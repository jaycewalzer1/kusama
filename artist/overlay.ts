// Putting things that are not corpus works onto the corpus's map, without moving the map.
//
// ## Why the projection is not refitted
//
// The obvious way to show a plate beside the corpus is to append its vector to the 19,791 and run
// UMAP again. That is wrong, and quietly so. UMAP is fit to the data it is given; adding 52 plates
// changes every corpus point's position, so the "before" and "after" maps are not comparable, and a
// plate that appears to sit in a region of textiles may have *created* that region. Worse, it is not
// reproducible: two overlays of two different trajectories would each need their own corpus map, and
// nothing on either page would say so.
//
// So the corpus map is fixed. A new point is placed at the weighted average of the existing 2D
// coordinates of its `k` nearest corpus works in the full 512-d space, weighted by cosine. The map
// is a fact about the corpus; the overlay is a reading of where a plate falls in it.
//
// ## What that placement is and is not
//
// It is an interpolation. It cannot put a point outside the hull of the corpus's own coordinates, so
// a plate that resembles nothing in the corpus does not fly off the edge — it lands in the middle,
// at the centroid of twenty things it is equally unlike. `Placement.meanCosine` is the number that
// distinguishes those two cases and it is reported per point, not hidden.
//
// It is also nearly unweighted in practice, and the module measures that rather than assuming it.
// CLIP image cosines live in a narrow band, so twenty neighbours at 0.72..0.78 produce weights that
// differ by under 10% — `weightSpread` says by how much, and when it is near 1.0 the placement is
// the plain centroid of the twenty and should be read as such.

import { rowAt, type CorpusEmbeddings } from './clip-index.js';

/** How many corpus neighbours a new point is placed from. Matches the corpus atlas's own k. */
export const PLACE_K = 20;

/** Cosine for unit-norm rows, defensive about the norm anyway — a zero row must not return NaN. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-12 ? dot / d : 0;
}

/** The `k` rows most similar to `v`, most similar first. Exact, by insertion — k is small. */
export function topK(v: ArrayLike<number>, rows: ArrayLike<number>[], k: number): { row: number; cosine: number }[] {
  const best: { row: number; cosine: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const c = cosine(v, rows[i] as ArrayLike<number>);
    if (best.length < k) {
      best.push({ row: i, cosine: c });
      best.sort((a, b) => b.cosine - a.cosine);
    } else if (c > (best[k - 1] as { cosine: number }).cosine) {
      best[k - 1] = { row: i, cosine: c };
      best.sort((a, b) => b.cosine - a.cosine);
    }
  }
  return best;
}

export interface Placement {
  x: number;
  y: number;
  /** The corpus rows the placement used, nearest first. */
  neighbours: { row: number; cosine: number }[];
  /** Mean cosine to those neighbours. Low means the point is near nothing and landed in the middle. */
  meanCosine: number;
  /**
   * Largest weight divided by smallest, over the `k` used. 1.0 means every neighbour counted
   * equally and this is their plain centroid — which, in CLIP's narrow cone, is almost the case.
   */
  weightSpread: number;
}

/**
 * Place one new vector on an existing map.
 *
 * Weights are the cosines themselves, per the design. Negative cosines are clamped to zero rather
 * than allowed to pull a point away from a neighbour: a negative weight in a weighted average is
 * not an average, and CLIP cosines are almost never negative anyway, so this is a guard and not a
 * behaviour.
 */
export function placeByNeighbours(
  v: ArrayLike<number>,
  rows: ArrayLike<number>[],
  xy: number[][],
  k = PLACE_K,
): Placement {
  const near = topK(v, rows, Math.min(k, rows.length));
  let wsum = 0;
  let x = 0;
  let y = 0;
  let lo = Infinity;
  let hi = 0;
  let csum = 0;
  for (const n of near) {
    const w = Math.max(0, n.cosine);
    wsum += w;
    csum += n.cosine;
    if (w < lo) lo = w;
    if (w > hi) hi = w;
    const p = xy[n.row] as number[];
    x += w * (p[0] as number);
    y += w * (p[1] as number);
  }
  return {
    x: wsum > 0 ? x / wsum : 0,
    y: wsum > 0 ? y / wsum : 0,
    neighbours: near,
    meanCosine: near.length > 0 ? csum / near.length : 0,
    weightSpread: lo > 0 ? hi / lo : Infinity,
  };
}

export interface Fidelity {
  k: number;
  /** How many placed points were measured. */
  n: number;
  /** Mean share of a point's k nearest corpus works in 512-d that are among its k nearest on the map. */
  preserved: number;
  /** What placing the same points at random among the corpus's coordinates would give. */
  chance: number;
  /** True when this k is larger than the k the placement used. See `placementRecall`. */
  wider: boolean;
}

/**
 * Does a placed point keep the company it keeps in the full space?
 *
 * It was worth expecting this to be circular at `k = PLACE_K` — the point is the weighted centre of
 * those twenty, so surely it lands among them. **It does not, and that is the most useful number
 * this module produces.** UMAP preserves adjacency and not distance, so twenty works that are
 * mutually near in 512 dimensions can be scattered across several regions of the page, and their
 * centroid is then in the empty space between those regions rather than in any of them. See
 * `placementRecall`, which measures exactly that and comes back near zero.
 *
 * So every row here is a real measurement, and all of them are low. Read them against `chance`, and
 * read the whole table as a limit on the page: a plate's position is a summary of where its
 * neighbours are, not a claim that the works around it on screen are the works near it in the
 * space.
 */
