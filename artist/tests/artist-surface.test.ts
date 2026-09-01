// What the corpus is asked, what it is told the answer is about, and the refusal that has to survive
// maintenance.
//
// This file exists to catch one class of regression: `artist/surface.ts` losing track of what its
// numbers are about. 77% of the manifest is objects on a studio backdrop, and on those images every
// RenderMetrics field silently changes its subject — `inkDensity` becomes the silhouette's share of
// the frame, `inkOffset` becomes where the photographer set the object down. Those numbers are
// plausible, stable, and about a photographic department rather than about a picture. They are
// measured anyway, because they are the only handle on how much of the corpus's structure is
// studio convention, and they are measured under a label. So the single most important assertion
// below is that the same pixels produce IDENTICAL metrics under both labels and differ only in
// `subject` — the label is a claim about provenance and must never be derived from the numbers it
// qualifies — and that `surfaceText` never pools the two into one band.
//
// The second half is the ground estimate itself. A gradient backdrop must come out not confident;
// that is the function working. If it ever starts coming out confident, `metrics` starts existing on
// images where "ink" is a lighting falloff.
//
// The third is `weight`, which exists because all 50 works with readings in `corpus/readings/` are
// paintings and none of them has a ground at all. It must be present when `metrics` is null, and it
// must actually separate compositions that `offset` alone reads as identical.
//
// Everything about what the numbers MEAN is driven from images built in memory. No corpus, no
// manifest, no bytes on disk — a test that needs a museum installed is a test that does not run on a
// fresh clone. The tests that do touch the corpus are gated, and the gate names every precondition
// it covers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from '../../env/browser.js';
import { GROUND_CONFIDENT_SHARE, estimateGround, type Rgb } from '../pixels.js';
import {
  AXIS_SHARE_CHANCE,
  MIN_MEASURED,
  axisShare,
  surfaceFrom,
  surfaceText,
  surfaces,
  type SurfaceReport,
} from '../surface.js';
import { imagePath, readManifest, type Work } from '../manifest.js';

// --- synthetic images ---------------------------------------------------------------------------

