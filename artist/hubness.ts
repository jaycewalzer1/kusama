// Hubness and the modality gap — the two standard pathologies of high-dimensional retrieval, on a
// task where the right answer is actually known.
//
// Everything else the corpus measures about neighbours is unlabelled: nobody has said which works
// *ought* to be near which. This file uses the one exception. A work's catalogue entry and that
// work's photograph are two encodings of the same object, so "does a work's text retrieve that
// work's own image, out of the whole pool" has a ground truth, and a correction that raises it has
// been shown to help rather than merely to change the answer.
//
// ## The two pathologies
//
// **Hubness** (Radovanović, Nanopoulos & Ivanović 2010). In high dimension the k-occurrence N_k(x)
// — how many other points list x among their k nearest — becomes strongly right-skewed. A few
// points become *hubs* that appear in almost everyone's neighbourhood, and a long tail become
// *antihubs* that appear in nobody's and are therefore unretrievable no matter what is asked. This
// is a property of the geometry, not of the data: it is why a plain cosine kNN over 512-d CLIP
// returns the same handful of works over and over. **CSLS** (Conneau et al. 2018) is the standard
// correction and it costs no training: penalise each candidate by how dense its own neighbourhood
// is, so a point that is near everything stops winning by being near everything.
//
// **The modality gap** (Liang et al. 2022). CLIP's text tower and vision tower land on two nearly
// disjoint cones of the same sphere, so *every* text vector is closer to *every* other text vector
// than to any image. Raw cosine still ranks correctly within a modality, but the absolute numbers
// are meaningless across it, and the shared direction — the vector between the two centroids —
// contributes an identical amount to every cross-modal score while carrying no information about
// any particular pair. Subtracting each modality's own mean and renormalising removes exactly that
// component, and nothing else.
//
// ## One pool, and it is stated everywhere
//
// CSLS needs the neighbourhood density of every *candidate*, not just of the queries, so it is
// quadratic in the pool where the rest of this subsystem is linear. The pool is therefore a
// stride-drawn subsample and **every number in this report is over that pool** — including chance,
// which is `k / pool` and not `k / 19,807`. Pool size changes the level of every rate here: a work
// finds its own photograph more easily among 4,000 than among 19,807. Never quote a figure from
// this report beside one from `corpus text-space`; they are two populations. `--pool 0` runs the
// whole corpus if the time is available.
//
// Report-only. No model, no API key, no network. Nothing here feeds a run, a reward, or a hash.

import { evenSample } from './atlas.js';
import { DIM } from './clip-text.js';
import { tieKeys } from './fuse.js';
import { joinToImages, type TextImageJoin } from './text-embed.js';

/** How many neighbours CSLS averages over to estimate a point's local density. The paper's value. */
export const CSLS_R = 10;

/** The default pool. Quadratic in this number; 4,000 is ~30s and a 64 MB score matrix. */
export const DEFAULT_POOL = 4000;

/**
 * Rows `pool` selected by stride from a join, repacked so index `i` means the same work everywhere.
 *
 * Stride and never prefix: `corpus/manifest.jsonl` is grouped by source, so a prefix pool would be
 * one museum and every same-museum figure computed on it would be near 100% by construction.
 */
export interface Pool {
  n: number;
  text: Float32Array;
  image: Float32Array;
  keys: Float64Array;
  /** Source museum per row, for the callers that want it. */
  sources: string[];
}

export function drawPool(join: TextImageJoin = joinToImages(), size = DEFAULT_POOL): Pool {
  const all = join.textRows.all;
  if (!all) throw new Error('the `all` text matrix is required');
  const rows = size > 0 && size < join.n ? evenSample(
    Array.from({ length: join.n }, (_, i) => i),
    size,
  ) : Array.from({ length: join.n }, (_, i) => i);
  const n = rows.length;
  const text = new Float32Array(n * DIM);
  const image = new Float32Array(n * DIM);
  rows.forEach((src, i) => {
    text.set(all.subarray(src * DIM, (src + 1) * DIM), i * DIM);
    image.set(join.imageRows.subarray(src * DIM, (src + 1) * DIM), i * DIM);
  });
  const works = rows.map((r) => (join.entries[r] as TextImageJoin['entries'][number]).work);
  return { n, text, image, keys: tieKeys(works), sources: works.map((w) => w.source) };
}

/** Full `n x n` score matrix, `S[q * n + c] = cos(from[q], into[c])`. Vectors are already unit. */
export function scoreMatrix(from: Float32Array, into: Float32Array, n: number): Float32Array {
  const s = new Float32Array(n * n);
  for (let q = 0; q < n; q++) {
    const qo = q * n;
    const fo = q * DIM;
    for (let c = 0; c < n; c++) {
      const co = c * DIM;
      let acc = 0;
      for (let j = 0; j < DIM; j++) acc += (from[fo + j] as number) * (into[co + j] as number);
      s[qo + c] = acc;
    }
  }
  return s;
}

