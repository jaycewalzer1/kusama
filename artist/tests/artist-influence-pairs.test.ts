// The creator parser and the pair mining, against twenty rows taken verbatim out of the manifest.
//
// `creators.ts` exists because the first pass at the pair test produced five pairs of which three
// were false, and every one of those three looked correct in the output. That is the failure mode
// this file guards: not a crash, but a join that succeeds against the wrong thing and then flows
// into a median. So the fixtures are copied out of `corpus/manifest.jsonl` rather than invented —
// an invented fixture tests the parser against the shape I imagined, which is exactly the mistake
// that produced `"french"` as an artist with 24 works.
//
// The twenty rows below cover eight of the ten relations, the three name shapes the three museums
// write, and the four kinds of creator key. The two uncovered relations are uncovered because the
// corpus contains none of them, which is asserted rather than left implicit.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CorpusEmbeddings, CorpusEntry } from '../clip-index.js';
import type { Work } from '../manifest.js';
import { ROW } from '../influence/descriptors.js';
import { RELATIONS, isCulture, isNamedPerson, kindOf, normalizeName, parseCreator } from '../influence/creators.js';
import { Z_THRESHOLD, minePairs, summarise, type PairMeasurement } from '../influence/pairs.js';

interface Fixture {
  creator: string;
  medium: string;
  classification: string;
  /** What `parseCreator` must return. Written out in full so a change to any field is a diff. */
  want: { maker: string | null; original: string | null; relation: string | null; person: string | null };
}

/**
 * Twenty `creator` fields, copied out of `corpus/manifest.jsonl`.
 *
 * Ordered derivations first, then the rows that claim no derivation. The en-dashes, the double
 * space in the Isenbrant row and the `1500/04-1557` date are all as the museums wrote them.
 */
