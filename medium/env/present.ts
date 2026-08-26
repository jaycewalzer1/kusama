// The display post-pass: presentation effects are render options, never nodes (spec section 6).
//
// Grain and misregistration are things that happen to a print, not things that are in a picture. If
// they were nodes an edit could target them, a diff would report them and an evaluation would score
// them, and none of that is true of the paper. So they live here, outside the program entirely.
//
// Every function in this file is pure and returns a NEW buffer; none of them can write through to
// the canonical pixels even by accident. `cli/render.ts` additionally has canonical.png on disk
// before it so much as looks at a presentation option, so there are two independent reasons the
// causal image cannot be touched by anything here.

import { deriveSeed, makeRng } from '../renderer/rng.js';

/**
 * `seed` is the program's master seed. Grain is derived from it through the same fnv1a/sfc32 path
 * the renderer uses for a node's texture stream, under a fixed key of its own, so the same program
 * grains the same way on any machine and no browser is involved in producing it.
 */
export interface GrainOptions {
  amount: number;
  seed: number;
}

export interface MisregisterOptions {
  dx: number;
  dy: number;
}

/** Not a node id, so it cannot collide with one: the rngKey namespace is the program's. */
const GRAIN_RNG_KEY = 'present/grain';

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Per-pixel luminance noise: one signed delta per pixel, applied equally to R, G and B, so the
 * pixel moves lighter or darker without moving in hue. `amount` is the half-range as a fraction of
 * full scale, so 0.02 is +-5/255.
 *
 * Alpha is left alone -- grain is ink and paper, not coverage.
 */
export function grain(rgba: Buffer, width: number, height: number, { amount, seed }: GrainOptions): Buffer {
  const out = Buffer.from(rgba);
  const rng = makeRng(deriveSeed(seed, GRAIN_RNG_KEY, 0, 'texture', 0));
  const span = amount * 255;
  // Row-major, one draw per pixel: the traversal order is part of what makes this reproducible.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      const delta = Math.round((rng.next() * 2 - 1) * span);
      out[i] = clamp8(out[i]! + delta);
      out[i + 1] = clamp8(out[i + 1]! + delta);
      out[i + 2] = clamp8(out[i + 2]! + delta);
    }
  }
  return out;
}

/** Clamp-to-edge sampling: see `misregister` for why this is the edge rule. */
function sample(rgba: Buffer, width: number, height: number, x: number, y: number, channel: number): number {
  const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  return rgba[4 * (cy * width + cx) + channel]!;
}

/**
 * Colour plates out of register, the way a misaligned print is: the red plate is pulled by
 * (-dx, -dy), the blue plate by (+dx, +dy), and green stays put as the reference plate. Fringes
 * appear on every edge in the image, coloured by which plate is missing there.
 *
 * Two decisions worth stating:
 *
 *  * **Whole pixels only.** `dx`/`dy` are rounded. A sub-pixel shift would need interpolation,
 *    which invents colours that are in neither plate; that is a different (and lossy) operation,
 *    and this one is meant to be exactly reversible in principle.
 *  * **Clamp to edge.** A plate pulled off the canvas has no data at the far border. We repeat the
 *    edge pixel rather than fill with black or with transparency, because either of those would put
 *    a hard band of a colour that is nowhere in the picture along one side, which reads as a bug
 *    rather than as a print artefact. The visible cost is a few columns/rows of smear.
 *
 * Alpha is taken from the unshifted pixel, so the silhouette of the image does not move.
 */
export function misregister(rgba: Buffer, width: number, height: number, { dx, dy }: MisregisterOptions): Buffer {
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  const out = Buffer.allocUnsafe(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      out[i] = sample(rgba, width, height, x + ox, y + oy, 0);
      out[i + 1] = rgba[i + 1]!;
      out[i + 2] = sample(rgba, width, height, x - ox, y - oy, 2);
      out[i + 3] = rgba[i + 3]!;
    }
  }
  return out;
}
