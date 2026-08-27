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
import { canonicalJson, contentHash, loadProfileFor } from '../env/profile.js';
import { affectSentence, initialAffect } from './affect.js';
import { capabilitySheet } from './capability-sheet.js';
import { Canvas, check } from './canvas.js';
import { newSpend, type Spend } from './call.js';
import { ArtistEnv } from './env.js';
import { loadCommission, type Commission } from './field.js';
import { carryNodeIds, declared, realization, totalDrift } from './intention.js';
import { OBSERVATION_HASH, type MakeContext } from './observation.js';
import { seedProgram } from './seed.js';
import { StudioLog } from './studio-log.js';
import { act, replan } from './phases/act.js';
import { choose } from './phases/choose.js';
import { examine } from './phases/examine.js';
import { find, grounded } from './phases/find.js';
import { SKETCH_PROFILE, sheetNotes, sheetOf, sketch, type SketchResult } from './phases/sketch.js';
import type { Policy } from './policy/interface.js';
import type {
  Affect,
  CheckReport,
  Cost,
  Intention,
  Mode,
  Problem,
  Program,
  Scores,
  Sketch,
  Step,
  Trajectory,
} from './types.js';

export interface RunOptions {
  policy: Policy;
  positionId: string;
  briefId: string;
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
}

/** A position with the steering removed. The brief's hard constraints stay: a commission is a fact. */
function stripped(commission: Commission): Commission {
  const bare = {
    ...commission.position,
    id: `${commission.position.id}-control`,
    name: `${commission.position.name} (control)`,
    worldview: 'You have no fixed position. Make the best poster you can for this commission.',
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
    effective: { ...bare, commitments: [...commission.brief.hard_constraints] },
  };
}

function makeContext(
  commission: Commission,
  sheet: string,
  env: ArtistEnv,
  steps: Step[],
  stepsLeft: number
): MakeContext {
  return {
    capabilitySheet: sheet,
    position: commission.position,
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
  };
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
  selfScore: number | null
): Scores {
  const real = realization(intention, program);
  const risk = steps.find((s) => s.accepted && s.isRiskMove);
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
    },
    drift: totalDrift(intentions),
    // Steps that changed the plan rather than the picture: the run's own cost of finding the problem
    // after it thought it had one. `problemsGrounded` is the FIND-phase half of the same question.
    problemFindingSteps: steps.filter((s) => s.replan !== null).length,
    problemsGrounded: grounded(problems, fieldText),
    destructionRate: destructionRate(steps),
    riskMoveTaken: risk !== undefined,
    riskConvention: risk?.action.risk ?? intention.riskMove?.convention ?? null,
    selfScore,
    affectTrace: steps.map((s) => s.affect),
    judgePending: report.pendingRubrics.map((r) => `[${r.id}] ${r.text}`),
  };
}

export async function runTrajectory(o: RunOptions): Promise<Trajectory> {
  const started = Date.now();
  const mode: Mode = o.mode ?? 'both';
  const maxSteps = o.maxSteps ?? 12;
  const hardStop = o.hardStop ?? 20;

  const loaded = loadCommission(o.positionId, o.briefId);
  const commission = o.control ? stripped(loaded) : loaded;
  const fieldText = canonicalJson(loaded.field);

  mkdirSync(path.join(o.outDir, 'sketches'), { recursive: true });
  const log = new StudioLog(o.outDir);
  const spend: Spend = newSpend();

  const seed = seedProgram(o.seed);
  const { profile, hash: profileHash } = loadProfileFor(seed);
  const pack = loadPackFor(seed);
  const sheet = capabilitySheet(profile, pack);

  const id = contentHash([o.positionId, o.briefId, o.seed, o.control ?? false].join('|')).slice(0, 16);
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
    observationHash: OBSERVATION_HASH,
    profileHash,
    packHash: pack.hash,
    positionHash: loaded.positionHash,
    fieldHash: loaded.fieldHash,
  });

  const canvas = new Canvas();
  const sketchCanvas = new Canvas(SKETCH_PROFILE);
  const affect0: Affect = initialAffect(loaded.field, loaded.temperament.value);

  try {
    // 1. FIND -------------------------------------------------------------------------------------
    const problems = await find(o.policy, log, spend, commission);
    log.append('note', { phase: 'find', found: problems.length, grounded: grounded(problems, fieldText) });

    // 2. SKETCH -----------------------------------------------------------------------------------
    // Under sketch-v1: every budget at or below default-v1 and no print pass, so a sketch costs a
    // fraction of a plate. Sketches are rendered serially like everything else (NOTES R8).
    const perProblem = o.sketchesPerProblem ?? 3;
    log.append('phase', { phase: 'sketch', profile: SKETCH_PROFILE, problems: problems.length, per: perProblem });
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
    log.append('phase', { phase: 'make', problemId: chosen.problemId, affect: affect0, said: affectSentence(affect0) });

    const steps: Step[] = [];
    let outcome: 'finished' | 'abandoned' = 'finished';
    let abandonReason: string | undefined;

    for (let k = 1; k <= hardStop; k++) {
      const stepsLeft = Math.max(0, maxSteps - (k - 1));
      const call = await act(o.policy, log, spend, makeContext(commission, sheet, env, steps, stepsLeft));
      const result = await env.step(call.action);
      result.step.observationHash = call.observationHash;
      steps.push(result.step);

      if (call.action.control === 'abandon') {
        outcome = 'abandoned';
        abandonReason = call.action.think;
        break;
      }
      if (call.action.control === 'finished') break;

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
          makeContext(commission, sheet, env, steps, stepsLeft),
          fired.trigger,
          fired.detail
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
      fieldHash: loaded.fieldHash,
      mode,
      seed: o.seed,
      seedProgram: seed,
      problems,
      sketches,
      chosen: { problemId: chosen.problemId, why: chosen.why },
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
        seen.selfScore
      ),
      cost,
      envVersion: {
        observationHash: OBSERVATION_HASH,
        profileHash,
        packHash: pack.hash,
        positionHash: loaded.positionHash,
        fieldHash: loaded.fieldHash,
      },
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
    return trajectory;
  } finally {
    await canvas.close();
    await sketchCanvas.close();
  }
}
