// `render` — turn a program into the canonical image, and into everything needed to check what that
// image is a claim about.
//
// Four artefacts, and the order they are produced in is the point:
//
//   canonical.png  the causal image: the render with the program's own `print` stages applied. No
//                  cosmetic pass ever runs on it; every diff, every hash and every downstream
//                  evaluation reads this file. It is written to disk before this command so much as
//                  inspects a presentation option. `print` is not cosmetic -- it is declared in the
//                  program, covered by the program hash, and validated against the profile -- so it
//                  belongs on this side of the line, and the trace records the plate's hash as well
//                  so what the print pass did stays visible.
//   display.png    canonical put through env/present.ts, and only when a presentation option was
//                  asked for. Nothing reads it back.
//   resolved.json  the resolved program, serialized with canonicalJson key ordering, so its sha256
//                  is exactly the `resolved.hash` recorded in the trace.
//   trace.json     the configuration the determinism claim was made under, readable on its own.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Renderer, type RendererManifest, type RenderResult } from '../env/browser.js';
import { loadPack, PackError, type AssetPack } from '../env/pack.js';
import { encodePng, pixelHash } from '../env/png.js';
import { canonicalJson, contentHash, loadProfileFor, ProfileError } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';
import { runPrint } from '../env/print.js';
import { grain, misregister } from '../env/present.js';
import type { ResolvedProgram } from '../renderer/resolve.js';
import { fontsUsed } from '../renderer/resolve.js';
import { compileSamplingPlan } from '../aesthetic/sample-compiler.js';
import { assertSamplingPlan, type SamplingCompilation } from '../aesthetic/sample-types.js';

