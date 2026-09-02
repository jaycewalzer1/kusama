// SAMPLE: declare borrowing jobs before drawing, retrieve deterministically, and let the artist
// reject crops for stated reasons. Source pixels never enter a policy call in this phase.

import { callPolicy, type Spend } from '../call.js';
import { samplingFeedbackObservation, samplingIntentObservation } from '../sampling-observation.js';
import { artistLayers, type Commission } from '../field.js';
import { embedText } from '../clip-text.js';
import { loadSamplingIndex, type SamplingIndex } from '../../aesthetic/sample-index.js';
import { searchSamplingIndex } from '../../aesthetic/sample-retrieval.js';
import {
  SAMPLE_CHANNELS,
  SAMPLE_TRANSFORMATIONS,
  type ArtistSampleIntent,
  type SampleGoal,
  type SampleRejection,
  type SamplingPlan,
} from '../../aesthetic/sample-types.js';
import {
  createSamplingPlan,
  normalizeArtistSampleIntents,
  requestsFromGoal,
  reselectSamplingPlan,
  type CandidateProvider,
} from '../sample-planner.js';
import { PolicyError, type Policy } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Problem } from '../types.js';

const SYSTEM = [
  'You are deciding whether and how to borrow before you draw.',
  'Each intent must answer a visual problem you already named. Borrow a measurable relation, not a',
  'subject or a recognizable look. Give each intent a binding role you will be able to point to in',
  'your own program later. One strong need is better than four decorative references.',
].join('\n');

const FEEDBACK_SYSTEM = [
  'You declared borrowing intents and have now received one text-only retrieval for each.',
  'Reject at most two crops, only when the measured formal evidence does not answer the stated',
  'problem. Give a concrete reason. Do not reject a work merely because its title or culture is not',
  'what you expected; you asked for a formal device, not an identity.',
].join('\n');

export const SAMPLE_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intents'],
  properties: {
    intents: {
      type: 'array', minItems: 1, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        required: ['problem', 'channel', 'transformation', 'salience', 'scope', 'bindingRole'],
        properties: {
          problem: { type: 'string', minLength: 10 },
          channel: { enum: [...SAMPLE_CHANNELS] },
          transformation: { enum: [...SAMPLE_TRANSFORMATIONS] },
          salience: { type: 'number', minimum: 0, maximum: 1 },
          scope: { type: 'number', minimum: 0, maximum: 1 },
          bindingRole: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,40}$' },
        },
      },
    },
  },
} as const;

const REJECTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rejections'],
  properties: {
    rejections: {
      type: 'array', maxItems: 2,
      items: {
        type: 'object', additionalProperties: false,
        required: ['requestId', 'fragmentId', 'reason'],
        properties: {
          requestId: { type: 'string' }, fragmentId: { type: 'string' },
          reason: { type: 'string', minLength: 10 },
        },
      },
    },
  },
} as const;

export interface SamplePhaseOptions {
  indexDir?: string;
  /** Ordered sample_selected payloads from a prior log. Suppresses every index access. */
  recordedPlans?: SamplingPlan[];
}

export interface SamplePhaseResult {
  intents: ArtistSampleIntent[];
  plan: SamplingPlan;
  feedback: string;
  fallback: boolean;
}

function goalOf(commission: Commission, problems: Problem[]): SampleGoal {
  return {
    subject: `${commission.brief.title}: ${commission.brief.occasion}`,
    percepts: problems.map((problem) => problem.text),
    avoid: [...commission.positionAsWritten.cliches, ...commission.practice.refusals],
  };
}

function fallbackIntents(goal: SampleGoal): ArtistSampleIntent[] {
  return requestsFromGoal(goal).slice(0, 4).map((request) => ({
    problem: request.perceptualGoal,
    channel: request.channels[0]!,
    transformation: request.transformation,
    salience: request.controls.salience,
    scope: request.controls.scope,
    bindingRole: request.role,
  }));
}

function sampleObservation(commission: Commission, problems: Problem[]): string {
  return samplingIntentObservation(artistLayers(commission), problems);
}

function relevantFormal(channel: string, f: SamplingPlan['samples'][number]['fragment']['formalFeatures']): string {
  const values: Record<string, unknown> = {
    composition: { saliencyCentroid: f.saliencyCentroid, symmetry: f.symmetry },
    scale_relation: { cropToImageAreaRatio: f.cropToImageAreaRatio, negativeSpace: f.negativeSpace },
    spatial_density: { spatialDensity: f.spatialDensity, edgeDensity: f.edgeDensity },
    negative_space: { negativeSpace: f.negativeSpace },
    silhouette: { edgeDensity: f.edgeDensity, contrast: f.contrast },
    palette: { dominantColorsLab: f.dominantColorsLab },
    value_structure: { luminanceMean: f.luminanceMean, contrast: f.contrast, luminanceHistogram: f.luminanceHistogram },
    edge_language: { edgeDensity: f.edgeDensity, edgeOrientationHistogram: f.edgeOrientationHistogram },
    mark_rhythm: { dominantDirectionalFlow: f.dominantDirectionalFlow, edgeOrientationHistogram: f.edgeOrientationHistogram },
    gesture: { dominantDirectionalFlow: f.dominantDirectionalFlow },
    gaze_or_direction: { dominantDirectionalFlow: f.dominantDirectionalFlow },
    texture: { edgeDensity: f.edgeDensity, luminanceVariance: f.luminanceVariance },
    motif: { edgeDensity: f.edgeDensity, symmetry: f.symmetry },
  };
  return JSON.stringify(values[channel] ?? { edgeDensity: f.edgeDensity, contrast: f.contrast });
}

