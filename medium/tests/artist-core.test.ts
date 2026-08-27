// The pure half of the artist: affect arithmetic, intention geometry, and the log's hash chain.
//
// Nothing here launches a browser or calls a model. That is the point of the split — these are the
// parts `reward.ts` has to be able to recompute from a log alone, so if any of them needed a
// network or a GPU, offline rescoring would be impossible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clamp,
  credulous,
  editsPerStep,
  initialAffect,
  initialArousal,
  onAcceptImproved,
  onRevert,
  onStall,
  stallThreshold,
} from '../artist/affect.js';
import { drift, estimateEdges, realization, totalDrift } from '../artist/intention.js';
import { StudioLog, readLog, verifyChain } from '../artist/studio-log.js';
import { loadCommission, effectivePosition, temperamentOf } from '../artist/field.js';
import { OBSERVATION_HASH, describeObservation, audienceObservation, findObservation } from '../artist/observation.js';
import type { Affect, Field, Intention } from '../artist/types.js';

// --- affect --------------------------------------------------------------------------------------

const FIELD = (stakesLevel: number): Field => ({
  version: '1.0',
  briefId: 'test',
  whenAndWhere: '',
  inTheAir: [],
  contested: [],
  exhausted: [],
  whoIsWatching: { audience: '', adversary: '' },
  transplants: [],
  stakesLevel,
  stakesLevelWhy: '',
});

test('affect: arousal is the field stakes, valence is the temperament', () => {
  const a = initialAffect(FIELD(0.8), -0.6);
  assert.equal(a.arousal, 0.8);
  assert.equal(a.valence, -0.6);
});

test('affect: an out-of-range stakesLevel is refused rather than clamped', () => {
  assert.throws(() => initialArousal(FIELD(1.4)), /outside 0\.\.1/);
});

test('affect: reverting raises arousal and lowers valence, accepting only raises valence', () => {
  const start: Affect = { arousal: 0.5, valence: 0 };
  assert.deepEqual(onRevert(start), { arousal: 0.6, valence: -0.1 });
  assert.deepEqual(onAcceptImproved(start), { arousal: 0.5, valence: 0.1 });
  assert.deepEqual(onStall(start), { arousal: 0.7, valence: -0.2 });
});

test('affect: both numbers stay in range however many bad steps happen', () => {
  let a: Affect = { arousal: 0.9, valence: -0.9 };
  for (let i = 0; i < 20; i++) a = onStall(a);
  assert.equal(a.arousal, 1);
  assert.equal(a.valence, -1);
  assert.deepEqual(clamp({ arousal: 5, valence: -5 }), { arousal: 1, valence: -1 });
});

test('affect: arousal buys edits per step, sourness buys patience', () => {
  assert.equal(editsPerStep({ arousal: 0, valence: 0 }), 1);
  assert.equal(editsPerStep({ arousal: 1, valence: 0 }), 5);
  assert.equal(stallThreshold({ arousal: 0, valence: 0 }), 3);
  assert.equal(stallThreshold({ arousal: 0, valence: -1 }), 6);
  // A good mood buys no extra patience: positive valence is not a licence to dawdle.
  assert.equal(stallThreshold({ arousal: 0, valence: 1 }), 3);
});

test('affect: a pleased artist is the one that listens to the describer more readily', () => {
  assert.equal(credulous({ arousal: 0, valence: 0.4 }), true);
  assert.equal(credulous({ arousal: 0, valence: 0.3 }), false);
});

// --- intention -----------------------------------------------------------------------------------

const tension = { between: 'a', and: 'b', claim: 'c' };

function intention(over: Partial<Intention> = {}): Intention {
  return {
    purpose: 'p',
    tension,
    riskMove: null,
    elements: [
      { id: 'title', role: 'the shout', nodeIds: ['t1'] },
      { id: 'date', role: 'the instruction', nodeIds: ['d1'] },
    ],
    edges: [{ from: 'title', to: 'date', type: 'aligned-to', claim: 'they share a left edge' }],
    ...over,
  };
}

function tree(nodes: Record<string, unknown>[]): unknown {
  return {
    canvas: { width: 100, height: 100, ground: '#ffffff' },
    palette: { ink: '#111111' },
    root: { id: 'root', type: 'group', children: nodes },
  };
}

