// COMPARE: choose which sketch to develop, and be answerable to the ranking you already made.
//
// This replaces the judgment half of CHOOSE. The phase it replaces asked one question — "which of
// these do you want" — over a contact sheet built from `sketches.filter(s => s.png)`, and that filter
// is the whole defect. A sketch whose edits were all refused has no picture, so it was not on the
// sheet, so it was not in the question, so it could not be chosen. The artist was not choosing among
// problems. It was choosing among survivors, and it could not see that it was.
//
// In one logged run that produced the exact failure this file exists to prevent: FIND had weighted
// the problems itself, the sketches for the heavier problems failed to render, and the artist
// "chose" a problem it had itself put at 8%. Nothing in the trajectory recorded that anything had
// gone wrong, because from inside the phase nothing had — every sketch it was shown was a real
// sketch and it picked one of them for real reasons. Validation had made the decision an hour
// earlier and left no line saying so.
//
// So two things change here.
//
// ## A sketch that did not draw stays in the running
//
// Every sketch is a card, drawn or not, and a card that did not draw carries the reason it did not.
// It goes into the pairwise round with that reason where its picture would have been, and it goes
// into the ranking. The artist can still decide against it — often it should, since a problem that
// will not go down on the sheet even on a retry is a fact about the problem — but it has to decide
// against it out loud, not receive a sheet with a hole in it.
//
// ## Pairwise, not scalar
//
// Every comparison is one call about exactly two sketches: which of these two is more worth
// developing, and why, on fertility and necessity. A rating out of ten over nine sketches is nine
// judgments each made against an imagined scale; a pairwise choice is a judgment made against a
// thing that is actually present. The win counts that come out are an aggregation of what the artist
// said, and the commit call is told so — it is allowed to keep a sketch that lost every comparison
// if it can say why the comparisons were the wrong question. The counts are not a score and nothing
// downstream should treat them as one.
//
// ## Judgment is never summed with a gate
//
// Nothing in this file reads `check.ts`, the profile limits, or any render measurement. That is the
// separation stated plainly: gates decide validity and the brief's prohibitions, judgment decides
// what is worth making, and a single number mixing the two would let a well-formed sketch outrank a
// necessary one by arithmetic. The one place a gate's outcome appears here is as a *fact told to the
// artist* — "this one would not draw, and here is what the validator said" — which is evidence for a
// judgment, not a term in it.
//
// ## Nothing here enters the hash chain
//
// Every call takes a `DiscoveryLog`. The pairwise choices are the preference data the brief wants
// kept for later, and the brief is equally explicit that no preference model is to be built now: the
// instruction is to build the record so the option exists. `discovery.jsonl` has no `prev`/`hash`,
// so a comparison can never be mistaken for a canonical step. The prompt text and the schemas below
// live in this file rather than in `observation.ts`/`schemas.ts` for the reason `influence-doc.ts`
// sets out at length: those two files hash their own source bytes into `envVersion.observationHash`,
// and a word added to either declares every trajectory ever collected to be from a different
// environment.

import { contentHash } from '../../env/profile.js';
import { callPolicy, type Spend } from '../call.js';
import type { DiscoveryLog } from '../discovery-log.js';
import { artistLayers, type Commission } from '../field.js';
import { stack } from '../observation.js';
import { rng, streamSeed } from '../sampling.js';
import type { Policy, PolicyImage } from '../policy/interface.js';
import type { Problem } from '../types.js';
import { sheetOf, type SketchResult } from './sketch.js';

const RULE = '-'.repeat(88);

/**
 * The most pairwise calls one COMPARE will make.
 *
 * Twelve. The usual field is nine sketches — three problems drawn three ways — and round-robin over
 * nine is 36 calls each carrying two plates, which is roughly a hundred thousand image tokens spent
 * deciding which handful to develop. Twelve is enough for the coverage rule below to put every
 * sketch in at least one comparison and most of them in three, at a third of the cost. When the
 * field is small enough that every pair fits under the cap, every pair is asked and no sampling
 * happens at all.
 */
export const MAX_COMPARISONS = 12;

/** One sketch as the comparison round sees it. A card that did not draw is still a card. */
export interface Card {
  /** `p2#s1`. Stable, readable, and what the artist names when it commits. */
  key: string;
  problemId: string;
  index: number;
  approach: string;
  drawn: boolean;
  /** The validator's or the renderer's sentence, on a card that did not draw. */
  failure: string | null;
  png: Buffer | null;
}

