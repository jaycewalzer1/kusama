// The driver.
//
// Seven phases in a fixed order, and nothing here holds state the environment does not. `ArtistEnv`
// owns the program, the look, the affect and the triggers; this file owns only the order of events
// and the policy calls. That split is the point: a training loop that replaced every `callPolicy`
// below with a sampled action would face exactly the same environment, because the environment is
// not in here.
//
// The order is FIND, SKETCH, CHOOSE, MAKE, EXAMINE, FINISH. It is not negotiable and not skippable:
// an artist that goes straight to MAKE is solving the brief, which is the failure this whole design
// exists to avoid. The cost of the first three phases is real — around a third of a trajectory — and
// it buys the one thing the brief cannot supply, which is a problem the artist found rather than was
// given.
//
// Everything that can fail is allowed to. A sketch that will not render, a problem that quotes
// nothing, an artist that abandons at step one: all of these are recorded outcomes, not errors. The
// only thing that aborts a trajectory is a policy call that will not produce a schema-valid answer,
// because a trajectory missing a decision is not a trajectory.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadPackFor } from '../env/pack.js';
import { canonicalJson, contentHash, loadProfile, loadProfileFor } from '../env/profile.js';
import { affectSentence, initialAffect } from './affect.js';
import { capabilitySheet } from './capability-sheet.js';
import { Canvas, check } from './canvas.js';
import { newSpend, type Spend } from './call.js';
import { ArtistEnv, refusalTally } from './env.js';
import { loadCommission, type Commission } from './field.js';
import {
  carryNodeIds,
  declarationScores,
  declared,
  examineAgreement,
  purposeChurn,
  realization,
  riskDeclared,
  terminationOf,
  totalDrift,
} from './intention.js';
import { envVersionNow } from './env-version.js';
import { type MakeContext } from './observation.js';
import { seedProgram } from './seed.js';
import { readLog, StudioLog } from './studio-log.js';
import { processOf } from './transition.js';
import { act, replan } from './phases/act.js';
import { choose } from './phases/choose.js';
import { examine } from './phases/examine.js';
import { find, grounded } from './phases/find.js';
import { assertTextBudget, SKETCH_PROFILE, sheetNotes, sheetOf, sketch, type SketchResult } from './phases/sketch.js';
import type { Policy } from './policy/interface.js';
import type {
  Affect,
  CheckReport,
  Cost,
  EdgeEstimate,
  Examine,
  Intention,
  Mode,
  Problem,
  Program,
  Scores,
  Sketch,
  Step,
  Termination,
  Trajectory,
} from './types.js';

export interface RunOptions {
  policy: Policy;
  positionId: string;
  briefId: string;
  /** L3, chosen here rather than read off the brief: the kind of object is its own axis. */
  deliverableId: string;
  seed: number;
  /** Where studio.jsonl, final.png, sketches/ and the rest are written. Created if absent. */
  outDir: string;
  mode?: Mode;
  /** Steps the artist is told it has. It may finish earlier; it may not exceed `hardStop`. */
  maxSteps?: number;
  hardStop?: number;
  sketchesPerProblem?: number;
  /** Off saves one env call per look, at the cost of the audience-disagrees trigger. */
  useAudience?: boolean;
  /**
   * The control arm. The artist is given a position stripped of everything that steers — no
   * worldview, no tensions, no commitments, no prohibitions, no cliches — but the finished piece is
   * still scored against the real one. That is what makes the comparison mean anything: both arms
   * are graded by the same checker, and only one of them was told what it was being graded on.
   */
  control?: boolean;
  /**
   * Whether the artist sees during MAKE. **On by default.** THINK+ACT and REPLAN are given the
   * current plate and, after the first kept step, a second frame marking what that step moved.
   *
   * It costs no extra render — the canvas already produced these bytes for the describer — so the
   * only difference between the arms is input tokens and whether the artist is looking. Off is the
   * ablation: run one cell each way on the same position, brief and seed and compare the
   * replan-reason distribution. If `description-disagrees` collapses when the canvas is attached,
   * the blind making phase was mostly a negotiation with a narrator, which is a measurement rather
   * than an opinion.
   */
  showCanvas?: boolean;
}

