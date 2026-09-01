// The contract between `artist/influence/descriptors.ts` and `influence/descriptors.py`.
//
// `descriptors.ts:4-8` says this file exists and asserts the four layer widths against the worker's
// own `--spec`. It did not exist. The widths were written down twice, in two languages, with nothing
// checking they agreed — which is the same failure the repo has hit before in the other direction:
// prose beside a number does not get checked the way the number does, and here the prose asserted a
// test. Writing it is cheaper than deleting the claim, because the claim is the right one.
//
// It lives in `artist/tests/` and not `artist/influence/tests/` deliberately. The suite glob is
// `dist/*/tests/*.test.js` — exactly one directory deep — so a test at `artist/influence/tests/`
// compiles to `dist/artist/influence/tests/` and never runs, silently, forever. That is a worse
// outcome than no test.
//
// The spec check skips without the venv, as `artist-dino.test.ts` does for its weights. Everything
// below it is arithmetic over hand-built rows and always runs, so a fresh clone still covers the
// packing, the offsets, the zero-variance rule and the layer scoping of `distance`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIMS,
  LAYERS,
  OFFSETS,
  ROW,
  centroid,
  computeStats,
  distance,
  pack,
  workerAvailable,
  workerSpec,
  workerUnavailableMessage,
  type Described,
  type Stats,
} from '../influence/descriptors.js';

const skip = workerAvailable() ? false : `needs the descriptor worker's venv.\n${workerUnavailableMessage()}`;

test('DIMS equals the worker\'s own --spec', { skip }, async () => {
  const spec = await workerSpec();
  // Compared as whole objects, not key by key: a layer the worker grew and TypeScript never heard of
  // is exactly the drift this test exists to catch, and a per-key loop over `LAYERS` would miss it.
  assert.deepEqual(spec['dims'], DIMS);
  assert.deepEqual(spec['layers'], [...LAYERS]);
});

test('the layer widths are the arithmetic their comment claims', () => {
  // These are the sums written in prose at `descriptors.ts:36-39`. If the worker changes GRID or
  // PALETTE_K the test above catches it; this one catches the comment going stale on its own.
  assert.equal(DIMS.armature, 16 * 16 + 6, 'a 16x16 grid + aspect, area, centroid(2), symmetry(2)');
  assert.equal(DIMS.palette, 6 * 3 + 6 + 3, '6 Lab centres + 6 area fractions + L mean, L std, chroma mean');
  assert.equal(DIMS.texture, 4 * 6 * 2 + 10, '(mean, std) over 4 scales x 6 orientations + a 10-bin LBP');
  assert.equal(DIMS.form, 8 + 3 + 1 + 12, '8 edge-hardness bins + curvature(3) + elongation + 12 orientations');
  assert.equal(ROW, 371);
});

test('offsets tile the row exactly, in LAYERS order and with no gap', () => {
  let at = 0;
  for (const l of LAYERS) {
    assert.equal(OFFSETS[l], at, `${l} starts at ${at}`);
    at += DIMS[l];
  }
  assert.equal(at, ROW);
});

function described(fill: (layer: (typeof LAYERS)[number], i: number) => number): Described {
  const d = { path: 'x.jpg', width: 10, height: 10 } as Described;
  for (const l of LAYERS) d[l] = Array.from({ length: DIMS[l] }, (_, i) => fill(l, i));
  return d;
}

test('pack lays the four layers down at their offsets', () => {
  // Each layer filled with its own constant, so a mis-offset shows up as the wrong constant at the
  // wrong index rather than as a plausible number.
  const marks: Record<string, number> = { armature: 1, palette: 2, texture: 3, form: 4 };
  const row = pack(described((l) => marks[l]!));
  assert.equal(row.length, ROW);
  for (const l of LAYERS) {
    assert.equal(row[OFFSETS[l]], marks[l], `${l} starts with its own mark`);
    assert.equal(row[OFFSETS[l] + DIMS[l] - 1], marks[l], `${l} ends with its own mark`);
  }
});

test('a dimension with no spread gets std 1, so it contributes 0 rather than infinity', () => {
  // The rule `computeStats` documents. Column 0 is constant across both rows; without the
  // substitution its z-scored contribution is 0/0.
  const rows = new Float32Array(2 * ROW);
  for (let i = 0; i < 2; i++) {
    rows[i * ROW] = 5; // constant
    rows[i * ROW + 1] = i === 0 ? 0 : 4; // std 2
  }
  const stats = computeStats(rows, 2);
  assert.equal(stats.rows, 2);
  assert.equal(stats.mean.length, ROW);
  assert.equal(stats.std[0], 1, 'a constant column is not zero-variance in the divisor');
  assert.equal(stats.std[1], 2);
  const a = rows.slice(0, ROW);
  const b = rows.slice(ROW, 2 * ROW);
  assert.ok(Number.isFinite(distance(a, b, 'armature', stats)));
});

test('distance reads one layer and is blind to every other', () => {
  const stats: Stats = { version: 'v1', rows: 1, mean: new Array(ROW).fill(0), std: new Array(ROW).fill(1) };
  const a = pack(described(() => 0));
  const b = pack(described(() => 0));
  // A difference planted in `form` must be invisible to `palette` and visible to `form`. This is the
  // property that makes a per-layer verdict mean anything: `docs/influence/pairs.md` reports four
  // separate sign tests, and they are only four measurements if the layers do not leak.
  b[OFFSETS.form] = 3;
  assert.equal(distance(a, b, 'palette', stats), 0);
  assert.equal(distance(a, b, 'armature', stats), 0);
  assert.equal(distance(a, b, 'texture', stats), 0);
  assert.equal(distance(a, b, 'form', stats), 3);
});

test('distance is z-scored, so a wide dimension does not become the measurement', () => {
  const std = new Array(ROW).fill(1);
  std[OFFSETS.palette] = 100;
  const stats: Stats = { version: 'v1', rows: 1, mean: new Array(ROW).fill(0), std };
  const a = pack(described(() => 0));
  const b = pack(described(() => 0));
  b[OFFSETS.palette] = 100;
  assert.equal(distance(a, b, 'palette', stats), 1, '100 raw units of a 100-wide dimension is one sd');
});

test('centroid of no rows is the zero row, not a division by zero', () => {
  const rows = new Float32Array(2 * ROW);
  rows[0] = 2;
  rows[ROW] = 4;
  assert.equal(centroid(rows, []).every((v) => v === 0), true);
  assert.equal(centroid(rows, [0, 1])[0], 3);
  assert.equal(centroid(rows, [1])[0], 4);
});
