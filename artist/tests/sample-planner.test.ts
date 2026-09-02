import assert from 'node:assert/strict';
import test from 'node:test';
import { createSamplingPlan, requestsFromGoal } from '../sample-planner.js';
import { chooseCandidate, searchSamplingIndex } from '../../aesthetic/sample-retrieval.js';
import { MET_CORPUS_SCHEMA, type MetCorpusRecord } from '../../env/sample-corpus.js';
import { SAMPLE_INDEX_SCHEMA, type SamplingIndex } from '../../aesthetic/sample-index.js';
import type { CorpusFragment, FormalFeatures, RetrievedCandidate, SampleGoal } from '../../aesthetic/sample-types.js';

const features: FormalFeatures = {
  normalizedPosition: [0.5, 0.5], cropToImageAreaRatio: 1, dominantColorsLab: [[50, 0, 0]],
  luminanceMean: 0.5, luminanceVariance: 0.04, luminanceHistogram: Array(8).fill(0.125), contrast: 0.2,
  edgeDensity: 0.3, edgeOrientationHistogram: [0.1, 0.1, 0.1, 0.1, 0.2, 0.1, 0.2, 0.1],
  spatialDensity: 0.4, symmetry: 0.5, negativeSpace: 0.6, saliencyCentroid: [0.4, 0.6], dominantDirectionalFlow: 70,
};

function work(objectId: number): MetCorpusRecord {
  return { objectId, title: `Work ${objectId}`, artist: `Artist ${objectId}`, culture: objectId % 2 ? 'Japan' : 'France',
    period: '19th century', date: '1850', medium: objectId % 2 ? 'Ink' : 'Oil', dimensions: null, department: 'Paintings',
    classification: 'Painting', objectName: 'Painting', tags: ['landscape', 'figure'], objectPageUrl: `https://met/${objectId}`,
    primaryImageUrl: `https://image/${objectId}`, publicDomain: true, localImagePath: `images/${objectId}.jpg`,
    imageContentHash: String(objectId).padStart(64, '0'), ingestedAt: '2026-01-01', schemaVersion: MET_CORPUS_SCHEMA };
}

function fragment(objectId: number): CorpusFragment {
  const hash = String(objectId).padStart(64, '0');
  return { fragmentId: `fragment-${objectId}`, objectId, sourceImageHash: hash, sourceRelativePath: `images/${objectId}.jpg`,
    normalizedBounds: [0, 0, 1, 1], pixelBounds: [0, 0, 100, 100], cropScale: 1, fragmentKind: 'whole',
    embeddingId: `embedding-${objectId}`, formalFeatures: { ...features, negativeSpace: 0.2 + objectId * 0.1 },
    provenance: { source: 'met-open-access', objectId, title: `Work ${objectId}`, artist: `Artist ${objectId}`, objectPageUrl: `https://met/${objectId}`,
      primaryImageUrl: `https://image/${objectId}`, publicDomain: true, sourceImageHash: hash, sourceRelativePath: `images/${objectId}.jpg` },
    wholeFragmentId: `fragment-${objectId}`, contextFragmentId: null };
}

function index(): SamplingIndex {
  const fragments = [1, 2, 3, 4, 5].map(fragment);
  const rows = [
    1, 0, 0,
    0.96, 0.28, 0,
    0.8, 0.6, 0,
    0.2, 0.8, 0.56,
    0, 0.3, 0.954,
  ];
  return {
    header: { schemaVersion: SAMPLE_INDEX_SCHEMA, indexId: 'fixture-index', manifestHash: 'fixture',
      profile: { schemaVersion: SAMPLE_INDEX_SCHEMA, levels: [], embeddingModel: 'fixture', embeddingWeights: 'fixture', embeddingDimensions: 3 },
      profileHash: 'fixture', rows: fragments.length, dimensions: 3, fragmentsFile: 'fragments.json', embeddingsFile: 'embeddings.f32',
      sourceRoot: '.', works: [1, 2, 3, 4, 5].map(work) },
    fragments, embeddings: Float32Array.from(rows),
  };
}

const goal: SampleGoal = { subject: 'a mountain that reads as 100,000 feet tall', percepts: ['fear', 'loneliness'], avoid: ['heroic adventure'] };

test('same query, seed, index, and temperature produce the same ranked and sampled candidate', () => {
  const request = requestsFromGoal(goal)[0]!;
  const a = searchSamplingIndex(index(), Float32Array.from([1, 0, 0]), request, { topK: 5 });
  const b = searchSamplingIndex(index(), Float32Array.from([1, 0, 0]), request, { topK: 5 });
  assert.deepEqual(a, b);
  assert.equal(chooseCandidate(a, 42, request.requestId, 0.25).fragment.fragmentId,
    chooseCandidate(b, 42, request.requestId, 0.25).fragment.fragmentId);
});

test('plan selection enforces the default one-fragment-per-source diversity rule', async () => {
  const requests = requestsFromGoal(goal);
  const candidates: RetrievedCandidate[] = index().fragments.map((item, rank) => ({
    rank: rank + 1, fragment: item,
    scores: { embedding: 1 - rank * 0.05, context: 0.5, metadata: 0, formal: 0.5, channelCompatibility: 1, quality: 1, diversity: 1, hybrid: 1 - rank * 0.05 },
  }));
  const make = () => createSamplingPlan({
    goal, requests, indexId: 'fixture-index', seed: 42, temperature: 0,
    candidates: async (_request, excluded) => candidates.filter((candidate) => !excluded.has(candidate.fragment.objectId)),
  });
  const first = await make();
  const second = await make();
  assert.equal(new Set(first.samples.map((sample) => sample.fragment.objectId)).size, first.samples.length);
  assert.deepEqual(first.samples.map((sample) => sample.fragment.objectId), second.samples.map((sample) => sample.fragment.objectId));
  assert.deepEqual(first.samples.map((sample) => sample.role), ['anchor', 'support', 'support', 'counterpoint']);
});

