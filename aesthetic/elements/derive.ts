// Derived conflicts: pairs of constraints that no tree and no image can satisfy together, proven by
// algebra over their parameters alone. Browser-free, corpus-free, total.
//
// The bar here is deliberately high, and it is the reason this tier is worth anything. A derived
// conflict that turns out to be satisfiable is worse than no conflict machinery at all: it would put
// a proof in `note` for a claim that is false, and every downstream Resolution would be recording a
// decision about a dilemma that never existed. So every rule below either proves emptiness or stays
// silent, and several plausible rules are deliberately absent because they are *not* sound:
//
//   symmetryMax vs symmetryMax        two ceilings. They intersect at min(); never empty.
//   maxDistinctColors vs palette      `palette` is an ALLOW-list (kinds.ts:102-115). It permits a
//                                     set, it never requires one, so "a palette needing more than n
//                                     colours" does not exist in this language. Three of a
//                                     five-colour allow-list satisfies both. Recorded in NEEDS.md.
//   requireMark summed into a budget  a `paint` node with a `solid` style answers a requireNode for
//                                     `paint` AND a requireMark for `solid`. The sets are not
//                                     disjoint, so the minima cannot be added.
//   requireNode{macro} in a budget    `nodeCount` counts drawing nodes, and counts containers only
//                                     under `countGroups`. A macro is neither reliably. Excluded.
//   textCase upper vs lower, alone    "1979" is equal to both its own upper and lower form, so a
//                                     tree whose only text is uncased satisfies both. Needs a
//                                     `textRequired` carrying a cased letter before it is empty.
//
// Each of those is a case where the obvious rule is wrong, and each was cheaper to find here than in
// a report that confidently named a conflict nobody could have resolved.

import type { Constraint, ConstraintResult } from '../types.js';
import type { Conflict, ConflictSide, SourceRef } from './types.js';
import { contentHash } from './hash.js';

/** A constraint plus where it came from: what compose() has already flattened into one list. */
export interface Sourced {
  constraint: Constraint;
  source: SourceRef;
  /**
   * Which of the three parts it was stated in. Nothing in this file reads it — a proof is about
   * parameters, not about where a rule was written — but the break record does: a commitment that
   * broke and a generative rule that stopped applying are different events, and only this tells
   * them apart.
   */
  part: ConstraintResult['part'];
}

function side(s: Sourced): ConflictSide {
  return { source: s.source, constraintId: s.constraint.id };
}

/**
 * Order-independent: the two (kind, id, constraintId) triples are sorted before hashing, so the same
 * pair discovered from either direction is the same conflict.
 */
export function conflictId(a: ConflictSide, b: ConflictSide): string {
  const key = (s: ConflictSide): string => `${s.source.kind}\u0000${s.source.id}\u0000${s.constraintId}`;
  return contentHash([key(a), key(b)].sort());
}

function conflict(a: Sourced, b: Sourced, note: string): Conflict {
  const [x, y] = [side(a), side(b)];
  return { id: conflictId(x, y), a: x, b: y, tier: 'derived', note };
}

function num(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === 'number' ? v : undefined;
}

function list(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === 'string' ? v : undefined;
}

// --- 1. empty numeric intersection, within one kind ---------------------------------------------
//
// Every kind whose params are a one-dimensional band on a single measured quantity. Two constraints
// on the same quantity intersect at [max(mins), min(maxes)], and that is empty when the lower bound
// is strictly above the upper one. Kinds that only ever carry a `max` fall out of this correctly by
// never producing a lower bound, which is why they are listed rather than special-cased.

const RANGE_KINDS: Record<string, { min: boolean; max: boolean }> = {
  inkDensityRange: { min: true, max: true },
  coverageRange: { min: true, max: true },
  inkOffsetRange: { min: true, max: true },
  nodeCount: { min: true, max: true },
  symmetryMax: { min: false, max: true },
  maxDistinctColors: { min: false, max: true },
  textMaxWords: { min: false, max: true },
  maxRepeatDepth: { min: false, max: true },
};

