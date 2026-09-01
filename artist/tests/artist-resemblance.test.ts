// Corpus resemblance: the reference-similarity metric with the sign flipped.
//
// Most of this file only runs when the optional encoder is installed, and that is deliberate rather
// than convenient. `onnxruntime-node` is 150MB of native runtime and the weights are another 335MB;
// requiring either would mean a fresh clone could not go green without half a gigabyte for one
// report command. So the tests that need them skip by name, loudly, and the tests that do not need
// them — the ones about what the numbers MEAN — always run.
//
// The assertion that earns the file is the last one: the corpus's own similarity band is measured
// and asserted to be narrow and off-zero. A cosine reported as though it ran 0 to 1 would be the
// same mistake `artist envelope` found in the archive's uniform binning.

import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { ROOT } from '../../env/browser.js';
import {
  MODEL_PATH,
  MODEL_SHA256,
  MODEL_URL,
  available,
  embed,
  resemblance,
  resemblanceText,
  similarity,
  unavailableMessage,
} from '../resemblance.js';

const CORPUS = path.join(ROOT, 'corpus', 'works');
const runnable = available() && existsSync(CORPUS);
const skip = runnable ? false : `needs the optional encoder and a corpus.\n${unavailableMessage()}`;

test('the weights are pinned by hash and by the url they came from', () => {
  // Every number this module produces is relative to one set of weights. A swap that was not
  // noticed would move the whole corpus band and nothing would look wrong.
  assert.match(MODEL_SHA256, /^[0-9a-f]{64}$/);
  assert.match(MODEL_URL, /^https:\/\/huggingface\.co\//);
  assert.ok(MODEL_PATH.endsWith('.onnx'));
});

test('when it cannot answer it says which half is missing and how to get it', () => {
  const msg = unavailableMessage();
  if (available()) {
    assert.equal(msg, '', 'everything is present, so there is nothing to report missing');
  } else {
    assert.ok(msg.length > 0);
    assert.match(msg, /onnxruntime-node|curl/);
  }
});

test('similarity of a unit vector with itself is 1', () => {
  const v = Float32Array.from([0.6, 0.8, 0, 0]);
  assert.ok(Math.abs(similarity(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(similarity(v, Float32Array.from([0.8, -0.6, 0, 0]))) < 1e-6);
});

test('an embedding is unit length', { skip }, async () => {
  const v = await embed(firstCorpusImage());
  assert.equal(v.length, 512);
  let norm = 0;
  for (const x of v) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-4, `norm was ${Math.sqrt(norm)}`);
});

test('the same image embeds to the same vector twice', { skip }, async () => {
  // Determinism is the substance of the work everywhere else in this repo; a descriptor that
  // wandered between calls would make every comparison below meaningless.
  const f = firstCorpusImage();
  assert.deepEqual([...(await embed(f))], [...(await embed(f))]);
});

test("the corpus's own band is narrow and nowhere near 0, which is the whole reason for reporting it", { skip }, async () => {
  const r = await resemblance([]);
  const b = r.baseline;
  assert.ok(b.works >= 2 && b.pairs === (b.works * (b.works - 1)) / 2);
  assert.ok(b.min < b.median && b.median < b.max, 'a degenerate band means the encoder is not discriminating');
  assert.ok(b.min > 0.2, `min was ${b.min}: a cosine over natural images does not reach 0, so 0 is not the floor`);
  assert.ok(b.max < 0.95, `max was ${b.max}: two corpus works that alike would mean the corpus has a duplicate in it`);
  assert.equal(b.sorted.length, b.pairs);
  assert.deepEqual(b.sorted, [...b.sorted].sort((x, y) => x - y), 'sorted must actually be sorted; percentile is a binary search over it');
});

test('the hub is disclosed, because a neighbour that is nearest to everything is not a finding', { skip }, async () => {
  const { baseline } = await resemblance([]);
  assert.ok(baseline.hub.workId.length > 0);
  assert.ok(baseline.hub.meanSimilarity > baseline.min && baseline.hub.meanSimilarity < baseline.max);
});

test('a run directory with no final.png is skipped by name, not guessed at', { skip }, async () => {
  const r = await resemblance([path.join(ROOT, 'aesthetic')]);
  assert.deepEqual(r.plates, []);
  assert.deepEqual(r.skipped, [path.join(ROOT, 'aesthetic')]);
  assert.match(resemblanceText(r), /no final\.png/);
});

test('the report says what a high number could not be', { skip }, async () => {
  // The limitation belongs on the report and not in a footnote: the artist is never shown a corpus
  // image, so this measures convergence and there is no channel by which it could measure copying.
  assert.match(resemblanceText(await resemblance([])), /convergence, not copying/);
});

function firstCorpusImage(): string {
  const dir = path.join(ROOT, 'corpus', 'images');
  const f = readdirSync(dir).filter((n) => !n.startsWith('.')).sort()[0];
  if (f === undefined) throw new Error('corpus/images/ is empty');
  return path.join(dir, f);
}
