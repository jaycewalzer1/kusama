// Step 3 of the build order: everything decidable without a browser is decided without a browser.
//
// These tests never launch Chromium. That is the point: a program that cannot be afforded, or that
// says something the profile does not allow, is refused in Node in milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProgram, validateEditAction, validateProfile } from '../validate.js';
import { loadProfile, type MediumProfile } from '../profile.js';
import { tearPointCount, tearPolygon, sprayParticleCount } from '../../renderer/resolve.js';
import { EMPTY_PACK, group, hatchNode, program, resolve, solidNode, strokeNode, testProfile, washNode } from './helpers.js';

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

test('a clip may be any convex region the profile allows, and nothing else', () => {
  // `clipShapes` is absent from default-v0, which means ["rect"], so PROFILE here is V0's answer.
  const wide = { ...PROFILE, clipShapes: ['rect', 'circle', 'polygon'] };
  const clipped = (clip: Record<string, unknown>) => {
    const g = group('g1', [hatchNode('h1', 20, 20)]);
    g['clip'] = clip;
    return program([g]);
  };
  const check = (p: MediumProfile, prog: Record<string, unknown>) =>
    validateProgram(prog, p, EMPTY_PACK).issues.map((i) => i.code);

  const circle = clipped({ type: 'circle', cx: 100, cy: 100, r: 60 });
  assert.deepEqual(check(PROFILE, circle), ['clip.notAllowed'], 'a v0 profile still clips with rects only');
  assert.deepEqual(check(wide, circle), []);

  // A square with a redundant collinear midpoint on one side: convex, and a naive cross-product
  // check that treats a zero cross as a direction change would reject it.
  const square = clipped({ type: 'polygon', points: [[20, 20], [120, 20], [220, 20], [220, 220], [20, 220]] });
  assert.deepEqual(check(wide, square), []);

  // A chevron. Sutherland-Hodgman does not fail on this, it returns a wrong shape, so the refusal
  // has to happen here or not at all.
  const chevron = clipped({ type: 'polygon', points: [[20, 20], [120, 120], [220, 20], [220, 220], [20, 220]] });
  assert.deepEqual(check(wide, chevron), ['clip.concave']);

  const tooMany = clipped({
    type: 'polygon',
    points: Array.from({ length: PROFILE.limits.maxPolygonPoints + 1 }, (_, i) => [20 + i * 0.5, 20]),
  });
  assert.ok(check(wide, tooMany).includes('limit.polygonPoints'));
});

test('a polygon clip actually clips, and nested clips intersect', () => {
  const inner = group('inner', [hatchNode('h1', 0, 0)]);
  inner['clip'] = { type: 'polygon', points: [[0, 0], [200, 0], [200, 200], [0, 200]] };
  const outer = group('outer', [inner]);
  outer['clip'] = { type: 'rect', x: 100, y: 100, w: 200, h: 200 };
  const resolved = resolve(program([outer]));
  const clip = resolved.nodes[0]!.clip!;
  const xs = clip.map(([x]) => x);
  const ys = clip.map(([, y]) => y);
  // The 0..200 square met the 100..300 rect, so the leaf sees 100..200 in both axes.
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [100, 200]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [100, 200]);
});

test('group blend is gated by the profile and reaches the leaves, nearest group winning', () => {
  const blended = (blend: string, children: Record<string, unknown>[]) => {
    const g = group(`g-${blend}`, children);
    g['blend'] = blend;
    return g;
  };

  // V0 allows none, and says so rather than drawing something that looks composited (NOTES R3).
  assert.deepEqual(codes(program([blended('multiply', [hatchNode('h1', 0, 0)])])), ['blend.notAllowed']);

  // The three p5's WEBGL path actually honours.
  const wide = { ...PROFILE, blendModes: ['normal', 'multiply', 'screen', 'exclusion', 'overlay', 'difference'] };
  const check = (blend: string) =>
    validateProgram(program([blended(blend, [hatchNode('h1', 0, 0)])]), wide, EMPTY_PACK).issues.map((i) => i.code);
  for (const ok of ['normal', 'multiply', 'screen', 'exclusion']) assert.deepEqual(check(ok), [], ok);

  // `overlay` and `difference` are refused one layer lower, by the schema, and so stay refused even
  // for a profile that names them -- which the profile above deliberately does. p5 2.2.0 accepts
  // both, ignores both, and paints the source unchanged (NOTES R11). Whether a mode is *allowed* is
  // policy and belongs to the profile; whether a mode *exists* is not, and no profile should be able
  // to promise a composite the renderer never performs.
  for (const no of ['overlay', 'difference']) {
    assert.deepEqual([...new Set(check(no))], ['schema.program'], no);
  }

  // There is no group at draw time -- the tree is flattened to leaves and each is drawn onto the one
  // canvas -- so blend has to arrive on the leaf. The nearest enclosing group wins, which is what
  // lets a subtree opt back out with `normal`.
  const resolved = resolve(
    program([
      hatchNode('plain', 0, 0),
      blended('multiply', [
        hatchNode('under-multiply', 10, 10),
        blended('normal', [hatchNode('opted-out', 20, 20)]),
      ]),
    ])
  );
  const blendOf = Object.fromEntries(resolved.nodes.map((n) => [n.id, n.blend]));
  assert.deepEqual(blendOf, { plain: null, 'under-multiply': 'multiply', 'opted-out': 'normal' });
});

