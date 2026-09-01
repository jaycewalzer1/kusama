// Reading the `creator` field, which three museums write three different ways.
//
// This file exists because the first pass at the pair test did not have it, and produced five
// derivative/original pairs of which three were false. `"Paul Gauguin, after\nFrench, 1848-1903"` is
// one string with a newline in it; a regex that takes "everything after the relation word" gets
// `"French, 1848-1903"`, and `"french"` is a creator with 24 works in this corpus, so the join
// succeeded and the pair table filled up with Gauguin matched against the French nation. The same
// happened for Whistler->`american` and Modigliani->`italian`. Every one of those would have gone
// into a median and none of them would have looked wrong in the output.
//
// So the parser is separate, tested against fixtures taken verbatim from the manifest, and it
// returns `null` rather than guessing. A pair that is not found is a smaller error than a pair that
// is wrong.
//
// ## The three shapes, as they actually appear
//
//   AIC     "Paul Gauguin, after\nFrench, 1848-1903"        name, relation, then a metadata line
//           "Utagawa Hiroshige 歌川 広重\nJapanese, 1797-1858"  the name may carry its own CJK form
//           "Christian Josi (Dutch, died 1828)\nafter Rembrandt van Rijn (Dutch, 1606-1669)"
//                                                            maker on line 1, original on line 2
//   Met     "Imitator of Vincent van Gogh (Dutch, 1853–1890)"  relation first, dates parenthesised
//   CMA     "Albrecht Dürer"                                  bare, and only 14.7% of rows have one
//
// ## What "the artist" means here, and what it does not
//
// `person` is a NAME, normalised for joining. It is not an identity: this corpus has no artist
// authority file, so `"Utagawa Hiroshige (1760-1849)"` (which carries Hokusai's dates, in the
// manifest, today) and `"Utagawa Hiroshige"` join to one person because the names agree, and nothing
// here can tell that one of them is a cataloguing error. That is a limit of the data and it is
// recorded in docs/influence/NEEDS.md rather than papered over.

/** The relations that mark a work as derivative of somebody else's. */
export const RELATIONS = [
  'copy after',
  'copy of',
  'school of',
  'manner of',
  'follower of',
  'workshop of',
  'circle of',
  'imitator of',
  'style of',
  'after',
] as const;
export type Relation = (typeof RELATIONS)[number];

// `after` is last because it is a substring of nothing but a prefix of everything: "copy after" must
// win before "after" is tried, or every "copy after X" is filed as an "after" with a maker of "copy".
const RELATION_ALTERNATION = RELATIONS.map((r) => r.replace(/ /g, '\\s+')).join('|');

export interface ParsedCreator {
  /** The maker, when the field names one distinct from the original. Null for "Paul Gauguin, after". */
  maker: string | null;
  /** The named original this work derives from, or null when the field claims no derivation. */
  original: string | null;
  relation: Relation | null;
  /** The name to file this work under when it is nobody's copy: the maker, or the sole name. */
  person: string | null;
}

/**
 * Strip a name down to something two spellings of it can be compared on.
 *
 * Removes CJK and any other non-Latin script (the AIC gives Japanese artists both forms in one
 * field), diacritics, parenthesised asides, and punctuation. Deliberately does NOT stem, transpose
 * "Surname, Forename", or do fuzzy matching: those turn a missed join into a wrong one, and this
 * function's failures should be misses.
 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Everything outside basic Latin: CJK, kana, Cyrillic, Greek, and the stray full-width comma.
    .replace(/[^\x00-\x7f]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nationality-and-dates lines, which the AIC puts on line 2 and the Met puts in parentheses.
 *
 * Matched by SHAPE rather than against a list of nationalities: a line that is a single capitalised
 * word optionally followed by a date range is a metadata line whatever the word is, and a list would
 * have to be complete to be safe. `"French, 1848-1903"`, `"Japanese"`, `"Dutch, died 1828"`,
 * `"American, born 1936"` and `"n. 1936"` all match; `"Wedgwood Manufactory"` does not.
 */
const METADATA_LINE =
  /^(?:[A-Z][a-zé]+(?:[- ][A-Z][a-zé]+)?)?(?:\s*,)?\s*(?:(?:b\.|d\.|n\.|born|died|active|fl\.?)\s*)?(?:c\.\s*)?(?:\d{3,4}\s*[-–—]\s*(?:\d{3,4})?|\d{3,4})?\s*$/;

function isMetadataLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  // Parenthesised asides are stripped BEFORE the shape is judged. The Met writes
  // `"Albrecht Dürer (German, 1471–1528)"`, which is a name with its metadata bracketed onto it;
  // counting the bracket contents as words makes it a four-word line with a date in it, i.e.
  // indistinguishable from `"French, 1848-1903"`, and the whole name gets discarded as metadata.
  const bare = t.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!bare) return true;
  // A line with a date in it and at most four words is metadata, not a name.
  if (/\d{3,4}/.test(bare) && bare.split(/\s+/).length <= 4) return true;
  return METADATA_LINE.test(bare) && /\d|^[A-Z][a-zé]+$/.test(bare);
}

