// The constraint language: sixteen kinds, one pure checker each.
//
// Closed on purpose. Every kind here is something the program tree or the canonical image actually
// exposes, and a position that needs a seventeenth has to give one up. The four render kinds read a
// RenderMetrics and nothing else; the one judge kind decides nothing at all and says so.
//
// A checker returns a status and its evidence. Evidence is the point: "violated" with no node ids
// and no measured number is an opinion, and this layer does not have opinions.

import type { Constraint, RenderMetrics, Status } from './types.js';
import { distinctColors, treeFacts, type TreeFacts } from './facts.js';

export interface Verdict {
  status: Status;
  evidence: string;
}

const UNVERIFIED_NO_METRICS: Verdict = {
  status: 'unverified',
  evidence: 'no render metrics supplied: pass --render to measure the canonical image',
};

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' ? v : undefined;
}

function list(params: Record<string, unknown>, key: string): string[] | undefined {
  const v = params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function flag(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}

function verdict(ok: boolean, evidence: string): Verdict {
  return { status: ok ? 'satisfied' : 'violated', evidence };
}

/** Ids in evidence are truncated so a 300-node tree does not print a paragraph. */
function ids(values: string[], limit = 8): string {
  if (values.length === 0) return 'none';
  const head = values.slice(0, limit).join(', ');
  return values.length > limit ? `${head}, +${values.length - limit} more` : head;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Case-insensitive, whitespace-insensitive. "13   MARCH" contains "13 March". */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function within(value: number, min: number | undefined, max: number | undefined): boolean {
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function rangeLabel(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `[${min}, ${max}]`;
  if (min !== undefined) return `>= ${min}`;
  if (max !== undefined) return `<= ${max}`;
  return 'unbounded';
}

// --- tree scope --------------------------------------------------------------------------------

const treeCheckers: Record<string, (f: TreeFacts, p: Record<string, unknown>) => Verdict> = {
  maxDistinctColors(f, p) {
    const max = num(p, 'max') ?? 0;
    const used = distinctColors(f, flag(p, 'includeGround', true));
    return verdict(used.length <= max, `${used.length} of at most ${max}: ${used.join(' ')}`);
  },

  palette(f, p) {
    const allow = new Set((list(p, 'allow') ?? []).map((c) => c.toLowerCase()));
    const includeGround = flag(p, 'includeGround', true);
    const offenders: string[] = [];
    for (const c of f.colors) if (!allow.has(c.hex)) offenders.push(`${c.nodeId} ${c.at}=${c.hex}`);
    if (includeGround && !allow.has(f.ground)) offenders.push(`canvas ground=${f.ground}`);
    return verdict(offenders.length === 0, offenders.length === 0 ? `all colours inside the allowed list` : ids(offenders));
  },

  forbidNode(f, p) {
    const offenders: string[] = [];
    for (const op of list(p, 'ops') ?? []) for (const id of f.ops[op] ?? []) offenders.push(`${id} (${op})`);
    for (const m of list(p, 'macros') ?? []) for (const id of f.macros[m] ?? []) offenders.push(`${id} (${m})`);
    return verdict(offenders.length === 0, offenders.length === 0 ? 'absent' : ids(offenders));
  },

  requireNode(f, p) {
    const min = num(p, 'min') ?? 1;
    const op = typeof p['op'] === 'string' ? p['op'] : undefined;
    const macro = typeof p['macro'] === 'string' ? p['macro'] : undefined;
    const found = op !== undefined ? (f.ops[op] ?? []) : macro !== undefined ? (f.macros[macro] ?? []) : [];
    const what = op ?? macro ?? '(nothing named)';
    return verdict(found.length >= min, `${found.length} ${what} of at least ${min}: ${ids(found)}`);
  },

  nodeCount(f, p) {
    const counted = f.drawingNodes + (flag(p, 'countGroups', false) ? f.containerNodes : 0);
    const min = num(p, 'min');
    const max = num(p, 'max');
    return verdict(within(counted, min, max), `${counted} nodes, wanted ${rangeLabel(min, max)}`);
  },

  textCase(f, p) {
    const want = p['case'] === 'lower' ? 'lower' : 'upper';
    const offenders: string[] = [];
    for (const t of f.texts) {
      const wanted = want === 'upper' ? t.text.toUpperCase() : t.text.toLowerCase();
      if (t.text !== wanted) offenders.push(`${t.nodeId} "${t.text.slice(0, 40)}"`);
    }
    return verdict(offenders.length === 0, offenders.length === 0 ? `${f.texts.length} strings all ${want}case` : ids(offenders));
  },

  textMaxWords(f, p) {
    const max = num(p, 'max') ?? 0;
    const offenders = f.texts.filter((t) => words(t.text).length > max).map((t) => `${t.nodeId} ${words(t.text).length} words`);
    const longest = f.texts.reduce((n, t) => Math.max(n, words(t.text).length), 0);
    return verdict(offenders.length === 0, offenders.length === 0 ? `longest string is ${longest} words, at most ${max}` : ids(offenders));
  },

  textRequired(f, p) {
    const all = normalizeText(f.texts.map((t) => t.text).join(' '));
    const missing = (list(p, 'contains') ?? []).filter((s) => !all.includes(normalizeText(s)));
    return verdict(missing.length === 0, missing.length === 0 ? 'every required string appears' : `missing: ${missing.map((s) => `"${s}"`).join(', ')}`);
  },

  maxRepeatDepth(f, p) {
    const max = num(p, 'max') ?? 0;
    return verdict(f.repeatDepth <= max, `deepest repeat nesting is ${f.repeatDepth}, at most ${max}`);
  },

  forbidMark(f, p) {
    const styles = new Set(list(p, 'styles') ?? []);
    const brushes = new Set(list(p, 'brushes') ?? []);
    const offenders: string[] = [];
    for (const m of f.marks) {
      if (m.style !== undefined && styles.has(m.style)) offenders.push(`${m.nodeId} style=${m.style}`);
      if (m.brush !== undefined && brushes.has(m.brush)) offenders.push(`${m.nodeId} brush=${m.brush}`);
    }
    return verdict(offenders.length === 0, offenders.length === 0 ? 'absent' : ids(offenders));
  },

  requireMark(f, p) {
    const min = num(p, 'min') ?? 1;
    const styles = new Set(list(p, 'styles') ?? []);
    const brushes = new Set(list(p, 'brushes') ?? []);
    const found = f.marks
      .filter((m) => (m.style !== undefined && styles.has(m.style)) || (m.brush !== undefined && brushes.has(m.brush)))
      .map((m) => m.nodeId);
    const wanted = [...styles, ...brushes].join('/');
    return verdict(found.length >= min, `${found.length} ${wanted} marks of at least ${min}: ${ids(found)}`);
  },
};

// --- render scope ------------------------------------------------------------------------------

const renderCheckers: Record<string, (m: RenderMetrics, p: Record<string, unknown>) => Verdict> = {
  inkDensityRange(m, p) {
    const min = num(p, 'min');
    const max = num(p, 'max');
    return verdict(within(m.inkDensity, min, max), `ink density ${m.inkDensity.toFixed(4)}, wanted ${rangeLabel(min, max)}`);
  },

  coverageRange(m, p) {
    const min = num(p, 'min');
    const max = num(p, 'max');
    return verdict(within(m.coverage, min, max), `coverage ${m.coverage.toFixed(4)}, wanted ${rangeLabel(min, max)}`);
  },

  symmetryMax(m, p) {
    const axis = p['axis'] === 'horizontal' ? 'horizontal' : 'vertical';
    const max = num(p, 'max') ?? 1;
    const got = m.symmetry[axis];
    return verdict(got <= max, `${axis} symmetry ${got.toFixed(4)}, at most ${max}`);
  },

  inkOffsetRange(m, p) {
    const min = num(p, 'min');
    const max = num(p, 'max');
    return verdict(within(m.inkOffset, min, max), `ink offset ${m.inkOffset.toFixed(4)}, wanted ${rangeLabel(min, max)}`);
  },
};

/**
 * One constraint against one tree. `metrics` may be null; render-scope constraints then come back
 * unverified rather than assumed. Judge scope is always unverified: this layer does not judge, and a
 * rubric that returned "satisfied" because nobody read it would be the worst thing in the file.
 */
export function checkConstraint(constraint: Constraint, program: unknown, metrics: RenderMetrics | null): Verdict {
  return checkConstraintWithFacts(constraint, treeFacts(program), metrics);
}

export function checkConstraintWithFacts(constraint: Constraint, facts: TreeFacts, metrics: RenderMetrics | null): Verdict {
  if (constraint.blocked_by !== undefined) {
    return { status: 'unverified', evidence: `blocked_by: ${constraint.blocked_by}` };
  }
  if (constraint.kind === 'rubric') {
    return { status: 'unverified', evidence: 'judge scope: no judge in this layer, returned unread' };
  }
  const tree = treeCheckers[constraint.kind];
  if (tree) return tree(facts, constraint.params);
  const render = renderCheckers[constraint.kind];
  if (render) return metrics === null ? UNVERIFIED_NO_METRICS : render(metrics, constraint.params);
  return { status: 'unverified', evidence: `no checker for kind "${constraint.kind}"` };
}

/** The closed set, as data, so a test can assert nobody added a seventeenth quietly. */
export const CONSTRAINT_KINDS = [...Object.keys(treeCheckers), ...Object.keys(renderCheckers), 'rubric'] as const;
