// Asking the corpus a question, in words or with a picture.
//
// This is the first channel in the repo that goes from language into the corpus. Everything before
// it went the other way: `resemblance.ts` takes a finished plate and finds what it looks like, and
// `vocabulary.ts` reads the museums' prose without ever touching a pixel.
//
// ## Why a raw cosine is never printed alone
//
// CLIP's text-image cosines live in a narrow band around 0.2-0.35 — the logit scale is learned and
// then thrown away by the export, so the absolute value carries almost no information. "This work
// scored 0.33" is close to meaningless; "this work scored 0.33 where the mean over all 19,791 for
// this same query is 0.19 and the sd is 0.026" is a claim. So every result carries its z-score and
// its percentile *within that query's own distribution over the whole corpus*, which costs nothing
// because the full scan has already computed every score.
//
// This is the same discipline `artist/envelope.ts` and `artist/resemblance.ts` apply, for the same
// reason: a number whose real range is 0.15-0.40, printed as though it ran 0 to 1, is a lie with
// four decimal places on it.

import { DIM, type CorpusEntry, loadCorpusEmbeddings } from './clip-index.js';
import { embedText } from './clip-text.js';
import { type Source } from './manifest.js';

export interface SearchHit {
  entry: CorpusEntry;
  score: number;
  /** Standard deviations above this query's mean score over the whole corpus. */
  z: number;
  /** Share of the corpus this hit beats, as a percentage. */
  percentile: number;
}

export interface SearchResult {
  query: string;
  /** 'text' when the query was a string, 'image' when it was a file. */
  kind: 'text' | 'image';
  hits: SearchHit[];
  /** How many corpus entries were in scope after any filter. */
  searched: number;
  /** The query's own score distribution over those entries. */
  mean: number;
  sd: number;
  min: number;
  max: number;
  /** Museum share of the top hits, against the museum share of the searched set. */
  crossing: { source: Source; hits: number; share: number; corpusShare: number }[];
  filter: Source | null;
}

/** Scores every in-scope entry, then reports the top `k` against the distribution of all of them. */
export function rank(
  query: Float32Array,
  label: string,
  kind: 'text' | 'image',
  k: number,
  filter: Source | null,
): SearchResult {
  const c = loadCorpusEmbeddings();
  const scope: number[] = [];
  for (let i = 0; i < c.entries.length; i++) {
    if (filter === null || c.entries[i]!.work.source === filter) scope.push(i);
  }
  if (scope.length === 0) throw new Error(`no corpus entries from source ${filter}`);

  const scores = new Float64Array(scope.length);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let n = 0; n < scope.length; n++) {
    const off = scope[n]! * DIM;
    let s = 0;
    for (let j = 0; j < DIM; j++) s += c.rows[off + j]! * query[j]!;
    scores[n] = s;
    sum += s;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const mean = sum / scope.length;
  let varSum = 0;
  for (const s of scores) varSum += (s - mean) * (s - mean);
  const sd = Math.sqrt(varSum / scope.length);

  const order = Array.from({ length: scope.length }, (_, n) => n).sort(
    (a, b) => scores[b]! - scores[a]!,
  );
  const hits: SearchHit[] = order.slice(0, k).map((n, at) => ({
    entry: c.entries[scope[n]!]!,
    score: scores[n]!,
    z: sd === 0 ? 0 : (scores[n]! - mean) / sd,
    percentile: (100 * (scope.length - 1 - at)) / scope.length,
  }));

  // What share of the neighbourhood comes from each museum, against what share the museum holds of
  // the searched set. Metadata neighbours are 93.6% same-museum against a 39.0% chance rate because
  // the catalogues use private vocabularies; the picture is supposed to cross that wall, and this
  // column is where that claim can be checked per query rather than in aggregate.
  const inScope = new Map<Source, number>();
  for (const n of scope) {
    const s = c.entries[n]!.work.source;
    inScope.set(s, (inScope.get(s) ?? 0) + 1);
  }
  const inHits = new Map<Source, number>();
  for (const h of hits) {
    inHits.set(h.entry.work.source, (inHits.get(h.entry.work.source) ?? 0) + 1);
  }
  const crossing = [...inScope.entries()]
    .map(([source, total]) => ({
      source,
      hits: inHits.get(source) ?? 0,
      share: (100 * (inHits.get(source) ?? 0)) / hits.length,
      corpusShare: (100 * total) / scope.length,
    }))
    .sort((a, b) => b.share - a.share);

  return { query: label, kind, hits, searched: scope.length, mean, sd, min, max, crossing, filter };
}

export async function searchByText(
  query: string,
  k = 12,
  filter: Source | null = null,
): Promise<SearchResult> {
  const [vec] = await embedText([query]);
  return rank(vec!, query, 'text', k, filter);
}

/** The image side, for `--image`. Takes an already-embedded vector so this file needs no decoder. */
export function searchByVector(
  vec: Float32Array,
  label: string,
  k = 12,
  filter: Source | null = null,
): SearchResult {
  return rank(vec, label, 'image', k, filter);
}

export function searchText(r: SearchResult): string {
  const out: string[] = [];
  out.push(`${r.kind === 'text' ? 'query' : 'image'}: ${r.query}`);
  out.push(
    `searched ${r.searched} distinct corpus images${r.filter ? ` from ${r.filter}` : ''}; ` +
      `this query's scores over all of them: mean ${r.mean.toFixed(4)} sd ${r.sd.toFixed(4)} ` +
      `min ${r.min.toFixed(4)} max ${r.max.toFixed(4)}`,
  );
  out.push('');
  out.push('  cos      z     pct     id            classification / title');
  for (const h of r.hits) {
    const w = h.entry.work;
    const title = (w.title || '(untitled)').replace(/\s+/g, ' ').slice(0, 52);
    const cls = (w.classification || '?').replace(/\s+/g, ' ').slice(0, 22);
    out.push(
      `  ${h.score.toFixed(4)}  ${h.z.toFixed(2).padStart(5)}  ${h.percentile.toFixed(2).padStart(6)}  ` +
        `${w.id.padEnd(12)}  ${cls} | ${title}`,
    );
  }
  out.push('');
  out.push('museum crossing (share of these hits vs share of the searched set):');
  for (const c of r.crossing) {
    out.push(
      `  ${c.source}  ${c.share.toFixed(1).padStart(5)}% of hits   ${c.corpusShare.toFixed(1).padStart(5)}% of corpus`,
    );
  }
  out.push('');
  out.push(
    'A cosine here is not a probability and not a percentage of anything. Read the z and the',
    'percentile, which are against this query\'s own distribution over the corpus. No corpus image',
    'ever reaches the artist through this command; it is a lookup for a person.',
  );
  return out.join('\n') + '\n';
}
