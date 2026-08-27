// The canvas: the only thing in the artist that touches a browser.
//
// Everything the artist learns about pixels comes through here, and it enforces the medium's two
// hard determinism rules by construction rather than by discipline: one browser for the whole run,
// and one render at a time. There is deliberately no method that takes an array of programs.
//
// Two caches, both keyed by program hash, both on disk, and both load-bearing for cost rather than
// for speed. A trajectory revisits the same program hash constantly — every reverted candidate
// leaves the canvas exactly as it was — so a cache hit is the common case, not the lucky one.
//
// KNOWN COST, recorded in docs/artist/NEEDS.md: a look that needs RenderMetrics renders twice on a
// cold hash. `metricsFromRgba` is module-private in aesthetic/measure.ts and the brief forbids
// changing the aesthetic layer, so the PNG and the metrics are obtained by two separate passes over
// the same program. Exporting that one function would halve the browser time of the whole system.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Renderer, ROOT } from '../env/browser.js';
import { loadPackFor, type AssetPack } from '../env/pack.js';
import { encodePng, pixelHash } from '../env/png.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { printRender } from '../env/print.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed } from '../renderer/resolve.js';
import { Measurer } from '../aesthetic/measure.js';
import { checkProgram } from '../aesthetic/check.js';
import type { AestheticProgram, CheckReport, RenderMetrics } from '../aesthetic/types.js';

const PNG_CACHE = path.join(ROOT, '.cache', 'artist-png');

export interface Rendered {
  programHash: string;
  /** sha256 of the canonical RGBA. The identity of the image, not of the program that made it. */
  pixelHash: string;
  png: Buffer;
  width: number;
  height: number;
  /** Null unless the look asked for metrics. Never assumed, never defaulted. */
  metrics: RenderMetrics | null;
}

export class InvalidProgramError extends Error {
  constructor(readonly issues: { path: string; message: string; code: string }[]) {
    super(`invalid program: ${issues.map((i) => `${i.path} ${i.message} [${i.code}]`).join('; ')}`);
    this.name = 'InvalidProgramError';
  }
}

function pngFile(programHash: string): string {
  return path.join(PNG_CACHE, `${programHash}.png`);
}

/**
 * The medium's own validator, unmodified. Called before anything expensive, which is the whole
 * reason an over-budget program costs microseconds instead of a browser launch. The artist never
 * gets a softer gate than a hand-written program does.
 */
export function validate(program: unknown, profileId?: string): { programHash: string; issues: { path: string; message: string; code: string }[] } {
  const { profile } = loadProfileFor(program, profileId);
  const pack: AssetPack = loadPackFor(program);
  const check = validateProgram(program, profile, pack);
  return { programHash: check.programHash, issues: check.issues };
}

export class Canvas {
  private renderer: Renderer | null = null;
  private readonly measurer: Measurer;
  /** Renders performed, cache hits excluded. Reported as a cost, because it is the dominant one. */
  renders = 0;

  constructor(private readonly profileId?: string) {
    this.measurer = new Measurer(profileId);
  }

  /**
   * Renders `program` to the canonical image, exactly as cli/render.ts does: the browser plate, then
   * the program's own declared print stages, and nothing cosmetic ever. `metrics` is opt-in because
   * it costs a second render on a cold hash and most steps do not need it.
   */
  async render(program: unknown, opts: { metrics?: boolean } = {}): Promise<Rendered> {
    const programHash = contentHash(program);

    let png: Buffer;
    let width: number;
    let height: number;
    const cached = this.readPng(programHash);
    if (cached) {
      ({ png, width, height } = cached);
    } else {
      const { profile } = loadProfileFor(program, this.profileId);
      const pack: AssetPack = loadPackFor(program);
      const check = validateProgram(program, profile, pack);
      if (!check.valid) throw new InvalidProgramError(check.issues);
      const resolved = check.resolved!;

      this.renderer ??= await Renderer.launch();
      const plate = await this.renderer.render(resolved, pack, fontsUsed(resolved));
      this.renders++;
      const rgba = printRender(plate.rgba, plate.width, plate.height, resolved);
      width = plate.width;
      height = plate.height;
      png = encodePng(rgba, width, height);
      this.writePng(programHash, png);
      // Stored beside the PNG so a replay can quote the pixel hash without decoding an image.
      writeFileSync(`${pngFile(programHash)}.json`, `${JSON.stringify({ pixelHash: pixelHash(rgba), width, height })}\n`);
    }

    const meta = JSON.parse(readFileSync(`${pngFile(programHash)}.json`, 'utf8')) as { pixelHash: string };
    const metrics = opts.metrics ? await this.measurer.measure(program) : null;

    return { programHash, pixelHash: meta.pixelHash, png, width, height, metrics };
  }

  private readPng(programHash: string): { png: Buffer; width: number; height: number } | null {
    try {
      const png = readFileSync(pngFile(programHash));
      const meta = JSON.parse(readFileSync(`${pngFile(programHash)}.json`, 'utf8')) as { width: number; height: number };
      return { png, width: meta.width, height: meta.height };
    } catch {
      return null;
    }
  }

  private writePng(programHash: string, png: Buffer): void {
    mkdirSync(PNG_CACHE, { recursive: true });
    writeFileSync(pngFile(programHash), png);
  }

  async close(): Promise<void> {
    await this.renderer?.close();
    this.renderer = null;
    await this.measurer.close();
  }
}

/**
 * The aesthetic layer's checker, unmodified, against the effective position (the artist's position
 * with the brief's hard constraints appended). Hand it null metrics and every render-scope
 * constraint comes back `unverified` — which is reported as undecided, never as a pass.
 */
export function check(program: unknown, position: AestheticProgram, metrics: RenderMetrics | null): CheckReport {
  return checkProgram(program, position, metrics);
}
