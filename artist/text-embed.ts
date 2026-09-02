// The catalogue, embedded — CLIP's TEXT tower over the same prose `text-space.ts` scored with BM25.
//
// Stage C answered the question that had to come first: plain word overlap already puts a work's
// nearest neighbours at 92.4% same-museum against the published one-hot's 93.6% and chance 39.0%.
// So the museum-boundedness of the catalogue is not a deep fact about cataloguing; it is largely
// word overlap, and **92.4% is the number an embedding has to beat, not 93.6%**. This file builds
// the embedding anyway, for the one thing BM25 cannot do: land the words in the same 512-d space as
// `corpus/clip.f32`, so a work's catalogue entry and a work's photograph can be compared directly.
//
// No API key, no network at run time, no credit. `artist/clip-text.ts` is a local ONNX text tower
// from the same checkpoint as the vision tower already used for the images. Report-only: nothing
// here feeds a run, a reward, or a hash.
//
// ## `department` is an org chart, and counting it as catalogue text is what made the wall
//
// The keep-one table in stage C is the reason there are two field sets here rather than one.
// Withholding one field at a time moved the rate by at most 6.9%, which reads as "no field matters"
// and is false — these fields are redundant, so the information survives in the field's neighbours.
// Keeping ONE field is what showed where the wall actually lives:
//
//   department alone     90.7%   an administrative field naming the museum's own filing cabinet
//   classification alone 83.9%
//   medium alone         65.5%
//   title alone          58.0%   level with the picture, on the same 1,000-query sample
//
// `department` on its own is worth the entire catalogue. It is not a description of the object; it
// is the name of the curatorial division that happens to hold it, and no two museums draw those
// lines the same way. Embed it and the encoder will learn the org chart and the report will call it
// a finding about art. So `object` — title, classification, medium — is the field set that asks
// what the museum said about the *work*, and `all` is kept beside it as the direct counterpart to
// BM25's full index. The gap between the two columns is the size of the artefact.
//
// ## This matrix does NOT row-align with the image matrices
//
// `clip.f32`, `dino.f32` and `descriptors.v1.f32` are one row per distinct IMAGE, in sorted sha256
// order, 19,807 rows — 98 manifest rows share bytes and 111 works never got pixels. Text is
// naturally per WORK, so this file is 20,000 rows in manifest order indexed by work id. Any
// `text row i vs image row i` loop is silently wrong. `joinToImages()` is the only join, and it
// goes through the image loader's own dedupe so that a text comparison and an image comparison are
// over the same population rather than over two populations that disagree by 193 works.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { evenSample } from './atlas.js';
import { DIM, embedText } from './clip-text.js';
import { MANIFEST, loadCorpusEmbeddings, type CorpusEmbeddings } from './clip-index.js';
import { readManifest, type Work } from './manifest.js';
import {
  ONE_HOT_METADATA_KNN,
  TEXT_FIELDS,
  buildIndex,
  neighbours,
  type TextField,
} from './text-space.js';

export { DIM };

/**
 * The two questions worth asking of the catalogue, as field lists.
 *
 * `all` is BM25's full index, so the two are comparable term for term. `object` drops the four
 * fields that describe the record rather than the work: `department` (the museum's org chart, worth
 * the whole wall on its own), `creator` (41% dense, and an attribution vocabulary is museum-private
 * in the same way), `culture` (71% dense, likewise), and `date_display` (three houses spell the
 * same century three ways, so it carries spelling and not period).
 */
export const FIELD_SETS = {
  all: TEXT_FIELDS,
  object: ['title', 'classification', 'medium'],
} as const satisfies Record<string, readonly TextField[]>;

export type FieldSet = keyof typeof FIELD_SETS;

export const FIELD_SET_NAMES = Object.keys(FIELD_SETS) as FieldSet[];

export const matrixPath = (set: FieldSet): string =>
  path.join(ROOT, 'corpus', `text-clip-${set}.f32`);
export const indexPath = (set: FieldSet): string =>
  path.join(ROOT, 'corpus', `text-clip-${set}.index.json`);

/**
 * What actually goes into the tower.
 *
 * Comma-separated, values only, no field names. Prefixing values with their field would put
 * `title:` and `medium:` into a caption encoder that was trained on English sentences, and CLIP has
 * no idea what those mean; it is also the exact mistake `text-space.ts` pins a test against on the
 * lexical side, where field-tagging drives the same-museum rate to 100% by construction. Fields are
 * emitted in `TEXT_FIELDS` order so the string is stable, and empty fields are dropped rather than
 * left as gaps — 59% of works have no `creator` and a trailing `, ,` is a token the tower would
 * have to interpret.
 */
