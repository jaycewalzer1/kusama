// Choosing twenty thousand works out of three hundred thousand, on purpose and in public.
//
// ## Why not just take the first N
//
// The pool is not a sample of art. It is the union of three institutions' cataloguing habits, and
// those habits are lopsided in ways that survive into anything drawn off the top of the file. Of the
// Met's 248,472 public-domain rows, 32,761 are Prints and 13,054 are Drawings; paintings are 2.1%.
// Cleveland's largest class is Print at 10,686 out of 41,511. A corpus taken in file order would be
// a corpus of European prints, and every lineage element derived from it would inherit that without
// anybody having decided it.
//
// So the selection is stratified, and the strata are recorded next to the result. `corpus/
// selection.json` is not a log — it is the answer to "what was available, and why these rather than
// those", which is the question a person asks when a derived element looks strange.
//
// ## The three properties that make this checkable
//
// **Deterministic from a seed.** No `Math.random`, no clock, no set iteration order that depends on
// insertion. Re-running the selector on the same pool must produce the same ids, which is why the
// result carries a hash of them: a future run either reproduces it or has changed something.
//
// **Additive.** A work already in the manifest is carried over unconditionally, whatever the caps
// say. Readings cost money and are keyed to the work; dropping a work that has been read throws away
// evidence in order to tidy a distribution, which is the wrong trade every time.
//
// **Nothing is silently excluded.** Undated works get an `(undated)` bucket rather than being
// skipped, and works with no classification already carry the source's own object name. A stratum
// nobody can see is a stratum nobody can argue with.

import { createHash } from 'node:crypto';
import type { Source, Work } from './manifest.js';

/** Twenty thousand: the low end of the target, because the binding cost is readings, not disk. */
export const DEFAULT_TARGET = 20_000;

/**
 * How much of the corpus any one classification may occupy, and any one source.
 *
 * The classification ceiling is the whole point — without it, round-robin over strata still hands
 * Prints thirty buckets (six centuries times three sources times its aliases) against one for a
 * rare class. 8% is the number that keeps prints and drawings from being a third of the corpus
 * between them while still letting them be its largest classes, which they honestly are.
 *
 * The source ceiling exists because the Met is 86% of the pool by row count and none of that is a
 * fact about art. Half is generous and still leaves the other two sources visible.
 */
export const MAX_CLASSIFICATION_SHARE = 0.08;
export const MAX_SOURCE_SHARE = 0.5;

export interface SelectionRules {
  seed: number;
  target: number;
  maxClassificationShare: number;
  maxSourceShare: number;
}

export interface Stratum {
  key: string;
  source: Source;
  classification: string;
  period: string;
  available: number;
  taken: number;
}

export interface Selection {
  generatedAt: string;
  rules: SelectionRules;
  poolSize: number;
  carriedOver: number;
  selected: number;
  /** sha256 of the selected ids, sorted, newline-joined. Re-running must reproduce it. */
  idsSha256: string;
  bySource: Record<string, number>;
  byPeriod: Record<string, number>;
  /** Every classification that contributed, with what was on offer beside what was taken. */
  byClassification: { classification: string; available: number; taken: number }[];
  /** The strata, biggest first. Truncated in the file because there are thousands. */
  strata: Stratum[];
}

// --- keys ----------------------------------------------------------------------------------------

/** FNV-1a, so the ordering is a pure function of the id and identical on every machine. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A work's classification segments. The Met's field is pipe-delimited multi-value —
 * `Photographs|Ephemera`, `Books|Prints|Ornament & Architecture` — and the other two are single.
 *
 * Lowercased, because these are three cataloguing departments and not one vocabulary. Measured over
 * the pooled 348,983: `Sculpture` 4,722 and `sculpture` 373, `Textile` 2,140 and `textile` 6,228,
 * `Coins` 1,497 and `coin` 1,250 are all the same category spelled by different institutions, and
 * leaving them apart splits every one of those buckets in half and halves the ceiling that is
 * supposed to hold them down. This changes the bucketing key only — `work.classification` is still
 * whatever the museum wrote.
 */
export function classificationsOf(work: Work): string[] {
  const parts = work.classification
    .split('|')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : ['(unclassified)'];
}

/**
 * The one classification a work is bucketed under: its **rarest** segment in this pool.
 *
 * Taking the first segment would put every `Prints|Ephemera` into Prints, which is the bucket
 * already overflowing; the ephemera would then be invisible as ephemera. The rarest segment is the
 * one that says the most about the object, and it is what a person means when they say a thing is
 * "a piece of ephemera that happens to be printed".
 */
