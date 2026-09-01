// The null test: does checkProgram discriminate, or does it rubber-stamp?
//
// A run of the artist loop came back with tree 1.0, render 1.0, 0 hard, 0 soft, 6/6 problems
// grounded and 18/18 sketches drawn. Every gate at 100% is not a good result, it is a checker under
// suspicion, and the way to settle it is to hand the checker programs that are deliberately wrong
// and see whether the number moves.
//
// What that measurement found, and what this file pins so it cannot regress unnoticed:
//
//   1. The floor is well below 1. An empty sheet does not pass, and neither does a sheet that is
//      complete except for one class of act. So the checker is not a rubber stamp.
//      This second probe used to remove the text, because the brief carried three `textRequired`
//      constraints. Conditions replaced briefs and no longer require anybody to say anything, so a
//      mute sheet is now legitimately fine and the probe would have been measuring nothing. It now
//      removes the coverings instead — a demand the position itself makes, which is the more
//      honest place for it to have been all along.
//   2. The tree scope is blind to composition. Randomising every coordinate in the tree leaves
//      treeScore byte-identical, because every tree-scope kind on these positions is an existence or
//      absence predicate. That is asserted here, deliberately and as a failure recorded rather than
//      hidden: the day someone adds a composition-sensitive tree kind, this test breaks and the
//      comment above it stops being true, which is exactly when it should be reread.
//   3. A score of 1.0 can be 1.0 over a strict subset of the position. Unverified constraints leave
//      BOTH the numerator and the denominator, so a position whose load-bearing hard commitment is
//      blocked by a missing primitive still reads 1.000. The count of what was left out is asserted
//      to be visible in the report, because a number that hides its own denominator is the thing
//      this whole file exists to catch.
//   4. Positions are not interchangeable. A program made for one does not satisfy all of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { checkProgram } from '../check.js';
import { loadCommission } from '../../artist/field.js';
import type { CheckReport } from '../types.js';

type Node = Record<string, unknown>;

function op(id: string, name: string, args: Record<string, unknown>): Node {
  return { id, type: 'op', op: name, rngKey: `k/${id}`, args };
}

/**
 * The smallest tree that satisfies every DECIDABLE tree-scope constraint of withheld crossed with
 * two-million-slips: four opaque blocks, one sealed region, three coverings, three texts of at most
 * four words carrying the three required strings, no hatching, no repeat, and few enough drawing
 * nodes to stay under the ceiling.
 *
 * Hand-written rather than lifted from a run, so the test does not depend on `out/` — which is
 * gitignored, and would make this test pass or fail depending on what happened to be on the disk.
 */
