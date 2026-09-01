// The envelope: what it states, what it refuses to state, and what it throws away.
//
// Most of this is driven from hand-built points, because `envelope()` is a pure function of a list
// of numbers. The two parts that touch disk — version filtering and the dedupe — are driven from a
// temp directory, because that is exactly where a silent wrong answer would come from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RenderMetrics } from '../../aesthetic/types.js';
import { DESCRIPTORS } from '../archive.js';
import {
  MIN_POINTS,
  currentMetricsVersion,
  envelope,
  envelopeText,
  fromMetricsCache,
  quantile,
  type EnvelopePoint,
} from '../envelope.js';

/** A point where every descriptor holds the same value, so a range is easy to reason about. */
const flat = (id: string, v: number, from: EnvelopePoint['from'] = 'run'): EnvelopePoint => ({
  id,
  from,
  values: Object.fromEntries(DESCRIPTORS.map((d) => [d, v])) as EnvelopePoint['values'],
});

function metrics(v: number, hash = `h${v}`): RenderMetrics {
  return {
    inkDensity: v,
    coverage: v,
    inkOffset: v,
    symmetry: { vertical: v, horizontal: v },
    edgeContact: { top: v, right: v, bottom: v, left: v },
    pixelHash: hash,
  };
}

test('quantile is nearest-rank: every number it returns came off a plate that exists', () => {
  const s = [0, 0.25, 0.5, 0.75, 1];
  for (const q of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
    assert.ok(s.includes(quantile(s, q)), `${q} interpolated to ${quantile(s, q)}`);
  }
  assert.equal(quantile(s, 0.5), 0.5);
  assert.equal(quantile(s, 1), 1);
  assert.equal(quantile(s, 0), 0);
  // The whole reason not to interpolate: on two plates a p90 must be one of the two, not a value
  // between them that no picture ever had.
  assert.equal(quantile([0.2, 0.8], 0.9), 0.8);
});

test('under MIN_POINTS a range is computed but not stated', () => {
  const e = envelope(Array.from({ length: MIN_POINTS - 1 }, (_, i) => flat(`p${i}`, i / 10)));
  assert.equal(e.points, MIN_POINTS - 1);
  assert.ok(e.ranges.every((r) => !r.stated));
  // Still computed. Withholding the numbers would only mean the next caller recomputes them by hand.
  assert.ok(e.ranges.every((r) => Number.isFinite(r.min) && Number.isFinite(r.max)));
  assert.match(envelopeText(e), /NOT STATED/);
});

test('at MIN_POINTS it states the range, and the occupancy is the span of 0..1 it reaches', () => {
  const e = envelope(Array.from({ length: MIN_POINTS }, (_, i) => flat(`p${i}`, 0.2 + i * 0.02)));
  assert.ok(e.ranges.every((r) => r.stated));
  const ink = e.ranges.find((r) => r.descriptor === 'inkDensity')!;
  assert.equal(ink.min.toFixed(4), '0.2000');
  assert.equal(ink.max.toFixed(4), '0.3000');
  // The number the archive has never had: these plates use a tenth of the interval it bins uniformly.
  assert.equal(ink.occupancy.toFixed(4), '0.1000');
  assert.doesNotMatch(envelopeText(e), /NOT STATED/);
  assert.match(envelopeText(e), /The archive bins 0\.\.1 uniformly/);
});

test('a blank plate sets every min to zero and is named for it, not dropped', () => {
  // One empty sheet reads 0 on all nine descriptors at once. Nine numbers that look like nine
  // measurements and are one blank picture. Excluding it would be worse — a blank sheet is a thing
  // the medium does — so it is counted and said out loud.
  const e = envelope([flat('blank', 0), ...Array.from({ length: 5 }, (_, i) => flat(`p${i}`, 0.3 + i * 0.05))]);
  assert.equal(e.blank, 1);
  assert.ok(e.ranges.every((r) => r.min === 0));
  assert.match(envelopeText(e), /no ink on it/);
  assert.equal(envelope([flat('a', 0.1)]).blank, 0);
});

test('an empty population says NOTHING MEASURED rather than reporting a range of zero width', () => {
  // The failure this repo keeps finding: a gate with nothing in front of it reporting a pass. An
  // envelope over no plates is not an envelope of zero width, and must not read like one.
  const e = envelope([]);
  assert.equal(e.points, 0);
  assert.ok(e.ranges.every((r) => r.n === 0 && !r.stated && Number.isNaN(r.min)));
  const text = envelopeText(e);
  assert.match(text, /NOTHING MEASURED/);
  assert.doesNotMatch(text, /0\.0000/);
});

test('exclusions are reported, because a sample that drops points silently is a sample that lies', () => {
  const e = envelope([flat('a', 0.5)], [{ id: 'b', because: 'metrics v3, and the current version is v4' }]);
  assert.match(envelopeText(e), /1 plate\(s\) found and not counted/);
  assert.match(envelopeText(e), /metrics v3/);
});

test('the metrics cache is read at one version only — a mixed sample measures neither renderer', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'envelope-'));
  writeFileSync(path.join(dir, 'aaa.v3.json'), JSON.stringify(metrics(0.9)));
  writeFileSync(path.join(dir, 'bbb.v3.json'), JSON.stringify(metrics(0.8)));
  writeFileSync(path.join(dir, 'ccc.v4.json'), JSON.stringify(metrics(0.1)));

  assert.equal(currentMetricsVersion(dir), 4);
  const { points, excluded } = fromMetricsCache(dir);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.values.inkDensity, 0.1);
  assert.equal(excluded.length, 2);
  assert.ok(excluded.every((x) => /metrics v3/.test(x.because)));
});

test('an entry at the current version but missing a descriptor is excluded, not read as zero', () => {
  // `descriptorsOf` throws on a missing nested object and yields undefined for a missing flat one;
  // a version number is a claim about the shape, not a check of it. Absent fields reading as
  // confident zeros is the exact bug this guards, and the three reasons stay three reasons: a file
  // dropped as "unreadable" when it parsed fine is a sample lying about its own sample.
  const dir = mkdtempSync(path.join(tmpdir(), 'envelope-'));
  const { edgeContact: _e, ...noEdges } = metrics(0.5);
  const { inkDensity: _i, ...noInk } = metrics(0.5);
  writeFileSync(path.join(dir, 'aaa.v4.json'), JSON.stringify(noEdges));
  writeFileSync(path.join(dir, 'bbb.v4.json'), JSON.stringify(noInk));
  writeFileSync(path.join(dir, 'ccc.v4.json'), 'not json');
  writeFileSync(path.join(dir, 'ddd.v4.json'), JSON.stringify(metrics(0.5)));

  const { points, excluded } = fromMetricsCache(dir);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.id, 'cache:ddd');
  assert.equal(excluded.length, 3);
  const why = (p: string) => excluded.find((x) => x.id.startsWith(`cache:${p}`))!.because;
  assert.match(why('aaa'), /not shaped like RenderMetrics/);
  assert.match(why('bbb'), /missing inkDensity/);
  assert.equal(why('ccc'), 'unreadable');
});

test('an empty cache directory is a real state, not an error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'envelope-'));
  assert.equal(currentMetricsVersion(dir), null);
  assert.deepEqual(fromMetricsCache(dir), { points: [], excluded: [] });
  assert.equal(currentMetricsVersion(path.join(dir, 'does-not-exist')), null);
});
