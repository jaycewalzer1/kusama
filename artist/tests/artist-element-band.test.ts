// The separation test, with groups whose answer is known before it is run.
//
// The real report needs the corpus pixels and seven resolved influence sets. What is under test is
// the statistic between them and the printed claim — and specifically that it is capable of saying
// NOTHING MEASURED, because a test that only ever feeds it separated groups would pass on a
// permutation test that had been wired backwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { elementBand, elementBandText, type ElementGroup } from '../element-band.js';
import type { Surface } from '../surface.js';

/**
 * A surface whose ground-free fields are all set from one number, so a group's spread is whatever
 * the caller says it is. `metrics` and `subject` are set separately because the first half of the
 * report is about exactly those two and nothing else.
 */
function surface(i: number, v: number, opts: { ground?: boolean; sheet?: boolean } = {}): Surface {
  // A histogram with all its weight in bin `b` makes axisShare 1 when b is an axis bin and 0 when it
  // is not, which is a controllable value rather than a derived one.
  const histogram = new Array<number>(12).fill(0);
  histogram[0] = 1;
  return {
    id: `w${i}`,
    sha256: `s${i}`,
    width: 100,
    height: 100,
    logAspect: 0,
    ground: { hex: '#ffffff', share: 1, extent: 0, confident: opts.ground ?? false },
    tone: { mean: v, sd: v, histogram: new Array(16).fill(1 / 16) },
    palette: { distinct: v * 1000, concentration: v, top: [] },
    energy: { gradient: v, byOctave: [v, v, v] },
    grain: { anisotropy: v, angle: 0, histogram },
    weight: { offset: v, spread: v },
    subject: opts.sheet ? 'sheet' : 'studio-framing',
    metrics: opts.ground
      ? ({ inkDensity: v, coverage: v, inkOffset: v, symmetry: { vertical: v, horizontal: v }, edgeContact: { top: v, right: v, bottom: v, left: v } } as Surface['metrics'])
      : null,
    measurable: opts.ground ?? false,
    why: 'fixture',
  };
}

/** Two groups drawn from the same numbers. Nothing should separate them. */
function interleaved(n: number): ElementGroup[] {
  const values = Array.from({ length: 2 * n }, (_, i) => (i % 10) / 10);
  const mk = (id: string, take: (i: number) => boolean): ElementGroup => {
    const surfaces = values.filter((_, i) => take(i)).map((v, i) => surface(i, v));
    return { id, works: surfaces.length, withGround: 0, sheets: 0, surfaces };
  };
  return [mk('a', (i) => i % 2 === 0), mk('b', (i) => i % 2 === 1)];
}

test('two groups drawn from one pool measure nothing, and the report says so in those words', () => {
  const b = elementBand(interleaved(40), 500);
  for (const f of b.fields) {
    assert.ok(f.chance > 0.05, `${f.label} claimed a separation at ${f.chance} between two identical groups`);
  }
  const text = elementBandText(b);
  assert.match(text, /NOTHING MEASURED/);
  assert.match(text, /No field separates the elements/);
});

// Each work gets its OWN value, not one value repeated. A pool holding only two distinct numbers
// makes every shuffled median a coin flip between them, so the spread reaches its maximum in ~88% of
// shuffles and the honest chance figure is 0.79 — the test first written that way failed, and it was
// the fixture that was wrong, not the statistic. Separated *bands* are what an element would have.
const spreadOut = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i / 400);

test('groups that really differ are found, and the chance figure can never be zero', () => {
  const low: ElementGroup = { id: 'low', works: 40, withGround: 0, sheets: 0, surfaces: spreadOut(40, 0.1).map((v, i) => surface(i, v)) };
  const high: ElementGroup = { id: 'high', works: 40, withGround: 0, sheets: 0, surfaces: spreadOut(40, 0.9).map((v, i) => surface(100 + i, v)) };
  const b = elementBand([low, high], 500);
  const tone = b.fields.find((f) => f.label === 'tone.mean')!;
  assert.ok(Math.abs(tone.spread - 0.8) < 1e-9, `spread ${tone.spread}`);
  // 1/(trials+1), never 0/trials. A chance of exactly zero would be a claim about the number of
  // shuffles run and not about the world, and it is the kind of number that gets quoted.
  assert.ok(Math.abs(tone.chance - 1 / 501) < 1e-9, `chance ${tone.chance}`);
  assert.ok(tone.chance > 0);
  assert.match(elementBandText(b), /separates/);
});

test('a work retrieved for two elements is counted once and disclosed', () => {
  const shared = surface(1, 0.5);
  const a: ElementGroup = { id: 'a', works: 2, withGround: 0, sheets: 0, surfaces: [shared, surface(2, 0.4)] };
  const c: ElementGroup = { id: 'c', works: 2, withGround: 0, sheets: 0, surfaces: [shared, surface(3, 0.6)] };
  const b = elementBand([a, c], 100);
  assert.equal(b.distinctImages, 3);
  assert.equal(b.sharedImages, 1);
  // The direction of the bias has to be stated, or a reader cannot tell whether the overlap is
  // manufacturing the separation or hiding it. It hides it.
  assert.match(elementBandText(b), /pull the groups TOGETHER/);
});

test('the render-rule half counts sheets, not works, and refuses under MIN_MEASURED', () => {
  // 40 works, 20 with a confident ground, but only 3 of those 2D. That is the corpus's actual shape
  // and the reason no element's inkDensityRange can be checked: museums photograph 2D works with
  // the mount inside the border, so a ground is commonest on the objects.
  const surfaces = Array.from({ length: 40 }, (_, i) => surface(i, 0.5, { ground: i < 20, sheet: i < 3 }));
  const g: ElementGroup = { id: 'thin', works: 40, withGround: 20, sheets: 3, surfaces };
  const text = elementBandText(elementBand([g, { ...g, id: 'thin2' }], 100));
  assert.match(text, /thin\s+40\s+20\s+3\s+<- too few sheets/);
  assert.match(text, /NOT ONE of 2 elements has 6 sheets/);
  // And it must name what becomes uncheckable, rather than saying "some constraints".
  for (const kind of ['inkDensityRange', 'coverageRange', 'symmetryMax', 'inkOffsetRange', 'edgeContactRange']) {
    assert.match(text, new RegExp(kind));
  }
});

test('the same groups give the same chance figures, because the shuffle is seeded', () => {
  const groups = interleaved(30);
  const a = elementBand(groups, 300);
  const b = elementBand(groups, 300);
  assert.deepEqual(a.fields.map((f) => f.chance), b.fields.map((f) => f.chance));
});
