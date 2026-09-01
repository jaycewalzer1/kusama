// The geometry of the two preprocessings, without the encoder.
//
// `aspectAudit` needs 335 MB of ONNX weights and 12 seconds; this does not, because the part that
// could be wrong is arithmetic. What is asserted is that `pad` keeps the whole picture and fills the
// rest with silence, that the crop discards what it says it discards, and that on a square image the
// two schemes are the same function — which is what makes the audit's "0-5% cropped" band a noise
// floor rather than a third result.

import test from 'node:test';
import assert from 'node:assert/strict';
import { preprocess, SIDE } from '../resemblance.js';
import type { Rgb } from '../pixels.js';

/**
 * A picture with a distinct band along each edge, so throwing an edge away is detectable.
 *
 * Row `y` gets red = its share of the height. The centre crop of a tall image keeps only the middle
 * of that ramp; padding keeps 0 and 255.
 */
function ramp(width: number, height: number): Rgb {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = Math.round((255 * y) / (height - 1));
      data[i + 1] = Math.round((255 * x) / (width - 1));
      data[i + 2] = 128;
    }
  }
  return { width, height, data };
}

/** Channel 0 of the tensor, as rows. */
const rows = (t: Float32Array): Float32Array[] =>
  Array.from({ length: SIDE }, (_, y) => t.subarray(y * SIDE, (y + 1) * SIDE));

const allZero = (r: Float32Array): boolean => r.every((v) => v === 0);

test('a square image is preprocessed identically either way', () => {
  // If this ever stops holding, the audit's near-square band stops being a noise floor and starts
  // being a second effect nobody has named.
  const img = ramp(300, 300);
  assert.deepEqual(Array.from(preprocess(img, false)), Array.from(preprocess(img, true)));
});

test('pad fills the margin with exactly zero — the normalized channel mean, and nothing else', () => {
  // A 2:1 image padded to square is half picture and half margin. Zero is the least the padding can
  // assert; the clamped-sampling alternative would smear the edge row across 112 rows, which is a
  // loud claim about a part of the picture that does not exist.
  const t = preprocess(ramp(400, 200), true);
  const r = rows(t);
  const blank = r.filter(allZero).length;
  assert.ok(blank >= 108 && blank <= 116, `${blank} blank rows, expected about half of ${SIDE}`);
  // And the margin is at the top and the bottom, not somewhere in the middle.
  assert.ok(allZero(r[0]!) && allZero(r[SIDE - 1]!));
  assert.ok(!allZero(r[SIDE >> 1]!), 'the centre row must be picture');
});

test('crop fills every row, and that is the difference', () => {
  const t = preprocess(ramp(400, 200), false);
  assert.equal(rows(t).filter(allZero).length, 0);
});

test('pad keeps the ends of the ramp that the crop throws away', () => {
  const tall = ramp(200, 400);
  const cropped = preprocess(tall, false);
  const padded = preprocess(tall, true);
  const span = (t: Float32Array, skipBlank: boolean): [number, number] => {
    const vals = rows(t)
      .filter((r) => !skipBlank || !allZero(r))
      .map((r) => r[SIDE >> 1] as number);
    return [Math.min(...vals), Math.max(...vals)];
  };
  const [cLo, cHi] = span(cropped, false);
  const [pLo, pHi] = span(padded, true);
  // The crop sees the middle half of a 0..1 ramp; padding sees all of it. So padding's range is
  // strictly wider at both ends, and by roughly a factor of two overall.
  assert.ok(pLo < cLo && pHi > cHi, `pad [${pLo},${pHi}] should contain crop [${cLo},${cHi}]`);
  assert.ok((pHi - pLo) / (cHi - cLo) > 1.8);
});

test('both schemes produce a full CLIP tensor of finite numbers', () => {
  for (const pad of [false, true]) {
    const t = preprocess(ramp(1128, 1872), pad);
    assert.equal(t.length, 3 * SIDE * SIDE);
    assert.ok(t.every((v) => Number.isFinite(v)));
  }
});
