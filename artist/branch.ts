// Immutable branches and strategic backtracking.
//
// Failed branches are never overwritten. Each branch records its identity, parent, fork event,
// source snapshot, consumed budget, terminal reason, and wager IDs. Budgets are global; branching
// creates no free compute.
//
// A recovery diagnosis names what failed and where to backtrack to. "Materially different" is
// defined by structured plan/element/relation diffs, not prose.
//
// Pure. No model calls, no I/O.

import { contentHash, canonicalJson } from '../env/profile.js';
import type { Intention, IntentionElement, IntentionEdge, Program } from './types.js';

export type RecoveryDiagnosis =
  | 'local_execution_error'
  | 'element_realization_failure'
  | 'relation_failure'
  | 'selected_plan_falsified'
  | 'artistic_problem_falsified'
  | 'medium_capability_failure'
  | 'reader_uncertain'
  | 'no_actionable_diagnosis';

export interface RecoveryEvidence {
  diagnosis: RecoveryDiagnosis;
  /** Which reads or rubrics support this diagnosis. */
  readEventSeqs: number[];
  /** Which rubric IDs failed. */
  failedRubricIds: string[];
  /** Which elements failed to realize. */
  failedElements: string[];
  /** Which edges failed. */
  failedEdges: string[];
}

export interface Branch {
  id: string;
  parentId: string | null;
  forkEventSeq: number;
  /** Hash of the program at the fork point. */
  sourceSnapshotHash: string;
  /** Which problem this branch is working on. */
  problemId: string;
  /** Which sketch(es) this branch started from. */
  sketchIds: string[];
  budgetConsumed: number;
  terminalReason: string;
  wagerIds: string[];
  /** The frozen intention hash at the start of this branch. */
  intentionHash: string;
  /** Archive descriptor: what this branch was trying and why it stopped. */
  archiveDescriptor: string;
  /** Whether this branch is still active. */
  active: boolean;
  /** Steps consumed on this branch specifically. */
  steps: number;
}

export interface BranchState {
  branches: Branch[];
  activeBranchId: string;
  /** Total budget consumed across all branches. */
  totalBudgetConsumed: number;
  /** Stall tracking: consecutive reads with no movement on primary failed hard rubric. */
  consecutiveUnchangedReads: number;
  lastFailedRubricIds: string[];
}

/**
 * Create the initial branch state at CHOOSE.
 */
export function initialBranchState(args: {
  problemId: string;
  sketchIds: string[];
  intentionHash: string;
  programHash: string;
  forkEventSeq: number;
}): BranchState {
  const rootBranch: Branch = {
    id: 'root',
    parentId: null,
    forkEventSeq: args.forkEventSeq,
    sourceSnapshotHash: args.programHash,
    problemId: args.problemId,
    sketchIds: args.sketchIds,
    budgetConsumed: 0,
    terminalReason: '',
    wagerIds: [],
    intentionHash: args.intentionHash,
    archiveDescriptor: '',
    active: true,
    steps: 0,
  };
  return {
    branches: [rootBranch],
    activeBranchId: 'root',
    totalBudgetConsumed: 0,
    consecutiveUnchangedReads: 0,
    lastFailedRubricIds: [],
  };
}

/**
 * Record a step on the active branch.
 */
export function recordBranchStep(state: BranchState): BranchState {
  const branches = state.branches.map((b) =>
    b.id === state.activeBranchId
      ? { ...b, budgetConsumed: b.budgetConsumed + 1, steps: b.steps + 1 }
      : b
  );
  return {
    ...state,
    branches,
    totalBudgetConsumed: state.totalBudgetConsumed + 1,
  };
}

/**
 * Track read results for stall detection.
 *
 * Policy: one failed read → bounded local repair if diagnosis is local. Two consecutive reads
 * with no movement on the primary failed hard rubric → no more near-identical repairs.
 */
export function trackRead(
  state: BranchState,
  failedRubricIds: string[]
): BranchState {
  const sameFailure =
    failedRubricIds.length > 0 &&
    state.lastFailedRubricIds.length > 0 &&
    failedRubricIds.every((id) => state.lastFailedRubricIds.includes(id)) &&
    state.lastFailedRubricIds.every((id) => failedRubricIds.includes(id));

  return {
    ...state,
    consecutiveUnchangedReads: sameFailure
      ? state.consecutiveUnchangedReads + 1
      : failedRubricIds.length > 0 ? 1 : 0,
    lastFailedRubricIds: failedRubricIds,
  };
}

