// The dial, and the gate that keeps it from moving anything it was not asked to move.
//
// `applyInfluence` turns a direction and a signed k into constraints. Two things have to be true of
// it and neither is obvious from reading it:
//
//   1. What it emits is decidable. A constraint the existing checker returns `unverified` for is a
//      sentence, not a rule, and a sweep reporting "all constraints satisfied" over a pile of those
//      would be reporting that nobody checked anything.
//   2. What it emits is ADDITIVE. The influence layer is optional and off by default; the eleven
//      goldens, `envVersion` and `elementPackHash` are byte-identical with it in the tree. That is a
//      property of the import graph, so it is asserted by reading the import graph.
//
// The counting of what CANNOT be said is as much the point as the emitting. Three of the four layers
// produce two constraints or none, and every unsayable field is a `blocked` entry rather than a
// silent drop — so the tests below assert the size of the gap, not just the presence of the output.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTRAINT_KINDS, checkConstraint } from '../../aesthetic/kinds.js';
import type { RenderMetrics } from '../../aesthetic/types.js';
import { DESCRIPTOR_VERSION, DIMS, LAYERS, OFFSETS, ROW, type Layer, type Stats } from '../influence/descriptors.js';
import { FIELDS } from '../influence/packs.js';
import { PAIR_TEST_VERDICT } from '../influence/directions.js';
import type { DirectionsFile } from '../influence/directions.js';
import { BIZARRENESS, SYMMETRY_AXIS, applyInfluence, bizarreness, findGroup, hexToLab, outOfGamut, outsideDomain } from '../influence/apply.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Corpus stats with mean 0.5 and std 0.1 everywhere, so a target is `0.5 + k * v * 0.1` by hand. */
function stats(mean = 0.5, std = 0.1): Stats {
  return { version: DESCRIPTOR_VERSION, rows: 1000, mean: new Array(ROW).fill(mean), std: new Array(ROW).fill(std) };
}

/** A directions file with one group whose every dimension pushes by `v`, in every layer. */
function directions(v = 1, source: 'pixels' | 'authored' = 'pixels'): DirectionsFile {
  const dirs: Record<string, unknown> = {};
  for (const layer of LAYERS) {
    dirs[layer] = {
      source,
      vector: new Array(DIMS[layer]).fill(v),
      magnitude: Math.sqrt(DIMS[layer]) * Math.abs(v),
      spread: 1,
      coverage: 1,
      cohesionZ: source === 'pixels' ? -3 : null,
      cohesive: source === 'pixels',
      carriesInfluence: PAIR_TEST_VERDICT[layer],
    };
  }
  dirs['subject'] = null;
  dirs['discourse'] = null;
  return {
    version: 'v1',
    descriptorVersion: DESCRIPTOR_VERSION,
    generated: '2026-09-02T00:00:00.000Z',
    corpusRows: 1000,
    minWorks: 15,
    permutations: 200,
    pairTestVerdict: { ...PAIR_TEST_VERDICT, subject: false, discourse: false },
    groups: [{ id: 'a-hand', label: 'A Hand', kind: 'artist', works: 30, directions: dirs as never }],
    packs: [],
  };
}

const WEIGHTS = JSON.parse(readFileSync(BIZARRENESS, 'utf8')) as { weights: Record<string, number>; unreachable: Record<string, string> };

/** A program with a named palette and a ground, which is what `recolour` and `treeFacts` both read. */
function program(colors: Record<string, string>, ground = '#ffffff'): Record<string, unknown> {
  return {
    canvas: { width: 800, height: 1000, ground },
    palette: colors,
    root: {
      id: 'root',
      type: 'group',
      children: Object.keys(colors).map((name, i) => ({ id: `n${i}`, type: 'op', op: 'paint', args: { color: name } })),
    },
  };
}

function metrics(over: Partial<RenderMetrics> = {}): RenderMetrics {
  return {
    inkDensity: 0.5,
    coverage: 0.5,
    inkOffset: 0.1,
    symmetry: { vertical: 0.5, horizontal: 0.5 },
    edgeContact: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
    pixelHash: 'x',
    ...over,
  };
}

