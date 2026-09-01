// The lexical control, tested on corpora whose right answer is known before the code runs.
//
// Two of these tests exist because the obvious implementation of this file would have passed every
// other test while reporting a confident wrong number: field-tagged terms, and ties broken by row
// order. Both would have driven the same-museum rate toward 100% by construction and "confirmed"
// the published 93.6%. They are pinned here as behaviour, not left as comments.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONE_HOT_METADATA_KNN,
  TEXT_FIELDS,
  buildIndex,
  neighbours,
  textBaseline,
  textBaselineText,
} from '../text-space.js';
import type { Work } from '../manifest.js';

/** A work with only the fields this module reads. Everything else is irrelevant to it. */
function work(id: string, source: string, fields: Partial<Record<string, string>>): Work {
  return {
    id,
    source,
    title: '',
    creator: null,
    date_display: null,
    classification: '',
    medium: '',
    culture: null,
    department: '',
    ...fields,
  } as unknown as Work;
}

const keysFor = (works: Work[]) =>
  Float64Array.from(works.map((_, i) => i)).map(() => 0) as unknown as Float64Array;

test('BM25 retrieves the work that shares vocabulary', () => {
  const works = [
    work('a', 'met', { title: 'Bowl', medium: 'earthenware' }),
    work('b', 'met', { title: 'Engraving of a bridge', medium: 'engraving on laid paper' }),
    work('c', 'aic', { title: 'Bowl with handles', medium: 'earthenware' }),
    work('d', 'aic', { title: 'Portrait', medium: 'oil on canvas' }),
  ];
  const ix = buildIndex(works);
  const keys = Float64Array.from(works, (_, i) => i);
  const { rows } = neighbours(ix, 0, 1, keys);
  assert.equal(works[rows[0]!]!.id, 'c', 'the other earthenware bowl is the nearest work');
});

// The decision this whole module turns on. A Met record puts the object word in `title` and an AIC
// record puts it in `classification`; if the term carried its field these two would share nothing.
test('terms are not field-tagged, so the same word matches across different fields', () => {
  const works = [
    work('met-1', 'met', { title: 'Bowl' }),
    work('aic-1', 'aic', { classification: 'bowl' }),
    work('cma-1', 'cma', { title: 'Sword' }),
  ];
  const ix = buildIndex(works);
  const { rows } = neighbours(ix, 0, 1, Float64Array.from(works, (_, i) => i));
  assert.equal(works[rows[0]!]!.id, 'aic-1', 'a Met title matched an AIC classification');
});

// `corpus/manifest.jsonl` is grouped by source. Every bag here is identical, so every score ties and
// the tie-break IS the answer. Breaking on row order would return the query's own museum every time.
test('ties do not break by row order, so a source-grouped manifest does not fake a museum wall', () => {
  const works = [
    ...Array.from({ length: 20 }, (_, i) => work(`met-${i}`, 'met', { title: 'Scarab', medium: 'steatite' })),
    ...Array.from({ length: 20 }, (_, i) => work(`aic-${i}`, 'aic', { title: 'Scarab', medium: 'steatite' })),
  ];
  const queries = works.map((_, i) => i);
  const r = textBaseline(works, queries, 12, TEXT_FIELDS);
  const full = r.readings[0]!;
  assert.ok(full.tiedAtK > 0.99, `every score should tie here, got ${full.tiedAtK}`);
  assert.ok(
    full.sameMuseum < 0.85,
    `identical bags split evenly between two museums must not read as museum-bound, got ${full.sameMuseum}`,
  );
  // 2 x (20/40)(19/39). The `(c-1)/(n-1)` is the point: a work is not its own neighbour.
  assert.ok(Math.abs(r.chance - 19 / 39) < 1e-9, `chance is drawn without replacement, got ${r.chance}`);
});

test('withholding a field rebuilds the index without that field', () => {
  const works = [
    work('a', 'met', { title: 'Bowl', medium: 'engraving on laid paper' }),
    work('b', 'aic', { title: 'Plate', medium: 'engraving on laid paper' }),
  ];
  const withMedium = buildIndex(works, TEXT_FIELDS);
  const without = buildIndex(works, TEXT_FIELDS.filter((f) => f !== 'medium'));
  assert.ok(withMedium.terms.includes('laid'), 'medium contributes `laid`');
  assert.ok(!without.terms.includes('laid'), 'withholding medium removes it');
  assert.ok(without.terms.includes('bowl'), 'the other fields survive');
});

test('a work with no words is counted, not silently scored', () => {
  const works = [
    work('a', 'met', { title: 'Bowl' }),
    work('b', 'met', { title: 'Bowl' }),
    work('c', 'aic', { title: '' }),
    ...Array.from({ length: 12 }, (_, i) => work(`d-${i}`, 'aic', { title: 'Sword' })),
  ];
  const ix = buildIndex(works);
  assert.equal(ix.empty, 1, 'the wordless work is counted as an empty bag');
  const { rows } = neighbours(ix, 2, 5, Float64Array.from(works, (_, i) => i));
  assert.equal(rows.length, 0, 'it retrieves nothing rather than retrieving everything at score 0');

  const r = textBaseline(works, [2], 5, TEXT_FIELDS);
  assert.equal(r.readings[0]!.unretrievable, 1);
  assert.equal(r.readings[0]!.sameMuseum, 0, 'an unretrievable query contributes no rate at all');
});

