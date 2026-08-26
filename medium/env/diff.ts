// Diffing two programs: what changed in the tree, and what changed on the page.
//
// The point of the whole medium is that these two answers agree. A typed edit to one node should move
// pixels only where that node is, and `spillover` is the number that says how badly it didn't: the
// share of changed pixels lying outside the union of the changed nodes' declared bounds. The build
// document's acceptance threshold is 0.05.
//
// Everything here is pure and works on canonical images only. Cosmetic post-processing must never be
// diffed, or a grain seed would look like a change to the picture.

import type { Bounds, ResolvedLeaf, ResolvedProgram } from '../renderer/resolve.js';
import { contentHash } from './profile.js';

export interface StructuralDiff {
  added: string[];
  removed: string[];
  /** Present in both, but resolves differently: moved, restyled, reseeded or re-argued. */
  changed: string[];
  unchanged: string[];
}

/**
 * Compare resolved leaves by id. Comparing the resolved form rather than the source is deliberate: a
 * change to a group's transform is a change to every leaf under it, which is exactly what the pixels
 * will show.
 */
export function structuralDiff(before: ResolvedProgram, after: ResolvedProgram): StructuralDiff {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const diff: StructuralDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const id of a.keys()) if (!b.has(id)) diff.removed.push(id);
  for (const [id, node] of b) {
    const prev = a.get(id);
    if (!prev) diff.added.push(id);
    else if (leafHash(prev) !== leafHash(node)) diff.changed.push(id);
    else diff.unchanged.push(id);
  }
  return diff;
}

/** Bounds are excluded: they are derived from the rest, so including them would only double-count. */
function leafHash(n: ResolvedLeaf): string {
  const { bounds: _derived, ...rest } = n;
  return contentHash(rest);
}

/** One box per node that is not unchanged: the union of where it was and where it now is. */
export function changedRegions(before: ResolvedProgram, after: ResolvedProgram, diff: StructuralDiff): Bounds[] {
  const a = new Map(before.nodes.map((n) => [n.id, n.bounds]));
  const b = new Map(after.nodes.map((n) => [n.id, n.bounds]));
  const boxes: Bounds[] = [];
  for (const id of [...diff.added, ...diff.removed, ...diff.changed]) {
    const box = union(a.get(id), b.get(id));
    if (box) boxes.push(box);
  }
  return boxes;
}

export function union(a?: Bounds, b?: Bounds): Bounds | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function inside(boxes: Bounds[], x: number, y: number): boolean {
  return boxes.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

export interface PixelDiff {
  differing: number;
  /** Differing pixels outside every changed-node box: the edit reaching further than it declared. */
  spilled: number;
  spillover: number;
  /** 0 unchanged, 1 changed inside a declared box, 2 changed outside every box. */
  mask: Uint8Array;
}

export function pixelDiff(a: Buffer, b: Buffer, width: number, height: number, boxes: Bounds[]): PixelDiff {
  const mask = new Uint8Array(width * height);
  let differing = 0;
  let spilled = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = 4 * p;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
      differing++;
      if (inside(boxes, x, y)) {
        mask[p] = 1;
      } else {
        mask[p] = 2;
        spilled++;
      }
    }
  }
  return { differing, spilled, spillover: differing === 0 ? 0 : spilled / differing, mask };
}

const FADE = 0.75;
const CHANGED = [0xd6, 0x1f, 0x5c];
const SPILLED = [0xf2, 0xa8, 0x1f];
const BOX = [0x2f, 0x6f, 0xd6];

/**
 * The picture after the edit, faded towards white, with changed pixels marked and the declared boxes
 * outlined. Spilled pixels are a different colour on purpose: they are the only interesting ones.
 */
export function diffImage(after: Buffer, width: number, height: number, boxes: Bounds[], mask: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    const paint = mask[p] === 1 ? CHANGED : mask[p] === 2 ? SPILLED : null;
    for (let c = 0; c < 3; c++) {
      out[i + c] = paint ? paint[c]! : Math.round(after[i + c]! + (0xff - after[i + c]!) * FADE);
    }
    out[i + 3] = 0xff;
  }
  for (const box of boxes) outlineBox(out, width, height, box);
  return out;
}

function outlineBox(rgba: Buffer, width: number, height: number, box: Bounds): void {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(width - 1, Math.round(box.x + box.w));
  const y1 = Math.min(height - 1, Math.round(box.y + box.h));
  if (x1 < x0 || y1 < y0) return;
  const put = (x: number, y: number) => {
    const i = 4 * (y * width + x);
    rgba[i] = BOX[0]!;
    rgba[i + 1] = BOX[1]!;
    rgba[i + 2] = BOX[2]!;
  };
  for (let x = x0; x <= x1; x++) {
    put(x, y0);
    put(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    put(x0, y);
    put(x1, y);
  }
}