export interface Pairwise {
  a: string;
  b: string;
  /** The key of the one the artist said was more worth developing. */
  winner: string;
  why: string;
}

export interface RankedSketch {
  key: string;
  problemId: string;
  index: number;
  approach: string;
  drawn: boolean;
  failure: string | null;
  wins: number;
  comparisons: number;
}

export interface Commitment {
  /** Sketch keys. More than one is allowed: the finished object may be a series. */
  survivors: string[];
  /** The problems those sketches belong to. Derived here, never taken from the model. */
  problemIds: string[];
  why: string;
  series: boolean;
  whyTheSketchesChangedMyMind: string | null;
}

export interface RankingAnswer {
  /** Every problem tied at the highest weight the artist gave. Empty when no weights were stated. */
  topRanked: string[];
  chosenProblemIds: string[];
  owed: boolean;
  given: boolean;
  reason: string | null;
}

export interface Comparison {
  survivors: RankedSketch[];
  ranking: RankedSketch[];
  comparisons: Pairwise[];
  commitment: Commitment;
  rankingAnswer: RankingAnswer;
}

function cardOf(s: SketchResult): Card {
  return {
    key: `${s.problemId}#s${s.index + 1}`,
    problemId: s.problemId,
    index: s.index,
    approach: s.approach,
    drawn: s.png !== null,
    failure: s.failure,
    png: s.png,
  };
}

/**
 * Which pairs get asked about.
 *
 * Round-robin when the field is small. Above the cap, a seeded shuffle with one rule laid over it:
 * a pair that introduces a sketch nothing has compared yet is taken before any pair that does not.
 * Without that rule a uniform subset leaves some sketch with zero comparisons, and a sketch with
 * zero comparisons and zero wins is indistinguishable in the ranking from one that lost everything —
 * which is the same silent disappearance this whole phase exists to stop, arriving by a new route.
 *
 * The shuffle is seeded off the run seed so the *selection* replays exactly. The judgments do not
 * and are not meant to; discovery is allowed to be nondeterministic, and only the question asked has
 * to be reproducible.
 */
export function pairsFor(n: number, runSeed: number, cap: number): [number, number][] {
  const all: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([i, j]);
  if (all.length <= cap) return all;

  const next = rng(streamSeed(runSeed, 'compare:pairs'));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }

  const seen = new Set<number>();
  const picked: [number, number][] = [];
  const rest: [number, number][] = [];
  for (const p of all) {
    if (picked.length < cap && (!seen.has(p[0]) || !seen.has(p[1]))) {
      picked.push(p);
      seen.add(p[0]);
      seen.add(p[1]);
    } else rest.push(p);
  }
  for (const p of rest) {
    if (picked.length >= cap) break;
    picked.push(p);
  }
  return picked;
}

const PAIRWISE_SYSTEM = [
  'You are an artist looking at two of your own sketches and choosing which one to develop.',
  '',
  'Two things decide it and you have to name both:',
  '',
  '  fertility   what developing this one would open up that you cannot already see the end of. A',
  '              sketch you could finish in your head is finished; it has nothing left to give you.',
  '  necessity   whether this one has to be made or merely could be. Competence is not necessity.',
  '',
  'One of them wins. Do not split the difference, do not rank them "roughly equal", and do not',
  'choose the one that is further along — you are choosing what to spend the next hours on, not',
  'awarding a prize for the state these are in now.',
].join('\n');

const COMMIT_SYSTEM = [
  'You are deciding what to make, having compared your sketches against each other one pair at a',
  'time. Nobody is waiting for this decision and nobody will check it.',
  '',
  'Keep one sketch, or keep several. Several is not a hedge when the several are one object in parts',
  'or a series that has to be read together — say which it is. Keeping everything is a hedge.',
  '',
  'You weighted these problems yourself before any of them was drawn. If what you are keeping is not',
  'the problem you weighted highest, that is allowed and may well be right, but it is something you',
  'have to account for by pointing at a sketch.',
].join('\n');

const ACCOUNT_SYSTEM = [
  'You have just kept a problem you had ranked below your own highest. Account for it.',
  '',
  'The answer has to be about a sketch — one you can name, and something in it or about the fact',
  'that it would not draw. "On reflection this problem is stronger" is not an account of anything;',
  'it is the decision restated.',
].join('\n');

const PAIRWISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'why'],
  properties: {
    winner: { enum: ['A', 'B'], description: 'Which of the two is more worth developing.' },
    why: {
      type: 'string',
      minLength: 40,
      description: 'On fertility and necessity, and about these two in particular rather than about sketching in general.',
    },
  },
};

