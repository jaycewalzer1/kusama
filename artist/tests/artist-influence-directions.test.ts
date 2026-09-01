// Direction arithmetic, on a corpus small enough that the right answer is known in advance.
//
// `direction = mean(group) - mean(corpus)` cannot fail. Give it fifteen works drawn at random and it
// returns a vector with a magnitude and a spread, indistinguishable in shape from one computed off
// fifteen works by one hand. That is what makes the cohesion test load-bearing and what makes this
// file necessary: the only way to know the permutation test can tell those two cases apart is to
// build both and check that it does.
//
// The synthetic corpus is three groups of twenty in a 371-dimensional space, plus filler:
//
//   TIGHT     displaced in `armature` only, with almost no scatter    -> cohesive, big magnitude
//   LOOSE     displaced the same distance, with scatter far wider     -> not cohesive
//   AVERAGE   sitting on the corpus mean                              -> magnitude near zero
//
// Everything here is deterministic. `computeDirections` seeds its own permutation draw and the rows
// come out of the same mulberry32 the rest of the influence layer uses, so a failure is a change in
// the arithmetic and never a change in the draw.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CorpusEmbeddings, CorpusEntry } from '../clip-index.js';
import type { Work } from '../manifest.js';
import { DIMS, LAYERS, OFFSETS, ROW, computeStats } from '../influence/descriptors.js';
import { COHESION_Z, MIN_WORKS, PAIR_TEST_VERDICT, TEXT_LAYERS, computeDirections, groupWorks } from '../influence/directions.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  /** The `creator` field, which is also the grouping key once normalised. */
  creator: string;
  n: number;
  /** How far this group sits from the corpus mean, in raw units, in `armature` only. */
  shift: number;
  /** Half-width of the uniform noise on every dimension. Wide means scattered. */
  noise: number;
}

const TIGHT = 'Tight Hand';
const LOOSE = 'Loose Hand';
const AVERAGE = 'Average Hand';

/**
 * Build a corpus from group specs.
 *
 * Every dimension gets noise so nothing is exactly constant — `computeStats` substitutes std 1 for a
 * zero-variance column, and a synthetic corpus that leaned on that substitution would be testing the
 * substitution rather than the direction.
 */
function corpus(specs: Spec[], seed = 7): { emb: CorpusEmbeddings; rows: Float32Array } {
  const total = specs.reduce((a, s) => a + s.n, 0);
  const rows = new Float32Array(total * ROW);
  const entries: CorpusEntry[] = [];
  const rand = mulberry32(seed);
  let r = 0;
  for (const s of specs) {
    for (let i = 0; i < s.n; i++) {
      for (let j = 0; j < ROW; j++) {
        const base = j >= OFFSETS.armature && j < OFFSETS.armature + DIMS.armature ? s.shift : 0;
        rows[r * ROW + j] = base + (rand() - 0.5) * 2 * s.noise;
      }
      entries.push({ work: { creator: s.creator, title: `w${r}`, medium: '', classification: '' } as Work, sha256: `sha-${r}`, row: r, aliases: [] });
      r++;
    }
  }
  return { emb: { entries, rows, rowsInFile: total, duplicates: 0, zeroRows: 0 }, rows };
}

const SPECS: Spec[] = [
  { creator: TIGHT, n: 20, shift: 4, noise: 0.05 },
  { creator: LOOSE, n: 20, shift: 4, noise: 3 },
  { creator: AVERAGE, n: 20, shift: 0, noise: 1 },
];

function build(specs = SPECS): ReturnType<typeof computeDirections> {
  const { emb, rows } = corpus(specs);
  const stats = computeStats(rows, emb.entries.length);
  return computeDirections(emb, stats);
}

test('a group displaced in one layer gets a direction there and nowhere else', () => {
  const file = build();
  const tight = file.groups.find((g) => g.id === 'tight hand')!;
  assert.ok(tight, 'the tight group has a direction');
  assert.equal(tight.works, 20);

  const armature = tight.directions['armature']!;
  const palette = tight.directions['palette']!;
  // The shift is 4 raw units against a corpus whose armature std is dominated by the between-group
  // spread, so the z-scored displacement is order 1 per dimension over 262 dimensions.
  assert.ok(armature.magnitude > 5, `armature magnitude ${armature.magnitude} should be large`);
  assert.ok(palette.magnitude < 1, `palette magnitude ${palette.magnitude} should be near zero`);
  // Sign matters: the group sits ABOVE the corpus mean, so every armature component is positive.
  assert.ok(armature.vector!.every((v) => v > 0), 'a positive displacement produces a positive direction');
});

