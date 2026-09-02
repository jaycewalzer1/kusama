// Reciprocal Rank Fusion, tested on fixtures whose answer is known before it runs.
//
// Nothing here reads `corpus/`, downloads a model, or runs a forward pass. What is tested is the
// part that decides whether the printed numbers mean anything: that the fusion reads RANKS and
// never scores, that retrieving deeper than `k` is what lets a work both arms agreed on reach the
// answer, that ties break on the id hash and not on which list happened to be passed first, and
// that the verdicts flip on bands fixed in advance rather than on whatever came out.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARM_BAND,
  FUSE_DEPTH,
  RRF_K,
  fusionComparison,
  fusionComparisonText,
  rrf,
  tieKeys,
} from '../fuse.js';
import { DIM, type TextImageJoin } from '../text-embed.js';
import type { Work } from '../manifest.js';

function work(id: string, source: string, fields: Partial<Record<string, string>> = {}): Work {
  return {
    id,
    source,
    title: '',
    creator: null,
    date_display: '',
    classification: '',
    medium: '',
    culture: null,
    department: '',
    ...fields,
  } as unknown as Work;
}

function axis(a: number): Float32Array {
  const v = new Float32Array(DIM);
  v[a % DIM] = 1;
  return v;
}

function pack(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs.length * DIM);
  vs.forEach((v, i) => out.set(v, i * DIM));
  return out;
}

function fakeJoin(works: Work[], text: Float32Array[], image: Float32Array[]): TextImageJoin {
  return {
    entries: works.map((w, i) => ({ work: w, sha256: `sha-${i}`, row: i, aliases: [] })),
    imageRows: pack(image),
    textRows: { all: pack(text), object: pack(text) },
    n: works.length,
    textOnly: 0,
  };
}

const flat = (n: number) => new Float64Array(n);

test('the fusion reads ranks and cannot read a score', () => {
  const keys = flat(3);
  // Same two orderings, and no score anywhere in the call. If RRF could see a magnitude there
  // would be somewhere to pass one; there is not, and that is the entire argument for RRF here
  // over interpolating an unbounded BM25 sum with a bounded cosine.
  const a = rrf([[0, 1, 2], [2, 1, 0]], keys);
  assert.equal(a.scores.get(1), 2 / (RRF_K + 2), 'rank 2 in both, and nothing else enters the sum');
  assert.equal(a.scores.get(0), 1 / (RRF_K + 1) + 1 / (RRF_K + 3));
  assert.equal(a.scores.get(0), a.scores.get(2), 'symmetric input, symmetric score');
  // A real and slightly counter-intuitive property, pinned here so that nobody later "fixes" it:
  // 1/x is convex, so rank 1 in one list and rank 3 in the other outscores rank 2 in both. RRF
  // rewards one retriever's strong opinion a shade more than two retrievers' lukewarm agreement.
  assert.ok((a.scores.get(0) as number) > (a.scores.get(1) as number));
});

test('a work in one list only cannot outrank a work both lists named lower down', () => {
  const keys = flat(3);
  const { rows } = rrf([[0, 2], [1, 2]], keys);
  assert.equal(rows[0], 2, 'rank 2 in both beats rank 1 in one');
});

test('a list that retrieved nothing contributes nothing and does not throw', () => {
  const keys = flat(2);
  const { rows, scores } = rrf([[], [1, 0]], keys);
  assert.deepEqual(rows, [1, 0]);
  assert.equal(scores.get(1), 1 / (RRF_K + 1));
});

// The reason `FUSE_DEPTH` is 100 and not 12. Fusing two top-12 lists can only re-order works one of
// them already had; the work BOTH arms ranked 13th is invisible to that and is exactly the work
// fusion exists to find.
test('retrieving deeper than k is what lets an agreed-on work reach the answer', () => {
  const n = 26;
  const keys = flat(n);
  const target = 25;
  const A = [...Array.from({ length: 12 }, (_, i) => i), target];
  const B = [...Array.from({ length: 12 }, (_, i) => 12 + i), target];
  assert.ok(!A.slice(0, 12).includes(target) && !B.slice(0, 12).includes(target));

  const shallow = rrf([A.slice(0, 12), B.slice(0, 12)], keys).rows;
  assert.ok(!shallow.includes(target), 'fusing two cut lists can never surface it');

  const deep = rrf([A, B], keys).rows;
  assert.equal(deep[0], target, 'agreed on by both, top-ranked by neither, and it wins');
});

test('ties break on the id hash, never on which list was passed first', () => {
  // Two works with identical RRF scores. Row order would hand it to 0; the keys say otherwise.
  const keys = Float64Array.from([9, 1]);
  assert.deepEqual(rrf([[0], [1]], keys).rows, [1, 0], 'the lower key wins the tie, not the lower row');
  const flipped = Float64Array.from([1, 9]);
  assert.deepEqual(rrf([[0], [1]], flipped).rows, [0, 1]);
});

