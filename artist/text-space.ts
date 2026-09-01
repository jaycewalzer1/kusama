// The lexical control: how far does plain word overlap get you, before any text encoder exists.
//
// The corpus has three embedding matrices and every one of them is image-side. There is no text
// embedding of the catalogue anywhere, and before building one there is a question that has to be
// answered first, because it decides whether the embedding is worth building at all:
//
//   The published "metadata neighbours are 93.6% same-museum" figure is `atlas.ts`'s ~87-column
//   one-hot over source, classification and culture. `vocabulary.ts` has already shown that AIC
//   paper terms — `laid` in 97.7% of its prints, `wove` in 97.8% — are near-private to one museum.
//   So the catalogue's failure to cross the museum wall may be nothing more interesting than three
//   institutions spelling the same materials differently.
//
// If BM25 over the raw strings reproduces the one-hot's museum-boundedness, then a text embedding
// that also reproduces it has demonstrated nothing: it will have spent 30MB and a model download to
// launder word overlap. This file is what makes that outcome detectable instead of publishable.
//
// Report-only. No model, no API key, no network, no download. Nothing here feeds a run or a hash.
//
// ## Two decisions that would have quietly produced the wrong answer
//
// **Terms are NOT field-tagged.** Encoding `title:bowl` and `medium:bowl` as different terms is the
// obvious way to make a field ablation easy, and it would have destroyed the exact thing being
// measured. At the Met the title very often IS the object word (`Bowl`, `Scarab`, `Jar`) while the
// AIC puts that word in `classification` and Cleveland in `type`. Field-tagging makes those three
// records share no term at all, so every neighbour becomes same-museum by construction and BM25
// "confirms" the 93.6% as an artefact of the tagging scheme. So the scored term is the bare word,
// and the field is recorded alongside it only so a field can be *withheld* and the index rebuilt.
//
// **Ties are not broken by row order.** `corpus/manifest.jsonl` is written grouped by source. Bags
// this short tie constantly — thousands of Egyptian scarabs carry a byte-identical bag — and a tie
// broken by index would hand every one of those neighbours to the query's own museum and report the
// manifest's sort order as a finding about cataloguing. Ties break on a hash of the work id, which
// is stable across runs and uncorrelated with source. `tiedAtK` reports how much of the result rests
// on that rule, because where the ties are dense the neighbour set is arbitrary no matter how it is
// broken and the honest reading is that BM25 has not ranked those works at all.

import { createHash } from 'node:crypto';
import type { Work } from './manifest.js';
import { tokenise } from './vocabulary.js';

/**
 * The catalogue fields that carry words, and the order they are named in.
 *
 * `image_url`, `accession_number` and `url` are excluded because they are identifiers: they tokenise
 * into museum-private junk that would drive the same-museum rate to nearly 100% and mean nothing.
 * This is the same field list `vocabulary.ts` calls `'all'`, kept in step with it deliberately.
 */
export const TEXT_FIELDS = [
  'title',
  'creator',
  'date_display',
  'classification',
  'medium',
  'culture',
  'department',
] as const;

export type TextField = (typeof TEXT_FIELDS)[number];

/** Okapi BM25's two standard constants, named rather than inlined so a reader can see they are stock. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface TextIndex {
  /** One entry per document, parallel to the `works` passed in. */
  works: Work[];
  /** Distinct terms, in first-seen order. `postings[t]` is indexed by this. */
  terms: string[];
  /** `postings[termId]` = alternating (doc, tf) pairs, ascending by doc. */
  postings: Int32Array[];
  /** `bags[doc]` = term ids in that document, for use as a query. */
  bags: Int32Array[];
  /** Term frequency of `bags[doc][j]` in that doc. */
  bagTf: Int32Array[];
  /** Total term count per document, BM25's `|D|`. */
  lengths: Float64Array;
  avgLength: number;
  /** `idf[termId]`, precomputed. */
  idf: Float64Array;
  /** Which fields were read to build this. */
  fields: TextField[];
  /** Documents whose bag came out empty — they can neither retrieve nor be retrieved. */
  empty: number;
}

