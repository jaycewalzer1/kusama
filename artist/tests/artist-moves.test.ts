// The moves that touch no pixels: what gets checked, and what must never start being rewarded.
//
// Two kinds of test here and they are guarding different things.
//
// The arithmetic tests cover `record` and `moveSummary` — the grounding check and the fold — over
// hand-built steps, so they run on a fresh clone with no corpus, no venv and no browser.
//
// The last two are guards over source bytes, in the style of `aesthetic/tests/elements.test.ts`.
// They exist because the failure they catch is not a wrong number, it is a design decision quietly
// reversed: the five move names are spelled three times in three languages, and `inert` is one
// assignment away from becoming something an artist can talk its way out of. Neither would show up
// as a failing assertion anywhere else.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../../env/browser.js';
import { MOVE_KINDS, grounded, moveLine, moveSummary, record, shown } from '../moves.js';
import { actSchema } from '../schemas.js';
import type { EpistemicMove, Intention, MoveKind } from '../types.js';

function look(ids: string[]) {
  return {
    aesthetic: 'x',
    hardViolations: 0,
    softViolations: 0,
    treeScore: null,
    renderScore: null,
    blocked: 0,
    pendingRubrics: [],
    results: ids.map((id) => ({ id }) as never),
  } as never;
}

const intention = { elements: [{ id: 'the-fold', role: 'r', nodeIds: [] }], edges: [], purpose: 'p', tension: { between: 'a', and: 'b', claim: 'c' }, riskMove: null } as unknown as Intention;

const SHOWN = shown({ elementIds: ['tsutsugaki'] }, intention, look(['ink-coverage']), ['met-436535']);

function move(over: Partial<EpistemicMove> = {}): EpistemicMove {
  return { kind: 'retrieve', refs: ['met-436535'], because: 'it holds the fold open', ...over };
}

test('a ref is grounded by any of the four things the environment shows, and by nothing else', () => {
  // One per provenance. The point of the check is that it is the union — an artist that retrieves a
  // constraint id is doing something as real as one that retrieves a work, and a check that only
  // knew about works would call the first unfounded.
  for (const ref of ['tsutsugaki', 'met-436535', 'the-fold', 'ink-coverage']) {
    const [r] = record([move({ refs: [ref] })], SHOWN);
    assert.equal(grounded(r!), true, `${ref} was shown`);
  }
  const [bad] = record([move({ refs: ['met-999999'] })], SHOWN);
  assert.deepEqual(bad!.unknownRefs, ['met-999999']);
  assert.equal(grounded(bad!), false);
});

test('the comparison is exact, so a near miss is unfounded rather than corrected', () => {
  // Deliberately not fuzzy. The failure being caught is a move about a work the run never saw, and
  // that failure does not look like a typo — accepting near misses would turn the check into a
  // spell-corrector and let a hallucinated id through on the strength of a shared prefix.
  const [r] = record([move({ refs: ['met-4365350', 'Tsutsugaki'] })], SHOWN);
  assert.deepEqual(r!.unknownRefs, ['met-4365350', 'Tsutsugaki']);
});

test('a move with one good ref and one bad one is unfounded, not half-founded', () => {
  const [r] = record([move({ kind: 'extract-a-relation', refs: ['met-436535', 'nowhere'] })], SHOWN);
  assert.deepEqual(r!.unknownRefs, ['nowhere']);
  assert.equal(grounded(r!), false);
});

test('a run nobody asked reports null, not a run that retrieved nothing', () => {
  // The standing rule in this repo, and the one that matters most here: every trajectory on disk
  // predates the moves and a zeroed summary would report the whole back catalogue as having been
  // offered the vocabulary and declined it.
  assert.equal(moveSummary([{ pixelsMoved: 0.2 }, { pixelsMoved: 0 }]), null);
  assert.notEqual(moveSummary([{ moves: [], pixelsMoved: 0 }]), null, 'asked and silent is a real answer');
});

