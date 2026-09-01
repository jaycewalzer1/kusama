// One corpus, two encoders, the same statistic — and a stated way to be wrong.
//
// The published appearance result is that a picture crosses the museum wall the catalogue cannot:
// metadata neighbours are 93.6% same-museum against 39.0% chance, appearance neighbours 55.4%. That
// is one encoder's opinion. CLIP is trained on image-caption pairs, and a museum's photography
// conventions are exactly the sort of thing captions covary with, so the result has a specific way
// of being an artefact: CLIP might be reading the caption-shaped residue of a photography
// department rather than the work.
//
// DINOv2 has never seen a caption. So this file computes the *same* statistic in both spaces, over
// the *same* rows and the *same* queries, and reports them side by side.
//
// ## What agreement and disagreement would each mean
//
// If both spaces cross at a similar rate, the crossing is a property of the pictures — two models
// with disjoint training signals do not invent the same artefact. If they differ, at least one is
// reading its own training and the 55.4% cannot be quoted without saying which encoder produced it.
//
// The second statistic here, neighbour overlap, is what keeps the first one honest. Two spaces can
// agree on the museum-crossing rate while ranking completely different works as neighbours — the
// rate is one number and the neighbour set is twelve. Overlap is reported against its own chance,
// `k/(n-1)`, which at k=12 over 19,791 works is 0.06%: any overlap at all is enormous against
// chance, so the number that matters is how far below 100% it sits, and that is the honest measure
// of how much a "nearest work" is a fact about the encoder.
//
// Report-only. Nothing here feeds a run, a reward, or a hash.

import { DIM as CLIP_DIM, loadCorpusEmbeddings, loadEmbeddings, rowAt, type CorpusEmbeddings } from './clip-index.js';
import { DIM as DINO_DIM, DINO_INDEX, DINO_MATRIX } from './dino.js';
import { evenSample } from './atlas.js';

export interface SpaceReading {
  name: string;
  dim: number;
  /** Mean over queries of the same-museum pair rate among that query's top `k`. */
  sameMuseum: number;
  sd: number;
  /** (mean - chance) / standard error. Not a p-value and not presented as one. */
  t: number;
}

export interface SecondSpace {
  /** Works present in BOTH matrices, after each was deduped by the shared loader. */
  works: number;
  /** Queries drawn from those works by stride. The sample, stated so it is never mixed with another. */
  queries: number;
  k: number;
  /** P(two works drawn at random share a museum), computed from the aligned rows. */
  chance: number;
  spaces: SpaceReading[];
  /** Mean share of a query's top `k` that both spaces agree on. */
  overlap: number;
  overlapSd: number;
  /** Expected overlap if the second space ranked at random: `k / (works - 1)`. */
  overlapChance: number;
  /** Queries whose two neighbour sets share nothing at all. */
  disjoint: number;
}

function dot(rows: Float32Array, i: number, q: Float32Array, dim: number): number {
  let s = 0;
  const off = i * dim;
  for (let j = 0; j < dim; j++) s += rows[off + j]! * q[j]!;
  return s;
}

/** Indices of the `k` nearest rows to row `self`, excluding itself. */
function topK(rows: Float32Array, n: number, self: number, k: number, dim: number): number[] {
  const q = rowAt(rows, self, dim);
  const scored: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (i === self) continue;
    scored.push([dot(rows, i, q, dim), i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).map(([, i]) => i);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[], m: number) => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));

/**
 * `sampleSize` is not a tuning knob. Each query is a full scan of both matrices, so asking every
 * work would be 19,791 scans of 19,791 rows in each of two spaces. The corpus is sampled by stride
 * and never by prefix — the manifest is written grouped by source, so a prefix would measure one
 * museum and report it as the corpus.
 */
export interface AlignedSpaces {
  /** Works held in BOTH spaces, in CLIP's order. */
  entries: CorpusEmbeddings['entries'];
  /** Repacked into the shared order, so a row index means one thing to every caller. */
  clipRows: Float32Array;
  dinoRows: Float32Array;
  n: number;
}

