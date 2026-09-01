// The artist's vocabulary: what a trajectory is made of.
//
// Everything here is data that survives the process. A Trajectory is written to disk as JSONL plus a
// handful of files, and `reward.ts` has to be able to rebuild every score in it from that record
// alone. So nothing in these types may be a function, a closure, or a handle to a browser.
//
// The medium's own types are imported, never redefined: an Edit here is exactly the EditAction the
// medium's applyEdit accepts, and a CheckReport here is exactly what the aesthetic layer produced.

import type { EditAction, Program } from '../env/edits.js';
import type { CheckReport } from '../aesthetic/types.js';
import type { StepWarrant } from './warrant.js';

export type { EditAction, CheckReport, Program };

/**
 * What the watcher would actually do. Three words rather than a number: a number invites a
 * threshold, a threshold gets tuned, and it would be tuned until the trajectories looked better.
 */
export type WouldAct = 'act' | 'consider' | 'ignore';

/** The same three-part shape the aesthetic layer uses for a position's tensions. */
export interface Tension {
  between: string;
  and: string;
  claim: string;
}

// --- the cultural field ------------------------------------------------------------------------

/**
 * The scene a brief lands in. Environment, not policy: hand-written per brief, never generated,
 * hashed into every trajectory. `whoIsWatching.audience` is deliberately a self-contained paragraph
 * because it is the ONLY part of the field the audience model is allowed to see.
 */
export interface Field {
  version: '1.0';
  briefId: string;
  whenAndWhere: string;
  inTheAir: string[];
  contested: string[];
  exhausted: string[];
  whoIsWatching: { audience: string; adversary: string };
  transplants: { ref: string; why: string }[];
  /**
   * 0..1, hand-set, and the artist never sees it: it is read once to initialise arousal. See
   * ./affect.ts for the four-level rubric it is set against. A number rather than an inference
   * because inferring it from the brief's prose measures the inferrer, not the brief.
   */
  stakesLevel: number;
  /** One line justifying stakesLevel against the rubric, so the number can be argued with. */
  stakesLevelWhy: string;
}

// --- what the artist decides -------------------------------------------------------------------

/** A problem found in the field, tied to one of the position's own tensions. */
export interface Problem {
  id: string;
  text: string;
  tension: Tension;
  /** Which lines of the field this problem was read out of. Free text, quoted back for the record. */
  fieldRefs: string[];
  /**
   * The weight the artist put on this problem when it named the whole distribution. Optional because
   * trajectories collected before verbalized sampling existed do not carry it, and — the standing
   * trap in this repo — an absent weight must not be read as a confident zero. Check that the field
   * exists, never that it is non-zero.
   */
  probability?: number;
}

/** A question the brief did not answer, and what the artist decided in the absence of an answer. */
export interface Question {
  question: string;
  whyItChangesTheObject: string;
  decidingInstead: string;
}

/**
 * Where the commission and the practice are actually in conflict, as two named things and a
 * sentence. This is the single best diagnostic in the run: a collision naming a real requirement
 * against a real principle means the two layers were both read, and a vague one means at least one
 * of them was skimmed. Logged as its own field for exactly that reason.
 */
export interface Collision {
  requirement: string;
  principle: string;
  statement: string;
}

/** What the artist will and will not do for the fee, and the line it would walk over. */
export interface Terms {
  outOfScope: string[];
  willNotChange: string[];
  wouldLoseTheCommissionOver: string;
}

export type EdgeType = 'aligned-to' | 'masked-by' | 'echoes' | 'contradicts' | 'answers';

/**
 * How an element is attached to the artefact — the thing that decides whether the tree is even the
 * right place to look for it.
 *
 *   node            marks on the sheet. The environment fills `nodeIds` as edits land.
 *   region          marks on the sheet that were promised to a named rectangle of it. Strictly
 *                   harder than `node`: the nodes have to exist AND their coordinates have to be
 *                   inside `ref`.
 *   ratio           a relation between two or more other declared elements. Owns no node of its own
 *                   and never will; its `ref` names the elements it is a relation between.
 *   absence         something deliberately not printed. Owns no node by construction.
 *   render-measure  a property of the printed image rather than of the tree: `ref` is one of the
 *                   four numbers the measurer takes off the canonical PNG.
 */