const FIXTURES: Fixture[] = [
  // AIC form 3: a maker on line 1 and the relation on line 2. The commonest real shape.
  {
    creator: 'Jean Mignon (French, active 1535-c. 1555)\nafter Luca Penni (Italian, 1500/04-1557)',
    medium: 'Etching in black on ivory laid paper',
    classification: 'etching',
    want: { maker: 'Jean Mignon', original: 'Luca Penni', relation: 'after', person: 'Jean Mignon' },
  },
  {
    creator: 'Pieter Tanjé (Dutch, 1706-1761)\nafter Cornelis Troost (Dutch, 1696-1750)',
    medium: 'Etching in black on ivory laid paper',
    classification: 'etching',
    want: { maker: 'Pieter Tanjé', original: 'Cornelis Troost', relation: 'after', person: 'Pieter Tanjé' },
  },
  // The maker and the original are the SAME person. `minePairs` must not pair this with itself.
  {
    creator: 'Antonio Maragliano (Italian, 1664–1741)\nWorkshop of Antonio Maragliano (Italian, 1664–1741)',
    medium: 'Wood',
    classification: 'large scale',
    want: { maker: 'Antonio Maragliano', original: 'Antonio Maragliano', relation: 'workshop of', person: 'Antonio Maragliano' },
  },
  // A hedge before the relation word. The original is read correctly; the "maker" is the hedge,
  // which is a known wart recorded in docs/influence/NEEDS.md. It costs nothing here because a
  // maker is only ever used as a grouping key and `possibly the` groups two works in 19,807.
  {
    creator: 'Possibly the workshop of Pierre Fromery (Prussian, born France, 1644-1738)',
    medium: 'Metal, enamel, and gold',
    classification: 'snuff box',
    want: { maker: 'Possibly the', original: 'Pierre Fromery', relation: 'workshop of', person: 'Possibly the' },
  },
  // Met form 2: relation first, dates parenthesised, no maker named at all.
  {
    creator: 'Imitator of Vincent van Gogh (Dutch, 1853–1890)',
    medium: 'Oil on panel',
    classification: 'oil on panel',
    want: { maker: null, original: 'Vincent van Gogh', relation: 'imitator of', person: null },
  },
  {
    creator: 'Circle of Adriaen Isenbrant  (Netherlandish, c. 1485–1551)',
    medium: 'Oil on panel',
    classification: 'oil on panel',
    want: { maker: null, original: 'Adriaen Isenbrant', relation: 'circle of', person: null },
  },
  {
    creator: 'School of Andrea del Verrocchio (Italian, 1435–1488)',
    medium: 'Terracotta with polychromy and gilding',
    classification: 'statuette',
    want: { maker: null, original: 'Andrea del Verrocchio', relation: 'school of', person: null },
  },
  {
    creator: 'After Desiderio da Settignano (Italian, 1428-1464)',
    medium: 'Painted stucco',
    classification: 'relief',
    want: { maker: null, original: 'Desiderio da Settignano', relation: 'after', person: null },
  },
  {
    creator: 'Style of Frans Francken II\nFlemish, 1581-1642',
    medium: 'Watercolor, over black chalk, on ivory laid paper',
    classification: 'watercolor',
    want: { maker: null, original: 'Frans Francken II', relation: 'style of', person: null },
  },
  {
    creator: 'Follower of Domenico Robusti, called Tintoretto\nItalian, 1560-1635',
    medium: 'Oil paint on tan laid paper, laid down on gray-brown card, laid down on album',
    classification: 'oil paintings (visual works)',
    want: { maker: null, original: 'Domenico Robusti, called Tintoretto', relation: 'follower of', person: null },
  },
  {
    creator: 'Manner of the Epeleios Painter\nGreek; Athens',
    medium: 'terracotta, red-figure',
    classification: 'drinking vessel',
    want: { maker: null, original: 'the Epeleios Painter', relation: 'manner of', person: null },
  },
  // The original is a single token, so `isNamedPerson` refuses it and no pair is formed.
  {
    creator: 'School of Fontainebleau\nFrench, flourished 1530s-1610',
    medium: 'Black chalk on tan laid paper',
    classification: 'graphite',
    want: { maker: null, original: 'Fontainebleau', relation: 'school of', person: null },
  },
  // The AIC's SUFFIX form, and the single row this whole file was written for. Read as a prefix,
  // `original` comes out as `French` and joins to the 24 works this corpus files under `french`.
  {
    creator: 'Paul Gauguin, after\nFrench, 1848-1903',
    medium: 'Rubbing in black and red ink, on ivory wove Japanese paper',
    classification: 'rubbing',
    want: { maker: null, original: 'Paul Gauguin', relation: 'after', person: null },
  },
  {
    creator: 'James McNeill Whistler, after\nAmerican, 1834-1903',
    medium: 'Photo-lithographic reproduction in black ink on ivory laid paper',
    classification: 'unidentified',
    want: { maker: null, original: 'James McNeill Whistler', relation: 'after', person: null },
  },

  // --- rows that claim no derivation ------------------------------------------------------------

  {
    creator: 'Paul Gauguin\nFrench, 1848-1903',
    medium:
      'Transfer drawing in brownish-black ink (recto); graphite and blue crayon pencil with brush and solvent washes in ocher on cream wove paper',
    classification: 'monotype',
    want: { maker: 'Paul Gauguin', original: null, relation: null, person: 'Paul Gauguin' },
  },
  // The dates on this row are Hokusai's. The parser cannot know that and does not try; the two
  // spellings join because the names agree. Recorded in NEEDS.md, not papered over here.
  {
    creator: 'Utagawa Hiroshige (1760-1849)\nJapanese',
    medium: 'Woodblock printed book',
    classification: 'book',
    want: { maker: 'Utagawa Hiroshige', original: null, relation: null, person: 'Utagawa Hiroshige' },
  },
  {
    creator: 'Artist unknown (American, 19th–20th century)',
    medium: 'Glass',
    classification: 'vessel',
    want: { maker: 'Artist unknown', original: null, relation: null, person: 'Artist unknown' },
  },
  {
    creator: 'Wedgwood Manufactory\nEngland, founded 1759',
    medium: 'Stoneware: glazed ivory jasperware with green relief',
    classification: 'ornamental piece',
    want: { maker: 'Wedgwood Manufactory', original: null, relation: null, person: 'Wedgwood Manufactory' },
  },
  // A lone capitalised word is indistinguishable from the nationality line the AIC puts on line 2,
  // so it is discarded as metadata and this row names nobody. See the test below: that decision
  // costs the corpus 2,065 works across 104 keys, and it is still the right one.
  {
    creator: 'China',
    medium: 'Porcelain painted in underglaze blue',
    classification: 'dish (vessel)',
    want: { maker: null, original: null, relation: null, person: null },
  },
  { creator: 'Egyptian', medium: 'Faience', classification: 'amulet', want: { maker: null, original: null, relation: null, person: null } },
];

test('twenty manifest rows parse into exactly the maker, original and relation they state', () => {
  assert.equal(FIXTURES.length, 20);
  for (const f of FIXTURES) {
    const p = parseCreator(f.creator);
    assert.deepEqual(
      { maker: p.maker, original: p.original, relation: p.relation, person: p.person },
      f.want,
      JSON.stringify(f.creator),
    );
  }
});

