// The lens, and the baseline that is the only reason to trust it.
//
// No towers and no network: `embed` is injected, so the query vector is whatever this file decides
// it is, and the corpus is 200 hand-made rows. That is the point — a test that used real CLIP would
// be testing CLIP. What is under test is the arithmetic that turns a ranking into a claim: the
// percentile, the z, and the refusal to call a set "picked out" when it is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lens, lensText, meanDirection, Z_FLOOR } from '../lens.js';
import type { CorpusEmbeddings } from '../clip-index.js';
import type { Resolved, ResolvedWork } from '../influences.js';

const DIM = 8;

function unit(v: number[]): Float32Array {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / n));
}

/**
 * A corpus of `n` works spread along one axis, bunched at the far end from the query.
 *
 * Work `i` sits at cosine exactly `(i / (n-1)) ** 4` from `AXIS`, so the ranking is monotone and
 * every percentile is checkable by hand. The fourth power is not decoration: a corpus spread
 * *uniformly* has an sd of about 0.29 of its range, and the top decile of a uniform distribution
 * sits only ~1.65 sd above its mean — so no set at all could clear a 2 sd floor and the test would
 * be asserting a thing that cannot happen. Real text-image cosines are bunched, which is exactly
 * why a z of 2 means something over them.
 */
function corpusOf(n: number): CorpusEmbeddings {
  const rows = new Float32Array(n * DIM);
  const entries: CorpusEmbeddings['entries'] = [];
  for (let i = 0; i < n; i++) {
    const c = (i / (n - 1)) ** 4;
    rows.set(unit([c, Math.sqrt(1 - c * c), 0, 0, 0, 0, 0, 0]), i * DIM);
    entries.push({ sha256: sha(i), row: i, aliases: [], work: { id: `w${i}` } as never });
  }
  return { entries, rows, rowsInFile: n, duplicates: 0, zeroRows: 0 };
}

const sha = (i: number): string => `sha${String(i).padStart(4, '0')}`;

function work(s: string, i: number): ResolvedWork {
  return {
    sha256: s,
    id: `w${i}`,
    weight: 1,
    cosine: 0,
    via: 'test',
    museum: 'met',
    title: `Work ${i}`,
    date: '',
    classification: '',
    medium: '',
    imagePath: null,
    avoidPenalty: 1,
  };
}

function resolvedOf(shas: string[]): Resolved {
  return {
    version: 1,
    positionId: 'test-set',
    seed: 1,
    influencesHash: 'x'.repeat(64),
    works: shas.map((s, i) => work(s, i)),
    centroid: [],
    spread: 0,
    radius: 0,
    axes: [],
    stats: {} as Resolved['stats'],
    truncated: [],
    empty: [],
  };
}

/** A query pointing straight at dimension 0 — the direction the corpus is spread along. */
const AXIS = async (phrases: string[]): Promise<Float32Array[]> =>
  phrases.map(() => unit([1, 0, 0, 0, 0, 0, 0, 0]));

const CORPUS = corpusOf(200);
/** The top of the spread: works 190-199, unambiguously near the query. */
const TOP = Array.from({ length: 10 }, (_, i) => sha(190 + i));
/** A stride through the whole spread: a set that is nothing in particular to this query. */
const SPREAD = Array.from({ length: 10 }, (_, i) => sha(i * 20));

test('the ruler is the whole corpus, not a sample of it', async () => {
  const l = await lens('anything', resolvedOf(TOP), CORPUS, AXIS);
  assert.equal(l.corpus.n, 200);
  assert.ok(l.corpus.sd > 0);
});

test('a set at the top of the spread is reported as found, with its percentiles', async () => {
  const l = await lens('anything', resolvedOf(TOP), CORPUS, AXIS);
  assert.equal(l.hits.length, 10);
  assert.equal(l.nothingMeasured, false);
  assert.ok(l.z > Z_FLOOR, `z ${l.z} should clear the floor`);
  // Sorted by cosine, and every one of them in the top decile of the corpus.
  for (let i = 1; i < l.hits.length; i++) assert.ok(l.hits[i - 1]!.cosine >= l.hits[i]!.cosine);
  for (const h of l.hits) assert.ok(h.percentile >= 90, `${h.work.id} at p${h.percentile}`);
  assert.match(lensText(l), /this condition does/);
});

