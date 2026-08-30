// Spec section 6: a macro is a fixed recipe of primitives, and the resolved program says so.
//
// A macro is the only place where one node the author wrote becomes several marks on the canvas, so
// it is the only place a hidden decision could hide. Four properties keep it honest, and all four
// are checked here:
//
//   1. every part of an expansion is in the resolved program as its own primitive node, named
//      `<macroId>/<partName>` and carrying `expandedFrom`, so a part can be read, diffed and pointed
//      at exactly like a hand-written node;
//   2. the parts are only the seven primitives -- a macro never expands into another macro or a
//      group, so expansion terminates in one step and nothing is left folded up;
//   3. each frame style, and the pack's hibiscus motif, expand to exactly the parts their recipes
//      describe, placed by the arguments the author gave and by nothing else;
//   4. the bounds are honest in both directions: the box the macro was asked for is inside the
//      bounds it declares, and -- under a real render -- no ink lands outside them.
//
// resolve.js gives a macro group no bounds field of its own; what it declares is its `parts` list.
// So "the macro's bounds" here means the union over exactly that declared list, which is also what
// makes the render check below a check on the macro rather than on its parts one at a time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../../env/browser.js';
import { loadPack, type AssetPack } from '../../env/pack.js';
import { resolveProgram, type Bounds, type ResolvedGroup, type ResolvedLeaf, type ResolvedProgram } from '../resolve.js';
import { EMPTY_PACK, INK, marked, program } from '../../env/tests/helpers.js';

const SLOW = { timeout: 180_000 };
const CORE = loadPack('core');

/** The whole of what a macro is allowed to expand to. */
const PRIMITIVES = new Set(['wash', 'paint', 'stroke', 'fragment', 'text', 'rule', 'cover']);

const EPS = 1e-9;

type Pt = [number, number];

// --- expanding one macro ---------------------------------------------------------------------------

function macroNode(id: string, macro: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'macro', macro, rngKey: `key-${id}`, args };
}

interface Expansion {
  id: string;
  resolved: ResolvedProgram;
  group: ResolvedGroup;
  /** The nodes the macro's own `parts` list names, in paint order. */
  parts: ResolvedLeaf[];
  names: string[];
  part(name: string): ResolvedLeaf;
  /** What the macro declares about where it paints: the union of its declared parts' bounds. */
  bounds: Bounds;
}

function expand(id: string, macro: string, args: Record<string, unknown>, pack: AssetPack = EMPTY_PACK): Expansion {
  const resolved = resolveProgram(program([macroNode(id, macro, args)], { assetPack: pack.id }), pack);
  const group = resolved.groups.find((g) => g.id === id);
  assert.ok(group, `no resolved group for macro "${id}"`);
  assert.equal(group.type, 'macro');
  assert.equal(group.macro, macro);

  const byId = new Map(resolved.nodes.map((n) => [n.id, n]));
  const parts = (group.parts ?? []).map((pid) => {
    const leaf = byId.get(pid);
    assert.ok(leaf, `macro "${id}" declares part "${pid}" but no such node was resolved`);
    return leaf;
  });
  assert.ok(parts.length > 0, `macro "${id}" expanded to nothing`);

  return {
    id,
    resolved,
    group,
    parts,
    names: parts.map((p) => p.id.slice(id.length + 1)),
    part(name: string) {
      const hit = parts.find((p) => p.id === `${id}/${name}`);
      assert.ok(hit, `macro "${id}" has no part "${name}" (it has ${parts.map((p) => p.id).join(', ')})`);
      return hit;
    },
    bounds: unionBounds(parts.map((p) => p.bounds)),
  };
}

// --- small geometry helpers ---------------------------------------------------------------------------

