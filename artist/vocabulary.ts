// The catalogue read as text: three museums describing overlapping kinds of object in three private
// vocabularies, and nothing until now had compared them.
//
// `atlas.ts` one-hot encodes `classification` and `culture` and pools everything rare into a single
// `(other)` column. It has to: 20,000 rows carry 6,889 distinct classifications and 7,205 distinct
// medium strings (lowercased and trimmed), and half of every word list this file builds is a term
// that occurs in exactly one work. So the categorical columns are the only part of the prose the map
// has ever seen, and the prose is where the museums disagree with each other.
//
// No model, no API key, no network. Every number here is arithmetic over `corpus/manifest.jsonl`.
//
// ## Three things, and the honesty condition each one is under
//
// **`dimensionalityOf`** asks whether a work is a sheet or a thing. It is a *stated vocabulary*, not
// a classifier — the two word lists are exported so a reader can disagree with them line by line —
// and it returns `'unknown'` when neither list fires. Defaulting to either answer would be the bug
// this repo has already been bitten by: an absent field read as a confident zero.
//
// **`terms`** is TF-IDF over the prose, under a stated minimum document frequency. Without the
// cutoff the ranking is a list of typos and proper nouns, because with one work per document a term
// appearing in one work gets the maximum IDF there is.
//
// **`crosswalk`** is the finding. Every rate in it is reported beside the chance baseline it has to
// beat, in the discipline `atlas.ts` set: a share of 39% over this corpus is not a result, it is the
// probability two works share a museum before anything is measured.

import { evenSample } from './atlas.js';
import { periodOf } from './selection.js';
import type { Work } from './manifest.js';

// --- tokens ---------------------------------------------------------------------------------------

/**
 * Function words and the residue of three data pipelines.
 *
 * `gt`, `lt`, `amp` and `quot` are here because they are not words: they are HTML entities that the
 * museums' own titles carry through their APIs unescaped (`&gt;` survives into 50 title tokens over
 * 24 works). Left in, they rank near the top of the title list and read as a finding about art.
 */
export const STOP_WORDS: readonly string[] = [
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'onto', 'or', 'over', 'the', 'this', 'to', 'under', 'upon', 'was', 'were',
  'with', 'within', 'without', 'no', 'not', 'other', 'after', 'before', 'above', 'below', 'between',
  'than', 'then', 'their', 'them', 'they', 'there', 'these', 'those', 'which', 'while', 'who',
  'whose', 'also', 'per', 'via',
  // the commonest non-English function words in these creator and title fields
  'de', 'la', 'le', 'du', 'des', 'el', 'und', 'von', 'mit',
  // HTML entity residue, not vocabulary
  'gt', 'lt', 'amp', 'quot', 'nbsp',
];

const STOP = new Set(STOP_WORDS);

/**
 * Lowercase, strip diacritics, split on anything that is not a letter or digit.
 *
 * The diacritic fold is load-bearing rather than tidy. Without it `appliqué` tokenises to `appliqu`
 * and `œuvres` to `vres`, and both of those turned up in the top twenty of the medium list on the
 * first run — a ranking of the corpus's encoding, presented as a ranking of its materials.
 *
 * Pure-digit tokens are dropped (they are dimensions, plate numbers and years, which the manifest
 * already holds as numbers) and so are single characters.
 */
export function tokenise(text: string | null | undefined): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^[0-9]+$/.test(t));
}

function fold(text: string | null | undefined): string {
  // Lowercase first: the ligature replacements below are on the lowercase code points, and `Œuvres`
  // is as common in these creator fields as `œuvres`.
  return (text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0153/g, 'oe')
    .replace(/\u00e6/g, 'ae');
}

// --- 1. is this work a sheet or an object? ---------------------------------------------------------

export type Dimensionality = '2d' | 'object' | 'unknown';

