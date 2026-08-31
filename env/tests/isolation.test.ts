// Step 2 of the build order: per-leaf isolation. Nothing an operator sets may survive it -- not
// brush state, not the p5 transform, not the RNG position.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../browser.js';
import {
  EMPTY_PACK,
  differingOutside,
  group,
  hatchNode,
  program,
  resolve,
  solidNode,
  strokeNode,
} from './helpers.js';

const SLOW = { timeout: 120_000 };

test('no brush state, transform or RNG position leaks out of a leaf', SLOW, async () => {
  // `target` is drawn with plain p5 fill. If the crosshatch, the charcoal stroke or the rotated and
  // scaled group before it leaked, the target's pixels would move or gain an outline.
  const target = solidNode('target', 250, 250);
  const alone = resolve(program([target]));
  const preceded = resolve(
    program([
      group(
        'noisy',
        [hatchNode('h1', 20, 20), strokeNode('s1', [[20, 150], [90, 80], [150, 160]])],
        { translate: [30, 10], rotate: 22, scale: 1.3 }
      ),
      target,
    ])
  );

  const noisyBounds = preceded.nodes.filter((n) => n.id !== 'target').map((n) => n.bounds);
  const renderer = await Renderer.launch();
  try {
    const a = await renderer.render(alone, EMPTY_PACK);
    const b = await renderer.render(preceded, EMPTY_PACK);
    const differing = differingOutside(a.rgba, b.rgba, a.width, a.height, noisyBounds);
    assert.equal(differing, 0, `${differing} pixels changed outside the preceding nodes' own bounds`);
  } finally {
    await renderer.close();
  }
});

test('reordering two non-overlapping leaves leaves both of them unchanged', SLOW, async () => {
  // Paint order is program order, but a node's own marks must not depend on where in the order it
  // sits. Two nodes that do not overlap therefore give identical pixels in either order.
  const a = hatchNode('a', 30, 40);
  const b = solidNode('b', 250, 250);
  const ab = resolve(program([a, b]));
  const ba = resolve(program([b, a]));
  const renderer = await Renderer.launch();
  try {
    const first = await renderer.render(ab, EMPTY_PACK);
    const second = await renderer.render(ba, EMPTY_PACK);
    const differing = differingOutside(first.rgba, second.rgba, first.width, first.height, []);
    assert.equal(differing, 0, `${differing} pixels changed when two disjoint nodes swapped order`);
  } finally {
    await renderer.close();
  }
});
