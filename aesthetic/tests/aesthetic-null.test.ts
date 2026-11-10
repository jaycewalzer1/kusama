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
//      removes the structure under the track instead — a demand the position itself makes, which is
//      the more honest place for it to have been all along.
//   2. The tree scope is blind to composition. Randomising every coordinate in the tree leaves
//      treeScore byte-identical, because every tree-scope kind on these positions is an existence or
//      absence predicate. That is asserted here, deliberately and as a failure recorded rather than
//      hidden: the day someone adds a composition-sensitive tree kind, this test breaks and the
//      comment above it stops being true, which is exactly when it should be reread.
//   3. A score of 1.0 can be 1.0 over a strict subset of the position. Unverified constraints leave
//      BOTH the numerator and the denominator, so treeScore reads 1.000 over whatever happened to be
//      decidable from the JSON. This probe used to make its point with a commitment blocked by a
//      missing primitive; `cover.destroys` closed that gap and `switchback` has no blocked
//      constraint. The point did not go away, it moved: every hard demand this position makes is
//      either measured on the canvas or asked of a viewer, so a tree score of 1.0 is 1.0 over one
//      ban and a handful of soft preferences.
//   4. Positions are not interchangeable. A program made for one does not satisfy all of them.
//
// The second probe changed meaning in the same overhaul and the change is worth stating plainly.
// Removing a class of act used to violate a hard constraint, because `requireNode` was hard. It is
// soft now, along with every other count of node types, because two full runs were spent clearing
// constraints of that kind by editing the tree with no visible change to the picture. The cost is
// real and is asserted below: the tree scope alone can no longer refuse a track with nothing
// holding it up. Only the canvas and the judge can, and the last tests here say which.
//
// This file was written against `withheld`, which was deleted on 2026-09-02 for not depicting
// anything. It now runs against `switchback`, and the six claims above survived the move unchanged
// while every specific number in them had to be rewritten — which is the point of keeping the
// claims and the fixtures in separate places.

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

const bent = (id: string, from: [number, number], to: [number, number]): Node =>
  op(id, 'rule', { from, to, brush: 'rotring', color: 'ink', weight: 2.2 });
const run = (id: string, points: [number, number][]): Node =>
  op(id, 'stroke', { points, brush: 'charcoal', color: 'ink', weight: 2.2, curve: 0.3 });

/**
 * The smallest tree that satisfies every DECIDABLE tree-scope constraint of switchback crossed with
 * two-million-slips: two washes and two hatched passages for the air, ten straight members for the
 * bents and bracing, six drawn runs for the track and the fence, two scatters of people, no flat
 * fill anywhere and no frame macro.
 *
 * Hand-written rather than lifted from a run, so the test does not depend on `out/` — which is
 * gitignored, and would make this test pass or fail depending on what happened to be on the disk.
 * The two signs are not asked for by anything; they are here so the mute probe below has something
 * to take away.
 */