/**
 * Words for a picture on a flat support, and for the flat support itself.
 *
 * This is an argument, not a measurement, and it is exported so it can be argued with. Two entries
 * are worth defending in advance:
 *
 * - `paint` and `pigment` are here. Paint is something applied to a surface, and the museums use it
 *   that way. It is also why `limestone, paint` — the tenth commonest medium string at 206 rows —
 *   matches both lists, which is what the resolution rule below is for.
 * - the `on <support>` phrases are here because `X on Y` is the grammar museums use for an image
 *   laid onto something flat. `opaque watercolor and gold on paper` is an Indian miniature; without
 *   the phrase, `gold` and `watercolor` are one word each and the tie hands it to `object`.
 *
 * **No textile term is in either list.** Not `textile`, not `tapestry`, not `velvet`, not `silk`. A
 * record that says `silk: lampas weave` has said what the cloth is and not whether the thing is a
 * hanging or a coat, and `tapestry weave` is a weave structure rather than a picture. Those 944 rows
 * come back `'unknown'`, which is the true answer.
 */
export const TWO_D_TERMS: readonly string[] = [
  // marks and the making of them
  'print', 'prints', 'printmaking', 'drawing', 'drawings', 'painting', 'paintings', 'watercolor',
  'watercolour', 'gouache', 'pastel', 'pastels', 'charcoal', 'crayon', 'graphite', 'ink', 'paint',
  'pigment', 'pigments', 'tempera', 'engraving', 'engravings', 'etching', 'etchings', 'lithograph',
  'lithographs', 'lithography', 'woodcut', 'woodcuts', 'woodblock', 'aquatint', 'mezzotint',
  'drypoint', 'monotype', 'screenprint', 'silkscreen', 'stencil', 'collage', 'sketch', 'sketches',
  'cartoon', 'illustration', 'illustrations', 'poster', 'posters', 'broadside', 'map', 'maps',
  'plan', 'chart', 'diagram', 'metalcut',
  // photography
  'photograph', 'photographs', 'photography', 'daguerreotype', 'ambrotype', 'tintype', 'albumen',
  'cyanotype', 'collotype', 'photogravure', 'negative',
  // the written and printed page
  'book', 'books', 'manuscript', 'manuscripts', 'folio', 'page', 'pages', 'leaf', 'album', 'albums',
  'codex', 'calligraphy', 'document', 'letter',
  // flat supports
  'paper', 'canvas', 'parchment', 'vellum', 'papyrus', 'cardboard', 'wallpaper',
  // phrases, which beat single words under the rule below
  'wood engraving', 'wood engravings', 'gelatin silver', 'silver print', 'bound volume',
  'hanging scroll', 'sheet music', 'laid paper', 'wove paper', 'metal cut', 'cabinet card',
  'iron gall ink', 'relief etching', 'relief print', 'relief engraving',
  'on paper', 'on canvas', 'on vellum', 'on parchment', 'on panel', 'on silk', 'on wood',
  'on board', 'on linen', 'on ivory', 'on copper',
];

/**
 * Words for a thing with a back and a volume: forms first, then the materials only ever given a
 * three-dimensional shape in these three catalogues.
 *
 * The material half is the arguable half. `wood` is in it, and a panel painting is made of wood —
 * which is exactly why the `on wood` phrase exists above and why `classification` is consulted
 * before `medium`. `gold` is in it, and gold ground is a painting material; same answer. A reader
 * who thinks a specific material does not belong can delete the line and re-run the split.
 */
