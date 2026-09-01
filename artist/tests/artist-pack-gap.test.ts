// The gap report, with a pack and a census whose answers are known before it runs.
//
// The real report needs the corpus pixels and a 25-minute census. What is under test is the join
// between a hand-written bound and a band of real sheets, and specifically the two claims the report
// makes that a reader would act on: that a rule nearly every sheet already passes is called out as
// close to no bound, and that a bound with fewer than MIN_MEASURED sheets behind it is printed as
// UNMEASURABLE rather than as a small number.
//
// The scoring path is the aesthetic layer's own `checkConstraint`. That is deliberate and it is what
// makes the fixtures below meaningful: `inkDensityRange {min: 0.5}` against a sheet of inkDensity
// 0.4 is a violation here for the same reason and by the same code as it is on a rendered plate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { constraintGaps, fieldGaps, loadPack, packGap, packGapText, SEPARATING_FIELDS } from '../pack-gap.js';
import { MIN_MEASURED, surfaceCensus, type Surface, type SurfaceCensus } from '../surface.js';
import type { ElementGroup } from '../element-band.js';
import type { LineageElement } from '../../aesthetic/elements/types.js';
import type { RenderMetrics } from '../../aesthetic/types.js';

/** A sheet whose every metric is one number, so a bound's pass rate is arithmetic the test can do. */
function metrics(v: number): Omit<RenderMetrics, 'pixelHash'> {
  return {
    inkDensity: v,
    coverage: v,
    inkOffset: v,
    symmetry: { vertical: v, horizontal: v },
    edgeContact: { top: v, right: v, bottom: v, left: v },
  };
}

/**
 * A census of `n` sheets with inkDensity spread evenly over [0, 1).
 *
 * Each sheet gets its OWN value rather than one value repeated, for the reason the element-band
 * fixtures do: a pool of two distinct numbers makes every share either 0%, 50% or 100% and a test
 * over it cannot tell a working threshold from a broken one.
 */
function census(n: number, open: SurfaceCensus['open'] = {}): SurfaceCensus {
  return {
    version: 1,
    generated: '2026-09-01T00:00:00.000Z',
    sampled: false,
    manifestRows: n,
    imagesRead: n,
    measured: n,
    open,
    subjects: {
      sheet: Array.from({ length: n }, (_, i) => metrics(i / n)),
      'studio-framing': [],
      unknown: [],
    },
  };
}

function surface(i: number, v: number, subject: Surface['subject'] | null = null): Surface {
  const histogram = new Array<number>(12).fill(0);
  histogram[0] = 1;
  return {
    id: `w${i}`,
    sha256: `s${i}`,
    width: 100,
    height: 100,
    logAspect: 0,
    ground: { hex: '#ffffff', share: 1, extent: 0, confident: subject !== null },
    tone: { mean: v, sd: v, histogram: new Array(16).fill(1 / 16) },
    palette: { distinct: v * 1000, concentration: v, top: [] },
    energy: { gradient: v, byOctave: [v, v, v] },
    grain: { anisotropy: v, angle: 0, histogram },
    weight: { offset: v, spread: v },
    subject: subject ?? 'studio-framing',
    metrics: subject === null ? null : metrics(v),
    measurable: subject !== null,
    why: 'fixture',
  };
}

function group(id: string, sheets: number, values: number[]): ElementGroup {
  return { id, works: values.length, withGround: sheets, sheets, surfaces: values.map((v, i) => surface(i, v)) };
}

function element(id: string, params: Record<string, unknown>, kind = 'inkDensityRange'): LineageElement {
  return {
    id,
    name: id,
    provenance: { culture: 'fixture', period: 'fixture', note: 'fixture', citation: 'fixture', tier: 'indirect' },
    worldviewFragment: 'fixture',
    generativeRules: [{ id: `${id}-rule`, kind, params, scope: 'render', severity: 'hard', why: 'fixture' }],
    prohibitions: [],
    cliches: [],
  } as LineageElement;
}

test('a bound is scored against real sheets by the checker that scores a plate', () => {
  // 100 sheets at inkDensity 0.00 .. 0.99. `>= 0.35` passes the 65 at 0.35 and above.
  const gaps = constraintGaps([element('e', { min: 0.35 })], [group('e', 0, [0.5])], census(100));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.ofSheets, 100);
  assert.equal(gaps[0]!.satisfied, 65);
});

