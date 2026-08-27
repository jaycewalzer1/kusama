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

export type EdgeType = 'aligned-to' | 'masked-by' | 'echoes' | 'contradicts' | 'answers';

export interface IntentionElement {
  id: string;
  role: string;
  /** Source node ids in the program this element is made of. May be empty before it exists. */
  nodeIds: string[];
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
  edits: (EditAction & { servesElementId?: string })[];
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
  realization: { score: number | null; mechanical: number; satisfied: number; judgePending: number };
  drift: number;
  /** Steps whose outcome was a change of plan rather than a change of picture. */
  problemFindingSteps: number;
  /** Problems from FIND whose quoted field lines actually appear in the field. */
  problemsGrounded: number;
  destructionRate: number;
  riskMoveTaken: boolean;
  riskConvention: string | null;
  selfScore: number | null;
  affectTrace: Affect[];
  /** Nothing in this repo judges. Every rubric the position raised, carried forward unread. */
  judgePending: string[];
}

export interface EnvVersion {
  /** sha256 of the observation serializer's own bytes. Changing it is a new environment version. */
  observationHash: string;
  profileHash: string;
  packHash: string;
  positionHash: string;
  fieldHash: string;
}

export interface Trajectory {
  id: string;
  positionId: string;
  positionHash: string;
  briefId: string;
  fieldHash: string;
  mode: Mode;
  seed: number;
  seedProgram: Program;
  problems: Problem[];
  sketches: Sketch[];
  chosen: { problemId: string; why: string } | null;
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
