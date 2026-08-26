// Step 3 of the build order: everything decidable without a browser is decided without a browser.
//
// These tests never launch Chromium. That is the point: a program that cannot be afforded, or that
// says something the profile does not allow, is refused in Node in milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProgram, validateEditAction, validateProfile } from '../env/validate.js';
import { loadProfile } from '../env/profile.js';
import { EMPTY_PACK, group, hatchNode, program, strokeNode, testProfile, washNode } from './helpers.js';

const PROFILE = testProfile();

function codes(prog: Record<string, unknown>): string[] {
  return validateProgram(prog, PROFILE, EMPTY_PACK).issues.map((i) => i.code);
}

test('the shipped profile validates against the profile schema', () => {
  assert.deepEqual(validateProfile(loadProfile('default-v0').profile), []);
});

test('a well-formed program passes and reports its budget', () => {
  const result = validateProgram(program([washNode('w1', 150, 150)]), PROFILE, EMPTY_PACK);
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
  assert.equal(result.programHash.length, 64);
  assert.ok(result.resolved, 'a valid program should come back resolved');
  assert.ok(result.budget && result.budget.marks > 0, 'a wash should be estimated as some marks');
  assert.deepEqual(result.budget?.over, []);
});

test('the same program hashes the same regardless of key order', () => {
  const a = validateProgram(program([washNode('w1', 150, 150)]), PROFILE, EMPTY_PACK);
  const reordered = program([washNode('w1', 150, 150)]);
  const b = validateProgram({ root: reordered['root'], ...reordered }, PROFILE, EMPTY_PACK);
  assert.equal(a.programHash, b.programHash);
});

test('unknown fields under an executable key fail; inert metadata does not', () => {
  const bad = washNode('w1', 150, 150);
  (bad['args'] as Record<string, unknown>)['secretMode'] = true;
  assert.ok(codes(program([bad])).includes('schema.program'));

  const annotated = washNode('w2', 150, 150);
  annotated['label'] = 'the sky';
  annotated['note'] = 'wanted this warmer';
  annotated['meta'] = { decisions: ['d17'], whateverElse: 3 };
  assert.deepEqual(codes(program([annotated])), []);
});

test('ids must be unique across the whole tree', () => {
  const dupe = program([washNode('same', 100, 100), washNode('same', 250, 250)]);
  assert.ok(codes(dupe).includes('id.duplicate'));
});

test('every drawing node must carry an rngKey', () => {
  const node = washNode('w1', 150, 150);
  delete node['rngKey'];
  assert.ok(codes(program([node])).includes('schema.program'));
});

test('numbers must sit on the profile step and inside the profile range', () => {
  const offStep = washNode('w1', 150, 150);
  (offStep['args'] as Record<string, unknown>)['region'] = { type: 'circle', cx: 150.3, cy: 150, r: 70 };
  assert.ok(codes(program([offStep])).includes('quantize'), 'cx of 150.3 is not on the 0.5 step');

  const fat = strokeNode('s1', [[20, 20], [200, 180]]);
  (fat['args'] as Record<string, unknown>)['weight'] = 3.14;
  assert.ok(codes(program([fat])).includes('quantize'), '3.14 is not on the 0.1 step');
  (fat['args'] as Record<string, unknown>)['weight'] = 20;
  assert.ok(codes(program([fat])).includes('range'), 'a weight of 20 is outside [0.1, 12]');
});

test('the profile gates operators, brushes, fonts, blend modes and palette colours', () => {
  const narrow = { ...PROFILE, primitives: ['wash'], brushes: ['pen'] };
  const withStroke = program([strokeNode('s1', [[20, 20], [200, 180]])]);
  const got = validateProgram(withStroke, narrow, EMPTY_PACK).issues.map((i) => i.code);
  assert.ok(got.includes('op.notAllowed'));
  assert.ok(got.includes('brush.notAllowed'), 'charcoal is not in the narrowed brush list');

  const unknownColour = washNode('w1', 150, 150, 'chartreuse');
  assert.ok(codes(program([unknownColour])).includes('palette.unknown'));

  const blended = group('g1', [washNode('w1', 150, 150)]);
  blended['blend'] = 'multiply';
  assert.ok(codes(program([blended])).includes('blend.notAllowed'), 'V0 allows no blend modes (NOTES R3)');
});

test('text inside a clipped group is refused rather than silently unclipped', () => {
  const text = {
    id: 't1', type: 'op', op: 'text', rngKey: 'key-t1',
    args: { text: 'LESS IS MORE', x: 40, y: 200, size: 28, font: 'grotesque', color: 'ink', align: 'left' },
  };
  const clipped = group('g1', [text]);
  clipped['clip'] = { type: 'rect', x: 0, y: 0, w: 200, h: 200 };
  assert.ok(codes(program([clipped])).includes('text.clipped'));
  assert.deepEqual(codes(program([text])), [], 'the same text unclipped is fine');
});

test('a program may only name fragments and motifs that are in its pack', () => {
  const missing = {
    id: 'f1', type: 'op', op: 'fragment', rngKey: 'key-f1',
    args: { name: 'not-a-fragment', x: 200, y: 200, span: 120, rotate: 0, style: { kind: 'solid', color: 'ink', opacity: 255 } },
  };
  assert.ok(codes(program([missing])).includes('fragment.unknown'));

  const present = { ...missing, args: { ...missing.args, name: 'blob' } };
  assert.deepEqual(codes(program([present])), []);
});

test('an over-budget repeat is refused before the browser starts', () => {
  // A 20x20 grid of tight two-layer crosshatch: legal JSON, within every structural limit, and far
  // past what the profile will pay to draw. Nothing here reaches a browser.
  const dense = hatchNode('h1', 0, 0);
  (dense['args'] as Record<string, unknown>)['style'] = {
    kind: 'hatch', brush: '2B', color: 'rust', spacing: 2, angle: 35, rand: 0.15, layers: 2,
  };
  const heavy = program([
    {
      id: 'r1', type: 'repeat', rngKey: 'key-r1', count: 400,
      layout: { type: 'grid', origin: [10, 10], cols: 20, dx: 20, dy: 20 },
      children: [dense],
    },
  ]);
  const result = validateProgram(heavy, PROFILE, EMPTY_PACK);
  assert.equal(result.valid, false);
  const over = result.issues.filter((i) => i.code === 'budget');
  assert.ok(over.length > 0, `expected a budget refusal, got ${JSON.stringify(result.issues)}`);
  assert.match(over[0]!.message, /exceeds the profile's limit/);
  // ...and the same program with a plausible instance count is affordable.
  const light = program([
    { id: 'r1', type: 'repeat', rngKey: 'key-r1', count: 4,
      layout: { type: 'grid', origin: [10, 10], cols: 2, dx: 140, dy: 140 }, children: [dense] },
  ]);
  assert.deepEqual(validateProgram(light, PROFILE, EMPTY_PACK).issues, []);
});

test('edit actions are schema-checked too', () => {
  const ok = {
    actionId: 'a1', kind: 'set_arg', targets: ['w1'], decisionRefs: ['d3'],
    path: 'style.opacity', value: 180, before: 140, after: 180, estimatedCost: 1,
  };
  assert.deepEqual(validateEditAction(ok), []);
  assert.ok(validateEditAction({ ...ok, kind: 'replace_program' }).length > 0, 'replace_program does not exist');
});
