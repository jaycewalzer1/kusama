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
// There are two ways out of this class and they are not interchangeable. `render` is the canonical
// one: cached, agreement-checked, and the only thing a hash chain is ever built over. `preview` is
// discovery's: one render, no cache, stamped `canonical: false` in a way the type system enforces.
// Everything that existed before `preview` did calls `render` and is unaffected by it.
//
// A look that needs RenderMetrics used to render the same program twice on a cold hash, once for the
// plate and once for the numbers. It no longer does: `Measurer.measureFrom` takes the printed RGBA
// this class already has, so metrics cost a decode at worst and never a browser. The Measurer still
// owns the metrics cache and the ground colour, so the numbers are the same numbers `measure` would
// have written and stay comparable with every metric taken before this change.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Renderer, ROOT } from '../env/browser.js';
import { diffImage, pixelDiff } from '../env/diff.js';
import { loadPackFor, type AssetPack } from '../env/pack.js';
import { decodePng, encodePng, pixelHash } from '../env/png.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { printRender } from '../env/print.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed } from '../renderer/resolve.js';
import { Measurer } from '../aesthetic/measure.js';
import { checkProgram } from '../aesthetic/check.js';
import type { AestheticProgram, CheckReport, RenderMetrics } from '../aesthetic/types.js';

const PNG_CACHE = path.join(ROOT, '.cache', 'artist-png');

export interface Rendered {
  /**
   * Always true, and it is here so that `Preview` cannot be assigned to `Rendered`.
   *
   * Without a field the two disagree on, a preview — same shape, same PNG, one agreement loop short
   * of trustworthy — is structurally a `Rendered` and would be accepted anywhere a hash-chained
   * render is expected. The literal types make that a compile error rather than a plausible image.
   */
  canonical: true;
  programHash: string;
  /** sha256 of the canonical RGBA. The identity of the image, not of the program that made it. */
  pixelHash: string;
  png: Buffer;
  width: number;
  height: number;
  /** Null unless the look asked for metrics. Never assumed, never defaulted. */
  metrics: RenderMetrics | null;
}

/**
 * One render, not repeated, and not to be believed to the byte. Discovery only.
 *
 * There is no `pixelHash`, deliberately. A hash of pixels nobody has shown to repeat is a name for
 * something that does not have a stable identity, and the moment such a hash exists somebody joins
 * on it.
 */
export interface Preview {
  canonical: false;
  programHash: string;
  png: Buffer;
  width: number;
  height: number;
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
 * The tree that made a plate, beside the plate.
 *
 * studio.jsonl records a step's *edits* and the hash of what they produced, never the tree itself,
 * because the tree is large and the log is read in full by replay. That is enough to re-run a
 * trajectory and not enough to look at one: nothing after the fact can say what the program was at
 * step 7, only what changed at step 7. A program is its hash, so writing it here — content-addressed,
 * beside the pixels it produced, deduplicated across every run on the machine — makes every
 * intermediate tree recoverable from a hash the log already carries.
 */
function programFile(programHash: string): string {
  return path.join(PNG_CACHE, `${programHash}.program.json`);
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
  /**
   * Preview renders performed. Counted apart from `renders` rather than added to it: `renders` is
   * quoted in a trajectory's costs and it means canonical renders, so folding discovery's browser
   * time into it would change a number that has already been reported for runs that never previewed.
   */
  previews = 0;

  constructor(private readonly profileId?: string) {
    this.measurer = new Measurer(profileId);
  }

  /**
   * Renders `program` to the canonical image, exactly as cli/render.ts does: the browser plate, then
   * the program's own declared print stages, and nothing cosmetic ever. `metrics` is opt-in because
   * a cold metric still costs a PNG decode and most steps do not need one.
   */
  async render(program: unknown, opts: { metrics?: boolean } = {}): Promise<Rendered> {
    const programHash = contentHash(program);

    let png: Buffer;
    let width: number;
    let height: number;
    /** The printed pixels, when this call is what produced them. Null on a PNG cache hit. */
    let printed: Buffer | null = null;
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
      printed = rgba;
      width = plate.width;
      height = plate.height;
      png = encodePng(rgba, width, height);
      this.writePng(programHash, png);
      // Stored beside the PNG so a replay can quote the pixel hash without decoding an image.
      writeFileSync(`${pngFile(programHash)}.json`, `${JSON.stringify({ pixelHash: pixelHash(rgba), width, height })}\n`);
    }

    // Written on a cache hit too, so a machine that rendered these plates before this file existed
    // backfills its trees the next time a run stands on them.
    if (!existsSync(programFile(programHash))) {
      mkdirSync(PNG_CACHE, { recursive: true });
      writeFileSync(programFile(programHash), `${JSON.stringify(program)}\n`);
    }

    const meta = JSON.parse(readFileSync(`${pngFile(programHash)}.json`, 'utf8')) as { pixelHash: string };
    // The thunk is never called when the metrics cache hits, which is why a revisit costs nothing.
    const metrics = opts.metrics
      ? this.measurer.measureFrom(program, () => (printed ? { rgba: printed, width, height } : decodePng(png)))
      : null;

    return { canonical: true, programHash, pixelHash: meta.pixelHash, png, width, height, metrics };
  }

