// The MediumProfile: what this medium can express at all, for one episode.
//
// A profile is mandatory, hashed and immutable while an episode runs. A program only means anything
// relative to one, which is why the hash goes into every trace next to the program hash.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './browser.js';
import type { ResolvedLeaf, ResolvedProgram } from '../renderer/resolve.js';
import { sprayParticleCount, DRIP_STEP } from '../renderer/resolve.js';

export interface ProfileLimits {
  maxSourceNodes: number;
  maxResolvedNodes: number;
  maxTreeDepth: number;
  maxRepeatInstances: number;
  maxRepeatNesting: number;
  maxPolygonPoints: number;
  maxStrokePoints: number;
  maxFragments: number;
  maxTextOps: number;
  maxTextLength: number;
  maxEstimatedMarks: number;
  maxRenderCost: number;
  maxPrintStages?: number;
  /**
   * Vertices one torn fragment edge may resample to. Absent means a fragment may not be torn at all,
   * which is V0's answer and is how `default-v0` keeps its hash without being edited to say so.
   */
  maxTearPoints?: number;
  /**
   * Particles one `spray` may lay down. Absent means this medium has no aerosol, which is V0's
   * answer and, like `maxTearPoints`, is how `default-v0` says so without being edited.
   */
  maxSprayParticles?: number;
}

export interface MediumProfile {
  id: string;
  description?: string;
  primitives: string[];
  macros: string[];
  layouts: string[];
  styles?: string[];
  fonts: string[];
  brushes: string[];
  blendModes: string[];
  assetPacks: string[];
  /** Post-process stages allowed in a program's `print` list. Absent means this medium has no "after". */
  print?: string[];
  /**
   * Region kinds a group's `clip` may use. Absent means `["rect"]`, which is what V0 allowed and is
   * how `default-v0` keeps its hash without having to be edited to say so.
   */
  clipShapes?: string[];
  limits: ProfileLimits;
  ranges: Record<string, [number, number]>;
  quantize: Record<string, number>;
}

export class ProfileError extends Error {}

/** Sorted-key JSON: the one serialization every hash in this repo is taken over. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function loadProfile(idOrPath: string): { profile: MediumProfile; hash: string } {
  const file = idOrPath.endsWith('.json') ? idOrPath : path.join(ROOT, 'env', 'profiles', `${idOrPath}.profile.json`);
  const profile = JSON.parse(readFileSync(file, 'utf8')) as MediumProfile;
  return { profile, hash: contentHash(profile) };
}

/**
 * The profile a program is to be read against: the one it names, unless a caller overrides it.
 *
 * There is deliberately no fallback. Every command used to default to `default`, which happened to
 * be `default-v0`, so a program could name a profile that was never loaded and the mismatch was
 * caught only by a later equality check. Now that there is more than one profile, a silent default
 * would mean a program rendered against a medium it did not ask for, and the whole point of hashing
 * the profile into the trace is that this cannot happen.
 */
export function loadProfileFor(program: unknown, override?: string): { profile: MediumProfile; hash: string } {
  if (override) return loadProfile(override);
  const named = (program as { profile?: unknown } | null)?.profile;
  if (typeof named !== 'string' || named.length === 0) {
    throw new ProfileError('this program names no profile, and a profile is not optional: add a "profile" key naming one of profiles/*.profile.json');
  }
  return loadProfile(named);
}

export interface Budget {
  resolvedNodes: number;
  repeatInstances: number;
  marks: number;
  cost: number;
  perOp: Record<string, number>;
  /** Limits this program is over, as readable sentences. Empty means it may be rendered. */
  over: string[];
}

/**
 * Estimated marks and render cost. Deliberately crude and always conservative: it exists so that an
 * over-budget program is refused in Node, in milliseconds, before a browser is ever launched. Marks
 * count brush stamps; cost weights them by how expensive that kind of stamp measured.
 */
export function estimateBudget(resolved: ResolvedProgram, profile: MediumProfile): Budget {
  const perOp: Record<string, number> = {};
  let marks = 0;
  let cost = 0;
  for (const node of resolved.nodes) {
    const m = estimateMarks(node);
    marks += m;
    cost += m * costWeight(node);
    perOp[node.op] = (perOp[node.op] ?? 0) + m;
  }
  const over: string[] = [];
  const check = (what: string, got: number, max: number) => {
    if (got > max) over.push(`${what} ${Math.round(got)} exceeds the profile's limit of ${max}`);
  };
  check('estimated marks', marks, profile.limits.maxEstimatedMarks);
  check('estimated render cost', cost, profile.limits.maxRenderCost);
  check('resolved nodes', resolved.counts.resolvedNodes, profile.limits.maxResolvedNodes);
  check('repeat instances', resolved.counts.repeatInstances, profile.limits.maxRepeatInstances);
  return {
    resolvedNodes: resolved.counts.resolvedNodes,
    repeatInstances: resolved.counts.repeatInstances,
    marks: Math.round(marks),
    cost: Math.round(cost),
    perOp,
    over,
  };
}

function styleOf(node: ResolvedLeaf): Record<string, number | string> | null {
  const s = (node.args as { style?: Record<string, number | string> }).style;
  return s ?? null;
}

function estimateMarks(node: ResolvedLeaf): number {
  const b = node.bounds;
  const area = Math.max(1, b.w * b.h);
  const perimeter = 2 * (b.w + b.h);
  const a = node.args as Record<string, unknown>;
  switch (node.op) {
    case 'text':
      return String(a['text'] ?? '').length * 2;
    case 'rule':
      return Math.max(2, perimeter / 8);
    case 'stroke': {
      const pts = (a['points'] as [number, number][]) ?? [];
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
      return pts.length + len / 5;
    }
    case 'cover':
      return 40 + Number(a['softness'] ?? 0) * 400;
    case 'spray': {
      // The one op whose mark count is exact rather than estimated: every particle is one stamp,
      // and the count is fixed by the arguments. Drips add their walk's vertices on top.
      const drip = a['drip'] as { count: number; length: number } | undefined;
      const dripMarks = drip ? drip.count * Math.max(1, Math.round(drip.length / DRIP_STEP)) : 0;
      return sprayParticleCount(a as { density: number; r: number }) + dripMarks;
    }
    default:
      break;
  }
  const style = styleOf(node);
  if (!style) return 10;
  switch (style['kind']) {
    case 'solid':
      return 1;
    case 'wash':
      return 40 + Number(style['bleed'] ?? 0) * 400;
    case 'outline':
      return perimeter / 5;
    case 'hatch': {
      const spacing = Math.max(1, Number(style['spacing'] ?? 6));
      const layers = Number(style['layers'] ?? 1);
      return (area / (spacing * 6)) * layers;
    }
    case 'field': {
      const count = (Number(style['density'] ?? 1) * area) / 1000;
      return count * (style['marks'] === 'scribble' ? 3 : 1);
    }
    default:
      return 10;
  }
}

/** How expensive one mark of this kind is, relative to a hatch stamp. Measured, roughly. */
function costWeight(node: ResolvedLeaf): number {
  if (node.op === 'text') return 0.5;
  const kind = styleOf(node)?.['kind'];
  if (node.op === 'cover') return 3;
  switch (kind) {
    case 'solid':
      return 0.1;
    case 'wash':
      return 3;
    default:
      return 1;
  }
}
