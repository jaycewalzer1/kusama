// The corpus, measured in the units the aesthetic layer actually checks — where that is honest, and
// a refusal where it is not.
//
// Every constraint this repo can decide at render scope is stated in `RenderMetrics` units:
// `inkDensityRange`, `coverageRange`, `inkOffsetRange`, `symmetryMax`, `edgeContactRange`. Nothing
// in the 19,807-image museum corpus has ever been measured in those units. So a hand-authored bound
// like `inkDensityRange {min: 0.35}` in `aesthetic/elements/pack/kuba-shoowa-surface.json` — "below
// about a third the ground is still reading as ground" — is a guess with a good paragraph attached
// to it. The paragraph is not the problem. The problem is that the number could have been measured
// off the cloth and was not, and nothing on disk can tell the two cases apart. This file is what
// would let such a number be measured.
//
// ## The 77% problem, and why the answer is a label and not a refusal
//
// 77% of the manifest is objects photographed against a studio backdrop: sculpture, jewelry,
// metalwork, ceramic, glass, vessels, coins. Only about 22.6% — 4,522 of 20,000 rows — is
// two-dimensional work on a sheet.
//
// On an object photograph every render-scope descriptor changes its subject without changing its
// name. `inkDensity` becomes the share of the frame the object's silhouette occupies against the
// photographer's seamless paper. `inkOffset` becomes where in the frame the photographer set the
// object down. `edgeContact` becomes how tightly the shot was cropped. `symmetry` becomes whether
// the object was shot square-on. Those are facts about museum studio convention rather than about a
// picture.
//
// They are still facts, and they are measured here rather than refused. `subject` says which of the
// two kinds of fact a row's `metrics` are: `'sheet'` means what the aesthetic layer means by those
// words, `'studio-framing'` means the same arithmetic performed on a photographic convention.
//
// Refusing them was the first design and it was wrong, for a reason this repo has already paid for
// once. The only way to later ask *how much of the corpus's apparent structure is the photography
// department* is to have measured the photography department. That confound is not hypothetical
// here: the metadata atlas found `file:have-pixels` loading on its first axis about as heavily as
// `source:met` — a large part of the strongest structure in the map turned out to be an artefact of
// a download that had not happened. Studio framing is the same class of error and this is the only
// handle on it. The danger was never the measurement. It was the *unlabelled* measurement, which is
// the shape of the mistake made here before: a resemblance metric reporting numbers off a directory
// that had been deleted. It never said it could not answer. It answered.
//
// So `metrics` is null on exactly one condition — no confident ground (see `estimateGround` in
// ./pixels.ts) — `measurable` means `metrics !== null`, `subject` says what the numbers are about,
// and `why` is always populated, including when the answer is yes, so nothing has to infer a reason
// from a null. **`surfaceText` never pools `'sheet'` with `'studio-framing'` into one band.**
// Pooling them is precisely the lie the label exists to prevent.
//
// ## The works that matter most have no ground at all
//
// The 50 CMA works with blind readings in `corpus/readings/` are the only works in this corpus that
// anything downstream is going to check a spatial claim against — a reading says "placed slightly
// off-center" or "a triangular arrangement" and something has to ask the pixels. All 50 are
// paintings, and **not one of them has a confident ground** (median border share 0.290, measured at
// a tolerance looser than the one used here, so it is worse than that at ours). This is not a
// failure of the estimator. A painting is cropped to its canvas edge; it has no ground by
// construction, and there is nothing for `inkDensity` to be a density *of*.
//
// Hence `weight`, which is defined for every image whether or not a ground exists, and is measured
// against the image's own mean luminance instead. It is a different quantity from `inkOffset` and
// must never be substituted for it; see the field's own comment, which is the load-bearing one.
//
// ## What that leaves, measured rather than guessed at (2026-08-31)
//
// Over 200 two-dimensional works sampled by stride, only **10%** have a border uniform enough to
// call a ground at the tolerance the ink test uses (median border share 0.380; p90 0.888, just under
// the line). Loosening the tolerance to 16 takes it to 17%, to 24 takes it to 30% — and each of
// those admits an image whose backdrop the metrics will then read as ink, which is why the tolerance
// is pinned to the ink threshold and not tuned to the pass rate. See GROUND_TOLERANCE in ./pixels.ts.
//
// So roughly one 2D work in ten yields a `'sheet'` measurement — around 330 of the 3,276 that have
// pixels on this machine. Objects pass the ground test far more often, because seamless paper is
// what a studio backdrop *is*; that is why `'studio-framing'` is the larger population and why
// keeping the two bands apart matters more than it would if they were the same size. The
// classification behind those shares was ad hoc, so treat them as the right order of magnitude and
// not as the census.
//
// ## What every image can answer
//
// `logAspect`, `tone`, `palette`, `energy` and `weight` are computed for everything, objects
// included, and they are honest about a photograph on their own terms: the aspect is the
// photograph's shape, the
// tonal spread and the colour distribution are properties of the bytes that exist. They are not
// laundered into composition. In particular **`palette` on an object shot includes the backdrop**,
// which is usually the largest single colour in the frame, and `tone.mean` on such a shot is mostly
// the paper's brightness. Read them as a description of the image file. They are not a description
// of the artwork, and the fact that they are still meaningful is the reason they are separated from
// `metrics` rather than merged with them.
//
// Everything here is a pure function of the bytes. No model, no network, no API key.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import type { RenderMetrics } from '../aesthetic/types.js';
import { inkMapRgb, metricsFromInk } from '../aesthetic/metrics.js';
import { evenSample } from './atlas.js';
import { quantile } from './envelope.js';
import { imagePath, type Work } from './manifest.js';
import { decode, estimateGround, type Ground, type Rgb } from './pixels.js';

