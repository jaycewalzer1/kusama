// The sheet the artist starts from.
//
// A blank one, on purpose. Every element that ends up in the picture has to have been put there by an
// edit the artist chose and the validator accepted, so a trajectory's tree is entirely the artist's
// doing and `destructionRate` and `realization` mean what they say. Seeding a half-drawn composition
// would hand the artist a plan it never made and score it for keeping it.
//
// Everything here is a pure function of the commission and the run seed, so two runs of the same cell
// with the same seed begin from the same program hash. The palette names are the only thing the
// artist inherits: an edit refers to a colour by name, and a program with no palette gives it nothing
// to say. Three names is the fewest that can express figure, ground and one accent.

import type { Program } from './types.js';

/** Poster proportions, fixed for the whole grid so cells are comparable as pictures. */
export const SEED_CANVAS = { width: 520, height: 700 } as const;

// ---------------------------------------------------------------------------
// Seeded PRNG (xorshift32). Returns a function that yields 0..1 on each call.
// ---------------------------------------------------------------------------
function xorshift32(seed: number): () => number {
  let s = seed | 0 || 1; // must be nonzero
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// HSL (h 0-360, s 0-1, l 0-1) -> '#rrggbb'
// ---------------------------------------------------------------------------
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1)      { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else             { r1 = c; b1 = x; }
  const m = l - c / 2;
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

// ---------------------------------------------------------------------------
// Pick a value in [lo, hi] from a 0..1 uniform.
// ---------------------------------------------------------------------------
function mix(t: number, lo: number, hi: number): number {
  return lo + t * (hi - lo);
}

// ---------------------------------------------------------------------------
// Generate a palette deterministically from the seed.
//
// Seed 1 returns the legacy palette for backward compatibility with goldens.
// All other seeds produce a diverse spread of hue families, value
// relationships, warmth and ground tones.
// ---------------------------------------------------------------------------
function seedPalette(seed: number): {
  ink: string; paper: string; accent: string; ground: string;
} {
  // Seed 1: the original hardcoded palette (golden compatibility).
  if (seed === 1) {
    return {
      ink: '#111111',
      paper: '#f2eee0',
      accent: '#c02418',
      ground: '#e8e4d8',
    };
  }

  const rand = xorshift32(seed);

  // --- Ground ---
  // Hue spans the full wheel. Saturation low-to-moderate, lightness high.
  const groundHue = rand() * 360;
  const groundSat = mix(rand(), 0.03, 0.25);
  const groundLit = mix(rand(), 0.78, 0.92);
  const ground = hslToHex(groundHue, groundSat, groundLit);

  // --- Paper ---
  // Close to ground hue but slightly lighter / less saturated.
  const paperHue = (groundHue + mix(rand(), -15, 15) + 360) % 360;
  const paperSat = mix(rand(), 0.02, 0.18);
  const paperLit = mix(rand(), Math.max(groundLit, 0.85), 0.96);
  const paper = hslToHex(paperHue, paperSat, paperLit);

  // --- Ink ---
  // Dark, can be warm or cool. Lightness 3-20% for strong contrast with paper.
  const inkHue = rand() * 360;
  const inkSat = mix(rand(), 0.0, 0.35);
  const inkLit = mix(rand(), 0.03, 0.20);
  const ink = hslToHex(inkHue, inkSat, inkLit);

  // --- Accent ---
  // Must contrast with both ground/paper (different hue) and ink (brighter).
  // Choose a hue at least 30 degrees from ground hue.
  const accentOffset = mix(rand(), 30, 330);
  const accentHue = (groundHue + accentOffset) % 360;
  const accentSat = mix(rand(), 0.45, 1.0);
  const accentLit = mix(rand(), 0.30, 0.58);
  const accent = hslToHex(accentHue, accentSat, accentLit);

  return { ink, paper, accent, ground };
}

export function seedProgram(seed: number, profile = 'default-v1', assetPack = 'core-v1'): Program {
  const { ink, paper, accent, ground } = seedPalette(seed);
  return {
    version: '0.2',
    profile,
    assetPack,
    canvas: {
      width: SEED_CANVAS.width,
      height: SEED_CANVAS.height,
      ground,
      brushScale: 1.5,
    },
    seed,
    palette: { ink, paper, accent },
    root: {
      id: 'root',
      type: 'group',
      children: [
        {
          id: 'sheet',
          type: 'group',
          children: [],
        },
      ],
    },
  };
}
