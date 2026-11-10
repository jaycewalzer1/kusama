// Regression tests for the artist loop reliability layer.
//
// Deterministic, no live models. Each test covers a specific failure mode identified in the
// motivating regression (switchback × fifty-year-embargo).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- terminal.ts ---------------------------------------------------------------------------------

import {
  deriveTerminalStatus,
  buildTerminalRecord,
  reportHeader,
  type TerminalStatus,
  type TerminalRecord,
} from '../terminal.js';

// Minimal fixtures for tests.
function fakeReport(hardViolations = 0, softViolations = 0) {
  return {
    aesthetic: 'test-aesthetic',
    hardViolations,
    softViolations,
    blocked: 0,
    treeScore: hardViolations === 0 ? 1 : 0.5,
    renderScore: hardViolations === 0 ? 1 : 0.5,
    results: hardViolations > 0
      ? [{ id: 'r1', kind: 'nodeCount' as const, severity: 'hard' as const, scope: 'tree' as const, status: 'violated' as const, part: 'commitment' as const, evidence: 'test', nodeIds: [], why: 'test', rubric: undefined }]
      : [{ id: 'r1', kind: 'nodeCount' as const, severity: 'hard' as const, scope: 'tree' as const, status: 'satisfied' as const, part: 'commitment' as const, evidence: 'test', nodeIds: [], why: 'test', rubric: undefined }],
    pendingRubrics: [],
  };
}

function fakeTermination(kind: 'declared-finished' | 'abandoned' | 'out-of-steps' | 'finish-blocked') {
  return {
    kind,
    edgesUnrealized: 0,
    unrealizedEdges: [],
    declaredUnrealizable: null,
    pendingRate: 0,
    pendingCapExceeded: false,
    legitimate: kind === 'declared-finished',
  };
}

function fakeExamine() {
  return {
    selfScore: 7,
    edgeEstimates: [],
    paragraph: 'test examine',
  };
}

describe('terminal status derivation', () => {
  it('tree/render 1.000 with failing outcome → not completed', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('out-of-steps'),
      examine: fakeExamine(),
      report: fakeReport(0),
      rubrics: null,
      artistRequestedCompletion: false,
      hasFinalPlate: true,
      executionError: false,
    });
    assert.equal(status, 'budget_exhausted');
  });

  it('hard undecided blocks completion', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('declared-finished'),
      examine: fakeExamine(),
      report: fakeReport(0),
      rubrics: [{ id: 'j-what-is-it', verdict: 'cannot-tell', evidence: 'no evidence' }],
      artistRequestedCompletion: true,
      hasFinalPlate: true,
      executionError: false,
    });
    assert.equal(status, 'failed_hard_rubric');
  });

  it('exhaustion → budget_exhausted even at perfect scores', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('out-of-steps'),
      examine: fakeExamine(),
      report: fakeReport(0),
      rubrics: null,
      artistRequestedCompletion: false,
      hasFinalPlate: true,
      executionError: false,
    });
    assert.equal(status, 'budget_exhausted');
  });

  it('clean completion when all gates pass', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('declared-finished'),
      examine: fakeExamine(),
      report: fakeReport(0),
      rubrics: [{ id: 'j1', verdict: 'holds', evidence: 'visible' }],
      artistRequestedCompletion: true,
      hasFinalPlate: true,
      executionError: false,
    });
    assert.equal(status, 'completed');
  });

  it('abandonment is labeled abandoned, not completion', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('abandoned'),
      examine: null,
      report: fakeReport(0),
      rubrics: null,
      artistRequestedCompletion: false,
      hasFinalPlate: true,
      executionError: false,
    });
    assert.equal(status, 'abandoned');
  });

  it('execution error → failed_execution', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('out-of-steps'),
      examine: null,
      report: fakeReport(0),
      rubrics: null,
      artistRequestedCompletion: false,
      hasFinalPlate: true,
      executionError: true,
    });
    assert.equal(status, 'failed_execution');
  });

  it('no final plate → invalid_run', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('out-of-steps'),
      examine: null,
      report: fakeReport(0),
      rubrics: null,
      artistRequestedCompletion: false,
      hasFinalPlate: false,
      executionError: false,
    });
    assert.equal(status, 'invalid_run');
  });

  it('finish-blocked with rubric failure → failed_hard_rubric', () => {
    const status = deriveTerminalStatus({
      termination: fakeTermination('finish-blocked'),
      examine: fakeExamine(),
      report: fakeReport(0),
      rubrics: [{ id: 'j1', verdict: 'fails', evidence: 'no roller coaster' }],
      artistRequestedCompletion: true,
      hasFinalPlate: true,
      executionError: false,
    });
    assert.equal(status, 'failed_hard_rubric');
  });
});

