// Four-condition experiment harness.
//
// 2×2: {synthetic artist position, neutral position} × {full loop, single-shot baseline}.
// Match renderer access, brief, token/dollar budget, candidate/render budget, max revisions,
// model family, stopping opportunities, seeds, and evaluation protocol.
//
// Outputs: intention-to-treat analysis (all runs including failed/abandoned/invalid/exhausted),
// execution-conditioned secondary analysis, anonymized plates in randomized order.
//
// Must be runnable and tested with deterministic fixtures/mocks.

import type { RunOptions } from './run.js';
import type { TerminalRecord, TerminalStatus } from './terminal.js';

export type ArmCondition = 'position' | 'neutral';
export type ArmMode = 'full_loop' | 'single_shot';

export interface ExperimentArm {
  condition: ArmCondition;
  mode: ArmMode;
  /** Unique label for this arm. */
  label: string;
}

export interface ExperimentCell {
  arm: ExperimentArm;
  seed: number;
  positionId: string;
  briefId: string;
}

export interface ExperimentConfig {
  /** The synthetic artist position ID. */
  positionId: string;
  /** The brief ID shared across all arms. */
  briefId: string;
  /** Seeds to run across all arms. */
  seeds: number[];
  /** Budget matching. */
  maxSteps: number;
  hardStop: number;
  maxFinishAttempts: number;
  /** Model family must be the same across all arms. */
  modelFamily: string;
  /** Output directory root. */
  outDir: string;
}

/**
 * Generate all cells for the 2×2 design.
 */
export function experimentCells(config: ExperimentConfig): ExperimentCell[] {
  const arms: ExperimentArm[] = [
    { condition: 'position', mode: 'full_loop', label: 'position-full' },
    { condition: 'position', mode: 'single_shot', label: 'position-single' },
    { condition: 'neutral', mode: 'full_loop', label: 'neutral-full' },
    { condition: 'neutral', mode: 'single_shot', label: 'neutral-single' },
  ];
  const cells: ExperimentCell[] = [];
  for (const arm of arms) {
    for (const seed of config.seeds) {
      cells.push({
        arm,
        seed,
        positionId: config.positionId,
        briefId: config.briefId,
      });
    }
  }
  return cells;
}

/**
 * Convert an experiment cell into RunOptions.
 *
 * The neutral arm uses the control flag; single-shot uses maxSteps=1.
 */
export function cellToRunOptions(
  cell: ExperimentCell,
  config: ExperimentConfig,
  policy: unknown // Policy type — kept as unknown to avoid circular import
): Partial<RunOptions> {
  return {
    positionId: cell.positionId,
    briefId: cell.briefId,
    seed: cell.seed,
    maxSteps: cell.arm.mode === 'single_shot' ? 1 : config.maxSteps,
    hardStop: cell.arm.mode === 'single_shot' ? 1 : config.hardStop,
    maxFinishAttempts: config.maxFinishAttempts,
    control: cell.arm.condition === 'neutral',
    outDir: `${config.outDir}/${cell.arm.label}/seed-${cell.seed}`,
  };
}

/**
 * One run's result in the experiment.
 */
export interface ExperimentResult {
  cell: ExperimentCell;
  terminal: TerminalRecord;
  /** Anonymized plate path, if a final plate exists. */
  plateFile: string | null;
}

/**
 * Intention-to-treat analysis: all runs including failed/abandoned/invalid/exhausted.
 */
export interface ITTAnalysis {
  totalRuns: number;
  byArm: Record<string, ArmSummary>;
}

export interface ArmSummary {
  total: number;
  completed: number;
  abandoned: number;
  budgetExhausted: number;
  failedHardRubric: number;
  failedExecution: number;
  invalidRun: number;
}

/**
 * Compute the ITT analysis from experiment results.
 */
export function ittAnalysis(results: ExperimentResult[]): ITTAnalysis {
  const byArm: Record<string, ArmSummary> = {};
  for (const r of results) {
    const label = r.cell.arm.label;
    if (!byArm[label]) {
      byArm[label] = {
        total: 0,
        completed: 0,
        abandoned: 0,
        budgetExhausted: 0,
        failedHardRubric: 0,
        failedExecution: 0,
        invalidRun: 0,
      };
    }
    const arm = byArm[label]!;
    arm.total++;
    switch (r.terminal.status) {
      case 'completed': arm.completed++; break;
      case 'abandoned': arm.abandoned++; break;
      case 'budget_exhausted': arm.budgetExhausted++; break;
      case 'failed_hard_rubric': arm.failedHardRubric++; break;
      case 'failed_execution': arm.failedExecution++; break;
      case 'invalid_run': arm.invalidRun++; break;
    }
  }
  return { totalRuns: results.length, byArm };
}

/**
 * Anonymize plates for blind human evaluation.
 *
 * Returns plate paths in randomized order, keyed by a random ID rather than by arm.
 * The mapping is returned separately so it can be revealed after evaluation.
 */
export function anonymizePlates(
  results: ExperimentResult[],
  seed: number
): { anonymized: { id: string; plateFile: string }[]; mapping: Record<string, string> } {
  const withPlates = results.filter((r) => r.plateFile !== null);
  // Deterministic shuffle using the seed.
  const shuffled = [...withPlates];
  let s = seed || 1;
  for (let i = shuffled.length - 1; i > 0; i--) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const j = Math.abs(s) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const anonymized: { id: string; plateFile: string }[] = [];
  const mapping: Record<string, string> = {};
  for (let i = 0; i < shuffled.length; i++) {
    const id = `plate-${String(i + 1).padStart(3, '0')}`;
    anonymized.push({ id, plateFile: shuffled[i]!.plateFile! });
    mapping[id] = shuffled[i]!.cell.arm.label;
  }
  return { anonymized, mapping };
}
