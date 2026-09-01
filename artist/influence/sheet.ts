// Contact sheets: a grid of images with a caption strip under each.
//
// Shared by the pair test (the ten tightest pairs, side by side) and the sweep (one column per k).
// Deliberately the dumbest thing that works — box-filter downscale, nearest-neighbour glyphs from a
// 5x7 bitmap font, PNG out. There is no image library in this repo's dependencies beyond `jpeg-js`
// and `pngjs`, and adding one to draw a caption would be a poor trade.
//
// The captions are the point. A contact sheet of ten pairs with no numbers under them is a picture
// of a claim rather than evidence for it: the reader cannot tell the tightest pair from the tenth
// without the distance printed on the cell.

import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { decode, type Rgb } from '../pixels.js';

export const CELL = 240;
export const CAPTION_HEIGHT = 26;
const PAD = 6;

/** Box-filter downscale to fit inside `w` x `h`, letterboxed on white. Aspect ratio is preserved. */
function fit(img: Rgb, w: number, h: number): Rgb {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(w * h * 3).fill(255);
  const ox = (w - dw) >> 1;
  const oy = (h - dh) >> 1;

  for (let y = 0; y < dh; y++) {
    // Source band for this destination row, so downscaling averages rather than samples. A
    // nearest-neighbour shrink of an engraving turns its hatching into moire, which is exactly the
    // property the texture layer is being asked about.
    const y0 = Math.floor((y * img.height) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * img.width) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 3;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          n++;
        }
      }
      const j = ((y + oy) * w + (x + ox)) * 3;
      out[j] = Math.round(r / n);
      out[j + 1] = Math.round(g / n);
      out[j + 2] = Math.round(b / n);
    }
  }
  return { width: w, height: h, data: out };
}

// A 5x7 bitmap font, one 5-bit row per byte, enough for the characters a caption here uses.
// Anything not in the table draws as a blank, so an unexpected character costs a gap and never an
// exception in the middle of writing a sheet.
const GLYPHS: Record<string, number[]> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  a: [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f], b: [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x1e],
  c: [0x00, 0x00, 0x0e, 0x10, 0x10, 0x11, 0x0e], d: [0x01, 0x01, 0x0d, 0x13, 0x11, 0x11, 0x0f],
  e: [0x00, 0x00, 0x0e, 0x11, 0x1f, 0x10, 0x0e], f: [0x06, 0x09, 0x08, 0x1c, 0x08, 0x08, 0x08],
  g: [0x00, 0x0f, 0x11, 0x11, 0x0f, 0x01, 0x0e], h: [0x10, 0x10, 0x16, 0x19, 0x11, 0x11, 0x11],
  i: [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e], j: [0x02, 0x00, 0x06, 0x02, 0x02, 0x12, 0x0c],
  k: [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12], l: [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  m: [0x00, 0x00, 0x1a, 0x15, 0x15, 0x15, 0x15], n: [0x00, 0x00, 0x16, 0x19, 0x11, 0x11, 0x11],
  o: [0x00, 0x00, 0x0e, 0x11, 0x11, 0x11, 0x0e], p: [0x00, 0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10],
  q: [0x00, 0x0d, 0x13, 0x13, 0x0d, 0x01, 0x01], r: [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  s: [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e], t: [0x08, 0x08, 0x1c, 0x08, 0x08, 0x09, 0x06],
  u: [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0d], v: [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04],
  w: [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0a], x: [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  y: [0x00, 0x11, 0x11, 0x11, 0x0f, 0x01, 0x0e], z: [0x00, 0x00, 0x1f, 0x02, 0x04, 0x08, 0x1f],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  '-': [0, 0, 0, 0x1f, 0, 0, 0], '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], ' ': [0, 0, 0, 0, 0, 0, 0],
};

function drawText(px: Uint8Array, W: number, text: string, x0: number, y0: number, grey = 40): void {
  let x = x0;
  for (const ch of text.toLowerCase()) {
    const g = GLYPHS[ch];
    if (g) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if ((g[r]! >> (4 - c)) & 1) {
            const i = ((y0 + r) * W + x + c) * 3;
            if (i >= 0 && i + 2 < px.length) {
              px[i] = grey;
              px[i + 1] = grey;
              px[i + 2] = grey;
            }
          }
        }
      }
    }
    x += 6;
  }
}

export interface Cell {
  /** Path to a jpg or png. A cell with no image draws as an empty box with its caption. */
  image: string | null;
  /** One or two short lines under the image. Truncated to fit the cell, never wrapped. */
  caption: string[];
}

/**
 * Write a `cols`-wide grid of cells to `out` as a PNG.
 *
 * A cell whose image fails to decode is drawn as a grey box rather than aborting the sheet: the
 * sheet is evidence about the other cells too, and losing all of it to one bad file would be the
 * wrong trade.
 */
export function contactSheet(cells: Cell[], cols: number, out: string): void {
  const rows = Math.ceil(cells.length / cols);
  const cw = CELL + PAD * 2;
  const ch = CELL + CAPTION_HEIGHT + PAD * 2;
  const W = cols * cw;
  const H = rows * ch;
  const px = new Uint8Array(W * H * 3).fill(255);

  cells.forEach((cell, i) => {
    const cx = (i % cols) * cw + PAD;
    const cy = Math.floor(i / cols) * ch + PAD;
    if (cell.image) {
      let img: Rgb | null = null;
      try {
        img = fit(decode(cell.image), CELL, CELL);
      } catch {
        img = null;
      }
      if (img) {
        for (let y = 0; y < CELL; y++) {
          for (let x = 0; x < CELL; x++) {
            const s = (y * CELL + x) * 3;
            const d = ((cy + y) * W + cx + x) * 3;
            px[d] = img.data[s]!;
            px[d + 1] = img.data[s + 1]!;
            px[d + 2] = img.data[s + 2]!;
          }
        }
      } else {
        for (let y = 0; y < CELL; y++)
          for (let x = 0; x < CELL; x++) {
            const d = ((cy + y) * W + cx + x) * 3;
            px[d] = 220;
            px[d + 1] = 220;
            px[d + 2] = 220;
          }
      }
    }
    cell.caption.slice(0, 2).forEach((line, li) => {
      drawText(px, W, line.slice(0, Math.floor(CELL / 6)), cx, cy + CELL + 4 + li * 10);
    });
  });

  const png = new PNG({ width: W, height: H });
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    png.data[j] = px[i]!;
    png.data[j + 1] = px[i + 1]!;
    png.data[j + 2] = px[i + 2]!;
    png.data[j + 3] = 255;
  }
  writeFileSync(out, PNG.sync.write(png));
}
