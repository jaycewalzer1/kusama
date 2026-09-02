// Hybrid fragment retrieval: semantic similarity plus formal fit, metadata, MMR and seeded choice.

import type { MetCorpusRecord } from '../env/sample-corpus.js';
import type {
  RetrievedCandidate,
  RetrievalScores,
  SampleChannel,
  SampleFilters,
  SampleRequest,
} from './sample-types.js';
import type { SamplingIndex } from './sample-index.js';

function seeded(seed: number, label: string): () => number {
  let x = 0x811c9dc5 ^ (seed | 0);
  for (let i = 0; i < label.length; i++) {
    x ^= label.charCodeAt(i);
    x = Math.imul(x, 0x01000193);
  }
  x = x || 0x9e3779b9;
  const next = () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
  for (let i = 0; i < 6; i++) next();
  return next;
}

export interface SearchOptions {
  topK?: number;
  candidatePool?: number;
  mmrLambda?: number;
  excludeObjectIds?: Set<number>;
  excludeFragmentIds?: Set<string>;
  negativeEmbeddings?: Float32Array[];
}

const SUPPORTED = new Set<SampleChannel>([
  'composition', 'scale_relation', 'spatial_density', 'negative_space', 'silhouette', 'motif',
  'gesture', 'gaze_or_direction', 'occlusion', 'palette', 'value_structure', 'edge_language',
  'mark_rhythm', 'texture',
]);

function dot(matrix: Float32Array, row: number, query: Float32Array, dim: number): number {
  let score = 0;
  const offset = row * dim;
  for (let i = 0; i < dim; i++) score += matrix[offset + i]! * query[i]!;
  return score;
}

function rowDot(matrix: Float32Array, a: number, b: number, dim: number): number {
  let score = 0;
  const ao = a * dim, bo = b * dim;
  for (let i = 0; i < dim; i++) score += matrix[ao + i]! * matrix[bo + i]!;
  return score;
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2) ?? []);
}

function metadataScore(query: string, work: MetCorpusRecord): number {
  const q = words(query);
  if (q.size === 0) return 0;
  const text = words([
    work.title, work.artist, work.culture, work.period, work.date, work.medium, work.department,
    work.classification, work.objectName, ...work.tags,
  ].filter(Boolean).join(' '));
  let overlap = 0;
  for (const term of q) if (text.has(term)) overlap++;
  return overlap / q.size;
}

