// DEVELOP's one new rule: a branch that keeps changing the program and stops changing the page.
//
// The failure it is against is on disk. In one logged trajectory the blind describer returned the
// same sentence for six consecutive kept steps: the artist was spending steps, the environment was
// accepting them, `standing` was moving because the changes satisfied node-counting constraints, and
// nothing anywhere noticed that a person looking at the sheet could not tell the six apart. That run
// is indistinguishable in the trajectory from one that was developing.
//
// So the trigger is checked here at both levels: the predicate on its own, and the environment
// actually firing it on a run whose describer has stopped saying anything new.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SAME_READ_STEPS, describedTheSame } from '../triggers.js';

test('three kept steps that read the same are a stuck branch; two are not', () => {
  const read = 'A pale sheet with a dark bar across the upper third.';
  assert.equal(describedTheSame([read, read]), null, 'two is one repetition, and models repeat');
  const fired = describedTheSame([read, read, read]);
  assert.ok(fired, 'three in a row is a run');
  assert.equal(fired.trigger, 'description-unchanged');
  assert.equal(fired.usd, 0, 'it costs nothing: both reads were already paid for by observe');
  // The detail has to tell the artist what to do about it, because a replan that only says "stuck"
  // gets a bigger version of the move that was not landing.
  assert.match(fired.detail, /Change/);
  assert.match(fired.detail, /abandon/);
  assert.ok(fired.detail.includes(read), 'and it quotes what the reader keeps saying');
});

test('only the last few reads decide it, so an earlier repeat does not poison the run', () => {
  const a = 'A pale sheet.';
  const b = 'A pale sheet with a red bar.';
  assert.ok(describedTheSame([a, a, a]), 'the window is the tail');
  assert.equal(describedTheSame([a, a, a, b]), null, 'one new read clears it');
  assert.equal(describedTheSame([a, a, b, a]), null);
});

test('the comparison ignores whitespace, case and punctuation and nothing else', () => {
  assert.ok(describedTheSame(['A pale sheet.', 'a  pale   sheet', 'A PALE SHEET']));
  // The gap this leaves, stated as a test rather than left to a comment: a describer that says the
  // same thing in different words is not caught, and that is a floor, not a filter.
  assert.equal(describedTheSame(['A pale sheet.', 'A sheet that is pale.', 'The sheet is pale.']), null);
});

test('an empty read is not evidence of anything', () => {
  assert.equal(describedTheSame(['', '', '']), null, 'three blanks are three missing answers, not a stall');
  assert.equal(describedTheSame(['x', '', 'x']), null);
});

test('the window is three and shorter histories cannot fire it', () => {
  assert.equal(SAME_READ_STEPS, 3);
  const read = 'A pale sheet.';
  for (let n = 0; n < SAME_READ_STEPS; n++) {
    assert.equal(describedTheSame(Array(n).fill(read)), null, `${n} reads is not enough to say`);
  }
});

// The environment half, run for real: a whole trajectory whose describer has run out of things to
// say. Everything else in this run is the ordinary stub — real renders, real edits through the real
// validator, real constraint checks — and the one thing changed is the thing under test.
//
// It renders, so it is slow. It is here anyway because the predicate above proves nothing about
// whether the loop ever asks it, and "the loop never asks" is precisely how the original failure
// went six steps without being noticed.
test('a run whose blind reader says the same thing every step gets told the branch is stuck', async () => {
  const { runTrajectory } = await import('../run.js');
  const { StubPolicy } = await import('./artist-stub.js');
  const { setEnvModel } = await import('../env-model.js');

  // The shared stub with one thing pinned: `describe` returns the same sentence no matter what it
  // is shown. Every other env call answers exactly as the shared stub does, so the only difference
  // between this run and an ordinary stubbed one is the condition under test.
  const constant = 'A pale sheet. Something dark sits on it. Nothing else.';
  setEnvModel(async <T>(request: { name: string }) => ({
    value: (request.name === 'describe'
      ? { description: constant }
      : request.name === 'transcribe'
        ? { strings: [] }
        : request.name === 'audience'
          ? { read: 'It looks like a notice.', wouldAct: 'consider' }
          : request.name === 'rubric'
            ? { verdict: 'cannot-tell', evidence: 'the stub reader cannot tell' }
            : { agree: true, reason: 'the report names the same marks in the same places' }) as T,
    cached: true,
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
    cacheKey: 'stub',
  }));

  try {
    const trajectory = await runTrajectory({
      policy: new StubPolicy(4),
      positionId: 'withheld',
      briefId: 'two-million-slips',
      seed: 4242,
      outDir: path.join(mkdtempSync(path.join(tmpdir(), 'develop-')), 'cell'),
      maxSteps: 6,
      sketchesPerProblem: 1,
      useAudience: false,
    });
    const kept = trajectory.steps.filter((s) => s.accepted);
    assert.ok(kept.length >= SAME_READ_STEPS, `the run kept ${kept.length} steps, enough to stall`);
    const triggers = trajectory.steps.map((s) => s.replan?.trigger).filter((t) => t !== undefined);
    assert.ok(
      triggers.includes('description-unchanged'),
      `the loop never noticed. Triggers fired: ${triggers.join(', ') || '(none)'}`
    );
  } finally {
    setEnvModel(null);
  }
});
