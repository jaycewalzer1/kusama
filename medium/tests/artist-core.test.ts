// The pure half of the artist: affect arithmetic, intention geometry, and the log's hash chain.
//
// Nothing here launches a browser or calls a model. That is the point of the split — these are the
// parts `reward.ts` has to be able to recompute from a log alone, so if any of them needed a
// network or a GPU, offline rescoring would be impossible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import {
  RENDER_MEASURES,
  bindingOf,
  carryNodeIds,
  declarationScores,
  declared,
  drift,
  estimateEdges,
  examineAgreement,
  PENDING_CAP,
  purposeChurn,
  realization,
  riskDeclared,
  terminationOf,
  totalDrift,
} from '../artist/intention.js';
import { envDrift } from '../artist/env-version.js';
import { refusalCause, refusalTally } from '../artist/env.js';
import { declarationOf, unplannedViolation } from '../artist/triggers.js';
import { StudioLog, readLog, verifyChain } from '../artist/studio-log.js';
import { loadCommission, effectivePosition, temperamentOf } from '../artist/field.js';
import { OBSERVATION_HASH, describeObservation, audienceObservation, findObservation } from '../artist/observation.js';
import { ROOT } from '../env/browser.js';
import type { CheckReport, RenderMetrics } from '../aesthetic/types.js';
import type { Affect, EdgeEstimate, Field, Intention } from '../artist/types.js';

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

// The test above puts both elements in the tree, so it passes whether the type gate runs first or
// last, and the regression it is named after is the one where it ran last. This is the case that
// tells them apart: an undecidable edge is undecidable whether or not its elements got made, and
// calling it `violated` also counted it in the denominator that `realization` divides by.
test('intention: an undecidable edge stays undecidable when its element is missing too', () => {
  const i = intention({ edges: [{ from: 'title', to: 'date', type: 'contradicts', claim: 'x' }] });
  const t = tree([{ id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } }]);
  const [edge] = estimateEdges(i, t);
  assert.equal(edge!.status, 'judge-pending');
  assert.equal(realization(i, t).mechanical, 0, 'and it is not in the denominator');
});

// --- bindings ------------------------------------------------------------------------------------
//
// A binding exists to stop the scoring punishing an artist for declaring an absence or a ratio as
// part of its plan, WITHOUT handing it an unfalsifiable way out. Its predecessor, `locatable:
// false`, was a bare assertion that an element was unreachable from the tree; it named no referent,
// so no evidence could contradict it and the only cost of claiming it for everything was a null
// score. The tests below are the pair: what the binding must now refuse, and what must not have
// moved underneath it.

const oneNode = () => tree([{ id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } }]);

test('intention: a declared absence is judged, not marked missing', () => {
  const i = intention({
    elements: [
      { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'node' } },
      {
        id: 'absence',
        role: 'the logo nobody printed',
        nodeIds: [],
        binding: { kind: 'absence', ref: 'the council crest' },
      },
    ],
    edges: [{ from: 'title', to: 'absence', type: 'aligned-to', claim: 'the gap sits on the margin' }],
  });
  const [edge] = estimateEdges(i, oneNode());
  assert.equal(edge!.status, 'judge-pending');
  assert.match(edge!.evidence, /deliberate absence of the council crest/);
  const r = realization(i, oneNode());
  // One element on the sheet, made. The absence is not in the denominator at all.
  assert.equal(r.elementsMade, 1);
  // And binding everything away from the tree earns nothing: null, never 1.
  assert.equal(r.score, null);
});

// MUST MOVE. This is the case `locatable: false` could not see: an element that claims to be a
// relation between things that were never declared. Under the boolean it was judge-pending — the
// same verdict as an honest absence — so a plan could route any edge it liked away from the tree by
// asserting a relation over nothing. A ratio has to name its terms, and the terms are checked.
test('intention: a ratio over elements the plan never declared is broken, not pending', () => {
  const i = intention({
    elements: [
      { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'node' } },
      { id: 'gap', role: 'the size differential', nodeIds: [], binding: { kind: 'ratio', ref: 'title ghost' } },
    ],
    edges: [{ from: 'title', to: 'gap', type: 'aligned-to', claim: 'the gap opens on the margin' }],
  });
  const [edge] = estimateEdges(i, oneNode());
  assert.equal(edge!.status, 'violated');
  assert.match(edge!.evidence, /never declares: ghost/);
  // And, being decidable, it is back in the denominator it used to slip out of.
  assert.equal(realization(i, oneNode()).mechanical, 1);
});

