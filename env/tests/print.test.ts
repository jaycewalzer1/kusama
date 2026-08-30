// The print pass is the one part of the medium that is pure CPU integer arithmetic, so its claim is
// the strongest form of the repo's claim: same buffer, same seed, same bytes -- or a refusal.
//
// These tests are that claim taken apart. Two of them only mean anything together:
//
//  * "the same seed repeats" is satisfied trivially by a stage that ignores its seed entirely, so
//    every seeded stage also has a "a different seed is a different print" test next to it. Without
//    that pair, a stage whose randomness had been accidentally hard-wired would test green forever.
//  * "amount 0 is an identity" is how an author dials an effect off. A stage that is *nearly* an
//    identity at its zero is a stage that cannot be turned off, so these are exact-byte assertions.
//
// Hashes rather than deepEqual throughout, so a failure names the stage instead of printing 1536
// bytes of diff.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrintError, printRender, runPrint } from '../print.js';
import type { PrintStage } from '../../renderer/resolve.js';

const W = 24;
const H = 16;
const SEED = 0x5eed;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * A fixed image with structure in it. A flat field would hide a halftone screen, a box blur and a
 * misregistration alike -- all three are identities on a constant image away from the edges.
 */
function image(): Buffer {
  const px = Buffer.allocUnsafe(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 4 * (y * W + x);
      px[i] = (x * 11) % 256;
      px[i + 1] = (y * 23) % 256;
      px[i + 2] = (x * y * 7) % 256;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** One realistic instance of every stage `applyStage` dispatches, in the schema's order. */
const STAGES: PrintStage[] = [
  { stage: 'threshold', cut: 0.5, dark: '#101014', light: '#f2f0e8' },
  { stage: 'posterize', levels: 3 },
  { stage: 'halftone', shape: 'dot', cell: 4, angle: 15, ink: '#101014', paper: '#f2f0e8' },
  { stage: 'grain', rngKey: 'grain', amount: 0.3, mono: true },
  { stage: 'misregister', rngKey: 'misregister', amount: 0.8, spread: 3 },
  { stage: 'paper', tint: '#f2e6c8', amount: 0.25, vignette: 0.4 },
  {
    stage: 'generation',
    rngKey: 'generation',
    passes: 2,
    cut: 0.5,
    dark: '#101014',
    light: '#f2f0e8',
    blur: 1,
    spread: 1,
    dropout: 0.12,
    speck: 0.03,
  },
];

/** The three stages that call `rng.next()`. The other four are pure functions of their pixels. */
const SEEDED = ['grain', 'misregister', 'generation'];

const stageNamed = (name: string): PrintStage => STAGES.find((s) => s.stage === name)!;

// --- determinism ---------------------------------------------------------------------------------

for (const stage of STAGES) {
  test(`the ${stage.stage} stage returns byte-identical pixels for the same input and seed`, () => {
    const a = runPrint(image(), W, H, [stage], SEED);
    const b = runPrint(image(), W, H, [stage], SEED);
    assert.equal(sha(a.rgba), sha(b.rgba));
  });
}

test('all seven stages chained repeat byte for byte', () => {
  const a = runPrint(image(), W, H, STAGES, SEED);
  const b = runPrint(image(), W, H, STAGES, SEED);
  assert.equal(sha(a.rgba), sha(b.rgba));
  assert.deepEqual(
    a.stages.map((s) => s.stage),
    STAGES.map((s) => s.stage)
  );
});

for (const name of SEEDED) {
  test(`the ${name} stage really draws on its seed, so a different seed is a different print`, () => {
    const a = runPrint(image(), W, H, [stageNamed(name)], SEED);
    const b = runPrint(image(), W, H, [stageNamed(name)], SEED + 1);
    assert.notEqual(sha(a.rgba), sha(b.rgba));
  });
}

/**
 * Two exact identities (pinned below), used only as padding so that the stage after them sees the
 * very same pixels it would have seen at index 0.
 */
const PADDING: PrintStage[] = [
  { stage: 'paper', tint: '#000000', amount: 0, vignette: 0 },
  { stage: 'misregister', rngKey: 'pad', amount: 0, spread: 0 },
];

test('a stage seeds off its rngKey, not its position, so padding it forward does not re-grain it', () => {
  // This used to assert the opposite, because the key used to be the stage's index. That made the
  // print pass the one place in the medium that seeded from position -- the thing `renderer/rng.js`
  // opens by forbidding -- and it meant inserting any stage at the front silently re-grained every
  // stage behind it. The padding is exact identities, so the grain sees identical pixels either way
  // and the only thing under test is where its seed came from.
  const first = runPrint(image(), W, H, [stageNamed('grain')], SEED);
  const third = runPrint(image(), W, H, [...PADDING, stageNamed('grain')], SEED);
  assert.equal(sha(first.rgba), sha(third.rgba));
});

test('two grain stages in one chain still differ, because their rngKeys do', () => {
  // The property the index used to provide for free, and the reason `rngKey` has to be unique: two
  // stages sharing a key would lay the identical field down twice, which is not something the
  // pixels would report as wrong. `env/validate.ts` refuses the duplicate; this pins that distinct
  // keys really do reach the seed.
  const grain = stageNamed('grain');
  const a = runPrint(image(), W, H, [{ ...grain, rngKey: 'first' }], SEED);
  const b = runPrint(image(), W, H, [{ ...grain, rngKey: 'second' }], SEED);
  assert.notEqual(sha(a.rgba), sha(b.rgba));
});

test("runPrint leaves the caller's buffer untouched, because render.ts hashes it as the plate", () => {
  const px = image();
  const before = sha(px);
  runPrint(px, W, H, STAGES, SEED);
  assert.equal(sha(px), before);
});

// --- what each stage actually does ---------------------------------------------------------------

test('threshold sends a pixel below the cut to exactly dark and one above to exactly light', () => {
  // luma is BT.601 on 0..255, so these four are 0, 255, 40 and 200 against a cut of 0.5*255 = 127.5.
  const px = Buffer.from([0, 0, 0, 255, 255, 255, 255, 200, 40, 40, 40, 128, 200, 200, 200, 0]);
  const stage: PrintStage = { stage: 'threshold', cut: 0.5, dark: '#ff0000', light: '#00ff00' };
  const out = runPrint(px, 4, 1, [stage], SEED).rgba;
  assert.deepEqual([...out], [255, 0, 0, 255, 0, 255, 0, 200, 255, 0, 0, 128, 0, 255, 0, 0]);
});

test('posterize at 2 levels leaves every channel at exactly 0 or 255', () => {
  const out = runPrint(image(), W, H, [{ stage: 'posterize', levels: 2 }], SEED).rgba;
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = out[i + c]!;
      assert.ok(v === 0 || v === 255, `byte ${i + c} is ${v}`);
    }
  }
});