test('a set spread across the corpus is NOTHING MEASURED, and still prints a ranking', async () => {
  const l = await lens('anything', resolvedOf(SPREAD), CORPUS, AXIS);
  assert.equal(l.hits.length, 10);
  assert.ok(Math.abs(l.z) < Z_FLOOR, `z ${l.z} should sit inside the band`);
  assert.equal(l.nothingMeasured, true);
  const text = lensText(l);
  assert.match(text, /NOTHING MEASURED/);
  assert.match(text, /it is not evidence that the condition found them/);
  // The works are still listed. A refusal to draw a conclusion is not a refusal to show the data.
  assert.match(text, /nearest 10 of the works this artist has looked at/);
  for (const h of l.hits) assert.match(text, new RegExp(h.work.id + '\\b'));
});

test('the sentences are encoded separately and averaged, and the count is reported', async () => {
  const seen: string[][] = [];
  const l = await lens(
    'One thing happened. Then a second thing happened. Then a third.',
    resolvedOf(TOP),
    CORPUS,
    async (p) => {
      seen.push(p);
      return AXIS(p);
    }
  );
  assert.equal(l.phrases.length, 3);
  assert.deepEqual(seen, [l.phrases]);
  assert.match(lensText(l), /encoded as 3 sentences, averaged/);
});

test('a set resolved against a different corpus is skipped, not scored as zero', async () => {
  // Scoring an absent work as 0 would drag the set mean toward the corpus mean and turn a real
  // effect into nothing — the exact failure this file exists to catch.
  const l = await lens('anything', resolvedOf([...TOP, 'not-in-this-corpus']), CORPUS, AXIS);
  assert.equal(l.hits.length, 10);
  assert.equal(l.nothingMeasured, false);
});

test('a query too short for the sentence splitter is encoded whole, not dropped', async () => {
  // `sentences` drops anything under 12 characters, which is right for a worldview and wrong for a
  // query someone types. "lace" is a condition; it must not come back as "the text is empty".
  const l = await lens('lace', resolvedOf(TOP), CORPUS, AXIS);
  assert.deepEqual(l.phrases, ['lace']);
  assert.equal(l.hits.length, 10);
});

test('an empty text and a set of cancelling sentences are refused rather than scored', async () => {
  await assert.rejects(() => lens('   ', resolvedOf(TOP), CORPUS, AXIS), /nothing to encode/);
  // Two opposite directions have no mean. The zero vector would give every work cosine 0, which
  // reads as "unlike everything" rather than as "this query is not a direction".
  const opposed = async (): Promise<Float32Array[]> => [
    unit([1, 0, 0, 0, 0, 0, 0, 0]),
    unit([-1, 0, 0, 0, 0, 0, 0, 0]),
  ];
  await assert.rejects(
    () => lens('A thing. Not a thing.', resolvedOf(TOP), CORPUS, opposed),
    /no mean direction/
  );
});

test('meanDirection returns a unit vector along the mean of its inputs', () => {
  const m = meanDirection([unit([1, 0, 0, 0, 0, 0, 0, 0]), unit([0, 1, 0, 0, 0, 0, 0, 0])]);
  let n = 0;
  for (const x of m) n += x * x;
  assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-6);
  assert.ok(Math.abs((m[0] as number) - (m[1] as number)) < 1e-6);
});

test('the report says which ruler to read the numbers on', async () => {
  // A text-image cosine of 0.30 is a high one and 0.6428 is the image-image median. Printing a
  // number without its scale is how the first-place work acquires a significance nobody measured.
  const text = lensText(await lens('anything', resolvedOf(TOP), CORPUS, AXIS));
  assert.match(text, /Read the percentile, not the cosine/);
  assert.match(text, /0\.6428/);
});
