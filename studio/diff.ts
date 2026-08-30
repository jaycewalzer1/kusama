// `diff` — what changed between two programs, in the tree and on the page.
//
// Canonical images only: cosmetic post-processing is never diffed, or a grain seed would read as a
// change to the picture.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Renderer } from '../env/browser.js';
import { changedRegions, diffImage, pixelDiff, structuralDiff } from '../env/diff.js';
import { loadPackFor } from '../env/pack.js';
import type { AssetPack } from '../env/pack.js';
import { encodePng, pixelHash } from '../env/png.js';
import { loadProfileFor } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';
import type { ResolvedProgram } from '../renderer/resolve.js';
import { fontsUsed } from '../renderer/resolve.js';

/** Fonts a program actually asks for, so an unused face cannot change either render. */
function load(file: string, profileId: string | undefined, packId?: string): { resolved: ResolvedProgram; pack: AssetPack } {
  const program = JSON.parse(readFileSync(file, 'utf8')) as { assetPack?: string };
  const { profile } = loadProfileFor(program, profileId);
  const pack = loadPackFor(program, packId);
  const result = validateProgram(program, profile, pack);
  if (!result.valid) {
    for (const issue of result.issues) console.error(`${file}${issue.path}: ${issue.message} [${issue.code}]`);
    process.exit(1);
  }
  return { resolved: result.resolved!, pack };
}

const cli = new Command()
  .name('diff')
  .argument('<before.json>')
  .argument('<after.json>')
  .option('-p, --profile <id|path>', 'override the profile each program names')
  .option('-a, --pack <id|path>', 'asset pack (defaults to the pack the programs name)')
  .option('-o, --out <dir>', 'where to write diff.png and diff.json', '.')
  // 0.05 is the acceptance threshold the medium is built to (env/diff.ts), so it is the default.
  // Passing 1 disables the check, since spillover is a share of changed pixels and cannot exceed it.
  .option('--max-spillover <ratio>', 'exit 1 if spillover exceeds this', '0.05');

cli.action(async (beforeFile: string, afterFile: string, opts: { profile?: string; pack?: string; out: string; maxSpillover: string }) => {
  const before = load(beforeFile, opts.profile, opts.pack);
  const after = load(afterFile, opts.profile, opts.pack);
  const { canvas } = after.resolved;
  if (before.resolved.canvas.width !== canvas.width || before.resolved.canvas.height !== canvas.height) {
    console.error('the two programs have different canvas sizes, so there is nothing to compare pixel by pixel');
    process.exit(1);
  }

  const structural = structuralDiff(before.resolved, after.resolved);
  const boxes = changedRegions(before.resolved, after.resolved, structural);

  const renderer = await Renderer.launch();
  let a;
  let b;
  try {
    a = await renderer.render(before.resolved, before.pack, fontsUsed(before.resolved));
    b = await renderer.render(after.resolved, after.pack, fontsUsed(after.resolved));
  } finally {
    await renderer.close();
  }

  const pixels = pixelDiff(a.rgba, b.rgba, canvas.width, canvas.height, boxes);
  const report = {
    before: { file: beforeFile, pixels: pixelHash(a.rgba) },
    after: { file: afterFile, pixels: pixelHash(b.rgba) },
    structural,
    boxes,
    differing: pixels.differing,
    spilled: pixels.spilled,
    spillover: pixels.spillover,
  };

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(path.join(opts.out, 'diff.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    path.join(opts.out, 'diff.png'),
    encodePng(diffImage(b.rgba, canvas.width, canvas.height, boxes, pixels.mask), canvas.width, canvas.height)
  );

  const { added, removed, changed } = structural;
  console.log(`${added.length} added, ${removed.length} removed, ${changed.length} changed, ${structural.unchanged.length} untouched`);
  for (const id of [...added.map((i) => `+ ${i}`), ...removed.map((i) => `- ${i}`), ...changed.map((i) => `~ ${i}`)]) {
    console.log(`    ${id}`);
  }
  console.log(`${pixels.differing} pixels differ, ${pixels.spilled} of them outside the declared bounds`);
  console.log(`spillover ${pixels.spillover.toFixed(4)}`);
  if (pixels.spillover > Number(opts.maxSpillover)) {
    console.error(`spillover ${pixels.spillover.toFixed(4)} exceeds the ${opts.maxSpillover} allowed`);
    process.exit(1);
  }
});

await cli.parseAsync();
