// Lineage elements, stage 1: the gate on composition and conflict.
//
// The claim this layer makes is that two lineages can compete for a bounded resource and that the
// competition is *provable* rather than asserted. So the tests here are mostly about what compose
// does NOT do: it does not drop a side, does not merge two constraints into one, does not turn a
// conflicted constraint into an unverified one, and does not make the score improve when two
// lineages disagree. A composition layer that quietly tidied conflicts away would score better the
// harder the blend was, which is exactly backwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { checkProgram, loadAestheticProgram } from '../aesthetic/check.js';
import { CONSTRAINT_KINDS } from '../aesthetic/kinds.js';
import type { AestheticProgram, Constraint, ConstraintResult } from '../aesthetic/types.js';
import { compose } from '../aesthetic/elements/compose.js';
import { conflictId, deriveConflicts } from '../aesthetic/elements/derive.js';
import { declaredConflicts, matchDeclared, observedConflicts } from '../aesthetic/elements/conflicts.js';
import { elementIds, elementPackHash, loadElement, loadElements } from '../aesthetic/elements/pack.js';
import { qualify, type Composition, type LineageElement, type SourceRef } from '../aesthetic/elements/types.js';
import { ROOT, Renderer } from '../env/browser.js';
import { pixelDiff, structuralDiff, changedRegions } from '../env/diff.js';
import { EMPTY_PACK, program, resolve, solidNode, strokeNode } from './helpers.js';

const BASE = 'cut-and-reset';

function position(id = BASE): AestheticProgram {
  return loadAestheticProgram(path.join(ROOT, 'aesthetic', 'positions', `${id}.json`));
}

const ALL = (): LineageElement[] => loadElements(elementIds());

/**
 * A composition read back as a position, so the shipped checker can be pointed at it. Everything
 * lands in `commitments`: `part` changes, nothing about scoring does.
 */
function asProgram(constraints: Constraint[], id = 'synthetic'): AestheticProgram {
  return {
    version: '1.0',
    id,
    name: id,
    lineage: [],
    worldview: '',
    tensions: [],
    commitments: constraints,
    prohibitions: [],
    generative_rules: [],
    cliches: [],
  };
}

/** The denominator `check.ts:score` actually divides by: decidable tree results, hard weighted 2. */
function treeDenominator(results: ConstraintResult[]): number {
  return results
    .filter((r) => r.scope === 'tree' && r.status !== 'unverified')
    .reduce((n, r) => n + (r.severity === 'hard' ? 2 : 1), 0);
}

/** A tree that exercises several kinds at once without trying to satisfy anything in particular. */
function sampleTree(): Record<string, unknown> {
  return {
    version: '0.2',
    profile: 'default-v0',
    assetPack: 'core',
    seed: 991,
    canvas: { width: 600, height: 900, ground: '#f2efe9', brushScale: 1 },
    palette: { ink: '#111111', hot: '#e8256f' },
    root: {
      id: 'root',
      type: 'group',
      children: [
        {
          id: 'blk',
          type: 'op',
          op: 'paint',
          rngKey: 'k/blk',
          args: {
            region: { type: 'rect', x: 40, y: 60, w: 300, h: 300 },
            style: { kind: 'solid', color: 'ink', opacity: 255 },
          },
        },
        {
          id: 'word',
          type: 'op',
          op: 'text',
          rngKey: 'k/word',
          args: { text: 'TONIGHT ONLY', x: 60, y: 500, size: 40, font: 'PTSans-Bold', color: 'ink', align: 'left' },
        },
      ],
    },
  };
}

// --- the pack itself ---------------------------------------------------------------------------