export function metadataString(work: Work, fields: readonly TextField[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = work[f];
    if (typeof v === 'string' && v.trim() !== '') parts.push(v.trim());
  }
  return parts.join(', ');
}

export interface TextMatrix {
  set: FieldSet;
  fields: readonly TextField[];
  /** Work id per row, in manifest order. */
  ids: string[];
  /** `ids.length` x 512, unit-normalised, row-major. */
  rows: Float32Array;
  /** Works whose fields were all empty; their row is present but means nothing. */
  empty: number;
}

/**
 * Embed every work's metadata string and write the matrix and its index.
 *
 * Every work is embedded, including the 111 with no pixels, because the matrix is a per-work
 * artefact and dropping rows here would push the image join's dedupe rule into a second place.
 */
export async function embedCorpusText(
  set: FieldSet,
  onProgress?: (done: number, total: number) => void,
  manifest = MANIFEST,
): Promise<TextMatrix> {
  const fields = FIELD_SETS[set];
  const works = readManifest(manifest).works;
  if (works.length === 0) throw new Error(`no works in ${manifest}`);

  const strings = works.map((w) => metadataString(w, fields));
  const empty = strings.filter((s) => s === '').length;

  const rows = new Float32Array(works.length * DIM);
  const batch = 64;
  for (let start = 0; start < strings.length; start += batch) {
    const vecs = await embedText(strings.slice(start, start + batch), batch);
    vecs.forEach((v, i) => rows.set(v, (start + i) * DIM));
    onProgress?.(Math.min(start + batch, strings.length), strings.length);
  }

  const ids = works.map((w) => w.id);
  writeFileSync(matrixPath(set), Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength));
  writeFileSync(indexPath(set), JSON.stringify(ids));
  return { set, fields, ids, rows, empty };
}

export function textMatrixAvailable(set: FieldSet): boolean {
  return existsSync(matrixPath(set)) && existsSync(indexPath(set));
}

/** Read a matrix back, checking that the file's row count and the index agree. */
export function loadTextMatrix(set: FieldSet): TextMatrix {
  const mp = matrixPath(set);
  const ip = indexPath(set);
  if (!existsSync(mp) || !existsSync(ip)) {
    throw new Error(
      `No text embeddings at ${path.relative(ROOT, mp)}. Build them: ` +
        `npm run corpus -- text-embed --set ${set}  (local CLIP text tower, no API key).`,
    );
  }
  const ids: string[] = JSON.parse(readFileSync(ip, 'utf8'));
  const buf = readFileSync(mp);
  const inFile = Math.floor(buf.length / (DIM * 4));
  if (inFile !== ids.length) {
    throw new Error(`${mp} holds ${inFile} rows but the index names ${ids.length}`);
  }
  const rows = new Float32Array(ids.length * DIM);
  for (let i = 0; i < rows.length; i++) rows[i] = buf.readFloatLE(i * 4);
  let empty = 0;
  for (let i = 0; i < ids.length; i++) {
    let any = false;
    for (let j = 0; j < DIM && !any; j++) if (rows[i * DIM + j] !== 0) any = true;
    if (!any) empty++;
  }
  return { set, fields: FIELD_SETS[set], ids, rows, empty };
}

export interface TextImageJoin {
  /** The image loader's entries, filtered to those whose work also has a text row. */
  entries: CorpusEmbeddings['entries'];
  /** `entries.length` x 512 image vectors, repacked into the shared order. */
  imageRows: Float32Array;
  /** `entries.length` x 512 text vectors per set, in the SAME order as `entries`. */
  textRows: Record<FieldSet, Float32Array>;
  n: number;
  /** Works with a text row but no image row: no pixels, or bytes shared with a kept work. */
  textOnly: number;
}

/**
 * The one join between the per-work text matrices and the per-image matrices.
 *
 * Goes through `loadCorpusEmbeddings()` so the dedupe, the zero-row rule and the lowest-id-wins
 * tie-break are the ones already in use — a second copy of that logic would report its disagreement
 * with the first as a finding. After this every index means the same work in every matrix, which is
 * the only condition under which the columns of the report below can be read against each other.
 */