export type BindingKind = 'node' | 'region' | 'ratio' | 'absence' | 'render-measure';

export interface ElementBinding {
  kind: BindingKind;
  /**
   * What the binding points at. Read, and checked, differently per kind: a rectangle `x,y,w,h` for
   * `region`; two or more element ids for `ratio`; a metric name for `render-measure`; prose naming
   * what is missing for `absence`; unused for `node`.
   *
   * The check is the point. `locatable: false`, which this replaces, was an unfalsifiable claim —
   * the artist asserted an element was not the kind of thing the tree could hold and nothing could
   * ever disagree. A binding has to name its referent, and a `ratio` pointing at an element nobody
   * declared or a `render-measure` naming a number that does not exist is a broken plan, scored
   * `violated` rather than waved through to a judge.
   */
  ref?: string;
}

export interface IntentionElement {
  id: string;
  role: string;
  /** Source node ids in the program this element is made of. May be empty before it exists. */
  nodeIds: string[];
  /**
   * How this element reaches the artefact. Declared by the artist; absent only on intentions
   * recorded before bindings existed, where `bindingOf` reconstructs one.
   *
   * It is safe to let the policy declare this because it buys nothing. A binding that owns no node
   * routes its edges to `judge-pending`, which removes them from the realization denominator rather
   * than satisfying them, and an intention with no decidable edges at all scores `null` — never 1.
   */
  binding?: ElementBinding;
  /**
   * The predecessor of `binding`, still read so that trajectories logged under it can be rescored.
   * Never written. See `bindingOf` for the reconstruction.
   */
  locatable?: boolean;
}

export interface IntentionEdge {
  from: string;
  to: string;
  type: EdgeType;
  claim: string;
}

export interface RiskMove {
  convention: string;
  why: string;
}

/**
 * The plan, as a graph over named elements. Not prose: the elements carry node ids so `realization`
 * can ask the tree whether the plan happened, and the edges carry a type so two of them can be
 * decided mechanically instead of by opinion.
 */
export interface Intention {
  elements: IntentionElement[];
  edges: IntentionEdge[];
  purpose: string;
  tension: Tension;
  riskMove: RiskMove | null;
}

/** Two numbers. A state that steers search; never a label on anything in the picture. */
export interface Affect {
  arousal: number;
  valence: number;
}

export type Control = 'continue' | 'replan' | 'finished' | 'abandon';

/** What the artist says and does in one turn. Exactly one policy call produces all of it. */
export interface Action {
  think: string;
  control: Control;
  /** The convention about to be broken, or null. Only meaningful once the step is accepted. */
  risk: string | null;
  /**
   * Constraint ids this step claims to be serving — the positive twin of `risk`, checked against
   * what the step did by `artist/warrant.ts`.
   *
   * Optional in the type and required in the schema. Every trajectory recorded before the field
   * existed has no `warrant` on any action, and `undefined` there must read as "never asked", not
   * as "cited nothing": `warrantSummary` counts those steps separately and leaves them out of every
   * rate. A default of `[]` here would silently turn every old run into a run with a perfect
   * citation record.
   */
  warrant?: string[];
  /**
   * On a `finished` step, the one edge of the plan the artist could not realize in this medium,
   * written `from->to`. Null when it claims every edge holds. Meaningless on any other control.
   *
   * This is what makes stopping a decision rather than a timer. Without it the only decidable
   * stopping rule is "every edge is bound", which punishes an artist that correctly recognises an
   * edge as unmakeable here and stops instead of grinding at it. With it, a scorer can decide
   * legitimacy of the stop with no model in the loop: either nothing is outstanding, or exactly one
   * thing is and the artist named it.
   */
  unrealizable: string | null;
  edits: (EditAction & { servesElementId?: string })[];
}