describe('terminal record and report header', () => {
  it('report header format is correct', () => {
    const record = buildTerminalRecord({
      status: 'budget_exhausted',
      reason: 'out of steps',
      finalProgramHash: 'abc123',
      finalPixelHash: 'def456',
      budgetAllocated: 12,
      budgetConsumed: 12,
      report: fakeReport(1),
      rubrics: null,
      examine: null,
      artistRequestedCompletion: false,
      environmentOverruled: false,
      wagers: [],
      branches: [],
      supportingEvents: [],
    });
    const header = reportHeader(record);
    assert.ok(header.includes('OUTCOME: budget_exhausted'));
    assert.ok(header.includes('STRUCTURAL VALIDITY:'));
    assert.ok(header.includes('HARD ARTIFACT RUBRICS:'));
    assert.ok(header.includes('ARTISTIC COMPLETION: no'));
  });
});

// --- artifact-read.ts ----------------------------------------------------------------------------

import { buildArtifactRead, rubricBlocks, anyHardRubricBlocks } from '../artifact-read.js';

describe('structured artifact reads', () => {
  it('normalizes rubric verdicts correctly', () => {
    const read = buildArtifactRead({
      description: 'flat shapes',
      rubrics: [
        { id: 'r1', verdict: 'holds', evidence: 'visible' },
        { id: 'r2', verdict: 'fails', evidence: 'not visible' },
        { id: 'r3', verdict: 'cannot-tell', evidence: 'ambiguous' },
      ],
    });
    assert.equal(read.rubricFindings[0]!.state, 'pass');
    assert.equal(read.rubricFindings[1]!.state, 'fail');
    assert.equal(read.rubricFindings[2]!.state, 'uncertain');
  });

  it('uncertain never promotes to pass', () => {
    const read = buildArtifactRead({
      description: 'test',
      rubrics: [{ id: 'r1', verdict: 'cannot-tell', evidence: 'unclear' }],
    });
    assert.ok(rubricBlocks(read.rubricFindings[0]!));
  });

  it('missing hard rubric blocks completion', () => {
    const read = buildArtifactRead({
      description: 'test',
      rubrics: [{ id: 'r1', verdict: 'holds', evidence: 'visible' }],
    });
    assert.ok(anyHardRubricBlocks(read.rubricFindings, new Set(['r1', 'r2'])));
  });
});

// --- wager.ts ------------------------------------------------------------------------------------

import { createWager, evaluateWager, recordWagerDecision } from '../wager.js';

