// The dial: turn a direction and a signed k into constraints the existing checker already knows.
//
//     applyInfluence(program, directions, artistId, layer, k, stats) -> InfluenceSet
//
// k is a distance along the direction in z-scored descriptor space. k=0 is the corpus mean, k=1 is
// where the group actually sits, k=2 is twice as far as anyone in the corpus has gone. The target is
// converted back to absolute descriptor units and only then turned into constraints, because a
// constraint has to be a statement about an image and not about a standard deviation.
//
// ## Most of a direction cannot be said in this language
//
// `ConstraintKind` is a closed set of eighteen and the rule is that a nineteenth costs one of them.
// Nothing here spends one. What that buys is an honest accounting, because when the mapping is
// forced through the existing kinds it becomes obvious how little of a descriptor survives:
//
//   palette   -> `palette`            the six Lab centres are literally a set of colours. Clean.
//   armature  -> `symmetryMax`        same IoU definition on both sides, but see AXIS NAMES below,
//                                     and it is a CEILING so it can only ever push symmetry down.
//   armature  -> `inkDensityRange`    related, not identical. See THE 2D PROBLEM.
//   armature  -> `inkOffsetRange`     derivable geometry, different weighting. See THE 2D PROBLEM.
//   armature  -> nothing              the 16x16 grid, aspect, coverage, edge contact.
//   texture   -> NOTHING              48 Gabor energies and an LBP histogram. No kind takes them.
//   form      -> NOTHING              edge hardness, curvature, elongation, stroke orientation.
//
// **The one layer that passed the pair test is the one layer with no constraint to carry it.**
// `texture` was the only descriptor that put a copy nearer its source (58/82, z=3.75); it is also
// the only one this medium cannot be asked about. Everything the dial can actually turn is a layer
// the pair test called a null. That is the central finding of Stage 4 and it is not a footnote:
// every unsayable field is emitted as a `blocked` entry rather than dropped, so the gap is counted.
//
// ## AXIS NAMES: the descriptor and the renderer disagree, and both are internally consistent
//
// `descriptors.py` computes `h_sym = _iou(mask, np.fliplr(mask))` — a LEFT-RIGHT flip, which it
// calls horizontal. `aesthetic/metrics.ts` computes the same left-right flip and calls it
// `symmetry.vertical` (the mirror axis is vertical). Same arithmetic, opposite label. So
// `symmetryH` maps to axis `'vertical'` and `symmetryV` maps to `'horizontal'`, and the swap in
// `SYMMETRY_AXIS` below is deliberate. Reading the names across the two files and matching them up
// would silently mirror every symmetry constraint this file emits.
//
// ## THE 2D PROBLEM
//
// The armature layer's `area` is the Otsu foreground fraction and `inkDensity` is the fraction of
// pixels that are not the ground colour. On a print those nearly agree. But only 14.7% of this
// corpus is 2D work; the rest are photographs of objects, where the Otsu foreground is the SILHOUETTE
// OF A POT against a studio backdrop. So an armature target derived from the corpus can be saying
// "make 40% of the sheet dark" when what it measured was "a vase occupies 40% of this photograph".
// The two constraints affected are emitted anyway, as `soft`, with the conflation written into
// `why` so it reaches whoever reads the report. They are the weakest thing this file produces.

import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import type { Constraint } from '../../aesthetic/types.js';
import type { Program } from '../../env/edits.js';
import { DIMS, OFFSETS, type Layer, type Stats } from './descriptors.js';
import { FIELDS } from './packs.js';
import type { Direction, DirectionsFile, GroupDirections } from './directions.js';

/** Descriptor symmetry field to the axis name `symmetryMax` uses. Swapped on purpose — see above. */
export const SYMMETRY_AXIS: Record<'symmetryH' | 'symmetryV', 'vertical' | 'horizontal'> = {
  symmetryH: 'vertical',
  symmetryV: 'horizontal',
};

