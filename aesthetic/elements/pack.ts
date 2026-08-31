// Loading elements off disk, and the shape check that stands in for validating them.
//
// Elements are hand-picked by id. There is no retrieval, no ranking and no corpus: an element is
// something a person chose to bring into a work because they know what it is, and a nearest-neighbour
// lookup over a pile of references would be a different research question wearing this one's clothes.

import { readFileSync, readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Constraint } from '../types.js';
import type { LineageElement } from './types.js';
import { contentHash } from './hash.js';

/**
 * The medium root, found by walking up to the package.json rather than by importing ROOT from
 * env/browser.ts, which would pull Playwright into this directory. aesthetic/check.ts does the same
 * thing for the same reason and explains it there.
 */
const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('cannot locate the medium root (package.json not found above this file)');
})();

export const PACK_DIR = path.join(ROOT, 'aesthetic', 'elements', 'pack');

/**
 * Elements derived from corpus works, kept in their own directory.
 *
 * Two directories rather than one, because the two are not the same kind of claim. A pack element is
 * a person's reading of a tradition with a citation somebody can check. A derived element is one
 * model's reading of one picture, and there are fifty of them — poured into the same folder they
 * would outnumber the authored ones twelve to one, and every count in `elements-live.test.ts` would
 * quietly start measuring the corpus instead of the pack.
 *
 * They compose identically. `loadElement` looks in both, so `--elements cma-102578` works exactly as
 * `--elements ma-interval` does; only the enumeration is kept separate.
 */
export const DERIVED_DIR = path.join(ROOT, 'aesthetic', 'elements', 'derived');

const CONSTRAINT_KEYS = new Set(['id', 'kind', 'params', 'scope', 'severity', 'why', 'blocked_by']);

function checkConstraintShape(where: string, value: unknown): asserts value is Constraint {
  const c = value as Record<string, unknown>;
  if (typeof c?.['id'] !== 'string' || c['id'].length === 0) throw new Error(`${where}: constraint needs an id`);
  if (typeof c['kind'] !== 'string') throw new Error(`${where}/${String(c['id'])}: constraint needs a kind`);
  if (typeof c['params'] !== 'object' || c['params'] === null) throw new Error(`${where}/${String(c['id'])}: needs params`);
  if (c['scope'] !== 'tree' && c['scope'] !== 'render' && c['scope'] !== 'judge') {
    throw new Error(`${where}/${String(c['id'])}: scope must be tree, render or judge`);
  }
  if (c['severity'] !== 'hard' && c['severity'] !== 'soft') {
    throw new Error(`${where}/${String(c['id'])}: severity must be hard or soft`);
  }
  if (typeof c['why'] !== 'string' || c['why'].length === 0) throw new Error(`${where}/${String(c['id'])}: needs a why`);
  for (const k of Object.keys(c)) {
    if (!CONSTRAINT_KEYS.has(k)) throw new Error(`${where}/${String(c['id'])}: unexpected key "${k}"`);
  }
}

/**
 * Shape only. The citation is checked for being a non-empty string and for nothing else — no
 * resolver, no ISBN, no lookup — and calling that "validated" would be the whole problem. NEEDS.md.
 */
export function checkElementShape(value: unknown, expectedId?: string): LineageElement {
  const e = value as Record<string, unknown>;
  const id = e?.['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`element id must be a slug, got ${String(id)}`);
  if (expectedId !== undefined && id !== expectedId) throw new Error(`element ${id} is filed as ${expectedId}.json`);
  if (typeof e['name'] !== 'string' || e['name'].length === 0) throw new Error(`${id}: needs a name`);

  const p = e['provenance'] as Record<string, unknown> | undefined;
  for (const key of ['culture', 'period', 'note', 'citation']) {
    if (typeof p?.[key] !== 'string' || (p[key] as string).trim().length === 0) {
      throw new Error(`${id}: provenance.${key} must be a non-empty string`);
    }
  }
  if (typeof e['worldviewFragment'] !== 'string' || e['worldviewFragment'].trim().length === 0) {
    throw new Error(`${id}: needs a worldviewFragment`);
  }
  for (const part of ['generativeRules', 'prohibitions'] as const) {
    const arr = e[part];
    if (!Array.isArray(arr)) throw new Error(`${id}: ${part} must be an array`);
    for (const c of arr) checkConstraintShape(`${id}/${part}`, c);
  }
  // Optional, because the four authored elements predate it and giving them one would move
  // `elementPackHash` and retire runs that have nothing wrong with them. Checked when present.
  if (e['commitments'] !== undefined) {
    if (!Array.isArray(e['commitments'])) throw new Error(`${id}: commitments must be an array`);
    for (const c of e['commitments']) checkConstraintShape(`${id}/commitments`, c);
  }
  if (e['tensions'] !== undefined) {
    if (!Array.isArray(e['tensions'])) throw new Error(`${id}: tensions must be an array`);
    for (const t of e['tensions'] as Record<string, unknown>[]) {
      for (const key of ['between', 'and', 'claim']) {
        if (typeof t?.[key] !== 'string' || (t[key] as string).trim().length === 0) {
          throw new Error(`${id}: every tension needs a non-empty ${key}`);
        }
      }
    }
  }
  const carried =
    (e['generativeRules'] as unknown[]).length +
    (e['prohibitions'] as unknown[]).length +
    ((e['commitments'] as unknown[] | undefined)?.length ?? 0);
  if (carried === 0) throw new Error(`${id}: an element that carries no constraint is a note, not an element`);
  if (!Array.isArray(e['cliches']) || (e['cliches'] as unknown[]).some((c) => typeof c !== 'string')) {
    throw new Error(`${id}: cliches must be strings`);
  }
  return e as unknown as LineageElement;
}

function idsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'conflicts.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** The hand-authored pack, sorted. Read off the directory so a new file cannot go unnoticed. */
export function elementIds(): string[] {
  return idsIn(PACK_DIR);
}

/** The elements derived from corpus works. Empty before `corpus derive` has been run. */
export function derivedIds(): string[] {
  return idsIn(DERIVED_DIR);
}

export function loadElement(id: string): LineageElement {
  // The authored pack wins a name collision. A derived element is named after its object id, which
  // no authored element can be, so the two namespaces cannot actually meet — but if they ever did,
  // the file a person wrote is the one that should answer.
  for (const dir of [PACK_DIR, DERIVED_DIR]) {
    const file = path.join(dir, `${id}.json`);
    if (existsSync(file)) return checkElementShape(JSON.parse(readFileSync(file, 'utf8')), id);
  }
  throw new Error(`no element "${id}" in the pack or the derived set`);
}

export function loadElements(ids: string[]): LineageElement[] {
  return ids.map(loadElement);
}

/**
 * The identity of a set of elements: content hash over them sorted by id.
 *
 * Over the elements *in hand*, not over the directory, because `compose` is pure and total and may
 * not read a disk to answer a question about its arguments. When a composition uses the whole pack
 * the two coincide, which is the normal case.
 */
export function elementPackHash(elements: LineageElement[]): string {
  return contentHash([...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}
