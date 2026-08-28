// The k-seeds-per-cell batch, and the spread table that is the point of running it.
//
// The property under test is the one the old n=1 grid could not have: a score whose cells differ by
// less than the seeds within a cell differ must be reported as measuring nothing. A spread table
// that quietly reported the between-cell difference alone would present run variance as an effect,
// which is the exact error the batch exists to stop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cellName, flattenScores, parseCell, runDir, scoreSpreads, spreadText } from '../artist/grid.js';
import type { Scores } from '../artist/types.js';

function scores(over: Partial<Scores> = {}): Scores {
  return {
    tree: 1,
    render: 1,
    hardViolations: 0,
    softViolations: 0,
    realization: { score: 0.5, mechanical: 4, satisfied: 2, judgePending: 1, elementsMade: 1 },
    drift: 0,
    purposeChurn: { changed: 0, charsFirst: 10, charsLast: 10 },
    problemFindingSteps: 0,
    problemsGrounded: 3,
    destructionRate: 0,
    riskDeclared: false,
    riskMoveTaken: false,
    riskConvention: null,
    selfScore: 4,
    examineEdges: null,
    refusals: { budget: 0, capability: 0, structural: 0 },
    termination: {
      kind: 'declared-finished',
      edgesUnrealized: 0,
      unrealizedEdges: [],
      declaredUnrealizable: null,
      legitimate: true,
    },
    affectTrace: [],
    judgePending: [],
    ...over,
  };
}

test('a cell spec is position:brief:deliverable, with control as a fourth part', () => {
  assert.deepEqual(parseCell('data-austerity:arches-eviction:poster'), {
    positionId: 'data-austerity',
    briefId: 'arches-eviction',
    deliverableId: 'poster',
    control: false,
  });
  assert.equal(parseCell('data-austerity:arches-eviction:poster:control').control, true);
  assert.equal(cellName(parseCell('a:b:c:control')), 'a__b__c__control');
  assert.equal(runDir('/out', parseCell('a:b:c'), 3), '/out/a__b__c/seed-3');
});

test('a cell spec that omits the deliverable is refused rather than defaulted', () => {
  // Defaulting here would run a different experiment than the one on the command line, and the
  // difference would not surface until the scores were already paid for.
  assert.throws(() => parseCell('data-austerity:arches-eviction'), /position:brief:deliverable/);
  assert.throws(() => parseCell('a:b:c:sideways'), /position:brief:deliverable/);
  assert.throws(() => parseCell('a::c'), /empty part/);
});

test('flattening finds nested and boolean scores without being told their names', () => {
  const flat = flattenScores(scores());
  assert.equal(flat.get('realization.score'), 0.5);
  assert.equal(flat.get('termination.legitimate'), 1, 'booleans count as 0/1');
  assert.equal(flat.get('refusals.budget'), 0);
  assert.equal(flat.has('affectTrace'), false, 'traces are not scores');
  assert.equal(flat.has('riskConvention'), false, 'null is dropped, not zeroed');
});

test('a score that separates the cells by more than the within-cell spread is reported as separating', () => {
  const spreads = scoreSpreads([
    { cell: 'collision', scores: scores({ drift: 1.0 }) },
    { cell: 'collision', scores: scores({ drift: 1.1 }) },
    { cell: 'comfortable', scores: scores({ drift: 4.0 }) },
    { cell: 'comfortable', scores: scores({ drift: 4.1 }) },
  ]);
  const drift = spreads.find((s) => s.score === 'drift')!;
  assert.equal(drift.separates, true);
  assert.ok(drift.between > 2.9 && drift.between < 3.1);
  assert.ok(drift.within < 0.1);
});

test('a score whose cells differ by less than its seeds do is reported as measuring nothing', () => {
  const spreads = scoreSpreads([
    { cell: 'collision', scores: scores({ drift: 0 }) },
    { cell: 'collision', scores: scores({ drift: 4 }) },
    { cell: 'comfortable', scores: scores({ drift: 0.2 }) },
    { cell: 'comfortable', scores: scores({ drift: 4.2 }) },
  ]);
  const drift = spreads.find((s) => s.score === 'drift')!;
  assert.equal(drift.separates, false, 'between 0.2, within 2.0');
  assert.match(spreadText(spreads), /not measuring anything/);
  assert.match(spreadText(spreads), /drift/);
});

test('per-cell n is reported, so a zero spread from a single seed can be seen as such', () => {
  const spreads = scoreSpreads([
    { cell: 'a', scores: scores({ drift: 1 }) },
    { cell: 'b', scores: scores({ drift: 2 }) },
  ]);
  const drift = spreads.find((s) => s.score === 'drift')!;
  assert.deepEqual(drift.perCell.map((p) => p.stat.n), [1, 1]);
  assert.equal(drift.within, 0, 'n=1 cells have no spread, which is not the same as agreeing');
  assert.equal(drift.separates, true, 'and that is exactly why n must be read beside it');
});

test('an empty corpus says it is empty rather than reporting a clean sweep', () => {
  // The regression, not a hypothetical: a batch whose nine runs all failed on a missing API key
  // printed "Every score separated these cells by more than the spread within them" — with no
  // scores there are no failing scores, so the vacuous case read as a pass.
  const text = spreadText(scoreSpreads([]));
  assert.match(text, /no finished runs/);
  assert.doesNotMatch(text, /separated these cells/);
});

test('a single-cell corpus refuses to claim separation', () => {
  const text = spreadText(
    scoreSpreads([
      { cell: 'only', scores: scores({ drift: 1 }) },
      { cell: 'only', scores: scores({ drift: 2 }) },
    ])
  );
  assert.match(text, /Only one cell/);
  assert.match(text, /0 by construction/);
});

test('cells with one seed are named, because their zero spread is absence not agreement', () => {
  const text = spreadText(
    scoreSpreads([
      { cell: 'a', scores: scores({ drift: 1 }) },
      { cell: 'b', scores: scores({ drift: 2 }) },
    ])
  );
  assert.match(text, /fewer than two seeds/);
  assert.match(text, /unearned/);
});

test('a score that is null on some seeds is averaged over the seeds that have it', () => {
  const spreads = scoreSpreads([
    { cell: 'a', scores: scores({ tree: 1 }) },
    { cell: 'a', scores: scores({ tree: null }) },
    { cell: 'b', scores: scores({ tree: 0 }) },
  ]);
  const tree = spreads.find((s) => s.score === 'tree')!;
  assert.deepEqual(tree.perCell.map((p) => p.stat.n), [1, 1]);
  assert.equal(tree.perCell[0]!.stat.mean, 1);
});
