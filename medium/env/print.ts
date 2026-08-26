// The print pass: what happens to a picture after it has been drawn.
//
// Xerox, ransom-note and cheap-flyer aesthetics are not ways of drawing. They are things that happen
// to an image once it exists, and V0 had no "after" at all. This is the after.
//
// Three decisions, and each of them is the answer to a mistake this repo has already made:
//
//  * **Node, not the browser.** Every stage is integer arithmetic over a Buffer. No GPU, no float
//    accumulation across pixels, no texture sampling. NOTES R6 caught the medium out on an MSAA
//    resolve and R8 on shared GPU-process state; this pass touches neither, because by the time it
//    runs the browser is closed and out of the picture.
//
//  * **After the render has been proven to repeat, never inside the proof.** `Renderer.render`
//    loops until two whole renders are byte-identical. A threshold is a machine for making two
//    slightly different images agree, so a print stage inside that loop could make a genuinely
//    nondeterministic render converge and the substrate would then certify it as deterministic.
//    That is NOTES R8's meta-lesson exactly. Callers must run this on the *output* of `render()`.
//
//  * **The pass invents no colour.** Every colour a stage uses is named in the program's palette and
//    resolved before it gets here, so `print` cannot introduce a colour the program never declared.
//
// Randomness comes from a `print` stream seeded off the master seed and the stage's index, through
// the same fnv1a/sfc32 path every node uses. It never touches a node seed, so adding, removing or
// reordering a print stage cannot change a single mark.

import { deriveSeed, makeRng } from '../renderer/rng.js';
import type { PrintStage } from '../renderer/resolve.js';

/** Not a node id, so it cannot collide with one: the rngKey namespace is the program's. */
const PRINT_RNG_KEY = 'print';

export class PrintError extends Error {}

export interface PrintResult {
  rgba: Buffer;
  /** One line per stage, in order, for the trace. */
  stages: { stage: string; ms: number }[];
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** ITU-R BT.601 luma on the 0..255 integers, rounded. The one definition of "how dark" here. */
function luma(r: number, g: number, b: number): number {
  return (299 * r + 587 * g + 114 * b) / 1000;
}

/**
 * Run a program's print list over a finished image. Pure: the input buffer is never written to.
 * `seed` is the program's master seed; `stages` must already have had their colours resolved.
 */
export function runPrint(
  rgba: Buffer,
  width: number,
  height: number,
  stages: PrintStage[],
  seed: number
): PrintResult {
  let pixels: Buffer = Buffer.from(rgba);
  const log: { stage: string; ms: number }[] = [];
  stages.forEach((stage, index) => {
    const started = Date.now();
    const rng = makeRng(deriveSeed(seed, `${PRINT_RNG_KEY}/${index}`, 0, 'print', 0));
    pixels = applyStage(pixels, width, height, stage, rng);
    log.push({ stage: String(stage['stage']), ms: Date.now() - started });
  });
  return { rgba: pixels, stages: log };
}

/**
 * The form every caller but `render` wants: a resolved program's own stages applied to its render,
 * or the render handed straight back when it declares none. Callers must already have a render they
 * trust; nothing here belongs inside the loop that establishes that trust.
 */
export function printRender(
  rgba: Buffer,
  width: number,
  height: number,
  resolved: { print: PrintStage[]; seed: number }
): Buffer {
  if (resolved.print.length === 0) return rgba;
  return runPrint(rgba, width, height, resolved.print, resolved.seed).rgba;
}

type Rng = ReturnType<typeof makeRng>;

function applyStage(px: Buffer, w: number, h: number, stage: PrintStage, rng: Rng): Buffer {
  switch (stage['stage']) {
    case 'threshold':
      return threshold(px, w, h, Number(stage['cut']), String(stage['dark']), String(stage['light']));
    case 'posterize':
      return posterize(px, Number(stage['levels']));
    case 'halftone':
      return halftone(px, w, h, {
        shape: String(stage['shape']) as 'dot' | 'line',
        cell: Number(stage['cell']),
        angle: Number(stage['angle']),
        ink: String(stage['ink']),
        paper: String(stage['paper']),
      });
    case 'grain':
      return grain(px, w, h, Number(stage['amount']), stage['mono'] !== false, rng);
    case 'misregister':
      return misregister(px, w, h, Number(stage['amount']), Number(stage['spread'] ?? 1), rng);
    case 'paper':
      return paper(px, w, h, String(stage['tint']), Number(stage['amount']), Number(stage['vignette'] ?? 0));
    case 'generation':
      return generation(px, w, h, stage, rng);
    default:
      throw new PrintError(`unknown print stage "${String(stage['stage'])}"`);
  }
}

// --- threshold / posterize ---------------------------------------------------------------------

function threshold(px: Buffer, w: number, h: number, cut: number, darkHex: string, lightHex: string): Buffer {
  const out = Buffer.allocUnsafe(px.length);
  const dark = hexToRgb(darkHex);
  const light = hexToRgb(lightHex);
  const level = cut * 255;
  for (let p = 0; p < w * h; p++) {
    const i = 4 * p;
    const c = luma(px[i]!, px[i + 1]!, px[i + 2]!) < level ? dark : light;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = px[i + 3]!;
  }
  return out;
}

function posterize(px: Buffer, levels: number): Buffer {
  const out = Buffer.allocUnsafe(px.length);
  const steps = levels - 1;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.round(Math.round((px[i + c]! / 255) * steps) * (255 / steps));
    }
    out[i + 3] = px[i + 3]!;
  }
  return out;
}