/** Tone is binned this coarsely on purpose; 256 bins over a JPEG is a histogram of its noise. */
const TONE_BINS = 16;
/** Bits per channel kept when counting colours. 4 bits gives 4,096 possible quantised colours. */
const PALETTE_BITS = 4;
/** How many quantised colours `palette.top` reports. */
const PALETTE_TOP = 8;
/** The share of pixels `palette.concentration` measures the cost of covering. */
const PALETTE_COVER = 0.9;
/** Halvings of resolution in `energy.byOctave`. */
const OCTAVES = 3;
/** Bins in `grain.histogram`, over the half-circle. 12 bins is one every 15 degrees. */
const GRAIN_BINS = 12;
/**
 * Floor on the structure tensor's trace, below which the image is called directionless.
 *
 * The same class of guard as `weightOf`'s `total < 1/255` and for the same reason: on a flat field
 * every gradient is zero, the tensor is all zeros, and both the coherence ratio and `atan2(0, 0)`
 * are 0/0. Unguarded, `atan2` returns 0 and the ratio returns NaN — an image would report a
 * confident horizontal grain read off nothing. The trace is a sum of squared luminance differences,
 * so one pixel pair differing by a single 8-bit level contributes `(1/255)^2`; anything with real
 * content clears this by orders of magnitude.
 */
const GRAIN_FLOOR = 1 / 255 ** 2;

/**
 * Below this many measurable works, no band is printed.
 *
 * Six, deliberately the same number as `MIN_POINTS` in ./envelope.ts and for the same argument: a
 * band is read for its edges, the edges of a sample are the least stable thing in it, and six is the
 * fewest that makes a p90 mean anything at all — it is the fifth of six. Six is a floor on printing
 * a band, not a sample anybody should author a constraint from. A bound taken to the elements pack
 * wants hundreds of sheets behind it, and `surfaceText` prints the count on every line so the reader
 * can see which of those two situations they are in.
 */
export const MIN_MEASURED = 6;

