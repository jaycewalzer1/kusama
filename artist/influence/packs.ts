// Authored influence packs: a direction someone wrote down, rather than one measured off works.
//
// A pixel direction comes from a group this corpus holds. Most of the influences that matter to a
// practice are not in this corpus — nobody's Rick Owens collection is in the Met — so the only way
// to name one is to assert it. This file is the format for that assertion and the loader that turns
// it into the same `Direction` shape `computeDirections` produces, so downstream code does not care
// which kind it got.
//
// ## Authored packs are sparse, and that is the honest part
//
// A measured direction fills every dimension of a layer because a measurement has an opinion about
// all of them. A hand does not. Someone can write down that Owens' palette is near-black with a bone
// highlight and almost no chroma — those are real numbers in CIELAB. Nobody can write down a
// 48-dimensional Gabor energy bank, and a pack that pretended to would be fabricating 48 floats and
// calling them a reference.
//
// So a pack names FIELDS, not vectors. A field that is not named is left at the corpus mean, which
// in z-scored space is zero: no claim, no push. Every direction then carries `coverage`, the
// fraction of the layer the author actually filled, and a reader who sees magnitude 4.2 at coverage
// 0.30 knows that magnitude came out of 8 of 27 dimensions.
//
// ## Why authored values are absolute and not z-scores
//
// The author writes L*=12, not "2.4 standard deviations below the corpus". Writing z directly would
// make the pack a function of whichever corpus it was written against, so re-ingesting the corpus
// would silently change what the pack claimed. In absolute units the pack means the same thing
// forever and the z-scoring happens here, against the stats of the day.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { DIMS, LAYERS, OFFSETS, type Layer, type Stats } from './descriptors.js';
import { TEXT_LAYERS, type Direction, type GroupDirections } from './directions.js';
import { PAIR_TEST_VERDICT } from './directions.js';

export const PACKS_DIR = path.join(ROOT, 'influence', 'packs');

/**
 * Where each named field sits inside its layer's slice, and how long it is.
 *
 * This table is the whole reason a pack can be written by a person: it is the only place the
 * descriptor's flat float order is given human names. It must match `influence/descriptors.py`
 * exactly — a test asserts the lengths here sum to `DIMS`.
 */
export const FIELDS: Record<Layer, Record<string, { at: number; len: number }>> = {
  armature: {
    grid: { at: 0, len: 256 },
    aspect: { at: 256, len: 1 },
    areaFraction: { at: 257, len: 1 },
    centroidX: { at: 258, len: 1 },
    centroidY: { at: 259, len: 1 },
    symmetryH: { at: 260, len: 1 },
    symmetryV: { at: 261, len: 1 },
  },
  palette: {
    /** 6 CIELAB centres, L,a,b each, sorted by area DESCENDING. Centre 0 is the biggest region. */
    centres: { at: 0, len: 18 },
    /** The 6 area fractions, same order, summing to 1. */
    fractions: { at: 18, len: 6 },
    lMean: { at: 24, len: 1 },
    lStd: { at: 25, len: 1 },
    chromaMean: { at: 26, len: 1 },
  },
  texture: {
    /** 4 scales x 6 orientations, (mean, std) per filter. */
    gabor: { at: 0, len: 48 },
    /** Uniform LBP, P=8 R=1, 10 bins. */
    lbp: { at: 48, len: 10 },
  },
  form: {
    /** 8 bins of gradient magnitude at Canny edges, on a FIXED [0,1] range. Bin 7 is hardest. */
    hardness: { at: 0, len: 8 },
    /** Mean absolute turning angle over the top-20 contours, in radians. */
    curvatureMean: { at: 8, len: 1 },
    curvatureStd: { at: 9, len: 1 },
    /** Fraction of turns under 5 degrees. See the warning in `docs/influence/README.md`. */
    straightFraction: { at: 10, len: 1 },
    /** Long/short of the largest dark contour's min-area box. 1 is a square, higher is longer. */
    elongation: { at: 11, len: 1 },
    /** 12 bins over [0,pi). Verified against synthetic probes: bin 0 is horizontal, bin 6 vertical. */
    orientation: { at: 12, len: 12 },
  },
};