test('the permutation test separates a tight group from a loose one at the same displacement', () => {
  // Both groups sit the same distance from the corpus mean, so magnitude cannot tell them apart —
  // and it does not. Only cohesion does. This is the whole reason `cohesionZ` is in the file.
  const file = build();
  const tight = file.groups.find((g) => g.id === 'tight hand')!.directions['armature']!;
  const loose = file.groups.find((g) => g.id === 'loose hand')!.directions['armature']!;

  assert.ok(Math.abs(tight.magnitude - loose.magnitude) / tight.magnitude < 0.25, 'the two displacements are comparable');
  assert.ok(tight.cohesionZ! < COHESION_Z, `tight cohesionZ ${tight.cohesionZ} should clear ${COHESION_Z}`);
  assert.equal(tight.cohesive, true);
  assert.ok(loose.cohesionZ! > tight.cohesionZ!, 'a scattered group is less cohesive than a tight one');
  assert.equal(loose.cohesive, false, 'a group scattered wider than chance is not a house style');
});

test('spread is measured along the direction and is comparable to magnitude', () => {
  const file = build();
  const tight = file.groups.find((g) => g.id === 'tight hand')!.directions['armature']!;
  const loose = file.groups.find((g) => g.id === 'loose hand')!.directions['armature']!;
  // A group scattered further along its own axis than that axis is long has not gone anywhere in
  // particular. Both numbers are lengths in the same units, which is what makes that readable.
  assert.ok(tight.spread < tight.magnitude, 'a tight group is shorter than its own displacement');
  assert.ok(loose.spread > tight.spread, 'scatter shows up in spread');
});

test('a group below the corpus mean gets a direction pointing the other way', () => {
  // Two of the three groups sit at +4 and this one at 0, so the corpus mean is above it and its
  // direction is negative in every armature dimension. The sign is not decoration: `applyInfluence`
  // multiplies it by a signed k, and a direction with the wrong sign turns the dial backwards.
  const file = build();
  const avg = file.groups.find((g) => g.id === 'average hand')!.directions['armature']!;
  assert.ok(avg.vector!.every((v) => v < 0), 'a group below the corpus mean points down');
  assert.ok(Number.isFinite(avg.spread));
  assert.ok(Number.isFinite(avg.cohesionZ!));
});

test('magnitude alone barely separates a displaced group from an undisplaced one', () => {
  // Three groups on the SAME centre, differing only in scatter. Nothing here is displaced, so an
  // honest "how far from the corpus is this artist" reading should be near nothing. It is not.
  const same = build([
    { creator: 'Tight Hand', n: 20, shift: 0, noise: 0.05 },
    { creator: 'Loose Hand', n: 20, shift: 0, noise: 3 },
    { creator: 'Average Hand', n: 20, shift: 0, noise: 1 },
  ]);
  const displaced = build().groups.find((g) => g.id === 'tight hand')!.directions['armature']!.magnitude;
  const undisplaced = Object.fromEntries(same.groups.map((g) => [g.id, g.directions['armature']!.magnitude]));

  // The ordering holds — displacement does show up — but look at the size of the gap.
  for (const [id, m] of Object.entries(undisplaced)) assert.ok(m < displaced, `${id}: ${m} vs ${displaced}`);

  // A group of twenty drawn from the corpus itself, displaced by nothing at all, still returns a
  // direction 41% as long as a genuinely displaced group's — because twenty samples in 262
  // dimensions have a mean that misses, and the miss is a vector with a length. This lower bound is
  // asserted deliberately: it is the arithmetic behind the header's "a direction always exists,
  // which is the problem", and a future change that made it go away would mean the noise floor had
  // moved, not that the estimator had improved.
  assert.ok(undisplaced['loose hand']! > displaced / 3, `noise alone reached ${undisplaced['loose hand']} of ${displaced}`);

  // Cohesion is what actually tells them apart, and it does so on the same data where magnitude
  // could not. Displacement and tightness are separate questions and the file answers both.
  assert.equal(same.groups.find((g) => g.id === 'tight hand')!.directions['armature']!.cohesive, true);
  assert.equal(same.groups.find((g) => g.id === 'loose hand')!.directions['armature']!.cohesive, false);
});

