// Reading the catalogue as text, and the four ways a word count lies about a corpus.
//
// **The default that isn't one.** `dimensionalityOf` returns `'unknown'` when neither vocabulary
// fires. The bug this catches is the one this repo has already been bitten by — an absent field read
// as a confident zero — and it looks harmless here: an empty classification coming back `'object'`
// would still be right 80% of the time, and would poison every rate computed off it.
//
// **The rule for a work that is both.** 2,970 of 20,000 rows have a field matching both word lists.
// A resolution rule that lives only in whichever `if` happens to run first is not a rule, so the two
// clauses are asserted here and the assertion names them.
//
// **Hapax legomena.** Documents are works, so a term said once gets the maximum IDF there is and
// half the vocabulary is said once. Without the cutoff the top of a TF-IDF list is typos. The test
// that matters is not that the cutoff exists but that it *excludes* — and, at the other end, that a
// term in every document collapses to zero rather than ranking on bulk.
//
// **A rate with no baseline.** 39% of pairs in this corpus share a museum before anything is
// measured, so a crosswalk that prints a concentration without printing what concentration costs
// nothing is a report that can be made to say anything. `chance` is checked against the arithmetic
// it claims to be, and `crosswalkText` is checked for printing it next to every rate.
//
// Every fixture here is synthetic. Nothing in this file reads `corpus/`, so the whole file runs on a
// fresh clone with no pixels, no pool and no manifest on disk.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Source, Work } from '../manifest.js';
import {
  crosswalk,
  crosswalkText,
  dimensionalityOf,
  dimensionalitySplit,
  MIN_DOCUMENT_FREQUENCY,
  OBJECT_TERMS,
  SYNONYM_MIN_DOCUMENTS,
  terms,
  tokenise,
  TWO_D_TERMS,
} from '../vocabulary.js';

let serial = 0;
const work = (source: Source, over: Partial<Work> = {}): Work => ({
  id: `${source}-${++serial}`,
  source,
  object_id: String(serial),
  accession_number: null,
  url: 'u',
  rights: 'r',
  title: '',
  creator: null,
  date_display: '',
  date_begin: null,
  date_end: null,
  classification: '',
  medium: '',
  culture: null,
  department: 'Egyptian Art',
  image_url: null,
  image: null,
  fetched_at: '2026-08-31T00:00:00.000Z',
  ...over,
});

// --- 1. sheet or object ----------------------------------------------------------------------------

test('a drawing on paper is a sheet and a bronze statuette is a thing', () => {
  assert.equal(dimensionalityOf(work('aic', { classification: 'Drawing', medium: 'Graphite on cream laid paper' })), '2d');
  assert.equal(dimensionalityOf(work('met', { classification: 'Statuette', medium: 'Bronze' })), 'object');
});

test('a row the museum classified as nothing is unknown, and is NOT defaulted to the commoner answer', () => {
  // 80.6% of the corpus is `object`, so defaulting would be right most of the time and wrong in the
  // way that matters: every rate computed downstream would be reading a guess as a record.
  const silent = work('cma', { classification: '', medium: '', department: '(no department)' });
  assert.equal(dimensionalityOf(silent), 'unknown');
  assert.notEqual(dimensionalityOf(silent), 'object');
  // And the unknowns are counted, not dropped, so a reader can see how big the hole is.
  const split = dimensionalitySplit([silent, work('met', { classification: 'Scarab' })]);
  assert.equal(split.counts.unknown, 1);
  assert.equal(split.counts.object, 1);
  assert.deepEqual(Object.keys(split.bySource).sort(), ['cma', 'met']);
});

