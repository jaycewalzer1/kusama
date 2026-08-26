// Authoring script for the `core` asset pack. Run `node assets/packs/core/author.mjs` to rewrite
// pack.json; nothing at render time uses this file.
//
// Fragments are drawn here as coarse control polygons in a convenient 0..100 box with y down, then
// (optionally) smoothed by Chaikin corner cutting and normalised into the unit box the renderer
// expects. Authoring the control points and deriving the outline is the only honest way to get
// shapes that are original: none of these are traced from a photograph, an artwork or a logo.
//
// Chaikin doubles the point count per iteration, so `smooth` is chosen per shape to land inside the
// profile's 20..80 point window. Shapes that should stay crisp (architecture, broken edges, marks)
// get 0 iterations and therefore carry all their vertices explicitly.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../../dist/env/profile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- shape helpers --------------------------------------------------------------------------------

/** One round of Chaikin corner cutting on a closed polygon: each edge becomes its middle two quarters. */
function chaikin(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    out.push([x0 + 0.25 * (x1 - x0), y0 + 0.25 * (y1 - y0)]);
    out.push([x0 + 0.75 * (x1 - x0), y0 + 0.75 * (y1 - y0)]);
  }
  return out;
}

/** Centre on the bounding box and scale the longer side to 1, so every fragment fills the unit box. */
function normalize(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = 1 / Math.max(maxX - minX, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return points.map(([x, y]) => [round((x - cx) * scale), round((y - cy) * scale)]);
}

const round = (v) => Math.round(v * 10000) / 10000;

function fragment(label, smooth, control) {
  let points = control;
  for (let i = 0; i < smooth; i++) points = chaikin(points);
  if (points.length < 20 || points.length > 80) {
    throw new Error(`${label}: ${points.length} points is outside the 20..80 the profile allows`);
  }
  return { label, points: normalize(points) };
}

/** Alternating outer/inner radius about (50,50), for the two marks that are geometric by nature. */
function star(spikes, outer, inner, phase = 0) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const t = phase + (Math.PI * i) / spikes;
    const r = i % 2 === 0 ? outer : inner;
    pts.push([50 + r * Math.cos(t), 50 + r * Math.sin(t)]);
  }
  return pts;
}

/** Points along a circular arc, angles in degrees, y up in maths but written down the screen. */
function arc(cx, cy, r, from, to, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
  }
  return pts;
}

// --- fragments ------------------------------------------------------------------------------------
// Outlines run clockwise on screen. Comments name the landmarks so the shapes stay editable.

