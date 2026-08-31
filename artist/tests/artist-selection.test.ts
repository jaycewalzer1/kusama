// Selection: that the corpus is a decision and not an accident of file order.
//
// The failure here is the quietest one in the whole ingest. A selector that is subtly wrong still
// returns twenty thousand real works with real licences, and the resulting corpus is simply *about*
// something nobody chose — European prints, or whichever museum happened to have the most rows. No
// downstream check catches that, because nothing downstream knows what the pool looked like. So the
// tests are: the caps bind, the carried-over works survive the caps, and the same seed gives the
// same answer twice.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Source, Work } from '../manifest.js';
import { bucketClassification, classificationsOf, periodOf, select } from '../selection.js';

const RULES = { seed: 7, target: 100, maxClassificationShare: 0.08, maxSourceShare: 0.5 };

function work(source: Source, n: number, classification: string, begin: number | null, culture: string | null): Work {
  return {
    id: `${source}-${n}`,
    source,
    object_id: String(n),
    accession_number: null,
    url: `https://example.org/${n}`,
    rights: 'CC0',
    title: `Work ${n}`,
    creator: null,
    date_display: begin === null ? '' : String(begin),
    date_begin: begin,
    date_end: begin,
    classification,
    medium: '',
    culture,
    department: 'Prints and Drawings',
    image_url: `https://example.org/${n}.jpg`,
    image: null,
    fetched_at: '2026-08-31T00:00:00.000Z',
  };
}

/** A pool shaped like the real one: one class swamping everything, spread over centuries. */
function lopsidedPool(): Work[] {
  const pool: Work[] = [];
  let n = 0;
  for (let i = 0; i < 4000; i++) pool.push(work('met', n++, 'Prints', 1700 + (i % 300), `Culture ${i % 5}`));
  for (let i = 0; i < 600; i++) pool.push(work('met', n++, 'Drawings', 1600 + (i % 300), null));
  for (let i = 0; i < 200; i++) pool.push(work('cma', n++, 'Painting', 1500 + (i % 400), 'America'));
  for (let i = 0; i < 60; i++) pool.push(work('aic', n++, 'Textile', null, 'Peru'));
  for (let i = 0; i < 40; i++) pool.push(work('aic', n++, 'Coin', -300 + i, 'Greece'));
  return pool;
}

test('no classification may exceed its share, however much of the pool it is', () => {
  const pool = lopsidedPool();
  const { selection } = select(pool, new Set(), RULES);
  const cap = Math.ceil(RULES.target * RULES.maxClassificationShare);
  for (const c of selection.byClassification) {
    assert.ok(c.taken <= cap, `${c.classification} took ${c.taken}, above the cap of ${cap}`);
  }
  // Prints is 80% of the pool. If the cap were not binding this would be near 80 of 100.
  const prints = selection.byClassification.find((c) => c.classification === 'prints');
  assert.ok(prints);
  assert.ok(prints.taken <= cap, `prints took ${prints.taken}`);
  assert.ok(prints.available > 3000, 'the fixture is supposed to be lopsided');
});

test('no source may exceed its share either', () => {
  const { selection } = select(lopsidedPool(), new Set(), RULES);
  const cap = Math.ceil(RULES.target * RULES.maxSourceShare);
  for (const [source, n] of Object.entries(selection.bySource)) assert.ok(n <= cap, `${source} took ${n}`);
  // The Met is 92% of the fixture pool by rows; it must not be 92% of the corpus.
  assert.ok((selection.bySource.met ?? 0) <= cap);
});

test('undated works are a bucket, not a discard', () => {
  const { works, selection } = select(lopsidedPool(), new Set(), RULES);
  assert.ok((selection.byPeriod['(undated)'] ?? 0) > 0, 'the 60 undated textiles were all dropped');
  for (const w of works) assert.ok(periodOf(w).length > 0);
});