test('the shipped pack is four elements, every constraint a known kind, every citation non-empty', () => {
  const ids = elementIds();
  assert.equal(ids.length, 4, 'the pack should hold exactly the four selected in the pre-flight');
  for (const id of ids) {
    const e = loadElement(id);
    assert.equal(e.id, id, `${id}.json declares a different id`);
    assert.ok(e.provenance.citation.trim().length > 0, `${id} has no citation`);
    assert.ok(e.cliches.length > 0, `${id} names no cliches, so adopting it costs nothing`);
    const all = [...e.generativeRules, ...e.prohibitions];
    assert.ok(all.length >= 3, `${id} carries too little to be a position fragment`);
    for (const c of all) {
      assert.ok((CONSTRAINT_KINDS as readonly string[]).includes(c.kind), `${id}/${c.id} uses an unknown kind`);
      assert.ok(c.why.length > 0, `${id}/${c.id} states no reason`);
    }
  }
});

test('the element pack hash depends on the set of elements and not on the order they were passed', () => {
  const ids = elementIds();
  const forward = elementPackHash(loadElements(ids));
  const backward = elementPackHash(loadElements([...ids].reverse()));
  assert.equal(forward, backward);
  assert.equal(forward.length, 64);
  // And it is not a constant: dropping one element must move it, or it is hashing nothing.
  assert.notEqual(forward, elementPackHash(loadElements(ids.slice(1))));
  assert.notEqual(forward, elementPackHash([]));
});

// --- fixture 1: clean compose ------------------------------------------------------------------

test('fixture: a position and an element that agree compose to zero conflicts', () => {
  const c = compose(position(), loadElements(['rodchenko-red-black']));
  assert.deepEqual(c.conflicts, [], 'rodchenko-red-black was chosen as the element that fits cut-and-reset');
  // The constraints still all arrived. A clean compose is not an empty one.
  assert.equal(c.constraints.length, 12 + 3);
});

test('fixture: a position composed with nothing is the position, and says so in its hash', () => {
  const p = position();
  const c = compose(p, []);
  assert.deepEqual(c.conflicts, []);
  assert.equal(c.constraints.length, 12);
  assert.equal(c.elementPackHash, elementPackHash([]));
  for (const k of c.constraints) assert.equal(k.source.kind, 'position');
});

// --- fixture 2: a derived numeric conflict -----------------------------------------------------

test('fixture: two empty numeric intersections are derived, with the arithmetic in the note', () => {
  const c = compose(position(), loadElements(['kuba-shoowa-surface', 'ma-interval']));
  const ink = c.conflicts.find(
    (k) => k.tier === 'derived' && k.note.startsWith('inkDensityRange:')
  );
  assert.ok(ink, 'ink >= 0.35 against ink <= 0.18 must be derived, not declared');
  assert.match(ink.note, /\[0\.35, 0\.18\] is empty/);
  assert.deepEqual(
    [ink.a.constraintId, ink.b.constraintId].sort(),
    ['e-not-filled', 'e-worked-through']
  );

  const count = c.conflicts.find((k) => k.note.startsWith('nodeCount:'));
  assert.ok(count, 'nodeCount >= 8 against nodeCount <= 6 must be derived');
  assert.match(count.note, /\[8, 6\] is empty/);
});

// --- fixture 3: a derived budget-exhaustion conflict -------------------------------------------

test('fixture: requirements on distinct ops add up past a nodeCount ceiling', () => {
  const c = compose(position(), ALL());
  const budget = c.conflicts.filter((k) => k.note.startsWith('node budget:'));
  assert.ok(budget.length >= 2, 'each requirement that shares the blame gets its own conflict');

  // 5 paint + 6 text + 2 fragment + 5 rule = 18 against a ceiling of 6.
  for (const k of budget) {
    assert.equal(k.tier, 'derived');
    assert.match(k.note, /= 18\./);
    assert.match(k.note, /caps the tree at 6/);
    assert.ok(
      k.a.constraintId === 'e-few-things' || k.b.constraintId === 'e-few-things',
      'the ceiling must be one end of every budget conflict'
    );
  }
  // Every requirement in the sum is named as the other end, and no requirement is left out.
  const others = budget.map((k) => (k.a.constraintId === 'e-few-things' ? k.b : k.a)).map((s) => s.constraintId);
  for (const need of ['e-many-panels', 'e-twelve-sizes', 'e-the-vignette', 'e-members-under-load']) {
    assert.ok(others.includes(need), `${need} contributes to the 18 but was not reported as a side`);
  }
});