/**
 * Why the validator would not take an edit.
 *
 *   budget       a cap was reached: `[budget]` or any `[limit.*]`. The artist asked for something
 *                the medium can do and has run out of room to do it.
 *   capability   the profile or pack does not have the thing at all: any `*.notAllowed` or
 *                `*.unknown`. Not a cap and not a mistake — a request the medium cannot serve.
 *   structural   everything else: a target that is not there, a shape that does not match, a
 *                duplicate id, a number outside its range. The only kind that is the artist's fault.
 *
 * Kept apart because they mean opposite things about the artist. A run whose refusals are all
 * `budget` was not making errors, it was hitting a wall it could not see; scoring that as poor
 * action selection measures the cap. One measured run refused twenty-two edits for `maxTextOps`
 * alone out of twenty-nine refusals total.
 */
export type RefusalCause = 'budget' | 'capability' | 'structural';

export interface Refusal {
  actionId: string;
  kind: string;
  cause: RefusalCause;
  /** The validator's own sentence, kept verbatim: the cause is a summary, not a replacement. */
  reason: string;
}

/** What the canvas said back, before the artist acted. */
export interface Look {
  renderHash: string;
  checkReport: CheckReport;
  description: string;
  audienceRead?: string;
  /**
   * What the watcher would do, beside the prose about what they think it is. Optional because a
   * sketch has no audience and because logs written before this existed carry no value for it — an
   * absent field here must read as "not asked", never as `ignore`.
   */
  wouldAct?: WouldAct;
}

export type TriggerName =
  | 'description-disagrees'
  | 'audience-disagrees'
  | 'unplanned-violation'
  | 'artist-declares'
  | 'stall'
  /** The artist asked to finish and the environment refused. See `gate.ts`. */
  | 'finish-blocked';

export interface Replan {
  trigger: TriggerName;
  before: Intention;
  after: Intention;
}

export interface Step {
  k: number;
  look: Look;
  action: Action;
  replan: Replan | null;
  accepted: boolean;
  revertedBecause?: string;
  isRiskMove: boolean;
  /** Nodes that carried a satisfied constraint in `look` and were deleted, covered or overpainted. */
  destroyedNodeIds: string[];
  /** The actionIds that the validator let through, in order. The rest were refused. */
  appliedActionIds: string[];
  /** The ones it would not take, each with its cause separated from the validator's sentence. */
  refused: Refusal[];
  /**
   * Share of the canvas this step moved, 0 on any step that was not kept. The tree diff says what
   * was edited; this says whether it showed.
   */
  pixelsMoved: number;
  /**
   * A step that was kept and did not change the picture. Undefined on a step that was never kept,
   * and on any step logged before this existed — it must not read as `false` there, since a run
   * that was never asked and a run that was asked and said no are different facts.
   */
  inert?: boolean;
  /**
   * Whether this step raised the run's best standing and showed it — the exact condition the
   * environment uses to reset the stall counter and lift the mood.
   *
   * Stamped rather than recomputed because the standing it compares against is the *running best*,
   * which no per-step field carries; without it, "when did the reward last move" is not a function
   * of the record. Undefined on steps logged before this existed, and it must not read as `false`
   * there: a run nobody asked and a run that improved nothing are different facts.
   */
  improved?: boolean;
  affect: Affect;
  /** sha256 of the exact observation string this step's THINK+ACT call was given. */
  observationHash: string;
  /**
   * What this step broke, and what its `risk` had said about it. Null on steps that never reached a
   * comparison — nothing applied, or the candidate would not render.
   */
  declaration: StepDeclaration | null;
  /**
   * This step's citations, checked. Null on steps that never reached a before/after comparison, and
   * `undefined` on steps recorded before the field existed — see `Action.warrant`.
   */
  warrant?: StepWarrant | null;
  /**
   * Whether the plate was actually attached to this step's THINK+ACT call, and the change image
   * with it. Stamped from the context that was built, not from the run's flag: the flag says what
   * was asked for, and these say what the payload carried.
   */
  sawCanvas: boolean;
  sawChange: boolean;
}