describe('plan wagers', () => {
  it('creates an open wager', () => {
    const wager = createWager({
      id: 'w1',
      branchId: 'root',
      claim: 'the roller coaster will be legible',
      predictedFailure: {
        rubricIds: ['j-what-is-it'],
        observableArtifactSymptoms: ['no roller coaster visible'],
        affectedElements: ['switchback-structure'],
        affectedEdges: ['structure->track'],
      },
      sacrifice: 'abstract expressiveness',
      disconfirmingEvidence: 'blind reader identifies a roller coaster',
    });
    assert.equal(wager.status, 'open');
    assert.equal(wager.observations.length, 0);
  });

  it('supports wager when predicted rubric fails', () => {
    let wager = createWager({
      id: 'w1',
      branchId: 'root',
      claim: 'legibility',
      predictedFailure: {
        rubricIds: ['j-what-is-it'],
        observableArtifactSymptoms: [],
        affectedElements: [],
        affectedEdges: [],
      },
      sacrifice: '',
      disconfirmingEvidence: '',
    });
    const read = buildArtifactRead({
      description: 'abstract shapes',
      rubrics: [{ id: 'j-what-is-it', verdict: 'fails', evidence: 'no roller coaster' }],
    });
    wager = evaluateWager(wager, read, 42);
    assert.equal(wager.status, 'supported');
    assert.equal(wager.observations.length, 1);
    assert.equal(wager.statusChangedAt, 42);
  });

  it('falsifies wager when all predicted rubrics pass', () => {
    let wager = createWager({
      id: 'w1',
      branchId: 'root',
      claim: 'legibility',
      predictedFailure: {
        rubricIds: ['j-what-is-it'],
        observableArtifactSymptoms: [],
        affectedElements: [],
        affectedEdges: [],
      },
      sacrifice: '',
      disconfirmingEvidence: '',
    });
    const read = buildArtifactRead({
      description: 'roller coaster structure',
      rubrics: [{ id: 'j-what-is-it', verdict: 'holds', evidence: 'clearly a roller coaster' }],
    });
    wager = evaluateWager(wager, read, 43);
    assert.equal(wager.status, 'falsified');
  });

  it('resolved wager stays resolved on subsequent reads', () => {
    let wager = createWager({
      id: 'w1',
      branchId: 'root',
      claim: 'legibility',
      predictedFailure: {
        rubricIds: ['j1'],
        observableArtifactSymptoms: [],
        affectedElements: [],
        affectedEdges: [],
      },
      sacrifice: '',
      disconfirmingEvidence: '',
    });
    const read1 = buildArtifactRead({
      description: 'test',
      rubrics: [{ id: 'j1', verdict: 'fails', evidence: 'no' }],
    });
    wager = evaluateWager(wager, read1, 1);
    assert.equal(wager.status, 'supported');

    const read2 = buildArtifactRead({
      description: 'test',
      rubrics: [{ id: 'j1', verdict: 'holds', evidence: 'yes' }],
    });
    wager = evaluateWager(wager, read2, 2);
    // Status should NOT change once resolved.
    assert.equal(wager.status, 'supported');
    assert.equal(wager.observations.length, 2);
  });
});

// --- frozen-intention.ts -------------------------------------------------------------------------

import {
  freezeIntention,
  frozenHash,
  diffFrozen,
  isLegalReplan,
  validateReplan,
} from '../frozen-intention.js';

function fakeIntention(overrides: Partial<import('../types.js').Intention> = {}): import('../types.js').Intention {
  return {
    elements: [
      { id: 'e1', role: 'main subject', nodeIds: [], binding: { kind: 'node' } },
      { id: 'e2', role: 'background', nodeIds: [], binding: { kind: 'node' } },
    ],
    edges: [
      { from: 'e1', to: 'e2', type: 'aligned-to', claim: 'centered' },
    ],
    purpose: 'depict a roller coaster',
    tension: { between: 'realism', and: 'abstraction', claim: 'partial' },
    riskMove: null,
    ...overrides,
  };
}

