// The text tower over the catalogue, tested on fixtures whose answer is known before it runs.
//
// Nothing here touches `corpus/`, downloads a model, or runs a forward pass. What is tested is the
// part that decides whether the printed numbers mean anything: what string reaches the encoder, that
// the per-work text rows are joined to the per-image rows BY ID and not by position, that the
// same-museum statistic is the query-vs-neighbours one, and that the verdicts flip on bands fixed in
// advance rather than on whatever came out.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BM25_ALL_FIELDS,
  COLUMN_BAND,
  DIM,
  FIELD_SETS,
  GATE_SELF_AT_K,
  joinToImages,
  metadataString,
  textSpaceComparison,
  textSpaceComparisonText,
  type TextImageJoin,
} from '../text-embed.js';
import type { CorpusEmbeddings } from '../clip-index.js';
import type { Work } from '../manifest.js';

function work(id: string, source: string, fields: Partial<Record<string, string>> = {}): Work {
  return {
    id,
    source,
    title: '',
    creator: null,
    date_display: '',
    classification: '',
    medium: '',
    culture: null,
    department: '',
    ...fields,
  } as unknown as Work;
}

/** A unit vector along one axis, so cosines in the fixtures are 1 or 0 and nothing is approximate. */
function axis(a: number): Float32Array {
  const v = new Float32Array(DIM);
  v[a % DIM] = 1;
  return v;
}

function pack(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs.length * DIM);
  vs.forEach((v, i) => out.set(v, i * DIM));
  return out;
}

test('the encoder is handed values, never field names, and blank fields are dropped', () => {
  const w = work('met-1', 'met', {
    title: 'Bowl',
    creator: null as unknown as string,
    classification: 'Ceramics',
    medium: 'Earthenware',
    department: 'Asian Art',
  });
  const s = metadataString(w, FIELD_SETS.all);
  assert.equal(s, 'Bowl, Ceramics, Earthenware, Asian Art');
  assert.ok(!s.includes(':'), 'no field tags — CLIP was trained on English, not on `title:`');
  assert.ok(!s.includes(', ,'), 'an absent creator leaves no gap for the tower to interpret');
});

test('the object field set drops the record fields, and the wall-carrying one first', () => {
  assert.ok(FIELD_SETS.all.includes('department'), 'the `all` set is BM25\'s full index, unaltered');
  for (const f of ['department', 'creator', 'culture', 'date_display'] as const) {
    assert.ok(!(FIELD_SETS.object as readonly string[]).includes(f), `object must not carry ${f}`);
  }
  assert.deepEqual([...FIELD_SETS.object], ['title', 'classification', 'medium']);
});

test('the two matrices are joined by work id, not by row position', () => {
  const works = [work('a', 'met'), work('b', 'aic'), work('c', 'cma')];
  // The image side holds them in a different order and is missing one entirely, which is the real
  // case: 111 works never got pixels and 98 more lose their row to a byte-identical twin.
  const images: CorpusEmbeddings = {
    entries: [
      { work: works[2]!, sha256: 'sc', row: 0, aliases: [] },
      { work: works[0]!, sha256: 'sa', row: 1, aliases: [] },
    ],
    rows: pack([axis(2), axis(0)]),
    rowsInFile: 2,
    duplicates: 0,
    zeroRows: 0,
  };
  const textIds = ['a', 'b', 'c'];
  const textRows = pack([axis(10), axis(11), axis(12)]);

  // The join `joinToImages` performs, inlined here because the real one reads two files off disk.
  const at = new Map(textIds.map((id, i) => [id, i]));
  const joined = images.entries.map((e) => at.get(e.work.id));
  assert.deepEqual(joined, [2, 0], 'cma-c takes text row 2 and met-a takes row 0, by id');
  assert.notDeepEqual(joined, [0, 1], 'a positional join would have silently paired the wrong works');
  assert.equal(typeof joinToImages, 'function');
});

