// Would a second encoder widen the shelf, and widen it somewhere the first one was not going?
//
// An element's forty-eight works were retrieved by CLIP *text* queries: the position's lineage refs
// and worldview sentences become phrases, the phrases become vectors, and the nearest pictures come
// back. Every one of those works is therefore a work whose appearance CLIP associates with a
// sentence somebody wrote. `second-space.ts` measured how much that costs — only 25.1% of a work's
// top-20 neighbours survive changing the encoder — but it measured it on the corpus at large, not on
// the shelf the artist is actually shown.
//
// **DINOv2 cannot answer the retrieval question directly, and that is the whole design constraint.**
// It has no text tower. There is no "DINOv2 query" for "a sheet that has to be read from across a
// street", so the two encoders cannot be unioned at the point where the text enters. What DINOv2 can
// do is start from a picture. So the expansion is two-stage: CLIP text finds a beachhead, and the
// image-only encoder widens it along visual similarity that no caption mediated.
//
// ## Why there is a control arm, and why the report is worthless without it
//
// "DINOv2 added 90 works the set did not have" is not a finding. Taking the neighbours of 48 seeds
// in ANY space adds works the set did not have; that is what neighbours are. The question is whether
// the second encoder reaches somewhere the first one would not have, so the same expansion is run
// through CLIP image-space from the identical seeds, and the two are compared to each other rather
// than to the seed set.
//
// If the two arms land on largely the same works, the second encoder adds nothing to retrieval and
// this idea should be dropped — which is a real possible outcome and the reason to measure before
// wiring anything. The overlap is scored against the overlap two independent draws of the same sizes
// would produce, because with 19,791 works to choose from, "they only shared 14" means nothing until
// you know that chance is under one.
//
// Report-only. It writes no `.resolved.json`, moves no hash, and nothing in a run reads it.

import { DIM as CLIP_DIM, rowAt } from './clip-index.js';
import { DIM as DINO_DIM } from './dino.js';
import { type Resolved } from './influences.js';
import { dimensionalityOf } from './vocabulary.js';
import { alignSpaces, type AlignedSpaces } from './second-space.js';

/** Neighbours drawn per seed work. Small on purpose: this widens a shelf, it does not rebuild one. */
export const PER_SEED = 3;

export interface ExpandArm {
  name: string;
  dim: number;
  /** sha256 of every work this arm would add. Seeds and duplicates already removed. */
  added: string[];
  /** Mean cosine of the added works to the seed centroid, in CLIP's space. */
  toSeedsInClip: number;
  /** The same distance measured in DINOv2's space. */
  toSeedsInDino: number;
  /** How many of the added works are 2D, by `dimensionalityOf`. */
  twoD: number;
  /** Added works per museum. */
  museums: Record<string, number>;
}

export interface Expansion {
  positionId: string;
  seeds: number;
  /** Seed works that were not found in both matrices, so could not be expanded from. */
  seedsMissing: number;
  perSeed: number;
  arms: ExpandArm[];
  /** Works BOTH arms added. The number the whole report exists to produce. */
  shared: number;
  /** Works both arms would add if each drew its additions from the corpus at random. */
  sharedChance: number;
  /** Works available to be added: everything in both spaces, less the seeds. */
  pool: number;
  corpusTwoDShare: number;
}

function centroid(rows: Float32Array, at: number[], dim: number): Float32Array {
  const c = new Float32Array(dim);
  for (const i of at) {
    const off = i * dim;
    for (let j = 0; j < dim; j++) c[j]! += rows[off + j]!;
  }
  let norm = 0;
  for (const v of c) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < dim; j++) c[j]! /= norm;
  return c;
}

function cosineTo(rows: Float32Array, i: number, q: Float32Array, dim: number): number {
  let s = 0;
  const off = i * dim;
  for (let j = 0; j < dim; j++) s += rows[off + j]! * q[j]!;
  return s;
}

/**
 * The `perSeed` nearest works to each seed that are not themselves seeds, unioned over the seeds.
 *
 * Excluding the seeds before taking the top `perSeed`, rather than after, so that a seed sitting in
 * a tight cluster of other seeds still contributes its full share of new works. Filtering afterwards
 * would silently give the densest part of the shelf the fewest additions, which is the opposite of
 * what an expansion is for.
 */
