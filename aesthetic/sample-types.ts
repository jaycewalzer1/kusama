// The typed language between retrieval and the artist, and between the artist and compilation.
// No renderer type appears here: samples are decisions, never executable pixels.

import type { MetCorpusRecord } from '../env/sample-corpus.js';

export const SAMPLE_SCHEMA_VERSION = 'kusama.sampling.v1' as const;

export const SAMPLE_CHANNELS = [
  'composition', 'scale_relation', 'spatial_density', 'negative_space', 'silhouette', 'motif',
  'gesture', 'gaze_or_direction', 'occlusion', 'palette', 'value_structure', 'edge_language',
  'mark_rhythm', 'texture', 'symbolic_role', 'material_logic',
] as const;
export type SampleChannel = (typeof SAMPLE_CHANNELS)[number];

export const SAMPLE_TRANSFORMATIONS = [
  'echo', 'transpose', 'invert', 'compress', 'exaggerate', 'fragment', 'hybridize', 'counterpoint',
] as const;
export type SampleTransformation = (typeof SAMPLE_TRANSFORMATIONS)[number];

export const SAMPLE_MODES = [
  'reference_transfer', 'structural_analogy', 'motif_adaptation', 'literal_fragment',
] as const;
export type SampleMode = (typeof SAMPLE_MODES)[number];

export const INFLUENCE_PRESETS = ['whisper', 'accent', 'dialogue', 'dominant', 'rupture'] as const;
export type InfluencePreset = (typeof INFLUENCE_PRESETS)[number];

export interface InfluenceControls {
  salience: number;
  scope: number;
  abstraction: number;
  exaggeration: number;
}

/** Numeric defaults, not prose aliases. Explicit controls override each field independently. */
export const PRESET_CONTROLS: Readonly<Record<InfluencePreset, InfluenceControls>> = {
  whisper: { salience: 0.12, scope: 0.28, abstraction: 0.88, exaggeration: -0.2 },
  accent: { salience: 0.38, scope: 0.3, abstraction: 0.62, exaggeration: 0.15 },
  dialogue: { salience: 0.55, scope: 0.58, abstraction: 0.72, exaggeration: 0.2 },
  dominant: { salience: 0.82, scope: 0.9, abstraction: 0.7, exaggeration: 0.42 },
  rupture: { salience: 0.92, scope: 0.78, abstraction: 0.96, exaggeration: 1 },
};

export function controlsFor(preset: InfluencePreset, overrides: Partial<InfluenceControls> = {}): InfluenceControls {
  const out = { ...PRESET_CONTROLS[preset], ...overrides };
  for (const key of ['salience', 'scope', 'abstraction'] as const) {
    if (!Number.isFinite(out[key]) || out[key] < 0 || out[key] > 1) throw new Error(`${key} must be in 0..1`);
  }
  if (!Number.isFinite(out.exaggeration) || out.exaggeration < -1 || out.exaggeration > 1) {
    throw new Error('exaggeration must be in -1..1');
  }
  return out;
}

export interface FormalFeatures {
  normalizedPosition: [number, number];
  cropToImageAreaRatio: number;
  /** Up to five CIELAB triples, most common first. */
  dominantColorsLab: [number, number, number][];
  luminanceMean: number;
  luminanceVariance: number;
  luminanceHistogram: number[];
  contrast: number;
  edgeDensity: number;
  edgeOrientationHistogram: number[];
  spatialDensity: number;
  symmetry: number;
  negativeSpace: number;
  saliencyCentroid: [number, number];
  /** Degrees, 0 horizontal and 90 vertical. */
  dominantDirectionalFlow: number;
}

export interface Provenance {
  source: 'met-open-access';
  objectId: number;
  title: string;
  artist: string | null;
  culture?: string | null;
  period?: string | null;
  date?: string | null;
  medium?: string | null;
  department?: string | null;
  classification?: string | null;
  objectPageUrl: string;
  primaryImageUrl: string;
  publicDomain: true;
  sourceImageHash: string;
  sourceRelativePath: string;
}

export interface FragmentAnnotation {
  depictedSubjects: string[];
  depictedParts: string[];
  compositionalRoles: string[];
  relationalDevices: string[];
  affectivePossibilities: string[];
  spatialDescription?: string;
  scaleDescription?: string;
  markDescription?: string;
}

export interface CorpusFragment {
  fragmentId: string;
  objectId: number;
  sourceImageHash: string;
  sourceRelativePath: string;
  normalizedBounds: [number, number, number, number];
  pixelBounds: [number, number, number, number];
  cropScale: number;
  fragmentKind: 'whole' | 'context' | 'detail' | 'segment';
  embeddingId: string;
  formalFeatures: FormalFeatures;
  provenance: Provenance;
  wholeFragmentId: string;
  contextFragmentId: string | null;
  annotation?: FragmentAnnotation;
}

export interface SampleGoal {
  subject: string;
  percepts: string[];
  avoid: string[];
}

/** The deliberately small decision the artist makes before it has drawn anything. */
export interface ArtistSampleIntent {
  problem: string;
  channel: SampleChannel;
  transformation: SampleTransformation;
  salience: number;
  scope: number;
  bindingRole: string;
}

export interface SampleFilters {
  department?: string[];
  culture?: string[];
  date?: [number, number];
  medium?: string[];
  artist?: string[];
  classification?: string[];
  crossMedium?: boolean;
  crossPeriod?: boolean;
}

export interface SampleRequest {
  requestId: string;
  role: string;
  query: string;
  negativeQueries?: string[];
  channels: SampleChannel[];
  mode: SampleMode;
  transformation: SampleTransformation;
  preset: InfluencePreset;
  controls: InfluenceControls;
  perceptualGoal: string;
  filters?: SampleFilters;
  /** Whether this request was stated by the artist or supplied after SAMPLE failed twice. */
  origin: 'artist' | 'fallback';
}

