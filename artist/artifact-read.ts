// Structured artifact reads.
//
// The reader stays blind: plate + minimal rubric wording only. No plan, artist, brief, symbolism,
// corpus, or prior reasoning. What changes is the output shape: structured findings replace
// substring matching on the description.
//
// Hard decisions use `rubricFindings`, not substring matching on the description.
// `uncertain` never promotes to pass.
//
// Pure data types. No model calls.

/**
 * A concept the reader identifies in the artifact.
 */
export interface ConceptCandidate {
  label: string;
  confidence: number;
  evidence?: string;
}

/**
 * A finding on a specific rubric.
 *
 * `uncertain` is a complete answer — it means the image does not settle it.
 * `unread` means the rubric was never evaluated.
 * Neither promotes to `pass`.
 */
export interface RubricFinding {
  rubricId: string;
  state: 'pass' | 'fail' | 'uncertain' | 'unread';
  confidence: number;
  evidence: string;
}

/**
 * A structured read of an artifact by a blind reader.
 *
 * The reader sees only the plate and minimal rubric wording. It never sees the plan, the artist's
 * identity, the brief, symbolism, corpus references, or prior reasoning.
 */
export interface ArtifactRead {
  description: string;
  conceptCandidates: ConceptCandidate[];
  rubricFindings: RubricFinding[];
  salientObservations: string[];
  /** The raw model output, preserved alongside the normalized result. */
  rawOutput?: string;
}

/**
 * Build an ArtifactRead from the existing blind reader outputs.
 *
 * This bridges the current `describe` / `readRubric` system to the structured ArtifactRead type.
 * The description and rubric answers are already produced by blind readers; this function
 * normalizes them into the unified shape.
 */
export function buildArtifactRead(args: {
  description: string;
  rubrics: { id: string; verdict: string; evidence: string }[];
  concepts?: ConceptCandidate[];
  observations?: string[];
  rawOutput?: string;
}): ArtifactRead {
  return {
    description: args.description,
    conceptCandidates: args.concepts ?? [],
    rubricFindings: args.rubrics.map((r) => ({
      rubricId: r.id,
      state: normalizeVerdict(r.verdict),
      confidence: r.verdict === 'holds' || r.verdict === 'fails' ? 0.8 : 0.4,
      evidence: r.evidence,
    })),
    salientObservations: args.observations ?? [],
    rawOutput: args.rawOutput,
  };
}

function normalizeVerdict(
  verdict: string
): 'pass' | 'fail' | 'uncertain' | 'unread' {
  switch (verdict) {
    case 'holds':
      return 'pass';
    case 'fails':
      return 'fail';
    case 'cannot-tell':
      return 'uncertain';
    default:
      return 'unread';
  }
}

/**
 * Whether a rubric finding blocks completion.
 *
 * `pass` does not block. Everything else does: `fail`, `uncertain`, `unread`, and missing
 * evidence are all non-passes. `uncertain` never promotes to pass.
 */
export function rubricBlocks(finding: RubricFinding): boolean {
  return finding.state !== 'pass';
}

/**
 * Whether any hard rubric finding blocks completion.
 */
export function anyHardRubricBlocks(
  findings: RubricFinding[],
  hardRubricIds: Set<string>
): boolean {
  // Missing hard rubrics also block — a rubric that was never evaluated is not a pass.
  for (const id of hardRubricIds) {
    const finding = findings.find((f) => f.rubricId === id);
    if (!finding || rubricBlocks(finding)) return true;
  }
  return false;
}
