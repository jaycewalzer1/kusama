// The museum-crossing statistic, with a corpus whose answer is known in advance.
//
// The real measurement needs the 19,791-row matrix and the ONNX text tower. What is under test here
// is the arithmetic between those and the printed claim: the pair rate, the chance baseline computed
// from the corpus rather than assumed, and the t against it. A fake corpus with a museum mix chosen
// by hand makes each of those checkable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { crossing, crossingText, pairRate } from '../crossing.js';
import type { CorpusEmbeddings } from '../clip-index.js';

const DIM = 4;

test('pairRate counts pairs, not works', () => {
  assert.equal(pairRate(['met', 'met', 'met']), 1);
  assert.equal(pairRate(['met', 'aic', 'cma']), 0);
  // Two of three pairs share a museum, not two of three works. The distinction is the whole reason
  // the statistic is over pairs: it is comparable with the 39.0% chance figure, which is also a pair.
  assert.equal(pairRate(['met', 'met', 'aic']), 1 / 3);
  assert.equal(pairRate(['met']), 0);
});

/**
 * A corpus of `mix` counts per museum, every row identical.
 *
 * Identical rows mean every query ties, so the top-k is whatever order the entries are in — which
 * makes the retrieval side of the measurement a constant and leaves only the arithmetic. The entries
 * are interleaved so a top-12 is not accidentally all one museum.
 */
function fakeCorpus(mix: Record<string, number>): CorpusEmbeddings {
  const museums = Object.entries(mix).flatMap(([m, n]) => Array.from({ length: n }, () => m));
  // Round-robin, so position in the list carries no museum information.
  const order: string[] = [];
  const pools = Object.entries(mix).map(([m, n]) => ({ m, left: n }));
  while (order.length < museums.length) {
    for (const p of pools) {
      if (p.left > 0) {
        order.push(p.m);
        p.left--;
      }
    }
  }
  const rows = new Float32Array(order.length * DIM);
  for (let i = 0; i < order.length; i++) rows.set([1, 0, 0, 0], i * DIM);
  return {
    entries: order.map((m, i) => ({ sha256: `s${i}`, row: i, aliases: [], work: { id: `${m}-${i}`, source: m } as never })),
    rows,
    rowsInFile: order.length,
    duplicates: 0,
    zeroRows: 0,
  };
}

const flat = async (phrases: string[]): Promise<Float32Array[]> =>
  phrases.map(() => Float32Array.from([1, 0, 0, 0]));

test('the chance baseline is computed from the corpus, not assumed', async () => {
  // 50/30/20 -> 0.25 + 0.09 + 0.04 = 0.38. If this were hard-coded at 0.390 it would be right for
  // the real corpus and quietly wrong for every other, which is the failure mode the whole
  // "against its baseline" rule exists to prevent.
  const c = await crossing(['withheld'], fakeCorpus({ met: 500, aic: 300, cma: 200 }), flat);
  assert.ok(Math.abs(c.chance - 0.38) < 1e-9, `chance ${c.chance}`);
  assert.equal(c.corpusRows, 1000);
  assert.ok(Math.abs((c.mix['met'] as number) - 0.5) < 1e-9);
});

test('a corpus from one museum makes every query rate 1, and the chance baseline 1 with it', async () => {
  const c = await crossing(['withheld'], fakeCorpus({ met: 1000 }), flat);
  assert.equal(c.chance, 1);
  assert.ok(c.queries.length > 0);
  for (const q of c.queries) assert.equal(q.rate, 1);
  assert.equal(c.mean, 1);
  // Every query is at chance, and a set that is at chance is a set that measured nothing — even
  // though every single number in it is 100%.
  assert.equal(c.atOrBelowChance, c.queries.length);
});

test('an evenly interleaved corpus puts a query below chance, and the report says which', async () => {
  const c = await crossing(['withheld'], fakeCorpus({ met: 400, aic: 400, cma: 400 }), flat);
  // Round-robin over three equal museums: a top-12 is 4/4/4, so 18 of 66 pairs share a museum.
  for (const q of c.queries) assert.ok(q.rate < c.chance + 1e-9, `${q.rate} vs ${c.chance}`);
  assert.equal(c.atOrBelowChance, c.queries.length);
  assert.ok(c.t < 0, `t ${c.t} should be negative when every query is below chance`);
});

test('the report carries the two numbers this one has to be read between', async () => {
  const text = crossingText(await crossing(['withheld'], fakeCorpus({ met: 500, aic: 300, cma: 200 }), flat));
  assert.match(text, /metadata neighbours\s+93\.6%/);
  assert.match(text, /appearance neighbours\s+55\.4%/);
  assert.match(text, /chance\s+38\.0%/);
  // And it breaks the queries down by which part of the position they came from, because a lineage
  // ref names a real work and a commitment's `why` is prose about this repo's substrate.
  for (const source of ['lineage', 'worldview', 'commitment']) assert.match(text, new RegExp(source));
});