function commitSchema(keys: string[]): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['survivors', 'why', 'series'],
    properties: {
      survivors: {
        type: 'array',
        minItems: 1,
        maxItems: keys.length,
        items: { type: 'string', enum: keys },
        description: 'The sketch keys you are keeping, exactly as they are written above.',
      },
      why: { type: 'string', minLength: 40, description: 'Why these, on fertility and necessity.' },
      series: { type: 'boolean', description: 'True if what you are keeping is several parts meant to be read together.' },
      whyTheSketchesChangedMyMind: {
        type: 'string',
        minLength: 40,
        description:
          'Required if you are not keeping the problem you weighted highest. Name the sketch that moved you and say what in it did.',
      },
    },
  };
}

const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['whyTheSketchesChangedMyMind'],
  properties: {
    whyTheSketchesChangedMyMind: {
      type: 'string',
      minLength: 60,
      description: 'Name a sketch and say what in it moved you off the problem you had weighted highest.',
    },
  },
};

function problemBlock(p: Problem | undefined, id: string): string {
  if (!p) return `problem ${id} (no record of it)`;
  return `problem [${p.id}] ${p.text}\n  tension: ${p.tension.between} vs ${p.tension.and}: ${p.tension.claim}`;
}

function cardBlock(label: string, c: Card, problems: Map<string, Problem>): string {
  const state = c.drawn
    ? 'DRAWN — its picture is attached to this message.'
    : `NOT DRAWN — ${c.failure ?? 'it produced no picture and said nothing about why'}`;
  return [`${label}: ${c.key}`, `  ${problemBlock(problems.get(c.problemId), c.problemId)}`, `  approach: ${c.approach}`, `  ${state}`].join('\n');
}

function pairwiseObservation(commission: Commission, problems: Map<string, Problem>, a: Card, b: Card): string {
  const l = artistLayers(commission);
  const attached = [a, b].filter((c) => c.drawn);
  const images =
    attached.length === 2
      ? 'Two pictures are attached, A first and B second.'
      : attached.length === 1
        ? `One picture is attached and it is ${attached[0]!.key}. The other sketch has no picture.`
        : 'No picture is attached. Neither of these was drawn.';
  return [
    stack(l.position, l.practice, l.brief),
    RULE,
    'TWO OF YOUR SKETCHES. WHICH IS MORE WORTH DEVELOPING?',
    '',
    cardBlock('A', a, problems),
    '',
    cardBlock('B', b, problems),
    '',
    images,
    RULE,
    // The paragraph the old phase could not have written, because the sketch it is about was not in
    // the question at all.
    'A sketch that was not drawn is still in this comparison. Its edits were refused or its program',
    'would not render, and that is evidence about the problem as much as about the attempt: an idea',
    'that will not go down on the sheet the easy way is sometimes the one worth the hours. Do not',
    'pick the other one merely because there is a picture of it.',
  ].join('\n');
}

function rankingLines(problems: Problem[]): string {
  return problems
    .map((p) => {
      // Absent is not zero. A trajectory from before verbalized sampling carries no weight at all,
      // and printing "0%" there would tell the artist it had dismissed a problem it never weighed.
      const w = p.probability === undefined ? 'no weight stated' : `${(p.probability * 100).toFixed(0)}%`;
      return `  ${p.id}  ${w.padStart(16)}  ${p.text}`;
    })
    .join('\n');
}

function rankedLines(ranking: RankedSketch[]): string {
  return ranking
    .map(
      (r) =>
        `  ${r.key}  ${r.wins}/${r.comparisons} pairwise wins  ${r.drawn ? 'drawn' : `NOT DRAWN: ${r.failure ?? 'no reason recorded'}`}\n      ${r.approach}`
    )
    .join('\n');
}

function comparisonLines(cs: Pairwise[]): string {
  if (cs.length === 0) return '  (none: there was only one sketch)';
  return cs.map((c) => `  ${c.a} vs ${c.b} -> ${c.winner}\n      ${c.why}`).join('\n');
}

/**
 * Aggregate the pairwise choices into an order.
 *
 * Win count, and ties broken by the sha256 of the sketch key. Not by array order: the array is in
 * problem order out of FIND, which is correlated with the weights the artist gave — so ties would
 * resolve toward the problem that was already favoured, and a ranking that quietly agrees with its
 * own prior is a ranking that measures nothing. A hash of the key is stable across runs and machines
 * and has nothing to do with either the order or the weights.
 */
