import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPack } from '../../env/pack.js';
import { loadProfile } from '../../env/profile.js';
import { validateProgram } from '../../env/validate.js';
import { compileSamplingPlan, exaggeratedScaleRatio, mountainBaseProgram } from '../sample-compiler.js';
import { controlsFor, SAMPLE_SCHEMA_VERSION, type CorpusFragment, type FormalFeatures, type SampleChannel, type SamplingPlan, type SelectedSample } from '../sample-types.js';

const features: FormalFeatures = {
  normalizedPosition: [0.5, 0.5], cropToImageAreaRatio: 1 / 2500, dominantColorsLab: [[38, -3, -12]],
  luminanceMean: 0.35, luminanceVariance: 0.02, luminanceHistogram: [0.1, 0.2, 0.25, 0.2, 0.15, 0.06, 0.03, 0.01],
  contrast: 0.14, edgeDensity: 0.22, edgeOrientationHistogram: [0.03, 0.04, 0.05, 0.06, 0.08, 0.14, 0.25, 0.35],
  spatialDensity: 0.28, symmetry: 0.42, negativeSpace: 0.74, saliencyCentroid: [0.31, 0.68], dominantDirectionalFlow: 84,
};

const fragment: CorpusFragment = {
  fragmentId: 'frag-fixture', objectId: 123, sourceImageHash: 'a'.repeat(64), sourceRelativePath: 'images/source.jpg',
  normalizedBounds: [0, 0, 1, 1], pixelBounds: [0, 0, 1000, 800], cropScale: 1, fragmentKind: 'whole', embeddingId: 'embedding-fixture',
  formalFeatures: features,
  provenance: { source: 'met-open-access', objectId: 123, title: 'Vast Landscape', artist: 'Fixture Artist',
    objectPageUrl: 'https://met.example/123', primaryImageUrl: 'https://images.example/123.jpg', publicDomain: true,
    sourceImageHash: 'a'.repeat(64), sourceRelativePath: 'images/source.jpg' },
  wholeFragmentId: 'frag-fixture', contextFragmentId: null,
};

function makePlan(channels: SampleChannel[], sample: Partial<SelectedSample> = {}): SamplingPlan {
  const controls = sample.controls ?? controlsFor('accent');
  const request = { requestId: 'request-fixture', role: 'anchor', query: 'vast landscape', channels,
    mode: sample.mode ?? 'reference_transfer' as const, transformation: sample.transformation ?? 'exaggerate' as const,
    preset: sample.preset ?? 'accent' as const, controls, perceptualGoal: 'impossible scale', origin: 'fallback' as const };
  const selected: SelectedSample = {
    sampleId: 'sample-fixture', requestId: request.requestId, role: 'anchor', requestedRole: 'anchor', fragment,
    candidates: [{ rank: 1, fragment, scores: { embedding: 0.4, context: 0.4, metadata: 0.2, formal: 0.8, channelCompatibility: 1, quality: 0.8, diversity: 1, hybrid: 0.55 } }],
    borrowed: channels.join(', '), whyChosen: 'fixture', perceptualGoal: request.perceptualGoal, channels,
    mode: request.mode, preset: request.preset, controls, transformation: request.transformation,
    intendedDifference: 'extrapolate the relation without source pixels', enabled: true,
    ...sample,
  };
  return { schemaVersion: SAMPLE_SCHEMA_VERSION, planId: 'plan-fixture', seed: 42, indexId: 'index-fixture',
    goal: { subject: '100,000-foot mountain', percepts: ['fear', 'loneliness'], avoid: ['pastiche'] },
    requests: [request], samples: [selected], createdBy: { kind: 'deterministic-fallback' } };
}

function find(root: any, id: string): any {
  if (root.id === id) return root;
  for (const child of root.children ?? []) { const got = find(child, id); if (got) return got; }
  return undefined;
}

test('salience zero produces exactly no program change', () => {
  const base = mountainBaseProgram();
  const plan = makePlan(['scale_relation', 'composition', 'mark_rhythm'], { controls: { salience: 0, scope: 1, abstraction: 1, exaggeration: 1 } });
  const compiled = compileSamplingPlan(base, plan);
  assert.deepEqual(compiled.program, base);
  assert.equal(compiled.constraints.length, 0);
  assert.equal(compiled.baseProgramHash, compiled.compiledProgramHash);
});

test('whisper affects fewer and weaker rhythm decisions than dominant', () => {
  const whisper = compileSamplingPlan(mountainBaseProgram(), makePlan(['mark_rhythm'], { preset: 'whisper', controls: controlsFor('whisper') }));
  const dominant = compileSamplingPlan(mountainBaseProgram(), makePlan(['mark_rhythm'], { preset: 'dominant', controls: controlsFor('dominant') }));
  assert.ok(whisper.constraints[0]!.affectedNodeIds.length < dominant.constraints[0]!.affectedNodeIds.length);
  assert.ok(whisper.constraints[0]!.magnitude < dominant.constraints[0]!.magnitude);
});

test('positive scale exaggeration increases ratios monotonically and negative exaggeration compresses them', () => {
  const values = [-1, -0.5, 0, 0.5, 1].map((value) => exaggeratedScaleRatio(50, value));
  for (let i = 1; i < values.length; i++) assert.ok(values[i]! > values[i - 1]!);
  assert.ok(values[0]! < 50);
  assert.equal(values[2]!, 50);
  assert.ok(values[4]! >= 499.9);

  const positive = compileSamplingPlan(mountainBaseProgram(), makePlan(['scale_relation'], { controls: { salience: 1, scope: 1, abstraction: 1, exaggeration: 1 } }));
  const negative = compileSamplingPlan(mountainBaseProgram(), makePlan(['scale_relation'], { controls: { salience: 1, scope: 1, abstraction: 1, exaggeration: -1 } }));
  assert.ok(find((positive.program as any).root, 'figure').args.region.h < find((negative.program as any).root, 'figure').args.region.h);
});