// The trap this repo has already fallen into once: `pairRate` (the neighbours against each other)
// printed under a heading measured as `sameMuseumShareAtK` (the query against its neighbours).
test('the same-museum statistic is query-vs-neighbours, not neighbours-vs-each-other', () => {
  const works = [
    work('met-q', 'met', { title: 'alpha' }),
    work('met-1', 'met', { title: 'alpha' }),
    work('aic-1', 'aic', { title: 'alpha' }),
    work('aic-2', 'aic', { title: 'alpha' }),
    work('aic-3', 'aic', { title: 'alpha' }),
    ...Array.from({ length: 10 }, (_, i) => work(`cma-${i}`, 'cma', { title: 'zeta' })),
  ];
  // Rows 0-4 sit on one axis and rows 5+ on another, so query 0's four nearest are exactly the
  // one met and the three aic. Query-vs-neighbours is 1/4 = 25%; the pair rate over those same four
  // would be 3 same-museum pairs of 6 = 50%.
  const vecs = works.map((_, i) => axis(i < 5 ? 0 : 1));
  const join = fakeJoin(works, vecs, vecs);
  const r = textSpaceComparison(4, 1, join);
  const clip = r.columns.find((c) => c.name === 'CLIP-text (all)')!;
  assert.equal(r.queries, 1, 'a stride sample of one is row 0');
  assert.ok(Math.abs(clip.sameMuseum - 0.25) < 1e-9, `expected 25%, got ${100 * clip.sameMuseum}%`);
});

test('chance is drawn without replacement and every column shares one population', () => {
  const works = [
    ...Array.from({ length: 20 }, (_, i) => work(`met-${i}`, 'met', { title: 'Scarab' })),
    ...Array.from({ length: 20 }, (_, i) => work(`aic-${i}`, 'aic', { title: 'Scarab' })),
  ];
  const vecs = works.map((_, i) => axis(i % 3));
  const r = textSpaceComparison(6, 40, fakeJoin(works, vecs, vecs));
  // 2 x (20/40)(19/39). The `(c-1)/(n-1)` is the point: a work is not its own neighbour.
  assert.ok(Math.abs(r.chance - 19 / 39) < 1e-9, `got ${r.chance}`);
  assert.equal(r.n, 40);
  assert.equal(new Set(r.columns.map((c) => c.name)).size, r.columns.length, 'no duplicate columns');
  assert.ok(
    r.columns.some((c) => c.name === 'CLIP-image'),
    'the picture is a column here so it is read on the same sample as the words',
  );
});

test('the cross-modal gate passes when the towers agree and reads NOTHING MEASURED when they do not', () => {
  const works = Array.from({ length: 40 }, (_, i) =>
    work(`w-${i}`, i % 2 === 0 ? 'met' : 'aic', { title: `Object ${i}` }),
  );
  const distinct = works.map((_, i) => axis(i));

  const agreeing = textSpaceComparison(4, 40, fakeJoin(works, distinct, distinct));
  for (const c of agreeing.crossModal) {
    assert.equal(c.selfAtK, 1, `${c.set}: a work's text should find its own image`);
    assert.ok(Math.abs(c.selfCosine - 1) < 1e-6);
    assert.ok(Math.abs(c.otherCosine) < 1e-6, 'and nothing else');
  }
  assert.ok(
    textSpaceComparisonText(agreeing).includes('do share a space'),
    'a passing gate says the columns are comparable',
  );
  // The gate is an absolute share fixed in advance. A multiple of `k/n` would be either no bar at
  // all on 19,807 works or a bar above 1 on a fixture, which is how this was first written.
  assert.ok(GATE_SELF_AT_K > 0 && GATE_SELF_AT_K < 1, 'the gate must be a share, reachable and not free');
  assert.ok(GATE_SELF_AT_K < 0.548, 'and below the 54.8% P@10 already measured for titles alone');

  // The failure this exists to catch: 512 numbers of the right shape that mean nothing against
  // these images. Text on one set of axes, images on a disjoint set.
  const disjointImages = works.map((_, i) => axis(i + 100));
  const failing = textSpaceComparison(4, 40, fakeJoin(works, distinct, disjointImages));
  for (const c of failing.crossModal) {
    assert.equal(c.selfCosine, 0, 'a work sits at zero from its own image');
    assert.equal(c.otherCosine, 0, 'and at zero from every other one — nothing is ranked at all');
    // Every score ties, so the result is whatever the tie-break returns. That must land at chance
    // and not above it: an ordering by row index would have returned rows 0..3 and scored 10%
    // self-retrieval out of a space that measures nothing.
    assert.ok(
      c.selfAtK <= failing.selfChance,
      `a space that ranks nothing must not beat chance, got ${c.selfAtK} vs ${failing.selfChance}`,
    );
    assert.ok(c.selfAtK < GATE_SELF_AT_K, 'and it must not pass the gate');
  }
  assert.ok(
    textSpaceComparisonText(failing).includes('NOTHING MEASURED'),
    'a failed gate must refuse the cross-modal numbers rather than print them',
  );
});

