// Render-scope measurement: four numbers taken off the canonical image.
//
// The browser half of this layer, and the only part of it that cannot run in a search loop. The
// medium's determinism argument is inherited whole from env/browser.ts and none of it is
// re-litigated: nothing here counts frames, launches pages concurrently, or reads the display image.
// The pixel arithmetic itself lives in ./metrics.ts, which imports no browser, so a caller that has
// pixels and wants numbers never pays for Playwright.
//
// Because the canonical image is a pure function of (program, profile, pack, renderer), metrics are
// cached on disk by program hash and by METRICS_VERSION.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Renderer, ROOT } from '../env/browser.js';
import { loadPackFor, type AssetPack } from '../env/pack.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { printRender } from '../env/print.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed, type ResolvedProgram } from '../renderer/resolve.js';
import { metricsFromRgba } from './metrics.js';
import type { RenderMetrics } from './types.js';

// Re-exported at its old name and old path: this module was where `metricsFromRgba` lived, and
// moving a function is not a reason to make its callers edit an import.
export { metricsFromRgba } from './metrics.js';

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
 * The rule is about *redefinition*, not about where the code sits. Moving the arithmetic into
 * ./metrics.ts changed no number -- the same map, the same grid, the same bands -- so this stayed at
 * 4 on purpose. A pure refactor that provably does not move the numbers is exactly the case that
 * must NOT bump: bumping it would abandon a whole cache of entries that are still true, and pay for
 * every one of them again in browser time to arrive back at the same JSON.
 *
 * TODO: this is a human remembering, and the human did not. The cache key wants the renderer's
 * identity folded into it -- a hash over `renderer/*.js` alongside the program hash -- so that a
 * change like 6b7601e invalidates these entries whether or not anyone thinks to edit this line.
 * Deliberately not done here: it is a second change riding along with the one that was asked for.
 */
const METRICS_VERSION = 4;

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
