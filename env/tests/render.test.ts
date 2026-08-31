// Step 9/10 of the build order: what a render leaves on disk, and what may and may not touch it.
//
// The one claim worth defending here is that canonical.png is causal and nothing cosmetic can reach
// it. So the same program is rendered twice plainly, once with both presentation options on, and
// once with --trace-masks, and all four canonical images have to be the same bytes. Renders are the
// expensive thing (six in this file, in four CLI runs), so every test reads from those four runs
// rather than starting its own.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodePng, pixelHash } from '../png.js';
import { canonicalJson, contentHash } from '../profile.js';
import { grain, misregister } from '../present.js';
import type { Bounds, ResolvedProgram } from '../../renderer/resolve.js';
import { EMPTY_PACK, GROUND, program, solidNode, testProfile, washNode } from './helpers.js';

const SLOW = { timeout: 300_000 };
const W = 240;
const H = 240;

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'studio', 'render.js');

/** Two leaves: enough for a mask each, cheap enough to render six times. */
const PROGRAM = program([washNode('a', 80, 80), solidNode('b', 110, 110)], {
  canvas: { width: W, height: H, ground: GROUND, brushScale: 3 },
});

let dir = '';
const out = (name: string) => path.join(dir, name);

async function render(outName: string, ...flags: string[]): Promise<void> {
  await execFileAsync(process.execPath, [
    CLI,
    out('program.json'),
    '-o',
    out(outName),
    '-p',
    out('test.profile.json'),
    '-a',
    out('pack.json'),
    ...flags,
  ]);
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'medium-render-'));
  writeFileSync(out('program.json'), JSON.stringify(PROGRAM));
  writeFileSync(out('test.profile.json'), JSON.stringify(testProfile()));
  writeFileSync(out('pack.json'), JSON.stringify(EMPTY_PACK));
  await render('plain-1');
  await render('plain-2');
  await render('presented', '--grain', '0.05', '--misregister', '3,2');
  await render('masked', '--trace-masks');
}, SLOW);

test('canonical.png is byte-identical across two runs of the same program', SLOW, () => {
  const a = readFileSync(out('plain-1/canonical.png'));
  const b = readFileSync(out('plain-2/canonical.png'));
  assert.ok(a.equals(b), 'two runs of the same program produced different canonical bytes');
});

test('trace.json records the pixel hash canonical.png actually has', SLOW, () => {
  const trace = JSON.parse(readFileSync(out('plain-1/trace.json'), 'utf8')) as {
    canonical: { width: number; height: number; pixelHash: string };
    resolved: { hash: string };
    renderer: { warmupRenders: number; browser: { version: string } };
    timings: { settleFrames: number };
  };
  const png = decodePng(readFileSync(out('plain-1/canonical.png')));

  assert.equal(png.width, trace.canonical.width);
  assert.equal(png.height, trace.canonical.height);
  assert.equal(pixelHash(png.rgba), trace.canonical.pixelHash);

  // ...and the trace says which configuration that hash was produced under.
  assert.ok(trace.renderer.browser.version.length > 0);
  assert.ok(trace.renderer.warmupRenders >= 1);
  assert.ok(trace.timings.settleFrames >= 1);

  // resolved.json is canonicalJson(resolved), so the recorded hash is the hash of those bytes.
  const bytes = readFileSync(out('plain-1/resolved.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), trace.resolved.hash);
});

test('resolved.json has one entry per resolved node, with a world matrix and bounds', SLOW, () => {
  const text = readFileSync(out('plain-1/resolved.json'), 'utf8');
  const resolved = JSON.parse(text) as ResolvedProgram;

  assert.equal(text, canonicalJson(resolved), 'resolved.json is not in canonicalJson key order');
  assert.equal(contentHash(resolved), createHash('sha256').update(text).digest('hex'));

  assert.equal(resolved.nodes.length, resolved.counts.resolvedNodes);
  assert.deepEqual(
    resolved.nodes.map((n) => n.id),
    ['a', 'b']
  );
  for (const node of resolved.nodes) {
    assert.equal(node.world.length, 6, `${node.id}: world matrix should be a 2x3 affine`);
    assert.ok(node.world.every((n) => Number.isFinite(n)));
    assert.ok(node.bounds.w > 0 && node.bounds.h > 0, `${node.id}: empty bounds`);
    assert.equal(typeof node.seed, 'number');
    assert.equal(node.rngKey, `key-${node.id}`);
  }
});

test('presentation options change display.png and cannot change canonical.png', SLOW, () => {
  const plain = readFileSync(out('plain-1/canonical.png'));
  const presented = readFileSync(out('presented/canonical.png'));
  assert.ok(plain.equals(presented), 'a presentation option reached the canonical image');

  const display = readFileSync(out('presented/display.png'));
  assert.ok(!display.equals(presented), 'display.png is the canonical image unchanged');
  assert.ok(!existsSync(out('plain-1/display.png')), 'display.png was written with nothing asked for');

  // The structural reason: both passes copy, so neither can write through to the pixels it was
  // handed, whoever hands them over and in whatever order.
  const canonical = decodePng(plain);
  const untouched = Buffer.from(canonical.rgba);
  const grained = grain(canonical.rgba, canonical.width, canonical.height, { amount: 0.05, seed: 12345 });
  const shifted = misregister(canonical.rgba, canonical.width, canonical.height, { dx: 3, dy: 2 });
  assert.ok(canonical.rgba.equals(untouched), 'the presentation pass mutated its input');
  assert.ok(!grained.equals(untouched), 'grain changed nothing');
  assert.ok(!shifted.equals(untouched), 'misregister changed nothing');

  // Same inputs, same grain: it is seeded from the program seed, not from the process.
  assert.ok(grained.equals(grain(canonical.rgba, canonical.width, canonical.height, { amount: 0.05, seed: 12345 })));
});

test('--trace-masks marks exactly the pixels a node is responsible for', SLOW, () => {
  const trace = JSON.parse(readFileSync(out('masked/trace.json'), 'utf8')) as {
    masks: { id: string; file: string; changedPixels: number }[];
  };
  assert.ok(readFileSync(out('masked/canonical.png')).equals(readFileSync(out('plain-1/canonical.png'))));
  assert.deepEqual(
    trace.masks.map((m) => m.id),
    ['a', 'b']
  );

  const resolved = JSON.parse(readFileSync(out('masked/resolved.json'), 'utf8')) as ResolvedProgram;
  const boundsOf = (id: string): Bounds => resolved.nodes.find((n) => n.id === id)!.bounds;

  for (const mask of trace.masks) {
    const png = decodePng(readFileSync(out(`masked/${mask.file}`)));
    const b = boundsOf(mask.id);
    let white = 0;
    let outside = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (png.rgba[4 * (y * png.width + x)] !== 0xff) continue;
        white++;
        if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) outside++;
      }
    }
    assert.equal(white, mask.changedPixels, `${mask.id}: trace disagrees with the mask it wrote`);
    assert.ok(white > 50, `${mask.id}: omitting the node changed nothing`);
    assert.equal(outside, 0, `${mask.id}: ${outside} mask pixels fell outside its declared bounds`);
  }
});
