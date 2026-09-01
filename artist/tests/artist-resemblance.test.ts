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
  corpusImages,
  embed,
  resemblance,
  resemblanceText,
  similarity,
  unavailableMessage,
} from '../resemblance.js';

const IMAGES = path.join(ROOT, 'corpus', 'images');
/** Pixels are gitignored, so a fresh clone has the manifest and no bytes. Both halves are needed. */
const hasPixels = existsSync(IMAGES) && readdirSync(IMAGES).some((n) => n.endsWith('.jpg'));
const runnable = available() && hasPixels;
const skip = runnable ? false : `needs the optional encoder and a corpus.\n${unavailableMessage()}`;
const noPixels = hasPixels ? false : 'corpus/images/ is empty on this machine; run `corpus images`';

test('the corpus is read from the manifest, not from a directory that no longer exists', { skip: noPixels }, () => {
  // This is the whole regression. `corpusImages` read `corpus/works/*.json` until 2026-08-31 and
  // looked correct because the branch it was written on forked before the ingest and still carried
  // that directory. On the current tree it returned zero and the command threw. No amount of reading
  // the file said so; only asking it, on this machine, against the corpus that is actually here.
  const works = corpusImages();
  assert.ok(works.length > 1000, `found ${works.length} corpus images; the manifest holds ~19,889`);
  for (const w of works.slice(0, 20)) {
    assert.ok(existsSync(w.file), `${w.id} points at ${w.file}, which is not there`);
    assert.ok(w.id.length > 0);
  }
});

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

  // Asserted on percentiles rather than on the extremes, and that is a correction, not a loosening.
  // These bounds were `min > 0.2` and `max < 0.95`, set against a 50-work corpus — 1,225 pairs. The
  // corpus is now sampled at 1,500 works, which is 1,124,250 pairs, and both bounds fail for the
  // boring reason that a thousand times as many draws reach further into both tails. The extreme of
  // a million samples is a fact about the sample size; the percentiles are a fact about the corpus.
  // Measured 2026-08-31 after deduplication: min 0.1555, p1 0.4148, median 0.6428, p99 0.8374,
  // max 0.9685 — 2 pairs under 0.20, 10 at or above 0.95, none at or above 0.99.
  const at = (p: number) => b.sorted[Math.floor(p * (b.sorted.length - 1))] as number;
  assert.ok(at(0.01) > 0.3, `1st percentile was ${at(0.01)}: a cosine over natural images does not approach 0`);
  assert.ok(at(0.99) < 0.9, `99th percentile was ${at(0.99)}: the bulk of a corpus must not read as near-identical`);

  // The one extreme that is a property of the corpus rather than of the sample size. `corpusImages`
  // keeps one row per distinct sha256; until it did, two catalogue rows sharing one photograph put
  // an exact 1.0000 in here, and the maximum is what every plate's score is read against.
  assert.ok(b.max < 0.99, `max was ${b.max}: at that similarity the corpus is holding one picture twice`);

  assert.equal(b.sorted.length, b.pairs);
  // Linear rather than sort-and-compare: this is 1.1M floats and the claim is only monotonicity,
  // which `percentile` binary-searches over.
  for (let i = 1; i < b.sorted.length; i++) {
    assert.ok((b.sorted[i] as number) >= (b.sorted[i - 1] as number), `sorted is not sorted at ${i}; percentile is a binary search over it`);
  }
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