/**
 * Which band a constraint is about. `symmetryMax` is per-axis, so two ceilings on different axes are
 * two different quantities and must not be intersected with each other.
 */
function bandKey(c: Constraint): string | null {
  if (!(c.kind in RANGE_KINDS)) return null;
  if (c.kind === 'symmetryMax') return `symmetryMax:${str(c.params, 'axis') === 'horizontal' ? 'horizontal' : 'vertical'}`;
  return c.kind;
}

/** The bound this constraint puts on its band. `max`-only kinds spell their ceiling differently. */
function bounds(c: Constraint): { min?: number; max?: number } {
  const shape = RANGE_KINDS[c.kind]!;
  const out: { min?: number; max?: number } = {};
  if (shape.min) {
    const v = num(c.params, 'min');
    if (v !== undefined) out.min = v;
  }
  if (shape.max) {
    const v = num(c.params, 'max');
    if (v !== undefined) out.max = v;
  }
  return out;
}

function rangeConflicts(all: Sourced[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      const key = bandKey(a.constraint);
      if (key === null || key !== bandKey(b.constraint)) continue;
      const ba = bounds(a.constraint);
      const bb = bounds(b.constraint);
      // One constraint's floor against the other's ceiling. A floor and a ceiling from the same
      // constraint is a malformed constraint, not a conflict between two sources.
      for (const [lo, hi, loS, hiS] of [
        [ba.min, bb.max, a, b],
        [bb.min, ba.max, b, a],
      ] as [number | undefined, number | undefined, Sourced, Sourced][]) {
        if (lo === undefined || hi === undefined || lo <= hi) continue;
        out.push(
          conflict(
            a,
            b,
            `${key}: ${loS.constraint.id} requires >= ${lo}, ${hiS.constraint.id} requires <= ${hi}. ` +
              `The intersection [${lo}, ${hi}] is empty, so no value of this quantity satisfies both.`
          )
        );
        break;
      }
    }
  }
  return out;
}

// --- 2. disjoint palettes ------------------------------------------------------------------------
//
// Two allow-lists with nothing in common. Sound *unconditionally* only when both count the ground:
// the canvas ground is one colour, it is checked against both lists, and it cannot be in two
// disjoint sets. With `includeGround: false` on either side the pair is satisfiable by a tree that
// lays down no colour at all, so this stays silent there. NEEDS.md.

function paletteConflicts(all: Sourced[]): Conflict[] {
  const palettes = all.filter((s) => s.constraint.kind === 'palette');
  const out: Conflict[] = [];
  for (let i = 0; i < palettes.length; i++) {
    for (let j = i + 1; j < palettes.length; j++) {
      const a = palettes[i]!;
      const b = palettes[j]!;
      const groundA = a.constraint.params['includeGround'] !== false;
      const groundB = b.constraint.params['includeGround'] !== false;
      if (!groundA || !groundB) continue;
      const A = new Set(list(a.constraint.params, 'allow').map((c) => c.toLowerCase()));
      const B = new Set(list(b.constraint.params, 'allow').map((c) => c.toLowerCase()));
      if (A.size === 0 || B.size === 0) continue;
      const shared = [...A].filter((c) => B.has(c));
      if (shared.length > 0) continue;
      out.push(
        conflict(
          a,
          b,
          `palette: ${a.constraint.id} allows {${[...A].join(' ')}} and ${b.constraint.id} allows ` +
            `{${[...B].join(' ')}}, which are disjoint. Both count the canvas ground, and the ground ` +
            `is one colour, so it would have to belong to both lists.`
        )
      );
    }
  }
  return out;
}

// --- 3. budget exhaustion ------------------------------------------------------------------------
//
// The case that rescues tree scope. Existence predicates union happily — two elements each demanding
// a node are both satisfied by making both — right up until they compete for a finite shared
// resource, and `nodeCount {max}` is exactly that.
//
// Sound because a node has exactly one op, so requirements on *distinct* ops name disjoint sets of
// nodes and their minima add. Two requirements on the *same* op overlap completely, so those take a
// max rather than a sum. Macros and marks are excluded above and for the reasons given there.

