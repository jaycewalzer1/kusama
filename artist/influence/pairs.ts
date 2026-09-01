// The pair test: does a copy land nearer its source than a stranger does?
//
// This is the only check in the influence layer that can fail honestly. Everything downstream —
// directions, the dial, the sweeps — assumes that the four descriptor layers carry something an
// influence actually travels through. If a copyist holding Rembrandt's composition does not land
// nearer Rembrandt than a random object in the same corpus does, then that layer measures nothing
// for this question, and no amount of sweeping it will make the result mean anything.
//
// So: mine the manifest for works whose own catalogue entry says they derive from a named artist,
// and measure, per layer, how far they sit from that artist's own work versus how far they sit from
// the corpus at large.
//
// ## The estimator, and why it is a median-to-many rather than a distance-to-one
//
// The obvious design is a (derivative, original) pair of two images. It is not available: this
// corpus almost never holds the specific painting a print was made after. What it holds is the
// copyist's print and some other works by the named artist. So the pair distance is
//
//     median over the original artist's own works of  d(derivative, own work)
//
// and the baseline is the same statistic with the artist's works replaced by `BASELINE_SAMPLE`
// random corpus works:
//
//     median over 50 random works of  d(derivative, random work)
//
// Same shape on both sides, so the ratio is not an artefact of one side being a minimum over a
// small set and the other a median over a large one. A minimum would have been the tempting choice
// — "the nearest of the artist's works" reads like "the one that was copied" — and it is exactly
// the choice that would make an artist with 8 works in the corpus beat an artist with 1 for
// reasons having nothing to do with influence.
//
// ## What is excluded, and why each exclusion is load-bearing
//
//   - The original must pass `isNamedPerson`. `"After artist unknown"` otherwise joins to all 324
//     works this corpus files under `artist unknown`, and produces a pair, a distance and a table
//     row, none of which mean anything.
//   - The original's own works exclude anything whose own creator field claims a derivation, so a
//     copy is never used as the source it is being measured against.
//   - The derivative's own image is excluded from the original's set by sha256. Otherwise a work
//     whose creator field names its own maker as the original ("Benedetto Buglioni ... Workshop of
//     Benedetto Buglioni") scores a distance of zero against itself and drags the median.
//   - Both sides must have a descriptor row. A work with no pixels is not evidence either way.

import type { CorpusEmbeddings, CorpusEntry } from '../clip-index.js';
import { LAYERS, type Layer, type Stats, ROW, distance } from './descriptors.js';
import { isNamedPerson, normalizeName, parseCreator, type Relation } from './creators.js';

/** Random works drawn per derivative to form its baseline. The prompt's number, kept as a constant. */
export const BASELINE_SAMPLE = 50;

/** Media words that make a work a print. Used only to split the table, never to filter. */
const PRINTY = /\b(engraving|etching|lithograph|woodcut|mezzotint|aquatint|print|photogravure|drypoint)\b/i;

export interface MinedPair {
  derivative: CorpusEntry;
  relation: Relation;
  /** The normalised name the derivative's creator field claims it derives from. */
  originalName: string;
  /** That artist's own works in this corpus, excluding copies and the derivative itself. */
  originals: CorpusEntry[];
  /** True when the derivative is a print — the "print after a painting" split. */
  isPrint: boolean;
}

export interface Mining {
  pairs: MinedPair[];
  /** Rows whose creator field claims a derivation from somebody, named or not. */
  derivations: number;
  /** Of those, how many named somebody who passes `isNamedPerson`. */
  namedDerivations: number;
  /** Distinct named persons with at least one non-derivative work in the corpus. */
  persons: number;
}

/**
 * Find every work whose catalogue entry says it derives from an artist this corpus also holds.
 *
 * Operates over `entries`, which is one canonical work per distinct image. The ~98 manifest rows
 * that share bytes with another row are represented by their alias, so a derivation recorded only
 * on an alias row is not seen. That is at most 98 rows out of 19,807 and it is a smaller error than
 * counting one image twice under two creators.
 */
export function minePairs(emb: CorpusEmbeddings): Mining {
  const own = new Map<string, CorpusEntry[]>();
  for (const e of emb.entries) {
    const p = parseCreator(e.work.creator);
    // A work that is itself a copy is not evidence of its maker's hand, and must never be used as
    // the source another copy is measured against.
    if (!p.person || p.original) continue;
    if (!isNamedPerson(p.person)) continue;
    const k = normalizeName(p.person);
    const list = own.get(k);
    if (list) list.push(e);
    else own.set(k, [e]);
  }

  const pairs: MinedPair[] = [];
  let derivations = 0;
  let namedDerivations = 0;

  for (const e of emb.entries) {
    const p = parseCreator(e.work.creator);
    if (!p.original) continue;
    derivations++;
    if (!isNamedPerson(p.original)) continue;
    namedDerivations++;
    const originals = (own.get(normalizeName(p.original)) ?? []).filter((o) => o.sha256 !== e.sha256);
    if (!originals.length) continue;
    pairs.push({
      derivative: e,
      relation: p.relation ?? 'after',
      originalName: normalizeName(p.original),
      originals,
      isPrint: PRINTY.test(e.work.medium) || PRINTY.test(e.work.classification),
    });
  }

  return { pairs, derivations, namedDerivations, persons: own.size };
}