/**
 * L1 removed, everything else intact. The brief's hard constraints stay, because a commission is a
 * fact about the job rather than a part of the artist; L3 and L4 stay too, since the control arm is
 * meant to isolate *having a practice* and an arm that also lost the protocol and the object would
 * be measuring three things at once.
 *
 * The practice's refusals go with it. A control artist that kept them would refuse on grounds it was
 * never given, which is the one thing the arm exists to show the real artist doing.
 */
function stripped(commission: Commission): Commission {
  const bare = {
    ...commission.position,
    id: `${commission.position.id}-control`,
    name: `${commission.position.name} (control)`,
    worldview: 'You have no fixed position. Make the best object you can for this commission.',
    lineage: [],
    tensions: [],
    commitments: [],
    prohibitions: [],
    generative_rules: [],
    cliches: [],
  };
  return {
    ...commission,
    position: bare,
    practice: {
      origin: 'You have no particular training and no inherited vocabulary. You have the job in front of you.',
      doing: 'Serving the commission.',
      period: 'Now.',
      register: 'Whatever the job seems to want.',
      refusals: [],
    },
    effective: { ...bare, commitments: [...commission.brief.hard_constraints] },
  };
}

function makeContext(
  commission: Commission,
  sheet: string,
  env: ArtistEnv,
  steps: Step[],
  stepsLeft: number,
  canvasAttached: boolean,
  textOps: { used: number; max: number }
): MakeContext {
  return {
    capabilitySheet: sheet,
    position: commission.position,
    practice: commission.practice,
    deliverable: commission.deliverable,
    brief: commission.brief,
    program: env.program,
    report: env.look.checkReport,
    description: env.look.description,
    audienceRead: env.look.audienceRead ?? null,
    intention: env.intention,
    affect: env.affect,
    steps,
    maxEdits: env.maxEdits,
    stepsLeft,
    canvasAttached,
    changeAttached: canvasAttached && env.change !== null,
    textOps,
  };
}

/**
 * Text ops standing in the tree, against the profile's cap.
 *
 * The capability sheet already states the cap. It does not state what is left, and the difference
 * showed: in one measured run twenty-two edits were refused for `maxTextOps` by a policy that had
 * been told the limit and could not see its own consumption of it. A budget the policy cannot
 * condition on is not a budget, it is a trap that bills in refusals.
 */
function textOps(env: ArtistEnv, max: number): { used: number; max: number } {
  return { used: env.texts().length, max };
}

/**
 * How much of what was made got unmade: destroyed load-bearing nodes over nodes ever added. Never a
 * penalty anywhere — it is reported because an artist that only ever adds is not choosing, and the
 * number is the only way to see that from outside.
 */
function destructionRate(steps: Step[]): number {
  const added = steps
    .filter((s) => s.accepted)
    .reduce(
      (n, s) =>
        n + s.action.edits.filter((e) => e.kind === 'add_node' && s.appliedActionIds.includes(e.actionId)).length,
      0
    );
  const gone = steps.reduce((n, s) => n + s.destroyedNodeIds.length, 0);
  return added === 0 ? 0 : Math.round((gone / added) * 1000) / 1000;
}

