// Render-scope measurement: four numbers taken off the canonical image.
//
// The browser half of this layer, and the only part of it that cannot run in a search loop. The
// medium's determinism argument is inherited whole from env/browser.ts and none of it is
// re-litigated: nothing here counts frames, launches pages concurrently, or reads the display image.
//
// Because the canonical image is a pure function of (program, profile, pack, renderer), metrics are
// cached on disk by program hash and by METRICS_VERSION.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Renderer, ROOT } from '../env/browser.js';
import { loadPackFor, type AssetPack } from '../env/pack.js';
import { pixelHash } from '../env/png.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { printRender } from '../env/print.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed, type ResolvedProgram } from '../renderer/resolve.js';
import type { RenderMetrics } from './types.js';

/** A pixel counts as ink when any channel is this far from the ground colour. */
const INK_THRESHOLD = 8;
/** Coverage is measured on a fixed grid. Fixed so that one cached metric answers every constraint. */
const GRID = 16;
/** A cell counts as covered once this fraction of it is ink. */
const CELL_INK = 0.01;
/** The edge band's width, as a fraction of the sheet's shorter side. */
const EDGE_BAND = 0.05;

const CACHE_DIR = path.join(ROOT, '.cache', 'aesthetic-metrics');
/**
 * Part of the cache file name. Bump it whenever RenderMetrics gains, loses or redefines a field --
 * an entry written before a field existed would otherwise parse cleanly and hand a checker
 * `undefined`, which `within()` reads as "inside every bound" -- and, less obviously, whenever the
 * renderer changes what the existing numbers measure.
 *
 * The second rule is here because the first one is not enough and that was found the hard way. The
 * key is the *program* hash, and `contentHash` covers the program only: not the profile, not the
 * pack, and not the renderer. So when 6b7601e changed how text is measured and moved real pixels,
 * every cached entry stayed valid-looking and wrong -- the same four numbers, taken off an image
 * that no longer existed. Nothing failed. A stale metric does not crash, it just quietly answers a
 * question about a render nobody would get again.
 *
 * 2: added inkOffset.
 * 3: 6b7601e moved text, so inkOffset/coverage/symmetry for any program with an untracked,
 *    unjittered text node were measured off superseded pixels.
 * 4: added edgeContact. Every v3 entry is missing the field entirely, and a checker handed
 *    `undefined` reads it as inside every bound — the exact failure the first rule above exists to
 *    prevent.
 *
 * TODO: this is a human remembering, and the human did not. The cache key wants the renderer's
 * identity folded into it -- a hash over `renderer/*.js` alongside the program hash -- so that a
 * change like 6b7601e invalidates these entries whether or not anyone thinks to edit this line.
 * Deliberately not done here: it is a second change riding along with the one that was asked for.
 */
const METRICS_VERSION = 4;

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
 */
function inkDistance(rgba: Buffer, width: number, height: number, ground: string): Uint8Array {
  const [gr, gg, gb] = hexToRgb(ground);
  const map = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    const d = Math.max(Math.abs(rgba[i]! - gr), Math.abs(rgba[i + 1]! - gg), Math.abs(rgba[i + 2]! - gb));
    map[p] = d >= INK_THRESHOLD ? d : 0;
  }
  return map;
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
 * The four numbers, from an RGBA buffer that is already the *printed* image. Exported so a caller
 * that has just produced that buffer does not have to render the program a second time to get them;
 * `Measurer.measureFrom` is the cached way in and is what callers should normally use.
 *
 * The buffer must be post-`printRender`. Measuring the browser plate instead would score a picture
 * nobody will ever see, and nothing here can detect the difference.
 */
export function metricsFromRgba(rgba: Buffer, width: number, height: number, ground: string): RenderMetrics {
  const ink = inkDistance(rgba, width, height, ground);
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
    pixelHash: pixelHash(rgba),
  };
}

function cacheFile(programHash: string): string {
  return path.join(CACHE_DIR, `${programHash}.v${METRICS_VERSION}.json`);
}

function readCached(programHash: string): RenderMetrics | null {
  try {
    return JSON.parse(readFileSync(cacheFile(programHash), 'utf8')) as RenderMetrics;
  } catch {
    return null;
  }
}

function writeCache(programHash: string, metrics: RenderMetrics): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile(programHash), `${JSON.stringify(metrics, null, 2)}\n`);
}

/**
 * One browser for a run of measurements, one render at a time. Renders in flight together are not
 * deterministic (NOTES R8), so this class deliberately offers no way to ask for several at once.
 */
export class Measurer {
  private renderer: Renderer | null = null;

  /** Undefined means "whichever profile the program names", which is the only honest default. */
  constructor(private readonly profileId?: string) {}

  /** Measures `program`, from cache when possible. Launches a browser only on a cache miss. */
  async measure(program: unknown): Promise<RenderMetrics> {
    const programHash = contentHash(program);
    const cached = readCached(programHash);
    if (cached) return cached;

    const { resolved, pack } = this.resolve(program);
    this.renderer ??= await Renderer.launch();
    const plate = await this.renderer.render(resolved, pack, fontsUsed(resolved));
    // Measure what the program actually prints: a threshold or a halftone changes ink share and
    // contrast by design, so measuring the plate would score a picture nobody will ever see.
    const rgba = printRender(plate.rgba, plate.width, plate.height, resolved);
    const metrics = metricsFromRgba(rgba, plate.width, plate.height, resolved.canvas.ground);
    writeCache(programHash, metrics);
    return metrics;
  }

  /**
   * The same measurement for a caller that already has the printed image, and therefore never a
   * browser. `plate` is a thunk because the metrics cache is checked first and the common case is a
   * hit: a caller holding a PNG should not pay to decode it to learn nothing new.
   *
   * What it hands back must be the image after the program's own print stages, exactly what
   * `measure` would have produced. Nothing here can check that, so the ground colour is taken from
   * the program rather than from the caller — a wrong ground would poison the cache silently, and
   * that is the failure mode METRICS_VERSION exists to remember.
   */
  measureFrom(program: unknown, plate: () => { rgba: Buffer; width: number; height: number }): RenderMetrics {
    const programHash = contentHash(program);
    const cached = readCached(programHash);
    if (cached) return cached;

    const { resolved } = this.resolve(program);
    const { rgba, width, height } = plate();
    const metrics = metricsFromRgba(rgba, width, height, resolved.canvas.ground);
    writeCache(programHash, metrics);
    return metrics;
  }

  private resolve(program: unknown): { resolved: ResolvedProgram; pack: AssetPack } {
    const { profile } = loadProfileFor(program, this.profileId);
    const pack: AssetPack = loadPackFor(program);
    const check = validateProgram(program, profile, pack);
    if (!check.valid) {
      throw new Error(`cannot measure an invalid program: ${check.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    }
    return { resolved: check.resolved!, pack };
  }

  async close(): Promise<void> {
    await this.renderer?.close();
    this.renderer = null;
  }
}