test('intention: aligned-to is decided from the coordinates the artist wrote', () => {
  const aligned = tree([
    { id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } },
    { id: 'd1', type: 'op', op: 'text', args: { x: 40, y: 80, text: 'B' } },
  ]);
  const [edge] = estimateEdges(intention(), aligned);
  assert.equal(edge!.status, 'satisfied');
  assert.match(edge!.evidence, /common x=40/);

  const apart = tree([
    { id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } },
    { id: 'd1', type: 'op', op: 'text', args: { x: 55, y: 80, text: 'B' } },
  ]);
  assert.equal(estimateEdges(intention(), apart)[0]!.status, 'violated');
});

test('intention: echoes is decided from shared marks, not from shared position', () => {
  const echoes = intention({
    edges: [{ from: 'title', to: 'date', type: 'echoes', claim: 'same hand' }],
  });
  const same = tree([
    { id: 't1', type: 'op', op: 'paint', args: { style: { kind: 'hatch' }, color: '#111111' } },
    { id: 'd1', type: 'op', op: 'paint', args: { style: { kind: 'hatch' }, color: '#111111' } },
  ]);
  assert.equal(estimateEdges(echoes, same)[0]!.status, 'satisfied');

  const different = tree([
    { id: 't1', type: 'op', op: 'paint', args: { style: { kind: 'hatch' }, color: '#111111' } },
    { id: 'd1', type: 'op', op: 'paint', args: { style: { kind: 'solid' }, color: '#cc0000' } },
  ]);
  assert.equal(estimateEdges(echoes, different)[0]!.status, 'violated');
});

test('intention: the three undecidable edge types are reported, never guessed', () => {
  for (const type of ['masked-by', 'contradicts', 'answers'] as const) {
    const i = intention({ edges: [{ from: 'title', to: 'date', type, claim: 'x' }] });
    const t = tree([
      { id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } },
      { id: 'd1', type: 'op', op: 'text', args: { x: 40, y: 80, text: 'B' } },
    ]);
    assert.equal(estimateEdges(i, t)[0]!.status, 'judge-pending');
  }
});

test('intention: an element that never got made fails its edges whatever they claim', () => {
  const t = tree([{ id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } }]);
  const [edge] = estimateEdges(intention(), t);
  assert.equal(edge!.status, 'violated');
  assert.match(edge!.evidence, /not in the tree: d1/);
});

test('intention: a plan made only of unjudgeable edges scores null, not one', () => {
  const i = intention({ edges: [{ from: 'title', to: 'date', type: 'contradicts', claim: 'x' }] });
  const t = tree([
    { id: 't1', type: 'op', op: 'text', args: { x: 1, y: 1, text: 'A' } },
    { id: 'd1', type: 'op', op: 'text', args: { x: 2, y: 2, text: 'B' } },
  ]);
  const r = realization(i, t);
  assert.equal(r.score, null);
  assert.equal(r.judgePending, 1);
  assert.equal(r.elementsMade, 1);
});

test('intention: drift is zero against itself and changing the purpose dominates', () => {
  const a = intention();
  assert.equal(drift(a, a), 0);
  assert.ok(drift(a, intention({ purpose: 'something else' })) >= 0.5);
  const restructured = intention({
    elements: [{ id: 'other', role: 'r', nodeIds: [] }],
    edges: [],
  });
  assert.ok(drift(a, restructured) > 0);
  assert.equal(totalDrift([a, a, a]), 0);
});

// --- studio log ----------------------------------------------------------------------------------

test('studio log: a whole chain verifies, and every kind of damage is located', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-'));
  const log = new StudioLog(dir);
  log.append('trajectory-start', { id: 'x' });
  log.append('policy-call', { name: 'think-act' });
  log.append('trajectory-end', { outcome: 'finished' });

  const lines = readLog(log.file);
  assert.equal(lines.length, 3);
  assert.deepEqual(verifyChain(lines), []);

  // A line removed from the middle.
  assert.ok(verifyChain([lines[0]!, lines[2]!]).length > 0, 'a deleted line must break the chain');

  // A line edited in place.
  const tampered = structuredClone(lines);
  (tampered[1]!.data as { name: string }).name = 'something-else';
  const problems = verifyChain(tampered);
  assert.ok(problems.some((p) => p.seq === 1 && /own hash/.test(p.problem)));
});

