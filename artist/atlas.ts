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

import { UMAP } from 'umap-js';
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

/**
 * The other projection: UMAP, which keeps neighbourhoods instead of variance.
 *
 * PCA answers "what is this axis made of". Over 512 CLIP coordinates that answer is `+0.69 clip:92`
 * — a real number about a column nobody named, and one anonymous dimension carrying 64% of the
 * variance is a documented property of CLIP rather than a fact about art. So the argument that made
 * PCA the right choice for named museum fields does not transfer, and the projection that keeps
 * *neighbourhoods* is the one to use where the columns are opaque.
 *
 * Both are kept and both are measured by the same `preservation()`, because "UMAP is the standard
 * choice" is not evidence. Seeded, so two runs of this on the same input give the same picture —
 * an unseeded UMAP is a different map every time, which quietly makes every cluster unciteable.
 */
export function umapProject(rows: Float64Array[], seed = 1, neighbours = 15, minDist = 0.1): number[][] {
  let s = seed >>> 0;
  const random = () => {
    // mulberry32: small, and the point is only that it is the same sequence twice.
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const umap = new UMAP({ nComponents: 2, nNeighbors: Math.min(neighbours, rows.length - 1), minDist, random });
  return umap.fit(rows.map((r) => Array.from(r)));
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

// --- is it the SAME map twice ----------------------------------------------------------------

/**
 * One UMAP fit, identified by everything that could have changed the picture.
 */
export interface StabilityRun {
  seed: number;
  neighbours: number;
  minDist: number;
  /** `preservation()` for this fit, on the same points. */
  preserved: number;
}

export interface StabilityPair {
  a: number;
  b: number;
  /** Mean over points of the share of a point's 2-D top-k that both fits name. Local structure. */
  neighbourAgreement: number;
  /** Spearman correlation of pairwise 2-D distances between the two fits. Global structure. */
  distanceRho: number;
}

export interface Stability {
  n: number;
  k: number;
  /** `k / (n - 1)` — what two independent random layouts would share. */
  chance: number;
  runs: StabilityRun[];
  /** Pairs differing ONLY in seed. */
  seedPairs: StabilityPair[];
  /** Pairs differing in `nNeighbors` or `minDist`. */
  paramPairs: StabilityPair[];
  preservedMean: number;
  preservedSd: number;
}

/** Spearman rho between two equal-length series. Ties averaged, as the definition requires. */
export function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Float64Array(v.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && (order[j + 1] as [number, number])[0] === (order[i] as [number, number])[0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) r[(order[t] as [number, number])[1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const u = (a[i] as number) - ma;
    const v = (b[i] as number) - mb;
    num += u * v;
    da += u * u;
    db += v * v;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Deterministic stride sample of index pairs, for the global-structure correlation. */
function pairSample(n: number, want: number): [number, number][] {
  const total = (n * (n - 1)) / 2;
  const take = Math.min(want, total);
  const stride = total / take;
  const out: [number, number][] = [];
  for (let t = 0; t < take; t++) {
    // Invert the triangular index so the sample is spread over all pairs, not over the first rows.
    let m = Math.floor(t * stride);
    let i = 0;
    let row = n - 1;
    while (m >= row) {
      m -= row;
      row--;
      i++;
    }
    out.push([i, i + 1 + m]);
  }
  return out;
}

/**
 * Run UMAP several times and ask whether it drew the same picture.
 *
 * A single seeded UMAP at library defaults is reproducible, which is not the same as stable: it
 * reproduces one arbitrary answer exactly. The question a reader of the atlas actually has is
 * whether the clusters they are looking at survive a different seed and a different `nNeighbors`,
 * and the honest answer has to be measured, because UMAP will always produce clean-looking islands.
 *
 * Two agreements are reported because they can disagree, and when they do the disagreement IS the
 * finding: `nNeighbors` trades local for global by construction, so a layout can keep almost every
 * neighbourhood while rearranging the whole plane. Local agreement licenses "these works sit
 * together"; only the distance correlation licenses "this cluster is far from that one".
 *
 * Fitted on the points passed in — normally the same stride sample `preservation()` uses. The map on
 * the page is fitted on every work, and a layout fitted on fewer points is not that layout, so this
 * measures the method's seed-sensitivity and not the published picture's.
 */
export function stability(
  rows: Float64Array[],
  k = 20,
  seeds: readonly number[] = [1, 2, 3],
  params: readonly { neighbours: number; minDist: number }[] = [
    { neighbours: 15, minDist: 0.1 },
    { neighbours: 5, minDist: 0.1 },
    { neighbours: 50, minDist: 0.1 },
  ],
  pairs = 50_000,
): Stability {
  const n = rows.length;
  const base = params[0] as { neighbours: number; minDist: number };
  const specs: { seed: number; neighbours: number; minDist: number }[] = [
    ...seeds.map((seed) => ({ seed, neighbours: base.neighbours, minDist: base.minDist })),
    ...params.slice(1).map((p) => ({ seed: seeds[0] as number, ...p })),
  ];

  const fits = specs.map((s) => umapProject(rows, s.seed, s.neighbours, s.minDist));
  const runs: StabilityRun[] = specs.map((s, i) => ({
    ...s,
    preserved: preservation(rows, fits[i] as number[][], k).preserved,
  }));

  const sample = pairSample(n, pairs);
  const dists = fits.map((f) =>
    sample.map(([i, j]) => {
      const a = f[i] as number[];
      const b = f[j] as number[];
      return Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number));
    }),
  );

  const nearest = fits.map((f) =>
    Array.from({ length: n }, (_, i) => {
      const order = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i);
      const p = f[i] as number[];
      const d = (j: number) => {
        const q = f[j] as number[];
        return ((p[0] as number) - (q[0] as number)) ** 2 + ((p[1] as number) - (q[1] as number)) ** 2;
      };
      order.sort((x, y) => d(x) - d(y) || x - y);
      return new Set(order.slice(0, k));
    }),
  );

  const compare = (a: number, b: number): StabilityPair => {
    let kept = 0;
    for (let i = 0; i < n; i++) {
      for (const j of (nearest[a] as Set<number>[])[i] as Set<number>) {
        if (((nearest[b] as Set<number>[])[i] as Set<number>).has(j)) kept++;
      }
    }
    return {
      a,
      b,
      neighbourAgreement: n > 0 ? kept / (n * k) : 0,
      distanceRho: spearman(dists[a] as number[], dists[b] as number[]),
    };
  };

  const seedPairs: StabilityPair[] = [];
  for (let i = 0; i < seeds.length; i++) for (let j = i + 1; j < seeds.length; j++) seedPairs.push(compare(i, j));
  const paramPairs: StabilityPair[] = [];
  for (let j = seeds.length; j < specs.length; j++) paramPairs.push(compare(0, j));

  const ps = runs.map((r) => r.preserved);
  const pm = ps.reduce((s, x) => s + x, 0) / (ps.length || 1);
  return {
    n,
    k,
    chance: n > 1 ? k / (n - 1) : 0,
    runs,
    seedPairs,
    paramPairs,
    preservedMean: pm,
    preservedSd:
      ps.length > 1 ? Math.sqrt(ps.reduce((s, x) => s + (x - pm) ** 2, 0) / (ps.length - 1)) : 0,
  };
}

/** Below this, two seeds have not drawn the same picture and no cluster on it may be named. */
export const STABILITY_BAND = 0.5;

export function stabilityText(s: Stability, specLabel = (r: StabilityRun) => `seed ${r.seed}, nn ${r.neighbours}, minDist ${r.minDist}`): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const out: string[] = [
    `UMAP stability over ${s.n.toLocaleString()} points at k=${s.k}. ${s.runs.length} fits, one input.`,
    '',
    'EACH FIT, AND WHAT IT PRESERVED',
  ];
  for (const r of s.runs) out.push(`  ${specLabel(r).padEnd(34)} preserved ${pct(r.preserved)}  (chance ${pct(s.chance)})`);
  out.push(
    `  spread across fits: mean ${pct(s.preservedMean)}, sd ${pct(s.preservedSd)}`,
    '',
    'SAME PARAMETERS, DIFFERENT SEED — how much of the picture is the random start',
  );
  for (const p of s.seedPairs) {
    out.push(`  fit ${p.a} vs ${p.b}   neighbours shared ${pct(p.neighbourAgreement)}   distance rho ${p.distanceRho.toFixed(3)}`);
  }
  out.push('', 'SAME SEED, DIFFERENT nNeighbors — how much is the parameter');
  for (const p of s.paramPairs) {
    out.push(`  fit ${p.a} vs ${p.b}   neighbours shared ${pct(p.neighbourAgreement)}   distance rho ${p.distanceRho.toFixed(3)}`);
  }
  const seedMin = s.seedPairs.reduce((m, p) => Math.min(m, p.neighbourAgreement), 1);
  const rhoMin = s.seedPairs.reduce((m, p) => Math.min(m, p.distanceRho), 1);
  out.push(
    '',
    'WHAT MAY BE SAID ABOUT THIS MAP',
    seedMin >= STABILITY_BAND
      ? `  Two seeds keep ${pct(seedMin)} of each point's ${s.k} nearest, so "these works sit together" is a`
        + `\n  statement about the data and not about the seed.`
      : `  Two seeds keep only ${pct(seedMin)} of each point's ${s.k} nearest. The clusters on this map are`
        + `\n  substantially an artefact of the random start; NAME NO CLUSTER from it.`,
    rhoMin >= STABILITY_BAND
      ? `  Pairwise distances correlate at rho ${rhoMin.toFixed(3)} across seeds, so relative distance on the plane`
        + `\n  carries some information.`
      : `  Pairwise distances correlate at only rho ${rhoMin.toFixed(3)} across seeds. DISTANCE BETWEEN CLUSTERS ON`
        + `\n  THIS PLOT MEANS NOTHING — this is UMAP's documented behaviour, now measured here rather`
        + `\n  than assumed, and it is the single most over-read property of every plot of this kind.`,
    `  Local and global need not agree: nNeighbors trades one for the other by construction, so a`,
    `  layout can hold every neighbourhood while rearranging the plane.`,
  );
  return out.map((x) => `${x}\n`).join('');
}

export interface Composition {
  /** The recorded field a neighbourhood was checked against. */
  field: string;
  /** Mean fraction of a work's k nearest, in the full space, that carry the work's own value. */
  share: number;
  /** What two independently drawn works would share, over this same sample. */
  chance: number;
}

/**
 * What a neighbourhood in the full space is made of.
 *
 * The loadings say what an *axis* is made of, which only means something when the columns have
 * names. A space of 512 anonymous coordinates has no such answer — "axis 1 is +0.09 clip:37" is
 * true and says nothing — so this asks the question from the other side: take the works a space
 * calls near each other, and count how often they came out of the same museum, or the same culture.
 *
 * Read against `chance`, always. Over this corpus 39% of pairs share a museum before anything is
 * measured, so a 55% share is a mild effect and a 94% share is a space that has largely learnt the
 * catalogue rather than the art. Exact and O(n^2), so it runs on the same sample as `preservation`.
 */
export function composition(
  works: Work[],
  high: Float64Array[],
  fields: { field: string; of: (w: Work) => string }[],
  k = 20,
): Composition[] {
  const n = works.length;
  if (n <= k + 1) return fields.map(({ field }) => ({ field, share: 0, chance: 0 }));

  const sq = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += ((a[i] as number) - (b[i] as number)) ** 2;
    return s;
  };
  const nearest = Array.from({ length: n }, (_, i) => {
    const order = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i);
    order.sort((a, b) => sq(high[i] as Float64Array, high[a] as Float64Array) - sq(high[i] as Float64Array, high[b] as Float64Array) || a - b);
    return order.slice(0, k);
  });

  return fields.map(({ field, of }) => {
    const value = works.map(of);
    let same = 0;
    for (let i = 0; i < n; i++) for (const j of nearest[i] as number[]) if (value[j] === value[i]) same++;
    // Chance is the probability two distinct works drawn from THIS sample agree, not 1/categories:
    // the categories are wildly unequal, and a uniform baseline would flatter every result here.
    const counts = new Map<string, number>();
    for (const v of value) counts.set(v, (counts.get(v) ?? 0) + 1);
    let chance = 0;
    for (const c of counts.values()) chance += (c / n) * ((c - 1) / (n - 1));
    return { field, share: same / (n * k), chance };
  });
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