/** `at(x, y)` returns `[r, g, b]`. Small enough to reason about, big enough to have a 4% border. */
function image(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Rgb {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { width, height, data };
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

/**
 * A dark rectangle in the middle third, on paper of whatever colour the caller wants at the edges.
 *
 * 201 and not 200, so the middle third is exactly a third and the ink is exactly a ninth of the
 * sheet. A round-looking side length that divides into 66.67 would make every assertion below carry
 * a rounding fudge, and a fudge is where a wrong answer hides.
 */
function blob(backdrop: (x: number, y: number) => [number, number, number], side = 201): Rgb {
  const lo = Math.floor(side / 3);
  const hi = Math.floor((2 * side) / 3);
  return image(side, side, (x, y) => (x >= lo && x < hi && y >= lo && y < hi ? BLACK : backdrop(x, y)));
}

/** White, with black rectangles `[x0, x1, y0, y1]` (half-open) laid on it. */
function rects(width: number, height: number, boxes: [number, number, number, number][]): Rgb {
  return image(width, height, (x, y) =>
    boxes.some(([x0, x1, y0, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1) ? BLACK : WHITE
  );
}

const flatWhite = () => WHITE;
/** A backdrop lit from one side: 190 to 255 across the frame. No edge of it matches any other. */
const gradient = (x: number, _y: number): [number, number, number] => {
  const v = Math.round(190 + (65 * x) / 200);
  return [v, v, v];
};

// --- the refusals ---------------------------------------------------------------------------------

test('a blob on uniform paper has a confident ground, and as a sheet it is measurable', () => {
  const s = surfaceFrom(blob(flatWhite), 'w-1', 'a'.repeat(64), true);
  assert.equal(s.ground.hex, '#ffffff');
  assert.ok(s.ground.confident, `border share was ${s.ground.share}`);
  assert.equal(s.ground.share, 1);
  assert.ok(s.measurable);
  assert.equal(s.subject, 'sheet');
  assert.notEqual(s.metrics, null);
  // The middle third of a square, so a ninth of it. This is the number that only means something
  // because the ground was real.
  assert.equal(s.metrics!.inkDensity.toFixed(3), (1 / 9).toFixed(3));
  assert.match(s.why, /a sheet/);
});

test('a gradient backdrop is not a ground, and nothing is measured on it', () => {
  // The failure this guards: a lit falloff across seamless paper is ink under any single-colour
  // ground, so `inkDensity` would come back as most of the frame and look like a picture.
  const s = surfaceFrom(blob(gradient), 'w-2', 'b'.repeat(64), true);
  assert.equal(s.ground.confident, false);
  assert.ok(s.ground.share < GROUND_CONFIDENT_SHARE);
  assert.equal(s.metrics, null);
  assert.equal(s.measurable, false);
  assert.match(s.why, /border is not one colour/);
  assert.match(s.why, /mount, a frame or a lit gradient/);
  // The label is about what the thing is, not about whether it could be measured, so it survives
  // the refusal.
  assert.equal(s.subject, 'sheet');
});

test('an object on a perfect backdrop is measured and labelled studio-framing', () => {
  // THE 77% CASE. The ground could not be better — seamless paper, uniform to the byte — and the
  // numbers that come out are real measurements of a photograph rather than of a picture:
  // `inkDensity` is the share of the frame the silhouette occupies. They are kept, because they are
  // the only way to later ask how much of the corpus's structure is the photography department, and
  // that confound is not hypothetical (`file:have-pixels` loaded on the metadata atlas's first axis
  // as heavily as `source:met`). The danger was never the measurement; it was the unlabelled one.
  const object = surfaceFrom(blob(flatWhite), 'w-3', 'c'.repeat(64), false);
  assert.ok(object.ground.confident);
  assert.equal(object.measurable, true);
  assert.notEqual(object.metrics, null);
  assert.equal(object.subject, 'studio-framing');
  assert.match(object.why, /about the photograph/);
  assert.match(object.why, /silhouette/);

  // THE ASSERTION THAT EARNS THE FILE. Same pixels, same arithmetic, same numbers to the last bit —
  // only the label moves. If these ever diverge, the label has started being derived from the
  // numbers it is supposed to qualify, and every band built from it becomes self-confirming.
  const sheet = surfaceFrom(blob(flatWhite), 'w-3', 'c'.repeat(64), true);
  assert.equal(sheet.subject, 'sheet');
  assert.deepEqual(sheet.metrics, object.metrics);
  assert.notEqual(sheet.why, object.why);
});

test('an unclassified row is unknown, not quietly filed with the objects', () => {
  // Null and false are different states. Collapsing them would put every row nobody has classified
  // into the studio-framing band, which is a population claim made by a missing value.
  const s = surfaceFrom(blob(flatWhite), 'w-4', 'd'.repeat(64), null);
  assert.equal(s.subject, 'unknown');
  assert.equal(s.measurable, true);
  assert.match(s.why, /nothing has said whether this is a sheet or an object/);
  assert.deepEqual(s.metrics, surfaceFrom(blob(flatWhite), 'w-4', 'd'.repeat(64), false).metrics);
});

test('no ground means no metrics whatever the subject is', () => {
  for (const twoD of [true, false, null]) {
    const s = surfaceFrom(blob(gradient), 'w-5', 'e'.repeat(64), twoD);
    assert.equal(s.metrics, null, `subject ${String(twoD)} was measured without a ground`);
    assert.match(s.why, /border is not one colour/);
    // And the reason given is the ground, not the subject: the subject never suppresses a
    // measurement, so it is never the explanation for a missing one.
    assert.doesNotMatch(s.why, /silhouette/);
  }
});

// --- what every image can answer ------------------------------------------------------------------

test('logAspect is 0 for a square, +1 for 2:1 and -1 for 1:2', () => {
  const of = (w: number, h: number) => surfaceFrom(image(w, h, flatWhite), 'a', '', true).logAspect;
  assert.equal(of(100, 100), 0);
  assert.equal(of(200, 100), 1);
  assert.equal(of(100, 200), -1);
  // The reason it is a log: 2:1 and 1:2 are the same departure from square in opposite directions,
  // and a raw ratio would call them 2 and 0.5.
  assert.equal(of(200, 100), -of(100, 200));
});

test('palette.distinct on a two-colour image is 2', () => {
  const s = surfaceFrom(blob(flatWhite), 'a', '', true);
  assert.equal(s.palette.distinct, 2);
  assert.equal(s.palette.top.length, 2);
  assert.equal(s.palette.top[0]!.hex, '#ffffff');
  assert.equal(s.palette.top[0]!.share.toFixed(3), (8 / 9).toFixed(3));
  // 8/9 of the pixels are one colour, so one of the two colours covers 90%... it does not, quite:
  // 0.888 < 0.9, so both are needed. The point of the assertion is that the answer is a count of
  // colours over the colours present, not the 0.9 it was asked to cover.
  assert.equal(s.palette.concentration, 1);
  const oneColour = surfaceFrom(image(100, 100, flatWhite), 'a', '', true);
  assert.equal(oneColour.palette.distinct, 1);
});

test('tone: the histogram sums to 1, and sd is 0 on a flat field', () => {
  const flat = surfaceFrom(image(100, 100, () => [128, 128, 128]), 'a', '', true);
  assert.equal(flat.tone.histogram.length, 16);
  assert.equal(flat.tone.histogram.reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
  assert.equal(flat.tone.sd, 0);
  const blobbed = surfaceFrom(blob(flatWhite), 'a', '', true);
  assert.ok(blobbed.tone.sd > 0);
  assert.equal(blobbed.tone.histogram.reduce((a, b) => a + b, 0).toFixed(6), '1.000000');
});

test('energy.gradient is 0 on a flat field, and a checkerboard beats a ramp', () => {
  const flat = surfaceFrom(image(100, 100, () => [200, 200, 200]), 'a', '', true);
  assert.equal(flat.energy.gradient, 0);

  const checker = surfaceFrom(image(100, 100, (x, y) => ((x + y) % 2 === 0 ? WHITE : BLACK)), 'a', '', true);
  const ramp = surfaceFrom(image(100, 100, (x) => [Math.round((255 * x) / 99), Math.round((255 * x) / 99), Math.round((255 * x) / 99)]), 'a', '', true);
  assert.ok(checker.energy.gradient > ramp.energy.gradient, `${checker.energy.gradient} vs ${ramp.energy.gradient}`);
  assert.ok(ramp.energy.gradient > 0);

  // And the thing the octaves are for: the checkerboard's variation is one pixel wide, so box
  // averaging destroys it, while the ramp's survives. This is the "fine texture vs large forms"
  // reading, and it is the only reading the profile supports.
  assert.equal(checker.energy.byOctave.length, 3);
  assert.ok(checker.energy.byOctave[0]! < checker.energy.gradient);
  assert.ok(ramp.energy.byOctave[0]! >= ramp.energy.gradient * 0.9);
});

test('byOctave is reported short rather than padded when the image cannot be halved three times', () => {
  const tiny = surfaceFrom(image(6, 6, flatWhite), 'a', '', true);
  assert.ok(tiny.energy.byOctave.length < 3, `got ${tiny.energy.byOctave.length}`);
});

// --- weight, the family that survives having no ground --------------------------------------------

test('weight is present when metrics is null, which is the whole point of it', () => {
  // All 50 works with readings in `corpus/readings/` are paintings cropped to the canvas edge, so
  // none of them has a ground and none of them will ever have `metrics`. If `weight` were gated on
  // the same condition, the only works anything downstream wants to check a spatial claim against
  // would have nothing measured on them at all.
  const s = surfaceFrom(blob(gradient), 'w-6', 'f'.repeat(64), true);
  assert.equal(s.metrics, null);
  assert.notEqual(s.weight, null);
  assert.ok(Number.isFinite(s.weight.offset) && Number.isFinite(s.weight.spread));
  assert.ok(s.weight.spread > 0, 'a gradient has contrast even where it has no ground');
});

test('weight.offset is ~0 for a deviation field symmetric about the centre, and clear for one side', () => {
  // Two bars mirrored about the vertical axis: the luminance deviation is symmetric, so its centroid
  // is the frame centre by construction and any non-zero answer is a bug in the accumulation.
  const symmetric = surfaceFrom(rects(200, 200, [[20, 60, 0, 200], [140, 180, 0, 200]]), 'a', '', true);
  assert.ok(symmetric.weight.offset < 1e-12, `symmetric field gave offset ${symmetric.weight.offset}`);

  // The same mass on one side only.
  const oneSided = surfaceFrom(rects(200, 200, [[20, 60, 0, 200]]), 'a', '', true);
  assert.ok(oneSided.weight.offset > 0.05, `one-sided field gave offset ${oneSided.weight.offset}`);
  assert.ok(oneSided.weight.offset > symmetric.weight.offset * 100 || symmetric.weight.offset === 0);
});

test('weight.spread separates two compositions that share an offset exactly', () => {
  // The two fixtures carry the SAME total dark area (so the same mean luminance, so the same
  // per-pixel weights) and the same mass centroid — one block at x 130..170, versus two half-size
  // blocks at 110..130 and 170..190 whose centroid is also 150. So their `offset` is not merely
  // close, it is the same number, and `offset` alone cannot tell them apart.
  const one = surfaceFrom(rects(200, 200, [[130, 170, 80, 120]]), 'a', '', true);
  const two = surfaceFrom(rects(200, 200, [[110, 130, 80, 120], [170, 190, 80, 120]]), 'a', '', true);

  // Assert the shared offset FIRST. Without this the test would pass on two fixtures that simply
  // differ, and would be showing nothing about what `spread` adds.
  assert.equal(one.weight.offset.toFixed(12), two.weight.offset.toFixed(12));
  assert.ok(one.weight.offset > 0, 'both are off-centre, so this is not the degenerate offset 0 case');

  // And the number that does tell them apart: the split mass sits further from its own centroid.
  assert.ok(
    two.weight.spread > one.weight.spread,
    `split ${two.weight.spread} should exceed compact ${one.weight.spread}`
  );
});

test('a flat image has no weight anywhere, and says 0 rather than inventing a position', () => {
  const flat = surfaceFrom(image(100, 100, () => [128, 128, 128]), 'a', '', true);
  assert.equal(flat.weight.offset, 0);
  assert.equal(flat.weight.spread, 0);
});

test('estimateGround reports extent as well as share, so a nearly empty image is visible', () => {
  const g = estimateGround(blob(flatWhite));
  assert.equal(g.share, 1);
  assert.equal(g.extent.toFixed(3), (8 / 9).toFixed(3));
  const empty = estimateGround(image(100, 100, flatWhite));
  assert.equal(empty.extent, 1);
});

// --- grain, the direction family ------------------------------------------------------------------

/**
 * A square of stripes running at `deg`, where `deg` is the direction the stripes THEMSELVES run —
 * the same convention `grain.angle` reports, so a test reads as the thing it is checking.
 *
 * The stripe field is a cosine rather than hard black-and-white bars, because bars alias: their
 * edges land on the pixel grid at some angles and not others, which puts a staircase into the
 * gradients and a false axis peak into the histogram. A cosine has the same direction everywhere
 * and no edges at all.
 */
function stripes(deg: number, side = 128, period = 8): Rgb {
  const rad = (deg * Math.PI) / 180;
  // The wave varies ACROSS the stripes, so its direction is a quarter turn from theirs.
  const nx = Math.sin(rad);
  const ny = -Math.cos(rad);
  return image(side, side, (x, y) => {
    const v = Math.round(128 + 100 * Math.cos((2 * Math.PI * (x * nx + y * ny)) / period));
    return [v, v, v];
  });
}

/** Left half from `a`, right half from `b`. Both must be the same size. */
function halves(a: Rgb, b: Rgb): Rgb {
  const { width, height } = a;
  return image(width, height, (x, y) => {
    const src = x < width / 2 ? a : b;
    const i = (y * width + x) * 3;
    return [src.data[i]!, src.data[i + 1]!, src.data[i + 2]!];
  });
}

const grainOfImage = (img: Rgb) => surfaceFrom(img, 'g', '', true).grain;
/** Circular distance between two orientations, which live modulo 180. */
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));

test('a flat image has no grain, and says so rather than reading a direction off rounding error', () => {
  const g = grainOfImage(image(100, 100, () => [128, 128, 128]));
  assert.equal(g.anisotropy, 0);
  assert.equal(g.angle, 0);
  assert.deepEqual(
    g.histogram.map((v) => v),
    new Array(12).fill(0)
  );
  // The trap this guards is specific: unguarded, `atan2(0, 0)` is 0 and the coherence ratio is NaN,
  // so a blank sheet would report a perfectly confident horizontal grain. Assert the absence, not
  // just the value, or a NaN would satisfy `!== 90`.
  assert.ok(Number.isFinite(g.anisotropy));
});

test('grain.angle reports the direction the marks run, on both axes and the diagonals', () => {
  for (const deg of [0, 30, 45, 90, 135, 150]) {
    const g = grainOfImage(stripes(deg));
    assert.ok(
      apart(g.angle, deg) < 3,
      `stripes at ${deg} deg read as ${g.angle.toFixed(1)}, ${apart(g.angle, deg).toFixed(1)} away`
    );
    // A pure grating is perfectly coherent, so this is near 1 at every angle including the
    // diagonals. It was 0.849 at 45 degrees while the gradients were plain forward differences —
    // that threshold would have passed had it been written as 0.84, and the systematic bias against
    // diagonal structure would have shipped. The number that made it visible is this one.
    assert.ok(g.anisotropy > 0.95, `stripes at ${deg} deg had anisotropy ${g.anisotropy.toFixed(3)}`);
  }
});

test('orientation wraps at 180, which a mean of angles gets exactly backwards', () => {
  // 10 and 170 are twenty degrees apart across the wrap, so their true average is horizontal. A
  // naive `(10 + 170) / 2` is 90 — vertical, the perpendicular of the right answer. This is the
  // whole reason `grainOf` sums a tensor instead of averaging `atan2` per pixel, so it is asserted
  // directly and not inferred from the diagonal cases above.
  const g = grainOfImage(halves(stripes(10), stripes(170)));
  assert.ok(apart(g.angle, 0) < 12, `two halves at 10 and 170 read as ${g.angle.toFixed(1)}, not ~0`);
  assert.ok(apart(g.angle, 90) > 45, 'the naive mean of 10 and 170 is 90, and that is the wrong answer');
});

test('anisotropy and the histogram answer different questions, and a crosshatch separates them', () => {
  // Two equally strong hatchings a quarter turn apart, in different PLACES. The image as a whole
  // runs no particular way, so anisotropy is near zero — and that is correct, not a failure. The
  // histogram is where the two directions are still visible, which is why both fields exist.
  //
  // They have to be side by side rather than summed. `cos(x) + cos(y)` looks like a crosshatch and
  // is not one: adding two gratings makes an egg-crate whose every local gradient points diagonally,
  // so it reads as peaks at 45 and 135. That was the first version of this test and the code was
  // right about the image.
  const g = grainOfImage(halves(stripes(0), stripes(90)));
  assert.ok(g.anisotropy < 0.25, `a crosshatch should not lean; anisotropy was ${g.anisotropy.toFixed(3)}`);

  const peaks = g.histogram
    .map((v, b) => ({ v, b }))
    .sort((p, q) => q.v - p.v)
    .slice(0, 2)
    .map((p) => p.b)
    .sort((p, q) => p - q);
  // Bin 0 is horizontal, bin 6 is vertical, at 12 bins over the half-circle.
  assert.deepEqual(peaks, [0, 6], `expected peaks at horizontal and vertical, got bins ${peaks.join(',')}`);
  assert.ok(g.anisotropy < 0.25 && axisShare(g) > 0.9, 'the crosshatch is axis-aligned even though it does not lean');
});

test('the grain histogram is a distribution, and axisShare has a chance baseline of a third', () => {
  const g = grainOfImage(stripes(45));
  const total = g.histogram.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `histogram summed to ${total}`);

  // Four of twelve bins touch an axis, so an image with no preferred direction reads 1/3. The
  // constant is asserted rather than assumed, because every reading of this field is against it.
  assert.equal(AXIS_SHARE_CHANCE.toFixed(4), (1 / 3).toFixed(4));
  // Stripes at 45 degrees are the furthest a direction can get from both axes, so they must read
  // well BELOW chance. Stated as a fraction of chance rather than as an absolute, because the
  // absolute is only readable next to the baseline: 0.11 sounds small and means nothing until you
  // know that a directionless image reads 0.33.
  assert.ok(
    axisShare(g) < AXIS_SHARE_CHANCE / 2,
    `45-degree stripes read axisShare ${axisShare(g).toFixed(4)} against ${AXIS_SHARE_CHANCE.toFixed(4)} chance`
  );
  assert.ok(axisShare(grainOfImage(stripes(0))) > 0.9, 'horizontal stripes must read far above chance');
});

// --- the batch ------------------------------------------------------------------------------------

function work(id: string, sha256: string): Work {
  return {
    id,
    source: 'cma',
    object_id: id.split('-')[1] ?? '0',
    accession_number: null,
    url: `https://example.invalid/${id}`,
    rights: 'CC0',
    title: id,
    creator: null,
    date_display: '',
    date_begin: null,
    date_end: null,
    classification: 'Textile',
    medium: '',
    culture: null,
    department: 'Textiles',
    image_url: 'https://example.invalid/i.jpg',
    image: { source_url: 'https://example.invalid/i.jpg', sha256, bytes: 1, width: null, height: null },
    fetched_at: '2026-08-31T00:00:00Z',
  };
}

test('two works sharing one sha256 become one surface, and the duplicate is counted as one', () => {
  // A museum that photographs a knife and its fork together files one photograph against both
  // catalogue records: two catalogue facts, one picture. 98 rows in this corpus are like that, and
  // letting both through has already produced a CLIP pair above 0.98 and a resemblance maximum of
  // exactly 1.0000. Here it would double-weight an image in every band the report prints.
  //
  // The sha is fabricated, so no file exists for it — and that is what makes the assertion sharp
  // rather than vacuous. Exactly ONE row reaches the file check. If the dedupe ever moved after the
  // existsSync, `no file on disk` would read 2 and `another row holds the same bytes` would read 0.
  const shared = 'e'.repeat(64);
  const r = surfaces([work('cma-1', shared), work('cma-2', shared)], () => true);
  assert.equal(r.works, 2);
  assert.equal(r.skipped['another row holds the same bytes'], 1);
  assert.equal(r.skipped['no file on disk'], 1);
  assert.equal(r.surfaces.length, 0);
  assert.equal(r.measured, 0);
});

test('a row with no image is counted under its own reason, not under the missing file', () => {
  const noImage = { ...work('cma-3', 'f'.repeat(64)), image: null };
  const r = surfaces([noImage, work('cma-4', '0'.repeat(64))], () => true);
  assert.equal(r.skipped['the manifest row has no image'], 1);
  assert.equal(r.skipped['no file on disk'], 1);
});

test('surfaceText says NOTHING MEASURED rather than printing a band over nothing', () => {
  // The failure this repo keeps finding: a gate with nothing in front of it reporting a pass. A
  // band over zero works is not a band of zero width and must not read like one.
  const empty: SurfaceReport = { works: 3, measured: 0, skipped: { 'no file on disk': 3 }, surfaces: [] };
  const text = surfaceText(empty);
  assert.match(text, /NOTHING MEASURED/);
  assert.match(text, /no constraint may/);
  assert.doesNotMatch(text, /inkDensity/);

  // And still NOTHING MEASURED one short of the threshold, which is where a band would first start
  // looking like a measurement.
  const some = Array.from({ length: MIN_MEASURED - 1 }, (_, i) =>
    surfaceFrom(blob(flatWhite), `w-${i}`, String(i), true)
  );
  const under = surfaceText({ works: some.length, measured: some.length, skipped: {}, surfaces: some });
  assert.match(under, /NOTHING MEASURED/);
  const over = surfaceText({
    works: MIN_MEASURED,
    measured: MIN_MEASURED,
    skipped: {},
    surfaces: [...some, surfaceFrom(blob(flatWhite), 'w-last', 'z', true)],
  });
  assert.doesNotMatch(over, /NOTHING MEASURED/);
  assert.match(over, /inkDensity/);
});

test('surfaceText prints the images it refused, with the reason', () => {
  const refused = Array.from({ length: 4 }, (_, i) => surfaceFrom(blob(gradient), `o-${i}`, String(i), false));
  const text = surfaceText({ works: 4, measured: 0, skipped: {}, surfaces: refused });
  assert.match(text, /images read and not measured/);
  assert.match(text, /4 {2}the border is not one colour/);
  // The always-honest fields are still printed for them: they describe the file, and the file is
  // real — including `weight`, which is the only composition family these images can answer.
  assert.match(text, /palette\.concentration/);
  assert.match(text, /logAspect/);
  assert.match(text, /weight\.offset/);
  assert.match(text, /weight\.spread/);
});

test('surfaceText never pools sheets with studio framing into one band', () => {
  // The lie the `subject` label exists to prevent. A sheet's inkDensity is a picture's marks; an
  // object's is a photographer's silhouette. One band over both would be a number about neither,
  // and it would look exactly like a measurement.
  const sheets = Array.from({ length: MIN_MEASURED }, (_, i) =>
    surfaceFrom(blob(flatWhite), `s-${i}`, `s${i}`, true)
  );
  const objects = Array.from({ length: MIN_MEASURED }, (_, i) =>
    surfaceFrom(rects(201, 201, [[20, 180, 20, 180]]), `o-${i}`, `o${i}`, false)
  );
  const all = [...sheets, ...objects];
  const text = surfaceText({ works: all.length, measured: all.length, skipped: {}, surfaces: all });

  assert.match(text, new RegExp(`sheet \\(${MIN_MEASURED}\\)`));
  assert.match(text, new RegExp(`studio-framing \\(${MIN_MEASURED}\\)`));
  // Two tables, so `inkDensity` appears twice and never once over twelve. Match the table row
  // shape, not the bare word: the studio-framing caption names `inkDensity` in prose to say what it
  // means there, and counting that line would make this assertion pass for the wrong reason.
  const inkRows = text.split('\n').filter((l) => /^\s+inkDensity\s+n=/.test(l));
  assert.equal(inkRows.length, 2, text);
  assert.ok(
    inkRows.every((l) => l.includes(`n=${String(MIN_MEASURED).padStart(5)}`)),
    `a row counted more than the ${MIN_MEASURED} in its own subject:\n${inkRows.join('\n')}`
  );
  // And the two bands really are different numbers, so pooling would have destroyed information
  // rather than merely mislabelled it.
  assert.notEqual(inkRows[0], inkRows[1]);
  assert.match(text, /never pooled/);
});

// --- the corpus, if it is here --------------------------------------------------------------------

const MANIFEST = path.join(ROOT, 'corpus', 'manifest.jsonl');
const IMAGES = path.join(ROOT, 'corpus', 'images');
/**
 * Three separate preconditions, all named, because a skip that names one missing thing while
 * silently covering two has already burned this repo — five tests reported `ok` while executing
 * nothing. The manifest is tracked and the pixels are not, so a fresh clone has the first and none
 * of the rest; and a manifest whose rows all point at absent files would satisfy the first two and
 * still measure nothing.
 */
const allRows = existsSync(MANIFEST) ? readManifest(MANIFEST).works : [];
const rows = allRows.slice(0, 400);
const hasFile = (w: Work) => {
  const rel = imagePath(w);
  return rel !== null && existsSync(path.join(ROOT, 'corpus', rel));
};
const withPixels = existsSync(IMAGES) ? rows.filter(hasFile) : [];
const noCorpus =
  rows.length === 0
    ? `corpus/manifest.jsonl is not on this machine (it is tracked; check the checkout)`
    : !existsSync(IMAGES)
      ? 'corpus/images/ does not exist on this machine; run `corpus images` (the pixels are gitignored)'
      : withPixels.length < 5
        ? `corpus/manifest.jsonl and corpus/images/ both exist, but only ${withPixels.length} of the first ${rows.length} rows have their file on disk; run \`corpus images\``
        : false;

test('a real corpus image decodes and answers the open fields', { skip: noCorpus }, () => {
  const s = surfaces(withPixels.slice(0, 5), () => false);
  assert.equal(s.surfaces.length, 5);
  for (const surface of s.surfaces) {
    assert.ok(surface.width > 0 && surface.height > 0);
    assert.ok(Number.isFinite(surface.logAspect));
    assert.ok(surface.tone.mean > 0 && surface.tone.mean <= 1);
    assert.ok(surface.palette.distinct > 1, 'a real photograph is not one flat colour');
    assert.ok(surface.energy.gradient > 0);
    assert.match(surface.ground.hex, /^#[0-9a-f]{6}$/);
    // Classified as objects here, so whatever is measured is labelled as being about the photograph.
    assert.equal(surface.subject, 'studio-framing');
    assert.equal(surface.measurable, surface.metrics !== null);
    assert.equal(surface.measurable, surface.ground.confident);
    // And `weight` is there either way, which is the property the readings depend on.
    assert.ok(Number.isFinite(surface.weight.offset) && surface.weight.offset >= 0);
    assert.ok(surface.weight.spread > 0);
  }
});

test('the corpus dedupes on real bytes: the row count exceeds the image count', { skip: noCorpus }, () => {
  // 98 of the manifest's rows share a sha256 with another row. Over the first 400 rows the number
  // found may be zero, so what is asserted is the invariant that cannot fail: never more surfaces
  // than distinct hashes.
  const some = withPixels.slice(0, 40);
  const distinct = new Set(some.map((w) => w.image!.sha256)).size;
  const r = surfaces(some, () => false);
  assert.ok(r.surfaces.length <= distinct, `${r.surfaces.length} surfaces over ${distinct} distinct hashes`);
  assert.equal(r.works, some.length);
  assert.equal(r.skipped['another row holds the same bytes'] ?? 0, some.length - distinct);
});

test('the image directory the corpus tests read is the one the manifest names', { skip: noCorpus }, () => {
  // Cheap, and it is the check that would have caught `corpus/works/` — a directory that had been
  // deleted, read by a metric that reported numbers anyway.
  assert.ok(readdirSync(IMAGES).some((n) => n.endsWith('.jpg')));
});

const READINGS = path.join(ROOT, 'corpus', 'readings');
const readingIds = existsSync(READINGS)
  ? new Set(readdirSync(READINGS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')))
  : new Set<string>();
const readWorks = allRows.filter((w) => readingIds.has(w.id) && existsSync(IMAGES) && hasFile(w));
/**
 * Four preconditions, each named separately. The manifest is tracked, `corpus/images/` is not,
 * `corpus/readings/` is a third thing that can be absent on its own, and a readings file whose work
 * has no pixels here satisfies the first three while measuring nothing. Naming one of the four while
 * covering all four is how five tests in this repo once reported `ok` while executing nothing.
 */
const noReadings =
  allRows.length === 0
    ? 'corpus/manifest.jsonl is not on this machine (it is tracked; check the checkout)'
    : !existsSync(IMAGES)
      ? 'corpus/images/ does not exist on this machine; run `corpus images` (the pixels are gitignored)'
      : readingIds.size === 0
        ? 'corpus/readings/ holds no .json readings on this machine'
        : readWorks.length === 0
          ? `corpus/readings/ names ${readingIds.size} work(s) and none of them has its image file under corpus/images/; run \`corpus images\``
          : false;

test('the works with readings have no ground, and weight is what is left', { skip: noReadings }, () => {
  // The measured claim this whole family exists for. These 50 CMA works are the only ones anything
  // downstream can check a spatial reading against ("placed slightly off-center"), and a painting is
  // cropped to its canvas edge, so it has no ground by construction. If this test ever starts
  // finding confident grounds here, either the estimator has loosened or the readings set has
  // changed — and either way the band printed for these works means something different.
  assert.equal(readWorks.length, readingIds.size, 'every work with a reading should have pixels here');
  const r = surfaces(readWorks, () => true);
  assert.equal(r.surfaces.length, readWorks.length);

  const grounded = r.surfaces.filter((s) => s.ground.confident);
  assert.equal(grounded.length, 0, `${grounded.length} of ${r.surfaces.length} paintings claimed a ground`);
  assert.equal(r.measured, 0);
  assert.ok(r.surfaces.every((s) => s.metrics === null));

  // And every one of them still answers the ground-free family.
  assert.ok(r.surfaces.every((s) => Number.isFinite(s.weight.offset) && s.weight.spread > 0));
  assert.match(surfaceText(r), /NOTHING MEASURED/);
  assert.match(surfaceText(r), /weight\.offset/);
});
