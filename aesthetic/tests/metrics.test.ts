// The definitions, pinned to hand-built pixels.
//
// measure.test.ts already covers edgeContact through `metricsFromRgba`; this file exists because the
// arithmetic now lives on its own in aesthetic/metrics.ts, is reachable without a browser, and is
// about to be pointed at museum JPEGs as well as at plates. That widens the class of bug worth
// guarding: not "does the renderer draw the right thing" but "does a number still mean what its doc
// comment says it means". Every assertion below is a *definition* that something else in the stack
// reads as a fact — that a blank sheet reports 0 rather than 1 for symmetry, that inkOffset is
// weighted by tone and not by the bare mask, that the four edges are four independent numbers, that
// ink starts exactly at INK_THRESHOLD and not one step either side, and that a 3-byte buffer and a
// 4-byte buffer of the same picture are the same measurement. A refactor that quietly flipped any of
// those would keep every constraint check running and change what all of them assert, which is the
// failure mode that does not announce itself.
//
// The sheets are small enough that every expected value below is derivable with a pencil.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inkMapRgb, inkMapRgba, metricsFromInk, metricsFromRgba } from '../metrics.js';

const W = 100;
const H = 100;
const WHITE = '#ffffff';
/** EDGE_BAND is 0.05 of the shorter side, so 5 rows or columns on this sheet. */
const BAND = 5;

/** A white sheet; `paint` fills a rectangle with one colour. */
function sheet(): Buffer {
  return Buffer.alloc(W * H * 4, 0xff);
}
function paint(buf: Buffer, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * W + px) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
}

/**
 * The no-ink convention, stated in one place. `symmetry` of an empty sheet is 0, not 1, even though
 * an empty sheet is trivially its own mirror: the field answers "how much of the mark agrees with
 * its reflection", and a sheet with no mark has no answer. Returning 1 would make every untouched
 * region look maximally composed, and a `symmetryRange` constraint with a high floor would pass on a
 * blank page. inkOffset uses the same convention for the same reason.
 */
test('a blank sheet is zero everywhere, including both symmetries', () => {
  const m = metricsFromRgba(sheet(), W, H, WHITE);
  assert.equal(m.inkDensity, 0);
  assert.equal(m.coverage, 0);
  assert.equal(m.inkOffset, 0);
  assert.deepEqual(m.symmetry, { vertical: 0, horizontal: 0 });
  assert.deepEqual(m.edgeContact, { top: 0, right: 0, bottom: 0, left: 0 });
});

/**
 * The other end of the scale. A full bleed is the case where inkOffset has to stay 0 by arithmetic
 * rather than by convention: the tone is uniform, so the weighted centroid is the sheet's centre.
 * That is what makes the next test meaningful — a non-zero inkOffset on a fully inked sheet can only
 * come from tone.
 */
test('a full bleed is one everywhere, and sits dead centre', () => {
  const b = sheet();
  paint(b, 0, 0, W, H, 0, 0, 0);
  const m = metricsFromRgba(b, W, H, WHITE);
  assert.equal(m.inkDensity, 1);
  assert.equal(m.coverage, 1);
  assert.equal(m.inkOffset, 0);
  assert.deepEqual(m.edgeContact, { top: 1, right: 1, bottom: 1, left: 1 });
});

/**
 * The property inkOffset's doc comment claims and that nothing tested until now. Both halves of this
 * sheet are ink, so the *mask* is perfectly mirror-symmetric and its centroid is the centre of the
 * page — the degeneracy the weighting exists to escape. Weighted by distance from the paper, a black
 * half against a pale half is plainly left-heavy, and the number says so.
 *
 * The assertion is pinned to the hand-derived value, not just to "> 0", because the interesting way
 * for this to break is for the weighting to be *partially* removed: a mask-count in the denominator
 * with tone in the numerator would still be non-zero and would still be wrong.
 */
