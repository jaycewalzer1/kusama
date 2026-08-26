// Step 4 of the build order: every primitive draws, and every primitive tells the truth about where.
//
// Two claims per operator, both cheap and both load-bearing:
//   1. it marks pixels at all (an operator that silently does nothing is the failure mode that hurts,
//      because it looks like a rendering choice rather than a bug -- see NOTES O2);
//   2. every mark it makes falls inside the bounds `resolve.js` declared for it. Everything
//      downstream -- diff spillover, batch position-independence, the locality tests -- is only
//      meaningful if those bounds are honest, including the brush's bleed past the nominal shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../env/browser.js';
import { differingOutside, EMPTY_PACK, marked, program, resolve } from './helpers.js';

const SLOW = { timeout: 180_000 };
const W = 400;
const H = 400;

const REGION = { type: 'rect', x: 120, y: 120, w: 160, h: 160 };

/** Something for `cover` to take away. Solid, so any residue is unambiguous. */
const UNDER = {
  id: 'under', type: 'op', op: 'paint', rngKey: 'k-under',
  args: { region: { type: 'rect', x: 60, y: 60, w: 280, h: 280 }, style: { kind: 'solid', color: 'teal', opacity: 255 } },
};

/** One node per case, so nothing overlaps and bounds can be checked per operator. */
const CASES: { name: string; node: Record<string, unknown>; fonts?: string[] }[] = [
  {
    name: 'wash',
    node: { op: 'wash', args: { region: { type: 'circle', cx: 200, cy: 200, r: 80 }, style: { kind: 'wash', color: 'teal', opacity: 150, bleed: 0.15, texture: [0.5, 0.3] } } },
  },
  {
    name: 'paint/hatch',
    node: { op: 'paint', args: { region: REGION, style: { kind: 'hatch', brush: '2B', color: 'rust', spacing: 6, angle: 35, rand: 0.15, layers: 2 } } },
  },
  {
    name: 'paint/field',
    node: { op: 'paint', args: { region: REGION, style: { kind: 'field', brush: 'pen', color: 'ink', density: 4, length: 14, angle: 20, jitter: 30, marks: 'dashes' } } },
  },
  {
    name: 'paint/outline',
    node: { op: 'paint', args: { region: REGION, style: { kind: 'outline', brush: 'rotring', color: 'ink', weight: 2 } } },
  },
  {
    name: 'paint/solid',
    node: { op: 'paint', args: { region: REGION, style: { kind: 'solid', color: 'ink', opacity: 220 } } },
  },
  {
    name: 'stroke',
    node: { op: 'stroke', args: { points: [[120, 280], [180, 140], [260, 260], [300, 150]], brush: 'charcoal', color: 'ink', weight: 3, curve: 0.4, closed: false } },
  },
  {
    name: 'fragment',
    node: { op: 'fragment', args: { name: 'blob', x: 200, y: 200, span: 150, rotate: 20, style: { kind: 'solid', color: 'rust', opacity: 240 } } },
  },
  {
    name: 'rule',
    node: { op: 'rule', args: { from: [80, 200], to: [320, 210], brush: 'rotring', color: 'ink', weight: 1.5 } },
  },
  {
    name: 'text',
    node: { op: 'text', args: { text: 'LESS IS MORE', font: 'grotesque', size: 34, x: 60, y: 210, color: 'ink' } },
    fonts: ['grotesque'],
  },
];

test('every primitive draws, and only inside the bounds it declared', SLOW, async () => {
  const renderer = await Renderer.launch();
  try {
    for (const { name, node, fonts } of CASES) {
      const resolved = resolve(program([{ id: 'n', type: 'op', rngKey: 'k-n', ...node }]));
      const target = resolved.nodes.find((n) => n.id === 'n');
      assert.ok(target, `${name}: node should survive resolution`);

      const out = await renderer.render(resolved, EMPTY_PACK, fonts ?? []);
      assert.deepEqual(out.warnings, [], `${name}: the page reported errors`);

      assert.ok(marked(out.rgba, W, H, target.bounds) > 50, `${name}: drew nothing`);
      const spill = marked(out.rgba, W, H, target.bounds, true);
      assert.equal(spill, 0, `${name}: ${spill} marked pixels fell outside its declared bounds`);
    }
  } finally {
    await renderer.close();
  }
});

test('cover restores the ground exactly, and only where it said it would', SLOW, async () => {
  const cover = { id: 'n', type: 'op', op: 'cover', rngKey: 'k-n', args: { region: REGION, softness: 0.2 } };
  const before = resolve(program([UNDER]));
  const after = resolve(program([UNDER, cover]));
  const target = after.nodes.find((n) => n.id === 'n')!;

  const renderer = await Renderer.launch();
  try {
    const a = await renderer.render(before, EMPTY_PACK);
    const b = await renderer.render(after, EMPTY_PACK);

    // The core of the covered region is the ground colour again, byte for byte.
    const centre = 4 * (200 * W + 200);
    assert.deepEqual([b.rgba[centre], b.rgba[centre + 1], b.rgba[centre + 2]], [0xfd, 0xf9, 0xf0]);
    // The layer it covered is otherwise untouched...
    assert.ok(marked(b.rgba, W, H, target.bounds, true) > 1000, 'cover erased more than its region');
    // ...and nothing at all changed outside the bounds cover declared.
    assert.equal(differingOutside(a.rgba, b.rgba, W, H, [target.bounds]), 0);
  } finally {
    await renderer.close();
  }
});
