// Verbalized sampling: the sampler itself, and the two schemas that feed it.
//
// The properties worth a test here are the ones that would fail silently. A sampler that quietly
// ignored the weights would still return plausible-looking sets; a sampler that was not a pure
// function of its seed would still work perfectly until the first replay.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distribution,
  normalized,
  rng,
  sampleIndices,
  streamSeed,
  tookTheMode,
  VS_K,
  type Weighted,
} from '../sampling.js';
import { FIND_SCHEMA, PROPOSE_SCHEMA } from '../schemas.js';

const w = (...ps: number[]): Weighted[] => ps.map((probability) => ({ probability }));

test('normalized sums to one whatever the model said', () => {
  for (const raw of [[0.6, 0.6, 0.6], [0.1, 0.1], [0.9], [0.2, 0.3, 0.5]]) {
    const total = normalized(w(...raw)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `${raw} normalized to ${total}`);
  }
});

test('normalized keeps the shape of what was stated', () => {
  const n = normalized(w(0.8, 0.2));
  assert.ok(n[0]! > n[1]!);
  assert.ok(Math.abs(n[0]! - 0.8) < 1e-12);
});

test('a candidate with no usable weight is floored, not dropped', () => {
  // Dropping it would shrink k and make the distribution look tighter than the model made it.
  const n = normalized([{ probability: 1 }, { probability: 0 }, { probability: Number.NaN }] as Weighted[]);
  assert.equal(n.length, 3);
  assert.ok(n[1]! > 0 && n[2]! > 0);
  assert.ok(n[0]! > 0.99);
});

test('the draw is a pure function of the seed', () => {
  const cands = w(0.4, 0.3, 0.2, 0.05, 0.05);
  const a = sampleIndices(cands, 3, rng(streamSeed(1, 'find')));
  const b = sampleIndices(cands, 3, rng(streamSeed(1, 'find')));
  assert.deepEqual(a, b);
});

test('different streams of one run seed draw differently', () => {
  // Otherwise every problem in a run would be handed the same approach index and the whole point of
  // proposing per problem would be lost.
  const seeds = ['find', 'propose:p-one', 'propose:p-two'].map((s) => streamSeed(7, s));
  assert.equal(new Set(seeds).size, 3);
});

test('no index is drawn twice', () => {
  const cands = w(0.9, 0.05, 0.03, 0.02);
  for (let s = 1; s < 200; s++) {
    const drawn = sampleIndices(cands, 4, rng(s));
    assert.equal(new Set(drawn).size, 4, `seed ${s} repeated an index`);
  }
});

test('asking for more than there are returns all of them', () => {
  const drawn = sampleIndices(w(0.5, 0.5), 5, rng(3));
  assert.equal(drawn.length, 2);
});

test('the weights are actually used', () => {
  // The whole claim of this file. A uniform sampler passes every test above and fails this one.
  const cands = w(0.95, 0.05);
  let first = 0;
  for (let s = 1; s <= 400; s++) if (sampleIndices(cands, 1, rng(s))[0] === 0) first++;
  assert.ok(first > 340 && first < 400, `heavy candidate drawn first ${first}/400 times`);
});

test('the tail is reachable — the mode is not always taken', () => {
  // The failure this stage exists to fix. If this ever comes back 400/400 the sampler has collapsed
  // back into `take the first answer` and the extra call is buying nothing.
  const cands = w(0.6, 0.25, 0.1, 0.05);
  let mode = 0;
  for (let s = 1; s <= 400; s++) if (sampleIndices(cands, 1, rng(s))[0] === 0) mode++;
  assert.ok(mode > 200 && mode < 320, `mode drawn first ${mode}/400 times`);
});

test('rng never leaves [0,1)', () => {
  const next = rng(streamSeed(42, 'x'));
  for (let i = 0; i < 10000; i++) {
    const v = next();
    assert.ok(v >= 0 && v < 1, `rng produced ${v}`);
  }
});

test('the logged distribution keeps the stated numbers, not the normalized ones', () => {
  // The record is what the model said. Renormalizing on the way to disk would destroy the evidence
  // of how badly it adds up, which is itself worth having.
  const d = distribution('find', 9, [{ key: 'a', probability: 0.6 }, { key: 'b', probability: 0.6 }], [1]);
  assert.deepEqual(d.stated.map((s) => s.probability), [0.6, 0.6]);
  assert.deepEqual(d.drawn, [1]);
});

test('tookTheMode reports the diagnostic it claims to', () => {
  const stated = [{ key: 'a', probability: 0.7 }, { key: 'b', probability: 0.3 }];
  assert.equal(tookTheMode(distribution('s', 1, stated, [0, 1])), true);
  assert.equal(tookTheMode(distribution('s', 1, stated, [1, 0])), false);
  assert.equal(tookTheMode(distribution('s', 1, [], [])), false);
});

test('both verbalized schemas require a probability on every candidate', () => {
  // A candidate without one is a ranking entry, and a ranking has no tail to sample.
  const find = (FIND_SCHEMA as any).properties.problems;
  assert.ok(find.items.required.includes('probability'));
  const propose = (PROPOSE_SCHEMA as any).properties.approaches;
  assert.ok(propose.items.required.includes('probability'));
});

test('both verbalized schemas leave room for at least k candidates', () => {
  for (const [name, field] of [
    ['find', (FIND_SCHEMA as any).properties.problems],
    ['propose', (PROPOSE_SCHEMA as any).properties.approaches],
  ] as const) {
    assert.ok(field.maxItems >= VS_K, `${name} caps candidates below k`);
  }
});

test('PROPOSE asks for no edits', () => {
  // The reason it is affordable. An approach with its edits attached costs five times the tokens and
  // four fifths of them are discarded by the draw.
  assert.ok(!JSON.stringify(PROPOSE_SCHEMA).includes('actionId'));
});
