// The second half of the face gate: does the face put ink on the page at all?
//
//   node docs/substrate-test/tools/face-ink.mjs out/faces-goldens
//
// This exists because the determinism gate cannot see a blank face. Nothing renders byte-identically
// to nothing, so seven variable fonts passed `golden --update` / `golden --check` across two
// independent processes with a perfect score while drawing absolutely no glyphs (NOTES O6). Agreement
// is not evidence of a capability; it is only evidence that whatever happened, happened twice.
//
// So: read each face's canonical PNG, count pixels that differ from the sheet's most common colour,
// and refuse any face whose page came out empty or nearly so. The threshold is deliberately crude --
// the face programs draw eight text ops, so a working face is thousands of pixels clear of it.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const dir = process.argv[2] ?? 'out/faces-goldens';
/** A face program draws 8 text ops plus a rule; the smallest real face measured ~1200 ink pixels. */
const MIN_INK = 400;

const rows = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.png')).sort()) {
  const png = PNG.sync.read(readFileSync(path.join(dir, file)));
  // The ground is whatever colour covers most of the sheet; taking it from the pixels rather than
  // from the program means this tool works on any PNG, including a printed one.
  const counts = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let ground = 0;
  let best = -1;
  for (const [key, n] of counts) if (n > best) { best = n; ground = key; }
  const [gr, gg, gb] = [(ground >> 16) & 255, (ground >> 8) & 255, ground & 255];
  let ink = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (Math.abs(png.data[i] - gr) + Math.abs(png.data[i + 1] - gg) + Math.abs(png.data[i + 2] - gb) > 24) ink++;
  }
  rows.push([path.basename(file, '.png'), ink]);
}

const blank = rows.filter(([, ink]) => ink < MIN_INK);
for (const [name, ink] of rows) console.log(`${ink < MIN_INK ? 'BLANK' : '  ok '} ${name.padEnd(24)} ${ink}`);
if (blank.length) {
  console.error(`\nFAIL ${blank.length} face(s) drew under ${MIN_INK} ink pixels: ${blank.map(([n]) => n).join(', ')}`);
  process.exit(1);
}
console.log(`\nok: all ${rows.length} faces put ink on the page`);
