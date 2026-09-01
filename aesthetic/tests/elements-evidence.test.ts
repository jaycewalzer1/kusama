// The evidence tiers, and the number they exist to produce.
//
// Two things are checked here and they are different in kind. The first is mechanical: the tier is
// required, its values are closed, and a derived element cannot claim to be a citation. The second
// is a measurement over what is actually on disk, in the manner of `artist envelope` — the profile
// of a real position with real elements, asserted to be what it is rather than what would be nice.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose } from '../elements/compose.js';
import { evidenceProfile, evidenceText } from '../elements/evidence.js';
import { checkElementShape, elementIds, loadElement, loadElements } from '../elements/pack.js';
import { EVIDENCE_TIERS, type LineageElement } from '../elements/types.js';
import { loadAestheticProgram } from '../check.js';
import { ROOT } from '../../env/browser.js';
import path from 'node:path';

/** The live catalogue, not a fixture: the point is what the real default configuration profiles as. */
const position = () => loadAestheticProgram(path.join(ROOT, 'aesthetic', 'positions', 'withheld.json'));

function base(): LineageElement {
  return {
    id: 'test-tier',
    name: 'Test: a tier fixture',
    provenance: {
      culture: 'test',
      period: 'test',
      note: 'synthetic, defined in the test file',
      citation: 'none: synthetic fixture',
      tier: 'speculative',
    },
    worldviewFragment: 'A fixture for the evidence tier checks.',
    generativeRules: [],
    prohibitions: [
      {
        id: 'x-no-spray',
        kind: 'forbidNode',
        params: { ops: ['spray'] },
        scope: 'tree',
        severity: 'hard',
        why: 'synthetic fixture: an element must carry at least one constraint to be an element',
      },
    ],
    cliches: ['a fixture that pretends to be a tradition'],
  };
}

test('every element on disk declares a tier from the closed set', () => {
  for (const id of elementIds()) {
    const tier = loadElement(id).provenance.tier;
    assert.ok(
      (EVIDENCE_TIERS as readonly string[]).includes(tier),
      `${id} claims tier "${tier}", which is not one of ${EVIDENCE_TIERS.join(', ')}`
    );
  }
});

test('the four hand-authored elements claim indirect and nothing on disk claims direct', () => {
  // `direct` means a primary source is quoted into the file. Nothing here does that, and the day
  // something does, this test should be the thing that has to be edited to let it through.
  for (const id of elementIds()) {
    assert.notEqual(
      loadElement(id).provenance.tier,
      'direct',
      `${id} claims a quoted primary source. If that is now true, quote it and change this test.`
    );
  }
});

test('an element without a tier is refused', () => {
  const e = base() as unknown as Record<string, unknown>;
  const p = e['provenance'] as Record<string, unknown>;
  delete p['tier'];
  assert.throws(() => checkElementShape(e), /provenance\.tier must be one of/);
});

test('an element with an invented tier is refused', () => {
  const e = base() as unknown as Record<string, unknown>;
  (e['provenance'] as Record<string, unknown>)['tier'] = 'verified';
  assert.throws(() => checkElementShape(e), /provenance\.tier must be one of/);
});

test('a derived element may not claim to rest on a source it never saw', () => {
  // The one mechanical rule the tier system carries: a blind model reading of one JPEG is an
  // interpretation of that image. `direct` and `indirect` are claims about a source outside this
  // repo, and the derivation path has no access to one.
  const from = {
    corpus: 'cma',
    objectId: '1',
    url: 'https://example.invalid/1',
    date: 'n.d.',
    creator: null,
    rights: 'CC0',
    imagePath: 'corpus/images/x.jpg',
    imageHash: 'f'.repeat(64),
    readingProtocol: 'a'.repeat(64),
    deriveProtocol: 'b'.repeat(64),
    model: 'test',
    canonical: false,
  };
  for (const tier of ['direct', 'indirect'] as const) {
    const e = { ...base(), derivedFrom: from };
    e.provenance.tier = tier;
    assert.throws(() => checkElementShape(e), /interpretation of that image/, `${tier} should be refused`);
  }
  const ok = { ...base(), derivedFrom: from };
  ok.provenance.tier = 'interpretation';
  assert.doesNotThrow(() => checkElementShape(ok));
});

test('on a run adopting no elements, every constraint deciding the score is a position and none is evidenced', () => {
  // The uncomfortable number, and the reason the layer exists. This is the default configuration —
  // `artist run withheld <brief>` with no `--elements` — and in it the evidence tiers describe
  // exactly nothing, because nothing in the composition claims to come from anywhere.
  const p = evidenceProfile(compose(position(), []), []);
  assert.equal(p.sourced, 0);
  assert.equal(p.counts.position, p.total);
  assert.ok(p.total >= 10, 'a position on disk carries at least ten constraints');
  for (const tier of EVIDENCE_TIERS) assert.equal(p.counts[tier], 0);
  assert.deepEqual(p.unknownElements, []);
});

test('adopting elements moves constraints out of the position bucket and into a tier', () => {
  const ids = ['ma-interval', 'rodchenko-red-black'];
  const elements = loadElements(ids);
  const bare = evidenceProfile(compose(position(), []), []);
  const p = evidenceProfile(compose(position(), elements), elements);

  assert.equal(p.counts.position, bare.counts.position, 'the position contributes what it always did');
  assert.equal(p.total, bare.total + p.sourced);
  assert.equal(p.counts.indirect, p.sourced, 'both elements are indirect, so all of it lands there');
  assert.ok(p.sourced > 0);
  assert.equal(p.counts.direct + p.counts.interpretation + p.counts.speculative, 0);
});

test('a profile built without the elements it cites says so rather than under-counting', () => {
  // The failure this field exists for: a caller holding a Composition read back from JSON but not
  // the pack it was built from would otherwise get a clean-looking 100%-position profile.
  const elements = loadElements(['ma-interval']);
  const c = compose(position(), elements);
  const p = evidenceProfile(c, []);
  assert.deepEqual(p.unknownElements, ['ma-interval']);
  assert.equal(p.total, c.constraints.length);
  assert.ok(p.counts.position + p.sourced < p.total, 'the unknown constraints are counted nowhere else');
  assert.match(evidenceText(p), /INCOMPLETE/);
});

test('evidenceText names the absence of a primary source instead of leaving a zero to be read past', () => {
  const out = evidenceText(evidenceProfile(compose(position(), []), []));
  assert.match(out, /Nothing here rests on a primary source/);
  assert.match(out, /position/);
  assert.match(out, /100\.0%/);
});

test('an empty composition says nothing rather than dividing by zero', () => {
  assert.match(
    evidenceText({ counts: { direct: 0, indirect: 0, interpretation: 0, speculative: 0, position: 0 }, total: 0, sourced: 0, unknownElements: [] }),
    /nothing to say about evidence/
  );
});