/** Indices of the `k` highest scores in one row, ties broken by the id hash and never by column. */
export function topK(s: Float32Array, n: number, q: number, k: number, keys: Float64Array, excludeSelf: boolean): number[] {
  const o = q * n;
  const idx: number[] = [];
  for (let c = 0; c < n; c++) if (!(excludeSelf && c === q)) idx.push(c);
  idx.sort((a, b) => (s[o + b] as number) - (s[o + a] as number) || (keys[a] as number) - (keys[b] as number));
  return idx.slice(0, k);
}

export interface HubnessReading {
  space: string;
  k: number;
  n: number;
  /** Fisher-Pearson skewness of the k-occurrence N_k. 0 is symmetric; above ~1 is a hub problem. */
  skew: number;
  /** The single most-listed point's N_k. Chance is k, since the slots total n*k over n points. */
  maxNk: number;
  /** Share of points listed by nobody. These are unretrievable at k whatever the query. */
  antihubShare: number;
  /** Share of ALL n*k neighbour slots taken by the top 1% of points by N_k. Chance is 1%. */
  top1pctShare: number;
}

/** N_k over a full score matrix. `n * k` slots are handed out; a fair space gives each point k. */
export function kOccurrence(s: Float32Array, n: number, k: number, keys: Float64Array, excludeSelf: boolean): Int32Array {
  const nk = new Int32Array(n);
  for (let q = 0; q < n; q++) for (const c of topK(s, n, q, k, keys, excludeSelf)) nk[c] = (nk[c] as number) + 1;
  return nk;
}

export function hubnessOf(space: string, nk: Int32Array, n: number, k: number): HubnessReading {
  let sum = 0;
  for (const v of nk) sum += v;
  const m = sum / n;
  let m2 = 0;
  let m3 = 0;
  let anti = 0;
  let max = 0;
  for (const v of nk) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
    if (v === 0) anti++;
    if (v > max) max = v;
  }
  m2 /= n;
  m3 /= n;
  const sorted = [...nk].sort((a, b) => b - a);
  const top = Math.max(1, Math.round(n / 100));
  let held = 0;
  for (let i = 0; i < top; i++) held += sorted[i] as number;
  return {
    space,
    k,
    n,
    skew: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0,
    maxNk: max,
    antihubShare: anti / n,
    top1pctShare: sum > 0 ? held / sum : 0,
  };
}

/**
 * Subtract a modality's own mean vector and renormalise.
 *
 * The mean is the direction every vector in that modality shares, and across modalities it is the
 * gap: it adds the same constant to every cross-modal score and so can only compress the range, not
 * order it. Removing it is not a learned transform and has no parameter to tune.
 */
export function centre(rows: Float32Array, n: number): { rows: Float32Array; mean: Float32Array } {
  const mu = new Float32Array(DIM);
  for (let i = 0; i < n; i++) for (let j = 0; j < DIM; j++) mu[j] = (mu[j] as number) + (rows[i * DIM + j] as number);
  for (let j = 0; j < DIM; j++) mu[j] = (mu[j] as number) / n;
  const out = new Float32Array(n * DIM);
  for (let i = 0; i < n; i++) {
    const o = i * DIM;
    let norm = 0;
    for (let j = 0; j < DIM; j++) {
      const v = (rows[o + j] as number) - (mu[j] as number);
      out[o + j] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < DIM; j++) out[o + j] = (out[o + j] as number) / norm;
  }
  return { rows: out, mean: mu };
}

/**
 * CSLS in place of the raw cosine: `2 cos(q, c) - rQ(q) - rC(c)`.
 *
 * `rC(c)` is what does the work — it is the mean similarity of candidate `c` to its own `r` nearest
 * QUERIES, so a candidate sitting in a dense part of the query cloud is charged for it and stops
 * winning every list. `rQ(q)` is constant within a row and cannot change that row's ranking; it is
 * kept because it makes the score symmetric and comparable across rows, which matters as soon as
 * anyone thresholds it.
 */
