// The influence resolver, and the one arithmetic fact that caught it lying.
//
// `resolve` produces a table of museum works that looks like a curated reading list no matter what
// it does. Every failure mode here is silent and plausible: a broken per-museum cap just yields a
// set that happens to be from one museum, a broken dedupe yields a set with one work in it four
// times, and — the one that actually happened — a broken PCA yields three axes with real works at
// both ends of each.
//
// The axes are what these tests are mostly for. Power iteration converges to *something* from any
// starting vector, so a defect does not throw and does not produce anything obviously wrong; it
// produces a slightly different set of works. The check that catches it is arithmetic rather than
// aesthetic: principal axes are ordered by construction, so `explained` must be non-increasing. It
// was not. `principalAxes` compared a unit iterate against an un-normalised seed vector in its
// convergence test, so `1 - |dot|` came out negative on the first pass and the loop broke after a
// single power step. On `withheld` that printed axis 0 at 10.2% of the set's variance and axis 1 at
// 22.0%. Nothing else in the output looked wrong.
//
// The synthetic fixture below is the second half of that: three clusters separated along one known
// direction, where the answer is knowable in advance and does not depend on the corpus being present.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embeddingsAvailable, loadCorpusEmbeddings } from '../clip-index.js';
import { textAvailable, textUnavailableMessage } from '../clip-text.js';
import {
  DEFAULT_SEED,
  influencesFromPosition,
  influencesHash,
  jaccard,
  principalAxes,
  resolve,
  sentences,
} from '../influences.js';
import { loadPosition } from '../field.js';

const DIM = 512;

const noCorpus =
  textAvailable() && embeddingsAvailable()
    ? false
    : `needs the text tower and corpus/clip.f32.\n${textUnavailableMessage()}`;

// --- the parts that need nothing on disk ---------------------------------------------------------

/**
 * Three clusters strung along dimension 0, with a smaller spread along dimension 1 and noise
 * everywhere else. The dominant direction is e0 and the second is e1, both known in advance.
 */
function threeClusters(): Float32Array[] {
  let s = 7;
  const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: Float32Array[] = [];
  for (let i = 0; i < 60; i++) {
    const v = new Float32Array(DIM);
    v[0] = ((i % 3) - 1) * 3 + (r() - 0.5) * 0.2;
    v[1] = (r() - 0.5) * 1;
    for (let j = 2; j < DIM; j++) v[j] = (r() - 0.5) * 0.02;
    out.push(v);
  }
  return out;
}

test('PCA on three known clusters recovers the direction they are strung along', () => {
  const axes = principalAxes(threeClusters(), 3);
  assert.equal(axes.length, 3);
  // Sign is arbitrary in an eigenvector, so compare magnitudes.
  assert.ok(Math.abs(axes[0]!.axis[0]!) > 0.99, `axis 0 is not e0: ${axes[0]!.axis[0]}`);
  assert.ok(Math.abs(axes[1]!.axis[1]!) > 0.99, `axis 1 is not e1: ${axes[1]!.axis[1]}`);
  assert.ok(axes[0]!.explained > 0.9, `axis 0 explains only ${axes[0]!.explained}`);
});

test('PCA axes are ordered — explained variance never increases', () => {
  // The assertion that caught the real defect. It needs no ground truth and no corpus: it is true
  // of principal axes by construction, so a violation is a bug in the solver and nothing else.
  for (const set of [threeClusters(), threeClusters().slice(0, 5)]) {
    const axes = principalAxes(set, 3);
    for (let i = 1; i < axes.length; i++) {
      assert.ok(
        axes[i]!.explained <= axes[i - 1]!.explained + 1e-6,
        `axis ${i} explains ${axes[i]!.explained} but axis ${i - 1} only ${axes[i - 1]!.explained}`,
      );
    }
  }
});