export interface Surface {
  id: string;
  sha256: string;
  width: number;
  height: number;
  /** log2(width/height). 0 is square; sign says which way it is long. Log so 2:1 and 1:2 are symmetric. */
  logAspect: number;
  ground: Ground;
  /** 16 buckets of perceived luminance over the whole image, summing to 1. */
  tone: { mean: number; sd: number; histogram: number[] };
  palette: {
    /** Distinct colours after quantising to 4 bits per channel (so 4096 possible). */
    distinct: number;
    /**
     * How many of the distinct quantised colours it takes to cover 90% of the pixels, as a share of
     * the distinct colours present. 0.02 means one colour in fifty carries nine tenths of the image;
     * 0.9 means the colour is spread thin across nearly everything present.
     *
     * Stated as a share of colours and not as a share of pixels, because the share of pixels in a
     * set chosen to cover 90% of the pixels is 90% by construction — a number that would look like a
     * measurement and vary with nothing.
     */
    concentration: number;
    top: { hex: string; share: number }[];
  };
  /** Mean absolute luminance gradient, overall and at three halvings of resolution. */
  energy: { gradient: number; byOctave: number[] };
  /**
   * Which way the marks run, and how much they agree about it. Defined for every image, like
   * `weight` and unlike `metrics`, because it needs no ground.
   *
   * `anisotropy` is 0 when direction is spread evenly and 1 when every edge in the image runs the
   * same way. `angle` is the direction the structure *runs* in degrees, 0 horizontal and 90
   * vertical, measured anticlockwise from the x-axis and reported in [0, 180) because a line has no
   * arrowhead. `histogram` is `GRAIN_BINS` bins over that same half-circle, weighted by gradient
   * magnitude and summing to 1.
   *
   * **`anisotropy` and `histogram` answer different questions and neither substitutes for the
   * other.** `anisotropy` is one tensor over the whole image, so two equally strong hatchings at
   * +45 and -45 cancel to near zero — correctly, since the image as a whole runs no particular way,
   * but that is not the same as "no direction in it". The histogram is where that image shows two
   * peaks. Read `anisotropy` as *does the whole sheet lean*, and the histogram as *what directions
   * are present at all*.
   *
   * **On a `studio-framing` row this is mostly the photograph.** A rectangular object on seamless
   * paper puts a strong horizontal and vertical edge into the frame no matter what its surface
   * does, so the histogram piles at the 0 and 90 bins for a reason that belongs to the photography
   * department. Never pool this across `subject`, for exactly the reason `metrics` is never pooled.
   *
   * It is also not a measure of texture, weave, or hand. A halftone screen, a canvas weave, a
   * scanner's banding and a deliberate hatch are indistinguishable here; all four are edges that
   * agree about direction.
   */
  grain: { anisotropy: number; angle: number; histogram: number[] };
  /**
   * Where the visual weight sits, measured against the image's own mean luminance rather than
   * against a ground. Defined for EVERY image, including one with no ground at all.
   *
   * This is NOT `RenderMetrics.inkOffset` and must never be compared with it, averaged with it, or
   * substituted for it. `inkOffset` weights by distance from a known paper colour and answers
   * "where are the marks"; this weights by distance from the image's own average and answers "where
   * is the contrast". On a plate with a real ground they nearly agree. On a painting only this one
   * exists — all 50 works with readings in `corpus/readings/` are paintings and none of them has a
   * ground, which is the reason this field exists.
   *
   * **Read it as a percentile of the corpus band, never as an absolute.** Measured over 600
   * stride-sampled distinct corpus images: `offset` min 0.001, p10 0.011, median 0.041, p90 0.127,
   * max 0.236. Those numbers are small and tightly clustered, so "0.09" tells a person nothing
   * while "above the 80th percentile of the corpus" tells them what they asked. This is the same
   * discipline `artist/resemblance.ts` applies to raw cosines against its `CorpusBaseline`, and for
   * the same reason: a number whose whole range is narrow and off-zero is unreadable raw.
   */
  weight: { offset: number; spread: number };
  /** Null unless `measurable` — the metrics that are commensurable with a rendered plate. */
  metrics: Omit<RenderMetrics, 'pixelHash'> | null;
  /**
   * What the metrics in `metrics` are actually about. Never inferred from the numbers themselves.
   *
   * `'sheet'` — a 2D work on a confident ground; `metrics` means what the aesthetic layer thinks it
   * means. `'studio-framing'` — an object on a confident ground; the numbers are real measurements
   * *of the photograph*, where `inkDensity` is the object's silhouette share of the frame and
   * `inkOffset` is where the photographer placed it. `'unknown'` — nothing has said which, so
   * nothing may be concluded about which.
   *
   * The label comes from the caller's classification and from nowhere else. Deriving it from the
   * metrics — "a low inkDensity on a pale ground is probably an object" — would make the label a
   * restatement of the numbers it is supposed to qualify, and every band would then be
   * self-confirming.
   */
  subject: 'sheet' | 'studio-framing' | 'unknown';
  /** True exactly when `metrics !== null`. */
  measurable: boolean;
  /**
   * Always present. When `measurable` is false this says which test failed, in plain words; when it
   * is true it says what the numbers are about, so a reader of one surface does not have to know
   * the `subject` vocabulary to be warned.
   */
  why: string;
}

// --- the always-honest descriptors ------------------------------------------------------------

/**
 * Rec.709 weights on the stored bytes, not on linearised light.
 *
 * Deliberate: every consumer of this number compares it with another number from the same function,
 * and gamma-decoding first would make the histogram a description of photons rather than of the
 * file. It also means `tone.mean` is not a photometric quantity and must not be reported as one.
 */
function luminance(data: Uint8Array, i: number): number {
  return (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
}

function toneOf(img: Rgb): Surface['tone'] {
  const n = img.width * img.height;
  const histogram = new Array<number>(TONE_BINS).fill(0);
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < n; p++) {
    const l = luminance(img.data, p * 3);
    sum += l;
    sumSq += l * l;
    histogram[Math.min(TONE_BINS - 1, Math.floor(l * TONE_BINS))]!++;
  }
  const mean = n === 0 ? 0 : sum / n;
  // Population sd, not sample: this is every pixel in the image, not a draw from a larger set of
  // pixels the image might have had.
  const variance = n === 0 ? 0 : Math.max(0, sumSq / n - mean * mean);
  return { mean, sd: Math.sqrt(variance), histogram: histogram.map((c) => (n === 0 ? 0 : c / n)) };
}

function paletteOf(img: Rgb): Surface['palette'] {
  const n = img.width * img.height;
  const shift = 8 - PALETTE_BITS;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let p = 0; p < n; p++) {
    const i = p * 3;
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    const key = ((r >> shift) << (2 * PALETTE_BITS)) | ((g >> shift) << PALETTE_BITS) | (b >> shift);
    const cell = counts.get(key);
    if (cell === undefined) counts.set(key, { n: 1, r, g, b });
    else {
      cell.n++;
      cell.r += r;
      cell.g += g;
      cell.b += b;
    }
  }

  // Sorted by count, ties by quantised key, so the order does not depend on the scan order.
  const sorted = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]);
  let covered = 0;
  let needed = 0;
  for (const [, cell] of sorted) {
    if (covered / Math.max(1, n) >= PALETTE_COVER) break;
    covered += cell.n;
    needed++;
  }
  const two = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return {
    distinct: sorted.length,
    concentration: sorted.length === 0 ? 0 : needed / sorted.length,
    top: sorted.slice(0, PALETTE_TOP).map(([, c]) => ({
      hex: `#${two(c.r / c.n)}${two(c.g / c.n)}${two(c.b / c.n)}`,
      share: c.n / Math.max(1, n),
    })),
  };
}

