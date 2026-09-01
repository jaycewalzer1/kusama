// Does a sentence cross the museum wall?
//
// The corpus ingest established that the catalogue cannot. Metadata neighbours are **93.6%**
// same-museum against a **39.0%** chance baseline, because the columns each museum fills in are
// characteristic of that museum — AIC alone says `laid` and `wove` about paper, and does so for
// 97.7% and 97.8% of the rows that carry those words. Appearance neighbours are **55.4%**: the
// picture crosses a wall the catalogue could not.
//
// This file asks the third version of that question, which is the one L5 depends on. An influence
// set is retrieved by *text* — a position's lineage refs, the sentences of its worldview, the `why`
// of each commitment — and if a text query were as museum-bound as the catalogue, then "the works
// this artist has looked at" would mostly be a fact about which museum's prose the position happens
// to sound like.
//
// ## The statistic and its baseline
//
// For each query, the top `k` are taken and the share of *pairs* among them from the same museum is
// computed. The unit of analysis is the query, not the pair: pairs inside one query's results are
// not independent of each other, so 3,000 pairs are not 3,000 observations. The mean of the
// per-query rates is compared against the chance that two rows drawn at random from the deduped
// corpus share a museum, which is computed here from the corpus rather than assumed.
//
// No model call. The text tower encodes, the corpus is already encoded, and no artist is involved.

import { loadPosition } from './field.js';
import { loadCorpusEmbeddings, rowAt } from './clip-index.js';
import { embedText } from './clip-text.js';
import { queriesFromPosition } from './influences.js';

export interface CrossingQuery {
  positionId: string;
  source: string;
  text: string;
  k: number;
  /** Share of pairs among the top `k` that come from one museum. */
  rate: number;
}

export interface Crossing {
  /** Share of the deduped corpus from each museum. The baseline is computed from this, not assumed. */
  mix: Record<string, number>;
  corpusRows: number;
  /** P(two rows drawn at random share a museum). */
  chance: number;
  queries: CrossingQuery[];
  mean: number;
  sd: number;
  /** (mean - chance) / standard error. Not a p-value and not presented as one. */
  t: number;
  atOrBelowChance: number;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Pairs among `sources` that come from one museum. The unit the whole statistic is built from. */
export function pairRate(sources: string[]): number {
  let pairs = 0;
  let same = 0;
  for (let a = 0; a < sources.length; a++) {
    for (let b = a + 1; b < sources.length; b++) {
      pairs++;
      if (sources[a] === sources[b]) same++;
    }
  }
  return pairs > 0 ? same / pairs : 0;
}

/**
 * `corpus` and `embed` are injected so this is testable without the 19,791-row matrix and the ONNX
 * text tower — the same reason `lens.ts` takes its embedder as an argument.
 */
export async function crossing(
  positionIds: string[],
  corpus = loadCorpusEmbeddings(),
  embed: (phrases: string[]) => Promise<Float32Array[]> = embedText
): Promise<Crossing> {
  const dim = corpus.rows.length / corpus.entries.length;

  const counts: Record<string, number> = {};
  for (const e of corpus.entries) counts[e.work.source] = (counts[e.work.source] ?? 0) + 1;
  const n = corpus.entries.length;
  const mix: Record<string, number> = {};
  let chance = 0;
  for (const [m, c] of Object.entries(counts)) {
    mix[m] = c / n;
    chance += (c / n) ** 2;
  }

  const queries: CrossingQuery[] = [];
  for (const id of positionIds) {
    const qs = queriesFromPosition(loadPosition(id));
    const vectors = await embed(qs.map((q) => q.text));
    for (let qi = 0; qi < qs.length; qi++) {
      const q = qs[qi] as (typeof qs)[number];
      const scored: [number, number][] = [];
      for (let i = 0; i < n; i++) scored.push([dot(vectors[qi] as Float32Array, rowAt(corpus.rows, i, dim)), i]);
      scored.sort((a, b) => b[0] - a[0]);
      const top = scored.slice(0, q.k).map(([, i]) => corpus.entries[i]!.work.source);
      queries.push({ positionId: id, source: q.source, text: q.text, k: q.k, rate: pairRate(top) });
    }
  }

  const rates = queries.map((q) => q.rate);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((s, r) => s + (r - mean) ** 2, 0) / (rates.length - 1));
  return {
    mix,
    corpusRows: n,
    chance,
    queries,
    mean,
    sd,
    t: (mean - chance) / (sd / Math.sqrt(rates.length)),
    atOrBelowChance: rates.filter((r) => r <= chance).length,
  };
}

/** The two published numbers this result has to be read between. */
const METADATA_KNN = 0.936;
const APPEARANCE_KNN = 0.554;

export function crossingText(c: Crossing): string {
  const out: string[] = [];
  out.push(
    `${c.queries.length} text queries from ${new Set(c.queries.map((q) => q.positionId)).size} positions, top-k each, over ${c.corpusRows.toLocaleString()} deduped works`,
    `  corpus mix: ${Object.entries(c.mix).map(([m, s]) => `${m} ${(100 * s).toFixed(1)}%`).join('  ')}`,
    ''
  );
  out.push(
    `SAME-MUSEUM PAIR RATE among a query's own results: ${(100 * c.mean).toFixed(1)}% (sd ${(100 * c.sd).toFixed(1)})`,
    `  against ${(100 * c.chance).toFixed(1)}% chance, computed from the mix above. t = ${c.t.toFixed(2)} over ${c.queries.length} queries,`,
    `  and ${c.atOrBelowChance} of them are at or below chance outright.`
  );
  out.push('');
  out.push('WHERE THAT SITS BETWEEN THE TWO NUMBERS ALREADY MEASURED');
  out.push(`  metadata neighbours   ${(100 * METADATA_KNN).toFixed(1)}%   the catalogue barely crosses the wall at all`);
  out.push(`  a text query          ${(100 * c.mean).toFixed(1)}%   <- this`);
  out.push(`  appearance neighbours ${(100 * APPEARANCE_KNN).toFixed(1)}%   the picture crosses it`);
  out.push(`  chance                ${(100 * c.chance).toFixed(1)}%`);
  out.push('');
  const by: Record<string, number[]> = {};
  for (const q of c.queries) (by[q.source] ??= []).push(q.rate);
  out.push('BY WHAT PART OF THE POSITION THE QUERY CAME FROM');
  for (const [s, rs] of Object.entries(by)) {
    out.push(`  ${s.padEnd(12)} n ${String(rs.length).padStart(3)}  mean ${(100 * rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(1)}%`);
  }
  out.push('');
  const sorted = [...c.queries].sort((a, b) => b.rate - a.rate);
  out.push('MOST MUSEUM-BOUND');
  for (const q of sorted.slice(0, 3)) out.push(`  ${(100 * q.rate).toFixed(0).padStart(3)}%  ${q.source.padEnd(11)} ${q.positionId.padEnd(20)} ${q.text.slice(0, 44)}`);
  out.push('LEAST');
  for (const q of sorted.slice(-3)) out.push(`  ${(100 * q.rate).toFixed(0).padStart(3)}%  ${q.source.padEnd(11)} ${q.positionId.padEnd(20)} ${q.text.slice(0, 44)}`);
  out.push('');
  out.push('  A text query is museum-bound, and only mildly. It is nearer the picture than the catalogue,');
  out.push('  which is what an influence set needs to be true for it to be a set of works rather than a set');
  out.push("  of one museum's prose style. It is not a null and it is not a clean crossing either.");
  return out.map((s) => `${s}\n`).join('');
}
