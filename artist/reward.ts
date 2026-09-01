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
import { affectArmed, initialAffect } from './affect.js';
import { Canvas, check } from './canvas.js';
import { refusalCause } from './env.js';
import { loadCommission } from './field.js';
import {
  carryNodeIds,
  declarationScores,
  declared,
  examineAgreement,
  fusedRealization,
  gradientOf,
  pruneDeadNodes,
  purposeChurn,
  realization,
  riskDeclared,
  terminationOf,
  totalDrift,
  visibleRate,
} from './intention.js';
import { moveSummary } from './moves.js';
import { grounded } from './phases/find.js';
import { bareEdit, servedNodeIds } from './schemas.js';
import { readLog, verifyChain, type LogLine } from './studio-log.js';
import type {
  Affect,
  Control,
  EdgeEstimate,
  Intention,
  MoveRecord,
  Problem,
  Program,
  RefusalCause,
  Scores,
  StepDeclaration,
  Termination,
  Trajectory,
} from './types.js';

interface ActLine {
  name: string;
  action?: {
    think?: string;
    risk?: string | null;
    edits?: (EditAction & { servesElementId?: string })[];
    intention?: Intention;
    problems?: Problem[];
    selfScore?: number;
    edgeEstimates?: EdgeEstimate[];
  };
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
  control?: Control;
  /**
   * Optional because logs written before stopping was a decision do not carry it. Absence means the
   * artist named nothing, which is exactly what those runs did, so the default is honest here — but
   * see `refused` below for the case where a default is not.
   */
  unrealizable?: string | null;
  /**
   * The `cause` on each entry is deliberately NOT read. It is recomputed from `reason`, which every
   * log has carried since refusals were first written down, so the split can be applied backwards to
   * trajectories collected before causes existed. Trusting the stamped field would silently score
   * every one of those runs as having refused nothing.
   */
  refused?: { actionId: string; kind?: string; reason: string }[];
  /**
   * Absent on every log written before the declaration was checked against `risk` alone. Absence is
   * read as "this step reached no comparison", not as "this step declared nothing and broke
   * nothing": the second would score old runs a perfect `declaredViolationRate` for a rule that was
   * never applied to them.
   */
  declaration?: StepDeclaration | null;
  /**
   * Absent on every log written before sight was recorded. Absence is read as "no evidence", not as
   * "blind": the runs already in the corpus were sighted and simply did not write it down, and
   * folding their silence into 0 would invent a blind corpus. `visibleRate` returns null for that.
   */
  sawCanvas?: boolean;
  sawChange?: boolean;
  /**
   * Kept but invisible. Logged as `null` when the step was not kept and absent on every log written
   * before the threshold existed, and both must stay distinct from `false` — see `inertSteps`.
   */
  inert?: boolean | null;
  /**
   * Absent on every log written before the gradient was measured. Same reading as `inert`: absence
   * is "not recorded", and `gradientOf` returns null for a run of them rather than reporting that
   * nothing ever improved.
   */
  improved?: boolean | null;
  /**
   * The step's size on the page, and its epistemic moves with the environment's audit of their refs.
   *
   * `moves` is read off the log rather than re-derived for the same reason `declaration` is: the
   * grounding check reads what the run showed — the influence set, the plan and the constraint table
   * as they stood at that step — and rebuilding that offline would mean re-deriving every
   * intermediate look. Absent on every log written before the action space had moves in it; `null`
   * on a step logged after and asked. `moveSummary` reads both as "not recorded".
   */
  moves?: MoveRecord[] | null;
  pixelsMoved?: number;
}

/** A `note` line from the finish gate. `accepted` is the environment's answer, not the artist's. */
interface GateLine {
  phase?: string;
  attempt?: number;
  accepted?: boolean;
  blockers?: string[];
}

interface StartLine {
  positionId: string;
  briefId: string;
  seed: number;
  control: boolean;
  /** Absent in logs written before elements existed, and those runs composed none. */
  elementIds?: string[];
}

/**
 * How the run stopped, from the last step line alone.
 *
 * The driver decides this by watching its own loop break; offline there is no loop, so it is read
 * off the control the artist chose on its final step. The two agree because the driver breaks on
 * exactly those two controls and on nothing else — anything that falls out of the bottom of the loop
 * ran out of steps, which is what `out-of-steps` means and what a log with no terminal control
 * shows.
 */
function stoppedAs(last: StepLine | undefined, gates: GateLine[]): Termination['kind'] {
  if (last?.control === 'abandon') return 'abandoned';
  if (last?.control === 'finished') {
    // A `finished` control is now a request. The gate's last word on it decides whether the run
    // stopped because it was finished or because it had run out of chances to say so. On a log with
    // no gate lines the request could not have been refused, so the old reading is the right one.
    const decided = gates[gates.length - 1];
    return decided && decided.accepted === false ? 'finish-blocked' : 'declared-finished';
  }
  return 'out-of-steps';
}

