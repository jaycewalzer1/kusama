// The rated pool, and the three checks that have to pass before any of it is called a reward.
//
// The pool is a person's ratings of finished plates. It is the only judgement in this repo that does
// not come from a model or from a rule, which makes it the thing everything else is validated
// *against* — and the binding constraint, because it grows at the speed of somebody looking at
// pictures. So the file it lives in is append-only, plain JSONL, one line per act of rating, and
// nothing here ever rewrites a line. A pool you cannot resume is a pool nobody finishes.
//
// Three deliberate refusals, each of which is the whole point of the corresponding function:
//
//   no composite score
//     Nothing here adds components together. `componentCorrelations` exists precisely because the
//     documented failure of a fused reward — a search that collapsed onto one flat clip-art flower —
//     was five components correlating at 0.85 to 0.95 while looking like five opinions. A weighted
//     sum of five copies of one number is that one number with extra confidence. So the components
//     stay plural and unfused, and the correlation check runs before any of them is used.
//
//   no aggregate correlation against the ratings
//     A judge that agrees with a person about which plates are mediocre, and disagrees about which
//     are the best, scores well on Spearman and is useless. The only question worth asking is
//     whether the judge's top-k is the person's top-k, so `jaccardAt` is the readout and there is no
//     function here that returns one aggregate number for the whole ordering.
//
//   no single-ordering comparison
//     Every pairwise comparison is run in both orderings and averaged. A comparator asked (A, B) and
//     (B, A) that answers "the first one" twice has told you about its position bias and nothing
//     about A and B. `pairwise` refuses to score a pair it has only seen one way round, and reports
//     the disagreement rate as its own number.
//
// TODO: the comparator itself. `pairwise` takes comparisons; it does not make them, because making
// one is a model call and both providers are out of credit. When that is wired, it must submit each
// pair twice with the plates swapped and hand the results here — not average inside the caller.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pearson } from './archive.js';

/** The repo root, found the same way `aesthetic/elements/pack.ts` finds it and for the same reason. */
const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('cannot locate the repo root (package.json not found above this file)');
})();

/**
 * The pool lives at the repo root, not under `out/`.
 *
 * `out/` is gitignored, and a pool that is meant to be grown over weeks and used to validate every
 * later judge cannot live in a directory that is one `rm -rf` from gone. This file is the artifact;
 * the plates it rates are reproducible and it is not.
 */
export const POOL_FILE = path.join(ROOT, 'ratings.jsonl');

// --- tiers -------------------------------------------------------------------------------------------

/**
 * One key per tier, in order, worst first.
 *
 * Five, because a person rating a hundred plates at speed can hold five distinctions and not seven,
 * and because the two ends have to be usable without hesitation — a scale whose extremes feel unfair
 * to use collapses into its middle. The glosses are the actual question being asked; they are shown
 * on every prompt so that the fifth session's "3" means what the first session's "3" meant.
 */
export const TIERS = [
  { key: '1', name: 'discard', gloss: 'nothing is happening. I would not keep the file' },
  { key: '2', name: 'weak', gloss: 'legible as an attempt, not as a work' },
  { key: '3', name: 'ok', gloss: 'holds together. nothing to argue with, or about' },
  { key: '4', name: 'strong', gloss: 'there is a decision in it I did not expect' },
  { key: '5', name: 'keep', gloss: 'I would show this' },
] as const;

export type Tier = (typeof TIERS)[number]['name'];

export const TIER_NAMES = TIERS.map((t) => t.name) as readonly Tier[];

/** Worst is 0. Used as an ordering, never as a quantity — the gap between 1 and 2 is not a unit. */
export function tierRank(t: Tier): number {
  return TIER_NAMES.indexOf(t);
}

export function tierForKey(key: string): Tier | null {
  return TIERS.find((t) => t.key === key)?.name ?? null;
}

// --- the pool ----------------------------------------------------------------------------------------