test('transform verbs change compilation independently of otherwise identical controls', () => {
  const controls = { salience: 0.7, scope: 0.8, abstraction: 0.9, exaggeration: 0.6 };
  const expanded = compileSamplingPlan(mountainBaseProgram(), makePlan(['scale_relation'], { transformation: 'exaggerate', controls }));
  const compressed = compileSamplingPlan(mountainBaseProgram(), makePlan(['scale_relation'], { transformation: 'compress', controls }));
  assert.ok(find((expanded.program as any).root, 'figure').args.region.h < find((compressed.program as any).root, 'figure').args.region.h);

  const direct = compileSamplingPlan(mountainBaseProgram(), makePlan(['composition'], { transformation: 'transpose', controls }));
  const inverted = compileSamplingPlan(mountainBaseProgram(), makePlan(['composition'], { transformation: 'invert', controls }));
  assert.ok(find((direct.program as any).root, 'mountain').transform.translate[0] < 0);
  assert.ok(find((inverted.program as any).root, 'mountain').transform.translate[0] > 0);

  const whole = compileSamplingPlan(mountainBaseProgram(), makePlan(['mark_rhythm'], { transformation: 'transpose', controls }));
  const fragmented = compileSamplingPlan(mountainBaseProgram(), makePlan(['mark_rhythm'], { transformation: 'fragment', controls }));
  assert.ok(whole.constraints[0]!.affectedNodeIds.length > fragmented.constraints[0]!.affectedNodeIds.length);
});

test('high scope and low salience creates a restrained global influence', () => {
  const base = mountainBaseProgram();
  const compiled = compileSamplingPlan(base, makePlan(['palette'], { controls: { salience: 0.08, scope: 1, abstraction: 0.9, exaggeration: 0 } }));
  assert.equal(compiled.constraints[0]!.scope, 'global');
  assert.deepEqual(Object.keys((compiled.program as any).palette), Object.keys((base as any).palette));
  assert.notDeepEqual((compiled.program as any).palette, (base as any).palette);
  assert.ok(compiled.constraints[0]!.magnitude < 0.1);
});

test('reference transfer emits native decisions only and never executable source pixels', () => {
  const compiled = compileSamplingPlan(mountainBaseProgram(), makePlan(['composition', 'motif', 'mark_rhythm']));
  const executable = JSON.stringify((compiled.program as any).root);
  assert.doesNotMatch(executable, /primaryImageUrl|sourceRelativePath|literal_fragment/);
  const all: any[] = [];
  const walk = (node: any) => { all.push(node); (node.children ?? []).forEach(walk); };
  walk((compiled.program as any).root);
  assert.ok(all.filter((node) => node.type === 'op').every((node) => ['wash', 'paint', 'stroke', 'rule'].includes(node.op)));
});

test('disabling one sample preserves unrelated nodes and every pre-existing rngKey', () => {
  const base = mountainBaseProgram();
  const first = makePlan(['scale_relation']);
  const rhythmSample = makePlan(['mark_rhythm']).samples[0]!;
  rhythmSample.sampleId = 'sample-rhythm'; rhythmSample.requestId = 'request-rhythm';
  const rhythmRequest = { ...makePlan(['mark_rhythm']).requests[0]!, requestId: 'request-rhythm' };
  first.requests.push(rhythmRequest); first.samples.push(rhythmSample);
  const full = compileSamplingPlan(base, first);
  const ablated = compileSamplingPlan(base, first, ['sample-fixture']);
  assert.deepEqual(find((full.program as any).root, 'ground-rule'), find((ablated.program as any).root, 'ground-rule'));
  const baseKeys = ['atmosphere', 'mountain-mass', 'snow-line', 'figure', 'ground-rule'].map((id) => find((base as any).root, id).rngKey);
  const ablatedKeys = ['atmosphere', 'mountain-mass', 'snow-line', 'figure', 'ground-rule'].map((id) => find((ablated.program as any).root, id).rngKey);
  assert.deepEqual(ablatedKeys, baseKeys);
});

test('unsupported channels are visible and every applied influence has complete provenance', () => {
  const compiled = compileSamplingPlan(mountainBaseProgram(), makePlan(['scale_relation', 'symbolic_role']));
  assert.deepEqual(compiled.unsupported, [{ sampleId: 'sample-fixture', channel: 'symbolic_role', reason: 'no native compiler for symbolic_role' }]);
  assert.equal(compiled.provenance[0]!.chosenFragment.provenance.objectId, 123);
  assert.equal(compiled.provenance[0]!.request.requestId, 'request-fixture');
  assert.ok(compiled.provenance[0]!.constraints.some((constraint) => constraint.affectedNodeIds.includes('figure')));
});

test('compiled scale, space, palette/value, and rhythm influences remain a valid native program', () => {
  const channels: SampleChannel[] = ['scale_relation', 'composition', 'negative_space', 'value_structure', 'palette', 'mark_rhythm'];
  const compiled = compileSamplingPlan(mountainBaseProgram(), makePlan(channels, { controls: { salience: 0.55, scope: 0.8, abstraction: 0.95, exaggeration: 0.7 } }));
  const profile = loadProfile('default-v1').profile;
  const pack = loadPack('core-v1');
  const checked = validateProgram(compiled.program, profile, pack);
  assert.deepEqual(checked.issues, []);
});