test('the fold counts kinds, groundedness and the pixelless steps separately', () => {
  const s = moveSummary([
    { moves: record([move(), move({ kind: 'reject', refs: ['bad-id'] })], SHOWN), pixelsMoved: 0 },
    { moves: record([move({ kind: 'reframe', refs: ['the-fold'] })], SHOWN), pixelsMoved: 0.4 },
    { moves: [], pixelsMoved: 0 },
  ])!;
  assert.equal(s.total, 3);
  assert.equal(s.grounded, 2);
  assert.equal(s.stepsWithMoves, 2, 'the step that made no move is not a step with moves');
  assert.equal(s.pixellessSteps, 1, 'only the step that both moved and painted nothing');
  assert.equal(s.byKind.retrieve, 1);
  assert.equal(s.byKind.reject, 1);
  assert.equal(s.byKind.reframe, 1);
  assert.equal(s.byKind['copy-as-study'], 0, 'a kind nobody used is 0 and present, not absent');
});

test('a step whose pixelsMoved was never recorded is not counted as pixelless', () => {
  // No `?? 0` anywhere in the fold. An unmeasured step and a step measured at zero are different
  // facts, and defaulting would report an old log as a long stretch of pixelless deliberation.
  const s = moveSummary([{ moves: record([move()], SHOWN) }])!;
  assert.equal(s.stepsWithMoves, 1);
  assert.equal(s.pixellessSteps, 0);
});

test('moveLine says which ref named nothing, not merely that the move failed', () => {
  const [r] = record([move({ refs: ['met-436535', 'nowhere'] })], SHOWN);
  const line = moveLine(r!);
  assert.match(line, /UNFOUNDED/);
  assert.match(line, /nowhere/);
  assert.doesNotMatch(line, /UNFOUNDED: met-436535/);
});

test('the five kinds are spelled the same in the union, the constant and the schema', () => {
  // Three sources of truth by construction: a TypeScript union the compiler checks, an array the
  // fold iterates to seed `byKind`, and a JSON enum the model is actually shown. Nothing makes them
  // agree, and a kind added to two of the three is a kind the artist can name and the summary
  // silently drops.
  type Node = Record<string, unknown>;
  const at = (n: unknown, ...keys: string[]): Node => keys.reduce((v, k) => (v as Node)[k] as Node, n as Node);
  const act = actSchema();
  const items = at(act, 'properties', 'moves', 'items');
  assert.deepEqual(at(items, 'properties', 'kind')['enum'], [...MOVE_KINDS]);
  assert.deepEqual([...(items['required'] as string[])].sort(), ['because', 'kind', 'refs']);
  assert.ok((act['required'] as string[]).includes('moves'), 'required, so the empty list is a decision');

  // The union, reached the only way a test can reach one: an exhaustive map that stops compiling if
  // a member is added to the type and not to MOVE_KINDS.
  const everyKind: Record<MoveKind, true> = {
    retrieve: true,
    reject: true,
    'copy-as-study': true,
    'extract-a-relation': true,
    reframe: true,
  };
  assert.deepEqual(Object.keys(everyKind).sort(), [...MOVE_KINDS].sort());
});

test('a move cannot make a step non-inert, and env.ts still says so in one line', () => {
  // The safety property of the whole feature, guarded over source bytes because there is no number
  // that would move if it were broken.
  //
  // `inertSteps` is this repo's reward-hacking counter — steps that were kept and changed nothing.
  // The first thing an artist under pressure does with a free-text epistemic move is attach one to
  // an empty step and buy its way out of that counter, and the change that would allow it is one
  // clause on one line. So the line is pinned. If a future reader wants moves to suppress
  // inertness, they have to delete this test, which means reading the argument in moves.ts first.
  const env = readFileSync(path.join(ROOT, 'artist', 'env.ts'), 'utf8');
  const assignments = env.split('\n').filter((l) => l.includes('step.inert ='));
  assert.deepEqual(assignments.map((l) => l.trim()), ['step.inert = step.pixelsMoved < INERT_THRESHOLD;']);

  // Same argument for the stall counter and the mood: a move must not reset either. Both are
  // decided off `step.improved`, which is decided off `inert` and `standing` and nothing else.
  const improved = env.split('\n').filter((l) => l.includes('step.improved ='));
  assert.deepEqual(improved.map((l) => l.trim()), ['step.improved = now > this.best && !step.inert;']);
});