export interface Rating {
  /** The run directory's name, which is what the archive calls a candidate too. */
  plate: string;
  /**
   * The pixels that were actually looked at.
   *
   * Carried so that a re-rendered plate does not silently inherit a rating of a different picture.
   * `stale` in `PoolView` is the difference; it is reported rather than dropped, because a rating a
   * person spent attention on is evidence even when what it was evidence about has moved.
   */
  pixelHash: string;
  tier: Tier;
  rater: string;
  at: string;
}

export interface PoolView {
  /** One per plate, latest wins. A person changing their mind is the file working as intended. */
  ratings: Rating[];
  /** Lines read, including superseded ones. `lines - ratings.length` is how much re-rating happened. */
  lines: number;
  /** Lines that would not parse or lacked a field. Counted, never skipped silently. */
  malformed: number;
}

function isRating(v: unknown): v is Rating {
  const r = v as Partial<Rating>;
  return (
    typeof r?.plate === 'string' &&
    typeof r.pixelHash === 'string' &&
    typeof r.rater === 'string' &&
    typeof r.at === 'string' &&
    typeof r.tier === 'string' &&
    (TIER_NAMES as readonly string[]).includes(r.tier)
  );
}

export function readPool(file: string = POOL_FILE): PoolView {
  if (!existsSync(file)) return { ratings: [], lines: 0, malformed: 0 };
  const latest = new Map<string, Rating>();
  let lines = 0;
  let malformed = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!isRating(parsed)) {
      malformed++;
      continue;
    }
    latest.set(parsed.plate, parsed);
  }
  return { ratings: [...latest.values()].sort((a, b) => (a.plate < b.plate ? -1 : 1)), lines, malformed };
}

