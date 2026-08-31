// The break record.
//
// Driven by a synthetic log in the exact line order `ArtistEnv` emits — reset renders, then per step
// an act call, a candidate render and a step line — for the same reason artist-process.test.ts does:
// the fold is pure, so a fixture log tests it completely and a real trajectory would only add a
// browser and a model to the dependency list of an assertion about a join.
//
// The composition here is a real one, composed from the shipped pack, because the record's whole
// job is to attribute a break to a *source* and a made-up composition would let the attribution
// pass while agreeing with nothing on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../../aesthetic/elements/compose.js';
import { loadAestheticProgram } from '../../aesthetic/check.js';
import { loadElements } from '../../aesthetic/elements/pack.js';
import { qualify, type Composition } from '../../aesthetic/elements/types.js';
import { ROOT } from '../../env/browser.js';
import path from 'node:path';
import { breakRecordOf, breaks, breakText } from '../breaks.js';
import type { LogLine } from '../studio-log.js';

const AFFECT = { arousal: 0.5, valence: 0.1 };

function line(seq: number, kind: LogLine['kind'], data: unknown): LogLine {
  return { seq, t: '', kind, data, prev: '', hash: '' };
}

/** A render line carrying the two verdict lists, which is what a run has logged since env.ts did. */
function render(seq: number, satisfied: string[], violated: string[]): LogLine {
  return line(seq, 'render', {
    programHash: 'p',
    pixelHash: 'x',
    standing: 0,
    hardViolations: violated.length,
    softViolations: 0,
    treeScore: 0.5,
    renderScore: null,
    satisfied,
    violated,
  });
}

/** A render line as it was written before the verdicts were logged. */
function oldRender(seq: number): LogLine {
  return line(seq, 'render', { programHash: 'p', pixelHash: 'x', standing: 0, hardViolations: 0, softViolations: 0, treeScore: 0.5, renderScore: null });
}

function step(seq: number, k: number, broke: string[], covered: string[], accepted = true): LogLine {
  return line(seq, 'step', {
    k,
    edits: [],
    refused: [],
    applied: [],
    accepted,
    revertedBecause: null,
    isRiskMove: false,
    destroyedNodeIds: [],
    affect: AFFECT,
    declaration: { namedIds: covered, blanket: false, broke, covered },
  });
}

const composition: Composition = compose(
  loadAestheticProgram(path.join(ROOT, 'aesthetic/positions/withheld.json')),
  loadElements(['ma-interval', 'rodchenko-red-black'])
);

const idsOf = (kind: 'position' | 'element', id: string): string[] =>
  composition.constraints.filter((c) => c.source.kind === kind && c.source.id === id).map((c) => c.id);

const POS = idsOf('position', 'withheld');
const MA = idsOf('element', 'ma-interval');
const ROD = idsOf('element', 'rodchenko-red-black');

test('the fixture is real: three sources, each with constraints of its own', () => {
  // If this ever goes empty the tests below all pass vacuously, which is the failure mode a fixture
  // built from the live pack is most exposed to.
  assert.ok(POS.length >= 3, 'the position contributed nothing');
  assert.ok(MA.length >= 1 && ROD.length >= 1, 'an element contributed nothing');
});

test('a break is attributed to the source that owned the constraint, and to the part it was stated in', () => {
  const broken = MA[0]!;
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval', 'rodchenko-red-black'], composition }),
    render(1, [broken], []),
    render(2, [], [broken]),
    step(3, 1, [broken], []),
  ];
  const r = breakRecordOf(log);
  assert.equal(r.breaks.length, 1);
  const b = r.breaks[0]!;
  assert.equal(b.k, 1);
  assert.equal(b.constraint, broken);
  assert.deepEqual(b.source, { kind: 'element', id: 'ma-interval' });
  assert.ok(['commitment', 'prohibition', 'generative_rule'].includes(b.part));
  assert.equal(b.accepted, true);
  assert.equal(r.summary.bySource['element:ma-interval'], 1);
});

test('declared in advance comes from the step\'s own risk, never from the artist saying so after', () => {
  const broken = MA[0]!;
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval'], composition }),
    render(1, [broken], []),
    render(2, [], [broken]),
    step(3, 1, [broken], [broken]),
    render(4, [], [broken, POS[0]!]),
    step(5, 2, [POS[0]!], []),
  ];
  const r = breakRecordOf(log);
  assert.deepEqual(r.breaks.map((b) => b.declaredInAdvance), [true, false]);
  assert.equal(r.summary.declared, 1);
  assert.equal(r.summary.stuck, 2);
});

test('a break is forced by what was gained on the same step, when the checker saw the trade', () => {
  const broken = MA[0]!;
  const gained = ROD[0]!;
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval', 'rodchenko-red-black'], composition }),
    render(1, [broken], [gained]),
    render(2, [gained], [broken]),
    step(3, 1, [broken], []),
  ];
  const r = breakRecordOf(log);
  const forcing = r.breaks[0]!.forcedBy.find((f) => f.basis === 'gained');
  assert.ok(forcing, 'the trade the checker saw was not reported');
  assert.equal(forcing.constraint, gained);
  assert.deepEqual(forcing.source, { kind: 'element', id: 'rodchenko-red-black' });
  assert.equal(r.summary.unexplained, 0);
});

