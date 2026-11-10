// What the artist is told about the mark budget before it spends it.
//
// `maxEstimatedMarks` is the limit the policy actually hits: 43 of the 63 edit refusals recorded
// under `out/` are that one code, every one of them in a sketch, three of them a first edit against
// a blank sheet. It was printed as a bare number in a key=value dump, in a unit nothing on the page
// defined, and never as a remainder -- which is the same failure `textOps` had, on a budget that is
// overrun far more often. Two places say it now, and both are covered here: the MAKE observation,
// which can say what is left because it is looking at a tree, and SKETCH, which cannot -- it writes
// every edit before any of them is applied -- and so has to be told what the allowance buys instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadProfile } from '../../env/profile.js';
import type { CheckReport } from '../../aesthetic/types.js';
import { artistLayers, loadCommission } from '../field.js';
import { makeObservation, type MakeContext } from '../observation.js';
import { sheetCost, SKETCH_PROFILE } from '../phases/sketch.js';
import { seedProgram } from '../seed.js';
import type { Intention } from '../types.js';

function context(marks: MakeContext['marks']): MakeContext {
  const c = loadCommission('overlooked', 'nine-returned');
  const report: CheckReport = {
    aesthetic: c.effective.id,
    hardViolations: 0,
    softViolations: 0,
    treeScore: null,
    renderScore: null,
    blocked: 0,
    pendingRubrics: [],
    results: [],
  };
  const intention: Intention = {
    elements: [],
    edges: [],
    purpose: 'p',
    tension: { between: 'a', and: 'b', claim: 'c' },
    riskMove: null,
  };
  return {
    ...artistLayers(c),
    capabilitySheet: 'sheet',
    program: {},
    report,
    description: 'd',
    audienceRead: null,
    intention,
    affect: { arousal: 0.5, valence: 0 },
    steps: [],
    maxEdits: 1,
    stepsLeft: 1,
    canvasAttached: false,
    changeAttached: false,
    textOps: { used: 0, max: 8 },
    marks,
  };
}

const HEAVY = [
  { sourceId: 'ground', op: 'paint', kind: 'hatch', marks: 8311 },
  { sourceId: 'band', op: 'paint', kind: 'hatch', marks: 3178 },
  { sourceId: 'edge', op: 'paint', kind: 'outline', marks: 488 },
  { sourceId: 'dot', op: 'paint', kind: 'solid', marks: 1 },
];

test('MAKE says the marks as a remainder, and names what is holding them', () => {
  const text = makeObservation(context({ used: 1200, max: 12000, heaviest: HEAVY }));
  assert.match(text, /Marks: 1,200\/12,000 \(10%\), 10,800 left\./);
  assert.match(
    text,
    /\n {2}heaviest: ground \(paint\/hatch\) 8,311, band \(paint\/hatch\) 3,178, edge \(paint\/outline\) 488\n/
  );
  assert.ok(!text.includes('dot (paint/solid)'), 'three is the list, not the whole tree');
});

test('MAKE stays quiet about tactics until the budget is nearly gone', () => {
  const room = makeObservation(context({ used: 1200, max: 12000, heaviest: HEAVY }));
  assert.ok(!room.includes('Near the limit'), 'a tenth spent needs no advice');

  const tight = makeObservation(context({ used: 11491, max: 12000, heaviest: HEAVY }));
  assert.match(tight, /Marks: 11,491\/12,000 \(96%\), 509 left\./);
  assert.match(tight, /Near the limit\. Size textured regions deliberately/);
  // The whole point of the block is undone if the way out of it is the flat fill the MATERIAL
  // section exists to argue against, so the advice has to say so where it is given.
  assert.match(tight, /do not retreat to solid to save marks/);
});

test('MAKE says outright when there is nothing left', () => {
  const text = makeObservation(context({ used: 12000, max: 12000, heaviest: HEAVY }));
  assert.match(text, /Marks: 12,000\/12,000\. Nothing left — shrink or delete to free marks\./);
  assert.ok(!/\d+ left\./.test(text.split('Marks:')[1]!.split('\n')[0]!), 'no remainder to state');
});

test('SKETCH is told what its allowance buys on the canvas it actually has', () => {
  const { profile } = loadProfile(SKETCH_PROFILE);
  const max = profile.limits.maxEstimatedMarks;
  const seed = seedProgram(1);
  const canvas = seed['canvas'] as { width: number; height: number };
  const text = sheetCost(profile, seed, max);

  assert.match(text, new RegExp(`WHAT YOUR ${max} MARKS BUY ON THIS SHEET \\(${canvas.width}x${canvas.height}\\)`));
  for (const kind of profile.styles!) assert.match(text, new RegExp(`\\n  ${kind}\\s`), `${kind} has no row`);

  // The finding the block exists to state: one crosshatch over this sheet is most of the sketch
  // allowance, and the same sheet filled `solid` is one mark. If those two ever read the same the
  // table has stopped saying anything.
  const share = (kind: string) => Number(new RegExp(`\\n  ${kind}\\s+\\d+\\s+(\\d+)%`).exec(text)![1]);
  assert.ok(share('hatch') > 30, `a full-sheet hatch should cost a large share of the allowance, got ${share('hatch')}%`);
  assert.equal(share('solid'), 0);
});