test('budget exhaustion is the case that rescues tree scope: it fires with no render metrics at all', () => {
  // The point of the budget rule is that it proves an impossibility the tree checker can decide,
  // which the ink-vs-coverage pair cannot. If it ever needed a browser it would be worthless.
  const c = compose(position(), ALL());
  assert.ok(c.conflicts.some((k) => k.note.startsWith('node budget:')));
});

// --- fixture 4: the declared render conflict ---------------------------------------------------

test('fixture: ink density against coverage is declared, cites its measurement, and is not derived', () => {
  const c = compose(position(), loadElements(['kuba-shoowa-surface', 'ma-interval']));
  const declared = c.conflicts.filter((k) => k.tier === 'declared');
  assert.equal(declared.length, 1, 'exactly one declared conflict ships');
  const d = declared[0]!;
  assert.deepEqual(
    [d.a.constraintId, d.b.constraintId].sort(),
    ['e-interval-holds', 'e-worked-through']
  );
  // A declared conflict is only as good as the measurement behind it, so the note must carry one.
  assert.match(d.note, /element-preflight\.md/);
  assert.match(d.note, /0\.2500/);
  assert.match(d.note, /29 measured programs/);
  // And it must record that the obvious version of the pair was satisfiable and got rejected.
  assert.match(d.note, /0\.40 IS satisfiable/);
});

test('the declared table is seeded only with pairs that are actually in the pack', () => {
  const table = declaredConflicts();
  assert.ok(table.length >= 1, 'an empty conflicts.json would make the declared tier a no-op');
  const known = new Set<string>();
  for (const e of ALL()) for (const c of [...e.generativeRules, ...e.prohibitions]) known.add(`${e.id}/${c.id}`);
  for (const e of [position()]) {
    for (const c of [...e.commitments, ...e.prohibitions]) known.add(`${e.id}/${c.id}`);
  }
  for (const row of table) {
    for (const side of [row.a, row.b]) {
      assert.ok(known.has(`${side.source.id}/${side.constraintId}`), `declared conflict names ${side.source.id}/${side.constraintId}, which is not in the pack`);
    }
    assert.ok(row.note.length > 80, 'a declared conflict with a one-line note is an assumption');
  }
});

test('a declared pair whose ends are not both present is not reported', () => {
  // kuba alone: the ma-interval end of the declared pair is absent, so the claim does not apply.
  const c = compose(position(), loadElements(['kuba-shoowa-surface']));
  assert.equal(c.conflicts.filter((k) => k.tier === 'declared').length, 0);
});

test('a proof outranks a claim about the same two constraints', () => {
  // Feed the declared table a row that duplicates a pair `derive` already proves. The derived one
  // must survive and the declared one must not be emitted alongside it.
  const p = position();
  const els = loadElements(['kuba-shoowa-surface', 'ma-interval']);
  const dup = {
    a: { source: { kind: 'element' as const, id: 'kuba-shoowa-surface' }, constraintId: 'e-worked-through' },
    b: { source: { kind: 'element' as const, id: 'ma-interval' }, constraintId: 'e-not-filled' },
    note: 'a claim about a pair that is already proven, which must lose',
  };
  const c = compose(p, els, [dup]);
  const id = conflictId(dup.a, dup.b);
  const hits = c.conflicts.filter((k) => k.id === id);
  assert.equal(hits.length, 1, 'the pair must be reported once, not twice');
  assert.equal(hits[0]!.tier, 'derived');
});

// --- fixture 5: three-way compose --------------------------------------------------------------

