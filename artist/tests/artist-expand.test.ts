// Two encoders widening one shelf, over corpora whose two answers are known before the run.
//
// The real expansion needs both 19,791-row matrices. What is under test is the part that can be
// wrong without looking wrong: that the seeds are excluded from what is added, that each arm's
// additions are deduplicated, that the chance baseline is the one two independent draws would
// produce — and above all that the verdict flips on `AGREEMENT_RATIO`, fixed before any real number
// was seen, and is willing to print NOTHING MEASURED against the build it exists to justify.

import test from 'node:test';
import assert from 'node:assert/strict';
import { expansion, expansionText } from '../expand.js';
import { DIM as CLIP_DIM } from '../clip-index.js';
import { DIM as DINO_DIM } from '../dino.js';
import type { AlignedSpaces } from '../second-space.js';
import type { Resolved } from '../influences.js';

const N = 40;
const SEEDS = [0, 10, 20, 30];

/**
 * Works laid out along an arc, so a work's nearest neighbours are its neighbours in `order`.
 *
 * `order(i)` is where work `i` sits on the arc, and the two spaces are given different orders. The
 * multiplier 7 is coprime to 40 and its inverse mod 40 is 23, so a DINO neighbour of `i` is
 * `i +- 23`, never `i +- 1`. That makes the two arms provably disjoint rather than approximately so.
 */
function arc(n: number, dim: number, order: (i: number) => number): Float32Array {
  const rows = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    const a = (order(i) * Math.PI) / (2 * n);
    rows[i * dim] = Math.cos(a);
    rows[i * dim + 1] = Math.sin(a);
  }
  return rows;
}

const identity = (i: number) => i;
const shuffled = (i: number) => (i * 7) % N;

function spaces(dinoOrder: (i: number) => number, n = N): AlignedSpaces {
  return {
    entries: Array.from({ length: n }, (_, i) => ({
      sha256: `s${i}`,
      row: i,
      aliases: [],
      // Every third work is a print, so the 2D column has something to count and the corpus share
      // it is read against is not 0 or 1.
      work: { id: `w${i}`, source: i % 2 === 0 ? 'met' : 'aic', classification: i % 3 === 0 ? 'Print' : 'Vase' } as never,
    })),
    clipRows: arc(n, CLIP_DIM, identity),
    dinoRows: arc(n, DINO_DIM, dinoOrder),
    n,
  };
}

const resolved = (shas: string[]): Resolved =>
  ({ positionId: 'fixture', works: shas.map((sha256) => ({ sha256 })) }) as never;

const seedShas = SEEDS.map((i) => `s${i}`);

test('the arms add works that are not seeds, deduplicated, and the pool is what is left', () => {
  const e = expansion(resolved(seedShas), 2, spaces(identity));
  assert.equal(e.seeds, 4);
  assert.equal(e.seedsMissing, 0);
  assert.equal(e.pool, N - 4);
  for (const a of e.arms) {
    assert.equal(a.added.length, new Set(a.added).size, `${a.name} added a work twice`);
    for (const s of a.added) assert.ok(!seedShas.includes(s), `${a.name} added the seed ${s}`);
  }
  // Two neighbours drawn from each of four seeds, none of which collide on this layout.
  assert.equal(e.arms[0]!.added.length, 8);
});

test('a seed that is in neither matrix is counted, not silently dropped', () => {
  const e = expansion(resolved([...seedShas, 'not-in-the-corpus']), 2, spaces(identity));
  assert.equal(e.seeds, 4);
  assert.equal(e.seedsMissing, 1);
});

test('chance overlap is what two independent draws of these two sizes would give', () => {
  const e = expansion(resolved(seedShas), 2, spaces(shuffled));
  const [clip, dino] = e.arms as [typeof e.arms[0], typeof e.arms[0]];
  assert.ok(Math.abs(e.sharedChance - (clip.added.length * dino.added.length) / e.pool) < 1e-12);
  // 8 * 8 / 36. Not a round number on purpose: an overlap of 1 here is already at chance, which is
  // the whole reason the report cannot quote a raw count.
  assert.ok(Math.abs(e.sharedChance - 64 / 36) < 1e-12, `sharedChance ${e.sharedChance}`);
});