test('when a work matches both lists the rule is: first field decides, and within a field the longer phrase wins with ties to object', () => {
  // Clause 2, tie: `limestone` and `paint` are one word each, from opposite lists. Object wins,
  // because three-dimensionality is a physical property and painting a relief does not flatten it.
  assert.equal(dimensionalityOf(work('met', { classification: '', medium: 'Limestone, paint' })), 'object');

  // Clause 2, longer phrase: `wood engraving` is two words and beats the one word `wood`. Without
  // this, every wood engraving in the corpus is filed as a wooden object.
  assert.equal(dimensionalityOf(work('aic', { classification: 'Wood engraving', medium: '' })), '2d');

  // Clause 1, field precedence: classification is the museum's own answer to what kind of thing this
  // is, so it decides before the materials list does. Reverse the order and this row is a lump of
  // copper instead of a print.
  assert.equal(dimensionalityOf(work('aic', { classification: 'Print', medium: 'Etching on copper plate' })), '2d');
  // ...and with the classification silent, the same medium is decided by the copper.
  assert.equal(dimensionalityOf(work('aic', { classification: '', medium: 'Copper plate' })), 'object');
});

test('the two vocabularies are disjoint, or the tie rule would be the only rule', () => {
  // A term in both lists matches both every time, so every field holding it resolves to `object` by
  // the tie clause and the 2D list silently stops having an effect for that word.
  const object = new Set(OBJECT_TERMS);
  assert.deepEqual(TWO_D_TERMS.filter((t) => object.has(t)), []);
  assert.equal(new Set(TWO_D_TERMS).size, TWO_D_TERMS.length, 'no duplicates');
  assert.equal(object.size, OBJECT_TERMS.length, 'no duplicates');
});

test('no textile term is in either list, so a bolt of silk comes back unknown rather than guessed', () => {
  // `silk: lampas weave` says what the cloth is and not whether the thing is a hanging or a coat,
  // and `tapestry weave` is a weave structure rather than a picture. Both answers are honestly
  // unknown; a list that took a side here would be inventing 944 rows of fact.
  assert.equal(dimensionalityOf(work('cma', { classification: 'Textile', medium: 'silk: lampas weave', department: 'Textiles' })), 'unknown');
  assert.equal(dimensionalityOf(work('cma', { classification: 'Weaving - Tapestry', medium: 'wool and silk, slit tapestry weave', department: 'Textiles' })), 'unknown');
});

// --- 2. TF-IDF -------------------------------------------------------------------------------------

test('the tokeniser folds diacritics and drops the museums HTML entities', () => {
  // Both are real: without the fold, `appliqué` tokenises to `appliqu` and ranked in the top twenty
  // of the medium list; `&gt;` survives unescaped into 50 title tokens over 24 works.
  assert.deepEqual(tokenise('Appliqué &gt; &amp; Œuvres 1857 a mm'), ['applique', 'oeuvres', 'mm']);
});

test('a term said in one work is excluded by the cutoff, which is the whole reason the ranking means anything', () => {
  // Documents are works, so `ln(n/1)` is the largest IDF available and a typo outranks every real
  // word in the corpus. Over the real manifest 50.7% of terms are said exactly once.
  const works = [...Array(40)].map((_, i) => work('met', { title: `common ${i < 25 ? 'rare ' : ''}unique${i}` }));
  const found = terms(works, 'title');
  assert.ok(MIN_DOCUMENT_FREQUENCY > 1, 'a cutoff of 1 is not a cutoff');
  assert.deepEqual(found.filter((t) => t.documents === 1), [], 'every hapax must be gone');
  assert.deepEqual(found.map((t) => t.term), ['rare', 'common']);

  // The cutoff is a floor, not a filter on what exists: drop it and the hapax come back.
  assert.equal(terms(works, 'title', 1).filter((t) => t.documents === 1).length, 40);
});