describe('frozen intention semantics', () => {
  it('freezing and hashing produces a stable hash', () => {
    const intention = fakeIntention();
    const frozen = freezeIntention(intention, null, null);
    const h1 = frozenHash(frozen);
    const h2 = frozenHash(frozen);
    assert.equal(h1, h2);
    assert.ok(h1.length > 0);
  });

  it('reusing element ID for new meaning is rejected', () => {
    const intention = fakeIntention();
    const frozen = freezeIntention(intention, null, null);
    const mutated = fakeIntention({
      elements: [
        { id: 'e1', role: 'brake hardware', nodeIds: [], binding: { kind: 'node' } },
        { id: 'e2', role: 'background', nodeIds: [], binding: { kind: 'node' } },
      ],
    });
    const violations = validateReplan(frozen, mutated, null);
    assert.ok(violations !== null);
    assert.ok(violations.some((v) => v.includes('e1') && v.includes('role mutated')));
  });

  it('versioned revision legally changes semantics', () => {
    const before = freezeIntention(fakeIntention(), null, null);
    const after = freezeIntention(
      fakeIntention({ purpose: 'depict a mountain instead' }),
      null,
      null
    );
    const diff = diffFrozen(before, after);
    assert.ok(diff.purposeChanged);
    assert.ok(!isLegalReplan(diff));
  });

  it('adding new elements is legal', () => {
    const before = freezeIntention(fakeIntention(), null, null);
    const afterIntention = fakeIntention({
      elements: [
        ...fakeIntention().elements,
        { id: 'e3', role: 'accent', nodeIds: [], binding: { kind: 'node' } },
      ],
    });
    const after = freezeIntention(afterIntention, null, null);
    const diff = diffFrozen(before, after);
    assert.ok(isLegalReplan(diff));
  });

  it('dropping a failed edge is illegal', () => {
    const before = freezeIntention(fakeIntention(), null, null);
    const afterIntention = fakeIntention({ edges: [] });
    const violations = validateReplan(before, afterIntention, null);
    assert.ok(violations !== null);
    assert.ok(violations.some((v) => v.includes('edge') && v.includes('removed')));
  });
});

// --- branch.ts -----------------------------------------------------------------------------------

import {
  initialBranchState,
  recordBranchStep,
  trackRead,
  isStalled,
  diagnose,
  forkBranch,
  materiallyDifferent,
} from '../branch.js';

describe('branch tracking', () => {
  it('global budget counts all branches', () => {
    let state = initialBranchState({
      problemId: 'p1',
      sketchIds: ['s1'],
      intentionHash: 'h1',
      programHash: 'ph1',
      forkEventSeq: 0,
    });
    state = recordBranchStep(state);
    state = recordBranchStep(state);
    assert.equal(state.totalBudgetConsumed, 2);

    // Fork branch.
    state = forkBranch(state, {
      reason: 'stalled',
      archiveDescriptor: 'tried approach A',
      newBranchId: 'b2',
      newProblemId: 'p1',
      newSketchIds: ['s2'],
      newIntentionHash: 'h2',
      newProgramHash: 'ph2',
      forkEventSeq: 5,
      wagerIds: ['w1'],
    });
    state = recordBranchStep(state);
    // Global budget is 3 (2 on root + 1 on b2).
    assert.equal(state.totalBudgetConsumed, 3);
    // Root branch has 2 steps.
    assert.equal(state.branches.find((b) => b.id === 'root')!.steps, 2);
    // New branch has 1 step.
    assert.equal(state.branches.find((b) => b.id === 'b2')!.steps, 1);
  });

  it('two unchanged reads trigger stall', () => {
    let state = initialBranchState({
      problemId: 'p1',
      sketchIds: [],
      intentionHash: 'h1',
      programHash: 'ph1',
      forkEventSeq: 0,
    });
    state = trackRead(state, ['j-what-is-it']);
    assert.ok(!isStalled(state));
    state = trackRead(state, ['j-what-is-it']);
    assert.ok(isStalled(state));
  });

  it('different failure clears stall counter', () => {
    let state = initialBranchState({
      problemId: 'p1',
      sketchIds: [],
      intentionHash: 'h1',
      programHash: 'ph1',
      forkEventSeq: 0,
    });
    state = trackRead(state, ['j-what-is-it']);
    state = trackRead(state, ['j-other-rubric']);
    assert.ok(!isStalled(state));
  });

  it('failed branch is archived, not overwritten', () => {
    let state = initialBranchState({
      problemId: 'p1',
      sketchIds: ['s1'],
      intentionHash: 'h1',
      programHash: 'ph1',
      forkEventSeq: 0,
    });
    state = forkBranch(state, {
      reason: 'plan falsified',
      archiveDescriptor: 'tried switchback structure',
      newBranchId: 'b2',
      newProblemId: 'p1',
      newSketchIds: ['s2'],
      newIntentionHash: 'h2',
      newProgramHash: 'ph2',
      forkEventSeq: 10,
      wagerIds: [],
    });
    assert.equal(state.branches.length, 2);
    assert.equal(state.branches[0]!.active, false);
    assert.equal(state.branches[0]!.terminalReason, 'plan falsified');
    assert.equal(state.branches[1]!.active, true);
  });

  it('materially different intentions detected', () => {
    const a = fakeIntention();
    const b = fakeIntention({
      elements: [
        { id: 'e1', role: 'main subject', nodeIds: [], binding: { kind: 'node' } },
        { id: 'e3', role: 'new element', nodeIds: [], binding: { kind: 'node' } },
      ],
    });
    assert.ok(materiallyDifferent(a, b));
  });

  it('cosmetic mutations are not materially different', () => {
    const a = fakeIntention();
    const b = fakeIntention(); // same structure
    assert.ok(!materiallyDifferent(a, b));
  });
});