export function overlayFidelity(
  vectors: ArrayLike<number>[],
  placements: Placement[],
  rows: ArrayLike<number>[],
  xy: number[][],
  ks: number[],
  placeK = PLACE_K,
): Fidelity[] {
  const n = vectors.length;
  return ks.map((k) => {
    if (n === 0 || rows.length <= k) {
      return { k, n, preserved: 0, chance: 0, wider: k > placeK };
    }
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const inSpace = new Set(topK(vectors[i] as ArrayLike<number>, rows, k).map((t) => t.row));
      const p = placements[i] as Placement;
      // The k nearest corpus points to the placed coordinate, on the page. Euclidean and not
      // cosine: the page is a plane, and proximity in that plane is what a reader reads off it.
      const d: { row: number; d2: number }[] = [];
      for (let j = 0; j < xy.length; j++) {
        const q = xy[j] as number[];
        const d2 = (p.x - (q[0] as number)) ** 2 + (p.y - (q[1] as number)) ** 2;
        if (d.length < k) {
          d.push({ row: j, d2 });
          d.sort((a, b) => a.d2 - b.d2);
        } else if (d2 < (d[k - 1] as { d2: number }).d2) {
          d[k - 1] = { row: j, d2 };
          d.sort((a, b) => a.d2 - b.d2);
        }
      }
      for (const { row } of d) if (inSpace.has(row)) kept++;
    }
    return {
      k,
      n,
      preserved: kept / (n * k),
      chance: k / rows.length,
      wider: k > placeK,
    };
  });
}

/**
 * Of the `k` corpus works a point was placed FROM, how many are among the `k` corpus points nearest
 * the placement on the page?
 *
 * This is the check that decides whether the projection-by-neighbour-average is a faithful
 * operation or only a plausible one, and it is the one measurement here whose answer was a
 * surprise. If the map were metric this would be close to 1 by construction. It is not: the
 * weighted centroid of twenty points scattered across a UMAP lands between them, in a region whose
 * own inhabitants may be nothing like the twenty.
 *
 * A low number does not mean the placement is arbitrary — `Placement.meanCosine` says the point is
 * genuinely near those twenty in the space. It means the *page* cannot show that.
 */
export function placementRecall(placements: Placement[], xy: number[][], k = PLACE_K): number {
  if (placements.length === 0) return 0;
  let kept = 0;
  for (const p of placements) {
    const used = new Set(p.neighbours.map((n) => n.row));
    const d: { row: number; d2: number }[] = [];
    for (let j = 0; j < xy.length; j++) {
      const q = xy[j] as number[];
      const d2 = (p.x - (q[0] as number)) ** 2 + (p.y - (q[1] as number)) ** 2;
      if (d.length < k) {
        d.push({ row: j, d2 });
        d.sort((a, b) => a.d2 - b.d2);
      } else if (d2 < (d[k - 1] as { d2: number }).d2) {
        d[k - 1] = { row: j, d2 };
        d.sort((a, b) => a.d2 - b.d2);
      }
    }
    for (const { row } of d) if (used.has(row)) kept++;
  }
  return kept / (placements.length * k);
}

// --- what the page draws --------------------------------------------------------------------------

export type LandmarkKind = 'influence' | 'extreme' | 'sketch' | 'final';

export interface Landmark {
  kind: LandmarkKind;
  x: number;
  y: number;
  /** Short text drawn on the map for extremes; empty for everything else. */
  label: string;
  /** The hover line. */
  detail: string;
  /** Influence weight, or 1. Drives the drawn radius. */
  weight: number;
  /**
   * Ordering within a path, or null. Always null for today's plates: no run has ever persisted a
   * plate per MAKE step, so there is no sequence to connect. Kept so a run made after the loop is
   * wired can produce a real path without this file changing.
   */
  step: number | null;
}

export interface Overlay {
  /** What is being laid over the corpus, in the reader's words. */
  caption: string;
  landmarks: Landmark[];
  fidelity: Fidelity[];
  /** Mean and range of `Placement.meanCosine` over the placed points, plus `placementRecall`. */
  anchoring: {
    meanCosine: number;
    minCosine: number;
    maxCosine: number;
    weightSpread: number;
    recall: number;
  } | null;
  /** Sentences the footer prints verbatim, including any NOTHING MEASURED. */
  notes: string[];
}

/** The corpus row index of a sha256, or -1. The join every overlay needs and none should redo. */
export function rowOfSha(corpus: CorpusEmbeddings, sha: string): number {
  const e = corpus.entries.find((x) => x.sha256 === sha);
  return e ? e.row : -1;
}

/** Unit-norm rows of a corpus embedding matrix as plain arrays, in entry order. */
export function corpusRows(corpus: CorpusEmbeddings): Float32Array[] {
  return corpus.entries.map((_, i) => rowAt(corpus.rows, i));
}
