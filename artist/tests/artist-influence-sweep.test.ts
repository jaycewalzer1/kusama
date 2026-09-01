// One sweep, end to end, at two values of k.
//
// Every other test in this layer is arithmetic over hand-built rows. This one is the only place the
// influence layer touches pixels: it writes a program, runs the repo's own renderer under hermetic
// Chromium, feeds the PNG to the Python descriptor worker, and measures the distance from what came
// back to the target the dial asked for. It is slow and it is the only test that can catch the
// layer being wired to nothing.
//
// It is guarded three ways, and skips rather than fails when any is missing:
//   - the descriptor worker's venv (`workerAvailable`), same guard `artist-influence-descriptors`
//     uses, because a fresh clone has no venv until `influence/requirements.txt` is installed;
//   - `dist/studio/render.js`, which only exists after a build;
//   - `.browsers/`, the hermetic Chromium that `npx playwright install chromium` fetches.
// A fresh clone therefore reports this as SKIPPED, with a message naming what is missing, and the
// suite still goes green. That is the same contract `artist-dino.test.ts` has.
//
// Two k values, not six: k=0 and k=1. k=0 must reproduce the source program byte for byte because
// no colour has moved, and k=1 must actually recolour. Two is the smallest number that can show the
// dial doing something, and a six-step sweep in the suite would cost six serial renders for no more
// evidence. Renders are strictly serial regardless (NOTES R8).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESCRIPTOR_VERSION, DIMS, LAYERS, OFFSETS, ROW, workerAvailable, workerUnavailableMessage, type Stats } from '../influence/descriptors.js';
import { PAIR_TEST_VERDICT, type DirectionsFile } from '../influence/directions.js';
import { applyInfluence } from '../influence/apply.js';
import { SWEEPABLE, recolour, runSweep, targetCentres } from '../influence/sweep.js';
import { FIELDS } from '../influence/packs.js';
import type { Program } from '../../env/edits.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RENDERER = path.join(ROOT, 'dist', 'studio', 'render.js');
const BROWSERS = path.join(ROOT, '.browsers');
const WEIGHTS = JSON.parse(readFileSync(path.join(ROOT, 'influence', 'bizarreness.json'), 'utf8')) as {
  weights: Record<string, number>;
};

function why(): string | false {
  const missing: string[] = [];
  if (!workerAvailable()) missing.push(workerUnavailableMessage());
  if (!existsSync(RENDERER)) missing.push(`no renderer at ${path.relative(ROOT, RENDERER)} — run \`npx tsc -p tsconfig.json\``);
  if (!existsSync(BROWSERS)) missing.push('no hermetic Chromium in .browsers — run `npx playwright install chromium`');
  return missing.length ? `an end-to-end sweep needs pixels.\n${missing.join('\n')}` : false;
}
const skip = why();

/**
 * A target that is a real place in colour space, reached by moving away from a plausible mean.
 *
 * The mean is mid-grey Lab (50, 0, 0) in every centre and the direction pushes L down and a up, so
 * at k=1 the six centres are a dark warm set that no sRGB clamp will touch. Building it by hand
 * rather than reading `corpus/directions.v1.json` keeps the test independent of a 29 MB cache that
 * a fresh clone does not have.
 */
function stats(): Stats {
  const mean = new Array(ROW).fill(0);
  const std = new Array(ROW).fill(1);
  const c = FIELDS.palette['centres']!;
  for (let i = 0; i < 6; i++) {
    mean[OFFSETS.palette + c.at + i * 3] = 50;
    mean[OFFSETS.palette + c.at + i * 3 + 1] = 0;
    mean[OFFSETS.palette + c.at + i * 3 + 2] = 0;
    std[OFFSETS.palette + c.at + i * 3] = 10;
    std[OFFSETS.palette + c.at + i * 3 + 1] = 10;
    std[OFFSETS.palette + c.at + i * 3 + 2] = 10;
  }
  return { version: DESCRIPTOR_VERSION, rows: 100, mean, std };
}

function directions(): DirectionsFile {
  const vector = new Array(DIMS.palette).fill(0);
  const c = FIELDS.palette['centres']!;
  // Six centres walked apart from each other, so the snap in `recolour` has somewhere to send
  // different source colours. A single repeated centre would collapse the whole palette to one hex
  // and the test would prove less than it looks like it proves.
  for (let i = 0; i < 6; i++) {
    vector[c.at + i * 3] = -2 + i * 0.5; // L*: 30 at the first centre, 55 at the last
    vector[c.at + i * 3 + 1] = 1.5; // a*: warm
    vector[c.at + i * 3 + 2] = 0.5;
  }
  return {
    version: DESCRIPTOR_VERSION,
    generated: '2026-09-02T00:00:00.000Z',
    descriptorMatrix: 'synthetic — built inside artist-influence-sweep.test.ts',
    minWorks: 15,
    permutations: 200,
    cohesionZ: -2,
    pairTestVerdict: PAIR_TEST_VERDICT,
    groups: [
      {
        id: 'a-hand',
        label: 'A Hand',
        kind: 'person',
        works: 30,
        source: 'pixels',
        directions: {
          armature: null,
          palette: {
            magnitude: 5,
            spread: 1,
            cohesionZ: -3,
            cohesive: true,
            coverage: 1,
            source: 'pixels',
            // Copied off the real verdict rather than written as `false`, so that a re-run of the
            // pair test that changed the answer would change this fixture with it.
            carriesInfluence: PAIR_TEST_VERDICT.palette,
            vector,
          },
          texture: null,
          form: null,
          subject: null,
          discourse: null,
        },
      },
    ],
    packs: [],
  } as unknown as DirectionsFile;
}

