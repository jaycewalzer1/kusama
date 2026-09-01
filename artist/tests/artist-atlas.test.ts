// The atlas, and specifically the two ways a corpus map lies.
//
// The first lie is the projection: two dimensions cannot hold ninety, and a scatter plot never says
// how much it dropped. So `preservation` is tested against the case that matters — a projection that
// is *known* to be worthless must not score well, and one that is known to be perfect must.
//
// The second lie is the axis. A picture whose horizontal axis is "which museum" looks exactly like a
// picture whose horizontal axis is "which century", and the loadings are the only thing that tells
// them apart. That is asserted here on data built so the answer is known in advance.

import assert from 'node:assert/strict';
import test from 'node:test';
import { composition, evenSample, loadingsOf, preservation, principalAxes, project, standardise, topValues, umapProject, varianceExplained, vectorise } from '../atlas.js';
import type { Source, Work } from '../manifest.js';

const work = (source: Source, n: number, over: Partial<Work> = {}): Work => ({
  id: `${source}-${n}`,
  source,
  object_id: String(n),
  accession_number: null,
  url: 'u',
  rights: 'r',
  title: 't',
  creator: null,
  date_display: '',
  date_begin: null,
  date_end: null,
  classification: 'Drawing',
  medium: '',
  culture: null,
  department: 'd',
  image_url: null,
  image: null,
  fetched_at: '2026-08-31T00:00:00.000Z',
  ...over,
});

test('a column the corpus never varies in contributes nothing rather than infinity', () => {
  // Every work here is from one museum, so two of the three source columns are constant at zero and
  // the third constant at one. Dividing by a zero standard deviation would put NaN into every
  // downstream distance, and NaN sorts unpredictably — the map would still draw.
  const rows = standardise([Float64Array.from([1, 0, 5]), Float64Array.from([1, 0, 7])]);
  for (const r of rows) for (const x of r) assert.ok(Number.isFinite(x), `${[...r]}`);
  assert.deepEqual([...(rows[0] as Float64Array)].slice(0, 2), [0, 0]);
});

test('the rare tail is pooled into one named column instead of ten thousand empty ones', () => {
  // The pool holds 6,834 distinct classifications. One-hot over all of them is a matrix in which
  // nearly every column is a single work, and distance in it measures nothing.
  const works = [...Array(10)].map((_, i) => work('met', i, { classification: 'Prints' })).concat([work('aic', 99, { classification: 'Astrolabes' })]);
  const { names, rows } = vectorise(works);
  assert.ok(names.includes('kind:prints'));
  assert.ok(names.includes('kind:(other)'), 'the tail must have somewhere to go');
  // Ties break on the name, not on iteration order, so the columns are the same on every run.
  assert.deepEqual(topValues([work('met', 1, { classification: 'B' }), work('met', 2, { classification: 'A' })], (w) => [w.classification]), ['A', 'B']);
  assert.equal(rows.length, 11);
});

test('an undated work is flagged as undated, not placed at year zero', () => {
  // A tenth of the corpus has no parseable band. Without the flag they would all land on whatever
  // number stands in for missing and form the tightest cluster on the map.
  const { names, rows } = vectorise([work('met', 1, { date_begin: 1900, date_end: 1910 }), work('met', 2)]);
  const flag = names.indexOf('when:dated');
  assert.notEqual((rows[0] as Float64Array)[flag], (rows[1] as Float64Array)[flag]);
});

test('a projection that destroys every neighbourhood scores at chance and is called uninformative', () => {
  // The guard that matters. `preserved` alone is meaningless — with k of 20 among 100 points, a
  // layout that has thrown the data away still keeps a fifth of every neighbourhood by arithmetic.
  const high = [...Array(100)].map((_, i) => Float64Array.from([i, 0]));
  // Collapse everything onto one point: all neighbour information is gone.
  const flat = high.map(() => [0, 0]);
  const dead = preservation(high, flat, 20);
  assert.ok(Math.abs(dead.preserved - dead.chance) < 0.12, `${dead.preserved} vs ${dead.chance}`);
  assert.equal(dead.informative, false, 'a layout at chance must not be called informative');

  // And an exact copy of the space must score 1 and be called informative, or the measure is not
  // measuring preservation at all.
  const perfect = preservation(high, high.map((r) => [...r]), 20);
  assert.equal(perfect.preserved, 1);
  assert.equal(perfect.informative, true);
});

