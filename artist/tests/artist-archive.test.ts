// The archive: binning, the gate, and the two things it refuses to guess.
//
// Driven from hand-built measurements, because the whole of `archive()` is a function of five
// numbers and a violation count and there is nothing a PNG would add. `measureRuns` is tested
// separately against a directory on disk, which is where the guessing would happen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RenderMetrics } from '../../aesthetic/types.js';
import { archive, archiveText, bin, measureRuns, DEFAULT_AXES, DESCRIPTORS, type Measured } from '../archive.js';

function metrics(inkDensity: number, inkOffset: number, rest: Partial<RenderMetrics> = {}): RenderMetrics {
  return {
    inkDensity,
    coverage: 0.5,
    inkOffset,
    symmetry: { vertical: 0.5, horizontal: 0.5 },
    pixelHash: `h${inkDensity}-${inkOffset}`,
    ...rest,
  };
}

const cand = (id: string, ink: number, off: number, hard = 0): Measured => ({
  id,
  dir: `out/${id}`,
  metrics: metrics(ink, off),
  hardViolations: hard,
});

test('every axis offered is a quantity the checker already measures', () => {
  // The fence. A descriptor invented for the archive would be one nothing else in the system can
  // see, and the grid would start reporting on itself.
  const m = metrics(0.1, 0.2);
  const available = new Set([...Object.keys(m).filter((k) => k !== 'symmetry' && k !== 'pixelHash'), 'symmetryVertical', 'symmetryHorizontal']);
  for (const d of DESCRIPTORS) assert.ok(available.has(d), `${d} is not in RenderMetrics`);
  assert.ok(DEFAULT_AXES.every((d) => (DESCRIPTORS as readonly string[]).includes(d)));
});

test('a value lands in the bin its fraction names, and 1.0 lands in the last one', () => {
  assert.equal(bin(0, 6), 0);
  assert.equal(bin(0.16, 6), 0);
  assert.equal(bin(0.17, 6), 1);
  assert.equal(bin(0.99, 6), 5);
  // The off-by-one that would put a full-bleed plate in cell 6 of a 6-cell axis.
  assert.equal(bin(1, 6), 5);
});

test('a hard violation keeps a candidate out of the grid and its reason in the record', () => {
  const a = archive([cand('good', 0.1, 0.1), cand('bad', 0.9, 0.9, 2)]);
  assert.equal(a.summary.admitted, 1);
  assert.equal(a.summary.rejected, 1);
  assert.equal(a.summary.occupied, 1, 'the refused candidate occupies no cell');

  const bad = a.candidates.find((c) => c.id === 'bad')!;
  assert.equal(bad.admitted, false);
  assert.equal(bad.cell, null);
  assert.match(bad.rejectedBecause!, /2 hard constraint/);
  // Kept, not dropped. A gate whose rejections vanish is a gate nobody can audit.
  assert.equal(a.candidates.length, 2);
  assert.match(archiveText(a), /refused: bad/);
});

test('candidates that differ only below the bin width share a cell, and both stay', () => {
  const a = archive([cand('x', 0.10, 0.10), cand('y', 0.15, 0.12)]);
  assert.equal(a.cells.length, 1);
  assert.deepEqual(a.cells[0]!.members, ['x', 'y']);
  assert.equal(a.summary.fill, 1 / 36);
});

test('with no ranking there is no elite, and the cell says so rather than electing one', () => {
  // The elite is the best pairwise judge rank in the cell. That judge does not exist yet, and
  // picking by a constraint score would be the wrong instrument twice: a cell full of candidates
  // that satisfy every constraint is exactly the case an archive is for.
  const a = archive([cand('x', 0.1, 0.1), cand('y', 0.12, 0.12)]);
  assert.equal(a.cells[0]!.elite, null);
  assert.equal(a.cells[0]!.eliteBasis, 'unranked');
  assert.match(archiveText(a), /No cell has an elite/);
});

test('given a ranking the elite is the best-ranked member of the cell', () => {
  const a = archive([cand('x', 0.1, 0.1), cand('y', 0.12, 0.12)], DEFAULT_AXES, 6, { x: 4, y: 1 });
  assert.equal(a.cells[0]!.elite, 'y');
  assert.equal(a.cells[0]!.eliteBasis, 'rank');
});

test('a member with no rank cannot be elite, and does not stop the ranked ones being', () => {
  const a = archive([cand('x', 0.1, 0.1), cand('y', 0.12, 0.12)], DEFAULT_AXES, 6, { y: 3 });
  assert.equal(a.cells[0]!.elite, 'y');
  assert.deepEqual(a.cells[0]!.members, ['x', 'y'], 'the unranked one is still in the cell');
});

test('two axes that measure the same thing are reported as one axis, not as a full grid', () => {
  // The documented collapse, in miniature. Four candidates whose ink and offset move together fill
  // four cells on a diagonal of thirty-six, and the correlation is what says why.
  const same = [0.05, 0.3, 0.55, 0.85].map((v, i) => cand(`c${i}`, v, v));
  const a = archive(same);
  assert.equal(a.summary.occupied, 4);
  assert.ok(a.summary.axisCorrelation! > 0.9, `expected near-perfect correlation, got ${a.summary.axisCorrelation}`);
  assert.match(archiveText(a), /these two axes are one axis/);
});

test('an axis that did not vary reports no correlation rather than zero', () => {
  // Zero would read as "independent", when the truth is "this axis never moved".
  const a = archive([cand('a', 0.1, 0.4), cand('b', 0.5, 0.4), cand('c', 0.9, 0.4)]);
  assert.equal(a.summary.axisCorrelation, null);
});

test('under three candidates the correlation is not a number, because it would be noise', () => {
  assert.equal(archive([cand('a', 0.1, 0.2), cand('b', 0.8, 0.3)]).summary.axisCorrelation, null);
  assert.equal(archive([]).summary.axisCorrelation, null);
});

test('an empty archive is zero occupied cells, not thirty-six empty ones', () => {
  const a = archive([]);
  assert.deepEqual(a.cells, []);
  assert.equal(a.summary.fill, 0);
});

test('changing the axes re-bins without needing pixels: all five descriptors are on every candidate', () => {
  const a = archive([cand('x', 0.1, 0.9)]);
  assert.deepEqual(Object.keys(a.candidates[0]!.descriptors).sort(), [...DESCRIPTORS].sort());
});

test('measureRuns reads finished runs and refuses the ones it cannot gate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'archive-'));
  // No final.png: not a finished run, and not an error either.
  mkdirSync(path.join(root, 'unfinished'), { recursive: true });
  writeFileSync(path.join(root, 'unfinished', 'final.json'), '{}');
  // Has both files, but the score with the gate on it is missing. Refused rather than defaulted to
  // zero: defaulting would admit an unknown through the only gate this file has.
  const nogate = path.join(root, 'nogate');
  mkdirSync(nogate, { recursive: true });
  writeFileSync(path.join(nogate, 'final.png'), 'not a png');
  writeFileSync(path.join(nogate, 'final.json'), JSON.stringify({ finalProgram: { canvas: { ground: '#fff' } }, scores: {} }));

  const { measured, skipped } = measureRuns(root);
  assert.deepEqual(measured, []);
  assert.deepEqual(skipped, [nogate], 'the unfinished run is not a skip, it is not a run');
});

test('a runs directory that does not exist is empty, not a throw', () => {
  const { measured, skipped } = measureRuns(path.join(tmpdir(), 'archive-nonexistent-directory'));
  assert.deepEqual(measured, []);
  assert.deepEqual(skipped, []);
});
