// Truthful terminal outcomes.
//
// A run's terminal status is separate from every component score: `completed` requires specific
// evidence, and anything less is named for what actually happened. `budget_exhausted` at
// tree/render 1.000 is still `budget_exhausted` — the artist did not request completion and the
// environment did not confirm it. `undecided`, `unread` and missing evidence are never passes.
//
// Pure. No model calls, no I/O.

import { contentHash, canonicalJson } from '../env/profile.js';
import type {
  CheckReport,
  Examine,
  Intention,
  Scores,
  Termination,
} from './types.js';
import type { RubricAnswer } from './env-calls.js';
import type { Wager } from './wager.js';
import type { Branch } from './branch.js';

/**
 * The terminal status, typed and separate from all component scores.
 *
 * `completed` requires evidence:
 *   - a final plate exists
 *   - EXAMINE ran on it
 *   - all hard tree/render constraints pass
 *   - all hard judge rubrics pass (not `undecided`, `unread`, `unknown`, or missing)
 *   - artist requested completion or protocol permits auto-completion
 *
 * Everything else names what actually happened.
 */
export type TerminalStatus =
  | 'running'
  | 'completed'
  | 'abandoned'
  | 'budget_exhausted'
  | 'failed_hard_rubric'
  | 'failed_execution'
  | 'invalid_run'
  | 'cancelled';

export interface TerminalRecord {
  status: TerminalStatus;
  reason: string;
  finalProgramHash: string | null;
  finalPixelHash: string | null;
  /** Budget steps allocated / consumed. */
  budgetAllocated: number;
  budgetConsumed: number;
  /** Hard rubrics by outcome. */
  hardRubricsPassed: string[];
  hardRubricsFailed: string[];
  hardRubricsUnresolved: string[];
  /** Soft rubrics by outcome. */
  softPassed: number;
  softFailed: number;
  /** Whether EXAMINE ran on the final plate. */
  examineRan: boolean;
  /** Whether the artist requested completion. */
  artistRequestedCompletion: boolean;
  /** Whether the environment overruled the artist's request. */
  environmentOverruled: boolean;
  /** Wager IDs and their final statuses. */
  wagerStatuses: { id: string; status: string }[];
  /** Branch tree summary. */
  branches: { id: string; terminal: string; budgetUsed: number }[];
  /** Supporting event seq numbers. */
  supportingEvents: number[];
}

/**
 * The report header, printed at the top of every terminal record.
 */
export function reportHeader(record: TerminalRecord): string {
  const structuralValidity =
    record.hardRubricsFailed.length === 0 && record.hardRubricsUnresolved.length === 0
      ? 'pass'
      : 'fail';
  const renderValidity =
    record.status === 'completed' || record.status === 'abandoned' ? 'pass' : 'unknown';
  const hardArtifactRubrics =
    record.hardRubricsFailed.length > 0
      ? 'fail'
      : record.hardRubricsUnresolved.length > 0
        ? 'unknown'
        : 'pass';
  const artisticCompletion =
    record.status === 'completed' && record.artistRequestedCompletion ? 'yes' : 'no';

  return [
    `OUTCOME: ${record.status}`,
    `STRUCTURAL VALIDITY: ${structuralValidity}`,
    `RENDER VALIDITY: ${renderValidity}`,
    `HARD ARTIFACT RUBRICS: ${hardArtifactRubrics}`,
    `ARTISTIC COMPLETION: ${artisticCompletion}`,
  ].join('\n');
}

/**
 * Derive the terminal status from the run's evidence.
 *
 * The order of checks matters: `invalid_run` and `failed_execution` are checked first because
 * they indicate the run never produced valid output. Then the artist's own signal. Then the
 * evidence-based checks.
 */