test('with k close to n every layout scores near one, and chance says so', () => {
  // The trap this reports its way out of: at k = n - 1 a random scatter preserves *everything*,
  // because every point is a neighbour of every other. The score is 1 and it means nothing.
  const high = [...Array(25)].map((_, i) => Float64Array.from([i]));
  const p = preservation(high, high.map(() => [Math.random()]), 23);
  assert.ok(p.preserved > 0.9, `${p.preserved}`);
  assert.ok(p.chance > 0.9, 'chance must rise with k or the score looks like a finding');
  assert.equal(p.informative, false);
});

test('the axes are reported as the named columns they are made of', () => {
  // Two museums, and nothing else varying. The first axis has to come out as the museum, and the
  // loadings have to say the word — otherwise the same plot gets described as "style" later.
  const works = [...Array(30)].map((_, i) => (i % 2 ? work('met', i) : work('cma', i, { culture: 'Japan' })));
  const { names, rows } = vectorise(works);
  const axes = principalAxes(rows, 2);
  const first = loadingsOf(names, axes)[0] as { column: string; weight: number }[];
  assert.match(first[0]?.column as string, /^source:|^culture:/);
  assert.ok(Math.abs(first[0]?.weight as number) > 0.2);
  // Variance shares are fractions of the whole and cannot exceed it.
  const share = varianceExplained(rows, axes);
  assert.ok((share[0] as number) >= (share[1] as number), 'axes must come out in descending order');
  assert.ok((share[0] as number) + (share[1] as number) <= 1.0000001);
});

test('the same data twice gives the same picture and not its mirror image', () => {
  // An eigenvector's sign is arbitrary. Left unpinned, two runs produce plots that are reflections
  // of each other, and a reader comparing them sees a change that did not happen.
  const works = [...Array(40)].map((_, i) => work(i % 3 === 0 ? 'aic' : 'met', i, { date_begin: 1000 + i * 10, date_end: 1010 + i * 10 }));
  const a = project(vectorise(works).rows, principalAxes(vectorise(works).rows, 2));
  const b = project(vectorise(works).rows, principalAxes(vectorise(works).rows, 2));
  assert.deepEqual(a, b);
});

test('a neighbourhood that is all one museum is only news if the corpus is not', () => {
  // Two clean blocks in the space, each entirely one museum, so every neighbour is a match and
  // `share` is 1. The point of the test is `chance`: with a 50/50 split it is ~0.5 and 1.0 is a real
  // finding; make the corpus 39 works from one museum and one from another and chance rises to 0.90
  // for the same perfect separation. A share reported without it can be made to mean anything.
  const split = [...Array(40)].map((_, i) => work(i < 20 ? 'met' : 'aic', i));
  const far = split.map((_, i) => Float64Array.from([i < 20 ? 0 : 100]));
  const [even] = composition(split, far, [{ field: 'same museum', of: (w) => w.source }], 5);
  assert.equal(even?.share, 1);
  assert.ok(Math.abs((even?.chance as number) - 0.4871) < 0.001, `${even?.chance}`);

  const lopsided = [...Array(40)].map((_, i) => work(i < 39 ? 'met' : 'aic', i));
  const [skewed] = composition(lopsided, far, [{ field: 'same museum', of: (w) => w.source }], 5);
  assert.ok((skewed?.chance as number) > 0.9, `${skewed?.chance}`);
});

test('UMAP gives the same picture twice, because an unseeded one makes every cluster unciteable', () => {
  // Three separated blobs, so there is real structure to find and the run is short.
  const rows = [...Array(60)].map((_, i) => Float64Array.from([(i % 3) * 50 + (i % 7) * 0.1, (i % 3) * 50 - (i % 5) * 0.1]));
  assert.deepEqual(umapProject(rows, 7, 5), umapProject(rows, 7, 5));
  assert.notDeepEqual(umapProject(rows, 7, 5), umapProject(rows, 8, 5));
});

test('the sample is spread across the manifest rather than taken off the front of it', () => {
  // The manifest is written grouped by source. A prefix would measure the projection on Cleveland
  // alone and report the number as the corpus.
  const sample = evenSample([...Array(100)].map((_, i) => i), 10);
  assert.equal(sample.length, 10);
  assert.equal(sample[0], 0);
  assert.ok((sample[9] as number) > 80, `${sample}`);
  assert.deepEqual(evenSample([1, 2, 3], 10), [1, 2, 3]);
});
