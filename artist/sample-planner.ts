// Artist-side intent: turn a goal into distinct source jobs, then choose without collapsing roles.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../env/canonical.js';
import {
  INFLUENCE_PRESETS,
  SAMPLE_CHANNELS,
  SAMPLE_MODES,
  SAMPLE_SCHEMA_VERSION,
  SAMPLE_TRANSFORMATIONS,
  controlsFor,
  type ArtistSampleIntent,
  type RetrievedCandidate,
  type SampleChannel,
  type SampleGoal,
  type SampleMode,
  type SampleRejection,
  type SampleRequest,
  type SamplingPlan,
  type SelectedSample,
} from '../aesthetic/sample-types.js';
import { chooseCandidate } from '../aesthetic/sample-retrieval.js';

export interface CommissionSamplingInput {
  goal?: Partial<SampleGoal>;
  subject?: string;
  percepts?: string[];
  avoid?: string[];
  requests?: SampleRequest[];
}

function id(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 20)}`;
}

/** Identity of every decision compilation consumes, including later rejection history/revisions. */
export function samplingPlanId(plan: Pick<SamplingPlan, 'schemaVersion' | 'seed' | 'indexId' | 'goal' | 'requests' | 'samples' | 'rejections'>): string {
  return id('plan', {
    schemaVersion: plan.schemaVersion,
    seed: plan.seed,
    indexId: plan.indexId,
    goal: plan.goal,
    requests: plan.requests,
    samples: plan.samples,
    ...(plan.rejections ? { rejections: plan.rejections } : {}),
  });
}

export function goalFromCommission(input: CommissionSamplingInput | string): SampleGoal {
  if (typeof input === 'string') return { subject: input, percepts: [], avoid: [] };
  const source = input.goal ?? input;
  const subject = source.subject?.trim();
  if (!subject) throw new Error('commission must state goal.subject or subject');
  return { subject, percepts: [...(source.percepts ?? [])], avoid: [...(source.avoid ?? [])] };
}

/**
 * Deterministic fallback for an unavailable policy model. It still creates separate queries and
 * jobs; a configured artist may replace these requests, but must pass validateArtistSampleRequests.
 */
export function requestsFromGoal(goal: SampleGoal): SampleRequest[] {
  const mountain = /mountain|landscape|cliff|peak/i.test(goal.subject);
  const affect = goal.percepts.join(', ') || 'the stated perceptual goal';
  const definitions = mountain ? [
    {
      role: 'scale_anchor', query: `a nearly invisible solitary human figure overwhelmed by a vast landscape; ${affect}`,
      channels: ['scale_relation', 'composition'] as const, mode: 'structural_analogy' as const,
      transformation: 'exaggerate' as const, preset: 'rupture' as const,
    },
    {
      role: 'spatial_support', query: 'severe empty space, isolation, and an off-centre occupied mass',
      channels: ['negative_space', 'composition', 'spatial_density'] as const, mode: 'reference_transfer' as const,
      transformation: 'exaggerate' as const, preset: 'dominant' as const,
    },
    {
      role: 'atmospheric_support', query: 'cold compressed values and deep nocturnal spatial recession',
      channels: ['value_structure', 'palette'] as const, mode: 'reference_transfer' as const,
      transformation: 'compress' as const, preset: 'whisper' as const,
    },
    {
      role: 'disruptive_counterpoint', query: 'violent upward directional rhythm from a non-landscape work',
      channels: ['mark_rhythm', 'gesture'] as const, mode: 'structural_analogy' as const,
      transformation: 'counterpoint' as const, preset: 'accent' as const,
    },
  ] : [
    {
      role: 'composition_anchor', query: `${goal.subject}; a decisive spatial structure that produces ${affect}`,
      channels: ['composition', 'negative_space'] as const, mode: 'reference_transfer' as const,
      transformation: 'transpose' as const, preset: 'dominant' as const,
    },
    {
      role: 'motif_support', query: `${goal.subject}; a small distinctive motif with a clear silhouette`,
      channels: ['motif', 'silhouette'] as const, mode: 'motif_adaptation' as const,
      transformation: 'fragment' as const, preset: 'accent' as const,
    },
    {
      role: 'material_support', query: 'ornament, armor, textile, or jewelry with a forceful repeated rhythm',
      channels: ['mark_rhythm', 'material_logic', 'texture'] as const, mode: 'structural_analogy' as const,
      transformation: 'transpose' as const, preset: 'dialogue' as const,
      filters: { crossMedium: true },
    },
    {
      role: 'disruptive_counterpoint', query: `a distant historical device that resists ${goal.subject}`,
      channels: ['gesture', 'gaze_or_direction'] as const, mode: 'structural_analogy' as const,
      transformation: 'counterpoint' as const, preset: 'accent' as const,
      filters: { crossPeriod: true },
    },
  ];
  return definitions.map((d, index) => {
    const preset = d.preset;
    const controls = controlsFor(preset, mountain && index === 0
      ? { salience: 0.55, scope: 0.8, abstraction: 0.95, exaggeration: 1 }
      : mountain && index === 2
        ? { salience: 0.12, scope: 0.9, abstraction: 0.9, exaggeration: -0.15 }
        : {});
    const request = {
      requestId: '', role: d.role, query: d.query, negativeQueries: goal.avoid,
      channels: [...d.channels], mode: d.mode, transformation: d.transformation,
      preset, controls, perceptualGoal: affect,
      origin: 'fallback' as const,
      ...('filters' in d ? { filters: d.filters } : {}),
    } as SampleRequest;
    request.requestId = id('request', { ...request, requestId: undefined, index });
    return request;
  });
}

function presetFor(salience: number): SampleRequest['preset'] {
  if (salience < 0.25) return 'whisper';
  if (salience < 0.47) return 'accent';
  if (salience < 0.7) return 'dialogue';
  if (salience < 0.88) return 'dominant';
  return 'rupture';
}

function modeFor(channel: SampleChannel): SampleMode {
  if (channel === 'motif' || channel === 'silhouette') return 'motif_adaptation';
  if (['scale_relation', 'composition', 'spatial_density', 'negative_space', 'gesture', 'gaze_or_direction', 'mark_rhythm'].includes(channel)) {
    return 'structural_analogy';
  }
  return 'reference_transfer';
}

/** Validate the intentionally smaller SAMPLE response before it is expanded into retrieval jobs. */
export function validateArtistSampleIntents(value: unknown): ArtistSampleIntent[] {
  if (!Array.isArray(value)) throw new Error('artist sample intents must be an array');
  if (value.length < 1 || value.length > 4) throw new Error('artist must produce one to four sample intents');
  const roles = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) throw new Error(`intent ${index} is not an object`);
    const intent = raw as ArtistSampleIntent;
    if (typeof intent.problem !== 'string' || intent.problem.trim().length < 10) throw new Error(`intent ${index} has no usable problem`);
    if (!SAMPLE_CHANNELS.includes(intent.channel)) throw new Error(`intent ${index} has invalid channel`);
    if (!SAMPLE_TRANSFORMATIONS.includes(intent.transformation)) throw new Error(`intent ${index} has invalid transformation`);
    if (!Number.isFinite(intent.salience) || intent.salience < 0 || intent.salience > 1) throw new Error(`intent ${index} salience must be in 0..1`);
    if (!Number.isFinite(intent.scope) || intent.scope < 0 || intent.scope > 1) throw new Error(`intent ${index} scope must be in 0..1`);
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(intent.bindingRole)) throw new Error(`intent ${index} has invalid bindingRole`);
    if (roles.has(intent.bindingRole)) throw new Error(`duplicate bindingRole ${intent.bindingRole}`);
    roles.add(intent.bindingRole);
  }
  return value as ArtistSampleIntent[];
}

/** Deterministically turn pre-drawing intent into the richer, stable retrieval contract. */
export function normalizeArtistSampleIntents(
  value: unknown,
  commission: CommissionSamplingInput | string,
  origin: SampleRequest['origin'] = 'artist'
): SampleRequest[] {
  const intents = validateArtistSampleIntents(value);
  const goal = goalFromCommission(commission);
  return intents.map((intent, index) => {
    const preset = presetFor(intent.salience);
    const controls = controlsFor(preset, {
      salience: intent.salience,
      scope: intent.scope,
      abstraction: 0.82,
      exaggeration: intent.transformation === 'compress' ? -0.35 : intent.transformation === 'exaggerate' ? 0.55 : 0.15,
    });
    const request: SampleRequest = {
      requestId: '',
      role: intent.bindingRole,
      query: `${intent.problem}; in relation to ${goal.subject}`,
      negativeQueries: [...goal.avoid],
      channels: [intent.channel],
      mode: modeFor(intent.channel),
      transformation: intent.transformation,
      preset,
      controls,
      perceptualGoal: intent.problem,
      origin,
    };
    request.requestId = id('request', { index, goal: goal.subject, ...request, requestId: undefined });
    return request;
  });
}

export function validateArtistSampleRequests(value: unknown): SampleRequest[] {
  if (!Array.isArray(value)) throw new Error('artist sample requests must be an array');
  if (value.length < 1 || value.length > 8) throw new Error('artist must produce one to eight sample requests');
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) throw new Error(`request ${index} is not an object`);
    const r = raw as SampleRequest;
    if (!r.requestId || ids.has(r.requestId)) throw new Error(`request ${index} has a missing or duplicate requestId`);
    ids.add(r.requestId);
    if (!r.role || !r.query || !r.perceptualGoal) throw new Error(`request ${r.requestId} is missing role, query, or perceptualGoal`);
    if (!Array.isArray(r.channels) || r.channels.length === 0 || r.channels.some((c) => !SAMPLE_CHANNELS.includes(c))) {
      throw new Error(`request ${r.requestId} has invalid channels`);
    }
    if (!SAMPLE_MODES.includes(r.mode)) throw new Error(`request ${r.requestId} has invalid mode`);
    if (!SAMPLE_TRANSFORMATIONS.includes(r.transformation)) throw new Error(`request ${r.requestId} has invalid transformation`);
    if (!INFLUENCE_PRESETS.includes(r.preset)) throw new Error(`request ${r.requestId} has invalid preset`);
    if (r.origin !== 'artist' && r.origin !== 'fallback') throw new Error(`request ${r.requestId} has invalid origin`);
    controlsFor(r.preset, r.controls);
  }
  return value as SampleRequest[];
}

export type CandidateProvider = (
  request: SampleRequest,
  excludedObjectIds: ReadonlySet<number>,
  excludedFragmentIds: ReadonlySet<string>
) => Promise<RetrievedCandidate[]>;

export async function createSamplingPlan(options: {
  goal: SampleGoal;
  requests?: SampleRequest[];
  indexId: string;
  seed: number;
  candidates: CandidateProvider;
  temperature?: number;
  artistProfile?: string;
}): Promise<SamplingPlan> {
  const requests = validateArtistSampleRequests(options.requests ?? requestsFromGoal(options.goal));
  const used = new Set<number>();
  const samples: SelectedSample[] = [];
  for (const [index, request] of requests.entries()) {
    const candidates = await options.candidates(request, used, new Set());
    const anchor = samples[0]?.fragment.provenance;
    const different = candidates.filter((candidate) => {
      const source = candidate.fragment.provenance;
      if (request.filters?.crossMedium && anchor && (source.medium ?? '').toLowerCase() === (anchor.medium ?? '').toLowerCase()) return false;
      if (request.filters?.crossPeriod && anchor) {
        const century = (value: string | null | undefined) => {
          const year = value?.match(/-?\d{3,4}/)?.[0];
          return year === undefined ? null : Math.floor(Number(year) / 100);
        };
        const a = century(anchor.date ?? anchor.period), b = century(source.date ?? source.period);
        if (a !== null && b !== null && a === b) return false;
      }
      return true;
    });
    if ((request.filters?.crossMedium || request.filters?.crossPeriod) && different.length === 0) {
      throw new Error(`${request.requestId}: cross-source requirement could not be met by the candidate pool`);
    }
    const eligible = different.length ? different : candidates;
    const chosen = chooseCandidate(eligible, options.seed, request.requestId, options.temperature ?? 0.18);
    used.add(chosen.fragment.objectId);
    const role = /counterpoint|disrupt/i.test(request.role) ? 'counterpoint' : index === 0 ? 'anchor' : 'support';
    const sampleId = id('sample', { request: request.requestId, fragment: chosen.fragment.fragmentId });
    samples.push({
      sampleId, requestId: request.requestId, role, requestedRole: request.role, fragment: chosen.fragment,
      candidates,
      borrowed: request.channels.join(', '),
      whyChosen: `rank ${chosen.rank}; hybrid ${chosen.scores.hybrid.toFixed(4)}, formal ${chosen.scores.formal.toFixed(4)}, diversity ${chosen.scores.diversity.toFixed(4)}`,
      perceptualGoal: request.perceptualGoal,
      channels: request.channels, mode: request.mode, preset: request.preset, controls: request.controls,
      transformation: request.transformation,
      intendedDifference: `${request.transformation} the measured ${request.channels.join('/')} device into ${options.goal.subject}; do not reproduce source pixels`,
      enabled: true,
    });
  }
  const body = { schemaVersion: SAMPLE_SCHEMA_VERSION, seed: options.seed, indexId: options.indexId, goal: options.goal, requests, samples };
  return {
    ...body,
    planId: samplingPlanId(body),
    createdBy: options.artistProfile ? { kind: 'artist', profile: options.artistProfile } : { kind: 'deterministic-fallback' },
  };
}

/** Replace rejected crops without excluding the rest of their source object or changing the seed stream. */
export async function reselectSamplingPlan(
  plan: SamplingPlan,
  rejection: SampleRejection,
  candidates: CandidateProvider,
  temperature = 0.18
): Promise<SamplingPlan> {
  const sampleAt = plan.samples.findIndex((sample) => sample.requestId === rejection.requestId);
  if (sampleAt < 0) throw new Error(`rejection names missing request ${rejection.requestId}`);
  const current = plan.samples[sampleAt]!;
  if (current.fragment.fragmentId !== rejection.fragmentId) {
    throw new Error(`rejection ${rejection.requestId} names ${rejection.fragmentId}, selected fragment is ${current.fragment.fragmentId}`);
  }
  const request = plan.requests.find((item) => item.requestId === rejection.requestId)!;
  const rejected = new Set((plan.rejections ?? []).filter((item) => item.requestId === request.requestId).map((item) => item.fragmentId));
  rejected.add(rejection.fragmentId);
  const usedObjects = new Set(plan.samples.filter((_, index) => index !== sampleAt).map((sample) => sample.fragment.objectId));
  const pool = await candidates(request, usedObjects, rejected);
  const chosen = chooseCandidate(pool, plan.seed, request.requestId, temperature);
  const next = JSON.parse(JSON.stringify(plan)) as SamplingPlan;
  const selected = next.samples[sampleAt]!;
  selected.sampleId = id('sample', { request: request.requestId, fragment: chosen.fragment.fragmentId });
  selected.fragment = chosen.fragment;
  selected.candidates = pool;
  selected.whyChosen = `rank ${chosen.rank}; hybrid ${chosen.scores.hybrid.toFixed(4)}, formal ${chosen.scores.formal.toFixed(4)}, diversity ${chosen.scores.diversity.toFixed(4)}`;
  next.rejections = [...(next.rejections ?? []), rejection];
  next.planId = samplingPlanId(next);
  return next;
}
