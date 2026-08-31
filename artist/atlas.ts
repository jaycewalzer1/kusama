// A map of the corpus made only from what the museums already wrote down.
//
// No model, no API, no credit. Every number here comes out of the manifest — the source, the date
// band, the classification, the culture, and the pixel dimensions read off the file — so this runs
// on all 20,000 works, including the ones whose pixels have not arrived yet, and it runs offline.
//
// The point is not the picture. The point is that a two-dimensional picture of an 80-dimensional
// space is a lossy claim, and almost every corpus scatter plot ever published makes that claim
// without measuring it. So `preservation()` measures it: of the k works nearest to a given work in
// the full space, how many are still among its k nearest on the map — against the number you would
// get by scattering the same points at random. A layout that does not beat that baseline is
// decoration, and this module is willing to say so.

import { classificationsOf, periodOf } from './selection.js';
import { SOURCES, type Work } from './manifest.js';

/** How many distinct classifications and cultures get their own column before the tail is pooled. */
export const TOP_CATEGORIES = 40;

export interface Vectors {
  /** One name per column, in column order, so a coordinate can always be traced to a fact. */
  names: string[];
  /** `rows[i][j]` — standardised, so no column dominates by unit alone. */
  rows: Float64Array[];
}

/**
 * The most common values of a categorical field, by count then by name.
 *
 * Only the top few get a column. A one-hot over all 6,834 classifications would be a 6,834-column
 * matrix in which almost every entry is zero and almost every column is a single work, and distance
 * in it is not a measure of anything. The tail is pooled into one `other` column, which is honest
 * about being a pool rather than pretending the rare categories were represented.
 */
export function topValues(works: Work[], of: (w: Work) => string[], keep = TOP_CATEGORIES): string[] {
  const count = new Map<string, number>();
  for (const w of works) for (const v of of(w)) count.set(v, (count.get(v) ?? 0) + 1);
  return [...count]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, keep)
    .map(([v]) => v);
}

const culturesOf = (w: Work): string[] => [w.culture?.trim().toLowerCase() || '(unrecorded)'];

/**
 * Every work as a row of numbers, and the name of every column.
 *
 * Four kinds of fact go in, and each is there because it is *recorded* rather than inferred:
 *
 * - **which museum** (3 columns). Not a property of the art, but it is the largest single
 *   confounder in the corpus and hiding it would not make it stop being there. Leaving it in means
 *   a reader can see when a cluster is a genre and when it is just the Met.
 * - **when** (3 columns): the midpoint of the date band in centuries, the log of its width, and a
 *   flag for whether it parsed at all. The flag matters — a tenth of the corpus is undated, and
 *   without it those works would silently pile up at whatever number stands in for "missing".
 * - **what kind of thing** and **whose** (2 x 41 columns), one-hot over the commonest values.
 * - **the shape of the file** (3 columns): log aspect, log area, and a flag for whether the pixels
 *   are here yet. A vertical scroll and a horizontal frieze differ in a way no category records.
 *
 * Columns are standardised to zero mean and unit variance afterwards, because otherwise "century"
 * (spread of ~20) would outweigh eighty one-hot columns (spread of ~0.1) and the map would be a
 * timeline. One consequence is worth stating plainly rather than discovering later: after
 * standardisation this vector is mostly one-hot, so Euclidean distance in it is dominated by
 * *whether two works share a category*. The map that comes out is therefore largely a map of the
 * three museums' cataloguing vocabularies. That is a real thing to look at, and it is not a map of
 * how the works look.
 */
export function vectorise(works: Work[]): Vectors {
  const classes = topValues(works, classificationsOf);
  const cultures = topValues(works, culturesOf);
  const names = [
    ...SOURCES.map((s) => `source:${s}`),
    'when:century',
    'when:log-span',
    'when:dated',
    ...classes.map((c) => `kind:${c}`),
    'kind:(other)',
    ...cultures.map((c) => `culture:${c}`),
    'culture:(other)',
    'file:log-aspect',
    'file:log-area',
    'file:have-pixels',
  ];
  const at = new Map(names.map((n, i) => [n, i]));
  const rows = works.map((w) => {
    const v = new Float64Array(names.length);
    v[at.get(`source:${w.source}`) as number] = 1;

    const dated = w.date_begin !== null && w.date_end !== null;
    if (dated) {
      v[at.get('when:century') as number] = ((w.date_begin as number) + (w.date_end as number)) / 200;
      v[at.get('when:log-span') as number] = Math.log1p(Math.max(0, (w.date_end as number) - (w.date_begin as number)));
      v[at.get('when:dated') as number] = 1;
    }

    for (const c of classificationsOf(w)) v[(at.get(`kind:${c}`) ?? at.get('kind:(other)')) as number] = 1;
    for (const c of culturesOf(w)) v[(at.get(`culture:${c}`) ?? at.get('culture:(other)')) as number] = 1;

    const { width, height } = w.image ?? { width: null, height: null };
    if (width && height) {
      v[at.get('file:log-aspect') as number] = Math.log(width / height);
      v[at.get('file:log-area') as number] = Math.log(width * height);
      v[at.get('file:have-pixels') as number] = 1;
    }
    return v;
  });
  return { names, rows: standardise(rows) };
}

