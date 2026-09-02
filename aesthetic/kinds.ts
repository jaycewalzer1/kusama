// The constraint language: twenty kinds, one pure checker each.
//
// Closed on purpose. Every kind here is something the program tree or the canonical image actually
// exposes, and a position that needs a twenty-first has to give one up. The six render kinds read a
// RenderMetrics and nothing else; the one judge kind decides nothing at all and says so.
//
// The tree kinds and the render kinds are not equals, and the split matters more than the count.
// A tree kind reads the JSON, so it can be satisfied by editing the JSON — twice now a run has spent
// its whole budget swapping one op for another to turn a counting constraint green with no visible
// change to the picture. A render kind reads pixels, and the only way to move pixels is to move
// pixels. That is why `regionCountRange` exists beside `requireMark`: "four opaque areas" is a claim
// about the image, and counting `solid` styles in the tree was only ever a guess at it.
//
// A checker returns a status, its evidence, and the node ids the verdict rests on. Evidence is the
// point: "violated" with no node ids and no measured number is an opinion, and this layer does not
// have opinions. `nodeIds` is the same claim in a form a caller can compute with, because reading
// ids back out of prose by substring match is wrong in both directions — an id that is a prefix of
// another matches, and a verdict that names no ids matches nothing.
//
// "Rests on" is narrow and deliberately so:
//   violated   the offending nodes.
//   satisfied  the nodes carrying it — the ones whose removal could turn it into a violation.
//   otherwise  empty, and empty is a real answer.
// A verdict that rests on an *absence* (nothing forbidden is present) or on an *aggregate* (the tree
// has 12 nodes) names nobody, because no node is carrying it and pretending otherwise would make
// every node in the tree look load-bearing.

import type { Constraint, RenderMetrics, Status } from './types.js';
import { distinctColors, treeFacts, type TreeFacts } from './facts.js';

export interface Verdict {
  status: Status;
  evidence: string;
  /** Deduplicated, in tree order. Empty when no node carries the verdict; never truncated. */
  nodeIds: string[];
}