/** How the two dimensions on the page were arrived at. Recorded, because it changes what a gap means. */
export type Projection = 'pca' | 'umap';

export interface Atlas {
  works: number;
  projection: Projection;
  columns: string[];
  varianceExplained: number[];
  /** Per axis, the columns it is most made of. The reason for choosing PCA over a nicer picture. */
  loadings: { axis: number; column: string; weight: number }[][];
  preservation: Preservation;
  /**
   * Whether the same input drew the same picture twice. Only present for UMAP and only when asked
   * for: it is six more fits. PCA has no seed, so for PCA the question does not arise.
   */
  stability?: Stability;
  /** What the full space calls near, in terms a museum recorded. The answer loadings cannot give. */
  composition: Composition[];
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

/**
 * @param space An already-built high-dimensional space, one row per work in `works`, used in place
 *   of the one this module derives from the manifest. That is how the same layout, the same honesty
 *   measure and the same page get pointed at image embeddings without this file learning what an
 *   embedding is or where the matrix lives.
 */
export function atlas(
  works: Work[],
  sampleSize = 1500,
  k = 20,
  space?: Vectors,
  method: Projection = 'pca',
  withStability = false,
): Atlas {
  const { names, rows } = space ?? vectorise(works);
  if (rows.length !== works.length) {
    throw new Error(`space has ${rows.length} rows for ${works.length} works`);
  }
  const axes = principalAxes(rows, 2);
  const xy = method === 'umap' ? umapProject(rows) : project(rows, axes);
  const index = evenSample(
    works.map((_, i) => i),
    sampleSize,
  );
  return {
    works: works.length,
    projection: method,
    columns: names,
    ...(withStability && method === 'umap'
      ? { stability: stability(index.map((i) => rows[i] as Float64Array), k) }
      : {}),
    // Still computed under UMAP, and still true: it says how much of the spread a *linear* map
    // would have caught, which is the thing UMAP is being used instead of.
    varianceExplained: varianceExplained(rows, axes),
    loadings: loadingsOf(names, axes),
    preservation: preservation(
      index.map((i) => rows[i] as Float64Array),
      index.map((i) => xy[i] as number[]),
      k,
    ),
    composition: composition(
      index.map((i) => works[i] as Work),
      index.map((i) => rows[i] as Float64Array),
      [
        { field: 'same museum', of: (w) => w.source },
        { field: 'same culture', of: (w) => w.culture?.trim().toLowerCase() || '(unrecorded)' },
        { field: 'same kind', of: (w) => classificationsOf(w)[0] as string },
        { field: 'same period', of: periodOf },
      ],
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