test('the same seed and pool give the same works, and a different seed does not', () => {
  const pool = lopsidedPool();
  const a = select(pool, new Set(), RULES);
  const b = select(pool, new Set(), RULES);
  assert.equal(a.selection.idsSha256, b.selection.idsSha256);
  assert.deepEqual(
    a.works.map((w) => w.id),
    b.works.map((w) => w.id),
  );
  const c = select(pool, new Set(), { ...RULES, seed: 8 });
  assert.notEqual(a.selection.idsSha256, c.selection.idsSha256);
  // Same rules, so the same *number* of works: the seed chooses which, not how many.
  assert.equal(a.works.length, c.works.length);
});

test('a work already in the manifest is carried over even when its class is full', () => {
  const pool = lopsidedPool();
  // Twenty prints already read — more than the classification cap of 8 allows.
  const held = new Set(pool.filter((w) => w.classification === 'Prints').slice(0, 20).map((w) => w.id));
  const { works, selection } = select(pool, held, RULES);
  const ids = new Set(works.map((w) => w.id));
  for (const id of held) assert.ok(ids.has(id), `${id} had been read and was dropped to tidy a distribution`);
  assert.equal(selection.carriedOver, 20);
  const prints = selection.byClassification.find((c) => c.classification === 'prints');
  // Carried-over works count against the cap rather than being invisible to it, so the class is
  // over its ceiling by exactly the works that were already evidence and by nothing else.
  assert.equal(prints?.taken, 20);
});

test('a held id that is no longer in the pool does not break the selection', () => {
  // The pool is regenerable and the museums restate it; a work can leave. That is a fact to survive,
  // not to crash on.
  const { selection } = select(lopsidedPool(), new Set(['met-999999']), RULES);
  assert.equal(selection.carriedOver, 0);
});

test('the target is a ceiling, and a pool smaller than it is not padded', () => {
  const small = [work('cma', 1, 'Painting', 1800, null), work('cma', 2, 'Print', 1800, null)];
  const { works } = select(small, new Set(), RULES);
  assert.equal(works.length, 2);
});

test('a multi-valued classification buckets under its rarest segment', () => {
  // `Photographs|Ephemera` in a pool full of photographs is a piece of ephemera. Bucketing it under
  // the first segment puts it in the bucket that is already overflowing and makes the ephemera
  // invisible as ephemera.
  const frequency = new Map([
    ['photographs', 9000],
    ['ephemera', 12],
    ['prints', 4000],
  ]);
  assert.deepEqual(classificationsOf(work('met', 1, 'Photographs|Ephemera', 1900, null)), ['photographs', 'ephemera']);
  assert.equal(bucketClassification(work('met', 1, 'Photographs|Ephemera', 1900, null), frequency), 'ephemera');
  assert.equal(bucketClassification(work('met', 2, 'Prints', 1900, null), frequency), 'prints');
  // A segment the pool has never seen is rarer than one it has, which is the right way round.
  assert.equal(bucketClassification(work('met', 3, 'Prints|Astrolabes', 1900, null), frequency), 'astrolabes');
  // Three museums, three house styles, one category. `Sculpture` and `sculpture` must not be two
  // buckets, or the ceiling that is supposed to hold sculpture down holds down half of it.
  assert.deepEqual(classificationsOf(work('cma', 4, 'Sculpture', 1900, null)), classificationsOf(work('aic', 5, 'sculpture', 1900, null)));
});

test('periods are centuries, and BCE is a band rather than a contested ordinal', () => {
  assert.equal(periodOf(work('cma', 1, 'x', 1882, null)), '19c');
  assert.equal(periodOf(work('cma', 2, 'x', 1900, null)), '20c');
  assert.equal(periodOf(work('cma', 3, 'x', 0, null)), '1c');
  // -300 and -250 are the same hundred years and must land in the same bucket. An ordinal label
  // would have to decide whether that is the third century BCE or the fourth, and the sources do
  // not agree; a band does not have to decide.
  assert.equal(periodOf(work('cma', 4, 'x', -300, null)), '300s BCE');
  assert.equal(periodOf(work('cma', 5, 'x', -250, null)), '300s BCE');
  assert.equal(periodOf(work('cma', 6, 'x', null, null)), '(undated)');
});
