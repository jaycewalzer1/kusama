// The rated pool and the three checks around it.
//
// Everything here is offline by construction. The pool is a person's file, the correlation gate is
// arithmetic over numbers already on disk, and `pairwise` folds comparisons somebody else made — the
// comparator that would make them is a model call and does not exist yet. That split is deliberate:
// the parts that decide whether a reward is usable must be testable without a provider.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CORRELATION_LIMIT,
  TIERS,
  TIER_NAMES,
  agreementText,
  appendRating,
  assertIndependent,
  componentCorrelations,
  componentRows,
  componentsOf,
  correlationText,
  jaccardAt,
  pairwise,
  plates,
  poolText,
  ratingsAsRanked,
  readPool,
  tierForKey,
  tierRank,
  topK,
  type Comparison,
  type Rating,
} from '../ratings.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'ratings-'));
const rating = (plate: string, tier: Rating['tier'], pixelHash = 'p'): Rating => ({
  plate,
  pixelHash,
  tier,
  rater: 'me',
  at: '2026-08-31T00:00:00.000Z',
});

// --- tiers -------------------------------------------------------------------------------------------

test('the tiers are an order with one key each, and the keys are distinct', () => {
  assert.equal(new Set(TIERS.map((t) => t.key)).size, TIERS.length);
  assert.equal(new Set(TIER_NAMES).size, TIERS.length);
  assert.deepEqual(
    TIER_NAMES.map(tierRank),
    TIER_NAMES.map((_, i) => i),
    'the rank is the position, worst first'
  );
  assert.equal(tierForKey('1'), 'discard');
  assert.equal(tierForKey('9'), null, 'an unbound key is not a rating');
  for (const t of TIERS) assert.ok(t.gloss.length > 10, 'a tier without a gloss drifts between sessions');
});

// --- the pool ----------------------------------------------------------------------------------------

test('the pool is append-only and the latest rating of a plate wins', () => {
  const file = path.join(dir(), 'ratings.jsonl');
  appendRating(rating('a', 'weak'), file);
  appendRating(rating('b', 'keep'), file);
  appendRating(rating('a', 'strong'), file);

  const view = readPool(file);
  assert.equal(view.lines, 3, 'nothing is rewritten: changing your mind adds a line');
  assert.equal(view.ratings.length, 2);
  assert.equal(view.ratings.find((r) => r.plate === 'a')!.tier, 'strong');
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3);
});

test('a resumed session sees the earlier one, which is the whole point of the file', () => {
  const file = path.join(dir(), 'ratings.jsonl');
  appendRating(rating('a', 'ok'), file);
  const first = readPool(file).ratings.map((r) => r.plate);
  appendRating(rating('b', 'ok'), file);
  assert.deepEqual(readPool(file).ratings.map((r) => r.plate), [...first, 'b']);
});

test('a line that will not parse is counted, not skipped into silence', () => {
  const file = path.join(dir(), 'ratings.jsonl');
  writeFileSync(file, `not json\n${JSON.stringify(rating('a', 'ok'))}\n${JSON.stringify({ plate: 'b' })}\n`);
  const view = readPool(file);
  assert.equal(view.malformed, 2, 'a bad line and a line missing fields are both unanswered questions');
  assert.equal(view.ratings.length, 1);
});

test('a tier nobody defined is malformed rather than a new tier', () => {
  const file = path.join(dir(), 'ratings.jsonl');
  writeFileSync(file, `${JSON.stringify({ ...rating('a', 'ok'), tier: 'brilliant' })}\n`);
  assert.equal(readPool(file).malformed, 1);
  assert.equal(readPool(file).ratings.length, 0);
});

test('a pool file that does not exist is empty, not a throw', () => {
  const view = readPool(path.join(tmpdir(), 'ratings-nonexistent-file.jsonl'));
  assert.deepEqual(view, { ratings: [], lines: 0, malformed: 0 });
});

// --- top-k -------------------------------------------------------------------------------------------