/**
 * A step's account of what it was going to break, checked against what it did break.
 *
 * `namedIds` comes from the step's `risk` field alone. The MAKE schema has always said that naming a
 * constraint id there is how a break is declared; the trigger used to read `think` as well, which
 * turned every incidental mention into a pass — and the artist is shown every id, on every call, in
 * the checker table.
 */
export interface StepDeclaration {
  namedIds: string[];
  /** More than `MAX_DECLARED_IDS` were named, so the step declared nothing and covers nothing. */
  blanket: boolean;
  /** Constraints that went satisfied -> violated on this step. */
  broke: string[];
  /** The ones the declaration actually covered. Empty whenever `blanket`. */
  covered: string[];
}

export interface Sketch {
  problemId: string;
  steps: Step[];
  finalHash: string;
  /** Path, relative to the trajectory directory. */
  png: string;
}

export type Mode = 'plan' | 'discover' | 'both';
/**
 * How the run ended, as the headline reads it.
 *
 * `unresolved` exists because `finished` used to be the default and absorbed two other endings.
 * A run that used its last step and stopped, and a run that asked to stop and was refused, both
 * reported `outcome: "finished"` beside `termination.legitimate: false` — the top line said the
 * work was done and the field underneath said it was not. `finished` now means only what
 * `declared-finished` means: the artist asked, and the environment let it go.
 */
export type Outcome = 'finished' | 'abandoned' | 'unresolved';

export interface EdgeEstimate {
  from: string;
  to: string;
  type: EdgeType;
  /** 'satisfied' | 'violated' from the tree, or 'judge-pending' when only a judge could say. */
  status: 'satisfied' | 'violated' | 'judge-pending';
  evidence: string;
}

export interface Examine {
  selfScore: number;
  edgeEstimates: EdgeEstimate[];
  paragraph: string;
}

/**
 * The tree's verdicts and the eye's, joined edge by edge. Only edges the tree actually decided are
 * compared; for the three non-mechanical edge types the tree returns `judge-pending` by
 * construction, and counting those as disagreements would measure `estimateEdge` rather than the run.
 */
export interface ExamineAgreement {
  /** Edges the tree decided and EXAMINE also decided. The denominator; the rest are diagnostics. */
  comparable: number;
  agree: number;
  /** Tree: the relation holds. Eye: it does not. Structure that did not become a picture. */
  treeYesEyeNo: number;
  /** Tree: it does not hold. Eye: it does. A relation claimed after the program denied it. */
  treeNoEyeYes: number;
  /** The tree decided and the artist declined to. Not a disagreement; still not an answer. */
  eyePending: number;
  /**
   * Edges the eye ruled on that the tree had already declined to decide — the three non-mechanical
   * types. Where the eye actually decided one, this is the only place EXAMINE adds evidence instead
   * of duplicating it, and `fusedRealization` is what consumes those. Where the eye declined too,
   * nobody decided the edge and it is counted here rather than nowhere.
   *
   * It exists because the rollup did not close: on the run that exposed this, EXAMINE gave 9
   * verdicts and the buckets accounted for 7. `comparable + eyePending + treePending + unplanned`
   * is now every verdict EXAMINE gave, and a rollup that does not add up is one nobody can read.
   */
  treePending: number;
  /** Verdicts on edges the plan does not contain. */
  unplanned: number;
  /** Edges the tree decided that EXAMINE returned no verdict on at all. */
  unexamined: number;
}

export interface Cost {
  policyCalls: number;
  envCalls: number;
  cachedEnvCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  wallMs: number;
  renders: number;
}

