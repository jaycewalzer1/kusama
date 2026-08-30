// The declared tier, and the stub for the observed one.
//
// A declared conflict is a material tension between two kinds that no algebra settles, so nothing
// here can check it. That is precisely why it is loaded from data with a `note` that has to cite the
// measurement: the file is the audit trail, and an entry without one is an assertion.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Conflict, ConflictSide } from './types.js';
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
 * Conflicts seen in a run rather than proven or declared: the artist honoured one commitment and
 * broke the other, and the log says so.
 *
 * Deliberately not built. It needs a run to read, and stage 1 does not wire this layer into one — so
 * the only thing that could be written here now is a signature and a guess about what a trajectory
 * will look like. Throwing is the honest version of that; returning `[]` would make every caller
 * quietly report that a run contained no observed conflicts, which is a much worse lie than an
 * error.
 */
export function observedConflicts(_run: unknown): Conflict[] {
  throw new Error('NotImplemented: observed conflicts need a wired run to read; stage 3');
}
