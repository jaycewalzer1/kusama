// COMPARE, with a policy that can only judge what it was actually shown.
//
// The stub here parses the observation and answers out of it, rather than returning a canned choice.
// That is the point of the test and not a convenience: the bug this phase exists to fix was invisible
// from inside the old phase, because every sketch the artist saw was a real sketch and it picked one
// of them for real reasons. A stub that answered from constants baked into the test file would pass
// against a phase that had silently dropped half the field, which is exactly the run that shipped.
//
// So the stub can only name a sketch key that appeared in the text it was handed, and the tests
// about the undrawn sketch are tests that its key was in that text at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePng } from '../../env/png.js';
import { contentHash } from '../../env/profile.js';
import { newSpend } from '../call.js';
import { DiscoveryLog, readDiscovery } from '../discovery-log.js';
import { loadCommission } from '../field.js';
import { answersToRanking, compare, pairsFor, rank, type Card, type Commitment, type Pairwise } from '../phases/compare.js';
import type { SketchResult } from '../phases/sketch.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';
import type { Problem } from '../types.js';

const COMMISSION = loadCommission('interference', 'fifty-year-embargo');

function problem(id: string, probability: number): Problem {
  return {
    id,
    text: `whatever is difficult about ${id}`,
    tension: { between: 'one thing', and: 'another', claim: `the claim for ${id}` },
    fieldRefs: [],
    probability,
  };
}

function drawn(problemId: string, index: number, approach: string): SketchResult {
  return {
    problemId,
    index,
    approach,
    program: null,
    programHash: `hash-${problemId}-${index}`,
    png: encodePng(Buffer.alloc(8 * 8 * 4, 180), 8, 8),
    failure: null,
  };
}

function refused(problemId: string, index: number, approach: string): SketchResult {
  return { problemId, index, approach, program: null, programHash: '', png: null, failure: 'every edit was refused' };
}

function card(key: string): Card {
  const [problemId, s] = key.split('#');
  return {
    key,
    problemId: problemId!,
    index: Number(s!.slice(1)) - 1,
    approach: `approach for ${key}`,
    drawn: true,
    failure: null,
    png: null,
  };
}