export interface Scores {
  /** Fraction of decidable tree-scope constraints satisfied, hard weighted double. */
  tree: number | null;
  render: number | null;
  hardViolations: number;
  softViolations: number;
  realization: {
    score: number | null;
    mechanical: number;
    satisfied: number;
    judgePending: number;
    /**
     * Fraction of the elements bound to the sheet — `node` and `region` — that landed on it.
     * Absences, ratios and render-measures are not asked; a `region` is asked more strictly than a
     * `node`, since it named the rectangle it was going in.
     */
    elementsMade: number;
    /**
     * `score`, with EXAMINE allowed to decide only the edges the tree cannot decide at all.
     *
     * One-directional on purpose: the eye fills silence, it never overturns a mechanical verdict.
     * The artist controls both sides of that trade, so letting a self-assessment flip `violated` to
     * `satisfied` would make claiming a relation cheaper than building it. Null when EXAMINE did
     * not run. `fromEye` says how much of the denominator it supplied — at 0 this is `score`.
     */
    fused: { score: number | null; decidable: number; satisfied: number; fromEye: number } | null;
  };
  /**
   * Structural distance travelled across replans: element ids and edges only. Rewording a role or a
   * purpose moves nothing here — see `purposeChurn` for that, kept separate on purpose.
   */
  drift: number;
  purposeChurn: { changed: number; charsFirst: number; charsLast: number };
  /** Steps whose outcome was a change of plan rather than a change of picture. */
  problemFindingSteps: number;
  /** Problems from FIND whose quoted field lines actually appear in the field. */
  problemsGrounded: number;
  destructionRate: number;
  /**
   * Steps that were kept and did not change the picture. `null` when no step carried the field, so
   * a log written before the measurement existed does not report a confident zero.
   *
   * This is the reward-hacking counter. Splitting a text node in two to get under a word limit, or
   * adding a tick nobody can see to satisfy a count, both raise the checker's score and leave the
   * sheet exactly as it was. They earn nothing now; this says how often it was tried.
   */
  inertSteps: number | null;
  /**
   * Where the reward gradient actually is: how many steps improved anything, and how many ran on
   * the end having improved nothing.
   *
   * This is the number that decides whether the environment can train. On the run it was built for,
   * the piece was made in step 1, the score hit 1.000 at step 2 and stayed there — `trailing: 10`
   * on a 12-step trajectory, meaning 83% of the run carried no signal at all, while every headline
   * score read perfect. Nothing else in this file could show that: `tree` and `render` report where
   * the run ended up, and a run that arrives immediately and a run that climbs steadily produce the
   * same pair of numbers.
   *
   * `null` when no step recorded `improved`, for the reason `inertSteps` is null there.
   */
  gradient: { improvedSteps: number; trailing: number; longestStall: number } | null;
  /**
   * Times the artist asked to finish and the environment refused. `null` on a run that predates the
   * gate — distinct from 0, which means it asked once and was let go, or never asked at all.
   *
   * The whole point of the run this was built for is the distance between judging a piece a failure
   * and doing something about it. This number is the near end of that distance: it counts the
   * occasions on which the loop made the artist keep working.
   */
  finishRefusals: number | null;
  /**
   * What the run's declarations were worth. A declaration is what buys a step past the revert rule,
   * so it is the one piece of the artist's prose the environment acts on, and it needs measuring on
   * its own terms rather than only as the absence of a trigger.
   */
  declarations: {
    /** New violations a declaration covered, over all new violations. 0 when nothing broke. */
    declaredViolationRate: number;
    /** Named ids that were really broken, over named ids. Low means the naming was a hedge. */
    declarationSpecificity: number;
    /** Which constraints this run declared away, and how often. */
    declaredViolationsByConstraint: Record<string, number>;
    /** Steps whose risk named more constraints than a declaration can carry. */
    blanketSteps: number;
  };
  /**
   * Share of steps whose act call actually carried the plate, and the change image with it.
   *
   * Whether the artist can see what it is editing is the largest single difference between two runs
   * of this environment, and until now it was recorded nowhere in the scores — a blind run and a
   * sighted one produced score files that could not be told apart, and every comparison across the
   * two silently mixed them. `null` when no step recorded it: see `visibleRate` in ./intention.ts.
   */
  canvasVisibleRate: number | null;
  changeVisibleRate: number | null;
  /**
   * Whether any version of the plan named a convention to break. The declaration, kept beside the
   * outcome so that "said it would, didn't" shows up as the gap between two numbers rather than
   * disappearing into either one.
   */
  riskDeclared: boolean;
  riskMoveTaken: boolean;
  /**
   * The convention a step actually said it was breaking, or null. Never the plan's stated riskMove:
   * an intention is a thing the artist said it would do, and reporting it here as though a step had
   * done it turns every unexecuted intention into a result.
   */
  riskConvention: string | null;
  selfScore: number | null;
  /**
   * EXAMINE's own verdicts on its edges, tallied. Reported beside `realization` rather than merged
   * into it because the two are computed from different evidence — realization reads the tree,
   * EXAMINE reads the picture and the describer's prose — and a disagreement between them is the
   * signal. Null when EXAMINE did not run.
   */
  examineEdges: { satisfied: number; violated: number; judgePending: number } | null;
  /**
   * The disagreement itself, edge by edge, rather than the two tallies left side by side for a
   * reader to subtract. Two separate counts of different edges can look identical and mean opposite
   * things; only the join says which edges moved. Null when EXAMINE did not run.
   */
  examineAgreement: ExamineAgreement | null;
  /**
   * Every edit the validator refused, split by cause. Never summed into one number: a budget
   * refusal and a structural one are evidence about different things, and adding them produces a
   * quantity that means nothing.
   */
  refusals: Record<RefusalCause, number>;
  /** How the run stopped, and whether a scorer can call that stop legitimate without a model. */
  termination: Termination;
  affectTrace: Affect[];
  /** Whether the affect in that trace ever changed a decision. See `affectArmed` in ./affect.ts. */
  affectArmed: AffectArmed;
  /**
   * Every rubric the position raised, carried forward unread for L5.
   *
   * Named `pendingRubrics`, not `judgePending`, because `judgePending` already meant something else
   * twice in this same object — `realization.judgePending` and `examineEdges.judgePending`, both
   * counts of *edges* nobody could decide. Those two agree with each other and are fine. This one
   * is a list of rubric texts and shares nothing but the word.
   */
  pendingRubrics: string[];
}