test('PCA axes are orthonormal and the total explained does not exceed 1', () => {
  const axes = principalAxes(threeClusters(), 3);
  const dot = (a: Float32Array, b: Float32Array) => {
    let x = 0;
    for (let i = 0; i < a.length; i++) x += a[i]! * b[i]!;
    return x;
  };
  for (let i = 0; i < axes.length; i++) {
    assert.ok(Math.abs(dot(axes[i]!.axis, axes[i]!.axis) - 1) < 1e-4, 'axis is not unit length');
    for (let j = i + 1; j < axes.length; j++) {
      assert.ok(Math.abs(dot(axes[i]!.axis, axes[j]!.axis)) < 1e-3, `axes ${i} and ${j} are not orthogonal`);
    }
  }
  assert.ok(axes.reduce((a, b) => a + b.explained, 0) <= 1 + 1e-6);
});

test('PCA on a set with no variance returns nothing rather than a direction', () => {
  const same = Array.from({ length: 8 }, () => Float32Array.from({ length: DIM }, (_, j) => (j === 3 ? 1 : 0)));
  assert.deepEqual(principalAxes(same, 3), []);
});

test('worldview paragraphs are split into sentences short enough for a 77-token context', () => {
  const got = sentences('One thing happens here. And then another, longer thing. Tiny.');
  assert.deepEqual(got, ['One thing happens here.', 'And then another, longer thing.']);
});

test('queries carry the position, and the hash moves when they do', () => {
  const a = influencesFromPosition(loadPosition('withheld'));
  const b = influencesFromPosition(loadPosition('interference'));
  assert.notEqual(influencesHash(a), influencesHash(b));
  assert.equal(influencesHash(a), influencesHash(influencesFromPosition(loadPosition('withheld'))));
  assert.ok(a.queries.length > 0);
  assert.ok(a.queries.some((q) => q.source === 'lineage'));
  assert.ok(a.queries.some((q) => q.source === 'worldview'));
  // Prohibitions down-weight, they do not remove. They must land in `avoid`, never in `excludes`.
  assert.equal(a.excludes.length, 0);
  assert.ok(a.avoid.length > 0);
});

test('every query weight and k is in range, and lineage outranks commitment', () => {
  const inf = influencesFromPosition(loadPosition('many-hands'));
  for (const q of inf.queries) {
    assert.ok(q.weight > 0 && q.weight <= 1, `weight ${q.weight} out of range`);
    assert.ok(q.k > 0 && q.k <= 64, `k ${q.k} out of range`);
    assert.ok(q.text.trim().length > 0);
  }
  const w = (s: string) => inf.queries.find((q) => q.source === s)?.weight;
  assert.ok((w('lineage') ?? 0) > (w('commitment') ?? 1));
});

// --- the parts that need the tower and the pixels -------------------------------------------------

test('resolution is deterministic, deduped, capped and inside its own limits', { skip: noCorpus }, async () => {
  const inf = influencesFromPosition(loadPosition('withheld'), DEFAULT_SEED);
  const a = await resolve(inf);
  const b = await resolve(inf);

  assert.equal(a.influencesHash, influencesHash(inf));
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same seed, same input, different output');

  // One row per distinct image. This has been wrong twice elsewhere in the repo for the same reason
  // — 98 manifest rows share bytes — so it is asserted here rather than trusted.
  assert.equal(new Set(a.works.map((w) => w.sha256)).size, a.works.length);
  assert.ok(a.works.length > 0 && a.works.length <= inf.limits.maxWorks);

  const cap = Math.floor(inf.limits.maxWorks * inf.limits.maxPerMuseum);
  for (const m of a.stats.museums) {
    assert.ok(m.n <= cap, `${m.source} holds ${m.n} of ${a.works.length}, over the cap of ${cap}`);
  }
  for (const w of a.works) {
    assert.ok(w.cosine >= inf.limits.minCosineToQuery, `${w.id} came in at ${w.cosine}`);
    assert.ok(w.avoidPenalty > 0 && w.avoidPenalty <= 1);
  }
  // Sorted by the weight that decides who survives the cap, not by arrival order.
  for (let i = 1; i < a.works.length; i++) {
    assert.ok(a.works[i]!.weight <= a.works[i - 1]!.weight + 1e-9);
  }
});

