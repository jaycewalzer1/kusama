// An artist's background, as weights over a corpus.
//
// Jayce's formulation on 2026-08-31 was "implement the artist's unique background as different
// weights over groups of embeddings". This file is the smallest honest version of that: a position
// on disk names six or seven historical works in its `lineage` and states a worldview; those
// strings are put to the corpus through the CLIP text tower; what comes back is a weighted set of
// real museum works. That set is the position's *influences*.
//
// ## The word for what happens here is RETRIEVAL, not reading
//
// Nothing in this file interprets anything. It does not know what "Erased de Kooning Drawing" is.
// It takes the string, embeds it, and returns whatever the encoder puts nearest it — which for a
// named work not in the corpus is, at best, works that photograph like the words. That is a real
// and useful operation and it is not comprehension, and every report this file prints says so.
// The measurements in `statsOf` exist because the difference is checkable: if two positions with
// completely different lineages resolve to the same thirty works, the derivation is not
// distinguishing positions, and the Jaccard column will say that in a number.
//
// ## No model call, ever
//
// Every step is local: the CLIP text tower in `.models/`, the corpus matrix in `corpus/clip.f32`,
// arithmetic. There is no provider, no key, and no quota. That is deliberate — the whole point of
// this being a document rather than a prompt is that it resolves the same way on a laptop with the
// network off.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import type { AestheticProgram } from '../aesthetic/types.js';
import { DIM, type CorpusEntry, loadCorpusEmbeddings } from './clip-index.js';
import { embedText } from './clip-text.js';
import { imagePath, type Source, type Work } from './manifest.js';
import { rng } from './sampling.js';
import { dimensionalityOf } from './vocabulary.js';

export const INFLUENCES_DIR = path.join(ROOT, 'aesthetic', 'influences');
export const DEFAULT_SEED = 20260831;

/** The corpus's own pair band, measured over 1.12M deduped pairs on 2026-08-31. */
export const CORPUS_PAIR_MEDIAN = 0.6428;
export const CORPUS_PAIR_P99 = 0.8374;

export type QuerySource = 'worldview' | 'lineage' | 'commitment' | 'manual';

export interface InfluenceQuery {
  text: string;
  weight: number;
  k: number;
  source: QuerySource;
}

export interface InfluenceLimits {
  maxWorks: number;
  /** No museum may hold more than this share of the resolved set. */
  maxPerMuseum: number;
  /** A hit below this cosine is not evidence of anything and is dropped. */
  minCosineToQuery: number;
}

export interface Influences {
  version: 1;
  positionId: string;
  seed: number;
  queries: InfluenceQuery[];
  /** Hand-chosen works, by sha256. Weight 1.0 and never capped away. */
  picks: string[];
  excludes: string[];
  /** Strings a work should be *away* from. Down-weight, never remove. See `resolve`. */
  avoid: string[];
  limits: InfluenceLimits;
}

export interface ResolvedWork {
  sha256: string;
  id: string;
  weight: number;
  cosine: number;
  /** The query text that put this work in, or 'pick'. */
  via: string;
  museum: Source;
  title: string;
  date: string;
  classification: string;
  medium: string;
  imagePath: string | null;
  /** How much `avoid` cost this work, as a multiplier that was applied to `weight`. */
  avoidPenalty: number;
}

export interface Axis {
  /** Which principal axis, 0-based. */
  index: number;
  /** Share of the set's variance this axis explains. */
  explained: number;
  /** A label made only from what the catalogue columns actually differ on between the two ends. */
  label: string;
  plus: { sha256: string; id: string; title: string; museum: Source; classification: string; step: number; cosine: number }[];
  minus: { sha256: string; id: string; title: string; museum: Source; classification: string; step: number; cosine: number }[];
  /** How many steps each direction ran before the walk stopped. */
  stepsPlus: number;
  stepsMinus: number;
  /** Whether the walk stopped because it left the corpus, or because it hit the step cap. */
  endedPlus: 'hull' | 'cap';
  endedMinus: 'hull' | 'cap';
}

export interface InfluenceStats {
  n: number;
  /** Share of within-set pairs from the same museum, and the same share for a random draw. */
  sameMuseum: number;
  sameMuseumChance: number;
  museums: { source: Source; n: number; share: number }[];
  /** Mean cosine between members. Above ~0.90 means one thing photographed many times. */
  intraMean: number;
  intraMin: number;
  intraMax: number;
  /** Flag: the set is not a set, it is one work. */
  degenerate: boolean;
  entropy: { field: 'classification' | 'medium'; measured: number; chanceMean: number; chanceLo: number; chanceHi: number }[];
  dimensionality: { twoD: number; object: number; unknown: number; twoDShare: number; corpusTwoDShare: number };
}