/** Mean absolute forward difference in luminance, over both axes at once. 0 on a flat field. */
function gradientOf(lum: Float64Array, width: number, height: number): number {
  let total = 0;
  let pairs = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = lum[y * width + x]!;
      if (x + 1 < width) {
        total += Math.abs(lum[y * width + x + 1]! - at);
        pairs++;
      }
      if (y + 1 < height) {
        total += Math.abs(lum[(y + 1) * width + x]! - at);
        pairs++;
      }
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

/** 2x2 box, dropping an odd last row or column rather than replicating it into an invented pixel. */
function halve(lum: Float64Array, width: number, height: number): { lum: Float64Array; width: number; height: number } {
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = lum[2 * y * width + 2 * x]!;
      const b = lum[2 * y * width + 2 * x + 1]!;
      const c = lum[(2 * y + 1) * width + 2 * x]!;
      const d = lum[(2 * y + 1) * width + 2 * x + 1]!;
      out[y * w + x] = (a + b + c + d) / 4;
    }
  }
  return { lum: out, width: w, height: h };
}

/**
 * Gradient at full resolution and at each halving.
 *
 * **What a profile means.** A profile that falls steeply from octave to octave is an image whose
 * variation lives at the pixel scale and averages away — fine texture, a weave, film grain, JPEG
 * noise. A profile that holds up is an image with large forms in it: a variation that survives
 * having four pixels averaged into one is a variation bigger than four pixels.
 *
 * **What it does not mean, and this matters more.** It is not a measure of detail, complexity,
 * business or interest, and it says nothing whatever about what the marks are of. A photograph of a
 * rough textile and a photograph of the same textile out of focus differ here; a masterpiece and a
 * scan of a noisy blank sheet can agree. It is also not scale-invariant in the way the name
 * "octave" invites: these images are not a common size, so octave 1 of a 4,000px photograph and
 * octave 1 of a 600px one are different physical scales, and comparing them across the corpus
 * compares two different questions. `byOctave` is shorter than three entries when the image is too
 * small to halve that many times — reported short rather than padded, because a padded entry would
 * be a measurement of nothing.
 */
function energyOf(img: Rgb): Surface['energy'] {
  const n = img.width * img.height;
  const lum = new Float64Array(n);
  for (let p = 0; p < n; p++) lum[p] = luminance(img.data, p * 3);

  const gradient = gradientOf(lum, img.width, img.height);
  const byOctave: number[] = [];
  let level = { lum, width: img.width, height: img.height };
  for (let o = 0; o < OCTAVES; o++) {
    if (level.width < 2 || level.height < 2) break;
    level = halve(level.lum, level.width, level.height);
    byOctave.push(gradientOf(level.lum, level.width, level.height));
  }
  return { gradient, byOctave };
}

/**
 * The structure tensor of the luminance gradients, summarised.
 *
 * **Why a tensor and not a mean of angles.** Orientation is a quantity modulo 180 degrees: a stroke
 * at 10 degrees and a stroke at 170 are twenty degrees apart, not a hundred and sixty, and the mean
 * of the two is horizontal rather than the vertical that averaging 10 and 170 produces. Summing
 * `Gx^2`, `Gy^2` and `Gx*Gy` and taking `atan2` of the combination is the doubled-angle average that
 * makes the wrap-around come out right, and it is the reason this is not four lines of `Math.atan2`
 * in a loop. The same doubling is why `coherence` falls out for free: it is the length of the
 * doubled-angle resultant over its total, which is exactly "how much do these directions agree".
 *
 * Gradients are differences over a 2x2 cell rather than forward differences, so that both components
 * are sampled at the same point; see the loop. Any remaining bias toward the axis bins is left in
 * rather than filtered out, because a filter here would be a choice about what a diagonal is worth,
 * made once and invisible afterwards. It is small against the frame effect described on the field,
 * which pushes the same way and is much larger.
 */