export function joinToImages(
  sets: readonly FieldSet[] = FIELD_SET_NAMES,
  images: CorpusEmbeddings = loadCorpusEmbeddings(),
): TextImageJoin {
  const matrices = sets.map((s) => loadTextMatrix(s));
  const first = matrices[0];
  if (!first) throw new Error('at least one field set is needed');
  for (const m of matrices) {
    if (m.ids.length !== first.ids.length) {
      throw new Error(`text sets disagree on row count: ${m.set} has ${m.ids.length}, ${first.set} ${first.ids.length}`);
    }
  }
  const at = new Map(first.ids.map((id, i) => [id, i]));

  const entries: CorpusEmbeddings['entries'] = [];
  const textRowOf: number[] = [];
  for (const e of images.entries) {
    const i = at.get(e.work.id);
    if (i === undefined) continue;
    entries.push(e);
    textRowOf.push(i);
  }
  const n = entries.length;

  const imageRows = new Float32Array(n * DIM);
  entries.forEach((e, i) => {
    imageRows.set(images.rows.subarray(e.row * DIM, (e.row + 1) * DIM), i * DIM);
  });

  const textRows = {} as Record<FieldSet, Float32Array>;
  matrices.forEach((m, mi) => {
    const packed = new Float32Array(n * DIM);
    for (let i = 0; i < n; i++) {
      const src = textRowOf[i] as number;
      packed.set(m.rows.subarray(src * DIM, (src + 1) * DIM), i * DIM);
    }
    textRows[sets[mi] as FieldSet] = packed;
  });

  return { entries, imageRows, textRows, n, textOnly: first.ids.length - n };
}

// ---------------------------------------------------------------------------------------------
// The comparison. This, and not the 40MB file, is what stage A was for.
// ---------------------------------------------------------------------------------------------

export interface SpaceColumn {
  name: string;
  /** Mean over queries of the share of a query's top-k drawn from the QUERY's own museum. */
  sameMuseum: number;
  sd: number;
  /** (mean - chance) / standard error. Not a p-value and not presented as one. */
  t: number;
  /** Queries that retrieved nothing. Only BM25 can do this; a dense space always returns k. */
  unretrievable: number;
}

export interface OverlapReading {
  a: string;
  b: string;
  /** Mean share of a query's top-k that both spaces name. */
  mean: number;
  sd: number;
  /** Queries whose two neighbour sets share nothing at all. */
  disjoint: number;
}

export interface CrossModal {
  set: FieldSet;
  /** Share of queries whose OWN image is in the top-k images its own catalogue text retrieves. */
  selfAtK: number;
  /** Mean cosine between a work's text vector and its own image vector. */
  selfCosine: number;
  /** Mean cosine between a work's text vector and a different work's image. The floor to read against. */
  otherCosine: number;
}

export interface TextSpaceComparison {
  /** Works holding BOTH a text row and a deduped image row. One population for every column. */
  n: number;
  queries: number;
  k: number;
  /** P(two works drawn without replacement share a museum), on THESE works. */
  chance: number;
  columns: SpaceColumn[];
  overlaps: OverlapReading[];
  /** Expected overlap if the second space ranked at random: `k / (n - 1)`. */
  overlapChance: number;
  crossModal: CrossModal[];
  /** `k / n` — the share of queries whose own image would land in the top-k by chance. */
  selfChance: number;
  /** Works with text but no image row: no pixels, or bytes shared with a kept work. */
  textOnly: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = (xs: number[], m: number) =>
  xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0;

/**
 * Rows of `into` nearest to row `self` of `from`. Pass the same matrix twice for a within-space kNN.
 *
 * `keys` is the tie-break and it is not decoration. Exact float ties are rare between two real CLIP
 * vectors, but they are certain wherever an encoder failed, a field was blank, or a fixture is
 * degenerate — and `corpus/manifest.jsonl` is written grouped by source, so falling back to row
 * order hands every tied neighbour to the query's own museum and reports the sort order as a
 * finding about cataloguing. `text-space.ts` pins a test against exactly that on the lexical side;
 * the dense side gets the same rule and the same id hash, so the two are broken identically.
 */
export function nearestRows(
  from: Float32Array,
  into: Float32Array,
  n: number,
  self: number,
  k: number,
  keys: Float64Array,
  excludeSelf: boolean,
): number[] {
  const off = self * DIM;
  const scored: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (excludeSelf && i === self) continue;
    let s = 0;
    const o = i * DIM;
    for (let j = 0; j < DIM; j++) s += (into[o + j] as number) * (from[off + j] as number);
    scored.push([s, i]);
  }
  scored.sort((a, b) => b[0] - a[0] || (keys[a[1]] as number) - (keys[b[1]] as number));
  return scored.slice(0, k).map(([, i]) => i);
}