test('intention: a ratio over elements that do exist is judged, and stays out of the denominator', () => {
  const i = intention({
    elements: [
      { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'node' } },
      { id: 'date', role: 'the instruction', nodeIds: [], binding: { kind: 'node' } },
      { id: 'gap', role: 'the size differential', nodeIds: [], binding: { kind: 'ratio', ref: 'title, date' } },
    ],
    edges: [{ from: 'title', to: 'gap', type: 'aligned-to', claim: 'the gap opens on the margin' }],
  });
  const [edge] = estimateEdges(i, oneNode());
  assert.equal(edge!.status, 'judge-pending');
  assert.equal(realization(i, oneNode()).mechanical, 0);
});

test('intention: a render-measure binding must name a number this medium actually takes', () => {
  const bound = (ref: string) =>
    intention({
      elements: [
        { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'node' } },
        { id: 'weight', role: 'how heavy the sheet reads', nodeIds: [], binding: { kind: 'render-measure', ref } },
      ],
      edges: [{ from: 'title', to: 'weight', type: 'echoes', claim: 'the shout carries the weight' }],
    });
  assert.equal(estimateEdges(bound('inkDensity'), oneNode())[0]!.status, 'judge-pending');
  const invented = estimateEdges(bound('vibe'), oneNode())[0]!;
  assert.equal(invented.status, 'violated');
  assert.match(invented.evidence, /not a measure this medium takes/);
});

// The list is written out in intention.ts so that no browser module sits behind the offline
// rescorer. This is the seam that keeps the copy honest: the literal below is typed as the
// aesthetic layer's own RenderMetrics, so renaming a field there fails to compile here.
test('intention: the render-measure vocabulary is the aesthetic layer own', () => {
  const metrics: RenderMetrics = {
    inkDensity: 0,
    coverage: 0,
    inkOffset: 0,
    symmetry: { vertical: 0, horizontal: 0 },
    pixelHash: '',
  };
  const names = Object.keys(metrics)
    .filter((k) => k !== 'pixelHash')
    .flatMap((k) => (k === 'symmetry' ? ['symmetry.vertical', 'symmetry.horizontal'] : [k]));
  assert.deepEqual(names.sort(), [...RENDER_MEASURES].sort());
});

// MUST MOVE. A `region` is the one binding that is HARDER than `node`, and it is the answer to the
// obvious worry about letting the policy declare its own binding: the kinds that leave the tree all
// cost something, and the one extra kind that stays in it costs more than the default.
test('intention: a region element written outside its own rectangle did not get made', () => {
  const region = (ref: string) =>
    intention({
      elements: [
        { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'region', ref } },
        { id: 'date', role: 'the instruction', nodeIds: ['d1'], binding: { kind: 'node' } },
      ],
    });
  const t = tree([
    { id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } },
    { id: 'd1', type: 'op', op: 'text', args: { x: 40, y: 80, text: 'B' } },
  ]);
  assert.equal(realization(region('0,0,100,50'), t).elementsMade, 1, 'inside the promised band');
  assert.equal(realization(region('0,60,100,40'), t).elementsMade, 0.5, 'the same node, promised elsewhere');
  // The edge is still decided from the coordinates: where a thing is promised and whether it is
  // aligned to another thing are separate questions, and only the second one is an edge.
  assert.equal(estimateEdges(region('0,60,100,40'), t)[0]!.status, 'satisfied');
});

test('intention: a region whose rectangle is not a rectangle is a broken plan', () => {
  const i = intention({
    elements: [
      { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'region', ref: 'the top bit' } },
      { id: 'date', role: 'the instruction', nodeIds: ['d1'], binding: { kind: 'node' } },
    ],
  });
  const t = tree([
    { id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } },
    { id: 'd1', type: 'op', op: 'text', args: { x: 40, y: 80, text: 'B' } },
  ]);
  const [edge] = estimateEdges(i, t);
  assert.equal(edge!.status, 'violated');
  assert.match(edge!.evidence, /is not x,y,w,h/);
});

