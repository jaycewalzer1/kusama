// Influence directions: where a group of works sits, relative to the corpus, in each layer.
//
//     direction = mean(group) - mean(corpus)      in z-scored descriptor space
//
// That is the whole arithmetic. Everything else in this file is about not over-reading it.
//
// ## A direction always exists, which is the problem
//
// Subtracting two means never fails. Give it fifteen works chosen at random and it returns a
// vector, with a magnitude and a spread, that looks exactly like a vector computed from fifteen
// works by one hand. So a direction on its own is not evidence that the group has a look — it is
// evidence that the group is not exactly the corpus average, which is true of any fifteen works.
//
// So every direction here carries a `cohesion` z from a permutation test: the group's mean distance
// to its own centroid, against the same statistic for `PERMUTATIONS` random groups of the same
// size. Negative z means tighter than chance, which is what a real house style looks like. A
// direction whose cohesion does not clear the threshold is kept — it is still the honest mean of
// those works — but it is marked, and `influence directions` prints how many were marked.
//
// ## Why the layer verdicts from the pair test are carried in here
//
// Three of the four layers did not separate a copy from its source (docs/influence/pairs.md). A
// `form` direction for Wedgwood is still a real measurement of where Wedgwood's works sit in the
// form descriptor; what it is not is a measurement of Wedgwood's *influence*, because that
// descriptor was just shown not to carry influence through this corpus. Both facts belong in the
// file, so `PAIR_TEST_VERDICT` is written into every direction as `carriesInfluence`.

import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import type { CorpusEmbeddings, CorpusEntry } from '../clip-index.js';
import { DESCRIPTOR_VERSION, DIMS, LAYERS, OFFSETS, ROW, type Layer, type Stats } from './descriptors.js';
import { kindOf, normalizeName, parseCreator, type CreatorKind } from './creators.js';

export const DIRECTIONS = path.join(ROOT, 'corpus', 'directions.v1.json');

/** Works a group needs before it gets a direction at all. */
export const MIN_WORKS = 15;

/** Random same-size groups drawn for the cohesion test. */
export const PERMUTATIONS = 200;

/** Cohesion z below this counts as "tighter than chance". Negative because tighter is smaller. */
export const COHESION_Z = -2.0;

/**
 * Which layers the pair test showed actually carry influence through this corpus.
 *
 * Written down here rather than recomputed, because `influence directions` must not depend on the
 * descriptor cache being re-measured, and because a reader of `directions.v1.json` needs the verdict
 * in the file. Regenerate with `npm run influence -- pairs` and update this if the corpus changes:
 * a test asserts the two agree.
 */
export const PAIR_TEST_VERDICT: Record<Layer, boolean> = {
  armature: false,
  palette: false,
  texture: true,
  form: false,
};

/** The two layers this file reserves and cannot fill: they need text, and text needs a model. */
export const TEXT_LAYERS = ['subject', 'discourse'] as const;
export type TextLayer = (typeof TEXT_LAYERS)[number];

export interface Direction {
  /** Where the numbers came from. `text` directions are always null here — see NEEDS.md. */
  source: 'pixels' | 'text' | 'authored';
  /** `DIMS[layer]` long, in z-scored space. Null when the source cannot fill it. */
  vector: number[] | null;
  /** Euclidean length of `vector`. How far the group sits from the corpus mean. */
  magnitude: number;
  /** The group's own standard deviation along its unit direction. How spread the group is. */
  spread: number;
  /**
   * Fraction of this layer's dimensions the source actually filled. Always 1 for `pixels`, which
   * measures every dimension whether or not the number is interesting. An authored direction is
   * usually far below 1, and the gap is the point: a hand can state a palette in Lab and cannot
   * state a 48-dimensional Gabor bank, so the unfilled dimensions are left at the corpus mean
   * rather than invented. Reading magnitude without reading coverage overstates an authored pack.
   */
  coverage: number;
  /**
   * Permutation-test z on the group's tightness. Negative is tighter than a random same-size group.
   * Null when there is no group to test — an authored pack is one assertion, not a set of works, so
   * it has no tightness and this is null rather than a zero that would read as "average".
   */
  cohesionZ: number | null;
  /** True when `cohesionZ` clears `COHESION_Z`. A false here means "this may be any 15 works". */
  cohesive: boolean;
  /** The pair test's verdict for this layer. False means the layer did not carry influence. */
  carriesInfluence: boolean;
}

