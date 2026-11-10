// A group's `clip` crops what its subtree paints. Until this file existed, nothing in the repo
// named `clipSegment` or `clipPolyline` and no golden program used `"clip"` at all, so the two
// branches of the segment clipper were swapped for as long as they have existed and 1000+ green
// tests said nothing about it. The effect was total and silent: `clipSegment` returned null for
// EVERY segment -- including ones lying wholly inside the clip -- so `clipPolyline` returned [],
// and `opStroke` and `opRule` painted nothing under a clip. `clipPolygon` was correct throughout,
// so fills went on working. A clipped group therefore kept its flats and lost its brushwork, which
// reads as a drawing decision rather than a bug (NOTES O2, and the header of operators.test.ts).
//
// The unit half below is the cheap guard. The pixel half is the one that would have caught it: it
// asserts a clipped stroke marks the page at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPolyline, clipSegment } from '../resolve.js';
import { Renderer } from '../../env/browser.js';
import { EMPTY_PACK, marked, program, resolve } from '../../env/tests/helpers.js';

type Point = [number, number];

/** The clip both windings are written out for, since the clipper must not care which it gets. */
const BOX: Point[] = [
  [100, 100],
  [300, 100],
  [300, 300],
  [100, 300],
];
const BOX_REVERSED: Point[] = [...BOX].reverse();

test('clipSegment keeps what is inside the clip, both windings', () => {
  for (const [winding, clip] of [
    ['clockwise', BOX],
    ['counter-clockwise', BOX_REVERSED],
  ] as const) {
    // The case that matters most and is easiest to get wrong: a segment that touches no edge.
    assert.deepEqual(
      clipSegment([150, 200], [250, 200], clip),
      [
        [150, 200],
        [250, 200],
      ],
      `${winding}: a segment wholly inside must survive unchanged`
    );

    assert.deepEqual(
      clipSegment([0, 200], [400, 200], clip),
      [
        [100, 200],
        [300, 200],
      ],
      `${winding}: a segment crossing right through must be cropped to the box`
    );

    assert.deepEqual(
      clipSegment([200, 200], [400, 200], clip),
      [
        [200, 200],
        [300, 200],
      ],
      `${winding}: a segment starting inside must be cropped at the far edge`
    );

    // A diagonal, because the two branches differ by the sign of the edge cross product and an
    // axis-aligned segment is parallel to half the edges, which takes the `den ~ 0` path instead.
    assert.deepEqual(
      clipSegment([0, 100], [400, 500], clip),
      [
        [100, 200],
        [200, 300],
      ],
      `${winding}: a diagonal must be cropped on both ends`
    );

    assert.equal(clipSegment([0, 200], [50, 200], clip), null, `${winding}: wholly left of the box`);
    assert.equal(clipSegment([150, 0], [250, 50], clip), null, `${winding}: wholly above the box`);
    assert.equal(clipSegment([350, 200], [400, 200], clip), null, `${winding}: wholly right of the box`);
  }
});

test('clipPolyline splits a path into the runs that fall inside', () => {
  assert.deepEqual(clipPolyline([[150, 200], [250, 200]], BOX), [[[150, 200], [250, 200]]]);

  // Interior vertices are kept, so a cropped path is still the same shape where it survives.
  assert.deepEqual(clipPolyline([[0, 200], [200, 200], [400, 200]], BOX), [
    [
      [100, 200],
      [200, 200],
      [300, 200],
    ],
  ]);

  // Out and back in again is two runs, not one line joining across the gap.
  const runs = clipPolyline([[150, 200], [400, 200], [400, 250], [150, 250]], BOX);
  assert.equal(runs.length, 2, 'a path that leaves and re-enters must come back as two runs');
  assert.deepEqual(runs[0], [
    [150, 200],
    [300, 200],
  ]);
  assert.deepEqual(runs[1], [
    [300, 250],
    [150, 250],
  ]);

  assert.deepEqual(clipPolyline([[0, 0], [50, 50]], BOX), [], 'a path wholly outside contributes nothing');
});

const W = 400;
const H = 400;
const CLIP = { type: 'rect', x: 100, y: 100, w: 200, h: 200 };

test('a clipped group still paints its strokes, cropped to the clip', { timeout: 180_000 }, async () => {
  // Deliberately larger than the clip in both directions: the stroke and the rule each cross two
  // edges, and the hatch is there so the test can tell "strokes vanished" from "the clip is wrong".
  const children = [
    {
      id: 'g',
      type: 'group',
      clip: CLIP,
      children: [
        {
          id: 'st',
          type: 'op',
          op: 'stroke',
          rngKey: 'k-st',
          args: { points: [[-50, -50], [450, 450]], brush: 'charcoal', color: 'ink', weight: 3 },
        },
        {
          id: 'ru',
          type: 'op',
          op: 'rule',
          rngKey: 'k-ru',
          args: { from: [-50, 200], to: [450, 200], brush: 'rotring', color: 'ink', weight: 2 },
        },
      ],
    },
  ];

  const resolved = resolve(program(children));
  const renderer = await Renderer.launch();
  try {
    const out = await renderer.render(resolved, EMPTY_PACK);
    assert.deepEqual(out.warnings, [], 'the page reported errors');

    const inside = marked(out.rgba, W, H, { x: 100, y: 100, w: 200, h: 200 });
    assert.ok(inside > 500, `a clipped stroke and rule drew ${inside} pixels; they were dropped entirely`);
  } finally {
    await renderer.close();
  }
});