test('inkOffset is weighted by tone, so a black half against a pale half is not centred', () => {
  const b = sheet();
  paint(b, 0, 0, W / 2, H, 0, 0, 0); // distance 255 from white
  paint(b, W / 2, 0, W / 2, H, 0xd0, 0xd0, 0xd0); // distance 47, comfortably above the threshold
  const m = metricsFromRgba(b, W, H, WHITE);

  // Witness that the mask alone could not have told us this: every pixel is ink, so the mask is its
  // own mirror and the mask centroid is exactly the centre.
  assert.equal(m.inkDensity, 1);
  assert.equal(m.symmetry.vertical, 1);

  // Column centres are 0.5..99.5, so the two halves have mean x of 25 and 75.
  const meanX = (255 * 25 + 47 * 75) / (255 + 47);
  const expected = Math.abs(meanX - W / 2) / Math.hypot(W / 2, H / 2);
  assert.ok(Math.abs(m.inkOffset - expected) < 1e-12, `inkOffset ${m.inkOffset}, expected ~${expected}`);
  assert.ok(m.inkOffset > 0.2, 'a tone-blind centroid would have reported 0 here');
});

/**
 * Symmetry is intersection over union of the mask with its mirror, so it is 1 only when every inked
 * pixel has an inked partner, and 0 when none does. The one-sided case is the one that matters: it
 * proves the mirror is taken about the sheet's axis and not about the mark's own bounding box, which
 * would report any single blob as perfectly symmetric.
 */
test('symmetry.vertical is 1 for a mirrored pair of marks and 0 for one of them alone', () => {
  const mirrored = sheet();
  paint(mirrored, 10, 40, 10, 20, 0, 0, 0); // columns 10..19
  paint(mirrored, 80, 40, 10, 20, 0, 0, 0); // columns 80..89, the reflection of 10..19 about x=49.5
  assert.equal(metricsFromRgba(mirrored, W, H, WHITE).symmetry.vertical, 1);

  const oneSided = sheet();
  paint(oneSided, 10, 40, 10, 20, 0, 0, 0);
  const m = metricsFromRgba(oneSided, W, H, WHITE);
  assert.equal(m.symmetry.vertical, 0, 'no inked pixel has an inked reflection');
  assert.ok(m.inkDensity > 0, 'and it is not zero merely because the sheet is empty');
});

/**
 * Four numbers, not one. The mark below leaves three margins untouched and runs off the fourth edge,
 * and the whole reason edgeContact is a record rather than a scalar is that this must not read the
 * same as a mark that leaves all four alone. The right-hand value is a fraction, not a flag: the
 * band runs the full height of the sheet and the mark occupies a fifth of it.
 */
test('edgeContact reports the one edge a mark runs off, and stays zero on the other three', () => {
  const b = sheet();
  paint(b, 90, 40, 10, 20, 0, 0, 0); // reaches x = 99, the last column
  const e = metricsFromRgba(b, W, H, WHITE).edgeContact;
  // The right band is the last BAND columns over the full height: 5 * 20 inked of 5 * 100.
  assert.equal(e.right, (BAND * 20) / (BAND * H));
  assert.equal(e.top, 0);
  assert.equal(e.bottom, 0);
  assert.equal(e.left, 0);
});

/**
 * The seam that lets a decoded JPEG be measured in the same units as a plate. Three bytes per pixel
 * or four, the ink map must be identical — alpha was never read, and if that ever changes silently
 * then corpus numbers and render numbers stop being comparable while both keep looking reasonable.
 * The RGBA half here carries a deliberately varying alpha to make that explicit.
 */
test('inkMapRgb and inkMapRgba agree on the same image expressed both ways', () => {
  const w = 4;
  const h = 3;
  const px = [
    [255, 255, 255], [0, 0, 0], [128, 128, 128], [250, 250, 250],
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255],
    [247, 255, 255], [248, 255, 255], [10, 20, 30], [200, 200, 200],
  ];
  const rgba = Buffer.alloc(w * h * 4);
  const rgb = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    const [r, g, bl] = px[p]!;
    rgba[p * 4] = r!;
    rgba[p * 4 + 1] = g!;
    rgba[p * 4 + 2] = bl!;
    rgba[p * 4 + 3] = p % 3 === 0 ? 0 : 0xff; // alpha varies and must not matter
    rgb[p * 3] = r!;
    rgb[p * 3 + 1] = g!;
    rgb[p * 3 + 2] = bl!;
  }

  const fromRgba = inkMapRgba(rgba, w, h, WHITE);
  const fromRgb = inkMapRgb(rgb, w, h, WHITE);
  assert.deepEqual([...fromRgb], [...fromRgba]);
  // And the same map gives the same metrics, so the only thing pixelHash adds is the claim about
  // bytes that a caller holding a JPEG cannot make.
  const { pixelHash: _bytes, ...rest } = metricsFromRgba(rgba, w, h, WHITE);
  assert.deepEqual(metricsFromInk(fromRgb, w, h), rest);
});

