// DIVERGE, with a policy that can only cut lenses it was actually shown.
//
// The stub is not the shared `StubPolicy`. It reads the problem ids out of the first observation and
// the lens ids out of the second, and answers with those. That is the point rather than a
// convenience: the failure this phase can have without anyone noticing is a cut list that does not
// line up with the proposal — ids invented at review time, or lenses that quietly vanish between the
// two calls — and a stub answering with ids baked into this file would pass while proving that the
// two halves never had to agree.
//
// The stub also does two things a real model does and a well-behaved stub would not. It repeats a
// lens id, because ids are the join key for the whole phase and a repeat would silently merge two
// proposals into one. And it names only some of the losers in its cut list, because the property the
// brief actually asks for is that every death carries a reason, which is a claim about the lenses
// the artist forgot as much as the ones it argued about.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newSpend } from '../call.js';
import { DiscoveryLog, readDiscovery } from '../discovery-log.js';
import { loadCommission } from '../field.js';
import { diverge, emergentStructureFailures, KEEP_DEFAULT, MIN_LENSES, type DivergeLens } from '../phases/diverge.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';
import type { Problem } from '../types.js';

/** How many lens objects the stub emits, one of which repeats an id it has already used. */
const EMITTED = 23;
/** Losers the stub deliberately says nothing about, so reconciliation has something to reconcile. */
const UNMENTIONED = 2;

const PROBLEMS: Problem[] = [
  {
    id: 'sealed-record',
    text: 'The material cannot be shown and the piece still has to be about what is in it.',
    tension: { between: 'the embargo', and: 'the wish to be legible', claim: 'one of them has to give' },
    fieldRefs: ['a line from the field'],
    probability: 0.55,
  },
  {
    id: 'nobody-waiting',
    text: 'Fifty years means the first honest viewer is not alive yet, and neither is the work.',
    tension: { between: 'now', and: 'the reader in 2076', claim: 'the surface has to survive both' },
    fieldRefs: ['another line'],
    probability: 0.31,
  },
  {
    id: 'hand-of-the-clerk',
    text: 'Somebody filed this, and the filing is the only thing about it anyone can see.',
    tension: { between: 'the clerk', and: 'the author', claim: 'the clerk wins by default' },
    fieldRefs: ['a third line'],
    // No probability on purpose: an absent weight must print as unranked, never as a confident zero.
  },
];

/** Problem ids as the observation printed them. `  [id] (…)`. */
function problemIdsShown(observation: string): string[] {
  return [...observation.matchAll(/^ {2}\[([a-z][a-z0-9-]*)\] \(/gm)].map((m) => m[1] as string);
}

/** Lens ids as the observation printed them. `  [l4] on …`. */
function lensIdsShown(observation: string): string[] {
  return [...observation.matchAll(/^ {2}\[(l[0-9]+)\] on /gm)].map((m) => m[1] as string);
}

class DivergeStub implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly requests: PolicyRequest[] = [];

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
    if (request.name === 'diverge-propose') {
      const problems = problemIdsShown(request.observation);
      assert.ok(problems.length > 0, 'the propose observation named the problems');
      const lenses = Array.from({ length: EMITTED }, (_, i) => {
        // The last one repeats l1's id. Everything else about it differs, so a phase that kept both
        // would end up with two lenses answering to one name.
        const id = i === EMITTED - 1 ? 'l1' : `l${i + 1}`;
        const claim = `In ${['bookbinding', 'drainage', 'crowd control', 'cold storage'][i % 4]}, number ${i}, a thing is true before anybody arrives.`;
        return {
          id,
          problem: problems[i % problems.length] as string,
          source: `m${(i % 6) + 1}`,
          sourceClaim: claim,
          lens: `Look at the problem the way that trade looks at its own materials, number ${i}.`,
          // Lens 3 hands back its own input as the emergent sentence. It stays in the record; the
          // checker is expected to name it rather than the phase to drop it.
          emergent: i === 2 ? claim : `Only together do they make it true that number ${i} cannot be undone once the sheet is ruled.`,
        };
      });
      return { lenses };
    }
    const shown = lensIdsShown(request.observation);
    assert.ok(shown.length >= MIN_LENSES, 'the cut observation printed the whole proposal');
    const keep = shown.slice(0, KEEP_DEFAULT);
    const losers = shown.slice(KEEP_DEFAULT, shown.length - UNMENTIONED);
    return {
      keep,
      cut: losers.map((id) => ({ id, reason: `${id}: the emergent sentence survives deleting the source, so nothing was built.` })),
    };
  }
}

