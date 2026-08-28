// The gate: six authored fixtures, six expected reports.
//
// Three positions, each with a tree that satisfies every tree-scope constraint and a tree that
// violates exactly two named ones. The failing tree's `meta.violates` is the expectation, so the
// fixture carries its own contract and a drifting checker cannot be quietly re-baselined.
//
// These are checked with metrics = null. Render-scope constraints therefore come back `unverified`,
// which is what makes "exactly two violations" a statement about the tree scope alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { checkProgram, constraintsOf, loadAestheticProgram, validateAestheticProgram } from '../aesthetic/check.js';
import { CONSTRAINT_KINDS } from '../aesthetic/kinds.js';
import { validateProgram } from '../env/validate.js';
import { loadPack } from '../env/pack.js';
import { loadProfile } from '../env/profile.js';

// Read off disk rather than listed, so a position added or renamed cannot leave the gate quietly
// checking a smaller set than exists.
const AESTHETICS = readdirSync(path.join(ROOT, 'aesthetic', 'positions'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => f.slice(0, -'.json'.length));

function programFile(id: string): string {
  return path.join(ROOT, 'aesthetic', 'positions', `${id}.json`);
}

function fixture(id: string, kind: 'pass' | 'fail'): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, 'aesthetic', 'fixtures', `${id}-${kind}.json`), 'utf8')) as Record<string, unknown>;
}

function declaredViolations(tree: Record<string, unknown>): string[] {
  const meta = tree['meta'] as Record<string, unknown> | undefined;
  const list = meta?.['violates'];
  return Array.isArray(list) ? (list as string[]) : [];
}

test('the pure half of the layer imports no browser, so a search loop pays for no browser', () => {
  // check/facts/kinds/types are the modules a search loop calls per candidate edit. measure.ts is
  // the browser half and is deliberately not in this list. If this fails, someone reached for
  // something in env/browser.ts (usually a path constant) and dragged Playwright in behind it.
  for (const file of ['check.ts', 'facts.ts', 'kinds.ts', 'types.ts']) {
    const source = readFileSync(path.join(ROOT, 'aesthetic', file), 'utf8');
    const imports = source.match(/^\s*import[\s\S]*?from\s+'[^']+';/gm) ?? [];
    for (const line of imports) {
      assert.doesNotMatch(line, /env\/browser\.js/, `aesthetic/${file} must not import env/browser.js`);
      assert.doesNotMatch(line, /\.\/measure\.js/, `aesthetic/${file} must not import ./measure.js`);
      assert.doesNotMatch(line, /playwright/, `aesthetic/${file} must not import playwright`);
    }
  }
});

test('every aesthetic program is schema-valid and uses only the closed kind set', () => {
  for (const id of AESTHETICS) {
    const raw = JSON.parse(readFileSync(programFile(id), 'utf8')) as unknown;
    assert.deepEqual(validateAestheticProgram(raw), [], `${id} failed the aesthetic program schema`);

    const ap = loadAestheticProgram(programFile(id));
    assert.equal(ap.id, id);
    for (const { constraint } of constraintsOf(ap)) {
      assert.ok((CONSTRAINT_KINDS as readonly string[]).includes(constraint.kind), `${id}/${constraint.id} uses an unknown kind`);
    }
  }
});

test('each program states a position: lineage, tensions, rules, cliches, and at least one judge rubric', () => {
  for (const id of AESTHETICS) {
    const ap = loadAestheticProgram(programFile(id));
    assert.ok(ap.lineage.length >= 5, `${id} needs five references`);
    assert.ok(ap.worldview.split(/\s+/).length < 150, `${id} worldview is over 150 words`);
    assert.ok(ap.tensions.length >= 3, `${id} needs three tensions`);
    assert.ok(ap.generative_rules.length >= 3 && ap.generative_rules.length <= 5, `${id} needs three to five rules`);
    assert.ok(ap.cliches.length >= 6 && ap.cliches.length <= 10, `${id} needs six to ten cliches`);

    const all = constraintsOf(ap).map((c) => c.constraint);
    const decidable = all.filter((c) => c.blocked_by === undefined);
    assert.ok(decidable.filter((c) => c.scope === 'tree').length >= 5, `${id} needs tree-scope constraints that can actually be decided`);
    assert.ok(decidable.filter((c) => c.scope === 'render').length >= 1, `${id} needs a render-scope constraint`);
    const rubrics = all.filter((c) => c.kind === 'rubric');
    assert.ok(rubrics.length >= 1 && rubrics.length <= 2, `${id} needs one or two judge rubrics`);
    assert.ok(all.some((c) => c.blocked_by !== undefined), `${id} should name what the medium cannot say`);
  }
});

