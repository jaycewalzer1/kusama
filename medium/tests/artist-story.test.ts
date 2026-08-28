// The fold from studio.jsonl to something readable.
//
// Two properties are the whole point of `story.ts` and both are easy to lose:
// a MAKE beat is a *step* (the act call, its refused edits, the render, the verdict, the trigger and
// the replan are one event), and 200 identical refusals collapse to one row with a count. If either
// stops holding, the page is a flat log again with extra indentation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalFamily, said, storyOf, summarise, type Entry } from '../artist/story.js';

let seq = 0;
function line(kind: string, data: Record<string, unknown>): Entry {
  seq++;
  return { seq, t: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), kind, summary: summarise(kind, data) };
}

/** One tiny run: find, one sketch, choose, two steps (one of them reverted), examine, end. */
function run(): Entry[] {
  seq = 0;
  return [
    line('trajectory-start', { positionId: 'generation-loss', briefId: 'arches-eviction', deliverableId: 'poster', seed: 7, maxSteps: 12 }),
    line('phase', { phase: 'find' }),
    line('policy-call', { name: 'find', ok: true, usage: { usd: 0.09 }, action: { problems: [{ text: 'the poster shouts' }] } }),
    line('phase', { phase: 'sketch' }),
    line('policy-call', { name: 'sketch', ok: true, usage: { usd: 0.05 }, action: { approach: 'Confession first, instruction last.' } }),
    line('edit-refused', { reason: 'text too long [limit.textLength]' }),
    line('edit-refused', { reason: 'text too long [limit.textLength]' }),
    line('edit-refused', { reason: 'index 4 is past the end of "sheet", which has 2 children' }),
    line('edit-refused', { reason: 'index 9 is past the end of "sheet", which has 3 children' }),
    line('phase', { phase: 'choose' }),
    line('policy-call', { name: 'choose', ok: true, usage: { usd: 0.05 }, action: { why: 'Cell 15 is the wrong one, in the best sense.' } }),
    line('phase', { phase: 'reset' }),
    line('render', { programHash: 'blank', treeScore: 0, renderScore: 0, hardViolations: 6, softViolations: 0 }),
    line('phase', { phase: 'make' }),

    line('policy-call', { name: 'act', ok: true, usage: { usd: 0.13 }, action: { think: 'The canvas is blank. Lay the structure down.' } }),
    line('edit-refused', { reason: 'text too long [limit.textLength]' }),
    line('render', { programHash: 'plate-a', treeScore: 0.5, renderScore: 0.4, hardViolations: 2, softViolations: 1 }),
    line('step', { k: 1, control: 'continue', accepted: true, applied: [1, 2, 3], think: 'The canvas is blank. Lay the structure down.' }),
    line('trigger', { trigger: 'description-disagrees', detail: 'the sheet does not read as you say' }),
    line('policy-call', { name: 'replan', ok: true, usage: { usd: 0.02 }, action: { think: 'The date is reading as a body count.' } }),

    line('policy-call', { name: 'act', ok: true, usage: { usd: 0.08 }, action: { think: 'Push the coverage over the line.' } }),
    line('render', { programHash: 'plate-b', treeScore: 0.4, renderScore: 0.4, hardViolations: 3, softViolations: 1 }),
    line('step', { k: 2, control: 'finished', accepted: false, applied: [], revertedBecause: 'coverage fell', think: 'Push the coverage over the line.' }),

    line('phase', { phase: 'examine' }),
    line('policy-call', { name: 'examine', ok: true, usage: { usd: 0.03 }, action: { paragraph: 'It turned out to be a letter.' } }),
    line('trajectory-end', {
      outcome: 'finished',
      scores: { tree: 1, render: 1, hardViolations: 0 },
      cost: { usd: 0.45, wallMs: 600000, policyCalls: 7 },
    }),
  ];
}

test('the acts are the phases, in order, and MAKE opens on the reset render', () => {
  const s = storyOf(run());
  assert.deepEqual(s.acts.map((a) => a.id), ['start', 'find', 'sketch', 'choose', 'make', 'examine', 'end']);

  // The blank sheet and its six hard violations belong to MAKE, not to CHOOSE, which never made them.
  const make = s.acts.find((a) => a.id === 'make')!;
  assert.equal(make.beats[0]!.label, 'start');
  assert.equal(make.beats[0]!.scores!.hard, 6);
  assert.equal(s.acts.find((a) => a.id === 'choose')!.beats.every((b) => b.scores === null), true);
});

