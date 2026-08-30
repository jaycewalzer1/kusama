// Does the shipped element pack fit a position somebody can actually be commissioned on?
//
// `elements.test.ts` composes against `tests/fixtures/positions/cut-and-reset.json`, a position that
// was deleted from the catalogue in the same session the finish gate was added. Those tests are
// still worth having — they pin `compose`, `deriveConflicts` and the hash — but every number in them
// is a property of a document no run can name, so between them they proved a mechanism and said
// nothing about whether the mechanism has anything to work on. NEEDS.md recorded that as the
// blocking gap for stage 2, with the instruction that if the pack turned out to fit nothing, that
// was the finding and not a reason to keep the fixture.
//
// This file is the measurement, taken against the live catalogue. It is deliberately written as
// assertions about what is on disk rather than as a range, because the interesting result is not
// "some conflicts exist" but exactly which pairings are runnable, and that number is small.
//
// WHAT IT FOUND, and the numbers below are its evidence:
//
//   The pack fits. All twelve pairings compose without throwing, so the layer is not a mechanism
//   built on a document nobody can commission.
//
//   The clean-compose case survived the catalogue rebuild, eight times over. NEEDS.md feared it
//   might have "no replacement" — `chromolith-broadside` and `rodchenko-red-black` compose to zero
//   conflicts against all three positions, and `kuba-shoowa-surface` against two of them.
//
//   But almost every conflicting pairing is unsatisfiable rather than interesting. `ma-interval`
//   wants coverage at or below 0.18 and both `withheld` and `interference` require 0.25 or 0.3, so
//   `contradictions()` proves no program satisfies either pair and `runTrajectory` refuses before
//   the first policy call. `kuba-shoowa-surface` requires a `field` mark that `many-hands` forbids
//   outright. Those refusals are correct — a run against an impossible commission measures the
//   commission — but they are not the layer doing its job.
//
//   Exactly one live pairing has conflicts AND is satisfiable: `many-hands` + `ma-interval`. One
//   cell out of twelve is where a run can be asked to resolve a lineage conflict rather than be
//   turned away from one. That is the honest size of stage 1 against this catalogue, and the test
//   below pins it so that a future element or position that widens it is visible as a change.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommission } from '../../artist/field.js';
import { elementIds } from '../elements/pack.js';
import { envVersionNow } from '../../artist/env-version.js';

const POSITIONS = ['interference', 'many-hands', 'withheld'];
const BRIEF = 'fifty-year-embargo';
const DELIVERABLE = 'panel';

/** Every position x element pairing, composed. Loading is the test: `compose` may not refuse. */
function grid() {
  return POSITIONS.flatMap((position) =>
    elementIds().map((element) => {
      const c = loadCommission(position, BRIEF, DELIVERABLE, [element]);
      return {
        position,
        element,
        conflicts: c.composition!.conflicts.length,
        unsatisfiable: c.unsatisfiable.length,
      };
    })
  );
}

test('live catalogue: every position composes with every element without refusing', () => {
  // `compose` is total by design — an id collision namespaces rather than throws — and this is the
  // assertion that the design survived contact with positions it was not written against.
  const rows = grid();
  assert.equal(rows.length, POSITIONS.length * elementIds().length);
  assert.equal(rows.length, 12, 'three positions and four elements are on disk');
});

test('live catalogue: the clean-compose case has replacements, and there are eight', () => {
  // The property `elements.test.ts` could only assert against the deleted position. An element that
  // conflicts with everything is not a vocabulary, it is a veto.
  const rows = grid();
  assert.equal(rows.filter((r) => r.conflicts === 0).length, 8);
  // Two of the four compose cleanly against every position on disk, which is the direct replacement
  // for the one hand-picked clean case the frozen fixture had.
  const cleanEverywhere = elementIds().filter((e) => rows.every((r) => r.element !== e || r.conflicts === 0));
  assert.deepEqual(cleanEverywhere.sort(), ['chromolith-broadside', 'rodchenko-red-black']);
});

test('live catalogue: exactly one pairing is both conflicting and runnable', () => {
  // The cell the layer exists for. A conflict the artist can be asked to resolve has to be a
  // conflict a program could satisfy either way; an unsatisfiable one is refused before the run.
  const usable = grid().filter((r) => r.conflicts > 0 && r.unsatisfiable === 0);
  assert.deepEqual(
    usable.map((r) => `${r.position}+${r.element}`),
    ['many-hands+ma-interval'],
    'if this list grew, an element or a position changed and the layer got wider'
  );
  assert.equal(usable[0]!.conflicts, 2);
});

