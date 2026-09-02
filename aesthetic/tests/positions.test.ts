// What a position is allowed to insist on.
//
// The schema in aesthetic-program.schema.json will accept a program with twelve hard constraints,
// and for a while every position on disk had ten to thirteen. Two things went wrong at that density
// and both were measured rather than felt. The first: between them the constraints admitted roughly
// one object, so the worldview prose stopped mattering and the constraint list did all the deciding.
// The second: the hard ones that counted node types in the source tree were satisfiable by editing
// the source tree, and two full runs were spent doing exactly that — swapping `rule` ops for
// `stroke` ops to clear a `forbidNode`, adding a `paint` with a solid style under a covering to
// clear a `requireMark` — with the constraint going green and nobody able to see a difference.
//
// So this file asserts a budget, not a style. Four hard decidable constraints, none of them a count,
// and every hard tree-scope one a ban or a ceiling. Rubrics are exempt and uncapped: a rubric is
// read by somebody who can weigh it, which is where the content of a practice belongs.
//
// The six cross-check programs in examples/aesthetic/ are deliberately NOT held to this and are
// covered by aesthetic-fixtures.test.ts instead. They are the exhibit of what the budget prevents.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { constraintsOf, loadAestheticProgram, positionIssues } from '../check.js';
import { COUNTING_KINDS, MAX_HARD_CONSTRAINTS } from '../types.js';
import type { AestheticProgram } from '../types.js';

const POSITIONS = path.join(ROOT, 'aesthetic', 'positions');

function positions(): { id: string; file: string; ap: AestheticProgram }[] {
  return readdirSync(POSITIONS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(POSITIONS, f);
      return { id: f.replace(/\.json$/, ''), file, ap: loadAestheticProgram(file) };
    });
}

/** Counting the disk rather than trusting a list, because the list has been wrong before. */
test('there are positions on disk and every one of them loads', () => {
  const found = positions();
  assert.ok(found.length >= 3, `expected at least three positions, found ${found.length}`);
  for (const { id, ap } of found) assert.equal(ap.id, id, 'a position id must match its filename');
});

test('every position on disk is within the hard-constraint budget', () => {
  for (const { id, ap } of positions()) {
    const issues = positionIssues(ap);
    assert.deepEqual(issues, [], `${id} is over budget:\n  ${issues.join('\n  ')}`);
  }
});

/**
 * The budget restated as the two facts a reader would want, so a failure says which rule broke
 * rather than only that something did. This duplicates positionIssues on purpose: if the function
 * and the rule ever disagree, the rule is what was meant.
 */
test('no position makes a node count hard, and none carries more than four hard decidable constraints', () => {
  for (const { id, ap } of positions()) {
    const hard = constraintsOf(ap)
      .map(({ constraint }) => constraint)
      .filter((c) => c.severity === 'hard');

    for (const c of hard) {
      assert.ok(
        !COUNTING_KINDS.includes(c.kind),
        `${id}/${c.id} is a hard "${c.kind}", which counts nodes and can be cleared without moving a pixel`
      );
    }

    const decidable = hard.filter((c) => c.scope !== 'judge');
    assert.ok(
      decidable.length <= MAX_HARD_CONSTRAINTS,
      `${id} has ${decidable.length} hard decidable constraints (${decidable.map((c) => c.id).join(', ')})`
    );
  }
});

/**
 * The part that is easy to get wrong while satisfying everything above: a position could come in
 * under budget by having no hard constraints at all, which is not restraint, it is having no
 * position. At least one hard constraint has to be measured on the canvas, because that is the one
 * kind of demand this environment has never seen gamed.
 */
test('every position still makes at least one demand of the image itself', () => {
  for (const { id, ap } of positions()) {
    const hardRender = constraintsOf(ap).filter(
      ({ constraint }) => constraint.severity === 'hard' && constraint.scope === 'render'
    );
    assert.ok(hardRender.length >= 1, `${id} insists on nothing the renderer can measure`);
  }
});

/**
 * `positionIssues` has to actually refuse things, or the three tests above pass because it never
 * says no. Both rules are exercised against a program built to break exactly one of them.
 */
test('positionIssues refuses a hard node count and refuses a fifth hard constraint', () => {
  const base: AestheticProgram = {
    version: '1.0',
    id: 'under-test',
    name: 'Under test',
    lineage: [],
    worldview: 'a fixture',
    tensions: [],
    commitments: [],
    prohibitions: [],
    generative_rules: [],
    cliches: [],
  };

  const counting = {
    ...base,
    commitments: [
      { id: 'c1', kind: 'requireNode' as const, params: { op: 'cover', min: 3 }, scope: 'tree' as const, severity: 'hard' as const, why: 'x' },
    ],
  };
  const countingIssues = positionIssues(counting);
  assert.equal(countingIssues.length, 1);
  assert.match(countingIssues[0]!, /counts nodes in the source tree/);

  const five = {
    ...base,
    prohibitions: [0, 1, 2, 3, 4].map((n) => ({
      id: `p${n}`,
      kind: 'forbidMark' as const,
      params: { styles: ['hatch'] },
      scope: 'tree' as const,
      severity: 'hard' as const,
      why: 'x',
    })),
  };
  const fiveIssues = positionIssues(five);
  assert.equal(fiveIssues.length, 1);
  assert.match(fiveIssues[0]!, /5 hard decidable constraints/);

  // And four of the same is fine, so the message above is about the fifth and not about the kind.
  assert.deepEqual(positionIssues({ ...five, prohibitions: five.prohibitions.slice(0, 4) }), []);

  // Judge rubrics are exempt: five hard ones alongside four hard decidable is still within budget.
  const withRubrics = {
    ...five,
    prohibitions: five.prohibitions.slice(0, 4),
    commitments: [0, 1, 2, 3, 4].map((n) => ({
      id: `j${n}`,
      kind: 'rubric' as const,
      params: { text: 'a question for a reader' },
      scope: 'judge' as const,
      severity: 'hard' as const,
      why: 'x',
    })),
  };
  assert.deepEqual(positionIssues(withRubrics), []);
});