export function cslsMatrix(s: Float32Array, n: number, r = CSLS_R): Float32Array {
  const rQ = new Float64Array(n);
  const rC = new Float64Array(n);
  const take = Math.min(r, n);
  // A sorted insertion buffer of exactly `take` entries. Full sorting here is 2n sorts of n
  // elements and dominates the whole report; almost every candidate fails the first comparison.
  const best = new Float64Array(take);
  const meanTop = (get: (i: number) => number) => {
    best.fill(-Infinity);
    let floor = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = get(i);
      if (v <= floor) continue;
      let j = take - 1;
      while (j > 0 && (best[j - 1] as number) < v) {
        best[j] = best[j - 1] as number;
        j--;
      }
      best[j] = v;
      floor = best[take - 1] as number;
    }
    let acc = 0;
    for (let i = 0; i < take; i++) acc += Number.isFinite(best[i]) ? (best[i] as number) : 0;
    return take > 0 ? acc / take : 0;
  };
  for (let q = 0; q < n; q++) rQ[q] = meanTop((c) => s[q * n + c] as number);
  for (let c = 0; c < n; c++) rC[c] = meanTop((q) => s[q * n + c] as number);
  const out = new Float32Array(n * n);
  for (let q = 0; q < n; q++) {
    const o = q * n;
    const a = rQ[q] as number;
    for (let c = 0; c < n; c++) out[o + c] = 2 * (s[o + c] as number) - a - (rC[c] as number);
  }
  return out;
}

export interface CrossModalReading {
  /** `raw`, `centred`, `CSLS`, `centred + CSLS`. */
  name: string;
  /** Share of works whose OWN image is in the top-k its own catalogue text retrieves. Labelled. */
  selfAtK: number;
  /** The same at rank 1. */
  selfAt1: number;
  /** Mean rank of the work's own image, 1-based. Lower is better; n is the floor. */
  meanSelfRank: number;
  /** Median rank of the work's own image. */
  medianSelfRank: number;
  hubness: HubnessReading;
}

export interface HubnessReport {
  n: number;
  k: number;
  r: number;
  /** `k / n` on THIS pool. Every rate above must be read against this and not against a global one. */
  selfChance: number;
  /** Mean cosine between a text vector and its OWN image, raw. */
  selfCosine: number;
  /** Mean cosine between a text vector and every other work's image, raw. The floor. */
  otherCosine: number;
  /** Euclidean length of the vector between the two modality centroids. The modality gap itself. */
  modalityGap: number;
  /** Within-space hubness on the same pool: the picture and the prose, each against themselves. */
  withinSpace: HubnessReading[];
  crossModal: CrossModalReading[];
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length === 0 ? 0 : a.length % 2 ? (a[h] as number) : (((a[h - 1] as number) + (a[h] as number)) / 2);
};

/** Rank of the work's own image in its own text's ranking, 1-based. */
function selfRank(s: Float32Array, n: number, q: number, keys: Float64Array): number {
  const o = q * n;
  const mine = s[o + q] as number;
  const myKey = keys[q] as number;
  let rank = 1;
  for (let c = 0; c < n; c++) {
    if (c === q) continue;
    const v = s[o + c] as number;
    if (v > mine || (v === mine && (keys[c] as number) < myKey)) rank++;
  }
  return rank;
}

export function hubnessReport(pool: Pool, k = 12, r = CSLS_R): HubnessReport {
  const { n, text, image, keys } = pool;
  if (n < k + 2) throw new Error(`pool of ${n} cannot yield ${k} neighbours`);

  const raw = scoreMatrix(text, image, n);

  let self = 0;
  let other = 0;
  for (let q = 0; q < n; q++) {
    self += raw[q * n + q] as number;
    other += raw[q * n + ((q + Math.floor(n / 2)) % n)] as number;
  }

  const muT = new Float64Array(DIM);
  const muI = new Float64Array(DIM);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < DIM; j++) {
      muT[j] = (muT[j] as number) + (text[i * DIM + j] as number);
      muI[j] = (muI[j] as number) + (image[i * DIM + j] as number);
    }
  }
  let gap = 0;
  for (let j = 0; j < DIM; j++) gap += ((muT[j] as number) / n - (muI[j] as number) / n) ** 2;
  gap = Math.sqrt(gap);

  const centredText = centre(text, n).rows;
  const centredImage = centre(image, n).rows;
  const centred = scoreMatrix(centredText, centredImage, n);

  const variants: { name: string; s: Float32Array }[] = [
    { name: 'raw', s: raw },
    { name: 'centred', s: centred },
    { name: 'CSLS', s: cslsMatrix(raw, n, r) },
    { name: 'centred + CSLS', s: cslsMatrix(centred, n, r) },
  ];

  const crossModal: CrossModalReading[] = variants.map(({ name, s }) => {
    let hits = 0;
    let top1 = 0;
    const ranks: number[] = [];
    for (let q = 0; q < n; q++) {
      const rank = selfRank(s, n, q, keys);
      ranks.push(rank);
      if (rank <= k) hits++;
      if (rank === 1) top1++;
    }
    return {
      name,
      selfAtK: hits / n,
      selfAt1: top1 / n,
      meanSelfRank: ranks.reduce((a, x) => a + x, 0) / n,
      medianSelfRank: median(ranks),
      hubness: hubnessOf(name, kOccurrence(s, n, k, keys, false), n, k),
    };
  });

  const within: HubnessReading[] = [
    hubnessOf('CLIP-image', kOccurrence(scoreMatrix(image, image, n), n, k, keys, true), n, k),
    hubnessOf('CLIP-text', kOccurrence(scoreMatrix(text, text, n), n, k, keys, true), n, k),
  ];

  return {
    n,
    k,
    r,
    selfChance: k / n,
    selfCosine: self / n,
    otherCosine: other / n,
    modalityGap: gap,
    withinSpace: within,
    crossModal,
  };
}