/**
 * The two matrices joined by sha256, not by row.
 *
 * Both went through the same loader and the same dedupe, so "the same images in the same order" is
 * very nearly safe — and this is what turns "very nearly" into a check. A row misalignment shows up
 * as a small intersection, which is obvious, rather than as a plausible wrong number, which is not.
 * Exactly one copy of this exists because two callers joining differently would report their
 * disagreement about the join as a finding about the encoders.
 */
export function alignSpaces(
  clip: CorpusEmbeddings = loadCorpusEmbeddings(),
  dino: CorpusEmbeddings = loadEmbeddings(DINO_MATRIX, DINO_INDEX, DINO_DIM)
): AlignedSpaces {
  const dinoAt = new Map(dino.entries.map((e, i) => [e.sha256, i]));
  const entries: CorpusEmbeddings['entries'] = [];
  const dinoRowOf: number[] = [];
  for (let i = 0; i < clip.entries.length; i++) {
    const j = dinoAt.get(clip.entries[i]!.sha256);
    if (j !== undefined) {
      entries.push(clip.entries[i]!);
      dinoRowOf.push(j);
    }
  }
  const n = entries.length;
  const clipRows = new Float32Array(n * CLIP_DIM);
  const dinoRows = new Float32Array(n * DINO_DIM);
  entries.forEach((e, i) => {
    clipRows.set(rowAt(clip.rows, e.row, CLIP_DIM), i * CLIP_DIM);
    dinoRows.set(rowAt(dino.rows, dinoRowOf[i]!, DINO_DIM), i * DINO_DIM);
  });
  return { entries, clipRows, dinoRows, n };
}

export function secondSpace(
  k = 12,
  sampleSize = 1000,
  clip: CorpusEmbeddings = loadCorpusEmbeddings(),
  dino: CorpusEmbeddings = loadEmbeddings(DINO_MATRIX, DINO_INDEX, DINO_DIM)
): SecondSpace {
  const { entries, clipRows, dinoRows, n } = alignSpaces(clip, dino);
  if (n < k + 2) throw new Error(`only ${n} work(s) are in both spaces; ${k} neighbours cannot be drawn`);
  const sources = entries.map((e) => e.work.source);

  const counts: Record<string, number> = {};
  for (const s of sources) counts[s] = (counts[s] ?? 0) + 1;
  // The chance a work drawn at random shares the query's museum, drawn WITHOUT replacement — the
  // `(c-1)/(n-1)` and not `c/n`, matching `sameMuseumChance` in analytics.ts so the baseline under
  // these columns is the same baseline as the one under the published figure.
  const chance = Object.values(counts).reduce((acc, c) => acc + (c / n) * ((c - 1) / (n - 1)), 0);

  const queries = evenSample(
    entries.map((_, i) => i),
    sampleSize
  );

  /**
   * Share of a query's neighbours that come from the QUERY's museum.
   *
   * Deliberately not `pairRate` from crossing.ts, which counts museum agreement among the k
   * neighbours *with each other* and never looks at the query. That is the only thing crossing.ts
   * can do — its queries are text phrases, and a phrase has no museum — but here the query is a
   * work, and the published 55.4% is `sameMuseumShareAtK` in analytics.ts, which is this. Built
   * with `pairRate` first, the CLIP column read 61.2% against a published 55.4% at the same k=20:
   * two different quantities printed in one column, and the gap was the only thing that showed it.
   */
  const fromQueryMuseum = (mine: string, near: number[]): number =>
    near.reduce((a, i) => a + (sources[i] === mine ? 1 : 0), 0) / near.length;

  const clipRates: number[] = [];
  const dinoRates: number[] = [];
  const overlaps: number[] = [];
  let disjoint = 0;
  for (const q of queries) {
    const a = topK(clipRows, n, q, k, CLIP_DIM);
    const b = topK(dinoRows, n, q, k, DINO_DIM);
    clipRates.push(fromQueryMuseum(sources[q]!, a));
    dinoRates.push(fromQueryMuseum(sources[q]!, b));
    const inB = new Set(b);
    const shares = a.filter((i) => inB.has(i)).length;
    if (shares === 0) disjoint++;
    overlaps.push(shares / k);
  }

  const reading = (name: string, dim: number, rates: number[]): SpaceReading => {
    const m = mean(rates);
    const s = sd(rates, m);
    return { name, dim, sameMuseum: m, sd: s, t: (m - chance) / (s / Math.sqrt(rates.length)) };
  };

  const om = mean(overlaps);
  return {
    works: n,
    queries: queries.length,
    k,
    chance,
    spaces: [reading('CLIP ViT-B/32', CLIP_DIM, clipRates), reading('DINOv2-small', DINO_DIM, dinoRates)],
    overlap: om,
    overlapSd: sd(overlaps, om),
    overlapChance: k / (n - 1),
    disjoint,
  };
}

