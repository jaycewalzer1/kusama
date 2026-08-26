// Validation: everything that can be decided about a program without rendering it.
//
// Order matters. The schema runs first (so later passes can assume shapes), then the checks that
// need the whole tree, then resolution, then the budget. Resolution and budgeting happen in Node,
// so a program that cannot be afforded is refused in milliseconds and never reaches a browser.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { ROOT } from './browser.js';
import { contentHash, estimateBudget, type Budget, type MediumProfile } from './profile.js';
import { packHash, type AssetPack } from './pack.js';
import { ResolveError, resolveProgram, type ResolvedProgram } from '../renderer/resolve.js';
import { MacroError } from '../renderer/macros.js';

const Ajv = _Ajv2020 as unknown as typeof _Ajv2020.default;

export interface Issue {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: Issue[];
  programHash: string;
  resolved?: ResolvedProgram;
  budget?: Budget;
}

function schema(name: string): object {
  return JSON.parse(readFileSync(path.join(ROOT, 'schema', name), 'utf8')) as object;
}

let compiled: { program: ValidateFunction; edit: ValidateFunction; profile: ValidateFunction } | null = null;

function validators() {
  if (compiled) return compiled;
  // strictRequired off: edit.schema.json declares its properties once at the top and makes them
  // conditionally required from `if/then` branches, which that lint reads as a missing definition.
  const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  ajv.addSchema(schema('paintstyle.schema.json'));
  compiled = {
    program: ajv.compile(schema('program.schema.json')),
    edit: ajv.compile(schema('edit.schema.json')),
    profile: ajv.compile(schema('profile.schema.json')),
  };
  return compiled;
}

export function validateProfile(profile: unknown): Issue[] {
  const v = validators().profile;
  return v(profile) ? [] : ajvIssues(v, 'schema.profile');
}

export function validateEditAction(action: unknown): Issue[] {
  const v = validators().edit;
  return v(action) ? [] : ajvIssues(v, 'schema.edit');
}

function ajvIssues(v: ValidateFunction, code: string): Issue[] {
  return (v.errors ?? []).map((e) => ({
    code,
    path: e.instancePath || '/',
    message: `${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? ` ("${String(e.params['additionalProperty'])}")` : ''}`,
  }));
}

/** The whole check. `pack` must already have been loaded (and therefore hash-verified). */
export function validateProgram(program: unknown, profile: MediumProfile, pack: AssetPack): ValidationResult {
  const issues: Issue[] = [];
  const programHash = contentHash(program);

  const v = validators().program;
  if (!v(program)) {
    return { valid: false, issues: ajvIssues(v, 'schema.program'), programHash };
  }
  const prog = program as ProgramShape;

  issues.push(...checkAssets(prog, profile, pack));
  issues.push(...walkAndCheck(prog, profile, pack));

  if (issues.length) return { valid: false, issues, programHash };

  let resolved: ResolvedProgram;
  try {
    resolved = resolveProgram(prog, pack, {
      maxResolvedNodes: profile.limits.maxResolvedNodes,
      maxDepth: profile.limits.maxTreeDepth,
      maxRepeatInstances: profile.limits.maxRepeatInstances,
      maxRepeatNesting: profile.limits.maxRepeatNesting,
    });
  } catch (e) {
    if (e instanceof ResolveError || e instanceof MacroError) {
      return { valid: false, issues: [{ code: 'resolve', path: '/root', message: e.message }], programHash };
    }
    throw e;
  }

  const budget = estimateBudget(resolved, profile);
  for (const message of budget.over) issues.push({ code: 'budget', path: '/root', message });

  return { valid: issues.length === 0, issues, programHash, resolved, budget };
}

// --- the individual checks -------------------------------------------------------------------------

interface ProgramShape {
  profile: string;
  assetPack: string;
  seed: number;
  canvas: Record<string, number | string>;
  palette?: Record<string, string>;
  root: NodeShape;
  meta?: unknown;
}

interface NodeShape {
  id: string;
  type: 'group' | 'repeat' | 'macro' | 'op';
  op?: string;
  macro?: string;
  rngKey?: string;
  args?: Record<string, unknown>;
  transform?: Record<string, unknown>;
  clip?: Record<string, unknown>;
  blend?: string;
  count?: number;
  layout?: Record<string, unknown>;
  jitter?: Record<string, unknown>;
  children?: NodeShape[];
}

function checkAssets(prog: ProgramShape, profile: MediumProfile, pack: AssetPack): Issue[] {
  const issues: Issue[] = [];
  if (prog.profile !== profile.id) {
    issues.push({ code: 'profile.mismatch', path: '/profile', message: `program declares profile "${prog.profile}" but was validated against "${profile.id}"` });
  }
  if (prog.assetPack !== pack.id) {
    issues.push({ code: 'pack.mismatch', path: '/assetPack', message: `program declares pack "${prog.assetPack}" but was given "${pack.id}"` });
  }
  if (!profile.assetPacks.includes(pack.id)) {
    issues.push({ code: 'pack.notAllowed', path: '/assetPack', message: `the profile does not allow asset pack "${pack.id}"` });
  }
  if (packHash(pack) !== pack.hash) {
    issues.push({ code: 'pack.hash', path: '/assetPack', message: `asset pack "${pack.id}" does not match its declared hash` });
  }
  return issues;
}

