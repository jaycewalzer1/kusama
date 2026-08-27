// Rescoring, offline, from the log alone.
//
// The claim this file has to make good on: every number in scores.json can be rebuilt from
// studio.jsonl plus the medium, the checker and the cached environment answers, with no model in the
// loop. If that holds, the reward function is a function of the record rather than of the run, and it
// can be changed after the fact and applied to trajectories collected under the old one. If it does
// not hold, then some part of the score depends on something nobody wrote down, and the collected
// data is worth less than it looks.
//
// So this walks the log in file order and rebuilds the state machine: the intention as CHOOSE left
// it, each act's edits filtered to the ones the step line says landed, the program committed only on
// accepted steps, the intention swapped on each replan. It does not re-decide anything. Where the run
// made a choice, the log is authoritative; where the run computed a number, this recomputes it.
//
// The one thing it does call out to is a render, and only for render-scope metrics — which come out
// of the measurer's own on-disk cache keyed by program hash, so a rescore of a trajectory that has
// already been run touches no browser. A rescore after `rm -rf .cache` renders once.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyEdit, type EditAction } from '../env/edits.js';
import { loadPackFor } from '../env/pack.js';
import { canonicalJson, loadProfileFor } from '../env/profile.js';
import { Canvas, check } from './canvas.js';
import { loadCommission } from './field.js';
import { carryNodeIds, declared, realization, totalDrift } from './intention.js';
import { grounded } from './phases/find.js';
import { bareEdit } from './schemas.js';
import { readLog, verifyChain, type LogLine } from './studio-log.js';
import type { Affect, Intention, Problem, Program, Scores, Trajectory } from './types.js';

interface ActLine {
  name: string;
  action?: { think?: string; risk?: string | null; edits?: (EditAction & { servesElementId?: string })[]; intention?: Intention; problems?: Problem[]; selfScore?: number };
}

interface StepLine {
  k: number;
  applied: string[];
  edits: { actionId: string; kind: string }[];
  accepted: boolean;
  isRiskMove: boolean;
  risk: string | null;
  destroyedNodeIds: string[];
  affect: Affect;
  replanned?: boolean;
}

interface StartLine {
  positionId: string;
  briefId: string;
  seed: number;
  control: boolean;
}

/** Deep copy through JSON: intentions are plain data by construction (see types.ts). */
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The same rule env.ts uses: an accepted `add_node` that named the element it serves gives that
 * element its node id. Duplicated here rather than shared because the two must be able to disagree —
 * if this drifts from the runtime rule, gate 2 fails, which is exactly the alarm that should ring.
 */
function attach(intention: Intention, edits: (EditAction & { servesElementId?: string })[]): void {
  for (const edit of edits) {
    const serves = edit.servesElementId;
    if (!serves) continue;
    const element = intention.elements.find((e) => e.id === serves);
    const id = (edit.node as { id?: string } | undefined)?.id;
    if (element && id && !element.nodeIds.includes(id)) element.nodeIds.push(id);
  }
}

export interface Recomputed {
  scores: Scores;
  finalProgram: Program;
  chainProblems: { seq: number; problem: string }[];
}