export interface Resolved {
  version: 1;
  positionId: string;
  seed: number;
  influencesHash: string;
  works: ResolvedWork[];
  centroid: number[];
  /** Mean cosine of members to the centroid. Similarity, not a distance. */
  spread: number;
  /** Mean Euclidean distance of members from the centroid. This is what the walk steps in. */
  radius: number;
  axes: Axis[];
  stats: InfluenceStats;
  /** Queries whose token stream ran past CLIP's 77-token context and were cut. */
  truncated: { text: string; tokens: number }[];
  /** Queries that returned nothing above `minCosineToQuery`. */
  empty: string[];
}

// --- derivation ---------------------------------------------------------------------------------

/**
 * CLIP's context is 77 tokens including BOS and EOS, so a sentence longer than about fifty words is
 * silently cut in half. A position's `worldview` is one long paragraph; feeding it whole would
 * embed its first two clauses and discard the rest without saying so. Splitting on sentence
 * boundaries is deterministic, and `Resolved.truncated` records anything still too long.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 12);
}

/**
 * Queries from a position, with no model anywhere.
 *
 * The weights are the brief's: lineage 1.0, worldview 0.8, commitments 0.6. That ordering is a
 * claim worth stating — a lineage entry NAMES A REAL WORK, so it is the only query here with a
 * chance of retrieving something a person would call correct. A commitment's `why` is prose about
 * this repo's substrate ("Three separate acts of covering") and will retrieve whatever photographs
 * like those words, which is usually nothing in particular. They are included because excluding
 * them would be a judgement, and their low weight is the judgement made explicit instead.
 */
export function queriesFromPosition(p: AestheticProgram): InfluenceQuery[] {
  const qs: InfluenceQuery[] = [];
  for (const l of p.lineage) qs.push({ text: l.ref, weight: 1.0, k: 12, source: 'lineage' });
  for (const s of sentences(p.worldview)) qs.push({ text: s, weight: 0.8, k: 12, source: 'worldview' });
  for (const c of p.commitments) {
    if (c.why) qs.push({ text: c.why, weight: 0.6, k: 8, source: 'commitment' });
  }
  return qs;
}

/**
 * The strings a resolved set should be *away* from: the position's own stated clichés, and the
 * reasons behind its prohibitions.
 *
 * These down-weight rather than exclude, which is the whole design. A prohibition in this repo is a
 * rule about a rendered plate ("no opaque areas"), not a rule about art history, so treating it as
 * a hard filter over museum works would be a category error — it would silently delete Rothko for
 * being solid. Down-weighting says "this is less characteristic of the position" and leaves the
 * work visible with its penalty printed.
 */
export function avoidFromPosition(p: AestheticProgram): string[] {
  return [...p.cliches, ...p.prohibitions.map((x) => x.why).filter((w): w is string => !!w)];
}

export function influencesFromPosition(p: AestheticProgram, seed = DEFAULT_SEED): Influences {
  return {
    version: 1,
    positionId: p.id,
    seed,
    queries: queriesFromPosition(p),
    picks: [],
    excludes: [],
    avoid: avoidFromPosition(p),
    limits: { maxWorks: 48, maxPerMuseum: 0.6, minCosineToQuery: 0.2 },
  };
}

/** The same operation for a lineage element, whose fields are named differently but say the same. */
export function influencesFromElement(
  el: {
    id: string;
    name: string;
    provenance: { culture?: string | null; note?: string | null };
    worldviewFragment: string;
    generativeRules: { why?: string }[];
    prohibitions: { why?: string }[];
    cliches: string[];
  },
  seed = DEFAULT_SEED,
): Influences {
  const qs: InfluenceQuery[] = [{ text: el.name, weight: 1.0, k: 12, source: 'lineage' }];
  if (el.provenance.culture) {
    qs.push({ text: el.provenance.culture, weight: 1.0, k: 12, source: 'lineage' });
  }
  for (const s of sentences(el.provenance.note ?? '')) {
    qs.push({ text: s, weight: 0.8, k: 12, source: 'worldview' });
  }
  for (const s of sentences(el.worldviewFragment)) {
    qs.push({ text: s, weight: 0.8, k: 12, source: 'worldview' });
  }
  for (const r of el.generativeRules) {
    if (r.why) qs.push({ text: r.why, weight: 0.6, k: 8, source: 'commitment' });
  }
  return {
    version: 1,
    positionId: el.id,
    seed,
    queries: qs,
    picks: [],
    excludes: [],
    avoid: [...el.cliches, ...el.prohibitions.map((x) => x.why).filter((w): w is string => !!w)],
    limits: { maxWorks: 48, maxPerMuseum: 0.6, minCosineToQuery: 0.2 },
  };
}

