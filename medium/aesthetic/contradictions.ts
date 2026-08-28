// Constraints that cannot all hold, computed before anything is drawn.
//
// A position composed with a brief can ask for two things that no program satisfies: text that is
// required and text nodes that are forbidden, a mark that must appear and must not, an ink density
// under 0.05 and over 0.20. Nothing used to notice. The run started, the artist spent a trajectory
// discovering by hand that one of the two could not be had, and the score reported a hard violation
// as though the artist had failed to satisfy something satisfiable.
//
// So this is a satisfiability check, not a quality check, and it is deliberately incomplete in one
// direction only: everything it reports is a real contradiction, and there are contradictions it
// cannot see. A pair it says nothing about is not certified consistent. That asymmetry is the whole
// design — a false positive here refuses a commission that could have been made, which is the
// expensive mistake.
//
// Only `hard` constraints are compared. Two soft constraints that pull against each other are a
// trade the artist is meant to make, and calling that unsatisfiable would delete the tension the
// position exists to hold.

import type { AestheticProgram, Constraint } from './types.js';

export interface Contradiction {
  /** The two constraint ids, in the order they appear in the position. Equal for a self-contradiction. */
  a: string;
  b: string;
  why: string;
}

/** Every hard constraint the checker would actually decide, from all three parts of the position. */
function hardConstraints(program: AestheticProgram): Constraint[] {
  const all = [
    ...program.commitments,
    ...program.prohibitions,
    ...program.generative_rules.map((r) => r.constraint).filter((c): c is Constraint => c !== undefined),
  ];
  // A blocked constraint is reported `unverified` and excluded from every score, so it cannot
  // contradict anything: nothing is being asked of the program. A rubric decides nothing at all.
  return all.filter((c) => c.severity === 'hard' && c.blocked_by === undefined && c.kind !== 'rubric');
}

function list(c: Constraint, key: string): string[] {
  const v = c.params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function str(c: Constraint, key: string): string | undefined {
  const v = c.params[key];
  return typeof v === 'string' ? v : undefined;
}

function num(c: Constraint, key: string): number | undefined {
  const v = c.params[key];
  return typeof v === 'number' ? v : undefined;
}

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return [...new Set(a.filter((x) => set.has(x)))];
}

/** What a `requireNode` asks for, as the same vocabulary `forbidNode` refuses. */
function required(c: Constraint): string[] {
  return [str(c, 'op'), str(c, 'macro')].filter((x): x is string => x !== undefined);
}

function forbidden(c: Constraint): string[] {
  return [...list(c, 'ops'), ...list(c, 'macros')];
}

/** The four kinds that name a numeric window over the same quantity, so two of them can miss. */
const RANGE_KINDS = new Set(['inkDensityRange', 'coverageRange', 'inkOffsetRange', 'nodeCount']);

/** Disjoint when one window ends before the other begins. An open end never excludes anything. */
function disjoint(a: Constraint, b: Constraint): boolean {
  const aMin = num(a, 'min');
  const aMax = num(a, 'max');
  const bMin = num(b, 'min');
  const bMax = num(b, 'max');
  if (aMin !== undefined && bMax !== undefined && aMin > bMax) return true;
  if (bMin !== undefined && aMax !== undefined && bMin > aMax) return true;
  return false;
}

function window(c: Constraint): string {
  const min = num(c, 'min');
  const max = num(c, 'max');
  return `[${min ?? '-inf'}, ${max ?? 'inf'}]`;
}

/**
 * Every pair of hard constraints that no program can satisfy at once, plus the one constraint that
 * contradicts itself.
 *
 * Five families, each one a set overlap or an interval miss — nothing here needs to know what the
 * position means, only what the checkers in ./kinds.ts do with these params.
 */
export function contradictions(program: AestheticProgram): Contradiction[] {
  const constraints = hardConstraints(program);
  const found: Contradiction[] = [];

  for (const c of constraints) {
    if (!RANGE_KINDS.has(c.kind)) continue;
    const min = num(c, 'min');
    const max = num(c, 'max');
    if (min !== undefined && max !== undefined && min > max) {
      found.push({ a: c.id, b: c.id, why: `${c.kind} asks for ${window(c)}, which is empty` });
    }
  }

  for (let i = 0; i < constraints.length; i++) {
    for (let j = i + 1; j < constraints.length; j++) {
      const a = constraints[i]!;
      const b = constraints[j]!;

      if (a.kind === b.kind && RANGE_KINDS.has(a.kind) && disjoint(a, b)) {
        found.push({ a: a.id, b: b.id, why: `${a.kind} ${window(a)} and ${window(b)} do not meet` });
      }

      if (a.kind === 'textCase' && b.kind === 'textCase' && str(a, 'case') !== str(b, 'case')) {
        found.push({ a: a.id, b: b.id, why: `text cannot be ${str(a, 'case') ?? 'upper'} and ${str(b, 'case') ?? 'upper'} at once` });
      }

      for (const [need, deny] of [[a, b], [b, a]] as const) {
        if (need.kind === 'requireNode' && deny.kind === 'forbidNode') {
          const both = overlap(required(need), forbidden(deny));
          if (both.length > 0) {
            found.push({ a: need.id, b: deny.id, why: `${both.join(', ')} is both required and forbidden` });
          }
        }
        if (need.kind === 'requireMark' && deny.kind === 'forbidMark') {
          const both = overlap(
            [...list(need, 'styles'), ...list(need, 'brushes')],
            [...list(deny, 'styles'), ...list(deny, 'brushes')]
          );
          if (both.length > 0) {
            found.push({ a: need.id, b: deny.id, why: `mark ${both.join(', ')} is both required and forbidden` });
          }
        }
        // The one that is not a symmetric pair of kinds: a required string has to be written by a
        // text op, so forbidding the op forbids the string. `textRequired` names no op, which is why
        // this is worth stating rather than leaving to the two node kinds above.
        if (need.kind === 'textRequired' && deny.kind === 'forbidNode' && list(need, 'contains').length > 0) {
          if (forbidden(deny).includes('text')) {
            found.push({
              a: need.id,
              b: deny.id,
              why: `"${list(need, 'contains').join('", "')}" has to be printed and the text op is forbidden`,
            });
          }
        }
      }
    }
  }
  return found;
}