test('a torn fragment edge is gated, budgeted, and the same tear every time', () => {
  const torn = (tear: Record<string, number>) => ({
    id: 'f1', type: 'op', op: 'fragment', rngKey: 'key-f1',
    args: { name: 'blob', x: 200, y: 200, span: 120, rotate: 0, tear, style: { kind: 'solid', color: 'ink', opacity: 255 } },
  });
  const check = (p: MediumProfile, node: Record<string, unknown>) =>
    validateProgram(program([node]), p, EMPTY_PACK).issues.map((i) => i.code);

  // `maxTearPoints` is absent from default-v0, so V0 fragments have clean edges and say so. V0 also
  // declares no quantize step for either field, and an undeclared step is itself an error, so a v0
  // profile refuses a tear on two independent grounds rather than one.
  assert.deepEqual(check(PROFILE, torn({ roughness: 0.4, segment: 8 })).sort(), [
    'quantize.undeclared', 'quantize.undeclared', 'tear.notAllowed',
  ]);

  const wide = {
    ...PROFILE,
    limits: { ...PROFILE.limits, maxTearPoints: 600 },
    ranges: { ...PROFILE.ranges, roughness: [0, 1] as [number, number], segment: [1, 60] as [number, number] },
    quantize: { ...PROFILE.quantize, roughness: 0.01, segment: 0.5 },
  };
  assert.deepEqual(check(wide, torn({ roughness: 0.4, segment: 8 })), []);
  // The cost of a tear is set by the outline's perimeter over the segment length, neither of which
  // is a number anybody typed. A fine deckle on a big fragment is thousands of vertices.
  const tight = { ...wide, limits: { ...wide.limits, maxTearPoints: 100 } };
  assert.ok(check(tight, torn({ roughness: 0.4, segment: 1 })).includes('limit.tearPoints'));
  assert.deepEqual(check(tight, torn({ roughness: 0.4, segment: 20 })), []);

  // The geometry itself: as many vertices as promised, displaced no further than promised, and the
  // same answer from the same stream, because the tear is what makes the fragment's shape.
  const square: [number, number][] = [[0, 0], [80, 0], [80, 80], [0, 80]];
  const tear = { roughness: 0.5, segment: 10 };
  assert.equal(tearPointCount(square, tear), 32);
  const rng = () => 1; // the extreme: every vertex pushed the full displacement outward
  const out = tearPolygon(square, tear, rng);
  assert.equal(out.length, 32);
  for (const [x, y] of out) {
    assert.ok(x >= -5.001 && x <= 85.001 && y >= -5.001 && y <= 85.001, `${x},${y} escaped roughness * segment`);
  }
  const seeded = () => {
    let s = 7;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  };
  assert.deepEqual(tearPolygon(square, tear, seeded()), tearPolygon(square, tear, seeded()));
});