/**
 * Centre every column and divide by its standard deviation, in place.
 *
 * A column that never varies is left at zero rather than divided by zero — that is a column the
 * corpus has no information in, and it should contribute nothing rather than infinity.
 */
export function standardise(rows: Float64Array[]): Float64Array[] {
  if (rows.length === 0) return rows;
  const d = (rows[0] as Float64Array).length;
  for (let j = 0; j < d; j++) {
    let sum = 0;
    for (const r of rows) sum += r[j] as number;
    const mean = sum / rows.length;
    let ss = 0;
    for (const r of rows) ss += ((r[j] as number) - mean) ** 2;
    const sd = Math.sqrt(ss / rows.length);
    for (const r of rows) r[j] = sd > 1e-12 ? ((r[j] as number) - mean) / sd : 0;
  }
  return rows;
}

// --- the projection -------------------------------------------------------------------------------

/**
 * The `k` directions of greatest variance, by power iteration with deflation.
 *
 * Principal components and not t-SNE or UMAP, deliberately. Those two make prettier pictures and
 * both of them invent structure: they optimise a neighbourhood objective, so they will produce
 * crisp islands from noise and the islands look exactly like findings. PCA is a rotation. It cannot
 * add a cluster that is not there, its axes are linear combinations of named columns and so can be
 * *read*, and when it fails to separate anything that failure is itself the true answer.
 *
 * Deterministic: the start vector is a fixed alternating pattern, not a random one.
 */
export function principalAxes(rows: Float64Array[], k = 2, iterations = 200): Float64Array[] {
  if (rows.length === 0) return [];
  const d = (rows[0] as Float64Array).length;
  // The d x d covariance, which is small — the corpus is 20,000 x ~90, so this is 90 x 90.
  const cov: Float64Array[] = Array.from({ length: d }, () => new Float64Array(d));
  for (const r of rows) {
    for (let a = 0; a < d; a++) {
      const ra = r[a] as number;
      if (ra === 0) continue;
      const row = cov[a] as Float64Array;
      for (let b = 0; b < d; b++) row[b] = (row[b] as number) + ra * (r[b] as number);
    }
  }
  for (const row of cov) for (let b = 0; b < d; b++) row[b] = (row[b] as number) / rows.length;

  const axes: Float64Array[] = [];
  for (let n = 0; n < k; n++) {
    let v = new Float64Array(d);
    for (let i = 0; i < d; i++) v[i] = i % 2 === 0 ? 1 : -1;
    for (let it = 0; it < iterations; it++) {
      const next = new Float64Array(d);
      for (let a = 0; a < d; a++) {
        let s = 0;
        const row = cov[a] as Float64Array;
        for (let b = 0; b < d; b++) s += (row[b] as number) * (v[b] as number);
        next[a] = s;
      }
      // Remove the axes already found, every iteration, so rounding cannot let this one drift back
      // into a direction that has already been reported.
      for (const a of axes) {
        let dot = 0;
        for (let i = 0; i < d; i++) dot += (next[i] as number) * (a[i] as number);
        for (let i = 0; i < d; i++) next[i] = (next[i] as number) - dot * (a[i] as number);
      }
      let norm = 0;
      for (let i = 0; i < d; i++) norm += (next[i] as number) ** 2;
      norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let i = 0; i < d; i++) next[i] = (next[i] as number) / norm;
      v = next;
    }
    // Sign is arbitrary in an eigenvector, so fix it: the largest-magnitude entry is positive. Two
    // runs of this on the same data must produce the same picture, not its mirror image.
    let big = 0;
    for (let i = 1; i < d; i++) if (Math.abs(v[i] as number) > Math.abs(v[big] as number)) big = i;
    if ((v[big] as number) < 0) for (let i = 0; i < d; i++) v[i] = -(v[i] as number);
    axes.push(v);
  }
  return axes;
}

export function project(rows: Float64Array[], axes: Float64Array[]): number[][] {
  return rows.map((r) => axes.map((a) => a.reduce((s, ai, i) => s + ai * (r[i] as number), 0)));
}

/** How much of the total variance each axis carries. The honest caption for any PCA scatter plot. */
export function varianceExplained(rows: Float64Array[], axes: Float64Array[]): number[] {
  let total = 0;
  for (const r of rows) for (const x of r) total += x * x;
  if (total === 0) return axes.map(() => 0);
  return project(rows, axes).reduce(
    (acc, p) => acc.map((s, j) => s + (p[j] as number) ** 2),
    axes.map(() => 0),
  ).map((s) => s / total);
}

// --- is the map telling the truth ------------------------------------------------------------------