export function rank(cards: Card[], comparisons: Pairwise[]): RankedSketch[] {
  const wins = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const c of cards) {
    wins.set(c.key, 0);
    seen.set(c.key, 0);
  }
  for (const c of comparisons) {
    wins.set(c.winner, (wins.get(c.winner) ?? 0) + 1);
    seen.set(c.a, (seen.get(c.a) ?? 0) + 1);
    seen.set(c.b, (seen.get(c.b) ?? 0) + 1);
  }
  const ranked: RankedSketch[] = cards.map((c) => ({
    key: c.key,
    problemId: c.problemId,
    index: c.index,
    approach: c.approach,
    drawn: c.drawn,
    failure: c.failure,
    wins: wins.get(c.key) ?? 0,
    comparisons: seen.get(c.key) ?? 0,
  }));
  const tiebreak = new Map(ranked.map((r) => [r.key, contentHash(r.key)]));
  return ranked.sort((x, y) => y.wins - x.wins || tiebreak.get(x.key)!.localeCompare(tiebreak.get(y.key)!));
}

/**
 * Whether the choice answered to the artist's own problem ranking.
 *
 * A reason is owed when none of the problems the artist kept is among the ones it weighted highest.
 * `given` is true when a reason exists and mentions the sketches — by key, or by the words for
 * looking at one.
 *
 * That is a test of presence and reference and nothing else. It does not and cannot say the reason
 * is a good one, that it is true of the sketch it names, or that the artist was in fact persuaded by
 * what it says persuaded it. A fluent sentence about a sketch passes here. What this rules out is
 * the case that was actually happening: a low-weighted problem chosen with no account of the change
 * at all.
 */
export function answersToRanking(chosen: Commitment, problems: Problem[]): RankingAnswer {
  // Only problems that carry a weight are part of the ranking. A run collected before verbalized
  // sampling has no weights anywhere, and reading those as zeros would invent a ranking and then
  // hold the artist to it.
  const weighted = problems.filter((p) => p.probability !== undefined);
  const best = weighted.reduce((m, p) => Math.max(m, p.probability!), -Infinity);
  const topRanked = weighted.filter((p) => p.probability === best).map((p) => p.id);

  const owed = topRanked.length > 0 && !chosen.problemIds.some((id) => topRanked.includes(id));
  const reason = chosen.whyTheSketchesChangedMyMind?.trim() || null;
  const refersToSketches =
    reason !== null && (/\bsketch(es)?\b|\bdrawn\b|\bdrew\b|\bdrawing\b/i.test(reason) || chosen.survivors.some((k) => reason.includes(k)));

  return { topRanked, chosenProblemIds: chosen.problemIds, owed, given: owed && refersToSketches, reason };
}