/** Compact text only: no image bytes and no embeddings. */
export function selectionFeedback(plan: SamplingPlan): string {
  return plan.samples.map((sample) => {
    const p = sample.fragment.provenance;
    return [
      `[${sample.requestId}] fragment ${sample.fragment.fragmentId}`,
      `source: ${p.title}; date: ${p.date ?? 'unknown'}; medium: ${p.medium ?? 'unknown'}; culture: ${p.culture ?? 'unknown'}`,
      `channel: ${sample.channels[0]}; formal: ${relevantFormal(sample.channels[0]!, sample.fragment.formalFeatures)}`,
      `crop normalized: ${sample.fragment.normalizedBounds.join(', ')}; pixels: ${sample.fragment.pixelBounds.join(', ')}`,
    ].join('\n');
  }).join('\n\n');
}

async function provider(index: SamplingIndex, requests: SamplingPlan['requests']): Promise<CandidateProvider> {
  const rows = await embedText(requests.flatMap((request) => [request.query, ...(request.negativeQueries ?? [])]));
  let at = 0;
  const vectors = new Map<string, { query: Float32Array; negative: Float32Array[] }>();
  for (const request of requests) {
    const query = rows[at++]!;
    vectors.set(request.requestId, { query, negative: (request.negativeQueries ?? []).map(() => rows[at++]!) });
  }
  return async (request, excludedObjects, excludedFragments) => {
    const vector = vectors.get(request.requestId)!;
    return searchSamplingIndex(index, vector.query, request, {
      topK: 10,
      candidatePool: 60,
      excludeObjectIds: new Set(excludedObjects),
      excludeFragmentIds: new Set(excludedFragments),
      negativeEmbeddings: vector.negative,
    });
  };
}

export async function sample(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  problems: Problem[],
  seed: number,
  options: SamplePhaseOptions
): Promise<SamplePhaseResult> {
  log.append('phase', { phase: 'sample' });
  const goal = goalOf(commission, problems);
  let intents: ArtistSampleIntent[];
  let fallback = false;
  try {
    const result = await callPolicy<{ intents: ArtistSampleIntent[] }>(policy, log, spend, {
      name: 'sample', system: SYSTEM, observation: sampleObservation(commission, problems),
      schema: SAMPLE_INTENT_SCHEMA, maxTokens: 3000,
    });
    intents = result.action.intents;
  } catch (error) {
    if (!(error instanceof PolicyError) || error.kind !== 'schema') throw error;
    fallback = true;
    intents = fallbackIntents(goal);
  }
  const requests = normalizeArtistSampleIntents(intents, goal, fallback ? 'fallback' : 'artist');
  log.append('sample_requested', { intents, fallback });

  const replayPlans = [...(options.recordedPlans ?? [])];
  let candidateProvider: CandidateProvider | null = null;
  let plan: SamplingPlan;
  if (replayPlans.length > 0) {
    plan = replayPlans.shift()!;
  } else {
    if (!options.indexDir) throw new Error('sampling is enabled but no sampling index was supplied');
    const index = loadSamplingIndex(options.indexDir);
    candidateProvider = await provider(index, requests);
    plan = await createSamplingPlan({
      goal, requests, indexId: index.header.indexId, seed, candidates: candidateProvider,
      ...(fallback ? {} : { artistProfile: policy.model }),
    });
    plan.fallback = fallback;
  }
  log.append('sample_selected', { plan });

  const feedback = selectionFeedback(plan);
  const response = await callPolicy<{ rejections: SampleRejection[] }>(policy, log, spend, {
    name: 'sample_feedback', system: FEEDBACK_SYSTEM,
    observation: samplingFeedbackObservation(feedback),
    schema: REJECTION_SCHEMA, maxTokens: 1800,
  });
  for (const rejection of response.action.rejections) {
    log.append('sample_rejected', rejection);
    if (replayPlans.length > 0) {
      const recorded = replayPlans.shift()!;
      const last = recorded.rejections?.[recorded.rejections.length - 1];
      if (!last || last.requestId !== rejection.requestId || last.fragmentId !== rejection.fragmentId || last.reason !== rejection.reason) {
        throw new Error('recorded sampling plan does not match the replayed rejection');
      }
      plan = recorded;
    } else {
      plan = await reselectSamplingPlan(plan, rejection, candidateProvider!, 0.18);
    }
    log.append('sample_selected', { plan });
  }
  if (replayPlans.length > 0) throw new Error(`replay carried ${replayPlans.length} unused sampling plan(s)`);
  return { intents, plan, feedback: selectionFeedback(plan), fallback };
}