test('emergentStructureFailures catches the degenerate cases and nothing else', () => {
  const lens = (over: Partial<DivergeLens>): DivergeLens => ({
    id: 'l0',
    problem: 'sealed-record',
    source: 'm1',
    sourceClaim: 'A ruled margin exists before anyone knows what will be written in it.',
    lens: 'Read the archive as a sheet that was ruled before it was filled.',
    emergent: 'Only together is it true that the shape is committed to before the content is.',
    ...over,
  });

  const good = lens({ id: 'l1' });
  const empty = lens({ id: 'l2', emergent: '   ' });
  const restates = lens({ id: 'l3', emergent: '  A ruled margin exists before anyone knows what will be written in it.  ' });
  const echoesLens = lens({ id: 'l4', emergent: 'Read the archive as a sheet that was ruled before it was filled' });
  const dupeA = lens({ id: 'l5', emergent: 'The same sentence twice over.' });
  const dupeB = lens({ id: 'l6', emergent: 'the same sentence twice over' });

  const failed = emergentStructureFailures([good, empty, restates, echoesLens, dupeA, dupeB]);
  assert.deepEqual(
    failed.map((l) => l.id),
    ['l2', 'l3', 'l4', 'l6'],
    'the first of a duplicated pair survives; the second is the copy'
  );
});

test('DIVERGE proposes twenty-plus, cuts most, and loses none of them', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'diverge-'));
  const discovery = new DiscoveryLog(dir);
  const policy = new DivergeStub();
  const spend = newSpend();
  const result = await diverge(
    policy,
    discovery,
    spend,
    loadCommission('interference', 'fifty-year-embargo'),
    PROBLEMS,
    null,
    7
  );

  assert.deepEqual(
    policy.requests.map((r) => r.name),
    ['diverge-propose', 'diverge-cut']
  );
  assert.equal(spend.policyCalls, 2);

  // The floor the brief sets, and the repeated id did not become a second lens.
  assert.ok(result.proposed.length >= MIN_LENSES, `${result.proposed.length} lenses proposed`);
  assert.equal(result.proposed.length, EMITTED - 1, 'the duplicate id was dropped, not merged');
  const proposedIds = result.proposed.map((l) => l.id);
  assert.equal(new Set(proposedIds).size, proposedIds.length, 'every proposed lens has its own id');

  // Most of them die. That is the phase working, not the phase failing.
  assert.ok(result.cut.length > result.proposed.length / 2, `${result.cut.length} of ${result.proposed.length} cut`);
  assert.ok(result.kept.length <= KEEP_DEFAULT && result.kept.length > 0, `${result.kept.length} kept`);

  // Kept plus cut is exactly the proposal: nothing lost, nothing counted twice.
  const accounted = [...result.kept.map((l) => l.id), ...result.cut.map((c) => c.lens.id)];
  assert.equal(accounted.length, result.proposed.length);
  assert.deepEqual([...accounted].sort(), [...proposedIds].sort());

  // Every death carries a reason, including the ones the artist never mentioned.
  for (const c of result.cut) assert.ok(c.reason.trim().length > 0, `${c.lens.id} was cut for a stated reason`);
  const forgotten = result.cut.filter((c) => c.reason === 'not named when the artist reviewed its own list');
  assert.equal(forgotten.length, UNMENTIONED, 'a lens the artist skipped is still cut, and still on the record');

  // The lens that handed back its own input is reported, and is still in the proposal.
  assert.deepEqual(result.degenerate.map((l) => l.id), ['l3']);
  assert.ok(proposedIds.includes('l3'), 'a degenerate lens is recorded, not silently dropped');

  // The record. Every proposal, every death with its reason, every survivor.
  const lines = readDiscovery(discovery.file);
  const proposedLines = lines.filter((l) => l.kind === 'lens-proposed');
  assert.deepEqual(proposedLines.map((l) => (l.data as DivergeLens).id), proposedIds);
  const cutLines = lines.filter((l) => l.kind === 'lens-cut');
  assert.equal(cutLines.length, result.cut.length);
  for (const l of cutLines) {
    const d = l.data as { lens: DivergeLens; reason: string };
    assert.ok(d.reason.trim().length > 0, `${d.lens.id} was logged with a reason`);
    assert.ok(d.lens.emergent.length > 0, 'the cut record holds the whole lens, not just its id');
  }
  assert.equal(lines.filter((l) => l.kind === 'lens-kept').length, result.kept.length);

  // Discovery is not the chain and must never look like it.
  for (const l of lines) assert.ok(!('hash' in l) && !('prev' in l), 'discovery lines carry no chain');
  assert.equal(lines.filter((l) => l.kind === 'policy-call').length, 2);

  // And nothing was written beside it. DIVERGE must not have touched the hash-chained trajectory.
  assert.throws(() => readFileSync(path.join(dir, 'studio.jsonl'), 'utf8'));
});

test("the artist's own problem ranking is on the page when it widens and when it cuts", async () => {
  const policy = new DivergeStub();
  await diverge(
    policy,
    new DiscoveryLog(mkdtempSync(path.join(tmpdir(), 'diverge-rank-'))),
    newSpend(),
    loadCommission('interference', 'fifty-year-embargo'),
    PROBLEMS,
    null,
    7
  );
  for (const r of policy.requests) {
    assert.match(r.observation, /you weighted this 55%/);
    assert.match(r.observation, /you weighted this 31%/);
    // The problem FIND gave no weight prints as unranked. Reading an absent field as zero would tell
    // the artist it had ruled a problem out when it had said nothing about it at all.
    assert.match(r.observation, /\[hand-of-the-clerk\] \(unranked\)/);
  }
});
