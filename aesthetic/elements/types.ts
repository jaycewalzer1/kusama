// Lineage elements: position fragments that carry their own rules and their own prohibitions.
//
// A position is one coherent aesthetic program. An element is smaller and deliberately partial: a
// single inherited commitment, with the provenance that earns it and the cliches that come free with
// it. The claim this layer exists to make testable is about *blending* — what happens when one work
// has to hold two lineages whose rules cannot both be kept, and which commitment gets broken.
//
// So the unit of interest is not the element. It is the Conflict: a named, provable competition for
// a bounded resource between two named constraints from two named sources. Everything else here is
// scaffolding for producing those honestly.
//
// Reuses the closed sixteen constraint kinds and adds none. An element that wants something the
// medium cannot say records that in docs/artist/NEEDS.md and picks the nearest expressible thing;
// the alternative is a seventeenth kind per lineage, which is how a constraint language dies.

import type { Constraint } from '../types.js';

export interface LineageElement {
  id: string;
  name: string;
  provenance: {
    culture: string;
    period: string;
    note: string;
    /**
     * Shape-checked and non-empty, and that is *all* it is. Nothing in this repo can tell whether a
     * citation names a real book, and a test that asserted a non-empty string would read as though
     * something had. See docs/artist/NEEDS.md.
     */
    citation: string;
  };
  /** One or two sentences: the stance this fragment carries into a work that adopts it. */
  worldviewFragment: string;
  generativeRules: Constraint[];
  prohibitions: Constraint[];
  cliches: string[];
}

/** Where a constraint entered a composition from. Positions and elements namespace separately. */
export type SourceRef = { kind: 'position'; id: string } | { kind: 'element'; id: string };

/** One end of a conflict: which source, and which constraint *as that source wrote it*. */
export interface ConflictSide {
  source: SourceRef;
  /** The constraint's own id, not the namespaced one. `qualify()` joins the two back together. */
  constraintId: string;
}

/**
 * Three tiers, and the difference between them is who is answerable for the claim.
 *
 * `derived`  proven unsatisfiable by algebra over the two constraints' parameters. No browser, no
 *            corpus, no judgement. `note` carries the proof. This is the tier that earns the layer.
 * `declared` a material tension between two kinds that no algebra settles, seeded only from the
 *            measured table in docs/artist/element-preflight.md. A declared conflict is a claim
 *            about this medium, and it is only as good as the measurement behind it.
 * `observed` a conflict seen in a run. Not built; see ./conflicts.ts.
 *
 * Anything that is neither derived nor declared is not a conflict yet. Semantic oppositions — "the
 * margin speaks" against "the margin is silence" — are `rubric` scope, permanently unverified, and
 * that is the documented argument for building a judge rather than a substitute for one.
 */
export type ConflictTier = 'derived' | 'declared' | 'observed';

export interface Conflict {
  /** Stable hash of the sorted (source.kind, source.id, constraintId) pairs. Order-independent. */
  id: string;
  a: ConflictSide;
  b: ConflictSide;
  tier: ConflictTier;
  /** For `derived`, the proof. For `declared`, the measurement it was seeded from. */
  note: string;
}

/**
 * A position and some elements, flattened into one constraint list plus the conflicts inside it.
 *
 * Not `ComposedField`: `Field` is the FIND-stage document in artist/types.ts and reusing the word
 * would make two unrelated things read as the same thing.
 *
 * Composition may not refuse. `effectivePosition` (artist/field.ts) throws on an id collision, which
 * is right for a brief bolted onto a position — one report, one id. Here a collision is expected:
 * `p-no-illustration` is written verbatim in two positions on disk already, and an element pack that
 * could not be composed with a position that happens to share a constraint name would be useless.
 * So ids are namespaced on the way in instead.
 */
export interface Composition {
  constraints: Array<Constraint & { source: SourceRef }>;
  conflicts: Conflict[];
  elementPackHash: string;
}

/**
 * What a run did about a conflict. Defined now, emitted by nothing until stage 3.
 *
 * `avoided` is machine-derived and never self-reported: an artist asked whether it dodged a conflict
 * will say yes. In stage 1 the only honest definition available is node existence at finish — the
 * medium has no per-node pixel attribution (kinds.ts:230-234 leaves `nodeIds` empty for all four
 * render kinds), and artist/filmstrip.ts measures whole-sheet survival keyed on step, not per node.
 * So "the nodes carrying side A were painted over by side B" is not answerable here. NEEDS.md.
 */
export type Resolution =
  | {
      conflictId: string;
      verdict: 'honored_a_broke_b' | 'honored_b_broke_a';
      reason: string;
      nodeIds: string[];
    }
  | { conflictId: string; verdict: 'reconciled'; reason: string; nodeIds: string[] }
  | { conflictId: string; verdict: 'avoided' };

/** The id a constraint carries inside a Composition: `element:ma-interval/e-quiet`. */
export function qualify(source: SourceRef, constraintId: string): string {
  return `${source.kind}:${source.id}/${constraintId}`;
}
