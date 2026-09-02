// The aesthetic program: the unit the environment searches over.
//
// Five parts. Two of them (worldview, tensions) are prose the artist model reads and nothing in this
// repo ever checks. Three of them carry constraints, and a constraint's `scope` says who can decide
// it: the tree alone, the deterministic PNG, or a judge that does not exist yet.
//
// These types mirror ./aesthetic-program.schema.json exactly. The schema is the gate; these are
// what the checker reads after the gate has passed.

export type Scope = 'tree' | 'render' | 'judge';
export type Severity = 'hard' | 'soft';

export type OpName = 'wash' | 'paint' | 'stroke' | 'fragment' | 'text' | 'rule' | 'cover';
export type MacroName = 'frame' | 'motif' | 'quarantine';
export type StyleKind = 'wash' | 'hatch' | 'field' | 'outline' | 'solid';

/**
 * The closed set. Eighteen. It was sixteen, and the rule was that a seventeenth costs one of
 * these; `textMinHeight` was added without spending one because the thing it decides — is this
 * string set at image scale or is it a caption — was not expressible by any combination of the
 * other sixteen. `textMaxWords` limits how much is said and `textCase` limits how it is spelled;
 * neither can tell a title from a credit line, which is the whole difference between a work with
 * words in it and a work with a label on it.
 *
 * `edgeContactRange` is the eighteenth and was not free either. It was added because a measured
 * failure had no rule behind it: run after run left an untouched margin on all four sides while
 * every constraint passed, and prose in the protocol asking the artist to work to the edge did not
 * take. `inkDensityRange` and `coverageRange` are both satisfied by a picture that fills the middle
 * and stops — density and coverage are quantities of ink, not places — and `inkOffsetRange` moves
 * the centroid without ever requiring the sheet's border to be reached. None of the seventeen can
 * say "this must touch the edge", so the environment could not refuse a work for not touching it.
 */
export type ConstraintKind =
  | 'maxDistinctColors'
  | 'palette'
  | 'forbidNode'
  | 'requireNode'
  | 'requireErasure'
  | 'nodeCount'
  | 'textCase'
  | 'textMaxWords'
  | 'textMinHeight'
  | 'textRequired'
  | 'maxRepeatDepth'
  | 'forbidMark'
  | 'requireMark'
  | 'inkDensityRange'
  | 'symmetryMax'
  | 'inkOffsetRange'
  | 'coverageRange'
  | 'edgeContactRange'
  | 'regionCountRange'
  | 'rubric';

/**
 * Kinds that count nodes in the source tree. None of them may be `hard`, and loadAestheticProgram
 * refuses a position that makes one so.
 *
 * The rule is not aesthetic tidiness, it is a measured failure. Two runs spent their whole budget
 * churning the tree to satisfy hard node counts with no visible change to the picture: `rule` ops
 * swapped for `stroke` ops to clear a `forbidNode`, and `paint`-with-a-solid-style added purely to
 * clear a `requireMark {styles:['solid']}` that a `cover` had made unreachable. In both cases the
 * constraint went green and nobody could see a difference. Meanwhile the render-measured
 * constraints — ink density, edge contact, symmetry — were never once gamed, because the only way
 * to move them is to move pixels.
 *
 * So: what a position insists on is measured on the canvas, and what it counts in the tree is a
 * preference it can express and lose.
 */
export const COUNTING_KINDS: readonly ConstraintKind[] = [
  'requireNode',
  'requireMark',
  'requireErasure',
  'nodeCount',
];

/**
 * Tree-scope kinds a position may still make hard. Every one of them is a ceiling or a ban: it can
 * be satisfied by not doing something, so there is no way to satisfy it by adding a node that does
 * nothing. `textRequired` is not here — it is a brief's instrument, not a position's, and it is the
 * structurally weakest kind in the language (see docs/constraints.md).
 */
export const HARD_TREE_KINDS: readonly ConstraintKind[] = [
  'maxDistinctColors',
  'palette',
  'forbidNode',
  'forbidMark',
  'maxRepeatDepth',
  'textMaxWords',
  'textMinHeight',
  'textCase',
];

/**
 * The most hard, decidable constraints a position may carry.
 *
 * Four is not a round number chosen for its roundness. The three positions on disk carried ten to
 * thirteen apiece, and at that density they no longer describe a practice — between them they admit
 * about one object, and every trajectory under them converges on it. Judge rubrics are exempt and
 * uncapped: a rubric is read by somebody who can weigh it, which is where the content of a practice
 * belongs, and it is `unverified` here so it can never be satisfied by accident.
 */
