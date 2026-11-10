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
//   The clean-compose case survived the catalogue rebuild, seven times over. NEEDS.md feared it
//   might have "no replacement" — `kuba-shoowa-surface` and `rodchenko-red-black` compose to zero
//   conflicts against all three positions, and `chromolith-broadside` against one of them.
//
//   Two pairings are unsatisfiable rather than interesting. `ma-interval` wants ink density at or
//   below 0.18 and `same-everywhere` requires 0.3 to 0.85, so `contradictions()` proves no program
//   satisfies the pair and `runTrajectory` refuses before the first policy call. `overlooked`
//   forbids the text op outright and `chromolith-broadside` requires twelve sizes of it and a
//   printed string, which is two proofs on the same collision. Those refusals are correct — a run
//   against an impossible commission measures the commission — but they are not the layer doing
//   its job.
//
//   Three live pairings have conflicts AND are satisfiable. Three cells out of twelve are where a
//   run can be asked to resolve a lineage conflict rather than be turned away from one. That is the
//   honest size of stage 1 against this catalogue, and the tests below pin it so that a future
//   element or position that widens it is visible as a change.
//
// Every number above was re-measured on 2026-09-02, when `withheld`, `many-hands` and `interference`
// were deleted for not depicting anything and `switchback`, `overlooked` and `same-everywhere`
// replaced them. The shape of the finding held — the pack fits, most cells compose clean, a couple
// are impossible — and not one of the specific numbers did, which is the reason they are written
// down as numbers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommission } from '../../artist/field.js';
import { elementIds } from '../elements/pack.js';
import { envVersionNow } from '../../artist/env-version.js';

const POSITIONS = ['same-everywhere', 'overlooked', 'switchback'];
const BRIEF = 'fifty-year-embargo';