test('fixture: three elements at once conflict pairwise and the list is order-independent', () => {
  const ids = ['ma-interval', 'rodchenko-red-black', 'chromolith-broadside'];
  const forward = compose(position(), loadElements(ids));
  const backward = compose(position(), loadElements([...ids].reverse()));

  assert.ok(forward.conflicts.length >= 5, 'a three-way blend should be visibly harder than a pair');
  assert.equal(forward.elementPackHash, backward.elementPackHash);
  // Same conflicts, same order, same sides: the composition depends on the set, not the argument
  // order. Without the sort in compose.ts, `a` and `b` swapped when the arguments were reordered.
  assert.deepEqual(backward.conflicts, forward.conflicts);

  const kinds = new Set(forward.conflicts.map((k) => k.note.split(':')[0]));
  assert.ok(kinds.size >= 3, 'a three-way blend should break in more than one way');
});

// --- fixture 6: an element prohibition against the base position -------------------------------

test('fixture: an element prohibition contradicting the base position is derived, not swallowed', () => {
  // cut-and-reset commits to `c-cut-blocks`: at least three paint nodes. An element that forbids
  // paint outright contradicts the base position from the element's *prohibition* side.
  const forbidder: LineageElement = {
    id: 'test-no-paint',
    name: 'Test: nothing may be painted',
    provenance: { culture: 'test', period: 'test', note: 'synthetic, defined in the test file', citation: 'none: synthetic fixture' },
    worldviewFragment: 'A fixture, so that the element-prohibits-position direction is covered by something.',
    generativeRules: [],
    prohibitions: [
      {
        id: 'x-no-paint',
        kind: 'forbidNode',
        params: { ops: ['paint'] },
        scope: 'tree',
        severity: 'hard',
        why: 'synthetic fixture: contradicts the base position head-on',
      },
    ],
    cliches: ['the empty sheet as a statement'],
  };

  const c = compose(position(), [forbidder]);
  const hit = c.conflicts.find(
    (k) => k.a.constraintId === 'x-no-paint' || k.b.constraintId === 'x-no-paint'
  );
  assert.ok(hit, 'forbidNode paint against requireNode paint must be reported');
  assert.equal(hit.tier, 'derived');
  assert.match(hit.note, /^existence:/);
  const other = hit.a.constraintId === 'x-no-paint' ? hit.b : hit.a;
  assert.equal(other.constraintId, 'c-cut-blocks');
  assert.equal(other.source.kind, 'position');

  // Both sides are still in the constraint list. Nothing was resolved away.
  const ids = c.constraints.map((k) => k.id);
  assert.ok(ids.includes(qualify({ kind: 'element', id: 'test-no-paint' }, 'x-no-paint')));
  assert.ok(ids.includes(qualify({ kind: 'position', id: BASE }, 'c-cut-blocks')));
});

// --- fixture 7: id collision -------------------------------------------------------------------

test('fixture: an element that reuses a position constraint id composes, it does not throw', () => {
  // `effectivePosition` in artist/field.ts throws on exactly this. Here it must not: p-no-illustration
  // is already written verbatim in two positions on disk, and a pack that could not be composed
  // because two lineages named a rule the same way would make the conflict unaskable.
  const collider: LineageElement = {
    id: 'test-collider',
    name: 'Test: reuses a name the position already uses',
    provenance: { culture: 'test', period: 'test', note: 'synthetic, defined in the test file', citation: 'none: synthetic fixture' },
    worldviewFragment: 'A fixture for the id-collision path.',
    generativeRules: [
      {
        id: 'p-no-illustration',
        kind: 'requireNode',
        params: { op: 'fragment', min: 2 },
        scope: 'tree',
        severity: 'hard',
        why: 'synthetic fixture: same id as the position prohibition, opposite meaning',
      },
    ],
    prohibitions: [],
    cliches: ['naming a rule after the rule it breaks'],
  };

  const c = compose(position(), [collider]);
  const ids = c.constraints.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, 'namespacing must make every id in a composition unique');
  assert.ok(ids.includes('position:cut-and-reset/p-no-illustration'));
  assert.ok(ids.includes('element:test-collider/p-no-illustration'));

  // And the two are still recognisably in conflict — the collision did not hide it.
  const hit = c.conflicts.find((k) => k.note.startsWith('existence:'));
  assert.ok(hit, 'the collided pair still contradict each other and must be reported');
  assert.deepEqual([hit.a.source.kind, hit.b.source.kind].sort(), ['element', 'position']);
});

