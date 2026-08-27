// Two sheets: the grid, and the strip.
//
// The grid is the only artefact in this system that can be looked at rather than read. Thirty cells,
// six positions down and five briefs across, plus a sixth column that is the control arm of the same
// briefs. Reading a table of tree scores tells you whether the checker was satisfied; looking at the
// grid tells you whether six positions produced six different kinds of picture, which is the actual
// question and is not in any of the numbers.
//
// The strip is one trajectory over time: the sheet after every accepted step. It answers a different
// question — whether the artist was working or accumulating — and it costs nothing, because every
// intermediate plate is already in the PNG cache under its program hash.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { decodePng, encodePng } from '../env/png.js';
import { contactSheet, type Image } from '../env/sheet.js';
import { readLog } from './studio-log.js';

const PNG_CACHE = path.join(ROOT, '.cache', 'artist-png');

/** A blank cell, so a missing trajectory leaves a hole in the grid rather than shifting everything. */
function blank(cell: number, shade = 0x30): Image {
  const rgba = Buffer.alloc(cell * cell * 4, shade);
  for (let p = 0; p < cell * cell; p++) rgba[4 * p + 3] = 255;
  return { rgba, width: cell, height: cell };
}

export interface GridCell {
  /** Directory of a finished trajectory, or null for a cell that was not run. */
  dir: string | null;
}

/**
 * `rows` is one row per position, each row one cell per column in order. Columns are the briefs, then
 * the control column last. Missing cells are drawn blank rather than skipped: a grid whose cells do
 * not line up with its axes is worse than no grid.
 */
export function gridSheet(rows: GridCell[][], cell = 300): { png: Buffer; missing: number } {
  const images: Image[] = [];
  let missing = 0;
  const cols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const dir = row[c]?.dir ?? null;
      const file = dir ? path.join(dir, 'final.png') : null;
      if (file && existsSync(file)) images.push(decodePng(readFileSync(file)));
      else {
        images.push(blank(cell));
        missing++;
      }
    }
  }
  const sheet = contactSheet(images, { cols, cell, gap: 10, background: [0x18, 0x18, 0x18] });
  return { png: encodePng(sheet.rgba, sheet.width, sheet.height), missing };
}

/**
 * Every plate this trajectory stood on, in order: the seed, then the result of each accepted step.
 * Pulled from the render cache by program hash, so this never opens a browser. A step whose plate has
 * been evicted from the cache is dropped, and the count of those is returned.
 */
export function strip(dir: string, cell = 220): { png: Buffer | null; frames: number; evicted: number } {
  const lines = readLog(path.join(dir, 'studio.jsonl'));
  const hashes: string[] = [];
  for (const line of lines) {
    if (line.kind === 'render') {
      const h = (line.data as { programHash: string }).programHash;
      if (hashes[hashes.length - 1] !== h) hashes.push(h);
    }
  }

  const images: Image[] = [];
  let evicted = 0;
  for (const h of hashes) {
    const file = path.join(PNG_CACHE, `${h}.png`);
    if (!existsSync(file)) {
      evicted++;
      continue;
    }
    images.push(decodePng(readFileSync(file)));
  }
  if (images.length === 0) return { png: null, frames: 0, evicted };

  const sheet = contactSheet(images, {
    cols: images.length,
    cell,
    gap: 8,
    background: [0x18, 0x18, 0x18],
  });
  return { png: encodePng(sheet.rgba, sheet.width, sheet.height), frames: images.length, evicted };
}