/** Every position x element pairing, composed. Loading is the test: `compose` may not refuse. */
function grid() {
  return POSITIONS.flatMap((position) =>
    elementIds().map((element) => {
      const c = loadCommission(position, BRIEF, [element]);
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

test('live catalogue: the clean-compose case has replacements, and there are seven', () => {
  // The property `elements.test.ts` could only assert against the deleted position. An element that
  // conflicts with everything is not a vocabulary, it is a veto.
  const rows = grid();
  assert.equal(rows.filter((r) => r.conflicts === 0).length, 7);
  // Two of the four compose cleanly against every position on disk, which is the direct replacement
  // for the one hand-picked clean case the frozen fixture had.
  const cleanEverywhere = elementIds().filter((e) => rows.every((r) => r.element !== e || r.conflicts === 0));
  assert.deepEqual(cleanEverywhere.sort(), ['kuba-shoowa-surface', 'rodchenko-red-black']);
});

test('live catalogue: three pairings are both conflicting and runnable', () => {
  // The cells the layer exists for. A conflict the artist can be asked to resolve has to be a
  // conflict a program could satisfy either way; an unsatisfiable one is refused before the run.
  //
  // This was one cell until the positions were cut back to four hard constraints each, and two
  // until they were replaced by depictive ones. Both widenings are the same effect arriving
  // somewhere measurable: a position carrying thirteen hard constraints rules out most vocabularies
  // before anybody draws anything, and one carrying four leaves the artist a decision to make.
  // Pinned, so widening it further stays deliberate.
  const usable = grid().filter((r) => r.conflicts > 0 && r.unsatisfiable === 0);
  assert.deepEqual(
    usable.map((r) => `${r.position}+${r.element}`).sort(),
    ['overlooked+ma-interval', 'same-everywhere+chromolith-broadside', 'switchback+ma-interval'],
    'if this list changed, an element or a position changed and the layer got wider or narrower'
  );
});

test('live catalogue: the unsatisfiable pairings are refused with a proof, not a shrug', () => {
  // Two pairings cannot be run. Each has to say which two constraints collided and why, because
  // "unsatisfiable" with no proof is indistinguishable from a bug in the checker.
  const blocked = grid().filter((r) => r.unsatisfiable > 0);
  assert.deepEqual(
    blocked.map((r) => `${r.position}+${r.element}`).sort(),
    ['overlooked+chromolith-broadside', 'same-everywhere+ma-interval']
  );

  // A range against a range, which is the kind of conflict that stays provable now that the
  // counting constraints have all gone soft.
  const dense = loadCommission('same-everywhere', BRIEF, ['ma-interval']).unsatisfiable;
  assert.equal(dense.length, 1);
  assert.equal(dense[0]!.a, 'position:same-everywhere+fifty-year-embargo/r-furnished');
  assert.equal(dense[0]!.b, 'element:ma-interval/e-not-filled');
  assert.match(dense[0]!.why, /inkDensityRange \[0\.3, 0\.85\] and \[-inf, 0\.18\] do not meet/);

  // And the other kind, which the old catalogue had no example of: an op forbidden outright against
  // an element that requires it, proved twice because the element asks for it in two ways.
  const mute = loadCommission('overlooked', BRIEF, ['chromolith-broadside']).unsatisfiable;
  assert.equal(mute.length, 2);
  assert.ok(mute.every((u) => u.b === 'position:overlooked+fifty-year-embargo/p-no-caption'));
  assert.match(mute.map((u) => u.why).join(' | '), /text is both required and forbidden/);
});

test('live catalogue: the whole pack at once is unsatisfiable against all three positions', () => {
  // Worth pinning because it is the obvious thing to try first and it never works. The elements were
  // picked to be selective; four selective vocabularies at once leave nothing.
  for (const position of POSITIONS) {
    const c = loadCommission(position, BRIEF, elementIds());
    assert.ok(c.unsatisfiable.length > 0, `${position} + the whole pack should not be runnable`);
  }
});

test('adopting no element leaves the commission byte-identical to before elements existed', () => {
  // The reason the feature could be added without moving a single golden or fixture. `compose`
  // namespaces every id, which is right with two sources and noise with one, so the empty case is
  // not composed at all.
  const bare = loadCommission('switchback', BRIEF);
  assert.equal(bare.composition, null);
  assert.deepEqual(bare.elementIds, []);
  assert.equal(bare.effective.id, 'switchback+fifty-year-embargo');
  assert.ok(
    bare.effective.commitments.some((c) => c.id === 'c-track'),
    'an uncomposed report still says c-track, not position:switchback/c-track'
  );
});

test('elementPackHash is a ninth field and it moves when the element set does', () => {
  // The version bug this had to close: two runs under different lineages comparing as the same
  // experiment, exactly as two runs under different affect rules did before `dynamicsHash`.
  const bare = envVersionNow('switchback', BRIEF, 1);
  const withOne = envVersionNow('switchback', BRIEF, 1, ['rodchenko-red-black']);
  assert.equal(Object.keys(bare).length, 9);
  assert.notEqual(bare.elementPackHash, withOne.elementPackHash);
  // And it is its own field rather than folded into the asset pack's, because a run that changed
  // which brushes exist is a different fact from a run that changed which traditions it drew on.
  assert.equal(bare.packHash, withOne.packHash);
  // Order-independent: the identity is of the set, not of the argument list.
  assert.equal(
    envVersionNow('switchback', BRIEF, 1, ['ma-interval', 'rodchenko-red-black']).elementPackHash,
    envVersionNow('switchback', BRIEF, 1, ['rodchenko-red-black', 'ma-interval']).elementPackHash
  );
});

test('the empty pack hashes to a real value, so an ordinary run carries the field too', () => {
  // A null here would make "this run adopted nothing" and "this log predates elements" the same
  // reading, and `envDrift` skips absent fields — so every pre-element run would silently compare
  // as equal to every element run.
  const bare = envVersionNow('switchback', BRIEF, 1);
  assert.match(bare.elementPackHash, /^[0-9a-f]{8,}$/);
});

test('a composed position carries the elements the artist adopted, not just their constraints', () => {
  // A lineage the artist is checked against but never shown is a parameter bundle wearing the word
  // lineage. The stance and the cliches go in with the rules.
  const c = loadCommission('overlooked', BRIEF, ['ma-interval']);
  const bare = loadCommission('overlooked', BRIEF);
  assert.ok(c.effective.worldview.length > bare.effective.worldview.length, 'the stance was not carried');
  assert.ok(c.effective.cliches.length > bare.effective.cliches.length, 'the cliches were not carried');
  assert.equal(c.effective.id, 'overlooked+fifty-year-embargo+ma-interval');
  // Element prohibitions stay prohibitions. Pouring the flat list into `commitments` would relabel
  // every one of them and the report would stop saying which part a violation came from.
  assert.ok(c.effective.prohibitions.some((p) => p.id.startsWith('element:ma-interval/')));
});
