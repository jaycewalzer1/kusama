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
import { applyEdit, type EditAction } from '../env/edits.js';
import { loadPackFor } from '../env/pack.js';
import { decodePng } from '../env/png.js';
import { canonicalJson, contentHash, loadProfile, loadProfileFor } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';
import { pixelDiff } from '../env/diff.js';
import { loadSamplingIndexHeader } from '../aesthetic/sample-index.js';
import { compileWithSamplingTargets, validateSamplingBindings, withSamplingAncestry, type SamplingBindings, type TargetResolution } from '../aesthetic/sample-targets.js';
import type { SamplingCompilation, SamplingPlan } from '../aesthetic/sample-types.js';
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
import { DiscoveryLog } from './discovery-log.js';
import { coverage, groundedInWorks, type MaterialSheet } from './material-sheet.js';
import { corpusAvailable } from './research-query.js';
import { moveSummary } from './moves.js';
import { type MakeContext } from './observation.js';
import { PRACTICE_STORE, updatePractice, type Tried } from './practice-version.js';
import { seedProgram } from './seed.js';
import { readLog, StudioLog } from './studio-log.js';
import type { SampleRevision } from './sampling-events.js';
import { processOf } from './transition.js';
import { bareEdit } from './schemas.js';
import { act, replan } from './phases/act.js';
import { choose } from './phases/choose.js';
import { compare } from './phases/compare.js';
import { diverge } from './phases/diverge.js';
import { examine } from './phases/examine.js';
import { find, grounded } from './phases/find.js';
import { research } from './phases/research.js';
import { sample as samplePhase } from './phases/sample.js';
import { bindSamples, reviewSampling, reviseSamplingPlan } from './phases/sample-finish.js';
import { assertTextBudget, propose, SKETCH_PROFILE, sheetNotes, sheetOf, sketch, type SketchResult } from './phases/sketch.js';
import { PER_LENS, wideSketch, type PreviewCanvas, type WideSketch } from './phases/wide-sketch.js';
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
  /**
   * Run the discovery half: RESEARCH, then DIVERGE, wide SKETCH and COMPARE in place of the three
   * canonical sketches and the single CHOOSE call.
   *
   * **Off by default, and off is byte-identical to the run before any of it existed.** No
   * `discovery.jsonl` is opened, no material sheet is built, FIND is handed the same observation and
   * the same schema object it was handed before, and no practice version is written. That is not
   * politeness towards old trajectories — it is the only way the two modes contract holds. Discovery
   * is nondeterministic by design and writes to its own unchained file; the moment an unflagged run
   * touched any of it, every golden and every replay would be measuring a different environment.
   *
   * On, the chain still gets CHOOSE, MAKE, EXAMINE and one UPDATE PRACTICE call, because those are
   * the decisions the trajectory is a record of. Everything the discovery phases propose and cut
   * lands in `discovery.jsonl`, which nothing hashes and `replay` never reads.
   *
   * It is expensive: two research calls, two diverge calls, a dozen sketches per surviving lens, up
   * to twelve pairwise judgments. That is the point of it, and the reason it is not the default.
   */
  discovery?: boolean;
  /**
   * Where UPDATE PRACTICE appends. Defaults to the tracked store under `aesthetic/practice/`; a test
   * points it at a temporary directory so a stubbed run does not commit a practice version.
   */
  practiceStore?: string;
  /** Opt-in sampling index directory. Absent preserves the pre-sampling trajectory path. */
  sampling?: string;
  /** Replay-only plans read from sample_selected events. Their presence suppresses index access. */
  recordedSamplingPlans?: SamplingPlan[];
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
    // Beside `inertSteps`, never folded into it. See ./moves.ts: that separation is the whole safety
    // property, because a move must not become a way to buy a step out of the reward-hacking counter.
    moves: moveSummary(steps),
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

/**
 * Only hard rubrics can refuse a finish. Severity lives on `results`; `pendingRubrics` deliberately
 * carries only ids and text, so reading severity from that flattened list would be inventing it.
 */
function hardRubrics(report: CheckReport): { id: string; text: string }[] {
  return report.results
    .filter((r) => r.kind === 'rubric' && r.severity === 'hard' && r.rubric !== undefined)
    .map((r) => ({ id: r.id, text: r.rubric as string }));
}

