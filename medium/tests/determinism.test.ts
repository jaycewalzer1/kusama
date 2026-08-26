// Step 1 of the build order: the renderer is byte-deterministic under the pinned configuration.
//
// "Two-context determinism" means two independent Chromium browser contexts, in the same process,
// producing identical pixels. Renderer.render() opens a fresh context per render, so rendering the
// same program twice is exactly that test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../env/browser.js';
import { pixelHash } from '../env/png.js';
import { loadPack } from '../env/pack.js';
import { resolveProgram } from '../renderer/resolve.js';
import { EMPTY_PACK, GROUND, program, resolve, washNode } from './helpers.js';

const CORE = loadPack('core');
const SLOW = { timeout: 120_000 };

/** Differing bytes between two renders, and the worst single-channel delta. */
function drift(a: Buffer, b: Buffer): { bytes: number; maxDelta: number } {
  let bytes = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d) {
      bytes++;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return { bytes, maxDelta };
}

const textNode = (id: string, y: number) => ({
  id,
  type: 'op',
  op: 'text',
  rngKey: `key-${id}`,
  args: { text: 'LESS IS MORE', font: 'grotesque', size: 34, x: 200, y, color: 'ink', align: 'center' },
});

test('the same program renders byte-identically in two browser contexts', SLOW, async () => {
  const resolved = resolve(program([washNode('w1', 150, 150)]));
  const renderer = await Renderer.launch();
  try {
    const a = await renderer.render(resolved, EMPTY_PACK);
    const b = await renderer.render(resolved, EMPTY_PACK);
    assert.equal(a.width, 400);
    assert.equal(a.height, 400);
    assert.equal(a.rgba.length, 400 * 400 * 4);
    assert.deepEqual(a.warnings, []);
    assert.equal(pixelHash(a.rgba), pixelHash(b.rgba), 'two contexts disagreed on the same program');

    // ...and it actually painted something: the wash covers the centre.
    const ground = [0xfd, 0xf9, 0xf0];
    const centre = 4 * (200 * 400 + 150);
    assert.notDeepEqual([a.rgba[centre], a.rgba[centre + 1], a.rgba[centre + 2]], ground);
    // ...while a far corner is still the ground colour.
    assert.deepEqual([a.rgba[0], a.rgba[1], a.rgba[2]], ground, `ground should be ${GROUND}`);
  } finally {
    await renderer.close();
  }
});

// The next two tests deliberately use renderUnchecked(). Both bugs they cover are invisible through
// render(), because render() exists to repeat a render until it repeats itself -- so testing them
// through it would only prove the loop works. See NOTES R6.

test('a program that draws text renders the same way every time', SLOW, async () => {
  // The program that first caught it (NOTES R6): a broad wash, a grid of hatched fragments across
  // it, and a line of text. Because drawing text perturbs the *next* render, a program containing
  // text poisons its own next render, and no two consecutive renders of it ever agreed. Each piece
  // is stable alone, so all three have to be here together for this to test anything.
  const resolved = resolveProgram(
    program(
      [
        {
          id: 'w',
          type: 'op',
          op: 'wash',
          rngKey: 'key-w',
          args: {
            region: { type: 'rect', x: 60, y: 80, w: 680, h: 600 },
            style: { kind: 'wash', color: 'teal', opacity: 150, bleed: 0.15, texture: [0.4, 0.3] },
          },
        },
        {
          id: 'r',
          type: 'repeat',
          rngKey: 'key-r',
          count: 12,
          layout: { type: 'grid', origin: [140, 300], cols: 4, dx: 170, dy: 340 },
          children: [
            {
              id: 'f',
              type: 'op',
              op: 'fragment',
              rngKey: 'key-f',
              args: {
                // A real 68-point outline from the shipped pack, not the test pack's 6-point blob:
                // the flicker lives on hatch ends, and a blob has far too few of them to catch it.
                name: 'figure.standing',
                x: 0,
                y: 0,
                span: 150,
                style: { kind: 'hatch', brush: '2B', color: 'ink', spacing: 5, angle: 30, rand: 0.15, layers: 1 },
              },
            },
          ],
        },
        textNode('t', 1120),
      ],
      { assetPack: CORE.id, canvas: { width: 800, height: 1200, ground: GROUND, brushScale: 3 } }
    ),
    CORE
  );
  const renderer = await Renderer.launch();
  try {
    const first = await renderer.renderUnchecked(resolved, CORE, ['grotesque']);
    for (let i = 2; i <= 4; i++) {
      const next = await renderer.renderUnchecked(resolved, CORE, ['grotesque']);
      const { bytes, maxDelta } = drift(first.rgba, next.rgba);
      assert.equal(bytes, 0, `render ${i} drifted from render 1 by ${bytes} bytes, worst delta ${maxDelta}/255`);
    }
  } finally {
    await renderer.close();
  }
});

test('drawing text does not change the render that follows it', SLOW, async () => {
  // Rendering text used to perturb the *next* render by a few pixels, differently each time, even
  // though each program was stable in isolation (NOTES R6). Fresh pages did not prevent it, so this
  // renders the same wash repeatedly with a text render spliced in front of every one.
  const wash = resolve(program([washNode('w1', 200, 200)]));
  const text = resolve(program([textNode('t1', 200)]));
  const renderer = await Renderer.launch();
  try {
    await renderer.renderUnchecked(text, EMPTY_PACK, ['grotesque']);
    const first = await renderer.renderUnchecked(wash, EMPTY_PACK);
    for (let i = 2; i <= 3; i++) {
      await renderer.renderUnchecked(text, EMPTY_PACK, ['grotesque']);
      const after = await renderer.renderUnchecked(wash, EMPTY_PACK);
      const { bytes, maxDelta } = drift(first.rgba, after.rgba);
      assert.equal(bytes, 0, `the wash after text render ${i} drifted by ${bytes} bytes, worst delta ${maxDelta}/255`);
    }
  } finally {
    await renderer.close();
  }
});

test('a preceding node does not change the marks of the node after it', SLOW, async () => {
  // Same node w2, once alone and once after an unrelated w1. Per-leaf reseeding means adding w1
  // must change nothing outside w1's own declared bounds -- which also checks that those bounds
  // are honest about the wash's bleed.
  const alone = resolve(program([washNode('w2', 300, 300, 'rust')]));
  const preceded = resolve(program([washNode('w1', 80, 80), washNode('w2', 300, 300, 'rust')]));
  const w1 = preceded.nodes.find((n) => n.id === 'w1');
  assert.ok(w1, 'w1 should be in the resolved program');
  const renderer = await Renderer.launch();
  try {
    const a = await renderer.render(alone, EMPTY_PACK);
    const b = await renderer.render(preceded, EMPTY_PACK);
    let differing = 0;
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x < 400; x++) {
        const inW1 =
          x >= w1.bounds.x && x <= w1.bounds.x + w1.bounds.w && y >= w1.bounds.y && y <= w1.bounds.y + w1.bounds.h;
        if (inW1) continue;
        const i = 4 * (y * 400 + x);
        if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2]) differing++;
      }
    }
    assert.equal(differing, 0, `${differing} pixels outside w1's own bounds changed when w1 was added`);
  } finally {
    await renderer.close();
  }
});
