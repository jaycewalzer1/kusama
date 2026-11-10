// The freeze, checked. This is the whole enforcement mechanism: if a held-out document is edited,
// `npm test` fails by name and says which one and what it hashed to before.
//
// Deliberately not a test of whether the held-out cells are "good" cells. Nothing here can decide
// that. It decides one thing — the bytes have not moved — and the value of the split rests entirely
// on that one thing being checked by a machine rather than remembered by a person.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../../env/browser.js';
import { loadBrief, loadField, loadPosition } from '../field.js';
import {
  heldOutBriefs,
  heldOutPositions,
  holdoutDrift,
  holdoutText,
  isHeldOut,
  loadHoldout,
  splitBySample,
} from '../holdout.js';

test('every frozen document still hashes to what it hashed at the freeze', () => {
  const drift = holdoutDrift();
  assert.deepEqual(
    drift,
    [],
    `A held-out document has been edited since ${loadHoldout().frozenAt}. That is exactly what the ` +
      `freeze exists to catch, so this failure is the mechanism working, not a broken test.\n\n${holdoutText()}`
  );
});

test('a document that was re-frozen says so, and says what it hashed to before', () => {
  // The hole in the test above: editing a held-out document and updating its hash in the same commit
  // passes it and leaves no trace. That move is allowed — `many-hands` was rewritten by the
  // constraint-budget overhaul along with every other position — but it costs an entry, and the
  // entry has to carry the previous hash so the chain back to the original freeze stays readable.
  const h = loadHoldout();
  const frozenNow = new Set([...h.positions, ...h.briefs].map((d) => d.hash));
  for (const b of h.breaks) {
    assert.match(b.on, /^\d{4}-\d{2}-\d{2}$/, `${b.id}: a break needs a date`);
    assert.match(b.was, /^[0-9a-f]{64}$/, `${b.id}: a break needs the hash it broke from`);
    assert.ok(!frozenNow.has(b.was), `${b.id}: the recorded previous hash is the one still frozen`);
    assert.ok(b.why.length > 200, `${b.id}: a re-freeze reason has to argue that it was not tuning`);
  }
  // And the text a reader sees says how many there were, rather than only what is frozen today.
  assert.match(holdoutText(), /freeze break\(s\) since|original freeze still stands/);
});

test('the freeze names a brief, everything it names exists, and an empty axis is explained', () => {
  // A holdout.json that had quietly become empty would pass every other test in this file while
  // buying nothing at all, which is the failure mode worth spending a test on.
  //
  // The position axis IS empty as of 2026-09-02, and that is a real state rather than rot: the three
  // positions that existed were deleted and the three that replaced them were written by an author
  // who was looking at the loop's failure while writing them, so none can honestly be called unseen.
  // An empty axis is therefore allowed — but only when a break record says why, which is what stops
  // this from becoming the silent emptiness the test was written to catch.
  assert.ok(heldOutBriefs().length >= 1, 'no brief is held out');
  if (heldOutPositions().length === 0) {
    assert.ok(
      loadHoldout().breaks.some((b) => b.kind === 'position'),
      'the position axis is empty and no break record explains it'
    );
  }

  for (const id of heldOutPositions()) {
    assert.equal(loadPosition(id).id, id);
  }
  for (const id of heldOutBriefs()) {
    assert.equal(loadBrief(id).id, id);
    assert.equal(loadField(id).briefId, id);
  }
});

test('the cell that has recorded runs is not claimed as held out', () => {
  // withheld x fifty-year-embargo is where the L2 A/B was measured. Freezing it retroactively would
  // be the one move that makes the whole split a lie, so it is asserted against rather than trusted.
  assert.equal(isHeldOut('switchback', 'fifty-year-embargo'), false);
});

test('a cell is held out when either axis is', () => {
  const b = heldOutBriefs()[0]!;
  const open = ['same-everywhere', 'overlooked', 'switchback'].filter((id) => !heldOutPositions().includes(id));

  // The brief axis alone is enough to hold a cell out, and with the position axis empty it is the
  // only thing doing so. Asserted over every open position rather than one, because "either axis"
  // is the claim and a single example would still pass if the OR had become an AND.
  for (const id of open) {
    assert.equal(isHeldOut(id, b), true, `open position ${id}, held-out brief`);
    assert.equal(isHeldOut(id, 'fifty-year-embargo'), false, `neither axis held out for ${id}`);
  }

  for (const p of heldOutPositions()) {
    assert.equal(isHeldOut(p, b), true, 'both axes held out');
    assert.equal(isHeldOut(p, 'fifty-year-embargo'), true, 'held-out position, open brief');
  }
});

test('splitBySample never puts a held-out cell in the in-sample list', () => {
  const b = heldOutBriefs()[0]!;
  // One open cell, one held out by the brief axis, plus one per held-out position if there are any.
  // Built from the freeze rather than hard-coded so this keeps working whichever axis is populated.
  const items = [
    { positionId: 'switchback', briefId: 'fifty-year-embargo' },
    { positionId: 'switchback', briefId: b },
    ...heldOutPositions().map((p) => ({ positionId: p, briefId: 'fifty-year-embargo' })),
  ];
  const { inSample, heldOut } = splitBySample(items, (i) => i);
  assert.equal(inSample.length, 1);
  assert.equal(heldOut.length, 1 + heldOutPositions().length);
  assert.equal(inSample[0]?.positionId, 'switchback');
});

test('holdout.json is on disk beside the documents it freezes', () => {
  assert.ok(existsSync(path.join(ROOT, 'aesthetic', 'holdout.json')));
});