/** Content hash of the input document. Changing a query changes this, and so the resolved file. */
export function influencesHash(inf: Influences): string {
  return createHash('sha256').update(JSON.stringify(inf)).digest('hex').slice(0, 16);
}

// --- resolution ---------------------------------------------------------------------------------

function normalised(v: Float32Array): Float32Array {
  let n = 0;
  for (let j = 0; j < v.length; j++) n += v[j]! * v[j]!;
  n = Math.sqrt(n);
  if (n > 0) for (let j = 0; j < v.length; j++) v[j]! /= n;
  return v;
}

function centroidOf(vectors: Float32Array[]): Float32Array {
  const c = new Float32Array(DIM);
  for (const v of vectors) for (let j = 0; j < DIM; j++) c[j]! += v[j]!;
  return normalised(c);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export async function resolve(inf: Influences): Promise<Resolved> {
  const corpus = loadCorpusEmbeddings();
  const byRow = corpus.entries;
  const bySha = new Map(byRow.map((e, i) => [e.sha256, i]));

  const texts = inf.queries.map((q) => q.text);
  const vecs = texts.length > 0 ? await embedText(texts) : [];
  const avoidVecs = inf.avoid.length > 0 ? await embedText(inf.avoid) : [];

  // Which queries CLIP had to cut. Recorded rather than fixed: shortening them would be an edit to
  // the position's prose, and the position is the artefact under study.
  const { loadTokenizer, CONTEXT_LENGTH } = await import('./clip-tokenizer.js');
  const tok = loadTokenizer();
  const truncated = texts
    .map((t) => ({ text: t, tokens: tok.encode(t).length + 2 }))
    .filter((x) => x.tokens > CONTEXT_LENGTH);

  const excluded = new Set(inf.excludes);
  // Accumulated weight per corpus row, plus the single best (query, cosine) that put it there.
  const score = new Map<number, { weight: number; cosine: number; via: string }>();
  const empty: string[] = [];

  inf.queries.forEach((q, qi) => {
    const v = vecs[qi]!;
    const hits: { row: number; cos: number }[] = [];
    for (let i = 0; i < byRow.length; i++) {
      if (excluded.has(byRow[i]!.sha256)) continue;
      let s = 0;
      const off = i * DIM;
      for (let j = 0; j < DIM; j++) s += corpus.rows[off + j]! * v[j]!;
      hits.push({ row: i, cos: s });
    }
    // Ties broken on sha256 so the result does not depend on manifest order.
    hits.sort((a, b) => b.cos - a.cos || (byRow[a.row]!.sha256 < byRow[b.row]!.sha256 ? -1 : 1));
    const taken = hits.slice(0, q.k).filter((h) => h.cos >= inf.limits.minCosineToQuery);
    if (taken.length === 0) empty.push(q.text);
    for (const h of taken) {
      const add = q.weight * h.cos;
      const cur = score.get(h.row);
      if (!cur) score.set(h.row, { weight: add, cosine: h.cos, via: q.text });
      else {
        cur.weight += add;
        // `via` names the strongest single reason the work is here, not the last one seen.
        if (h.cos > cur.cosine) {
          cur.cosine = h.cos;
          cur.via = q.text;
        }
      }
    }
  });

  for (const sha of inf.picks) {
    const row = bySha.get(sha);
    if (row === undefined) continue;
    score.set(row, { weight: 1.0, cosine: 1.0, via: 'pick' });
  }

  // The avoid penalty. A work's penalty is its highest cosine to any avoid string, mapped through
  // the same floor the queries use, so a work that is merely unrelated to every cliché is untouched.
  const penalty = new Map<number, number>();
  for (const row of score.keys()) {
    let worst = 0;
    for (const av of avoidVecs) {
      const s = dot(corpus.rows.subarray(row * DIM, (row + 1) * DIM), av);
      if (s > worst) worst = s;
    }
    // Linear from 1.0 at the floor down to 0.5 at cosine 0.40, which is far into the tail for text.
    const over = Math.max(0, worst - inf.limits.minCosineToQuery);
    penalty.set(row, Math.max(0.5, 1 - over * 2.5));
  }

  const ranked = [...score.entries()]
    .map(([row, s]) => ({ row, ...s, weight: s.weight * penalty.get(row)!, avoidPenalty: penalty.get(row)! }))
    .sort((a, b) => b.weight - a.weight || (byRow[a.row]!.sha256 < byRow[b.row]!.sha256 ? -1 : 1));

  // Per-museum cap, applied greedily down the ranking. A museum at its cap is skipped rather than
  // truncating the set, so the cap costs the corpus's most-represented museum and nobody else.
  const capPerMuseum = Math.max(1, Math.floor(inf.limits.maxWorks * inf.limits.maxPerMuseum));
  const heldBy = new Map<Source, number>();
  const chosen: typeof ranked = [];
  const pickedShas = new Set(inf.picks);
  for (const r of ranked) {
    if (chosen.length >= inf.limits.maxWorks) break;
    const src = byRow[r.row]!.work.source;
    const held = heldBy.get(src) ?? 0;
    // A hand-pick is never capped away; that is the point of hand-picking it.
    if (held >= capPerMuseum && !pickedShas.has(byRow[r.row]!.sha256)) continue;
    heldBy.set(src, held + 1);
    chosen.push(r);
  }

  const works: ResolvedWork[] = chosen.map((r) => {
    const e = byRow[r.row]!;
    const w = e.work;
    return {
      sha256: e.sha256,
      id: w.id,
      weight: r.weight,
      cosine: r.cosine,
      via: r.via,
      museum: w.source,
      title: w.title,
      date: w.date_display,
      classification: w.classification,
      medium: w.medium,
      imagePath: imagePath(w),
      avoidPenalty: r.avoidPenalty,
    };
  });

  const vectors = chosen.map((r) => corpus.rows.slice(r.row * DIM, (r.row + 1) * DIM));
  const centroid = centroidOf(vectors);
  const spread = vectors.length ? vectors.reduce((s, v) => s + dot(v, centroid), 0) / vectors.length : 0;
  const radius = vectors.length
    ? vectors.reduce((s, v) => {
        let d = 0;
        for (let j = 0; j < DIM; j++) d += (v[j]! - centroid[j]!) ** 2;
        return s + Math.sqrt(d);
      }, 0) / vectors.length
    : 0;

  const axes = vectors.length >= 4 ? extremes(vectors, centroid, radius, new Set(chosen.map((r) => r.row))) : [];
  const stats = statsOf(works, vectors, inf.seed);

  return {
    version: 1,
    positionId: inf.positionId,
    seed: inf.seed,
    influencesHash: influencesHash(inf),
    works,
    centroid: [...centroid],
    spread,
    radius,
    axes,
    stats,
    truncated,
    empty,
  };
}

// --- the extremes operator ----------------------------------------------------------------------

/**
 * Principal axes of the resolved set, by power iteration with deflation.
 *
 * There is no numpy on this machine and no linear algebra dependency in this repo, and neither is
 * worth adding for an n <= 48 problem. The covariance is never formed: `Xt(Xv)` is the same product
 * and is 48x512 rather than 512x512.
 *
 * The mean is computed here rather than taken as an argument. A `Resolved` set's `centroid` is
 * unit-normalised because it is used as a retrieval query, and centring on it instead of on the
 * arithmetic mean is not PCA — the residuals would not sum to zero and the first axis would spend
 * its variance on the offset.
 */
export function principalAxes(vectors: Float32Array[], count: number): { axis: Float32Array; explained: number }[] {
  const n = vectors.length;
  const mean = new Float32Array(DIM);
  for (const v of vectors) for (let j = 0; j < DIM; j++) mean[j]! += v[j]! / n;
  const X = vectors.map((v) => Float32Array.from(v, (x, j) => x - mean[j]!));
  let total = 0;
  for (const r of X) total += dot(r, r);
  if (total === 0) return [];

  const out: { axis: Float32Array; explained: number }[] = [];
  const found: Float32Array[] = [];
  const r = rng(1);
  for (let a = 0; a < count; a++) {
    // The seed vector MUST be unit length. The convergence test below is `1 - |dot(next, v)|` with
    // `next` unit, so a seed with norm 6.5 (which is what 512 uniform draws gives) makes the dot
    // product exceed 1, makes `moved` negative, and breaks the loop after a single power step. Every
    // axis was then one multiplication away from random noise: on `withheld` that printed axis 0 at
    // 10.2% of the set's variance and axis 1 at 22.0%, an ordering principal axes cannot have.
    let v = normalised(Float32Array.from({ length: DIM }, () => r() - 0.5));
    for (let iter = 0; iter < 200; iter++) {
      const next = new Float32Array(DIM);
      for (const row of X) {
        const p = dot(row, v);
        for (let j = 0; j < DIM; j++) next[j]! += p * row[j]!;
      }
      // Deflate AFTER the product, not before it. Deflating only the input lets the product put the
      // already-found component straight back in, so the iterate drifts home to axis 0. That showed
      // up as axis 1 explaining 22.3% of the set's variance while axis 0 explained 10.2% — an
      // ordering that is arithmetically impossible for principal axes, and is what caught it.
      for (const f of found) {
        const p = dot(next, f);
        for (let j = 0; j < DIM; j++) next[j]! -= p * f[j]!;
      }
      let norm = 0;
      for (let j = 0; j < DIM; j++) norm += next[j]! * next[j]!;
      norm = Math.sqrt(norm);
      if (norm === 0) return out;
      for (let j = 0; j < DIM; j++) next[j]! /= norm;
      const moved = 1 - Math.abs(dot(next, v));
      v = next;
      if (moved < 1e-9) break;
    }
    let variance = 0;
    for (const row of X) variance += dot(row, v) ** 2;
    out.push({ axis: v, explained: variance / total });
    found.push(v);
    if (out.length >= n - 1) break;
  }
  return out;
}

const MAX_WALK_STEPS = 12;

/**
 * "Exaggerate some aspects to absolute extremes and minimize others" — as an operation on vectors.
 *
 * Walk out from the set's centroid along each principal axis in steps of half the set's own radius,
 * and at each step ask the corpus what is nearest. The walk stops when the nearest corpus work
 * falls below the corpus's own median pair similarity (0.6428): past that point the walked vector
 * is no longer near anything the corpus contains, so the works it "retrieves" are just the least
 * distant of a uniformly distant field, and reporting them would be reporting noise. A hard step
 * cap guarantees termination even if the corpus somehow follows the axis forever.
 */
function extremes(vectors: Float32Array[], centroid: Float32Array, radius: number, own: Set<number>): Axis[] {
  const corpus = loadCorpusEmbeddings();
  const step = Math.max(radius * 0.5, 1e-3);
  const axes = principalAxes(vectors, 3);

  return axes.map((a, index) => {
    const walk = (sign: 1 | -1): { hits: Axis['plus']; steps: number; ended: 'hull' | 'cap' } => {
      const hits: Axis['plus'] = [];
      const seen = new Set<number>();
      let steps = 0;
      let ended: 'hull' | 'cap' = 'cap';
      for (let s = 1; s <= MAX_WALK_STEPS; s++) {
        const point = new Float32Array(DIM);
        let norm = 0;
        for (let j = 0; j < DIM; j++) {
          point[j] = centroid[j]! + sign * s * step * a.axis[j]!;
          norm += point[j]! * point[j]!;
        }
        norm = Math.sqrt(norm);
        for (let j = 0; j < DIM; j++) point[j]! /= norm;

        let best = -Infinity;
        let bestRows: { row: number; cos: number }[] = [];
        for (let i = 0; i < corpus.entries.length; i++) {
          if (own.has(i) || seen.has(i)) continue;
          let c = 0;
          const off = i * DIM;
          for (let j = 0; j < DIM; j++) c += corpus.rows[off + j]! * point[j]!;
          if (c > best) best = c;
          bestRows.push({ row: i, cos: c });
        }
        if (best < CORPUS_PAIR_MEDIAN) {
          ended = 'hull';
          break;
        }
        steps = s;
        bestRows.sort((x, y) => y.cos - x.cos);
        for (const h of bestRows.slice(0, 3)) {
          seen.add(h.row);
          const w = corpus.entries[h.row]!.work;
          hits.push({
            sha256: corpus.entries[h.row]!.sha256,
            id: w.id,
            title: w.title,
            museum: w.source,
            classification: w.classification,
            step: sign * s,
            cosine: h.cos,
          });
        }
      }
      return { hits, steps, ended };
    };

    const plus = walk(1);
    const minus = walk(-1);
    return {
      index,
      explained: a.explained,
      label: labelFor(plus.hits, minus.hits),
      plus: plus.hits,
      minus: minus.hits,
      stepsPlus: plus.steps,
      stepsMinus: minus.steps,
      endedPlus: plus.ended,
      endedMinus: minus.ended,
    };
  });
}

/**
 * A label for an axis, made only from catalogue columns that actually differ between its two ends.
 *
 * Deliberately not a phrase a person would write. "printmaking -> ceramics" is a statement about
 * the metadata of the works at the two extremes, which is a fact; "austerity -> ornament" would be
 * an interpretation, and this file does not do those.
 */
function labelFor(plus: Axis['plus'], minus: Axis['minus']): string {
  const top = (xs: Axis['plus'], f: (x: Axis['plus'][number]) => string) => {
    const counts = new Map<string, number>();
    for (const x of xs) {
      const v = (f(x) || '').trim().toLowerCase();
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    return best ? best[0] : '?';
  };
  const parts: string[] = [];
  const pc = top(plus, (x) => x.classification);
  const mc = top(minus, (x) => x.classification);
  if (pc !== mc) parts.push(`${mc} -> ${pc}`);
  const pm = top(plus, (x) => x.museum);
  const mm = top(minus, (x) => x.museum);
  if (pm !== mm) parts.push(`${mm} -> ${pm}`);
  return parts.length ? parts.join('; ') : 'the catalogue columns do not differ between the ends';
}

// --- blend --------------------------------------------------------------------------------------

export interface Blend {
  a: string;
  b: string;
  /** Cosine between the two sets' centroids. Near 1.0 means the blend has nothing to blend. */
  centroidCosine: number;
  midpoint: { sha256: string; id: string; title: string; museum: Source; classification: string; cosine: number }[];
  /** Near the midpoint but outside BOTH sets' own spreads. The point of the operation. */
  surprises: { sha256: string; id: string; title: string; museum: Source; classification: string; cosine: number; toA: number; toB: number }[];
}

export function blend(a: Resolved, b: Resolved, k = 12): Blend {
  const corpus = loadCorpusEmbeddings();
  const ca = Float32Array.from(a.centroid);
  const cb = Float32Array.from(b.centroid);
  const mid = new Float32Array(DIM);
  let norm = 0;
  for (let j = 0; j < DIM; j++) {
    mid[j] = (ca[j]! + cb[j]!) / 2;
    norm += mid[j]! * mid[j]!;
  }
  norm = Math.sqrt(norm);
  for (let j = 0; j < DIM; j++) mid[j]! /= norm;

  const own = new Set([...a.works.map((w) => w.sha256), ...b.works.map((w) => w.sha256)]);
  const scored: { row: number; cos: number; toA: number; toB: number }[] = [];
  for (let i = 0; i < corpus.entries.length; i++) {
    if (own.has(corpus.entries[i]!.sha256)) continue;
    const v = corpus.rows.subarray(i * DIM, (i + 1) * DIM);
    scored.push({ row: i, cos: dot(v, mid), toA: dot(v, ca), toB: dot(v, cb) });
  }
  scored.sort((x, y) => y.cos - x.cos);
  const name = (s: { row: number; cos: number }) => {
    const e = corpus.entries[s.row]!;
    return {
      sha256: e.sha256,
      id: e.work.id,
      title: e.work.title,
      museum: e.work.source,
      classification: e.work.classification,
      cosine: s.cos,
    };
  };
  // "Near the midpoint but far from both" is the only part of a blend that could not have been
  // reached from either set alone. Everything else the midpoint returns is just the more popular
  // of the two neighbourhoods.
  const surprises = scored
    .filter((s) => s.toA < a.spread && s.toB < b.spread)
    .slice(0, k)
    .map((s) => ({ ...name(s), toA: s.toA, toB: s.toB }));

  return {
    a: a.positionId,
    b: b.positionId,
    centroidCosine: dot(ca, cb),
    midpoint: scored.slice(0, k).map(name),
    surprises,
  };
}

// --- measurement --------------------------------------------------------------------------------

function entropyOf(values: string[]): number {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / values.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function statsOf(works: ResolvedWork[], vectors: Float32Array[], seed: number): InfluenceStats {
  const corpus = loadCorpusEmbeddings();
  const n = works.length;

  const heldBy = new Map<Source, number>();
  for (const w of works) heldBy.set(w.museum, (heldBy.get(w.museum) ?? 0) + 1);
  let samePairs = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs++;
      if (works[i]!.museum === works[j]!.museum) samePairs++;
    }
  }
  // Chance is computed from THIS corpus rather than quoted, because the corpus's museum mix is a
  // fact on disk and a quoted 39.0% would go stale the day a work is added.
  const corpusHeld = new Map<Source, number>();
  for (const e of corpus.entries) corpusHeld.set(e.work.source, (corpusHeld.get(e.work.source) ?? 0) + 1);
  let chance = 0;
  for (const c of corpusHeld.values()) chance += (c / corpus.entries.length) ** 2;

  let intraSum = 0;
  let intraMin = Infinity;
  let intraMax = -Infinity;
  let intraPairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const c = dot(vectors[i]!, vectors[j]!);
      intraSum += c;
      intraPairs++;
      if (c < intraMin) intraMin = c;
      if (c > intraMax) intraMax = c;
    }
  }
  const intraMean = intraPairs ? intraSum / intraPairs : 0;

  // Entropy against 100 same-size random draws from the corpus, seeded so the band is reproducible.
  const entropy: InfluenceStats['entropy'] = [];
  for (const field of ['classification', 'medium'] as const) {
    const measured = entropyOf(works.map((w) => (w[field] || '?').toLowerCase()));
    const draws: number[] = [];
    const r = rng(seed);
    for (let d = 0; d < 100; d++) {
      const sample: string[] = [];
      for (let i = 0; i < n; i++) {
        const e = corpus.entries[Math.floor(r() * corpus.entries.length)]!;
        sample.push(((e.work[field] as string) || '?').toLowerCase());
      }
      draws.push(entropyOf(sample));
    }
    draws.sort((a, b) => a - b);
    entropy.push({
      field,
      measured,
      chanceMean: draws.reduce((a, b) => a + b, 0) / draws.length,
      chanceLo: draws[2]!,
      chanceHi: draws[97]!,
    });
  }

  let twoD = 0;
  let object = 0;
  let unknown = 0;
  for (const w of works) {
    // `dimensionalityOf` reads the manifest fields, so it needs the Work, not the ResolvedWork.
    const e = corpus.entries.find((x) => x.sha256 === w.sha256);
    const d = e ? dimensionalityOf(e.work) : 'unknown';
    if (d === '2d') twoD++;
    else if (d === 'object') object++;
    else unknown++;
  }

  return {
    n,
    sameMuseum: pairs ? samePairs / pairs : 0,
    sameMuseumChance: chance,
    museums: [...heldBy.entries()]
      .map(([source, count]) => ({ source, n: count, share: count / n }))
      .sort((a, b) => b.n - a.n),
    intraMean,
    intraMin: intraPairs ? intraMin : 0,
    intraMax: intraPairs ? intraMax : 0,
    degenerate: intraMean > 0.9,
    entropy,
    dimensionality: {
      twoD,
      object,
      unknown,
      twoDShare: n ? twoD / n : 0,
      // Measured over the whole manifest on 2026-09-01: 14.7% of rows are 2D.
      corpusTwoDShare: 0.147,
    },
  };
}