test('live catalogue: the unsatisfiable pairings are refused with a proof, not a shrug', () => {
  // Three pairings cannot be run. Each has to say which two constraints collided and why, because
  // "unsatisfiable" with no proof is indistinguishable from a bug in the checker.
  const blocked = grid().filter((r) => r.unsatisfiable > 0);
  assert.deepEqual(
    blocked.map((r) => `${r.position}+${r.element}`).sort(),
    ['interference+ma-interval', 'many-hands+kuba-shoowa-surface', 'withheld+ma-interval']
  );
  const withheld = loadCommission('withheld', BRIEF, DELIVERABLE, ['ma-interval']).unsatisfiable;
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0]!.a, 'position:withheld+fifty-year-embargo/r-heavy');
  assert.equal(withheld[0]!.b, 'element:ma-interval/e-not-filled');
  assert.match(withheld[0]!.why, /inkDensityRange \[0\.3, inf\] and \[-inf, 0\.18\] do not meet/);
});

test('live catalogue: the whole pack at once is unsatisfiable against all three positions', () => {
  // Worth pinning because it is the obvious thing to try first and it never works. The elements were
  // picked to be selective; four selective vocabularies at once leave nothing.
  for (const position of POSITIONS) {
    const c = loadCommission(position, BRIEF, DELIVERABLE, elementIds());
    assert.ok(c.unsatisfiable.length > 0, `${position} + the whole pack should not be runnable`);
  }
});

test('adopting no element leaves the commission byte-identical to before elements existed', () => {
  // The reason the feature could be added without moving a single golden or fixture. `compose`
  // namespaces every id, which is right with two sources and noise with one, so the empty case is
  // not composed at all.
  const bare = loadCommission('withheld', BRIEF, DELIVERABLE);
  assert.equal(bare.composition, null);
  assert.deepEqual(bare.elementIds, []);
  assert.equal(bare.effective.id, 'withheld+fifty-year-embargo');
  assert.ok(
    bare.effective.commitments.some((c) => c.id === 'c-covered'),
    'an uncomposed report still says c-covered, not position:withheld/c-covered'
  );
});

test('elementPackHash is a tenth field and it moves when the element set does', () => {
  // The version bug this had to close: two runs under different lineages comparing as the same
  // experiment, exactly as two runs under different affect rules did before `dynamicsHash`.
  const bare = envVersionNow('withheld', BRIEF, DELIVERABLE, 1);
  const withOne = envVersionNow('withheld', BRIEF, DELIVERABLE, 1, ['rodchenko-red-black']);
  assert.equal(Object.keys(bare).length, 10);
  assert.notEqual(bare.elementPackHash, withOne.elementPackHash);
  // And it is its own field rather than folded into the asset pack's, because a run that changed
  // which brushes exist is a different fact from a run that changed which traditions it drew on.
  assert.equal(bare.packHash, withOne.packHash);
  // Order-independent: the identity is of the set, not of the argument list.
  assert.equal(
    envVersionNow('withheld', BRIEF, DELIVERABLE, 1, ['ma-interval', 'rodchenko-red-black']).elementPackHash,
    envVersionNow('withheld', BRIEF, DELIVERABLE, 1, ['rodchenko-red-black', 'ma-interval']).elementPackHash
  );
});

test('the empty pack hashes to a real value, so an ordinary run carries the field too', () => {
  // A null here would make "this run adopted nothing" and "this log predates elements" the same
  // reading, and `envDrift` skips absent fields — so every pre-element run would silently compare
  // as equal to every element run.
  const bare = envVersionNow('withheld', BRIEF, DELIVERABLE, 1);
  assert.match(bare.elementPackHash, /^[0-9a-f]{8,}$/);
});

test('a composed position carries the elements the artist adopted, not just their constraints', () => {
  // A lineage the artist is checked against but never shown is a parameter bundle wearing the word
  // lineage. The stance and the cliches go in with the rules.
  const c = loadCommission('many-hands', BRIEF, DELIVERABLE, ['ma-interval']);
  const bare = loadCommission('many-hands', BRIEF, DELIVERABLE);
  assert.ok(c.effective.worldview.length > bare.effective.worldview.length, 'the stance was not carried');
  assert.ok(c.effective.cliches.length > bare.effective.cliches.length, 'the cliches were not carried');
  assert.equal(c.effective.id, 'many-hands+fifty-year-embargo+ma-interval');
  // Element prohibitions stay prohibitions. Pouring the flat list into `commitments` would relabel
  // every one of them and the report would stop saying which part a violation came from.
  assert.ok(c.effective.prohibitions.some((p) => p.id.startsWith('element:ma-interval/')));
});