function expand(rows: Float32Array, n: number, dim: number, seeds: number[], perSeed: number): number[] {
  const isSeed = new Set(seeds);
  const added: number[] = [];
  const seen = new Set<number>();
  for (const s of seeds) {
    const q = rowAt(rows, s, dim);
    const scored: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (isSeed.has(i)) continue;
      scored.push([cosineTo(rows, i, q, dim), i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, i] of scored.slice(0, perSeed)) {
      if (!seen.has(i)) {
        seen.add(i);
        added.push(i);
      }
    }
  }
  return added;
}

export function expansion(
  resolved: Resolved,
  perSeed = PER_SEED,
  spaces: AlignedSpaces = alignSpaces()
): Expansion {
  const { entries, clipRows, dinoRows, n } = spaces;
  const rowOf = new Map(entries.map((e, i) => [e.sha256, i]));

  const seeds: number[] = [];
  let seedsMissing = 0;
  for (const w of resolved.works) {
    const i = rowOf.get(w.sha256);
    if (i === undefined) seedsMissing++;
    else if (!seeds.includes(i)) seeds.push(i);
  }
  if (seeds.length === 0) throw new Error(`none of ${resolved.positionId}'s works are in both spaces`);

  const clipCentroid = centroid(clipRows, seeds, CLIP_DIM);
  const dinoCentroid = centroid(dinoRows, seeds, DINO_DIM);

  const arm = (name: string, dim: number, at: number[]): ExpandArm => {
    const museums: Record<string, number> = {};
    let twoD = 0;
    for (const i of at) {
      const w = entries[i]!.work;
      museums[w.source] = (museums[w.source] ?? 0) + 1;
      if (dimensionalityOf(w) === '2d') twoD++;
    }
    const avg = (f: (i: number) => number) => (at.length ? at.reduce((s, i) => s + f(i), 0) / at.length : 0);
    return {
      name,
      dim,
      added: at.map((i) => entries[i]!.sha256),
      toSeedsInClip: avg((i) => cosineTo(clipRows, i, clipCentroid, CLIP_DIM)),
      toSeedsInDino: avg((i) => cosineTo(dinoRows, i, dinoCentroid, DINO_DIM)),
      twoD,
      museums,
    };
  };

  const clipAt = expand(clipRows, n, CLIP_DIM, seeds, perSeed);
  const dinoAt = expand(dinoRows, n, DINO_DIM, seeds, perSeed);
  const clipArm = arm('CLIP ViT-B/32', CLIP_DIM, clipAt);
  const dinoArm = arm('DINOv2-small', DINO_DIM, dinoAt);

  const inClip = new Set(clipArm.added);
  const shared = dinoArm.added.filter((s) => inClip.has(s)).length;
  const pool = n - seeds.length;

  let corpusTwoD = 0;
  for (const e of entries) if (dimensionalityOf(e.work) === '2d') corpusTwoD++;

  return {
    positionId: resolved.positionId,
    seeds: seeds.length,
    seedsMissing,
    perSeed,
    arms: [clipArm, dinoArm],
    shared,
    // Two independent draws of a and b works from the same pool meet in a*b/pool works on average.
    sharedChance: (clipArm.added.length * dinoArm.added.length) / pool,
    pool,
    corpusTwoDShare: corpusTwoD / entries.length,
  };
}

/**
 * The share of the smaller arm the two must share before they count as reaching the same works.
 *
 * This was first written as a ratio of observed overlap to chance overlap, with a threshold of 3x,
 * and that was wrong — the first real run tripped it at 31x while the two arms shared only 21% of
 * the smaller one, four fifths of each arm being works the other never reached. Over a pool of
 * 19,743 the chance overlap is 0.8 works, so any agreement at all is many times chance, and both
 * arms start from the SAME 48 seeds, which guarantees some. Chance is the useless comparison here,
 * exactly as it is for the neighbour overlap in `second-space.ts`: the reading is the distance
 * from 100%, not the distance from chance.
 *
 * A half is not tuned to the data. "Largely the same works" means most of the smaller arm, and
 * most means more than half; the number is a definition of the English, fixed by what the sentence
 * has to be able to mean. The chance figure is still printed, because a reader is owed it — but it
 * is printed as context and not as the test.
 */