function grainOf(img: Rgb): Surface['grain'] {
  const { width, height, data } = img;
  const histogram = new Array<number>(GRAIN_BINS).fill(0);
  const flat = { anisotropy: 0, angle: 0, histogram: histogram.map(() => 0) };
  if (width < 2 || height < 2) return flat;

  const n = width * height;
  const lum = new Float64Array(n);
  for (let p = 0; p < n; p++) lum[p] = luminance(data, p * 3);

  let jxx = 0;
  let jyy = 0;
  let jxy = 0;
  let weight = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      // Both differences are averaged over the 2x2 cell so that they are sampled at the SAME point,
      // its centre. A plain forward difference puts `gx` half a pixel right of `gy`, which reads
      // the two at different phases of any fine pattern and decorrelates them: a pure 45-degree
      // grating, which should be perfectly coherent, measured 0.849 that way and measures 1.0000
      // this way. The error is worst exactly on the diagonals, so it was a systematic bias against
      // diagonal structure rather than noise.
      const tl = lum[y * width + x]!;
      const tr = lum[y * width + x + 1]!;
      const bl = lum[(y + 1) * width + x]!;
      const br = lum[(y + 1) * width + x + 1]!;
      const gx = (tr - tl + (br - bl)) / 2;
      const gy = (bl - tl + (br - tr)) / 2;
      jxx += gx * gx;
      jyy += gy * gy;
      jxy += gx * gy;

      // The gradient points across the edge; the structure runs along it, a quarter turn away.
      // `atan2(gx, -gy)` is `atan2(gy, gx) + 90` folded into one call.
      const mag = Math.hypot(gx, gy);
      if (mag === 0) continue;
      let a = Math.atan2(gx, -gy);
      if (a < 0) a += Math.PI;
      if (a >= Math.PI) a -= Math.PI;
      histogram[Math.min(GRAIN_BINS - 1, Math.floor((a / Math.PI) * GRAIN_BINS))]! += mag;
      weight += mag;
    }
  }

  const trace = jxx + jyy;
  if (trace < GRAIN_FLOOR || weight === 0) return flat;

  // Coherence of the doubled-angle resultant: 0 when the two tensor eigenvalues are equal (no
  // direction is preferred) and 1 when one of them is zero (every edge runs the same way).
  const anisotropy = Math.hypot(jxx - jyy, 2 * jxy) / trace;
  // Halved because the tensor works in doubled angles; +90 degrees for the same gradient-to-tangent
  // quarter turn the histogram makes.
  let angle = (0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180) / Math.PI + 90;
  angle = ((angle % 180) + 180) % 180;

  return { anisotropy, angle, histogram: histogram.map((v) => v / weight) };
}

/**
 * The share of gradient magnitude running within 15 degrees of horizontal or vertical.
 *
 * `grain.angle` cannot be banded across a corpus — it is circular, and the median of a wrap-around
 * quantity is not a direction anything has. This is the scalar that can: four of the `GRAIN_BINS`
 * bins touch an axis, so **an image with no preferred direction reads 4/12 = 0.3333, and that is the
 * chance baseline every reading here is against.** Above it means axis-aligned structure — a weave,
 * a rule, a hatch squared to the sheet, or, far more often in this corpus, the edge of the object
 * and the edge of the photograph.
 */
export function axisShare(grain: Surface['grain']): number {
  const h = grain.histogram;
  if (h.length !== GRAIN_BINS) return 0;
  const near = GRAIN_BINS / 12;
  let sum = 0;
  for (let b = 0; b < GRAIN_BINS; b++) {
    const centre = ((b + 0.5) / GRAIN_BINS) * 180;
    const toAxis = Math.min(centre, Math.abs(centre - 90), 180 - centre);
    if (toAxis <= 15 * near) sum += h[b]!;
  }
  return sum;
}

/** The chance value of `axisShare` on an image with no preferred direction. */
export const AXIS_SHARE_CHANCE = 4 / GRAIN_BINS;

/**
 * The luminance-deviation centroid and how far the deviation lies from it.
 *
 * The weight is `|L - mean L|`, which has one property worth stating because it is easy to misread
 * the numbers without it: the total weight above the mean always equals the total weight below it,
 * so a small dark mark on a large pale sheet carries exactly as much weight as the whole sheet does.
 * That is the intended behaviour — a mark on paper should not be outvoted by the paper — but it also
 * means `offset` is pulled halfway toward the frame centre by the background, which is a large part
 * of why the corpus band is as narrow as it is.
 *
 * `spread` is the weighted mean radius about the CENTROID, not about the frame centre. About the
 * centre it would simply re-encode `offset` — an off-centre compact mass would read as "spread" —
 * and the two numbers would be one number twice. About the centroid, `offset` says where the weight
 * is and `spread` says whether it is one thing or several, which is the distinction the field
 * exists for: `offset` alone cannot tell two masses balanced either side of the centre from one
 * mass sitting on it, and those are opposite compositions.
 *
 * Both are normalised by the centre-to-corner distance, exactly as `inkOffset` is, so the two are on
 * the same scale. They are still not the same quantity and must not be pooled.
 */
