// The step record and the survival curve.
//
// Both are pure folds over things the run wrote down — one over the log, one over rendered frames —
// so both are testable with no browser and no model, which is the whole reason they were built as
// folds. The log fixture below is the exact line order `ArtistEnv` emits: reset renders, then per
// step an act call, a candidate render, a step line, and sometimes a replan.

import test from 'node:test';
import assert from 'node:assert/strict';
import { programsOf, survivalOf } from '../artist/filmstrip.js';
import { processOf, processText } from '../artist/transition.js';
import type { LogLine } from '../artist/studio-log.js';

const AFFECT = { arousal: 0.5, valence: 0.1 };

/** A log line with the chain fields filled in with anything: the fold never reads them. */
function line(seq: number, kind: LogLine['kind'], data: unknown): LogLine {
  return { seq, t: '', kind, data, prev: '', hash: '' };
}

function render(seq: number, programHash: string, pixelHash: string, standing: number): LogLine {
  return line(seq, 'render', {
    programHash,
    pixelHash,
    standing,
    hardViolations: 0,
    softViolations: 0,
    treeScore: 0.5,
    renderScore: null,
  });
}

function step(seq: number, data: Record<string, unknown>): LogLine {
  return line(seq, 'step', {
    refused: [],
    destroyedNodeIds: [],
    isRiskMove: false,
    revertedBecause: null,
    affect: AFFECT,
    ...data,
  });
}

/** A real add_node, because `programsOf` actually runs these through the medium's validator. */
function add(actionId: string, id: string, y: number): Record<string, unknown> {
  return {
    actionId,
    kind: 'add_node',
    targets: ['sheet'],
    parent: 'sheet',
    node: { id, type: 'op', op: 'text', rngKey: id, args: { x: 40, y, size: 34, text: id.toUpperCase(), font: 'special-elite', color: 'ink', align: 'left' } },
  };
}

/**
 * Three steps: one kept, one whose every edit was refused, one kept and followed by a replan. That
 * covers all three ways a transition can end.
 */
const LOG: LogLine[] = [
  line(0, 'trajectory-start', { seed: 1, positionId: 'p', briefId: 'b', control: false }),
  render(1, 'h0', 'px0', -6),
  line(2, 'phase', { phase: 'reset' }),
  line(3, 'policy-call', { name: 'act', action: { edits: [add('a1', 'title', 120)] } }),
  render(4, 'h1', 'px1', -3),
  step(5, {
    k: 1,
    edits: [{ actionId: 'a1', kind: 'add_node' }],
    applied: ['a1'],
    accepted: true,
    pixelsMoved: 0.12,
    programHash: 'h1',
  }),
  line(6, 'policy-call', { name: 'act', action: { edits: [add('a2', 'bad', 200)] } }),
  step(7, {
    k: 2,
    edits: [{ actionId: 'a2', kind: 'add_node' }],
    applied: [],
    refused: [{ actionId: 'a2', reason: 'over the text budget [limit.textOps]' }],
    accepted: false,
    revertedBecause: 'every edit was refused',
    programHash: 'h1',
  }),
  line(8, 'policy-call', { name: 'act', action: { edits: [add('a3', 'wash', 280)] } }),
  render(9, 'h2', 'px2', -1),
  step(10, {
    k: 3,
    edits: [{ actionId: 'a3', kind: 'add_node' }],
    applied: ['a3'],
    accepted: true,
    pixelsMoved: 0.4,
    programHash: 'h2',
  }),
  line(11, 'phase', { phase: 'replan', trigger: 'description-disagrees' }),
  line(12, 'policy-call', { name: 'replan', action: { intention: {} } }),
];

test('a transition chains: every after is the next before, with no gaps', () => {
  const { transitions } = processOf(LOG);
  assert.equal(transitions.length, 3);
  for (let i = 1; i < transitions.length; i++) {
    assert.deepEqual(transitions[i]!.before, transitions[i - 1]!.after, `step ${i + 1} does not start where step ${i} ended`);
  }
  assert.equal(transitions[0]!.before.pixelHash, 'px0');
  assert.equal(transitions[0]!.after.pixelHash, 'px1');
});

test('a refused step transitions to where it already was, and is still a transition', () => {
  const refused = processOf(LOG).transitions[1]!;
  assert.equal(refused.accepted, false);
  // (s, a, s') with s' === s. A step the environment threw away is data about the environment.
  assert.deepEqual(refused.before, refused.after);
  assert.equal(refused.candidate, null, 'nothing rendered, so there is no counterfactual to record');
  assert.equal(refused.pixelsMoved, 0);
  assert.equal(refused.edits[0]!.refusedBecause, 'over the text budget [limit.textOps]');
  assert.equal(refused.born.length, 0, 'a refused add_node did not put a node in the tree');
});

test('birth records which step laid each node down', () => {
  const birth: Record<string, number> = processOf(LOG).birth;
  assert.equal(birth['bad'], undefined, 'a refused node was never born');
  assert.deepEqual(birth, { title: 1, wash: 3 });
});