// --- halftone ------------------------------------------------------------------------------------

/**
 * A screen, not a filter. Each pixel is tested against the coverage its own cell would need at that
 * pixel's position within the cell, so the result is a real dot or line pattern rather than a blur.
 *
 * The grid is rotated by `angle` about the canvas origin, which is why a two-colour screen at 15 and
 * 75 degrees moires the way a real duotone does. Every number here is a rounded product of the input
 * integers, so nothing accumulates.
 */
function halftone(
  px: Buffer,
  w: number,
  h: number,
  o: { shape: 'dot' | 'line'; cell: number; angle: number; ink: string; paper: string }
): Buffer {
  const out = Buffer.allocUnsafe(px.length);
  const ink = hexToRgb(o.ink);
  const paper = hexToRgb(o.paper);
  const r = (o.angle * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      // 1 is full ink, 0 is bare paper.
      const coverage = 1 - luma(px[i]!, px[i + 1]!, px[i + 2]!) / 255;
      const u = (x * cos + y * sin) / o.cell;
      const v = (-x * sin + y * cos) / o.cell;
      let onInk: boolean;
      if (o.shape === 'line') {
        // Distance from the middle of the line, 0..1 across half a cell.
        const d = Math.abs(v - Math.floor(v) - 0.5) * 2;
        onInk = d <= coverage;
      } else {
        const du = u - Math.floor(u) - 0.5;
        const dv = v - Math.floor(v) - 0.5;
        // A dot of area `coverage` inside a unit cell has radius sqrt(coverage/pi); clamped so that
        // full coverage floods the cell rather than leaving the corners bare.
        const radius = Math.sqrt(coverage / Math.PI) * 1.28;
        onInk = du * du + dv * dv <= radius * radius;
      }
      const c = onInk ? ink : paper;
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = px[i + 3]!;
    }
  }
  return out;
}

// --- grain ---------------------------------------------------------------------------------------

function grain(px: Buffer, w: number, h: number, amount: number, mono: boolean, rng: Rng): Buffer {
  const out = Buffer.from(px);
  const span = amount * 255;
  // Row-major, one draw per pixel: the traversal order is part of what makes this reproducible.
  for (let p = 0; p < w * h; p++) {
    const i = 4 * p;
    if (mono) {
      const d = Math.round((rng.next() * 2 - 1) * span);
      out[i] = clamp8(out[i]! + d);
      out[i + 1] = clamp8(out[i + 1]! + d);
      out[i + 2] = clamp8(out[i + 2]! + d);
    } else {
      for (let c = 0; c < 3; c++) out[i + c] = clamp8(out[i + c]! + Math.round((rng.next() * 2 - 1) * span));
    }
  }
  return out;
}

// --- misregistration -----------------------------------------------------------------------------

function sample(px: Buffer, w: number, h: number, x: number, y: number, channel: number): number {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  return px[4 * (cy * w + cx) + channel]!;
}

/**
 * Colour plates out of register. Unlike `env/present.ts`'s display-only version, the offsets are not
 * given: each plate's is drawn from the print stream, so a program says "this is a bad print" and
 * the medium decides how, reproducibly. Whole pixels only, clamped at the edge -- see present.ts for
 * why those are the two rules.
 */
