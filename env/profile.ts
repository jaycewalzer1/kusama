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

/** One source node's share of the marks, named so that it can be edited. */
export interface MarkShare {
  /** The id as written in the program, not the resolved id: this is what a `set_arg` targets. */
  sourceId: string;
  op: string;
  /** The paint style, when the op takes one. `hatch` and `solid` are the same op and differ by 10,000x. */
  kind: string | null;
  marks: number;
}

export interface Budget {
  resolvedNodes: number;
  repeatInstances: number;
  marks: number;
  cost: number;
  perOp: Record<string, number>;
  /**
   * Marks by source node, heaviest first. `perOp` cannot answer the only question worth asking when
   * a budget is blown — WHICH node to shrink — because `solid` and `hatch` are both the `paint` op
   * and differ by four orders of magnitude, so they sum into one indistinguishable bucket.
   */
  heaviest: MarkShare[];
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
  const bySource = new Map<string, MarkShare>();
  let marks = 0;
  let cost = 0;
  for (const node of resolved.nodes) {
    const m = estimateMarks(node);
    marks += m;
    cost += m * costWeight(node);
    perOp[node.op] = (perOp[node.op] ?? 0) + m;
    // Summed per source node, not per resolved node: a `repeat` of 40 instances is one thing the
    // artist can edit, and listing its instances separately would bury the node that matters under
    // forty rows naming an id that appears nowhere in the program it is reading.
    const seen = bySource.get(node.sourceId);
    if (seen) seen.marks += m;
    else bySource.set(node.sourceId, { sourceId: node.sourceId, op: node.op, kind: kindOf(node), marks: m });
  }
  const heaviest = [...bySource.values()]
    .map((s) => ({ ...s, marks: Math.round(s.marks) }))
    .sort((a, b) => b.marks - a.marks || (a.sourceId < b.sourceId ? -1 : 1));
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
    heaviest,
    over,
  };
}

/**
 * The heaviest nodes as a sentence, for a refusal that would otherwise name only a total.
 *
 * "estimated marks 15909 exceeds the profile's limit of 12000" is true and unactionable: it does not
 * say that one crosshatch is 10,111 of them. Measured over `out/`, 43 of 63 edit refusals ever
 * recorded were this one limit, and one sketch walked 15242 -> 13674 -> 12502 across a retry without
 * landing, which is what bisecting against a total with no breakdown looks like from inside.
 */
export function saySpend(budget: Budget, top = 3): string {
  const rows = budget.heaviest.filter((s) => s.marks > 0).slice(0, top);
  if (rows.length === 0) return '';
  const named = rows.map((s) => `${s.sourceId} (${s.kind ? `${s.op}/${s.kind}` : s.op}) ${s.marks}`);
  return `heaviest nodes, in marks: ${named.join(', ')} — of ${budget.marks} total`;
}

function styleOf(node: ResolvedLeaf): Record<string, number | string> | null {
  const s = (node.args as { style?: Record<string, number | string> }).style;
  return s ?? null;
}

/** The paint style's discriminator, or null for an op that takes no style (or takes a keyword). */
function kindOf(node: ResolvedLeaf): string | null {
  const kind = styleOf(node)?.['kind'];
  return typeof kind === 'string' ? kind : null;
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
      // A stroke's render cost is dominated by the brush, not the geometry. The old divisor (5)
      // priced a sheet-diagonal at ~211 marks vs 1 for a solid fill — 200x apart — which made the
      // budget refuse exactly the accumulation the rubric demands. 40 puts a diagonal at ~25: still
      // more expensive than a fill, but no longer a budget-killer.
      const pts = (a['points'] as [number, number][]) ?? [];
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
      return pts.length + len / 40;
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

/**
 * What each fill costs, measured by running the estimator rather than by describing it.
 *
 * `maxEstimatedMarks` is printed to the artist as a bare number and the function that spends it is
 * not printed at all, so the one fact that governs the budget — that `solid` is 1 mark whatever its
 * size and a `hatch` of the same region is hundreds, growing with area — is unavailable to the thing
 * being held to it. Stating it in prose would put a copy of `estimateMarks` in a text file, which is
 * the drift `capability-sheet.ts` exists to avoid, so the rates are probed out of the real function.
 *
 * Two boxes rather than one because the scaling law is the point: 300x300 is nine times the area of
 * 100x100, and reading `1 -> 1` beside `278 -> 2500` teaches the whole cost model in one line.
 */
export interface MarkRate {
  kind: string;
  /** The arguments the rate was measured at, since a hatch's cost is mostly its spacing. */
  params: string;
  marks: number;
}

function within(profile: MediumProfile, field: string, value: number): number {
  const r = profile.ranges[field];
  return r ? Math.min(r[1], Math.max(r[0], value)) : value;
}

/** What each of this profile's fills costs over one box, at representative arguments. */
export function markRates(profile: MediumProfile, box: { w: number; h: number }): MarkRate[] {
  return (profile.styles ?? []).map((kind) => {
    // A style this switch does not know still gets a row, at whatever the estimator says a bare one
    // costs. Dropping it would hide a gap in the exact table whose job is to have none.
    let style: Record<string, unknown> = {};
    let params = '';
    if (kind === 'wash') {
      style = { bleed: 0.3 };
      params = 'bleed 0.3';
    } else if (kind === 'hatch') {
      const spacing = within(profile, 'spacing', 6);
      style = { spacing, layers: 1 };
      params = `spacing ${spacing}, layers 1 — halve the spacing or double the layers and this doubles`;
    } else if (kind === 'field') {
      const density = within(profile, 'density', 1);
      style = { density, marks: 'dots' };
      params = `density ${density}, dots — scribble is 3x`;
    }
    return {
      kind,
      params,
      marks: Math.round(
        estimateMarks({
          op: 'paint',
          args: { style: { kind, ...style } },
          bounds: { x: 0, y: 0, w: box.w, h: box.h },
        } as unknown as ResolvedLeaf)
      ),
    };
  });
}

/** The two boxes the capability sheet quotes rates over. 300x300 is nine times the area of 100x100. */
export const PROBE_SMALL = { w: 100, h: 100 } as const;
export const PROBE_LARGE = { w: 300, h: 300 } as const;

/** How expensive one mark of this kind is, relative to a hatch stamp. Measured, roughly. */
function costWeight(node: ResolvedLeaf): number {
  if (node.op === 'text') return 0.5;
  if (node.op === 'stroke') return 0.15;
  if (node.op === 'rule') return 0.15;
  if (node.op === 'spray') return 0.3;
  const kind = styleOf(node)?.['kind'];
  if (node.op === 'cover') return 3;
  switch (kind) {
    case 'solid':
      return 0.1;
    case 'wash':
      return 8;
    default:
      return 1;
  }
}