function unionBounds(list: Bounds[]): Bounds {
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  const right = Math.max(...list.map((b) => b.x + b.w));
  const bottom = Math.max(...list.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

function show(b: Bounds): string {
  return `[${b.x}, ${b.y}, ${b.w}x${b.h}]`;
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function samePoint(a: Pt, b: Pt, eps = 1e-6): boolean {
  return near(a[0], b[0], eps) && near(a[1], b[1], eps);
}

function args(leaf: ResolvedLeaf): Record<string, any> {
  return leaf.args as Record<string, any>;
}

/** Every point a part places, in the part's own local coordinates. */
function pointsOf(leaf: ResolvedLeaf): Pt[] {
  const a = args(leaf);
  if (leaf.op === 'stroke') return a['points'] as Pt[];
  if (leaf.op === 'rule') return [a['from'] as Pt, a['to'] as Pt];
  if (leaf.op === 'text') return [[a['x'], a['y']] as Pt];
  const region = a['region'] as Record<string, any>;
  if (region['type'] === 'polygon') return region['points'] as Pt[];
  if (region['type'] === 'circle') return [[region['cx'], region['cy']] as Pt];
  if (region['type'] === 'rect') {
    return [
      [region['x'], region['y']],
      [region['x'] + region['w'], region['y']],
      [region['x'] + region['w'], region['y'] + region['h']],
      [region['x'], region['y'] + region['h']],
    ];
  }
  throw new Error(`no point extractor for ${leaf.op}/${String(region['type'])}`);
}

// --- the fixtures the structural tests share -------------------------------------------------------

const FRAME_BOX = { x: 40, y: 40, w: 300, h: 200 };
const FRAME_CORNERS = { ...FRAME_BOX, style: 'corners', color: 'ink', brush: 'rotring', weight: 1.5, arm: 40 };
const FRAME_FULL = { ...FRAME_BOX, style: 'full', color: 'ink', brush: 'rotring', weight: 1 };
const FRAME_DOTS = { ...FRAME_BOX, style: 'dots', color: 'ink', count: 16, dotRadius: 4 };

const MOTIF_ARGS = { name: 'hibiscus', x: 200, y: 200, size: 160 };
const MOTIF_BOX = { x: 200 - 80, y: 200 - 80, w: 160, h: 160 };

const QUARANTINE_BOX = { x: 40, y: 240, w: 300, h: 120 };
const QUARANTINE_ARGS = {
  ...QUARANTINE_BOX,
  style: { kind: 'wash', color: 'teal', opacity: 120, bleed: 0.08, texture: [0.4, 0.2] },
  boxColor: 'ink',
  boxWeight: 0.5,
  label: 'SPONSORS',
};

const CASES: { what: string; box: Bounds; expand: () => Expansion }[] = [
  { what: 'frame', box: FRAME_BOX, expand: () => expand('fr', 'frame', FRAME_CORNERS) },
  { what: 'motif', box: MOTIF_BOX, expand: () => expand('mo', 'motif', MOTIF_ARGS, CORE) },
  { what: 'quarantine', box: QUARANTINE_BOX, expand: () => expand('qu', 'quarantine', QUARANTINE_ARGS) },
];

// --- 1 and 2: nothing stays folded up ----------------------------------------------------------------

test('every macro part is its own primitive node, named after the macro and pointing back at it', () => {
  for (const { what, expand: build } of CASES) {
    const ex = build();

    // What the macro declares (`parts`) and what the leaves claim (`expandedFrom`) are two separate
    // records of the same fact, so they are compared rather than one being read through the other.
    const claimed = ex.resolved.nodes.filter((n) => n.expandedFrom === ex.id).map((n) => n.id);
    assert.deepEqual(claimed, ex.group.parts, `${what}: expandedFrom and the macro's parts list disagree`);

    for (const part of ex.parts) {
      const [prefix, ...rest] = part.id.split('/');
      assert.equal(prefix, ex.id, `${what}: part "${part.id}" is not named after its macro`);
      assert.equal(rest.length, 1, `${what}: part id "${part.id}" is not <macroId>/<partName>`);
      assert.ok(rest[0], `${what}: part "${part.id}" has an empty part name`);
      assert.equal(part.expandedFrom, ex.id, `${what}: part "${part.id}" does not point back at its macro`);
      assert.ok(PRIMITIVES.has(part.op), `${what}: part "${part.id}" is a "${part.op}", not one of the seven primitives`);
      assert.equal(part.sourceId, part.id, `${what}: part "${part.id}" should be its own source node`);
      // Parts are seeded off the macro's key, so two parts of one macro cannot share a draw and a
      // part cannot collide with a hand-written node's key.
      assert.ok(part.rngKey.startsWith('key-'), `${what}: part "${part.id}" lost the macro's rngKey`);
      assert.ok(part.rngKey.length > `key-${ex.id}`.length, `${what}: part "${part.id}" reuses the macro's own rngKey`);
    }

    assert.equal(new Set(ex.names).size, ex.names.length, `${what}: two parts share a name`);
    assert.equal(new Set(ex.parts.map((p) => p.rngKey)).size, ex.parts.length, `${what}: two parts share an rngKey`);

    // A macro expands in one step: no groups, repeats or further macros come out of it.
    const nested = ex.resolved.groups.filter((g) => g.expandedFrom === ex.id);
    assert.deepEqual(nested, [], `${what}: expansion produced ${nested.length} nested group(s)`);
    assert.equal(ex.resolved.groups.filter((g) => g.type === 'macro').length, 1, `${what}: more than one macro resolved`);
  }
});

// --- 3: each recipe expands to what its code says ------------------------------------------------------

test('frame "full" is four rules around the inset rect', () => {
  const ex = expand('fr', 'frame', { ...FRAME_FULL, inset: 10 });
  assert.deepEqual(ex.names, ['top', 'right', 'bottom', 'left']);

  const x0 = 50;
  const y0 = 50;
  const x1 = 330;
  const y1 = 230;
  const corners: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const sides = new Set<string>();
  for (const part of ex.parts) {
    assert.equal(part.op, 'rule');
    assert.equal(args(part)['color'], INK);
    assert.equal(args(part)['weight'], 1);
    const [from, to] = pointsOf(part) as [Pt, Pt];
    const a = corners.findIndex((c) => samePoint(c, from));
    const b = corners.findIndex((c) => samePoint(c, to));
    assert.ok(a >= 0 && b >= 0, `rule ${part.id} runs ${JSON.stringify([from, to])}, not between two corners`);
    assert.equal(Math.abs(a - b) % 2, 1, `rule ${part.id} is a diagonal, not a side`);
    sides.add([a, b].sort().join('-'));
  }
  assert.equal(sides.size, 4, 'the four rules do not cover the four different sides');
});

test('frame "dots" is `count` solid dots walked round the border', () => {
  const ex = expand('fr', 'frame', FRAME_DOTS);
  assert.deepEqual(ex.names, Array.from({ length: 16 }, (_, i) => `dot${i}`));

  const { x, y, w, h } = FRAME_BOX;
  for (const part of ex.parts) {
    assert.equal(part.op, 'paint');
    const region = args(part)['region'] as Record<string, number | string>;
    assert.equal(region['type'], 'circle');
    assert.equal(region['r'], 4);
    assert.deepEqual(args(part)['style'], { kind: 'solid', color: INK, opacity: 255 });
    const cx = region['cx'] as number;
    const cy = region['cy'] as number;
    const onEdge = near(cx, x) || near(cx, x + w) || near(cy, y) || near(cy, y + h);
    const inBox = cx >= x - EPS && cx <= x + w + EPS && cy >= y - EPS && cy <= y + h + EPS;
    assert.ok(onEdge && inBox, `${part.id} at ${cx},${cy} is not on the border of the frame`);
  }
  // Distinct positions, i.e. the walk really walks rather than piling up at a corner.
  const seen = new Set(ex.parts.map((p) => JSON.stringify(pointsOf(p)[0])));
  assert.equal(seen.size, 16, 'two dots landed on the same point');

  const defaults = expand('fr2', 'frame', { ...FRAME_BOX, style: 'dots', color: 'ink' });
  assert.equal(defaults.parts.length, 12, 'the documented default count is 12');
  assert.equal((args(defaults.parts[0]!)['region'] as Record<string, number>)['r'], 3);
});

test('frame "corners" is eight arms, two at each corner of the inset rect', () => {
  const ex = expand('fr', 'frame', FRAME_CORNERS);
  assert.deepEqual(ex.names, ['tl_h', 'tl_v', 'tr_h', 'tr_v', 'br_h', 'br_v', 'bl_h', 'bl_v']);

  const { x, y, w, h } = FRAME_BOX;
  const corner: Record<string, Pt> = { tl: [x, y], tr: [x + w, y], br: [x + w, y + h], bl: [x, y + h] };
  const centre: Pt = [x + w / 2, y + h / 2];
  for (const part of ex.parts) {
    assert.equal(part.op, 'rule');
    const name = part.id.slice(ex.id.length + 1);
    const anchor = corner[name.slice(0, 2)]!;
    const axis: 0 | 1 = name.endsWith('_h') ? 0 : 1;
    const cross: 0 | 1 = axis === 0 ? 1 : 0;
    const [from, to] = pointsOf(part) as [Pt, Pt];
    const far = samePoint(from, anchor) ? to : from;
    assert.ok(samePoint(from, anchor) || samePoint(to, anchor), `${part.id} does not touch its corner`);
    assert.ok(near(Math.abs(far[axis] - anchor[axis]), 40), `${part.id} is not 40 long along its axis`);
    assert.ok(near(far[cross], anchor[cross]), `${part.id} is not axis-aligned`);
    // The arm runs inwards, never off the edge of the frame.
    assert.ok(Math.sign(far[axis] - anchor[axis]) === Math.sign(centre[axis] - anchor[axis]), `${part.id} points outwards`);
  }

  const defaults = expand('fr2', 'frame', { ...FRAME_BOX, style: 'corners', color: 'ink', brush: 'rotring', weight: 1 });
  const [from, to] = pointsOf(defaults.part('tl_h')) as [Pt, Pt];
  assert.equal(Math.abs(to[0] - from[0]), Math.min(FRAME_BOX.w, FRAME_BOX.h) * 0.12, 'the documented default arm is min(w,h) * 0.12');
});

test('the hibiscus motif expands to five petals, a centre and three stamens', () => {
  const ex = expand('mo', 'motif', MOTIF_ARGS, CORE);
  assert.deepEqual(ex.names, ['petal0', 'petal1', 'petal2', 'petal3', 'petal4', 'centre', 'stamen0', 'stamen1', 'stamen2']);

  for (let i = 0; i < 5; i++) {
    const petal = ex.part(`petal${i}`);
    assert.equal(petal.op, 'paint');
    assert.equal((args(petal)['region'] as Record<string, string>)['type'], 'polygon');
    assert.equal((args(petal)['style'] as Record<string, string>)['kind'], 'wash');
  }
  const centre = ex.part('centre');
  assert.equal(centre.op, 'paint');
  assert.equal((args(centre)['region'] as Record<string, string>)['type'], 'circle');
  for (let i = 0; i < 3; i++) {
    assert.equal(ex.part(`stamen${i}`).op, 'stroke');
    assert.equal(args(ex.part(`stamen${i}`))['brush'], '2H');
  }
});

test('a motif is placed and scaled by the macro args and by nothing else', () => {
  // Rather than restate the recipe, this pins the three things `size`, `rotate` and `x`/`y` are
  // supposed to do to whatever the pack happens to contain: scale about the placement point,
  // rotate about it, and move it.
  const base = expand('m1', 'motif', { name: 'hibiscus', x: 0, y: 0, size: 100 }, CORE);
  const moved = expand('m2', 'motif', { name: 'hibiscus', x: 300, y: 220, size: 100 }, CORE);
  const bigger = expand('m3', 'motif', { name: 'hibiscus', x: 0, y: 0, size: 200 }, CORE);
  const turned = expand('m4', 'motif', { name: 'hibiscus', x: 0, y: 0, size: 100, rotate: 90 }, CORE);

  for (const name of base.names) {
    const from = pointsOf(base.part(name));
    const shifted = pointsOf(moved.part(name));
    const scaled = pointsOf(bigger.part(name));
    const rotated = pointsOf(turned.part(name));
    assert.equal(shifted.length, from.length, `${name} changed shape when it moved`);
    from.forEach((p, i) => {
      assert.ok(samePoint(shifted[i]!, [p[0] + 300, p[1] + 220]), `${name}[${i}] did not translate with x/y`);
      assert.ok(samePoint(scaled[i]!, [p[0] * 2, p[1] * 2]), `${name}[${i}] did not scale with size`);
      // Screen space, y down, clockwise positive: 90 degrees sends (x, y) to (-y, x).
      assert.ok(samePoint(rotated[i]!, [-p[1], p[0]]), `${name}[${i}] did not rotate about the placement point`);
    });
  }

  const r = (ex: Expansion) => (args(ex.part('centre'))['region'] as Record<string, number>)['r']!;
  assert.equal(r(bigger), r(base) * 2, 'the centre disc did not scale with size');
  assert.equal(r(turned), r(base), 'rotation changed the centre disc');
});

test('quarantine is the field, a box round it, and a label only if one was asked for', () => {
  const ex = expand('qu', 'quarantine', QUARANTINE_ARGS);
  assert.deepEqual(ex.names, ['field', 'box_top', 'box_right', 'box_bottom', 'box_left', 'label']);

  const { x, y, w, h } = QUARANTINE_BOX;
  const field = ex.part('field');
  assert.equal(field.op, 'paint');
  assert.deepEqual(args(field)['region'], { type: 'rect', x, y, w, h });
  assert.equal((args(field)['style'] as Record<string, unknown>)['kind'], 'wash');
  assert.equal((args(field)['style'] as Record<string, unknown>)['bleed'], 0.08);

  const corners: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const sides = new Set<string>();
  for (const name of ['box_top', 'box_right', 'box_bottom', 'box_left']) {
    const part = ex.part(name);
    assert.equal(part.op, 'rule');
    assert.equal(args(part)['weight'], 0.5);
    assert.equal(args(part)['color'], INK);
    const [from, to] = pointsOf(part) as [Pt, Pt];
    const a = corners.findIndex((c) => samePoint(c, from));
    const b = corners.findIndex((c) => samePoint(c, to));
    assert.ok(a >= 0 && b >= 0, `${name} runs ${JSON.stringify([from, to])}, not between two corners`);
    sides.add([a, b].sort().join('-'));
  }
  assert.equal(sides.size, 4, 'the box does not cover four different sides');

  const label = ex.part('label');
  assert.equal(label.op, 'text');
  assert.equal(args(label)['text'], 'SPONSORS');
  assert.equal(args(label)['align'], 'center');
  assert.equal(args(label)['x'], x + w / 2);
  assert.ok(args(label)['y'] > y + h, 'the label should sit under the fenced box, not inside it');

  const silent = expand('qu2', 'quarantine', { ...QUARANTINE_ARGS, label: undefined });
  assert.deepEqual(silent.names, ['field', 'box_top', 'box_right', 'box_bottom', 'box_left']);
  assert.equal(silent.parts.filter((p) => p.op === 'text').length, 0);
});

// --- 4: the bounds a macro declares --------------------------------------------------------------------

test('a macro declares bounds that hold its parts and cover the box it was asked for', () => {
  for (const { what, box, expand: build } of CASES) {
    const ex = build();
    for (const part of ex.parts) {
      assert.ok(contains(ex.bounds, part.bounds), `${what}: part "${part.id}" ${show(part.bounds)} escapes the macro's ${show(ex.bounds)}`);
    }
    // ...and no larger than it has to be, so "outside the macro" below means something.
    assert.ok(ex.parts.some((p) => near(p.bounds.x, ex.bounds.x)), `${what}: no part reaches the left edge of ${show(ex.bounds)}`);
    assert.ok(ex.parts.some((p) => near(p.bounds.y, ex.bounds.y)), `${what}: no part reaches the top edge of ${show(ex.bounds)}`);
    assert.ok(ex.parts.some((p) => near(p.bounds.x + p.bounds.w, ex.bounds.x + ex.bounds.w)), `${what}: no part reaches the right edge`);
    assert.ok(ex.parts.some((p) => near(p.bounds.y + p.bounds.h, ex.bounds.y + ex.bounds.h)), `${what}: no part reaches the bottom edge`);
    // The other direction: a macro asked to cover a box must claim at least that box.
    assert.ok(contains(ex.bounds, box), `${what}: bounds ${show(ex.bounds)} do not cover the requested ${show(box)}`);
  }
});

// One render, three macros, boxes far enough apart that a part escaping its own macro lands on bare
// ground rather than inside a neighbour. Renders are the expensive thing here, so this is the only
// one: the cheap structural facts are all established above.
const SHEET_W = 800;
const SHEET_H = 800;

const SHEET_MACROS: Record<string, Record<string, unknown>> = {
  frame: macroNode('frame', 'frame', { x: 40, y: 40, w: 280, h: 200, style: 'corners', color: 'ink', brush: 'rotring', weight: 1.5, arm: 40 }),
  motif: macroNode('motif', 'motif', { name: 'hibiscus', x: 600, y: 180, size: 200 }),
  quarantine: macroNode('quarantine', 'quarantine', {
    x: 80, y: 520, w: 300, h: 160,
    style: { kind: 'wash', color: 'teal', opacity: 130, bleed: 0.1, texture: [0.4, 0.2] },
    boxColor: 'ink', boxWeight: 0.5, label: 'FENCED OFF', labelSize: 14,
  }),
};

test('a macro paints nothing outside the bounds it declared', SLOW, async () => {
  const prog = program(Object.values(SHEET_MACROS), {
    assetPack: CORE.id,
    canvas: { width: SHEET_W, height: SHEET_H, ground: '#fdf9f0', brushScale: 2 },
  });
  const resolved = resolveProgram(prog, CORE);
  const boxes = Object.keys(SHEET_MACROS).map((id) => {
    const parts = resolved.nodes.filter((n) => n.expandedFrom === id);
    assert.ok(parts.length > 0, `${id} expanded to nothing`);
    return { id, bounds: unionBounds(parts.map((p) => p.bounds)) };
  });
  // The premise of doing all three in one frame.
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.id >= b.id) continue;
      const apart = a.bounds.x + a.bounds.w < b.bounds.x || b.bounds.x + b.bounds.w < a.bounds.x || a.bounds.y + a.bounds.h < b.bounds.y || b.bounds.y + b.bounds.h < a.bounds.y;
      assert.ok(apart, `${a.id} ${show(a.bounds)} and ${b.id} ${show(b.bounds)} overlap; move them apart`);
    }
  }

  const renderer = await Renderer.launch();
  try {
    const out = await renderer.render(resolved, CORE, ['grotesque']);
    assert.deepEqual(out.warnings, [], 'the page reported errors');

    for (const { id, bounds } of boxes) {
      assert.ok(marked(out.rgba, SHEET_W, SHEET_H, bounds) > 50, `${id}: drew nothing`);
    }
    const spill = markedOutside(out.rgba, SHEET_W, SHEET_H, boxes.map((b) => b.bounds));
    assert.equal(spill, 0, `${spill} marked pixels fell outside every macro's declared bounds`);
  } finally {
    await renderer.close();
  }
});

const GROUND_RGB = [0xfd, 0xf9, 0xf0];

/** Like helpers' `marked(..., outside)`, but excluding several boxes rather than one. */
function markedOutside(rgba: Buffer, width: number, height: number, boxes: Bounds[]): number {
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (boxes.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)) continue;
      const i = 4 * (y * width + x);
      if (rgba[i] !== GROUND_RGB[0] || rgba[i + 1] !== GROUND_RGB[1] || rgba[i + 2] !== GROUND_RGB[2]) n++;
    }
  }
  return n;
}
