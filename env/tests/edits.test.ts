// Step 11 of the build order: edits are typed and bounded.
//
// The cheap claims -- purity, refusal, provenance -- are checked without a browser. The claim that
// justifies the layer's existence is not cheap and is checked with one: an edit changes pixels only
// where it said it would (spec 13). The rngKey claim is checked structurally instead of by pixels,
// because "the node's own marks did not change" is exactly "its seed did not change", and that is
// both cheaper and the actual invariant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../browser.js';
import { applyEdit, type EditResult, type Program } from '../edits.js';
import { validateEditAction } from '../validate.js';
import {
  differingOutside,
  EMPTY_PACK,
  GROUND,
  group,
  hatchNode,
  program,
  resolve,
  solidNode,
  strokeNode,
  testProfile,
  washNode,
} from './helpers.js';

const PROFILE = testProfile();
const SLOW = { timeout: 180_000 };
const W = 400;
const H = 400;

function edit(prog: Program, action: unknown): EditResult {
  return applyEdit(prog, action, PROFILE, EMPTY_PACK);
}

/** brushScale 1, so a node's bounds are tight enough for a locality claim to mean something. */
function tight(children: unknown[]): Program {
  return program(children, { canvas: { width: W, height: H, ground: GROUND, brushScale: 1 } });
}

const DIM_OPACITY = { actionId: 'a1', kind: 'set_arg', targets: ['w1'], decisionRefs: ['d3'], path: 'style.opacity', value: 180 };

function findNode(prog: Program, id: string): Record<string, unknown> | undefined {
  const walk = (node: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (node['id'] === id) return node;
    for (const kid of (node['children'] as Record<string, unknown>[]) ?? []) {
      const hit = walk(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(prog['root'] as Record<string, unknown>);
}

// --- purity ---------------------------------------------------------------------------------------

test('applyEdit does not touch the program it was given, and repeats itself exactly', () => {
  const prog = program([washNode('w1', 150, 150)]);
  const untouched = structuredClone(prog);

  const first = edit(prog, DIM_OPACITY);
  assert.equal(first.valid, true, first.reason);
  assert.deepEqual(prog, untouched, 'the input program was mutated');

  const second = edit(prog, DIM_OPACITY);
  assert.deepEqual(second.nextProgram, first.nextProgram);
  assert.deepEqual(second.changedNodeIds, first.changedNodeIds);
  assert.equal(second.cost, first.cost);
});

test('a refused edit hands back the original object, not a copy of it', () => {
  const prog = program([washNode('w1', 150, 150)]);
  const result = edit(prog, { actionId: 'a1', kind: 'delete_node', targets: ['nope'] });
  assert.equal(result.valid, false);
  assert.equal(result.nextProgram, prog);
  assert.match(result.reason!, /no node "nope"/);
});

// --- one test per V0 action, and its obvious refusal ------------------------------------------------

test('add_node inserts a subtree where it was told to', () => {
  const prog = program([washNode('w1', 150, 150)]);
  const result = edit(prog, {
    actionId: 'a1', kind: 'add_node', targets: ['root'], parent: 'root', index: 0,
    node: hatchNode('h1', 40, 40),
  });
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.changedNodeIds, ['h1']);
  assert.ok(result.cost > 0, 'a new node costs something to draw');
  const kids = (findNode(result.nextProgram, 'root')!['children'] as Record<string, unknown>[]).map((k) => k['id']);
  assert.deepEqual(kids, ['h1', 'w1'], 'index 0 means it paints first');
});

test('add_node refuses a node with no rngKey of its own', () => {
  const orphan = solidNode('s1', 40, 40);
  delete orphan['rngKey'];
  const result = edit(program([washNode('w1', 150, 150)]), {
    actionId: 'a1', kind: 'add_node', targets: ['root'], parent: 'root', node: orphan,
  });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /rngKey/);
});

test('add_node refuses a parent that cannot hold children', () => {
  const result = edit(program([washNode('w1', 150, 150)]), {
    actionId: 'a1', kind: 'add_node', targets: ['w1'], parent: 'w1', node: solidNode('s1', 40, 40),
  });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /has no children/);
});