test('paper at amount 0 and vignette 0 is an exact identity', () => {
  const px = image();
  const out = runPrint(px, W, H, [{ stage: 'paper', tint: '#ff00ff', amount: 0, vignette: 0 }], SEED);
  assert.equal(sha(out.rgba), sha(px));
});

test('paper on a 1x1 image returns black, not the identity its zero parameters promise', () => {
  // Documenting what it does, not what it should do. `maxR2` is `cx*cx + cy*cy` and both are 0 on a
  // 1x1 image, so `shade` is `1 - 0 * (0/0)` = NaN and the Buffer write coerces NaN to 0. Every
  // other stage is an identity at its zero on any size. Unreachable from a validated program --
  // program.schema.json puts the canvas minimum at 16x16 -- so this is a pin, not an alarm.
  const one = Buffer.from([128, 64, 32, 255]);
  const out = runPrint(one, 1, 1, [{ stage: 'paper', tint: '#ffffff', amount: 0, vignette: 0 }], SEED);
  assert.deepEqual([...out.rgba], [0, 0, 0, 255]);
});

test('grain at amount 0 is an exact identity', () => {
  const px = image();
  const out = runPrint(px, W, H, [{ stage: 'grain', amount: 0, mono: true }], SEED);
  assert.equal(sha(out.rgba), sha(px));
});

