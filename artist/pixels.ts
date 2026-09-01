// Bytes to pixels, and the one question that has to be answered before any pixel means anything:
// what is the ground?
//
// `decode` lived in `resemblance.ts` until now, private to it, because one file needed it. Two do:
// CLIP wants an RGB buffer and so does any attempt to measure a corpus image in the units the
// aesthetic layer speaks. It is moved here whole rather than copied, so there is one definition of
// what "the pixels of this file" are and a change to it cannot reach one caller and miss the other.
//
// ## Why ground estimation belongs next to decoding and not next to measurement
//
// `aesthetic/measure.ts` never has to guess. It measures a plate the medium produced, and the
// program that produced it *states* its ground colour — that is the whole reason `metricsFromRgba`
// takes `ground` as an argument instead of inferring it. A museum photograph states nothing. Its
// backdrop is whatever paper the photographer rolled out, lit however it was lit, saved as a JPEG.
//
// So `inkDensity` on a corpus image is not a measurement until somebody decides which colour is the
// paper, and that decision can be wrong in a way that produces a perfectly plausible number. A
// backdrop with a lighting falloff across it will read as ink over half the frame; a mount board a
// shade off white will read as a solid mark the size of the picture. `estimateGround` therefore
// returns its own confidence beside its answer, measured rather than assumed, and everything
// downstream is expected to refuse the measurement when the confidence is not there. A gradient
// backdrop coming back `confident: false` is this function working, not failing.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);

export interface Rgb {
  width: number;
  height: number;
  /** RGB, one byte per channel, no alpha. */
  data: Uint8Array;
}

export function decode(file: string): Rgb {
  const bytes = readFileSync(file);
  if (file.toLowerCase().endsWith('.png')) {
    const png = PNG.sync.read(bytes);
    const out = new Uint8Array(png.width * png.height * 3);
    for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
      // Composited onto white, not dropped. A plate's alpha is the sheet showing through, and
      // reading RGB straight would turn the untouched margin into whatever the buffer happened to
      // hold — which on this renderer is black, and would dominate the embedding.
      const a = png.data[i + 3]! / 255;
      out[j] = Math.round(png.data[i]! * a + 255 * (1 - a));
      out[j + 1] = Math.round(png.data[i + 1]! * a + 255 * (1 - a));
      out[j + 2] = Math.round(png.data[i + 2]! * a + 255 * (1 - a));
    }
    return { width: png.width, height: png.height, data: out };
  }
  const jpeg = require('jpeg-js') as {
    decode: (b: Buffer, o: { useTArray: boolean }) => { width: number; height: number; data: Uint8Array };
  };
  const img = jpeg.decode(bytes, { useTArray: true });
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = img.data[i]!;
    out[j + 1] = img.data[i + 1]!;
    out[j + 2] = img.data[i + 2]!;
  }
  return { width: img.width, height: img.height, data: out };
}

// --- ground ---------------------------------------------------------------------------------------

/**
 * How far a channel may sit from the ground colour and still be ground: the same 8 that
 * `aesthetic/measure.ts` calls `INK_THRESHOLD`, restated here because it is private there and this
 * file must not edit that one.
 *
 * Restating a constant is normally how two files drift apart, so the reason it is the same number
 * is worth stating rather than assuming. This tolerance decides `confident`, and `confident` decides
 * whether the metrics get computed at all — with the metrics then taken at a threshold of 8. A
 * looser tolerance here would certify a backdrop as uniform and then hand it to a measurement that
 * disagrees, counting as ink exactly the pixels this function just called paper. The confidence
 * test has to be the same test the measurement will apply, or it is confidence about a different
 * question.
 */
export const GROUND_TOLERANCE = 8;

/**
 * The band read as "the border", as a fraction of the shorter side.
 *
 * 4%, a little narrower than `measure.ts`'s 5% edge band, and for a different reason than that one:
 * this band is not a margin a person would name, it is the strip most likely to be backdrop and
 * least likely to be subject. Wider starts eating the object in a tightly cropped photograph and
 * drags the modal colour toward it; narrower makes the estimate a handful of pixels on a small
 * image.
 */
export const GROUND_BORDER_FRACTION = 0.04;