/** A descriptor field the direction has an opinion about and the constraint language cannot state. */
export interface Blocked {
  layer: Layer;
  field: string;
  /** The absolute value the direction asked for, where it is a single number. */
  wanted: number | null;
  /** What is missing, in the vocabulary `Constraint.blocked_by` uses. */
  blockedBy: string;
  why: string;
}

export interface InfluenceSet {
  id: string;
  label: string;
  source: Direction['source'];
  layer: Layer;
  k: number;
  /** The layer's descriptor in absolute units at this k. `DIMS[layer]` long. */
  target: number[];
  /** Constraints to ADD to the program. Never replaces one, never edits the program. */
  constraints: Constraint[];
  /** Everything the direction wanted and this medium cannot be asked. */
  blocked: Blocked[];
  /** Kinds the program already constrains, which the caller should look at before merging. */
  overlaps: string[];
  /** Target values no image can have. Non-empty means this k is off the end of the descriptor. */
  impossible: { field: string; index: number; value: number; range: [number, number] }[];
  bizarreness: number;
  /** True when the pair test showed this layer carries influence through this corpus. */
  carriesInfluence: boolean;
}

/**
 * The range each descriptor field can physically occupy, for fields where that is knowable.
 *
 * A direction is a straight line and nothing about the arithmetic stops it. Extrapolating one past
 * where the group actually sits walks the target off the end of the descriptor's own domain: the
 * Rick Owens palette at k=2 asks for a mean chroma of -4.8 and an L* of -7.1, and chroma is a square
 * root and L* is bounded below by zero. No image can be there. Reported per field rather than
 * clamped, because clamping would silently turn "k=2" into "k=1.4 in some dimensions and k=2 in
 * others" and the sweep would still be labelled k=2.
 *
 * Fields not in this table have no bound anyone has established, and their absence is not a claim
 * that they are unbounded.
 */
const EPS = 1e-9;

export const DOMAIN: Record<Layer, Record<string, [number, number]>> = {
  armature: {
    grid: [0, 1],
    areaFraction: [0, 1],
    centroidX: [0, 1],
    centroidY: [0, 1],
    symmetryH: [0, 1],
    symmetryV: [0, 1],
    aspect: [0, Infinity],
  },
  palette: {
    // Lab centres are L,a,b interleaved, so only every third entry is the bounded L. Checked
    // positionally in `outsideDomain` rather than given a range here.
    fractions: [0, 1],
    lMean: [0, 100],
    lStd: [0, 100],
    chromaMean: [0, Infinity],
  },
  texture: { lbp: [0, 1] },
  form: {
    hardness: [0, 1],
    curvatureMean: [0, Math.PI],
    curvatureStd: [0, Math.PI],
    straightFraction: [0, 1],
    elongation: [1, Infinity],
    orientation: [0, 1],
  },
};

/** Fields of `target` that fall outside what an image can actually measure. */
export function outsideDomain(layer: Layer, target: number[]): { field: string; index: number; value: number; range: [number, number] }[] {
  const out: { field: string; index: number; value: number; range: [number, number] }[] = [];
  for (const [name, range] of Object.entries(DOMAIN[layer])) {
    const f = FIELDS[layer][name];
    if (!f) continue;
    for (let i = 0; i < f.len; i++) {
      const v = target[f.at + i]!;
      // EPS, because a target that lands exactly on a bound arrives as -1e-17 and reporting
      // "straightFraction=0 is outside 0..1" is a bug report about floating point, not a finding.
      if (v < range[0] - EPS || v > range[1] + EPS) out.push({ field: name, index: i, value: Number(v.toPrecision(3)), range });
    }
  }
  if (layer === 'palette') {
    const c = FIELDS.palette['centres']!;
    for (let i = 0; i < 6; i++) {
      const L = target[c.at + i * 3]!;
      if (L < -EPS || L > 100 + EPS) out.push({ field: 'centres', index: i * 3, value: Number(L.toPrecision(4)), range: [0, 100] });
    }
  }
  return out;
}

