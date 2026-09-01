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
import { affectArmed, affectSentence, initialAffect } from './affect.js';
import { breakRecordOf } from './breaks.js';
import { capabilitySheet } from './capability-sheet.js';
import { Canvas, check } from './canvas.js';
import { newSpend, type Spend } from './call.js';
import { ArtistEnv, refusalTally } from './env.js';
import { artistLayers, loadCommission, type Commission } from './field.js';
import { blockerLines, finishBlockers } from './gate.js';
import { provenanceOf } from './provenance.js';
import type { Fired } from './triggers.js';
import {
  carryNodeIds,
  declarationScores,
  declared,
  examineAgreement,
  fusedRealization,
  gradientOf,
  purposeChurn,
  realization,
  riskDeclared,
  terminationOf,
  visibleRate,
  totalDrift,
} from './intention.js';
import { envVersionNow } from './env-version.js';
import { loadInfluenceDoc } from './influence-doc.js';
import { type MakeContext } from './observation.js';
import { seedProgram } from './seed.js';
import { readLog, StudioLog } from './studio-log.js';
import { processOf } from './transition.js';
import { act, replan } from './phases/act.js';
import { choose } from './phases/choose.js';
import { examine } from './phases/examine.js';
import { find, grounded } from './phases/find.js';
import { assertTextBudget, propose, SKETCH_PROFILE, sheetNotes, sheetOf, sketch, type SketchResult } from './phases/sketch.js';
import type { Policy } from './policy/interface.js';
import type {
  Affect,
  CheckReport,
  Cost,
  EdgeEstimate,
  Examine,
  Intention,
  Mode,
  Outcome,
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
  /**
   * Lineage elements this run composes into the position. Empty by default, and the empty case is
   * byte-identical to the run before this option existed — see `withElements`. Non-empty puts the
   * elements' rules into the checker, their stances into the worldview, their cliches into the list
   * the artist is told not to take, and their identity into `envVersion.elementPackHash`.
   */
  elementIds?: string[];
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
  /**
   * How many times the artist may ask to finish and be refused before the environment stops
   * arguing. Default 2: one refusal is a chance to act on the evidence, and a second refusal that
   * changed nothing is the run telling us it cannot. Setting it to 0 restores the old behaviour,
   * where finishing was an assertion nobody could contradict, and is only there so the ablation can
   * be run.
   */
  maxFinishAttempts?: number;
  /**
   * A resolved influence set — an id under `aesthetic/influences/`, or a path to a
   * `*.resolved.json` — shown to the artist as a shelf of real works it has looked at.
   *
   * Absent is the default and is byte-identical to the run before this option existed: no block is
   * appended to any observation, no image is attached, and `envVersion` carries no `influencesHash`.
   * A test pins that.
   *
   * Present adds the catalogue block and up to eight thumbnails to FIND and to each SKETCH. It does
   * NOT reach DESCRIBE or AUDIENCE, which stay blind to everything but the plate, and it does not
   * reach MAKE unless `influencesInMake` is set.
   */
  influences?: string;
  /**
   * Carry the block into THINK+ACT and REPLAN as well. Off by default — see the note above `act`.
   * The thumbnails are never attached during MAKE either way; only the text.
   */
  influencesInMake?: boolean;
}

/**
 * L1 removed, everything else intact. The brief's hard constraints stay, because a commission is a
 * fact about the job rather than a part of the artist; L4 stays too, since the control arm is meant
 * to isolate *having a practice* and an arm that also lost the protocol would be measuring two
 * things at once.
 *
 * The practice's refusals go with it. A control artist that kept them would refuse on grounds it was
 * never given, which is the one thing the arm exists to show the real artist doing.
 */