/**
 * The three thresholds affect can cross, counted over the affects the loop actually consulted.
 *
 * `armed === 0` is the reading this exists for: the run would have been identical with affect frozen
 * at its opening value. Movement in `arousalRange` / `valenceRange` beside `armed === 0` says the
 * numbers moved and never crossed; a zero-width range says they never moved.
 */
export interface AffectArmed {
  observed: number;
  editsChanged: number;
  stallChanged: number;
  credulousChanged: number;
  armed: number;
  armedRate: number;
  arousalRange: [number, number];
  valenceRange: [number, number];
}

/**
 * The terminal condition, made decidable.
 *
 * The acceptance test for a stop action is whether a scorer can decide, with no language model,
 * that the run terminated legitimately. `out-of-steps` cannot pass it — a timer expired, and
 * nothing about the work was consulted. So legitimacy is defined only over the artist's own
 * `finished`, against the plan it declared: either every edge the tree can decide is satisfied, or
 * exactly one is not and the artist named that one as unrealizable in this medium.
 *
 * `abandoned` is deliberately NOT legitimate-or-not. It is a different outcome, already reported as
 * `Trajectory.outcome`, and folding it in here would either reward abandoning as a way to stop
 * cleanly or punish the one refusal capability the design is trying to elicit.
 */
export interface Termination {
  /**
   * `finish-blocked`: the artist asked to stop, was told why it could not, and asked again without
   * the reasons having gone away. It is not `declared-finished` — the stop was refused, not made —
   * and it is not `out-of-steps`, because the run had steps left and chose not to use them.
   */
  kind: 'declared-finished' | 'abandoned' | 'out-of-steps' | 'finish-blocked';
  /** Edges the tree can decide and says are not satisfied at the final program. */
  edgesUnrealized: number;
  /** `from->to` for each of them, so the record says which and not just how many. */
  unrealizedEdges: string[];
  /** What the artist named on its terminal step, or null. Not required to match. */
  declaredUnrealizable: string | null;
  /** Unjudgeable edges over all edges in the final plan. */
  pendingRate: number;
  /**
   * Whether that rate is over `PENDING_CAP`. Reported separately from `legitimate` because the two
   * failures are different: a stop that was not earned, and a stop nothing could have contradicted.
   */
  pendingCapExceeded: boolean;
  /** True only when the stop was a decision about the work rather than a step count expiring. */
  legitimate: boolean;
}