test('a two-sided bound and a max-only bound are both read the way the checker reads them', () => {
  const both = constraintGaps([element('e', { min: 0.2, max: 0.6 })], [group('e', 0, [0.5])], census(100));
  assert.equal(both[0]!.satisfied, 41); // 0.20 .. 0.60 inclusive
  const cap = constraintGaps([element('e', { axis: 'vertical', max: 0.7 }, 'symmetryMax')], [group('e', 0, [0.5])], census(100));
  assert.equal(cap[0]!.satisfied, 71); // 0.00 .. 0.70 inclusive
});

test('tree-scope rules are not in the table at all, because no band could ever check them', () => {
  const e = element('e', { min: 0.35 });
  e.generativeRules.push({ id: 'tree', kind: 'requireNode', params: { op: 'paint', min: 5 }, scope: 'tree', severity: 'hard', why: 'f' });
  const gaps = constraintGaps([e], [group('e', 0, [0.5])], census(100));
  assert.deepEqual(gaps.map((g) => g.constraint.id), ['e-rule']);
});

// Matched on the ROW and not on the bare word. Both "UNMEASURABLE" and the field names appear in
// this report's own prose above the table, so a `doesNotMatch(/UNMEASURABLE/)` passes or fails on
// the caption — which is how a test in this repo once counted a heading as a table row.
const row = (own: string) => new RegExp(`e-rule\\s+inkDensityRange\\s+>= 0\\.3500\\s+${own}\\s+\\d+\\.\\d%`);

test('a bound with too few sheets behind it prints UNMEASURABLE, never a small n', () => {
  const under = packGapText(packGap([element('e', { min: 0.35 })], [group('e', MIN_MEASURED - 1, [0.5])], census(100)));
  assert.match(under, row('UNMEASURABLE'));
  assert.doesNotMatch(under, row(String(MIN_MEASURED - 1)));
  assert.match(under, /NOT ONE of 1 numeric rules/);

  const over = packGapText(packGap([element('e', { min: 0.35 })], [group('e', MIN_MEASURED, [0.5])], census(100)));
  assert.match(over, row(String(MIN_MEASURED)));
  assert.doesNotMatch(over, row('UNMEASURABLE'));
  assert.doesNotMatch(over, /NOT ONE of/);
});

test('a rule almost every sheet already passes is named as close to no bound', () => {
  const text = packGapText(packGap([element('e', { min: 0.01 })], [group('e', 0, [0.5])], census(100)));
  assert.match(text, /close to no bound at all/);
  assert.doesNotMatch(text, /almost no example/);
});

test('a rule almost no sheet passes is named too, and not as a failure of the lineage', () => {
  const text = packGapText(packGap([element('e', { min: 0.99 })], [group('e', 0, [0.5])], census(100)));
  assert.match(text, /almost no example/);
  // Not `/a lineage can ask/`: the sentence wraps between "a" and "lineage", so that regex is a
  // test of where the line break falls rather than of what the report says.
  assert.match(text, /lineage can ask for something rare/);
  assert.doesNotMatch(text, /close to no bound at all/);
});

test('a rule in the middle gets no verdict sentence, only its row', () => {
  const text = packGapText(packGap([element('e', { min: 0.5 })], [group('e', 0, [0.5])], census(100)));
  assert.doesNotMatch(text, /close to no bound at all/);
  assert.doesNotMatch(text, /almost no example/);
  assert.match(text, /50\.0%/);
});