/**
 * A BM25 index over the works' catalogue prose.
 *
 * `fields` is the ablation knob and the whole reason this takes a parameter: rebuilding without
 * `medium` is how the `laid paper` / `wove paper` hypothesis gets tested, and rebuilding without
 * `department` is how "is this just the museum's own filing cabinet" gets tested.
 */
export function buildIndex(works: Work[], fields: readonly TextField[] = TEXT_FIELDS): TextIndex {
  const termId = new Map<string, number>();
  const terms: string[] = [];
  const rawPostings: number[][] = [];
  const bags: Int32Array[] = [];
  const bagTf: Int32Array[] = [];
  const lengths = new Float64Array(works.length);
  let empty = 0;

  works.forEach((w, doc) => {
    const counts = new Map<number, number>();
    let total = 0;
    for (const f of fields) {
      for (const t of tokenise(w[f] as string | null)) {
        let id = termId.get(t);
        if (id === undefined) {
          id = terms.length;
          termId.set(t, id);
          terms.push(t);
          rawPostings.push([]);
        }
        counts.set(id, (counts.get(id) ?? 0) + 1);
        total++;
      }
    }
    if (counts.size === 0) empty++;
    lengths[doc] = total;
    const ids = [...counts.keys()].sort((a, b) => a - b);
    bags.push(Int32Array.from(ids));
    bagTf.push(Int32Array.from(ids, (id) => counts.get(id) as number));
    for (const id of ids) {
      const p = rawPostings[id] as number[];
      p.push(doc, counts.get(id) as number);
    }
  });

  const n = works.length;
  const idf = new Float64Array(terms.length);
  for (let t = 0; t < terms.length; t++) {
    const df = (rawPostings[t] as number[]).length / 2;
    // The standard BM25 IDF with the +1 that keeps it non-negative. Without it a term present in
    // more than half the corpus scores negative and holding a very common word in common actively
    // pushes two works apart, which is not a claim anyone intends to make.
    idf[t] = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  let sum = 0;
  for (const l of lengths) sum += l;

  return {
    works,
    terms,
    postings: rawPostings.map((p) => Int32Array.from(p)),
    bags,
    bagTf,
    lengths,
    avgLength: n > 0 ? sum / n : 0,
    idf,
    fields: [...fields],
    empty,
  };
}

/** Deterministic, source-independent tie-break. See the header note on manifest ordering. */
function tieKey(id: string): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0);
}

export interface Neighbours {
  rows: number[];
  /** How many of the `k` returned were on a score tied with the score at rank `k`. */
  tied: number;
}

/**
 * The `k` documents BM25 ranks highest for document `self`, using its own bag as the query.
 *
 * Asymmetric, as BM25 is: `score(a, b)` and `score(b, a)` differ because the query terms come from
 * one side and the length normalisation from the other. That is the standard retrieval quantity and
 * the one a text embedding would have to beat, so it is not "fixed" into a symmetric cosine here.
 */