function fieldAt(layer: Layer, name: string): { at: number; len: number } {
  const f = FIELDS[layer][name];
  if (!f) throw new Error(`no field ${name} in ${layer}`);
  return f;
}

// --- CIELAB to sRGB hex --------------------------------------------------------------------------
// D65, the same white point skimage's `rgb2lab` uses by default. Written out rather than pulled in
// because it is twenty lines and the alternative is a dependency for one conversion.

function labToHex(L: number, a: number, b: number): string {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number): number => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * inv(fx);
  const Y = 1.0 * inv(fy);
  const Z = 1.08883 * inv(fz);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  const hex = lin.map((c) => {
    // Out-of-gamut Lab is clamped, not rejected. A direction at k=2 routinely lands outside sRGB,
    // and the honest report of that is the nearest colour a screen can show plus the note in
    // `outOfGamut` — refusing to emit would hide the fact that the dial went past the display.
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255);
  });
  return `#${hex.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** sRGB hex to CIELAB, D65. The inverse of `labToHex`, for snapping a program's colours to a target. */
export function hexToLab(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const ch = [0, 1, 2].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const [r, g, b] = lin as [number, number, number];
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** True when the Lab triple does not survive the round trip into sRGB — the dial went off the display. */
export function outOfGamut(L: number, a: number, b: number): boolean {
  const fy = (L + 16) / 116;
  const inv = (t: number): number => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * inv(fy + a / 500);
  const Y = inv(fy);
  const Z = 1.08883 * inv(fy - b / 200);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return lin.some((c) => c < -0.001 || c > 1.001);
}

// --- bizarreness ---------------------------------------------------------------------------------

/**
 * Per-layer cost of moving one unit of k. Loaded from `influence/bizarreness.json` rather than
 * written here, because it is a judgement about which departures read as strange and nobody has
 * calibrated it against anything. A hardcoded weight is an unfalsifiable claim in a source file.
 */
export type BizarrenessWeights = Record<string, number>;

export const BIZARRENESS = path.join(ROOT, 'influence', 'bizarreness.json');

export function bizarreness(assignments: { layer: string; k: number }[], w: BizarrenessWeights): number {
  return assignments.reduce((a, x) => a + (w[x.layer] ?? 0) * Math.abs(x.k), 0);
}

// --- the dial ------------------------------------------------------------------------------------

export function findGroup(file: DirectionsFile, id: string): GroupDirections | undefined {
  return file.groups.find((g) => g.id === id) ?? file.packs.find((p) => p.id === id);
}

/**
 * Constraints that put `program` k standard-deviations along `id`'s direction in `layer`.
 *
 * `program` is read and never written. It is here so the returned set can report which kinds the
 * program already constrains: the influence layer is additive by policy, so a caller merging these
 * needs to know it is about to have two `palette` constraints rather than one.
 */
export function applyInfluence(
  program: Program,
  file: DirectionsFile,
  id: string,
  layer: Layer,
  k: number,
  stats: Stats,
  weights: BizarrenessWeights,
  severity: 'hard' | 'soft' = 'soft',
): InfluenceSet {
  const group = findGroup(file, id);
  if (!group) throw new Error(`no direction for ${id}; have ${[...file.groups, ...file.packs].map((g) => g.id).join(', ')}`);
  const dir = group.directions[layer];
  if (!dir || !dir.vector) throw new Error(`${id} has no ${layer} direction (it is null — authored packs fill only some layers)`);

  const base = OFFSETS[layer];
  const target = new Array<number>(DIMS[layer]);
  for (let i = 0; i < DIMS[layer]; i++) {
    target[i] = stats.mean[base + i]! + k * dir.vector[i]! * stats.std[base + i]!;
  }

  const constraints: Constraint[] = [];
  const blocked: Blocked[] = [];
  const idp = `influence-${id}-${layer}`;
  const provenance =
    `${dir.source} direction for ${group.label} at k=${k}` +
    (dir.source === 'pixels' ? ` over ${group.works} works` : ' (authored: no works stand behind it)') +
    (dir.carriesInfluence ? '' : `; the pair test did NOT show ${layer} carries influence through this corpus`);

  if (layer === 'palette') {
    const c = fieldAt('palette', 'centres');
    const allow: string[] = [];
    let off = 0;
    for (let i = 0; i < 6; i++) {
      const [L, a, b] = [target[c.at + i * 3]!, target[c.at + i * 3 + 1]!, target[c.at + i * 3 + 2]!];
      if (outOfGamut(L, a, b)) off++;
      allow.push(labToHex(L, a, b));
    }
    constraints.push({
      id: `${idp}-palette`,
      kind: 'palette',
      params: { allow, includeGround: true },
      scope: 'tree',
      severity,
      why:
        `${provenance}. The six k-means centres of the target palette, converted from CIELAB to sRGB` +
        (off ? `. ${off} of the 6 fell outside sRGB and were clamped to the nearest displayable colour` : ''),
    });
    // Emitting maxDistinctColors here would be a fabrication: every palette descriptor has exactly
    // six centres because k is fixed at 6, so "6" is a fact about the algorithm and not about the
    // artist. The descriptor cannot say how many colours anyone actually used.
    blocked.push({
      layer,
      field: 'chromaMean',
      wanted: target[fieldAt('palette', 'chromaMean').at]!,
      blockedBy: 'no saturation constraint',
      why: 'The mean chroma of the sheet is the palette layer\'s strongest single number and the language has no kind that bounds saturation. `palette` fixes exact colours instead, which is a stricter and different thing.',
    });
    blocked.push({
      layer,
      field: 'fractions',
      wanted: null,
      blockedBy: 'no colour-area constraint',
      why: 'How much of the sheet each colour covers. `palette` says which colours may appear and nothing at all about their proportions, so a target that is 55% black is satisfied by one black dot.',
    });
  }

  if (layer === 'armature') {
    for (const f of ['symmetryH', 'symmetryV'] as const) {
      const axis = SYMMETRY_AXIS[f];
      const want = Math.min(1, Math.max(0, target[fieldAt('armature', f).at]!));
      const corpus = stats.mean[base + fieldAt('armature', f).at]!;
      if (want < corpus) {
        constraints.push({
          id: `${idp}-symmetry-${axis}`,
          kind: 'symmetryMax',
          params: { axis, max: Number(want.toFixed(4)) },
          scope: 'render',
          severity,
          why: `${provenance}. Target ${axis} symmetry ${want.toFixed(3)} against a corpus mean of ${corpus.toFixed(3)}.`,
        });
      } else {
        // A ceiling cannot ask for more. This is not a mapping oversight, it is the shape of the
        // kind: `symmetryMax` is satisfied by a completely asymmetric image at any max.
        blocked.push({
          layer,
          field: f,
          wanted: want,
          blockedBy: 'symmetryMax is a ceiling, with no floor',
          why: `The direction wants ${axis} symmetry of ${want.toFixed(3)}, ABOVE the corpus mean ${corpus.toFixed(3)}. \`symmetryMax\` can only forbid symmetry, never require it, so this half of the direction cannot be stated.`,
        });
      }
    }

    const area = target[fieldAt('armature', 'areaFraction').at]!;
    const band = 0.08;
    constraints.push({
      id: `${idp}-density`,
      kind: 'inkDensityRange',
      params: { min: Number(Math.max(0, area - band).toFixed(4)), max: Number(Math.min(1, area + band).toFixed(4)) },
      scope: 'render',
      severity,
      why:
        `${provenance}. Target Otsu foreground fraction ${area.toFixed(3)}, +/-${band}. ` +
        'CAVEAT: only 14.7% of this corpus is 2D, so for most works this number is the silhouette of a photographed object against a backdrop, not a quantity of ink on a sheet.',
    });

    const cx = target[fieldAt('armature', 'centroidX').at]!;
    const cy = target[fieldAt('armature', 'centroidY').at]!;
    // centre-to-corner is sqrt(0.5) in these normalised units, which is what inkOffset divides by.
    const offset = Math.min(1, Math.hypot(cx - 0.5, cy - 0.5) / Math.SQRT1_2);
    constraints.push({
      id: `${idp}-offset`,
      kind: 'inkOffsetRange',
      params: { min: Number(Math.max(0, offset - 0.1).toFixed(4)), max: Number(Math.min(1, offset + 0.1).toFixed(4)) },
      scope: 'render',
      severity,
      why:
        `${provenance}. Target centroid (${cx.toFixed(3)}, ${cy.toFixed(3)}) is ${offset.toFixed(3)} of the way to a corner. ` +
        'CAVEAT: the descriptor centroid is unweighted over the Otsu mask; inkOffset is tone-weighted. Same geometry, different weighting. Plus the 2D caveat above.',
    });

    blocked.push({
      layer,
      field: 'grid',
      wanted: null,
      blockedBy: 'no spatial-layout constraint',
      why: 'The 256 luminance cells are 98% of this layer and carry where the darks actually sit. `coverageRange` counts how many of a 16x16 grid have ANY ink, which a grid of cell MEANS cannot be turned into, and no kind reads the arrangement.',
    });
    blocked.push({
      layer,
      field: 'aspect',
      wanted: target[fieldAt('armature', 'aspect').at]!,
      blockedBy: 'no silhouette constraint',
      why: 'Width over height of the foreground bounding box. The sheet is a fixed size and nothing measures the shape of what is on it.',
    });
  }

  if (layer === 'texture' || layer === 'form') {
    // Every field, listed one by one rather than as a single "unsupported layer" line. The count is
    // the argument: 58 texture and 24 form dimensions have no constraint at all between them.
    for (const [name, f] of Object.entries(FIELDS[layer])) {
      blocked.push({
        layer,
        field: name,
        wanted: f.len === 1 ? target[f.at]! : null,
        blockedBy: layer === 'texture' ? 'no texture constraint' : 'no stroke-geometry constraint',
        why:
          layer === 'texture'
            ? `${f.len} dimension(s) of ${name}. Nothing in the eighteen kinds reads the image's frequency content. \`requireMark\` names a p5.brush style, which is a fact about the tree and not about the pixels it produced.`
            : `${f.len} dimension(s) of ${name}. Edge hardness, contour curvature and stroke orientation are all properties of the canonical PNG and none of the six RenderMetrics fields measures any of them.`,
      });
    }
  }

  const existing = new Set(
    [...program ? collectKinds(program) : []],
  );
  const overlaps = [...new Set(constraints.map((c) => c.kind))].filter((k2) => existing.has(k2));

  return {
    id: group.id,
    label: group.label,
    source: dir.source,
    layer,
    k,
    target: target.map((v) => Number(v.toFixed(6))),
    constraints,
    blocked,
    overlaps,
    impossible: outsideDomain(layer, target),
    bizarreness: bizarreness([{ layer, k }], weights),
    carriesInfluence: dir.carriesInfluence,
  };
}

/**
 * Constraint kinds the program's own aesthetic program already states, if it carries one.
 *
 * A `Program` is a render tree and does not have to know about constraints at all, so this reads a
 * `meta.constraints` array if one is there and returns nothing otherwise. Returning nothing is the
 * right answer for a bare program: it constrains no kinds.
 */
function collectKinds(program: Program): string[] {
  const meta = (program as { meta?: { constraints?: { kind?: string }[] } }).meta;
  return (meta?.constraints ?? []).map((c) => c.kind).filter((k): k is string => typeof k === 'string');
}