/** Jaccard over the sha256 sets. The check that the derivation distinguishes positions at all. */
export function jaccard(a: Resolved, b: Resolved): number {
  const A = new Set(a.works.map((w) => w.sha256));
  const B = new Set(b.works.map((w) => w.sha256));
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return A.size + B.size - shared === 0 ? 0 : shared / (A.size + B.size - shared);
}

// --- disk ---------------------------------------------------------------------------------------

export function influencesFile(id: string): string {
  return path.join(INFLUENCES_DIR, `${id}.json`);
}
export function resolvedFile(id: string): string {
  return path.join(INFLUENCES_DIR, `${id}.resolved.json`);
}

export function loadInfluences(id: string): Influences | null {
  const f = influencesFile(id);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Influences) : null;
}

export function loadResolved(id: string): Resolved | null {
  const f = resolvedFile(id);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Resolved) : null;
}

export function saveResolved(r: Resolved): string {
  const f = resolvedFile(r.positionId);
  writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
  return f;
}

// --- report -------------------------------------------------------------------------------------

export function resolvedText(r: Resolved): string {
  const out: string[] = [];
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  out.push(`influences for ${r.positionId} — ${r.works.length} works, influencesHash ${r.influencesHash}`);
  out.push('');
  out.push('  weight   cos   pen  id            museum  classification / title');
  for (const w of r.works) {
    out.push(
      `  ${w.weight.toFixed(3).padStart(6)}  ${w.cosine.toFixed(3)}  ${w.avoidPenalty.toFixed(2)}  ` +
        `${w.id.padEnd(12)}  ${w.museum.padEnd(6)}  ${(w.classification || '?').slice(0, 20).padEnd(20)} | ${(w.title || '').slice(0, 40)}`,
    );
  }

  out.push('');
  out.push('measured, each against its chance baseline:');
  const s = r.stats;
  out.push(
    `  same-museum pairs   ${pct(s.sameMuseum)}  vs ${pct(s.sameMuseumChance)} chance ` +
      `(and vs 55.4% for appearance neighbours, 93.6% for metadata neighbours)`,
  );
  out.push(
    `  intra-set cosine    mean ${s.intraMean.toFixed(4)} (min ${s.intraMin.toFixed(4)} max ${s.intraMax.toFixed(4)})  ` +
      `vs corpus median ${CORPUS_PAIR_MEDIAN} / p99 ${CORPUS_PAIR_P99}`,
  );
  if (s.degenerate) {
    out.push('  *** DEGENERATE: mean intra-set cosine > 0.90. This is one work photographed many times.');
  }
  for (const e of s.entropy) {
    const verdict =
      e.measured < e.chanceLo ? 'NARROWER than chance' : e.measured > e.chanceHi ? 'BROADER than chance' : 'INSIDE the chance band — nothing measured';
    out.push(
      `  ${e.field.padEnd(15)} entropy ${e.measured.toFixed(3)} bits vs random draw ` +
        `${e.chanceMean.toFixed(3)} [${e.chanceLo.toFixed(3)}, ${e.chanceHi.toFixed(3)}] — ${verdict}`,
    );
  }
  out.push(
    `  2D vs object        ${s.dimensionality.twoD} 2D / ${s.dimensionality.object} object / ${s.dimensionality.unknown} unknown  ` +
      `= ${pct(s.dimensionality.twoDShare)} 2D vs ${pct(s.dimensionality.corpusTwoDShare)} in the manifest`,
  );
  out.push(`  museums             ${s.museums.map((m) => `${m.source} ${m.n} (${pct(m.share)})`).join('  ')}`);

  out.push('');
  out.push(`the set's own shape: spread ${r.spread.toFixed(4)} (mean cosine to centroid), radius ${r.radius.toFixed(4)} (mean euclidean)`);
  for (const a of r.axes) {
    out.push('');
    out.push(`  axis ${a.index} — ${pct(a.explained)} of the set's variance — ${a.label}`);
    out.push(
      `    walked ${a.stepsMinus} steps out on minus (stopped by ${a.endedMinus === 'hull' ? "the corpus's hull" : 'the step cap'}), ` +
        `${a.stepsPlus} on plus (${a.endedPlus === 'hull' ? "hull" : 'step cap'})`,
    );
    for (const side of [
      { name: '  -  ', hits: a.minus.slice(0, 3) },
      { name: '  +  ', hits: a.plus.slice(0, 3) },
    ]) {
      for (const h of side.hits) {
        out.push(`    ${side.name} ${h.cosine.toFixed(3)}  ${h.id.padEnd(12)} ${(h.classification || '?').slice(0, 18).padEnd(18)} | ${(h.title || '').slice(0, 38)}`);
      }
    }
  }

  if (r.truncated.length) {
    out.push('');
    out.push(`${r.truncated.length} queries ran past CLIP's 77-token context and were CUT. Only their opening survives:`);
    for (const t of r.truncated.slice(0, 6)) out.push(`  ${t.tokens} tokens: ${t.text.slice(0, 78)}...`);
  }
  if (r.empty.length) {
    out.push('');
    out.push(`${r.empty.length} queries returned nothing above the cosine floor:`);
    for (const t of r.empty.slice(0, 6)) out.push(`  ${t.slice(0, 88)}`);
  }

  out.push('');
  out.push(
    'This is RETRIEVAL, not reading. Nothing here knows what any of these works is. A lineage entry',
    'names a real work that is almost certainly NOT in this corpus, so what comes back is whatever',
    'photographs like the words in its title. Read the Jaccard column across positions before',
    'believing that any of this distinguishes one position from another.',
  );
  return out.join('\n') + '\n';
}