test('one space used twice reaches the same works, and the report says so', () => {
  const e = expansion(resolved(seedShas), 2, spaces(identity));
  assert.equal(e.shared, 8);
  const text = expansionText(e);
  assert.match(text, /NOTHING MEASURED/);
  // The refusal has to name the share it refused on, or a reader cannot tell the threshold was
  // fixed in advance rather than chosen to fit.
  assert.match(text, /100\.0% is most of the smaller arm, over the 50\.0% fixed/);
});

test('two spaces that order the corpus differently widen it somewhere new', () => {
  const e = expansion(resolved(seedShas), 2, spaces(shuffled));
  assert.equal(e.shared, 0);
  const text = expansionText(e);
  assert.doesNotMatch(text, /NOTHING MEASURED/);
  assert.match(text, /are NOT reaching the same works/);
  // And the sentence that keeps this from becoming a quality claim, which is the only thing the
  // measurement could be mistaken for.
  assert.match(text, /Nothing here measured relevance/);
});

test('many times chance is not the same as largely the same works', () => {
  // The regression this pins shipped for one run. The verdict was first a ratio of observed overlap
  // to chance overlap with a threshold of 3x, and the first real position tripped it at 31x while
  // the two arms shared only 21% of the smaller — four fifths of each arm being works the other
  // encoder never reached. Over a big pool chance overlap is a fraction of a work, so ANY agreement
  // is many times chance, and both arms start from the same seeds, which guarantees some.
  //
  // 2,000 works, 20 seeds every 100. The DINO layout is identical below 500 and reshuffled above it,
  // so the five seeds in the identical region contribute overlapping neighbours and the other
  // fifteen do not: a quarter share, at many times chance.
  const n = 2000;
  const partly = (i: number) => (i < 500 ? i : 500 + ((i - 500) * 7) % 1500);
  const seeds = Array.from({ length: 20 }, (_, s) => `s${s * 100}`);
  const e = expansion(resolved(seeds), 2, spaces(partly, n));

  const share = e.shared / Math.min(...e.arms.map((a) => a.added.length));
  const ratio = e.shared / e.sharedChance;
  assert.ok(ratio > 5, `ratio ${ratio} is not the many-times-chance case this test is about`);
  assert.ok(share < 0.5, `share ${share} is not the low-share case this test is about`);

  const text = expansionText(e);
  assert.doesNotMatch(text, /NOTHING MEASURED/);
  assert.match(text, /are NOT reaching the same works/);
  // And the report has to say out loud that the chance figure is not what decided it, because a
  // reader who sees a 12x will otherwise supply the old, wrong conclusion themselves.
  assert.match(text, /That number is NOT the test/);
});

test('an arm is not guaranteed to score higher in its own space, and the report no longer says it is', () => {
  const e = expansion(resolved(seedShas), 2, spaces(shuffled));
  const [clip] = e.arms as [typeof e.arms[0]];
  // The report first read "each arm is nearer the seeds in its OWN space by construction". This
  // fixture is the counterexample that killed that sentence, and it is pinned here so it cannot be
  // written again: the search maximises nearness to INDIVIDUAL seeds, while the column is nearness
  // to their CENTROID, and on a layout where the two spaces disagree the CLIP arm's additions come
  // out marginally nearer the seed centroid in DINO's space than in CLIP's own.
  assert.ok(
    clip.toSeedsInClip < clip.toSeedsInDino,
    `expected the counterexample, got ${clip.toSeedsInClip} >= ${clip.toSeedsInDino}`
  );
  const text = expansionText(e);
  assert.match(text, /An arm is NOT guaranteed to score higher in its own space/);
  assert.doesNotMatch(text, /by construction/);
});

test('a set with no work in either matrix is an error, not an empty report', () => {
  assert.throws(() => expansion(resolved(['nowhere']), 2, spaces(identity)), /none of fixture's works/);
});