export async function recompute(dir: string, canvas?: Canvas): Promise<Recomputed> {
  const lines: LogLine[] = readLog(path.join(dir, 'studio.jsonl'));
  const chainProblems = verifyChain(lines);
  const start = lines.find((l) => l.kind === 'trajectory-start')!.data as StartLine;
  const commission = loadCommission(start.positionId, start.briefId);
  const fieldText = canonicalJson(commission.field);

  // The seed is data, not a decision, so it is rebuilt rather than read back from final.json.
  const { seedProgram } = await import('./seed.js');
  let program: Program = seedProgram(start.seed);
  const { profile } = loadProfileFor(program);
  const pack = loadPackFor(program);

  let problems: Problem[] = [];
  let intention: Intention | null = null;
  const intentions: Intention[] = [];
  let selfScore: number | null = null;
  let pending: (EditAction & { servesElementId?: string })[] = [];
  const steps: StepLine[] = [];
  let replans = 0;

  for (const line of lines) {
    if (line.kind === 'policy-call') {
      const call = line.data as ActLine & { ok?: boolean };
      if (call.ok === false) continue;
      if (call.name === 'find') problems = call.action?.problems ?? [];
      if (call.name === 'choose' && call.action?.intention) {
        intention = declared(copy(call.action.intention));
        intentions.push(copy(intention));
      }
      if (call.name === 'act') pending = call.action?.edits ?? [];
      if (call.name === 'replan' && call.action?.intention) {
        // Same rule run.ts uses: an element that keeps its id keeps the nodes it is made of.
        intention = intention ? carryNodeIds(intention, copy(call.action.intention)) : declared(copy(call.action.intention));
        intentions.push(copy(intention));
        replans++;
      }
      if (call.name === 'examine') selfScore = call.action?.selfScore ?? null;
      continue;
    }

    if (line.kind !== 'step') continue;
    const step = line.data as StepLine;
    steps.push(step);

    const landed = step.applied.map((id) => pending.find((e) => e.actionId === id)).filter(Boolean) as (EditAction & { servesElementId?: string })[];
    let candidate = program;
    for (const edit of landed) {
      const r = applyEdit(candidate, bareEdit(edit), profile, pack);
      if (!r.valid) throw new Error(`recompute: step ${step.k} edit ${edit.actionId} was accepted at run time but is refused now: ${r.reason}`);
      candidate = r.nextProgram;
    }
    if (step.accepted) {
      program = candidate;
      if (intention) attach(intention, landed);
    }
    pending = [];
  }

  if (!intention) throw new Error('recompute: the log has no CHOOSE call, so there is no plan to score against');

  const own = canvas ?? new Canvas();
  try {
    const rendered = await own.render(program, { metrics: true });
    const report = check(program, commission.effective, rendered.metrics);
    const real = realization(intention, program);
    const risk = steps.find((s) => s.accepted && s.isRiskMove);
    // Counted exactly as run.ts counts it: add_node edits that were applied on an accepted step.
    const added = steps
      .filter((s) => s.accepted)
      .reduce(
        (n, s) => n + s.edits.filter((e) => e.kind === 'add_node' && s.applied.includes(e.actionId)).length,
        0
      );
    const gone = steps.reduce((n, s) => n + s.destroyedNodeIds.length, 0);

    const scores: Scores = {
      tree: report.treeScore,
      render: report.renderScore,
      hardViolations: report.hardViolations,
      softViolations: report.softViolations,
      realization: {
        score: real.score,
        mechanical: real.mechanical,
        satisfied: real.satisfied,
        judgePending: real.judgePending,
      },
      drift: totalDrift(intentions),
      problemFindingSteps: replans,
      problemsGrounded: grounded(problems, fieldText),
      destructionRate: added === 0 ? 0 : Math.round((gone / added) * 1000) / 1000,
      riskMoveTaken: risk !== undefined,
      riskConvention: risk?.risk ?? intention.riskMove?.convention ?? null,
      selfScore,
      affectTrace: steps.map((s) => s.affect),
      judgePending: report.pendingRubrics.map((r) => `[${r.id}] ${r.text}`),
    };
    return { scores, finalProgram: program, chainProblems };
  } finally {
    if (!canvas) await own.close();
  }
}

export interface RecomputeCheck {
  dir: string;
  ok: boolean;
  differences: string[];
}

/** Recompute and compare against the scores.json the run wrote. Gate 2 is this, ten times. */
export async function recomputeMatches(dir: string, canvas?: Canvas): Promise<RecomputeCheck> {
  const written = JSON.parse(readFileSync(path.join(dir, 'scores.json'), 'utf8')) as Scores;
  const { scores, chainProblems } = await recompute(dir, canvas);
  const differences = chainProblems.map((p) => `log line ${p.seq}: ${p.problem}`);
  for (const key of Object.keys(written) as (keyof Scores)[]) {
    if (JSON.stringify(written[key]) !== JSON.stringify(scores[key])) {
      differences.push(`${key}: recorded ${JSON.stringify(written[key])}, recomputed ${JSON.stringify(scores[key])}`);
    }
  }
  return { dir, ok: differences.length === 0, differences };
}

/** Every score in one directory of trajectories, flattened for a spreadsheet. */
export function scoresCsv(trajectories: Trajectory[]): string {
  const head = [
    'id', 'position', 'brief', 'control', 'outcome', 'tree', 'render', 'hard', 'soft',
    'realization', 'judgePending', 'drift', 'replans', 'grounded', 'destruction',
    'risk', 'selfScore', 'steps', 'policyCalls', 'renders', 'usd', 'wallMs',
  ];
  const rows = trajectories.map((t) => [
    t.id,
    t.positionId,
    t.briefId,
    t.positionId.endsWith('-control') ? '1' : '0',
    t.outcome,
    t.scores.tree ?? '',
    t.scores.render ?? '',
    t.scores.hardViolations,
    t.scores.softViolations,
    t.scores.realization.score ?? '',
    t.scores.realization.judgePending,
    t.scores.drift,
    t.scores.problemFindingSteps,
    t.scores.problemsGrounded,
    t.scores.destructionRate,
    t.scores.riskMoveTaken ? '1' : '0',
    t.scores.selfScore ?? '',
    t.steps.length,
    t.cost.policyCalls,
    t.cost.renders,
    t.cost.usd,
    t.cost.wallMs,
  ]);
  return [head, ...rows].map((r) => r.join(',')).join('\n');
}
