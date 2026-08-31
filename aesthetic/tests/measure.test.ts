// edgeContact, measured off hand-built pixels.
//
// `metricsFromRgba` is pure over a buffer, so these are real measurements of the real function with
// no browser and no cache: the sheets below are the ones whose answers can be worked out by hand.
// The rest of RenderMetrics is exercised through the fixtures and the goldens.

import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFromRgba } from '../measure.js';

const W = 100;
const H = 100;
/** EDGE_BAND is 0.05 of the shorter side, so 5 rows or columns on this sheet. */
const BAND = 5;

/** A white sheet with a black rectangle painted on it. `w` or `h` of 0 leaves it blank. */
function sheet(x: number, y: number, w: number, h: number): Buffer {
  const rgba = Buffer.alloc(W * H * 4, 0xff);
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * W + px) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
    }
  }
  return rgba;
}

const edges = (b: Buffer) => metricsFromRgba(b, W, H, '#ffffff').edgeContact;

test('an untouched sheet reads zero on all four sides', () => {
  assert.deepEqual(edges(sheet(0, 0, 0, 0)), { top: 0, right: 0, bottom: 0, left: 0 });
});

test('a full bleed reads one on all four sides', () => {
  assert.deepEqual(edges(sheet(0, 0, W, H)), { top: 1, right: 1, bottom: 1, left: 1 });
});

/**
 * The case the field was added for. A picture can carry plenty of ink and still leave a margin on
 * every side, and inkDensity cannot tell you so -- it reports the same number wherever the mark
 * sits. This is the run the user was looking at.
 */
test('a mark that touches no edge reads zero on all four sides while still carrying ink', () => {
  const m = metricsFromRgba(sheet(20, 20, 60, 60), W, H, '#ffffff');
  assert.deepEqual(m.edgeContact, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.ok(m.inkDensity > 0.3, `the sheet is not empty: inkDensity ${m.inkDensity}`);
});

/**
 * The asymmetry that no scalar could report. Three sides reached, one clean -- a mean, a max or a
 * count of sides touched would each collapse this into the same answer as some other picture.
 */
test('a mark that runs off three sides names the fourth as the clean one', () => {
  // Full width, from a fifth of the way down to the bottom: left, right and bottom are reached.
  const e = edges(sheet(0, 20, W, H - 20));
  assert.equal(e.top, 0, 'the only untouched side');
  assert.equal(e.bottom, 1);
  // Not 1. Contact is a fraction, not a flag: the side bands run the sheet's full height and the
  // top fifth of each is clean, so "runs off the left edge" is reported as the 0.8 of it that does.
  assert.equal(e.left, 0.8);
  assert.equal(e.right, 0.8);
});

/** Each side's denominator is its own band, so the four numbers are comparable to each other. */
test('a band of ink along one edge fills that side and grazes its two neighbours', () => {
  const e = edges(sheet(0, H - BAND, W, BAND));
  assert.equal(e.bottom, 1);
  assert.equal(e.top, 0);
  // The left and right bands run the full height and are inked only where they cross the bottom one.
  assert.equal(e.left, BAND / H);
  assert.equal(e.right, BAND / H);
});

/** A hairline on the border still counts: contact is contact, and the band is not a threshold. */
test('a single row of ink on the edge is contact, at the fraction of the band it occupies', () => {
  const e = edges(sheet(0, 0, W, 1));
  assert.equal(e.top, 1 / BAND);
  assert.equal(e.bottom, 0);
});