/** Deep copy through JSON: intentions are plain data by construction (see types.ts). */
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The same rule env.ts uses: an accepted edit that named the element it serves gives that element
 * the nodes it touched. Duplicated here rather than shared because the two must be able to disagree —
 * if this drifts from the runtime rule, gate 2 fails, which is exactly the alarm that should ring.
 * Only `servedNodeIds` is shared, because which ids an edit kind touches is a fact about the edit
 * vocabulary rather than a scoring decision either side is entitled to make differently.
 */
function attach(intention: Intention, edits: (EditAction & { servesElementId?: string })[]): void {
  for (const edit of edits) {
    const serves = edit.servesElementId;
    if (!serves) continue;
    const element = intention.elements.find((e) => e.id === serves);
    if (!element) continue;
    for (const id of servedNodeIds(edit)) if (!element.nodeIds.includes(id)) element.nodeIds.push(id);
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
  // The elements the run adopted, not today's pack: a rescore has to grade the piece against the
  // rubric it was made under, and re-deriving the set here would let a change to the pack silently
  // rewrite the scores of runs collected before it.
  const commission = loadCommission(start.positionId, start.briefId, start.elementIds ?? []);
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
  let edgeEstimates: EdgeEstimate[] | null = null;
  let pending: (EditAction & { servesElementId?: string })[] = [];
  const steps: StepLine[] = [];
  const gates: GateLine[] = [];
  let replans = 0;

  for (const line of lines) {
    if (line.kind === 'note') {
      const note = line.data as GateLine;
      if (note.phase === 'finish-gate') gates.push(note);
      continue;
    }
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
      if (call.name === 'examine') {
        selfScore = call.action?.selfScore ?? null;
        edgeEstimates = call.action?.edgeEstimates ?? null;
      }
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
      if (intention) {
        attach(intention, landed);
        pruneDeadNodes(intention, program);
      }
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
    const last = steps[steps.length - 1];
    // Counted exactly as run.ts counts it: add_node edits that were applied on an accepted step.
    const added = steps
      .filter((s) => s.accepted)
      .reduce(
        (n, s) => n + s.edits.filter((e) => e.kind === 'add_node' && s.applied.includes(e.actionId)).length,
        0
      );
    const gone = steps.reduce((n, s) => n + s.destroyedNodeIds.length, 0);

    const refusals: Record<RefusalCause, number> = { budget: 0, capability: 0, structural: 0 };
    for (const s of steps) for (const r of s.refused ?? []) refusals[refusalCause(r.reason)]++;

    // Before the literal, because `tree` and `render` read it. This mirrors `scoresOf` in run.ts and
    // has to keep mirroring it: gate 2 compares the two constructions field by field, and it caught
    // this the moment run.ts was changed on its own.
    const termination = terminationOf(real.estimates, stoppedAs(last, gates), last?.unrealizable ?? null);

    const scores: Scores = {
      // Null when the run did not earn its stop — the reasoning is in `scoresOf` (run.ts). Gated on
      // the *recomputed* termination, not the recorded one: gate 2's premise is that the log alone
      // rebuilds the scores, and reading the flag out of `scores.json` would make the check compare
      // that file against itself.
      tree: termination.legitimate ? report.treeScore : null,
      render: termination.legitimate ? report.renderScore : null,
      hardViolations: report.hardViolations,
      softViolations: report.softViolations,
      realization: {
        score: real.score,
        mechanical: real.mechanical,
        satisfied: real.satisfied,
        judgePending: real.judgePending,
        elementsMade: real.elementsMade,
        fused: edgeEstimates ? fusedRealization(real.estimates, edgeEstimates) : null,
      },
      drift: totalDrift(intentions),
      purposeChurn: purposeChurn(intentions),
      problemFindingSteps: replans,
      problemsGrounded: grounded(problems, fieldText),
      destructionRate: added === 0 ? 0 : Math.round((gone / added) * 1000) / 1000,
      // Read off the logged flag rather than recomputed from `pixelsMoved`, unlike `refusalCause`
      // above. The threshold is a run-time constant: recomputing here would re-decide an old run's
      // steps under whatever `INERT_THRESHOLD` says today, and gate 2 would then report a
      // difference caused by editing a number rather than by the two paths disagreeing.
      inertSteps: steps.some((s) => s.inert !== undefined && s.inert !== null)
        ? steps.filter((s) => s.inert === true).length
        : null,
      // Read off the logged flag, never recomputed, for the same reason `inertSteps` is: it compares
      // against the running best standing, which the log does not carry per step.
      gradient: gradientOf(steps.map((s) => s.improved)),
      moves: moveSummary(steps),
      // Null when the gate never ran at all: a log with no gate lines cannot say whether the run
      // would have been refused, and 0 would claim it asked once and was let go.
      finishRefusals: gates.length === 0 ? null : gates.filter((g) => g.accepted === false).length,
      declarations: declarationScores(steps.map((s) => s.declaration ?? null)),
      canvasVisibleRate: visibleRate(steps.map((s) => s.sawCanvas)),
      changeVisibleRate: visibleRate(steps.map((s) => s.sawChange)),
      riskDeclared: riskDeclared(intentions),
      riskMoveTaken: risk !== undefined,
      riskConvention: risk?.risk ?? null,
      selfScore,
      examineEdges: edgeEstimates
        ? {
            satisfied: edgeEstimates.filter((e) => e.status === 'satisfied').length,
            violated: edgeEstimates.filter((e) => e.status === 'violated').length,
            judgePending: edgeEstimates.filter((e) => e.status === 'judge-pending').length,
          }
        : null,
      examineAgreement: edgeEstimates ? examineAgreement(real.estimates, edgeEstimates) : null,
      refusals,
      termination,
      affectTrace: steps.map((s) => s.affect),
      affectArmed: affectArmed(
        initialAffect(commission.field, commission.temperament.value),
        steps.map((s) => s.affect)
      ),
      pendingRubrics: report.pendingRubrics.map((r) => `[${r.id}] ${r.text}`),
    };
    return { scores, finalProgram: program, chainProblems };
  } finally {
    if (!canvas) await own.close();
  }
}

export interface RecomputeCheck {
  dir: string;
  /** The run was rescored and every score it had recorded came back the same. */
  ok: boolean;
  differences: string[];
  /**
   * Scores the written file does not have. Reported apart from `differences` and never counted as
   * one: a score that did not exist when the run was recorded has nothing to disagree with.
   */
  added: string[];
  /** Why this run cannot be rescored at all, or null. */
  unscorable: string | null;
  /** The recomputed scores, for a caller that wants to write them down. Null when unscorable. */
  scores: Scores | null;
}

/**
 * Recompute and compare against the scores.json the run wrote. Gate 2 is this, ten times.
 *
 * Two things this does not do, both of which it used to.
 *
 * It no longer iterates the written file's keys alone. Scores get added, and every score added
 * since a run was recorded was silently outside the comparison — an old run reported `exact` while
 * whole families of numbers went unchecked, which is the failure mode a verification pass exists to
 * not have. The union is walked instead, and a key the written file lacks is reported as `added`
 * rather than as a difference, because a score that did not exist has nothing to disagree with.
 *
 * It no longer throws when the run cannot be scored. A commission that has since left the catalog
 * makes a run unrescorable, which is a fact about the run and belongs in its row; raising it killed
 * the whole batch at the first dead position and reported nothing about the runs after it.
 */
export async function recomputeMatches(dir: string, canvas?: Canvas): Promise<RecomputeCheck> {
  const written = JSON.parse(readFileSync(path.join(dir, 'scores.json'), 'utf8')) as Scores;
  let result: Awaited<ReturnType<typeof recompute>>;
  try {
    result = await recompute(dir, canvas);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { dir, ok: false, differences: [], added: [], unscorable: why, scores: null };
  }
  const { scores, chainProblems } = result;
  const differences = chainProblems.map((p) => `log line ${p.seq}: ${p.problem}`);
  const added: string[] = [];
  for (const key of new Set([...Object.keys(written), ...Object.keys(scores)]) as Set<keyof Scores>) {
    if (!(key in written)) {
      added.push(`${key}: not recorded, recomputed ${JSON.stringify(scores[key])}`);
    } else if (JSON.stringify(written[key]) !== JSON.stringify(scores[key])) {
      differences.push(`${key}: recorded ${JSON.stringify(written[key])}, recomputed ${JSON.stringify(scores[key])}`);
    }
  }
  return { dir, ok: differences.length === 0, differences, added, unscorable: null, scores };
}

/** Every score in one directory of trajectories, flattened for a spreadsheet. */
export function scoresCsv(trajectories: Trajectory[]): string {
  const head = [
    'id', 'position', 'brief', 'control', 'outcome', 'tree', 'render', 'hard', 'soft',
    'realization', 'elementsMade', 'judgePending', 'drift', 'purposeChanged', 'replans',
    'grounded', 'destruction', 'riskDeclared', 'riskTaken', 'selfScore', 'steps', 'policyCalls',
    'renders', 'usd', 'wallMs',
  ];
  const rows = trajectories.map((t) => [
    t.id,
    t.positionId,
    t.briefId,
    t.control ? '1' : '0',
    t.outcome,
    t.scores.tree ?? '',
    t.scores.render ?? '',
    t.scores.hardViolations,
    t.scores.softViolations,
    t.scores.realization.score ?? '',
    t.scores.realization.elementsMade,
    t.scores.realization.judgePending,
    t.scores.drift,
    t.scores.purposeChurn.changed,
    t.scores.problemFindingSteps,
    t.scores.problemsGrounded,
    t.scores.destructionRate,
    t.scores.riskDeclared ? '1' : '0',
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