test('a term in every work scores zero and sits at the bottom, because IDF collapses', () => {
  const works = [...Array(40)].map((_, i) => work('met', { title: `common ${i < 25 ? 'rare ' : ''}filler` }));
  const found = terms(works, 'title');
  const common = found.find((t) => t.term === 'common');
  assert.equal(common?.documents, 40);
  assert.equal(common?.tfidf, 0, 'ln(40/40) is exactly zero');
  assert.equal(found[0]?.term, 'rare', 'the distinctive term is top, not the ubiquitous one');
  assert.equal(found.at(-1)?.term, 'filler', 'ties among zero-scoring terms break on count then name');
  // It stays in the list rather than being dropped: "this word is in every row" is worth seeing.
  assert.ok(found.some((t) => t.term === 'filler' && t.tfidf === 0));
});

test('count and documents are different facts and are reported apart', () => {
  // A word said three times in one work is not a word three works share. Folding them would make a
  // single verbose medium string look like a corpus-wide pattern.
  const works = [...Array(30)].map(() => work('met', { medium: 'gold gold gold' }));
  const [gold] = terms(works, 'medium');
  assert.equal(gold?.count, 90);
  assert.equal(gold?.documents, 30);
});

// --- 3. the crosswalk -------------------------------------------------------------------------------

/**
 * Two museums, two words each, and a context that either lines up or does not.
 *
 * `aic` says `pot`, `met` says `vessel`. In the aligned corpus both words are used of works from the
 * same period carrying the same shared vocabulary (`clay handle`); in the independent corpus `pot`
 * keeps that context and `vessel` is moved onto the other one, so the two words are used of
 * different things. `alpha`/`beta` are there so there is more than one cross-museum pair to average
 * over — a lift whose denominator is the pair itself is not a baseline.
 */
function twoMuseums(aligned: boolean): Work[] {
  const X = { medium: 'clay handle', date_begin: 401, date_end: 500 };
  const Y = { medium: 'iron blade', date_begin: 801, date_end: 900 };
  const many = (n: number, source: Source, word: string, ctx: typeof X) =>
    [...Array(n)].map(() => work(source, { classification: word, ...ctx }));
  return [
    ...many(30, 'aic', 'pot', X),
    ...many(30, 'aic', 'alpha', Y),
    ...many(30, 'met', 'vessel', aligned ? X : Y),
    ...many(30, 'met', 'beta', aligned ? Y : X),
  ];
}
const liftOf = (c: ReturnType<typeof crosswalk>, a: string, b: string): number =>
  c.synonyms.find((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))?.lift ?? 0;

test('chance is the probability two works of this sample share a museum, computed from the sample', () => {
  // Not one over the number of museums. The museums are unequal — the real corpus is 50% Met — and a
  // uniform baseline would flatter every rate measured against it.
  const c = crosswalk(twoMuseums(true));
  assert.equal(c.works, 120);
  assert.deepEqual(c.bySource, { aic: 60, met: 60 });
  const expected = 2 * (60 / 120) * (59 / 119);
  assert.ok(Math.abs(c.chance - expected) < 1e-12, `${c.chance} vs ${expected}`);

  // Lopsided, same arithmetic: 100 works from one museum and 20 from another share a museum 70% of
  // the time by accident, and any rate under that is worse than nothing.
  const lopsided = [...Array(100)].map(() => work('met')).concat([...Array(20)].map(() => work('cma')));
  const skewed = crosswalk(lopsided);
  const also = (100 / 120) * (99 / 119) + (20 / 120) * (19 / 119);
  assert.ok(Math.abs(skewed.chance - also) < 1e-12, `${skewed.chance} vs ${also}`);
});

test('two museums using different words for the same dated works surface as a synonym candidate above chance', () => {
  const aligned = crosswalk(twoMuseums(true));
  const independent = crosswalk(twoMuseums(false));

  // `pot` is aic-only and `vessel` met-only, and neither is shared vocabulary, so the pairing cannot
  // come from the words themselves — only from what the works around them are made of and when.
  assert.ok(aligned.pairsEvaluated >= 4, `${aligned.pairsEvaluated} pairs`);
  const found = liftOf(aligned, 'pot', 'vessel');
  assert.ok(found > 1.5, `aligned lift ${found} must beat the 1.0 chance baseline by a margin`);
  assert.equal(aligned.synonyms[0]?.lift, found, 'and it must be the top candidate');

  const noise = liftOf(independent, 'pot', 'vessel');
  assert.ok(noise < 1, `independent lift ${noise} must sit at or below chance`);
  assert.ok(found > noise * 2, `${found} vs ${noise}`);
});