const UNVERIFIED_NO_METRICS: Verdict = {
  status: 'unverified',
  evidence: 'no render metrics supplied: pass --render to measure the canonical image',
  nodeIds: [],
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

function verdict(ok: boolean, evidence: string, nodeIds: string[] = []): Verdict {
  return { status: ok ? 'satisfied' : 'violated', evidence, nodeIds: dedupe(nodeIds) };
}

/** First occurrence wins, so the order is tree order and two equal verdicts compare equal. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
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

/**
 * Case-insensitive, whitespace-insensitive. "13   MARCH" contains "13 March".
 *
 * Exported because the artist layer asks the same question of a blind reader's transcript that
 * `textRequired` asks of the tree — is this string present — and the two answers are only worth
 * comparing if one rule decided both. A second normaliser written beside this one would make the
 * gap between "it is in the program" and "it can be read off the sheet" partly an artefact of two
 * spellings of the same idea.
 */
export function normalizeText(text: string): string {
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
    // Satisfied rests on nobody: removing a node can only lower the count. Violated rests on every
    // node that put a colour on the sheet, since which of them is the surplus one is not decidable.
    const carrying = used.length <= max ? [] : f.colors.map((c) => c.nodeId);
    return verdict(used.length <= max, `${used.length} of at most ${max}: ${used.join(' ')}`, carrying);
  },

  palette(f, p) {
    const allow = new Set((list(p, 'allow') ?? []).map((c) => c.toLowerCase()));
    const includeGround = flag(p, 'includeGround', true);
    const offenders: string[] = [];
    const offenderIds: string[] = [];
    for (const c of f.colors) {
      if (allow.has(c.hex)) continue;
      offenders.push(`${c.nodeId} ${c.at}=${c.hex}`);
      offenderIds.push(c.nodeId);
    }
    // The ground is the canvas, not a node, so it can offend without any node id to blame.
    if (includeGround && !allow.has(f.ground)) offenders.push(`canvas ground=${f.ground}`);
    return verdict(offenders.length === 0, offenders.length === 0 ? `all colours inside the allowed list` : ids(offenders), offenderIds);
  },

  forbidNode(f, p) {
    const offenders: string[] = [];
    const offenderIds: string[] = [];
    for (const op of list(p, 'ops') ?? []) {
      for (const id of f.ops[op] ?? []) {
        offenders.push(`${id} (${op})`);
        offenderIds.push(id);
      }
    }
    for (const m of list(p, 'macros') ?? []) {
      for (const id of f.macros[m] ?? []) {
        offenders.push(`${id} (${m})`);
        offenderIds.push(id);
      }
    }
    return verdict(offenders.length === 0, offenders.length === 0 ? 'absent' : ids(offenders), offenderIds);
  },

  requireNode(f, p) {
    const min = num(p, 'min') ?? 1;
    const op = typeof p['op'] === 'string' ? p['op'] : undefined;
    const macro = typeof p['macro'] === 'string' ? p['macro'] : undefined;
    const found = op !== undefined ? (f.ops[op] ?? []) : macro !== undefined ? (f.macros[macro] ?? []) : [];
    const what = op ?? macro ?? '(nothing named)';
    // The clearest load-bearing case in the language: these nodes are the requirement.
    return verdict(found.length >= min, `${found.length} ${what} of at least ${min}: ${ids(found)}`, found);
  },

  /**
   * Coverings that say what they took away.
   *
   * The difference between this and `requireNode {op: 'cover'}` is the only reason it exists. A
   * `cover` is three lines of JSON and can be laid on bare paper; counting them measures whether
   * somebody typed the word. A `cover` carrying `destroys` has passed env/validate.ts, which
   * refuses the program unless every named node exists, is drawn before the covering, and has
   * bounds the covering actually overlaps. So this counts acts of subtraction, and a tree cannot
   * satisfy it without something having been made first and then lost under something else.
   *
   * It is still a count, and counts are still soft — a position may not make this hard. What the
   * validator removed is the free move, not the incentive to make the move look done.
   */
  requireErasure(f, p) {
    const min = num(p, 'min') ?? 1;
    const each = num(p, 'minDestroyed') ?? 1;
    const found = f.covers.filter((c) => c.destroys.length >= each);
    const ids = found.map((c) => c.nodeId);
    const detail = found.map((c) => `${c.nodeId} over ${c.destroys.join('+')}`);
    return verdict(
      found.length >= min,
      `${found.length} coverings naming at least ${each} destroyed node of at least ${min}` +
        (found.length ? `: ${detail.slice(0, 6).join(', ')}` : `; ${f.covers.length} covers declare nothing`),
      ids
    );
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
    const offenderIds: string[] = [];
    for (const t of f.texts) {
      const wanted = want === 'upper' ? t.text.toUpperCase() : t.text.toLowerCase();
      if (t.text === wanted) continue;
      offenders.push(`${t.nodeId} "${t.text.slice(0, 40)}"`);
      offenderIds.push(t.nodeId);
    }
    return verdict(offenders.length === 0, offenders.length === 0 ? `${f.texts.length} strings all ${want}case` : ids(offenders), offenderIds);
  },

  textMaxWords(f, p) {
    const max = num(p, 'max') ?? 0;
    const over = f.texts.filter((t) => words(t.text).length > max);
    const offenders = over.map((t) => `${t.nodeId} ${words(t.text).length} words`);
    const longest = f.texts.reduce((n, t) => Math.max(n, words(t.text).length), 0);
    return verdict(
      offenders.length === 0,
      offenders.length === 0 ? `longest string is ${longest} words, at most ${max}` : ids(offenders),
      over.map((t) => t.nodeId)
    );
  },

  // The caption test. A caption is not a length and not a wording — it is type set small enough to
  // be read as apparatus rather than as image, parked where it will not disturb anything. Measured
  // as a fraction of canvas height so the answer does not change with the size of the sheet.
  //
  // Quarantine labels are excluded, not passed: the macro sets them at a size the program never
  // states, so there is nothing to measure and reporting a guess would be worse than reporting
  // nothing. A tree whose only strings are labels satisfies this vacuously, and that is correct —
  // this constraint decides set type, and a label is not set type.
  textMinHeight(f, p) {
    const min = num(p, 'min') ?? 0;
    const set = f.texts.filter((t) => t.size !== undefined);
    if (f.canvasHeight <= 0) return verdict(false, 'the program declares no canvas height, so no set size can be read as a fraction of it');
    const floor = min * f.canvasHeight;
    const under = set.filter((t) => t.size! < floor);
    const offenders = under.map((t) => `${t.nodeId} set at ${t.size}, ${(t.size! / f.canvasHeight).toFixed(3)} of the height`);
    const smallest = set.reduce((n, t) => Math.min(n, t.size!), Infinity);
    return verdict(
      under.length === 0,
      under.length === 0
        ? set.length === 0
          ? 'no set type on the sheet'
          : `smallest type is set at ${smallest}, ${(smallest / f.canvasHeight).toFixed(3)} of the height, at least ${min}`
        : ids(offenders),
      under.map((t) => t.nodeId)
    );
  },

  textRequired(f, p) {
    const wanted = list(p, 'contains') ?? [];
    const all = normalizeText(f.texts.map((t) => t.text).join(' '));
    const missing = wanted.filter((s) => !all.includes(normalizeText(s)));
    // Suppliers are named per node, but the match above is made against the joined text, so a
    // required string that only appears across two nodes is satisfied and names nobody. That is
    // honest: neither node carries it alone, and which pair carries it is not a fact about a node.
    const suppliers =
      missing.length === 0
        ? f.texts.filter((t) => wanted.some((s) => normalizeText(t.text).includes(normalizeText(s)))).map((t) => t.nodeId)
        : [];
    return verdict(
      missing.length === 0,
      missing.length === 0 ? 'every required string appears' : `missing: ${missing.map((s) => `"${s}"`).join(', ')}`,
      suppliers
    );
  },

  maxRepeatDepth(f, p) {
    const max = num(p, 'max') ?? 0;
    return verdict(f.repeatDepth <= max, `deepest repeat nesting is ${f.repeatDepth}, at most ${max}`);
  },

  forbidMark(f, p) {
    const styles = new Set(list(p, 'styles') ?? []);
    const brushes = new Set(list(p, 'brushes') ?? []);
    const offenders: string[] = [];
    const offenderIds: string[] = [];
    for (const m of f.marks) {
      if (m.style !== undefined && styles.has(m.style)) {
        offenders.push(`${m.nodeId} style=${m.style}`);
        offenderIds.push(m.nodeId);
      }
      if (m.brush !== undefined && brushes.has(m.brush)) {
        offenders.push(`${m.nodeId} brush=${m.brush}`);
        offenderIds.push(m.nodeId);
      }
    }
    return verdict(offenders.length === 0, offenders.length === 0 ? 'absent' : ids(offenders), offenderIds);
  },

  requireMark(f, p) {
    const min = num(p, 'min') ?? 1;
    const styles = new Set(list(p, 'styles') ?? []);
    const brushes = new Set(list(p, 'brushes') ?? []);
    const found = f.marks
      .filter((m) => (m.style !== undefined && styles.has(m.style)) || (m.brush !== undefined && brushes.has(m.brush)))
      .map((m) => m.nodeId);
    const wanted = [...styles, ...brushes].join('/');
    return verdict(found.length >= min, `${found.length} ${wanted} marks of at least ${min}: ${ids(found)}`, found);
  },
};