function scoresOf(
  report: CheckReport,
  intention: Intention,
  program: Program,
  intentions: Intention[],
  steps: Step[],
  problems: Problem[],
  fieldText: string,
  seen: Examine | null,
  stopped: Termination['kind']
): Scores {
  const real = realization(intention, program);
  const risk = steps.find((s) => s.accepted && s.isRiskMove);
  const last = steps[steps.length - 1];
  return {
    tree: report.treeScore,
    render: report.renderScore,
    hardViolations: report.hardViolations,
    softViolations: report.softViolations,
    realization: {
      score: real.score,
      mechanical: real.mechanical,
      satisfied: real.satisfied,
      judgePending: real.judgePending,
      elementsMade: real.elementsMade,
    },
    drift: totalDrift(intentions),
    purposeChurn: purposeChurn(intentions),
    // Steps that changed the plan rather than the picture: the run's own cost of finding the problem
    // after it thought it had one. `problemsGrounded` is the FIND-phase half of the same question.
    problemFindingSteps: steps.filter((s) => s.replan !== null).length,
    problemsGrounded: grounded(problems, fieldText),
    destructionRate: destructionRate(steps),
    declarations: declarationScores(steps.map((s) => s.declaration)),
    riskDeclared: riskDeclared(intentions),
    riskMoveTaken: risk !== undefined,
    // No fallback to `intention.riskMove`. If no accepted step named a risk, the artist planned one
    // and did not take it, and the honest report of that is null — not the plan's sentence dressed
    // up as an outcome.
    riskConvention: risk?.action.risk ?? null,
    selfScore: seen?.selfScore ?? null,
    examineEdges: seen ? tally(seen.edgeEstimates) : null,
    examineAgreement: seen ? examineAgreement(real.estimates, seen.edgeEstimates) : null,
    refusals: refusalTally(steps),
    // Against `realization`'s estimates, not EXAMINE's: EXAMINE is the artist grading its own
    // picture, and a stopping rule scored off it would let the artist decide it had finished by
    // saying so twice.
    termination: terminationOf(real.estimates, stopped, last?.action.unrealizable ?? null),
    affectTrace: steps.map((s) => s.affect),
    judgePending: report.pendingRubrics.map((r) => `[${r.id}] ${r.text}`),
  };
}

/** EXAMINE's verdicts counted. Kept beside realization's, never folded into them. */
function tally(estimates: EdgeEstimate[]): { satisfied: number; violated: number; judgePending: number } {
  return {
    satisfied: estimates.filter((e) => e.status === 'satisfied').length,
    violated: estimates.filter((e) => e.status === 'violated').length,
    judgePending: estimates.filter((e) => e.status === 'judge-pending').length,
  };
}