test('every fixture is a program the medium accepts', () => {
  assert.ok(AESTHETICS.length >= 2, 'a gate over one position is not a gate');
  const { profile } = loadProfile('default-v0');
  const pack = loadPack('core');
  for (const id of AESTHETICS) {
    for (const kind of ['pass', 'fail'] as const) {
      const result = validateProgram(fixture(id, kind), profile, pack);
      assert.deepEqual(result.issues, [], `${id}-${kind} is not a valid program`);
      assert.equal(result.programHash.length, 64);
    }
  }
});

test('the pass fixture of every program violates nothing and scores 1 on the tree', () => {
  for (const id of AESTHETICS) {
    const report = checkProgram(fixture(id, 'pass'), loadAestheticProgram(programFile(id)));
    const violated = report.results.filter((r) => r.status === 'violated');
    assert.deepEqual(violated.map((r) => r.id), [], `${id}-pass should satisfy everything decidable`);
    assert.equal(report.hardViolations, 0);
    assert.equal(report.softViolations, 0);
    assert.equal(report.treeScore, 1, `${id}-pass should score 1 on tree scope`);
  }
});

test('the fail fixture of every program violates precisely the two constraints it names', () => {
  for (const id of AESTHETICS) {
    const tree = fixture(id, 'fail');
    const expected = declaredViolations(tree).slice().sort();
    assert.equal(expected.length, 2, `${id}-fail must declare exactly two violations`);

    const report = checkProgram(tree, loadAestheticProgram(programFile(id)));
    const got = report.results.filter((r) => r.status === 'violated').map((r) => r.id).sort();
    assert.deepEqual(got, expected, `${id}-fail reported the wrong set`);
    assert.equal(report.hardViolations + report.softViolations, 2);
    assert.ok(report.treeScore !== null && report.treeScore < 1);
  }
});

test('a violation always arrives with evidence naming a node or a measured number', () => {
  for (const id of AESTHETICS) {
    const report = checkProgram(fixture(id, 'fail'), loadAestheticProgram(programFile(id)));
    for (const r of report.results.filter((x) => x.status === 'violated')) {
      assert.ok(r.evidence.length > 0, `${id}/${r.id} violated with no evidence`);
      assert.notEqual(r.evidence, 'absent');
      assert.ok(r.why.length > 0);
    }
  }
});

test('render scope is unverified and judge rubrics are returned unread when nothing measured them', () => {
  for (const id of AESTHETICS) {
    const report = checkProgram(fixture(id, 'pass'), loadAestheticProgram(programFile(id)));
    assert.equal(report.renderScore, null, `${id} should not score render scope without metrics`);
    for (const r of report.results.filter((x) => x.scope === 'render')) assert.equal(r.status, 'unverified');
    assert.ok(report.pendingRubrics.length >= 1, `${id} should hand its rubrics back`);
    for (const p of report.pendingRubrics) assert.ok(p.text.length > 40, `${id}/${p.id} rubric is too thin to judge with`);
    assert.ok(report.blocked >= 1, `${id} should report its blocked constraints`);
  }
});

test('scoring weights hard double and excludes everything undecided', () => {
  const ap = loadAestheticProgram(programFile('interference'));
  const pass = checkProgram(fixture('interference', 'pass'), ap);
  const fail = checkProgram(fixture('interference', 'fail'), ap);

  // Both fixtures have the same shape of decidable tree constraints; the fail one misses two hard.
  const decidable = pass.results.filter((r) => r.scope === 'tree' && r.status !== 'unverified');
  const total = decidable.reduce((n, r) => n + (r.severity === 'hard' ? 2 : 1), 0);
  const lost = fail.results
    .filter((r) => r.status === 'violated')
    .reduce((n, r) => n + (r.severity === 'hard' ? 2 : 1), 0);

  assert.equal(pass.treeScore, 1);
  assert.equal(fail.treeScore, (total - lost) / total);
  assert.ok(lost === 4, 'both of this fixture\'s violations are hard, so it should lose four weighted points');
});