export const MAX_HARD_CONSTRAINTS = 4;

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  params: Record<string, unknown>;
  scope: Scope;
  severity: Severity;
  why: string;
  /**
   * Names the primitive this medium does not have. The constraint below it is a proxy for something
   * the position wants and the substrate cannot say. Reported `unverified`, excluded from every
   * score, so the gap stays visible instead of being quietly scored as a pass.
   */
  blocked_by?: string;
}

export interface LineageRef {
  ref: string;
  why: string;
}

export interface Tension {
  between: string;
  and: string;
  claim: string;
}

export interface GenerativeRule {
  rule: string;
  constraint?: Constraint;
}

export interface AestheticProgram {
  version: '1.0';
  id: string;
  name: string;
  lineage: LineageRef[];
  worldview: string;
  tensions: Tension[];
  commitments: Constraint[];
  prohibitions: Constraint[];
  generative_rules: GenerativeRule[];
  cliches: string[];
  meta?: Record<string, unknown>;
}

// --- what a check produces -------------------------------------------------------------------------

export type Status = 'satisfied' | 'violated' | 'unverified';

export interface ConstraintResult {
  id: string;
  kind: ConstraintKind;
  scope: Scope;
  severity: Severity;
  status: Status;
  /** Where the position is stated: which of the five parts this constraint came from. */
  part: 'commitment' | 'prohibition' | 'generative_rule';
  /** Node ids, measured values, or the reason nothing could be decided. Always human-readable. */
  evidence: string;
  /**
   * The same claim as `evidence`, in a form a caller can compute with: the nodes the verdict rests
   * on — offenders when violated, carriers when satisfied. Empty when the verdict rests on an
   * absence, on an aggregate, or on the whole image; see ./kinds.ts for the rule per kind. Empty is
   * an answer, not a gap, so a caller must not fall back to reading ids out of `evidence`.
   */
  nodeIds: string[];
  why: string;
  blocked_by?: string;
  /** Only on `rubric` results: the text, passed through unread and unexecuted. */
  rubric?: string;
}

export interface CheckReport {
  aesthetic: string;
  hardViolations: number;
  softViolations: number;
  /** Fraction of decidable tree-scope constraints satisfied, hard weighted double. null if none. */
  treeScore: number | null;
  /** The same over render scope. null when no render metrics were supplied. */
  renderScore: number | null;
  /** Constraints excluded from both scores because they name a primitive the medium lacks. */
  blocked: number;
  /** Rubric texts nobody has judged. Returned verbatim. */
  pendingRubrics: { id: string; text: string }[];
  results: ConstraintResult[];
}

/**
 * Everything the render scope is allowed to know. Computed once per program hash from the canonical
 * RGBA and cached; see ./measure.ts. Deliberately four numbers and not a feature vector
 * — a render-scope constraint that needs more than this is a judge-scope constraint wearing a hat.
 *
 * Adding or redefining a field here means bumping METRICS_VERSION in measure.ts, or a cache entry
 * written before the field existed will parse and read as undefined.
 */
export interface RenderMetrics {
  /** Fraction of pixels that are not the ground colour. */
  inkDensity: number;
  /** Fraction of a fixed 16x16 grid of cells that contain any ink at all. */
  coverage: number;
  /**
   * Distance of the tone-weighted ink centroid from the sheet centre, over centre-to-corner. 0 is
   * dead centre, 0 for a blank sheet. Unlike `symmetry` it survives a full bleed.
   */
  inkOffset: number;
  /** Ink-mask agreement with its own mirror, as intersection over union. 0 when there is no ink. */
  symmetry: { vertical: number; horizontal: number };
  /**
   * Per side, the fraction of a band along that edge of the sheet that carries ink. 0 is an
   * untouched margin, 1 is a band inked wall to wall.
   *
   * Four numbers rather than one on purpose. A picture that runs off three sides and leaves the
   * fourth clean is the interesting case, and any scalar — a mean, a max, a count of sides touched —
   * reports it as the same thing as a picture that leaves all four alone or none. The margin problem
   * that made this field necessary was exactly that asymmetry, and a fused number could not have
   * shown it.
   */
  edgeContact: { top: number; right: number; bottom: number; left: number };
  /**
   * Area share of each connected opaque region of the sheet, largest first. Four-connected, so two
   * areas meeting at a corner are two. Regions below 0.0005 of the sheet are not listed and the
   * list stops at 64 entries; both are storage floors, not the definition of a region — a
   * constraint sets its own floor with `minArea`.
   *
   * This is what a position asks when it wants "four opaque areas", and it is deliberately not a
   * count of `solid` nodes. Four solid marks that overlap into one blot are one region here; three
   * that a covering cuts in half are four. The tree cannot tell those apart and this can.
   */
  opaqueRegions: number[];
  /** The pixel hash the metrics were taken over, so a report can say which image it means. */
  pixelHash: string;
}
