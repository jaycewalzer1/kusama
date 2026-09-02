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
//      BOTH the numerator and the denominator, so treeScore reads 1.000 over whatever happened to be
//      decidable from the JSON. This probe used to make its point with a commitment blocked by a
//      missing primitive; `cover.destroys` closed that gap and `withheld` has no blocked constraint
//      left. The point did not go away, it moved: every hard demand this position now makes is
//      measured on the canvas, so a tree score of 1.0 is 1.0 over the soft preferences alone.
//   4. Positions are not interchangeable. A program made for one does not satisfy all of them.
//
// The second probe changed meaning in the same overhaul and the change is worth stating plainly.
// Removing every covering used to violate a hard constraint, because `requireNode {op:'cover'}` was
// hard. It is soft now, along with every other count of node types, because two full runs were spent
// clearing constraints of that kind by editing the tree with no visible change to the picture. The
// cost is real and is asserted below: the tree scope alone can no longer refuse an uncovered sheet.
// Only the canvas can, and the last test here is the demonstration that it does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { checkProgram } from '../check.js';
import { loadCommission } from '../../artist/field.js';
import type { CheckReport, RenderMetrics } from '../types.js';

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
        // Each covering names what it took back. env/validate.ts checks the claim geometrically —
        // the named node has to exist, to have been drawn earlier, and to lie underneath — so these
        // three ids are the difference between a covering and a dark rectangle, and they are the
        // reason `c-erased` is decidable at all.
        op('taken-back-1', 'cover', { region: { type: 'rect', x: 50, y: 70, w: 210, h: 70 }, softness: 0, destroys: ['made-a'] }),
        op('taken-back-2', 'cover', { region: { type: 'rect', x: 90, y: 240, w: 280, h: 80 }, softness: 0, destroys: ['made-b'] }),
        op('taken-back-3', 'cover', { region: { type: 'rect', x: 70, y: 410, w: 190, h: 60 }, softness: 0, destroys: ['made-c'] }),
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

  // What removing every covering costs, exactly. It is soft violations now and not a hard one, and
  // that is the price of refusing to let a node count be hard. Asserted rather than lamented: if
  // this ever becomes a hard violation again, somebody has put a counting constraint back.
  assert.ok(open.softViolations > 0, 'removing every covering violated nothing at all');
  assert.equal(open.hardViolations, 0, 'the tree scope is not supposed to be able to refuse this any more');

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

test('a tree score of 1.0 is 1.0 over the soft preferences, because every hard demand is on the canvas', () => {
  const report = checkProgram(passing(), position, null);
  const treeScoped = report.results.filter((r) => r.scope === 'tree');

  // 1.000, and worth much less than it looks. Every constraint that asks this position for something
  // positive is render-scope now, so with no metrics supplied they are all `unverified`, all outside
  // the fraction, and what is left in the tree is one ban and a handful of soft preferences. That is
  // a better failure than the one it replaces — a blocked commitment could never be measured at all,
  // and these can — but it is still a number that hides its own denominator, which is what this file
  // exists to say.
  assert.equal(tree(report), 1);
  assert.equal(report.renderScore, null, 'nothing measured the canvas, so there is no render score');

  // A hard tree constraint is allowed, but only if it is a ban. `p-no-hatching` is the one here and
  // it is satisfied by a tree with no hatching in it — which is to say, by not doing something,
  // which is the one kind of tree demand that cannot be met by adding a node nobody can see.
  assert.ok(
    treeScoped.filter((r) => r.severity === 'hard').every((r) => r.kind === 'forbidMark'),
    `the only hard tree constraint should be a ban: ${treeScoped.filter((r) => r.severity === 'hard').map((r) => `${r.id}/${r.kind}`).join(', ')}`
  );

  const hard = report.results.filter((r) => r.severity === 'hard');
  const hardDecidable = hard.filter((r) => r.scope !== 'judge' && r.scope !== 'tree');
  assert.ok(hardDecidable.length > 0 && hardDecidable.every((r) => r.scope === 'render'));
  assert.ok(
    hardDecidable.every((r) => r.status === 'unverified'),
    'the hard constraints are unmeasured here, and the 1.000 above does not know it'
  );
  assert.ok(report.pendingRubrics.length > 0, 'rubrics are carried forward unread, not dropped');
});

/**
 * The other half of that sentence: the canvas can refuse what the tree no longer can.
 *
 * The uncovered sheet from the floor test violates nothing hard by tree alone. Hand the same
 * position a measurement in which the sheet is thin, centred, off the edges and holding one blot
 * instead of three, and all four hard constraints fail at once. This is the whole argument for
 * moving them — the numbers below cannot be reached by swapping one op for another.
 */
test('the render scope refuses what the tree scope cannot', () => {
  const thin: RenderMetrics = {
    inkDensity: 0.04,
    coverage: 0.1,
    inkOffset: 0.05,
    symmetry: { vertical: 0.1, horizontal: 0.1 },
    edgeContact: { top: 0, right: 0, bottom: 0, left: 0 },
    opaqueRegions: [0.03],
    pixelHash: 'not-a-real-hash',
  };
  const report = checkProgram(passing(), position, thin);
  const violated = report.results.filter((r) => r.status === 'violated' && r.severity === 'hard');
  assert.ok(violated.length >= 3, `expected the canvas to refuse this: ${JSON.stringify(report.results.map((r) => [r.id, r.status]))}`);
  assert.ok(violated.some((r) => r.kind === 'regionCountRange'), 'one blot is not three opaque areas');
  assert.ok(violated.some((r) => r.kind === 'inkDensityRange'));
  assert.ok(violated.some((r) => r.kind === 'edgeContactRange'));
  assert.notEqual(report.renderScore, null);
  assert.ok(report.renderScore! < 0.5, `render score ${report.renderScore} is too generous for this sheet`);
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
