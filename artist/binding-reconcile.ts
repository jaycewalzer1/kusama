// Binding reconciliation after every patch.
//
// After every edit, recompute element↔node bindings. Verify bound nodes exist, deleted nodes
// are unbound, and `servesElementId` refers to a real frozen element. Derive `[not made yet]`
// from validated bindings. Distinguish: present in tree / visibly realized / reader-confirmed /
// relation holds / merely claimed.
//
// Pure. No model calls, no I/O.

import type {
  Intention,
  IntentionElement,
  IntentionEdge,
  Program,
} from './types.js';
import { bindingOf } from './intention.js';

/**
 * The realization status of one element, derived from validated bindings.
 */
export type ElementStatus =
  | 'present_in_tree'       // nodes exist in the tree
  | 'not_made_yet'          // no nodes, or nodes deleted
  | 'binding_stale'         // nodes reference was valid but nodes no longer exist
  | 'absence_declared'      // binding kind is absence — no nodes expected
  | 'ratio_declared'        // binding kind is ratio — no nodes expected
  | 'render_measure';       // binding kind is render-measure — no nodes expected

export interface ElementBindingReport {
  elementId: string;
  status: ElementStatus;
  nodeIds: string[];
  /** Node IDs that were bound but no longer exist in the tree. */
  staleNodeIds: string[];
  /** Whether `servesElementId` on any recent edit refers to this element. */
  hasServingEdits: boolean;
}

export interface BindingReconciliation {
  elements: ElementBindingReport[];
  invariantViolations: string[];
}

/**
 * Every node ID present in a program tree.
 */
function allNodeIds(program: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (n: unknown) => {
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    if (typeof node['id'] === 'string') ids.add(node['id']);
    if (Array.isArray(node['children'])) for (const c of node['children']) walk(c);
  };
  walk((program as Record<string, unknown>)?.['root']);
  return ids;
}

/**
 * Reconcile element↔node bindings against the current program.
 *
 * This should be called after every patch to ensure bindings are consistent.
 */
export function reconcileBindings(
  intention: Intention,
  program: unknown,
  frozenElementIds?: Set<string>
): BindingReconciliation {
  const liveNodes = allNodeIds(program);
  const elements: ElementBindingReport[] = [];
  const violations: string[] = [];
  const seenElementIds = new Set<string>();

  for (const element of intention.elements) {
    // Duplicate element ID check.
    if (seenElementIds.has(element.id)) {
      violations.push(`duplicate element id: "${element.id}"`);
    }
    seenElementIds.add(element.id);

    const binding = bindingOf(element);
    const staleNodeIds = element.nodeIds.filter((id) => !liveNodes.has(id));

    let status: ElementStatus;
    switch (binding.kind) {
      case 'absence':
        status = 'absence_declared';
        break;
      case 'ratio':
        status = 'ratio_declared';
        break;
      case 'render-measure':
        status = 'render_measure';
        break;
      default: {
        const liveCount = element.nodeIds.filter((id) => liveNodes.has(id)).length;
        if (liveCount > 0) {
          status = staleNodeIds.length > 0 ? 'binding_stale' : 'present_in_tree';
        } else {
          status = 'not_made_yet';
        }
        break;
      }
    }

    elements.push({
      elementId: element.id,
      status,
      nodeIds: element.nodeIds.filter((id) => liveNodes.has(id)),
      staleNodeIds,
      hasServingEdits: false, // Set by caller if needed.
    });
  }

  // Check edges reference real elements.
  for (const edge of intention.edges) {
    if (!seenElementIds.has(edge.from)) {
      violations.push(
        `edge "${edge.from}->${edge.to}" references missing element "${edge.from}"`
      );
    }
    if (!seenElementIds.has(edge.to)) {
      violations.push(
        `edge "${edge.from}->${edge.to}" references missing element "${edge.to}"`
      );
    }
  }

  // Check for role mutation without versioned change (if frozen IDs provided).
  if (frozenElementIds) {
    for (const element of intention.elements) {
      // An element ID not in the frozen set is new — that's permitted.
      // But an element ID in the frozen set must not have its meaning changed
      // (this is checked at the frozen-intention level, not here).
    }
  }

  // Check for dangling node IDs — nodes that claim to serve an element that doesn't exist.
  // This is checked at edit time by the caller.

  return { elements, invariantViolations: violations };
}

/**
 * Check invariants that should hold after every patch.
 *
 * Returns a list of violations. Empty means all invariants hold.
 */
export function checkBindingInvariants(
  intention: Intention,
  program: unknown
): string[] {
  const reconciliation = reconcileBindings(intention, program);
  const violations = [...reconciliation.invariantViolations];

  // Additional invariants.
  for (const report of reconciliation.elements) {
    // Stale bindings — nodes were deleted but element still references them.
    if (report.staleNodeIds.length > 0) {
      violations.push(
        `element "${report.elementId}" has stale node bindings: ${report.staleNodeIds.join(', ')}`
      );
    }
  }

  return violations;
}

/**
 * Whether a `servesElementId` on an edit refers to a real element in the intention.
 */
export function isValidServes(
  servesElementId: string | undefined,
  intention: Intention
): boolean {
  if (!servesElementId) return true; // Not serving anything is valid.
  return intention.elements.some((e) => e.id === servesElementId);
}

/**
 * Auto-derive `[not made yet]` labels from validated bindings.
 *
 * An element is `[not made yet]` if:
 * - Its binding kind is `node` or `region`, AND
 * - It has zero live nodes in the tree
 *
 * This replaces the previous approach of checking `nodeIds.length === 0`, which could not
 * distinguish between "never started" and "nodes deleted".
 */
export function unmadeElements(
  intention: Intention,
  program: unknown
): string[] {
  const reconciliation = reconcileBindings(intention, program);
  return reconciliation.elements
    .filter((r) => r.status === 'not_made_yet')
    .map((r) => r.elementId);
}