const MASK_DIR = 'masks';

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Sorted keys, but still readable: trace.json is meant to be opened and understood by a person. */
function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`);
}

/** Only the faces the program actually uses; an unused face must not be able to change a render. */
/**
 * White where the two renders differ, black where they agree. Any of the four channels differing
 * counts: the mask is about "this pixel is not the same pixel", not about visible contrast.
 */
function diffMask(a: Buffer, b: Buffer, width: number, height: number): { rgba: Buffer; changed: number } {
  const rgba = Buffer.alloc(width * height * 4);
  let changed = 0;
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    const differs =
      a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3];
    if (differs) changed++;
    const v = differs ? 0xff : 0x00;
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = 0xff;
  }
  return { rgba, changed };
}

/** Resolved ids carry `/` and `#` from macro parts and repeat instances; the index keeps names unique. */
function maskFile(index: number, id: string): string {
  return `${String(index).padStart(4, '0')}-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
}

function parseMisregister(raw: string): { dx: number; dy: number } {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    die(`--misregister wants two numbers "dx,dy", got "${raw}"`);
  }
  return { dx: parts[0]!, dy: parts[1]! };
}

function parseGrain(raw: string): number {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1) {
    die(`--grain wants a fraction of full scale in (0, 1], got "${raw}"`);
  }
  return amount;
}

const cli = new Command()
  .name('render')
  .argument('<program.json>', 'the program to render')
  .option('-o, --out <dir>', 'output directory', 'out')
  .option('-p, --profile <id|path>', 'override the profile the program names')
  .option('-a, --pack <id|path>', 'asset pack (defaults to the pack the program names)')
  .option('--grain <amount>', 'display only: per-pixel luminance noise, as a fraction of full scale')
  .option('--misregister <dx,dy>', 'display only: pull the colour plates apart by whole pixels')
  .option('--sampling-plan <file>', 'compile this typed sampling plan into the program before validation')
  .option('--disable-sample <id...>', 'sampling-plan sample ids to ablate before rendering')
  .option('--trace-masks', 'render once per leaf with that leaf omitted, and save each diff as a mask');

interface Options {
  out: string;
  profile?: string;
  pack?: string;
  grain?: string;
  misregister?: string;
  samplingPlan?: string;
  disableSample?: string[];
  traceMasks?: boolean;
}

cli.action(async (file: string, opts: Options) => {
  const started = Date.now();
  let program = JSON.parse(readFileSync(file, 'utf8')) as { assetPack?: string; meta?: { provenance?: unknown } };
  let sampling: SamplingCompilation | null = null;
  if (opts.samplingPlan) {
    const plan: unknown = JSON.parse(readFileSync(opts.samplingPlan, 'utf8'));
    assertSamplingPlan(plan);
    sampling = compileSamplingPlan(program as Record<string, unknown>, plan, opts.disableSample ?? []);
    program = sampling.program as typeof program;
  }
  let profile, profileHash: string;
  try {
    ({ profile, hash: profileHash } = loadProfileFor(program, opts.profile));
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    return die(`/profile: ${e.message} [profile.missing]`);
  }
  let pack: AssetPack;
  const packName = opts.pack ?? program.assetPack;
  if (!packName) return die('/assetPack: this program names no asset pack [pack.missing]');
  try {
    pack = loadPack(packName);
  } catch (e) {
    // A tampered pack is a refusal like any other, not a crash.
    if (!(e instanceof PackError)) throw e;
    return die(`/assetPack: ${e.message} [pack.hash]`);
  }

  // Nothing unvalidated is ever rendered: an over-budget or malformed program is refused here, in
  // milliseconds, before a browser exists.
  const check = validateProgram(program, profile, pack);
  if (!check.valid) {
    for (const issue of check.issues) console.error(`${issue.path}: ${issue.message} [${issue.code}]`);
    return die(`invalid  ${file}  (${check.issues.length} issue${check.issues.length === 1 ? '' : 's'})`);
  }
  const resolved = check.resolved!;

  const grainAmount = opts.grain === undefined ? null : parseGrain(opts.grain);
  const offset = opts.misregister === undefined ? null : parseMisregister(opts.misregister);

  const outDir = path.resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  if (sampling) writeJson(path.join(outDir, 'sampling.json'), { ...sampling, program: undefined });

  const leaves = resolved.nodes;
  if (opts.traceMasks) {
    console.warn(
      `--trace-masks: about to spend ${leaves.length + 1} renders ` +
        `(1 canonical + 1 per resolved leaf, of which there are ${leaves.length})`
    );
  }

  const fonts = fontsUsed(resolved);
  const renderer = await Renderer.launch();
  let manifest: RendererManifest;
  let canonical: RenderResult;
  let plateHash = '';
  let printStages: { stage: string; ms: number }[] = [];
  const masks: { id: string; file: string; changedPixels: number }[] = [];
  try {
    const plate = await renderer.render(resolved, pack, fonts);
    // The print pass runs here, on the far side of the loop that proved this render repeats, and
    // never inside it. A threshold collapses small differences, so a print pass run inside the
    // self-consistency check would be a machine for making a nondeterministic render agree with
    // itself (docs/substrate-test/proposed-primitives.md).
    plateHash = pixelHash(plate.rgba);
    canonical = plate;
    if (resolved.print.length > 0) {
      const out = runPrint(plate.rgba, plate.width, plate.height, resolved.print, resolved.seed);
      canonical = { ...plate, rgba: out.rgba };
      printStages = out.stages;
    }
    // On disk before anything cosmetic is even reachable.
    writeFileSync(path.join(outDir, 'canonical.png'), encodePng(canonical.rgba, canonical.width, canonical.height));

    if (opts.traceMasks) {
      mkdirSync(path.join(outDir, MASK_DIR), { recursive: true });
      for (const [index, leaf] of leaves.entries()) {
        // Only `canvas`, `seed` and `nodes` are read at render time (renderer/draw.js), so dropping
        // one leaf from the flat list is exactly "this program without this node".
        // Masks compare plates, not prints: a threshold turns "this leaf moved four pixels" into
        // either nothing at all or a whole region, so a printed mask measures the print, not the leaf.
        const without = { ...resolved, nodes: leaves.filter((n) => n !== leaf) };
        const out = await renderer.render(without, pack, fonts);
        const mask = diffMask(plate.rgba, out.rgba, canonical.width, canonical.height);
        const name = maskFile(index, leaf.id);
        writeFileSync(path.join(outDir, MASK_DIR, name), encodePng(mask.rgba, canonical.width, canonical.height));
        masks.push({ id: leaf.id, file: `${MASK_DIR}/${name}`, changedPixels: mask.changed });
      }
    }
    manifest = renderer.manifest;
  } finally {
    await renderer.close();
  }

  writeFileSync(path.join(outDir, 'resolved.json'), canonicalJson(resolved));

  const presentStarted = Date.now();
  let display: { file: string; grain: number | null; misregister: { dx: number; dy: number } | null } | null = null;
  if (grainAmount !== null || offset !== null) {
    // A copy from the start: present.ts is pure, and canonical.rgba is never handed to it directly.
    let pixels: Buffer = Buffer.from(canonical.rgba);
    if (grainAmount !== null) {
      pixels = grain(pixels, canonical.width, canonical.height, { amount: grainAmount, seed: resolved.seed });
    }
    if (offset !== null) pixels = misregister(pixels, canonical.width, canonical.height, offset);
    writeFileSync(path.join(outDir, 'display.png'), encodePng(pixels, canonical.width, canonical.height));
    display = { file: 'display.png', grain: grainAmount, misregister: offset };
  }
  const presentMs = Date.now() - presentStarted;

  const trace = {
    program: { file: path.resolve(file), hash: check.programHash },
    // sha256 of resolved.json's bytes exactly, because that file is canonicalJson(resolved).
    resolved: { file: 'resolved.json', hash: contentHash(resolved), counts: resolved.counts },
    profile: { id: profile.id, hash: profileHash },
    pack: { id: pack.id, hash: pack.hash },
    canonical: {
      file: 'canonical.png',
      width: canonical.width,
      height: canonical.height,
      pixelHash: pixelHash(canonical.rgba),
    },
    // What the browser produced, before `print`. Equal to canonical.pixelHash when there are no
    // stages, and the only way to tell a changed render from a changed print when there are.
    plate: { pixelHash: plateHash, stages: printStages },
    display,
    masks: opts.traceMasks ? masks : null,
    budget: check.budget,
    renderer: manifest,
    warnings: [...resolved.warnings, ...canonical.warnings],
    timings: {
      drawMs: canonical.timings.drawMs,
      readMs: canonical.timings.readMs,
      // How many frames this render needed to settle. The manifest says how that is decided
      // (`settlePolicy`); this says what it cost here, and both belong in the determinism claim.
      settleFrames: canonical.timings.settleFrames,
      renderMs: canonical.timings.totalMs,
      presentMs,
      totalMs: Date.now() - started,
    },
    provenance: program.meta?.provenance,
    sampling: sampling ? {
      plan: path.resolve(opts.samplingPlan!),
      disabledSampleIds: sampling.disabledSampleIds,
      applied: sampling.constraints.filter((constraint) => constraint.supported).length,
      unsupported: sampling.unsupported,
    } : null,
  };
  writeJson(path.join(outDir, 'trace.json'), trace);

  console.log(`${outDir}`);
  console.log(
    `    canonical.png  ${canonical.width}x${canonical.height}  pixels ${trace.canonical.pixelHash.slice(0, 12)}`
  );
  console.log(
    display
      ? `    display.png    ${grainAmount === null ? '' : `grain ${grainAmount} `}${offset === null ? '' : `misregister ${offset.dx},${offset.dy}`}`.trimEnd()
      : '    display.png    not written: no presentation option asked for, so display == canonical'
  );
  if (opts.traceMasks) console.log(`    ${MASK_DIR}/         ${masks.length} masks`);
  for (const w of trace.warnings) console.warn(`    warning: ${w}`);
});

await cli.parseAsync();