export function bucketClassification(work: Work, frequency: Map<string, number>): string {
  const parts = classificationsOf(work);
  let best = parts[0] as string;
  let bestN = frequency.get(best) ?? 0;
  for (const p of parts.slice(1)) {
    const n = frequency.get(p) ?? 0;
    // Ties break on the name so the choice does not depend on field order.
    if (n < bestN || (n === bestN && p < best)) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

/**
 * The period bucket. Centuries, and `(undated)` for the works whose prose did not parse.
 *
 * Undated is a real bucket and not a discard. Roughly a tenth of the pool has no parseable band —
 * the Met alone has 147 rows whose begin and end are inverted — and those are disproportionately
 * the objects nobody catalogued carefully, which is not a reason to exclude them from a corpus
 * about how objects are looked at.
 */
export function periodOf(work: Work): string {
  if (work.date_begin === null) return '(undated)';
  const c = Math.floor(work.date_begin / 100);
  // BCE is labelled by its band rather than by an ordinal century. `-300` in a museum record means
  // 300 BCE, but whether that is the third or the fourth century BCE depends on whether whoever
  // wrote it was counting astronomically, and the three sources do not agree with each other.
  // `300s BCE` is the hundred years the bucket actually holds and makes no claim either way.
  return c < 0 ? `${Math.abs(c) * 100}s BCE` : `${c + 1}c`;
}

// --- the selection -------------------------------------------------------------------------------

/**
 * Choose works from the pool, stratified, deterministically.
 *
 * `alreadyHeld` is the ids already in the manifest; they are kept whatever the caps say, and they
 * count against the caps so that carrying them over does not quietly push the corpus past its own
 * limits.
 */
export function select(pool: Work[], alreadyHeld: Set<string>, rules: SelectionRules): { works: Work[]; selection: Selection } {
  const frequency = new Map<string, number>();
  for (const w of pool) for (const c of classificationsOf(w)) frequency.set(c, (frequency.get(c) ?? 0) + 1);

  const byId = new Map(pool.map((w) => [w.id, w]));
  const buckets = new Map<string, { source: Source; classification: string; period: string; works: Work[] }>();
  for (const w of pool) {
    const classification = bucketClassification(w, frequency);
    const period = periodOf(w);
    const key = `${w.source}|${classification}|${period}`;
    const b = buckets.get(key) ?? { source: w.source, classification, period, works: [] };
    b.works.push(w);
    buckets.set(key, b);
  }

  // Within a bucket, spread across cultures before spreading within one. A bucket of 4,000 Prints
  // will only ever give up a handful of members, and taking them all from whichever culture the
  // museum catalogued most thoroughly is the same lopsidedness one level down.
  for (const b of buckets.values()) {
    const byCulture = new Map<string, Work[]>();
    for (const w of b.works) {
      const c = w.culture ?? '(unrecorded)';
      const list = byCulture.get(c);
      if (list) list.push(w);
      else byCulture.set(c, [w]);
    }
    const cultures = [...byCulture.keys()].sort((x, y) => hash32(`${rules.seed}:${x}`) - hash32(`${rules.seed}:${y}`));
    for (const c of cultures) (byCulture.get(c) as Work[]).sort((x, y) => hash32(`${rules.seed}:${x.id}`) - hash32(`${rules.seed}:${y.id}`));
    const spread: Work[] = [];
    for (let i = 0; spread.length < b.works.length; i++) {
      for (const c of cultures) {
        const w = (byCulture.get(c) as Work[])[i];
        if (w) spread.push(w);
      }
    }
    b.works = spread;
  }

  const chosen = new Map<string, Work>();
  const perClassification = new Map<string, number>();
  const perSource = new Map<string, number>();
  const taken = new Map<string, number>();
  const classificationCap = Math.max(1, Math.ceil(rules.target * rules.maxClassificationShare));
  const sourceCap = Math.max(1, Math.ceil(rules.target * rules.maxSourceShare));

  const bump = (w: Work) => {
    const c = bucketClassification(w, frequency);
    const key = `${w.source}|${c}|${periodOf(w)}`;
    perClassification.set(c, (perClassification.get(c) ?? 0) + 1);
    perSource.set(w.source, (perSource.get(w.source) ?? 0) + 1);
    taken.set(key, (taken.get(key) ?? 0) + 1);
  };

  // The works already read, first and unconditionally. They may exceed a cap; they are evidence.
  let carriedOver = 0;
  for (const id of [...alreadyHeld].sort()) {
    const w = byId.get(id);
    if (!w) continue;
    chosen.set(id, w);
    bump(w);
    carriedOver++;
  }

  // Round-robin over strata, in a seeded order, one work each pass. Equal weight per stratum rather
  // than proportional: proportional allocation reproduces the pool's shape, which is the shape this
  // whole function exists to refuse.
  const order = [...buckets.entries()].sort((a, b) => hash32(`${rules.seed}:${a[0]}`) - hash32(`${rules.seed}:${b[0]}`));
  const cursor = new Map<string, number>(order.map(([k]) => [k, 0]));
  let progressed = true;
  while (chosen.size < rules.target && progressed) {
    progressed = false;
    for (const [key, b] of order) {
      if (chosen.size >= rules.target) break;
      if ((perClassification.get(b.classification) ?? 0) >= classificationCap) continue;
      if ((perSource.get(b.source) ?? 0) >= sourceCap) continue;
      let i = cursor.get(key) as number;
      while (i < b.works.length && chosen.has((b.works[i] as Work).id)) i++;
      if (i >= b.works.length) {
        cursor.set(key, i);
        continue;
      }
      const w = b.works[i] as Work;
      chosen.set(w.id, w);
      bump(w);
      cursor.set(key, i + 1);
      progressed = true;
    }
  }

  const works = [...chosen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = works.map((w) => w.id);

  const byPeriod: Record<string, number> = {};
  for (const w of works) byPeriod[periodOf(w)] = (byPeriod[periodOf(w)] ?? 0) + 1;

  const strata: Stratum[] = order
    .map(([key, b]) => ({ key, source: b.source, classification: b.classification, period: b.period, available: b.works.length, taken: taken.get(key) ?? 0 }))
    .sort((a, b) => b.taken - a.taken || b.available - a.available);

  const byClassification = [...perClassification.entries()]
    .map(([classification, t]) => ({ classification, available: frequency.get(classification) ?? 0, taken: t }))
    .sort((a, b) => b.taken - a.taken);

  return {
    works,
    selection: {
      generatedAt: new Date().toISOString(),
      rules,
      poolSize: pool.length,
      carriedOver,
      selected: works.length,
      idsSha256: createHash('sha256').update(`${ids.join('\n')}\n`).digest('hex'),
      bySource: Object.fromEntries([...perSource.entries()].sort()),
      byPeriod: Object.fromEntries(Object.entries(byPeriod).sort()),
      byClassification,
      strata,
    },
  };
}