function passing(): Record<string, unknown> {
  return {
    profile: 'default-v1',
    canvas: { width: 500, height: 700, ground: '#f2efe6', brushScale: 1 },
    palette: { ink: '#111111', red: '#cc2200' },
    root: {
      id: 'root',
      type: 'group',
      children: [
        op('made-a', 'paint', {
          region: { type: 'rect', x: 20, y: 40, w: 300, h: 120 },
          style: { kind: 'solid', color: 'ink', opacity: 255 },
        }),
        op('made-b', 'paint', {
          region: { type: 'rect', x: 60, y: 200, w: 380, h: 150 },
          style: { kind: 'solid', color: 'ink', opacity: 255 },
        }),
        op('made-c', 'paint', {
          region: { type: 'rect', x: 40, y: 380, w: 260, h: 130 },
          style: { kind: 'solid', color: 'red', opacity: 255 },
        }),
        op('made-d', 'paint', {
          region: { type: 'circle', x: 360, y: 560, r: 90 },
          style: { kind: 'solid', color: 'ink', opacity: 255 },
        }),
        {
          id: 'sealed',
          type: 'macro',
          macro: 'quarantine',
          rngKey: 'k/sealed',
          args: {
            x: 200,
            y: 430,
            w: 180,
            h: 120,
            style: { kind: 'solid', color: 'ink', opacity: 255 },
            boxBrush: 'marker',
            boxColor: 'ink',
            boxWeight: 4,
            label: 'NOT THIS',
            labelFont: 'anton',
            labelSize: 20,
          },
        },
        op('taken-back-1', 'cover', { region: { type: 'rect', x: 50, y: 70, w: 210, h: 70 }, softness: 0 }),
        op('taken-back-2', 'cover', { region: { type: 'rect', x: 90, y: 240, w: 280, h: 80 }, softness: 0 }),
        op('taken-back-3', 'cover', { region: { type: 'rect', x: 70, y: 410, w: 190, h: 60 }, softness: 0 }),
        op('t-since', 'text', { text: '1961', font: 'anton', size: 64, x: 30, y: 660, color: 'ink' }),
        op('t-extent', 'text', { text: '2.1 MILLION', font: 'anton', size: 48, x: 30, y: 610, color: 'ink' }),
        op('t-date', 'text', { text: '14 JANUARY', font: 'anton', size: 48, x: 30, y: 560, color: 'red' }),
        op('escapes', 'rule', { from: [16, 36], to: [326, 44], brush: 'marker', color: 'ink', weight: 3 }),
      ],
    },
  };
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const kids = (p: Record<string, unknown>): Node[] => (p['root'] as { children: Node[] }).children;

/** Every x and y in the tree replaced by a deterministic pseudo-random one. No fact changes. */
function scrambled(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  let s = 7;
  const rnd = (n: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return Math.floor((s / 2147483648) * n);
  };
  for (const node of kids(q)) {
    const args = node['args'] as Record<string, unknown>;
    if (args['x'] !== undefined) args['x'] = rnd(500);
    if (args['y'] !== undefined) args['y'] = rnd(690) + 10;
    const region = args['region'] as Record<string, number> | undefined;
    if (region) {
      region['x'] = rnd(400);
      region['y'] = rnd(600);
    }
  }
  return q;
}

function withoutText(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  (q['root'] as { children: Node[] }).children = kids(q).filter((n) => n['op'] !== 'text');
  return q;
}

/** Everything else intact: the blocks, the seal, the type, the rule. Only the coverings gone. */
function withoutCovers(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  (q['root'] as { children: Node[] }).children = kids(q).filter((n) => n['op'] !== 'cover');
  return q;
}

function empty(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  (q['root'] as { children: Node[] }).children = [];
  return q;
}

const commission = loadCommission('withheld', 'two-million-slips');
const position = commission.effective;
const tree = (r: CheckReport): number => {
  assert.notEqual(r.treeScore, null, 'this position has decidable tree constraints');
  return r.treeScore!;
};

test('the passing program does pass, so the rest of this file is measuring a real ceiling', () => {
  const report = checkProgram(passing(), position, null);
  assert.equal(report.hardViolations, 0, JSON.stringify(report.results.filter((r) => r.status === 'violated'), null, 1));
  assert.equal(tree(report), 1);
});

test('the floor is well below the ceiling: an empty sheet and an uncovered sheet both score worse', () => {
  const ceiling = tree(checkProgram(passing(), position, null));
  const blank = checkProgram(empty(passing()), position, null);
  const open = checkProgram(withoutCovers(passing()), position, null);

  assert.ok(tree(blank) < ceiling * 0.7, `an empty sheet scored ${tree(blank)} against a ceiling of ${ceiling}`);
  assert.ok(tree(open) < ceiling, `a sheet with nothing covered scored ${tree(open)}, the same as one with coverings`);
  assert.ok(open.hardViolations > 0, 'removing every covering violated no hard constraint');

  // And the counterpart, now that L2 asks for no strings: taking the words out is NOT a failure.
  // A work is allowed to say nothing. If this ever starts violating something, a commission has
  // come back in through a constraint list.
  const mute = checkProgram(withoutText(passing()), position, null);
  assert.equal(mute.hardViolations, 0, 'a sheet with no words on it violated a hard constraint: something is requiring speech again');
});

test('the tree scope is blind to composition: scrambling every coordinate changes nothing', () => {
  // Not a bug being tolerated — a limit being written down. Every tree-scope kind these positions
  // use is an existence or absence predicate over facts, and none of them reads a coordinate. An
  // artist can therefore reach treeScore 1.0 without arranging anything, and any claim that a high
  // tree score means the piece is composed is a claim this repo cannot support.
  const before = checkProgram(passing(), position, null);
  const after = checkProgram(scrambled(passing()), position, null);
  assert.equal(after.treeScore, before.treeScore);
  assert.equal(after.hardViolations, before.hardViolations);
  assert.equal(after.softViolations, before.softViolations);
});

test('a tree score of 1.0 is 1.0 over what could be decided, and the rest is countable', () => {
  const report = checkProgram(passing(), position, null);
  const treeScoped = report.results.filter((r) => r.scope === 'tree');
  const undecided = treeScoped.filter((r) => r.status === 'unverified');

  // The position's own load-bearing commitment — a region that is the remainder of something
  // destroyed — is blocked by a missing primitive. It is hard, it is unverified, and it leaves both
  // sides of the fraction. So the
  // headline reads 1.000 while the thing the position is actually about went unmeasured.
  assert.equal(tree(report), 1);
  assert.ok(undecided.length > 0, 'this position is supposed to have an undecidable tree constraint');
  assert.ok(
    undecided.some((r) => r.severity === 'hard' && r.blocked_by !== undefined),
    'the blocked hard commitment is what makes this test worth having'
  );
  // The only defence is that the omission is visible. If it ever stops being counted, fail here.
  assert.equal(report.blocked, treeScoped.filter((r) => r.blocked_by !== undefined).length);
  assert.ok(report.blocked > 0);
  assert.ok(report.pendingRubrics.length > 0, 'rubrics are carried forward unread, not dropped');
});

test('positions are not interchangeable: one program does not satisfy all of them', () => {
  const program = passing();
  const ids = readdirSync(path.join(ROOT, 'aesthetic', 'positions')).map((f) => f.replace(/\.json$/, ''));
  assert.ok(ids.length >= 3, 'expected the catalog of positions on disk');

  const perfect = ids.filter((id) => {
    const c = loadCommission(id, 'two-million-slips');
    return checkProgram(program, c.effective, null).treeScore === 1;
  });
  // A false pass is expected — positions overlap, and one program legitimately answering two of
  // them is not a defect. All of them would mean the position is not doing any work at all.
  assert.ok(
    perfect.length < ids.length,
    `a program made for withheld scored 1.0 on every position: ${perfect.join(' ')}`
  );
});