function formalScore(channels: readonly SampleChannel[], f: SamplingIndex['fragments'][number]['formalFeatures']): number {
  if (channels.length === 0) return 0;
  const scores = channels.map((channel) => {
    switch (channel) {
      case 'negative_space': return f.negativeSpace;
      case 'spatial_density': return f.spatialDensity;
      case 'scale_relation': return Math.max(0, 1 - Math.sqrt(f.cropToImageAreaRatio));
      case 'composition': return 0.45 + 0.55 * Math.hypot(f.saliencyCentroid[0] - 0.5, f.saliencyCentroid[1] - 0.5) / Math.SQRT1_2;
      case 'palette': return Math.min(1, f.dominantColorsLab.length / 5);
      case 'value_structure': return Math.min(1, f.contrast * 3.5);
      case 'mark_rhythm': case 'gesture': case 'gaze_or_direction': return Math.max(...f.edgeOrientationHistogram);
      case 'edge_language': case 'texture': return f.edgeDensity;
      case 'silhouette': case 'motif': case 'occlusion': return Math.min(1, 0.5 * f.edgeDensity + 0.5 * f.contrast * 3);
      default: return 0;
    }
  });
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function compatible(channels: readonly SampleChannel[]): number {
  return channels.filter((c) => SUPPORTED.has(c)).length / Math.max(1, channels.length);
}

function quality(f: SamplingIndex['fragments'][number]['formalFeatures']): number {
  const exposure = 1 - Math.min(1, Math.abs(f.luminanceMean - 0.5) * 1.6);
  return Math.max(0, Math.min(1, 0.35 + 0.35 * exposure + 0.3 * Math.min(1, f.contrast * 4)));
}

function contains(haystack: string | null, needles?: string[]): boolean {
  if (!needles?.length) return true;
  const text = (haystack ?? '').toLowerCase();
  return needles.some((needle) => text.includes(needle.toLowerCase()));
}

function allowed(work: MetCorpusRecord, filters?: SampleFilters): boolean {
  if (!filters) return true;
  if (!contains(work.department, filters.department)) return false;
  if (!contains(work.culture, filters.culture)) return false;
  if (!contains(work.medium, filters.medium)) return false;
  if (!contains(work.artist, filters.artist)) return false;
  if (!contains(work.classification, filters.classification)) return false;
  if (filters.date) {
    const years = (work.date ?? '').match(/-?\d{3,4}/g)?.map(Number) ?? [];
    if (!years.some((year) => year >= filters.date![0] && year <= filters.date![1])) return false;
  }
  return true;
}

/** Ranked inspection results. MMR changes rank, never the recorded component scores. */
export function searchSamplingIndex(
  index: SamplingIndex,
  queryEmbedding: Float32Array | null,
  request: SampleRequest,
  options: SearchOptions = {},
): RetrievedCandidate[] {
  const dim = index.header.dimensions;
  if (queryEmbedding && queryEmbedding.length !== dim) throw new Error(`query has ${queryEmbedding.length} dimensions, index has ${dim}`);
  const works = new Map(index.header.works.map((work) => [work.objectId, work]));
  const rowOf = new Map(index.fragments.map((fragment, row) => [fragment.fragmentId, row]));
  const exclude = options.excludeObjectIds ?? new Set<number>();
  const excludeFragments = options.excludeFragmentIds ?? new Set<string>();
  const scored: { row: number; scores: RetrievalScores }[] = [];
  for (let row = 0; row < index.fragments.length; row++) {
    const fragment = index.fragments[row]!;
    const work = works.get(fragment.objectId);
    if (!work || exclude.has(work.objectId) || excludeFragments.has(fragment.fragmentId) || !allowed(work, request.filters)) continue;
    const embedding = queryEmbedding ? dot(index.embeddings, row, queryEmbedding, dim) : 0;
    const contextRow = rowOf.get(fragment.contextFragmentId ?? fragment.wholeFragmentId);
    const context = queryEmbedding && contextRow !== undefined ? dot(index.embeddings, contextRow, queryEmbedding, dim) : embedding;
    let negative = 0;
    for (const vector of options.negativeEmbeddings ?? []) negative = Math.max(negative, dot(index.embeddings, row, vector, dim));
    const metadata = metadataScore(request.query, work);
    const formal = formalScore(request.channels, fragment.formalFeatures);
    const channelCompatibility = compatible(request.channels);
    const imageQuality = quality(fragment.formalFeatures);
    const hybrid = 0.52 * embedding + 0.1 * context + 0.1 * metadata + 0.16 * formal +
      0.06 * channelCompatibility + 0.06 * imageQuality - 0.18 * Math.max(0, negative);
    scored.push({ row, scores: { embedding, context, metadata, formal, channelCompatibility, quality: imageQuality, diversity: 1, hybrid } });
  }
  scored.sort((a, b) => b.scores.hybrid - a.scores.hybrid || index.fragments[a.row]!.fragmentId.localeCompare(index.fragments[b.row]!.fragmentId));
  const pool = scored.slice(0, options.candidatePool ?? Math.max(40, (options.topK ?? 12) * 5));
  const selected: typeof pool = [];
  const lambda = options.mmrLambda ?? 0.76;
  while (pool.length && selected.length < (options.topK ?? 12)) {
    let bestAt = 0;
    let best = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      let redundancy = 0;
      for (const prior of selected) {
        const sameSource = index.fragments[candidate.row]!.objectId === index.fragments[prior.row]!.objectId;
        redundancy = Math.max(redundancy, sameSource ? 1 : Math.max(0, rowDot(index.embeddings, candidate.row, prior.row, dim)));
      }
      const mmr = lambda * candidate.scores.hybrid - (1 - lambda) * redundancy;
      if (mmr > best || (mmr === best && index.fragments[candidate.row]!.fragmentId < index.fragments[pool[bestAt]!.row]!.fragmentId)) {
        best = mmr; bestAt = i;
      }
    }
    const [picked] = pool.splice(bestAt, 1);
    picked!.scores.diversity = selected.length === 0 ? 1 : Math.max(0, Math.min(1, 1 - (picked!.scores.hybrid * lambda - best) / (1 - lambda)));
    selected.push(picked!);
  }
  return selected.map((item, rank) => ({ rank: rank + 1, fragment: index.fragments[item.row]!, scores: item.scores }));
}

/** Seeded softmax draw from a candidate pool. Temperature 0 is the deterministic top hit. */
export function chooseCandidate(candidates: readonly RetrievedCandidate[], seed: number, stream: string, temperature = 0.18): RetrievedCandidate {
  if (candidates.length === 0) throw new Error(`no candidates for ${stream}`);
  if (temperature <= 0) return candidates[0]!;
  const max = Math.max(...candidates.map((c) => c.scores.hybrid));
  const weights = candidates.map((c) => Math.exp((c.scores.hybrid - max) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let draw = seeded(seed, stream)() * total;
  for (let i = 0; i < candidates.length; i++) {
    draw -= weights[i]!;
    if (draw <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}
