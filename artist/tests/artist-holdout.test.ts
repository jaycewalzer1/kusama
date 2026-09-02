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

test('the freeze names at least one position and one brief, and both exist on disk', () => {
  // A holdout.json that had quietly become empty would pass every other test in this file while
  // buying nothing at all, which is the failure mode worth spending a test on.
  assert.ok(heldOutPositions().length >= 1, 'no position is held out');
  assert.ok(heldOutBriefs().length >= 1, 'no brief is held out');

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
  assert.equal(isHeldOut('withheld', 'fifty-year-embargo'), false);
});

test('a cell is held out when either axis is', () => {
  const p = heldOutPositions()[0]!;
  const b = heldOutBriefs()[0]!;
  const openPosition = ['interference', 'many-hands', 'withheld'].find((id) => id !== p)!;

  assert.equal(isHeldOut(p, b), true, 'both axes held out');
  assert.equal(isHeldOut(p, 'fifty-year-embargo'), true, 'held-out position, open brief');
  assert.equal(isHeldOut(openPosition, b), true, 'open position, held-out brief');
  assert.equal(isHeldOut('withheld', 'fifty-year-embargo'), false, 'neither axis held out');
});

test('splitBySample never puts a held-out cell in the in-sample list', () => {
  const p = heldOutPositions()[0]!;
  const b = heldOutBriefs()[0]!;
  const items = [
    { positionId: 'withheld', briefId: 'fifty-year-embargo' },
    { positionId: p, briefId: 'fifty-year-embargo' },
    { positionId: 'withheld', briefId: b },
  ];
  const { inSample, heldOut } = splitBySample(items, (i) => i);
  assert.equal(inSample.length, 1);
  assert.equal(heldOut.length, 2);
  assert.equal(inSample[0]?.positionId, 'withheld');
});

test('holdout.json is on disk beside the documents it freezes', () => {
  assert.ok(existsSync(path.join(ROOT, 'aesthetic', 'holdout.json')));
});
