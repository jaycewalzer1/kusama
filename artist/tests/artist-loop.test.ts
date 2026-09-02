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
import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTrajectory } from '../run.js';
import { INERT_THRESHOLD } from '../env.js';
import { replay } from '../replay.js';
import { recomputeMatches } from '../reward.js';
import { readLog, verifyChain } from '../studio-log.js';
import { sftLines } from '../export.js';
import { strip } from '../grid.js';
import { StubPolicy, installStubEnvModel } from './artist-stub.js';
import type { Trajectory } from '../types.js';

const OUT = mkdtempSync(path.join(tmpdir(), 'artist-loop-'));
const CELL = path.join(OUT, 'cell');

let trajectory: Trajectory;
let envRequests: ReturnType<typeof installStubEnvModel>['requests'];

test('the loop runs a whole trajectory: find, sketch, choose, make, examine, finish', async () => {
  // Make the new evidence genuinely fail. The trajectory already has other blockers, but the log
  // assertion below proves this answer crossed the env-call -> gate boundary instead of decorating
  // an unused field.
  const stub = installStubEnvModel({ rubricVerdict: 'fails' });
  envRequests = stub.requests;
  const policy = new StubPolicy(4);
  trajectory = await runTrajectory({
    policy,
    positionId: 'withheld',
    briefId: 'two-million-slips',
    seed: 4242,
    outDir: CELL,
    maxSteps: 6,
    sketchesPerProblem: 1,
    useAudience: true,
  });

  // `unresolved`, not `finished`. This stub asks to stop twice and is refused twice — see the
  // EXAMINE assertion below — so it never earned the stop. `finished` used to be the initial value
  // that anything short of `abandon` kept, which is how a blocked run came to report the same
  // outcome as a granted one while `termination.legitimate` underneath it read false.
  assert.equal(trajectory.outcome, 'unresolved');
  assert.equal(trajectory.scores.termination.kind, 'finish-blocked');
  assert.equal(trajectory.problems.length, 3, 'FIND ran and produced its problems');
  assert.equal(trajectory.sketches.length, 3, 'one sketch per problem, all of which rendered');
  assert.equal(trajectory.chosen?.problemId, 'p-date');
  assert.ok(trajectory.steps.length >= 4, 'MAKE took steps');
  assert.ok(trajectory.examine, 'EXAMINE ran');

  // The phases happened in the order the design insists on. EXAMINE runs once per ask to finish —
  // this stub asks twice and is refused twice — because the gate needs the artist's own reading of
  // the picture before it can decide whether the artist may stop looking at it.
  const names = policy.calls.filter((c) => c !== 'sketch' && c !== 'act' && c !== 'replan' && c !== 'propose');
  assert.deepEqual(names, ['find', 'choose', 'examine', 'examine']);
  assert.ok(policy.calls.indexOf('sketch') > policy.calls.indexOf('find'));
  assert.ok(policy.calls.indexOf('choose') > policy.calls.lastIndexOf('sketch'));

  const rubricCalls = envRequests.filter((r) => r.name === 'rubric');
  const rubricResults = trajectory.steps[trajectory.steps.length - 1]!.look.checkReport.results.filter(
    (r) => r.kind === 'rubric'
  );
  // Counted off the position rather than hard-coded, because the number of hard rubrics is exactly
  // what the constraint-budget rewrite moves: what used to be a hard tree constraint nobody could
  // see is now a question a reader answers, and `withheld` gained one that way. What has to stay
  // true is the ratio — every hard rubric read once per finish attempt, and no call bought by a
  // soft one.
  const hard = rubricResults.filter((r) => r.severity === 'hard');
  const soft = rubricResults.filter((r) => r.severity === 'soft');
  assert.ok(hard.length >= 1 && soft.length >= 1, 'the position has both kinds, or this proves nothing');
  assert.equal(rubricCalls.length, hard.length * 2, 'every hard rubric was read once per finish attempt');
  assert.ok(rubricCalls.every((r) => r.imageBase64), 'the rubric reader looked at the plate');
  for (const h of hard) {
    assert.equal(
      rubricCalls.filter((r) => r.text.includes(h.rubric!)).length,
      2,
      `the hard rubric ${h.id} reached the reader on both attempts`
    );
  }
  for (const s of soft) {
    assert.ok(rubricCalls.every((r) => !r.text.includes(s.rubric!)), 'a soft rubric did not buy an unused call');
  }
  assert.ok(rubricCalls.every((r) => !r.text.includes('withheld')), 'the rubric reader was not told the position id');

  const gateNotes = readLog(path.join(CELL, 'studio.jsonl')).filter(
    (line) => line.kind === 'note' && (line.data as { phase?: string }).phase === 'finish-gate'
  );
  assert.equal(gateNotes.length, 2);
  assert.ok(
    gateNotes.every((line) =>
      ((line.data as { blockers: string[] }).blockers ?? []).some((b) => b.startsWith('[rubric-fails]'))
    ),
    'the failing rubric became a finish blocker on every attempt'
  );

  // One PROPOSE per problem drawn, and every one of them before any sketching. The count is the
  // check that matters: a PROPOSE per *sketch* would be the same call made three times over and
  // would put the three sketches back on three independent draws, which is what it exists to stop.
  assert.equal(policy.calls.filter((c) => c === 'propose').length, trajectory.problems.length);
  assert.ok(policy.calls.indexOf('propose') < policy.calls.indexOf('sketch'));

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

// The stub leaves several of the position's hard constraints violated — nothing covered, nothing
// sealed, too few opaque marks — and used to be recorded as having finished anyway. That is
// the failure the gate exists for, so this test now asserts the refusal: the artist said `finished`,
// the environment said no twice, and the stop is on the record as not made.
test('the run stopped because the artist said so, and the record says whether that was earned', () => {
  const t = trajectory.scores.termination;
  assert.equal(t.kind, 'finish-blocked');
  assert.equal(trajectory.scores.finishRefusals, 2);
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

  // And therefore there is no summary score. This is the assertion that would have failed on the
  // two real runs on disk: `out/openai-withheld/final.json` reports `tree: 1, render: 1` — a
  // perfect sheet — beside this same `legitimate: false`, a self-score of 4, and six planned
  // relations that did not hold. The constraints those means are taken over are almost all node
  // counts, so they saturate as soon as the counting rules are met and say nothing about whether
  // the run finished anything.
  //
  // The counts below are deliberately still asserted present. Nulling the means withdraws a claim;
  // it does not withdraw a measurement, and a reader who wants the detail still has all of it.
  assert.equal(trajectory.scores.tree, null, 'a run that did not earn its stop reported a tree score');
  assert.equal(trajectory.scores.render, null, 'a run that did not earn its stop reported a render score');
  assert.equal(typeof trajectory.scores.hardViolations, 'number');
  assert.equal(typeof trajectory.scores.softViolations, 'number');
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

// The default arm is sighted, so this run's rate is 1. Worth asserting on a whole trajectory rather
// than only on the fold: the number has to survive the trip through `env.step` and out to the log,
// and the fold was never the part at risk.
test('the run records whether the artist could see the sheet it was editing', () => {
  assert.equal(trajectory.scores.canvasVisibleRate, 1);
  assert.ok(trajectory.steps.every((s) => s.sawCanvas));
  // Not a second copy of the same flag. There is no change image before the first kept step, so a
  // sighted run's change rate is strictly below its canvas rate.
  assert.equal(trajectory.steps[0]!.sawChange, false);
  assert.ok(trajectory.scores.changeVisibleRate! < 1);

  const steps = readLog(path.join(CELL, 'studio.jsonl')).filter((l) => l.kind === 'step');
  assert.ok(steps.length > 0);
  assert.ok(steps.every((l) => (l.data as { sawCanvas?: unknown }).sawCanvas === true));
});

// Every accepted step in this run repaints a visible chunk of the sheet, so the count is 0 — but it
// is 0 and not null, which is the assertion. The distinction is the whole rule: a run that was
// measured and found nothing has to be legible apart from a run that was never measured, or the
// corpus collected before the threshold existed reads as a corpus with no reward hacking in it.
test('every kept step is checked against the page, and a measured run reports a number not a null', () => {
  assert.equal(trajectory.scores.inertSteps, 0);
  for (const step of trajectory.steps.filter((s) => s.accepted)) {
    assert.equal(typeof step.inert, 'boolean', `step ${step.k} was kept and not asked whether it showed`);
    assert.equal(step.inert, step.pixelsMoved < INERT_THRESHOLD);
  }
});

// MUST MOVE, and the only fixture that can show it: the two arms are a property of the whole loop,
// not of any function in it. A second trajectory is expensive, but a score that exists so the blind
// arm can never again be invisible has to be shown telling the two arms apart at least once.
test('the blind arm scores differently from the default arm, which is the whole point of the score', async () => {
  const blindCell = path.join(OUT, 'blind');
  installStubEnvModel();
  const blind = await runTrajectory({
    policy: new StubPolicy(4),
    positionId: 'withheld',
    briefId: 'two-million-slips',
    seed: 4242,
    outDir: blindCell,
    maxSteps: 6,
    sketchesPerProblem: 1,
    useAudience: true,
    showCanvas: false,
  });
  assert.equal(blind.scores.canvasVisibleRate, 0);
  assert.equal(blind.scores.changeVisibleRate, 0);
  assert.ok(blind.steps.every((s) => !s.sawCanvas));
  assert.notEqual(blind.scores.canvasVisibleRate, trajectory.scores.canvasVisibleRate);
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
  installStubEnvModel({ rubricVerdict: 'fails' });
  const result = await replay(CELL, path.join(OUT, 'replayed'));
  assert.deepEqual(result.envDrift, [], 'a run made moments ago is in the environment that made it');
  assert.deepEqual(result.chainProblems, []);
  assert.deepEqual(result.observationMismatches, [], 'every observation rebuilt byte for byte');
  assert.deepEqual(result.differences, []);
  assert.equal(result.finalHash.original, result.finalHash.replayed);
  assert.equal(result.ok, true);
});

test('gate 2: scores.json rebuilds exactly from the log alone', async () => {
  // Checked before the comparison, because `deepEqual(null, null)` passes and would report a
  // round trip that never happened. The stub declares moves on the step it asks to finish on, so a
  // null summary here means the record dropped them between the step and the log — which is the
  // one failure gate 2 exists to catch and the one it cannot see by agreeing with itself.
  const summary = trajectory.scores.moves;
  assert.ok(summary, 'the run was asked for epistemic moves and recorded some');
  assert.ok(summary.total > 0);
  assert.ok(summary.grounded < summary.total, 'a ref naming nothing shown is on the record as unfounded');
  assert.ok(summary.pixellessSteps > 0, 'a step that decided something and moved nothing is counted');

  const result = await recomputeMatches(CELL);
  assert.deepEqual(result.differences, []);
  // MUST STAY FLAT. A run recorded by this build has every score the recompute produces, so nothing
  // is new and the union comparison sees exactly what the old one-sided walk saw.
  assert.deepEqual(result.added, []);
  assert.equal(result.unscorable, null);
  assert.equal(result.ok, true);
});

test('a run recorded before a score existed says so instead of reporting exact', async () => {
  // MUST MOVE. The comparison used to walk the written file's keys, so a score added after a run
  // was recorded fell outside it entirely: the run reported `exact` while whole families of numbers
  // went unchecked. Standing in for that here by taking a key away from a copy of a real run.
  const older = path.join(OUT, 'older');
  cpSync(CELL, older, { recursive: true });
  const scores = JSON.parse(readFileSync(path.join(older, 'scores.json'), 'utf8'));
  delete scores.canvasVisibleRate;
  scores.destructionRate = 0.5;
  writeFileSync(path.join(older, 'scores.json'), JSON.stringify(scores, null, 2));

  const result = await recomputeMatches(older);
  assert.equal(result.added.length, 1);
  assert.match(result.added[0]!, /^canvasVisibleRate: not recorded/);
  // A score that did not exist has nothing to disagree with, so it is not a failure — but a score
  // that was recorded and no longer matches still is, and the two are reported apart.
  assert.equal(result.ok, false);
  assert.equal(result.differences.length, 1);
  assert.match(result.differences[0]!, /^destructionRate: recorded 0\.5/);
});

test('a run whose commission has left the catalog is unscorable, not a crash', async () => {
  // Raising here used to kill a whole batch at its first dead run and report nothing about the
  // rest. Being unable to rescore a run is a fact about that run and belongs in its own row.
  const gone = path.join(OUT, 'gone');
  cpSync(CELL, gone, { recursive: true });
  const lines = readFileSync(path.join(gone, 'studio.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => l.replace('"positionId":"withheld"', '"positionId":"a-position-that-was-deleted"'));
  writeFileSync(path.join(gone, 'studio.jsonl'), lines.join('\n') + '\n');

  const result = await recomputeMatches(gone);
  assert.equal(result.ok, false);
  assert.equal(result.scores, null);
  assert.match(result.unscorable!, /a-position-that-was-deleted/);
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
    if (!['describe', 'audience', 'rubric'].includes(request.name)) continue;
    const seen = `${request.system}\n${request.text}`.toLowerCase();
    for (const secret of forbidden) {
      assert.ok(!seen.includes(secret.toLowerCase()), `${request.name} was shown "${secret}"`);
    }
  }
  // AUDIENCE is allowed exactly one thing beyond the pixels: the field's watching paragraph.
  const audience = envRequests.find((r) => r.name === 'audience');
  assert.ok(audience?.text.includes('postgraduate of twenty-four'), 'the audience is the person the field named');
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