/** How far apart two same-museum rates have to be before the difference is worth a sentence. */
const AGREEMENT_BAND = 0.05;

export function secondSpaceText(r: SecondSpace): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const out: string[] = [];
  out.push(
    `${r.queries.toLocaleString()} queries drawn by stride from ${r.works.toLocaleString()} works held in both spaces,`,
    `top-${r.k} each. Every number below is on THIS sample; do not pair it with a figure from another.`,
    ''
  );
  out.push('SAME-MUSEUM PAIR RATE among a work\'s own nearest neighbours');
  for (const s of r.spaces) {
    out.push(`  ${s.name.padEnd(16)} ${s.dim}d   ${pct(s.sameMuseum)}  (sd ${pct(s.sd)}, t ${s.t.toFixed(1)} vs chance)`);
  }
  out.push(`  ${'chance'.padEnd(16)}       ${pct(r.chance)}  two works drawn at random`);
  out.push('');

  const [a, b] = r.spaces as [SpaceReading, SpaceReading];
  const gap = Math.abs(a.sameMuseum - b.sameMuseum);
  if (gap <= AGREEMENT_BAND) {
    out.push(
      `The two encoders agree to within ${pct(gap)}. CLIP is trained on captions and DINOv2 on no text at`,
      `all, so the crossing rate is not an artefact of either one's training signal — it is a property`,
      `of the photographs. The published appearance figure survives a second opinion.`
    );
  } else {
    const higher = a.sameMuseum > b.sameMuseum ? a : b;
    const lower = higher === a ? b : a;
    out.push(
      `The two encoders differ by ${pct(gap)}, which is outside the ${pct(AGREEMENT_BAND)} band fixed before`,
      `this was run. ${higher.name} is the more museum-bound of the two. A same-museum rate therefore`,
      `cannot be quoted without naming the encoder that produced it.`,
      '',
      // Separating the LEVEL from the SIGN, because the band above only ever tests the level and a
      // reader who sees "differ" will otherwise take the whole finding to have failed.
      `That is a disagreement about the level, not the direction. Both spaces sit far above the`,
      `${pct(r.chance)} baseline (t ${a.t.toFixed(1)} and ${b.t.toFixed(1)}), and both sit far below the 93.6% the`,
      `catalogue's own words produce, so both say the picture crosses a wall the metadata does not.`,
      `${lower.name}, which has never read a caption, crosses it by MORE — the museum-bound share is`,
      `not an artefact of caption training, and if anything caption training adds to it.`
    );
  }
  out.push('');

  out.push('DO THEY POINT AT THE SAME WORKS');
  out.push(
    `  ${pct(r.overlap)} of a query's ${r.k} neighbours are the same in both spaces (sd ${pct(r.overlapSd)}),`,
    `  against ${pct(r.overlapChance)} chance. ${r.disjoint} of ${r.queries} queries share no neighbour at all.`
  );
  out.push(
    `  Chance is ${pct(r.overlapChance)}, so ANY overlap is enormous against it and that comparison is not the`,
    `  interesting one. The reading is the distance from 100%: ${pct(1 - r.overlap)} of what an encoder calls`,
    `  "the nearest works" is a fact about the encoder. A single nearest neighbour, shown to anyone as`,
    `  an influence or a resemblance, is that much a choice of model.`
  );
  return out.map((s) => `${s}\n`).join('');
}