/** One pass over the source tree: ids, profile allowances, structural rules, numbers, counts. */
function walkAndCheck(prog: ProgramShape, profile: MediumProfile, pack: AssetPack): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const counts = { source: 0, fragments: 0, textOps: 0 };
  const palette = prog.palette ?? {};

  const numbers = (value: unknown, key: string, at: string) => {
    issues.push(...checkNumbers(value, key, at, profile));
  };

  const color = (value: unknown, at: string) => {
    if (typeof value !== 'string' || value.startsWith('#')) return;
    if (!(value in palette)) issues.push({ code: 'palette.unknown', path: at, message: `colour "${value}" is not in the palette` });
  };

  const style = (s: Record<string, unknown> | undefined, at: string) => {
    if (!s) return;
    const kind = String(s['kind']);
    if (profile.styles && !profile.styles.includes(kind)) {
      issues.push({ code: 'style.notAllowed', path: at, message: `the profile does not allow the "${kind}" paint style` });
    }
    if (typeof s['brush'] === 'string' && !profile.brushes.includes(s['brush'])) {
      issues.push({ code: 'brush.notAllowed', path: at, message: `the profile does not allow brush "${String(s['brush'])}"` });
    }
    color(s['color'], `${at}/color`);
  };

  const walk = (node: NodeShape, at: string, clipped: boolean, depth: number) => {
    counts.source++;
    if (seen.has(node.id)) issues.push({ code: 'id.duplicate', path: at, message: `id "${node.id}" is used more than once` });
    seen.add(node.id);
    if (depth > profile.limits.maxTreeDepth) {
      issues.push({ code: 'limit.depth', path: at, message: `tree depth ${depth} exceeds the profile's maxTreeDepth ${profile.limits.maxTreeDepth}` });
      return;
    }
    numbers(node.transform, 'transform', `${at}/transform`);
    numbers(node.clip, 'clip', `${at}/clip`);

    if (node.type === 'group') {
      if (node.blend !== undefined && !profile.blendModes.includes(node.blend)) {
        issues.push({ code: 'blend.notAllowed', path: `${at}/blend`, message: `the profile does not allow blend mode "${node.blend}" (V0 allows none: see NOTES R3)` });
      }
      const nowClipped = clipped || node.clip !== undefined;
      (node.children ?? []).forEach((c, i) => walk(c, `${at}/children/${i}`, nowClipped, depth + 1));
      return;
    }

    if (node.type === 'repeat') {
      const layoutType = String(node.layout?.['type']);
      if (!profile.layouts.includes(layoutType)) {
        issues.push({ code: 'layout.notAllowed', path: `${at}/layout`, message: `the profile does not allow the "${layoutType}" layout` });
      }
      numbers(node.count, 'count', `${at}/count`);
      numbers(node.layout, 'layout', `${at}/layout`);
      numbers(node.jitter, 'jitter', `${at}/jitter`);
      (node.children ?? []).forEach((c, i) => walk(c, `${at}/children/${i}`, clipped, depth + 1));
      return;
    }

    if (node.type === 'macro') {
      const name = String(node.macro);
      if (!profile.macros.includes(name)) {
        issues.push({ code: 'macro.notAllowed', path: at, message: `the profile does not allow the "${name}" macro` });
      }
      const a = node.args ?? {};
      numbers(a, 'args', `${at}/args`);
      if (name === 'motif' && !(String(a['name']) in pack.motifs)) {
        issues.push({ code: 'motif.unknown', path: `${at}/args/name`, message: `motif "${String(a['name'])}" is not in asset pack "${pack.id}"` });
      }
      if (name === 'quarantine') {
        style(a['style'] as Record<string, unknown>, `${at}/args/style`);
        color(a['boxColor'], `${at}/args/boxColor`);
        if (a['label'] !== undefined) {
          counts.textOps++;
          if (clipped) issues.push({ code: 'text.clipped', path: at, message: 'a quarantine label is a text op and text cannot be clipped (NOTES L1)' });
          checkFont(String(a['labelFont'] ?? 'grotesque'), `${at}/args/labelFont`);
        }
      }
      if (typeof a['brush'] === 'string' && !profile.brushes.includes(a['brush'])) {
        issues.push({ code: 'brush.notAllowed', path: `${at}/args/brush`, message: `the profile does not allow brush "${String(a['brush'])}"` });
      }
      if (typeof a['boxBrush'] === 'string' && !profile.brushes.includes(a['boxBrush'])) {
        issues.push({ code: 'brush.notAllowed', path: `${at}/args/boxBrush`, message: `the profile does not allow brush "${String(a['boxBrush'])}"` });
      }
      color(a['color'], `${at}/args/color`);
      return;
    }

    // op
    const op = String(node.op);
    const a = node.args ?? {};
    if (!profile.primitives.includes(op)) {
      issues.push({ code: 'op.notAllowed', path: at, message: `the profile does not allow the "${op}" operator` });
    }
    numbers(a, 'args', `${at}/args`);
    style(a['style'] as Record<string, unknown>, `${at}/args/style`);
    color(a['color'], `${at}/args/color`);
    if (typeof a['brush'] === 'string' && !profile.brushes.includes(a['brush'])) {
      issues.push({ code: 'brush.notAllowed', path: `${at}/args/brush`, message: `the profile does not allow brush "${String(a['brush'])}"` });
    }

    const region = a['region'] as Record<string, unknown> | undefined;
    if (region?.['type'] === 'polygon') {
      const pts = region['points'] as unknown[];
      if (pts.length > profile.limits.maxPolygonPoints) {
        issues.push({ code: 'limit.polygonPoints', path: `${at}/args/region/points`, message: `${pts.length} polygon points exceeds the profile's limit of ${profile.limits.maxPolygonPoints}` });
      }
    }
    if (op === 'stroke') {
      const pts = (a['points'] as unknown[]) ?? [];
      if (pts.length > profile.limits.maxStrokePoints) {
        issues.push({ code: 'limit.strokePoints', path: `${at}/args/points`, message: `${pts.length} stroke points exceeds the profile's limit of ${profile.limits.maxStrokePoints}` });
      }
    }
    if (op === 'fragment' || region?.['type'] === 'fragment') {
      counts.fragments++;
      const name = String((op === 'fragment' ? a['name'] : region?.['name']) ?? '');
      if (!(name in pack.fragments)) {
        issues.push({ code: 'fragment.unknown', path: `${at}/args/name`, message: `fragment "${name}" is not in asset pack "${pack.id}"` });
      }
    }
    if (op === 'text') {
      counts.textOps++;
      const text = String(a['text'] ?? '');
      if (text.length > profile.limits.maxTextLength) {
        issues.push({ code: 'limit.textLength', path: `${at}/args/text`, message: `text of ${text.length} characters exceeds the profile's limit of ${profile.limits.maxTextLength}` });
      }
      checkFont(String(a['font']), `${at}/args/font`);
      if (clipped) {
        issues.push({ code: 'text.clipped', path: at, message: 'text inside a clipped group is refused: glyphs cannot be clipped geometrically (NOTES L1)' });
      }
    }
  };

  function checkFont(name: string, at: string) {
    if (!profile.fonts.includes(name)) {
      issues.push({ code: 'font.notAllowed', path: at, message: `the profile does not allow font "${name}"` });
    }
  }

  numbers(prog.canvas, 'canvas', '/canvas');
  numbers(prog.seed, 'seed', '/seed');
  walk(prog.root, '/root', false, 1);

  if (counts.source > profile.limits.maxSourceNodes) {
    issues.push({ code: 'limit.sourceNodes', path: '/root', message: `${counts.source} source nodes exceeds the profile's limit of ${profile.limits.maxSourceNodes}` });
  }
  if (counts.fragments > profile.limits.maxFragments) {
    issues.push({ code: 'limit.fragments', path: '/root', message: `${counts.fragments} fragment placements exceeds the profile's limit of ${profile.limits.maxFragments}` });
  }
  if (counts.textOps > profile.limits.maxTextOps) {
    issues.push({ code: 'limit.textOps', path: '/root', message: `${counts.textOps} text ops exceeds the profile's limit of ${profile.limits.maxTextOps}` });
  }
  return issues;
}

