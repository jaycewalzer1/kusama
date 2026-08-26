// `contact-sheet` — tile PNGs into one sheet, so a batch can be looked at rather than reasoned about.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { decodePng, encodePng } from '../env/png.js';
import { contactSheet } from '../env/sheet.js';

const cli = new Command()
  .name('contact-sheet')
  .argument('<images...>', 'PNG files, in the order they should appear')
  .option('-o, --out <file>', 'where to write the sheet', 'contact-sheet.png')
  .option('-c, --cols <n>', 'columns', '5')
  .option('--cell <px>', 'the box each image is fitted into', '200');

cli.action((files: string[], opts: { out: string; cols: string; cell: string }) => {
  const images = files.map((f) => decodePng(readFileSync(f)));
  const sheet = contactSheet(images, {
    cols: Number(opts.cols),
    cell: Number(opts.cell),
    gap: 8,
    background: [0x22, 0x22, 0x22],
  });
  mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, encodePng(sheet.rgba, sheet.width, sheet.height));
  console.log(`${opts.out}  ${sheet.width}x${sheet.height}  ${images.length} images`);
});

cli.parse();