// MUST STAY FLAT. Every trajectory on disk was logged before bindings existed. If reading one back
// changed a single verdict, gate 2 would fail on runs nobody touched, and the failure would be
// blamed on the log rather than on this file.
test('intention: an intention logged under `locatable` scores exactly as it did', () => {
  const legacy = intention({
    elements: [
      { id: 'title', role: 'the shout', nodeIds: ['t1'] },
      { id: 'absence', role: 'the logo nobody printed', nodeIds: [], locatable: false },
    ],
    edges: [{ from: 'title', to: 'absence', type: 'aligned-to', claim: 'the gap sits on the margin' }],
  });
  assert.deepEqual(bindingOf(legacy.elements[0]!), { kind: 'node' });
  assert.deepEqual(bindingOf(legacy.elements[1]!), { kind: 'absence', ref: 'the logo nobody printed' });
  const [edge] = estimateEdges(legacy, oneNode());
  assert.equal(edge!.status, 'judge-pending');
  const r = realization(legacy, oneNode());
  assert.equal(r.elementsMade, 1);
  assert.equal(r.score, null);
  assert.equal(r.mechanical, 0);
});

// MUST STAY FLAT. The default case is the overwhelming majority of every plan, and none of the
// numbers it produces are allowed to have moved.
test('intention: node-bound elements score identically under either declaration', () => {
  const t = tree([
    { id: 't1', type: 'op', op: 'text', args: { x: 40, y: 10, text: 'A' } },
    { id: 'd1', type: 'op', op: 'text', args: { x: 40, y: 80, text: 'B' } },
  ]);
  const unstated = realization(intention(), t);
  const stated = realization(
    intention({
      elements: [
        { id: 'title', role: 'the shout', nodeIds: ['t1'], binding: { kind: 'node' } },
        { id: 'date', role: 'the instruction', nodeIds: ['d1'], binding: { kind: 'node' } },
      ],
    }),
    t
  );
  assert.deepEqual(stated, unstated);
  assert.equal(stated.score, 1);
  assert.equal(stated.elementsMade, 1);
});