test('a transition carries the log lines its decisions are on', () => {
  const t = processOf(LOG).transitions;
  assert.deepEqual(t[0]!.calls, { act: 3, replan: null });
  assert.deepEqual(t[2]!.calls, { act: 8, replan: 12 });
  assert.equal(t[2]!.replanTrigger, 'description-disagrees');
  assert.equal(t[0]!.replanTrigger, null);
});

test('the fold reads a log written before it existed', () => {
  // `pixelsMoved` is new on the step line. An older trajectory has no such field and must still
  // fold, reporting 0 rather than undefined — otherwise every run collected so far is unreadable.
  const older = LOG.map((l) =>
    l.kind === 'step' ? line(l.seq, l.kind, { ...(l.data as Record<string, unknown>), pixelsMoved: undefined }) : l
  );
  const t = processOf(older).transitions;
  assert.equal(t.length, 3);
  assert.equal(t[0]!.pixelsMoved, 0);
});

test('processText writes one line per step', () => {
  const text = processText(processOf(LOG));
  assert.equal(text.split('\n').length, 3);
  assert.match(text, /k 1.*kept/);
  assert.match(text, /k 2.*revert/);
});

// --- the filmstrip -------------------------------------------------------------------------------

test('a frame per step, plus the seed, and a reverted step repeats the frame before it', () => {
  // The whole reason this replays edits rather than pruning the final tree: a step that re-argues an
  // existing node has to land on its own frame, not on the frame where the node was born.
  const programs = programsOf(LOG);
  assert.equal(programs.length, 4, 'the seed, then one frame per step');
  assert.deepEqual(programs[1], programs[2], 'step 2 was refused, so its frame is the one before it');
  assert.notDeepEqual(programs[2], programs[3]);
});

test('an edit that re-argues an existing node lands on its own frame', () => {
  // The failure that killed the first version of this. Pruning the final tree back to the nodes
  // alive at step k carries the FINAL arguments at every frame, so a step that only moved something
  // already on the sheet showed as moving nothing, and its pixels were credited to the step that
  // first put the node there.
  const moved: LogLine[] = [
    ...LOG.slice(0, 6),
    line(6, 'policy-call', {
      name: 'act',
      action: { edits: [{ actionId: 'm1', kind: 'set_arg', targets: ['title'], path: 'y', value: 480 }] },
    }),
    step(7, { k: 2, edits: [{ actionId: 'm1', kind: 'set_arg' }], applied: ['m1'], accepted: true, programHash: 'h2' }),
  ];
  const programs = programsOf(moved);
  assert.notDeepEqual(programs[2], programs[1], 'the title moved, so the frame moved');
  assert.deepEqual(programs[2], programs[programs.length - 1]);
});

test('a step that claims an edit no act call offered is a broken log, not a silent frame', () => {
  const lying = LOG.map((l) =>
    l.kind === 'step' && (l.data as { k: number }).k === 1
      ? line(l.seq, l.kind, { ...(l.data as Record<string, unknown>), applied: ['ghost'] })
      : l
  );
  assert.throws(() => programsOf(lying), /no act call offered it/);
});

/** A 2x1 canvas as raw RGBA, so the survival arithmetic is checkable by hand. */
function frame(...pixels: [number, number, number][]): Buffer {
  return Buffer.from(pixels.flatMap(([r, g, b]) => [r, g, b, 0xff]));
}

const W = [0xff, 0xff, 0xff] as [number, number, number];
const A = [0x11, 0x11, 0x11] as [number, number, number];
const B = [0x22, 0x22, 0x22] as [number, number, number];

test('survival is the share of a step\u2019s own pixels still visible at the end', () => {
  // Step 1 paints both pixels. Step 2 paints over the first one. Half of step 1 survives.
  const rows = survivalOf([frame(W, W), frame(A, A), frame(B, A)], 2, 1);
  assert.deepEqual(rows[0], { k: 1, laidDown: 1, survived: 0.5, survival: 0.5 });
  assert.deepEqual(rows[1], { k: 2, laidDown: 0.5, survived: 0.5, survival: 1 });
});

test('a step that moved nothing has no survival rather than a survival of zero', () => {
  const rows = survivalOf([frame(W, W), frame(W, W)], 2, 1);
  assert.equal(rows[0]!.laidDown, 0);
  assert.equal(rows[0]!.survival, null, 'nothing was laid down, so nothing died');
});

test('an artist that only ever adds scores a flat 1.0, which is the finding, not a pass', () => {
  // Every step lands on untouched canvas and nothing is ever covered. This is what the loop's own
  // destructionRate of 0 looks like measured in pixels instead of in nodes.
  const rows = survivalOf([frame(W, W), frame(A, W), frame(A, B)], 2, 1);
  assert.deepEqual(rows.map((r) => r.survival), [1, 1]);
});