function passing(): Record<string, unknown> {
  return {
    profile: 'default-v1',
    canvas: { width: 900, height: 600, ground: '#efeae0', brushScale: 1 },
    palette: { ink: '#1a1c20', steel: '#4a5560', rust: '#8c3a1f' },
    root: {
      id: 'root',
      type: 'group',
      children: [
        // Air and ground. `c-air` wants three built or wet passages; these are four, and not one of
        // them is a `solid`, which is the position's single hard tree ban.
        op('sky', 'wash', {
          region: { type: 'rect', x: -20, y: -20, w: 940, h: 340 },
          style: { kind: 'wash', color: 'steel', opacity: 38, bleed: 0.2, texture: [0.4, 0.3] },
        }),
        op('dirt', 'wash', {
          region: { type: 'rect', x: -20, y: 470, w: 940, h: 150 },
          style: { kind: 'wash', color: 'rust', opacity: 44, bleed: 0.25, texture: [0.5, 0.3] },
        }),
        op('shade-under', 'paint', {
          region: { type: 'rect', x: 180, y: 300, w: 520, h: 200 },
          style: { kind: 'hatch', brush: '2B', color: 'ink', spacing: 9, angle: 74, rand: 0.12 },
        }),
        op('steel-tone', 'paint', {
          region: { type: 'rect', x: 240, y: 120, w: 420, h: 220 },
          style: { kind: 'hatch', brush: '2H', color: 'steel', spacing: 13, angle: 28, rand: 0.1 },
        }),

        // What holds it up: three bents and four braces, ten members against `g-structure`'s eight.
        bent('bent-1a', [212, 500], [252, 176]),
        bent('bent-1b', [300, 500], [268, 176]),
        bent('bent-2a', [420, 502], [452, 250]),
        bent('bent-2b', [500, 502], [468, 250]),
        bent('bent-3a', [606, 504], [632, 318]),
        bent('bent-3b', [672, 504], [648, 318]),
        bent('brace-1', [222, 420], [296, 300]),
        bent('brace-2', [296, 420], [226, 300]),
        bent('brace-3', [430, 440], [498, 340]),
        bent('brace-4', [498, 440], [432, 340]),

        // The track, in five runs from lift hill to brake run, plus the fence in the way.
        run('lift-hill', [[-20, 470], [90, 380], [180, 268], [258, 168]]),
        run('crest', [[258, 168], [300, 150], [346, 158], [386, 196]]),
        run('drop', [[386, 196], [412, 300], [434, 400], [462, 452]]),
        run('valley-turn', [[462, 452], [528, 420], [578, 356], [624, 312]]),
        run('brake-run', [[624, 312], [720, 322], [820, 330], [920, 344]]),
        run('fence-line', [[-20, 546], [220, 538], [520, 544], [920, 536]]),

        // Somebody is here.
        op('queue', 'fragment', {
          name: 'figure.crowd',
          x: 200,
          y: 540,
          span: 260,
          rotate: 0,
          style: { kind: 'outline', brush: 'cpencil', color: 'ink', weight: 1.3 },
        }),
        op('watcher', 'fragment', {
          name: 'figure.standing',
          x: 738,
          y: 528,
          span: 96,
          rotate: 0,
          style: { kind: 'outline', brush: '2B', color: 'ink', weight: 1.6 },
        }),

        op('sign-name', 'text', { text: 'SWITCHBACK', font: 'anton', size: 36, x: 690, y: 152, color: 'ink' }),
        op('sign-price', 'text', { text: 'ONE RIDE', font: 'anton', size: 22, x: 690, y: 186, color: 'rust' }),
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
  const point = (): [number, number] => [rnd(880) + 10, rnd(580) + 10];
  for (const node of kids(q)) {
    const args = node['args'] as Record<string, unknown>;
    if (args['x'] !== undefined) args['x'] = rnd(880) + 10;
    if (args['y'] !== undefined) args['y'] = rnd(580) + 10;
    if (args['from'] !== undefined) args['from'] = point();
    if (args['to'] !== undefined) args['to'] = point();
    const points = args['points'] as unknown[] | undefined;
    if (points) args['points'] = points.map(point);
    const region = args['region'] as Record<string, number> | undefined;
    if (region) {
      region['x'] = rnd(700);
      region['y'] = rnd(500);
    }
  }
  return q;
}

function withoutText(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  (q['root'] as { children: Node[] }).children = kids(q).filter((n) => n['op'] !== 'text');
  return q;
}

/** Everything else intact: the air, the track, the crowd, the signs. Only what holds it up gone. */
function withoutStructure(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  (q['root'] as { children: Node[] }).children = kids(q).filter((n) => n['op'] !== 'rule');
  return q;
}

function empty(p: Record<string, unknown>): Record<string, unknown> {
  const q = copy(p);
  (q['root'] as { children: Node[] }).children = [];
  return q;
}

const commission = loadCommission('switchback', 'two-million-slips');
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

test('the floor is well below the ceiling: an empty sheet and an unbraced sheet both score worse', () => {
  const ceiling = tree(checkProgram(passing(), position, null));
  const blank = checkProgram(empty(passing()), position, null);
  const floating = checkProgram(withoutStructure(passing()), position, null);

  assert.ok(tree(blank) < ceiling * 0.7, `an empty sheet scored ${tree(blank)} against a ceiling of ${ceiling}`);
  assert.ok(
    tree(floating) < ceiling,
    `a track with nothing under it scored ${tree(floating)}, the same as one on a braced frame`
  );

  // What taking the structure out costs, exactly. It is soft violations now and not a hard one, and
  // that is the price of refusing to let a node count be hard. Asserted rather than lamented: if
  // this ever becomes a hard violation again, somebody has put a counting constraint back.
  assert.ok(floating.softViolations > 0, 'removing every straight member violated nothing at all');
  assert.equal(floating.hardViolations, 0, 'the tree scope is not supposed to be able to refuse this any more');

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

  // A hard tree constraint is allowed, but only if it is a ban. `p-no-flat` is the one here and it
  // is satisfied by a tree with no opaque fill in it — which is to say, by not doing something,
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
 * The unbraced sheet from the floor test violates nothing hard by tree alone. Hand the same
 * position a measurement in which the ride is drawn dead-on from nowhere and the sheet has broken
 * into four flat plates, and both of its hard render constraints fail at once. This is the whole
 * argument for moving them — neither number below can be reached by swapping one op for another.
 *
 * Two, not the four this test began with. `switchback` puts only `r-somewhere` and `r-not-plated`
 * on the canvas and sends the rest of its demands to a viewer, and asserting a count of three here
 * would be asserting a fact about a deleted position rather than about the checker.
 */
test('the render scope refuses what the tree scope cannot', () => {
  const plated: RenderMetrics = {
    inkDensity: 0.42,
    coverage: 0.5,
    inkOffset: 0.02,
    symmetry: { vertical: 0.94, horizontal: 0.3 },
    edgeContact: { top: 0, right: 0, bottom: 0, left: 0 },
    opaqueRegions: [0.3, 0.22, 0.18, 0.09],
    pixelHash: 'not-a-real-hash',
  };
  const report = checkProgram(passing(), position, plated);
  const violated = report.results.filter((r) => r.status === 'violated' && r.severity === 'hard');
  assert.ok(violated.length >= 2, `expected the canvas to refuse this: ${JSON.stringify(report.results.map((r) => [r.id, r.status]))}`);
  assert.ok(violated.some((r) => r.kind === 'regionCountRange'), 'four plates is not at most two opaque areas');
  assert.ok(violated.some((r) => r.kind === 'symmetryMax'), 'a mirror-symmetrical ride was drawn from nowhere');

  // Every hard render constraint this position has is in that list, so there is nothing left to
  // carry the score. If a third is ever added, this drops below 1 instead of to 0 and the assertion
  // above still holds — which is why the count is a floor and this is a bound, not an equality.
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
    `a program made for switchback scored 1.0 on every position: ${perfect.join(' ')}`
  );
});
