import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestMetCorpus } from '../sample-corpus.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Met ingestion excludes non-public-domain records and records without primary images', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kusama-met-filter-'));
  const rows: Record<number, unknown> = {
    1: { objectID: 1, isPublicDomain: false, primaryImageSmall: 'https://image/1.jpg', title: 'private' },
    2: { objectID: 2, isPublicDomain: true, primaryImageSmall: '', primaryImage: '', title: 'no image' },
    3: { objectID: 3, isPublicDomain: true, primaryImageSmall: 'https://image/3.jpg', title: 'eligible', objectURL: 'https://met/3' },
  };
  const fetcher: typeof fetch = async (url) => jsonResponse(rows[Number(String(url).split('/').pop())]);
  const manifest = await ingestMetCorpus({ output: dir, limit: 3, objectIds: [1, 2, 3], fetcher, requestDelayMs: 0, concurrency: 1, now: () => '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(manifest.records.map((r) => r.objectId), [3]);
  assert.equal(manifest.records[0]!.publicDomain, true);
  assert.equal(manifest.records[0]!.primaryImageUrl, 'https://image/3.jpg');
});

test('interrupted/repeated ingestion resumes from cached state without duplicates or refetches', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kusama-met-resume-'));
  let calls = 0;
  const fetcher: typeof fetch = async (url) => {
    calls++;
    const id = Number(String(url).split('/').pop());
    return jsonResponse({ objectID: id, isPublicDomain: true, primaryImageSmall: `https://image/${id}.jpg`, title: `work ${id}`, objectURL: `https://met/${id}` });
  };
  const opts = { output: dir, limit: 2, objectIds: [10, 11], fetcher, requestDelayMs: 0, concurrency: 1, now: () => '2026-01-01T00:00:00.000Z' };
  const first = await ingestMetCorpus(opts);
  const firstCalls = calls;
  const second = await ingestMetCorpus(opts);
  assert.equal(firstCalls, 2);
  assert.equal(calls, firstCalls);
  assert.deepEqual(second.records.map((r) => r.objectId), [10, 11]);
  assert.equal(new Set(second.records.map((r) => r.objectId)).size, second.records.length);
  assert.equal(first.recordsHash, second.recordsHash);
  assert.doesNotThrow(() => JSON.parse(readFileSync(path.join(dir, 'ingest-state.v1.json'), 'utf8')));
});

test('a metadata-only manifest can be upgraded to downloaded, content-hashed images', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kusama-met-download-'));
  let metadataCalls = 0;
  let imageCalls = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).startsWith('https://image/')) {
      imageCalls++;
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
    }
    metadataCalls++;
    return jsonResponse({ objectID: 20, isPublicDomain: true, primaryImageSmall: 'https://image/20.jpg', title: 'download later', objectURL: 'https://met/20' });
  };
  const common = { output: dir, limit: 1, objectIds: [20], fetcher, requestDelayMs: 0, concurrency: 1, now: () => '2026-01-01T00:00:00.000Z' };
  const metadata = await ingestMetCorpus(common);
  assert.equal(metadata.records[0]!.localImagePath, null);
  const downloaded = await ingestMetCorpus({ ...common, downloadImages: true });
  assert.equal(metadataCalls, 1, 'the cached object metadata was not requested again');
  assert.equal(imageCalls, 1);
  assert.match(downloaded.records[0]!.imageContentHash!, /^[0-9a-f]{64}$/);
  assert.equal(downloaded.records[0]!.localImagePath, `images/${downloaded.records[0]!.imageContentHash}.jpg`);
});

test('Met ingestion does not retry a permanent client error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kusama-met-permanent-error-'));
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response('not found', { status: 404 });
  };
  await assert.rejects(
    ingestMetCorpus({ output: dir, limit: 1, objectIds: [404], fetcher, requestDelayMs: 0 }),
    /answered 404/,
  );
  assert.equal(calls, 1);
});
