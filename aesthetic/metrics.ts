// The pure half of render-scope measurement: pixels in, numbers out, and nothing that opens a page.
//
// Split out of measure.ts because the arithmetic and the browser were living in one module, so
// anything that wanted the four numbers imported Playwright to get them. That is a real cost for
// corpus code in artist/, which measures museum JPEGs by the thousand and never renders anything.
//
// The point of the split is that a downloaded photograph and a rendered plate come out in the *same*
// units. So the definitions live here once, and the entry points differ only in how they find the
// ink: `inkMapRgba` for the 4-byte buffer a render produces, `inkMapRgb` for the 3-byte buffer a
// decoded JPEG produces, `metricsFromInk` for a caller that has its own idea of what the ground is.
// Nothing in this file may import ../env/browser.js, ../env/profile.js, ../env/pack.js,
// ../env/print.js, ../env/validate.js or ../renderer/*, or the cost comes straight back.

import { pixelHash } from '../env/png.js';
import type { RenderMetrics } from './types.js';

/** A pixel counts as ink when any channel is this far from the ground colour. */
const INK_THRESHOLD = 8;
/** Coverage is measured on a fixed grid. Fixed so that one cached metric answers every constraint. */
const GRID = 16;
/** A cell counts as covered once this fraction of it is ink. */
const CELL_INK = 0.01;
/** The edge band's width, as a fraction of the sheet's shorter side. */
const EDGE_BAND = 0.05;

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * How far each pixel is from the ground colour, as the largest single-channel difference, and zero
 * below the threshold. This is the one definition of ink in the file: a pixel *is* ink where this is
 * non-zero, and *how much* ink it is — how far off the paper it sits — is the number itself.
 *
 * Everything below is computed from this one map, which is the honest limit of what "ink density",
 * "symmetry" and "ink offset" can mean without a judge: they are statements about where marks are,
 * not about what the marks are of.
 *
 * `stride` is how many bytes a pixel occupies; only the first three are ever read, so alpha is
 * ignored exactly as it always was, and a 3-byte buffer is not a different measurement.
 */
function inkDistance(
  px: Buffer | Uint8Array,
  width: number,
  height: number,
  ground: string,
  stride: number
): Uint8Array {
  const [gr, gg, gb] = hexToRgb(ground);
  const map = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = stride * p;
    const d = Math.max(Math.abs(px[i]! - gr), Math.abs(px[i + 1]! - gg), Math.abs(px[i + 2]! - gb));
    map[p] = d >= INK_THRESHOLD ? d : 0;
  }
  return map;
}

/** Public so a caller with its own definition of the ground can reuse the rest. */
export function inkMapRgba(
  rgba: Buffer | Uint8Array,
  width: number,
  height: number,
  ground: string
): Uint8Array {
  return inkDistance(rgba, width, height, ground, 4);
}

/** The same map off a 3-byte-per-pixel buffer, which is what a decoded JPEG is. */
export function inkMapRgb(rgb: Uint8Array, width: number, height: number, ground: string): Uint8Array {
  return inkDistance(rgb, width, height, ground, 3);
}

/** Intersection over union of the ink mask with its own mirror. 0 when there is no ink at all. */
function symmetry(ink: Uint8Array, width: number, height: number, axis: 'vertical' | 'horizontal'): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = ink[y * width + x]! !== 0;
      const mx = axis === 'vertical' ? width - 1 - x : x;
      const my = axis === 'vertical' ? y : height - 1 - y;
      const b = ink[my * width + mx]! !== 0;
      if (a && b) both++;
      if (a || b) either++;
    }
  }
  return either === 0 ? 0 : both / either;
}

/**
 * Per side, the share of a band along that edge that carries ink.
 *
 * The band, not the single outermost row. A one-pixel test answers a question about the renderer's
 * clipping rather than about the picture: a mark that stops one pixel short reads as an untouched
 * margin, and a mark that bleeds one pixel past reads as a full edge. `EDGE_BAND` of the shorter
 * side is a width a person would call "the margin" when looking at the sheet.
 *
 * The denominator is the band's own area, so each of the four numbers is 0..1 and the four are
 * comparable with each other on a sheet that is not square. Corners fall in two bands and are
 * counted in both; they are genuinely contact with both edges.
 */