// --- what it emits ------------------------------------------------------------------------------

test('every constraint the dial emits is a kind the checker already knows and can decide', () => {
  for (const layer of LAYERS) {
    const set = applyInfluence(program({}), directions(), 'a-hand', layer, 1, stats(), WEIGHTS.weights);
    for (const c of set.constraints) {
      assert.ok((CONSTRAINT_KINDS as readonly string[]).includes(c.kind), `${c.kind} is not one of the eighteen`);
      assert.ok(c.id.startsWith('influence-a-hand-'), `${c.id} does not name its origin`);
      assert.ok(c.why.length > 40, `${c.id} does not say where it came from`);
      assert.ok(['tree', 'render'].includes(c.scope));
      assert.equal(c.severity, 'soft', 'the dial defaults to soft: it is a suggestion, not a wall');
      // Decidable, which is the whole difference between a constraint and a sentence.
      const v = checkConstraint(c, program({}), metrics());
      assert.notEqual(v.status, 'unverified', `${c.id} (${c.kind}) came back unverified`);
      assert.ok(v.evidence.length > 0);
    }
  }
});

test('the dial spends none of the eighteen kinds on a nineteenth', () => {
  const emitted = new Set(LAYERS.flatMap((l) => applyInfluence(program({}), directions(), 'a-hand', l, 1, stats(), WEIGHTS.weights).constraints.map((c) => c.kind)));
  // Three kinds out of eighteen, for four descriptor layers holding 371 dimensions between them.
  assert.deepEqual([...emitted].sort(), ['inkDensityRange', 'inkOffsetRange', 'palette']);
});

