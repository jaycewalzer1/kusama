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

export function seedProgram(seed: number, profile = 'default-v1', assetPack = 'core-v1'): Program {
  return {
    version: '0.2',
    profile,
    assetPack,
    canvas: {
      width: SEED_CANVAS.width,
      height: SEED_CANVAS.height,
      ground: '#e8e4d8',
      brushScale: 1.5,
    },
    seed,
    palette: {
      ink: '#111111',
      paper: '#f2eee0',
      accent: '#c02418',
    },
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
