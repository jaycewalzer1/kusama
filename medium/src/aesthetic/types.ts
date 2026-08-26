// The aesthetic program: the unit the environment searches over.
//
// Five parts. Two of them (worldview, tensions) are prose the artist model reads and nothing in this
// repo ever checks. Three of them carry constraints, and a constraint's `scope` says who can decide
// it: the tree alone, the deterministic PNG, or a judge that does not exist yet.
//
// These types mirror spec/aesthetic-program.schema.json exactly. The schema is the gate; these are
// what the checker reads after the gate has passed.

export type Scope = 'tree' | 'render' | 'judge';
export type Severity = 'hard' | 'soft';

export type OpName = 'wash' | 'paint' | 'stroke' | 'fragment' | 'text' | 'rule' | 'cover';
export type MacroName = 'frame' | 'motif' | 'quarantine';
export type StyleKind = 'wash' | 'hatch' | 'field' | 'outline' | 'solid';

/** The closed set. Fifteen, and it stays fifteen: a sixteenth costs one of these. */
export type ConstraintKind =
  | 'maxDistinctColors'
  | 'palette'
  | 'forbidNode'
  | 'requireNode'
  | 'nodeCount'
  | 'textCase'
  | 'textMaxWords'
  | 'textRequired'
  | 'maxRepeatDepth'
  | 'forbidMark'
  | 'requireMark'
  | 'inkDensityRange'
  | 'symmetryMax'
  | 'coverageRange'
  | 'rubric';

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
 * RGBA and cached; see src/aesthetic/measure.ts. Deliberately three numbers and not a feature vector
 * — a render-scope constraint that needs more than this is a judge-scope constraint wearing a hat.
 */
export interface RenderMetrics {
  /** Fraction of pixels that are not the ground colour. */
  inkDensity: number;
  /** Fraction of a fixed 16x16 grid of cells that contain any ink at all. */
  coverage: number;
  /** Ink-mask agreement with its own mirror, as intersection over union. 0 when there is no ink. */
  symmetry: { vertical: number; horizontal: number };
  /** The pixel hash the metrics were taken over, so a report can say which image it means. */
  pixelHash: string;
}
