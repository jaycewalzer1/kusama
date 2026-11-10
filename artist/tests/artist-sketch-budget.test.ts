// The sketch text budget, and what is allowed to put a floor under it.
//
// `assertTextBudget` throws, and it throws between FIND and SKETCH — after the run has paid for a
// FIND call and before it has written a single sketch. Nothing exercised it over the positions
// actually on disk, so `many-hands` shipped carrying a `requireNode text min 30` and every run of
// that position died there: three of them on one afternoon, with the reason nowhere but the studio
// server's stderr buffer. Both halves of that are covered here — the derivation, and the catalogue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { ROOT } from '../../env/browser.js';
import { loadProfile } from '../../env/profile.js';
import type { AestheticProgram, Constraint } from '../../aesthetic/types.js';
import { loadCommission } from '../field.js';
import { assertTextBudget, textDemand, SKETCH_PROFILE } from '../phases/sketch.js';

const ids = (dir: string) =>
  readdirSync(path.join(ROOT, 'aesthetic', dir))
    .filter((f) => f.endsWith('.json') && !f.endsWith('.field.json'))
    .map((f) => f.replace(/\.json$/, ''));

const program = (constraints: Constraint[]): AestheticProgram =>
  ({ id: 'under-test', commitments: constraints, prohibitions: [] }) as unknown as AestheticProgram;

const c = (over: Partial<Constraint>): Constraint =>
  ({ id: 'x', kind: 'requireNode', params: { op: 'text', min: 30 }, scope: 'tree', severity: 'hard', why: 'under test', ...over }) as Constraint;

/**
 * The one that would have caught it. Every cell the studio can launch, against the budget the
 * sketch profile really has — not a hand-written fixture, which is what let the catalogue drift
 * away from the assertion without anything going red.
 */
test('every position x brief on disk clears the sketch text budget', () => {
  const { profile } = loadProfile(SKETCH_PROFILE);
  const positions = ids('positions');
  const briefs = ids('briefs');
  assert.ok(positions.length >= 3 && briefs.length >= 3, 'expected a catalogue to check');
  for (const position of positions) {
    for (const brief of briefs) {
      assert.doesNotThrow(
        () => assertTextBudget(loadCommission(position, brief).effective, profile.limits),
        `${position} x ${brief} cannot be sketched under ${SKETCH_PROFILE}`
      );
    }
  }
});

test('a hard, unblocked text demand still sets the floor', () => {
  assert.equal(textDemand(program([c({})])), 30);
  assert.throws(() => assertTextBudget(program([c({})]), { maxTextOps: 12 }), /demands 30/);
});

test('a soft or blocked constraint is not a demand', () => {
  // Soft is scored, not required; blocked is not checked at all. Neither can stop a run.
  assert.equal(textDemand(program([c({ severity: 'soft' })])), 1);
  assert.equal(textDemand(program([c({ blocked_by: 'the medium places glyphs a line at a time' })])), 1);
  assert.equal(textDemand(program([c({ kind: 'textRequired', params: { contains: ['a', 'b'] }, severity: 'soft' })])), 1);
});
