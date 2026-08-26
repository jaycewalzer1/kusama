// Shared fixtures for the tests. Kept deliberately small: a bare asset pack and a program builder,
// so a test can say what it is about in a few lines.

import type { ResolvedProgram } from '../renderer/resolve.js';
import { resolveProgram } from '../renderer/resolve.js';
import type { AssetPack } from '../env/pack.js';
import type { MediumProfile } from '../env/profile.js';
import { contentHash, loadProfile } from '../env/profile.js';

const PACK_BODY = {
  id: 'test-pack',
  fragments: {
    blob: {
      points: [
        [-0.4, -0.3],
        [0.1, -0.45],
        [0.45, -0.05],
        [0.3, 0.4],
        [-0.2, 0.45],
        [-0.45, 0.1],
      ] as [number, number][],
    },
  },
  motifs: {
    tick: {
      parts: [
        {
          type: 'stroke' as const,
          name: 'arm',
          points: [
            [-0.4, 0],
            [0, 0.4],
            [0.45, -0.45],
          ] as [number, number][],
          brush: 'HB',
          color: 'ink',
          weight: 1,
        },
      ],
    },
  },
};

/** One fragment and one motif, so the asset-referencing paths are exercised without a real pack. */
export const EMPTY_PACK: AssetPack = { ...PACK_BODY, hash: contentHash(PACK_BODY) };

/** The shipped profile, retargeted at the test pack. Everything else about it is the real thing. */
export function testProfile(): MediumProfile {
  const { profile } = loadProfile('default-v0');
  return { ...profile, id: 'test', assetPacks: ['test-pack'] };
}

export const TEAL = '#5e8c8a';
export const INK = '#4a3c31';
export const RUST = '#991f25';
export const GROUND = '#fdf9f0';

export function program(children: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.2',
    profile: 'test',
    assetPack: 'test-pack',
    canvas: { width: 400, height: 400, ground: GROUND, brushScale: 3 },
    seed: 12345,
    palette: { ink: INK, teal: TEAL, rust: RUST },
    root: { id: 'root', type: 'group', children },
    ...over,
  };
}

export function washNode(id: string, cx: number, cy: number, color = 'teal'): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'wash',
    rngKey: `key-${id}`,
    args: {
      region: { type: 'circle', cx, cy, r: 70 },
      style: { kind: 'wash', color, opacity: 140, bleed: 0.12, texture: [0.4, 0.2] },
    },
  };
}

/** A leaf that sets as much brush state as one operator can: crosshatch, jittered, two layers. */
export function hatchNode(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'paint',
    rngKey: `key-${id}`,
    args: {
      region: { type: 'rect', x, y, w: 110, h: 110 },
      style: { kind: 'hatch', brush: '2B', color: 'rust', spacing: 6, angle: 35, rand: 0.15, layers: 2 },
    },
  };
}

export function strokeNode(id: string, points: [number, number][]): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'stroke',
    rngKey: `key-${id}`,
    args: { points, brush: 'charcoal', color: 'ink', weight: 3, curve: 0.4, closed: false },
  };
}

/** Painted with plain p5, so leaked brush stroke or hatch state would show up on its edges. */
export function solidNode(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'paint',
    rngKey: `key-${id}`,
    args: {
      region: { type: 'rect', x, y, w: 120, h: 120 },
      style: { kind: 'solid', color: 'ink', opacity: 200 },
    },
  };
}

export function group(id: string, children: unknown[], transform?: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'group', transform, children };
}

/** Pixels that differ between two renders, ignoring the given boxes. */
export function differingOutside(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  boxes: { x: number; y: number; w: number; h: number }[]
): number {
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (boxes.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) continue;
      const i = 4 * (y * width + x);
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
  }
  return n;
}

export function resolve(prog: Record<string, unknown>): ResolvedProgram {
  return resolveProgram(prog, EMPTY_PACK);
}

const GROUND_RGB = [0xfd, 0xf9, 0xf0];

/** Pixels that are not the ground colour, optionally restricted to (or excluded from) a box. */
export function marked(
  rgba: Buffer,
  width: number,
  height: number,
  box?: { x: number; y: number; w: number; h: number },
  outside = false
): number {
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (box) {
        const inside = x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
        if (inside === outside) continue;
      }
      const i = 4 * (y * width + x);
      if (rgba[i] !== GROUND_RGB[0] || rgba[i + 1] !== GROUND_RGB[1] || rgba[i + 2] !== GROUND_RGB[2]) n++;
    }
  }
  return n;
}