export const OBJECT_TERMS: readonly string[] = [
  // containers, tableware, and the things a kitchen holds
  'vessel', 'vessels', 'bowl', 'bowls', 'cup', 'cups', 'jar', 'jars', 'jug', 'jugs', 'vase',
  'vases', 'bottle', 'bottles', 'flask', 'dish', 'dishes', 'platter', 'ewer', 'amphora', 'krater',
  'kylix', 'lekythos', 'pot', 'pots', 'pottery', 'urn', 'censer', 'teapot', 'tureen', 'basin',
  'beaker', 'goblet', 'spoon', 'fork', 'knife', 'ladle', 'basket', 'baskets', 'basketry',
  // furniture and the things kept among it
  'box', 'boxes', 'casket', 'chest', 'furniture', 'chair', 'table', 'cabinet', 'lamp', 'lantern',
  'candlestick', 'mirror', 'comb', 'tool', 'tools', 'implement', 'hammer', 'axe', 'chisel',
  'needle', 'spindle', 'clock', 'watch', 'key', 'lock', 'buckle', 'pin', 'button', 'handle',
  'pipe', 'toy', 'doll', 'model', 'models', 'fan', 'palette',
  // figures and architecture in the round
  'sculpture', 'sculptures', 'statue', 'statues', 'statuette', 'statuettes', 'figurine', 'figure',
  'figures', 'bust', 'relief', 'reliefs', 'stela', 'stele', 'carving', 'mask', 'masks', 'tile',
  'tiles', 'brick', 'capital', 'column',
  // what is worn or exchanged
  'jewelry', 'jewellery', 'ornament', 'amulet', 'amulets', 'scarab', 'scarabs', 'seal', 'seals',
  'ring', 'rings', 'necklace', 'bracelet', 'earring', 'earrings', 'pendant', 'brooch', 'bead',
  'beads', 'coin', 'coins', 'medal', 'medals', 'medallion', 'weight', 'weights',
  // clothing: a three-dimensional thing that happens to be made of cloth
  'dress', 'robe', 'coat', 'shoe', 'shoes', 'sandal', 'boot', 'boots', 'glove', 'gloves', 'hat',
  'costume', 'garment',
  // arms, instruments, burial
  'sword', 'dagger', 'spear', 'arrow', 'armor', 'armour', 'helmet', 'shield', 'gun', 'pistol',
  'rifle', 'weapon', 'weapons', 'instrument', 'instruments', 'drum', 'flute', 'lute', 'lyre',
  'harp', 'guitar', 'violin', 'bell', 'sarcophagus', 'coffin', 'canopic', 'shabti', 'ushabti',
  'mummy',
  // materials
  'bronze', 'copper', 'brass', 'iron', 'steel', 'silver', 'gold', 'pewter', 'lead', 'tin', 'alloy',
  'metal', 'metalwork', 'ceramic', 'ceramics', 'earthenware', 'stoneware', 'porcelain',
  'terracotta', 'clay', 'faience', 'glass', 'glazed', 'glaze', 'stone', 'limestone', 'marble',
  'granite', 'basalt', 'sandstone', 'quartzite', 'steatite', 'alabaster', 'travertine', 'jade',
  'ivory', 'bone', 'shell', 'wood', 'lacquer', 'enamel', 'amber', 'carnelian', 'jasper', 'agate',
  'obsidian', 'flint', 'mud', 'plaster', 'wax', 'leather', 'silt', 'schist', 'greywacke', 'diorite',
  'granodiorite', 'serpentine', 'hematite', 'stucco', 'oak', 'walnut', 'mahogany', 'gilt',
  'rock crystal', 'copper alloy', 'cupreous metal',
];

/**
 * The fields consulted, in the order they are consulted, and the reason for that order.
 *
 * `classification` is the museum's own answer to "what kind of thing is this", so it goes first.
 * `medium` is a materials list, which describes the thing without committing to its shape.
 * `department` is last because it is an administrative bucket that openly mixes both kinds — the
 * AIC's `Painting and Sculpture of Europe` covers 430 works and names one of each. Consulted second
 * it decided 525 rows on the strength of an office name; consulted last it decides only the rows
 * where nothing else spoke.
 */
export const DIMENSIONALITY_FIELDS: readonly (keyof Work)[] = ['classification', 'medium', 'department'];