/**
 * Whether the stall condition is met: two consecutive reads with no movement on the primary
 * failed hard rubric.
 */
export function isStalled(state: BranchState): boolean {
  return state.consecutiveUnchangedReads >= 2;
}

/**
 * Diagnose what went wrong, using the evidence available.
 */
export function diagnose(evidence: {
  failedRubricIds: string[];
  failedElements: string[];
  failedEdges: string[];
  readEventSeqs: number[];
  executionError: boolean;
  readerUncertain: boolean;
}): RecoveryEvidence {
  let diagnosis: RecoveryDiagnosis = 'no_actionable_diagnosis';

  if (evidence.executionError) {
    diagnosis = 'local_execution_error';
  } else if (evidence.failedElements.length > 0 && evidence.failedEdges.length === 0) {
    diagnosis = 'element_realization_failure';
  } else if (evidence.failedEdges.length > 0 && evidence.failedElements.length === 0) {
    diagnosis = 'relation_failure';
  } else if (evidence.failedElements.length > 0 && evidence.failedEdges.length > 0) {
    diagnosis = 'selected_plan_falsified';
  } else if (evidence.readerUncertain) {
    diagnosis = 'reader_uncertain';
  }

  return {
    diagnosis,
    readEventSeqs: evidence.readEventSeqs,
    failedRubricIds: evidence.failedRubricIds,
    failedElements: evidence.failedElements,
    failedEdges: evidence.failedEdges,
  };
}

/**
 * Archive the current branch and create a new one.
 *
 * The old branch is marked inactive with its terminal reason. The new branch starts from
 * the specified fork point.
 */
export function forkBranch(
  state: BranchState,
  args: {
    reason: string;
    archiveDescriptor: string;
    newBranchId: string;
    newProblemId: string;
    newSketchIds: string[];
    newIntentionHash: string;
    newProgramHash: string;
    forkEventSeq: number;
    wagerIds: string[];
  }
): BranchState {
  const branches = state.branches.map((b) =>
    b.id === state.activeBranchId
      ? {
          ...b,
          active: false,
          terminalReason: args.reason,
          archiveDescriptor: args.archiveDescriptor,
          wagerIds: args.wagerIds,
        }
      : b
  );
  const newBranch: Branch = {
    id: args.newBranchId,
    parentId: state.activeBranchId,
    forkEventSeq: args.forkEventSeq,
    sourceSnapshotHash: args.newProgramHash,
    problemId: args.newProblemId,
    sketchIds: args.newSketchIds,
    budgetConsumed: 0,
    terminalReason: '',
    wagerIds: [],
    intentionHash: args.newIntentionHash,
    archiveDescriptor: '',
    active: true,
    steps: 0,
  };
  return {
    ...state,
    branches: [...branches, newBranch],
    activeBranchId: args.newBranchId,
    consecutiveUnchangedReads: 0,
    lastFailedRubricIds: [],
  };
}

/**
 * Whether two intentions are materially different.
 *
 * Defined by structured element/edge diffs, not prose. Two intentions are materially different if:
 * - Different element IDs (not just reworded roles)
 * - Different edge structure (from/to/type, not just claim rewording)
 * - Different purpose hash (the purpose text itself changed structurally)
 *
 * This prevents state ping-pong: an intention that adds a word to the purpose and changes nothing
 * else is not materially different.
 */
export function materiallyDifferent(a: Intention, b: Intention): boolean {
  const aIds = new Set(a.elements.map((e) => e.id));
  const bIds = new Set(b.elements.map((e) => e.id));
  if (aIds.size !== bIds.size) return true;
  for (const id of aIds) if (!bIds.has(id)) return true;

  const edgeKey = (e: IntentionEdge) => `${e.from}|${e.type}|${e.to}`;
  const aEdges = new Set(a.edges.map(edgeKey));
  const bEdges = new Set(b.edges.map(edgeKey));
  if (aEdges.size !== bEdges.size) return true;
  for (const k of aEdges) if (!bEdges.has(k)) return true;

  // Purpose must be structurally different, not just reworded.
  // Use sentence count and key noun extraction as a proxy.
  const aSentences = a.purpose.split(/[.!?]+/).filter((s) => s.trim().length > 5).length;
  const bSentences = b.purpose.split(/[.!?]+/).filter((s) => s.trim().length > 5).length;
  if (Math.abs(aSentences - bSentences) > 1) return true;

  return false;
}