/** One pair's measured distances, one number per layer on each side. */
export interface PairMeasurement {
  pair: MinedPair;
  /** Median distance to the original artist's own works, per layer. */
  toOriginal: Record<Layer, number>;
  /** Median distance to `BASELINE_SAMPLE` random works, per layer. */
  toRandom: Record<Layer, number>;
  /** `toOriginal / toRandom`, per layer. Below 1 means the copy sits nearer its source. */
  ratio: Record<Layer, number>;
}

export interface LayerResult {
  layer: Layer;
  /** Median across pairs of the distance to the original artist's own work. */
  pairMedian: number;
  /** Median across pairs of the distance to random works. */
  randomMedian: number;
  ratio: number;
  /** Range of `ratio` across the seeds measured. Equal to `[ratio, ratio]` for a single seed. */
  ratioRange: [number, number];
  /** Pairs where the copy sat nearer its source than its own random baseline. */
  wins: number;
  n: number;
  /** Sign-test z on `wins` against a coin flip: `(wins - n/2) / sqrt(n/4)`. */
  z: number;
  /** True when the sign test does not clear `Z_THRESHOLD` in either direction. */
  measuresNothing: boolean;
  /** Which way the layer pointed, when it pointed anywhere. */
  direction: 'nearer' | 'further' | 'none';
}

/**
 * The null decision is a sign test on `wins`, not a band around the distance ratio.
 *
 * The ratio was the obvious statistic and it turned out not to be a stable one. Re-running the test
 * over five seeds moved `palette` between 0.937 and 0.955, which is across a ±0.05 band around 1.0
 * — so a ±band verdict for that layer was a fact about which fifty random works were drawn, and the
 * report would have said "measures nothing" or not depending on the seed. The count of pairs that
 * sat nearer their source moved by at most two over the same seeds, because it asks a question about
 * each pair separately instead of about a median of medians.
 *
 * So `wins` decides, the ratio is reported alongside with its spread across seeds, and a reader can
 * see both. 2.0 is roughly the 5% two-sided point; it is a threshold, not a p-value, and the report
 * says so.
 */
export const Z_THRESHOLD = 2.0;

export interface PairReport {
  mining: Mining;
  /** The first pass, used for the tightest/loosest listings so they name one seed's ordering. */
  measurements: PairMeasurement[];
  layers: LayerResult[];
  /** Same table restricted to a subset of pairs, for the relation and print splits. */
  splits: { name: string; n: number; layers: LayerResult[] }[];
  /** Splits that existed but were too small to measure. Reported as counts, never as a table. */
  tooSmall: { name: string; n: number }[];
  seeds: number[];
  baselineSample: number;
}

/** The seeds the test runs by default. Five is enough to show the spread without being a study. */
export const DEFAULT_SEEDS = [1, 2, 3, 7, 99];

/**
 * Pairs a split needs before its table is computed at all.
 *
 * 20, and it is deliberately high enough to exclude most of the relations. At n=6 the sign test
 * calls 6/6 significant (z=2.45), so `workshop of` printed a "nearer its source" verdict off six
 * works — a row that reads exactly like the `after` row computed from sixty-six, and which would be
 * quoted as "workshop copies hold the armature" by anybody reading the table rather than the n.
 * Splits below this are reported as counts, with no numbers attached to them.
 */
export const MIN_SPLIT = 20;

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * A small deterministic PRNG, so the baseline sample is a property of the seed and not of the run.
 *
 * mulberry32. Not cryptographic and not required to be — its only job is that two runs of
 * `influence pairs` on the same corpus print the same numbers, so a change in the table is a change
 * in the descriptors and never a change in which 50 works happened to be drawn.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function row(rows: Float32Array, i: number): Float32Array {
  return rows.subarray(i * ROW, (i + 1) * ROW);
}