/** Drop trailing "(Dutch, 1853-1890)", ", French, 1848-1903", ", born 1936" and the like. */
function stripTail(name: string): string {
  let s = name.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/,\s*(?:[A-Z][a-zé]+(?:[- ][A-Z][a-zé]+)?)?\s*,?\s*(?:b\.|d\.|n\.|born|died|active|fl\.?|c\.)?\s*\d{3,4}\s*[-–—]?\s*\d{0,4}\s*$/, '');
  s = s.replace(/,\s*(?:born|died|active)\s+\d{3,4}\s*$/i, '');
  return s.replace(/\s+/g, ' ').trim().replace(/[,;]+$/, '').trim();
}

/**
 * Parse one `creator` field.
 *
 * Returns nulls rather than guesses. `person` is set for every row that names anybody at all, so a
 * caller counting an artist's own works reads `person`; `original` is set only when the field
 * explicitly claims a derivation.
 */
export function parseCreator(raw: string | null): ParsedCreator {
  const empty: ParsedCreator = { maker: null, original: null, relation: null, person: null };
  if (!raw || !raw.trim()) return empty;

  // Keep only the lines that are names. The AIC's second line is nationality and dates, and it is
  // the single largest source of false joins in this field.
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const nameLines = lines.filter((l) => !isMetadataLine(l));
  if (!nameLines.length) return empty;

  const rel = new RegExp(`^(.*?)\\b(${RELATION_ALTERNATION})\\b[:,]?\\s*(.*)$`, 'i');

  // Form 3 first: a maker on one line and "after <original>" on a later one.
  for (let i = 1; i < nameLines.length; i++) {
    const m = rel.exec(nameLines[i]!);
    if (m && !m[1]!.trim() && m[3]!.trim()) {
      const maker = stripTail(nameLines[0]!);
      const original = stripTail(m[3]!);
      return {
        maker: maker || null,
        original: original || null,
        relation: canonicalRelation(m[2]!),
        person: maker || null,
      };
    }
  }

  const line = nameLines[0]!;
  const m = rel.exec(line);
  if (!m) {
    const person = stripTail(line);
    return { maker: person || null, original: null, relation: null, person: person || null };
  }

  const before = m[1]!.trim().replace(/[,;]+$/, '').trim();
  const after = m[3]!.trim();
  const relation = canonicalRelation(m[2]!);

  // Form 2, "After Rembrandt van Rijn" / "Imitator of Vincent van Gogh": nothing before the relation,
  // so the field names the original and no maker at all.
  if (!before) {
    const original = stripTail(after);
    return { maker: null, original: original || null, relation, person: null };
  }

  // Form 1, "Paul Gauguin, after": the AIC's suffix form. The name BEFORE the relation is the
  // original — this is the case that produced three false pairs when it was read as a prefix.
  if (!after) {
    const original = stripTail(before);
    return { maker: null, original: original || null, relation, person: null };
  }

  // Both sides present on one line: "Christian Josi, after Rembrandt van Rijn".
  const maker = stripTail(before);
  const original = stripTail(after);
  return { maker: maker || null, original: original || null, relation, person: maker || null };
}

function canonicalRelation(found: string): Relation {
  const norm = found.toLowerCase().replace(/\s+/g, ' ');
  return (RELATIONS.find((r) => r === norm) ?? 'after') as Relation;
}

/** True when this field claims the work derives from somebody named. */
export function isDerivative(raw: string | null): boolean {
  return parseCreator(raw).original !== null;
}

/**
 * Placeholders that a museum writes in the creator field when it does NOT know the creator.
 *
 * These have to be excluded explicitly, because they behave like extremely prolific artists. The
 * corpus holds 324 works by `"artist unknown"` and 88 by `"unknown artist"`, and
 * `"David Teniers the Younger ... After artist unknown"` joins to all 324 of them — producing a
 * derivative/original pair, a distance, and a row in the table, none of which mean anything. An
 * unknown creator is an absence; treating it as an identity is the same class of mistake as
 * inferring a licence, which artist/manifest.ts refuses to do for the same reason.
 */
const NOT_A_PERSON = /\b(unknown|unidentified|anonymous|various|attributed|unrecorded)\b/i;