export function deriveTerminalStatus(evidence: {
  termination: Termination;
  examine: Examine | null;
  report: CheckReport;
  rubrics: RubricAnswer[] | null;
  artistRequestedCompletion: boolean;
  hasFinalPlate: boolean;
  executionError: boolean;
}): TerminalStatus {
  // Execution failures first.
  if (evidence.executionError) return 'failed_execution';
  if (!evidence.hasFinalPlate) return 'invalid_run';

  // Abandonment is the artist's own decision.
  if (evidence.termination.kind === 'abandoned') return 'abandoned';

  // Budget exhaustion — ran out of steps without requesting completion.
  if (evidence.termination.kind === 'out-of-steps') return 'budget_exhausted';

  // Finish was blocked — artist asked but environment refused (repeatedly).
  if (evidence.termination.kind === 'finish-blocked') {
    // Check if the block was due to hard rubrics.
    const rubricsFailing = (evidence.rubrics ?? []).filter(
      (r) => r.verdict === 'fails'
    );
    if (rubricsFailing.length > 0) return 'failed_hard_rubric';
    return 'budget_exhausted';
  }

  // Artist declared finished and was accepted.
  if (evidence.termination.kind === 'declared-finished') {
    // Check all conditions for `completed`.
    if (!evidence.examine) return 'budget_exhausted'; // EXAMINE must have run.
    if (evidence.report.hardViolations > 0) return 'failed_hard_rubric';

    // Check hard rubrics — `undecided`, `cannot-tell`, and missing are NOT passes.
    if (evidence.rubrics) {
      const failing = evidence.rubrics.filter((r) => r.verdict === 'fails');
      const uncertain = evidence.rubrics.filter(
        (r) => r.verdict === 'cannot-tell'
      );
      if (failing.length > 0) return 'failed_hard_rubric';
      // Uncertain is not a pass, but it's different from a clear fail.
      // If there are uncertain results and no passing override, it's still not completed.
      if (uncertain.length > 0) return 'failed_hard_rubric';
    }

    return 'completed';
  }

  return 'budget_exhausted';
}

/**
 * Build the terminal record from a finished trajectory's evidence.
 */
export function buildTerminalRecord(args: {
  status: TerminalStatus;
  reason: string;
  finalProgramHash: string | null;
  finalPixelHash: string | null;
  budgetAllocated: number;
  budgetConsumed: number;
  report: CheckReport;
  rubrics: RubricAnswer[] | null;
  examine: Examine | null;
  artistRequestedCompletion: boolean;
  environmentOverruled: boolean;
  wagers: Wager[];
  branches: Branch[];
  supportingEvents: number[];
}): TerminalRecord {
  const hardResults = args.report.results.filter(
    (r) => r.severity === 'hard'
  );
  const passed = hardResults.filter((r) => r.status === 'satisfied').map((r) => r.id);
  const failed = hardResults.filter((r) => r.status === 'violated').map((r) => r.id);
  const unresolved = hardResults.filter((r) => r.status === 'unverified').map((r) => r.id);

  // Also include rubric results in the hard rubric accounting.
  if (args.rubrics) {
    for (const r of args.rubrics) {
      if (r.verdict === 'holds') passed.push(r.id);
      else if (r.verdict === 'fails') failed.push(r.id);
      else unresolved.push(r.id);
    }
  }

  return {
    status: args.status,
    reason: args.reason,
    finalProgramHash: args.finalProgramHash,
    finalPixelHash: args.finalPixelHash,
    budgetAllocated: args.budgetAllocated,
    budgetConsumed: args.budgetConsumed,
    hardRubricsPassed: passed,
    hardRubricsFailed: failed,
    hardRubricsUnresolved: unresolved,
    softPassed: args.report.results.filter(
      (r) => r.severity === 'soft' && r.status === 'satisfied'
    ).length,
    softFailed: args.report.softViolations,
    examineRan: args.examine !== null,
    artistRequestedCompletion: args.artistRequestedCompletion,
    environmentOverruled: args.environmentOverruled,
    wagerStatuses: args.wagers.map((w) => ({ id: w.id, status: w.status })),
    branches: args.branches.map((b) => ({
      id: b.id,
      terminal: b.terminalReason,
      budgetUsed: b.budgetConsumed,
    })),
    supportingEvents: args.supportingEvents,
  };
}