/**
 * Sheet or object, from what the museum wrote down.
 *
 * **The resolution rule, in two clauses, because a work can match both lists.**
 *
 * 1. **The first field that matches anything decides**, in the order above. A row classified
 *    `Print` whose medium is `etching on copper plate` is a print; the copper is what it was cut
 *    into, not what it is.
 * 2. **Within a field, the longer phrase wins, and a tie goes to `object`.** `wood engraving` (two
 *    words, 2d) beats `wood` (one word, object). `limestone, paint` matches one word from each and
 *    comes back `object` — three-dimensionality is a physical property of the thing, and painting
 *    the surface of a limestone relief does not flatten it.
 *
 * When no field matches either list the answer is `'unknown'` and it is returned as such. 944 of
 * 20,000 rows land there, almost all of them textiles, and that is a fact about what the museums
 * recorded rather than a gap to be filled in with the commoner answer.
 *
 * Measured over the manifest: **2,930 `2d` (14.7%), 16,126 `object` (80.6%), 944 `unknown` (4.7%)**,
 * and 2,970 rows (14.8%) have at least one field matching both lists, so clause 2 is not an edge
 * case. The number this replaces is worth stating: asking only "does any 2D word appear anywhere in
 * these three fields", which is what a one-sided regex does, matches 4,876 rows (24.4%). The
 * 1,946-row difference is not a disagreement about vocabulary — it is the painted, inked, gilded
 * and paper-lined *objects* that a one-sided search calls pictures because it never looks for the
 * other list.
 */
export function dimensionalityOf(w: Work): Dimensionality {
  for (const field of DIMENSIONALITY_FIELDS) {
    const decided = dimensionalityOfText(w[field] as string | null);
    if (decided) return decided;
  }
  return 'unknown';
}