const DRAWING_OPS = new Set(['wash', 'paint', 'stroke', 'fragment', 'text', 'rule', 'cover', 'spray']);

function budgetConflicts(all: Sourced[]): Conflict[] {
  const ceilings = all.filter((s) => s.constraint.kind === 'nodeCount' && num(s.constraint.params, 'max') !== undefined);
  if (ceilings.length === 0) return [];

  // Per op, the strongest requirement and who wrote it.
  const perOp = new Map<string, { min: number; by: Sourced }>();
  for (const s of all) {
    if (s.constraint.kind !== 'requireNode') continue;
    const op = str(s.constraint.params, 'op');
    if (op === undefined || !DRAWING_OPS.has(op)) continue;
    const min = num(s.constraint.params, 'min') ?? 1;
    const seen = perOp.get(op);
    if (seen === undefined || min > seen.min) perOp.set(op, { min, by: s });
  }
  if (perOp.size === 0) return [];

  const floor = [...perOp.values()].reduce((n, r) => n + r.min, 0);
  const terms = [...perOp.entries()].map(([op, r]) => `${r.min} ${op} (${r.by.constraint.id})`).join(' + ');

  const out: Conflict[] = [];
  for (const ceiling of ceilings) {
    const max = num(ceiling.constraint.params, 'max')!;
    if (floor <= max) continue;
    // The conflict is between the ceiling and each requirement under it: every one of them is a
    // party to the overspend, and naming only the largest would hide the rest.
    for (const { by } of perOp.values()) {
      if (by.source.kind === ceiling.source.kind && by.source.id === ceiling.source.id && by.constraint.id === ceiling.constraint.id) {
        continue;
      }
      out.push(
        conflict(
          by,
          ceiling,
          `node budget: requirements on distinct ops name disjoint nodes, so their minima add — ` +
            `${terms} = ${floor}. ${ceiling.constraint.id} caps the tree at ${max}. ` +
            `${floor} > ${max}, so the required vocabulary does not fit on the surface.`
        )
      );
    }
  }
  return out;
}

// --- 4. forbidden vs required existence ----------------------------------------------------------

function existenceConflicts(all: Sourced[]): Conflict[] {
  const out: Conflict[] = [];

  const forbidsNode = all.filter((s) => s.constraint.kind === 'forbidNode');
  const requiresNode = all.filter((s) => s.constraint.kind === 'requireNode');
  for (const f of forbidsNode) {
    const ops = new Set(list(f.constraint.params, 'ops'));
    const macros = new Set(list(f.constraint.params, 'macros'));
    for (const r of requiresNode) {
      if ((num(r.constraint.params, 'min') ?? 1) < 1) continue;
      const op = str(r.constraint.params, 'op');
      const macro = str(r.constraint.params, 'macro');
      const hit = (op !== undefined && ops.has(op)) || (macro !== undefined && macros.has(macro));
      if (!hit) continue;
      out.push(
        conflict(
          r,
          f,
          `existence: ${r.constraint.id} requires at least ${num(r.constraint.params, 'min') ?? 1} ` +
            `${op ?? macro} node${(num(r.constraint.params, 'min') ?? 1) === 1 ? '' : 's'}, and ` +
            `${f.constraint.id} forbids every ${op ?? macro} node. A node cannot be both present and absent.`
        )
      );
    }
  }

  // requireMark is satisfied by a mark matching ANY of its styles or brushes, so it is only dead
  // when every one of them is forbidden. A requirement for {wash, field} against a prohibition on
  // {field} alone is still answerable with a wash, and must not be reported.
  const forbidsMark = all.filter((s) => s.constraint.kind === 'forbidMark');
  const requiresMark = all.filter((s) => s.constraint.kind === 'requireMark');
  for (const f of forbidsMark) {
    const fStyles = new Set(list(f.constraint.params, 'styles'));
    const fBrushes = new Set(list(f.constraint.params, 'brushes'));
    for (const r of requiresMark) {
      if ((num(r.constraint.params, 'min') ?? 1) < 1) continue;
      const rStyles = list(r.constraint.params, 'styles');
      const rBrushes = list(r.constraint.params, 'brushes');
      if (rStyles.length === 0 && rBrushes.length === 0) continue;
      if (!rStyles.every((s) => fStyles.has(s)) || !rBrushes.every((b) => fBrushes.has(b))) continue;
      const wanted = [...rStyles, ...rBrushes].join('/');
      out.push(
        conflict(
          r,
          f,
          `existence: ${r.constraint.id} requires at least ${num(r.constraint.params, 'min') ?? 1} ` +
            `${wanted} mark(s), and ${f.constraint.id} forbids every one of {${wanted}}. ` +
            `There is no remaining style or brush that could answer the requirement.`
        )
      );
    }
  }

  return out;
}