test('a MAKE beat is a step: the call, the refusals, the render, the verdict, the trigger and the replan', () => {
  const make = storyOf(run()).acts.find((a) => a.id === 'make')!;
  assert.deepEqual(make.beats.map((b) => b.label), ['start', 'step 1', 'step 2']);

  const one = make.beats[1]!;
  assert.equal(one.seqs.length, 6, 'act call, refusal, render, step, trigger, replan');
  assert.equal(one.tone, 'good');
  assert.equal(one.plate, 'plate-a');
  assert.equal(one.refused, 1);
  assert.match(one.title, /^kept · 3 edits — The canvas is blank/);
  assert.ok(one.notes.some((n) => n.text.startsWith('description-disagrees')));
  assert.ok(one.notes.some((n) => n.text.startsWith('replanned:')));

  const two = make.beats[2]!;
  assert.equal(two.tone, 'bad');
  assert.match(two.title, /^reverted · 0 edits · finished — /);
});

test('repeats fold to a count with the family kept, not to a wall', () => {
  const sketch = storyOf(run()).acts.find((a) => a.id === 'sketch')!;
  assert.equal(sketch.beats.length, 1);
  const notes = sketch.beats[0]!.notes;
  assert.equal(sketch.beats[0]!.refused, 4);
  assert.deepEqual(
    notes.map((n) => [n.text, n.count]),
    [
      ['limit.textLength', 2],
      ['index N is past the end of "...", which has N children', 2],
    ]
  );
});

test('a shut act still says what it cost and what went wrong', () => {
  const s = storyOf(run());
  // A beat runs until the next beat opens, and the next beat is in the next act.
  assert.equal(s.acts.find((a) => a.id === 'sketch')!.summary, '1 beat · 1 call · $0.05 · 6s · 4 refused');
  assert.match(s.acts.find((a) => a.id === 'make')!.summary, /tree 0\.40 · 3 hard · 1 refused · 1 reverted or failed$/);
  assert.equal(s.acts.find((a) => a.id === 'make')!.tone, 'bad', 'a failure is visible through the collapse');
  assert.equal(s.acts.find((a) => a.id === 'end')!.summary, 'tree 1.000 · render 1.000 · 0 hard · $0.45 · 10 min · 7 calls');
});

test('the track is one point per distinct plate, in order', () => {
  const s = storyOf(run());
  assert.deepEqual(s.track.map((p) => p.plate), ['blank', 'plate-a', 'plate-b']);
  assert.deepEqual(s.track.map((p) => p.label), ['make start', 'step 1', 'step 2']);
  assert.deepEqual({ ...s.totals, usd: Number(s.totals.usd.toFixed(2)) }, { usd: 0.45, ms: 25000, calls: 7, refused: 5, steps: 2 });
});

test('every line lands in exactly one beat, so "show me the log for this" is complete', () => {
  const entries = run();
  const s = storyOf(entries);
  const seqs = s.acts.flatMap((a) => a.beats.flatMap((b) => b.seqs));
  assert.equal(new Set(seqs).size, seqs.length, 'no line is folded into two beats');
  // The act openers and the end are act titles rather than beats; everything else is reachable.
  const unplaced = entries.filter((e) => !seqs.includes(e.seq));
  assert.deepEqual(unplaced.map((e) => e.kind), ['trajectory-start', 'phase', 'phase', 'phase', 'phase', 'trajectory-end']);
});

test('refusalFamily prefers the checker\'s own tags and otherwise strips what varies', () => {
  assert.equal(refusalFamily('too long [limit.textLength] and also [limit.textLength]'), 'limit.textLength');
  assert.equal(refusalFamily('bad [schema.program] at [limit.textOps]'), 'schema.program, limit.textOps');
  assert.equal(refusalFamily('index 4 is past the end of "sheet"'), 'index N is past the end of "..."');
});

test('said reads whatever the phase called its reasoning', () => {
  assert.equal(said({ think: 'a' }), 'a');
  assert.equal(said({ approach: 'b' }), 'b');
  assert.equal(said({ paragraph: 'c' }), 'c');
  assert.equal(said({ problems: [{ text: 'x' }, { text: 'y' }] }), '- x\n- y');
  assert.equal(said(undefined), '');
});

test('a failed policy call is bad and keeps its error', () => {
  seq = 0;
  const s = storyOf([
    line('phase', { phase: 'find' }),
    line('policy-call', { name: 'find', ok: false, error: 'the model timed out', usage: { usd: 0 }, action: {} }),
  ]);
  const beat = s.acts[0]!.beats[0]!;
  assert.equal(beat.tone, 'bad');
  assert.equal(beat.title, 'find FAILED');
  assert.deepEqual(beat.notes, [{ text: 'the model timed out', count: 1, tone: 'bad' }]);
});