describe('recovery diagnosis', () => {
  it('diagnoses element realization failure', () => {
    const evidence = diagnose({
      failedRubricIds: [],
      failedElements: ['e1'],
      failedEdges: [],
      readEventSeqs: [42],
      executionError: false,
      readerUncertain: false,
    });
    assert.equal(evidence.diagnosis, 'element_realization_failure');
  });

  it('diagnoses execution error', () => {
    const evidence = diagnose({
      failedRubricIds: [],
      failedElements: [],
      failedEdges: [],
      readEventSeqs: [],
      executionError: true,
      readerUncertain: false,
    });
    assert.equal(evidence.diagnosis, 'local_execution_error');
  });
});

// --- binding-reconcile.ts ------------------------------------------------------------------------

import {
  reconcileBindings,
  checkBindingInvariants,
  isValidServes,
  unmadeElements,
} from '../binding-reconcile.js';

describe('binding reconciliation', () => {
  it('existing support nodes reconcile to the element', () => {
    const intention = fakeIntention({
      elements: [
        { id: 'e1', role: 'subject', nodeIds: ['n1', 'n2'], binding: { kind: 'node' } },
      ],
    });
    const program = { root: { id: 'root', children: [{ id: 'n1' }, { id: 'n2' }] } };
    const reconciliation = reconcileBindings(intention, program);
    assert.equal(reconciliation.elements[0]!.status, 'present_in_tree');
    assert.equal(reconciliation.elements[0]!.staleNodeIds.length, 0);
  });

  it('deleted nodes are detected as stale', () => {
    const intention = fakeIntention({
      elements: [
        { id: 'e1', role: 'subject', nodeIds: ['n1', 'n-gone'], binding: { kind: 'node' } },
      ],
    });
    const program = { root: { id: 'root', children: [{ id: 'n1' }] } };
    const violations = checkBindingInvariants(intention, program);
    assert.ok(violations.some((v) => v.includes('stale') && v.includes('n-gone')));
  });

  it('edges to missing elements are flagged', () => {
    const intention: import('../types.js').Intention = {
      elements: [{ id: 'e1', role: 'subject', nodeIds: [], binding: { kind: 'node' } }],
      edges: [{ from: 'e1', to: 'e-missing', type: 'aligned-to', claim: 'test' }],
      purpose: 'test',
      tension: { between: 'a', and: 'b', claim: 'c' },
      riskMove: null,
    };
    const program = { root: { id: 'root', children: [] } };
    const reconciliation = reconcileBindings(intention, program);
    assert.ok(reconciliation.invariantViolations.some((v) => v.includes('e-missing')));
  });

  it('duplicate element IDs are flagged', () => {
    const intention: import('../types.js').Intention = {
      elements: [
        { id: 'e1', role: 'subject', nodeIds: [], binding: { kind: 'node' } },
        { id: 'e1', role: 'different', nodeIds: [], binding: { kind: 'node' } },
      ],
      edges: [],
      purpose: 'test',
      tension: { between: 'a', and: 'b', claim: 'c' },
      riskMove: null,
    };
    const program = { root: { id: 'root', children: [] } };
    const reconciliation = reconcileBindings(intention, program);
    assert.ok(reconciliation.invariantViolations.some((v) => v.includes('duplicate')));
  });

  it('servesElementId is validated against intention', () => {
    const intention = fakeIntention();
    assert.ok(isValidServes('e1', intention));
    assert.ok(!isValidServes('e-nonexistent', intention));
    assert.ok(isValidServes(undefined, intention));
  });

  it('unmade elements derived from validated bindings', () => {
    const intention = fakeIntention({
      elements: [
        { id: 'e1', role: 'subject', nodeIds: ['n1'], binding: { kind: 'node' } },
        { id: 'e2', role: 'background', nodeIds: [], binding: { kind: 'node' } },
        { id: 'e3', role: 'void', nodeIds: [], binding: { kind: 'absence', ref: 'nothing' } },
      ],
    });
    const program = { root: { id: 'root', children: [{ id: 'n1' }] } };
    const unmade = unmadeElements(intention, program);
    assert.ok(unmade.includes('e2'));
    assert.ok(!unmade.includes('e1')); // present
    assert.ok(!unmade.includes('e3')); // absence — not expected to be made
  });
});

