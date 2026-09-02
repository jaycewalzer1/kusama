import assert from 'node:assert/strict';
import test from 'node:test';
import { ABSENT, envDrift, envVersionNow } from '../env-version.js';
import { normalizeArtistSampleIntents, validateArtistSampleIntents } from '../sample-planner.js';

const intents = [{
  problem: 'the subject has no resistance against the empty field',
  channel: 'negative_space' as const,
  transformation: 'exaggerate' as const,
  salience: 0.72,
  scope: 0.61,
  bindingRole: 'resisting_subject',
}];

test('artist intents normalize deterministically into singular-channel canonical requests', () => {
  const commission = { subject: 'an unsettled field', percepts: ['resistance'], avoid: ['illustration'] };
  const a = normalizeArtistSampleIntents(intents, commission, 'artist');
  const b = normalizeArtistSampleIntents(intents, commission, 'artist');
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0]!.channels, ['negative_space']);
  assert.equal(a[0]!.role, 'resisting_subject');
  assert.equal(a[0]!.origin, 'artist');
  assert.equal(a[0]!.controls.salience, 0.72);
  assert.equal(a[0]!.controls.scope, 0.61);
});

test('intent validation refuses duplicate binding roles and never pads a one-intent answer', () => {
  assert.equal(validateArtistSampleIntents(intents).length, 1);
  assert.throws(() => validateArtistSampleIntents([...intents, { ...intents[0] }]), /duplicate bindingRole/);
});

test('envVersion carries no samplingObservationHash key at all when the phase is off', () => {
  const off = envVersionNow('withheld', 'nine-returned', 1);
  // Spread, not assigned: `samplingObservationHash: undefined` would still show up in `Object.keys`
  // and so in envDrift's loop, and every sampled run would read as having drifted.
  assert.deepEqual(Object.keys(off).filter((k) => k.includes('sampling')), []);

  const on = envVersionNow('withheld', 'nine-returned', 1, [], undefined, true);
  assert.match(on.samplingObservationHash ?? '', /^[0-9a-f]{16,64}$/);
  // The phase adds one hash and moves nothing else: sampling is not part of the position, the brief,
  // the medium, the protocol, or the observation serializer the unsampled path is stamped with.
  assert.deepEqual({ ...on, samplingObservationHash: undefined }, { ...off, samplingObservationHash: undefined });
});

test('a sampled run replayed against an environment with the phase off is drift, not silence', () => {
  const recorded = envVersionNow('withheld', 'nine-returned', 1, [], undefined, true);
  const now = envVersionNow('withheld', 'nine-returned', 1);
  const drift = envDrift(recorded, now);
  assert.deepEqual(drift.map((d) => d.field), ['samplingObservationHash']);
  assert.equal(drift[0]?.current, ABSENT);
  // The other direction stays silent: a log written before the phase existed cannot disagree about it.
  assert.deepEqual(envDrift(now, recorded), []);
});

