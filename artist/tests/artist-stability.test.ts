// Whether UMAP drew the same picture twice, tested on a layout whose answer is known in advance.
//
// The atlas page has always carried the sentence "the gap between two clusters here means nothing".
// That is correct received wisdom about UMAP and it had never been checked on this data, which is a
// different thing from being false. These tests pin the machinery that checks it: that a fit
// compared with itself scores a perfect 1 (so the comparison is not accidentally measuring
// something else), that seeds and parameters are compared separately, and that the verdict flips on
// a band fixed in advance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STABILITY_BAND, spearman, stability, stabilityText, umapProject } from '../atlas.js';

/** Three tight, well-separated blobs in 6-d: a layout with real neighbourhoods to preserve. */
function blobs(perBlob = 22, dims = 6): Float64Array[] {
  const rows: Float64Array[] = [];
  let s = 12345;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let b = 0; b < 3; b++) {
    for (let i = 0; i < perBlob; i++) {
      const r = new Float64Array(dims);
      for (let d = 0; d < dims; d++) r[d] = (d === b ? 10 : 0) + rand() * 0.6;
      rows.push(r);
    }
  }
  return rows;
}

test('spearman is 1 on an identical series, -1 on a reversed one, and 0 on a constant', () => {
  const xs = [3, 1, 4, 1, 5, 9, 2, 6];
  assert.ok(Math.abs(spearman(xs, xs) - 1) < 1e-9);
  assert.ok(Math.abs(spearman(xs, [...xs].map((x) => -x)) + 1) < 1e-9);
  assert.equal(spearman(xs, xs.map(() => 7)), 0, 'no variance means no correlation, not a divide by zero');
});

test('spearman averages tied ranks rather than breaking them by position', () => {
  // Both series are the same up to a tie; a rank rule that used array position would score below 1.
  assert.ok(Math.abs(spearman([1, 2, 2, 3], [1, 2, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(spearman([1, 2, 2, 3], [1, 5, 5, 9]) - 1) < 1e-9);
});

test('a fit compared with itself agrees perfectly, so the comparison measures what it says', () => {
  const rows = blobs();
  // One seed repeated: the two fits are byte-identical, so anything below a perfect score would be
  // a bug in the comparison rather than instability in UMAP.
  const s = stability(rows, 5, [7, 7], [{ neighbours: 10, minDist: 0.1 }], 2000);
  assert.equal(s.seedPairs.length, 1);
  const p = s.seedPairs[0] as { neighbourAgreement: number; distanceRho: number };
  assert.ok(Math.abs(p.neighbourAgreement - 1) < 1e-9, `got ${p.neighbourAgreement}`);
  assert.ok(Math.abs(p.distanceRho - 1) < 1e-9, `got ${p.distanceRho}`);
  assert.equal(s.preservedSd, 0, 'the same seed twice has no spread');
});

test('the same seed gives the same layout, and a different seed is a different layout', () => {
  const rows = blobs(14, 4);
  const a = umapProject(rows, 3, 8, 0.1);
  const b = umapProject(rows, 3, 8, 0.1);
  assert.deepEqual(a, b, 'seeded, or no number on the page could be reproduced');
  const c = umapProject(rows, 4, 8, 0.1);
  assert.notDeepEqual(a, c, 'if the seed changed nothing there would be nothing here to measure');
});

test('seed pairs and parameter pairs are counted separately and never pooled', () => {
  const rows = blobs(12, 4);
  const s = stability(
    rows,
    4,
    [1, 2],
    [{ neighbours: 8, minDist: 0.1 }, { neighbours: 4, minDist: 0.1 }],
    1000,
  );
  assert.equal(s.runs.length, 3, 'two seeds at the base parameters, plus one parameter variant');
  assert.equal(s.seedPairs.length, 1, 'C(2,2) seed pairs');
  assert.equal(s.paramPairs.length, 1);
  assert.equal(s.k, 4);
  assert.ok(Math.abs(s.chance - 4 / (rows.length - 1)) < 1e-12, 'chance is k/(n-1), on these points');
  // A parameter variant must be compared against the base seed, not against another parameter.
  const pp = s.paramPairs[0] as { a: number; b: number };
  assert.equal(pp.a, 0);
  assert.equal(pp.b, 2);
  const runs = s.runs;
  assert.equal((runs[2] as { neighbours: number }).neighbours, 4);
  assert.equal((runs[2] as { seed: number }).seed, 1, 'the variant holds the first seed fixed');
});

test('the verdict names no cluster when the seeds disagree, and says why when they agree', () => {
  const rows = blobs();
  const s = stability(rows, 5, [7, 7], [{ neighbours: 10, minDist: 0.1 }], 2000);
  const text = stabilityText(s);
  assert.match(text, /WHAT MAY BE SAID ABOUT THIS MAP/);
  const worst = s.seedPairs.reduce((m, p) => Math.min(m, p.neighbourAgreement), 1);
  if (worst >= STABILITY_BAND) assert.match(text, /about the works and not about the random start|statement about the data/);
  else assert.match(text, /NAME NO CLUSTER/);

  // Forced below the band: the page must refuse, in those words, without a fit being run.
  const broken = {
    ...s,
    seedPairs: [{ a: 0, b: 1, neighbourAgreement: 0.1, distanceRho: 0.05 }],
  };
  const bad = stabilityText(broken);
  assert.match(bad, /NAME NO CLUSTER/);
  assert.match(bad, /DISTANCE BETWEEN TWO CLUSTERS|DISTANCE BETWEEN CLUSTERS ON/);
});

test('the band is a number fixed in advance, not one read off the result', () => {
  assert.equal(STABILITY_BAND, 0.5);
});
