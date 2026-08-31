// The three places the loop was made to act on what it already knew.
//
// Everything under test here is a pure function, on purpose. The finish gate, the contradiction
// scan and the read-back comparison are all decidable without a model, a browser or a trajectory,
// and a rule that can only be exercised by running a whole loop is a rule nobody will exercise.
//
// The loop-level assertions live in artist-loop.test.ts, which now finishes on a refusal.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { contradictions } from '../../aesthetic/contradictions.js';
import { normalizeText } from '../../aesthetic/kinds.js';
import { SELF_SCORE_FLOOR, finishBlockers, requiredStrings, unreadable } from '../gate.js';
import { loadCommission } from '../field.js';
import type { AestheticProgram, CheckReport, Constraint, ConstraintResult } from '../../aesthetic/types.js';
import type { Brief } from '../field.js';
import type { Examine } from '../types.js';

// --- fixtures ------------------------------------------------------------------------------------

function constraint(over: Partial<Constraint> & Pick<Constraint, 'id' | 'kind'>): Constraint {
  return { scope: 'tree', severity: 'hard', why: 'under test', params: {}, ...over } as Constraint;
}

function position(constraints: Constraint[]): AestheticProgram {
  return {
    version: '1.0',
    id: 'under-test',
    name: 'under test',
    worldview: '',
    lineage: [],
    tensions: [],
    commitments: constraints,
    prohibitions: [],
    generative_rules: [],
    cliches: [],
  } as unknown as AestheticProgram;
}

function result(over: Partial<ConstraintResult> & Pick<ConstraintResult, 'id'>): ConstraintResult {
  return {
    kind: 'requireNode',
    scope: 'tree',
    severity: 'hard',
    status: 'violated',
    part: 'commitment',
    evidence: 'none',
    nodeIds: [],
    why: 'under test',
    ...over,
  } as ConstraintResult;
}

function report(results: ConstraintResult[] = []): CheckReport {
  return {
    aesthetic: 'under-test',
    hardViolations: results.filter((r) => r.severity === 'hard' && r.status === 'violated').length,
    softViolations: 0,
    treeScore: 1,
    renderScore: 1,
    blocked: 0,
    pendingRubrics: [],
    results,
  };
}

function brief(contains: string[]): Brief {
  return {
    hard_constraints: contains.map((c, i) =>
      constraint({ id: `hc-${i}`, kind: 'textRequired', params: { contains: [c] } })
    ),
  } as unknown as Brief;
}

function examine(over: Partial<Examine> = {}): Examine {
  return { selfScore: 8, edgeEstimates: [], paragraph: 'it works', ...over };
}

/** A run with nothing wrong with it: the accept path, which every case below perturbs by one thing. */
function clean() {
  return {
    brief: brief(['3 MARCH']),
    report: report(),
    examine: examine(),
    transcript: [{ text: '3 March', legible: true }],
    wouldAct: 'act' as const,
    declaredUnrealizable: null,
  };
}

// --- the gate ------------------------------------------------------------------------------------

test('a piece with nothing wrong with it is allowed to stop', () => {
  assert.deepEqual(finishBlockers(clean()), []);
});

// The failure this whole file exists for: `19:00` is in the program, the sheet renders it so that a
// reader gets `10:00`, and every tree-scope check says the fact is present. Only the read-back can
// tell, and only if the reader was never told what it was looking for.
test('a required fact the eye reads as something else blocks the finish', () => {
  const blockers = finishBlockers({
    ...clean(),
    brief: brief(['19:00']),
    transcript: [{ text: '10:00', legible: true }],
  });
  assert.deepEqual(blockers.map((b) => b.kind), ['unreadable-fact']);
  assert.match(blockers[0]!.detail, /19:00/);
});

test('a fact the reader could not make out does not count as read', () => {
  assert.deepEqual(unreadable(['3 MARCH'], [{ text: '3 MARCH', legible: false }]), ['3 MARCH']);
  assert.deepEqual(unreadable(['3 MARCH'], [{ text: '3 MARCH', legible: true }]), []);
});

// The comparison has to be the checker's own, or the gap between "it is in the tree" and "it can be
// read off the sheet" is partly an artefact of two spellings of `contains`.
test('the read-back is compared exactly as the tree is: case- and whitespace-insensitive', () => {
  assert.deepEqual(unreadable(['3 MARCH'], [{ text: '3   march', legible: true }]), []);
  assert.equal(normalizeText('3   MARCH'), normalizeText('3 March'));
});

test('a transcript that was never taken blocks nothing', () => {
  assert.deepEqual(finishBlockers({ ...clean(), brief: brief(['NOT ON THE SHEET']), transcript: null }), []);
});

test('an audience that was never asked blocks nothing, and one that would walk past does', () => {
  assert.deepEqual(finishBlockers({ ...clean(), wouldAct: undefined }), []);
  assert.deepEqual(finishBlockers({ ...clean(), wouldAct: 'consider' }), []);
  assert.deepEqual(
    finishBlockers({ ...clean(), wouldAct: 'ignore' }).map((b) => b.kind),
    ['audience-ignores']
  );
});

test('the artist calling its own piece a failure reopens it', () => {
  assert.deepEqual(finishBlockers({ ...clean(), examine: examine({ selfScore: SELF_SCORE_FLOOR }) }), []);
  assert.deepEqual(
    finishBlockers({ ...clean(), examine: examine({ selfScore: SELF_SCORE_FLOOR - 1 }) }).map((b) => b.kind),
    ['self-score']
  );
});

test('a hard violation the checker already found now stops the run rather than decorating it', () => {
  const blockers = finishBlockers({ ...clean(), report: report([result({ id: 'c-voices' })]) });
  assert.deepEqual(blockers.map((b) => b.kind), ['hard-violation']);
  assert.match(blockers[0]!.detail, /c-voices/);
});