// --- invariant 2: purity -----------------------------------------------------------------------

test('invariant: compose is pure — a second process produces a byte-identical Composition', () => {
  const url = (rel: string): string => JSON.stringify(new URL(rel, import.meta.url).href);
  const posFile = JSON.stringify(path.join(ROOT, 'aesthetic', 'positions', `${BASE}.json`));
  const script = `
import { loadAestheticProgram } from ${url('../aesthetic/check.js')};
import { compose } from ${url('../aesthetic/elements/compose.js')};
import { loadElements, elementIds } from ${url('../aesthetic/elements/pack.js')};
const c = compose(loadAestheticProgram(${posFile}), loadElements(elementIds()));
process.stdout.write(JSON.stringify(c));
`;
  const run = (): string =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });

  const here = JSON.stringify(compose(position(), ALL()));
  const there = run();
  assert.equal(there, here, 'a fresh process disagreed with this one about the same composition');
  // Twice more in the child, so a first-run cache warm cannot be what made them agree.
  assert.equal(run(), there);
  assert.equal(JSON.parse(there).elementPackHash, elementPackHash(ALL()));
});

test('invariant: compose reads no clock, no environment and no randomness — the same call twice agrees', () => {
  const a = compose(position(), ALL());
  const b = compose(position(), ALL());
  assert.deepEqual(b, a);
  assert.equal(JSON.stringify(b), JSON.stringify(a));
});

test('the observed tier is a signature and nothing else', () => {
  assert.throws(() => observedConflicts({}), /NotImplemented/);
});

// --- invariant 3: conflicts do not shrink the denominator ---------------------------------------

test('invariant: composing does not drop, merge or silence a constraint', () => {
  const p = position();
  const els = ALL();
  const c = compose(p, els);

  const expected =
    p.commitments.length +
    p.prohibitions.length +
    p.generative_rules.filter((g) => g.constraint !== undefined).length +
    els.reduce((n, e) => n + e.generativeRules.length + e.prohibitions.length, 0);
  assert.equal(c.constraints.length, expected, 'the composition is the union or it is not the union');

  // Both ends of every conflict are still present, checkable, and carry their own severity.
  for (const k of c.conflicts) {
    for (const side of [k.a, k.b]) {
      const found = c.constraints.find((x) => x.id === qualify(side.source, side.constraintId));
      assert.ok(found, `conflict ${k.id} names ${side.constraintId}, which is not in the constraint list`);
      assert.ok(found.blocked_by === undefined || found.blocked_by.length > 0);
    }
  }
});

test('invariant: the denominator over a composition is the sum of the denominators of its parts', () => {
  const p = position();
  const els = ALL();
  const c = compose(p, els);
  const tree = sampleTree();

  const whole = treeDenominator(checkProgram(tree, asProgram(c.constraints)).results);

  let parts = treeDenominator(checkProgram(tree, p).results);
  for (const e of els) {
    parts += treeDenominator(checkProgram(tree, asProgram([...e.generativeRules, ...e.prohibitions])).results);
  }

  assert.ok(c.conflicts.length >= 10, 'this composition is supposed to be a hard one');
  assert.equal(whole, parts, 'conflict detection changed how much of the composition is being scored');
});