export function appendRating(r: Rating, file: string = POOL_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(r)}\n`);
}

// --- top-k agreement ---------------------------------------------------------------------------------

export interface Ranked {
  id: string;
  /** Higher is better. Ties are expected and are the reason `TopK` reports its own size. */
  score: number;
}

export interface TopK {
  ids: string[];
  requested: number;
  /**
   * How many of `ids` are tied with the k-th best.
   *
   * A five-tier scale over sixty plates puts twenty things in one tier, so "the top 10" is not a set
   * the ratings determine. Everything tied at the boundary is included and the count is reported, so
   * a Jaccard computed over 17 items cannot be read as a Jaccard over 10.
   */
  tiedAtBoundary: number;
}

/** The best `k`, with everything tied with the k-th included rather than cut by sort order. */
export function topK(ranked: Ranked[], k: number): TopK {
  const sorted = [...ranked].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  if (sorted.length <= k) return { ids: sorted.map((r) => r.id), requested: k, tiedAtBoundary: 0 };
  const cut = sorted[k - 1]!.score;
  const ids = sorted.filter((r) => r.score >= cut).map((r) => r.id);
  return { ids, requested: k, tiedAtBoundary: sorted.filter((r) => r.score === cut).length };
}

export interface Agreement {
  k: number;
  /** Null when either side has nothing to say at this k — never 0, which would read as "disagrees". */
  jaccard: number | null;
  mine: number;
  theirs: number;
  intersection: number;
  union: number;
  tiedAtBoundary: { mine: number; theirs: number };
}

/**
 * Jaccard of the two top-k sets.
 *
 * The number to put on a dashboard, and the only one. Aggregate rank correlation over the whole pool
 * is the wrong question: a judge can agree perfectly about which plates are mediocre — which is most
 * of them — and be wrong about every plate anybody would act on, and score well.
 */
export function jaccardAt(k: number, mine: Ranked[], theirs: Ranked[]): Agreement {
  const a = topK(mine, k);
  const b = topK(theirs, k);
  const sa = new Set(a.ids);
  const sb = new Set(b.ids);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return {
    k,
    jaccard: union === 0 ? null : inter / union,
    mine: sa.size,
    theirs: sb.size,
    intersection: inter,
    union,
    tiedAtBoundary: { mine: a.tiedAtBoundary, theirs: b.tiedAtBoundary },
  };
}

export const DEFAULT_KS = [5, 10, 20];

/** The pool as a ranking. The tier index, not a rescaling of it: this is an order, not a score. */
export function ratingsAsRanked(ratings: Rating[]): Ranked[] {
  return ratings.map((r) => ({ id: r.plate, score: tierRank(r.tier) }));
}

// --- pairwise comparison ------------------------------------------------------------------------------

export interface Comparison {
  /** The plate shown first. */
  first: string;
  /** The plate shown second. */
  second: string;
  /** Which of the two won, by id, or null for a refusal to choose. */
  winner: string | null;
}

export interface PairVerdict {
  /** Sorted, so a pair has one spelling. */
  pair: [string, string];
  /** The winner both orderings agreed on, or null when they disagreed or one abstained. */
  winner: string | null;
  agreed: boolean;
}

export interface PairwiseResult {
  verdicts: PairVerdict[];
  /**
   * Pairs seen in only one ordering. Excluded from `verdicts` entirely: a comparison run one way
   * round is not a measurement, it is a measurement plus an unknown amount of position bias.
   */
  unpaired: [string, string][];
  /**
   * Share of complete pairs whose two orderings disagreed.
   *
   * This is the comparator's position bias, and it is the number that says whether any of the rest
   * of this means anything. At 0.5 the comparator is answering "the first one" and the verdicts
   * below are noise with a shape.
   */
  orderBias: number | null;
  /** Wins over decided comparisons, per plate. A ranking, and not a rating. */
  ranked: Ranked[];
}

const spell = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * Fold comparisons into per-pair verdicts, requiring both orderings.
 *
 * Averaging two orderings of a categorical choice means: agree, or no verdict. There is no third
 * thing to do with "A won when shown first and B won when shown first" except to say that the
 * comparator did not answer the question.
 */
export function pairwise(comparisons: Comparison[]): PairwiseResult {
  const byPair = new Map<string, { key: [string, string]; forward: Comparison[]; backward: Comparison[] }>();
  for (const c of comparisons) {
    const key = spell(c.first, c.second);
    const k = key.join('\u0000');
    const slot = byPair.get(k) ?? { key, forward: [], backward: [] };
    (c.first === key[0] ? slot.forward : slot.backward).push(c);
    byPair.set(k, slot);
  }

  const verdicts: PairVerdict[] = [];
  const unpaired: [string, string][] = [];
  for (const { key, forward, backward } of [...byPair.values()].sort((x, y) => (x.key < y.key ? -1 : 1))) {
    if (forward.length === 0 || backward.length === 0) {
      unpaired.push(key);
      continue;
    }
    const f = forward[forward.length - 1]!.winner;
    const b = backward[backward.length - 1]!.winner;
    const agreed = f !== null && f === b;
    verdicts.push({ pair: key, winner: agreed ? f : null, agreed });
  }

  const wins = new Map<string, { won: number; decided: number }>();
  const bump = (id: string, won: number) => {
    const w = wins.get(id) ?? { won: 0, decided: 0 };
    wins.set(id, { won: w.won + won, decided: w.decided + 1 });
  };
  for (const v of verdicts) {
    if (v.winner === null) continue;
    bump(v.pair[0], v.winner === v.pair[0] ? 1 : 0);
    bump(v.pair[1], v.winner === v.pair[1] ? 1 : 0);
  }

  return {
    verdicts,
    unpaired,
    orderBias: verdicts.length === 0 ? null : verdicts.filter((v) => !v.agreed).length / verdicts.length,
    ranked: [...wins.entries()]
      .map(([id, w]) => ({ id, score: w.won / w.decided }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)),
  };
}

// --- component correlation ----------------------------------------------------------------------------

export const CORRELATION_LIMIT = 0.8;

/**
 * Every finite number in a scores object, by dotted path.
 *
 * Walked rather than listed, so a component added to `Scores` is checked without anybody remembering
 * to add it here — the failure mode this guards against is a new component that duplicates an old
 * one, and a hand-maintained list would be updated by the same commit that introduced the duplicate.
 * Booleans are not numbers and are left out; a `Record<string, number>` of per-constraint counts has
 * keys that differ run to run and is dropped by the intersection rule in `componentCorrelations`.
 */
export function componentsOf(scores: unknown, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  if (scores === null || typeof scores !== 'object' || Array.isArray(scores)) return out;
  for (const [key, value] of Object.entries(scores as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else if (value !== null && typeof value === 'object') Object.assign(out, componentsOf(value, name));
  }
  return out;
}

export interface CorrelationReport {
  /** Components present and numeric on every row. Anything else cannot be correlated over this pool. */
  components: string[];
  /** Named with the reason, because a component that vanishes from a check is worse than a bad one. */
  dropped: { name: string; because: string }[];
  n: number;
  pairs: { a: string; b: string; r: number }[];
  /** `|r|` over the limit. Non-empty means no reward may be built from these components. */
  offenders: { a: string; b: string; r: number }[];
  limit: number;
}

/**
 * Pairwise correlation across every component, over the rated pool.
 *
 * Run before any reward is used, and it is a gate rather than a report: the prior art that
 * mode-collapsed onto one flat clip-art flower had five components correlating at 0.85 to 0.95, and
 * every one of them looked like a separate opinion in the config file. `assertIndependent` is what
 * makes it loud.
 *
 * Components that are constant across the pool report no correlation rather than zero — see
 * `pearson`, where a constant axis returning 0 was a real bug. Here it matters more: a component
 * that never moves is not independent of anything, it is not evidence.
 */
export function componentCorrelations(rows: Record<string, number>[], limit = CORRELATION_LIMIT): CorrelationReport {
  const dropped: { name: string; because: string }[] = [];
  const seen = new Set(rows.flatMap((r) => Object.keys(r)));
  const components: string[] = [];
  for (const name of [...seen].sort()) {
    const missing = rows.filter((r) => typeof r[name] !== 'number').length;
    if (missing > 0) dropped.push({ name, because: `absent or non-numeric on ${missing} of ${rows.length} rows` });
    else components.push(name);
  }

  const pairs: { a: string; b: string; r: number }[] = [];
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i]!;
      const b = components[j]!;
      const r = pearson(
        rows.map((row) => row[a]!),
        rows.map((row) => row[b]!)
      );
      if (r !== null) pairs.push({ a, b, r });
    }
  }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  return {
    components,
    dropped,
    n: rows.length,
    pairs,
    offenders: pairs.filter((p) => Math.abs(p.r) > limit),
    limit,
  };
}

/** Throws with every offending pair named. The loud half of the check. */
export function assertIndependent(report: CorrelationReport): void {
  if (report.offenders.length === 0) return;
  const lines = report.offenders.map((p) => `  ${p.a} x ${p.b}  r=${p.r.toFixed(3)}`);
  throw new Error(
    `${report.offenders.length} component pair(s) correlate above ${report.limit} over ${report.n} rated plates.\n` +
      `${lines.join('\n')}\n` +
      'These are not separate opinions. Fusing them would weight one quantity several times over, ' +
      'which is how a reward collapses onto a single shape.'
  );
}

// --- reading plates and scores off disk ------------------------------------------------------------------

export interface Plate {
  /** The run directory's name. Same id the archive uses, so the two records join. */
  name: string;
  dir: string;
  png: string;
  /** SHA-256 of `final.png`'s bytes. The picture, not a summary of it. */
  pixelHash: string;
}

/** Every finished run under `runsDir` that has a plate to look at, in a stable order. */
export function plates(runsDir: string): Plate[] {
  if (!existsSync(runsDir)) return [];
  const out: Plate[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    const png = path.join(dir, 'final.png');
    if (!existsSync(png)) continue;
    out.push({ name: entry.name, dir, png, pixelHash: createHash('sha256').update(readFileSync(png)).digest('hex') });
  }
  return out;
}

/**
 * The score components of each named plate, for the correlation check.
 *
 * A plate whose `final.json` is missing or unreadable is named in `missing` rather than contributing
 * an empty row: a row of absent components would be dropped by the intersection rule and would take
 * every other component with it, silently emptying the check.
 */
export function componentRows(
  runsDir: string,
  names: string[]
): { rows: Record<string, number>[]; missing: string[] } {
  const rows: Record<string, number>[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const file = path.join(runsDir, name, 'final.json');
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    try {
      const scores = (JSON.parse(readFileSync(file, 'utf8')) as { scores?: unknown }).scores;
      if (scores === undefined) missing.push(name);
      else rows.push(componentsOf(scores));
    } catch {
      missing.push(name);
    }
  }
  return { rows, missing };
}

// --- text ----------------------------------------------------------------------------------------------

export function poolText(view: PoolView, unrated: string[] = [], stale: string[] = []): string {
  const counts = TIER_NAMES.map((t) => `${t} ${view.ratings.filter((r) => r.tier === t).length}`);
  const out = [
    `rated ${view.ratings.length} plate(s) over ${view.lines} line(s)`,
    `  ${counts.join('   ')}`,
  ];
  if (view.malformed) out.push(`  ${view.malformed} line(s) would not parse and were not counted either way`);
  if (unrated.length) out.push(`  ${unrated.length} plate(s) on disk not yet rated: ${unrated.slice(0, 6).join(' ')}`);
  if (stale.length) out.push(`  ${stale.length} rating(s) are of pixels that have since changed: ${stale.join(' ')}`);
  return out.join('\n');
}

export function agreementText(as: Agreement[]): string {
  const out = ['judge against the rated pool, at top-k. there is no aggregate number here on purpose.'];
  for (const a of as) {
    if (a.jaccard === null) {
      out.push(`  @${a.k}  no overlap to measure — one side is empty`);
      continue;
    }
    const tie =
      a.tiedAtBoundary.mine > 1 || a.tiedAtBoundary.theirs > 1
        ? `  (ties at the cut: mine ${a.tiedAtBoundary.mine}, judge ${a.tiedAtBoundary.theirs})`
        : '';
    out.push(`  @${a.k}  jaccard ${a.jaccard.toFixed(3)}   ${a.intersection}/${a.union}   sets ${a.mine} and ${a.theirs}${tie}`);
  }
  return out.join('\n');
}

export function correlationText(r: CorrelationReport): string {
  const out = [`${r.components.length} component(s) over ${r.n} rated plate(s), limit ${r.limit}`];
  for (const p of r.pairs.slice(0, 8)) out.push(`  ${p.r.toFixed(3)}  ${p.a} x ${p.b}`);
  if (r.dropped.length) out.push(`  ${r.dropped.length} component(s) not comparable over this pool (first: ${r.dropped[0]!.name})`);
  if (r.offenders.length > 0) {
    out.push(`  ${r.offenders.length} PAIR(S) OVER THE LIMIT — these components are not independent`);
  } else if (r.pairs.length === 0) {
    // The vacuous pass, and it is the dangerous one. Under three rated plates `pearson` returns null
    // for every pair, so the offender list is empty for the same reason an unasked question has no
    // wrong answer. Saying "no pair over the limit" here would be a gate reporting that it held while
    // nothing was in front of it.
    out.push(`  NOTHING MEASURED — ${r.n} rated plate(s) is not enough to correlate anything. This is not a pass.`);
  } else {
    out.push(`  no pair over the limit, across ${r.pairs.length} measurable pair(s)`);
  }
  return out.join('\n');
}
