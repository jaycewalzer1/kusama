// compose: one position plus some elements, flattened into one constraint list and the conflicts
// inside it. Pure, deterministic and total.
//
// Total is the requirement that shapes the whole file. `effectivePosition` (artist/field.ts:415)
// throws when a brief's constraint id collides with the position's, and for a brief that is right:
// one report, one id, and an ambiguous report is worse than a refusal. Here refusing would be wrong.
// `p-no-illustration` is already written verbatim in two positions on disk, elements are picked by
// hand from a shared vocabulary, and a composition that could not be formed because two lineages
// happened to name a rule the same way would make the conflict unaskable — which is the one question
// this layer exists to ask. So ids are namespaced by source on the way in instead.
//
// Namespacing changes report output: a constraint that read `p-no-illustration` now reads
// `position:cut-and-reset/p-no-illustration`. That is blessed.
//
// Note what compose does NOT do: it does not drop, merge, weaken or reconcile anything. Both sides
// of a conflict go into `constraints` intact and both will be checked and get a real verdict. A
// conflict is a decision point, not an excuse to stop deciding — the moment composition started
// resolving conflicts by dropping a side, the score would improve every time two lineages disagreed,
// and the layer would be measuring its own tidying rather than the artist's choice.

import { constraintsOf } from '../check.js';
import type { AestheticProgram, Constraint } from '../types.js';
import { deriveConflicts, type Sourced } from './derive.js';
import { declaredConflicts, matchDeclared, type DeclaredConflict } from './conflicts.js';
import { elementPackHash } from './pack.js';
import { qualify, type Composition, type Conflict, type LineageElement, type SourceRef } from './types.js';

/** Constraints in source order: the position first, then each element as it was passed. */
function flatten(position: AestheticProgram, elements: LineageElement[]): Sourced[] {
  const out: Sourced[] = [];
  const from: SourceRef = { kind: 'position', id: position.id };
  for (const { constraint } of constraintsOf(position)) out.push({ constraint, source: from });
  for (const e of elements) {
    const src: SourceRef = { kind: 'element', id: e.id };
    for (const c of [...e.generativeRules, ...e.prohibitions]) out.push({ constraint: c, source: src });
  }
  return out;
}

/**
 * `declared` is injectable so a test can compose against a known table instead of the shipped one.
 * It defaults to the pack's `conflicts.json`, read once; that read is deterministic, so the default
 * does not cost `compose` its purity.
 */
export function compose(
  position: AestheticProgram,
  elements: LineageElement[],
  declared: DeclaredConflict[] = declaredConflicts()
): Composition {
  const sourced = flatten(position, elements);

  const constraints: Array<Constraint & { source: SourceRef }> = sourced.map(({ constraint, source }) => ({
    ...constraint,
    id: qualify(source, constraint.id),
    source,
  }));

  // Derived first, then declared, and a pair already proven is not re-reported as a claim: a proof
  // outranks a measurement about the same two constraints.
  //
  // Sorted by id within each tier so that the conflict list depends on the *set* of elements and not
  // on the order they were passed, which is the property `elementPackHash` already has. Without it a
  // caller that reordered its arguments would get a different-looking Composition describing the
  // same composition.
  const byId = (x: Conflict, y: Conflict): number => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const derived = deriveConflicts(sourced).sort(byId);
  const seen = new Set(derived.map((c) => c.id));
  const conflicts: Conflict[] = [
    ...derived,
    ...matchDeclared(sourced, declared)
      .filter((c) => !seen.has(c.id))
      .sort(byId),
  ];

  return { constraints, conflicts, elementPackHash: elementPackHash(elements) };
}
