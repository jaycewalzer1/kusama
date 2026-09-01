// Putting a point on a map that was fitted without it.
//
// The thing worth testing here is not that a weighted average computes a weighted average. It is the
// two claims the page makes on the strength of it:
//
//   1. a placed point cannot leave the hull of the corpus's coordinates, so "it landed in the middle"
//      and "it belongs in the middle" look identical on screen and only `meanCosine` separates them;
//   2. `placementRecall` is NOT ~1 by construction, which is the finding the footer prints. The
//      fixture below reproduces the mechanism on eight points: neighbours that are mutually near in
//      the full space but scattered on the map, whose centroid lands nowhere near any of them.
//
// If a future change makes recall come out high on this fixture, the placement stopped being a
// centroid and the page's caveat is wrong — which is why it is asserted as a low number and not as
// "some number".

import assert from 'node:assert/strict';
import test from 'node:test';
import { PLACE_K, cosine, overlayFidelity, placeByNeighbours, placementRecall, topK } from '../overlay.js';

const unit = (...v: number[]): number[] => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

test('cosine returns 0 rather than NaN for a zero row', () => {
  assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(Math.abs(cosine([1, 0], [0, 1])), 0);
  // Unnormalised inputs must agree with normalised ones — the corpus rows are unit-norm but the
  // fixtures in this file are not, and a dot product masquerading as a cosine would pass everything
  // else here.
  assert.ok(Math.abs(cosine([3, 4], [6, 8]) - 1) < 1e-12);
});

test('topK returns k rows, most similar first, and is exact', () => {
  const rows = [unit(1, 0), unit(0.9, 0.1), unit(0, 1), unit(0.5, 0.5)];
  const got = topK(unit(1, 0), rows, 3);
  assert.equal(got.length, 3);
  assert.deepEqual(
    got.map((g) => g.row),
    [0, 1, 3],
  );
  for (let i = 1; i < got.length; i++) assert.ok((got[i - 1] as { cosine: number }).cosine >= (got[i] as { cosine: number }).cosine);
});

test('a placement is inside the hull of the coordinates it averaged, however unlike them it is', () => {
  // Four works that share a weak common direction and are otherwise orthogonal, at the four corners.
  const rows = [unit(1, 3, 0, 0, 0), unit(1, 0, 3, 0, 0), unit(1, 0, 0, 3, 0), unit(1, 0, 0, 0, 3)];
  const xy = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  // A vector equally — and weakly — like all four. It does not fly off the edge; it lands dead
  // centre, which is exactly what a viewer would misread as "it belongs here".
  const far = placeByNeighbours(unit(1, 0, 0, 0, 0), rows, xy, 4);
  assert.ok(Math.abs(far.x - 5) < 1e-9 && Math.abs(far.y - 5) < 1e-9);
  // meanCosine is the only thing that separates that from a genuine placement in the same spot.
  assert.ok(far.meanCosine < 0.4, `meanCosine ${far.meanCosine}`);

  const near = placeByNeighbours(rows[0] as number[], rows, xy, 4);
  assert.equal(near.neighbours[0]?.row, 0);
  assert.ok(near.meanCosine > far.meanCosine);
});

test('negative cosines are clamped, so a placement is never outside the coordinates it averaged', () => {
  const rows = [unit(1, 0), unit(-1, 0)];
  const xy = [
    [0, 0],
    [100, 0],
  ];
  const p = placeByNeighbours(unit(1, 0), rows, xy, 2);
  // The opposed neighbour gets weight 0, not weight -1, so the point sits on top of row 0 rather
  // than being flung to x = -100.
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
});

test('weightSpread near 1 means the placement is the plain centroid', () => {
  // CLIP's narrow cone, in miniature: four neighbours whose cosines differ by a few percent.
  const rows = [unit(1, 0.10), unit(1, 0.12), unit(1, 0.14), unit(1, 0.16)];
  const xy = [
    [0, 0],
    [4, 0],
    [0, 4],
    [4, 4],
  ];
  const p = placeByNeighbours(unit(1, 0), rows, xy, 4);
  assert.ok(p.weightSpread < 1.01, `weightSpread ${p.weightSpread}`);
  const centroid = [(0 + 4 + 0 + 4) / 4, (0 + 0 + 4 + 4) / 4];
  assert.ok(Math.abs(p.x - (centroid[0] as number)) < 0.1);
  assert.ok(Math.abs(p.y - (centroid[1] as number)) < 0.1);
});

test('placementRecall is NOT ~1 by construction when the map keeps adjacency and not distance', () => {
  // Eight corpus works. Rows 0..3 are mutually near in the full space; the map scatters them to the
  // four corners. Rows 4..7 are unlike them but sit in the middle of the map.
  const rows = [unit(1, 0.02, 0), unit(1, -0.02, 0), unit(1, 0, 0.02), unit(1, 0, -0.02), unit(0, 1, 0), unit(0, 1, 0.05), unit(0, 0.95, 0), unit(0, 1, -0.05)];
  const xy = [
    [0, 0],
    [20, 0],
    [0, 20],
    [20, 20],
    [10, 10],
    [10.5, 10],
    [10, 10.5],
    [9.5, 10],
  ];
  const v = unit(1, 0, 0);
  const p = placeByNeighbours(v, rows, xy, 4);
  // It is genuinely near the four it was placed from...
  assert.ok(p.meanCosine > 0.99, `meanCosine ${p.meanCosine}`);
  // ...and it lands on top of the four it is nothing like.
  const recall = placementRecall([p], xy, 4);
  assert.equal(recall, 0);
  assert.ok(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 10) < 1e-9);
});

test('placementRecall is 1 when the map is metric', () => {
  // Same code path, a map that does preserve distance. This is the control that says the low number
  // above is a fact about UMAP and not a bug in the measurement.
  const rows = [unit(1, 0), unit(0.99, 0.14), unit(0.98, 0.2), unit(0, 1), unit(0.1, 1), unit(0.2, 1)];
  const xy = rows.map((r) => [(r[0] as number) * 100, (r[1] as number) * 100]);
  const p = placeByNeighbours(unit(1, 0.05), rows, xy, 3);
  assert.equal(placementRecall([p], xy, 3), 1);
});

test('overlayFidelity reports chance as k/N and degrades safely on a corpus smaller than k', () => {
  const rows = [unit(1, 0), unit(0, 1), unit(1, 1)];
  const xy = [
    [0, 0],
    [1, 1],
    [2, 2],
  ];
  const v = [unit(1, 0)];
  const p = [placeByNeighbours(v[0] as number[], rows, xy, 2)];
  const [tiny] = overlayFidelity(v, p, rows, xy, [5]);
  assert.deepEqual(tiny, { k: 5, n: 1, preserved: 0, chance: 0, wider: false });

  const [ok] = overlayFidelity(v, p, rows, xy, [2], 2);
  assert.equal((ok as { chance: number }).chance, 2 / 3);
  assert.equal((ok as { wider: boolean }).wider, false);
});

test('wider marks the ks that are larger than the k the placement used', () => {
  const rows = Array.from({ length: 40 }, (_, i) => unit(Math.cos(i), Math.sin(i)));
  const xy = rows.map((_, i) => [i, i]);
  const v = [unit(1, 0)];
  const p = [placeByNeighbours(v[0] as number[], rows, xy)];
  const f = overlayFidelity(v, p, rows, xy, [PLACE_K, PLACE_K + 10]);
  assert.equal((f[0] as { wider: boolean }).wider, false);
  assert.equal((f[1] as { wider: boolean }).wider, true);
});