export async function runTrajectory(o: RunOptions): Promise<Trajectory> {
  const started = Date.now();
  const mode: Mode = o.mode ?? 'both';
  const maxSteps = o.maxSteps ?? 12;
  const hardStop = o.hardStop ?? 20;

  const loaded = loadCommission(o.positionId, o.briefId, o.deliverableId);
  const commission = o.control ? stripped(loaded) : loaded;
  const fieldText = canonicalJson(loaded.field);

  mkdirSync(path.join(o.outDir, 'sketches'), { recursive: true });
  const log = new StudioLog(o.outDir);
  const spend: Spend = newSpend();

  const seed = seedProgram(o.seed);
  const { profile } = loadProfileFor(seed);
  const pack = loadPackFor(seed);
  const sheet = capabilitySheet(profile, pack);

  const id = contentHash([o.positionId, o.briefId, o.deliverableId, o.seed, o.control ?? false].join('|')).slice(0, 16);
  // The same eight hashes on the start line and on the finished trajectory, from one place. They
  // used to be two object literals that happened to agree.
  const envVersion = envVersionNow(o.positionId, o.briefId, o.deliverableId, o.seed);
  log.append('trajectory-start', {
    id,
    positionId: loaded.position.id,
    briefId: loaded.brief.id,
    control: o.control ?? false,
    mode,
    seed: o.seed,
    maxSteps,
    hardStop,
    // Every option that changes how many calls the driver makes, so a replay can reproduce the
    // call order rather than approximate it.
    sketchesPerProblem: o.sketchesPerProblem ?? 3,
    useAudience: o.useAudience ?? true,
    // The ablation arm. It changes the observation text as well as the images, so a replay that
    // did not carry it would rebuild every MAKE observation wrong and report the arm as a divergence.
    showCanvas: o.showCanvas ?? true,
    deliverableId: loaded.deliverable.id,
    ...envVersion,
    // Style words found in L2. Non-empty does not stop the run — it marks it non-comparable, which
    // is a different and more useful thing than a crash on a brief somebody is still drafting.
    contamination: loaded.contamination,
  });
  if (loaded.contamination.length > 0) {
    log.append('note', {
      phase: 'start',
      warning: 'the brief carries aesthetic direction; this run is not comparable with a clean one',
      contamination: loaded.contamination,
    });
  }

  const canvas = new Canvas();
  const sketchCanvas = new Canvas(SKETCH_PROFILE);
  const affect0: Affect = initialAffect(loaded.field, loaded.temperament.value);

  try {
    // 1. FIND -------------------------------------------------------------------------------------
    const { questions, problems } = await find(o.policy, log, spend, commission);
    log.append('note', {
      phase: 'find',
      found: problems.length,
      grounded: grounded(problems, fieldText),
      questions: questions.length,
    });

    // 2. SKETCH -----------------------------------------------------------------------------------
    // Under sketch-v1: every budget at or below default-v1 and no print pass, so a sketch costs a
    // fraction of a plate. Sketches are rendered serially like everything else (NOTES R8).
    const perProblem = o.sketchesPerProblem ?? 3;
    const { profile: sketchProfile } = loadProfile(SKETCH_PROFILE);
    const textNeeded = assertTextBudget(loaded.effective, sketchProfile.limits);
    log.append('phase', {
      phase: 'sketch',
      profile: SKETCH_PROFILE,
      problems: problems.length,
      per: perProblem,
      // The position's own floor, beside the budget it is being given. A run whose sketches all come
      // back short on text can be read against these two numbers rather than guessed at.
      textDemand: textNeeded,
      maxTextOps: sketchProfile.limits.maxTextOps,
    });
    const results: SketchResult[] = [];
    for (const problem of problems) {
      for (let i = 0; i < perProblem; i++) {
        results.push(await sketch(o.policy, log, spend, commission, problem, i, seed, sketchCanvas));
      }
    }
    await sketchCanvas.close();

    const sketches: Sketch[] = [];
    for (const r of results) {
      if (!r.png) continue;
      const file = path.join('sketches', `${r.problemId}-${r.index + 1}.png`);
      writeFileSync(path.join(o.outDir, file), r.png);
      sketches.push({ problemId: r.problemId, steps: [], finalHash: r.programHash, png: file });
    }
    const contact = sheetOf(results);
    if (contact) writeFileSync(path.join(o.outDir, 'sketches', 'contact.png'), contact);

    // 3. CHOOSE -----------------------------------------------------------------------------------
    const chosen = await choose(o.policy, log, spend, commission, problems, sketches, contact, sheetNotes(results));
    // The collision, on its own line in the log. It is the cheapest read on whether both layers were
    // actually taken in, so it goes where somebody tailing the run can see it without a diff.
    log.append('note', { phase: 'choose', collision: chosen.collision, terms: chosen.terms });
    const intention0 = declared(chosen.intention);
    const intentions: Intention[] = [intention0];

    // 4. MAKE -------------------------------------------------------------------------------------
    const env = new ArtistEnv({
      commission,
      canvas,
      log,
      seedProgram: seed,
      useAudience: o.useAudience ?? true,
      useMetrics: true,
    });
    await env.reset(intention0, affect0);
    // The ablation's only switch, logged so a trajectory says which arm it is without being diffed
    // against another one.
    const showCanvas = o.showCanvas ?? true;
    log.append('phase', {
      phase: 'make',
      problemId: chosen.problemId,
      affect: affect0,
      said: affectSentence(affect0),
      showCanvas,
    });

    const steps: Step[] = [];
    let outcome: 'finished' | 'abandoned' = 'finished';
    let abandonReason: string | undefined;
    // Defaults to the timer, and is only upgraded by the artist actually saying so. An artist that
    // never chooses a control gets `out-of-steps`, which is what happened.
    let stopped: Termination['kind'] = 'out-of-steps';

    for (let k = 1; k <= hardStop; k++) {
      const stepsLeft = Math.max(0, maxSteps - (k - 1));
      const call = await act(
        o.policy,
        log,
        spend,
        makeContext(commission, sheet, env, steps, stepsLeft, showCanvas, textOps(env, profile.limits.maxTextOps)),
        env.plate,
        env.change?.png ?? null
      );
      const result = await env.step(call.action);
      result.step.observationHash = call.observationHash;
      steps.push(result.step);

      if (call.action.control === 'abandon') {
        outcome = 'abandoned';
        abandonReason = call.action.think;
        stopped = 'abandoned';
        break;
      }
      if (call.action.control === 'finished') {
        stopped = 'declared-finished';
        break;
      }

      // A replan happens for a named reason or not at all. `artist-declares` is the artist's own
      // control value; everything else was fired by the environment and is already logged.
      const fired = result.fired ?? (call.action.control === 'replan'
        ? { trigger: 'artist-declares' as const, detail: call.action.think, usd: 0, cached: true }
        : null);
      if (fired) {
        const before = env.intention;
        const replanned = await replan(
          o.policy,
          log,
          spend,
          makeContext(commission, sheet, env, steps, stepsLeft, showCanvas, textOps(env, profile.limits.maxTextOps)),
          fired.trigger,
          fired.detail,
          env.plate,
          env.change?.png ?? null
        );
        const after = carryNodeIds(before, replanned);
        result.step.replan = { trigger: fired.trigger, before, after };
        env.intention = after;
        intentions.push(after);
      }

      if (k >= maxSteps) {
        // Out of the steps it was told it had. Not an abandonment: the piece stands as it stands.
        log.append('note', { phase: 'make', stopped: 'out of steps', k });
        break;
      }
    }

    // 5. EXAMINE ----------------------------------------------------------------------------------
    const finalRender = await canvas.render(env.program, { metrics: true });
    writeFileSync(path.join(o.outDir, 'final.png'), finalRender.png);
    const scoringReport = check(env.program, loaded.effective, finalRender.metrics);

    const seen = await examine(
      o.policy,
      log,
      spend,
      commission,
      env.intention,
      env.look.checkReport,
      env.look.description,
      env.look.audienceRead ?? null,
      finalRender.png
    );

    // 6. FINISH -----------------------------------------------------------------------------------
    const cost: Cost = {
      policyCalls: spend.policyCalls,
      envCalls: env.envCalls,
      cachedEnvCalls: env.cachedEnvCalls,
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      usd: Math.round((spend.usd + env.envUsd) * 1e6) / 1e6,
      wallMs: Date.now() - started,
      renders: canvas.renders + sketchCanvas.renders,
    };

    // 7. SCORES -----------------------------------------------------------------------------------
    // Scored against the real position even in the control arm, which is the whole comparison.
    const trajectory: Trajectory = {
      id,
      positionId: loaded.position.id,
      positionHash: loaded.positionHash,
      briefId: loaded.brief.id,
      deliverableId: loaded.deliverable.id,
      control: o.control ?? false,
      fieldHash: loaded.fieldHash,
      mode,
      seed: o.seed,
      seedProgram: seed,
      contamination: loaded.contamination,
      questions,
      problems,
      sketches,
      collision: chosen.collision,
      terms: chosen.terms,
      chosen: { problemId: chosen.problemId, why: chosen.why, cost: chosen.cost },
      intention0,
      intentions,
      steps,
      finalProgram: env.program,
      finalHash: finalRender.programHash,
      examine: seen,
      outcome,
      ...(abandonReason ? { abandonReason } : {}),
      scores: scoresOf(
        scoringReport,
        env.intention,
        env.program,
        intentions,
        steps,
        problems,
        fieldText,
        seen,
        stopped
      ),
      cost,
      envVersion,
    };

    log.append('trajectory-end', {
      id,
      outcome,
      finalHash: trajectory.finalHash,
      pixelHash: finalRender.pixelHash,
      scores: trajectory.scores,
      cost,
      policySpend: spend,
    });

    writeFileSync(path.join(o.outDir, 'final.json'), `${JSON.stringify(trajectory, null, 2)}\n`);
    writeFileSync(path.join(o.outDir, 'scores.json'), `${JSON.stringify(trajectory.scores, null, 2)}\n`);
    // Folded back out of the log this run just wrote, rather than assembled from the variables in
    // scope. It costs a file read and it buys the guarantee that matters: transitions.json is a
    // view of studio.jsonl and cannot contain anything the log does not, so the same command run
    // over an old trajectory produces the same artifact.
    writeFileSync(
      path.join(o.outDir, 'transitions.json'),
      `${JSON.stringify(processOf(readLog(log.file)), null, 2)}\n`
    );
    return trajectory;
  } finally {
    await canvas.close();
    await sketchCanvas.close();
  }
}