export interface Preservation {
  k: number;
  /** How many works the measurement actually compared. */
  n: number;
  /** Mean fraction of each work's k nearest that are still among its k nearest on the map. */
  preserved: number;
  /** What scattering the same points at random would score: `k / (n - 1)`. */
  chance: number;
  /** True only when the layout beats chance by a margin worth reporting. */
  informative: boolean;
}

/**
 * Compare neighbourhoods before and after the projection.
 *
 * A score has to be read against `chance`, never alone. With n = 200 and k = 20 a *random* layout
 * preserves about 10% of neighbours, so "10% preserved" is not a weak result, it is no result; and
 * as k approaches n every layout scores near 1 while saying nothing at all. Both numbers are
 * returned together for that reason, and `informative` is false unless the layout is at least twice
 * chance — a threshold this module states rather than hides, so it can be argued with.
 *
 * Exact and O(n^2), so it is run over a sample. The sample must be passed in by the caller, because
 * a function that quietly picks its own subset is a function whose answer cannot be reproduced.
 */
export function preservation(high: Float64Array[], low: number[][], k = 20): Preservation {
  const n = high.length;
  const chance = n > 1 ? k / (n - 1) : 0;
  if (n <= k + 1) return { k, n, preserved: 0, chance, informative: false };

  const nearest = (dist: (a: number, b: number) => number) =>
    Array.from({ length: n }, (_, i) => {
      const order = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i);
      order.sort((a, b) => dist(i, a) - dist(i, b) || a - b);
      return new Set(order.slice(0, k));
    });

  const sq = (a: number[] | Float64Array, b: number[] | Float64Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += ((a[i] as number) - (b[i] as number)) ** 2;
    return s;
  };
  const before = nearest((a, b) => sq(high[a] as Float64Array, high[b] as Float64Array));
  const after = nearest((a, b) => sq(low[a] as number[], low[b] as number[]));

  let kept = 0;
  for (let i = 0; i < n; i++) for (const j of before[i] as Set<number>) if ((after[i] as Set<number>).has(j)) kept++;
  const preserved = kept / (n * k);
  return { k, n, preserved, chance, informative: preserved > chance * 2 };
}

/**
 * A deterministic, evenly-spread subsample. Every `stride`-th work, not the first `size` of them.
 *
 * The manifest is written in selection order, which is grouped by source, so the first 2,000 rows
 * are all Cleveland. A prefix would measure the projection on one museum and report it as the
 * corpus.
 */
export function evenSample<T>(items: T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const stride = items.length / size;
  return Array.from({ length: size }, (_, i) => items[Math.floor(i * stride)] as T);
}

export interface AtlasPoint {
  id: string;
  source: string;
  x: number;
  y: number;
  /** The label a reader will actually colour the plot by. */
  kind: string;
  period: string;
  title: string;
  sha256: string | null;
}

export interface Atlas {
  works: number;
  columns: string[];
  varianceExplained: number[];
  /** Per axis, the columns it is most made of. The reason for choosing PCA over a nicer picture. */
  loadings: { axis: number; column: string; weight: number }[][];
  preservation: Preservation;
  points: AtlasPoint[];
}

/**
 * What each axis is actually made of, largest weight first.
 *
 * This is the whole argument for a linear projection. A t-SNE plot has no answer to "what is the
 * horizontal axis", and the honest answer when it is asked is "nothing". Here the answer is a list
 * of named museum fields, so a cluster can be checked against the reason it exists. The first run
 * reported `source:met +0.42` beside `file:have-pixels -0.42` on the same axis, which said plainly
 * that the strongest structure in the corpus is *which museum a work is in* — and that half of that
 * axis was an artefact of the Met's pixels not having downloaded yet.
 */
export function loadingsOf(names: string[], axes: Float64Array[], top = 8): Atlas['loadings'] {
  return axes.map((a, n) =>
    [...a]
      .map((weight, i) => ({ axis: n + 1, column: names[i] as string, weight }))
      .sort((x, y) => Math.abs(y.weight) - Math.abs(x.weight))
      .slice(0, top),
  );
}

export function atlas(works: Work[], sampleSize = 1500, k = 20): Atlas {
  const { names, rows } = vectorise(works);
  const axes = principalAxes(rows, 2);
  const xy = project(rows, axes);
  const index = evenSample(
    works.map((_, i) => i),
    sampleSize,
  );
  return {
    works: works.length,
    columns: names,
    varianceExplained: varianceExplained(rows, axes),
    loadings: loadingsOf(names, axes),
    preservation: preservation(
      index.map((i) => rows[i] as Float64Array),
      index.map((i) => xy[i] as number[]),
      k,
    ),
    points: works.map((w, i) => ({
      id: w.id,
      source: w.source,
      x: (xy[i] as number[])[0] as number,
      y: (xy[i] as number[])[1] as number,
      kind: classificationsOf(w)[0] as string,
      period: periodOf(w),
      title: w.title,
      sha256: w.image?.sha256 ?? null,
    })),
  };
}
