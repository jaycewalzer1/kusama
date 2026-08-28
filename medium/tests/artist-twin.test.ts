// The position-versus-null-twin comparison, and the ways it could lie.
//
// The measurement is cheap and the temptation to over-read it is large, so most of this file is
// about what the number must NOT do: it must not call two identical artists different, it must not
// call a verdict on four edits, and it must not quietly become a restatement of the score gap. The
// last is the one that matters — the control arm is graded by the position's own checker, so it
// always scores worse, and a comparison that reproduced that finding would be measuring the checker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { actionProfile, twinOf, twinText, DECORATION_BELOW, MIN_EDITS } from '../artist/twin.js';
import type { LogLine } from '../artist/studio-log.js';

const AFFECT = { arousal: 0.5, valence: 0.1 };

function line(seq: number, kind: LogLine['kind'], data: unknown): LogLine {
  return { seq, t: '', kind, data, prev: '', hash: '' };
}

function render(seq: number, standing: number): LogLine {
  return line(seq, 'render', {
    programHash: `h${seq}`,
    pixelHash: `px${seq}`,
    standing,
    hardViolations: 0,
    softViolations: 0,
    treeScore: 0.5,
    renderScore: null,
  });
}

/**
 * A log of `ops.length` accepted steps, one edit each, in the exact line order ArtistEnv emits.
 * Every step adds a node of the named op, which is the only thing the profile reads.
 */
function logOf(ops: string[], extra: { refuse?: number[]; revert?: number[]; risk?: number[] } = {}): LogLine[] {
  const lines: LogLine[] = [line(0, 'trajectory-start', { seed: 1, positionId: 'p', briefId: 'b' }), render(1, -6)];
  let seq = 2;
  ops.forEach((op, i) => {
    const k = i + 1;
    const id = `n${k}`;
    const refused = extra.refuse?.includes(k) ?? false;
    const reverted = refused || (extra.revert?.includes(k) ?? false);
    lines.push(
      line(seq++, 'policy-call', {
        name: 'act',
        action: { edits: [{ actionId: `a${k}`, kind: 'add_node', node: { id, type: 'op', op, rngKey: id } }] },
      })
    );
    if (!refused) lines.push(render(seq++, -5));
    lines.push(
      line(seq++, 'step', {
        k,
        edits: [{ actionId: `a${k}`, kind: 'add_node' }],
        applied: refused ? [] : [`a${k}`],
        refused: refused ? [{ actionId: `a${k}`, reason: 'over the text budget [limit.textOps]' }] : [],
        accepted: !reverted,
        revertedBecause: reverted ? 'refused' : null,
        isRiskMove: extra.risk?.includes(k) ?? false,
        destroyedNodeIds: [],
        pixelsMoved: reverted ? 0 : 0.1,
        affect: AFFECT,
        programHash: `h${seq}`,
      })
    );
  });
  return lines;
}

/** Enough edits to clear MIN_EDITS, alternating so the shares are not degenerate. */
const many = (a: string, b: string, n = MIN_EDITS + 4) =>
  Array.from({ length: n }, (_, i) => (i % 2 === 0 ? a : b));

test('the action label is the op, not the edit kind', () => {
  // The whole comparison turns on this. Every edit in both arms is an `add_node`, so a histogram
  // over `kind` is the constant distribution {add_node: 1} and would report every pair of artists
  // as identical — the exact false negative this file exists to prevent.
  const p = actionProfile(logOf(['text', 'text', 'paint']));
  assert.deepEqual(p.counts, { 'add:text': 2, 'add:paint': 1 });
  assert.equal(p.edits, 3);
  assert.equal(p.shares['add:text'], 2 / 3);
});

test('an op the act call never carried is kept as add:? rather than dropped', () => {
  // Older logs, and any step whose act call is outside the slice being folded. Dropping these would
  // silently shrink the denominator and inflate every other share.
  const lines = logOf(['text']).map((l) =>
    l.kind === 'policy-call' ? line(l.seq, 'policy-call', { name: 'act', action: { edits: [{ actionId: 'a1', kind: 'add_node' }] } }) : l
  );
  const p = actionProfile(lines);
  assert.deepEqual(p.counts, { 'add:?': 1 });
  assert.equal(Object.values(p.shares).reduce((a, b) => a + b, 0), 1, 'the shares still cover every edit');
});

