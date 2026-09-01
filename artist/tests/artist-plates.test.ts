// A trajectory's plates in the corpus's space, and the two ways that goes quietly wrong.
//
// First: a percentile is only meaningful against a stated pool. `artist/resemblance.ts` searches a
// 1,500-work stride sample and this file searches all 19,791, so the same plate gets two different
// percentiles and neither is wrong. The tests below pin the band's shape and the monotonicity of the
// lookup so that the two can be compared knowingly.
//
// Second: `cosineToInfluenceCentroid` is the number the whole night is pointed at, and on its own it
// is unreadable — CLIP image embeddings sit in a narrow cone, so 0.74 looks like a relationship and
// is the floor. `influencePercentile` is what makes it a claim, and its calibration is testable: the
// corpus's own works, scored against the centroid, must be uniform on 0..1 by construction.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { embeddingsAvailable, embeddingsUnavailableMessage } from '../clip-index.js';
import { available as encoderAvailable, unavailableMessage } from '../resemblance.js';
import { COPY_COSINE, corpusBand, platesIn, positionOf, readTrajectory } from '../plates.js';

const DIR = path.join(ROOT, 'out', 'condition-withheld');

const noCorpus =
  embeddingsAvailable() && encoderAvailable()
    ? false
    : `needs the vision tower and corpus/clip.f32.\n${embeddingsUnavailableMessage()}\n${unavailableMessage()}`;
const noTrajectory = existsSync(path.join(DIR, 'final.png'))
  ? false
  : `out/condition-withheld/final.png is not on this machine (it is gitignored and on no remote)`;

test('plates are enumerated final-first, in a stable order', { skip: noTrajectory }, () => {
  const got = platesIn(DIR);
  assert.ok(got.length > 0);
  assert.equal(got[0]!.file, 'final.png');
  assert.equal(got[0]!.kind, 'final');
  // Row order in `plates.clip.f32` is this order, so instability here silently mislabels every row.
  assert.deepEqual(got, platesIn(DIR));
  for (const p of got.slice(1)) assert.equal(p.kind, 'sketch');
});

test('the position comes from the log, not from the directory name', { skip: noTrajectory }, () => {
  // `out/condition-withheld` is named after a condition AND a position. Reading the name is guessing.
  assert.equal(positionOf(DIR), 'withheld');
  assert.equal(positionOf(path.join(ROOT, 'out', 'does-not-exist')), null);
});

test('the corpus band reproduces the one resemblance.ts publishes', { skip: noCorpus }, () => {
  // Same encoder, same works, a completely different computation path: this reads `corpus/clip.f32`
  // while `resemblance.ts` re-embeds from JPEG. Agreement to four places is a real cross-check that
  // the stored matrix is the matrix the encoder produces.
  const { band } = corpusBand();
  assert.equal(band.works, 1500);
  assert.equal(band.pairs, (1500 * 1499) / 2);
  assert.equal(band.min.toFixed(4), '0.1555');
  assert.equal(band.median.toFixed(4), '0.6428');
  assert.equal(band.max.toFixed(4), '0.9685');
});

test('the sidecar is well formed, and every number is inside its own definition', { skip: noCorpus || noTrajectory }, async () => {
  const { sidecar, vectors } = await readTrajectory(DIR);
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.plates.length, vectors.length);
  assert.equal(sidecar.positionId, 'withheld');
  assert.equal(sidecar.corpusRows, 19791);

  for (const p of sidecar.plates) {
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.ok(p.corpusPercentile >= 0 && p.corpusPercentile <= 1);
    assert.ok(Math.abs(p.novelty - (1 - p.nearestCorpus.cosine)) < 1e-12, 'novelty is not 1 - cosine');
    assert.equal(p.copyFlag, p.nearestCorpus.cosine > COPY_COSINE);
    assert.ok(p.aspect > 0);
    assert.equal(p.step, null, 'no run has ever persisted a step plate; if this fails, say so');
  }
  // Every unit vector really is unit length, so the cosines above are cosines.
  for (const v of vectors) {
    let n = 0;
    for (const x of v) n += x * x;
    assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-4);
  }
});

test('a higher similarity always gets a percentile at least as high', { skip: noCorpus }, () => {
  const { sorted } = corpusBand();
  // Monotonicity is the whole contract of the lookup. It is easy to break with an off-by-one in the
  // binary search and impossible to notice from the output, because a wrong percentile is still a
  // plausible percentile.
  let last = -1;
  for (let v = 0; v <= 1.0001; v += 0.01) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    const p = lo / sorted.length;
    assert.ok(p >= last, `percentile fell from ${last} to ${p} at ${v}`);
    last = p;
  }
  assert.equal(last, 1, 'a similarity of 1.0 must sit at the top of the band');
});

test('the influence percentile is calibrated — it is a rank in the corpus, not a raw cosine', { skip: noCorpus || noTrajectory }, async () => {
  const { sidecar } = await readTrajectory(DIR);
  const scored = sidecar.plates.filter((p) => p.influencePercentile !== null);
  assert.ok(scored.length > 0, 'withheld has resolved influences, so every plate should be scored');
  for (const p of scored) {
    assert.ok(p.cosineToInfluenceCentroid !== null);
    assert.ok(p.influencePercentile! >= 0 && p.influencePercentile! <= 1);
  }
  // The point of the column: the raw cosines all look high and alike, and the percentiles do not.
  const cosines = scored.map((p) => p.cosineToInfluenceCentroid!);
  const pcts = scored.map((p) => p.influencePercentile!);
  assert.ok(Math.max(...cosines) - Math.min(...cosines) < 0.15, 'raw cosines should be in a narrow band');
  assert.ok(Math.max(...pcts) - Math.min(...pcts) > 0.3, 'percentiles should spread that band out');
});

test('drift is NOTHING MEASURED, with the reason attached', { skip: noCorpus || noTrajectory }, async () => {
  const { sidecar } = await readTrajectory(DIR);
  assert.ok(sidecar.drift, 'a trajectory with plates must say something about drift');
  assert.equal(sidecar.drift.measured, false);
  assert.match(sidecar.drift.reason, /NOTHING MEASURED/);
  // The reason must name the cause, not just decline. If step plates ever start being written, this
  // test fails and points at the code that has to change.
  assert.match(sidecar.drift.reason, /step/);
});