test('top-k includes everything tied with the k-th, and says how many that was', () => {
  // A five-tier scale over many plates puts a lot of things in one tier, so "the top 5" is not a set
  // the ratings determine. Cutting at exactly 5 would make the answer depend on sort order — that is,
  // on the plate names — and a Jaccard computed against an arbitrary tie-break is an arbitrary number.
  const ranked = [
    { id: 'a', score: 4 },
    { id: 'b', score: 2 },
    { id: 'c', score: 2 },
    { id: 'd', score: 2 },
    { id: 'e', score: 0 },
  ];
  const t = topK(ranked, 2);
  assert.deepEqual(t.ids, ['a', 'b', 'c', 'd']);
  assert.equal(t.tiedAtBoundary, 3);
});

test('asking for more than there is returns everything and claims no ties', () => {
  const t = topK([{ id: 'a', score: 1 }], 10);
  assert.deepEqual(t.ids, ['a']);
  assert.equal(t.tiedAtBoundary, 0);
});

test('perfect agreement is 1 and total disagreement is 0, both at the same k', () => {
  const mine = [
    { id: 'a', score: 3 },
    { id: 'b', score: 2 },
    { id: 'c', score: 1 },
    { id: 'd', score: 0 },
  ];
  assert.equal(jaccardAt(2, mine, mine).jaccard, 1);
  const inverted = mine.map((r) => ({ id: r.id, score: -r.score }));
  assert.equal(jaccardAt(2, mine, inverted).jaccard, 0);
});

test('an empty side reports null, never zero — no evidence is not disagreement', () => {
  const a = jaccardAt(5, [], []);
  assert.equal(a.jaccard, null);
  assert.equal(a.union, 0);
  assert.match(agreementText([a]), /no overlap to measure/);
});

test('the readout is per-k and carries no aggregate number', () => {
  const mine = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, score: i }));
  const theirs = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, score: i < 5 ? i : 29 - i }));
  const at = [5, 10, 20].map((k) => jaccardAt(k, mine, theirs));
  assert.equal(at[0]!.jaccard, 0, 'the judge is wrong about exactly the plates anybody would act on');
  assert.ok(at[2]!.jaccard! > at[0]!.jaccard!, 'and looks better the further down the list you ask');
  const text = agreementText(at);
  assert.match(text, /@5/);
  assert.match(text, /@20/);
  assert.doesNotMatch(text, /spearman|overall|aggregate correlation/i);
});

test('a pool of ratings becomes a ranking without becoming a score', () => {
  const ranked = ratingsAsRanked([rating('a', 'keep'), rating('b', 'discard')]);
  assert.deepEqual(topK(ranked, 1).ids, ['a']);
});

// --- pairwise ---------------------------------------------------------------------------------------

test('a pair compared in both orderings with the same answer has a verdict', () => {
  const cs: Comparison[] = [
    { first: 'a', second: 'b', winner: 'a' },
    { first: 'b', second: 'a', winner: 'a' },
  ];
  const r = pairwise(cs);
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.verdicts[0]!.winner, 'a');
  assert.equal(r.orderBias, 0);
});

test('a comparator that always says "the first one" produces no verdicts and a bias of 1', () => {
  // The failure this function exists to catch. Both answers are confident, both are consistent with
  // the other, and averaged the wrong way they would produce a clean ranking of pure position bias.
  const r = pairwise([
    { first: 'a', second: 'b', winner: 'a' },
    { first: 'b', second: 'a', winner: 'b' },
  ]);
  assert.equal(r.verdicts[0]!.winner, null);
  assert.equal(r.verdicts[0]!.agreed, false);
  assert.equal(r.orderBias, 1);
  assert.deepEqual(r.ranked, [], 'and it ranks nothing, rather than ranking by which was shown first');
});

test('a pair seen one way round only is unpaired, not a verdict at half strength', () => {
  const r = pairwise([{ first: 'a', second: 'b', winner: 'a' }]);
  assert.deepEqual(r.verdicts, []);
  assert.deepEqual(r.unpaired, [['a', 'b']]);
  assert.equal(r.orderBias, null, 'no complete pair means no bias measurement');
});