test('a gain by the same source is not a reason: that is one lineage rearranging itself', () => {
  assert.ok(MA.length >= 2, 'the fixture needs an element with two constraints');
  const broken = MA[0]!;
  const gained = MA[1]!;
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval'], composition }),
    render(1, [broken], [gained]),
    render(2, [gained], [broken]),
    step(3, 1, [broken], []),
  ];
  const r = breakRecordOf(log);
  assert.deepEqual(r.breaks[0]!.forcedBy.filter((f) => f.basis === 'gained'), []);
});

test('a break nothing explains is counted, not quietly dropped', () => {
  // Deliberately a constraint no conflict names. The first one in the pack is party to a derived
  // conflict, and picking it would test the conflict path over again while claiming to test this.
  const inConflict = new Set(composition.conflicts.flatMap((c) => [qualify(c.a.source, c.a.constraintId), qualify(c.b.source, c.b.constraintId)]));
  const broken = MA.find((id) => !inConflict.has(id));
  assert.ok(broken, 'every constraint of this element is already in a conflict');
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval'], composition }),
    render(1, [broken], []),
    render(2, [], [broken]),
    step(3, 1, [broken], []),
  ];
  const r = breakRecordOf(log);
  assert.deepEqual(r.breaks[0]!.forcedBy, []);
  assert.equal(r.summary.unexplained, 1);
});

test('a known conflict accounts for a break even when no trade was visible on the step', () => {
  const known = composition.conflicts[0];
  assert.ok(known, 'the composed pack must contain at least one derived or declared conflict');
  const broken = qualify(known.a.source, known.a.constraintId);
  const other = qualify(known.b.source, known.b.constraintId);
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval', 'rodchenko-red-black'], composition }),
    render(1, [broken], []),
    render(2, [], [broken]),
    step(3, 1, [broken], []),
  ];
  const r = breakRecordOf(log);
  const forcing = r.breaks[0]!.forcedBy.find((f) => f.basis === 'conflict');
  assert.ok(forcing);
  assert.equal(forcing.constraint, other);
  assert.equal(forcing.tier, known.tier);
  assert.equal(forcing.note, known.note, 'the note must be the conflict\'s own, not a new sentence');
});

test('a reverted step still recorded a break, and it is kept apart from one that stuck', () => {
  const broken = MA[0]!;
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval'], composition }),
    render(1, [broken], []),
    render(2, [], [broken]),
    step(3, 1, [broken], [], false),
    render(4, [], [broken]),
    step(5, 2, [broken], [], true),
  ];
  const r = breakRecordOf(log);
  assert.equal(r.breaks.length, 2);
  assert.equal(r.summary.reverted, 1);
  assert.equal(r.summary.stuck, 1);
  // A reverted candidate does not become the state the next step is measured against.
  assert.deepEqual(r.breaks.map((b) => b.accepted), [false, true]);
});

test('a log with no per-constraint verdicts reports that, and does not report an empty run', () => {
  // The trap this closes: an absent field read as a confident zero. An old trajectory has no
  // verdicts, and "nothing broke" is a much worse answer than "this cannot be answered".
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval'], composition }),
    oldRender(1),
    oldRender(2),
    step(3, 1, [MA[0]!], []),
  ];
  const r = breakRecordOf(log);
  assert.equal(r.verdictsRecorded, false);
  assert.equal(r.statesObserved, 0);
  assert.deepEqual(r.observed, []);
  assert.match(breakText(r), /no per-constraint verdicts/);
});

test('a break of a constraint the composition does not name is skipped rather than guessed at', () => {
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval'], composition }),
    render(1, [], []),
    render(2, [], ['element:not-composed/e-ghost']),
    step(3, 1, ['element:not-composed/e-ghost'], []),
  ];
  assert.deepEqual(breakRecordOf(log).breaks, []);
});

test('a run that adopted no elements has one source and nothing to trade', () => {
  const log = [line(0, 'trajectory-start', { elementIds: [], composition: null }), render(1, [], []), render(2, [], [])];
  const r = breakRecordOf(log);
  assert.deepEqual(r.breaks, []);
  assert.deepEqual(r.observed, []);
  assert.equal(r.verdictsRecorded, true, 'the verdicts were there; there was just nothing to attribute');
  assert.match(breakText(r), /one source and nothing to trade/);
});

test('the observed tier is computed from the states the run actually stood in', () => {
  const a = POS[0]!;
  const b = ROD[0]!;
  const log = [
    line(0, 'trajectory-start', { elementIds: ['ma-interval', 'rodchenko-red-black'], composition }),
    render(1, [a], [b]),
    render(2, [b], [a]),
    step(3, 1, [a], []),
  ];
  const r = breakRecordOf(log);
  assert.equal(r.statesObserved, 2);
  assert.equal(r.observed.length, 1);
  assert.equal(r.observed[0]!.tier, 'observed');
  assert.match(r.observed[0]!.note, /the 2 observed held both/);
});

test('a log with no trajectory-start line is not a trajectory', () => {
  assert.throws(() => breakRecordOf([render(0, [], [])]), /not a trajectory log/);
});

test('breaks() reads no files and takes the composition it is given', () => {
  // The composition is an argument and not a re-read of the pack on purpose: an element edited
  // after a run must not be able to rewrite what that run is said to have broken.
  const log = [render(0, [MA[0]!], []), render(1, [], [MA[0]!]), step(2, 1, [MA[0]!], [])];
  assert.equal(breaks(log, composition, ['ma-interval']).breaks.length, 1);
  assert.equal(breaks(log, null, []).breaks.length, 0);
});