test('invariant: adding conflicts to the table cannot change the score', () => {
  const p = position();
  const els = loadElements(['kuba-shoowa-surface', 'ma-interval']);
  const tree = sampleTree();

  const withTable = compose(p, els);
  const withoutTable = compose(p, els, []);
  assert.ok(withTable.conflicts.length > withoutTable.conflicts.length, 'the declared table must do something');

  // Same constraints either way, so the same report either way.
  assert.deepEqual(withoutTable.constraints, withTable.constraints);
  const a = checkProgram(tree, asProgram(withTable.constraints));
  const b = checkProgram(tree, asProgram(withoutTable.constraints));
  assert.deepEqual(b.results, a.results);
  assert.equal(b.treeScore, a.treeScore);
  assert.equal(b.hardViolations, a.hardViolations);
});

test('invariant: a conflicted constraint still gets a real verdict, not an unverified one', () => {
  const c = compose(position(), ALL());
  const report = checkProgram(sampleTree(), asProgram(c.constraints));
  const conflicted = new Set<string>();
  for (const k of c.conflicts) {
    conflicted.add(qualify(k.a.source, k.a.constraintId));
    conflicted.add(qualify(k.b.source, k.b.constraintId));
  }
  assert.ok(conflicted.size >= 8);

  for (const r of report.results.filter((x) => conflicted.has(x.id))) {
    if (r.scope !== 'tree') continue;
    if (r.blocked_by !== undefined) continue;
    assert.notEqual(r.status, 'unverified', `${r.id} is in a conflict and came back undecided anyway`);
  }
});

// --- invariant 4: the pending share -------------------------------------------------------------

test('invariant: composing adds no judge-pending constraints, so the pending share is the position\'s', () => {
  const p = position();
  const c = compose(p, ALL());
  const tree = sampleTree();

  const base = checkProgram(tree, p);
  const blended = checkProgram(tree, asProgram(c.constraints));

  assert.equal(blended.pendingRubrics.length, base.pendingRubrics.length, 'an element smuggled in a rubric');
  assert.equal(blended.blocked, base.blocked, 'an element smuggled in a blocked_by');
  for (const e of ALL()) {
    for (const k of [...e.generativeRules, ...e.prohibitions]) {
      assert.notEqual(k.kind, 'rubric', `${e.id}/${k.id} is a rubric, which no stage-1 element may carry`);
      assert.equal(k.blocked_by, undefined, `${e.id}/${k.id} declares blocked_by, which no stage-1 element may carry`);
    }
  }
  // 12 conflicts and not one extra permanently-undecided result. Elements DO add unverified results
  // — six render-scope constraints checked with metrics = null — but "unmeasured" is not the same
  // thing as "unjudgeable", and only the second kind is what a pending cap exists to catch. So the
  // claim is the sharper one: everything an element adds to the undecided pile becomes decidable the
  // moment an image exists.
  assert.ok(c.conflicts.length >= 10);
  const undecided = (r: { results: ConstraintResult[] }): ConstraintResult[] =>
    r.results.filter((x) => x.status === 'unverified');
  const extra = undecided(blended).length - undecided(base).length;
  assert.ok(extra > 0, 'the elements carry render-scope constraints, so there should be some');

  const metrics = {
    inkDensity: 0.22,
    coverage: 0.45,
    inkOffset: 0.3,
    symmetry: { vertical: 0.5, horizontal: 0.5 },
    pixelHash: 'x'.repeat(64),
  };
  const measured = checkProgram(tree, asProgram(c.constraints), metrics);
  const measuredBase = checkProgram(tree, p, metrics);
  assert.equal(
    undecided(measured).length,
    undecided(measuredBase).length,
    'an element added a constraint that stays undecided even once the sheet has been measured'
  );
});

test('invariant: nothing in artist/ imports the elements layer this stage, so the loop is untouched', () => {
  const artist = path.join(ROOT, 'artist');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []
    );
  const files = walk(artist);
  assert.ok(files.length >= 5, 'the scan found almost nothing, so it is scanning the wrong tree');
  for (const f of files) {
    assert.doesNotMatch(
      readFileSync(f, 'utf8'),
      /aesthetic\/elements\//,
      `${path.relative(ROOT, f)} imports the elements layer, but stage 1 must not be wired into a run`
    );
  }
});