test('palette emits six colours and nothing about how much of the sheet each covers', () => {
  const set = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  assert.equal(set.constraints.length, 1);
  const [c] = set.constraints;
  assert.equal(c!.kind, 'palette');
  const allow = c!.params['allow'] as string[];
  assert.equal(allow.length, 6, 'six k-means centres, six colours');
  for (const hex of allow) assert.match(hex, /^#[0-9a-f]{6}$/, `${hex} is not a hex colour`);
  assert.equal(c!.params['includeGround'], true, 'the ground is a colour on the sheet like any other');

  // The two things a palette constraint provably cannot say, emitted as blocks rather than dropped.
  assert.deepEqual(set.blocked.map((b) => b.field).sort(), ['chromaMean', 'fractions']);
  const fractions = set.blocked.find((b) => b.field === 'fractions')!;
  assert.match(fractions.why, /55% black is satisfied by one black dot/);
});

test('palette does NOT emit maxDistinctColors, because six is a fact about k-means', () => {
  // The tempting extra constraint. Every palette descriptor in the corpus has exactly six centres
  // because k is fixed at 6 — so `maxDistinctColors: 6` would be the algorithm's parameter dressed
  // up as a claim about an artist, and it would apply identically to all 19,807 works.
  const set = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  assert.equal(set.constraints.some((c) => c.kind === 'maxDistinctColors'), false);
});

test('the palette constraint decides a real program both ways', () => {
  const set = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  const allow = set.constraints[0]!.params['allow'] as string[];

  const obeys = program({ a: allow[0]!, b: allow[1]! }, allow[2]!);
  assert.equal(checkConstraint(set.constraints[0]!, obeys, null).status, 'satisfied');

  const disobeys = program({ a: '#ff00ff' }, allow[0]!);
  const v = checkConstraint(set.constraints[0]!, disobeys, null);
  assert.equal(v.status, 'violated');
  assert.match(v.evidence, /#ff00ff/, 'the verdict names the offending colour');
});

test('armature states two of its four opinions, and blocks 98% of the layer', () => {
  // The direction pushes UP everywhere, so both symmetry targets are above the corpus mean and
  // `symmetryMax` — a ceiling — cannot ask for either. What survives is density and offset.
  const up = applyInfluence(program({}), directions(1), 'a-hand', 'armature', 1, stats(), WEIGHTS.weights);
  assert.deepEqual(up.constraints.map((c) => c.kind).sort(), ['inkDensityRange', 'inkOffsetRange']);
  const ceilings = up.blocked.filter((b) => b.blockedBy === 'symmetryMax is a ceiling, with no floor');
  assert.deepEqual(ceilings.map((b) => b.field).sort(), ['symmetryH', 'symmetryV']);

  // Push DOWN and the ceiling can state it. Half of every symmetry direction is sayable and half
  // is not, which is a property of the kind and not of this mapping.
  const down = applyInfluence(program({}), directions(-1), 'a-hand', 'armature', 1, stats(), WEIGHTS.weights);
  assert.deepEqual(down.constraints.map((c) => c.kind).sort(), ['inkDensityRange', 'inkOffsetRange', 'symmetryMax', 'symmetryMax']);

  // The 16x16 grid is 256 of the layer's 262 dimensions and nothing reads it.
  assert.ok(up.blocked.some((b) => b.field === 'grid' && b.blockedBy === 'no spatial-layout constraint'));
  assert.equal(FIELDS.armature['grid']!.len / DIMS.armature > 0.97, true);
});

test('the axis names are swapped on purpose, and both source files still say what they said', () => {
  // `descriptors.py` calls a left-right flip `h_sym`; `metrics.ts` calls the same left-right flip
  // `symmetry.vertical`, because it names the MIRROR AXIS. Matching the letters across the two
  // files would silently mirror every symmetry constraint this layer emits. Both sides are read
  // here rather than trusted, because the swap looks like a bug to anybody tidying up.
  assert.deepEqual(SYMMETRY_AXIS, { symmetryH: 'vertical', symmetryV: 'horizontal' });
  const py = readFileSync(path.join(ROOT, 'influence', 'descriptors.py'), 'utf8');
  assert.match(py, /h_sym\s*=\s*_iou\(mask,\s*np\.fliplr\(mask\)\)/, 'descriptors.py no longer defines h_sym as a left-right flip');
  const ts = readFileSync(path.join(ROOT, 'aesthetic', 'metrics.ts'), 'utf8');
  assert.match(ts, /axis === 'vertical'/, 'metrics.ts no longer branches on a vertical axis name');

  // And the emitted constraint uses the axis name the CHECKER reads, not the descriptor's.
  const down = applyInfluence(program({}), directions(-1), 'a-hand', 'armature', 1, stats(), WEIGHTS.weights);
  const axes = down.constraints.filter((c) => c.kind === 'symmetryMax').map((c) => c.params['axis']);
  assert.deepEqual(axes.sort(), ['horizontal', 'vertical']);
});

test('the two armature constraints carry the 2D caveat into their own why', () => {
  // Only 14.7% of this corpus is 2D. For the rest, the Otsu foreground is the silhouette of a pot
  // against a studio backdrop, and "make 40% of the sheet dark" is not what was measured. These
  // are the weakest things the dial produces and they say so where they will be read.
  const set = applyInfluence(program({}), directions(), 'a-hand', 'armature', 1, stats(), WEIGHTS.weights);
  for (const c of set.constraints) assert.match(c.why, /CAVEAT|14\.7%/, `${c.id} drops the 2D caveat`);
});

test('texture and form emit nothing at all, and name every field they cannot state', () => {
  // The finding this whole stage turns on: `texture` is the ONLY layer the pair test showed carries
  // influence (58/82, z=3.75) and it is the only layer with no constraint kind to carry it. Asserted
  // as an equality, so a future kind that fixed it would fail this test and have to say so.
  for (const layer of ['texture', 'form'] as const) {
    const set = applyInfluence(program({}), directions(), 'a-hand', layer, 1, stats(), WEIGHTS.weights);
    assert.equal(set.constraints.length, 0, `${layer} emitted a constraint`);
    assert.deepEqual(set.blocked.map((b) => b.field).sort(), Object.keys(FIELDS[layer]).sort());
  }
  assert.equal(PAIR_TEST_VERDICT.texture, true, 'texture passed the pair test');
  assert.equal(applyInfluence(program({}), directions(), 'a-hand', 'texture', 1, stats(), WEIGHTS.weights).carriesInfluence, true);
});

test('a layer that failed the pair test says so in every constraint it emits', () => {
  const set = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  assert.equal(set.carriesInfluence, false);
  assert.match(set.constraints[0]!.why, /the pair test did NOT show palette carries influence/);
});

test('an authored direction says so in its constraints instead of claiming works', () => {
  const set = applyInfluence(program({}), directions(1, 'authored'), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  assert.equal(set.source, 'authored');
  assert.match(set.constraints[0]!.why, /authored: no works stand behind it/);
  assert.doesNotMatch(set.constraints[0]!.why, /over 30 works/);
});

// --- k -------------------------------------------------------------------------------------------

test('k scales the target linearly and k=0 is the corpus mean', () => {
  const s = stats();
  const zero = applyInfluence(program({}), directions(), 'a-hand', 'palette', 0, s, WEIGHTS.weights);
  assert.ok(zero.target.every((v) => Math.abs(v - 0.5) < 1e-9), 'k=0 must be exactly the corpus mean');

  const one = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1, s, WEIGHTS.weights);
  const two = applyInfluence(program({}), directions(), 'a-hand', 'palette', 2, s, WEIGHTS.weights);
  // target = mean + k * v * std = 0.5 + k * 1 * 0.1
  assert.ok(Math.abs(one.target[0]! - 0.6) < 1e-9);
  assert.ok(Math.abs(two.target[0]! - 0.7) < 1e-9);

  const back = applyInfluence(program({}), directions(), 'a-hand', 'palette', -1, s, WEIGHTS.weights);
  assert.ok(Math.abs(back.target[0]! - 0.4) < 1e-9, 'a negative k walks the other way, it does not clamp');
});

test('a target off the end of the descriptor is reported per field, never clamped', () => {
  // Lab L* is bounded at 0 and 100. A big enough k walks past it, and the honest report of that is
  // "this k is off the map in these fields" — clamping would relabel a mixed target as a clean k=2.
  const impossible = outsideDomain('palette', new Array(DIMS.palette).fill(0.5).map((v, i) => (i === 0 ? -7.12 : v)));
  assert.equal(impossible.length, 1);
  assert.equal(impossible[0]!.field, 'centres');
  assert.deepEqual(impossible[0]!.range, [0, 100]);

  // A field that lands exactly on its bound is not a violation. Floating point delivers 0 as
  // -8.79e-7 and reporting "straightFraction=0 is outside 0..1" is a bug report about arithmetic.
  const onBound = new Array(DIMS.form).fill(0.5);
  // `elongation` is a ratio of the long axis to the short one, so its floor is 1, not 0 — a 0.5
  // there is genuinely off the map and the field's default fill has to be lifted onto its bound
  // before this test can say anything about EPS.
  onBound[FIELDS.form['elongation']!.at] = 1;
  onBound[FIELDS.form['straightFraction']!.at] = -1e-12;
  assert.deepEqual(outsideDomain('form', onBound), []);
});

test('an out-of-gamut colour is clamped to the nearest displayable one and the clamp is declared', () => {
  // The dial routinely walks past sRGB. Refusing to emit would hide that; emitting silently would
  // claim a colour no screen can show. So it clamps and counts, in the constraint's own `why`.
  assert.equal(outOfGamut(50, 0, 0), false, 'a neutral mid grey is displayable');
  assert.equal(outOfGamut(50, 120, -120), true);
  // Every dimension of this direction is 1000, so at k=1 each centre asks for Lab (100.5, 100.5,
  // 100.5): a colour brighter than white and more saturated than any primary. Deliberately absurd —
  // the point is that the dial does not refuse, it clamps and says how many it clamped.
  const far = applyInfluence(program({}), directions(1000), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  assert.match(far.constraints[0]!.why, /fell outside sRGB and were clamped/);
});

test('hexToLab round-trips a colour the palette constraint actually emits', () => {
  const set = applyInfluence(program({}), directions(2), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  for (const hex of set.constraints[0]!.params['allow'] as string[]) {
    const [L, a, b] = hexToLab(hex);
    assert.ok(L >= -0.5 && L <= 100.5, `${hex} decodes to L*=${L}`);
    assert.ok(Number.isFinite(a) && Number.isFinite(b));
  }
});

// --- bizarreness ---------------------------------------------------------------------------------

test('bizarreness weights live in a data file, not in a source file', () => {
  // A hardcoded weight is an unfalsifiable claim: nobody can diff it and nobody has to defend it.
  // These are a judgement with nothing behind them, and they are in a file that says so.
  const src = readFileSync(path.join(ROOT, 'artist', 'influence', 'apply.ts'), 'utf8');
  assert.doesNotMatch(src, /palette:\s*1\b/, 'a weight has been copied into apply.ts');
  assert.deepEqual(WEIGHTS.weights, { palette: 1, armature: 2, texture: 2, form: 3, subject: 5, discourse: 8 });
  const raw = readFileSync(BIZARRENESS, 'utf8');
  assert.match(raw, /nobody has calibrated them against anything/);
});

test('four of the six weights can never be spent, and the file says which', () => {
  // texture and form have no constraint kind; subject and discourse have no direction at all. Only
  // palette and armature are reachable, so the ordering the file argues for is mostly untested.
  assert.deepEqual(Object.keys(WEIGHTS.unreachable).sort(), ['discourse', 'form', 'note', 'subject', 'texture']);
  const reachable = Object.keys(WEIGHTS.weights).filter((l) => !(l in WEIGHTS.unreachable));
  assert.deepEqual(reachable.sort(), ['armature', 'palette']);
});

test('bizarreness is linear in |k| and blind to the sign', () => {
  const w = WEIGHTS.weights;
  assert.equal(bizarreness([{ layer: 'palette', k: 2 }], w), 2);
  assert.equal(bizarreness([{ layer: 'palette', k: -2 }], w), 2, 'departing backwards is as strange as forwards');
  assert.equal(bizarreness([{ layer: 'form', k: 1 }, { layer: 'palette', k: 1 }], w), 4);
  assert.equal(bizarreness([], w), 0);
  // A layer with no weight contributes nothing rather than throwing, so an unknown layer cannot
  // silently inflate a total.
  assert.equal(bizarreness([{ layer: 'invented', k: 5 }], w), 0);
});

test('bizarreness is reported on the set and is not wired into any score', () => {
  const set = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1.5, stats(), WEIGHTS.weights);
  assert.equal(set.bizarreness, 1.5);
  // The prompt's rule, asserted mechanically: nothing that computes a run's reward may read this.
  // The import path, not the bare word — `influences` was already the name of the corpus works a run
  // is shown, which reward.ts has always been allowed to talk about, and matching on the word makes
  // this test fire on a sentence about that instead of on a reachable dependency.
  const reward = readFileSync(path.join(ROOT, 'artist', 'reward.ts'), 'utf8');
  assert.doesNotMatch(reward, /bizarreness|influence\//i, 'reward.ts has learned about the influence layer');
});

// --- the additive-only gate ----------------------------------------------------------------------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sources(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

const TREE = ['artist', 'aesthetic', 'env', 'renderer', 'studio'].flatMap((d) => sources(path.join(ROOT, d)));

test('the influence layer has exactly one door, and it is a CLI', () => {
  // This is what makes the layer additive. Nothing in the loop, the checker, the environment or the
  // renderer can reach it, so no hash it does not already feed can move because it exists.
  const importers = TREE.filter((f) => /from '[^']*influence\/[^']*\.js'/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f))
    .filter((f) => !f.startsWith(path.join('artist', 'influence')))
    .sort();
  assert.deepEqual(importers, [
    path.join('artist', 'tests', 'artist-influence-apply.test.ts'),
    path.join('artist', 'tests', 'artist-influence-descriptors.test.ts'),
    path.join('artist', 'tests', 'artist-influence-directions.test.ts'),
    path.join('artist', 'tests', 'artist-influence-packs.test.ts'),
    path.join('artist', 'tests', 'artist-influence-pairs.test.ts'),
    path.join('artist', 'tests', 'artist-influence-sweep.test.ts'),
    path.join('studio', 'influence.ts'),
  ]);
});

test('nothing that feeds a hash or a score can see the influence layer', () => {
  // `envVersion` is nine hashes and every trajectory on disk carries them. If any of the files that
  // build it could reach this layer, every run collected before Stage 1 would become a different
  // experiment from every run collected after — silently, with no diff in the runs themselves.
  for (const f of ['env-version.ts', 'observation.ts', 'schemas.ts', 'affect.ts', 'reward.ts', 'run.ts', 'field.ts']) {
    const src = readFileSync(path.join(ROOT, 'artist', f), 'utf8');
    assert.doesNotMatch(src, /influence\//, `artist/${f} reaches the influence layer`);
  }
  // And the checker cannot: rule 4 puts pixel measurement on the render side, never in check.ts.
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'aesthetic', 'check.ts'), 'utf8'), /influence/);
});

test('the influence layer respects the one-way import order', () => {
  // `renderer/ <- env/ <- aesthetic/ <- artist/ <- studio/`. Living under `artist/` it may read
  // down and must never read up, and in particular must never import the CLI it is driven by.
  for (const f of sources(path.join(ROOT, 'artist', 'influence'))) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from '\.\.\/\.\.\/studio\//, `${path.relative(ROOT, f)} imports the CLI`);
    assert.doesNotMatch(src, /from '(@anthropic-ai\/sdk|openai)'/, `${path.relative(ROOT, f)} imports a model SDK`);
  }
});

