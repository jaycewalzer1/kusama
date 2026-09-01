// The corpus's image embeddings, loaded once and joined to the manifest.
//
// `corpus/clip.f32` is 19,807 rows x 512 float32 in sorted sha256 order, with
// `corpus/clip-index.json` naming the sha256 of each row. Both are gitignored derived data
// (40.6MB); `corpus/README.md` says how to rebuild them.
//
// ## The dedupe is not optional and it is not cosmetic
//
// 98 manifest rows share bytes with another row — a knife and its fork, photographed once and
// catalogued twice. That has now produced a wrong number twice: a CLIP pair scoring >0.98 that was
// a photograph against itself, and `resemblance`'s corpus maximum reading 1.0000. So the dedupe
// lives HERE, in the loader, rather than in each caller. There is exactly one row per distinct
// image, and the work chosen to name it is the lowest id among the works sharing those bytes, so
// the choice is deterministic rather than manifest-order-dependent. The works that lost the tie are
// kept on `aliases`, because "this image is catalogued twice" is itself a finding and dropping it
// silently would be the same mistake in the other direction.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { readManifest, type Work } from './manifest.js';

export const CLIP_MATRIX = path.join(ROOT, 'corpus', 'clip.f32');
export const CLIP_INDEX = path.join(ROOT, 'corpus', 'clip-index.json');
export const MANIFEST = path.join(ROOT, 'corpus', 'manifest.jsonl');
export const DIM = 512;

export interface CorpusEntry {
  work: Work;
  sha256: string;
  /** Row in `rows`, which is NOT the row in the file — zero rows and unjoined rows are gone. */
  row: number;
  /** Other manifest ids sharing these exact bytes. Empty for all but ~98 entries. */
  aliases: string[];
}

export interface CorpusEmbeddings {
  entries: CorpusEntry[];
  /** `entries.length` x 512, unit-normalised, row-major. */
  rows: Float32Array;
  /** How many rows the file held, before the join and the dedupe. */
  rowsInFile: number;
  /** Manifest rows dropped because they share bytes with a kept row. */
  duplicates: number;
  /** Manifest rows dropped because the encoder recorded a failure (all-zero row). */
  zeroRows: number;
}

export function embeddingsAvailable(): boolean {
  return existsSync(CLIP_MATRIX) && existsSync(CLIP_INDEX) && existsSync(MANIFEST);
}

export function embeddingsUnavailableMessage(): string {
  return (
    `No corpus embeddings at ${path.relative(ROOT, CLIP_MATRIX)}. They are derived data and ` +
    `gitignored; see corpus/README.md for the rebuild (local CLIP, no API key, ~12 min).`
  );
}

let cached: CorpusEmbeddings | null = null;

export function loadCorpusEmbeddings(): CorpusEmbeddings {
  if (cached) return cached;
  if (!embeddingsAvailable()) throw new Error(embeddingsUnavailableMessage());

  const index: string[] = JSON.parse(readFileSync(CLIP_INDEX, 'utf8'));
  const buf = readFileSync(CLIP_MATRIX);
  const rowsInFile = Math.floor(buf.length / (DIM * 4));
  if (rowsInFile !== index.length) {
    throw new Error(`${CLIP_MATRIX} holds ${rowsInFile} rows but the index names ${index.length}`);
  }
  const at = new Map(index.map((sha, i) => [sha, i]));

  const works = readManifest(MANIFEST).works;
  // Lowest id wins the tie, so which work names an image does not depend on manifest order.
  const bySha = new Map<string, Work[]>();
  for (const w of works) {
    if (!w.image) continue;
    const list = bySha.get(w.image.sha256);
    if (list) list.push(w);
    else bySha.set(w.image.sha256, [w]);
  }

  const entries: CorpusEntry[] = [];
  const kept: Float32Array[] = [];
  let duplicates = 0;
  let zeroRows = 0;

  for (const [sha, sharing] of bySha) {
    const i = at.get(sha);
    if (i === undefined) continue;
    const row = new Float32Array(DIM);
    let any = false;
    for (let j = 0; j < DIM; j++) {
      const v = buf.readFloatLE((i * DIM + j) * 4);
      row[j] = v;
      if (v !== 0) any = true;
    }
    if (!any) {
      zeroRows++;
      continue;
    }
    const ordered = [...sharing].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    duplicates += ordered.length - 1;
    entries.push({
      work: ordered[0]!,
      sha256: sha,
      row: entries.length,
      aliases: ordered.slice(1).map((w) => w.id),
    });
    kept.push(row);
  }

  const rows = new Float32Array(entries.length * DIM);
  kept.forEach((r, i) => rows.set(r, i * DIM));

  cached = { entries, rows, rowsInFile, duplicates, zeroRows };
  return cached;
}

/** Row `i` of a packed matrix, as a view. Not a copy — do not mutate it. */
export function rowAt(rows: Float32Array, i: number, dim = DIM): Float32Array {
  return rows.subarray(i * dim, (i + 1) * dim);
}

/**
 * The `k` nearest rows to `query`, by cosine. Both sides are assumed unit-length, which every
 * producer in this repo guarantees, so this is a dot product and nothing renormalises here.
 *
 * A full scan over 19,807 x 512 is about 10M multiply-adds — single-digit milliseconds. An index
 * would be a second thing to keep correct and would buy nothing at this size.
 */
export function nearest(
  rows: Float32Array,
  count: number,
  query: Float32Array,
  k: number,
  dim = DIM,
): { row: number; score: number }[] {
  const best: { row: number; score: number }[] = [];
  let worst = -Infinity;
  for (let i = 0; i < count; i++) {
    let s = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) s += rows[off + j]! * query[j]!;
    if (best.length < k) {
      best.push({ row: i, score: s });
      if (best.length === k) {
        best.sort((a, b) => b.score - a.score);
        worst = best[k - 1]!.score;
      }
    } else if (s > worst) {
      best[k - 1] = { row: i, score: s };
      let at = k - 1;
      while (at > 0 && best[at]!.score > best[at - 1]!.score) {
        const t = best[at]!;
        best[at] = best[at - 1]!;
        best[at - 1] = t;
        at--;
      }
      worst = best[k - 1]!.score;
    }
  }
  if (best.length < k) best.sort((a, b) => b.score - a.score);
  return best;
}
