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

export type { EditAction, CheckReport, Program };

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
}

export type TriggerName =
  | 'description-disagrees'
  | 'audience-disagrees'
  | 'unplanned-violation'
  | 'artist-declares'
  | 'stall';

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
  affect: Affect;
  /** sha256 of the exact observation string this step's THINK+ACT call was given. */
  observationHash: string;
}

export interface Sketch {
  problemId: string;
  steps: Step[];
  finalHash: string;
  /** Path, relative to the trajectory directory. */
  png: string;
}

export type Mode = 'plan' | 'discover' | 'both';
export type Outcome = 'finished' | 'abandoned';

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
  /** Nothing in this repo judges. Every rubric the position raised, carried forward unread. */
  judgePending: string[];
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
  kind: 'declared-finished' | 'abandoned' | 'out-of-steps';
  /** Edges the tree can decide and says are not satisfied at the final program. */
  edgesUnrealized: number;
  /** `from->to` for each of them, so the record says which and not just how many. */
  unrealizedEdges: string[];
  /** What the artist named on its terminal step, or null. Not required to match. */
  declaredUnrealizable: string | null;
  /** True only when the stop was a decision about the work rather than a step count expiring. */
  legitimate: boolean;
}

/**
 * Every input that could have changed the answer, hashed. The four prompt layers are hashed
 * separately and not rolled together: an ablation that swaps one of them has to be able to say
 * which one moved, and a single combined hash would only say that something did.
 */
export interface EnvVersion {
  /** sha256 of the observation serializer's own bytes. Changing it is a new environment version. */
  observationHash: string;
  profileHash: string;
  packHash: string;
  /** L4. The transaction protocol, which varies with neither artist nor commission. */
  protocolHash: string;
  /** L1. The practice, artist-side. */
  positionHash: string;
  /** L3. The kind of object, artist-agnostic. */
  deliverableHash: string;
  /** L2. The commission, artist-agnostic. */
  briefHash: string;
  fieldHash: string;
}

export interface Trajectory {
  id: string;
  positionId: string;
  positionHash: string;
  briefId: string;
  /** The kind of object commissioned — L3. */
  deliverableId: string;
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