/** One field's verdict, or `null` for "this field said nothing". Exported for the tests and audits. */
export function dimensionalityOfText(text: string | null | undefined): Dimensionality | null {
  const padded = ` ${fold(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const twoD = longestMatch(padded, TWO_D_TERMS);
  const object = longestMatch(padded, OBJECT_TERMS);
  if (twoD === 0 && object === 0) return null;
  return twoD > object ? '2d' : 'object';
}

/** Word count of the longest term in `terms` present in `padded`, or 0. Specificity, measured. */
function longestMatch(padded: string, terms: readonly string[]): number {
  let best = 0;
  for (const t of terms) {
    if (!padded.includes(` ${t} `)) continue;
    const words = t.split(' ').length;
    if (words > best) best = words;
  }
  return best;
}

/** The split, with the per-museum breakdown, because the three museums are not alike here. */
export interface DimensionalitySplit {
  works: number;
  counts: Record<Dimensionality, number>;
  bySource: Record<string, Record<Dimensionality, number>>;
}

export function dimensionalitySplit(works: Work[]): DimensionalitySplit {
  const counts: Record<Dimensionality, number> = { '2d': 0, object: 0, unknown: 0 };
  const bySource: Record<string, Record<Dimensionality, number>> = {};
  for (const w of works) {
    const d = dimensionalityOf(w);
    counts[d]++;
    const row = bySource[w.source] ?? { '2d': 0, object: 0, unknown: 0 };
    row[d]++;
    bySource[w.source] = row;
  }
  return { works: works.length, counts, bySource };
}

// --- 2. TF-IDF over the catalogue prose --------------------------------------------------------------

export interface Term {
  term: string;
  /** Total occurrences across the whole corpus. */
  count: number;
  /** How many works contain it at least once. Documents are works. */
  documents: number;
  /** `(count / documents) * ln(works / documents)`. See the cutoff note on `terms`. */
  tfidf: number;
}

/**
 * The cutoff that makes the ranking mean anything.
 *
 * Documents are works, so IDF is `ln(20000 / df)` and a term in exactly one work scores the maximum
 * there is. Measured over `field: 'all'`: **8,891 of 17,553 distinct terms (50.7%) appear in exactly
 * one work**, and with no cutoff the top of the list is `chantilly`, `dering`, `frigate`,
 * `guapiles`, `marozzo`, `nakhtamun`, `sawdust`, `seeds`, `winterthur`, `mm`, `approx` — a Theban
 * scribe, a fencing master, four place names and two abbreviations, all tied at the same score
 * because they were each said once. That is not a finding about the corpus; it is a list of things
 * said once.
 *
 * 20 works out of 20,000 is 0.1%. It is a knob, it is stated here rather than buried, and the top
 * of the ranking sits just above it by construction: this measure orders terms by how *distinctive*
 * they are, so raising the cutoff raises the floor of what counts as distinctive.
 */
export const MIN_DOCUMENT_FREQUENCY = 20;

export type TermField = 'title' | 'medium' | 'classification' | 'all';

/**
 * `'all'` is every text field on the row: title, creator, date prose, classification, medium,
 * culture, department. Named here rather than left implicit, because "all" over a schema that
 * changes is a measurement that silently changes with it.
 */
const FIELD_TEXT: Record<TermField, (w: Work) => string> = {
  title: (w) => w.title,
  medium: (w) => w.medium,
  classification: (w) => w.classification,
  all: (w) => [w.title, w.creator, w.date_display, w.classification, w.medium, w.culture, w.department].filter(Boolean).join(' '),
};

/**
 * Every term in a field, with its corpus counts and its TF-IDF, most distinctive first.
 *
 * `tf` is occurrences per containing document rather than a raw total, so a term that appears in a
 * thousand works cannot outrank a rarer one on bulk alone; the ranking is then essentially IDF, and
 * the whole question becomes where the floor is. Hence `minDocuments`, which is a parameter with a
 * stated default rather than a constant hidden in the body — a caller measuring a 40-work sample
 * needs a different floor from one measuring 20,000, and should have to say so.
 */
export function terms(works: Work[], field: TermField, minDocuments = MIN_DOCUMENT_FREQUENCY): Term[] {
  const text = FIELD_TEXT[field];
  const count = new Map<string, number>();
  const documents = new Map<string, number>();
  for (const w of works) {
    const seen = new Set<string>();
    for (const t of tokenise(text(w))) {
      count.set(t, (count.get(t) ?? 0) + 1);
      seen.add(t);
    }
    for (const t of seen) documents.set(t, (documents.get(t) ?? 0) + 1);
  }

  const n = works.length;
  const out: Term[] = [];
  for (const [term, d] of documents) {
    if (d < minDocuments) continue;
    const c = count.get(term) as number;
    // ln(n/d) is exactly 0 when a term is in every work. It stays in the list at the bottom rather
    // than being dropped, because "this word is in all 20,000 rows" is itself worth being able to see.
    out.push({ term, count: c, documents: d, tfidf: (c / d) * Math.log(n / d) });
  }
  return out.sort((a, b) => b.tfidf - a.tfidf || b.count - a.count || (a.term < b.term ? -1 : 1));
}

// --- 3. the cross-museum crosswalk -------------------------------------------------------------------

/**
 * A term "carries weight" in a museum when it clears both a floor and a share of that museum.
 *
 * Both, because the museums are unequal in this corpus — 10,000 Met rows against 3,183 Cleveland —
 * and a plain count would call a term shared when it is really the Met's, while a plain share would
 * promote a Cleveland term seen four times.
 */
export const CROSSWALK_MIN_DOCUMENTS = 8;
export const CROSSWALK_MIN_SOURCE_SHARE = 0.002;

/** A term is one museum's private word when at least this much of it is in that one museum. */
export const PRIVATE_SHARE = 0.9;

/** A synonym candidate must be backed by this many works and lean this hard toward one museum. */
export const SYNONYM_MIN_DOCUMENTS = 20;
export const SYNONYM_MIN_SKEW = 1.5;

/** ...and the two terms must be alternatives rather than companions: Jaccard co-occurrence at most this. */
export const SYNONYM_MAX_CO_OCCURRENCE = 0.05;

/** The whole corpus today. A cap rather than a subsample, so nothing is dropped at 20,000 rows. */
export const CROSSWALK_SAMPLE = 20_000;

export interface Crosswalk {
  /** How many works the sample actually held. */
  works: number;
  /** The sample's museum mix. Every concentration below has to be read against this. */
  bySource: Record<string, number>;
  /** Chance that two works drawn from this sample share a source. Every rate below is read against it. */
  chance: number;
  /** Terms carrying real weight in two or more museums: the shared vocabulary. */
  shared: { term: string; bySource: Record<string, number>; sources: number }[];
  /** Terms concentrated in one museum: that museum's private word for something. */
  private: { term: string; source: string; share: number; count: number }[];
  /** Pairs of terms that co-occur across museums far more than chance — candidate synonyms. */
  synonyms: { a: string; b: string; lift: number; support: number }[];
  /**
   * The denominator under every `lift`: mean context similarity over all cross-museum pairs that
   * were evaluated. `lift` is a ratio to this, so `lift 1.0` is exactly chance and is not a finding.
   */
  contextChance: number;
  /** How many cross-museum pairs were compared to get that mean. */
  pairsEvaluated: number;
}

/**
 * What the three museums call the same things, and what each of them calls them alone.
 *
 * ## The text this reads
 *
 * `title + classification + medium`, per work. Not `creator`, `culture` or `department`, all three
 * of which name the museum's own filing system or a region and would make every museum's vocabulary
 * look private by construction. Titles are included because at the Met the title very often *is*
 * the object word — `Bowl`, `Scarab`, `Jar`.
 *
 * ## How the synonym candidates are found, and what they are not
 *
 * Not by string similarity. Comparing spellings would rediscover `ceramic`/`ceramics` and nothing
 * else, and the interesting pairs — `pottery` against `stoneware`, `textiles` against `weaving` —
 * share no letters worth counting.
 *
 * Instead, **shared context**. Each candidate term gets a profile over features that are common to
 * all three museums: the *shared* vocabulary co-occurring with it, plus the work's period band from
 * `periodOf`. Two terms are compared by cosine over those profiles. The profile deliberately
 * excludes museum-private vocabulary, because otherwise a Met term and an AIC term have no features
 * in common at all and every cross-museum cosine is zero.
 *
 * Three filters, all stated and all exported: a candidate must be backed by `SYNONYM_MIN_DOCUMENTS`
 * works; it must *lean* toward one museum by `SYNONYM_MIN_SKEW` times that museum's own share of
 * the sample (a rate over its chance baseline — not "exclusive to", which would drop `ceramic`, a
 * word all three use, and with it the pair the whole exercise is for); and the pair must co-occur
 * in at most `SYNONYM_MAX_CO_OCCURRENCE` of the works holding either, because two words that
 * habitually appear together are companions, not alternatives.
 *
 * **What comes out is a hypothesis and must be labelled as one.** Shared context is not shared
 * meaning. The measured list has `scarabs` pairing with `notched` and `simple` at high lift, which
 * is a true statement about Egyptian seal catalogues and not a synonym. It also has `firearm` ~
 * `firearms` and `scaraboids` ~ `scarab` near the top — known-equivalent pairs recovered from
 * context alone, with no letter compared, which is the closest thing to a positive control this
 * method has. Neither result makes the output a mapping. Nothing downstream may treat it as one.
 *
 * A sample with fewer than two museums cannot answer any of this, so it returns empty lists rather
 * than numbers: `chance` is 1.0, every term is trivially private, and there is no crosswalk to make.
 */
export function crosswalk(works: Work[], sampleSize = CROSSWALK_SAMPLE): Crosswalk {
  const sample = evenSample(works, sampleSize);
  const n = sample.length;

  const sourceCount = new Map<string, number>();
  for (const w of sample) sourceCount.set(w.source, (sourceCount.get(w.source) ?? 0) + 1);
  const sources = [...sourceCount.keys()].sort();
  // The same baseline `composition()` uses: the probability two distinct works drawn from THIS
  // sample agree, not one over the number of museums.
  let chance = 0;
  if (n > 1) for (const c of sourceCount.values()) chance += (c / n) * ((c - 1) / (n - 1));

  const bySourceTotal = Object.fromEntries(sources.map((s) => [s, sourceCount.get(s) as number]));
  const empty: Crosswalk = {
    works: n,
    bySource: bySourceTotal,
    chance: n > 1 ? chance : 1,
    shared: [],
    private: [],
    synonyms: [],
    contextChance: 0,
    pairsEvaluated: 0,
  };
  if (sources.length < 2 || n < 2) return empty;

  const bags = sample.map((w) => new Set(tokenise(`${w.title} ${w.classification} ${w.medium}`)));
  const documents = new Map<string, number>();
  const perSource = new Map<string, Map<string, number>>();
  bags.forEach((bag, i) => {
    const s = (sample[i] as Work).source;
    for (const t of bag) {
      documents.set(t, (documents.get(t) ?? 0) + 1);
      let m = perSource.get(t);
      if (!m) {
        m = new Map();
        perSource.set(t, m);
      }
      m.set(s, (m.get(s) ?? 0) + 1);
    }
  });

  const carries = (term: string, s: string): boolean => {
    const d = perSource.get(term)?.get(s) ?? 0;
    return d >= CROSSWALK_MIN_DOCUMENTS && d >= CROSSWALK_MIN_SOURCE_SHARE * (sourceCount.get(s) as number);
  };
  const topSourceOf = (term: string): string => {
    const m = perSource.get(term) as Map<string, number>;
    return sources.reduce((a, s) => ((m.get(s) ?? 0) > (m.get(a) ?? 0) ? s : a), sources[0] as string);
  };

  const shared: Crosswalk['shared'] = [];
  const isPrivate: Crosswalk['private'] = [];
  const leaning = new Map<string, string>();
  for (const [term, d] of documents) {
    const m = perSource.get(term) as Map<string, number>;
    const carried = sources.filter((s) => carries(term, s));
    if (carried.length >= 2) {
      shared.push({ term, bySource: Object.fromEntries(sources.map((s) => [s, m.get(s) ?? 0])), sources: carried.length });
    }
    const top = topSourceOf(term);
    const share = (m.get(top) ?? 0) / d;
    if (d >= CROSSWALK_MIN_DOCUMENTS && share >= PRIVATE_SHARE) isPrivate.push({ term, source: top, share, count: d });
    // Skew, not exclusivity: the term's share in its top museum over that museum's share of the sample.
    if (d >= SYNONYM_MIN_DOCUMENTS && share / ((sourceCount.get(top) as number) / n) >= SYNONYM_MIN_SKEW) leaning.set(term, top);
  }
  const total = (r: Record<string, number>) => Object.values(r).reduce((x, y) => x + y, 0);
  shared.sort((a, b) => b.sources - a.sources || total(b.bySource) - total(a.bySource) || (a.term < b.term ? -1 : 1));
  isPrivate.sort((a, b) => b.count - a.count || b.share - a.share || (a.term < b.term ? -1 : 1));

  // --- context profiles, over features all three museums can be seen to use
  const sharedTerms = new Set(shared.map((s) => s.term));
  const features = bags.map((bag, i) => {
    const f = new Set<string>();
    for (const t of bag) if (sharedTerms.has(t)) f.add(`t:${t}`);
    f.add(`p:${periodOf(sample[i] as Work)}`);
    return f;
  });

  const candidates = [...leaning.keys()].sort();
  const holders = new Map<string, number[]>(candidates.map((t) => [t, []]));
  bags.forEach((bag, i) => {
    for (const t of candidates) if (bag.has(t)) (holders.get(t) as number[]).push(i);
  });

  const profiles = new Map<string, Map<string, number>>();
  for (const t of candidates) {
    const idx = holders.get(t) as number[];
    const v = new Map<string, number>();
    for (const i of idx) for (const f of features[i] as Set<string>) if (f !== `t:${t}`) v.set(f, (v.get(f) ?? 0) + 1);
    let norm = 0;
    for (const [k, c] of v) {
      const x = c / idx.length;
      v.set(k, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, x] of v) v.set(k, x / norm);
    profiles.set(t, v);
  }

  const raw: { a: string; b: string; cos: number; support: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i] as string;
      const b = candidates[j] as string;
      if (leaning.get(a) === leaning.get(b)) continue;
      const inA = new Set(holders.get(a) as number[]);
      const inB = holders.get(b) as number[];
      let both = 0;
      for (const x of inB) if (inA.has(x)) both++;
      const union = inA.size + inB.length - both;
      if (union === 0 || both / union > SYNONYM_MAX_CO_OCCURRENCE) continue;
      const pa = profiles.get(a) as Map<string, number>;
      const pb = profiles.get(b) as Map<string, number>;
      const [small, big] = pa.size < pb.size ? [pa, pb] : [pb, pa];
      let cos = 0;
      for (const [k, x] of small) cos += x * (big.get(k) ?? 0);
      raw.push({ a, b, cos, support: Math.min(inA.size, inB.length) });
    }
  }
  const contextChance = raw.length ? raw.reduce((s, p) => s + p.cos, 0) / raw.length : 0;
  const synonyms = raw
    .map((p) => ({ a: p.a, b: p.b, lift: contextChance > 0 ? p.cos / contextChance : 0, support: p.support }))
    .sort((x, y) => y.lift - x.lift || y.support - x.support || (x.a < y.a ? -1 : 1));

  return { works: n, bySource: bySourceTotal, chance, shared, private: isPrivate, synonyms, contextChance, pairsEvaluated: raw.length };
}

/** Every rate beside the baseline it has to beat, in the shape `corpus atlas` prints. */
export function crosswalkText(c: Crosswalk, top = 15): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const out: string[] = [];
  const mix = Object.entries(c.bySource).map(([s, v]) => `${s} ${v}`).join(', ');
  out.push(`${c.works} works — ${mix}`);
  out.push(`chance two works share a museum: ${pct(c.chance)}`);

  if (Object.keys(c.bySource).length < 2) {
    out.push('');
    out.push('NOTHING MEASURED — one museum in the sample, so there is no crosswalk to make.');
    return out.join('\n') + '\n';
  }

  out.push('');
  out.push(`shared vocabulary — ${c.shared.length} terms carry weight in two or more museums:`);
  for (const s of c.shared.slice(0, top)) {
    const counts = Object.entries(s.bySource).map(([k, v]) => `${k} ${v}`).join('  ');
    out.push(`  ${s.term.padEnd(16)} ${s.sources} museums  ${counts}`);
  }

  out.push('');
  out.push(`private vocabulary — ${c.private.length} terms at least ${pct(PRIVATE_SHARE)} in one museum:`);
  for (const p of c.private.slice(0, top)) {
    // The baseline for a concentration is that museum's own share of the sample, not 1/3: half this
    // corpus is the Met, so a term sitting 50% in the Met is telling you nothing at all.
    const prior = (c.bySource[p.source] ?? 0) / (c.works || 1);
    out.push(`  ${p.term.padEnd(16)} ${p.source}  ${pct(p.share)}  chance ${pct(prior)}  ${(p.share / (prior || 1)).toFixed(1)}x  n=${p.count}`);
  }

  out.push('');
  if (c.pairsEvaluated === 0) {
    out.push('synonym candidates: NOTHING MEASURED — no cross-museum pair cleared the thresholds.');
    return out.join('\n') + '\n';
  }
  out.push(`synonym candidates — HYPOTHESES, not a mapping. ${c.pairsEvaluated} cross-museum pairs compared;`);
  out.push(`mean context similarity ${c.contextChance.toFixed(4)} is the chance baseline, so lift 1.0x is no result:`);
  for (const s of c.synonyms.slice(0, top)) {
    out.push(`  ${s.a.padEnd(16)} ~ ${s.b.padEnd(16)} ${s.lift.toFixed(2)}x chance  support ${s.support}`);
  }
  return out.join('\n') + '\n';
}