export interface AuthoredLayer {
  /** What the author is claiming, in words. Required: a pack with numbers and no note is unreadable. */
  note: string;
  /** Field name from `FIELDS` to a scalar or an array of exactly that field's length. */
  fields: Record<string, number | number[]>;
}

export interface Pack {
  id: string;
  label: string;
  source: 'authored';
  descriptorVersion: string;
  authored: string;
  /** What this was read off. A pack with no basis is someone's taste with a schema around it. */
  basis: string;
  /** Layers the author declined to fill are `null`, and stay null all the way to the output. */
  layers: Partial<Record<Layer, AuthoredLayer | null>>;
}

export function listPacks(dir = PACKS_DIR): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** Read and validate one pack. Throws with the offending field named — a pack is small, so a bad one is a typo. */
export function loadPack(file: string): Pack {
  const p = JSON.parse(readFileSync(file, 'utf8')) as Pack;
  if (p.source !== 'authored') throw new Error(`${file}: source must be "authored", got ${String(p.source)}`);
  if (!p.id || !p.label || !p.basis) throw new Error(`${file}: id, label and basis are all required`);
  for (const [layer, spec] of Object.entries(p.layers)) {
    if (spec === null || spec === undefined) continue;
    if (!(LAYERS as readonly string[]).includes(layer)) throw new Error(`${file}: unknown layer ${layer}`);
    if (!spec.note) throw new Error(`${file}: ${layer} has fields but no note`);
    const table = FIELDS[layer as Layer];
    for (const [name, value] of Object.entries(spec.fields)) {
      const f = table[name];
      if (!f) throw new Error(`${file}: ${layer} has no field ${name}; known: ${Object.keys(table).join(', ')}`);
      const n = Array.isArray(value) ? value.length : 1;
      if (n !== f.len) throw new Error(`${file}: ${layer}.${name} needs ${f.len} value(s), got ${n}`);
      for (const v of Array.isArray(value) ? value : [value]) {
        if (!Number.isFinite(v)) throw new Error(`${file}: ${layer}.${name} has a non-finite value`);
      }
    }
  }
  return p;
}

/**
 * Turn a pack into the same shape a measured group produces.
 *
 * `works: 0` is not a placeholder — it is the true count of works this direction was measured over,
 * and it keeps an authored pack from ever being read as if fifteen objects stood behind it.
 */
export function packDirections(p: Pack, stats: Stats): GroupDirections {
  const directions: Record<string, Direction | null> = {};

  for (const layer of LAYERS) {
    const spec = p.layers[layer];
    if (!spec) {
      directions[layer] = null;
      continue;
    }
    const dim = DIMS[layer];
    const base = OFFSETS[layer];
    const vec = new Float64Array(dim);
    let filled = 0;

    for (const [name, value] of Object.entries(spec.fields)) {
      const f = FIELDS[layer][name]!;
      const values = Array.isArray(value) ? value : [value];
      values.forEach((v, i) => {
        // Absolute value in, z-score out. The corpus mean is zero in z-space, so the z-score IS the
        // direction for this dimension; unfilled dimensions keep their zero and push nothing.
        vec[f.at + i] = (v - stats.mean[base + f.at + i]!) / stats.std[base + f.at + i]!;
      });
      filled += f.len;
    }

    const magnitude = Math.sqrt(vec.reduce((a, c) => a + c * c, 0));
    directions[layer] = {
      source: 'authored',
      vector: Array.from(vec, (v) => Number(v.toFixed(6))),
      magnitude: Number(magnitude.toFixed(6)),
      // An assertion has no spread: there is one of it. Zero here means "not measured", and is why
      // spread must never be read without checking `source`.
      spread: 0,
      coverage: Number((filled / dim).toFixed(4)),
      cohesionZ: null,
      cohesive: false,
      carriesInfluence: PAIR_TEST_VERDICT[layer],
    };
  }

  for (const l of TEXT_LAYERS) directions[l] = null;
  return { id: p.id, label: p.label, kind: 'artist', works: 0, directions };
}
