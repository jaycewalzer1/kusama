// Cite-then-verify: the artist names what a step serves, and the constraint table decides.
//
// The tests that matter here are the ones about what is NOT counted. `undecided` must not read as a
// miss, `undefined` must not read as an empty citation list, and an empty citation list must not
// produce a flattering rate. Each of those, got wrong, turns the report into a number that rewards
// saying less — which is the failure mode of every self-reported metric.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CheckReport, ConstraintResult, Status } from '../../aesthetic/types.js';
import { warrantOf, warrantSummary, warrantText, warrantsIn, type StepWarrant } from '../warrant.js';

function report(statuses: Record<string, Status>): CheckReport {
  const results = Object.entries(statuses).map(
    ([id, status]): ConstraintResult => ({
      id,
      kind: 'requireNode',
      scope: 'tree',
      severity: 'hard',
      status,
      part: 'commitment',
      evidence: 'fixture',
      nodeIds: [],
      why: 'fixture',
    })
  );
  return {
    aesthetic: 'fixture',
    hardViolations: results.filter((r) => r.status === 'violated').length,
    softViolations: 0,
    treeScore: null,
    renderScore: null,
    blocked: 0,
    pendingRubrics: [],
    results,
  };
}

const BEFORE = report({ 'c-one': 'violated', 'c-two': 'satisfied', 'c-three': 'unverified' });

test('a citation the step made good is redeemed', () => {
  const after = report({ 'c-one': 'satisfied', 'c-two': 'satisfied', 'c-three': 'unverified' });
  const w = warrantOf(['c-one'], BEFORE, after);
  assert.deepEqual(w.checked, [{ id: 'c-one', verdict: 'redeemed', before: 'violated', after: 'satisfied' }]);
});

test('a citation the step broke is contradicted, which is worse than not citing', () => {
  const after = report({ 'c-one': 'violated', 'c-two': 'violated', 'c-three': 'unverified' });
  const w = warrantOf(['c-two'], BEFORE, after);
  assert.equal(w.checked[0]?.verdict, 'contradicted');
});

test('a real id whose verdict did not move is undecided, not a miss', () => {
  // Most work toward a constraint takes more than one step. If this were scored as a failure the
  // report would punish an artist for building something gradually.
  const w = warrantOf(['c-one', 'c-two', 'c-three'], BEFORE, BEFORE);
  assert.deepEqual(w.checked.map((c) => c.verdict), ['undecided', 'undecided', 'undecided']);
  assert.equal(warrantSummary([w]).wrongRate, 0);
});

test('an id that is not in the commission is invented and carries no statuses', () => {
  const w = warrantOf(['c-one', 'p-invented'], BEFORE, BEFORE);
  const bad = w.checked.find((c) => c.id === 'p-invented');
  assert.equal(bad?.verdict, 'invented');
  assert.equal(bad?.before, null);
  assert.equal(bad?.after, null);
});

test('the same id cited twice is one citation', () => {
  const w = warrantOf(['c-one', 'c-one', 'c-one'], BEFORE, BEFORE);
  assert.deepEqual(w.cited, ['c-one']);
  assert.equal(w.checked.length, 1);
});

test('matching is exact: a prose sentence that mentions an id is not a citation of it', () => {
  // Unlike `declarationOf`, which substring-matches because `risk` is prose. `warrant` is a list of
  // ids, so anything that is not one is a fabrication rather than a parse.
  const w = warrantOf(['this step serves c-one'], BEFORE, BEFORE);
  assert.equal(w.checked[0]?.verdict, 'invented');
});

test('a step that was asked and cited nothing is silent, and silence does not buy a clean rate', () => {
  const s = warrantSummary([warrantOf([], BEFORE, BEFORE)]);
  assert.equal(s.steps, 1);
  assert.equal(s.silent, 1);
  assert.equal(s.citations, 0);
  assert.equal(s.wrongRate, null, '0/0 must not read as a perfect record');
  assert.match(warrantText(s), /it is an empty one/);
});

test('steps with no warrant field are counted apart and left out of every rate', () => {
  // The trap this repo has hit before: an absent field read as a confident zero. A trajectory
  // recorded before `warrant` existed must not come back as a run with a spotless citation record.
  const after = report({ 'c-one': 'violated', 'c-two': 'violated', 'c-three': 'unverified' });
  const s = warrantSummary([undefined, null, warrantOf(['c-two'], BEFORE, after)]);
  assert.equal(s.notAsked, 2);
  assert.equal(s.steps, 1);
  assert.equal(s.citations, 1);
  assert.equal(s.wrongRate, 1);
  assert.match(warrantText(s), /2 step\(s\) carry no warrant field/);
});

test('wrongRate counts invented and contradicted, and nothing else', () => {
  const after = report({ 'c-one': 'satisfied', 'c-two': 'violated', 'c-three': 'unverified' });
  const s = warrantSummary([warrantOf(['c-one', 'c-two', 'c-three', 'p-nope'], BEFORE, after)]);
  assert.deepEqual(s.counts, { redeemed: 1, contradicted: 1, undecided: 1, invented: 1 });
  assert.equal(s.wrongRate, 0.5);
  assert.deepEqual(s.inventedIds, ['p-nope']);
});

test('a run with no steps at all says so rather than printing a table of zeroes', () => {
  assert.match(warrantText(warrantSummary([])), /Nothing to check/);
});

test('warrantsIn reads the stamped verdicts off step lines and preserves absence', () => {
  const w: StepWarrant = warrantOf(['c-one'], BEFORE, BEFORE);
  const lines = [
    { kind: 'trajectory-start', data: {} },
    { kind: 'step', data: { k: 1, warrant: w } },
    { kind: 'step', data: { k: 2, warrant: null } },
    { kind: 'step', data: { k: 3 } },
    { kind: 'render', data: {} },
  ] as unknown as Parameters<typeof warrantsIn>[0];
  const got = warrantsIn(lines);
  assert.equal(got.length, 3, 'only step lines');
  assert.deepEqual(got[0], w);
  assert.equal(got[1], null);
  assert.equal(got[2], undefined, 'a step line with no warrant key must stay undefined, not become null');
});

test('the ACT schema requires a warrant and describes it as ids only', () => {
  // The field is required in the schema and optional in the type, deliberately: new calls must
  // answer, old logs must still parse. If this ever becomes optional in the schema, the citations
  // stop being a fact about every step and the rates above stop meaning anything.
  return import('../schemas.js').then(({ actSchema }) => {
    const s = actSchema();
    assert.ok((s['required'] as string[]).includes('warrant'));
    const p = (s['properties'] as Record<string, { type: string; description: string }>)['warrant'];
    assert.equal(p?.type, 'array');
    assert.match(p?.description ?? '', /ids only/);
  });
});
