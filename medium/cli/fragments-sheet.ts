// `fragments-sheet` — render every fragment in a pack at three sizes in three styles.
//
// This is the only way to know whether a pack is any good: a fragment that reads as a figure at
// 110px and as a smudge at 30px is a bad fragment, and so is one that survives an outline but
// collapses under a hatch. The sheet is built row by row -- one small program and one render per
// fragment -- and the rows are pasted together in Node, so no single program has to break the
// profile's limits on text ops or resolved nodes just to be a contact sheet.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Renderer } from '../env/browser.js';
import { loadPack } from '../env/pack.js';
import type { AssetPack } from '../env/pack.js';
import { encodePng } from '../env/png.js';
import { loadProfile } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';

const LABEL_W = 200;
const CELL = 116;
const ROW_H = 150;
const HEADER_H = 46;
const SIZES = [30, 60, 110];
const WIDTH = LABEL_W + SIZES.length * 3 * CELL;

const INK = '#4a3c31';
const RUST = '#991f25';
const GROUND = '#fdf9f0';

const STYLES: { name: string; style: Record<string, unknown> }[] = [
  { name: 'wash', style: { kind: 'wash', color: 'rust', opacity: 190, bleed: 0.12, texture: [0.4, 0.3] } },
  { name: 'hatch', style: { kind: 'hatch', brush: '2B', color: 'ink', spacing: 4, angle: 35, rand: 0.1, layers: 1 } },
  { name: 'outline', style: { kind: 'outline', brush: 'pen', color: 'ink', weight: 1 } },
];

const { profile: PROFILE } = loadProfile('default');

function sheetProgram(packId: string, height: number, children: unknown[]): Record<string, unknown> {
  return {
    version: '0.2',
    profile: PROFILE.id,
    assetPack: packId,
    canvas: { width: WIDTH, height, ground: GROUND, brushScale: 1 },
    seed: 4242,
    palette: { ink: INK, rust: RUST },
    root: { id: 'root', type: 'group', children },
  };
}

function text(id: string, s: string, x: number, y: number, align: string, size = 13): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'text',
    rngKey: `sheet-${id}`,
    args: { text: s, font: 'grotesque', size, x, y, color: 'ink', align, tracking: 0.5 },
  };
}

/** The captions: which column is which style, and at what sizes. */
function headerProgram(packId: string): Record<string, unknown> {
  const children: unknown[] = [text('pack', packId, 10, 30, 'left')];
  STYLES.forEach((s, g) => {
    const centre = LABEL_W + g * 3 * CELL + (3 * CELL) / 2;
    children.push(text(`style${g}`, `${s.name}   ${SIZES.join(' / ')} px`, centre, 30, 'center'));
  });
  return sheetProgram(packId, HEADER_H, children);
}

/** One fragment, nine times: three sizes inside each of three styles. */
function rowProgram(packId: string, name: string): Record<string, unknown> {
  const children: unknown[] = [text('label', name, 10, ROW_H / 2 + 4, 'left')];
  STYLES.forEach((s, g) => {
    SIZES.forEach((span, i) => {
      const cell = g * SIZES.length + i;
      children.push({
        id: `cell${cell}`,
        type: 'op',
        op: 'fragment',
        // Every cell of the sheet gets its own key, so the same fragment at three sizes shows three
        // independent draws of the style rather than the same jitter three times.
        rngKey: `${name}/${s.name}/${span}`,
        args: {
          name,
          x: LABEL_W + cell * CELL + CELL / 2,
          y: ROW_H / 2,
          span,
          style: s.style,
        },
      });
    });
  });
  return sheetProgram(packId, ROW_H, children);
}

/** Resolve through the real validator, so the sheet cannot quietly break the profile it advertises. */
function resolveOrDie(program: Record<string, unknown>, pack: AssetPack, what: string): unknown {
  const result = validateProgram(program, { ...PROFILE, assetPacks: [pack.id] }, pack);
  if (!result.valid) {
    const issues = result.issues.map((i) => `  ${i.path}: ${i.message} [${i.code}]`).join('\n');
    throw new Error(`the ${what} row of the sheet is not a valid program:\n${issues}`);
  }
  return result.resolved;
}

function paste(dest: Buffer, destW: number, src: Buffer, srcW: number, srcH: number, atY: number): void {
  src.copy(dest, atY * destW * 4, 0, srcW * srcH * 4);
}

const cli = new Command()
  .name('fragments-sheet')
  .option('-a, --pack <id|path>', 'asset pack', 'core')
  .option('-o, --out <file>', 'where to write the sheet', 'fragments-sheet.png');

cli.action(async (opts: { pack: string; out: string }) => {
  const pack = loadPack(opts.pack);
  const names = Object.keys(pack.fragments).sort();
  if (names.length === 0) throw new Error(`asset pack "${pack.id}" has no fragments`);

  const jobs = [
    { what: 'header', height: HEADER_H, resolved: resolveOrDie(headerProgram(pack.id), pack, 'header') },
    ...names.map((name) => ({
      what: name,
      height: ROW_H,
      resolved: resolveOrDie(rowProgram(pack.id, name), pack, name),
    })),
  ];

  const height = jobs.reduce((sum, j) => sum + j.height, 0);
  const sheet = Buffer.alloc(WIDTH * height * 4);
  const renderer = await Renderer.launch();
  try {
    let y = 0;
    for (const job of jobs) {
      const out = await renderer.render(job.resolved, pack, ['grotesque']);
      paste(sheet, WIDTH, out.rgba, out.width, out.height, y);
      y += job.height;
      console.log(`    ${job.what}`);
    }
  } finally {
    await renderer.close();
  }

  const dir = path.dirname(path.resolve(opts.out));
  mkdirSync(dir, { recursive: true });
  writeFileSync(opts.out, encodePng(sheet, WIDTH, height));
  console.log(`${opts.out}  ${WIDTH}x${height}  ${names.length} fragments from ${pack.id}@${pack.hash.slice(0, 12)}`);
});

await cli.parseAsync();
