// The declared tier and the observed one.
//
// A declared conflict is a material tension between two kinds that no algebra settles, so nothing
// here can check it. That is precisely why it is loaded from data with a `note` that has to cite the
// measurement: the file is the audit trail, and an entry without one is an assertion.
//
// An observed conflict is the opposite kind of claim. Nobody asserted it and nothing proves it: a
// run passed through some states, and in every one of them these two could not both be had. It is
// the weakest of the three tiers and the only one that can be wrong in the interesting direction —
// a longer run might find the state that satisfies both — so its `note` always says how many states
// it looked at.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Composition, Conflict, ConflictSide, SourceRef } from './types.js';
import { conflictId, type Sourced } from './derive.js';
import { PACK_DIR } from './pack.js';

export interface DeclaredConflict {
  a: ConflictSide;
  b: ConflictSide;
  note: string;
}

let cached: DeclaredConflict[] | null = null;

/** Read once. The file is data, not configuration: it does not change while a process runs. */
export function declaredConflicts(): DeclaredConflict[] {
  if (cached === null) {
    const raw = JSON.parse(readFileSync(path.join(PACK_DIR, 'conflicts.json'), 'utf8')) as {
      conflicts: DeclaredConflict[];
    };
    cached = raw.conflicts;
  }
  return cached;
}

function same(a: ConflictSide, s: Sourced): boolean {
  return a.source.kind === s.source.kind && a.source.id === s.source.id && a.constraintId === s.constraint.id;
}

/**
 * The declared entries whose *both* ends are actually present in this composition.
 *
 * An entry naming a constraint nobody composed is skipped in silence rather than reported. It is not
 * a conflict in this work: two lineages that were never brought together have nothing to settle, and
 * emitting it would put a decision point in a report about a choice the artist was never offered.
 */
export function matchDeclared(all: Sourced[], declared: DeclaredConflict[]): Conflict[] {
  const out: Conflict[] = [];
  for (const d of declared) {
    const a = all.find((s) => same(d.a, s));
    const b = all.find((s) => same(d.b, s));
    if (a === undefined || b === undefined) continue;
    out.push({ id: conflictId(d.a, d.b), a: d.a, b: d.b, tier: 'declared', note: d.note });
  }
  return out;
}

/**
 * One state a run passed through, as the checker saw it.
 *
 * Both lists, not one. `Status` has three values, so "not violated" is not "satisfied" — a
 * constraint the checker could not decide is `unverified`, and counting it as held is exactly the
 * mistake that would let an unobservable pair look compatible.
 */
export interface ObservedState {
  /** Step number, for the note. The seed state is 0. */
  k: number;
  /** Namespaced ids, as they appear in `Composition.constraints`. */
  satisfied: string[];
  violated: string[];
}

/**
 * Conflicts seen in a run rather than proven or declared.
 *
 * The rule, and it is deliberately narrow: two constraints the run decided at least once, where some
 * observed state held A while breaking B, some other state held B while breaking A, and **no**
 * observed state held both. That last clause is what makes it a conflict rather than a coincidence —
 * without it, any two constraints that were ever both violated at different moments would qualify,
 * which describes almost every pair in a long run.
 *
 * The two may share a source. That is a position or an element that cannot fully hold itself, and it
 * is the same thing `deriveConflicts` reports when it can prove one.
 *
 * What it is not: proof. A run is a sample of the states this medium can reach, and a pair reported
 * here may simply not have been given a state that satisfies both. So the note carries the count of
 * states examined, and a caller that wants to say "these cannot be had together" has to decide for
 * itself whether that many states is enough. The tier is named `observed` and not `proven` for
 * exactly this reason.
 *
 * Pairs the composition already knows about are dropped rather than re-reported: a proof or a
 * measurement outranks a sample of the same two constraints, the same precedence `compose` uses.
 */
export function observedConflicts(composition: Composition, states: ObservedState[]): Conflict[] {
  // One state cannot show a trade: the two clauses below need two different states by construction.
  if (states.length < 2) return [];

  const sourceOf = new Map<string, SourceRef>(composition.constraints.map((c) => [c.id, c.source]));
  const known = new Set(composition.conflicts.map((c) => c.id));
  const held = states.map((s) => new Set(s.satisfied));
  const broke = states.map((s) => new Set(s.violated));

  // Only constraints this run actually decided at least once. A constraint that was `unverified` in
  // every state has no evidence either way and must not be paired with anything.
  const decided = composition.constraints.map((c) => c.id).filter((id) => held.some((h) => h.has(id)) || broke.some((b) => b.has(id)));

  const out: Conflict[] = [];
  for (let i = 0; i < decided.length; i++) {
    for (let j = i + 1; j < decided.length; j++) {
      const x = decided[i]!;
      const y = decided[j]!;
      const sx = sourceOf.get(x)!;
      const sy = sourceOf.get(y)!;
      // Two constraints of one source are eligible, exactly as they are in `deriveConflicts` —
      // which does report `position:withheld/c-covered x position:withheld/g-few`, a position that
      // cannot fully hold itself. Excluding them here would make the observed tier answer a
      // narrower question than the other two, and no report would say which question had been
      // asked. The cross-source rule belongs where it means something: in `breaks.ts`, deciding
      // what *forced* a break.

      const xNotY = states.findIndex((_, k) => held[k]!.has(x) && broke[k]!.has(y));
      const yNotX = states.findIndex((_, k) => held[k]!.has(y) && broke[k]!.has(x));
      if (xNotY === -1 || yNotX === -1) continue;
      if (states.some((_, k) => held[k]!.has(x) && held[k]!.has(y))) continue;

      const a: ConflictSide = { source: sx, constraintId: bare(x) };
      const b: ConflictSide = { source: sy, constraintId: bare(y) };
      const id = conflictId(a, b);
      if (known.has(id)) continue;
      out.push({
        id,
        a,
        b,
        tier: 'observed',
        note:
          `${x} held at k${states[xNotY]!.k} while ${y} was violated; ` +
          `${y} held at k${states[yNotX]!.k} while ${x} was violated; ` +
          `no state among the ${states.length} observed held both.`,
      });
    }
  }
  return out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** `element:ma-interval/e-quiet` back to `e-quiet`. The inverse of `qualify` on the id half. */
function bare(qualified: string): string {
  const slash = qualified.indexOf('/');
  return slash === -1 ? qualified : qualified.slice(slash + 1);
}
