// `default-v2`: v1 with a finer angular grid and a wider instance budget.
//
// The artist kept hitting two walls under v1. The first was the quantize grid: `rotate`, `angle`,
// `startAngle` and `skew` all stepped by a whole degree, so a 0.6-degree delta was not expressible
// at all -- it snapped to 0 or to 1 and the difference the artist meant disappeared. v2 steps those
// four by 0.1. The second was `maxRepeatInstances: 400`. v2 raises it to 1200, and raises
// `maxResolvedNodes` to 3600 so a 1200-instance repeat can actually resolve rather than dying one
// limit later, with `maxEstimatedMarks` and `maxRenderCost` tripled alongside so the wider instance
// budget is reachable instead of being immediately traded for a budget refusal.
//
// Everything else -- primitives, macros, layouts, fonts, brushes, packs, ranges, the print list --
// is v1's, unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile } from '../profile.js';
import { validateProfile } from '../validate.js';

const v1 = loadProfile('default-v1');
const v2 = loadProfile('default-v2');

test('the v1 profile still hashes to the value the goldens were rendered against', () => {
  // Hard-coded on purpose, and the most important assertion in this file. Eleven committed goldens
  // are rendered against this profile; if anyone reformats, reorders or edits v1 -- including by
  // "tidying" it while adding a v3 -- those goldens stop describing anything, and this is the
  // loudest and cheapest way to find out. v2 is a NEW FILE beside v1, never an edit to it.
  assert.equal(v1.hash.slice(0, 12), 'be50e7c6f0a6');
});

test('default-v2 loads, is a valid profile, and says it is v2', () => {
  assert.equal(v2.profile.id, 'default-v2');
  assert.deepEqual(validateProfile(v2.profile), []);
});

test('v2 quantizes the four angular fields at 0.1 degrees', () => {
  // The whole point of the profile: a sub-degree delta is expressible.
  assert.equal(v2.profile.quantize['rotate'], 0.1);
  assert.equal(v2.profile.quantize['angle'], 0.1);
  assert.equal(v2.profile.quantize['startAngle'], 0.1);
  assert.equal(v2.profile.quantize['skew'], 0.1);
});

test('v2 widens the instance budget, and widens what it takes to resolve one', () => {
  assert.equal(v2.profile.limits.maxRepeatInstances, 1200);
  // A 1200-instance repeat has to fit under the resolved-node ceiling or the wider instance limit
  // buys nothing: the refusal just moves one limit down.
  assert.ok(
    v2.profile.limits.maxResolvedNodes >= v2.profile.limits.maxRepeatInstances,
    'maxResolvedNodes must leave room for a full-width repeat',
  );
  assert.equal(v2.profile.limits.maxResolvedNodes, 3600);
  assert.equal(v2.profile.limits.maxEstimatedMarks, 180000);
  assert.equal(v2.profile.limits.maxRenderCost, 720000);
});

test('v2 differs from v1 in exactly the nine intended values and nothing else', () => {
  // A profile is hashed whole, so an accidental extra edit is invisible until a trace disagrees.
  // This walks both objects and names every difference, so a stray change fails by description.
  const changed = new Set([
    'id',
    'limits.maxResolvedNodes',
    'limits.maxRepeatInstances',
    'limits.maxEstimatedMarks',
    'limits.maxRenderCost',
    'quantize.rotate',
    'quantize.angle',
    'quantize.startAngle',
    'quantize.skew',
  ]);
  const diffs: string[] = [];
  const walk = (a: unknown, b: unknown, at: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k);
      }
      return;
    }
    diffs.push(at);
  };
  walk(v1.profile, v2.profile, '');
  assert.deepEqual(diffs.sort(), [...changed].sort());
});