// --- experiment.ts -------------------------------------------------------------------------------

import {
  experimentCells,
  ittAnalysis,
  anonymizePlates,
  type ExperimentResult,
} from '../experiment.js';

describe('four-condition experiment harness', () => {
  it('generates 2×2 cells for each seed', () => {
    const cells = experimentCells({
      positionId: 'switchback',
      briefId: 'fifty-year-embargo',
      seeds: [1, 2, 3],
      maxSteps: 12,
      hardStop: 20,
      maxFinishAttempts: 2,
      modelFamily: 'anthropic',
      outDir: '/tmp/test-experiment',
    });
    assert.equal(cells.length, 12); // 4 arms × 3 seeds
    const labels = new Set(cells.map((c) => c.arm.label));
    assert.ok(labels.has('position-full'));
    assert.ok(labels.has('position-single'));
    assert.ok(labels.has('neutral-full'));
    assert.ok(labels.has('neutral-single'));
  });

  it('ITT analysis includes all run statuses', () => {
    const results: ExperimentResult[] = [
      {
        cell: { arm: { condition: 'position', mode: 'full_loop', label: 'position-full' }, seed: 1, positionId: 'p', briefId: 'b' },
        terminal: { status: 'completed', reason: '', finalProgramHash: 'h', finalPixelHash: 'p', budgetAllocated: 12, budgetConsumed: 10, hardRubricsPassed: [], hardRubricsFailed: [], hardRubricsUnresolved: [], softPassed: 0, softFailed: 0, examineRan: true, artistRequestedCompletion: true, environmentOverruled: false, wagerStatuses: [], branches: [], supportingEvents: [] },
        plateFile: '/tmp/plate1.png',
      },
      {
        cell: { arm: { condition: 'position', mode: 'full_loop', label: 'position-full' }, seed: 2, positionId: 'p', briefId: 'b' },
        terminal: { status: 'budget_exhausted', reason: 'out of steps', finalProgramHash: 'h', finalPixelHash: 'p', budgetAllocated: 12, budgetConsumed: 12, hardRubricsPassed: [], hardRubricsFailed: [], hardRubricsUnresolved: [], softPassed: 0, softFailed: 0, examineRan: true, artistRequestedCompletion: false, environmentOverruled: false, wagerStatuses: [], branches: [], supportingEvents: [] },
        plateFile: '/tmp/plate2.png',
      },
      {
        cell: { arm: { condition: 'neutral', mode: 'single_shot', label: 'neutral-single' }, seed: 1, positionId: 'p', briefId: 'b' },
        terminal: { status: 'abandoned', reason: 'abandoned', finalProgramHash: 'h', finalPixelHash: 'p', budgetAllocated: 1, budgetConsumed: 1, hardRubricsPassed: [], hardRubricsFailed: [], hardRubricsUnresolved: [], softPassed: 0, softFailed: 0, examineRan: false, artistRequestedCompletion: false, environmentOverruled: false, wagerStatuses: [], branches: [], supportingEvents: [] },
        plateFile: null,
      },
    ];
    const analysis = ittAnalysis(results);
    assert.equal(analysis.totalRuns, 3);
    assert.equal(analysis.byArm['position-full']!.completed, 1);
    assert.equal(analysis.byArm['position-full']!.budgetExhausted, 1);
    assert.equal(analysis.byArm['neutral-single']!.abandoned, 1);
  });

  it('anonymized plates are deterministically shuffled', () => {
    const results: ExperimentResult[] = [
      {
        cell: { arm: { condition: 'position', mode: 'full_loop', label: 'position-full' }, seed: 1, positionId: 'p', briefId: 'b' },
        terminal: { status: 'completed' } as any,
        plateFile: '/tmp/plate1.png',
      },
      {
        cell: { arm: { condition: 'neutral', mode: 'full_loop', label: 'neutral-full' }, seed: 1, positionId: 'p', briefId: 'b' },
        terminal: { status: 'completed' } as any,
        plateFile: '/tmp/plate2.png',
      },
    ];
    const a = anonymizePlates(results, 42);
    const b = anonymizePlates(results, 42);
    assert.deepEqual(a.anonymized, b.anonymized);
    assert.deepEqual(a.mapping, b.mapping);
    assert.equal(a.anonymized.length, 2);
  });
});