/**
 * Every input that could have changed the answer, hashed. The prompt layers are hashed
 * separately and not rolled together: an ablation that swaps one of them has to be able to say
 * which one moved, and a single combined hash would only say that something did.
 */
export interface EnvVersion {
  /** sha256 of the observation serializer's own bytes. Changing it is a new environment version. */
  observationHash: string;
  /** sha256 of the affect arithmetic: how the environment reacts, as opposed to what it shows. */
  dynamicsHash: string;
  profileHash: string;
  packHash: string;
  /** L4. The transaction protocol, which varies with neither artist nor commission. */
  protocolHash: string;
  /** L1. The practice, artist-side. */
  positionHash: string;
  /** L2. The commission, artist-agnostic. */
  briefHash: string;
  fieldHash: string;
  /**
   * The lineage elements the run composed with, as one hash. A separate field rather than folded into
   * `packHash`, because the asset pack and the element pack answer different questions: a run that
   * changed which brushes exist should not read as a run that changed which traditions it drew on.
   * The empty set hashes to a real, stable value, so an ordinary run carries this too.
   */
  elementPackHash: string;
  /**
   * L5. What the artist was shown of a corpus — present ONLY on runs that were shown one.
   *
   * Optional and absent by default, unlike `elementPackHash` above, and the difference is
   * deliberate. An empty element pack is a real state of an ordinary run: every run composes with
   * some set of elements and the empty one is a set. Influences are not like that. Most runs do not
   * have the layer at all, and giving them a hash of "nothing" would add a field to every trajectory
   * ever collected and make each one read as a different environment from the one it ran in.
   *
   * `envDrift` skips a field the record does not carry, so an old run is not refused over this. The
   * consequence to keep in mind is the other direction: **the absence of this field is not evidence
   * the layer was off** in a log written before the field existed.
   */
  influencesHash?: string;
}

export interface Trajectory {
  id: string;
  positionId: string;
  positionHash: string;
  briefId: string;
  /**
   * The lineage elements composed into the position, sorted. Empty is the ordinary case and means
   * the run adopted none. Recorded because `envVersion.elementPackHash` says only *whether* two runs
   * used the same set, never which one, and a hash is not a thing a reader can look up.
   */
  elementIds: string[];
  /**
   * Which arm this is: false for the position, true for its null twin.
   *
   * Recorded here because it cannot be recovered from anything else on the trajectory. `positionId`
   * is deliberately the real position's id in both arms — the control is scored against the position
   * it is a control *for*, and a row that renamed itself would not join to its twin — so there is no
   * id suffix to read the arm off. Inferring it from one used to be exactly the bug: `scoresCsv`
   * tested `positionId.endsWith('-control')` against an id that never carries the suffix, and every
   * control row in every grid reported itself as a position row.
   */
  control: boolean;
  fieldHash: string;
  mode: Mode;
  seed: number;
  seedProgram: Program;
  /**
   * Style words found in the brief by field.ts's scan. Non-empty means L2 carried aesthetic
   * direction, which makes this run non-comparable with a clean one rather than merely worse.
   */
  contamination: string[];
  /** Protocol step 1: what the brief did not answer, and what was assumed instead. */
  questions: Question[];
  problems: Problem[];
  sketches: Sketch[];
  /** Protocol step 2. Null only if CHOOSE never ran. */
  collision: Collision | null;
  /** Protocol step 4. Null only if CHOOSE never ran. */
  terms: Terms | null;
  chosen: { problemId: string; why: string; cost: string } | null;
  intention0: Intention;
  intentions: Intention[];
  steps: Step[];
  finalProgram: Program;
  finalHash: string;
  examine: Examine | null;
  outcome: Outcome;
  abandonReason?: string;
  scores: Scores;
  cost: Cost;
  envVersion: EnvVersion;
}