test('the four separating fields are banded over every work, not over the sheets', () => {
  // Ten works, none with a ground. A ground-free field must still produce n=10.
  const g = group('e', 0, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  const fields = fieldGaps([g], census(100));
  assert.deepEqual(fields.map((f) => f.label), SEPARATING_FIELDS.map((f) => f.label));
  for (const f of fields) assert.equal(f.bands[0]!.n, 10, `${f.label} banded ${f.bands[0]!.n} of 10 works`);
});

test('the fields that measured nothing in element-band are absent, not printed as columns', () => {
  const labels = SEPARATING_FIELDS.map((f) => f.label);
  for (const dead of ['grain.anisotropy', 'tone.mean', 'weight.offset', 'weight.spread']) {
    assert.ok(!labels.includes(dead), `${dead} measured nothing and must not be in the table`);
  }
  assert.deepEqual(labels, ['grain.axisShare', 'tone.sd', 'palette.distinct', 'energy.gradient']);
});

test('grain.axisShare carries its read-the-order warning wherever it is printed', () => {
  const text = packGapText(packGap([element('e', { min: 0.5 })], [group('e', 0, [0.5, 0.6, 0.7])], census(100)));
  assert.match(text, /READ THE ORDER BETWEEN ROWS/);
  assert.match(text, /0\.3333/);
});

test('an element with no resolved set, and a set with no element, are both named', () => {
  const g = packGap([element('claimed', { min: 0.5 })], [group('retrieved', 0, [0.5])], census(100));
  assert.deepEqual(g.unpaired.packOnly, ['claimed']);
  assert.deepEqual(g.unpaired.resolvedOnly, ['retrieved']);
  const text = packGapText(g);
  assert.match(text, /no resolved set/);
  assert.match(text, /nothing claimed to check/);
});

test('the report says in its own words that no kind reads the separating fields', () => {
  const text = packGapText(packGap([element('e', { min: 0.5 })], [group('e', 0, [0.5])], census(100)));
  assert.match(text, /NO CONSTRAINT KIND READS ANY OF THEM/);
  assert.match(text, /elementPackHash/);
  assert.match(text, /writes nothing/);
});

// --- the writer -----------------------------------------------------------------------------------
//
// Everything above hand-builds a census. These two check that `surfaceCensus` actually produces that
// shape from a `SurfaceReport`, and that it survives JSON — the 25-minute `--all` run is the only
// way to make one for real, so a shape bug found afterwards costs 25 minutes to retest.

test('the census splits metrics by subject and never pools them', () => {
  const report = {
    works: 5,
    measured: 3,
    skipped: {},
    surfaces: [
      surface(0, 0.1, 'sheet'),
      surface(1, 0.9, 'sheet'),
      surface(2, 0.5, 'studio-framing'),
      surface(3, 0.4),
      surface(4, 0.6),
    ],
  };
  const c = surfaceCensus(report, false);
  assert.equal(c.sampled, false);
  assert.equal(c.imagesRead, 5);
  assert.equal(c.subjects.sheet.length, 2);
  assert.equal(c.subjects['studio-framing'].length, 1);
  assert.equal(c.subjects.unknown.length, 0);
  assert.deepEqual(c.subjects.sheet.map((m) => m.inkDensity), [0.1, 0.9]);
  // Open bands are over EVERY image, ground or not — that is the whole reason they are open fields.
  for (const label of SEPARATING_FIELDS.map((f) => f.label)) assert.equal(c.open[label]!.n, 5, label);
});

test('a census survives JSON and the report reads it back unchanged', () => {
  const report = {
    works: 10,
    measured: 10,
    skipped: {},
    surfaces: Array.from({ length: 10 }, (_, i) => surface(i, i / 10, 'sheet')),
  };
  const direct = surfaceCensus(report, false);
  const roundTripped = JSON.parse(JSON.stringify(direct)) as SurfaceCensus;
  const g = (c: SurfaceCensus) => constraintGaps([element('e', { min: 0.5 })], [group('e', 0, [0.5])], c);
  assert.deepEqual(g(roundTripped), g(direct));
  assert.equal(g(roundTripped)[0]!.satisfied, 5);
});

test('a sampled census is marked as sampled, so it can be refused rather than caveated', () => {
  const report = { works: 1, measured: 1, skipped: {}, surfaces: [surface(0, 0.5, 'sheet')] };
  assert.equal(surfaceCensus(report, true).sampled, true);
  assert.equal(surfaceCensus(report, false).sampled, false);
});

// The pack on disk is the thing the report is about, so its shape is asserted rather than assumed.
// `loadElement` would validate one id at a time; this checks that the directory scan skips
// conflicts.json, which is in the same folder and is not an element.
test('the pack loads from disk and every file in it validates as an element', () => {
  const pack = loadPack();
  assert.ok(pack.length > 0, 'no elements on disk');
  for (const e of pack) assert.equal(typeof e.id, 'string');
  assert.ok(!pack.some((e) => e.id === 'conflicts'), 'conflicts.json was read as an element');
});

test('every render-scope rule on disk is one of the five kinds this report knows how to score', () => {
  for (const e of loadPack()) {
    for (const r of [...e.generativeRules, ...e.prohibitions]) {
      if (r.scope !== 'render') continue;
      // A sixth render kind added to aesthetic/kinds.ts without a thought here would otherwise be
      // scored by `checkConstraint` and silently reported under a table that claims five.
      assert.ok(
        ['inkDensityRange', 'coverageRange', 'symmetryMax', 'inkOffsetRange', 'edgeContactRange'].includes(r.kind),
        `${e.id}/${r.id} is a render kind this report does not know: ${r.kind}`
      );
    }
  }
});