/**
 * The sweep source: a tracked example, not an invented program.
 *
 * A hand-written program here was rejected by `schema.program` with 112 issues, which is the schema
 * doing its job — but it also means any program this test invents is a second, unversioned claim
 * about what the renderer accepts. `tear-strata` is one of the seven v1 examples the golden set
 * already renders, so it is known to be valid, known to be small (520x700), and it carries four
 * palette entries plus a ground for `recolour` to snap.
 */
const SOURCE = path.join(ROOT, 'examples', 'v1', 'tear-strata.json');
function program(): Program {
  return JSON.parse(readFileSync(SOURCE, 'utf8')) as Program;
}

// --- the parts that need no pixels ---------------------------------------------------------------

test('only palette is sweepable, and the file says why the other three are not', () => {
  // The Stage 4 result in one assertion: the one layer the pair test validated (`texture`) is not in
  // this list, and the one layer in this list is one the pair test called a null. Anything that
  // widened SWEEPABLE without an actual edit to go with it would be a lie in pictures.
  assert.deepEqual(SWEEPABLE, ['palette']);
  assert.equal(PAIR_TEST_VERDICT.palette, false, 'the sweepable layer is the one that failed the pair test');
  assert.equal(PAIR_TEST_VERDICT.texture, true, 'the layer that passed cannot be swept');
  const src = readFileSync(path.join(ROOT, 'artist', 'influence', 'sweep.ts'), 'utf8');
  for (const l of LAYERS) assert.match(src, new RegExp(`\`${l}\``), `sweep.ts never mentions ${l}`);
});

test('recolour snaps every colour and the ground, and returns a new program', () => {
  const src = program();
  const before = JSON.stringify(src);
  const centres = targetCentres(applyInfluence(src, directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights).target);
  const { program: out, changed } = recolour(src, centres);
  assert.equal(JSON.stringify(src), before, 'recolour mutated its input');
  assert.notEqual(JSON.stringify(out), before, 'recolour changed nothing');

  const names = changed.map((c) => c.name).sort();
  assert.deepEqual(names, ['bone', 'canvas.ground', 'ink', 'rust', 'slate'], 'every palette entry and the ground move');
  for (const c of changed) assert.match(c.to, /^#[0-9a-f]{6}$/, `${c.name} -> ${c.to} is not a hex colour`);
  const allowed = new Set(centres.map((_, i) => i));
  assert.equal(allowed.size, 6);
});

test('at k=0 the target is the corpus mean and recolour still snaps, because 6 centres is not 3 colours', () => {
  // A tempting wrong assertion is "k=0 leaves the program alone". It does not: k=0 means the target
  // is the corpus mean, and snapping three arbitrary colours onto six mid-grey centres still moves
  // them. What k=0 guarantees is that the target has no direction in it, not that the edit is a
  // no-op — and the sweep report is honest about that by printing the distance, not the diff.
  const zero = applyInfluence(program(), directions(), 'a-hand', 'palette', 0, stats(), WEIGHTS.weights);
  const c = FIELDS.palette['centres']!;
  assert.ok(Math.abs(zero.target[c.at]! - 50) < 1e-9, 'k=0 is the corpus mean L*');
  assert.equal(targetCentres(zero.target).length, 6);
});

// --- the part that needs pixels ------------------------------------------------------------------

test('a two-step sweep renders, describes and measures both columns', { skip, timeout: 600_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'influence-sweep-'));
  try {
    const src = path.join(dir, 'source.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(src, JSON.stringify(program(), null, 2) + '\n');

    const s = stats();
    const sets = [0, 1].map((k) => applyInfluence(program(), directions(), 'a-hand', 'palette', k, s, WEIGHTS.weights));
    const report = await runSweep(src, sets, 'palette', s, dir);

    assert.deepEqual(report.ks, [0, 1]);
    assert.equal(report.layer, 'palette');
    assert.equal(report.sweepable, true);
    assert.equal(report.carriesInfluence, false, 'the report must keep saying palette failed the pair test');
    assert.equal(report.steps.length, 2);

    for (const step of report.steps) {
      assert.equal(step.edited, true, `k=${step.k} rendered the unmodified program`);
      assert.ok(existsSync(path.join(step.dir, 'canonical.png')), `k=${step.k} produced no pixels`);
      assert.ok(existsSync(path.join(step.dir, 'program.json')), `k=${step.k} wrote no program`);
      assert.ok(Number.isFinite(step.distance), `k=${step.k} measured no distance — the worker returned nothing`);
      assert.ok(step.metrics, `k=${step.k} has no render metrics`);
      assert.ok(step.metrics!.inkDensity > 0, `k=${step.k} rendered a blank sheet`);
      assert.equal(step.verdicts.length, sets[0]!.constraints.length);
      // The palette constraint is emitted from the same six centres `recolour` snapped to, so a
      // render that disobeyed it would mean the edit and the rule had drifted apart.
      for (const v of step.verdicts) assert.equal(v.status, 'satisfied', `k=${step.k} ${v.id}: ${v.evidence}`);
    }

    // The dial moved something. Two different targets must produce two different pictures; identical
    // hashes here would mean the sweep was rendering the same program twice and printing two numbers
    // under it, which is exactly the failure the armature column is honest about.
    const [zero, one] = report.steps;
    assert.notEqual(zero!.metrics!.pixelHash, one!.metrics!.pixelHash, 'k=0 and k=1 rendered identical pixels');
    assert.notDeepEqual(zero!.recoloured, one!.recoloured, 'k=0 and k=1 snapped to the same colours');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
