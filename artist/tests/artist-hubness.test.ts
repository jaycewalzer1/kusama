// Hubness and the modality gap, tested on fixtures built so the right answer is known in advance.
//
// Nothing here reads `corpus/` or runs a model. The three things worth pinning: that CSLS actually
// demotes a hub rather than merely rescaling the row (a transform that changed no ranking would
// still print a different number), that centring removes the shared direction and nothing else, and
// that `selfChance` is `k / pool` — because the one way to make every rate in this report look good
// is to quote it against the whole corpus's chance while measuring it on a pool of four thousand.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSLS_R,
  DEFAULT_POOL,
  centre,
  cslsMatrix,
  hubnessOf,
  hubnessReport,
  hubnessReportText,
  kOccurrence,
  scoreMatrix,
  topK,
  type Pool,
} from '../hubness.js';
import { DIM } from '../text-embed.js';

function unit(parts: [number, number][]): Float32Array {
  const v = new Float32Array(DIM);
  for (const [i, w] of parts) v[i % DIM] = w;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] = (v[i] as number) / n;
  return v;
}

function pack(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs.length * DIM);
  vs.forEach((v, i) => out.set(v, i * DIM));
  return out;
}

/**
 * Six works. Image 0 is a hub: every work's text leans toward it slightly more than toward its own
 * picture, so raw cosine hands rank 1 to the same image for all six queries. That is the failure
 * mode hubness names, built here at the smallest size that shows it.
 */
const HUB_LEAN = 1.1;
function hubPool(): Pool {
  const n = 6;
  const u = 400;
  const text = Array.from({ length: n }, (_, i) => unit([[i, 1], [u, HUB_LEAN]]));
  const image = Array.from({ length: n }, (_, i) => (i === 0 ? unit([[u, 1]]) : unit([[i, 1]])));
  return {
    n,
    text: pack(text),
    image: pack(image),
    keys: Float64Array.from({ length: n }, (_, i) => i),
    sources: Array.from({ length: n }, (_, i) => (i % 2 ? 'met' : 'aic')),
  };
}

test('the fixture really is a hub: raw cosine gives every query the same image', () => {
  const p = hubPool();
  const s = scoreMatrix(p.text, p.image, p.n);
  for (let q = 0; q < p.n; q++) {
    assert.equal(topK(s, p.n, q, 1, p.keys, false)[0], 0, `query ${q} should be captured by the hub`);
  }
});

test('CSLS demotes the hub and hands every work its own picture back', () => {
  const p = hubPool();
  const raw = scoreMatrix(p.text, p.image, p.n);
  const corrected = cslsMatrix(raw, p.n, CSLS_R);
  for (let q = 0; q < p.n; q++) {
    assert.equal(topK(corrected, p.n, q, 1, p.keys, false)[0], q, `query ${q} should recover its own image`);
  }
});

test('CSLS is a re-ranking and not a rescaling — the numbers moving is not the claim', () => {
  const p = hubPool();
  const raw = scoreMatrix(p.text, p.image, p.n);
  const corrected = cslsMatrix(raw, p.n, CSLS_R);
  const before = topK(raw, p.n, 3, p.n, p.keys, false);
  const after = topK(corrected, p.n, 3, p.n, p.keys, false);
  assert.notDeepEqual(before, after, 'if the order is unchanged, CSLS printed a new number and did nothing');
});

test('the labelled task is scored against k/pool and not against the whole corpus', () => {
  const p = hubPool();
  const r = hubnessReport(p, 1, CSLS_R);
  assert.equal(r.selfChance, 1 / 6, 'k over the POOL; quoting k/19,807 here would flatter every row');
  assert.equal(r.n, 6);
  const raw = r.crossModal.find((c) => c.name === 'raw') as { selfAtK: number };
  const csls = r.crossModal.find((c) => c.name === 'CSLS') as { selfAtK: number; selfAt1: number };
  assert.ok(Math.abs(raw.selfAtK - 1 / 6) < 1e-9, 'the hub takes rank 1 from every work but its own');
  assert.equal(csls.selfAt1, 1, 'every work recovers its own picture at rank 1 under CSLS');
  assert.ok(csls.selfAtK > raw.selfAtK, 'the correction must earn its place on ground truth');
  assert.deepEqual(r.crossModal.map((c) => c.name), ['raw', 'centred', 'CSLS', 'centred + CSLS']);
});

