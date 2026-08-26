// Render-scope measurement: three numbers taken off the canonical image.
//
// The whole medium's determinism argument is inherited here and none of it is re-litigated. This
// goes through env/browser.ts's Renderer, which renders one program at a time in a fresh page and
// repeats each render until two consecutive renders are byte-identical (NOTES R1, R7, R8). Nothing
// in this file counts frames, launches pages concurrently, or reads the display image.
//
// Because the canonical image is a pure function of (program, profile, pack, renderer), metrics are
// cached on disk by program hash. A cache entry records the pixel hash it was taken over, so a stale
// entry is detectable rather than merely old.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Renderer } from '../../env/browser.js';
import { loadPack, type AssetPack } from '../../env/pack.js';
import { pixelHash } from '../../env/png.js';
import { ROOT } from '../../env/browser.js';
import { contentHash, loadProfile } from '../../env/profile.js';
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

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * True where the pixel is not the ground colour. Everything below is computed from this one mask,
 * which is the honest limit of what "ink density" and "symmetry" can mean without a judge: they are
 * statements about where marks are, not about what the marks are of.
 */
function inkMask(rgba: Buffer, width: number, height: number, ground: string): Uint8Array {
  const [gr, gg, gb] = hexToRgb(ground);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    const d = Math.max(Math.abs(rgba[i]! - gr), Math.abs(rgba[i + 1]! - gg), Math.abs(rgba[i + 2]! - gb));
    mask[p] = d >= INK_THRESHOLD ? 1 : 0;
  }
  return mask;
}

/** Intersection over union of the ink mask with its own mirror. 0 when there is no ink at all. */
function symmetry(mask: Uint8Array, width: number, height: number, axis: 'vertical' | 'horizontal'): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = mask[y * width + x]!;
      const mx = axis === 'vertical' ? width - 1 - x : x;
      const my = axis === 'vertical' ? y : height - 1 - y;
      const b = mask[my * width + mx]!;
      if (a && b) both++;
      if (a || b) either++;
    }
  }
  return either === 0 ? 0 : both / either;
}

export function metricsFromRgba(rgba: Buffer, width: number, height: number, ground: string): RenderMetrics {
  const mask = inkMask(rgba, width, height, ground);
  let ink = 0;
  for (let p = 0; p < mask.length; p++) ink += mask[p]!;

  let coveredCells = 0;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor((gx * width) / GRID);
      const x1 = Math.floor(((gx + 1) * width) / GRID);
      const y0 = Math.floor((gy * height) / GRID);
      const y1 = Math.floor(((gy + 1) * height) / GRID);
      let cell = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cell += mask[y * width + x]!;
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      if (cell / area >= CELL_INK) coveredCells++;
    }
  }

  return {
    inkDensity: ink / (width * height),
    coverage: coveredCells / (GRID * GRID),
    symmetry: {
      vertical: symmetry(mask, width, height, 'vertical'),
      horizontal: symmetry(mask, width, height, 'horizontal'),
    },
    pixelHash: pixelHash(rgba),
  };
}

function cacheFile(programHash: string): string {
  return path.join(CACHE_DIR, `${programHash}.json`);
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

  constructor(private readonly profileId = 'default') {}

  /** Measures `program`, from cache when possible. Launches a browser only on a cache miss. */
  async measure(program: unknown): Promise<RenderMetrics> {
    const programHash = contentHash(program);
    const cached = readCached(programHash);
    if (cached) return cached;

    const { profile } = loadProfile(this.profileId);
    const pack: AssetPack = loadPack((program as { assetPack?: string }).assetPack ?? 'core');
    const check = validateProgram(program, profile, pack);
    if (!check.valid) {
      throw new Error(`cannot measure an invalid program: ${check.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    }
    const resolved = check.resolved!;

    this.renderer ??= await Renderer.launch();
    const out = await this.renderer.render(resolved, pack, fontsUsed(resolved));
    const metrics = metricsFromRgba(out.rgba, out.width, out.height, resolved.canvas.ground);
    writeCache(programHash, metrics);
    return metrics;
  }

  async close(): Promise<void> {
    await this.renderer?.close();
    this.renderer = null;
  }
}