  /**
   * One render, for looking at. Discovery's path, and it is not a cheaper `render()`.
   *
   * What it skips is the agreement loop: `render()` goes through `Renderer.render`, which repeats a
   * program until two consecutive renders are byte-identical, so every canonical plate costs at
   * least two browser renders and sometimes six. A preview costs exactly one. That is where the
   * saving is, and it is also exactly what makes the result untrustworthy to the byte — measured, in
   * NOTES R7, at about four pixels in 960,000 differing between two renders of the same program.
   * Four pixels do not change what a contact sheet says and would break every hash in the chain,
   * which is the whole reason discovery may have this and the trajectory may not.
   *
   * What it does NOT skip is validation. `validateProgram` runs exactly as it does above, against
   * the same profile and the same pack: a program written whole in discovery gets no softer gate
   * than a hand-written one, which is what makes promoting it to the canonical path honest.
   *
   * It also does not touch the PNG cache, in either direction. The cache is keyed by program hash
   * and is read by `render()` as *the* canonical image of that program; writing one unrepeated
   * render into it would let a later canonical render return preview bytes on a cache hit, and the
   * trajectory would then be chained to pixels nothing ever proved repeat. Not reading it either is
   * the cheaper half of the same decision: a preview that sometimes returns a cached canonical image
   * and sometimes a fresh one has two different cost profiles and no reason to.
   *
   * The in-page settle loop (read frames until two consecutive readbacks agree) is still run. It is
   * inside renderer/page.html, it is what makes a single readback mean anything at all, and it is
   * not reachable from here.
   */
  async preview(program: unknown): Promise<Preview> {
    const { profile } = loadProfileFor(program, this.profileId);
    const pack: AssetPack = loadPackFor(program);
    const check = validateProgram(program, profile, pack);
    if (!check.valid) throw new InvalidProgramError(check.issues);
    const resolved = check.resolved!;

    this.renderer ??= await Renderer.launch();
    const plate = await this.renderer.renderUnchecked(resolved, pack, fontsUsed(resolved));
    this.previews++;
    const rgba = printRender(plate.rgba, plate.width, plate.height, resolved);
    return {
      canonical: false,
      programHash: contentHash(program),
      png: encodePng(rgba, plate.width, plate.height),
      width: plate.width,
      height: plate.height,
    };
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

export interface Change {
  /** The new plate faded back, with every pixel this step moved marked. */
  png: Buffer;
  /** Moved pixels over all pixels. The size of the step, on the page rather than in the tree. */
  fraction: number;
}

/**
 * What one step did to the page, as an image.
 *
 * No bounds are passed to `pixelDiff`, so nothing here is about spillover: `cli/diff.ts` asks
 * whether an edit reached further than the node it named, and that question needs the resolved
 * trees. This one only asks *where the ink moved*, which is the thing an artist looking at its own
 * last move would see, and it needs two PNGs and nothing else.
 *
 * Null when the two plates are different sizes, which in this medium means different profiles —
 * a sketch against a plate. There is no honest diff between those and a wrong one would be shown to
 * the artist as fact.
 */
export function changeSince(before: Buffer, after: Buffer): Change | null {
  const a = decodePng(before);
  const b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) return null;
  const diff = pixelDiff(a.rgba, b.rgba, b.width, b.height, []);
  // pixelDiff marks everything outside a declared box as 2 (spilled). With no boxes that is every
  // changed pixel, and "spilled" is meaningless here, so they are all just `changed`.
  const mask = diff.mask.map((v) => (v === 0 ? 0 : 1));
  return {
    png: encodePng(diffImage(b.rgba, b.width, b.height, [], mask), b.width, b.height),
    fraction: Math.round((diff.differing / (b.width * b.height)) * 1e4) / 1e4,
  };
}

/**
 * The aesthetic layer's checker, unmodified, against the effective position (the artist's position
 * with the brief's hard constraints appended). Hand it null metrics and every render-scope
 * constraint comes back `unverified` — which is reported as undecided, never as a pass.
 */
export function check(program: unknown, position: AestheticProgram, metrics: RenderMetrics | null): CheckReport {
  return checkProgram(program, position, metrics);
}
