// What this file exists to catch: an audit that always agrees with itself.
//
// The failure mode of a module like this is not a crash, it is a verdict. A separation between two
// medians is a number you can always compute and it always looks like a result, so the tests that
// matter are the ones where the answer is known in advance to be NOTHING: labels assigned at
// random, groups too small to say anything, a claim family so wide it matches every sentence. If
// those come back as findings, every real reading of the corpus is unciteable and nothing else here
// would have told us.
//
// The second thing tested is that the shuffle is two-sided. Readings that run *opposite* to the
// pixels are the most interesting result this file could produce, and a test that could only see
// agreement would report them as no effect.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAIM_PATTERNS, MIN_GROUP, type AuditPoint, auditFrom, auditText, claimsOf } from '../audit.js';

const prose = (over: Partial<Parameters<typeof claimsOf>[0]> = {}) => ({
  does: [],
  materialFacts: [],
  structuralMoves: [],
  ...over,
});

const points = (n: number, family: 'off-centre' | 'centred', offset: number, recognised = false, tag = ''): AuditPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${tag}${family}-${i}`,
    families: [family],
    // Spread slightly so the medians are not degenerate ties, which would make every shuffle equal.
    offset: offset + i * 1e-4,
    recognised,
  }));

test('a spatial claim is found in the field it was written in, with the sentence that made it', () => {
  const found = claimsOf(
    prose({ structuralMoves: ['The figure is placed slightly off-center, creating balance with the vase.'] }),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.family, 'off-centre');
  assert.equal(found[0]!.field, 'structuralMoves');
  // The quote is kept so a disagreement can be argued against what was written, not against a label.
  assert.match(found[0]!.quote, /off-center/);
});

test('the claim list is narrow on purpose: praise that no number contradicts is not a claim', () => {
  // These are the sentences a wider regex would swallow. Every one of them is unfalsifiable by
  // `weight.offset`, and matching them would manufacture a denominator and dilute a real effect
  // toward chance. If this test ever fails, the patterns grew and the audit got weaker.
  for (const sentence of [
    'The composition is dynamic and balanced.',
    'A harmonious arrangement of forms.',
    'The palette is restrained and the mood contemplative.',
    'The brushwork is confident throughout.',
  ]) {
    assert.deepEqual(claimsOf(prose({ does: [sentence] })), [], `"${sentence}" must not read as a spatial claim`);
  }
});

test('a reading that says both things is excluded and named, never silently resolved', () => {
  const both: AuditPoint[] = [
    { id: 'cma-both', families: ['off-centre', 'centred'], offset: 0.05, recognised: true },
    ...points(MIN_GROUP, 'off-centre', 0.2),
    ...points(MIN_GROUP, 'centred', 0.01),
  ];
  const a = auditFrom(both, 500);
  assert.deepEqual(a.contradictory, ['cma-both']);
  // It counts toward "made a claim" and toward neither group. Dropping it from both denominators
  // would quietly improve the result by discarding the one reading that disagrees with itself.
  assert.equal(a.withClaim, 2 * MIN_GROUP + 1);
  assert.equal(a.all.offCentre.n + a.all.centred.n, 2 * MIN_GROUP);
});

test('a claim with no measurement is carried as unmeasured, not as a zero', () => {
  // NaN is what a missing measurement looks like coming out of the surface module. Read as 0 it
  // would be the most centred work in the corpus, and it would drag a median it has no right to.
  const a = auditFrom([{ id: 'cma-nopix', families: ['off-centre'], offset: NaN, recognised: false }], 100);
  assert.deepEqual(a.unmeasured, ['cma-nopix']);
  assert.equal(a.all.offCentre.n, 0);
});

test('labels assigned at random come back as chance, not as a finding', () => {
  // The same twelve values, split by a label that means nothing. Deliberately over MIN_GROUP, so
  // the audit is willing to state a verdict and the verdict has to be "nothing". A module that
  // reports this as an effect reports everything as an effect.
  const values = [0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.13, 0.15, 0.17, 0.19, 0.21, 0.23];
  const mixed: AuditPoint[] = values.map((v, i) => ({
    id: `w${i}`,
    families: [i % 2 === 0 ? 'off-centre' : 'centred'],
    offset: v,
    recognised: false,
  }));
  const a = auditFrom(mixed, 2000);
  assert.ok(a.all.chance > 0.2, `random labels must not look like a finding, got chance ${a.all.chance}`);
  assert.match(auditText(a), /NOTHING MEASURED/);
});

test('a total separation is reported as one, and in the right direction', () => {
  const a = auditFrom([...points(6, 'off-centre', 0.2), ...points(6, 'centred', 0.01)], 5000);
  assert.ok(a.all.separation > 0.18, 'the medians are far apart and the separation must say so');
  assert.ok(a.all.chance < 0.05, `perfect separation must beat chance, got ${a.all.chance}`);
  assert.match(auditText(a), /the prose tracks the pixels/);
});

test('the shuffle is two-sided: readings that run backwards are seen, not reported as nothing', () => {
  // Works the model called off-centre measure MORE centred than the ones it called centred. This is
  // a real possible outcome and it is the most informative one; a one-sided test would print
  // "nothing measured" over the top of it.
  const a = auditFrom([...points(6, 'off-centre', 0.01), ...points(6, 'centred', 0.2)], 5000);
  assert.ok(a.all.separation < 0, 'the separation must carry the sign');
  assert.ok(a.all.chance < 0.05, 'an inverted effect is still an effect');
  assert.match(auditText(a), /runs OPPOSITE to the pixels/);
});

test('under MIN_GROUP nothing is stated, and every number is still computed and printed', () => {
  const a = auditFrom([...points(MIN_GROUP - 1, 'off-centre', 0.2), ...points(MIN_GROUP - 1, 'centred', 0.01)], 500);
  assert.equal(a.all.stated, false);
  // Computed, not suppressed: the envelope.ts convention. A reader can still see the medians and
  // judge; what they cannot do is quote them as a result.
  assert.ok(Number.isFinite(a.all.separation));
  assert.ok(Number.isFinite(a.all.chance));
  assert.match(auditText(a), /NOT STATED/);
  // And at exactly MIN_GROUP it becomes sayable, so the boundary is pinned rather than approximate.
  const b = auditFrom([...points(MIN_GROUP, 'off-centre', 0.2), ...points(MIN_GROUP, 'centred', 0.01)], 500);
  assert.equal(b.all.stated, true);
});

test('the contamination split is refused when a subgroup is empty rather than faked', () => {
  const a = auditFrom([...points(6, 'off-centre', 0.2, true), ...points(6, 'centred', 0.01, true)], 500);
  assert.notEqual(a.recognised, null);
  // Every work was recognised, so there is no unrecognised group and no comparison to make. Null,
  // not a band of zeros — the whole claim of this file rests on the two halves being comparable.
  assert.equal(a.unrecognised, null);
  assert.match(auditText(a), /NOT STATED at this sample size/);
});

test('the split reports the two halves separately and does not let one carry the other', () => {
  // Recognised works: labels mean nothing. Unrecognised works: total separation. Pooled, the effect
  // survives — which is exactly how a contaminated corpus would look like a working one.
  const a = auditFrom(
    [
      ...points(6, 'off-centre', 0.1, true, 'r'),
      ...points(6, 'centred', 0.1, true, 'r'),
      ...points(6, 'off-centre', 0.22, false, 'u'),
      ...points(6, 'centred', 0.01, false, 'u'),
    ],
    5000,
  );
  assert.ok(a.recognised!.chance > 0.2, 'the recognised half has no effect and must say so');
  assert.ok(a.unrecognised!.chance < 0.05, 'the unrecognised half has a total effect');
  assert.match(auditText(a), /Only the works it did NOT recognise hold/);
});

test('the same seed gives the same chance, so a number in a report can be re-derived', () => {
  const sample = [...points(6, 'off-centre', 0.15), ...points(6, 'centred', 0.05)];
  const a = auditFrom(sample, 1000, 7);
  const b = auditFrom(sample, 1000, 7);
  assert.equal(a.all.chance, b.all.chance);
  // And a different seed does not change the verdict, only the last digits. An audit whose finding
  // depends on the seed is not a finding.
  const c = auditFrom(sample, 1000, 99);
  assert.equal(c.all.chance <= 0.05, a.all.chance <= 0.05);
});

test('the patterns are exported so the word list can be argued with', () => {
  assert.ok(CLAIM_PATTERNS['off-centre'] instanceof RegExp);
  assert.ok(CLAIM_PATTERNS.centred instanceof RegExp);
  // "centred" must not match inside "off-center", or every off-centre reading is contradictory.
  assert.equal(CLAIM_PATTERNS.centred.test('placed slightly off-center in the frame'), false);
});