export async function compare(
  policy: Policy,
  discovery: DiscoveryLog,
  spend: Spend,
  commission: Commission,
  problems: Problem[],
  sketches: SketchResult[],
  runSeed: number,
  opts: { maxComparisons?: number } = {}
): Promise<Comparison> {
  const cards = sketches.map(cardOf);
  const byProblem = new Map(problems.map((p) => [p.id, p]));
  discovery.append('note', {
    phase: 'compare',
    cards: cards.length,
    drawn: cards.filter((c) => c.drawn).length,
    // Recorded on its own line because it is the number the old phase silently dropped.
    notDrawn: cards.filter((c) => !c.drawn).map((c) => ({ key: c.key, failure: c.failure })),
  });

  const comparisons: Pairwise[] = [];
  for (const [i, j] of pairsFor(cards.length, runSeed, opts.maxComparisons ?? MAX_COMPARISONS)) {
    const a = cards[i]!;
    const b = cards[j]!;
    const images: PolicyImage[] = [a, b]
      .filter((c) => c.png)
      .map((c) => ({ mediaType: 'image/png' as const, base64: c.png!.toString('base64') }));
    const result = await callPolicy<{ winner: 'A' | 'B'; why: string }>(policy, discovery, spend, {
      name: 'compare-pairwise',
      system: PAIRWISE_SYSTEM,
      observation: pairwiseObservation(commission, byProblem, a, b),
      schema: PAIRWISE_SCHEMA,
      images,
      maxTokens: 2000,
    });
    const pair: Pairwise = {
      a: a.key,
      b: b.key,
      winner: result.action.winner === 'A' ? a.key : b.key,
      why: result.action.why,
    };
    comparisons.push(pair);
    discovery.append('pairwise', { ...pair, aDrawn: a.drawn, bDrawn: b.drawn });
  }

  const ranking = rank(cards, comparisons);

  const l = artistLayers(commission);
  const sheet = sheetOf(sketches);
  const cells = cards.filter((c) => c.drawn).map((c, i) => `  cell ${i + 1}: ${c.key}`);
  const commit = await callPolicy<{
    survivors: string[];
    why: string;
    series: boolean;
    whyTheSketchesChangedMyMind?: string;
  }>(policy, discovery, spend, {
    name: 'compare-commit',
    system: COMMIT_SYSTEM,
    observation: [
      stack(l.position, l.practice, l.brief),
      RULE,
      'HOW YOU WEIGHTED THESE PROBLEMS, BEFORE ANY OF THEM WAS DRAWN',
      rankingLines(problems),
      RULE,
      `EVERY SKETCH, INCLUDING THE ONES THAT WERE NOT DRAWN (${ranking.length})`,
      rankedLines(ranking),
      sheet
        ? `\nThe drawn ones are attached as one sheet, reading left to right, top to bottom:\n${cells.join('\n')}`
        : '\nNo sheet is attached: none of these was drawn.',
      RULE,
      'WHAT YOU SAID WHEN YOU COMPARED THEM',
      comparisonLines(comparisons),
      RULE,
      'COMMIT.',
      'The win counts are a record of what you said, not a verdict. Keep a sketch that lost every',
      'comparison if you can say why the comparisons were the wrong question about it.',
    ].join('\n'),
    schema: commitSchema(cards.map((c) => c.key)),
    ...(sheet ? { images: [{ mediaType: 'image/png' as const, base64: sheet.toString('base64') }] } : {}),
    maxTokens: 4000,
  });

  // A key that names no sketch is dropped rather than carried; if that leaves nothing, the top of
  // the ranking stands in, so a malformed answer costs the commit call and not the run.
  const known = new Set(cards.map((c) => c.key));
  const survivorKeys = commit.action.survivors.filter((k) => known.has(k));
  if (survivorKeys.length === 0) survivorKeys.push(ranking[0]!.key);

  let commitment: Commitment = {
    survivors: survivorKeys,
    problemIds: [...new Set(survivorKeys.map((k) => cards.find((c) => c.key === k)!.problemId))],
    why: commit.action.why,
    series: commit.action.series,
    whyTheSketchesChangedMyMind: commit.action.whyTheSketchesChangedMyMind ?? null,
  };
  let answer = answersToRanking(commitment, problems);

  // The requirement is made real here rather than in the schema, because a schema cannot condition a
  // required field on an answer the model has not given yet. Declaring the field required in every
  // case would make it decorative in the ordinary case — a sentence produced to fill a slot when
  // nothing had changed anyone's mind. So it is asked for exactly when it is owed, and once asked it
  // is required, so the artist cannot keep a low-weighted problem without accounting for it.
  if (answer.owed && !answer.given) {
    const account = await callPolicy<{ whyTheSketchesChangedMyMind: string }>(policy, discovery, spend, {
      name: 'compare-account',
      system: ACCOUNT_SYSTEM,
      observation: [
        'HOW YOU WEIGHTED THESE PROBLEMS, BEFORE ANY OF THEM WAS DRAWN',
        rankingLines(problems),
        '',
        `You weighted ${answer.topRanked.join(', ')} highest, and you are keeping ${commitment.survivors.join(', ')},`,
        `which is problem ${commitment.problemIds.join(', ')}.`,
        '',
        `What you gave as your reason for keeping them: ${commitment.why}`,
        RULE,
        `EVERY SKETCH, INCLUDING THE ONES THAT WERE NOT DRAWN (${ranking.length})`,
        rankedLines(ranking),
        RULE,
        'WHAT YOU SAID WHEN YOU COMPARED THEM',
        comparisonLines(comparisons),
        RULE,
        'Name the sketch that moved you and say what in it did. Do not restate the reason above.',
      ].join('\n'),
      schema: ACCOUNT_SCHEMA,
      maxTokens: 2000,
    });
    commitment = { ...commitment, whyTheSketchesChangedMyMind: account.action.whyTheSketchesChangedMyMind };
    answer = answersToRanking(commitment, problems);
  }

  const survivors = ranking.filter((r) => survivorKeys.includes(r.key));
  discovery.append('note', { phase: 'compare', commitment, rankingAnswer: answer, ranking });
  return { survivors, ranking, comparisons, commitment, rankingAnswer: answer };
}