// --- invariant 5: determinism, three layers ------------------------------------------------------

const SLOW = { timeout: 180_000 };

/**
 * The medium-level claim underneath the whole layer: adopting an element means appending nodes, and
 * appending nodes may not disturb what was already on the sheet. Checked at all three levels the
 * repo already knows how to check — seeds, spillover, and the whole image.
 */
test('invariant: appending element-driven nodes leaves every pre-existing node seed untouched', () => {
  const before = resolve(program([solidNode('a', 20, 20), strokeNode('t', [[30, 300], [120, 250], [200, 320]])]));
  // What adopting `e-many-panels` (requireNode paint, min 5) looks like: more paint nodes, appended.
  const after = resolve(
    program([
      solidNode('a', 20, 20),
      strokeNode('t', [[30, 300], [120, 250], [200, 320]]),
      solidNode('b', 200, 20),
      solidNode('c', 200, 200),
    ])
  );

  const seeds = (p: typeof before): Map<string, number> =>
    new Map(p.nodes.map((n) => [n.id, n.seed]));
  const was = seeds(before);
  const is = seeds(after);
  assert.ok(was.size >= 2);
  for (const [id, seed] of was) {
    assert.equal(is.get(id), seed, `${id}'s seed moved when unrelated nodes were appended`);
  }
});

test('invariant: an element-driven append stays inside the boxes it declared', SLOW, async () => {
  const beforeProg = program([solidNode('a', 20, 20), strokeNode('t', [[30, 300], [120, 250], [200, 320]])]);
  const afterProg = program([
    solidNode('a', 20, 20),
    strokeNode('t', [[30, 300], [120, 250], [200, 320]]),
    solidNode('b', 200, 20),
  ]);
  const before = resolve(beforeProg);
  const after = resolve(afterProg);
  const boxes = changedRegions(before, after, structuralDiff(before, after));

  const renderer = await Renderer.launch();
  try {
    const a = await renderer.render(before, EMPTY_PACK);
    const b = await renderer.render(after, EMPTY_PACK);
    const d = pixelDiff(a.rgba, b.rgba, a.width, a.height, boxes);
    assert.ok(d.differing > 0, 'the appended node painted nothing, so this proves nothing');
    assert.ok(d.spillover < 0.05, `spillover ${d.spillover.toFixed(4)} is over the 0.05 budget`);
  } finally {
    await renderer.close();
  }
});

test('invariant: appending a node that paints nothing leaves the image hash identical', SLOW, async () => {
  const base = program([solidNode('a', 20, 20), strokeNode('t', [[30, 300], [120, 250], [200, 320]])]);
  // A paint node entirely off the 400x400 canvas: a real node in the tree, no marks on the sheet.
  const withNoop = program([
    solidNode('a', 20, 20),
    strokeNode('t', [[30, 300], [120, 250], [200, 320]]),
    solidNode('offsheet', 900, 900),
  ]);

  const renderer = await Renderer.launch();
  try {
    const a = await renderer.render(resolve(base), EMPTY_PACK);
    const b = await renderer.render(resolve(withNoop), EMPTY_PACK);
    const hash = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
    assert.equal(hash(b.rgba), hash(a.rgba), 'a node that paints nothing changed the picture');
  } finally {
    await renderer.close();
  }
});

// --- the guard that stops the whole mechanism becoming a no-op -----------------------------------

