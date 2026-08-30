// Diffing, spillover and contact sheets. The rendered case at the bottom is the one that matters: it
// is the acceptance criterion from the build document, that a change to one node moves pixels only
// where that node declared it would.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../browser.js';
import { changedRegions, pixelDiff, structuralDiff, union } from '../diff.js';
import { contactSheet, thumbnail } from '../sheet.js';
import { EMPTY_PACK, hatchNode, program, resolve, solidNode, washNode } from './helpers.js';

const SLOW = { timeout: 120_000 };
const W = 400;
const H = 400;
const MAX_SPILLOVER = 0.05;

function moved(node: Record<string, unknown>, dx: number, dy: number): Record<string, unknown> {
  const args = node['args'] as Record<string, unknown>;
  const region = args['region'] as Record<string, number>;
  return {
    ...node,
    args: { ...args, region: { ...region, cx: region['cx']! + dx, cy: region['cy']! + dy } },
  };
}

test('the structural diff names what changed and leaves the rest alone', () => {
  const a = resolve(program([washNode('w', 200, 200), solidNode('s', 40, 40)]));
  const b = resolve(program([moved(washNode('w', 200, 200), 60, 0), hatchNode('h', 240, 240)]));
  const diff = structuralDiff(a, b);
  assert.deepEqual(diff.changed, ['w']);
  assert.deepEqual(diff.added, ['h']);
  assert.deepEqual(diff.removed, ['s']);
  assert.deepEqual(diff.unchanged, []);
});

test('an identical program diffs to nothing at all', () => {
  const a = resolve(program([washNode('w', 200, 200), solidNode('s', 40, 40)]));
  const b = resolve(program([washNode('w', 200, 200), solidNode('s', 40, 40)]));
  const diff = structuralDiff(a, b);
  assert.deepEqual(diff.unchanged.sort(), ['s', 'w']);
  assert.deepEqual(changedRegions(a, b, diff), []);
});

test("a moved node's region is the union of where it was and where it went", () => {
  const a = resolve(program([washNode('w', 150, 200)]));
  const b = resolve(program([moved(washNode('w', 150, 200), 100, 0)]));
  const [box] = changedRegions(a, b, structuralDiff(a, b));
  const expected = union(a.nodes[0]!.bounds, b.nodes[0]!.bounds)!;
  assert.deepEqual(box, expected);
  assert.ok(box!.w > a.nodes[0]!.bounds.w, 'the union should be wider than either box alone');
});

test('spillover counts only the changed pixels that escaped the declared boxes', () => {
  const before = Buffer.alloc(4 * 4 * 4);
  const after = Buffer.alloc(4 * 4 * 4);
  after[4 * (1 * 4 + 1)] = 0xff; // inside the box below
  after[4 * (3 * 4 + 3)] = 0xff; // outside it
  const d = pixelDiff(before, after, 4, 4, [{ x: 0, y: 0, w: 2, h: 2 }]);
  assert.equal(d.differing, 2);
  assert.equal(d.spilled, 1);
  assert.equal(d.spillover, 0.5);
  assert.equal(d.mask[1 * 4 + 1], 1);
  assert.equal(d.mask[3 * 4 + 3], 2);
});

test('a contact sheet is a deterministic tiling that averages rather than samples', () => {
  const src = { rgba: Buffer.alloc(4 * 4 * 4, 0), width: 4, height: 4 };
  for (let p = 0; p < 16; p += 2) src.rgba[4 * p] = 0xff; // every other pixel red
  const thumb = thumbnail(src, 2, 2);
  assert.deepEqual([thumb.width, thumb.height], [2, 2]);
  assert.equal(thumb.rgba[0], 0x80, 'a 2x2 block of half-red pixels should average, not pick one');

  const opts = { cols: 2, cell: 4, gap: 2, background: [0, 0, 0] as [number, number, number] };
  const one = contactSheet([src, src, src], opts);
  const two = contactSheet([src, src, src], opts);
  assert.deepEqual([one.width, one.height], [2 * 6 + 2, 2 * 6 + 2]);
  assert.deepEqual(one.rgba, two.rgba);
});

test('moving one node changes pixels only where it said it would', SLOW, async () => {
  const before = resolve(program([washNode('w', 130, 200), solidNode('s', 250, 60), hatchNode('h', 240, 250)]));
  const after = resolve(program([moved(washNode('w', 130, 200), 80, 40), solidNode('s', 250, 60), hatchNode('h', 240, 250)]));
  const diff = structuralDiff(before, after);
  const boxes = changedRegions(before, after, diff);

  const renderer = await Renderer.launch();
  let a;
  let b;
  try {
    a = await renderer.render(before, EMPTY_PACK);
    b = await renderer.render(after, EMPTY_PACK);
  } finally {
    await renderer.close();
  }

  const d = pixelDiff(a.rgba, b.rgba, W, H, boxes);
  assert.ok(d.differing > 1000, 'the edit should be clearly visible');
  assert.ok(d.spillover < MAX_SPILLOVER, `spillover ${d.spillover} (${d.spilled} of ${d.differing} pixels)`);
});
