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

/**
 * One typeface the pack carries. `sha256` is over the file's bytes, so the pack hash covers the type
 * as well as the shapes, and a face whose bytes changed on disk cannot render under the old hash.
 */
export interface Face {
  family: string;
  role: string;
  /** Path relative to ROOT, so the hermetic route can serve it without inventing a location. */
  file: string;
  bytes: number;
  sha256: string;
  license: string;
  licenseFile?: string;
  source: string;
  variable?: boolean;
}

export interface License {
  spdx: string;
  file: string;
  sha256: string;
  source: string;
}

export interface AssetPack {
  id: string;
  hash: string;
  fragments: Record<string, Fragment>;
  motifs: Record<string, Motif>;
  /** Absent in core@003e484d9602, which had two hard-coded faces in the renderer instead. */
  faces?: Record<string, Face>;
  licenses?: Record<string, License>;
}

export class PackError extends Error {}

/**
 * Load a pack and verify its declared hash against its contents. The hash is taken over everything
 * except the `hash` field itself.
 */
export function loadPack(idOrPath: string): AssetPack {
  const file = idOrPath.endsWith('.json') ? idOrPath : path.join(ROOT, 'renderer', 'assets', 'packs', idOrPath, 'pack.json');
  const pack = JSON.parse(readFileSync(file, 'utf8')) as AssetPack;
  const declared = pack.hash;
  const actual = packHash(pack);
  if (declared !== actual) {
    throw new PackError(`asset pack "${pack.id}" declares hash ${declared} but its contents hash to ${actual}`);
  }
  return pack;
}

/**
 * The pack a program names, or the override. Same rule as the profile: there is no default pack,
 * because a fragment name means nothing until you know which pack it was looked up in.
 */
export function loadPackFor(program: unknown, override?: string): AssetPack {
  if (override) return loadPack(override);
  const named = (program as { assetPack?: unknown } | null)?.assetPack;
  if (typeof named !== 'string' || named.length === 0) {
    throw new PackError('this program names no asset pack: add an "assetPack" key naming one of assets/packs/*');
  }
  return loadPack(named);
}

export function packHash(pack: AssetPack): string {
  const { hash: _ignored, ...rest } = pack;
  return contentHash(rest);
}