// --- 5. opposed text case ------------------------------------------------------------------------
//
// Only empty once some text is forced to carry a cased letter. `textRequired` is the one kind that
// forces one: its `contains` strings must appear in the joined text, so a string with a letter whose
// upper and lower forms differ puts a cased character on the sheet.
//
// Kept out of the headline on purpose. It is a real conflict and a thin one — a typography setting,
// not two lineages competing for the surface.

function hasCasedLetter(s: string): boolean {
  return [...s].some((ch) => ch.toUpperCase() !== ch.toLowerCase());
}

function textCaseConflicts(all: Sourced[]): Conflict[] {
  const forced = all.find(
    (s) => s.constraint.kind === 'textRequired' && list(s.constraint.params, 'contains').some(hasCasedLetter)
  );
  if (forced === undefined) return [];

  const cases = all.filter((s) => s.constraint.kind === 'textCase');
  const out: Conflict[] = [];
  for (let i = 0; i < cases.length; i++) {
    for (let j = i + 1; j < cases.length; j++) {
      const a = cases[i]!;
      const b = cases[j]!;
      const ca = str(a.constraint.params, 'case') === 'lower' ? 'lower' : 'upper';
      const cb = str(b.constraint.params, 'case') === 'lower' ? 'lower' : 'upper';
      if (ca === cb) continue;
      out.push(
        conflict(
          a,
          b,
          `text case: ${a.constraint.id} wants ${ca}case and ${b.constraint.id} wants ${cb}case. ` +
            `${forced.constraint.id} requires a string carrying a cased letter, and a cased letter ` +
            `is not equal to both its own upper and its own lower form.`
        )
      );
    }
  }
  return out;
}

// --- the whole tier ------------------------------------------------------------------------------

/**
 * Every conflict provable from the parameters, deduplicated by id and in a stable order.
 *
 * A pair can be reached by more than one rule — two `nodeCount` bounds are both a range emptiness
 * and, if requirements sit under the ceiling, a budget overspend. First proof wins, and the order is
 * the order the rules are listed here, so the surviving `note` is deterministic.
 *
 * The input is canonically sorted first, and that is load-bearing rather than tidy. `conflictId`
 * sorts its two keys, so the *set* of conflicts was already independent of argument order — but the
 * rules below walk pairs in list order, so which end landed in `a` and which in `b`, and the order
 * the budget rule lists its terms in, still followed the caller. Composing the same four elements in
 * two orders therefore produced two different-looking reports of the same composition. Sorting here
 * makes every pairwise loop see one order, so sides and proofs are stable too.
 */
export function deriveConflicts(unsorted: Sourced[]): Conflict[] {
  const key = (s: Sourced): string => `${s.source.kind}\u0000${s.source.id}\u0000${s.constraint.id}`;
  const all = [...unsorted].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const found = [
    ...rangeConflicts(all),
    ...paletteConflicts(all),
    ...existenceConflicts(all),
    ...textCaseConflicts(all),
    ...budgetConflicts(all),
  ];
  const seen = new Set<string>();
  return found.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
