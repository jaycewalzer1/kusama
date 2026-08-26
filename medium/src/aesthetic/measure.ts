// Render-scope measurement: four numbers taken off the canonical image.
//
// The whole medium's determinism argument is inherited here and none of it is re-litigated. This
// goes through env/browser.ts's Renderer, which renders one program at a time in a fresh page and
// repeats each render until two consecutive renders are byte-identical (NOTES R1, R7, R8). Nothing
// in this file counts frames, launches pages concurrently, or reads the display image.
//
// Because the canonical image is a pure function of (program, profile, pack, renderer), metrics are
// cached on disk by program hash and by METRICS_VERSION. A cache entry records the pixel hash it was
// taken over, so a stale entry is detectable rather than merely old.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Renderer } from '../../env/browser.js';
import { loadPackFor, type AssetPack } from '../../env/pack.js';
import { pixelHash } from '../../env/png.js';
import { ROOT } from '../../env/browser.js';
import { contentHash, loadProfileFor } from '../../env/profile.js';
import { printRender } from '../../env/print.js';
import { validateProgram } from '../../env/validate.js';
import { fontsUsed } from '../../renderer/resolve.js';
import type { RenderMetrics } from './types.js';

/** A pixel counts as ink when any channel is this far from the ground colour. */
const INK_THRESHOLD = 8;
/** Coverage is measured on a fixed grid. Fixed so that one cached metric answers every constraint. */
const GRID = 16;
/** A cell counts as covered once this fraction of it is ink. */
const CELL_INK = 0.01;

const CACHE_DIR = path.join(ROOT, '.cache', 'aesthetic-metrics');
/**
 * Part of the cache file name, bumped whenever RenderMetrics gains, loses or redefines a field. An
 * entry written before a field existed would otherwise parse cleanly and hand a checker `undefined`,
 * which `within()` reads as "inside every bound". A version in the name makes that a miss instead.
 * 2: added inkOffset.
 */
const METRICS_VERSION = 2;

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
    pixelHash: pixelHash(rgba),
  };
}

function cacheFile(programHash: string): string {
  return path.join(CACHE_DIR, `${programHash}.v${METRICS_VERSION}.json`);
}

export function readCached(programHash: string): RenderMetrics | null {
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

    const { profile } = loadProfileFor(program, this.profileId);
    const pack: AssetPack = loadPackFor(program);
    const check = validateProgram(program, profile, pack);
    if (!check.valid) {
      throw new Error(`cannot measure an invalid program: ${check.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    }
    const resolved = check.resolved!;

    this.renderer ??= await Renderer.launch();
    const plate = await this.renderer.render(resolved, pack, fontsUsed(resolved));
    // Measure what the program actually prints: a threshold or a halftone changes ink share and
    // contrast by design, so measuring the plate would score a picture nobody will ever see.
    const rgba = printRender(plate.rgba, plate.width, plate.height, resolved);
    const metrics = metricsFromRgba(rgba, plate.width, plate.height, resolved.canvas.ground);
    writeCache(programHash, metrics);
    return metrics;
  }

  async close(): Promise<void> {
    await this.renderer?.close();
    this.renderer = null;
  }
}