/** Measure every mined pair against its own random baseline. */
export function measurePairs(mining: Mining, emb: CorpusEmbeddings, stats: Stats, seed = 1): PairMeasurement[] {
  const rand = mulberry32(seed);
  const n = emb.entries.length;
  const out: PairMeasurement[] = [];

  for (const pair of mining.pairs) {
    const d = row(emb.rows, pair.derivative.row);

    // Drawn per pair and never reused, so one unlucky draw cannot bias the whole table. Works
    // sharing the derivative's own bytes are skipped; a self-distance of zero in the baseline would
    // make the layer look worse than it is.
    const sample: CorpusEntry[] = [];
    let guard = 0;
    while (sample.length < BASELINE_SAMPLE && guard++ < BASELINE_SAMPLE * 20) {
      const e = emb.entries[Math.floor(rand() * n)]!;
      if (e.sha256 !== pair.derivative.sha256) sample.push(e);
    }

    const toOriginal = {} as Record<Layer, number>;
    const toRandom = {} as Record<Layer, number>;
    const ratio = {} as Record<Layer, number>;
    for (const layer of LAYERS) {
      toOriginal[layer] = median(pair.originals.map((o) => distance(d, row(emb.rows, o.row), layer, stats)));
      toRandom[layer] = median(sample.map((o) => distance(d, row(emb.rows, o.row), layer, stats)));
      ratio[layer] = toRandom[layer]! === 0 ? NaN : toOriginal[layer]! / toRandom[layer]!;
    }
    out.push({ pair, toOriginal, toRandom, ratio });
  }

  return out;
}

/**
 * Collapse one or more measurement passes into one row per layer.
 *
 * Each pass is the same pairs measured against a differently-seeded random baseline. The reported
 * `wins` and `ratio` are medians across passes; `ratioRange` is their full spread, which is the
 * number that says how much of the verdict is the seed.
 */
export function summarise(passes: PairMeasurement[][]): LayerResult[] {
  const n = passes[0]?.length ?? 0;
  return LAYERS.map((layer) => {
    const pairMedian = median(passes[0]!.map((m) => m.toOriginal[layer]!));
    const ratios = passes.map((ms) => {
      const rm = median(ms.map((m) => m.toRandom[layer]!));
      return { randomMedian: rm, ratio: rm === 0 ? NaN : pairMedian / rm };
    });
    const winCounts = passes.map((ms) => ms.filter((m) => m.toOriginal[layer]! < m.toRandom[layer]!).length);
    const finite = ratios.map((r) => r.ratio).filter(Number.isFinite);
    const ratio = median(finite);
    const wins = Math.round(median(winCounts));
    const z = n ? (wins - n / 2) / Math.sqrt(n / 4) : NaN;
    const measuresNothing = !Number.isFinite(z) || Math.abs(z) < Z_THRESHOLD;
    return {
      layer,
      pairMedian,
      randomMedian: median(ratios.map((r) => r.randomMedian)),
      ratio,
      ratioRange: [Math.min(...finite), Math.max(...finite)] as [number, number],
      wins,
      n,
      z,
      measuresNothing,
      direction: measuresNothing ? 'none' : z > 0 ? 'nearer' : 'further',
    };
  });
}

/** The whole test: mine, measure over every seed, summarise, and split by relation and by print. */
export function runPairTest(emb: CorpusEmbeddings, stats: Stats, seeds: number[] = DEFAULT_SEEDS): PairReport {
  const mining = minePairs(emb);
  const passes = seeds.map((s) => measurePairs(mining, emb, stats, s));

  const splits: PairReport['splits'] = [];
  const tooSmall: PairReport['tooSmall'] = [];
  const add = (name: string, keep: (m: PairMeasurement) => boolean, n: number): void => {
    if (n >= MIN_SPLIT) splits.push({ name, n, layers: summarise(passes.map((ms) => ms.filter(keep))) });
    else if (n > 0) tooSmall.push({ name, n });
  };

  const counts = new Map<Relation, number>();
  for (const p of mining.pairs) counts.set(p.relation, (counts.get(p.relation) ?? 0) + 1);
  for (const [rel, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    add(`relation: ${rel}`, (m) => m.pair.relation === rel, n);
  }
  for (const [name, keep] of [
    ['derivative is a print', true],
    ['derivative is not a print', false],
  ] as const) {
    add(name, (m) => m.pair.isPrint === keep, mining.pairs.filter((p) => p.isPrint === keep).length);
  }

  return { mining, measurements: passes[0]!, layers: summarise(passes), splits, tooSmall, seeds, baselineSample: BASELINE_SAMPLE };
}

/**
 * The ordering used for "tightest" and "loosest": the mean ratio over `on`.
 *
 * `on` should be the layers that actually cleared the sign test, not all four. Averaging the four
 * would rank the pairs mostly on three layers that were just shown to measure nothing, and the
 * resulting "ten tightest pairs" contact sheet would be a picture of noise with captions on it —
 * while looking exactly like evidence.
 */
export function overallRatio(m: PairMeasurement, on: readonly Layer[] = LAYERS): number {
  const rs = on.map((l) => m.ratio[l]!).filter(Number.isFinite);
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
}

/** The layers that cleared the sign test, or all of them when none did. */
export function rankingLayers(r: PairReport): { layers: Layer[]; measured: boolean } {
  const cleared = r.layers.filter((l) => !l.measuresNothing).map((l) => l.layer);
  return cleared.length ? { layers: cleared, measured: true } : { layers: [...LAYERS], measured: false };
}