test('applyInfluence reads the program and never writes to it', () => {
  // It takes a program only so the returned set can report which kinds are already constrained. A
  // dial that edited the tree would be an edit nobody recorded, on a hash nobody moved.
  const p = program({ ink: '#101010' }, '#f5f5f0');
  const before = JSON.stringify(p);
  for (const layer of LAYERS) applyInfluence(p, directions(), 'a-hand', layer, 1.5, stats(), WEIGHTS.weights);
  assert.equal(JSON.stringify(p), before, 'the program was mutated');
});

test('overlaps are reported so a caller knows it is about to hold two of the same kind', () => {
  const p = program({ ink: '#101010' });
  (p as { meta?: unknown }).meta = { constraints: [{ id: 'existing', kind: 'palette' }] };
  const set = applyInfluence(p, directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  // Reported, not resolved. Merging two palette allow-lists is a decision about the work and this
  // layer does not get to make it.
  assert.deepEqual(set.overlaps, ['palette']);
  assert.equal(set.constraints.length, 1, 'the overlap does not suppress the constraint');

  const bare = applyInfluence(program({}), directions(), 'a-hand', 'palette', 1, stats(), WEIGHTS.weights);
  assert.deepEqual(bare.overlaps, [], 'a program that states no constraints overlaps nothing');
});

test('an unknown group or an unfilled layer fails loudly rather than returning an empty set', () => {
  const file = directions();
  assert.equal(findGroup(file, 'a-hand')?.works, 30);
  assert.equal(findGroup(file, 'nobody'), undefined);
  assert.throws(() => applyInfluence(program({}), file, 'nobody', 'palette', 1, stats(), WEIGHTS.weights), /no direction for nobody/);
  // An authored pack fills only some layers. Asking it for one it declined must not quietly
  // produce a target of the corpus mean, which would render as "k=1 changed nothing".
  const sparse = directions(1, 'authored');
  (sparse.groups[0]!.directions as Record<string, unknown>)['texture'] = null;
  assert.throws(() => applyInfluence(program({}), sparse, 'a-hand', 'texture', 1, stats(), WEIGHTS.weights), /has no texture direction/);
});

test('the layer offsets the dial indexes with are the descriptor\'s own', () => {
  // `applyInfluence` reads `stats.mean[OFFSETS[layer] + i]`. A drift between this table and the
  // worker's packing would z-score a palette target against texture statistics and still return a
  // plausible number, which is the failure mode nothing downstream could detect.
  let at = 0;
  for (const l of LAYERS) {
    assert.equal(OFFSETS[l], at);
    at += DIMS[l];
  }
  assert.equal(at, ROW);
  assert.equal((LAYERS as readonly Layer[]).length, 4);
});