const FRAGMENTS = {
  // Frontal standing figure: head, two arms hanging clear of the body, two legs.
  'figure.standing': fragment('standing figure', 1, [
    [50, 3], [58, 8], [57, 18], [54, 22],
    [66, 27], [72, 42], [75, 58], [73, 64], [67, 60], [64, 44], [61, 33],
    [60, 50], [63, 66], [61, 84], [60, 97], [52, 97], [51, 80],
    [50, 66],
    [49, 80], [48, 97], [40, 97], [39, 84], [37, 66], [40, 50],
    [39, 33], [36, 44], [33, 58], [27, 64], [25, 58], [28, 42], [34, 27],
    [46, 22], [43, 18], [42, 8],
  ]),

  // Figure seated on the ground in profile, facing right, knees up.
  'figure.seated': fragment('seated figure', 1, [
    [34, 6], [43, 11], [41, 20],
    [46, 26], [52, 40], [62, 50], [76, 54], [82, 62], [80, 76], [86, 88], [86, 94],
    [66, 94], [70, 76], [68, 60], [50, 66],
    [34, 72], [24, 64], [26, 44], [28, 26], [25, 12],
  ]),

  // Four heads and shoulders overlapping: a crowd read as one silhouette.
  'figure.crowd': fragment('crowd', 1, [
    [6, 95], [8, 74], [14, 66],
    [14, 54], [20, 46], [27, 53], [27, 64],
    [33, 58], [35, 44], [42, 36], [50, 44], [50, 58],
    [57, 64], [58, 52], [64, 44], [71, 52], [71, 64],
    [78, 60], [79, 48], [85, 40], [92, 48], [92, 62],
    [94, 72], [94, 95],
  ]),

  // Open hand, fingers spread, thumb to the left.
  'hand.open': fragment('open hand', 1, [
    [30, 96], [26, 74],
    [16, 60], [10, 50], [16, 44], [28, 56],
    [32, 46], [28, 20], [33, 12], [39, 18],
    [42, 42], [44, 14], [50, 6], [56, 13],
    [56, 42], [60, 18], [67, 13], [70, 20],
    [67, 46], [74, 30], [81, 27], [84, 34],
    [78, 56], [74, 78], [70, 96],
  ]),

  // Fist with the index finger extended upward.
  'hand.pointing': fragment('pointing hand', 2, [
    [36, 96], [30, 70], [30, 50], [36, 38],
    [40, 10], [46, 4], [52, 12], [54, 36],
    [66, 32], [74, 44], [72, 62], [66, 80], [64, 96],
  ]),

  // Long-legged bird standing in profile, beak to the left.
  'animal.bird': fragment('bird', 1, [
    [6, 26], [18, 18], [28, 22], [34, 32],
    [46, 36], [62, 40], [82, 34], [94, 40], [84, 48], [66, 52],
    [58, 62], [56, 78], [60, 94], [48, 94], [50, 76], [46, 60],
    [34, 52], [26, 40], [20, 30], [10, 30],
  ]),

  // Four-legged animal in profile, head to the left, tail up.
  'animal.dog': fragment('dog', 1, [
    [8, 32], [16, 24], [20, 14], [28, 20], [34, 32],
    [48, 36], [70, 34], [80, 20], [88, 14], [86, 26], [82, 42],
    [84, 64], [86, 88], [78, 88], [74, 64],
    [66, 58], [48, 60], [36, 62],
    [38, 86], [30, 86], [28, 60],
    [22, 48], [12, 44], [8, 38],
  ]),

  // A round-headed opening: two piers, an outer extrados and an inner intrados, left open at the
  // bottom. Kept unsmoothed so the piers stay square.
  'arch.arch': fragment('arch', 0, [
    [10, 100],
    ...arc(50, 45, 40, 180, 0, 8),
    [90, 100], [74, 100],
    ...arc(50, 45, 24, 0, 180, 8),
    [26, 100],
  ]),

  // Column: abacus, echinus, tapered shaft, torus and plinth. Unsmoothed for the same reason.
  'arch.column': fragment('column', 0, [
    [22, 4], [78, 4], [78, 12], [70, 14], [66, 22], [64, 26],
    [63, 50], [65, 76], [66, 80], [72, 82], [74, 88], [80, 90], [80, 98],
    [20, 98], [20, 90], [26, 88], [28, 82], [34, 80], [35, 76],
    [37, 50], [36, 26], [34, 22], [30, 14], [22, 12],
  ]),

  // A wide shallow vessel seen slightly from above.
  'object.bowl': fragment('bowl', 2, [
    [10, 30], [26, 25], [50, 23], [74, 25], [90, 30],
    [88, 42], [80, 62], [66, 76], [50, 80], [34, 76], [20, 62], [12, 42],
  ]),

  // Broken piece: every vertex is a fracture, so nothing is smoothed.
  'debris.shard': fragment('shard', 0, [
    [50, 4], [58, 18], [72, 14], [66, 30], [82, 34], [70, 44],
    [88, 56], [72, 60], [80, 76], [64, 70], [66, 90], [54, 76],
    [46, 96], [40, 74], [26, 86], [30, 66], [12, 68], [24, 54],
    [6, 44], [24, 38], [16, 22], [34, 28], [32, 10], [44, 20],
  ]),

  // A widening shaft of light with a ragged far end. Straight sides, so no smoothing.
  'light.beam': fragment('beam of light', 0, [
    [44, 2], [56, 2],
    [62, 20], [68, 38], [74, 54], [80, 70], [86, 86], [90, 98],
    [78, 96], [74, 98], [62, 95], [56, 98], [44, 96], [38, 98], [26, 95], [20, 98], [10, 98],
    [14, 86], [20, 70], [26, 54], [32, 38], [38, 20],
  ]),

  // Three invented sponsor marks. Deliberately generic: a burst, a chevron block and a seal.
  'mark.sponsor-a': fragment('sponsor mark A', 0, star(12, 48, 22, -Math.PI / 2)),

  'mark.sponsor-b': fragment('sponsor mark B', 1, [
    [8, 20], [26, 20], [50, 52], [74, 20], [92, 20],
    [92, 80], [74, 80], [74, 46], [58, 68], [42, 68], [26, 46], [26, 80], [8, 80],
  ]),

  'mark.sponsor-c': fragment('sponsor mark C', 1, star(16, 48, 41)),
};

// --- motifs ---------------------------------------------------------------------------------------

/** One petal, base at the origin and tip at radius 0.5, rotated to `deg`. */
function petal(deg) {
  const outline = [
    [0, -0.04], [0.1, -0.1], [0.2, -0.24], [0.22, -0.38], [0.12, -0.47],
    [0, -0.5], [-0.12, -0.47], [-0.22, -0.38], [-0.2, -0.24], [-0.1, -0.1],
  ];
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return outline.map(([x, y]) => [round(x * cos - y * sin), round(x * sin + y * cos)]);
}

const MOTIFS = {
  // Five petals, a disc at the centre and three stamen filaments. Petal and centre colours are
  // palette names, so a program that places this motif must define `rust` and `ink` (or override
  // both with the macro's own `color`).
  hibiscus: {
    label: 'hibiscus',
    parts: [
      ...[0, 72, 144, 216, 288].map((deg, i) => ({
        type: 'paint',
        name: `petal${i}`,
        region: { type: 'polygon', points: petal(deg) },
        style: { kind: 'wash', color: 'rust', opacity: 200, bleed: 0.12, texture: [0.4, 0.3] },
      })),
      {
        type: 'paint',
        name: 'centre',
        region: { type: 'circle', cx: 0, cy: 0, r: 0.09 },
        style: { kind: 'solid', color: 'ink', opacity: 220 },
      },
      ...[-24, 0, 24].map((deg, i) => {
        const t = ((deg - 90) * Math.PI) / 180;
        return {
          type: 'stroke',
          name: `stamen${i}`,
          points: [
            [0, 0],
            [round(0.16 * Math.cos(t)), round(0.16 * Math.sin(t))],
            [round(0.3 * Math.cos(t)), round(0.3 * Math.sin(t))],
          ],
          brush: '2H',
          color: 'ink',
          weight: 0.6,
          curve: 0.2,
        };
      }),
    ],
  },
};

// --- write ----------------------------------------------------------------------------------------

const body = { id: 'core', fragments: FRAGMENTS, motifs: MOTIFS };
const pack = { ...body, hash: contentHash(body) };
writeFileSync(path.join(HERE, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);

const counts = Object.entries(FRAGMENTS).map(([k, v]) => `${k}:${v.points.length}`);
console.log(`core@${pack.hash.slice(0, 12)}  ${Object.keys(FRAGMENTS).length} fragments, ${Object.keys(MOTIFS).length} motifs`);
console.log(counts.join('  '));
