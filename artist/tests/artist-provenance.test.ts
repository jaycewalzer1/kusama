// Provenance novelty: the corpus question and the prior-runs question.
//
// Both are driven from hand-built inputs. That is not a shortcut here, it is the only way to reach
// the interesting verdicts: the derived element set is empty until `corpus derive` has run against a
// live model, so a test restricted to what is on disk could only ever produce `unknown` and would
// pass by being unable to ask the question. The lookup is injected for the same reason `setEnvModel`
// exists — the seam is deliberate, and the last test below pins the default to the real disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { elementIds } from '../../aesthetic/elements/pack.js';
import type { DerivedFrom } from '../../aesthetic/elements/types.js';
import { priorRuns, provenance, provenanceText, type PriorRun, type SourceLookup } from '../provenance.js';

/** A source record with only the fields the corpus question reads. */
function from(creator: string | null, date: string, extra: Partial<DerivedFrom> = {}): DerivedFrom {
  return {
    corpus: 'cma',
    objectId: '1',
    url: 'https://clevelandart.org/art/1',
    date,
    creator,
    rights: 'CC0',
    imagePath: 'images/x.jpg',
    imageHash: 'x',
    readingProtocol: 'r',
    deriveProtocol: 'd',
    model: 'test',
    canonical: false,
    ...extra,
  };
}

const CHASE = 'William Merritt Chase (American, 1849–1916)';
const HOMER = 'Winslow Homer (American, 1836–1910)';
const BOUTS = 'Albert Bouts (Netherlandish, c. 1451–1549)';

/** A lookup over a table. Anything not in the table is hand-authored and answers null. */
const table = (m: Record<string, DerivedFrom>): SourceLookup => (id) => m[id] ?? null;

test('two works by one hand are not a new combination, whatever the pair does', () => {
  const r = provenance(
    ['a', 'b'],
    [],
    [],
    table({ a: from(CHASE, '1882–83'), b: from(CHASE, '1902') })
  );
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0]!.corpus, 'same-hand');
  assert.match(r.pairs[0]!.note, /Chase/);
  assert.equal(r.summary.sameHandPairs, 1);
  assert.equal(r.summary.corpusNovelPairs, 0);
});

test('different hands whose dates overlap are same-period, which is weaker and says so', () => {
  const r = provenance(
    ['a', 'b'],
    [],
    [],
    table({ a: from(CHASE, '1882–83'), b: from(HOMER, '1870–1890') })
  );
  assert.equal(r.pairs[0]!.corpus, 'same-period');
  assert.match(r.pairs[0]!.note, /overlap/);
  assert.equal(r.summary.samePeriodPairs, 1);
});

test('different hands and disjoint spans is the novel verdict', () => {
  const r = provenance(
    ['a', 'b'],
    [],
    [],
    table({ a: from(CHASE, '1882–83'), b: from(BOUTS, 'c. 1500') })
  );
  assert.equal(r.pairs[0]!.corpus, 'novel');
  assert.equal(r.summary.corpusNovelPairs, 1);
});

test('a date that parses to no year is named in the note rather than silently counted as novel', () => {
  // This is the soft spot in the whole file. "18th century" carries a period a person can read and
  // the parser cannot, and a `novel` verdict resting on it is weaker than one resting on two years.
  // It is still reported as `novel` — inventing a span would be worse — but the note has to say so.
  const r = provenance(
    ['a', 'b'],
    [],
    [],
    table({ a: from(CHASE, '1882–83'), b: from(HOMER, '18th century') })
  );
  assert.equal(r.pairs[0]!.corpus, 'novel');
  assert.match(r.pairs[0]!.note, /No year could be parsed/);
});

test('a hand-authored element makes the pair unanswerable, never novel', () => {
  const r = provenance(['a', 'hand'], [], [], table({ a: from(CHASE, '1882') }));
  assert.equal(r.pairs[0]!.corpus, 'unknown');
  assert.equal(r.summary.unknownPairs, 1);
  assert.equal(r.summary.corpusNovelPairs, 0, 'an unanswerable question is not a positive answer');
  assert.deepEqual(r.ungrounded, ['hand']);
  assert.deepEqual(r.grounded, ['a']);
});

test('a source work the probe knew is reported as contaminated, and still gets its verdict', () => {
  const r = provenance(
    ['a', 'b'],
    [],
    [],
    table({ a: from(CHASE, '1882', { canonical: true }), b: from(BOUTS, 'c. 1500') })
  );
  assert.deepEqual(r.canonical, ['a']);
  assert.equal(r.pairs[0]!.corpus, 'novel', 'contamination is reported next to the claim, not instead of it');
});