test('the suffix form reads the name BEFORE the relation, not the nationality after it', () => {
  // Three rows in the corpus are written this way and all three would have produced a false pair.
  // Asserted separately from the table above because it is a specific defect with a specific cost,
  // and a table row is easy to "fix" by editing the expectation.
  for (const raw of ['Paul Gauguin, after\nFrench, 1848-1903', 'James McNeill Whistler, after\nAmerican, 1834-1903']) {
    const p = parseCreator(raw);
    assert.ok(p.original && !/french|american/i.test(p.original), `${p.original} is a nationality, not an artist`);
    assert.equal(p.maker, null, 'a suffix-form row names no maker');
  }
  assert.equal(parseCreator('Paul Gauguin, after\nFrench, 1848-1903').original, 'Paul Gauguin');
});

test('the fixtures cover every relation the corpus actually contains', () => {
  const covered = new Set(FIXTURES.map((f) => parseCreator(f.creator).relation).filter(Boolean));
  // `copy after` and `copy of` are in `RELATIONS` and occur ZERO times in this manifest. They are
  // kept in the parser because the cost of a relation that never fires is nothing, and the cost of
  // one that fires and is not recognised is a derivative filed as an original. Uncovered here
  // because there is nothing honest to copy out of the manifest for them.
  const absent = ['copy after', 'copy of'];
  assert.deepEqual([...RELATIONS].filter((r) => !covered.has(r)).sort(), absent.sort());
  assert.equal(covered.size, RELATIONS.length - absent.length);
});

test('the four creator kinds are told apart, and a placeholder is not an artist', () => {
  assert.equal(kindOf('Paul Gauguin'), 'artist');
  assert.equal(kindOf('Wedgwood Manufactory'), 'studio');
  assert.equal(kindOf('south coast Peru'), 'culture');
  // `artist unknown` has 322 works and `unknown artist` another 88. Filed as artists they are the
  // two largest "hands" in the corpus and would top every table sorted by output.
  assert.equal(kindOf('Artist unknown'), 'unknown');
  assert.equal(kindOf('unknown artist'), 'unknown');
  assert.equal(isNamedPerson('Artist unknown'), false);
  assert.equal(isNamedPerson('french'), false, 'a nationality is not a person');
  assert.equal(isNamedPerson('Rembrandt'), false, 'a single token is refused rather than guessed');
  assert.equal(isCulture('China'), true);
});

test('normalizeName strips scripts and asides without transposing or stemming', () => {
  // The AIC gives Japanese artists both forms in one field. Two spellings must join; two different
  // people must not, so nothing here is fuzzy.
  assert.equal(normalizeName('Utagawa Hiroshige 歌川 広重'), 'utagawa hiroshige');
  assert.equal(normalizeName('Albrecht Dürer (German, 1471–1528)'), 'albrecht durer');
  assert.notEqual(normalizeName('Hans Holbein the Younger'), normalizeName('Hans Holbein the Elder'));
});

// --- mining ---------------------------------------------------------------------------------------

function entry(creator: string, medium: string, classification: string, row: number, sha = `sha-${row}`): CorpusEntry {
  return {
    work: { creator, medium, classification, title: `work ${row}` } as Work,
    sha256: sha,
    row,
    aliases: [],
  };
}

function embeddings(entries: CorpusEntry[]): CorpusEmbeddings {
  return { entries, rows: new Float32Array(entries.length * ROW), rowsInFile: entries.length, duplicates: 0, zeroRows: 0 };
}

test('mining counts derivations, named derivations and joinable pairs separately', () => {
  const emb = embeddings(FIXTURES.map((f, i) => entry(f.creator, f.medium, f.classification, i)));
  const m = minePairs(emb);

  // 14 rows claim a derivation. 13 of those name somebody `isNamedPerson` accepts — Fontainebleau
  // is the one it refuses. Exactly one of the 13 names an artist this fixture corpus also holds
  // works BY, so exactly one pair survives. The three numbers falling this far apart is the point:
  // a report quoting only the first would claim fourteen pairs.
  assert.equal(m.derivations, 14);
  assert.equal(m.namedDerivations, 13);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0]!.originalName, 'paul gauguin');
  assert.equal(m.pairs[0]!.relation, 'after');
  assert.equal(m.pairs[0]!.originals.length, 1);

  // `own` holds only non-derivative rows that name somebody: Gauguin, Hiroshige and Wedgwood.
  // `artist unknown` is excluded, and `China`/`Egyptian` name nobody at all.
  assert.equal(m.persons, 3);
});