export interface SampleRejection {
  requestId: string;
  fragmentId: string;
  reason: string;
}

export interface RetrievalScores {
  embedding: number;
  context: number;
  metadata: number;
  formal: number;
  channelCompatibility: number;
  quality: number;
  diversity: number;
  hybrid: number;
}

export interface RetrievedCandidate {
  rank: number;
  fragment: CorpusFragment;
  scores: RetrievalScores;
}

export interface SelectedSample {
  sampleId: string;
  requestId: string;
  role: 'anchor' | 'support' | 'counterpoint';
  requestedRole: string;
  fragment: CorpusFragment;
  candidates: RetrievedCandidate[];
  borrowed: string;
  whyChosen: string;
  perceptualGoal: string;
  channels: SampleChannel[];
  mode: SampleMode;
  preset: InfluencePreset;
  controls: InfluenceControls;
  transformation: SampleTransformation;
  intendedDifference: string;
  enabled: boolean;
}

export interface SamplingPlan {
  schemaVersion: typeof SAMPLE_SCHEMA_VERSION;
  planId: string;
  seed: number;
  indexId: string;
  goal: SampleGoal;
  requests: SampleRequest[];
  samples: SelectedSample[];
  createdBy: { kind: 'artist' | 'deterministic-fallback'; profile?: string };
  /** Present on artist-loop plans; omitted on older CLI plans. */
  fallback?: boolean;
  rejections?: SampleRejection[];
}

export interface CompiledInfluenceConstraint {
  constraintId: string;
  sampleId: string;
  derivedFromSampleId: string;
  channels: SampleChannel[];
  application: SampleTransformation;
  claimedEffect: string;
  scope: 'local' | 'global';
  before: unknown;
  after: unknown;
  affectedNodeIds: string[];
  magnitude: number;
  supported: boolean;
  unsupportedReason?: string;
  /** Present when this channel consumes a synthesized or declared program target. */
  resolvedBy?: 'explicit' | 'structural';
  resolvedTargetNodeIds?: string[];
}

export interface SamplingProvenanceRecord {
  commissionGoal: SampleGoal;
  request: SampleRequest;
  candidates: RetrievedCandidate[];
  chosenFragment: CorpusFragment;
  transformation: SampleTransformation;
  constraints: CompiledInfluenceConstraint[];
  affectedProgramNodes: string[];
  rejections?: SampleRejection[];
}

export interface SamplingCompilation {
  program: Record<string, unknown>;
  baseProgramHash: string;
  compiledProgramHash: string;
  constraints: CompiledInfluenceConstraint[];
  unsupported: { sampleId: string; channel: SampleChannel; reason: string }[];
  provenance: SamplingProvenanceRecord[];
  disabledSampleIds: string[];
}

export function provenanceFrom(record: MetCorpusRecord, relativePath: string, hash: string): Provenance {
  return {
    source: 'met-open-access', objectId: record.objectId, title: record.title, artist: record.artist,
    culture: record.culture, period: record.period, date: record.date, medium: record.medium,
    department: record.department, classification: record.classification,
    objectPageUrl: record.objectPageUrl, primaryImageUrl: record.primaryImageUrl, publicDomain: true,
    sourceImageHash: hash, sourceRelativePath: relativePath,
  };
}

/** Runtime guard for JSON crossing the CLI boundary. TypeScript types do not validate files. */
export function samplingPlanFaults(value: unknown): string[] {
  const faults: string[] = [];
  if (typeof value !== 'object' || value === null) return ['plan is not an object'];
  const plan = value as Partial<SamplingPlan>;
  if (plan.schemaVersion !== SAMPLE_SCHEMA_VERSION) faults.push(`schemaVersion must be ${SAMPLE_SCHEMA_VERSION}`);
  if (typeof plan.planId !== 'string' || !plan.planId) faults.push('planId must be a non-empty string');
  if (!Number.isInteger(plan.seed) || (plan.seed as number) < 0) faults.push('seed must be a non-negative integer');
  if (typeof plan.indexId !== 'string' || !plan.indexId) faults.push('indexId must be a non-empty string');
  if (!Array.isArray(plan.requests) || plan.requests.length < 1 || plan.requests.length > 8) faults.push('requests must contain one to eight entries');
  if (!Array.isArray(plan.samples) || plan.samples.length < 1 || plan.samples.length > 8) faults.push('samples must contain one to eight entries');
  const requests = new Set(plan.requests?.map((request) => request.requestId) ?? []);
  const samples = new Set<string>();
  for (const sample of plan.samples ?? []) {
    if (!sample.sampleId || samples.has(sample.sampleId)) faults.push(`missing or duplicate sampleId ${sample.sampleId ?? ''}`);
    samples.add(sample.sampleId);
    if (!requests.has(sample.requestId)) faults.push(`${sample.sampleId} refers to missing request ${sample.requestId}`);
    if (sample.fragment?.provenance?.publicDomain !== true) faults.push(`${sample.sampleId} source is not explicitly public domain`);
    try { controlsFor(sample.preset, sample.controls); } catch (error) { faults.push(`${sample.sampleId}: ${(error as Error).message}`); }
  }
  for (const request of plan.requests ?? []) {
    if (request.origin !== 'artist' && request.origin !== 'fallback') faults.push(`${request.requestId} has invalid origin`);
  }
  return faults;
}

export function assertSamplingPlan(value: unknown): asserts value is SamplingPlan {
  const faults = samplingPlanFaults(value);
  if (faults.length) throw new Error(`invalid sampling plan:\n  ${faults.join('\n  ')}`);
}