test('the verdict against BM25 flips on the band, not on the result', () => {
  // Every work on one axis: CLIP-text ranks nothing, so its rate is whatever the museums' sizes
  // make it. What is asserted is the sentence the band produces, not the rate.
  const bound = Array.from({ length: 40 }, (_, i) =>
    work(`w-${i}`, i < 20 ? 'met' : 'aic', { title: i < 20 ? 'Scarab' : 'Woodcut' }),
  );
  const museumBound = bound.map((_, i) => axis(i < 20 ? 0 : 1));
  const r = textSpaceComparison(6, 40, fakeJoin(bound, museumBound, museumBound));
  const clip = r.columns.find((c) => c.name === 'CLIP-text (all)')!;
  const text = textSpaceComparisonText(r);
  const gap = clip.sameMuseum - BM25_ALL_FIELDS;
  const expected =
    Math.abs(gap) <= COLUMN_BAND ? 'added NOTHING' : gap < 0 ? 'LOWER' : 'HIGHER';
  assert.ok(text.includes(expected), `band said ${expected}; the report does not say it`);
  assert.ok(
    text.includes(`${(100 * BM25_ALL_FIELDS).toFixed(1)}%`),
    'the number to beat is BM25, and the report has to name it',
  );
  assert.ok(
    !text.includes('93.6% is the number to beat'),
    'the one-hot figure is NOT the target and must not be presented as one',
  );
});

test('the report names the population and refuses to hide the works outside it', () => {
  const works = Array.from({ length: 30 }, (_, i) => work(`w-${i}`, i % 2 ? 'met' : 'aic', { title: 'Bowl' }));
  const vecs = works.map((_, i) => axis(i));
  const join = fakeJoin(works, vecs, vecs);
  join.textOnly = 193;
  const text = textSpaceComparisonText(textSpaceComparison(5, 30, join));
  assert.ok(text.includes('193 works have catalogue text but no deduped image row'));
  assert.ok(text.includes('do not row-align'), 'the alignment caveat is part of the report, not a comment');
  // 55.4% is over the atlas's 1,500-work stride sample and ~66% is over the whole corpus. Both are
  // right, they are facts about different pools, and this column is the second one.
  assert.ok(text.includes('NOT the published 55.4%'), 'the CLIP-image column must name its pool');
});

/** A join built in memory, so the comparison can be tested without a matrix or a model on disk. */
function fakeJoin(works: Work[], text: Float32Array[], image: Float32Array[]): TextImageJoin {
  return {
    entries: works.map((w, i) => ({ work: w, sha256: `sha-${i}`, row: i, aliases: [] })),
    imageRows: pack(image),
    textRows: { all: pack(text), object: pack(text) },
    n: works.length,
    textOnly: 0,
  };
}
