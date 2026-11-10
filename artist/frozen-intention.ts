// Frozen intention semantics.
//
// After CHOOSE, the intention's core identity is frozen: purpose, central tension, element
// IDs/roles, edge IDs/types/claims, refusals/immovable terms, rubric identities, and the plan
// wager. MAKE replans may change bindings, tactics, edge-holds, predicted steps, evidence,
// invalidations, and branches — but never reuse an element ID for a new meaning, rewrite
// purpose/tension, drop a failed edge or immovable term, or weaken a hard rubric.
//
// Semantic changes require an explicit versioned event recording old/new hashes, the diff,
// why the old contract failed, what wager/commitment broke, what was invalidated, where the
// loop returns to, and the new branch ID.
//
// Pure. No model calls, no I/O.

import { contentHash, canonicalJson } from '../env/profile.js';
import type { Intention, IntentionElement, IntentionEdge, Terms } from './types.js';

/**
 * The frozen core of an intention. Everything here is immutable after CHOOSE; changes to any
 * of these fields require an explicit `SemanticRevision`.
 */
export interface FrozenCore {
  purpose: string;
  tension: { between: string; and: string; claim: string };
  /** Element IDs and their roles at freeze time. */
  elements: { id: string; role: string }[];
  /** Edge identities (from/to/type/claim) at freeze time. */
  edges: { from: string; to: string; type: string; claim: string }[];
  /** Terms immovable at freeze time. */
  immovableTerms: string[];
  /** The wager ID, if one was set. */
  wagerId: string | null;
}

/**
 * Canonical serialization of a frozen core, suitable for hashing.
 */
export function serializeFrozen(core: FrozenCore): string {
  return canonicalJson(core);
}

/**
 * Hash a frozen core for identity tracking.
 */
export function frozenHash(core: FrozenCore): string {
  return contentHash(serializeFrozen(core));
}

/**
 * Extract the frozen core from an intention and terms.
 */
export function freezeIntention(
  intention: Intention,
  terms: Terms | null,
  wagerId: string | null
): FrozenCore {
  return {
    purpose: intention.purpose,
    tension: { ...intention.tension },
    elements: intention.elements.map((e) => ({ id: e.id, role: e.role })),
    edges: intention.edges.map((e) => ({
      from: e.from,
      to: e.to,
      type: e.type,
      claim: e.claim,
    })),
    immovableTerms: terms?.willNotChange ?? [],
    wagerId,
  };
}

/**
 * What changed between two frozen cores. Used to detect illegal mutations and to document
 * legal semantic revisions.
 */
export interface FrozenDiff {
  purposeChanged: boolean;
  tensionChanged: boolean;
  elementsAdded: string[];
  elementsRemoved: string[];
  /** Elements whose role changed — reusing an ID for a new meaning. */
  elementsRoleMutated: { id: string; oldRole: string; newRole: string }[];
  edgesAdded: string[];
  edgesRemoved: string[];
  immovableTermsDropped: string[];
}

/**
 * Compute the diff between two frozen cores.
 */
export function diffFrozen(before: FrozenCore, after: FrozenCore): FrozenDiff {
  const beforeElements = new Map(before.elements.map((e) => [e.id, e.role]));
  const afterElements = new Map(after.elements.map((e) => [e.id, e.role]));

  const elementsAdded = after.elements
    .filter((e) => !beforeElements.has(e.id))
    .map((e) => e.id);
  const elementsRemoved = before.elements
    .filter((e) => !afterElements.has(e.id))
    .map((e) => e.id);
  const elementsRoleMutated = after.elements
    .filter((e) => {
      const oldRole = beforeElements.get(e.id);
      return oldRole !== undefined && oldRole !== e.role;
    })
    .map((e) => ({
      id: e.id,
      oldRole: beforeElements.get(e.id)!,
      newRole: e.role,
    }));

  const edgeKey = (e: { from: string; to: string; type: string }) =>
    `${e.from}|${e.type}|${e.to}`;
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));

  const edgesAdded = after.edges
    .filter((e) => !beforeEdges.has(edgeKey(e)))
    .map(edgeKey);
  const edgesRemoved = before.edges
    .filter((e) => !afterEdges.has(edgeKey(e)))
    .map(edgeKey);

  const afterImmovable = new Set(after.immovableTerms);
  const immovableTermsDropped = before.immovableTerms.filter(
    (t) => !afterImmovable.has(t)
  );

  return {
    purposeChanged: before.purpose !== after.purpose,
    tensionChanged: canonicalJson(before.tension) !== canonicalJson(after.tension),
    elementsAdded,
    elementsRemoved,
    elementsRoleMutated,
    edgesAdded,
    edgesRemoved,
    immovableTermsDropped,
  };
}

/**
 * Whether a diff represents only permitted MAKE-phase changes (bindings, tactics, evidence)
 * versus illegal semantic mutations that require an explicit revision event.
 */
export function isLegalReplan(diff: FrozenDiff): boolean {
  // Illegal: rewriting purpose or tension, reusing element ID for new meaning, dropping
  // failed edges or immovable terms, removing elements.
  if (diff.purposeChanged) return false;
  if (diff.tensionChanged) return false;
  if (diff.elementsRoleMutated.length > 0) return false;
  if (diff.elementsRemoved.length > 0) return false;
  if (diff.edgesRemoved.length > 0) return false;
  if (diff.immovableTermsDropped.length > 0) return false;
  // Adding new elements and edges is permitted — the plan can grow.
  return true;
}

/**
 * A versioned semantic revision event. Required when `isLegalReplan` returns false.
 */
export interface SemanticRevision {
  eventSeq: number;
  kind: 'revise_problem' | 'break_commitment';
  oldHash: string;
  newHash: string;
  diff: FrozenDiff;
  /** Why the old contract failed. */
  failureReason: string;
  /** Which wager or commitment broke. */
  brokenCommitment: string;
  /** What was invalidated by this revision. */
  invalidated: string[];
  /** Where the loop returns to after this revision. */
  returnsTo: string;
  /** The new branch ID, if branching. */
  newBranchId: string | null;
}

/**
 * Validate that a replanned intention does not illegally mutate frozen semantics.
 *
 * Returns null if the replan is legal, or a list of violations if it is not.
 */
export function validateReplan(
  frozen: FrozenCore,
  replanned: Intention,
  terms: Terms | null
): string[] | null {
  const newCore = freezeIntention(replanned, terms, frozen.wagerId);
  const diff = diffFrozen(frozen, newCore);
  if (isLegalReplan(diff)) return null;

  const violations: string[] = [];
  if (diff.purposeChanged) violations.push('purpose changed without a semantic revision');
  if (diff.tensionChanged) violations.push('tension changed without a semantic revision');
  for (const m of diff.elementsRoleMutated) {
    violations.push(
      `element "${m.id}" role mutated from "${m.oldRole}" to "${m.newRole}" — reusing an element ID for a new meaning`
    );
  }
  for (const id of diff.elementsRemoved) {
    violations.push(`element "${id}" removed without a semantic revision`);
  }
  for (const k of diff.edgesRemoved) {
    violations.push(`edge ${k} removed without a semantic revision`);
  }
  for (const t of diff.immovableTermsDropped) {
    violations.push(`immovable term "${t}" dropped without a semantic revision`);
  }
  return violations;
}
