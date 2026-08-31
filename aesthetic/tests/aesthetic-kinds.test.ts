// One passing tree and one failing tree for every constraint kind.
//
// The trees here are the smallest thing that makes the kind fire, not plausible pictures. They are
// never rendered and never validated against the medium's own schema: a checker that needed a valid
// program to reach a verdict could not be run on a half-finished edit, which is most of what it is
// for. The 12 authored fixtures in aesthetic-fixtures.test.ts are the ones that are real programs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTRAINT_KINDS, checkConstraint } from '../kinds.js';
import type { Constraint, ConstraintKind, RenderMetrics } from '../types.js';

type Node = Record<string, unknown>;

function prog(children: Node[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canvas: { width: 100, height: 100, ground: '#ffffff', brushScale: 1 },
    palette: { ink: '#111111', red: '#cc0000', blue: '#0000cc' },
    ...extra,
    root: { id: 'root', type: 'group', children },
  };
}

function op(id: string, name: string, args: Record<string, unknown>): Node {
  return { id, type: 'op', op: name, rngKey: 'k/' + id, args };
}

function macro(id: string, name: string, args: Record<string, unknown> = {}): Node {
  return { id, type: 'macro', macro: name, rngKey: 'k/' + id, args };
}

function solid(id: string, color = 'ink'): Node {
  return op(id, 'paint', {
    region: { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    style: { kind: 'solid', color, opacity: 255 },
  });
}

function text(id: string, body: string, color = 'ink'): Node {
  return op(id, 'text', { text: body, font: 'grotesque', size: 12, x: 0, y: 0, color });
}

function repeat(id: string, children: Node[]): Node {
  return {
    id,
    type: 'repeat',
    rngKey: 'k/' + id,
    count: 2,
    layout: { type: 'line', origin: [0, 0], dx: 5, dy: 0 },
    children,
  };
}

function constraint(kind: ConstraintKind, params: Record<string, unknown>, scope: Constraint['scope'] = 'tree'): Constraint {
  return { id: 'x', kind, params, scope, severity: 'hard', why: 'under test' };
}

function metrics(over: Partial<RenderMetrics> = {}): RenderMetrics {
  return {
    inkDensity: 0.3,
    coverage: 0.5,
    inkOffset: 0.2,
    symmetry: { vertical: 0.2, horizontal: 0.2 },
    edgeContact: { top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 },
    pixelHash: 'deadbeef',
    ...over,
  };
}

/** Every kind is asserted both ways in one call, so a kind that always returns the same verdict fails. */
function bothWays(
  kind: ConstraintKind,
  params: Record<string, unknown>,
  passing: unknown,
  failing: unknown,
  scope: Constraint['scope'] = 'tree',
  m: RenderMetrics | null = null,
): void {
  const c = constraint(kind, params, scope);
  const good = checkConstraint(c, passing, m);
  const bad = checkConstraint(c, failing, m);
  assert.equal(good.status, 'satisfied', `${kind} should have accepted the passing tree: ${good.evidence}`);
  assert.equal(bad.status, 'violated', `${kind} should have rejected the failing tree: ${bad.evidence}`);
  assert.ok(bad.evidence.length > 0, `${kind} must say why`);
}

test('the constraint language is closed at eighteen kinds', () => {
  assert.equal(CONSTRAINT_KINDS.length, 18);
  assert.equal(new Set(CONSTRAINT_KINDS).size, 18);
});

/**
 * The caption test. Not a length and not a wording — type set small enough to read as apparatus
 * rather than as image, which is the difference between a work with words in it and a work with a
 * label on it, and which no combination of the other sixteen kinds could decide.
 */
test('textMinHeight measures set size against the sheet, not against a fixed number of units', () => {
  const big = op('t', 'text', { text: 'ONE', font: 'grotesque', size: 90, x: 0, y: 0, color: 'ink' });
  // 3 on a 100-unit sheet is 0.03: a credit line. 90 is 0.90: the string is the picture.
  const small = op('t', 'text', { text: 'ONE', font: 'grotesque', size: 3, x: 0, y: 0, color: 'ink' });
  bothWays('textMinHeight', { min: 0.05 }, prog([big]), prog([small]));

  // The same 40-unit string passes on a short sheet and fails on a tall one.
  const forty = op('t', 'text', { text: 'ONE', font: 'grotesque', size: 40, x: 0, y: 0, color: 'ink' });
  const on = (height: number) => ({ ...(prog([forty]) as Record<string, unknown>), canvas: { width: 400, height, ground: '#ffffff', brushScale: 1 } });
  assert.equal(checkConstraint(constraint('textMinHeight', { min: 0.05 }), on(600), null).status, 'satisfied');
  assert.equal(checkConstraint(constraint('textMinHeight', { min: 0.05 }), on(1600), null).status, 'violated');
});

/** A quarantine label is set by the macro at a size the program never states. Unmeasured, not small. */
test('textMinHeight excludes quarantine labels rather than failing them', () => {
  const labelled: Node = {
    id: 'q',
    type: 'macro',
    macro: 'quarantine',
    rngKey: 'k/q',
    args: { region: { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, label: 'HELD' },
  } as unknown as Node;
  const v = checkConstraint(constraint('textMinHeight', { min: 0.05 }), prog([labelled]), null);
  assert.equal(v.status, 'satisfied');
  assert.match(v.evidence, /no set type/);
});

test('maxDistinctColors counts palette-resolved hexes and the ground', () => {
  bothWays(
    'maxDistinctColors',
    { max: 2, includeGround: true },
    prog([solid('a', 'ink'), solid('b', 'ink')]),
    prog([solid('a', 'ink'), solid('b', 'red')]),
  );
});

test('maxDistinctColors can be told to ignore the ground', () => {
  const c = constraint('maxDistinctColors', { max: 1, includeGround: false });
  assert.equal(checkConstraint(c, prog([solid('a', 'ink')]), null).status, 'satisfied');
  assert.equal(checkConstraint(constraint('maxDistinctColors', { max: 1, includeGround: true }), prog([solid('a', 'ink')]), null).status, 'violated');
});

test('palette names the offending node, not just the colour', () => {
  const c = constraint('palette', { allow: ['#111111', '#ffffff'], includeGround: true });
  assert.equal(checkConstraint(c, prog([solid('inside', 'ink')]), null).status, 'satisfied');
  const bad = checkConstraint(c, prog([solid('outside', 'red')]), null);
  assert.equal(bad.status, 'violated');
  assert.match(bad.evidence, /outside/);
  assert.match(bad.evidence, /#cc0000/);
});

test('forbidNode catches ops and macros by name', () => {
  bothWays(
    'forbidNode',
    { ops: ['fragment'], macros: ['motif'] },
    prog([solid('a')]),
    prog([solid('a'), op('f', 'fragment', { name: 'blob', x: 0, y: 0, span: 10, style: { kind: 'solid', color: 'ink' } })]),
  );
  bothWays('forbidNode', { macros: ['frame'] }, prog([solid('a')]), prog([macro('m', 'frame')]));
});

test('requireNode counts one named op or macro against a floor', () => {
  bothWays('requireNode', { op: 'text', min: 2 }, prog([text('t1', 'A'), text('t2', 'B')]), prog([text('t1', 'A')]));
  bothWays('requireNode', { macro: 'frame', min: 1 }, prog([macro('m', 'frame')]), prog([solid('a')]));
});

test('nodeCount counts drawing nodes and optionally containers', () => {
  bothWays('nodeCount', { max: 2 }, prog([solid('a'), solid('b')]), prog([solid('a'), solid('b'), solid('c')]));
  bothWays('nodeCount', { min: 3 }, prog([solid('a'), solid('b'), solid('c')]), prog([solid('a')]));

  const withGroups = constraint('nodeCount', { max: 1, countGroups: true });
  // one solid inside a repeat: 1 drawing node, but 2 containers (root group + repeat).
  assert.equal(checkConstraint(withGroups, prog([repeat('r', [solid('a')])]), null).status, 'violated');
});

test('textCase reads quarantine labels as text', () => {
  bothWays('textCase', { case: 'upper' }, prog([text('t', 'SHOUT')]), prog([text('t', 'Shout')]));
  bothWays('textCase', { case: 'lower' }, prog([text('t', 'quiet')]), prog([text('t', 'QUIET')]));

  const c = constraint('textCase', { case: 'upper' });
  const labelled = prog([macro('q', 'quarantine', { x: 0, y: 0, w: 10, h: 10, label: 'lowercase label' })]);
  const bad = checkConstraint(c, labelled, null);
  assert.equal(bad.status, 'violated');
  assert.match(bad.evidence, /^q /);
});

test('textMaxWords splits on whitespace runs, so the three-space workaround is free', () => {
  bothWays('textMaxWords', { max: 3 }, prog([text('t', 'ONE TWO THREE')]), prog([text('t', 'ONE TWO THREE FOUR')]));
  // NOTES E3: tracked text needs three spaces between words. It must not cost a word.
  const c = constraint('textMaxWords', { max: 2 });
  assert.equal(checkConstraint(c, prog([text('t', 'UR   014')]), null).status, 'satisfied');
});

test('textRequired is case- and whitespace-insensitive across the whole tree', () => {
  bothWays(
    'textRequired',
    { contains: ['14 NOVEMBER', 'RYE LANE'] },
    prog([text('a', '14   NOVEMBER'), text('b', 'the pit, rye lane')]),
    prog([text('a', '14 NOVEMBER')]),
  );
  const bad = checkConstraint(constraint('textRequired', { contains: ['5 POUNDS'] }), prog([text('a', 'FREE')]), null);
  assert.match(bad.evidence, /5 POUNDS/);
});

test('maxRepeatDepth measures nesting, not instance count', () => {
  bothWays('maxRepeatDepth', { max: 1 }, prog([repeat('r', [solid('a')])]), prog([repeat('r', [repeat('r2', [solid('a')])])]));
  assert.equal(checkConstraint(constraint('maxRepeatDepth', { max: 0 }), prog([solid('a')]), null).status, 'satisfied');
});

test('forbidMark catches a style kind or a brush anywhere a mark is made', () => {
  const washed = op('w', 'wash', {
    region: { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
    style: { kind: 'wash', color: 'ink', opacity: 120, bleed: 0.2, texture: [0.5, 0.5] },
  });
  bothWays('forbidMark', { styles: ['wash'] }, prog([solid('a')]), prog([washed]));

  const soft = op('s', 'stroke', { points: [[0, 0], [5, 5]], brush: 'crayon', color: 'ink', weight: 1 });
  bothWays('forbidMark', { brushes: ['crayon'] }, prog([solid('a')]), prog([soft]));
});

test('requireMark counts styles and brushes together against one floor', () => {
  const pen = (id: string) => op(id, 'rule', { from: [0, 0], to: [5, 0], brush: 'rotring', color: 'ink', weight: 1 });
  bothWays('requireMark', { styles: ['solid'], min: 2 }, prog([solid('a'), solid('b')]), prog([solid('a'), pen('r')]));
  bothWays('requireMark', { brushes: ['rotring'], min: 2 }, prog([pen('r1'), pen('r2')]), prog([pen('r1'), solid('a')]));
});

test('inkDensityRange, coverageRange, symmetryMax and inkOffsetRange read the metrics and nothing else', () => {
  const tree = prog([solid('a')]);
  assert.equal(
    checkConstraint(constraint('inkDensityRange', { min: 0.2, max: 0.4 }, 'render'), tree, metrics({ inkDensity: 0.3 })).status,
    'satisfied',
  );
  assert.equal(
    checkConstraint(constraint('inkDensityRange', { min: 0.2, max: 0.4 }, 'render'), tree, metrics({ inkDensity: 0.9 })).status,
    'violated',
  );
  assert.equal(
    checkConstraint(constraint('coverageRange', { min: 0.4 }, 'render'), tree, metrics({ coverage: 0.5 })).status,
    'satisfied',
  );
  assert.equal(
    checkConstraint(constraint('coverageRange', { min: 0.4 }, 'render'), tree, metrics({ coverage: 0.1 })).status,
    'violated',
  );
  assert.equal(
    checkConstraint(constraint('symmetryMax', { axis: 'vertical', max: 0.5 }, 'render'), tree, metrics()).status,
    'satisfied',
  );
  assert.equal(
    checkConstraint(constraint('symmetryMax', { axis: 'vertical', max: 0.5 }, 'render'), tree, metrics({ symmetry: { vertical: 0.9, horizontal: 0 } })).status,
    'violated',
  );
  assert.equal(
    checkConstraint(constraint('inkOffsetRange', { min: 0.1 }, 'render'), tree, metrics({ inkOffset: 0.3 })).status,
    'satisfied',
  );
  assert.equal(
    checkConstraint(constraint('inkOffsetRange', { min: 0.1 }, 'render'), tree, metrics({ inkOffset: 0.02 })).status,
    'violated',
  );
});

/**
 * The kind that exists because of a real run: four untouched margins, and nothing in the other
 * seventeen could name it. Density and coverage are quantities of ink, not places, and a picture can
 * satisfy any offset while stopping short of the border on every side.
 */
test('edgeContactRange demands every side by default, so an all-round margin cannot pass', () => {
  const tree = prog([solid('a')]);
  const at = (top: number, right: number, bottom: number, left: number) =>
    metrics({ edgeContact: { top, right, bottom, left } });
  const need = constraint('edgeContactRange', { min: 0.1 }, 'render');

  assert.equal(checkConstraint(need, tree, at(0.4, 0.4, 0.4, 0.4)).status, 'satisfied');
  // The motivating failure. A clean band all the way round.
  assert.equal(checkConstraint(need, tree, at(0, 0, 0, 0)).status, 'violated');
  // And the one a `minSides: 3` default would have let through: three sides run off, one is clean.
  const three = checkConstraint(need, tree, at(0.4, 0.4, 0.4, 0));
  assert.equal(three.status, 'violated', 'a single untouched side is still an untouched side');
  assert.match(three.evidence, /3 of 4 sides/);
  assert.match(three.evidence, /left 0\.0000/, 'the evidence names the side and its value');
});

test('edgeContactRange can be asked about some sides, and about how many of them must hold', () => {
  const tree = prog([solid('a')]);
  const at = (top: number, right: number, bottom: number, left: number) =>
    metrics({ edgeContact: { top, right, bottom, left } });

  // Asymmetry is the whole point of four numbers: run off the bottom, leave the top alone.
  const bleedBottom = constraint('edgeContactRange', { sides: ['bottom'], min: 0.5 }, 'render');
  const keepTop = constraint('edgeContactRange', { sides: ['top'], max: 0.01 }, 'render');
  const m = at(0, 0.3, 0.9, 0.3);
  assert.equal(checkConstraint(bleedBottom, tree, m).status, 'satisfied');
  assert.equal(checkConstraint(keepTop, tree, m).status, 'satisfied');
  // The named side is the one that decides: a clean top does not fail a question about the bottom.
  assert.equal(checkConstraint(bleedBottom, tree, at(0.9, 0.9, 0, 0.9)).status, 'violated');

  // minSides asks for a count without saying which — "reach the edge somewhere, twice".
  const anyTwo = constraint('edgeContactRange', { min: 0.5, minSides: 2 }, 'render');
  assert.equal(checkConstraint(anyTwo, tree, at(0.9, 0.9, 0, 0)).status, 'satisfied');
  assert.equal(checkConstraint(anyTwo, tree, at(0.9, 0, 0, 0)).status, 'violated');
});

test('render kinds come back unverified without metrics, never assumed', () => {
  for (const kind of ['inkDensityRange', 'coverageRange', 'symmetryMax', 'inkOffsetRange', 'edgeContactRange'] as const) {
    const v = checkConstraint(constraint(kind, { min: 0, max: 1 }, 'render'), prog([solid('a')]), null);
    assert.equal(v.status, 'unverified', `${kind} must not guess`);
    assert.match(v.evidence, /no render metrics/);
  }
});

test('rubric decides nothing, with or without metrics', () => {
  const c: Constraint = { id: 'j', kind: 'rubric', params: { text: 'is it any good' }, scope: 'judge', severity: 'hard', why: 'a judge' };
  assert.equal(checkConstraint(c, prog([solid('a')]), null).status, 'unverified');
  assert.equal(checkConstraint(c, prog([solid('a')]), metrics()).status, 'unverified');
});

test('every verdict carries nodeIds, and they are bare ids that exist in the tree', () => {
  const tree = prog([solid('a', 'red'), text('t', 'SHOUT'), macro('m', 'frame')]);
  const present = new Set(['root', 'a', 't', 'm']);
  const cases: Constraint[] = [
    constraint('maxDistinctColors', { max: 1 }),
    constraint('palette', { allow: ['#ffffff'] }),
    constraint('forbidNode', { ops: ['text'] }),
    constraint('requireNode', { op: 'text', min: 1 }),
    constraint('nodeCount', { max: 1 }),
    constraint('textCase', { case: 'lower' }),
    constraint('textMaxWords', { max: 0 }),
    constraint('textRequired', { contains: ['SHOUT'] }),
    constraint('maxRepeatDepth', { max: 0 }),
    constraint('forbidMark', { styles: ['solid'] }),
    constraint('requireMark', { styles: ['solid'], min: 1 }),
  ];
  for (const c of cases) {
    const v = checkConstraint(c, tree, null);
    assert.ok(Array.isArray(v.nodeIds), `${c.kind} returned no nodeIds`);
    assert.equal(new Set(v.nodeIds).size, v.nodeIds.length, `${c.kind} repeated an id`);
    for (const id of v.nodeIds) assert.ok(present.has(id), `${c.kind} named "${id}", which is not in the tree`);
  }
});

test('nodeIds does not do what substring matching on evidence did', () => {
  // The bug this replaces: "t" is a prefix of "t2", so scanning the evidence text for ids blamed
  // the node that was fine. The structured answer names one node because one node offended.
  const tree = prog([text('t', 'FINE'), text('t2', 'Bad')]);
  const v = checkConstraint(constraint('textCase', { case: 'upper' }), tree, null);
  assert.equal(v.status, 'violated');
  assert.deepEqual(v.nodeIds, ['t2']);
  assert.ok(v.evidence.includes('t'), 'the prose still names the node, which is why the old scan matched both');
});

test('a verdict that rests on an absence or an aggregate names nobody', () => {
  const clean = prog([solid('a')]);
  // Nothing forbidden is present, so no node is carrying the prohibition.
  assert.deepEqual(checkConstraint(constraint('forbidNode', { ops: ['text'] }), clean, null).nodeIds, []);
  assert.deepEqual(checkConstraint(constraint('forbidMark', { styles: ['wash'] }), clean, null).nodeIds, []);
  // A count is about the tree, not about any node in it.
  assert.deepEqual(checkConstraint(constraint('nodeCount', { min: 1 }), clean, null).nodeIds, []);
  assert.deepEqual(checkConstraint(constraint('maxRepeatDepth', { max: 1 }), clean, null).nodeIds, []);
  // Removing a node can only lower a colour count, so a satisfied cap rests on nobody.
  assert.deepEqual(checkConstraint(constraint('maxDistinctColors', { max: 5 }), clean, null).nodeIds, []);
});

test('a satisfied requirement names the nodes carrying it', () => {
  const tree = prog([text('t1', 'A'), text('t2', 'B'), solid('a')]);
  const req = checkConstraint(constraint('requireNode', { op: 'text', min: 2 }), tree, null);
  assert.equal(req.status, 'satisfied');
  assert.deepEqual(req.nodeIds, ['t1', 't2']);

  const mark = checkConstraint(constraint('requireMark', { styles: ['solid'], min: 1 }), tree, null);
  assert.equal(mark.status, 'satisfied');
  assert.deepEqual(mark.nodeIds, ['a']);

  const said = checkConstraint(constraint('textRequired', { contains: ['B'] }), tree, null);
  assert.equal(said.status, 'satisfied');
  assert.deepEqual(said.nodeIds, ['t2']);
});

test('render-scope verdicts name no node, because a metric is about the whole sheet', () => {
  for (const kind of ['inkDensityRange', 'coverageRange', 'symmetryMax', 'inkOffsetRange'] as const) {
    const v = checkConstraint(constraint(kind, { min: 0, max: 1 }, 'render'), prog([solid('a')]), metrics());
    assert.deepEqual(v.nodeIds, [], `${kind} attributed pixels to a node it cannot see`);
  }
});

test('blocked_by short-circuits every kind to unverified and names the missing primitive', () => {
  const c: Constraint = {
    id: 'b',
    kind: 'requireNode',
    params: { op: 'fragment', min: 1 },
    scope: 'tree',
    severity: 'hard',
    why: 'wants a found image',
    blocked_by: 'a halftone primitive',
  };
  const v = checkConstraint(c, prog([solid('a')]), null);
  assert.equal(v.status, 'unverified');
  assert.match(v.evidence, /a halftone primitive/);
});