export function neighbours(ix: TextIndex, self: number, k: number, keys: Float64Array): Neighbours {
  const n = ix.works.length;
  const scores = new Float64Array(n);
  const bag = ix.bags[self] as Int32Array;
  for (const t of bag) {
    const idf = ix.idf[t] as number;
    const p = ix.postings[t] as Int32Array;
    for (let i = 0; i < p.length; i += 2) {
      const doc = p[i] as number;
      const tf = p[i + 1] as number;
      const norm = 1 - BM25_B + (BM25_B * (ix.lengths[doc] as number)) / (ix.avgLength || 1);
      scores[doc] = (scores[doc] as number) + (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
    }
  }
  scores[self] = -Infinity;

  const order: number[] = [];
  for (let i = 0; i < n; i++) if (i !== self && (scores[i] as number) > 0) order.push(i);
  order.sort((a, b) => (scores[b] as number) - (scores[a] as number) || (keys[a] as number) - (keys[b] as number));
  const rows = order.slice(0, k);
  const cut = rows.length > 0 ? (scores[rows[rows.length - 1] as number] as number) : 0;
  const tied = rows.filter((r) => (scores[r] as number) === cut).length;
  return { rows, tied: rows.length > 0 ? tied : 0 };
}

export interface FieldReading {
  /**
   * `null` for the full index; `{ withheld }` for every field but one; `{ only }` for that field
   * alone.
   *
   * Both ablations are reported because neither answers the question by itself. These fields are
   * redundant — `department` says "Prints and Drawings", `classification` says "engraving" and
   * `medium` says "engraving on laid paper" about the same sheet — so withholding one changes almost
   * nothing while the information survives in its neighbours, and a withhold-only table reads as
   * "no field matters", which is the opposite of the truth. Keeping one field alone is what shows
   * what that field can do on its own.
   */
  scope: { withheld: TextField } | { only: TextField } | null;
  /** The field withheld to produce this reading, or null. Kept for callers that only read this. */
  withheld: TextField | null;
  /** Mean over queries of the share of a query's top-k drawn from the QUERY's own museum. */
  sameMuseum: number;
  sd: number;
  t: number;
  /** Queries that retrieved nothing at all — an empty bag, or no term shared with any other work. */
  unretrievable: number;
  /** Mean share of a query's returned neighbours sitting on the score tie at rank k. */
  tiedAtK: number;
  /** Mean neighbours actually returned; below k when the bag is too thin to reach that far. */
  returned: number;
}

export interface TextBaseline {
  works: number;
  queries: number;
  k: number;
  /** P(two works drawn without replacement share a museum), on THESE works. */
  chance: number;
  terms: number;
  emptyBags: number;
  /** The full index first, then one reading per field withheld. */
  readings: FieldReading[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sd = (xs: number[], m: number) =>
  xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0;

/**
 * The same-museum statistic `second-space.ts` computes for CLIP and DINOv2, computed for BM25.
 *
 * Deliberately the same quantity: the share of a query's top-k that comes from the QUERY's museum,
 * averaged over queries. NOT the neighbours-against-each-other pair rate, which is a different
 * number and has already been printed under the wrong heading once in this repo.
 *
 * `queryRows` must be the works to use as queries, by index into `works`. The caller supplies them
 * so that the identical sample can be handed to a second space and the two columns compared without
 * a sampling difference hiding inside the gap.
 */
export function textBaseline(
  works: Work[],
  queryRows: number[],
  k = 12,
  fields: readonly TextField[] = TEXT_FIELDS,
): TextBaseline {
  const n = works.length;
  if (n < k + 2) throw new Error(`only ${n} work(s); ${k} neighbours cannot be drawn`);

  const counts: Record<string, number> = {};
  for (const w of works) counts[w.source] = (counts[w.source] ?? 0) + 1;
  const chance = Object.values(counts).reduce((acc, c) => acc + (c / n) * ((c - 1) / (n - 1)), 0);

  const keys = Float64Array.from(works, (w) => tieKey(w.id));

  const read = (scope: FieldReading['scope']): FieldReading => {
    const use =
      scope === null
        ? fields
        : 'only' in scope
          ? [scope.only]
          : fields.filter((f) => f !== scope.withheld);
    const ix = buildIndex(works, use);
    const rates: number[] = [];
    const ties: number[] = [];
    const got: number[] = [];
    let unretrievable = 0;
    for (const q of queryRows) {
      const { rows, tied } = neighbours(ix, q, k, keys);
      got.push(rows.length);
      if (rows.length === 0) {
        unretrievable++;
        continue;
      }
      const mine = (works[q] as Work).source;
      rates.push(rows.reduce((a, i) => a + ((works[i] as Work).source === mine ? 1 : 0), 0) / rows.length);
      ties.push(tied / rows.length);
    }
    const m = mean(rates);
    const s = sd(rates, m);
    return {
      scope,
      withheld: scope !== null && 'withheld' in scope ? scope.withheld : null,
      sameMuseum: m,
      sd: s,
      t: s > 0 ? (m - chance) / (s / Math.sqrt(rates.length)) : 0,
      unretrievable,
      tiedAtK: mean(ties),
      returned: mean(got),
    };
  };

  const full = buildIndex(works, fields);
  return {
    works: n,
    queries: queryRows.length,
    k,
    chance,
    terms: full.terms.length,
    emptyBags: full.empty,
    readings: [
      read(null),
      ...fields.map((f) => read({ withheld: f })),
      ...fields.map((f) => read({ only: f })),
    ],
  };
}

/** How far a withheld field has to move the rate before it is worth a sentence. */
export const FIELD_BAND = 0.05;

/** Above this share of queries retrieving nothing, a keep-one rate is about a subset, not the corpus. */
export const SPARSE_FIELD_SHARE = 0.1;

/** The published one-hot figure this is the control for. Quoted, never recomputed here. */
export const ONE_HOT_METADATA_KNN = 0.936;

export function textBaselineText(r: TextBaseline): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const out: string[] = [];
  const full = r.readings[0] as FieldReading;

  out.push(
    `BM25 over the catalogue prose of ${r.works.toLocaleString()} works — ${r.terms.toLocaleString()} distinct terms,`,
    `${r.queries.toLocaleString()} queries drawn by stride, top-${r.k}. No model, no key, no network.`,
    '',
    'SAME-MUSEUM SHARE among a work\'s own nearest neighbours, by what the museum wrote down',
    `  ${'all fields'.padEnd(22)} ${pct(full.sameMuseum)}  (sd ${pct(full.sd)}, t ${full.t.toFixed(1)} vs chance)`,
  );
  const withheld = r.readings.filter((f) => f.scope !== null && 'withheld' in f.scope);
  const only = r.readings.filter((f) => f.scope !== null && 'only' in f.scope);
  for (const f of withheld) {
    const d = f.sameMuseum - full.sameMuseum;
    out.push(
      `  ${`without ${f.withheld}`.padEnd(22)} ${pct(f.sameMuseum)}  ${d >= 0 ? '+' : ''}${pct(d)}`,
    );
  }
  out.push(`  ${'chance'.padEnd(22)} ${pct(r.chance)}  two works drawn at random`);
  out.push('');
  out.push('THAT FIELD ALONE, because these fields say the same thing in three vocabularies');
  for (const f of only) {
    const field = (f.scope as { only: TextField }).only;
    // A sparse field's rate is measured on whatever subset filled it in, and that subset is not the
    // corpus. `creator` is present for 41% of works, so its rate is a fact about attributed works.
    const thin = f.unretrievable > SPARSE_FIELD_SHARE * r.queries;
    out.push(
      `  ${`${field} alone`.padEnd(22)} ${pct(f.sameMuseum)}  ` +
        `${thin ? 'ON ONLY ' : ''}${r.queries - f.unretrievable} of ${r.queries} queries${thin ? ' — NOT comparable to the rows above' : ''}`,
    );
  }
  if (only.some((f) => f.unretrievable > SPARSE_FIELD_SHARE * r.queries)) {
    out.push(
      `  A field left blank cannot retrieve, so a sparse field's rate is measured on the works that`,
      `  happen to carry it. Those subsets differ by field and none of them is the corpus.`,
    );
  }
  out.push('');

  // The comparison the whole file exists to make.
  const gap = full.sameMuseum - ONE_HOT_METADATA_KNN;
  out.push('AGAINST THE PUBLISHED ONE-HOT FIGURE');
  out.push(
    `  ${pct(ONE_HOT_METADATA_KNN)} is \`atlas.ts\`'s ~87-column one-hot, measured on a different sample; it is`,
    `  quoted here and not recomputed, so read the gap as approximate.`,
  );
  if (Math.abs(gap) <= FIELD_BAND) {
    out.push(
      `  BM25 lands within ${pct(FIELD_BAND)} of it at ${pct(full.sameMuseum)}. Plain word overlap already accounts`,
      `  for the catalogue's museum-boundedness. A text embedding that reports a similar rate has`,
      `  therefore added NOTHING over a tokeniser, and must not be quoted as though it had.`,
    );
  } else if (gap < 0) {
    out.push(
      `  BM25 is ${pct(-gap)} LOWER at ${pct(full.sameMuseum)}. The words cross the wall better than the`,
      `  categories do, so part of the one-hot's ${pct(ONE_HOT_METADATA_KNN)} is the encoding and not the catalogue.`,
      `  There is room above BM25 for an embedding to be worth building — and this is the number it`,
      `  has to beat, not the ${pct(ONE_HOT_METADATA_KNN)}.`,
    );
  } else {
    out.push(
      `  BM25 is ${pct(gap)} HIGHER at ${pct(full.sameMuseum)} — more museum-bound than the categories.`,
      `  The museums' private spellings are doing more of the work than their private categories.`,
    );
  }
  out.push('');

  const moved = withheld
    .map((f) => ({ f, d: f.sameMuseum - full.sameMuseum }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const top = moved[0];
  // Only fields answered by most of the corpus can be ranked against each other; a sparse field's
  // rate is over a different population and putting it in this ordering would compare two subsets.
  const alone = only
    .filter((f) => f.unretrievable <= SPARSE_FIELD_SHARE * r.queries)
    .sort((a, b) => b.sameMuseum - a.sameMuseum);
  const highest = alone[0];
  const lowest = alone[alone.length - 1];

  out.push('WHICH FIELD CARRIES IT — read the two tables together, never the first alone');
  if (!top || Math.abs(top.d) <= FIELD_BAND) {
    out.push(
      `  Withholding any single field moves the rate by at most ${pct(Math.abs(top?.d ?? 0))}, inside the ${pct(FIELD_BAND)} band`,
      `  fixed before this ran. That is NOT evidence that no field matters: these fields are`,
      `  redundant, so removing one leaves the same information standing in its neighbours.`,
    );
  } else {
    out.push(
      `  Withholding \`${top.f.withheld}\` moves the rate by ${top.d >= 0 ? '+' : ''}${pct(top.d)}, the largest of the ${moved.length} — but a`,
      `  withhold test cannot see redundancy, and every other field moves it less than ${pct(FIELD_BAND)}.`,
    );
  }
  if (highest && lowest) {
    out.push(
      `  Alone, \`${(highest.scope as { only: TextField }).only}\` reaches ${pct(highest.sameMuseum)} and \`${(lowest.scope as { only: TextField }).only}\` only ${pct(lowest.sameMuseum)}.`,
      `  ${highest.sameMuseum >= full.sameMuseum - FIELD_BAND ? `\`${(highest.scope as { only: TextField }).only}\` on its own is worth the entire catalogue: the museum wall survives deleting everything else.` : 'No single field reaches the full index on its own.'}`,
    );
  }
  out.push('');

  out.push('HOW MUCH OF THIS IS EVEN RANKED');
  out.push(
    `  ${pct(full.tiedAtK)} of a query's neighbours sit on the score tie at rank ${r.k}, and ${full.unretrievable} of`,
    `  ${r.queries} queries retrieved nothing at all (${r.emptyBags} works have an empty bag). Mean neighbours`,
    `  returned: ${full.returned.toFixed(1)} of ${r.k}.`,
  );
  if (full.tiedAtK > 0.5) {
    out.push(
      `  Over half the neighbourhood is tied, so for most queries BM25 has NOT ranked these works —`,
      `  it has found a block of identical bags and the order inside it is the tie-break. Read the`,
      `  same-museum rate above as a statement about that block, not about a ranking.`,
    );
  }
  out.push(
    '',
    'Ties break on a hash of the work id, never on row order: the manifest is grouped by source, so',
    'an index tie-break would hand tied neighbours to the query\'s own museum and report the sort',
    'order as a finding. Terms are not field-tagged, or a Met `Bowl` title and an AIC `bowl`',
    'classification would share no term and every neighbour would be same-museum by construction.',
  );
  return out.map((s) => `${s}\n`).join('');
}