test('every measured direction says it came from pixels, covers its whole layer, and carries the pair verdict', () => {
  const file = build();
  assert.equal(file.groups.length, 3);
  for (const g of file.groups) {
    for (const layer of LAYERS) {
      const d = g.directions[layer]!;
      assert.equal(d.source, 'pixels');
      assert.equal(d.coverage, 1, 'a measurement has an opinion about every dimension');
      assert.equal(d.vector!.length, DIMS[layer]);
      // The pair test's verdict travels INTO the file, so a reader of directions.v1.json alone
      // knows which of these layers was shown not to carry influence through this corpus.
      assert.equal(d.carriesInfluence, PAIR_TEST_VERDICT[layer], `${layer} must carry the pair verdict`);
    }
  }
  assert.deepEqual(file.pairTestVerdict, { ...PAIR_TEST_VERDICT, subject: false, discourse: false });
});

test('the two text layers are reserved and null, never filled with a plausible zero', () => {
  const file = build();
  for (const g of file.groups) {
    for (const l of TEXT_LAYERS) {
      // Null and not a zero vector. A zero vector would read as "this artist is exactly average in
      // subject", which is a measurement nobody made — filling these needs a model and this layer
      // calls none.
      assert.equal(g.directions[l], null, `${l} must be null, not a vector`);
    }
  }
  assert.deepEqual([...TEXT_LAYERS], ['subject', 'discourse']);
});

test('packs start empty: computeDirections measures works and authors nothing', () => {
  assert.deepEqual(build().packs, []);
});

test('a group below the minimum gets no direction at all', () => {
  const { emb } = corpus([
    { creator: 'Just Under', n: MIN_WORKS - 1, shift: 2, noise: 0.5 },
    { creator: 'Just Over', n: MIN_WORKS, shift: 2, noise: 0.5 },
  ]);
  const groups = groupWorks(emb);
  assert.deepEqual([...groups.keys()].sort(), ['just over']);
  assert.equal(groups.get('just over')!.entries.length, MIN_WORKS);
});

test('placeholders and copies are kept out of the groups they would otherwise dominate', () => {
  const { emb } = corpus([
    { creator: 'Artist unknown', n: 40, shift: 3, noise: 0.1 },
    { creator: 'Real Hand', n: 20, shift: 1, noise: 0.5 },
    // Twenty copies after one artist. They are filed under nobody: a copy is not evidence of the
    // copyist's own direction any more than it is of the original's, so it is left out of both.
    { creator: 'After Real Hand', n: 20, shift: 3, noise: 0.1 },
  ]);
  const groups = groupWorks(emb);
  assert.deepEqual([...groups.keys()].sort(), ['real hand']);
  assert.equal(groups.get('real hand')!.entries.length, 20, 'the copies did not join the original');
});

test('the file records what it was computed from, so two runs can be told apart', () => {
  const file = build();
  assert.equal(file.corpusRows, 60);
  assert.equal(file.minWorks, MIN_WORKS);
  assert.equal(file.version, 'v1');
  assert.equal(file.descriptorVersion, 'v1');
  assert.ok(file.permutations >= 100, 'a permutation test needs enough draws to have a sd');
});

test('directions are deterministic: the same corpus twice gives byte-identical vectors', () => {
  // Including the permutation baselines, which are drawn from a seeded PRNG for exactly this
  // reason. A cohesion z that moved between runs would make "cohesive" a property of the draw.
  const a = build();
  const b = build();
  assert.deepEqual(
    a.groups.map((g) => ({ id: g.id, directions: g.directions })),
    b.groups.map((g) => ({ id: g.id, directions: g.directions })),
  );
});