// carryNodeIds is what stops a replan silently unmaking everything built so far. The loop test does
// not guarantee a replan happens, so without this the function has no coverage at all.
test('intention: a replan keeps the nodes of the elements it re-declares, and only those', () => {
  const before = intention();
  const after = carryNodeIds(
    before,
    intention({
      purpose: 'reworded',
      elements: [
        { id: 'title', role: 'still the shout', nodeIds: [] },
        { id: 'rule', role: 'new', nodeIds: [] },
      ],
    })
  );
  assert.deepEqual(after.elements.find((e) => e.id === 'title')!.nodeIds, ['t1']);
  assert.deepEqual(after.elements.find((e) => e.id === 'rule')!.nodeIds, []);
  assert.equal(after.purpose, 'reworded');
  // `declared` is the other half: what the policy said, with the environment's column blank.
  assert.deepEqual(declared(before).elements.map((e) => e.nodeIds), [[], []]);
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

// Drift is structural and purpose churn is not folded into it, which is the whole point of the two
// being separate numbers: an artist that reworded its purpose has not moved its plan, and a metric
// that says it has is measuring the writing.
test('intention: drift is structural, and rewording the purpose moves nothing', () => {
  const a = intention();
  assert.equal(drift(a, a), 0);
  assert.equal(drift(a, intention({ purpose: 'something else' })), 0);
  const restructured = intention({
    elements: [{ id: 'other', role: 'r', nodeIds: [] }],
    edges: [],
  });
  assert.ok(drift(a, restructured) > 0);
  // Renaming a role is rewording too: the id is the identity.
  assert.equal(drift(a, intention({ elements: a.elements.map((e) => ({ ...e, role: 'renamed' })) })), 0);
  assert.equal(totalDrift([a, a, a]), 0);
});

test('intention: purpose churn is counted where it can be read, not averaged into drift', () => {
  const a = intention();
  const b = intention({ purpose: 'something else entirely' });
  assert.deepEqual(purposeChurn([a, a]), { changed: 0, charsFirst: a.purpose.length, charsLast: a.purpose.length });
  assert.equal(purposeChurn([a, b, a]).changed, 2);
  assert.equal(purposeChurn([a, b]).charsLast, b.purpose.length);
});

test('intention: a risk is declared by the plan, and declaring it is not doing it', () => {
  const quiet = intention();
  const bold = intention({ riskMove: { convention: 'the date sits at the foot', why: 'it should be read last' } });
  // MUST STAY FLAT: a plan that never names a convention declares no risk.
  assert.equal(riskDeclared([quiet, quiet]), false);
  assert.equal(riskDeclared([]), false);
  // MUST MOVE: named once and then replanned away. The declaration still happened, and reading only
  // the last intention would let a run un-declare a risk by changing its mind about it.
  assert.equal(riskDeclared([bold, quiet]), true);
  assert.equal(riskDeclared([quiet, bold]), true);
  // It is a property of the plan alone — no step is consulted — which is why `riskMoveTaken` has to
  // sit beside it rather than instead of it.
});

// --- tree against eye ----------------------------------------------------------------------------

function estimate(over: Partial<EdgeEstimate> = {}): EdgeEstimate {
  return { from: 'title', to: 'date', type: 'aligned-to', status: 'satisfied', evidence: '', ...over };
}

test('examine: the tree and the eye are joined edge by edge, not left as two tallies', () => {
  const treeSays = [
    estimate(),
    estimate({ from: 'date', to: 'title', type: 'echoes', status: 'violated' }),
    // Non-mechanical: the tree cannot decide it and never will, so it is not a disagreement.
    estimate({ from: 'title', to: 'rule', type: 'contradicts', status: 'judge-pending' }),
  ];
  // MUST STAY FLAT: the eye says exactly what the tree said, so nothing is in dispute — and the
  // undecidable edge is excluded rather than counted as agreement, which would inflate `comparable`.
  assert.deepEqual(examineAgreement(treeSays, treeSays), {
    comparable: 2,
    agree: 2,
    treeYesEyeNo: 0,
    treeNoEyeYes: 0,
    eyePending: 0,
    unplanned: 0,
    unexamined: 0,
  });

  // MUST MOVE: both verdicts flip, and the two directions are counted apart. They are different
  // failures — one is structure that did not become a picture, the other is a claim the tree denies.
  const flipped = [
    estimate({ status: 'violated' }),
    estimate({ from: 'date', to: 'title', type: 'echoes', status: 'satisfied' }),
  ];
  const d = examineAgreement(treeSays, flipped);
  assert.equal(d.agree, 0);
  assert.equal(d.treeYesEyeNo, 1);
  assert.equal(d.treeNoEyeYes, 1);
  assert.equal(d.comparable, 2);
});

test('examine: the join cannot be dodged by ruling on other edges or on none', () => {
  const treeSays = [estimate(), estimate({ from: 'date', to: 'title', type: 'echoes', status: 'violated' })];
  // Declining to rule is not agreement, and it is not a disagreement either — it has its own count.
  const shy = examineAgreement(treeSays, [estimate({ status: 'judge-pending' })]);
  assert.equal(shy.eyePending, 1);
  assert.equal(shy.unexamined, 1);
  assert.equal(shy.comparable, 0);
  // Verdicts on edges the plan never contained are counted where they cannot be mistaken for
  // agreement. An edge type that differs is a different edge: the eye did not answer the question.
  const invented = examineAgreement(treeSays, [estimate({ type: 'echoes' }), estimate({ to: 'nowhere' })]);
  assert.equal(invented.unplanned, 2);
  assert.equal(invented.comparable, 0);
  assert.equal(invented.unexamined, 2);
});

// --- declaring a break ---------------------------------------------------------------------------

// A declaration is the only piece of the artist's prose the environment acts on: it is what buys a
// step past the revert rule. The vocabulary below is shaped like the checker table the artist is
// shown on every call, because that table is where the exploit comes from.
const VOCAB = ['p-lowercase', 'hc-meeting', 'hc-deadline', 'hc-place', 'c-terse', 'c-hard-edges'];

function report(statuses: Record<string, string>): CheckReport {
  return {
    aesthetic: 'x',
    hardViolations: 0,
    softViolations: 0,
    treeScore: null,
    renderScore: null,
    blocked: 0,
    pendingRubrics: [],
    results: VOCAB.map((id) => ({
      id,
      kind: 'k',
      scope: 'tree',
      severity: 'hard',
      status: statuses[id] ?? 'satisfied',
      evidence: 'e',
    })),
  } as unknown as CheckReport;
}

test('declaration: a break is declared in the risk field, not mentioned in the thinking', () => {
  const before = report({});
  const after = report({ 'p-lowercase': 'violated' });

  // MUST MOVE: the id in the artist's reasoning, where it is discussing what it is satisfying, used
  // to buy a pass — the check ran over `think` concatenated with `risk`. Only `risk` is read now, so
  // a step that said nothing there has declared nothing.
  const mentioned = unplannedViolation(before, after, null);
  assert.ok(mentioned.fired, 'saying an id in passing is not saying you will break it');
  assert.deepEqual(mentioned.declaration.namedIds, []);
  assert.deepEqual(mentioned.declaration.broke, ['p-lowercase']);
  assert.deepEqual(mentioned.declaration.covered, []);

  // MUST STAY FLAT: a real declaration, in the field the schema points at, excuses the break exactly
  // as it always did. The narrowing must cost nothing to an artist that used the rule correctly.
  const named = unplannedViolation(before, after, 'raising the dates to uppercase breaks p-lowercase and I mean it');
  assert.equal(named.fired, null);
  assert.deepEqual(named.declaration.covered, ['p-lowercase']);
  assert.equal(named.declaration.blanket, false);
});

test('declaration: naming the rubric declares nothing', () => {
  const before = report({});
  const after = report({ 'p-lowercase': 'violated' });

  // MUST MOVE: four ids is over the cap, so the step pre-authorized a page rather than named a move,
  // and the one it actually broke is not covered. On the two recorded runs the model wrote five, six
  // and seven ids in a step without trying to game anything.
  const blanket = unplannedViolation(before, after, 'this may touch p-lowercase, hc-meeting, hc-deadline or hc-place');
  assert.ok(blanket.fired);
  assert.equal(blanket.declaration.blanket, true);
  assert.deepEqual(blanket.declaration.covered, []);
  assert.match(blanket.fired!.detail, /declares none of them/);

  // MUST STAY FLAT: exactly at the cap is still a declaration. The rule is against blankets, not
  // against an artist that breaks three things on purpose and says which three.
  const three = unplannedViolation(before, after, 'breaking p-lowercase, hc-meeting and hc-place');
  assert.equal(three.declaration.blanket, false);
  assert.equal(three.fired, null);
});

test('declaration: the fold separates covering a break from having named a lot', () => {
  const one = declarationOf('breaking p-lowercase', VOCAB, ['p-lowercase']);
  const hedged = declarationOf('p-lowercase, hc-meeting, hc-place may move', VOCAB, ['p-lowercase']);

  const precise = declarationScores([one, one]);
  assert.equal(precise.declaredViolationRate, 1);
  assert.equal(precise.declarationSpecificity, 1);
  assert.deepEqual(precise.declaredViolationsByConstraint, { 'p-lowercase': 2 });
  assert.equal(precise.blanketSteps, 0);

  // The hedge still covers its break — it is under the cap — but two thirds of what it named was
  // never at stake, and specificity is the number that says so.
  const loose = declarationScores([hedged]);
  assert.equal(loose.declaredViolationRate, 1);
  assert.equal(loose.declarationSpecificity, 0.333);

  // A run that broke nothing scores 0, not 1. Reading "nothing to declare" as perfect honesty is
  // how this score would be won by making nothing happen.
  assert.equal(declarationScores([declarationOf(null, VOCAB, [])]).declaredViolationRate, 0);
  // And steps that never reached a comparison are not steps that declared nothing.
  assert.deepEqual(declarationScores([null, null]), {
    declaredViolationRate: 0,
    declarationSpecificity: 0,
    declaredViolationsByConstraint: {},
    blanketSteps: 0,
  });
});

// --- stopping ------------------------------------------------------------------------------------

// The acceptance test for a stop action: a scorer with no model decides whether the run terminated
// legitimately. Running out of steps can never pass it, however good the piece is, because nothing
// about the work was consulted when the loop broke.
test('termination: running out of steps is never a legitimate stop, even with nothing outstanding', () => {
  const clean: EdgeEstimate[] = [{ from: 'title', to: 'date', type: 'echoes', status: 'satisfied', evidence: 'x' }];
  assert.equal(terminationOf(clean, 'declared-finished', null).legitimate, true);
  assert.equal(terminationOf(clean, 'out-of-steps', null).legitimate, false);
  // An abandon is a different outcome, not a legitimate stop and not scored as a failed one.
  assert.equal(terminationOf(clean, 'abandoned', null).legitimate, false);
});

test('termination: stopping with an edge outstanding is legitimate only if the artist named that edge', () => {
  const one: EdgeEstimate[] = [
    { from: 'title', to: 'date', type: 'echoes', status: 'satisfied', evidence: 'x' },
    { from: 'date', to: 'bar', type: 'aligned-to', status: 'violated', evidence: 'no common axis' },
  ];
  assert.equal(terminationOf(one, 'declared-finished', null).legitimate, false);
  assert.equal(terminationOf(one, 'declared-finished', 'date->bar').legitimate, true);
  // Naming a different edge is not a wildcard, and neither is naming one on a timeout.
  assert.equal(terminationOf(one, 'declared-finished', 'title->date').legitimate, false);
  assert.equal(terminationOf(one, 'out-of-steps', 'date->bar').declaredUnrealizable, null);
  // Two outstanding is not one, whichever is named: the escape is for a single unmakeable edge.
  const two = [...one, { from: 'bar', to: 'title', type: 'echoes', status: 'violated', evidence: 'y' } as EdgeEstimate];
  assert.equal(terminationOf(two, 'declared-finished', 'date->bar').legitimate, false);
  assert.deepEqual(terminationOf(two, 'declared-finished', null).unrealizedEdges, ['date->bar', 'bar->title']);
});

test('termination: a plan nothing could contradict does not get to finish', () => {
  const mech = (n: string): EdgeEstimate => ({ from: n, to: 'x', type: 'echoes', status: 'satisfied', evidence: '' });
  const soft = (n: string): EdgeEstimate =>
    ({ from: n, to: 'x', type: 'contradicts', status: 'judge-pending', evidence: 'only a judge can say' });

  // MUST MOVE: every edge unjudgeable. `edgesUnrealized` is 0 because only `violated` counts, so
  // before the cap this was a clean legitimate finish — the cheapest strategy in the environment.
  const dodge = terminationOf([soft('a'), soft('b'), soft('c')], 'declared-finished', null);
  assert.equal(dodge.edgesUnrealized, 0);
  assert.equal(dodge.pendingRate, 1);
  assert.equal(dodge.pendingCapExceeded, true);
  assert.equal(dodge.legitimate, false);

  // MUST STAY FLAT: a real plan with one unjudgeable edge in three is under the cap and stops
  // exactly as it did before. The cap has to leave room to say a true thing about contradiction.
  const honest = terminationOf([mech('a'), mech('b'), soft('c')], 'declared-finished', null);
  assert.ok(honest.pendingRate <= PENDING_CAP);
  assert.equal(honest.pendingCapExceeded, false);
  assert.equal(honest.legitimate, true);

  // Two in four is over the cap, and the two failures stay legible apart: nothing is unrealized,
  // so `legitimate: false` here means "never checkable", not "left something undone".
  const half = terminationOf([mech('a'), mech('b'), soft('c'), soft('d')], 'declared-finished', null);
  assert.equal(half.pendingRate, 0.5);
  assert.equal(half.edgesUnrealized, 0);
  assert.equal(half.pendingCapExceeded, true);
  assert.equal(half.legitimate, false);

  // A plan with no edges at all is not dodging anything; it fails on its own emptiness elsewhere.
  assert.equal(terminationOf([], 'declared-finished', null).pendingRate, 0);
});

// A budget refusal and a structural one say opposite things about the artist. One measured run
// refused 22 edits for maxTextOps out of 29 refusals; a single count would have read as an artist
// that could not address the tree.
test('refusals: cause is read off the validator code, so a cap is not counted as a mistake', () => {
  assert.equal(refusalCause('/root: 13 text ops exceeds the profile\'s limit of 12 [limit.textOps]'), 'budget');
  assert.equal(refusalCause('/root: ink density 0.71 over 0.62 [budget]'), 'budget');
  assert.equal(refusalCause('/root/1: the profile does not allow the "spray" operator [op.notAllowed]'), 'capability');
  assert.equal(refusalCause('/root/1: fragment "x" is not in asset pack "core" [fragment.unknown]'), 'capability');
  assert.equal(refusalCause('no node "nowhere" in the program'), 'structural');
  assert.equal(refusalCause('/root/1: 40 is outside the profile\'s range [0, 20] for "w" [range]'), 'structural');
  assert.deepEqual(
    refusalTally([
      { refused: [{ actionId: 'a', kind: 'add_node', cause: 'budget', reason: 'r' }] },
      { refused: [] },
    ]),
    { budget: 1, capability: 0, structural: 0 }
  );
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

// Every cell of the grid, read off disk rather than listed, so a document added or renamed cannot
// leave this checking a smaller catalog than exists.
const catalog = (dir: string, suffix = '.json') =>
  readdirSync(path.join(ROOT, 'aesthetic', dir))
    .filter((f) => f.endsWith(suffix) && !f.endsWith('.field.json'))
    .sort()
    .map((f) => f.slice(0, -suffix.length));

test('commission: every position carries a temperament and every brief carries a field', () => {
  const positions = catalog('positions');
  const briefs = catalog('briefs');
  const deliverable = catalog('deliverables')[0]!;
  assert.ok(positions.length >= 2 && briefs.length >= 2);
  for (const p of positions) {
    for (const b of briefs) {
      const c = loadCommission(p, b, deliverable);
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
  const c = loadCommission('cut-and-reset', 'arches-eviction', 'poster');
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
  const c = loadCommission('cut-and-reset', 'arches-eviction', 'poster');
  const obs = findObservation(c, c.field);
  assert.ok(obs.includes(c.field.whoIsWatching.adversary));
  assert.ok(obs.includes(c.field.transplants[0]!.ref));
  assert.ok(obs.includes(c.position.worldview.slice(0, 60)));
  assert.ok(obs.includes(c.brief.hard_constraints[0]!.id));
  // The number it is told not to see: stakesLevel is the environment's, not the artist's.
  assert.ok(!obs.includes('stakesLevel'));
});

// --- environment version -------------------------------------------------------------------------
//
// The regression this is named after: `replay` on either studio run reported twenty-seven
// observations that "did not rebuild", which reads as the driver leaking state between calls. The
// serializer had changed. Comparing across that is refused now, and these are the arithmetic of the
// refusal — the interesting half of which is what does NOT count as drift.

const ENV = {
  observationHash: 'a',
  profileHash: 'b',
  packHash: 'c',
  protocolHash: 'd',
  positionHash: 'e',
  deliverableHash: 'f',
  briefHash: 'g',
  fieldHash: 'h',
};

test('env version: the same environment is no drift at all', () => {
  assert.deepEqual(envDrift(ENV, ENV), []);
});

test('env version: each hash that moved is named, and only the ones that moved', () => {
  const drift = envDrift({ ...ENV, observationHash: 'z', briefHash: 'y' }, ENV);
  assert.deepEqual(drift.map((d) => d.field).sort(), ['briefHash', 'observationHash']);
  assert.deepEqual(drift.find((d) => d.field === 'briefHash'), {
    field: 'briefHash',
    recorded: 'y',
    current: 'g',
  });
});

test('env version: a hash the record never carried is not drift', () => {
  // Logs predate several of these fields. Reading absence as disagreement would refuse every old
  // run for a reason that has nothing to do with whether its environment moved.
  const { deliverableHash: _d, fieldHash: _f, ...older } = ENV;
  assert.deepEqual(envDrift(older, ENV), []);
});