test('wins are counted over decided comparisons and give a ranking', () => {
  const both = (x: string, y: string, w: string | null): Comparison[] => [
    { first: x, second: y, winner: w },
    { first: y, second: x, winner: w },
  ];
  const r = pairwise([...both('a', 'b', 'a'), ...both('a', 'c', 'a'), ...both('b', 'c', 'b')]);
  assert.deepEqual(r.ranked.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(r.ranked[0]!.score, 1);
  assert.equal(r.ranked[2]!.score, 0);
});

test('a pair has one spelling whichever way round it was first seen', () => {
  const r = pairwise([
    { first: 'z', second: 'a', winner: null },
    { first: 'a', second: 'z', winner: null },
  ]);
  assert.deepEqual(r.verdicts[0]!.pair, ['a', 'z']);
});

// --- component correlation ---------------------------------------------------------------------------

test('components are walked out of the scores object, at every depth, numbers only', () => {
  const c = componentsOf({
    tree: 0.5,
    realization: { score: 0.25, fused: { score: 0.3 } },
    riskDeclared: true,
    termination: 'finished',
    inertSteps: null,
    affectTrace: [{ arousal: 0.2 }],
  });
  assert.deepEqual(c, { tree: 0.5, 'realization.score': 0.25, 'realization.fused.score': 0.3 });
  assert.ok(!('inertSteps' in c), 'a null is an absent measurement and must not enter as a number');
  assert.ok(!('riskDeclared' in c), 'a boolean is not a component');
  assert.ok(!('affectTrace.0.arousal' in c), 'an array is a trace, not a column');
});

test('two components that are the same number twice are caught and named', () => {
  // The documented collapse: five components correlating at 0.85 to 0.95 while looking like five
  // separate opinions in a config file. This is what that looks like with two.
  const rows = [0.1, 0.4, 0.6, 0.9, 0.3].map((v) => ({ a: v, b: v * 2, c: 1 - v * 0.05 }));
  const r = componentCorrelations(rows);
  assert.equal(r.n, 5);
  assert.deepEqual(r.components, ['a', 'b', 'c']);
  assert.equal(r.offenders.length, 3, 'a is b, and c is a straight line in a too');
  assert.equal(r.pairs[0]!.r.toFixed(3), '1.000');
  assert.throws(() => assertIndependent(r), /correlate above 0.8/);
  assert.match(correlationText(r), /OVER THE LIMIT/);
});

test('a negative correlation is just as disqualifying as a positive one', () => {
  const rows = [0.1, 0.4, 0.6, 0.9].map((v) => ({ a: v, b: 1 - v }));
  const r = componentCorrelations(rows);
  assert.equal(r.pairs[0]!.r.toFixed(3), '-1.000');
  assert.equal(r.offenders.length, 1, 'one component is the other one backwards');
});

test('genuinely independent components pass and say so quietly', () => {
  const rows = [
    { a: 0.1, b: 0.9 },
    { a: 0.4, b: 0.2 },
    { a: 0.6, b: 0.8 },
    { a: 0.9, b: 0.3 },
    { a: 0.2, b: 0.5 },
  ];
  const r = componentCorrelations(rows);
  assert.ok(Math.abs(r.pairs[0]!.r) < CORRELATION_LIMIT);
  assert.deepEqual(r.offenders, []);
  assert.doesNotThrow(() => assertIndependent(r));
  assert.match(correlationText(r), /no pair over the limit, across 1 measurable pair/);
});

test('a gate with nothing in front of it says so instead of reporting a pass', () => {
  // Under three rated plates every pair is unmeasurable, so `offenders` is empty for the same reason
  // an unasked question has no wrong answer. This was live for about ten minutes: the real pool has
  // two plates in it and the check printed "no pair over the limit" over 45 components and 0 pairs.
  const r = componentCorrelations([{ a: 1, b: 1 }, { a: 2, b: 9 }]);
  assert.deepEqual(r.pairs, []);
  assert.deepEqual(r.offenders, []);
  assert.match(correlationText(r), /NOTHING MEASURED/);
  assert.doesNotMatch(correlationText(r), /no pair over the limit/);
});

test('a component that never moves reports nothing rather than a correlation of zero', () => {
  // The exactly-0 rule. A constant column is not independent of everything, it is not evidence, and
  // `pearson` returning 0 for it would read as the cleanest result in the report.
  const rows = [
    { a: 0.1, flat: 0.5 },
    { a: 0.4, flat: 0.5 },
    { a: 0.9, flat: 0.5 },
  ];
  const r = componentCorrelations(rows);
  assert.ok(r.components.includes('flat'), 'it is a component, it just cannot be correlated');
  assert.deepEqual(r.pairs, []);
  assert.deepEqual(r.offenders, []);
});

test('a component missing from one plate is dropped by name, not defaulted to zero', () => {
  const rows: Record<string, number>[] = [{ a: 0.1, b: 0.2 }, { a: 0.4 }, { a: 0.9, b: 0.8 }];
  const r = componentCorrelations(rows);
  assert.deepEqual(r.components, ['a']);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0]!.name, 'b');
  assert.match(r.dropped[0]!.because, /1 of 3/);
});

