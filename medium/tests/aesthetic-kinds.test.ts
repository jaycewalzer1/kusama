// One passing tree and one failing tree for every constraint kind.
//
// The trees here are the smallest thing that makes the kind fire, not plausible pictures. They are
// never rendered and never validated against the medium's own schema: a checker that needed a valid
// program to reach a verdict could not be run on a half-finished edit, which is most of what it is
// for. The 12 authored fixtures in aesthetic-fixtures.test.ts are the ones that are real programs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTRAINT_KINDS, checkConstraint } from '../src/aesthetic/kinds.js';
import type { Constraint, ConstraintKind, RenderMetrics } from '../src/aesthetic/types.js';

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
  return { inkDensity: 0.3, coverage: 0.5, inkOffset: 0.2, symmetry: { vertical: 0.2, horizontal: 0.2 }, pixelHash: 'deadbeef', ...over };
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

test('the constraint language is closed at sixteen kinds', () => {
  assert.equal(CONSTRAINT_KINDS.length, 16);
  assert.equal(new Set(CONSTRAINT_KINDS).size, 16);
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

test('render kinds come back unverified without metrics, never assumed', () => {
  for (const kind of ['inkDensityRange', 'coverageRange', 'symmetryMax', 'inkOffsetRange'] as const) {
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
