// Builds the human wall-test kit.
//
// 36 probe renders + 10 baseline renders, shuffled by a fixed seed so the sheet is reproducible and
// the answer key is recoverable, numbered 01..46 and otherwise unlabelled. The numbers are drawn
// from a 3x5 bitmap font defined here rather than by the medium, because the medium is the thing
// under test and must not appear in its own instrument.
//
// SEEDS_ON_SHEET is 3 rather than the 5 the batch renders, deliberately. The trait table's closing
// finding is that the seed changes almost nothing in a print-style program while the design changes
// everything, so the sheet spends its rows on twelve designs rather than on six designs seen five
// times each. The batch still renders all five per probe; the sheet samples the first three.
//
// Run from the repo root:  node docs/substrate-test/tools/wall-test.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { PROBES } from './seeds.mjs';

const SEEDS_ON_SHEET = 3;
const BASELINE = [
  'event-picture-edited', 'event-picture', 'hill-feast', 'poster-less-is-more',
  'v01', 'v05', 'v09', 'v13', 'v17', 'v19',
];

const OUT = 'out/substrate-test/wall-test';
const COLS = 4;
const CELL = 400;
const LABEL_H = 30;
const GAP = 10;
const BG = [24, 24, 26];
const FG = [190, 190, 186];

const DIGITS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

function readPng(file) {
  const png = PNG.sync.read(readFileSync(file));
  return { rgba: png.data, width: png.width, height: png.height };
}

// Box-average downscale, the same choice env/sheet.ts makes and for the same reason: a thumbnail
// that aliases invents texture, and texture is exactly what the viewer is being asked to judge.
function thumbnail(src, maxW, maxH) {
  const scale = Math.min(maxW / src.width, maxH / src.height, 1);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      const sums = [0, 0, 0, 0];
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = 4 * (sy * src.width + sx);
          for (let c = 0; c < 4; c++) sums[c] += src.rgba[i + c];
          n++;
        }
      }
      const o = 4 * (y * width + x);
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(sums[c] / n);
    }
  }
  return { rgba: out, width, height };
}

function shuffle(items, seed) {
  // Mulberry32. Fixed seed, so this sheet can be rebuilt byte-identically and the key still holds.
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const entries = [
  ...PROBES.flatMap((p) => Array.from({ length: SEEDS_ON_SHEET }, (_, i) => i + 1).map((s) => ({
    kind: 'probe', probe: p, source: `out/substrate-test/batch/${p}/${p}-s${s}/canonical.png`, name: `${p}-s${s}`,
  }))),
  ...BASELINE.map((n) => ({
    kind: 'baseline', probe: '-', source: `out/substrate-test/batch/baseline/${n}/canonical.png`, name: n,
  })),
];

const order = shuffle(entries, 0x5c0ff01d);
const rows = Math.ceil(order.length / COLS);
const stepX = CELL + GAP;
const stepY = CELL + LABEL_H + GAP;
const width = COLS * stepX + GAP;
const height = rows * stepY + GAP;
const sheet = Buffer.alloc(width * height * 4);
for (let p = 0; p < width * height; p++) {
  const i = 4 * p;
  [sheet[i], sheet[i + 1], sheet[i + 2], sheet[i + 3]] = [BG[0], BG[1], BG[2], 0xff];
}

function drawText(text, left, top, scale) {
  let cx = left;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (!glyph) { cx += 2 * scale; continue; }
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const i = 4 * ((top + gy * scale + sy) * width + cx + gx * scale + sx);
            [sheet[i], sheet[i + 1], sheet[i + 2], sheet[i + 3]] = [FG[0], FG[1], FG[2], 0xff];
          }
        }
      }
    }
    cx += 4 * scale;
  }
}

const key = [];
order.forEach((entry, index) => {
  const id = String(index + 1).padStart(2, '0');
  const thumb = thumbnail(readPng(entry.source), CELL, CELL);
  const cellLeft = GAP + (index % COLS) * stepX;
  const cellTop = GAP + Math.floor(index / COLS) * stepY;
  const left = cellLeft + Math.floor((CELL - thumb.width) / 2);
  const top = cellTop + Math.floor((CELL - thumb.height) / 2);
  for (let y = 0; y < thumb.height; y++) {
    thumb.rgba.copy(sheet, 4 * ((top + y) * width + left), 4 * y * thumb.width, 4 * (y + 1) * thumb.width);
  }
  drawText(id, cellLeft + 4, cellTop + CELL + 6, 4);
  key.push({ id, kind: entry.kind, probe: entry.probe, name: entry.name });
});

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/sheet.png`, PNG.sync.write(Object.assign(new PNG({ width, height }), { data: sheet })));

writeFileSync(
  `${OUT}/responses.csv`,
  ['image_id,viewer,answer (yes / no),note', ...key.map((k) => `${k.id},,,`)].join('\n') + '\n',
);
writeFileSync(
  `${OUT}/ANSWER-KEY.csv`,
  ['image_id,kind,probe,program', ...key.map((k) => `${k.id},${k.kind},${k.probe},${k.name}`)].join('\n') + '\n',
);
console.log(`wall-test sheet ${width}x${height}, ${order.length} images, ${key.filter((k) => k.kind === 'probe').length} probe / ${key.filter((k) => k.kind === 'baseline').length} baseline`);