// The verdict has to be fixed to a band decided in advance, not to whatever the number turns out to
// be — the same discipline `second-space.ts` is under.
test('the printed verdict flips on the band, not on the result', () => {
  const museumBound = [
    ...Array.from({ length: 30 }, (_, i) => work(`met-${i}`, 'met', { title: `Scarab ${i % 3}`, medium: 'steatite' })),
    ...Array.from({ length: 30 }, (_, i) => work(`aic-${i}`, 'aic', { title: `Woodcut ${i % 3}`, medium: 'wove paper' })),
  ];
  const bound = textBaseline(museumBound, museumBound.map((_, i) => i), 8, TEXT_FIELDS);
  assert.ok(bound.readings[0]!.sameMuseum > 0.9, 'disjoint vocabularies are museum-bound');
  const boundText = textBaselineText(bound);
  assert.ok(
    boundText.includes('added NOTHING over a tokeniser') || boundText.includes('HIGHER'),
    'a museum-bound result must say the embedding has nothing to prove over BM25',
  );

  const crossing = Array.from({ length: 60 }, (_, i) =>
    work(`w-${i}`, i % 2 === 0 ? 'met' : 'aic', { title: `Bowl ${i % 5}`, medium: 'earthenware' }),
  );
  const cross = textBaseline(crossing, crossing.map((_, i) => i), 8, TEXT_FIELDS);
  assert.ok(cross.readings[0]!.sameMuseum < ONE_HOT_METADATA_KNN, 'a shared vocabulary crosses');
  assert.ok(textBaselineText(cross).includes('LOWER'), 'and the text says so');
});

test('the same-museum statistic is query-vs-neighbours, not neighbours-vs-each-other', () => {
  // One met query whose 4 neighbours are 1 met and 3 aic. Query-vs-neighbours is 1/4 = 25%.
  // Neighbours-against-each-other over those same 4 would be 3 same-museum pairs of 6 = 50%.
  const works = [
    work('met-q', 'met', { title: 'alpha beta gamma delta' }),
    work('met-1', 'met', { title: 'alpha beta gamma' }),
    work('aic-1', 'aic', { title: 'alpha beta gamma' }),
    work('aic-2', 'aic', { title: 'alpha beta gamma' }),
    work('aic-3', 'aic', { title: 'alpha beta gamma' }),
    ...Array.from({ length: 10 }, (_, i) => work(`cma-${i}`, 'cma', { title: 'zeta' })),
  ];
  const r = textBaseline(works, [0], 4, TEXT_FIELDS);
  assert.ok(
    Math.abs(r.readings[0]!.sameMuseum - 0.25) < 1e-9,
    `expected the query's own museum share 25%, got ${100 * r.readings[0]!.sameMuseum}%`,
  );
});

test('the full index, then every field withheld, then every field alone', () => {
  const works = Array.from({ length: 30 }, (_, i) =>
    work(`w-${i}`, i % 2 === 0 ? 'met' : 'aic', { title: `Bowl ${i % 4}`, medium: 'earthenware' }),
  );
  const r = textBaseline(works, works.map((_, i) => i), 6, TEXT_FIELDS);
  assert.equal(r.readings.length, 2 * TEXT_FIELDS.length + 1);
  assert.equal(r.readings[0]!.scope, null);
  const withheld = r.readings.slice(1, TEXT_FIELDS.length + 1);
  const only = r.readings.slice(TEXT_FIELDS.length + 1);
  assert.deepEqual(withheld.map((x) => (x.scope as { withheld: string }).withheld), [...TEXT_FIELDS]);
  assert.deepEqual(only.map((x) => (x.scope as { only: string }).only), [...TEXT_FIELDS]);
  assert.deepEqual(only.map((x) => x.withheld), only.map(() => null), '`only` readings withhold nothing');
});

// A withhold test cannot see redundancy; the keep-one table is what the report needs to say which
// field carries the wall. Two fields each sufficient on their own is exactly the case that makes
// every withhold delta read as zero, so it is the case pinned here.
test('keep-one separates a redundant field from a field that carries nothing', () => {
  const works = Array.from({ length: 40 }, (_, i) => {
    const met = i % 2 === 0;
    return work(`w-${i}`, met ? 'met' : 'aic', {
      // Both fields are museum-private and each is sufficient alone: withholding either changes
      // nothing, so only the keep-one table can show they carry the wall.
      classification: met ? 'scarab' : 'woodcut',
      department: met ? 'egyptian' : 'prints',
      // Shared across both museums, so alone it crosses freely and carries nothing.
      title: `Object ${i % 4}`,
    });
  });
  const r = textBaseline(works, works.map((_, i) => i), 6, TEXT_FIELDS);
  const full = r.readings[0]!;
  const only = (f: string) =>
    r.readings.find((x) => x.scope !== null && 'only' in x.scope && x.scope.only === f)!;
  const dropped = (f: string) =>
    r.readings.find((x) => x.scope !== null && 'withheld' in x.scope && x.scope.withheld === f)!;

  assert.ok(full.sameMuseum > 0.9, 'the two private fields make the corpus museum-bound');
  assert.ok(
    Math.abs(dropped('classification').sameMuseum - full.sameMuseum) < 0.05,
    'withholding one of two redundant fields barely moves the rate — the trap this table sets',
  );
  assert.ok(only('classification').sameMuseum > 0.9, 'yet classification alone carries the whole wall');
  assert.ok(only('department').sameMuseum > 0.9, 'and so does department alone');
  assert.ok(only('title').sameMuseum < 0.75, 'while the shared title vocabulary crosses');
});

void keysFor;
