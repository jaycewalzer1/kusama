// canonicalJson/contentHash, repeated here rather than imported.
//
// The originals live in env/profile.ts, which imports ROOT from env/browser.ts and would drag
// Playwright into this directory behind a two-line helper. aesthetic/check.ts already repeats the
// ROOT lookup for the same reason and says so; this is the same trade for the same reason.
//
// Byte-identical behaviour to env/profile.ts is a property tests/elements.test.ts asserts, so the
// two cannot drift into producing different hashes for the same value.

import { createHash } from 'node:crypto';

/** Keys sorted, `undefined` values dropped, so two equal values have one serialization. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