test('a work whose own creator field names its maker as the original is never paired with itself', () => {
  // "Antonio Maragliano ... Workshop of Antonio Maragliano" is both sides of a pair in one row. It
  // is excluded twice over: a derivative row never enters `own`, and any survivor is filtered by
  // sha256 before the median. Both exclusions are checked, because either one alone would let a
  // distance of zero into the table under some other row shape.
  const self = FIXTURES.find((f) => f.creator.startsWith('Antonio Maragliano'))!;
  const alone = minePairs(embeddings([entry(self.creator, self.medium, self.classification, 0)]));
  assert.equal(alone.derivations, 1);
  assert.equal(alone.pairs.length, 0, 'a copy is not evidence of the hand it copies');

  // The sha filter, exercised directly: a plain Gauguin sharing bytes with the "after" row.
  const shared = minePairs(
    embeddings([
      entry('Paul Gauguin\nFrench, 1848-1903', 'Woodcut', 'woodcut', 0, 'same-bytes'),
      entry('Paul Gauguin, after\nFrench, 1848-1903', 'Zincograph', 'lithograph', 1, 'same-bytes'),
    ]),
  );
  assert.equal(shared.namedDerivations, 1);
  assert.equal(shared.pairs.length, 0, 'the only candidate original was the derivative itself');
});

test('the print split reads medium and classification, and never filters', () => {
  const emb = embeddings(FIXTURES.map((f, i) => entry(f.creator, f.medium, f.classification, i)));
  const m = minePairs(emb);
  // The one mined pair is a RUBBING after Gauguin, and a rubbing is not a print. It still mines,
  // still measures, and lands in the "not a print" table — the split is two tables, never a filter.
  assert.equal(m.pairs[0]!.isPrint, false);

  const lithograph = minePairs(
    embeddings([
      entry('Paul Gauguin\nFrench, 1848-1903', 'Woodcut in black', 'woodcut', 0),
      entry('Paul Gauguin, after\nFrench, 1848-1903', 'Transfer lithograph in black ink', 'unidentified', 1),
    ]),
  );
  assert.equal(lithograph.pairs.length, 1);
  assert.equal(lithograph.pairs[0]!.isPrint, true, 'the medium is read when the classification says nothing');
});

// --- the verdict ------------------------------------------------------------------------------------

function measurement(toOriginal: number, toRandom: number): PairMeasurement {
  const one = { armature: toOriginal, palette: toOriginal, texture: toOriginal, form: toOriginal };
  const other = { armature: toRandom, palette: toRandom, texture: toRandom, form: toRandom };
  const ratio = { armature: toOriginal / toRandom, palette: toOriginal / toRandom, texture: toOriginal / toRandom, form: toOriginal / toRandom };
  return { pair: null as never, toOriginal: one, toRandom: other, ratio };
}

test('the null verdict is a sign test on wins, and a ratio near 1 does not decide it', () => {
  // 50 pairs, all of them nearer their source. z = (50 - 25)/sqrt(12.5) = 7.07, and the RATIO is
  // 0.99 — a number a +/-0.05 band would have called a null. The two statistics disagreeing on
  // constructed data is why `summarise` reports both and lets only one decide.
  const near = Array.from({ length: 50 }, () => measurement(0.99, 1.0));
  const [layer] = summarise([near]);
  assert.equal(layer!.wins, 50);
  assert.equal(layer!.n, 50);
  assert.ok(layer!.z > Z_THRESHOLD, `z ${layer!.z} should clear ${Z_THRESHOLD}`);
  assert.equal(layer!.measuresNothing, false);
  assert.equal(layer!.direction, 'nearer');
  assert.ok(Math.abs(layer!.ratio - 0.99) < 1e-9, 'the ratio is reported even when it is not the verdict');
});

test('an even split measures nothing, and says so rather than reporting a direction', () => {
  const split = [
    ...Array.from({ length: 25 }, () => measurement(0.9, 1.0)),
    ...Array.from({ length: 25 }, () => measurement(1.1, 1.0)),
  ];
  const [layer] = summarise([split]);
  assert.equal(layer!.wins, 25);
  assert.equal(layer!.z, 0);
  assert.equal(layer!.measuresNothing, true);
  assert.equal(layer!.direction, 'none', 'a null has no direction, not a weak one');
});

test('a layer that puts copies FURTHER from their source is a finding, not a pass', () => {
  const far = Array.from({ length: 50 }, () => measurement(1.4, 1.0));
  const [layer] = summarise([far]);
  assert.equal(layer!.wins, 0);
  assert.ok(layer!.z < -Z_THRESHOLD);
  assert.equal(layer!.measuresNothing, false);
  assert.equal(layer!.direction, 'further');
});

test('ratioRange carries the spread across seeds, which is how much of a verdict is the draw', () => {
  const passes = [
    Array.from({ length: 20 }, () => measurement(0.95, 1.0)),
    Array.from({ length: 20 }, () => measurement(0.95, 1.02)),
  ];
  const [layer] = summarise(passes);
  const [lo, hi] = layer!.ratioRange;
  assert.ok(lo < hi, 'two differently-seeded baselines must not collapse to one number');
  assert.ok(Math.abs(hi - 0.95) < 1e-9 && Math.abs(lo - 0.95 / 1.02) < 1e-9);
});