test('under three plates there is no correlation to report, and no pair passes by default', () => {
  const r = componentCorrelations([{ a: 1, b: 1 }, { a: 2, b: 2 }]);
  assert.deepEqual(r.pairs, [], 'two points always lie on a line; a pass here would be an artifact');
  assert.deepEqual(r.offenders, []);
});

// --- disk --------------------------------------------------------------------------------------------

test('plates are the finished runs with a picture, hashed by the bytes that were looked at', () => {
  const root = dir();
  mkdirSync(path.join(root, 'one'));
  writeFileSync(path.join(root, 'one', 'final.png'), 'pixels');
  mkdirSync(path.join(root, 'two'));
  writeFileSync(path.join(root, 'two', 'final.png'), 'pixels');
  mkdirSync(path.join(root, 'unfinished'));
  writeFileSync(path.join(root, 'unfinished', 'studio.jsonl'), '');

  const found = plates(root);
  assert.deepEqual(found.map((p) => p.name), ['one', 'two']);
  assert.equal(found[0]!.pixelHash, found[1]!.pixelHash, 'the same picture hashes the same');
  assert.equal(found[0]!.pixelHash.length, 64);

  writeFileSync(path.join(root, 'two', 'final.png'), 'different pixels');
  assert.notEqual(plates(root)[0]!.pixelHash, plates(root)[1]!.pixelHash, 'and a re-render does not');
});

test('a runs directory that does not exist has no plates rather than throwing', () => {
  assert.deepEqual(plates(path.join(tmpdir(), 'ratings-nonexistent-directory')), []);
});

test('a plate whose scores cannot be read is named, not admitted as an empty row', () => {
  // An empty row has every component absent, so the intersection rule would drop every component and
  // the check would report "no pair over the limit" over nothing at all. That is the worst available
  // outcome: a gate that passes because it has been emptied.
  const root = dir();
  for (const [name, body] of [
    ['good', JSON.stringify({ scores: { tree: 0.5 } })],
    ['nojson', null],
    ['noscores', JSON.stringify({ finalProgram: {} })],
  ] as const) {
    mkdirSync(path.join(root, name));
    if (body) writeFileSync(path.join(root, name, 'final.json'), body);
  }
  const { rows, missing } = componentRows(root, ['good', 'nojson', 'noscores']);
  assert.deepEqual(rows, [{ tree: 0.5 }]);
  assert.deepEqual(missing, ['nojson', 'noscores']);
});

test('the summary counts every tier, including the ones nobody used', () => {
  const text = poolText({ ratings: [rating('a', 'keep')], lines: 1, malformed: 0 }, ['b'], ['c']);
  for (const t of TIER_NAMES) assert.match(text, new RegExp(`${t} \\d`));
  assert.match(text, /1 plate\(s\) on disk not yet rated/);
  assert.match(text, /pixels that have since changed/);
});