// --- render scope ------------------------------------------------------------------------------
//
// Every one of these is a statement about the whole sheet, so none of them names a node. Attributing
// a pixel to the node that laid it down would need the renderer to report per-node coverage, which
// it does not; `nodeIds` is empty here and that is the truth, not a stub.

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

  /**
   * Contact with the sheet's edge, per side, and how many sides have to satisfy it.
   *
   * `sides` defaults to all four and `minSides` to all of the ones named, so the plain form of this
   * constraint is the strict one: every side must be in range. That is deliberate — the failure it
   * was written for is a margin left on all four sides, and a default that accepted three would have
   * passed the run that motivated it.
   *
   * The message names the sides that failed and the value each of them had. A verdict that said only
   * "edge contact out of range" would send an artist to look at all four.
   */
  /**
   * How many separate opaque areas the finished sheet has.
   *
   * This is the kind that exists so nothing has to count `solid` styles. The two are not the same
   * question and were never close to it: a tree with four solid marks is a picture with one blot if
   * they overlap, with none if a wash went over them, and with six if a covering cut two of them in
   * half. The first is the exact move a policy makes when a hard `requireMark {styles:['solid'],
   * min:4}` is in its way — four marks, no visible change, constraint green — and it is the reason
   * counting nodes was demoted.
   *
   * `minArea` is the position's own floor for what it is willing to call a region, as a share of
   * the sheet. It defaults to half a percent, which on an 800x1200 sheet is about 70 by 70: below
   * that a person looking at the print says "a mark", not "an area". The metric stores everything
   * down to 0.0005 so this can be moved without measuring the image again.
   */
  regionCountRange(m, p) {
    const minArea = num(p, 'minArea') ?? 0.005;
    const min = num(p, 'min');
    const max = num(p, 'max');
    const kept = m.opaqueRegions.filter((a) => a >= minArea);
    const shown = kept.length === 0 ? 'none' : kept.slice(0, 6).map((a) => a.toFixed(4)).join(', ');
    return verdict(
      within(kept.length, min, max),
      `${kept.length} opaque regions at or above ${minArea} of the sheet, wanted ${rangeLabel(min, max)} — areas ${shown}${kept.length > 6 ? `, +${kept.length - 6} more` : ''}`
    );
  },

  edgeContactRange(m, p) {
    const named = list(p, 'sides') ?? ['top', 'right', 'bottom', 'left'];
    const sides = named.filter((s): s is keyof RenderMetrics['edgeContact'] => s in m.edgeContact);
    const min = num(p, 'min');
    const max = num(p, 'max');
    const held = sides.filter((s) => within(m.edgeContact[s], min, max));
    const need = num(p, 'minSides') ?? sides.length;
    const shown = sides.map((s) => `${s} ${m.edgeContact[s].toFixed(4)}`).join(', ');
    return verdict(
      held.length >= need,
      `${held.length} of ${sides.length} sides within ${rangeLabel(min, max)}, needed ${need} — ${shown}`
    );
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
    return { status: 'unverified', evidence: `blocked_by: ${constraint.blocked_by}`, nodeIds: [] };
  }
  if (constraint.kind === 'rubric') {
    return { status: 'unverified', evidence: 'judge scope: no judge in this layer, returned unread', nodeIds: [] };
  }
  const tree = treeCheckers[constraint.kind];
  if (tree) return tree(facts, constraint.params);
  const render = renderCheckers[constraint.kind];
  if (render) return metrics === null ? UNVERIFIED_NO_METRICS : render(metrics, constraint.params);
  return { status: 'unverified', evidence: `no checker for kind "${constraint.kind}"`, nodeIds: [] };
}

/** The closed set, as data, so a test can assert nobody added a twenty-first quietly. */
export const CONSTRAINT_KINDS = [...Object.keys(treeCheckers), ...Object.keys(renderCheckers), 'rubric'] as const;