/**
 * BM25, CLIP-text on two field sets, and CLIP-image — one statistic, one sample, one population.
 *
 * Every column is `sameMuseumShareAtK`: the share of a query's top-k that comes from the QUERY's
 * museum, averaged over queries. NOT the neighbours-against-each-other pair rate, which is a
 * different number and has already been printed under the wrong heading once in this repo.
 *
 * The sample is drawn by stride and never by prefix — `corpus/manifest.jsonl` is written grouped by
 * source, so a prefix would measure one museum and report it as the corpus.
 */
export function textSpaceComparison(k = 12, sampleSize = 1000, join = joinToImages()): TextSpaceComparison {
  const { entries, imageRows, textRows, n, textOnly } = join;
  if (n < k + 2) throw new Error(`only ${n} work(s) hold both text and pixels; ${k} neighbours cannot be drawn`);

  const works = entries.map((e) => e.work);
  const sources = works.map((w) => w.source);
  const counts: Record<string, number> = {};
  for (const s of sources) counts[s] = (counts[s] ?? 0) + 1;
  const chance = Object.values(counts).reduce((acc, c) => acc + (c / n) * ((c - 1) / (n - 1)), 0);

  const queries = evenSample(
    works.map((_, i) => i),
    sampleSize,
  );

  const share = (mine: string, near: number[]) =>
    near.length === 0 ? 0 : near.reduce((a, i) => a + (sources[i] === mine ? 1 : 0), 0) / near.length;

  // Same tie-break rule as the lexical baseline: a hash of the work id, never row order.
  const keys = Float64Array.from(works, (w) => createHash('sha256').update(w.id).digest().readUInt32BE(0));
  const bm25 = buildIndex(works, FIELD_SETS.all);
  const kNN = (rows: Float32Array, q: number) => nearestRows(rows, rows, n, q, k, keys, true);

  const sets = FIELD_SET_NAMES.filter((s) => s in textRows);
  const named: { name: string; near: number[][] }[] = [];
  const push = (name: string, near: number[][]) => named.push({ name, near });

  const bm25Near: number[][] = [];
  for (const q of queries) bm25Near.push(neighbours(bm25, q, k, keys).rows);
  push('BM25 (all fields)', bm25Near);

  for (const s of sets) {
    const rows = textRows[s];
    push(`CLIP-text (${s})`, queries.map((q) => kNN(rows, q)));
  }
  push('CLIP-image', queries.map((q) => kNN(imageRows, q)));

  const columns: SpaceColumn[] = named.map(({ name, near }) => {
    const rates: number[] = [];
    let unretrievable = 0;
    near.forEach((row, i) => {
      if (row.length === 0) {
        unretrievable++;
        return;
      }
      rates.push(share(sources[queries[i] as number] as string, row));
    });
    const m = mean(rates);
    const s = stdev(rates, m);
    return { name, sameMuseum: m, sd: s, t: s > 0 ? (m - chance) / (s / Math.sqrt(rates.length)) : 0, unretrievable };
  });

  const pair = (a: string, b: string): OverlapReading => {
    const A = named.find((x) => x.name === a) as { near: number[][] };
    const B = named.find((x) => x.name === b) as { near: number[][] };
    const shares: number[] = [];
    let disjoint = 0;
    for (let i = 0; i < queries.length; i++) {
      const inB = new Set(B.near[i] as number[]);
      const both = (A.near[i] as number[]).filter((x) => inB.has(x)).length;
      if (both === 0) disjoint++;
      shares.push(both / k);
    }
    const m = mean(shares);
    return { a, b, mean: m, sd: stdev(shares, m), disjoint };
  };

  const overlaps: OverlapReading[] = [];
  if (sets.includes('all')) {
    overlaps.push(pair('CLIP-text (all)', 'BM25 (all fields)'));
    if (sets.includes('object')) overlaps.push(pair('CLIP-text (all)', 'CLIP-text (object)'));
    overlaps.push(pair('CLIP-text (all)', 'CLIP-image'));
  }

  // The one question only this stage can ask: the words and the pixels are in the SAME space, so a
  // work's catalogue entry can be asked to find that work's own photograph among 19,807.
  const crossModal: CrossModal[] = sets.map((s) => {
    const rows = textRows[s];
    let hits = 0;
    const self: number[] = [];
    const other: number[] = [];
    for (const q of queries) {
      const near = nearestRows(rows, imageRows, n, q, k, keys, false);
      if (near.includes(q)) hits++;
      let sc = 0;
      for (let j = 0; j < DIM; j++) sc += (rows[q * DIM + j] as number) * (imageRows[q * DIM + j] as number);
      self.push(sc);
      // One fixed, arbitrary, non-self partner per query — a floor for the cosine, not a ranking.
      const o = (q + Math.floor(n / 2)) % n;
      let oc = 0;
      for (let j = 0; j < DIM; j++) oc += (rows[q * DIM + j] as number) * (imageRows[o * DIM + j] as number);
      other.push(oc);
    }
    return { set: s, selfAtK: hits / queries.length, selfCosine: mean(self), otherCosine: mean(other) };
  });

  return {
    n,
    queries: queries.length,
    k,
    chance,
    columns,
    overlaps,
    overlapChance: k / (n - 1),
    crossModal,
    selfChance: k / n,
    textOnly,
  };
}