/**
 * Every number in a program must sit on its field's quantization step and inside its field's range.
 * A field with no declared step is an error, not a pass: an unquantized number is a number the
 * medium cannot promise to reproduce or to diff meaningfully.
 */
function checkNumbers(value: unknown, key: string, at: string, profile: MediumProfile): Issue[] {
  const issues: Issue[] = [];
  const visit = (v: unknown, k: string, path: string) => {
    if (typeof v === 'number') {
      const step = profile.quantize[k];
      if (step === undefined) {
        issues.push({ code: 'quantize.undeclared', path, message: `the profile declares no quantization step for numeric field "${k}"` });
      } else if (Math.abs(v / step - Math.round(v / step)) > 1e-9) {
        issues.push({ code: 'quantize', path, message: `${v} is not a multiple of the ${step} step for "${k}"` });
      }
      const range = profile.ranges[k];
      if (range && (v < range[0] || v > range[1])) {
        issues.push({ code: 'range', path, message: `${v} is outside the profile's range [${range[0]}, ${range[1]}] for "${k}"` });
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, k, `${path}/${i}`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [ck, cv] of Object.entries(v)) {
        if (ck === 'meta') continue;
        visit(cv, ck, `${path}/${ck}`);
      }
    }
  };
  visit(value, key, at);
  return issues;
}