test('the pack is chosen so that at least two pairs conflict, one of them in render scope', () => {
  const c = compose(position(), ALL());
  const byScope = (id: string, source: SourceRef): Constraint | undefined =>
    c.constraints.find((k) => k.id === qualify(source, id));

  const renderConflicts = c.conflicts.filter((k) => {
    const a = byScope(k.a.constraintId, k.a.source);
    const b = byScope(k.b.constraintId, k.b.source);
    return a?.scope === 'render' && b?.scope === 'render';
  });
  assert.ok(renderConflicts.length >= 1, 'the brief requires a render-scope conflict with a measured empty intersection');
  assert.ok(
    renderConflicts.some((k) => k.tier === 'declared' && /element-preflight/.test(k.note)),
    'the render-scope conflict must be the measured one'
  );

  const treeConflicts = c.conflicts.filter((k) => {
    const a = byScope(k.a.constraintId, k.a.source);
    const b = byScope(k.b.constraintId, k.b.source);
    return a?.scope === 'tree' && b?.scope === 'tree';
  });
  assert.ok(treeConflicts.length >= 1, 'a layer whose only conflicts need a browser cannot be searched over');
  assert.ok(treeConflicts.every((k) => k.tier === 'derived'), 'tree-scope conflicts should be provable');
});

test('deriveConflicts is stable under its own input order and never pairs a constraint with itself', () => {
  const p = position();
  const els = ALL();
  const flat = [
    ...p.commitments.map((constraint) => ({ constraint, source: { kind: 'position' as const, id: p.id } })),
    ...p.prohibitions.map((constraint) => ({ constraint, source: { kind: 'position' as const, id: p.id } })),
    ...els.flatMap((e) =>
      [...e.generativeRules, ...e.prohibitions].map((constraint) => ({
        constraint,
        source: { kind: 'element' as const, id: e.id },
      }))
    ),
  ];
  const forward = deriveConflicts(flat).map((k) => k.id).sort();
  const backward = deriveConflicts([...flat].reverse()).map((k) => k.id).sort();
  assert.deepEqual(backward, forward);
  assert.equal(new Set(forward).size, forward.length, 'the same pair was reported twice');
  for (const k of deriveConflicts(flat)) {
    assert.notEqual(
      qualify(k.a.source, k.a.constraintId),
      qualify(k.b.source, k.b.constraintId),
      'a constraint was put in conflict with itself'
    );
  }
});

test('matchDeclared ignores rows it cannot ground in the composition it was given', () => {
  const rows = [
    {
      a: { source: { kind: 'element' as const, id: 'not-in-the-pack' }, constraintId: 'nope' },
      b: { source: { kind: 'position' as const, id: BASE }, constraintId: 'p-shouting' },
      note: 'a row naming an element that is not here',
    },
  ];
  const p = position();
  const flat = p.prohibitions.map((constraint) => ({
    constraint,
    source: { kind: 'position' as const, id: p.id },
  }));
  assert.deepEqual(matchDeclared(flat, rows), []);
});

// --- the composition read as a whole -------------------------------------------------------------

test('a hard blend scores worse than a clean one, which is the point of running the experiment', () => {
  const tree = sampleTree();
  const clean = compose(position(), loadElements(['rodchenko-red-black']));
  const hard = compose(position(), ALL());

  const a = checkProgram(tree, asProgram(clean.constraints));
  const b = checkProgram(tree, asProgram(hard.constraints));
  assert.ok(a.treeScore !== null && b.treeScore !== null);
  // Not because conflicts were counted — they are not in the score at all — but because a blend
  // that cannot be satisfied leaves violations on the sheet. If this ever inverted, composition
  // would have started tidying, and the layer would be measuring its own tidying.
  assert.ok(b.treeScore! <= a.treeScore!, 'the harder blend scored better, which means something is being dropped');
  assert.ok(b.hardViolations >= a.hardViolations);
});

test('a Composition serialises to JSON and back without losing a conflict or a source', () => {
  const c = compose(position(), ALL());
  const round = JSON.parse(JSON.stringify(c)) as Composition;
  assert.deepEqual(round, c);
  for (const k of round.conflicts) {
    assert.ok(['derived', 'declared', 'observed'].includes(k.tier));
    assert.ok(k.note.length > 20, `conflict ${k.id} has no usable note`);
    assert.equal(k.id.length, 64);
  }
});