function weightOf(img: Rgb): Surface['weight'] {
  const { width, height, data } = img;
  const n = width * height;
  if (n === 0) return { offset: 0, spread: 0 };

  let sum = 0;
  for (let p = 0; p < n; p++) sum += luminance(data, p * 3);
  const mean = sum / n;

  let total = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = Math.abs(luminance(data, (y * width + x) * 3) - mean);
      if (w === 0) continue;
      total += w;
      sx += w * (x + 0.5);
      sy += w * (y + 0.5);
    }
  }
  // A perfectly flat image has no deviation anywhere. 0 for both, the same convention `inkOffset`
  // uses for a blank sheet: no weight is not weight at the centre, but it is the only answer that
  // does not invent a position.
  //
  // The floor is not `=== 0`, and that is load-bearing. Summing millions of identical luminances
  // left-to-right drifts by ~1e-13 per pixel, so a genuinely uniform image arrives here with a
  // `total` around 1e-9 rather than 0 — and the centroid of arithmetic noise is the frame centre,
  // which makes `offset` look right while `spread` reports the mean radius of a uniform field
  // (~0.54). That is a fabricated composition read off the rounding error.
  //
  // One 8-bit level is the smallest difference the input can actually encode, so an image with any
  // content at all clears this by orders of magnitude: a single pixel one level off the mean already
  // contributes 1/255. Nothing real is thrown away, and no noise gets through.
  if (total < 1 / 255) return { offset: 0, spread: 0 };

  const corner = Math.hypot(width / 2, height / 2);
  const cx = sx / total;
  const cy = sy / total;

  let radius = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = Math.abs(luminance(data, (y * width + x) * 3) - mean);
      if (w === 0) continue;
      radius += w * Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    }
  }

  return {
    offset: Math.hypot(cx - width / 2, cy - height / 2) / corner,
    spread: radius / total / corner,
  };
}

// --- one image ------------------------------------------------------------------------------------

const GROUND_WHY =
  'the border is not one colour, so there is no ground to measure ink against — a mount, a frame ' +
  'or a lit gradient reads as ink over the whole backdrop';

const SUBJECT_WHY: Record<Surface['subject'], string> = {
  sheet: 'a sheet: these metrics mean what the aesthetic layer means by them',
  'studio-framing':
    'an object photographed against a backdrop — these metrics are about the photograph, where ' +
    "inkDensity is the silhouette's share of the frame and inkOffset is where the photographer " +
    'placed it',
  unknown:
    'nothing has said whether this is a sheet or an object, so what these metrics are about is ' +
    'unknown and no band may be built from them',
};

/**
 * A surface from pixels already in hand.
 *
 * Split out from `surfaceOf` so that everything this file claims about what its numbers mean can be
 * tested against images built in memory, with no corpus, no manifest and no bytes on disk. A test
 * that needs a museum to run is a test that does not run on a fresh clone.
 *
 * `twoDimensional` is `null` when nobody has classified the row. Null and false are different
 * states — "an object" and "unknown" support different conclusions — and collapsing them would let
 * an unclassified row fall silently into the studio-framing band.
 */
export function surfaceFrom(img: Rgb, id: string, sha256: string, twoDimensional: boolean | null): Surface {
  const ground = estimateGround(img);
  // One condition, and it is about the pixels: without a ground there is no ink, so there are no
  // metrics. What the metrics are ABOUT is a separate question, answered by `subject` and never
  // allowed to suppress the measurement.
  const measurable = ground.confident;
  const subject: Surface['subject'] =
    twoDimensional === null ? 'unknown' : twoDimensional ? 'sheet' : 'studio-framing';

  const metrics = measurable
    ? metricsFromInk(inkMapRgb(img.data, img.width, img.height, ground.hex), img.width, img.height)
    : null;

  const border = `${(ground.share * 100).toFixed(1)}% of the border is ${ground.hex}`;

  return {
    id,
    sha256,
    width: img.width,
    height: img.height,
    logAspect: Math.log2(img.width / img.height),
    ground,
    tone: toneOf(img),
    palette: paletteOf(img),
    energy: energyOf(img),
    grain: grainOf(img),
    weight: weightOf(img),
    metrics,
    subject,
    measurable,
    why: measurable ? `${SUBJECT_WHY[subject]} (${border})` : `${GROUND_WHY} (${border})`,
  };
}

/**
 * One image file, measured.
 *
 * `twoDimensional` is a parameter and not a lookup: deciding whether a manifest row is a work on a
 * sheet is a reading of museum vocabulary, it belongs to whatever owns that vocabulary, and wiring
 * it in here would make this file's answer depend on a classifier it does not own and cannot test.
 */
export function surfaceOf(file: string, work: Work, twoDimensional: boolean | null): Surface {
  return surfaceFrom(decode(file), work.id, work.image?.sha256 ?? '', twoDimensional);
}

// --- the batch ------------------------------------------------------------------------------------

export interface SurfaceReport {
  works: number;
  measured: number;
  skipped: Record<string, number>;
  surfaces: Surface[];
}

const NO_IMAGE = 'the manifest row has no image';
const DUPLICATE = 'another row holds the same bytes';
const NO_FILE = 'no file on disk';
const UNREADABLE = 'the file did not decode';
const NOT_SAMPLED = 'not in the stride sample';

/**
 * Every work that can be measured, measured; every one that cannot, counted by reason.
 *
 * **Deduplication by `image.sha256` happens before anything else and is not optional.** 98 of these
 * manifest rows share their bytes with another row, because a museum that photographs a knife and
 * its fork together files one photograph against both catalogue records. Two rows on one photograph
 * are two catalogue facts and one picture. Letting both through has already produced two wrong
 * answers in this repo — a CLIP pair above 0.98 that was one image against itself, and a
 * resemblance baseline whose maximum was exactly 1.0000 — and here it would silently double-weight
 * an image in every band this file prints.
 *
 * `sampleSize` strides rather than truncating, for the reason `evenSample` exists: the manifest is
 * written grouped by source, so the first N rows are one museum and a prefix would report that
 * museum's photographic conventions as the corpus's.
 */