test('delete_node removes the subtree and makes the program cheaper', () => {
  const prog = program([washNode('w1', 150, 150), group('g1', [hatchNode('h1', 40, 40)])]);
  const result = edit(prog, { actionId: 'a1', kind: 'delete_node', targets: ['g1'] });
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.changedNodeIds, ['g1', 'h1']);
  assert.ok(result.cost < 0, 'removing a node should not cost more');
  assert.equal(findNode(result.nextProgram, 'h1'), undefined);
  const record = (result.nextProgram['meta'] as Record<string, unknown[]>)['provenance']![0] as Record<string, unknown>;
  assert.equal((record['before'] as Record<string, unknown>)['id'], 'g1', 'a delete records what it removed');
});

test('delete_node refuses the root', () => {
  const result = edit(program([washNode('w1', 150, 150)]), { actionId: 'a1', kind: 'delete_node', targets: ['root'] });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /root cannot be deleted/);
});

test('set_arg replaces one value in place', () => {
  const result = edit(program([washNode('w1', 150, 150)]), DIM_OPACITY);
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.changedNodeIds, ['w1']);
  const args = findNode(result.nextProgram, 'w1')!['args'] as Record<string, Record<string, unknown>>;
  assert.equal(args['style']!['opacity'], 180);
  assert.equal(args['style']!['bleed'], 0.12, 'the rest of the style is untouched');
});

test('set_arg reaches into arrays by index', () => {
  const prog = program([strokeNode('s1', [[20, 20], [200, 180]])]);
  const result = edit(prog, { actionId: 'a1', kind: 'set_arg', targets: ['s1'], path: 'points.1.0', value: 300 });
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual((findNode(result.nextProgram, 's1')!['args'] as Record<string, unknown>)['points'], [[20, 20], [300, 180]]);
});

test('set_arg refuses a path that is not there, and a value of a different shape', () => {
  const prog = program([washNode('w1', 150, 150)]);
  const missing = edit(prog, { actionId: 'a1', kind: 'set_arg', targets: ['w1'], path: 'style.grain', value: 3 });
  assert.equal(missing.valid, false);
  assert.match(missing.reason!, /does not exist/);

  const wrongShape = edit(prog, { actionId: 'a1', kind: 'set_arg', targets: ['w1'], path: 'style.opacity', value: 'lots' });
  assert.equal(wrongShape.valid, false);
  assert.match(wrongShape.reason!, /in place/);

  const noArgs = edit(prog, { actionId: 'a1', kind: 'set_arg', targets: ['root'], path: 'style.opacity', value: 180 });
  assert.equal(noArgs.valid, false);
  assert.match(noArgs.reason!, /has no args/);
});

test('set_arg is still bound by the profile', () => {
  const offStep = edit(program([washNode('w1', 150, 150)]), {
    actionId: 'a1', kind: 'set_arg', targets: ['w1'], path: 'region.cx', value: 150.3,
  });
  assert.equal(offStep.valid, false);
  assert.match(offStep.reason!, /quantize/);
});

test('set_transform replaces a group transform whole', () => {
  const prog = program([group('g1', [solidNode('s1', 40, 40)], { translate: [10, 10] })]);
  const result = edit(prog, {
    actionId: 'a1', kind: 'set_transform', targets: ['g1'], transform: { translate: [60, 30], rotate: 15 },
  });
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.changedNodeIds, ['g1', 's1'], 'moving a group moves everything under it');
  assert.deepEqual(findNode(result.nextProgram, 'g1')!['transform'], { translate: [60, 30], rotate: 15 });
  const record = (result.nextProgram['meta'] as Record<string, unknown[]>)['provenance']![0] as Record<string, unknown>;
  assert.deepEqual(record['before'], { translate: [10, 10] });
});

