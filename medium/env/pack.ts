// Asset packs: the fixed vocabulary of shapes a program may refer to by name.
//
// A pack is content-hashed. The hash is checked at validation and recorded in the trace, so a render
// cannot be silently reproduced against different artwork.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './browser.js';
import { contentHash } from './profile.js';

export interface Fragment {
  /** Closed outline in a unit box, roughly -0.5..0.5, y down. */
  points: [number, number][];
  label?: string;
}

export type MotifPart =
  | { type: 'stroke'; name?: string; points: [number, number][]; brush?: string; color?: string; weight?: number; closed?: boolean; curve?: number }
  | { type: 'paint'; name?: string; region: Record<string, unknown>; style: Record<string, unknown> };

export interface Motif {
  parts: MotifPart[];
  label?: string;
}

export interface AssetPack {
  id: string;
  hash: string;
  fragments: Record<string, Fragment>;
  motifs: Record<string, Motif>;
}

export class PackError extends Error {}

/**
 * Load a pack and verify its declared hash against its contents. The hash is taken over everything
 * except the `hash` field itself.
 */
export function loadPack(idOrPath: string): AssetPack {
  const file = idOrPath.endsWith('.json') ? idOrPath : path.join(ROOT, 'assets', 'packs', idOrPath, 'pack.json');
  const pack = JSON.parse(readFileSync(file, 'utf8')) as AssetPack;
  const declared = pack.hash;
  const actual = packHash(pack);
  if (declared !== actual) {
    throw new PackError(`asset pack "${pack.id}" declares hash ${declared} but its contents hash to ${actual}`);
  }
  return pack;
}

export function packHash(pack: AssetPack): string {
  const { hash: _ignored, ...rest } = pack;
  return contentHash(rest);
}
