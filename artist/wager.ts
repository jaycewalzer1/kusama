// Plan wagers: structured predictions of failure recorded at CHOOSE.
//
// A wager is what makes a plan falsifiable. At CHOOSE, the selected plan records its predicted
// failure — which rubrics it expects to struggle with, what observable symptoms that failure would
// have, which elements and edges are at risk. After every relevant artifact read, the wager is
// evaluated against the evidence.
//
// History is never rewritten. The original wager, every observation applied to it, the event where
// its status changed, and any subsequent decision are all preserved.
//
// Pure. No model calls, no I/O.

import { contentHash, canonicalJson } from '../env/profile.js';
import type { ArtifactRead } from './artifact-read.js';

export type WagerStatus = 'open' | 'supported' | 'falsified' | 'unresolved';

export interface PredictedFailure {
  rubricIds: string[];
  observableArtifactSymptoms: string[];
  affectedElements: string[];
  affectedEdges: string[];
}

export interface WagerObservation {
  eventSeq: number;
  timestamp: string;
  read: ArtifactRead;
  /** Which rubric findings from the read are relevant to this wager's predicted failure. */
  relevantFindings: string[];
  /** The wager status after this observation. */
  statusAfter: WagerStatus;
  reasoning: string;
}

export interface WagerDecision {
  eventSeq: number;
  kind: 'persist' | 'break_commitment' | 'branch' | 'abandon' | 'revise';
  reasoning: string;
}

export interface Wager {
  id: string;
  branchId: string;
  claim: string;
  predictedFailure: PredictedFailure;
  sacrifice: string;
  disconfirmingEvidence: string;
  status: WagerStatus;
  observations: WagerObservation[];
  decisions: WagerDecision[];
  /** The event seq where the status last changed. */
  statusChangedAt: number | null;
}

/**
 * Create a new wager from CHOOSE output.
 */
export function createWager(args: {
  id: string;
  branchId: string;
  claim: string;
  predictedFailure: PredictedFailure;
  sacrifice: string;
  disconfirmingEvidence: string;
}): Wager {
  return {
    ...args,
    status: 'open',
    observations: [],
    decisions: [],
    statusChangedAt: null,
  };
}

/**
 * Evaluate a wager against an artifact read.
 *
 * Rules:
 * - If any predicted rubric fails with adequate confidence, the wager is `supported`.
 * - If all predicted rubrics pass with adequate confidence, the wager is `falsified`.
 * - If the predicted symptoms are observed, the wager is `supported`.
 * - Otherwise, the wager remains `open`.
 *
 * A wager that has already been `falsified` or `supported` stays that way — status is monotonic
 * for a given observation sequence. Only a `WagerDecision` can trigger a response.
 */
export function evaluateWager(
  wager: Wager,
  read: ArtifactRead,
  eventSeq: number
): Wager {
  if (wager.status === 'falsified' || wager.status === 'supported') {
    // Already terminal — record the observation but don't change status.
    return {
      ...wager,
      observations: [
        ...wager.observations,
        {
          eventSeq,
          timestamp: new Date().toISOString(),
          read,
          relevantFindings: findRelevantFindings(wager, read),
          statusAfter: wager.status,
          reasoning: 'wager already resolved',
        },
      ],
    };
  }

  const relevant = findRelevantFindings(wager, read);
  const failingRelevant = read.rubricFindings.filter(
    (f) => relevant.includes(f.rubricId) && f.state === 'fail' && f.confidence >= 0.6
  );
  const passingRelevant = read.rubricFindings.filter(
    (f) => relevant.includes(f.rubricId) && f.state === 'pass' && f.confidence >= 0.6
  );
  const uncertainRelevant = read.rubricFindings.filter(
    (f) => relevant.includes(f.rubricId) && f.state === 'uncertain'
  );

  // Check for observable symptoms in the description and observations.
  const symptomMatches = wager.predictedFailure.observableArtifactSymptoms.filter(
    (symptom) =>
      read.description.toLowerCase().includes(symptom.toLowerCase()) ||
      read.salientObservations.some((obs) =>
        obs.toLowerCase().includes(symptom.toLowerCase())
      )
  );

  let newStatus: WagerStatus = wager.status;
  let reasoning = '';

  if (failingRelevant.length > 0 || symptomMatches.length > 0) {
    newStatus = 'supported';
    reasoning = failingRelevant.length > 0
      ? `predicted rubric failure observed: ${failingRelevant.map((f) => f.rubricId).join(', ')}`
      : `predicted symptoms observed: ${symptomMatches.join(', ')}`;
  } else if (
    relevant.length > 0 &&
    passingRelevant.length === relevant.length &&
    uncertainRelevant.length === 0
  ) {
    newStatus = 'falsified';
    reasoning = `all predicted rubrics pass: ${passingRelevant.map((f) => f.rubricId).join(', ')}`;
  }

  return {
    ...wager,
    status: newStatus,
    statusChangedAt: newStatus !== wager.status ? eventSeq : wager.statusChangedAt,
    observations: [
      ...wager.observations,
      {
        eventSeq,
        timestamp: new Date().toISOString(),
        read,
        relevantFindings: relevant,
        statusAfter: newStatus,
        reasoning: reasoning || 'no conclusive evidence',
      },
    ],
  };
}

/**
 * Record a decision on a wager.
 */
export function recordWagerDecision(
  wager: Wager,
  decision: WagerDecision
): Wager {
  return {
    ...wager,
    decisions: [...wager.decisions, decision],
  };
}

function findRelevantFindings(wager: Wager, read: ArtifactRead): string[] {
  const predicted = new Set(wager.predictedFailure.rubricIds);
  return read.rubricFindings
    .filter((f) => predicted.has(f.rubricId))
    .map((f) => f.rubricId);
}

/**
 * Hash a wager for identity tracking.
 */
export function wagerHash(wager: Wager): string {
  return contentHash(
    canonicalJson({
      id: wager.id,
      claim: wager.claim,
      predictedFailure: wager.predictedFailure,
    })
  ).slice(0, 12);
}