test('excludes are honoured', { skip: noCorpus }, async () => {
  const inf = influencesFromPosition(loadPosition('withheld'), DEFAULT_SEED);
  const first = await resolve(inf);
  const banned = first.works.slice(0, 5).map((w) => w.sha256);
  const second = await resolve({ ...inf, excludes: banned });
  for (const sha of banned) {
    assert.ok(!second.works.some((w) => w.sha256 === sha), `${sha} was excluded and came back anyway`);
  }
  assert.ok(second.works.length > 0);
});

test('picks enter the set and are never capped away', { skip: noCorpus }, async () => {
  const corpus = loadCorpusEmbeddings();
  // A stride sample, so this is not quietly picking works the queries would have found anyway.
  const picks = [0, 1, 2].map((i) => corpus.entries[i * 4001]!.sha256);
  const inf = influencesFromPosition(loadPosition('withheld'), DEFAULT_SEED);
  const r = await resolve({ ...inf, picks });
  for (const sha of picks) {
    const got = r.works.find((w) => w.sha256 === sha);
    assert.ok(got, `pick ${sha} is not in the resolved set`);
    assert.equal(got.via, 'pick');
  }
});

test('the axes of a real resolved set are ordered and their walks terminate', { skip: noCorpus }, async () => {
  const r = await resolve(influencesFromPosition(loadPosition('withheld'), DEFAULT_SEED));
  assert.equal(r.axes.length, 3);
  for (let i = 0; i < r.axes.length; i++) {
    const a = r.axes[i]!;
    assert.equal(a.index, i);
    if (i > 0) assert.ok(a.explained <= r.axes[i - 1]!.explained + 1e-6, `axis ${i} explains more than axis ${i - 1}`);
    // Termination is the whole safety property of the walk: it stops at the corpus's hull or at the
    // step cap, and either way it stops.
    assert.ok(a.stepsPlus >= 0 && a.stepsPlus <= 12);
    assert.ok(a.stepsMinus >= 0 && a.stepsMinus <= 12);
    assert.ok(['hull', 'cap'].includes(a.endedPlus));
    assert.ok(['hull', 'cap'].includes(a.endedMinus));
    // The extremes are the corpus answering, not the set repeating itself back.
    const own = new Set(r.works.map((w) => w.sha256));
    for (const hit of [...a.plus, ...a.minus]) assert.ok(!own.has(hit.sha256));
  }
});

test('the stats report every number against a stated chance baseline', { skip: noCorpus }, async () => {
  const r = await resolve(influencesFromPosition(loadPosition('withheld'), DEFAULT_SEED));
  const s = r.stats;
  assert.equal(s.n, r.works.length);
  assert.ok(s.sameMuseumChance > 0 && s.sameMuseumChance < 1);
  assert.ok(s.intraMin <= s.intraMean && s.intraMean <= s.intraMax);
  assert.equal(s.entropy.length, 2);
  for (const e of s.entropy) assert.ok(e.chanceLo <= e.chanceMean && e.chanceMean <= e.chanceHi);
  const d = s.dimensionality;
  assert.equal(d.twoD + d.object + d.unknown, s.n);
});

test('two positions with different lineages do not resolve to the same works', { skip: noCorpus }, async () => {
  const a = await resolve(influencesFromPosition(loadPosition('withheld'), DEFAULT_SEED));
  const b = await resolve(influencesFromPosition(loadPosition('many-hands'), DEFAULT_SEED));
  assert.equal(jaccard(a, a), 1);
  // Not a claim that the sets are *good*, only that the derivation is carrying the position at all.
  // If this ever fails the queries have stopped mattering and every downstream number is about CLIP.
  assert.ok(jaccard(a, b) < 0.5, `withheld and many-hands overlap at ${jaccard(a, b)}`);
});