test('a pair a prior run already composed is not run-novel, and the run is named', () => {
  const prior: PriorRun[] = [
    { dir: 'out/one', elementIds: ['a', 'b', 'c'] },
    { dir: 'out/two', elementIds: ['a', 'z'] },
  ];
  const r = provenance(['a', 'b'], prior, [], table({ a: from(CHASE, '1882'), b: from(BOUTS, 'c. 1500') }));
  assert.deepEqual(r.pairs[0]!.priorRuns, ['out/one']);
  assert.equal(r.summary.runNovelPairs, 0);
  assert.equal(r.summary.priorRunsScanned, 2);
});

test('a run that used one of the two is not prior art for the pair', () => {
  const prior: PriorRun[] = [{ dir: 'out/one', elementIds: ['a'] }];
  const r = provenance(['a', 'b'], prior, [], table({ a: from(CHASE, '1882'), b: from(BOUTS, 'c. 1500') }));
  assert.deepEqual(r.pairs[0]!.priorRuns, []);
  assert.equal(r.summary.runNovelPairs, 1);
});

test('three elements give three pairs and one triple, and the triple takes the strongest co-occurrence', () => {
  const r = provenance(
    ['a', 'b', 'c'],
    [],
    [],
    table({ a: from(CHASE, '1882'), b: from(CHASE, '1902'), c: from(BOUTS, 'c. 1500') })
  );
  assert.equal(r.pairs.length, 3);
  assert.equal(r.triples.length, 1);
  assert.deepEqual(r.triples[0]!.elements, ['a', 'b', 'c']);
  // One hand made two of the three, so the triple is not a new combination either.
  assert.equal(r.triples[0]!.corpus, 'same-hand');
  assert.equal(r.summary.corpusNovelTriples, 0);
});

test('combinations have one spelling, whatever order the elements were passed', () => {
  const t = table({ a: from(CHASE, '1882'), b: from(BOUTS, 'c. 1500') });
  const x = provenance(['b', 'a'], [], [], t);
  const y = provenance(['a', 'b'], [], [], t);
  assert.deepEqual(x, y);
  assert.deepEqual(x.pairs[0]!.elements, ['a', 'b']);
});

test('one element is no combination, and the text says that rather than reporting zero of zero', () => {
  const r = provenance(['a'], [], [], table({ a: from(CHASE, '1882') }));
  assert.equal(r.pairs.length, 0);
  assert.equal(r.triples.length, 0);
  assert.match(provenanceText(r), /no combination to be novel/);
});

test('a run whose log cannot be read is counted, not read as "did not use this pair"', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'prov-'));
  mkdirSync(path.join(root, 'broken'), { recursive: true });
  writeFileSync(path.join(root, 'broken', 'studio.jsonl'), 'this is not json\n');
  mkdirSync(path.join(root, 'nolog'), { recursive: true });
  mkdirSync(path.join(root, 'good'), { recursive: true });
  writeFileSync(
    path.join(root, 'good', 'studio.jsonl'),
    `${JSON.stringify({ kind: 'trajectory-start', data: { elementIds: ['a', 'b'] } })}\n`
  );

  const { runs, unreadable } = priorRuns(root);
  // `nolog` has no log at all and is not a run; `broken` has one that will not parse and is an
  // unanswered question. Only the difference between those two makes the count honest.
  assert.deepEqual(unreadable, [path.join(root, 'broken')]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]!.elementIds, ['a', 'b']);
});

test('a run is not prior art for itself', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'prov-'));
  const mine = path.join(root, 'mine');
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    path.join(mine, 'studio.jsonl'),
    `${JSON.stringify({ kind: 'trajectory-start', data: { elementIds: ['a', 'b'] } })}\n`
  );
  assert.deepEqual(priorRuns(root, mine).runs, []);
  assert.equal(priorRuns(root).runs.length, 1, 'and it is prior art for anything else');
});

test('a runs directory that does not exist is empty, not a throw', () => {
  const { runs, unreadable } = priorRuns(path.join(tmpdir(), 'prov-nonexistent-directory'));
  assert.deepEqual(runs, []);
  assert.deepEqual(unreadable, []);
});

test('the default lookup reads the real element pack, where every element is hand-authored', () => {
  // Pins the seam: without this, every test above could pass against a lookup the shipped code never
  // uses. The four pack elements have no `derivedFrom` by construction, so they must all come back
  // ungrounded — and when `corpus derive` has run, this test still holds and the derived ones do not
  // appear here because they are not in `elementIds()`.
  const ids = elementIds().slice(0, 2);
  assert.equal(ids.length, 2, 'the pack needs two elements for this to mean anything');
  const r = provenance(ids, []);
  assert.deepEqual(r.ungrounded, [...ids].sort());
  assert.deepEqual(r.grounded, []);
  assert.equal(r.pairs[0]!.corpus, 'unknown');
});