function misregister(px: Buffer, w: number, h: number, amount: number, spread: number, rng: Rng): Buffer {
  const reach = amount * spread;
  const off: [number, number][] = [];
  for (let c = 0; c < 3; c++) {
    off.push([Math.round((rng.next() * 2 - 1) * reach), Math.round((rng.next() * 2 - 1) * reach)]);
  }
  const out = Buffer.allocUnsafe(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      for (let c = 0; c < 3; c++) out[i + c] = sample(px, w, h, x + off[c]![0], y + off[c]![1], c);
      out[i + 3] = px[i + 3]!;
    }
  }
  return out;
}

// --- paper ---------------------------------------------------------------------------------------

/**
 * Stock and vignette. `tint` is mixed in by `amount` everywhere; `vignette` darkens toward the
 * corners on a squared radial falloff, which is the cheap-scanner look and also, at low values, what
 * stops a flat ground reading as a screen rather than as paper.
 */
function paper(px: Buffer, w: number, h: number, tintHex: string, amount: number, vignette: number): Buffer {
  const out = Buffer.allocUnsafe(px.length);
  const tint = hexToRgb(tintHex);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxR2 = cx * cx + cy * cy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      const dx = x - cx;
      const dy = y - cy;
      const shade = 1 - vignette * ((dx * dx + dy * dy) / maxR2);
      for (let c = 0; c < 3; c++) {
        out[i + c] = clamp8(Math.round((px[i + c]! * (1 - amount) + tint[c]! * amount) * shade));
      }
      out[i + 3] = px[i + 3]!;
    }
  }
  return out;
}

// --- generation loss -----------------------------------------------------------------------------

/**
 * A photocopy of a photocopy of a photocopy. Each pass blurs, cuts to two tones, thickens the dark
 * set and then fails to transfer some of it -- and the next pass runs on that result, which is the
 * entire point: closed-up counters and broken hairlines are what *iteration* does, and they cannot
 * be got by scaling any single one of these knobs up.
 */
function generation(px: Buffer, w: number, h: number, stage: PrintStage, rng: Rng): Buffer {
  const passes = Number(stage['passes']);
  const cut = Number(stage['cut']);
  const dark = hexToRgb(String(stage['dark']));
  const light = hexToRgb(String(stage['light']));
  const blur = Number(stage['blur'] ?? 0);
  const spread = Number(stage['spread'] ?? 0);
  const dropout = Number(stage['dropout'] ?? 0);
  const speck = Number(stage['speck'] ?? 0);
  const level = cut * 255;

  let cur: Buffer = Buffer.from(px);
  for (let pass = 0; pass < passes; pass++) {
    if (blur > 0) cur = boxBlur(cur, w, h, blur);
    // One bit per pixel: true means ink.
    let ink = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = 4 * p;
      ink[p] = luma(cur[i]!, cur[i + 1]!, cur[i + 2]!) < level ? 1 : 0;
    }
    if (spread > 0) ink = dilate(ink, w, h, spread);
    for (let p = 0; p < w * h; p++) {
      if (ink[p] === 1) {
        if (dropout > 0 && rng.next() < dropout) ink[p] = 0;
      } else if (speck > 0 && rng.next() < speck) ink[p] = 1;
    }
    const out = Buffer.allocUnsafe(px.length);
    for (let p = 0; p < w * h; p++) {
      const i = 4 * p;
      const c = ink[p] === 1 ? dark : light;
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = px[i + 3]!;
    }
    cur = out;
  }
  return cur;
}

/** Separable box blur, integer mean, clamped at the edge. */
function boxBlur(px: Buffer, w: number, h: number, radius: number): Buffer {
  const mid = Buffer.allocUnsafe(px.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += sample(px, w, h, x + k, y, c);
        mid[i + c] = Math.round(sum / span);
      }
      mid[i + 3] = px[i + 3]!;
    }
  }
  const out = Buffer.allocUnsafe(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += sample(mid, w, h, x, y + k, c);
        out[i + c] = Math.round(sum / span);
      }
      out[i + 3] = px[i + 3]!;
    }
  }
  return out;
}

/** Morphological dilate of the set bits, square structuring element, clamped at the edge. */
function dilate(ink: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.min(w - 1, Math.max(0, x + dx));
          if (ink[sy * w + sx] === 1) {
            on = 1;
            break;
          }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}