function withBindings(program: Program, bindings: SamplingBindings): Program {
  return {
    ...program,
    meta: { ...((program as Record<string, any>).meta ?? {}), samplingBindings: bindings },
  };
}

function resolvedForSampling(program: Program) {
  const { profile } = loadProfileFor(program);
  const pack = loadPackFor(program);
  const checked = validateProgram(program, profile, pack);
  if (!checked.valid || !checked.resolved) {
    throw new Error(`sampling base is invalid: ${checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return withSamplingAncestry(checked.resolved, program);
}

interface SamplingPair {
  plan: SamplingPlan;
  compilation: SamplingCompilation;
  resolutions: TargetResolution[];
  sampled: Awaited<ReturnType<Canvas['render']>>;
  ablation: Awaited<ReturnType<Canvas['render']>>;
  sampledFile: string;
  ablationFile: string;
}

interface AcceptedSamplingFinish {
  pair: SamplingPair;
  inspected: Awaited<ReturnType<ArtistEnv['inspect']>>;
  base: Program;
  bindings: SamplingBindings;
}

async function renderSamplingPair(
  canvas: Canvas,
  log: StudioLog,
  outDir: string,
  base: Program,
  plan: SamplingPlan,
  attempt: number,
  suffix = ''
): Promise<SamplingPair> {
  const resolved = resolvedForSampling(base);
  const sampledResult = compileWithSamplingTargets(base, plan, resolved);
  const zero = JSON.parse(JSON.stringify(plan)) as SamplingPlan;
  for (const sample of zero.samples) sample.controls.salience = 0;
  for (const request of zero.requests) request.controls.salience = 0;
  const ablationResult = compileWithSamplingTargets(base, zero, resolved);
  const sampled = await canvas.render(sampledResult.compilation.program, { metrics: true });
  const ablation = await canvas.render(ablationResult.compilation.program, { metrics: true });
  const directory = path.join(outDir, 'sampling');
  mkdirSync(directory, { recursive: true });
  const tag = `${attempt}${suffix}`;
  const sampledFile = path.join('sampling', `sampled-${tag}.png`);
  const ablationFile = path.join('sampling', `ablation-${tag}.png`);
  writeFileSync(path.join(outDir, sampledFile), sampled.png);
  writeFileSync(path.join(outDir, ablationFile), ablation.png);
  const a = decodePng(sampled.png);
  const b = decodePng(ablation.png);
  const diff = pixelDiff(a.rgba, b.rgba, a.width, a.height, []);
  log.append('ablation_rendered', {
    sampledProgramHash: sampled.programHash,
    sampledPixelHash: sampled.pixelHash,
    ablationProgramHash: ablation.programHash,
    ablationPixelHash: ablation.pixelHash,
    differingPixels: diff.differing,
    totalPixels: a.width * a.height,
    sampledFile,
    ablationFile,
    resolutions: sampledResult.resolutions,
    effects: sampledResult.compilation.constraints.map((constraint) => ({
      sampleId: constraint.sampleId,
      problem: plan.samples.find((sample) => sample.sampleId === constraint.sampleId)?.perceptualGoal ?? '',
      channel: constraint.channels[0] ?? '',
      claimedEffect: constraint.claimedEffect,
      touchedNodeIds: constraint.affectedNodeIds,
    })),
  });
  return {
    plan,
    compilation: sampledResult.compilation,
    resolutions: sampledResult.resolutions,
    sampled,
    ablation,
    sampledFile,
    ablationFile,
  };
}

function revisedBase(
  base: Program,
  revision: SampleRevision,
  bindings: SamplingBindings,
  plan: SamplingPlan
): { program: Program; faults: string[] } {
  if (revision.kind !== 'base') return { program: base, faults: [] };
  const { profile } = loadProfileFor(base);
  const pack = loadPackFor(base);
  let candidate = base;
  const faults: string[] = [];
  for (const raw of revision.edits) {
    const edit = raw as EditAction & { servesElementId?: string };
    const result = applyEdit(candidate, bareEdit(edit), profile, pack);
    if (!result.valid) faults.push(`${edit.actionId ?? '(unnamed edit)'}: ${result.reason ?? 'refused'}`);
    else candidate = result.nextProgram;
  }
  if (faults.length > 0) return { program: base, faults };
  const checked = validateSamplingBindings(candidate, new Set(plan.requests.map((request) => request.role)), bindings);
  if (!checked.valid) return { program: base, faults: checked.faults };
  return { program: candidate, faults: [] };
}

/** EXAMINE's verdicts counted. Kept beside realization's, never folded into them. */
function tally(estimates: EdgeEstimate[]): { satisfied: number; violated: number; judgePending: number } {
  return {
    satisfied: estimates.filter((e) => e.status === 'satisfied').length,
    violated: estimates.filter((e) => e.status === 'violated').length,
    judgePending: estimates.filter((e) => e.status === 'judge-pending').length,
  };
}

/**
 * What the discovery half hands back to the canonical loop.
 *
 * Four of these six fields go straight into CHOOSE, which is deliberate: the widening, the drawing
 * and the judging all happen out in `discovery.jsonl`, and the only thing that crosses into the
 * chain is a shortlist with the artist's reasons for it. CHOOSE is still made to choose — it is not
 * handed a decision — but it is handed a field COMPARE has already argued down.
 */
interface Discovered {
  /** The problems COMPARE committed to. CHOOSE picks among these and no others. */
  problems: Problem[];
  sketches: Sketch[];
  contact: Buffer | null;
  notes: string[];
  fertile: Tried[];
  rejected: Tried[];
}

/**
 * One lens's sketch, renamed into the shape COMPARE reads.
 *
 * COMPARE is keyed on problems and wide sketching is keyed on lenses, and the join is the lens's own
 * `problem` field. The index is renumbered per problem rather than carried over from the lens,
 * because `Card.key` is `${problemId}#s${index + 1}` and two lenses on one problem would otherwise
 * both produce `p2#s1` — two different pictures under one name, in a phase whose entire job is
 * telling pictures apart.
 */
function asSketchResults(sketches: WideSketch[], problemOf: Map<string, string>): SketchResult[] {
  const next = new Map<string, number>();
  const out: SketchResult[] = [];
  for (const s of sketches) {
    const problemId = problemOf.get(s.lensId);
    // A sketch whose lens is not in the map cannot be scored against a problem ranking, and
    // inventing a problem for it would put a fabricated id into the commitment. It is dropped, and
    // the count is on the note below.
    if (!problemId) continue;
    const index = next.get(problemId) ?? 0;
    next.set(problemId, index + 1);
    out.push({
      problemId,
      index,
      approach: s.approach,
      program: s.program,
      programHash: s.programHash,
      png: s.png,
      failure: s.failure,
    });
  }
  return out;
}

/**
 * DIVERGE, wide SKETCH and COMPARE, in the order the brief puts them.
 *
 * Everything in here writes to `discovery`. The two lines it appends to the chained `log` are counts
 * — how wide the widening got, what survived the comparison — because a trajectory that cannot say
 * whether it ran this at all is a trajectory nobody can group by.
 */
async function discoverWide(
  policy: Policy,
  discovery: DiscoveryLog,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  problems: Problem[],
  materials: MaterialSheet | null,
  seed: Program,
  canvas: PreviewCanvas,
  outDir: string,
  runSeed: number,
  perLens: number,
  sampling: SamplingPlan | null
): Promise<Discovered> {
  const lenses = await diverge(policy, discovery, spend, commission, problems, materials, runSeed);
  log.append('note', {
    phase: 'diverge',
    proposed: lenses.proposed.length,
    kept: lenses.kept.length,
    cut: lenses.cut.length,
    // Reported, never enforced. A run whose emergent sentences are filler is a run worth being able
    // to find later, and it is not a run to abort.
    degenerate: lenses.degenerate.map((l) => l.id),
  });

  const problemOf = new Map(lenses.kept.map((l) => [l.id, l.problem]));
  const wide = await wideSketch(
    policy,
    discovery,
    spend,
    commission,
    lenses.kept.map((l) => ({ id: l.id, lens: l.lens, emergent: l.emergent })),
    materials,
    seed,
    canvas,
    runSeed,
    { perLens, ...(sampling ? { sampling, samplingLog: log } : {}) }
  );
  for (const s of wide.sheets) {
    if (s.png) writeFileSync(path.join(outDir, 'sketches', `lens-${s.lensId}.png`), s.png);
  }

  const cards = asSketchResults(wide.sketches, problemOf);
  const comparison = await compare(policy, discovery, spend, commission, problems, cards, runSeed);

  // The survivors as pictures, in the order `rank` put them, which is the order they are tiled in —
  // so a note saying "cell 3" names a cell somebody can find. Tiled by SKETCH's own `sheetOf` and
  // not by wide-sketch's: this is a handful of finalists at reading size, not a dozen thumbnails
  // being scanned for variety.
  const byKey = new Map(cards.map((c) => [`${c.problemId}#s${c.index + 1}`, c]));
  const survivors = comparison.survivors
    .map((s) => byKey.get(s.key))
    .filter((c): c is SketchResult => c !== undefined && c.png !== null);
  const contact = sheetOf(survivors);

  const sketches: Sketch[] = [];
  for (const c of survivors) {
    const file = path.join('sketches', `${c.problemId}-${c.index + 1}.png`);
    writeFileSync(path.join(outDir, file), c.png!);
    sketches.push({ problemId: c.problemId, steps: [], finalHash: c.programHash, png: file });
  }

  const drew = new Set(survivors.map((c) => `${c.problemId}#s${c.index + 1}`));
  const notes = [
    `These are the sketches you kept after comparing them in pairs. What you said when you committed: ${comparison.commitment.why}`,
    ...comparison.survivors
      .filter((s) => drew.has(s.key))
      .map(
        (s, i) =>
          `cell ${i + 1} (left to right, top to bottom): ${s.approach}` +
          `\n    problem: ${s.problemId}` +
          `\n    won ${s.wins} of ${s.comparisons} comparisons`
      ),
  ];

  const committed = problems.filter((p) => comparison.commitment.problemIds.includes(p.id));
  log.append('note', {
    phase: 'compare',
    cards: cards.length,
    dropped: wide.sketches.length - cards.length,
    comparisons: comparison.comparisons.length,
    survivors: comparison.survivors.map((s) => s.key),
    // The question the brief actually asks of this phase: did the artist choose a problem it had
    // itself weighted low, and if so did it say why with reference to the sketches.
    ranking: comparison.rankingAnswer,
  });

  return {
    // A commitment naming no problem this run found leaves CHOOSE nothing to choose between, so it
    // falls back to the whole list. That is a worse run, not a broken one.
    problems: committed.length > 0 ? committed : problems,
    sketches,
    contact,
    notes,
    fertile: comparison.survivors.map((s) => ({
      id: s.key,
      what: s.approach,
      why: `won ${s.wins} of ${s.comparisons} pairwise comparisons and was committed to`,
    })),
    rejected: lenses.cut.map((c) => ({ id: c.lens.id, what: c.lens.lens, why: c.reason })),
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
  const samplingIndexId = o.recordedSamplingPlans?.[0]?.indexId ?? (o.sampling ? loadSamplingIndexHeader(o.sampling).indexId : null);
  const samplingEnabled = samplingIndexId !== null;
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
      ...(samplingIndexId ? [samplingIndexId] : []),
    ].join('|')
  ).slice(0, 16);
  // The same ten hashes on the start line and on the finished trajectory, from one place. They
  // used to be two object literals that happened to agree.
  const envVersion = envVersionNow(o.positionId, o.briefId, o.seed, elementIds, influences?.hash, samplingEnabled);
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
    ...(samplingIndexId ? { sampling: true, samplingIndexId } : {}),
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

  // The second record, opened only when the discovery half is going to run. An unflagged run does
  // not create the file, so a directory listing says which mode a trajectory was made in.
  const discovery = o.discovery ? new DiscoveryLog(o.outDir) : null;

  try {
    // 0. RESEARCH ---------------------------------------------------------------------------------
    // Before FIND, because the whole point is that the artist has looked at art before it decides
    // what is difficult here. A corpus that is not on this machine is a missing input, not a
    // failure: the run continues with `materials` null and every phase below takes the byte-
    // identical unresearched path, which is exactly what the default arm does.
    let materials: MaterialSheet | null = null;
    if (discovery) {
      if (!corpusAvailable()) {
        log.append('note', {
          phase: 'research',
          warning: 'no corpus manifest on this machine; this run looked at no art',
        });
      } else {
        const found = await research(o.policy, discovery, spend, commission);
        materials = found.sheet;
        log.append('note', {
          phase: 'research',
          sheet: found.sheet.hash,
          materials: found.sheet.materials.length,
          candidatesSeen: found.candidatesSeen,
          queries: found.queries.length,
          ...found.coverage,
        });
      }
    }

    // 1. FIND -------------------------------------------------------------------------------------
    const { questions, problems, proposed } = await find(
      o.policy,
      log,
      spend,
      commission,
      o.seed,
      influences,
      materials
    );
    const inWorks = groundedInWorks(problems);
    log.append('note', {
      phase: 'find',
      // `proposed` is what the artist named; `found` is what the draw kept. Reporting only the
      // second would make a wide distribution and a narrow one look identical from the log.
      proposed: proposed.length,
      found: problems.length,
      grounded: grounded(problems, fieldText),
      groundedProposed: grounded(proposed, fieldText),
      questions: questions.length,
      // Only on a researched run. On an unresearched one every problem cites nothing by
      // construction and a `0` here would read as a finding rather than as an absent question.
      ...(materials
        ? { groundedInWorks: inWorks.grounded, unresolvedWorkRefs: inWorks.unresolved }
        : {}),
    });

    // SAMPLE is opt-in and sits after the problems exist but before any proposal is drawn.
    let samplingPlan: SamplingPlan | null = null;
    if (samplingEnabled) {
      const sampled = await samplePhase(o.policy, log, spend, commission, problems, o.seed, {
        indexDir: o.sampling,
        recordedPlans: o.recordedSamplingPlans,
      });
      samplingPlan = sampled.plan;
    }

    // 2. SKETCH -----------------------------------------------------------------------------------
    // Under sketch-v1: every budget at or below default-v1 and no print pass, so a sketch costs a
    // fraction of a plate. Sketches are rendered serially like everything else (NOTES R8).
    const perProblem = o.sketchesPerProblem ?? 3;
    const { profile: sketchProfile } = loadProfile(SKETCH_PROFILE);
    const textNeeded = assertTextBudget(loaded.effective, sketchProfile.limits);

    let found: Discovered;
    if (discovery) {
      // DIVERGE, a dozen sketches per surviving lens, and a round of pairwise judgments — all of it
      // in discovery.jsonl. `sketchesPerProblem` is read as the per-lens count when it is set, so a
      // test can ask for one sketch a lens without a second knob meaning nearly the same thing.
      log.append('phase', {
        phase: 'diverge',
        profile: SKETCH_PROFILE,
        problems: problems.length,
        perLens: o.sketchesPerProblem ?? PER_LENS,
        materials: materials?.hash ?? null,
      });
      found = await discoverWide(
        o.policy,
        discovery,
        log,
        spend,
        commission,
        problems,
        materials,
        seed,
        sketchCanvas,
        o.outDir,
        o.seed,
        o.sketchesPerProblem ?? PER_LENS,
        samplingPlan
      );
    } else {
      log.append('phase', {
        phase: 'sketch',
        profile: SKETCH_PROFILE,
        problems: problems.length,
        per: perProblem,
        // The position's own floor, beside the budget it is being given. A run whose sketches all
        // come back short on text can be read against these two numbers rather than guessed at.
        textDemand: textNeeded,
        maxTextOps: sketchProfile.limits.maxTextOps,
      });
      const results: SketchResult[] = [];
      for (const problem of problems) {
        // One short call names the ideas, then the draw hands one to each sketch. Without it the
        // three sketch calls are independent draws from one prompt and come back as one idea thrice.
        const { drawn } = await propose(o.policy, log, spend, commission, problem, o.seed, perProblem, samplingPlan);
        for (let i = 0; i < perProblem; i++) {
          results.push(
            await sketch(o.policy, log, spend, commission, problem, i, seed, sketchCanvas, drawn[i] ?? null, influences, samplingPlan)
          );
        }
      }
      const drawnSketches: Sketch[] = [];
      for (const r of results) {
        if (!r.png) continue;
        const file = path.join('sketches', `${r.problemId}-${r.index + 1}.png`);
        writeFileSync(path.join(o.outDir, file), r.png);
        drawnSketches.push({ problemId: r.problemId, steps: [], finalHash: r.programHash, png: file });
      }
      found = {
        problems,
        sketches: drawnSketches,
        contact: sheetOf(results),
        notes: sheetNotes(results),
        fertile: [],
        rejected: [],
      };
    }
    await sketchCanvas.close();
    const sketches = found.sketches;
    if (found.contact) writeFileSync(path.join(o.outDir, 'sketches', 'contact.png'), found.contact);

    // 3. CHOOSE -----------------------------------------------------------------------------------
    // `found.problems` and not `problems`. On the default arm they are the same list. On a discovery
    // run they are the problems COMPARE committed to, which is what makes the pairwise judgment
    // binding rather than advisory: CHOOSE still names the collision, the terms and the intention,
    // and it can no longer quietly pick a problem the artist has already argued its way off.
    const chosen = await choose(o.policy, log, spend, commission, found.problems, sketches, found.contact, found.notes);
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
      // `influences`, not `makeInfluences`. A work shown once in FIND is a work this run showed, and
      // a `retrieve` naming it two hours later is grounded whether or not the block was still on the
      // page at that step. `makeInfluences` answers a different question — what the act call carried
      // — and using it here would mark the default arm's every retrieval unfounded by construction.
      shownWorks: influences?.resolved.works.map((w) => w.id) ?? [],
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
    let samplingRevisionUsed = false;
    let sampledFinish: AcceptedSamplingFinish | null = null;

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
      const call = await act(o.policy, log, spend, context, env.plate, env.change?.png ?? null, makeInfluences, samplingPlan);
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
        let gatePlate = env.plate ?? (await canvas.render(env.program, { metrics: true })).png;
        let gateProgramHash = env.programHash;
        let gateLook = env.look;
        let gateSample: AcceptedSamplingFinish | null = null;
        if (samplingPlan) {
          const bound = await bindSamples(o.policy, log, spend, env.program, samplingPlan);
          if (!bound.valid) {
            finishAttempts++;
            const reasons = bound.faults.map((fault) => `[sampling-binding] ${fault}`);
            log.append('note', { phase: 'finish-gate', k, attempt: finishAttempts, accepted: false, blockers: reasons });
            if (finishAttempts >= maxFinishAttempts && maxFinishAttempts > 0) {
              stopped = 'finish-blocked';
              break;
            }
            blocked = { trigger: 'finish-blocked', detail: reasons.join(' '), usd: 0, cached: true };
          } else {
            const boundBase = withBindings(env.program, bound.bindings);
            env.program = boundBase;
            env.programHash = contentHash(boundBase);
            let pair = await renderSamplingPair(canvas, log, o.outDir, boundBase, samplingPlan, finishAttempts + 1);
            if (!samplingRevisionUsed) {
              const review = await reviewSampling(o.policy, log, spend, samplingPlan, pair.compilation, pair.sampled.png, pair.ablation.png);
              samplingRevisionUsed = true;
              const planRevision = reviseSamplingPlan(samplingPlan, review.revision);
              const baseRevision = revisedBase(boundBase, review.revision, bound.bindings, planRevision.plan);
              const faults = [...planRevision.faults, ...baseRevision.faults];
              const accepted = faults.length === 0;
              log.append('sample_revised', { revision: review.revision, assessment: review.assessment, accepted, faults });
              if (accepted) {
                samplingPlan = planRevision.plan;
                if (review.revision.kind === 'base') {
                  await env.replaceProgram(baseRevision.program);
                }
                if (review.revision.kind !== 'none') {
                  pair = await renderSamplingPair(canvas, log, o.outDir, env.program, samplingPlan, finishAttempts + 1, '-revised');
                }
              }
            }
            const inspected = await env.inspect(pair.compilation.program as Program);
            gatePlate = pair.sampled.png;
            gateProgramHash = pair.sampled.programHash;
            gateLook = inspected.look;
            gateSample = { pair, inspected, base: env.program, bindings: bound.bindings };
            writeFileSync(path.join(o.outDir, 'sampling', 'sampling-plan.json'), `${JSON.stringify(samplingPlan, null, 2)}\n`);
            writeFileSync(path.join(o.outDir, 'sampling', 'base-program.json'), `${JSON.stringify(env.program, null, 2)}\n`);
          }
        }
        if (blocked) {
          // Invalid bindings never reach compilation or EXAMINE; the finish request becomes a replan.
        } else {
          const attempt = await examine(
            o.policy,
            log,
            spend,
            commission,
            env.intention,
            gateLook.checkReport,
            gateLook.description,
            gateLook.audienceRead ?? null,
            gatePlate
          );
          seen0 = attempt;
          if (maxFinishAttempts === 0) {
            // The gate is off: the pre-gate environment, kept runnable so that "the gate changed the
            // work" is a comparison somebody can actually run rather than an assertion.
            stopped = 'declared-finished';
            sampledFinish = gateSample;
            break;
          }
          const blockers = finishBlockers({
            brief: loaded.brief,
            report: gateLook.checkReport,
            examine: attempt,
            // Only asked when the artist wants to stop. Null would mean "not asked", and the gate
            // never blocks on evidence it does not have.
            transcript: await env.readBack(gatePlate, gateProgramHash),
            rubrics: await env.readRubrics(hardRubrics(gateLook.checkReport), gatePlate, gateProgramHash),
            wouldAct: gateLook.wouldAct,
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
            sampledFinish = gateSample;
            break;
          }
          if (finishAttempts >= maxFinishAttempts) {
            // It asked, was told why not, and asked again unchanged. The piece stands as it stands
            // and the record says the stop was not earned.
            stopped = 'finish-blocked';
            sampledFinish = gateSample;
            break;
          }
          blocked = {
            trigger: 'finish-blocked',
            detail: blockerLines(blockers).join(' '),
            usd: 0,
            cached: true,
          };
        }
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
          makeInfluences,
          samplingPlan
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
    const finalProgram = (sampledFinish?.pair.compilation.program as Program | undefined) ?? env.program;
    const finalRender = sampledFinish?.pair.sampled ?? await canvas.render(finalProgram, { metrics: true });
    writeFileSync(path.join(o.outDir, 'final.png'), finalRender.png);
    const scoringReport = sampledFinish?.inspected.look.checkReport ?? check(finalProgram, loaded.effective, finalRender.metrics);

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
        scoringReport,
        sampledFinish?.inspected.look.description ?? env.look.description,
        sampledFinish?.inspected.look.audienceRead ?? env.look.audienceRead ?? null,
        finalRender.png
      ));

    // 6. UPDATE PRACTICE --------------------------------------------------------------------------
    // The last policy call of the run, and it is on the chain rather than in discovery.jsonl: a
    // practice version is a claim the artist is held to on every later run, and a claim whose
    // supporting record may legitimately be deleted is not one anybody can be held to. It has to
    // land here, after the loop's and EXAMINE's calls and before `trajectory-end`, because `replay`
    // walks recorded calls in order.
    if (discovery) {
      const version = await updatePractice(
        o.policy,
        log,
        spend,
        {
          positionId: loaded.positionAsWritten.id,
          // The practice as this run was actually given it — `commission`, not `loaded`, so a
          // control arm records the empty practice it was working under rather than the real one.
          practice: commission.practice,
          trajectoryId: id,
          sheet: materials,
          fertile: found.fertile,
          rejected: found.rejected,
        },
        o.practiceStore ?? PRACTICE_STORE
      );
      log.append('note', { phase: 'update-practice', version: version.version, hash: version.hash });
    }

    // 7. FINISH -----------------------------------------------------------------------------------
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

    // 8. SCORES -----------------------------------------------------------------------------------
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
      ...(sampledFinish && samplingPlan
        ? {
            sampling: {
              plan: samplingPlan,
              bindings: sampledFinish.bindings,
              resolutions: sampledFinish.pair.resolutions,
              baseProgram: sampledFinish.base,
              sampledFile: sampledFinish.pair.sampledFile,
              ablationFile: sampledFinish.pair.ablationFile,
              ablationPixelHash: sampledFinish.pair.ablation.pixelHash,
            },
          }
        : {}),
      collision: chosen.collision,
      terms: chosen.terms,
      chosen: { problemId: chosen.problemId, why: chosen.why, cost: chosen.cost },
      intention0,
      intentions,
      steps,
      finalProgram,
      finalHash: finalRender.programHash,
      examine: seen,
      outcome,
      ...(abandonReason ? { abandonReason } : {}),
      scores: scoresOf(
        scoringReport,
        env.intention,
        finalProgram,
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
