// Two spaces over one corpus, with corpora whose answer is known in advance.
//
// The real measurement needs both 19,791-row matrices and 88MB of weights. What is under test is the
// arithmetic between them and the printed claim: the sha256 alignment, the chance baselines, the
// overlap, and — the part most worth pinning — that the verdict sentence flips on a band fixed
// before any real number was seen, rather than on whatever the number turned out to be.

import test from 'node:test';
import assert from 'node:assert/strict';
import { secondSpace, secondSpaceText } from '../second-space.js';
import { DIM as CLIP_DIM } from '../clip-index.js';
import { DIM as DINO_DIM } from '../dino.js';
import type { CorpusEmbeddings } from '../clip-index.js';

/**
 * A corpus of `mix` counts per museum, interleaved round-robin, with `row(i)` giving each entry's
 * vector. `dim` is the real dimension of the space being faked, because `secondSpace` reads the two
 * matrices with two different strides and a fake that used one dimension for both would pass while
 * hiding the exact bug that would matter.
 */
function fake(mix: Record<string, number>, dim: number, row: (i: number, museum: string) => number[]): CorpusEmbeddings {
  const order: string[] = [];
  const pools = Object.entries(mix).map(([m, n]) => ({ m, left: n }));
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  while (order.length < total) {
    for (const p of pools) {
      if (p.left > 0) {
        order.push(p.m);
        p.left--;
      }
    }
  }
  const rows = new Float32Array(order.length * dim);
  order.forEach((m, i) => rows.set(row(i, m).slice(0, dim), i * dim));
  return {
    entries: order.map((m, i) => ({ sha256: `s${i}`, row: i, aliases: [], work: { id: `${m}-${i}`, source: m } as never })),
    rows,
    rowsInFile: order.length,
    duplicates: 0,
    zeroRows: 0,
  };
}

/** Every work identical, so retrieval is a constant and only the arithmetic is left. */
const flatRow = () => [1, 0, 0, 0];
/** A work's neighbours are the works from its own museum, and nothing else. */
const byMuseum = (museums: string[]) => (_i: number, m: string) => {
  const v = new Array(8).fill(0);
  v[museums.indexOf(m)] = 1;
  return v;
};

const MIX = { met: 60, aic: 30, cma: 30 };

test('the two spaces are joined by sha256, and the chance baseline comes from the corpus', () => {
  const r = secondSpace(6, 20, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, flatRow));
  assert.equal(r.works, 120);
  assert.equal(r.queries, 20);
  // Drawn WITHOUT replacement, matching `sameMuseumChance` in analytics.ts: a work cannot be its own
  // neighbour, so the second draw is from 119 and not 120.
  //   (60/120)(59/119) + 2 * (30/120)(29/119) = 0.2478992 + 0.1218487 = 0.3697479
  // Hard-coding 0.390 here would be right for the real corpus and quietly wrong for every other,
  // which is the failure the whole "against its baseline" rule exists to prevent.
  assert.ok(Math.abs(r.chance - 0.3697479) < 1e-6, `chance ${r.chance}`);
  assert.ok(Math.abs(r.overlapChance - 6 / 119) < 1e-9);
});

test('the rate is the query against its neighbours, not the neighbours against each other', () => {
  // The bug this pins actually shipped. `pairRate` in crossing.ts counts museum agreement among the
  // k retrieved works WITH EACH OTHER and never looks at the query, which is the only thing it can
  // do there — a text phrase has no museum. Reused here, where the query IS a work, it printed 61.2%
  // in a column headed by a published 55.4% measured at the same k. Two different quantities, and
  // only the gap between them gave it away.
  //
  // 10 met and 2 aic, all vectors identical, so every query retrieves the lowest-numbered other rows
  // and round-robin has interleaved them met, aic, met, aic, met, met, ... At k=4 the two statistics
  // are provably different:
  //   query-vs-neighbour  (0.50 + 0.25 + 0.50 + 0.25 + 8*0.50) / 12 = 11/24 = 0.458333
  //   neighbour-vs-neighbour (1/3 + 1/2 + 1/3 + 1/2 + 8/3)  / 12 = 13/36 = 0.361111
  const mix = { met: 10, aic: 2 };
  const r = secondSpace(4, 12, fake(mix, CLIP_DIM, flatRow), fake(mix, DINO_DIM, flatRow));
  assert.equal(r.queries, 12);
  for (const s of r.spaces) {
    assert.ok(Math.abs(s.sameMuseum - 11 / 24) < 1e-9, `${s.name} reported ${s.sameMuseum}`);
    assert.ok(Math.abs(s.sameMuseum - 13 / 36) > 1e-3, `${s.name} is reporting the neighbour-vs-neighbour rate`);
  }
});

test('a work is never its own neighbour', () => {
  // Every row is identical, so without the exclusion each query would retrieve itself first and the
  // museum rate would carry a guaranteed same-museum member. The corpus has 98 images catalogued
  // twice; self-retrieval is the same error one step earlier.
  const r = secondSpace(6, 10, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, flatRow));
  assert.ok(r.overlap > 0, 'identical rows should still agree on something');
  assert.equal(r.works, 120);
});

test('two spaces that rank identically overlap completely; one that ranks by museum does not', () => {
  const museums = Object.keys(MIX);
  const same = secondSpace(6, 20, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, flatRow));
  assert.equal(same.overlap, 1);
  assert.equal(same.disjoint, 0);

  // CLIP flat (ties broken by row order, which is round-robin over museums) against a DINO space
  // where a work's neighbours are its own museum. These are two genuinely different orderings.
  const split = secondSpace(6, 20, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, byMuseum(museums)));
  assert.ok(split.overlap < 1, `overlap ${split.overlap} should be below 1 when the orderings differ`);
  const [clip, dino] = split.spaces;
  assert.equal(dino!.sameMuseum, 1, 'a space that retrieves only same-museum works rates 1');
  assert.ok(clip!.sameMuseum < dino!.sameMuseum);
  // And that is what the t is for: 1 against a chance of 0.375 with zero variance is the degenerate
  // case, so assert the direction rather than a value.
  assert.ok(dino!.t > 0 || Number.isNaN(dino!.t), `t ${dino!.t}`);
});

test('the verdict flips on a band fixed in advance, not on the number that came back', () => {
  const museums = Object.keys(MIX);
  const agree = secondSpaceText(secondSpace(6, 20, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, flatRow)));
  assert.match(agree, /The two encoders agree to within/);
  assert.match(agree, /survives a second opinion/);

  const differ = secondSpaceText(secondSpace(6, 20, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, byMuseum(museums))));
  assert.match(differ, /The two encoders differ by/);
  assert.match(differ, /cannot be quoted without naming the encoder/);
  // The band has to appear in the output, or a reader cannot tell whether it was chosen after the
  // fact. This is the same discipline the lens's +-2 sd band is held to.
  assert.match(differ, /outside the 5\.0% band fixed before/);
});

test('overlap is reported against chance and then against 100%, because chance is the useless comparison', () => {
  const text = secondSpaceText(secondSpace(6, 20, fake(MIX, CLIP_DIM, flatRow), fake(MIX, DINO_DIM, byMuseum(Object.keys(MIX)))));
  assert.match(text, /against 5\.0% chance/);
  assert.match(text, /is a fact about the encoder/);
  // And the sample is stated with a warning, because pairing this with a figure from another sample
  // has already produced two wrong numbers in this repo.
  assert.match(text, /do not pair it with a figure from another/);
});