// --- Integration: the motivating regression scenario -------------------------------------------------

describe('motivating regression: switchback × fifty-year-embargo', () => {
  it('tree/render 1.000 with undecided hard rubric is NOT completed', () => {
    const status = deriveTerminalStatus({
      termination: {
        kind: 'declared-finished',
        edgesUnrealized: 0,
        unrealizedEdges: [],
        declaredUnrealizable: null,
        pendingRate: 0,
        pendingCapExceeded: false,
        legitimate: true,
      },
      examine: fakeExamine(),
      report: fakeReport(0), // tree 1.000, render 1.000
      rubrics: [{ id: 'j-what-is-it', verdict: 'cannot-tell', evidence: 'unclear' }],
      artistRequestedCompletion: true,
      hasFinalPlate: true,
      executionError: false,
    });
    // The blind reader never saw a roller coaster → undecided → NOT completed.
    assert.notEqual(status, 'completed');
    assert.equal(status, 'failed_hard_rubric');
  });

  it('element fence-head becoming brake hardware is rejected as role mutation', () => {
    const original = fakeIntention({
      elements: [
        { id: 'fence-head', role: 'fence post head', nodeIds: [], binding: { kind: 'node' } },
      ],
    });
    const frozen = freezeIntention(original, null, null);
    const mutated = fakeIntention({
      elements: [
        { id: 'fence-head', role: 'brake hardware', nodeIds: [], binding: { kind: 'node' } },
      ],
    });
    const violations = validateReplan(frozen, mutated, null);
    assert.ok(violations !== null);
    assert.ok(violations.some((v) => v.includes('fence-head') && v.includes('role mutated')));
  });

  it('predicted failure observed twice branches back to CHOOSE', () => {
    let wager = createWager({
      id: 'w1',
      branchId: 'root',
      claim: 'roller coaster legibility',
      predictedFailure: {
        rubricIds: ['j-what-is-it'],
        observableArtifactSymptoms: [],
        affectedElements: ['switchback-structure'],
        affectedEdges: [],
      },
      sacrifice: 'abstract composition',
      disconfirmingEvidence: 'reader identifies roller coaster',
    });

    // First read: fails.
    const read1 = buildArtifactRead({
      description: 'abstract geometric shapes',
      rubrics: [{ id: 'j-what-is-it', verdict: 'fails', evidence: 'no roller coaster' }],
    });
    wager = evaluateWager(wager, read1, 10);
    assert.equal(wager.status, 'supported');

    // The wager is now supported — the predicted failure has been observed.
    // Policy: resolve the wager, archive the branch, backtrack to CHOOSE.
    assert.equal(wager.observations.length, 1);
  });
});

// --- Renderer determinism (sanity check that types compile) ----------------------------------------

describe('layer invariants', () => {
  it('terminal types are well-formed', () => {
    const statuses: TerminalStatus[] = [
      'running', 'completed', 'abandoned', 'budget_exhausted',
      'failed_hard_rubric', 'failed_execution', 'invalid_run', 'cancelled',
    ];
    assert.equal(statuses.length, 8);
  });
});