export function surfaces(
  works: Work[],
  isTwoD: (w: Work) => boolean | null,
  sampleSize?: number
): SurfaceReport {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  const seen = new Set<string>();
  const candidates: { work: Work; file: string }[] = [];
  for (const w of works) {
    const rel = imagePath(w);
    if (rel === null || w.image === null) {
      skip(NO_IMAGE);
      continue;
    }
    if (seen.has(w.image.sha256)) {
      skip(DUPLICATE);
      continue;
    }
    seen.add(w.image.sha256);
    const file = path.join(ROOT, 'corpus', rel);
    if (!existsSync(file)) {
      skip(NO_FILE);
      continue;
    }
    candidates.push({ work: w, file });
  }

  const chosen = sampleSize === undefined ? candidates : evenSample(candidates, sampleSize);
  if (chosen.length < candidates.length) skipped[NOT_SAMPLED] = candidates.length - chosen.length;

  const out: Surface[] = [];
  for (const c of chosen) {
    // A truncated or malformed JPEG throws inside the decoder. Counted under its own reason rather
    // than folded into "no file on disk": a file that is present and unreadable is a different fact
    // about this machine than a file that was never fetched, and one reason covering two states is
    // how a census stops being evidence.
    try {
      out.push(surfaceOf(c.file, c.work, isTwoD(c.work)));
    } catch {
      skip(UNREADABLE);
    }
  }

  return { works: works.length, measured: out.filter((s) => s.metrics !== null).length, skipped, surfaces: out };
}

// --- inspection -------------------------------------------------------------------------------------

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '   -  ');

function band(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  return [
    `  ${pad(label, 22)}`,
    `n=${String(sorted.length).padStart(5)}`,
    ` min ${num(sorted[0]!)}`,
    ` p10 ${num(quantile(sorted, 0.1))}`,
    ` med ${num(quantile(sorted, 0.5))}`,
    ` p90 ${num(quantile(sorted, 0.9))}`,
    ` max ${num(sorted[sorted.length - 1]!)}`,
  ].join('');
}

/** The fields every image can answer, object photographs included. */
const OPEN_FIELDS: { label: string; of: (s: Surface) => number }[] = [
  { label: 'logAspect', of: (s) => s.logAspect },
  { label: 'tone.mean', of: (s) => s.tone.mean },
  { label: 'tone.sd', of: (s) => s.tone.sd },
  { label: 'palette.distinct', of: (s) => s.palette.distinct },
  { label: 'palette.concentration', of: (s) => s.palette.concentration },
  { label: 'energy.gradient', of: (s) => s.energy.gradient },
  // Two rows, not three: `grain.angle` has no band. It is a direction on a circle, so its median
  // over a corpus is the median of a wrap-around quantity and means nothing — a corpus of purely
  // horizontal and purely vertical images would report 45 degrees, a direction none of them has.
  // The distribution of angles is a real question and `corpus surface` is not where it gets asked.
  { label: 'grain.anisotropy', of: (s) => s.grain.anisotropy },
  { label: 'grain.axisShare', of: (s) => axisShare(s.grain) },
  // Printed here, in the always-honest table, because it is defined for every image whether or not
  // a ground exists — which is the entire reason it exists. It is NOT a RenderMetrics field and is
  // deliberately nowhere near the inkOffset row.
  { label: 'weight.offset', of: (s) => s.weight.offset },
  { label: 'weight.spread', of: (s) => s.weight.spread },
  { label: 'ground.share', of: (s) => s.ground.share },
  { label: 'ground.extent', of: (s) => s.ground.extent },
];

/** The RenderMetrics fields, which only a measurable surface has. */
const METRIC_FIELDS: { label: string; of: (m: Omit<RenderMetrics, 'pixelHash'>) => number }[] = [
  { label: 'inkDensity', of: (m) => m.inkDensity },
  { label: 'coverage', of: (m) => m.coverage },
  { label: 'inkOffset', of: (m) => m.inkOffset },
  { label: 'symmetry.vertical', of: (m) => m.symmetry.vertical },
  { label: 'symmetry.horizontal', of: (m) => m.symmetry.horizontal },
  { label: 'edgeContact.top', of: (m) => m.edgeContact.top },
  { label: 'edgeContact.right', of: (m) => m.edgeContact.right },
  { label: 'edgeContact.bottom', of: (m) => m.edgeContact.bottom },
  { label: 'edgeContact.left', of: (m) => m.edgeContact.left },
];