// The same rule `terminationOf` applies after the stop, applied before it: one unrealized relation
// is a decision if the artist named it, and an oversight otherwise.
test('one unrealized edge is allowed only when the artist said which', () => {
  const edge = { from: 'dates', to: 'bar', type: 'aligned-to' as const, status: 'violated' as const, evidence: 'no' };
  assert.deepEqual(
    finishBlockers({ ...clean(), examine: examine({ edgeEstimates: [edge] }) }).map((b) => b.kind),
    ['unrealized-edge']
  );
  assert.deepEqual(
    finishBlockers({
      ...clean(),
      examine: examine({ edgeEstimates: [edge] }),
      declaredUnrealizable: 'dates->bar',
    }),
    []
  );
  assert.deepEqual(
    finishBlockers({
      ...clean(),
      examine: examine({ edgeEstimates: [edge, { ...edge, from: 'bar', to: 'dates' }] }),
      declaredUnrealizable: 'dates->bar',
    }).map((b) => b.kind),
    ['unrealized-edge']
  );
});

test('the requirements come from the brief hard constraints, not from its prose', () => {
  assert.deepEqual(requiredStrings(brief(['3 MARCH', 'LOWER MARSH'])), ['3 MARCH', 'LOWER MARSH']);
});

// --- contradictions ------------------------------------------------------------------------------

test('a constraint that contradicts itself is reported against itself', () => {
  const found = contradictions(
    position([constraint({ id: 'r-dense', kind: 'inkDensityRange', scope: 'render', params: { min: 0.2, max: 0.05 } })])
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.a, 'r-dense');
  assert.equal(found[0]!.b, 'r-dense');
});

test('two windows over the same quantity that do not meet are unsatisfiable', () => {
  const found = contradictions(
    position([
      constraint({ id: 'a', kind: 'inkDensityRange', scope: 'render', params: { min: 0.3 } }),
      constraint({ id: 'b', kind: 'inkDensityRange', scope: 'render', params: { max: 0.1 } }),
    ])
  );
  assert.deepEqual(found.map((c) => [c.a, c.b]), [['a', 'b']]);
});

test('windows that overlap, and constraints over different quantities, are left alone', () => {
  assert.deepEqual(
    contradictions(
      position([
        constraint({ id: 'a', kind: 'inkDensityRange', scope: 'render', params: { min: 0.05, max: 0.3 } }),
        constraint({ id: 'b', kind: 'inkDensityRange', scope: 'render', params: { min: 0.1, max: 0.2 } }),
        constraint({ id: 'c', kind: 'coverageRange', scope: 'render', params: { min: 0.9 } }),
      ])
    ),
    []
  );
});

test('a required string and a forbidden text op cannot both hold', () => {
  const found = contradictions(
    position([
      constraint({ id: 'hc-meeting', kind: 'textRequired', params: { contains: ['3 MARCH'] } }),
      constraint({ id: 'c-mute', kind: 'forbidNode', params: { ops: ['text'] } }),
    ])
  );
  assert.deepEqual(found.map((c) => [c.a, c.b]), [['hc-meeting', 'c-mute']]);
});

test('a mark that is both required and forbidden is caught whichever order it is written in', () => {
  const found = contradictions(
    position([
      constraint({ id: 'c-no-charcoal', kind: 'forbidMark', params: { brushes: ['charcoal'] } }),
      constraint({ id: 'c-handled', kind: 'requireMark', params: { brushes: ['charcoal'], min: 3 } }),
    ])
  );
  assert.deepEqual(found.map((c) => [c.a, c.b]), [['c-handled', 'c-no-charcoal']]);
});

// Soft constraints are the trades the position exists to make. Calling a pair of them unsatisfiable
// would refuse to run the commissions that are actually interesting.
test('soft constraints are never contradictions', () => {
  assert.deepEqual(
    contradictions(
      position([
        constraint({ id: 'a', kind: 'inkDensityRange', scope: 'render', severity: 'soft', params: { min: 0.3 } }),
        constraint({ id: 'b', kind: 'inkDensityRange', scope: 'render', severity: 'soft', params: { max: 0.1 } }),
      ])
    ),
    []
  );
});

// The scan is worth nothing if it fires on the catalog. `run.ts` throws on an unsatisfiable
// commission before it makes a single policy call, so a false positive here is not a bad score, it
// is a triple the studio offers and then refuses to launch.
//
// Read off the disk rather than listed, because the studio can author new positions and briefs and a
// hardcoded list would go on passing while covering none of them.
const catalog = (dir: string) =>
  readdirSync(path.join(ROOT, 'aesthetic', dir))
    // Briefs sit beside a `<id>.field.json` companion, which is not itself a brief.
    .filter((f) => f.endsWith('.json') && !f.endsWith('.field.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();

test('every triple the catalog offers composes to something a program could satisfy', () => {
  const positions = catalog('positions');
  const briefs = catalog('briefs');
  const deliverables = catalog('deliverables');
  assert.ok(positions.length > 0 && briefs.length > 0 && deliverables.length > 0, 'catalog is empty');

  for (const positionId of positions) {
    for (const briefId of briefs) {
      for (const deliverableId of deliverables) {
        const commission = loadCommission(positionId, briefId, deliverableId);
        assert.deepEqual(
          commission.unsatisfiable,
          [],
          `${positionId} x ${briefId} x ${deliverableId}: ` +
            commission.unsatisfiable.map((c) => `${c.a} x ${c.b}: ${c.why}`).join('; ')
        );
      }
    }
  }
});