/** Every sketch key the observation put in front of the artist, in the order it listed them. */
function keysShown(observation: string): string[] {
  return [...observation.matchAll(/^ {2}(\S+#s\d+) {2}\d+\/\d+ pairwise wins/gm)].map((m) => m[1] as string);
}

interface StubOptions {
  /** Which of the two the artist prefers. Given the two keys as they appeared in the observation. */
  prefer?: (a: string, b: string) => string;
  /** Which of the keys the observation listed the artist keeps. */
  keep?: (keys: string[]) => string[];
  /** A `whyTheSketchesChangedMyMind` on the commit call itself, or nothing. */
  changedMyMind?: string;
}

class CompareStub implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly requests: PolicyRequest[] = [];

  constructor(private readonly opts: StubOptions = {}) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.requests.push(request);
    const action = this.answer(request);
    return {
      action: action as T,
      raw: JSON.stringify(action),
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }

  private answer(request: PolicyRequest): unknown {
    if (request.name === 'compare-pairwise') {
      const a = /^A: (\S+)$/m.exec(request.observation)?.[1] as string;
      const b = /^B: (\S+)$/m.exec(request.observation)?.[1] as string;
      const want = this.opts.prefer ? this.opts.prefer(a, b) : a;
      return {
        winner: want === a ? 'A' : 'B',
        why: `${want} is the fertile one and the other is merely competent; ${a} against ${b} is not close.`,
      };
    }
    if (request.name === 'compare-commit') {
      const keys = keysShown(request.observation);
      return {
        survivors: this.opts.keep ? this.opts.keep(keys) : [keys[0] as string],
        why: 'It is the one I cannot see the end of, and the other has nothing left to give me.',
        series: false,
        ...(this.opts.changedMyMind ? { whyTheSketchesChangedMyMind: this.opts.changedMyMind } : {}),
      };
    }
    return {
      whyTheSketchesChangedMyMind:
        'The sketch I kept refused to draw at all, and the refusal was more interesting than the picture the other one made.',
    };
  }
}

function commitment(survivors: string[], reason: string | null): Commitment {
  return {
    survivors,
    problemIds: [...new Set(survivors.map((k) => k.split('#')[0] as string))],
    why: 'because',
    series: false,
    whyTheSketchesChangedMyMind: reason,
  };
}

test('every pair the artist was asked about is logged, with a reason, and nothing else was written', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compare-'));
  const discovery = new DiscoveryLog(dir);
  const policy = new CompareStub();
  const problems = [problem('p1', 0.6), problem('p2', 0.3), problem('p3', 0.1)];
  const sketches = [drawn('p1', 0, 'ruled lines'), drawn('p2', 0, 'one dense corner'), drawn('p3', 0, 'nothing in the middle')];

  const out = await compare(policy, discovery, newSpend(), COMMISSION, problems, sketches, 7);

  // Three sketches is three pairs, under the cap, so every pair was asked about.
  assert.equal(out.comparisons.length, 3);
  const logged = readDiscovery(discovery.file).filter((l) => l.kind === 'pairwise');
  assert.equal(logged.length, 3);
  for (const l of logged) {
    const d = l.data as Pairwise;
    assert.ok(d.why.length > 0, 'a comparison without a reason is not preference data');
    assert.ok(d.winner === d.a || d.winner === d.b, 'the winner is one of the two that were compared');
  }
  const asked = new Set(out.comparisons.map((c) => `${c.a}|${c.b}`));
  assert.deepEqual(new Set(logged.map((l) => `${(l.data as Pairwise).a}|${(l.data as Pairwise).b}`)), asked);
  assert.deepEqual(asked, new Set(['p1#s1|p2#s1', 'p1#s1|p3#s1', 'p2#s1|p3#s1']));

  // Discovery is a plain record. A line with no chain fields cannot be mistaken for a canonical one.
  for (const l of readDiscovery(discovery.file)) assert.ok(!('hash' in l) && !('prev' in l));
  assert.throws(() => readFileSync(path.join(dir, 'studio.jsonl'), 'utf8'), 'COMPARE must not touch the chain');
});

test('a sketch that would not draw is in the comparisons and in the ranking, and can win', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compare-refused-'));
  const discovery = new DiscoveryLog(dir);
  const problems = [problem('p1', 0.6), problem('p2', 0.3), problem('p3', 0.1)];
  const sketches = [drawn('p1', 0, 'ruled lines'), refused('p2', 0, 'one dense corner'), drawn('p3', 0, 'nothing in the middle')];

  // The artist prefers the sketch that would not draw, which the old phase could not have offered it.
  const policy = new CompareStub({ prefer: (a, b) => (a === 'p2#s1' ? a : b === 'p2#s1' ? b : a) });
  const out = await compare(policy, discovery, newSpend(), COMMISSION, problems, sketches, 7);

  const undrawn = out.ranking.find((r) => r.key === 'p2#s1');
  assert.ok(undrawn, 'the sketch that failed is in the ranking rather than silently dropped');
  assert.equal(undrawn.drawn, false);
  assert.equal(undrawn.failure, 'every edit was refused');
  assert.equal(undrawn.comparisons, 2, 'it was compared like any other sketch');
  assert.equal(undrawn.wins, 2);
  assert.equal(out.ranking[0]!.key, 'p2#s1', 'and it can come out on top');

  // It was named in the pairwise observations, not merely counted afterwards.
  const pairCalls = policy.requests.filter((r) => r.name === 'compare-pairwise');
  const about = pairCalls.filter((r) => r.observation.includes('p2#s1'));
  assert.equal(about.length, 2);
  for (const r of about) assert.match(r.observation, /NOT DRAWN — every edit was refused/);
  // And exactly one picture went with those calls, since only one of the two was drawn.
  for (const r of about) assert.equal(r.images?.length, 1);

  // The count of what did not draw is on its own discovery line, because that is the number the
  // phase this replaces threw away.
  const note = readDiscovery(discovery.file).find((l) => l.kind === 'note') as { data: { notDrawn: unknown[] } };
  assert.equal(note.data.notDrawn.length, 1);
});