/** How close two columns have to be before the report calls them the same result. */
export const COLUMN_BAND = 0.05;

/**
 * The share of works whose own photograph must come back for the cross-modal columns to be read.
 *
 * An absolute band, fixed before the run, and NOT a multiple of chance: chance here is `k/n`, which
 * at k=12 over 19,807 is 0.06%, so any multiple small enough to be a real bar is also small enough
 * to pass a tower that has learned almost nothing, and a large multiple exceeds 1 and can never
 * pass at all. 20% is set against the 54.8% P@10 `artist/tests/clip-text.test.ts` already measures
 * for titles alone: comfortably below the known-good figure, and hundreds of times chance.
 */
export const GATE_SELF_AT_K = 0.2;

/** BM25's measured rate over the full field set, quoted so the verdict has a fixed target. */
export const BM25_ALL_FIELDS = 0.924;

export function textSpaceComparisonText(r: TextSpaceComparison): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const out: string[] = [];
  const col = (name: string) => r.columns.find((c) => c.name === name);
  const textAll = col('CLIP-text (all)');
  const textObj = col('CLIP-text (object)');
  const lexical = col('BM25 (all fields)');
  const image = col('CLIP-image');

  out.push(
    `CLIP's text tower over the catalogue prose of ${r.n.toLocaleString()} works — one population, one sample:`,
    `every column below is the same statistic on the same ${r.queries.toLocaleString()} stride-drawn queries at top-${r.k}.`,
    `${r.textOnly} works have catalogue text but no deduped image row and are outside all of it.`,
    '',
    'SAME-MUSEUM SHARE among a work\'s own nearest neighbours',
  );
  for (const c of r.columns) {
    out.push(`  ${c.name.padEnd(20)} ${pct(c.sameMuseum)}  (sd ${pct(c.sd)}, t ${c.t.toFixed(1)} vs chance)`);
  }
  out.push(
    `  ${'one-hot metadata'.padEnd(20)} ${pct(ONE_HOT_METADATA_KNN)}  \`atlas.ts\`'s ~87 columns, on a different sample`,
    `  ${'chance'.padEnd(20)} ${pct(r.chance)}  two works drawn at random`,
    '',
    `  The CLIP-image row is over the WHOLE corpus at top-${r.k}. It is NOT the published 55.4%, which is`,
    `  over the atlas's 1,500-work stride sample; the whole-corpus figure has always been ~66%. Both`,
    `  are right and they are facts about different pools — do not put them in one sentence.`,
    '',
  );

  out.push('DID THE EMBEDDING ADD ANYTHING OVER A TOKENISER');
  if (textAll && lexical) {
    const gap = textAll.sameMuseum - BM25_ALL_FIELDS;
    out.push(
      `  BM25 over these same fields is the number to beat, and it is ${pct(BM25_ALL_FIELDS)} — not the`,
      `  ${pct(ONE_HOT_METADATA_KNN)} one-hot figure. On this sample BM25 reads ${pct(lexical.sameMuseum)}.`,
    );
    if (Math.abs(gap) <= COLUMN_BAND) {
      out.push(
        `  CLIP-text lands within ${pct(COLUMN_BAND)} of it at ${pct(textAll.sameMuseum)}. On this statistic the embedding`,
        `  has added NOTHING a tokeniser did not already have, and must not be quoted as though it had.`,
      );
    } else if (gap < 0) {
      out.push(
        `  CLIP-text is ${pct(-gap)} LOWER at ${pct(textAll.sameMuseum)}: the tower crosses the museum wall that word`,
        `  overlap could not. That is a real difference between the two, on one sample, and nothing more.`,
      );
    } else {
      out.push(
        `  CLIP-text is ${pct(gap)} HIGHER at ${pct(textAll.sameMuseum)} — MORE museum-bound than word overlap.`,
        `  An encoder that is more boxed in than BM25 has not learned the catalogue, it has learned the houses.`,
      );
    }
  }
  const launder = r.overlaps.find((o) => o.b === 'BM25 (all fields)');
  if (launder) {
    out.push(
      `  Neighbour overlap with BM25: ${pct(launder.mean)} of a query's ${r.k} (chance ${pct(r.overlapChance)}),`,
      `  ${launder.disjoint} of ${r.queries} queries share nothing at all. A rate can agree while the`,
      `  neighbour sets do not — the rate is one number and the neighbourhood is ${r.k}, so read this row`,
      `  before saying the two spaces found the same works.`,
    );
  }
  out.push('');

  out.push('HOW MUCH OF THE WALL IS THE ORG CHART');
  if (textAll && textObj) {
    const d = textAll.sameMuseum - textObj.sameMuseum;
    out.push(
      `  \`all\` includes \`department\`, which stage C measured at ${pct(0.907)} same-museum ON ITS OWN — an`,
      `  administrative field naming the museum's own curatorial divisions, not the object.`,
      `  \`object\` is title + classification + medium: what the museum said about the WORK.`,
      `  Dropping the record fields moves the rate by ${d >= 0 ? '-' : '+'}${pct(Math.abs(d))}, to ${pct(textObj.sameMuseum)}.`,
    );
    if (image) {
      out.push(
        textObj.sameMuseum <= image.sameMuseum + COLUMN_BAND
          ? `  That is level with the picture (${pct(image.sameMuseum)}). The words about the object cross about as`
            + `\n  well as the photograph does, so "the picture crosses a wall the catalogue could not" is`
            + `\n  substantially a statement about \`department\` being counted as catalogue text.`
          : `  The picture still crosses better (${pct(image.sameMuseum)} against ${pct(textObj.sameMuseum)}), so the gap survives`
            + `\n  stripping the record fields and is not only an artefact of counting \`department\`.`,
      );
    }
    const shift = r.overlaps.find((o) => o.b === 'CLIP-text (object)');
    if (shift) {
      out.push(
        `  The two field sets share ${pct(shift.mean)} of a query's neighbours, so this is not a small`,
        `  perturbation of one neighbourhood — it is largely a different set of works.`,
      );
    }
  }
  out.push('');

  out.push('THE ONE THING BM25 CANNOT DO — the words and the pixels are in the same space');
  for (const c of r.crossModal) {
    out.push(
      `  ${`${c.set}: own image in top-${r.k}`.padEnd(28)} ${pct(c.selfAtK)}  against ${pct(r.selfChance)} chance`,
      `  ${`${c.set}: cosine to own image`.padEnd(28)} ${c.selfCosine.toFixed(4)}  against ${c.otherCosine.toFixed(4)} to another work's`,
    );
  }
  const best = r.crossModal.reduce<CrossModal | null>((a, c) => (a && a.selfAtK >= c.selfAtK ? a : c), null);
  if (best) {
    out.push(
      best.selfAtK >= GATE_SELF_AT_K
        ? `  A catalogue entry finds its own photograph out of ${r.n.toLocaleString()} far above chance, so the two towers`
          + `\n  do share a space and the columns above are comparable. This is the gate, not a result.`
        : `  A catalogue entry does NOT reliably find its own photograph. Treat every cross-modal number`
          + `\n  above as NOTHING MEASURED until that is explained.`,
    );
  }
  out.push(
    '',
    'Text is one row per WORK in manifest order; the image matrices are one row per distinct IMAGE in',
    'sha256 order. They do not row-align and were joined by work id through the image loader\'s own',
    'dedupe, so every index above names the same work in every matrix.',
  );
  return out.map((s) => `${s}\n`).join('');
}
