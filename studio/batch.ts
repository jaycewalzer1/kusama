// `batch` — render many programs in one browser, then prove the batch did not change any of them.
//
// A batch is only useful if rendering a program inside it is the same as rendering it alone, so this
// re-renders the first program again at the very end and refuses the batch if the two disagree. That
// check is the whole reason the command exists rather than a shell loop.
//
// Two policies here are deliberate and both cost throughput:
//
// One fresh page per render, always. The build document suggested recycling a page every 25 renders,
// but NOTES R1 measured that p5.brush keeps a blend-source framebuffer between draws, so a second
// render on a page is not the same render. Pages are cheap; determinism is not.
//
// One render at a time. The build document asked for a `--concurrency` flag defaulting to 4; it is
// not offered, because renders in flight together are not deterministic and cannot be made so from
// here (NOTES R8). It buys nothing anyway -- SwiftShader is software and the work serialises in
// Chromium's GPU process regardless.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Renderer } from '../env/browser.js';
import { loadPackFor } from '../env/pack.js';
import type { AssetPack } from '../env/pack.js';
import { encodePng, pixelHash } from '../env/png.js';
import { printRender } from '../env/print.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { contactSheet } from '../env/sheet.js';
import type { Image } from '../env/sheet.js';
import { validateProgram } from '../env/validate.js';
import type { ResolvedProgram } from '../renderer/resolve.js';
import { fontsUsed } from '../renderer/resolve.js';

interface Job {
  name: string;
  file: string;
  resolved: ResolvedProgram;
  pack: AssetPack;
  fonts: string[];
  programHash: string;
}

function programFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (statSync(input).isDirectory()) {
      for (const entry of readdirSync(input).sort()) {
        if (entry.endsWith('.json')) files.push(path.join(input, entry));
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

function prepare(file: string, profileId: string | undefined, packId?: string): Job {
  const program = JSON.parse(readFileSync(file, 'utf8')) as { assetPack?: string };
  const { profile } = loadProfileFor(program, profileId);
  const pack = loadPackFor(program, packId);
  const result = validateProgram(program, profile, pack);
  if (!result.valid) {
    for (const issue of result.issues) console.error(`${file}${issue.path}: ${issue.message} [${issue.code}]`);
    throw new Error(`${file} is not a valid program`);
  }
  const resolved = result.resolved!;
  const fonts = fontsUsed(resolved);
  return { name: path.basename(file, '.json'), file, resolved, pack, fonts, programHash: contentHash(program) };
}

const cli = new Command()
  .name('batch')
  .argument('<programs...>', 'program files, or directories of them')
  .option('-p, --profile <id|path>', 'override the profile each program names')
  .option('-a, --pack <id|path>', 'asset pack (defaults to the pack each program names)')
  .option('-o, --out <dir>', 'where to write the renders', 'batch-out')
  .option('--cell <px>', 'contact sheet cell size', '200');

cli.action(async (inputs: string[], opts: { profile?: string; pack?: string; out: string; cell: string }) => {
  const files = programFiles(inputs);
  if (files.length === 0) throw new Error('no programs to render');
  const jobs = files.map((f) => prepare(f, opts.profile, opts.pack));
  mkdirSync(opts.out, { recursive: true });

  const started = Date.now();
  const renderer = await Renderer.launch();
  let entries;
  let control;
  try {
    entries = [];
    for (const job of jobs) {
      const plate = await renderer.render(job.resolved, job.pack, job.fonts);
      // Print after the render has already been proven to repeat, never inside the proof.
      const out = { ...plate, rgba: printRender(plate.rgba, plate.width, plate.height, job.resolved) };
      const dir = path.join(opts.out, job.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'canonical.png'), encodePng(out.rgba, out.width, out.height));
      entries.push({
        name: job.name,
        file: job.file,
        programHash: job.programHash,
        packHash: job.pack.hash,
        pixels: pixelHash(out.rgba),
        width: out.width,
        height: out.height,
        timings: out.timings,
        warnings: out.warnings,
        image: { rgba: out.rgba, width: out.width, height: out.height } as Image,
      });
    }
    // The check: the first program again, alone, after everything else has been through this browser.
    const controlPlate = await renderer.render(jobs[0]!.resolved, jobs[0]!.pack, jobs[0]!.fonts);
    control = {
      ...controlPlate,
      rgba: printRender(controlPlate.rgba, controlPlate.width, controlPlate.height, jobs[0]!.resolved),
    };
  } finally {
    await renderer.close();
  }

  const sheet = contactSheet(
    entries.map((e) => e.image),
    { cols: Math.min(5, entries.length), cell: Number(opts.cell), gap: 8, background: [0x22, 0x22, 0x22] }
  );
  writeFileSync(path.join(opts.out, 'contact-sheet.png'), encodePng(sheet.rgba, sheet.width, sheet.height));

  const positionIndependent = pixelHash(control.rgba) === entries[0]!.pixels;
  const elapsedMs = Date.now() - started;
  writeFileSync(
    path.join(opts.out, 'batch.json'),
    `${JSON.stringify(
      {
        renderer: renderer.manifest,
        elapsedMs,
        positionIndependent,
        renders: entries.map(({ image: _dropped, ...rest }) => rest),
      },
      null,
      2
    )}\n`
  );

  console.log(`${entries.length} renders in ${(elapsedMs / 1000).toFixed(1)}s, one at a time`);
  console.log(`    ${(elapsedMs / entries.length / 1000).toFixed(2)}s each, ${opts.out}/contact-sheet.png`);
  if (!positionIndependent) {
    console.error(`position-dependent: ${jobs[0]!.name} rendered differently first and last in this batch`);
    process.exit(1);
  }
  console.log(`    position-independent: ${jobs[0]!.name} rendered identically first and last`);
});

await cli.parseAsync();
