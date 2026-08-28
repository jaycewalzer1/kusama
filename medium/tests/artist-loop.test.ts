// The whole loop, end to end, with the model unplugged.
//
// This is the test the eight gates hang off. It runs a real trajectory — real renders, real edits
// through the real validator, real constraint checks — with a scripted policy, and then does to it
// the three things the brief says must be possible: replay it, rescore it offline, and show that the
// environment never saw the artist's plan.
//
// It renders, so it is the slowest test in the repo by a wide margin. One trajectory, one sketch per
// problem, four steps. That is the smallest configuration that still exercises every branch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTrajectory } from '../artist/run.js';
import { replay } from '../artist/replay.js';
import { recomputeMatches } from '../artist/reward.js';
import { readLog, verifyChain } from '../artist/studio-log.js';
import { sftLines } from '../artist/export.js';
import { strip } from '../artist/grid.js';
import { StubPolicy, installStubEnvModel } from './artist-stub.js';
import type { Trajectory } from '../artist/types.js';

const OUT = mkdtempSync(path.join(tmpdir(), 'artist-loop-'));
const CELL = path.join(OUT, 'cell');

let trajectory: Trajectory;
let envRequests: ReturnType<typeof installStubEnvModel>['requests'];

test('the loop runs a whole trajectory: find, sketch, choose, make, examine, finish', async () => {
  const stub = installStubEnvModel();
  envRequests = stub.requests;
  const policy = new StubPolicy(4);
  trajectory = await runTrajectory({
    policy,
    positionId: 'generation-loss',
    briefId: 'arches-eviction',
    deliverableId: 'poster',
    seed: 4242,
    outDir: CELL,
    maxSteps: 6,
    sketchesPerProblem: 1,
    useAudience: true,
  });

  assert.equal(trajectory.outcome, 'finished');
  assert.equal(trajectory.problems.length, 3, 'FIND ran and produced its problems');
  assert.equal(trajectory.sketches.length, 3, 'one sketch per problem, all of which rendered');
  assert.equal(trajectory.chosen?.problemId, 'p-date');
  assert.ok(trajectory.steps.length >= 4, 'MAKE took steps');
  assert.ok(trajectory.examine, 'EXAMINE ran');

  // The phases happened in the order the design insists on, and only once each.
  const names = policy.calls.filter((c) => c !== 'sketch' && c !== 'act' && c !== 'replan');
  assert.deepEqual(names, ['find', 'choose', 'examine']);
  assert.ok(policy.calls.indexOf('sketch') > policy.calls.indexOf('find'));
  assert.ok(policy.calls.indexOf('choose') > policy.calls.lastIndexOf('sketch'));

  assert.ok(existsSync(path.join(CELL, 'final.png')));
  assert.ok(existsSync(path.join(CELL, 'final.json')));
  assert.ok(existsSync(path.join(CELL, 'scores.json')));
  assert.ok(existsSync(path.join(CELL, 'sketches', 'contact.png')));
});

test('an illegal edit is refused, costs the artist nothing else, and is on the record', () => {
  const refusals = readLog(path.join(CELL, 'studio.jsonl')).filter((l) => l.kind === 'edit-refused');
  assert.ok(refusals.length >= 1, 'the scripted bad edit was refused');
  const step0 = trajectory.steps[0]!;
  assert.ok(step0.accepted, 'the legal edit in the same step still landed');
  assert.deepEqual(step0.appliedActionIds, ['a0']);
});

// The scripted bad edit names a parent that is not in the tree, which is the artist's mistake and
// not a cap. It has to land in `structural` and nowhere else, or the one distinction the split
// exists to make is not being made.
test('the refusal is filed under its cause, and the causes are not summed', () => {
  assert.deepEqual(trajectory.scores.refusals, { budget: 0, capability: 0, structural: 1 });
  const refused = trajectory.steps.flatMap((s) => s.refused);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.actionId, 'a0-bad');
  assert.equal(refused[0]!.cause, 'structural');
  assert.match(refused[0]!.reason, /nowhere/);
});

test('the run stopped because the artist said so, and the record says whether that was earned', () => {
  const t = trajectory.scores.termination;
  assert.equal(t.kind, 'declared-finished');
  assert.equal(trajectory.steps[trajectory.steps.length - 1]!.action.control, 'finished');
  // Whatever this particular stub run realizes, the legitimacy of the stop is decidable from the
  // two numbers beside it and nothing else — no model, no prose.
  assert.equal(t.unrealizedEdges.length, t.edgesUnrealized);
  assert.equal(
    t.legitimate,
    !t.pendingCapExceeded &&
      (t.edgesUnrealized === 0 || (t.edgesUnrealized === 1 && t.declaredUnrealizable === t.unrealizedEdges[0]))
  );
  // The stub's plan is one `aligned-to` and one `contradicts`, so half of it is unjudgeable and it
  // does not get to finish. Nothing was left undone — `edgesUnrealized` is 0 — which is precisely
  // the shape the cap exists to catch, caught here on a whole trajectory rather than a unit fixture.
  assert.equal(t.pendingRate, 0.5);
  assert.equal(t.pendingCapExceeded, true);
  assert.equal(t.edgesUnrealized, 0);
  assert.equal(t.legitimate, false);
});