export interface GroupDirections {
  /** The normalised creator key. */
  id: string;
  /** One of the raw creator strings this key came from, for a human reading the file. */
  label: string;
  kind: CreatorKind;
  works: number;
  directions: Record<string, Direction | null>;
}

export interface DirectionsFile {
  version: string;
  descriptorVersion: string;
  generated: string;
  corpusRows: number;
  minWorks: number;
  permutations: number;
  /** Repeated here so a reader of this file alone knows which layers were nulls. */
  pairTestVerdict: Record<string, boolean>;
  /** Measured groups. Every direction in here has `source: "pixels"`. */
  groups: GroupDirections[];
  /**
   * Authored packs, kept in their own array rather than mixed into `groups`.
   *
   * Separate because the two are not the same kind of object and a reader scanning `groups` should
   * not have to check `source` on every row to know whether a number came off works or off a person.
   * `works: 0` on every entry here.
   */
  packs: GroupDirections[];
}

/** Every group with at least `min` works that is not itself a copy, keyed by normalised name. */
export function groupWorks(emb: CorpusEmbeddings, min = MIN_WORKS): Map<string, { label: string; entries: CorpusEntry[] }> {
  const all = new Map<string, { label: string; entries: CorpusEntry[] }>();
  for (const e of emb.entries) {
    const p = parseCreator(e.work.creator);
    // A copy is filed under its copyist, but it is not evidence of the copyist's own direction any
    // more than it is evidence of the original's, so derivative works are left out of both.
    if (!p.person || p.original) continue;
    const k = normalizeName(p.person);
    if (!k) continue;
    const g = all.get(k);
    if (g) g.entries.push(e);
    else all.set(k, { label: p.person, entries: [e] });
  }
  // Placeholders are dropped rather than ranked: `artist unknown` is the largest group in the
  // corpus and means only that nobody knew.
  for (const [k, g] of [...all]) {
    if (g.entries.length < min || kindOf(k) === 'unknown') all.delete(k);
  }
  return all;
}

