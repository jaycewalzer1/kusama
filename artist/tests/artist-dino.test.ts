// The second encoder: the preprocessing, and the one property that makes it worth having.
//
// Same skip discipline as `artist-resemblance.test.ts`: the weights are 88MB and gitignored, so the
// tests that need them skip by name and loudly, and the tests about what the numbers mean always
// run. The pipeline is written out separately from CLIP's on purpose — a shared preprocessing bug is
// the one error a second opinion cannot detect — so the preprocessing is what gets pinned here.

import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { ROOT } from '../../env/browser.js';
import { DIM, MODEL_PATH, MODEL_URL, SIDE, available, embed, preprocess, unavailableMessage } from '../dino.js';
import { preprocess as clipPreprocess } from '../resemblance.js';
import type { Rgb } from '../pixels.js';

const IMAGES = path.join(ROOT, 'corpus', 'images');
const hasPixels = existsSync(IMAGES) && readdirSync(IMAGES).some((n) => n.endsWith('.jpg'));
const skip = available() && hasPixels ? false : `needs the second encoder and a corpus.\n${unavailableMessage()}`;

function solid(w: number, h: number, rgb: [number, number, number]): Rgb {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 3);
  return { width: w, height: h, data };
}

test('the tensor is NCHW at the model\'s own input size', () => {
  const t = preprocess(solid(400, 300, [128, 128, 128]));
  assert.equal(t.length, 3 * SIDE * SIDE);
  assert.equal(SIDE, 224);
});

test('the normalisation is ImageNet\'s, asserted as its own constants and not as a distance from CLIP\'s', () => {
  // Written this way after the first version asserted "every channel differs from CLIP by more than
  // 0.01" and failed. It failed because it was the wrong assertion, not because the code was wrong:
  // CLIP's channel-0 statistics (0.4815 over 0.2686) and ImageNet's (0.485 over 0.229) put mid grey
  // 0.0024 apart, so an epsilon was standing in for the claim. Pin the constants the model's own
  // processor config names; that is the thing that has to be true.
  const img = solid(300, 300, [128, 128, 128]);
  const mine = preprocess(img);
  const at = (t: Float32Array, c: number) => t[c * SIDE * SIDE + 100 * SIDE + 100]!;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(at(mine, c) - (128 / 255 - MEAN[c]!) / STD[c]!) < 1e-5, `channel ${c} is ${at(mine, c)}`);
  }
  // The two pipelines must still not be the same function. They differ in the resize (256 then crop,
  // against a scale straight to 224) as well as in these constants, and a second opinion that shared
  // a preprocessing bug with the first could not detect it.
  assert.notDeepEqual([...preprocess(solid(400, 200, [200, 50, 20])).slice(0, 64)],
    [...clipPreprocess(solid(400, 200, [200, 50, 20])).slice(0, 64)]);
});

test('the shortest side sets the scale, so a wide image keeps its middle and loses its ends', () => {
  // A 1000x250 strip with a red left third. Resize takes the short side to 256, so the crop covers
  // 224/256 of the height and 224/1000ths-worth of the width — the centre. The red must be gone.
  const img = solid(1000, 250, [0, 0, 0]);
  for (let y = 0; y < 250; y++) for (let x = 0; x < 333; x++) img.data.set([255, 0, 0], (y * 1000 + x) * 3);
  const t = preprocess(img);
  const red = (128 / 255 - 0.485) / 0.229;
  let anyRed = false;
  for (let i = 0; i < SIDE * SIDE; i++) if (t[i]! > red) anyRed = true;
  assert.equal(anyRed, false, 'the centre crop of a wide strip should not reach its left third');
});

test('the embedding is unit length and stable on the same bytes', { skip }, async () => {
  const file = path.join(IMAGES, readdirSync(IMAGES).filter((n) => n.endsWith('.jpg')).sort()[0]!);
  const a = await embed(file);
  assert.equal(a.length, DIM);
  assert.equal(DIM, 384);
  let norm = 0;
  for (const v of a) norm += v * v;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5, `norm ${Math.sqrt(norm)}`);
  // The second call comes from the cache. That the cache is keyed on the image bytes AND the model
  // hash is what stops a weight swap from being blended into an existing set of numbers.
  const b = await embed(file);
  assert.deepEqual([...a], [...b]);
});

test('the weights are named so an absent encoder is a refusal with instructions, not a crash', () => {
  const msg = unavailableMessage();
  if (available()) {
    assert.equal(msg, '');
    assert.ok(existsSync(MODEL_PATH));
  } else {
    assert.match(msg, new RegExp(MODEL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