test('the tie-break keys are a hash of the id and are uncorrelated with the manifest order', () => {
  const works = Array.from({ length: 40 }, (_, i) => work(`met-${i}`, 'met'));
  const keys = tieKeys(works);
  assert.equal(keys.length, 40);
  let ascending = 0;
  for (let i = 1; i < keys.length; i++) if ((keys[i] as number) > (keys[i - 1] as number)) ascending++;
  assert.ok(ascending > 8 && ascending < 31, `keys track row order too closely: ${ascending}/39 ascending`);
});

test('a depth below k is refused rather than silently truncating the fusion', () => {
  const works = Array.from({ length: 40 }, (_, i) => work(`w-${i}`, i % 2 ? 'met' : 'aic', { title: `t${i}` }));
  const vecs = works.map((_, i) => axis(i));
  assert.throws(
    () => fusionComparison(12, 6, 10, fakeJoin(works, vecs, vecs)),
    /depth 6 is below k 12/,
  );
});

test('every arm is scored query-vs-neighbours on one sample, and the fused arm is a third list', () => {
  const works = [
    work('met-q', 'met', { title: 'alpha' }),
    work('met-1', 'met', { title: 'alpha' }),
    work('aic-1', 'aic', { title: 'alpha' }),
    work('aic-2', 'aic', { title: 'alpha' }),
    work('aic-3', 'aic', { title: 'alpha' }),
    ...Array.from({ length: 20 }, (_, i) => work(`cma-${i}`, 'cma', { title: 'zeta' })),
  ];
  const vecs = works.map((_, i) => axis(i < 5 ? 0 : 1));
  const r = fusionComparison(4, 8, 1, fakeJoin(works, vecs, vecs));
  assert.equal(r.queries, 1, 'a stride sample of one is row 0');
  assert.equal(r.arms.length, 3);
  assert.deepEqual(
    r.arms.map((a) => a.name),
    ['BM25 (all fields)', 'CLIP-text (all)', 'RRF (BM25 + CLIP-text)'],
  );
  const dense = r.arms.find((a) => a.name === 'CLIP-text (all)') as { sameMuseum: number };
  // Rows 0-4 sit on one axis, so query 0's four nearest are the one met and the three aic.
  // Query-vs-neighbours is 1/4; the pair rate over those same four would be 3 of 6 = 50%.
  assert.ok(Math.abs(dense.sameMuseum - 0.25) < 1e-9, `expected 25%, got ${100 * dense.sameMuseum}%`);
  assert.equal(r.overlaps.length, 3);
  assert.equal(r.k, 4);
  assert.equal(r.depth, 8);
  assert.equal(r.k0, RRF_K);
});

test('chance is drawn without replacement, and the overlap chance is k/(n-1)', () => {
  const works = [
    ...Array.from({ length: 20 }, (_, i) => work(`met-${i}`, 'met', { title: 'Scarab' })),
    ...Array.from({ length: 20 }, (_, i) => work(`aic-${i}`, 'aic', { title: 'Scarab' })),
  ];
  const vecs = works.map((_, i) => axis(i % 3));
  const r = fusionComparison(6, 20, 40, fakeJoin(works, vecs, vecs));
  assert.ok(Math.abs(r.chance - 19 / 39) < 1e-9, `got ${r.chance}`);
  assert.ok(Math.abs(r.overlapChance - 6 / 39) < 1e-9);
  assert.equal(r.n, 40);
});

test('the report refuses to claim a gain inside the band, and says so in those words', () => {
  const works = Array.from({ length: 40 }, (_, i) =>
    work(`w-${i}`, i % 2 === 0 ? 'met' : 'aic', { title: `Object ${i}` }),
  );
  const vecs = works.map((_, i) => axis(i));
  const text = fusionComparisonText(fusionComparison(6, 20, 40, fakeJoin(works, vecs, vecs)));
  assert.match(text, /a confound, not a score/, 'same-museum must never be presented as quality');
  assert.match(text, /nobody has labelled these neighbourhoods/);
  assert.match(text, /no relevance ground truth/);
  const arms = fusionComparison(6, 20, 40, fakeJoin(works, vecs, vecs)).arms;
  const fused = arms.find((a) => a.name.startsWith('RRF')) as { agreesWithImage: number };
  const best = Math.max(...arms.filter((a) => !a.name.startsWith('RRF')).map((a) => a.agreesWithImage));
  if (Math.abs(fused.agreesWithImage - best) <= ARM_BAND) assert.match(text, /NOTHING MEASURED/);
});

test('the published constants are the published constants, not values fitted here', () => {
  assert.equal(RRF_K, 60, "Cormack et al.'s k; changing it makes every fusion number in-sample");
  assert.equal(FUSE_DEPTH, 100);
});