test('a spray is gated, and its particle count is known exactly in Node', () => {
  const spray = (args: Record<string, unknown>) => ({
    id: 's1', type: 'op', op: 'spray', rngKey: 'key-s1',
    args: { x: 200, y: 200, r: 100, density: 0.5, falloff: 1, brush: '2B', color: 'ink', weight: 2, ...args },
  });
  const check = (p: MediumProfile, node: Record<string, unknown>) =>
    validateProgram(program([node]), p, EMPTY_PACK).issues.map((i) => i.code);

  // V0 has no aerosol. It says so by not having the limit, the same way it says a fragment may not
  // be torn -- so `default-v0` keeps its hash without being edited to refuse something it predates.
  assert.ok(check(PROFILE, spray({})).includes('spray.notAllowed'));

  const wide = {
    ...PROFILE,
    primitives: [...PROFILE.primitives, 'spray'],
    limits: { ...PROFILE.limits, maxSprayParticles: 4000 },
    ranges: { ...PROFILE.ranges, falloff: [0.2, 6] as [number, number], wander: [0, 12] as [number, number] },
    quantize: { ...PROFILE.quantize, falloff: 0.1, wander: 0.5 },
  };
  assert.deepEqual(check(wide, spray({})), []);

  // The point of computing the count here rather than discovering it in a browser: this is a
  // hundred thousand brush stamps, and it costs a millisecond to refuse.
  assert.ok(check(wide, spray({ density: 20, r: 400 })).includes('limit.sprayParticles'));

  // Exact, not estimated, and the same integer the operator will loop over. pi * 100^2 * 0.5 / 100.
  assert.equal(sprayParticleCount({ density: 0.5, r: 100 }), 157);
  assert.equal(sprayParticleCount({ density: 20, r: 400 }), 100531);

  // `falloff: 1` is a uniform disc, and that is the identity worth having: it means the parameter
  // has a meaningful zero point rather than a default somebody liked the look of. Check it against
  // the property a uniform disc actually has -- area, not radius, is uniformly distributed, so half
  // the particles fall inside r/sqrt(2).
  const sample = (falloff: number, n: number) => {
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    let inner = 0;
    for (let i = 0; i < n; i++) {
      rnd(); // the angle, drawn and discarded, exactly as the operator draws it
      if (Math.pow(rnd(), falloff / 2) < Math.SQRT1_2) inner++;
    }
    return inner / n;
  };
  assert.ok(Math.abs(sample(1, 20000) - 0.5) < 0.02, 'falloff 1 is not a uniform disc');
  assert.ok(sample(2.6, 20000) > 0.72, 'falloff above 1 should crowd the centre');
  assert.ok(sample(0.4, 20000) < 0.25, 'falloff below 1 should hollow out into a ring');
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

test("a cover's `destroys` claim is checked against the geometry, not believed", () => {
  const coverNode = (id: string, x: number, y: number, destroys?: string[]): Record<string, unknown> => ({
    id,
    type: 'op',
    op: 'cover',
    rngKey: `key-${id}`,
    args: { region: { type: 'rect', x, y, w: 100, h: 100 }, softness: 0.1, ...(destroys ? { destroys } : {}) },
  });

  // The honest case: `under` is painted first, the covering lands on top of it, and the two boxes
  // share ground. Nothing about the picture changes -- the claim is a record, not an instruction.
  assert.deepEqual(codes(program([solidNode('under', 40, 40), coverNode('c1', 60, 60, ['under'])])), []);
  assert.deepEqual(codes(program([solidNode('under', 40, 40), coverNode('c1', 60, 60)])), [], 'destroys is optional');

  // A macro answers for its own parts: they resolve as `m1/arm`, and `m1` is the only name the id
  // pattern lets a program write, so a covering over a macro names the macro.
  const motif = {
    id: 'm1', type: 'macro', macro: 'motif', rngKey: 'key-m1',
    args: { name: 'tick', x: 100, y: 100, size: 120, brush: 'HB', color: 'ink' },
  };
  assert.deepEqual(codes(program([motif, coverNode('c1', 60, 60, ['m1'])])), []);
  assert.deepEqual(codes(program([motif, coverNode('c1', 60, 60, ['m'])])), ['destroys.unknown'], 'a prefix is not a match');

  // A name with no node behind it.
  const ghost = program([solidNode('under', 40, 40), coverNode('c1', 60, 60, ['no-such-node'])]);
  assert.deepEqual(codes(ghost), ['destroys.unknown']);

  // Drawn after the covering, so it is on top of it. A covering cannot destroy what outlived it.
  const later = program([coverNode('c1', 60, 60, ['over']), solidNode('over', 40, 40)]);
  assert.deepEqual(codes(later), ['destroys.order']);

  // On the sheet, and before the covering, but nowhere near it.
  const elsewhere = program([solidNode('far', 260, 260), coverNode('c1', 10, 10, ['far'])]);
  const disjoint = validateProgram(elsewhere, PROFILE, EMPTY_PACK).issues;
  assert.deepEqual(disjoint.map((i) => i.code), ['destroys.disjoint']);
  assert.match(disjoint[0]!.message, /bounds do not overlap/);
  assert.equal(disjoint[0]!.path, '/root/children/1/args/destroys');
});

test('edit actions are schema-checked too', () => {
  const ok = {
    actionId: 'a1', kind: 'set_arg', targets: ['w1'], decisionRefs: ['d3'],
    path: 'style.opacity', value: 180, before: 140, after: 180, estimatedCost: 1,
  };
  assert.deepEqual(validateEditAction(ok), []);
  assert.ok(validateEditAction({ ...ok, kind: 'replace_program' }).length > 0, 'replace_program does not exist');
});
