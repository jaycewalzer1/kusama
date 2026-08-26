// `golden` — the committed evidence that this medium still renders what it used to.
//
// `--update` re-renders every example and rewrites goldens/. `--check` re-renders and compares pixel
// hashes, and is what CI runs. A failure is not necessarily a bug: it may mean the pinned runtime
// moved, which is exactly the thing the golden exists to notice, so the report names the runtime.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Renderer } from '../env/browser.js';
import { loadPack } from '../env/pack.js';
import { encodePng, pixelHash } from '../env/png.js';
import { contentHash, loadProfile } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed } from '../renderer/resolve.js';

interface GoldenEntry {
  programHash: string;
  packHash: string;
  profileHash: string;
  pixels: string;
}

interface GoldenIndex {
  /** The configuration these hashes were true under. Determinism is only claimed within it. */
  runtime: Record<string, unknown>;
  entries: Record<string, GoldenEntry>;
}

const cli = new Command()
  .name('golden')
  .option('-e, --examples <dir>', 'directory of programs', 'examples')
  .option('-g, --goldens <dir>', 'directory of committed renders', 'goldens')
  .option('-p, --profile <id|path>', 'medium profile', 'default')
  .option('--update', 'rewrite the goldens')
  .option('--check', 'compare against the goldens and exit 1 on any difference');

cli.action(async (opts: { examples: string; goldens: string; profile: string; update?: boolean; check?: boolean }) => {
  if (opts.update === Boolean(opts.check)) throw new Error('pass exactly one of --update or --check');
  const { profile, hash: profileHash } = loadProfile(opts.profile);
  const files = readdirSync(opts.examples)
    .filter((f) => f.endsWith('.json'))
    .sort();

  // Validate everything before the browser starts, so an invalid example costs nothing and cannot
  // leave a Chromium process behind on the way out.
  const jobs = files.map((file) => {
    const program = JSON.parse(readFileSync(path.join(opts.examples, file), 'utf8')) as { assetPack?: string };
    const pack = loadPack(program.assetPack ?? 'core');
    const result = validateProgram(program, profile, pack);
    if (!result.valid) {
      for (const issue of result.issues) console.error(`${file}${issue.path}: ${issue.message} [${issue.code}]`);
      process.exit(1);
    }
    const resolved = result.resolved!;
    return { name: path.basename(file, '.json'), program, pack, resolved, fonts: fontsUsed(resolved) };
  });

  const renderer = await Renderer.launch();
  const entries: Record<string, GoldenEntry> = {};
  const images: Record<string, Buffer> = {};
  try {
    for (const job of jobs) {
      const out = await renderer.render(job.resolved, job.pack, job.fonts);
      entries[job.name] = {
        programHash: contentHash(job.program),
        packHash: job.pack.hash,
        profileHash,
        pixels: pixelHash(out.rgba),
      };
      images[job.name] = encodePng(out.rgba, out.width, out.height);
    }
  } finally {
    await renderer.close();
  }

  const indexFile = path.join(opts.goldens, 'index.json');
  if (opts.update) {
    mkdirSync(opts.goldens, { recursive: true });
    const index: GoldenIndex = { runtime: renderer.manifest as unknown as Record<string, unknown>, entries };
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
    for (const [name, png] of Object.entries(images)) writeFileSync(path.join(opts.goldens, `${name}.png`), png);
    console.log(`wrote ${Object.keys(entries).length} goldens to ${opts.goldens}`);
    return;
  }

  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as GoldenIndex;
  const names = [...new Set([...Object.keys(index.entries), ...Object.keys(entries)])].sort();
  const failures: string[] = [];
  for (const name of names) {
    const was = index.entries[name];
    const now = entries[name];
    if (!was) failures.push(`${name}: no golden committed`);
    else if (!now) failures.push(`${name}: golden exists but the example is gone`);
    else if (was.pixels !== now.pixels) {
      const why =
        was.programHash !== now.programHash
          ? 'the program changed'
          : was.packHash !== now.packHash
            ? 'the asset pack changed'
            : was.profileHash !== now.profileHash
              ? 'the profile changed'
              : 'the inputs are identical, so the runtime moved';
      failures.push(`${name}: ${was.pixels.slice(0, 12)} -> ${now.pixels.slice(0, 12)} (${why})`);
    } else console.log(`ok  ${name}  ${now.pixels.slice(0, 12)}`);
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    const was = index.runtime['browser'] as { revision?: string } | undefined;
    const now = renderer.manifest.browser;
    console.error(`goldens were made under chromium ${was?.revision ?? '?'}; this is ${now.revision}`);
    process.exit(1);
  }
});

await cli.parseAsync();