test('the risk move is recorded once, where the artist declared it', () => {
  const risky = trajectory.steps.filter((s) => s.isRiskMove);
  assert.equal(risky.length, 1);
  assert.equal(trajectory.scores.riskMoveTaken, true);
  assert.ok(trajectory.scores.riskConvention?.includes('date'));
  // MUST STAY FLAT: this run declares a risk in CHOOSE and then takes it in a step, so the new
  // declaration number adds a fact and moves neither of the two outcome numbers above it.
  assert.equal(trajectory.scores.riskDeclared, true);
});

test('the log chain is whole and every policy call is in it with its observation', () => {
  const lines = readLog(path.join(CELL, 'studio.jsonl'));
  assert.deepEqual(verifyChain(lines), []);
  const calls = lines.filter((l) => l.kind === 'policy-call');
  assert.equal(calls.length, trajectory.cost.policyCalls);
  for (const call of calls) {
    const data = call.data as { observation: string; schema: object; observationHash: string };
    assert.ok(data.observation.length > 0, 'the whole observation is logged, not a hash of it');
    assert.ok(data.schema);
    assert.ok(data.observationHash);
  }
});

test('gate 1: the trajectory replays exactly, with no model and no divergence', async () => {
  installStubEnvModel();
  const result = await replay(CELL, path.join(OUT, 'replayed'));
  assert.deepEqual(result.envDrift, [], 'a run made moments ago is in the environment that made it');
  assert.deepEqual(result.chainProblems, []);
  assert.deepEqual(result.observationMismatches, [], 'every observation rebuilt byte for byte');
  assert.deepEqual(result.differences, []);
  assert.equal(result.finalHash.original, result.finalHash.replayed);
  assert.equal(result.ok, true);
});

test('gate 2: scores.json rebuilds exactly from the log alone', async () => {
  const result = await recomputeMatches(CELL);
  assert.deepEqual(result.differences, []);
  assert.equal(result.ok, true);
});

test('gate 6: the environment never saw the position, the brief, the plan or the mood', () => {
  assert.ok(envRequests.length > 0);
  // The forbidden strings are the actual contents of this trajectory, not generic words: a prompt
  // that says "do not guess the purpose" is not a leak, and a test that cannot tell the difference
  // would be tuned away the first time it fired.
  const forbidden = [
    trajectory.positionId,
    trajectory.briefId,
    trajectory.intention0.purpose,
    trajectory.intention0.tension.claim,
    ...trajectory.intention0.elements.map((e) => e.role),
    ...trajectory.problems.map((p) => p.text),
    String(trajectory.scores.affectTrace[0]?.arousal),
  ];
  for (const request of envRequests) {
    if (request.name !== 'describe' && request.name !== 'audience') continue;
    const seen = `${request.system}\n${request.text}`.toLowerCase();
    for (const secret of forbidden) {
      assert.ok(!seen.includes(secret.toLowerCase()), `${request.name} was shown "${secret}"`);
    }
  }
  // AUDIENCE is allowed exactly one thing beyond the pixels: the field's watching paragraph.
  const audience = envRequests.find((r) => r.name === 'audience');
  assert.ok(audience?.text.includes('joiner of fifty-two'), 'the audience is the person the field named');
  assert.ok(audience?.imageBase64, 'and it is looking at the image');
  const describe = envRequests.find((r) => r.name === 'describe');
  assert.ok(describe?.imageBase64);
  assert.ok(describe!.text.length < 200, 'DESCRIBE is handed a picture and one sentence of instruction');
});

test('export writes one chat-format example per successful policy call', () => {
  const { lines, dropped } = sftLines(CELL);
  assert.equal(dropped, 0);
  assert.equal(lines.length, trajectory.cost.policyCalls);
  for (const line of lines) {
    assert.deepEqual(line.messages.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.ok(line.messages[1]!.content.length > 100);
    assert.doesNotThrow(() => JSON.parse(line.messages[2]!.content));
    // Images are referenced, never inlined: a base64 PNG in an SFT file makes it unusable.
    assert.ok(!line.messages[1]!.content.includes('base64'));
  }
  assert.ok(lines.some((l) => l.meta.hadImages), 'CHOOSE and EXAMINE are marked as having had a picture');
});

test('the strip shows every plate the trajectory stood on, from the cache', () => {
  const s = strip(CELL);
  assert.ok(s.png, 'the plates are still in the render cache');
  assert.ok(s.frames >= 4, `expected a frame per accepted step, got ${s.frames}`);
});

test('scores.json is the same object the trajectory reports', () => {
  const written = JSON.parse(readFileSync(path.join(CELL, 'scores.json'), 'utf8'));
  assert.deepEqual(written, trajectory.scores);
  assert.equal(trajectory.scores.problemsGrounded >= 0, true);
  assert.equal(trajectory.scores.realization.judgePending, 1, 'the contradicts edge was never guessed at');
});