test('ties break on a hash of the sketch identity, not on the order the sketches arrived in', () => {
  const cards = [card('p1#s1'), card('p2#s2'), card('p3#s3')];
  // A cycle: every sketch wins exactly once, so the win counts decide nothing at all.
  const cycle: Pairwise[] = [
    { a: 'p1#s1', b: 'p2#s2', winner: 'p1#s1', why: 'x' },
    { a: 'p2#s2', b: 'p3#s3', winner: 'p2#s2', why: 'x' },
    { a: 'p1#s1', b: 'p3#s3', winner: 'p3#s3', why: 'x' },
  ];
  const ranked = rank(cards, cycle);
  for (const r of ranked) assert.equal(r.wins, 1, 'the tie is a real tie');

  const byHash = [...cards.map((c) => c.key)].sort((x, y) => contentHash(x).localeCompare(contentHash(y)));
  assert.deepEqual(ranked.map((r) => r.key), byHash);

  // Stable but not the array order: feeding the same tie in reverse produces the same ranking, and
  // the winner is not simply whichever sketch happened to be first.
  const reversed = rank([...cards].reverse(), cycle);
  assert.deepEqual(reversed.map((r) => r.key), ranked.map((r) => r.key));
  assert.notEqual(ranked[0]!.key, cards[0]!.key);
});

test('choosing the problem you weighted highest owes no account', () => {
  const problems = [problem('p1', 0.6), problem('p2', 0.3), problem('p3', 0.1)];
  const a = answersToRanking(commitment(['p1#s1'], null), problems);
  assert.deepEqual(a.topRanked, ['p1']);
  assert.equal(a.owed, false);
  assert.equal(a.given, false);

  // A series that includes the top-ranked problem has not abandoned it either.
  assert.equal(answersToRanking(commitment(['p1#s1', 'p3#s2'], null), problems).owed, false);
});

test('choosing a low-weighted problem owes an account, and a bare assertion is not one', () => {
  const problems = [problem('p1', 0.6), problem('p2', 0.3), problem('p3', 0.1)];

  const silent = answersToRanking(commitment(['p3#s1'], null), problems);
  assert.equal(silent.owed, true);
  assert.equal(silent.given, false, 'no reason at all is caught');

  const empty = answersToRanking(commitment(['p3#s1'], '   '), problems);
  assert.equal(empty.given, false, 'whitespace is not a reason');

  const restated = answersToRanking(commitment(['p3#s1'], 'On reflection this problem is simply the stronger one.'), problems);
  assert.equal(restated.owed, true);
  assert.equal(restated.given, false, 'a reason that never mentions the sketches does not answer');

  const real = answersToRanking(
    commitment(['p3#s1'], 'The sketch for p3 put the weight where I did not expect it and the other two did not.'),
    problems
  );
  assert.equal(real.given, true);
  assert.equal(real.reason?.startsWith('The sketch'), true);

  // Naming a survivor key counts as pointing at a sketch even without the word.
  assert.equal(answersToRanking(commitment(['p3#s1'], 'p3#s1 refused to go down on the sheet, and that is the point.'), problems).given, true);
});