function edgeContact(
  ink: Uint8Array,
  width: number,
  height: number
): { top: number; right: number; bottom: number; left: number } {
  const band = Math.max(1, Math.round(EDGE_BAND * Math.min(width, height)));
  const share = (x0: number, x1: number, y0: number, y1: number): number => {
    let inked = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ink[y * width + x]! !== 0) inked++;
    return inked / Math.max(1, (x1 - x0) * (y1 - y0));
  };
  return {
    top: share(0, width, 0, Math.min(band, height)),
    right: share(Math.max(0, width - band), width, 0, height),
    bottom: share(0, width, Math.max(0, height - band), height),
    left: share(0, Math.min(band, width), 0, height),
  };
}

/**
 * Distance of the ink centroid from the sheet centre, over the distance from centre to corner. 0
 * when the weight of the picture sits dead centre, 1 in the unreachable limit where all of it is one
 * corner pixel, and 0 for a blank sheet — the same convention symmetry uses for no ink.
 *
 * Weighted by tone, not by the bare mask, and that is the whole point. A sheet inked corner to
 * corner has its *mask* centroid at the centre by construction, which is the same degeneracy that
 * makes mirror symmetry meaningless once a page is full. Weighting by distance from the paper keeps
 * a black half against a pale half reading as off-centre, which is what "off axis" was ever asking.
 *
 * Accumulated in row-major order, so the floating-point sum is as reproducible as the pixels are.
 */
function inkOffset(ink: Uint8Array, width: number, height: number): number {
  let total = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = ink[y * width + x]!;
      if (w === 0) continue;
      total += w;
      sx += w * (x + 0.5);
      sy += w * (y + 0.5);
    }
  }
  if (total === 0) return 0;
  const dx = sx / total - width / 2;
  const dy = sy / total - height / 2;
  return Math.hypot(dx, dy) / Math.hypot(width / 2, height / 2);
}

/**
 * Every field of RenderMetrics except pixelHash, which is a claim about bytes this does not have.
 *
 * The ink map is the only input, so a caller that decided for itself which pixels are paper — a
 * photograph of an object on a sweep, say, where "the ground" is not one hex colour — still gets
 * numbers on the same scale as a plate's.
 */
export function metricsFromInk(
  ink: Uint8Array,
  width: number,
  height: number
): Omit<RenderMetrics, 'pixelHash'> {
  let inked = 0;
  for (let p = 0; p < ink.length; p++) if (ink[p]! !== 0) inked++;

  let coveredCells = 0;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor((gx * width) / GRID);
      const x1 = Math.floor(((gx + 1) * width) / GRID);
      const y0 = Math.floor((gy * height) / GRID);
      const y1 = Math.floor(((gy + 1) * height) / GRID);
      let cell = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ink[y * width + x]! !== 0) cell++;
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      if (cell / area >= CELL_INK) coveredCells++;
    }
  }

  return {
    inkDensity: inked / (width * height),
    coverage: coveredCells / (GRID * GRID),
    inkOffset: inkOffset(ink, width, height),
    symmetry: {
      vertical: symmetry(ink, width, height, 'vertical'),
      horizontal: symmetry(ink, width, height, 'horizontal'),
    },
    edgeContact: edgeContact(ink, width, height),
  };
}

/**
 * The four numbers, from an RGBA buffer that is already the *printed* image. Exported so a caller
 * that has just produced that buffer does not have to render the program a second time to get them;
 * `Measurer.measureFrom` is the cached way in and is what callers should normally use.
 *
 * The buffer must be post-`printRender`. Measuring the browser plate instead would score a picture
 * nobody will ever see, and nothing here can detect the difference.
 */
export function metricsFromRgba(rgba: Buffer, width: number, height: number, ground: string): RenderMetrics {
  return {
    ...metricsFromInk(inkMapRgba(rgba, width, height, ground), width, height),
    pixelHash: pixelHash(rgba),
  };
}