test('studio log: the file on disk is one JSON object per line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-'));
  const log = new StudioLog(dir);
  log.append('note', { a: 1 });
  log.append('note', { b: 2 });
  const raw = readFileSync(log.file, 'utf8').trimEnd().split('\n');
  assert.equal(raw.length, 2);
  for (const line of raw) assert.doesNotThrow(() => JSON.parse(line));
});

// --- commission ----------------------------------------------------------------------------------

test('commission: every position carries a temperament and every brief carries a field', () => {
  const positions = [
    'berlin-rave-flyer',
    'crass-collage',
    'ikeda-austerity',
    'riot-grrrl-zine',
    'situationist-ransom',
    'underground-resistance',
  ];
  const briefs = [
    'night-market-bombing',
    'rye-lane-evictions',
    'stop-the-convoy',
    'transmission-four',
    'tresor-last-night',
  ];
  for (const p of positions) {
    for (const b of briefs) {
      const c = loadCommission(p, b);
      assert.ok(c.temperament.value >= -1 && c.temperament.value <= 1, `${p} temperament`);
      assert.ok(c.temperament.why.length > 40, `${p} temperament needs a reason`);
      assert.ok(c.field.stakesLevel >= 0 && c.field.stakesLevel <= 1, `${b} stakesLevel`);
      assert.ok(c.field.transplants.length >= 3, `${b} needs three transplants`);
      assert.ok(c.field.inTheAir.length >= 3, `${b} needs what is in the air`);
      // The brief's hard constraints are in the position the checker actually sees.
      assert.equal(
        c.effective.commitments.length,
        c.position.commitments.length + c.brief.hard_constraints.length
      );
    }
  }
});

test('commission: a position with no temperament is refused, not defaulted to neutral', () => {
  assert.throws(
    () => temperamentOf({ id: 'x', meta: {} } as never),
    /no meta.temperament/
  );
});

test('commission: a brief constraint whose id collides with the position is refused', () => {
  const position = {
    id: 'p',
    commitments: [{ id: 'shared' }],
    prohibitions: [],
  } as never;
  assert.throws(
    () => effectivePosition(position, { id: 'b', hard_constraints: [{ id: 'shared' }] } as never),
    /collides/
  );
});

// --- observation ---------------------------------------------------------------------------------

test('observation: the serializer hashes its own bytes, so an edit is a version bump', () => {
  assert.match(OBSERVATION_HASH, /^[0-9a-f]{16,64}$/);
});

test('observation: the environment describers are blind to everything but the image', () => {
  const c = loadCommission('crass-collage', 'rye-lane-evictions');
  const leak = [
    c.position.name,
    c.position.worldview.slice(0, 40),
    c.brief.title,
    c.brief.event.slice(0, 40),
    c.field.whenAndWhere.slice(0, 40),
  ];
  const describe = describeObservation();
  for (const secret of leak) {
    assert.ok(!describe.includes(secret), `DESCRIBE leaked: ${secret}`);
  }
  // AUDIENCE gets exactly one paragraph of the field and nothing else from it.
  const audience = audienceObservation(c.field.whoIsWatching.audience);
  assert.ok(audience.includes(c.field.whoIsWatching.audience));
  assert.ok(!audience.includes(c.position.name));
  assert.ok(!audience.includes(c.brief.title));
  assert.ok(!audience.includes(c.field.whoIsWatching.adversary));
  for (const line of c.field.inTheAir) assert.ok(!audience.includes(line));
});

test('observation: FIND sees the field, because that is where a problem has to come from', () => {
  const c = loadCommission('crass-collage', 'rye-lane-evictions');
  const obs = findObservation(c.position, c.brief, c.field);
  assert.ok(obs.includes(c.field.whoIsWatching.adversary));
  assert.ok(obs.includes(c.field.transplants[0]!.ref));
  assert.ok(obs.includes(c.position.worldview.slice(0, 60)));
  assert.ok(obs.includes(c.brief.hard_constraints[0]!.id));
  // The number it is told not to see: stakesLevel is the environment's, not the artist's.
  assert.ok(!obs.includes('stakesLevel'));
});