/**
 * Culture, place and period strings that this corpus files in the `creator` field.
 *
 * 41.5% of imaged works have a creator at all, and a large share of those name a civilisation
 * rather than a person. They are legitimate grouping keys, they are not artists, and a caller
 * asking for an artist must be able to tell the difference. Matched by shape and by a list, because
 * neither alone is enough: `"south coast peru"` is a place with no marker on it, and `"Roman"` is
 * indistinguishable from a surname without one.
 *
 * A creator field that is nothing but ONE capitalised word never reaches `groupWorks` at all, and
 * this comment used to claim the opposite. `isMetadataLine` discards it, because it cannot tell
 * `China` in the creator column from the `French, 1848-1903` nationality line the same museums put
 * in the same field. `parseCreator('China')` returns all nulls, and so do `Egyptian`, `Roman`,
 * `Korea`, `Italian` and `Japan`. That is 100 distinct keys covering 2,061 works with no direction.
 *
 * The nine cultures that DO have directions got there on a multi-LINE field whose first line happens
 * to be one word — `Chimú\nNorth coast, Peru` is why `chimu` is a group and `China` is not. So the
 * rule is about the shape of the field, not the length of the name, and `CULTURE_WORDS` is doing its
 * job in both cases: it classifies whatever it is handed, and nothing hands it the 2,061. Recovering
 * them needs a per-museum rule about which column means what — docs/influence/NEEDS.md.
 */
const CULTURE_WORDS =
  /\b(china|chinese|egypt|egyptian|roman|rome|korea|korean|italy|italian|japan|japanese|german|germany|europe|european|iran|iranian|persia|persian|nepal|nepalese|england|english|british|britain|india|indian|tibet|tibetan|greek|greece|france|french|spain|spanish|islamic|america|american|dutch|netherlandish|netherlands|flemish|byzantine|coptic|etruscan|celtic|nazca|chimu|maya|mayan|inca|moche|wari|olmec|aztec|thailand|thai|vietnam|cambodia|indonesia|nigeria|ghana|mali|peru|peruvian|mexico|mexican|syria|turkey|turkish|iraq|israel|austria|austrian|russia|russian|sweden|swedish|denmark|danish|norway|poland|polish|hungary|switzerland|swiss|belgium|portugal|ireland|irish|scotland|scottish|wales|welsh|canada|australia|brazil|argentina|chile|colombia|cuba|jamaica|haiti|gandhara|kathmandu|valley|coast|region|province|dynasty|kingdom|empire|culture|period|prefecture|pradesh|rajasthan|gujarat|bengal|punjab|deccan|anatolia|levant|mesopotamia|assyria|babylon|sumer|phoenicia|nubia|colima|jalisco|oaxaca|veracruz|yucatan|cyclades|etruria|luristan)\b/i;

/**
 * Firms, manufactories and studios: collective makers, which are neither individuals nor cultures.
 *
 * Kept as a third category rather than folded into either. A direction computed from Wedgwood's 45
 * works is a real and coherent thing — a house style is more consistent than most artists' output —
 * but calling it an *artist* direction in a report would be a claim about a person who never
 * existed. `kindOf` is what the directions file records, so a reader can see which of the three they
 * are looking at without knowing the corpus.
 */
const FIRM_WORDS =
  /\b(manufactory|manufacturing|manufacture|studios|studio|company|pottery|porcelain|foundry|works|press|atelier|workshop|factory|mills?|brothers|sons|associates|firm|guild|bindery|silversmiths?|glasshouse)\b/i;

export type CreatorKind = 'artist' | 'studio' | 'culture' | 'unknown';

/**
 * Which of the four kinds of grouping key this creator name is.
 *
 * `unknown` is checked first and exists because the placeholders are the largest "artists" in the
 * corpus: `artist unknown` has 322 works and `unknown artist` another 88, which put them first and
 * second on any list sorted by output. Filed as `artist` they would have produced the two most
 * confident-looking directions in the file, each one the mean of several hundred unrelated objects.
 */
export function kindOf(name: string): CreatorKind {
  const n = normalizeName(name);
  if (!n || NOT_A_PERSON.test(n)) return 'unknown';
  if (FIRM_WORDS.test(n)) return 'studio';
  if (isCulture(name)) return 'culture';
  return 'artist';
}

/**
 * True when `name` looks like an individual maker rather than a placeholder or a civilisation.
 *
 * Deliberately conservative in the direction of saying no. A real artist wrongly excluded costs one
 * row of a table; a culture wrongly included becomes an "influence direction" that is actually the
 * mean of 576 Chinese objects, and every number computed from it reads as a fact about an artist.
 */
export function isNamedPerson(name: string | null): boolean {
  if (!name) return false;
  const n = normalizeName(name);
  if (!n || !n.includes(' ')) return false; // a single token is a culture or a placeholder far more often than a name
  if (NOT_A_PERSON.test(n)) return false;
  if (CULTURE_WORDS.test(n)) return false;
  return true;
}

/** True when `name` is one of the civilisation/place keys this corpus files under `creator`. */
export function isCulture(name: string | null): boolean {
  if (!name) return false;
  const n = normalizeName(name);
  if (!n) return false;
  if (NOT_A_PERSON.test(n)) return false;
  return CULTURE_WORDS.test(n) || !n.includes(' ');
}