test('a term all three museums use is shared vocabulary, and one only the Met uses is private', () => {
  const works = [
    ...[...Array(30)].map(() => work('aic', { classification: 'ceramic bowl' })),
    ...[...Array(30)].map(() => work('cma', { classification: 'ceramic dish' })),
    ...[...Array(30)].map(() => work('met', { classification: 'ceramic pottery' })),
  ];
  const c = crosswalk(works);
  const ceramic = c.shared.find((s) => s.term === 'ceramic');
  assert.equal(ceramic?.sources, 3);
  assert.deepEqual(ceramic?.bySource, { aic: 30, cma: 30, met: 30 });
  const pottery = c.private.find((p) => p.term === 'pottery');
  assert.equal(pottery?.source, 'met');
  assert.equal(pottery?.share, 1);
  assert.equal(pottery?.count, 30);
  assert.equal(c.private.find((p) => p.term === 'ceramic'), undefined, 'a word all three use is not private to any');
});

test('one museum in the sample cannot be crosswalked, and says so instead of returning numbers', () => {
  // Every term is trivially 100% private and no pair can cross anything. A module that reported
  // those as findings would be reporting the shape of its own input.
  const c = crosswalk([...Array(60)].map(() => work('met', { classification: 'pot', medium: 'clay handle' })));
  assert.equal(c.chance, 1);
  assert.deepEqual(c.shared, []);
  assert.deepEqual(c.private, []);
  assert.deepEqual(c.synonyms, []);
  assert.equal(c.pairsEvaluated, 0);
  assert.match(crosswalkText(c), /NOTHING MEASURED/);
});

test('crosswalkText prints the chance baseline beside every rate it reports', () => {
  const c = crosswalk(twoMuseums(true));
  const printed = crosswalkText(c);
  assert.match(printed, /chance two works share a museum: 49\.6%/);
  // A concentration is read against that museum's own share of the sample, not against 1/museums.
  for (const line of printed.split('\n').filter((l) => /^ {2}\S+\s+(aic|met|cma)\s/.test(l))) {
    assert.match(line, /chance \d+\.\d%/, line);
  }
  // Lift is a ratio to the mean context similarity, so the word `chance` is on every synonym line
  // and the denominator itself is printed above them.
  assert.match(printed, /mean context similarity 0\.\d+ is the chance baseline/);
  assert.match(printed, /HYPOTHESES, not a mapping/);
  for (const line of printed.split('\n').filter((l) => l.includes(' ~ '))) {
    assert.match(line, /\d+\.\d\dx chance {2}support \d+/, line);
  }
});

test('a synonym candidate must be backed by works, not by two rows that happen to agree', () => {
  // Below SYNONYM_MIN_DOCUMENTS nothing is a candidate, so the pair list is empty rather than full
  // of coincidences with a lift of infinity.
  const few = SYNONYM_MIN_DOCUMENTS - 1;
  const works = [
    ...[...Array(few)].map(() => work('aic', { classification: 'pot', medium: 'clay handle' })),
    ...[...Array(few)].map(() => work('met', { classification: 'vessel', medium: 'clay handle' })),
  ];
  const c = crosswalk(works);
  assert.equal(c.pairsEvaluated, 0);
  assert.deepEqual(c.synonyms, []);
  // ...but they are still visible as private vocabulary, which has the lower floor.
  assert.deepEqual(c.private.map((p) => p.term).sort(), ['pot', 'vessel']);
});
