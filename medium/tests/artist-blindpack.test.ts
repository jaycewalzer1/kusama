// The human test pack, checked on the two things that would make it measure nothing.
//
// A pack that looks right and is wrong is worse than no pack: five people spend an afternoon on it
// and the number that comes back is about the pack rather than about the positions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pairsOf, practiceText, writePack, type PackRun } from '../artist/blindpack.js';
import { loadPosition, practiceOf } from '../artist/field.js';

const OUT = mkdtempSync(path.join(tmpdir(), 'blindpack-'));

/** A run directory with a final.png in it. Nothing here needs the picture to be a real picture. */
function run(dir: string, positionId: string, briefId: string, deliverableId: string, withPng = true): PackRun {
  const full = path.join(OUT, dir);
  mkdirSync(full, { recursive: true });
  if (withPng) writeFileSync(path.join(full, 'final.png'), `bytes of ${dir}`);
  return { dir: full, positionId, briefId, deliverableId };
}

test('the pack pairs works that answered the same commission for the same kind of object', () => {
  const pack = pairsOf(
    [
      run('a', 'interference', 'nine-returned', 'panel'),
      run('b', 'many-hands', 'nine-returned', 'panel'),
      // Same brief, different object. A reader shown one of each would be sorting by format while
      // believing they were sorting by practice, which is the one way this test returns a false
      // positive, so it must not be paired with either of the two above.
      run('c', 'withheld', 'nine-returned', 'card'),
    ],
    1
  );
  assert.equal(pack.pairs.length, 1);
  assert.deepEqual(
    pack.pairs[0]!.works.map((w) => w.positionId).sort(),
    ['interference', 'many-hands']
  );
  assert.equal(pack.skipped.length, 1);
  assert.match(pack.skipped[0]!.why, /no pair/);
});

test('the works and the practices are shuffled separately, so A does not always mean 1', () => {
  // The failure this catches is a pack whose answer is "A1 B2" on every pair. It looks shuffled —
  // both orders vary from pair to pair — and it is a test of whether the reader noticed.
  const runs: PackRun[] = [];
  for (let i = 0; i < 8; i++) {
    runs.push(run(`p${i}-a`, 'interference', `brief-${i}`, 'panel'));
    runs.push(run(`p${i}-b`, 'many-hands', `brief-${i}`, 'panel'));
  }
  const pack = pairsOf(runs, 7);
  assert.equal(pack.pairs.length, 8);
  const aligned = pack.pairs.filter(
    (p) => p.works[0]!.positionId === p.practices[0]!.positionId
  ).length;
  assert.ok(aligned > 0 && aligned < pack.pairs.length, `A matched 1 on ${aligned} of 8 pairs`);
});

test('a pack regenerates exactly from its seed, and a different seed gives a different order', () => {
  // The key and the folder are written by two runs of this code as soon as anyone regenerates one.
  const runs = [
    run('s-a', 'interference', 'nine-returned', 'panel'),
    run('s-b', 'many-hands', 'nine-returned', 'panel'),
    run('s-c', 'withheld', 'nine-returned', 'panel'),
  ];
  assert.deepEqual(pairsOf(runs, 42), pairsOf(runs, 42));
  const orders = (seed: number) => pairsOf(runs, seed).pairs.map((p) => p.works.map((w) => w.label + w.positionId).join());
  assert.notDeepEqual(orders(42), orders(1));
});

test('a run with no picture is skipped by name rather than dropped', () => {
  const pack = pairsOf(
    [
      run('n-a', 'interference', 'nine-returned', 'panel'),
      run('n-b', 'many-hands', 'nine-returned', 'panel', false),
    ],
    1
  );
  assert.equal(pack.pairs.length, 0);
  assert.equal(pack.skipped.length, 2);
  assert.ok(pack.skipped.some((s) => /no final\.png/.test(s.why)));
});

test('nothing the reader is given names the position, and the answers are not in plain sight', () => {
  const pack = pairsOf(
    [
      run('w-a', 'interference', 'nine-returned', 'panel'),
      run('w-b', 'many-hands', 'nine-returned', 'panel'),
    ],
    3
  );
  const dir = path.join(OUT, 'pack');
  writePack(pack, dir);

  const pairDir = path.join(dir, 'pairs', 'pair-01');
  assert.deepEqual(readdirSync(pairDir).sort(), [
    'A.png', 'B.png', 'practice-1.txt', 'practice-2.txt', 'the-commission.txt',
  ]);
  const shown = [...readdirSync(pairDir), 'README.md']
    .filter((f) => !f.endsWith('.png'))
    .map((f) => readFileSync(path.join(f === 'README.md' ? dir : pairDir, f), 'utf8'))
    .join('\n');
  for (const id of ['interference', 'many-hands', 'nine-returned']) {
    assert.ok(!shown.includes(id), `the reader was shown "${id}"`);
  }

  // The key is on disk and readable — it is a seal against a glance, not a lock — but it is not
  // sitting in plain text next to the pictures.
  const sealed = readFileSync(path.join(dir, 'key', 'SEALED-answers.b64'), 'utf8');
  assert.ok(!sealed.includes('interference'));
  const key = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8'));
  const entry = key.pairs[0];
  for (const label of ['A', 'B']) {
    // The answer is the practice label whose position made that work. Checked against the two
    // orderings rather than restated, so a shuffle applied to one and not the other fails here.
    assert.equal(entry.answer[label], Object.entries(entry.practices).find(([, id]) => id === entry.works[label])![0]);
  }
});

test('the practice a reader is handed is the practice the artist was given', () => {
  // Not a paraphrase. If this text drifted from `practiceOf`, the test would be asking people to
  // match pictures against a description of an artist that never existed.
  const practice = practiceOf(loadPosition('interference'));
  const text = practiceText(practice);
  for (const line of [practice.origin, practice.doing, practice.period, practice.register, ...practice.refusals]) {
    assert.ok(text.includes(line), `the pack drops "${line.slice(0, 40)}..."`);
  }
});