test('centring subtracts exactly the mean and leaves unit vectors', () => {
  const rows = pack([unit([[0, 1], [5, 2]]), unit([[1, 1], [5, 2]]), unit([[2, 1], [5, 2]])]);
  const { rows: out, mean } = centre(rows, 3);
  // The shared direction is the one every row has in common; the mean is where it lives.
  assert.ok((mean[5] as number) > 0.5, 'the shared axis dominates the mean');
  for (let i = 0; i < 3; i++) {
    let norm = 0;
    for (let j = 0; j < DIM; j++) norm += (out[i * DIM + j] as number) ** 2;
    assert.ok(Math.abs(norm - 1) < 1e-5, `row ${i} is not unit after centring`);
  }
  let sum5 = 0;
  for (let i = 0; i < 3; i++) sum5 += out[i * DIM + 5] as number;
  assert.ok(Math.abs(sum5) < 1e-5, 'the shared component is gone, not merely reduced');
});

test('the modality gap is zero when the two matrices are the same points', () => {
  const n = 8;
  const vs = Array.from({ length: n }, (_, i) => unit([[i, 1]]));
  const p: Pool = {
    n,
    text: pack(vs),
    image: pack(vs),
    keys: Float64Array.from({ length: n }, (_, i) => i),
    sources: Array.from({ length: n }, () => 'met'),
  };
  const r = hubnessReport(p, 2, 3);
  assert.ok(r.modalityGap < 1e-6, `two identical clouds have no gap, got ${r.modalityGap}`);
  assert.ok(Math.abs(r.selfCosine - 1) < 1e-6);
  assert.ok(Math.abs(r.otherCosine) < 1e-6);
});

test('N_k hands out exactly n*k slots, and a fair space gives each point k', () => {
  // Points evenly spaced on a circle: each one's two nearest are its two circular neighbours, so
  // N_2 is exactly 2 everywhere and there is nothing for the statistic to find. Orthogonal axes
  // would NOT do — every cosine is 0, so the whole ranking would be the tie-break and half the
  // points would read as unretrievable, which is a fact about the tie-break and not about hubness.
  const n = 8;
  const vs = Array.from({ length: n }, (_, i) =>
    unit([[0, Math.cos((2 * Math.PI * i) / n)], [1, Math.sin((2 * Math.PI * i) / n)]]),
  );
  const keys = Float64Array.from({ length: n }, (_, i) => i);
  const s = scoreMatrix(pack(vs), pack(vs), n);
  const nk = kOccurrence(s, n, 2, keys, true);
  let total = 0;
  for (const v of nk) total += v;
  assert.equal(total, n * 2);
  for (const v of nk) assert.equal(v, 2, 'a perfectly symmetric space gives every point exactly k');
  const h = hubnessOf('circle', nk, n, 2);
  assert.equal(h.n, n);
  assert.equal(h.skew, 0, 'no spread, no skew');
  assert.equal(h.antihubShare, 0, 'nothing is unretrievable when every point is symmetric');
  assert.ok(Math.abs(h.top1pctShare - 2 / (n * 2)) < 1e-9);
});

test('a hub shows up as skew, a full top 1% share, and a wall of antihubs', () => {
  // 100 points, one of which is in everybody's list and 98 of which are in nobody's.
  const nk = new Int32Array(100);
  nk[0] = 100;
  nk[1] = 100;
  const h = hubnessOf('degenerate', nk, 100, 2);
  assert.ok(h.skew > 5, `a single hub must read as skew, got ${h.skew}`);
  assert.equal(h.maxNk, 100);
  assert.ok(Math.abs(h.antihubShare - 0.98) < 1e-9);
  assert.ok(Math.abs(h.top1pctShare - 0.5) < 1e-9, 'the top 1% is one point, holding half the slots');
});

test('topK breaks ties on the keys and never on the column index', () => {
  const n = 4;
  // Every candidate scores the same, so the order is entirely the tie-break.
  const s = new Float32Array(n * n).fill(0.5);
  const keys = Float64Array.from([9, 8, 7, 6]);
  assert.deepEqual(topK(s, n, 0, 3, keys, false), [3, 2, 1]);
});

test('the report states its pool and forbids quoting it beside the whole-corpus figures', () => {
  const text = hubnessReportText(hubnessReport(hubPool(), 2, CSLS_R));
  assert.match(text, /EVERY number below is over that pool/);
  assert.match(text, /Two pools, two quantities/);
  assert.match(text, /THE LABELLED TASK/);
  assert.match(text, /unretrievable/);
});

test('the published constants are the published constants', () => {
  assert.equal(CSLS_R, 10, "Conneau et al.'s neighbourhood size");
  assert.equal(DEFAULT_POOL, 4000);
});
