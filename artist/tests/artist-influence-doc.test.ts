// What the artist is shown of a corpus, and what it costs the runs that are shown nothing.
//
// The layer is optional, so the first thing to pin is the null case: a run without influences must
// be byte-identical to the run before this file existed. Not "similar" and not "passes the same
// assertions" — the same observation strings and the same `envVersion` keys, because every
// trajectory on disk was collected without it and a field appearing on all of them would declare
// them a different experiment.
//
// The second thing is the character of the block. It is a shelf, not a brief. The test asserts the
// absence of imperative framing directly, because the finding this layer exists to produce —
// whether an artist that has looked at a lineage makes different work — is answered by assumption
// the moment the prompt says "make it like these".

import assert from 'node:assert/strict';
import test from 'node:test';
import { ABSENT, envDrift, envVersionNow } from '../env-version.js';
import {
  THUMBNAILS,
  influenceImages,
  influenceSection,
  shownWorks,
  withInfluences,
  type InfluenceDoc,
} from '../influence-doc.js';
import { contentHash } from '../../env/profile.js';
import type { Resolved, ResolvedWork } from '../influences.js';

function work(i: number, over: Partial<ResolvedWork> = {}): ResolvedWork {
  return {
    sha256: `${i}`.padStart(64, '0'),
    id: `aic-${1000 + i}`,
    weight: 1 / (i + 1),
    cosine: 0.3 - i * 0.001,
    via: 'a query',
    museum: 'aic',
    title: `Work ${i}`,
    date: '1961',
    classification: 'print',
    medium: 'woodcut',
    // No file for any of them: the fixture must behave the same on this machine, where
    // `corpus/images/` is 3 GB, and on a clone where it does not exist at all.
    imagePath: null,
    avoidPenalty: 1,
    ...over,
  };
}

function resolved(n: number, over: Partial<Resolved> = {}): Resolved {
  return {
    version: 1,
    positionId: 'withheld',
    seed: 1,
    influencesHash: 'deadbeef',
    works: Array.from({ length: n }, (_, i) => work(i)),
    centroid: [1, 0],
    spread: 0.8,
    radius: 0.5,
    axes: [{ index: 0, explained: 0.275, label: 'calligraphy -> furniture; aic -> met', plus: [], minus: [], stepsPlus: 3, stepsMinus: 3, endedPlus: 'hull', endedMinus: 'cap' }],
    stats: {
      n,
      sameMuseum: 0.41,
      sameMuseumChance: 0.39,
      museums: [{ source: 'aic', n, share: 1 }],
      intraMean: 0.6612,
      intraMin: 0.55,
      intraMax: 0.79,
      degenerate: false,
      entropy: [],
      dimensionality: { twoD: 30, object: 18, unknown: 0, twoDShare: 0.625, corpusTwoDShare: 0.147 },
    },
    truncated: [],
    empty: [],
    ...over,
  };
}

function doc(n = 12, over: Partial<Resolved> = {}): InfluenceDoc {
  const d: InfluenceDoc = { id: 'withheld', resolved: resolved(n, over), hash: '' };
  return { ...d, hash: contentHash(influenceSection(d)) };
}

test('a run without influences gets the identical observation bytes back', () => {
  const observation = 'THE CONDITION:\nsomething\n';
  assert.equal(withInfluences(observation, null), observation);
  // Not just equal — the same string, so nothing was rebuilt and no invisible whitespace was
  // normalised on the way through.
  assert.ok(withInfluences(observation, null) === observation);
});

test('envVersion carries no influencesHash key at all when the layer is off', () => {
  const off = envVersionNow('withheld', 'nine-returned', 1);
  assert.ok(!('influencesHash' in off), `key present: ${JSON.stringify(Object.keys(off))}`);
  // The distinction the spread in `envVersionNow` exists for. `influencesHash: undefined` would
  // satisfy the assertion above only if it were written `off.influencesHash === undefined`, and
  // would then leak into `Object.keys` and into envDrift's loop.
  assert.deepEqual(Object.keys(off).filter((k) => k.includes('influences')), []);

  const on = envVersionNow('withheld', 'nine-returned', 1, [], 'abc123');
  assert.equal(on.influencesHash, 'abc123');
  // Every other field is untouched by the layer: the influence set is not part of the position, the
  // brief, the medium or the protocol.
  assert.deepEqual({ ...on, influencesHash: undefined }, { ...off, influencesHash: undefined });
});

