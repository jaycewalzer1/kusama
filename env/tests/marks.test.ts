// The mark budget, as something that can be read rather than only enforced.
//
// `maxEstimatedMarks` was the most-hit limit in the whole environment -- 43 of the 63 edit refusals
// ever recorded under `out/` -- and until now the only thing said about it was the total. Nothing
// printed what a mark is, what a fill costs in them, or which node was spending them, so a policy
// over budget could only bisect: one sketch walked 15242 -> 13674 -> 12502 across two attempts and
// never landed. These cover the three surfaces added to fix that, at the source of the numbers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateBudget, markRates, saySpend, PROBE_LARGE, PROBE_SMALL } from '../profile.js';
import { group, hatchNode, program, resolve, solidNode, testProfile, washNode } from './helpers.js';

const PROFILE = testProfile();

const budget = (children: unknown[]) => estimateBudget(resolve(program(children)), PROFILE);

test('the spend is broken down by source node, heaviest first', () => {
  const b = budget([solidNode('s1', 20, 20), hatchNode('h1', 40, 40), washNode('w1', 150, 150)]);

  assert.deepEqual(
    b.heaviest.map((s) => s.sourceId),
    ['h1', 'w1', 's1'],
    'a hatch outspends a wash outspends a solid, and that order is the whole point'
  );
  assert.deepEqual(b.heaviest.map((s) => `${s.op}/${s.kind}`), ['paint/hatch', 'wash/wash', 'paint/solid']);
  assert.equal(b.heaviest.find((s) => s.sourceId === 's1')!.marks, 1, 'a solid is one stamp at any size');
  // Every row is rounded and so is the total, so they agree to within a mark a row -- but nothing
  // may go missing between them, which is what a breakdown that summed the wrong thing would look like.
  const summed = b.heaviest.reduce((n, s) => n + s.marks, 0);
  assert.ok(Math.abs(summed - b.marks) <= b.heaviest.length, `${summed} vs ${b.marks}`);
});

test('a repeat is one row, not one row per instance', () => {
  // The node an artist can edit is the source node. Forty rows naming a resolved id that appears
  // nowhere in the program it is reading would bury the one line that matters.
  const once = budget([hatchNode('h1', 0, 0)]);
  const many = budget([
    {
      id: 'r1', type: 'repeat', rngKey: 'key-r1', count: 8,
      layout: { type: 'line', origin: [0, 0], dx: 20, dy: 0 },
      children: [hatchNode('h1', 0, 0)],
    },
  ]);

  assert.deepEqual(many.heaviest.map((s) => s.sourceId), ['h1']);
  // Summed, then rounded once -- so the eight instances agree with eight times the one to within
  // the rounding, and nowhere near to within a factor of eight, which is the failure being ruled out.
  assert.ok(Math.abs(many.heaviest[0]!.marks - 8 * once.heaviest[0]!.marks) <= 8);
});

test('a group carries no marks of its own', () => {
  const flat = budget([hatchNode('h1', 40, 40)]);
  const nested = budget([group('g1', [hatchNode('h1', 40, 40)])]);
  assert.deepEqual(nested.heaviest.map((s) => s.sourceId), ['h1']);
  assert.equal(nested.marks, flat.marks);
});

test('saySpend names nodes, caps the list, and says nothing about an empty sheet', () => {
  const b = budget([solidNode('s1', 20, 20), hatchNode('h1', 40, 40), washNode('w1', 150, 150)]);
  const said = saySpend(b);
  assert.match(said, /^heaviest nodes, in marks: h1 \(paint\/hatch\) \d+, w1 \(wash\/wash\) \d+, s1 \(paint\/solid\) 1/);
  assert.match(said, new RegExp(`of ${b.marks} total$`));

  assert.ok(!saySpend(b, 1).includes('w1'), 'top bounds the list');
  assert.equal(saySpend(budget([])), '', 'a blank sheet has no heaviest node to name');
});

test('the fill rates come from the estimator, and carry its scaling law', () => {
  const small = markRates(PROFILE, PROBE_SMALL);
  const large = markRates(PROFILE, PROBE_LARGE);

  assert.deepEqual(small.map((r) => r.kind), PROFILE.styles, 'every style the profile allows gets a row');
  assert.deepEqual(large.map((r) => r.kind), small.map((r) => r.kind));

  const at = (rows: typeof small, kind: string) => rows.find((r) => r.kind === kind)!.marks;
  assert.equal(at(small, 'solid'), 1);
  assert.equal(at(large, 'solid'), 1, 'a solid does not scale, which is why it is the cheap trap');
  assert.equal(at(small, 'wash'), at(large, 'wash'), 'a wash is priced by its bleed, not its area');

  // 300x300 is nine times the area of 100x100. Reading the two columns side by side is the only way
  // the cost model gets taught, so the ratio has to actually hold.
  for (const kind of ['hatch', 'field'] as const) {
    const ratio = at(large, kind) / at(small, kind);
    assert.ok(Math.abs(ratio - 9) < 0.1, `${kind} should scale with area, got ${ratio}x`);
  }
  assert.ok(at(small, 'hatch') > 100 * at(small, 'solid'), 'and the gap between them is the whole lesson');
});
