// The join between the pixels and the reasoning.
//
// The one property worth defending: scene k shows the frame rendered after step k next to the words
// the artist said *before* step k, and the survival number measured *for* step k. Off-by-one here is
// invisible on screen — every frame looks plausible next to every sentence — so it is checked
// against a run whose steps are deliberately distinguishable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { walkthroughOf, walkthroughHtml } from '../artist/walkthrough.js';
import type { SurvivalRow } from '../artist/filmstrip.js';
import type { LogLine } from '../artist/studio-log.js';

let seq = 0;
function line(kind: string, data: Record<string, unknown>): LogLine {
  return { seq: seq++, t: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), kind: kind as LogLine['kind'], data, prev: '', hash: '' };
}

const state = (programHash: string, standing: number) => ({
  programHash,
  pixelHash: `px-${programHash}`,
  standing,
  hardViolations: 0,
  softViolations: 0,
  treeScore: standing,
  renderScore: standing,
});

/** Two steps: the first is kept and adds a node, the second is refused an edit and reverted. */
function run(): LogLine[] {
  seq = 0;
  return [
    line('trajectory-start', { positionId: 'many-hands', briefId: 'nine-returned', deliverableId: 'print', control: false, seed: 7 }),
    line('phase', { phase: 'reset' }),
    line('render', state('blank', 0.1)),
    line('phase', { phase: 'make' }),

    line('policy-call', {
      name: 'act',
      ok: true,
      usage: { usd: 0.1 },
      action: { think: 'The canvas is blank.\nLay the structure down.', edits: [{ actionId: 'a1', node: { id: 'band' } }] },
    }),
    line('render', state('plate-a', 0.5)),
    line('step', {
      k: 1,
      edits: [{ actionId: 'a1', kind: 'add_node' }],
      refused: [],
      applied: ['a1'],
      accepted: true,
      revertedBecause: null,
      isRiskMove: false,
      destroyedNodeIds: [],
      pixelsMoved: 0.42,
      affect: {},
      programHash: 'plate-a',
      think: 'The canvas is blank.\nLay the structure down.',
    }),
    // A replan is three lines in a real log: what fired, the phase it opened, then the call.
    line('trigger', { trigger: 'description-disagrees', detail: 'the sheet does not read as you say' }),
    line('phase', { phase: 'replan', trigger: 'description-disagrees' }),
    line('policy-call', { name: 'replan', ok: true, usage: { usd: 0.02 }, action: { think: 'The date reads as a body count.' } }),

    line('policy-call', {
      name: 'act',
      ok: true,
      usage: { usd: 0.08 },
      action: { think: 'Push the coverage over the line.', edits: [{ actionId: 'a2' }] },
    }),
    line('edit-refused', { actionId: 'a2', reason: 'text too long [limit.textLength]' }),
    line('render', state('plate-b', 0.3)),
    line('step', {
      k: 2,
      edits: [{ actionId: 'a2', kind: 'set_prop' }],
      refused: [{ actionId: 'a2', reason: 'text too long [limit.textLength]' }],
      applied: [],
      accepted: false,
      revertedBecause: 'coverage fell',
      isRiskMove: true,
      destroyedNodeIds: ['old-rule'],
      pixelsMoved: 0,
      affect: {},
      programHash: 'plate-a',
      think: 'Push the coverage over the line.',
    }),
    line('trajectory-end', { outcome: 'finished', finalHash: 'plate-a', scores: {}, cost: { usd: 0.2, wallMs: 60000, policyCalls: 3 } }),
  ];
}

const frames = [{ k: 0 }, { k: 1 }, { k: 2 }];
const survival: SurvivalRow[] = [
  { k: 1, laidDown: 0.42, survived: 0.4, survival: 0.9524 },
  { k: 2, laidDown: 0, survived: 0, survival: null },
];

test('there is one scene per frame and the seed frame is not a decision', () => {
  const w = walkthroughOf(run(), frames, survival, 0.9524);
  assert.equal(w.scenes.length, 3);
  assert.deepEqual(w.scenes.map((s) => s.frame), ['step-00.png', 'step-01.png', 'step-02.png']);

  const seed = w.scenes[0]!;
  assert.equal(seed.accepted, null, 'nobody decided the blank sheet');
  assert.equal(seed.said, '');
  assert.equal(seed.survival, null);
  assert.equal(seed.title, 'the sheet it started from');
});

test('each scene carries the words that produced that frame, not the next one', () => {
  const w = walkthroughOf(run(), frames, survival, 0.9524);
  assert.match(w.scenes[1]!.said, /^The canvas is blank\./);
  assert.match(w.scenes[2]!.said, /^Push the coverage over the line\./);
  assert.match(w.scenes[1]!.title, /^kept · 1 edit — The canvas is blank\./);
  assert.match(w.scenes[2]!.title, /^reverted · 0 edits · risk — Push the coverage/);
});

test('the survival number on a scene is the one measured for that step', () => {
  const w = walkthroughOf(run(), frames, survival, 0.9524);
  assert.equal(w.scenes[1]!.survival!.survival, 0.9524);
  assert.equal(w.scenes[2]!.survival!.survival, null, 'a reverted step moved nothing');
  assert.equal(w.meanSurvival, 0.9524);
});

test('what the step did to the tree and the sheet rides along with it', () => {
  const w = walkthroughOf(run(), frames, survival, 0.9524);
  const one = w.scenes[1]!;
  assert.equal(one.accepted, true);
  assert.deepEqual(one.born, ['band']);
  assert.equal(one.pixelsMoved, 0.42);
  assert.deepEqual(one.standing, { before: 0.1, after: 0.5 });
  assert.equal(one.replanTrigger, 'description-disagrees');
  assert.ok(one.notes.some((n) => n.text.startsWith('replanned:')));

  const two = w.scenes[2]!;
  assert.equal(two.accepted, false);
  assert.equal(two.revertedBecause, 'coverage fell');
  assert.equal(two.isRiskMove, true);
  assert.deepEqual(two.destroyed, ['old-rule']);
  // A reverted step ends where it began, so its standing does not move.
  assert.deepEqual(two.standing, { before: 0.5, after: 0.5 });
  assert.deepEqual(
    two.edits.map((e) => [e.kind, e.applied, e.refusedBecause]),
    [['set_prop', false, 'text too long [limit.textLength]']]
  );
});

test('a run from before pixelsMoved existed says nothing rather than saying zero', () => {
  const lines = run();
  for (const l of lines) if (l.kind === 'step') delete (l.data as { pixelsMoved?: number }).pixelsMoved;
  const w = walkthroughOf(lines, frames, survival, 0.9524);
  // The Transition would report 0 here. 0 is a claim, and on step 1 it is a false one.
  assert.equal(w.scenes[1]!.pixelsMoved, null);
  assert.equal(w.scenes[1]!.survival!.laidDown, 0.42, 'the measured curve is unaffected');
});

test('the page embeds the walkthrough and cannot be broken out of by what the artist said', () => {
  const lines = run();
  // The artist is a text model; nothing stops it writing a closing script tag in its reasoning.
  (lines[4]!.data as { action: { think: string } }).action.think = 'close it: </script><script>alert(1)</script>';
  const html = walkthroughHtml(walkthroughOf(lines, frames, survival, 0.9524));
  const embedded = html.slice(html.indexOf('id="data"'));
  assert.equal(embedded.slice(0, embedded.indexOf('</script>')).includes('alert(1)'), true);
  assert.equal(html.includes('</script><script>alert(1)'), false, 'the tag must be escaped, not emitted');
});