/** How much a correction has to move `selfAtK` before the report calls it a change and not noise. */
export const CORRECTION_BAND = 0.01;

export function hubnessReportText(r: HubnessReport): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const out: string[] = [];

  out.push(
    `Hubness and the modality gap over a stride-drawn pool of ${r.n.toLocaleString()} works.`,
    `EVERY number below is over that pool. Chance for the labelled task is k/pool = ${pct(r.selfChance)},`,
    `not k/19,807 — a work finds its own photograph more easily in a smaller pool, so nothing here`,
    `may be quoted beside a figure from \`corpus text-space\`. Two pools, two quantities.`,
    '',
    'THE MODALITY GAP',
    `  distance between the text and image centroids   ${r.modalityGap.toFixed(4)}`,
    `  mean cosine, a work's text to its OWN image     ${r.selfCosine.toFixed(4)}`,
    `  mean cosine, that text to another work's image  ${r.otherCosine.toFixed(4)}`,
    `  The two towers sit on separate cones of the sphere: the second number is the floor a raw`,
    `  cross-modal cosine is measured from, and it is not near zero. Subtracting each modality's own`,
    `  mean removes exactly the shared direction, which adds the same constant to every pair.`,
    '',
    `HUBNESS WITHIN EACH SPACE at k=${r.k} — N_k is how many lists a work appears in. A fair space gives each work ${r.k}.`,
  );
  for (const h of r.withinSpace) {
    out.push(
      `  ${h.space.padEnd(16)} skew ${h.skew.toFixed(2)}   biggest hub N_k ${String(h.maxNk).padStart(5)}`
      + `   unretrievable ${pct(h.antihubShare)}   top 1% hold ${pct(h.top1pctShare)} of all slots`,
    );
  }
  out.push(
    `  \`unretrievable\` is the share of works that appear in NOBODY's top-${r.k}: no query in this pool`,
    `  can reach them, whatever it asks. \`top 1% hold\` is against a fair share of 1.0%.`,
    '',
    'THE LABELLED TASK — a work\'s catalogue entry retrieving that work\'s own photograph',
    `  ${'variant'.padEnd(16)} ${'self@' + r.k}   self@1    mean rank   median rank   N_k skew`,
  );
  for (const c of r.crossModal) {
    out.push(
      `  ${c.name.padEnd(16)} ${pct(c.selfAtK).padStart(6)}  ${pct(c.selfAt1).padStart(6)}  `
      + `${c.meanSelfRank.toFixed(1).padStart(9)}  ${String(c.medianSelfRank).padStart(11)}   ${c.hubness.skew.toFixed(2).padStart(6)}`,
    );
  }
  const base = r.crossModal.find((c) => c.name === 'raw');
  const best = r.crossModal.reduce((a, c) => (a.selfAtK >= c.selfAtK ? a : c));
  if (base) {
    out.push(
      '',
      'DID THE CORRECTIONS HELP, ON GROUND TRUTH',
      `  Raw cosine puts the right photograph in the top ${r.k} for ${pct(base.selfAtK)} of works, against`,
      `  ${pct(r.selfChance)} chance on this pool.`,
    );
    for (const c of r.crossModal) {
      if (c.name === 'raw') continue;
      const d = c.selfAtK - base.selfAtK;
      const s = c.hubness.skew - base.hubness.skew;
      out.push(
        `  ${c.name.padEnd(16)} ${d >= 0 ? '+' : '-'}${pct(Math.abs(d))} on the labelled task, `
        + `N_k skew ${s >= 0 ? '+' : ''}${s.toFixed(2)}`
        + (Math.abs(d) <= CORRECTION_BAND ? '   — inside the band; NOTHING MEASURED' : ''),
      );
    }
    out.push(
      best.name === 'raw'
        ? `  No correction beat the raw cosine here. Both are standard and both are cheap, and on this`
          + `\n  pool neither earned its place. Report that, do not apply them anyway.`
        : `  \`${best.name}\` is the best of the four at ${pct(best.selfAtK)}. It is a rank transform with no`
          + `\n  trained parameter, so it cannot have fitted this pool — but it was chosen ON this pool,`
          + `\n  so the margin above is an in-sample margin and should be re-read on another pool size.`,
    );
  }
  return out.map((s) => `${s}\n`).join('');
}