test('a run with no weights anywhere has no ranking to be answerable to', () => {
  const bare: Problem[] = [
    { id: 'p1', text: 'a', tension: { between: 'x', and: 'y', claim: 'z' }, fieldRefs: [] },
    { id: 'p2', text: 'b', tension: { between: 'x', and: 'y', claim: 'z' }, fieldRefs: [] },
  ];
  const a = answersToRanking(commitment(['p2#s1'], null), bare);
  assert.deepEqual(a.topRanked, [], 'an absent weight is not a weight of zero');
  assert.equal(a.owed, false);
});

test('the account is asked for when it is owed, and only then', async () => {
  const problems = [problem('p1', 0.6), problem('p2', 0.3), problem('p3', 0.1)];
  const sketches = [drawn('p1', 0, 'ruled lines'), drawn('p2', 0, 'one dense corner'), drawn('p3', 0, 'nothing in the middle')];

  const low = new CompareStub({ keep: (keys) => [keys.find((k) => k.startsWith('p3')) as string] });
  const owed = await compare(low, new DiscoveryLog(mkdtempSync(path.join(tmpdir(), 'compare-owed-'))), newSpend(), COMMISSION, problems, sketches, 7);
  assert.deepEqual(owed.commitment.problemIds, ['p3']);
  assert.equal(owed.rankingAnswer.owed, true);
  assert.equal(owed.rankingAnswer.given, true, 'the follow-up call makes the requirement real rather than decorative');
  assert.ok(owed.commitment.whyTheSketchesChangedMyMind);
  assert.equal(low.requests.filter((r) => r.name === 'compare-account').length, 1);

  // The account call is shown the ranking it is answering to and the sketches, not just its own words.
  const account = low.requests.find((r) => r.name === 'compare-account')!;
  assert.match(account.observation, /HOW YOU WEIGHTED THESE PROBLEMS/);
  assert.match(account.observation, /p3#s1/);

  const top = new CompareStub({ keep: (keys) => [keys.find((k) => k.startsWith('p1')) as string] });
  const clear = await compare(top, new DiscoveryLog(mkdtempSync(path.join(tmpdir(), 'compare-top-'))), newSpend(), COMMISSION, problems, sketches, 7);
  assert.equal(clear.rankingAnswer.owed, false);
  assert.equal(top.requests.filter((r) => r.name === 'compare-account').length, 0, 'no account is extracted when none is owed');
});

test('a series survives, and the survivors keep their place in the ranking', async () => {
  const problems = [problem('p1', 0.6), problem('p2', 0.3), problem('p3', 0.1)];
  const sketches = [drawn('p1', 0, 'ruled lines'), drawn('p1', 1, 'the same but heavier'), drawn('p2', 0, 'one dense corner')];
  const policy = new CompareStub({ keep: (keys) => keys.slice(0, 2) });
  const out = await compare(policy, new DiscoveryLog(mkdtempSync(path.join(tmpdir(), 'compare-series-'))), newSpend(), COMMISSION, problems, sketches, 7);

  assert.equal(out.survivors.length, 2);
  assert.deepEqual(out.survivors.map((s) => s.key), out.ranking.filter((r) => out.commitment.survivors.includes(r.key)).map((r) => r.key));
  assert.equal(out.ranking.length, 3, 'the ranking still holds every sketch, kept or not');
});

test('the pair selection is capped, seeded, and leaves no sketch uncompared', () => {
  // Nine sketches is 36 pairs; the cap holds it to twelve and every sketch is still in one.
  const pairs = pairsFor(9, 7, 12);
  assert.equal(pairs.length, 12);
  const seen = new Set(pairs.flat());
  assert.equal(seen.size, 9, 'a sketch nobody compared would be indistinguishable from one that lost');
  assert.deepEqual(pairsFor(9, 7, 12), pairs, 'the same seed asks the same questions');
  assert.notDeepEqual(pairsFor(9, 8, 12), pairs, 'a different seed asks different ones');

  // Under the cap it is a plain round-robin and nothing is sampled.
  assert.equal(pairsFor(4, 7, 12).length, 6);
  assert.equal(pairsFor(1, 7, 12).length, 0);
});