test('a run recorded with influences, replayed against an environment without them, is drift', () => {
  const recorded = envVersionNow('withheld', 'nine-returned', 1, [], 'abc123');
  const now = envVersionNow('withheld', 'nine-returned', 1);
  const drift = envDrift(recorded, now);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.field, 'influencesHash');
  assert.equal(drift[0]?.current, ABSENT);
  // And the reverse is still not drift: a log written before the field existed cannot be said to
  // disagree about it.
  assert.deepEqual(envDrift(now, recorded), []);
});

test('the block states facts and gives no instructions', () => {
  const text = influenceSection(doc());
  // The set, its size, and the one prohibition.
  assert.match(text, /12 works you have looked at/);
  assert.match(text, /forbidden is reproducing one of them/);
  // The axis label arrives as a description of what the set separates on...
  assert.match(text, /calligraphy -> furniture; aic -> met/);
  assert.match(text, /not a direction to move in/);
  // ...and not as a direction. These are the phrasings that would answer the experiment's own
  // question by assuming it, so their absence is asserted rather than left to review.
  for (const banned of [
    /make it like these/i,
    /in the (style|manner) of/i,
    /take inspiration/i,
    /draw on these/i,
    /work in this manner/i,
    /move along the/i,
  ]) {
    assert.doesNotMatch(text, banned, `the block gives a direction: ${banned}`);
  }
});

test('every corpus number in the block arrives with the baseline it is measured against', () => {
  const text = influenceSection(doc());
  // 66.12% intra-set coherence means nothing without 0.6428 for a random pair; 41% same-museum
  // means nothing without 39%; 62.5% flat means nothing without the corpus's 14.7%.
  assert.match(text, /0\.6612.*\n.*0\.6428/s);
  assert.match(text, /41\.0% of pairs .* against 39\.0% for a random draw/);
  assert.match(text, /62\.5% of it is flat work, against 14\.7% of the corpus/);
});

test('the count of attached images in the text is the count of images attached', () => {
  // No work in the fixture has a file, so the honest number is zero — and the sentence has to say
  // zero rather than eight. A block claiming eight pictures over a payload of none is an artist
  // told to look at something that is not there.
  const d = doc();
  assert.equal(shownWorks(d).length, 0);
  assert.equal(influenceImages(d).length, 0);
  assert.match(influenceSection(d), /No pictures are attached to this message/);
  assert.doesNotMatch(influenceSection(d), /attached to this message as images/);
  // No catalogue entry carries the marker either.
  assert.doesNotMatch(influenceSection(d), /^\s+\d+\. \[shown\]/m);
});

test('a phase attaching no pictures says so, whatever is on disk', () => {
  // SKETCH and MAKE pass 0 and attach nothing. The sentence has to follow the payload, not the
  // filesystem: this is the same defect `framesOf` throws on — a text promising an image the
  // message does not carry — and it is why the count is a parameter of the block rather than a
  // constant read from the set.
  const withPixels = doc(2, { works: [work(0, { imagePath: 'images/aic/nope.jpg' }), work(1)] });
  assert.match(influenceSection(withPixels, 0), /No pictures are attached to this message/);
  assert.doesNotMatch(influenceSection(withPixels, 0), /^\s+\d+\. \[shown\]/m);
});

test('a work with an imagePath that is not on this machine is not counted as shown', () => {
  // The clone case. `resolve` writes an imagePath from the manifest whether or not the 3 GB of
  // pixels were ever downloaded, so presence in the JSON is not presence on disk.
  const d = doc(3, { works: [work(0, { imagePath: 'images/aic/nope.jpg' }), work(1), work(2)] });
  assert.equal(shownWorks(d).length, 0);
  assert.equal(influenceImages(d).length, 0);
});

test('the hash is over the block text, so anything the artist reads moves it', () => {
  const a = doc();
  assert.equal(a.hash, contentHash(influenceSection(a)));
  // The axis labels are part of what was read, so a set that lost them is a different document even
  // though `Resolved.influencesHash` — which is over the query list — would be unchanged.
  assert.notEqual(a.hash, doc(12, { axes: [] }).hash);
  assert.notEqual(a.hash, doc(11).hash);

  // And the thumbnail cap does NOT move it here, which is the honest result rather than the one
  // this test was first written to expect. `shownWorks` counts files that exist, no fixture work
  // has one, so asking for eight pictures and asking for none produce the same sentence. The cap
  // moves the hash only on a machine that has the pixels — which is the same fact stated from the
  // other side, and the reason the hash is over the text rather than over the resolved set.
  assert.equal(influenceSection(a, THUMBNAILS), influenceSection(a, 0));
});

test('an axis-less set says so rather than printing an empty heading', () => {
  assert.match(influenceSection(doc(12, { axes: [] })), /no axis carried enough variance to label/);
});