function stripped(commission: Commission): Commission {
  const bare = {
    ...commission.positionAsWritten,
    id: `${commission.positionAsWritten.id}-control`,
    name: `${commission.positionAsWritten.name} (control)`,
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
    positionAsWritten: bare,
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
    ...artistLayers(commission),
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
  stopped: Termination['kind'],
  affect0: Affect,
  finishRefusals: number | null
): Scores {
  const real = realization(intention, program);
  const risk = steps.find((s) => s.accepted && s.isRiskMove);
  const last = steps[steps.length - 1];
  // Computed before the literal rather than inline, because `tree` and `render` now read it.
  const termination = terminationOf(real.estimates, stopped, last?.action.unrealizable ?? null);
  return {
    // Null when the run did not earn its stop, and this is the same correction `outcome` got below
    // for the same reason. `treeScore` and `renderScore` are means over the decidable constraints,
    // and the decidable constraints are almost all node counts — so they saturate at 1.0 the moment
    // the counting rules are met. One of the two real runs on disk reports `tree: 1, render: 1`
    // beside `legitimate: false`, a self-score of 4, and six of the artist's own planned relations
    // not holding. A headline of 1.0 over a run that ran out of steps is not a lenient measurement,
    // it is a measurement of a different thing presented as the verdict.
    //
    // Nothing is lost by nulling them: they are derived from `hardViolations` and `softViolations`,
    // which stay, and the undecided rubrics stay in `pendingRubrics`. What goes is only the
    // summary — which is exactly the part that had no right to exist for this run.
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
      // The eye decides only what the tree cannot. It never overturns a mechanical verdict, and it
      // never reaches `termination` below — see `fusedRealization`.
      fused: seen ? fusedRealization(real.estimates, seen.edgeEstimates) : null,
    },
    drift: totalDrift(intentions),
    purposeChurn: purposeChurn(intentions),
    // Steps that changed the plan rather than the picture: the run's own cost of finding the problem
    // after it thought it had one. `problemsGrounded` is the FIND-phase half of the same question.
    problemFindingSteps: steps.filter((s) => s.replan !== null).length,
    problemsGrounded: grounded(problems, fieldText),
    destructionRate: destructionRate(steps),
    // `some(... !== undefined)`, not `filter(s => s.inert)`. On a log written before the field
    // existed every step reads `undefined`, and counting those as false would report a run that was
    // never measured as a run with no inert steps.
    inertSteps: steps.some((s) => s.inert !== undefined) ? steps.filter((s) => s.inert === true).length : null,
    gradient: gradientOf(steps.map((s) => s.improved)),
    finishRefusals,
    declarations: declarationScores(steps.map((s) => s.declaration)),
    canvasVisibleRate: visibleRate(steps.map((s) => s.sawCanvas)),
    changeVisibleRate: visibleRate(steps.map((s) => s.sawChange)),
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
    termination,
    affectTrace: steps.map((s) => s.affect),
    affectArmed: affectArmed(affect0, steps.map((s) => s.affect)),
    pendingRubrics: report.pendingRubrics.map((r) => `[${r.id}] ${r.text}`),
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

  const elementIds = o.elementIds ?? [];
  // Loaded before anything is written, so a typo in `--influences` fails the run at the top rather
  // than after the first paid call. `loadInfluenceDoc` throws on a missing or empty set: an artist
  // told it has looked at nothing is a different experiment from an artist not told anything, and
  // the two must not be reachable by the same command line.
  const influences = o.influences ? loadInfluenceDoc(o.influences) : null;
  const makeInfluences = o.influencesInMake ? influences : null;
  const loaded = loadCommission(o.positionId, o.briefId, elementIds);
  const commission = o.control ? stripped(loaded) : loaded;
  const fieldText = canonicalJson(loaded.field);

  mkdirSync(path.join(o.outDir, 'sketches'), { recursive: true });
  const log = new StudioLog(o.outDir);
  const spend: Spend = newSpend();

  const seed = seedProgram(o.seed);
  const { profile } = loadProfileFor(seed);
  const pack = loadPackFor(seed);
  const sheet = capabilitySheet(profile, pack);

  // The element set is in the id: two runs of the same cell under different lineages are different
  // runs, and a shared id would make them overwrite each other in a resumable grid.
  // The influence set joins it for the same reason the element set did — a run that was shown 48
  // works and one that was shown none are different runs and must not overwrite each other in a
  // resumable grid. Appended only when there is one, and not as an empty string: a trailing `|`
  // would move the id of every run that has never had the layer.
  const id = contentHash(
    [
      o.positionId,
      o.briefId,
      o.seed,
      o.control ?? false,
      loaded.elementPackHash,
      ...(influences ? [influences.hash] : []),
    ].join('|')
  ).slice(0, 16);
  // The same ten hashes on the start line and on the finished trajectory, from one place. They
  // used to be two object literals that happened to agree.
  const envVersion = envVersionNow(o.positionId, o.briefId, o.seed, elementIds, influences?.hash);
  log.append('trajectory-start', {
    id,
    positionId: loaded.positionAsWritten.id,
    briefId: loaded.brief.id,
    elementIds: loaded.elementIds,
    // The composed constraint list and the conflicts inside it, whole, or null when no element was
    // adopted. Logged rather than left to be recomposed later: recomposing reads today's element
    // pack, and an element edited after the run would silently rewrite what that run is said to
    // have broken. This is the only place the composition reaches disk, and breaks.ts reads it from
    // here so that a break record is a view of the log rather than a join against the working tree.
    composition: loaded.composition,
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
    // Which set, and how far into the loop it reached. `influencesHash` inside `envVersion` says
    // only *that* two runs saw the same shelf; neither it nor the id is a thing a reader can look
    // up, and neither says whether MAKE was carrying it.
    ...(influences
      ? {
          influencesId: influences.id,
          influenceWorks: influences.resolved.works.length,
          influencesInMake: o.influencesInMake ?? false,
        }
      : {}),
    ...envVersion,
    // Style words found in L2. Non-empty does not stop the run — it marks it non-comparable, which
    // is a different and more useful thing than a crash on a brief somebody is still drafting.
    contamination: loaded.contamination,
    // Hard constraints of the composed position that cannot all hold. Non-empty stops the run
    // below; it is on the start line so the refusal is legible from the log alone.
    unsatisfiable: loaded.unsatisfiable,
  });
  if (loaded.unsatisfiable.length > 0) {
    // Refused before any policy call. A run against a commission no program can satisfy measures
    // the composition, not the artist, and the artist would spend the whole trajectory discovering
    // mechanically what is decidable here in a millisecond.
    const why = loaded.unsatisfiable.map((c) => `${c.a} x ${c.b}: ${c.why}`);
    log.append('note', {
      phase: 'start',
      warning: 'commission is unsatisfiable; no program can satisfy its hard constraints',
      unsatisfiable: why,
    });
    log.append('trajectory-end', { id, outcome: 'unsatisfiable', unsatisfiable: why });
    throw new Error(`unsatisfiable commission ${o.positionId} x ${o.briefId}:\n  ${why.join('\n  ')}`);
  }
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
    const { questions, problems, proposed } = await find(o.policy, log, spend, commission, o.seed, influences);
    log.append('note', {
      phase: 'find',
      // `proposed` is what the artist named; `found` is what the draw kept. Reporting only the
      // second would make a wide distribution and a narrow one look identical from the log.
      proposed: proposed.length,
      found: problems.length,
      grounded: grounded(problems, fieldText),
      groundedProposed: grounded(proposed, fieldText),
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
      // One short call names the ideas, then the draw hands one to each sketch. Without it the three
      // sketch calls are independent draws from the same prompt and come back as one idea three times.
      const { drawn } = await propose(o.policy, log, spend, commission, problem, o.seed, perProblem);
      for (let i = 0; i < perProblem; i++) {
        results.push(
          await sketch(o.policy, log, spend, commission, problem, i, seed, sketchCanvas, drawn[i] ?? null, influences)
        );
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
    let abandonReason: string | undefined;
    // Defaults to the timer, and is only upgraded by the artist actually saying so. An artist that
    // never chooses a control gets `out-of-steps`, which is what happened.
    let stopped: Termination['kind'] = 'out-of-steps';
    // EXAMINE, once the artist has asked to stop. Held here because the gate needs it before the
    // loop can end, and the trajectory needs the same one afterwards.
    let seen0: Examine | null = null;
    let finishAttempts = 0;
    const maxFinishAttempts = o.maxFinishAttempts ?? 2;

    for (let k = 1; k <= hardStop; k++) {
      const stepsLeft = Math.max(0, maxSteps - (k - 1));
      // `showCanvas && env.plate !== null`, not `showCanvas`. The observation says "The canvas
      // itself is attached. Look at it." off `canvasAttached`, while the payload is assembled from
      // the plate, so passing the raw flag lets the prompt promise an image the call does not
      // carry. Built once and reused for the replan so the step's record of what it saw is the
      // same object the call was made from.
      const context = makeContext(
        commission,
        sheet,
        env,
        steps,
        stepsLeft,
        showCanvas && env.plate !== null,
        textOps(env, profile.limits.maxTextOps)
      );
      const call = await act(o.policy, log, spend, context, env.plate, env.change?.png ?? null, makeInfluences);
      const result = await env.step(call.action, {
        canvas: context.canvasAttached,
        change: context.changeAttached,
      });
      result.step.observationHash = call.observationHash;
      steps.push(result.step);

      if (call.action.control === 'abandon') {
        abandonReason = call.action.think;
        stopped = 'abandoned';
        break;
      }
      // Finishing is a request, not an assertion. EXAMINE runs here rather than after the loop —
      // same call, same image, moved to where its answer can still change something — and the
      // environment either accepts the stop or hands the reasons back as a replan. A run that
      // finishes cleanly on its first ask therefore costs exactly what it used to, minus nothing:
      // this EXAMINE becomes the trajectory's.
      let blocked: Fired | null = null;
      if (call.action.control === 'finished') {
        const attempt = await examine(
          o.policy,
          log,
          spend,
          commission,
          env.intention,
          env.look.checkReport,
          env.look.description,
          env.look.audienceRead ?? null,
          env.plate ?? (await canvas.render(env.program, { metrics: true })).png
        );
        seen0 = attempt;
        if (maxFinishAttempts === 0) {
          // The gate is off: the pre-gate environment, kept runnable so that "the gate changed the
          // work" is a comparison somebody can actually run rather than an assertion.
          stopped = 'declared-finished';
          break;
        }
        const blockers = finishBlockers({
          brief: loaded.brief,
          report: env.look.checkReport,
          examine: attempt,
          // Only asked when the artist wants to stop. Null would mean "not asked", and the gate
          // never blocks on evidence it does not have.
          transcript: await env.readBack(),
          wouldAct: env.look.wouldAct,
          declaredUnrealizable: call.action.unrealizable ?? null,
        });
        finishAttempts++;
        log.append('note', {
          phase: 'finish-gate',
          k,
          attempt: finishAttempts,
          accepted: blockers.length === 0,
          blockers: blockerLines(blockers),
        });
        if (blockers.length === 0) {
          stopped = 'declared-finished';
          break;
        }
        if (finishAttempts >= maxFinishAttempts) {
          // It asked, was told why not, and asked again unchanged. The piece stands as it stands
          // and the record says the stop was not earned.
          stopped = 'finish-blocked';
          break;
        }
        blocked = {
          trigger: 'finish-blocked',
          detail: blockerLines(blockers).join(' '),
          usd: 0,
          cached: true,
        };
      }

      // A replan happens for a named reason or not at all. `artist-declares` is the artist's own
      // control value; everything else was fired by the environment and is already logged. A
      // refused finish outranks both: it is the only one the artist cannot decline to hear.
      const fired = blocked ?? result.fired ?? (call.action.control === 'replan'
        ? { trigger: 'artist-declares' as const, detail: call.action.think, usd: 0, cached: true }
        : null);
      if (fired) {
        const before = env.intention;
        const replanned = await replan(
          o.policy,
          log,
          spend,
          // Rebuilt rather than reusing the act call's context: the step has landed, so the plate,
          // the report and the change image have all moved on, and a replan reasoning from the
          // pre-step sheet would be replanning against a picture that no longer exists.
          makeContext(
            commission,
            sheet,
            env,
            steps,
            stepsLeft,
            showCanvas && env.plate !== null,
            textOps(env, profile.limits.maxTextOps)
          ),
          fired.trigger,
          fired.detail,
          env.plate,
          env.change?.png ?? null,
          makeInfluences
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

    // Reused when the artist asked to stop: that call already looked at this program, and asking
    // again would give the run two self-critiques and no way to say which one is its verdict. Only
    // a run that never asked — abandoned, or out of steps — pays for one here.
    const seen =
      seen0 ??
      (await examine(
        o.policy,
        log,
        spend,
        commission,
        env.intention,
        env.look.checkReport,
        env.look.description,
        env.look.audienceRead ?? null,
        finalRender.png
      ));

    // 6. FINISH -----------------------------------------------------------------------------------
    // Derived from how the loop actually ended, never defaulted. `finished` used to be the initial
    // value that anything short of `abandon` kept, so a run that used its last step and a run whose
    // finish was refused both reported `outcome: "finished"` next to `termination.legitimate:
    // false`. The headline said the work was done and the field under it said it was not.
    const outcome: Outcome =
      stopped === 'abandoned' ? 'abandoned' : stopped === 'declared-finished' ? 'finished' : 'unresolved';
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
      positionId: loaded.positionAsWritten.id,
      positionHash: loaded.positionHash,
      briefId: loaded.brief.id,
      elementIds: loaded.elementIds,
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
        stopped,
        affect0,
        // Asks minus the one that was granted. A run that finished on its first ask refused none.
        Math.max(0, finishAttempts - (stopped === 'declared-finished' ? 1 : 0))
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
    const written = readLog(log.file);
    writeFileSync(path.join(o.outDir, 'transitions.json'), `${JSON.stringify(processOf(written), null, 2)}\n`);
    // Its own file, beside scores.json rather than inside it. A break record read as a component of
    // a score is read as something to make go up, and it is the one artifact here that is not.
    writeFileSync(
      path.join(o.outDir, 'breaks.json'),
      `${JSON.stringify(breakRecordOf(written), null, 2)}\n`
    );
    // Whether this combination of lineages has been made before, off the corpus record and the
    // sibling runs. Written last because it is the only artifact here that looks outside this
    // directory, and so the only one whose answer can change without this run changing.
    writeFileSync(
      path.join(o.outDir, 'provenance.json'),
      `${JSON.stringify(provenanceOf(o.outDir, loaded.elementIds), null, 2)}\n`
    );
    return trajectory;
  } finally {
    await canvas.close();
    await sketchCanvas.close();
  }
}