test('grain at amount 0 is an exact identity in colour too, not only mono', () => {
  const px = image();
  const out = runPrint(px, W, H, [{ stage: 'grain', amount: 0, mono: false }], SEED);
  assert.equal(sha(out.rgba), sha(px));
});

test('misregister at amount 0 is an exact identity', () => {
  const px = image();
  const out = runPrint(px, W, H, [{ stage: 'misregister', amount: 0, spread: 3 }], SEED);
  assert.equal(sha(out.rgba), sha(px));
});

test('an unknown print stage is refused with a PrintError instead of passing the pixels through', () => {
  assert.throws(
    () => runPrint(image(), W, H, [{ stage: 'emboss' }], SEED),
    (err: unknown) => err instanceof PrintError && /unknown print stage "emboss"/.test(err.message)
  );
});

test('printRender with no stages hands back the very same buffer, not a copy', () => {
  // Worth pinning because it is the one path out of this module that is not a fresh allocation: a
  // caller that then writes to the result is writing to the plate.
  const px = image();
  assert.equal(printRender(px, W, H, { print: [], seed: SEED }), px);
});

test('printRender with stages returns a new buffer and leaves the plate alone', () => {
  const px = image();
  const before = sha(px);
  const out = printRender(px, W, H, { print: STAGES, seed: SEED });
  assert.notEqual(out, px);
  assert.equal(sha(px), before);
});

// --- alpha ---------------------------------------------------------------------------------------

for (const stage of STAGES) {
  test(`the ${stage.stage} stage copies alpha through from its source byte for byte`, () => {
    const px = image();
    for (let p = 0; p < W * H; p++) px[4 * p + 3] = (p * 37) % 256;
    const out = runPrint(px, W, H, [stage], SEED).rgba;
    for (let p = 0; p < W * H; p++) {
      assert.equal(out[4 * p + 3], px[4 * p + 3], `alpha changed at pixel ${p}`);
    }
  });
}

test('a fully opaque image is still fully opaque after the whole chain', () => {
  const out = runPrint(image(), W, H, STAGES, SEED).rgba;
  for (let p = 0; p < W * H; p++) assert.equal(out[4 * p + 3], 255, `pixel ${p} lost opacity`);
});

// --- clamping ------------------------------------------------------------------------------------

// A Buffer write masks to 8 bits silently, so "no byte is outside 0..255" is unfalsifiable here.
// What a missing clamp would actually look like is wraparound: white + positive noise landing near
// zero. So these count the pixels that are pinned at the limit, which wraparound would empty out.

test('grain at amount 1 clamps white at the ceiling rather than wrapping it to near black', () => {
  const white = Buffer.alloc(W * H * 4, 255);
  const out = runPrint(white, W, H, [{ stage: 'grain', amount: 1, mono: true }], SEED).rgba;
  let pinned = 0;
  for (let p = 0; p < W * H; p++) if (out[4 * p] === 255) pinned++;
  assert.ok(pinned > W * H * 0.25, `only ${pinned} of ${W * H} pixels stayed at 255`);
});

test('grain at amount 1 clamps black at the floor rather than wrapping it to near white', () => {
  const black = Buffer.alloc(W * H * 4, 0);
  const out = runPrint(black, W, H, [{ stage: 'grain', amount: 1, mono: true }], SEED).rgba;
  let pinned = 0;
  for (let p = 0; p < W * H; p++) if (out[4 * p] === 0) pinned++;
  assert.ok(pinned > W * H * 0.25, `only ${pinned} of ${W * H} pixels stayed at 0`);
});