export function surfaceText(r: SurfaceReport): string {
  const out: string[] = [
    `${r.works} manifest row(s) in; ${r.surfaces.length} image(s) read; ${r.measured} measurable.`,
  ];

  const reasons = [...Object.entries(r.skipped)].sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    out.push('', 'rows that produced no image:');
    for (const [why, n] of reasons) out.push(`  ${String(n).padStart(5)}  ${why}`);
  }

  const refused = new Map<string, number>();
  for (const s of r.surfaces) {
    if (s.metrics !== null) continue;
    // Grouped on the sentence and not on the whole `why`, because the ground reason carries the
    // image's own border share and would otherwise be a distinct reason per image.
    const key = s.why.split(' (')[0]!;
    refused.set(key, (refused.get(key) ?? 0) + 1);
  }
  if (refused.size > 0) {
    out.push('', 'images read and not measured:');
    for (const [why, n] of [...refused.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${String(n).padStart(5)}  ${why}`);
    }
  }

  if (r.surfaces.length > 0) {
    out.push(
      '',
      'Every image, photographs of objects included. These describe the file: the aspect is the',
      "photograph's shape and the palette includes the backdrop it was shot against. weight.* is",
      'defined even where there is no ground, and is the only one of these a composition claim can',
      'be checked against — read it as a percentile of this band, never as an absolute.',
      'field                       n   min     p10     med     p90     max',
      ...OPEN_FIELDS.map((f) => band(f.label, r.surfaces.map(f.of)))
    );
  }

  // One table per subject, never a pooled one. A `'sheet'` inkDensity and a `'studio-framing'`
  // inkDensity are the same arithmetic over two different worlds — a picture's marks and a
  // photographer's silhouette — and a band over both would be a number about neither. This is the
  // whole job of the `subject` label; pooling here would delete it.
  const measured = r.surfaces.filter((s) => s.metrics !== null);
  out.push(
    '',
    `Commensurable with a rendered plate: ${measured.length} image(s) on a confident ground, split by`,
    'what the numbers are about. These bands are never pooled.'
  );

  const subjects: Surface['subject'][] = ['sheet', 'studio-framing', 'unknown'];
  for (const subject of subjects) {
    const group = measured.filter((s) => s.subject === subject);
    if (group.length === 0) continue;
    out.push('', `  ${subject} (${group.length}) — ${SUBJECT_WHY[subject]}`);
    if (group.length < MIN_MEASURED) {
      out.push(
        `  NOTHING MEASURED. Fewer than ${MIN_MEASURED} images are ${subject}, so there is no band`,
        '  here to state. This is not a band of zero width; it is the absence of a measurement, and',
        '  no constraint may be authored from it.'
      );
      continue;
    }
    out.push(
      '  field                       n   min     p10     med     p90     max',
      ...METRIC_FIELDS.map((f) => `  ${band(f.label, group.map((s) => f.of(s.metrics!)))}`)
    );
  }

  if (measured.length === 0) {
    out.push(
      '',
      'NOTHING MEASURED. No image had a confident ground, so there is no band here at all. This is',
      'not a band of zero width; it is the absence of a measurement, and no constraint may be',
      'authored from it.'
    );
  }

  return out.join('\n');
}

// --- the census, saved --------------------------------------------------------------------------
//
// `surfaceText` is for a person and `surfaceCensus` is for the next program. They read the same
// `SurfaceReport` and the same two field lists, so a field added to one table appears in both.
//
// The asymmetry between `open` and `subjects` is deliberate. Open fields are stored as quantiles
// because there are 19,791 of them and nothing downstream has asked a question that the quantiles
// cannot answer. Metrics are stored RAW, per image, because a constraint is not a quantile — it is
// a predicate, and "what share of real sheets satisfy `inkDensityRange {min: 0.35}`" cannot be
// recovered from five numbers. Storing bands there would have quietly limited every future reader
// to the questions I happened to think of today.

export interface Band {
  n: number;
  min: number;
  p10: number;
  med: number;
  p90: number;
  max: number;
}

export interface SurfaceCensus {
  version: 1;
  generated: string;
  /** False only for an `--all` run. A band off a stride sample must never be quoted as the corpus's. */
  sampled: boolean;
  manifestRows: number;
  imagesRead: number;
  measured: number;
  open: Record<string, Band>;
  /** Raw metrics per measured image, split by subject and NEVER pooled. See `surfaceText`. */
  subjects: Record<Surface['subject'], Omit<RenderMetrics, 'pixelHash'>[]>;
}

export function bandOf(values: number[]): Band {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p10: quantile(s, 0.1),
    med: quantile(s, 0.5),
    p90: quantile(s, 0.9),
    max: s[s.length - 1] ?? NaN,
  };
}

export function surfaceCensus(r: SurfaceReport, sampled: boolean): SurfaceCensus {
  const open: Record<string, Band> = {};
  for (const f of OPEN_FIELDS) open[f.label] = bandOf(r.surfaces.map(f.of));

  const subjects = { sheet: [], 'studio-framing': [], unknown: [] } as SurfaceCensus['subjects'];
  for (const s of r.surfaces) if (s.metrics !== null) subjects[s.subject].push(s.metrics);

  return {
    version: 1,
    generated: new Date().toISOString(),
    sampled,
    manifestRows: r.works,
    imagesRead: r.surfaces.length,
    measured: r.measured,
    open,
    subjects,
  };
}