/**
 * The boundary itself. INK_THRESHOLD is 8 and the comparison is `>=`, so a pixel exactly 8 away from
 * the ground is ink and one 7 away is paper. Written as literals rather than imported from the
 * module, on purpose: a test that computes its fixtures from the constant it is checking would keep
 * passing if the constant moved, and the point of this one is that moving it is a redefinition
 * somebody has to notice. Both directions are checked, because the distance is an absolute value and
 * a sign bug would only show on the darker side of a mid-grey ground.
 */
test('ink starts exactly at the threshold, from either side of the ground', () => {
  const w = 4;
  const h = 1;
  const rgba = Buffer.alloc(w * h * 4, 0xff);
  const reds = [128 + 8, 128 + 7, 128 - 8, 128 - 7];
  for (let p = 0; p < w; p++) {
    rgba[p * 4] = reds[p]!;
    rgba[p * 4 + 1] = 128;
    rgba[p * 4 + 2] = 128;
  }
  const ink = inkMapRgba(rgba, w, h, '#808080');
  assert.deepEqual([...ink], [8, 0, 8, 0], 'at the threshold is ink; one step inside it is not');
  assert.equal(metricsFromInk(ink, w, h).inkDensity, 0.5);
});

/**
 * opaqueRegions is the field that exists so a position can stop counting nodes. "Four opaque areas"
 * used to be `requireMark {styles:['solid'], min:4}`, which is a claim about the JSON and was
 * satisfiable by adding a solid paint underneath a covering where nobody would ever see it. Here it
 * is a claim about the sheet, and the two easiest ways to get it wrong are both checked below: a
 * region is an area of the *image*, so marks that merge are one, and it is four-connected, so marks
 * that meet only at a corner are two.
 */
test('opaqueRegions counts separated marks separately, largest first', () => {
  const b = sheet();
  paint(b, 10, 10, 10, 10, 0, 0, 0); // 100 px
  paint(b, 60, 60, 20, 20, 0, 0, 0); // 400 px
  assert.deepEqual(metricsFromRgba(b, W, H, WHITE).opaqueRegions, [0.04, 0.01]);
});

test('two marks that overlap are one region, and two that meet at a corner are two', () => {
  const merged = sheet();
  paint(merged, 10, 10, 20, 20, 0, 0, 0);
  paint(merged, 25, 10, 20, 20, 0, 0, 0); // shares columns 25..29
  assert.deepEqual(
    metricsFromRgba(merged, W, H, WHITE).opaqueRegions,
    [(35 * 20) / (W * H)],
    'the tree has two solid marks here and the picture has one area'
  );

  const diagonal = sheet();
  paint(diagonal, 10, 10, 10, 10, 0, 0, 0); // x 10..19, y 10..19
  paint(diagonal, 20, 20, 10, 10, 0, 0, 0); // x 20..29, y 20..29, touching only at the corner
  assert.deepEqual(
    metricsFromRgba(diagonal, W, H, WHITE).opaqueRegions,
    [0.01, 0.01],
    'four-connected: a shared corner is not a connection'
  );
});

/**
 * The two floors, and the difference between them. OPAQUE_THRESHOLD is about tone — a mark can be
 * ink and still not be opaque, which is exactly the distinction `withheld` lives on, because a
 * translucent covering is a hint and a hint invites the guess. REGION_FLOOR is about storage and
 * nothing else: it keeps a stray antialiased speck out of the list. A constraint that cares sets its
 * own `minArea` well above it.
 */
test('a mark can be ink without being opaque, and a speck is below the storage floor', () => {
  const pale = sheet();
  paint(pale, 10, 10, 40, 40, 0xd0, 0xd0, 0xd0); // distance 47: ink, nowhere near opaque
  const m = metricsFromRgba(pale, W, H, WHITE);
  assert.ok(m.inkDensity > 0.15, 'it is plainly ink');
  assert.deepEqual(m.opaqueRegions, [], 'and it is not an opaque region');

  const speck = sheet();
  paint(speck, 50, 50, 20, 20, 0, 0, 0); // 400 px, 0.04 of the sheet
  paint(speck, 5, 5, 2, 2, 0, 0, 0); // 4 px, 0.0004, under the 0.0005 floor
  assert.deepEqual(metricsFromRgba(speck, W, H, WHITE).opaqueRegions, [0.04]);
});