test('two identical arms diverge by exactly zero', () => {
  const t = twinOf(logOf(many('text', 'paint')), logOf(many('text', 'paint')));
  assert.equal(t.divergence, 0);
  assert.equal(t.verdict, 'decoration');
  assert.deepEqual(t.onlyArm, []);
  assert.deepEqual(t.onlyControl, []);
});

test('two arms with no action in common diverge by exactly one', () => {
  const t = twinOf(logOf(many('text', 'rule')), logOf(many('paint', 'wash')));
  assert.equal(t.divergence, 1);
  assert.equal(t.verdict, 'steers');
  assert.deepEqual(t.onlyArm.sort(), ['add:rule', 'add:text']);
  assert.deepEqual(t.onlyControl.sort(), ['add:paint', 'add:wash']);
});

test('divergence is symmetric, and the asymmetry is only in which side is named', () => {
  const a = logOf(many('text', 'paint'));
  const b = logOf(many('text', 'rule'));
  const forward = twinOf(a, b);
  const backward = twinOf(b, a);
  assert.equal(forward.divergence, backward.divergence);
  assert.deepEqual(forward.onlyArm, backward.onlyControl);
  assert.deepEqual(forward.onlyControl, backward.onlyArm);
});

test('a short pair gets no verdict at all, however far apart it looks', () => {
  // Four edits against four, sharing nothing: divergence 1.0, the most extreme reading available,
  // and still not a finding. A number this confident off this little data is the failure mode.
  const t = twinOf(logOf(['text', 'text', 'rule', 'rule']), logOf(['paint', 'paint', 'wash', 'wash']));
  assert.equal(t.divergence, 1);
  assert.equal(t.verdict, 'undersampled');
  assert.match(t.because, new RegExp(`below ${MIN_EDITS}`));
  assert.ok(t.arm.edits < MIN_EDITS);
});

test('the floor sits under a real run, or the tool never answers', () => {
  // A trajectory at the default --steps 12 produces about ten edits — measured, not assumed: the two
  // real logs this file's threshold was calibrated against have 10 and 11. A floor above that would
  // make every honest invocation return 'undersampled', which is a tool that has been switched off
  // rather than a tool being careful.
  assert.ok(MIN_EDITS <= 10, `MIN_EDITS ${MIN_EDITS} is above the edit count of a default-length run`);
});

test('the verdict turns on the stated threshold and says which way it fell', () => {
  const near = twinOf(logOf(many('text', 'paint', 20)), logOf(many('text', 'paint', 20).map((o, i) => (i === 0 ? 'rule' : o))));
  assert.ok(near.divergence < DECORATION_BELOW, `expected a small divergence, got ${near.divergence}`);
  assert.equal(near.verdict, 'decoration');
  assert.match(near.because, /reached for the same things/);
});

test('the profile carries the rates a position should move, not just the histogram', () => {
  // A position with prohibitions should be REFUSED more and should tear its own work out more. Those
  // are separate axes from what it reaches for: an artist can reach for the same ops and be stopped
  // far more often, and a comparison blind to that would call it decoration.
  const p = actionProfile(logOf(['text', 'text', 'text', 'paint'], { refuse: [2], revert: [3], risk: [4] }));
  assert.equal(p.steps, 4);
  assert.equal(p.refusedShare, 0.25);
  assert.equal(p.revertShare, 0.5, 'a refused step is also a reverted step');
  assert.equal(p.riskShare, 0.25);
});

test('an arm that did nothing is an empty distribution, not a division by zero', () => {
  const p = actionProfile(logOf([]));
  assert.equal(p.edits, 0);
  assert.equal(p.steps, 0);
  assert.deepEqual(p.shares, {});
  for (const v of [p.refusedShare, p.revertShare, p.riskShare, p.destroyShare]) assert.equal(v, 0);

  const t = twinOf(logOf([]), logOf(many('text', 'paint')));
  assert.equal(t.verdict, 'undersampled');
  assert.ok(Number.isFinite(t.divergence));
});

test('the report says out loud that one pair is not a result', () => {
  const text = twinText(twinOf(logOf(many('text', 'rule')), logOf(many('paint', 'wash'))));
  assert.match(text, /divergence 1\.000 — STEERS/);
  assert.match(text, /smoke test, not a result/);
  // The per-label table is the finding; the scalar is a summary of it and must not be the only thing
  // on the page.
  assert.match(text, /add:text/);
  assert.match(text, /add:paint/);
});