const SAME_SHELF_SHARE = 0.5;

export function expansionText(e: Expansion): string {
  const out: string[] = [];
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const [clip, dino] = e.arms as [ExpandArm, ExpandArm];

  out.push(
    `WOULD A SECOND ENCODER WIDEN ${e.positionId.toUpperCase()}'S SHELF, AND WIDEN IT SOMEWHERE NEW`,
    '',
    `  ${e.seeds} seed works, ${e.perSeed} neighbours drawn from each, over a pool of ${e.pool.toLocaleString()} works.`,
    '  The seeds came from CLIP text queries, so both arms start from the same caption-mediated set.',
    '  DINOv2 has no text tower and could not have produced these seeds; it can only widen them.'
  );
  if (e.seedsMissing > 0) {
    out.push(`  ${e.seedsMissing} seed work(s) are not in both matrices and were not expanded from.`);
  }
  out.push('');

  out.push(`  ${'arm'.padEnd(16)}  added   2D   to seeds (CLIP)   to seeds (DINO)`);
  for (const a of e.arms) {
    out.push(
      `  ${a.name.padEnd(16)}  ${String(a.added.length).padStart(5)}  ${String(a.twoD).padStart(3)}   ` +
        `${a.toSeedsInClip.toFixed(4).padStart(15)}   ${a.toSeedsInDino.toFixed(4).padStart(15)}`
    );
  }
  out.push(
    '',
    '  Each arm searched its OWN space, so its own column is a number its search chose and the',
    "  other column is one it did not. Read the off-diagonal: that is how far an arm's additions",
    '  land when measured by the encoder that had no say in picking them.',
    '  An arm is NOT guaranteed to score higher in its own space here, and on a fixture where the',
    '  two layouts disagree it does not: the search maximised nearness to individual seeds, and',
    '  this column is nearness to their centroid, which is a different quantity.',
    `  ${pct(e.corpusTwoDShare)} of the pool is 2D, for the 2D column to be read against.`,
    ''
  );

  out.push('DO THE TWO ARMS REACH THE SAME WORKS');
  const smaller = Math.min(clip.added.length, dino.added.length);
  const share = e.shared / smaller;
  const ratio = e.sharedChance > 0 ? e.shared / e.sharedChance : Infinity;
  out.push(
    `  ${e.shared} work(s) were added by both, ${pct(share)} of the smaller arm's ${smaller}.`,
    '',
    `  Against chance that is ${ratio.toFixed(0)}x — ${e.sharedChance.toFixed(1)} works is what two independent draws from the`,
    `  ${e.pool.toLocaleString()} would share. That number is NOT the test. Both arms start from the same ${e.seeds} seeds,`,
    '  so some agreement is built in, and over a pool this size any agreement at all is many times',
    `  chance. The test is the distance from 100%: ${pct(1 - share)} of the smaller arm is works the other`,
    '  encoder never reached.'
  );
  if (share >= SAME_SHELF_SHARE) {
    out.push(
      '',
      `  ${pct(share)} is most of the smaller arm, over the ${pct(SAME_SHELF_SHARE)} fixed as what "largely the same"`,
      '  has to mean. The two encoders are largely reaching the same works, so the second one is not',
      '  buying a wider shelf and should not be wired into retrieval on the strength of this.',
      '  NOTHING MEASURED that a single encoder would not have found.'
    );
  } else {
    out.push(
      '',
      `  ${pct(share)} is under the ${pct(SAME_SHELF_SHARE)} fixed as what "largely the same" has to mean, so the arms`,
      '  are NOT reaching the same works. The image-only encoder widens the shelf somewhere the',
      '  caption-mediated one was not going, and the union of the two is a genuinely broader set',
      '  than either.',
      '',
      '  What this does NOT license: calling the added works better, more relevant, or more faithful',
      '  to the position. Nothing here measured relevance. It measured difference, and difference is',
      '  the only thing a second encoder can honestly be used for.'
    );
  }
  out.push('');

  out.push('  added per museum');
  for (const a of e.arms) {
    const m = Object.entries(a.museums)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${v}`)
      .join('  ');
    out.push(`    ${a.name.padEnd(16)} ${m || '(none)'}`);
  }

  return out.map((s) => `${s}\n`).join('');
}
