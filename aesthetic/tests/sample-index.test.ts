import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePng } from '../../env/png.js';
import { MET_CORPUS_SCHEMA, writeMetCorpus, type MetCorpusRecord } from '../../env/sample-corpus.js';
import { buildSamplingIndex, loadSamplingIndex, SAMPLE_INDEX_SCHEMA, type FragmentProfile } from '../sample-index.js';

function fixture(): { root: string; manifest: ReturnType<typeof writeMetCorpus> } {
  const root = mkdtempSync(path.join(tmpdir(), 'kusama-fragments-'));
  mkdirSync(path.join(root, 'images'));
  const rgba = Buffer.alloc(40 * 30 * 4);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
    const i = 4 * (y * 40 + x);
    rgba[i] = x * 6; rgba[i + 1] = y * 8; rgba[i + 2] = (x + y) * 3; rgba[i + 3] = 255;
  }
  const bytes = encodePng(rgba, 40, 30);
  const imageContentHash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(root, 'images', 'source.png'), bytes);
  const record: MetCorpusRecord = {
    objectId: 7, title: 'Synthetic source', artist: 'Fixture', culture: null, period: null, date: '1900',
    medium: 'paint', dimensions: null, department: 'Tests', classification: 'Painting', objectName: 'Painting', tags: ['mountain'],
    objectPageUrl: 'https://example.invalid/7', primaryImageUrl: 'https://example.invalid/7.png', publicDomain: true,
    localImagePath: 'images/source.png', imageContentHash, ingestedAt: '2026-01-01T00:00:00.000Z', schemaVersion: MET_CORPUS_SCHEMA,
  };
  return { root, manifest: writeMetCorpus(root, [record]) };
}

const profile: FragmentProfile = {
  schemaVersion: SAMPLE_INDEX_SCHEMA,
  levels: [{ scale: 0.7, grid: 2, kind: 'context' }, { scale: 0.4, grid: 3, kind: 'detail' }],
  embeddingModel: 'fixture', embeddingWeights: 'fixture-v1', embeddingDimensions: 3,
};

const embed = async (crop: { data: Uint8Array }): Promise<Float32Array> => {
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < crop.data.length; i += 3) { a += crop.data[i]!; b += crop.data[i + 1]!; c += crop.data[i + 2]!; }
  return Float32Array.from([a + 1, b + 1, c + 1]);
};

test('stable image bytes and crop settings produce identical ordered fragment ids', async () => {
  const { root, manifest } = fixture();
  const firstDir = path.join(root, 'index-a');
  const secondDir = path.join(root, 'index-b');
  await buildSamplingIndex({ output: firstDir, corpusRoot: root, manifest, profile, embed });
  await buildSamplingIndex({ output: secondDir, corpusRoot: root, manifest, profile, embed });
  const first = loadSamplingIndex(firstDir);
  const second = loadSamplingIndex(secondDir);
  assert.deepEqual(first.fragments.map((f) => f.fragmentId), second.fragments.map((f) => f.fragmentId));
  assert.equal(first.header.indexId, second.header.indexId);
  assert.equal(first.fragments[0]!.fragmentKind, 'whole');
  assert.ok(first.fragments.some((f) => f.fragmentKind === 'context'));
  assert.ok(first.fragments.some((f) => f.fragmentKind === 'detail' && f.contextFragmentId));
});

test('every vector row maps to exactly one fragment metadata record and mismatches are refused', async () => {
  const { root, manifest } = fixture();
  const dir = path.join(root, 'index');
  const header = await buildSamplingIndex({ output: dir, corpusRoot: root, manifest, profile, embed });
  const loaded = loadSamplingIndex(dir);
  assert.equal(header.rows, loaded.fragments.length);
  assert.equal(loaded.embeddings.length, loaded.fragments.length * profile.embeddingDimensions);
  assert.equal(new Set(loaded.fragments.map((f) => f.embeddingId)).size, loaded.fragments.length);
  writeFileSync(path.join(dir, 'embeddings.f32'), Buffer.alloc(4));
  assert.throws(() => loadSamplingIndex(dir), /matrix is .* expected/);
});

test('index construction batches missing embeddings while preserving row alignment', async () => {
  const { root, manifest } = fixture();
  const dir = path.join(root, 'index-batched');
  let batches = 0;
  let singles = 0;
  const header = await buildSamplingIndex({
    output: dir, corpusRoot: root, manifest, profile, batchSize: 4,
    embed: async (crop) => { singles++; return embed(crop); },
    embedBatch: async (crops) => { batches++; return Promise.all(crops.map((crop) => embed(crop))); },
  });
  assert.equal(header.rows, 14);
  assert.equal(batches, 4);
  assert.equal(singles, 0);
  assert.equal(loadSamplingIndex(dir).fragments.length, header.rows);
});