/**
 * The share of the border band that must be within `GROUND_TOLERANCE` of the modal colour before
 * "ground" is treated as a real thing in this image.
 *
 * 0.90, and it is an argument, not a taste — argue with it here rather than anywhere else. What the
 * threshold is protecting against is a border that is *partly* something else: a visible mount, a
 * frame, a colour bar, a corner of the object, a lighting falloff. Each of those takes a large,
 * contiguous bite out of the band, so the realistic failures do not sit near the line — a framed
 * painting shot to the frame's outer edge scores near 0, and a seamless-paper studio shot scores
 * near 1. 10% is roughly what a shadow gradient in two corners costs, which is the one case worth
 * forgiving because the modal colour is still the paper.
 *
 * Raising it to 0.98 would refuse most real JPEGs over compression noise near the object; dropping
 * it to 0.5 would certify a photograph whose border is half mount board, and the resulting
 * `inkDensity` would be the area of the mount. If this number ever needs to move, move it with a
 * count of what it admits and refuses over the corpus, not by feel.
 */
export const GROUND_CONFIDENT_SHARE = 0.9;

export interface Ground {
  /** `#rrggbb`, the modal colour of the border band. */
  hex: string;
  /** Share of border-band pixels within tolerance of `hex`. */
  share: number;
  /** Share of ALL pixels within tolerance of `hex`. */
  extent: number;
  /** True only when the border is uniform enough that "ground" is a real thing in this image. */
  confident: boolean;
}

function hex(r: number, g: number, b: number): string {
  const two = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${two(r)}${two(g)}${two(b)}`;
}

/**
 * The modal colour of the border, and how much of the border actually is it.
 *
 * Modal on a 4-bits-per-channel quantisation rather than on the raw bytes, because no two pixels of
 * a photographed sheet of paper are the same three numbers and a raw mode would be noise. The hex
 * returned is the *mean* of the pixels in the winning bucket, not the bucket's centre: the bucket is
 * a coarse net used to find the colour, and reporting the net instead of the fish would put the
 * ground up to 8 levels off, which is the tolerance itself.
 *
 * `share` and `extent` are the same test at two scopes, and both are reported because they answer
 * different questions. A low `share` means there is no single ground. A `share` near 1 with an
 * `extent` near 1 too means the image is nearly empty — a legitimate answer that a caller measuring
 * composition should be able to see, since `inkDensity` there is about to be a very small number
 * taken over a very large sheet.
 */
export function estimateGround(
  img: Rgb,
  borderFraction = GROUND_BORDER_FRACTION,
  tolerance = GROUND_TOLERANCE
): Ground {
  const { width, height, data } = img;
  const band = Math.max(1, Math.round(borderFraction * Math.min(width, height)));
  const onBorder = (x: number, y: number) => x < band || x >= width - band || y < band || y >= height - band;

  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let border = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!onBorder(x, y)) continue;
      const i = (y * width + x) * 3;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cell = counts.get(key);
      if (cell === undefined) counts.set(key, { n: 1, r, g, b });
      else {
        cell.n++;
        cell.r += r;
        cell.g += g;
        cell.b += b;
      }
      border++;
    }
  }

  if (border === 0) return { hex: '#000000', share: 0, extent: 0, confident: false };

  // Ties broken by the lower key, so the answer does not depend on Map insertion order — which is
  // to say on the order the image happened to be scanned in.
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const [, cell] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (cell.n > best.n) best = cell;
  }
  const ground = hex(best.r / best.n, best.g / best.n, best.b / best.n);
  const [gr, gg, gb] = [
    Number.parseInt(ground.slice(1, 3), 16),
    Number.parseInt(ground.slice(3, 5), 16),
    Number.parseInt(ground.slice(5, 7), 16),
  ];

  // `< tolerance` and not `<=`, so this is the exact complement of measure.ts's ink test, which is
  // `d >= INK_THRESHOLD`. A pixel is ground here if and only if it would not be ink there.
  let inBand = 0;
  let inAll = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const d = Math.max(Math.abs(data[i]! - gr), Math.abs(data[i + 1]! - gg), Math.abs(data[i + 2]! - gb));
      if (d >= tolerance) continue;
      inAll++;
      if (onBorder(x, y)) inBand++;
    }
  }

  const share = inBand / border;
  return {
    hex: ground,
    share,
    extent: inAll / (width * height),
    confident: share >= GROUND_CONFIDENT_SHARE,
  };
}