test('set_transform refuses a node that has no transform to set', () => {
  const result = edit(program([washNode('w1', 150, 150)]), {
    actionId: 'a1', kind: 'set_transform', targets: ['w1'], transform: { translate: [60, 30] },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /only a group carries a transform/);
});

test('set_style swaps the whole paint style, kind and all', () => {
  const prog = program([washNode('w1', 150, 150)]);
  const hatch = { kind: 'hatch', brush: '2B', color: 'ink', spacing: 6, angle: 35, rand: 0.15, layers: 2 };
  const result = edit(prog, { actionId: 'a1', kind: 'set_style', targets: ['w1'], style: hatch });
  assert.equal(result.valid, false, 'wash takes a wash style only');

  const paint = { ...washNode('p1', 150, 150), op: 'paint' };
  const swapped = edit(program([paint]), { actionId: 'a1', kind: 'set_style', targets: ['p1'], style: hatch });
  assert.equal(swapped.valid, true, swapped.reason);
  assert.deepEqual(swapped.changedNodeIds, ['p1']);
  assert.deepEqual((findNode(swapped.nextProgram, 'p1')!['args'] as Record<string, unknown>)['style'], hatch);
});

test('set_style refuses a node with no style', () => {
  const result = edit(program([strokeNode('s1', [[20, 20], [200, 180]])]), {
    actionId: 'a1', kind: 'set_style', targets: ['s1'], style: { kind: 'solid', color: 'ink', opacity: 200 },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /no style/);
});

// --- refusals come back as values, never as exceptions ----------------------------------------------

test('an action the schema does not know is refused, not thrown', () => {
  const prog = program([washNode('w1', 150, 150)]);
  for (const bad of [
    { actionId: 'a1', kind: 'replace_program', targets: ['root'], node: {} },
    { actionId: 'a1', kind: 'set_arg', targets: ['w1'] },
    { actionId: 'a1', kind: 'set_arg', targets: [], path: 'style.opacity', value: 180 },
    { kind: 'set_arg', targets: ['w1'], path: 'style.opacity', value: 180 },
  ]) {
    const result = edit(prog, bad);
    assert.equal(result.valid, false, `${JSON.stringify(bad)} should be refused`);
    assert.match(result.reason!, /not a valid EditAction/);
    assert.equal(result.nextProgram, prog);
  }
});

test('an edit that would break the budget is refused before anything is rendered', () => {
  // The 20x20 grid of tight crosshatch from the validator tests: legal JSON, inside every structural
  // limit, and far past what the profile will pay to draw.
  const dense = hatchNode('h1', 0, 0);
  (dense['args'] as Record<string, unknown>)['style'] = {
    kind: 'hatch', brush: '2B', color: 'rust', spacing: 2, angle: 35, rand: 0.15, layers: 2,
  };
  const result = edit(program([washNode('w1', 150, 150)]), {
    actionId: 'a1', kind: 'add_node', targets: ['root'], parent: 'root',
    node: {
      id: 'r1', type: 'repeat', rngKey: 'key-r1', count: 400,
      layout: { type: 'grid', origin: [10, 10], cols: 20, dx: 20, dy: 20 },
      children: [dense],
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /exceeds the profile's limit/);
});

test('an edit that would break the schema is refused the same way', () => {
  const duplicate = edit(program([washNode('w1', 150, 150)]), {
    actionId: 'a1', kind: 'add_node', targets: ['root'], parent: 'root', node: washNode('w1', 250, 250),
  });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.reason!, /used more than once/);
});

// --- provenance -------------------------------------------------------------------------------------

test('provenance accumulates in order, and every record is itself a valid action', () => {
  const first = edit(program([washNode('w1', 150, 150)]), DIM_OPACITY);
  const second = edit(first.nextProgram, {
    actionId: 'a2', kind: 'add_node', targets: ['root'], parent: 'root', node: solidNode('s1', 40, 40),
  });
  assert.equal(second.valid, true, second.reason);

  const log = (second.nextProgram['meta'] as Record<string, unknown[]>)['provenance'] as Record<string, unknown>[];
  assert.deepEqual(log.map((r) => r['actionId']), ['a1', 'a2']);
  assert.deepEqual(log.map((r) => r['kind']), ['set_arg', 'add_node']);
  assert.equal(log[0]!['before'], 140);
  assert.equal(log[0]!['after'], 180);
  assert.equal(log[0]!['estimatedCost'], first.cost);
  assert.equal(log[1]!['estimatedCost'], second.cost);
  for (const record of log) assert.deepEqual(validateEditAction(record), [], JSON.stringify(record));

  // ...and the first program still carries only its own history.
  assert.equal(((first.nextProgram['meta'] as Record<string, unknown[]>)['provenance'] as unknown[]).length, 1);
});

// --- V0.1 ---------------------------------------------------------------------------------------

test('reparent_node moves a node between groups without touching it', () => {
  const prog = program([group('g1', [hatchNode('h1', 40, 40)]), group('g2', [solidNode('s1', 250, 250)])]);
  const result = edit(prog, { actionId: 'a1', kind: 'reparent_node', targets: ['h1'], parent: 'g2', index: 0 });
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.changedNodeIds, ['h1']);
  assert.deepEqual((findNode(result.nextProgram, 'g1')!['children'] as unknown[]), []);
  assert.deepEqual(
    (findNode(result.nextProgram, 'g2')!['children'] as Record<string, unknown>[]).map((k) => k['id']),
    ['h1', 's1']
  );
  assert.equal(result.cost, 0, 'moving a node costs the same to draw');
});

test('reparent_node refuses to put a node inside itself', () => {
  const prog = program([group('g1', [group('g2', [hatchNode('h1', 40, 40)])])]);
  const result = edit(prog, { actionId: 'a1', kind: 'reparent_node', targets: ['g1'], parent: 'g2' });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /would not leave a tree/);
});

test('wrap_group wraps contiguous siblings, in paint order', () => {
  const prog = program([hatchNode('h1', 40, 40), solidNode('s1', 250, 250), washNode('w1', 150, 150)]);
  const result = edit(prog, {
    actionId: 'a1', kind: 'wrap_group', targets: ['s1', 'h1'], groupId: 'g1', transform: { translate: [20, 0] },
  });
  assert.equal(result.valid, true, result.reason);
  const kids = (findNode(result.nextProgram, 'root')!['children'] as Record<string, unknown>[]).map((k) => k['id']);
  assert.deepEqual(kids, ['g1', 'w1']);
  assert.deepEqual(
    (findNode(result.nextProgram, 'g1')!['children'] as Record<string, unknown>[]).map((k) => k['id']),
    ['h1', 's1'],
    'the wrapped nodes keep the order they were painted in, not the order they were named in'
  );
});

test('wrap_group refuses nodes that are not siblings', () => {
  const prog = program([group('g1', [hatchNode('h1', 40, 40)]), solidNode('s1', 250, 250)]);
  const result = edit(prog, { actionId: 'a1', kind: 'wrap_group', targets: ['h1', 's1'], groupId: 'g2' });
  assert.equal(result.valid, false);
  assert.match(result.reason!, /do not share a parent/);
});

test('duplicate_as_repeat repeats a node, and its first instance is the node it was', () => {
  const prog = program([hatchNode('h1', 40, 40)]);
  const before = resolve(prog).nodes.find((n) => n.sourceId === 'h1')!;
  const result = edit(prog, {
    actionId: 'a1', kind: 'duplicate_as_repeat', targets: ['h1'], count: 3, rngKey: 'key-h1-repeat',
    layout: { type: 'line', origin: [0, 0], dx: 130, dy: 0 },
  });
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.changedNodeIds, ['h1.repeat', 'h1']);

  const after = resolve(result.nextProgram).nodes.filter((n) => n.sourceId === 'h1');
  assert.equal(after.length, 3);
  assert.equal(after[0]!.rngKey, before.rngKey);
  assert.equal(after[0]!.seed, before.seed, 'instance 0 of a repeat derives the seed a lone node did');
  assert.ok(result.cost > 0, 'three copies cost more than one');
});

// --- rngKey stability -------------------------------------------------------------------------------

test('moving a node does not change its own marks, only where they land', () => {
  const prog = tight([group('g1', [hatchNode('h1', 40, 40)]), group('g2', [], { translate: [0, 200] })]);
  const before = resolve(prog).nodes.find((n) => n.sourceId === 'h1')!;

  const moved = edit(prog, { actionId: 'a1', kind: 'set_transform', targets: ['g1'], transform: { translate: [120, 0] } });
  assert.equal(moved.valid, true, moved.reason);
  const after = resolve(moved.nextProgram).nodes.find((n) => n.sourceId === 'h1')!;

  assert.equal(after.rngKey, before.rngKey, 'an edit never rewrites an rngKey');
  assert.equal(after.seed, before.seed, 'so the node draws the same marks');
  assert.equal(after.bounds.w, before.bounds.w);
  assert.equal(after.bounds.h, before.bounds.h);
  assert.equal(after.bounds.x, before.bounds.x + 120, 'the same shape, translated');
  assert.equal(after.bounds.y, before.bounds.y);

  // ...and the same holds when the node changes parents, which is the harder case: its position in
  // the tree changed, and a scheme that seeded from the path would have changed its marks.
  const reparented = edit(prog, { actionId: 'a2', kind: 'reparent_node', targets: ['h1'], parent: 'g2' });
  assert.equal(reparented.valid, true, reparented.reason);
  const elsewhere = resolve(reparented.nextProgram).nodes.find((n) => n.sourceId === 'h1')!;
  assert.equal(elsewhere.rngKey, before.rngKey);
  assert.equal(elsewhere.seed, before.seed);
  assert.equal(elsewhere.bounds.w, before.bounds.w);
  assert.equal(elsewhere.bounds.h, before.bounds.h);
  assert.equal(elsewhere.bounds.x, before.bounds.x);
  assert.equal(elsewhere.bounds.y, before.bounds.y + 200, 'the same shape, translated by its new parent');
});

// --- locality: the point of the whole layer ---------------------------------------------------------

/**
 * Three edits, rendered before and after. Every pixel that differs must lie inside the union of the
 * bounds of the nodes applyEdit itself named as changed -- so this checks the reported
 * `changedNodeIds` too, not just the geometry.
 */
const LOCAL: { name: string; base: Program; action: Record<string, unknown> }[] = [
  {
    name: 'set_arg moves a shape',
    base: tight([solidNode('s1', 60, 60), hatchNode('h1', 240, 240)]),
    action: { actionId: 'l1', kind: 'set_arg', targets: ['s1'], path: 'region.x', value: 200 },
  },
  {
    name: 'set_transform moves a group',
    base: tight([group('g1', [solidNode('s1', 60, 60)]), hatchNode('h1', 240, 240)]),
    action: { actionId: 'l2', kind: 'set_transform', targets: ['g1'], transform: { translate: [0, 200] } },
  },
  {
    name: 'add_node adds a shape',
    base: tight([hatchNode('h1', 240, 240)]),
    action: { actionId: 'l3', kind: 'add_node', targets: ['root'], parent: 'root', node: solidNode('s1', 40, 40) },
  },
];

test('an edit changes pixels only inside the bounds of the nodes it changed', SLOW, async () => {
  const renderer = await Renderer.launch();
  try {
    for (const { name, base, action } of LOCAL) {
      const result = edit(base, action);
      assert.equal(result.valid, true, `${name}: ${result.reason}`);

      const beforeTree = resolve(base);
      const afterTree = resolve(result.nextProgram);
      const boxes = [...beforeTree.nodes, ...afterTree.nodes]
        .filter((n) => result.changedNodeIds.includes(n.sourceId))
        .map((n) => n.bounds);

      const a = await renderer.render(beforeTree, EMPTY_PACK);
      const b = await renderer.render(afterTree, EMPTY_PACK);
      assert.deepEqual(a.warnings, [], `${name}: the page reported errors`);

      assert.ok(differingOutside(a.rgba, b.rgba, W, H, []) > 0, `${name}: the edit changed nothing at all`);
      const spill = differingOutside(a.rgba, b.rgba, W, H, boxes);
      assert.equal(spill, 0, `${name}: ${spill} pixels changed outside the bounds of ${result.changedNodeIds.join(', ')}`);
    }
  } finally {
    await renderer.close();
  }
});