/** z-score one row in place against the corpus stats, so distances weigh every dimension alike. */
function zRow(rows: Float32Array, i: number, stats: Stats, out: Float64Array): void {
  for (let j = 0; j < ROW; j++) out[j] = (rows[i * ROW + j]! - stats.mean[j]!) / stats.std[j]!;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean distance of a set of z-scored rows to their own centroid, within one layer's slice. */
function tightness(z: Float64Array[], indices: number[], from: number, to: number): number {
  const c = new Float64Array(to - from);
  for (const i of indices) for (let j = from; j < to; j++) c[j - from]! += z[i]![j]!;
  for (let j = 0; j < c.length; j++) c[j]! /= indices.length;
  let sum = 0;
  for (const i of indices) {
    let d = 0;
    for (let j = from; j < to; j++) {
      const t = z[i]![j]! - c[j - from]!;
      d += t * t;
    }
    sum += Math.sqrt(d);
  }
  return sum / indices.length;
}

/**
 * Compute every group's per-layer direction, with a cohesion test against random same-size groups.
 *
 * The z-scored matrix is built once and shared: at 19,807 x 371 it is ~59MB as float64, which is
 * worth spending to avoid re-standardising inside a 200-permutation loop.
 */
export function computeDirections(emb: CorpusEmbeddings, stats: Stats, min = MIN_WORKS, seed = 1): DirectionsFile {
  const n = emb.entries.length;
  const z: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = new Float64Array(ROW);
    zRow(emb.rows, i, stats, z[i]!);
  }

  // The corpus mean in z-scored space is zero by construction, up to float error. It is computed
  // rather than assumed so that a future caller passing stats from a subset still gets the right
  // answer, and so the assumption is visible instead of implied.
  const corpusMean = new Float64Array(ROW);
  for (let i = 0; i < n; i++) for (let j = 0; j < ROW; j++) corpusMean[j]! += z[i]![j]!;
  for (let j = 0; j < ROW; j++) corpusMean[j]! /= n;

  const rand = mulberry32(seed);
  const groups = groupWorks(emb, min);
  const out: GroupDirections[] = [];

  // Permutation baselines depend only on group SIZE, so they are computed once per distinct size
  // rather than once per group. Twenty-one groups over nine distinct sizes is less than half the
  // work, and every group of the same size is then compared against the identical baseline.
  const baselines = new Map<number, Record<Layer, { mean: number; sd: number }>>();
  const baselineFor = (size: number): Record<Layer, { mean: number; sd: number }> => {
    const hit = baselines.get(size);
    if (hit) return hit;
    const samples = {} as Record<Layer, number[]>;
    for (const l of LAYERS) samples[l] = [];
    for (let p = 0; p < PERMUTATIONS; p++) {
      const idx: number[] = [];
      for (let k = 0; k < size; k++) idx.push(Math.floor(rand() * n));
      for (const l of LAYERS) samples[l]!.push(tightness(z, idx, OFFSETS[l], OFFSETS[l] + DIMS[l]));
    }
    const b = {} as Record<Layer, { mean: number; sd: number }>;
    for (const l of LAYERS) {
      const xs = samples[l]!;
      const mean = xs.reduce((a, c) => a + c, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, c) => a + (c - mean) ** 2, 0) / xs.length) || 1;
      b[l] = { mean, sd };
    }
    baselines.set(size, b);
    return b;
  };

  for (const [id, g] of [...groups.entries()].sort((a, b) => b[1].entries.length - a[1].entries.length)) {
    const indices = g.entries.map((e) => e.row);
    const base = baselineFor(indices.length);
    const directions: Record<string, Direction | null> = {};

    for (const layer of LAYERS) {
      const from = OFFSETS[layer];
      const to = from + DIMS[layer];
      const vec = new Float64Array(to - from);
      for (const i of indices) for (let j = from; j < to; j++) vec[j - from]! += z[i]![j]!;
      for (let j = 0; j < vec.length; j++) vec[j]! = vec[j]! / indices.length - corpusMean[from + j]!;

      const magnitude = Math.sqrt(vec.reduce((a, c) => a + c * c, 0));
      // Spread is measured along the UNIT direction, so it is a length in the same units as the
      // magnitude and the two can be compared. A group whose spread exceeds its magnitude is
      // scattered further along its own axis than that axis is long.
      let spread = 0;
      if (magnitude > 0) {
        const proj = indices.map((i) => {
          let d = 0;
          for (let j = from; j < to; j++) d += z[i]![j]! * (vec[j - from]! / magnitude);
          return d;
        });
        const m = proj.reduce((a, c) => a + c, 0) / proj.length;
        spread = Math.sqrt(proj.reduce((a, c) => a + (c - m) ** 2, 0) / proj.length);
      }

      const t = tightness(z, indices, from, to);
      const cohesionZ = (t - base[layer].mean) / base[layer].sd;
      directions[layer] = {
        source: 'pixels',
        vector: Array.from(vec, (v) => Number(v.toFixed(6))),
        magnitude: Number(magnitude.toFixed(6)),
        spread: Number(spread.toFixed(6)),
        coverage: 1,
        cohesionZ: Number(cohesionZ.toFixed(3)),
        cohesive: cohesionZ < COHESION_Z,
        carriesInfluence: PAIR_TEST_VERDICT[layer],
      };
    }

    // Reserved, and deliberately empty. Filling these needs a reading of the work rather than a
    // measurement of it, and this layer calls no model. See docs/influence/NEEDS.md.
    for (const l of TEXT_LAYERS) directions[l] = null;

    out.push({ id, label: g.label, kind: kindOf(id), works: indices.length, directions });
  }

  return {
    version: 'v1',
    descriptorVersion: DESCRIPTOR_VERSION,
    generated: new Date().toISOString(),
    corpusRows: n,
    minWorks: min,
    permutations: PERMUTATIONS,
    pairTestVerdict: { ...PAIR_TEST_VERDICT, subject: false, discourse: false },
    groups: out,
    packs: [],
  };
}
