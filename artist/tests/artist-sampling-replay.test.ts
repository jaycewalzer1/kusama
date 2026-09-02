import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { controlsFor, SAMPLE_SCHEMA_VERSION, type CorpusFragment, type SamplingPlan } from '../../aesthetic/sample-types.js';
import { samplingPlanId } from '../sample-planner.js';
import { newSpend } from '../call.js';
import { loadCommission } from '../field.js';
import { sample } from '../phases/sample.js';
import { PolicyError, type Policy, type PolicyRequest, type PolicyResponse } from '../policy/interface.js';
import { replay } from '../replay.js';
import { runTrajectory } from '../run.js';
import { readLog, StudioLog } from '../studio-log.js';
import { contentHash } from '../../env/profile.js';
import { StubPolicy, installStubEnvModel } from './artist-stub.js';

const fragment: CorpusFragment = {
  fragmentId: 'fragment-replay',
  objectId: 901,
  sourceImageHash: 'a'.repeat(64),
  sourceRelativePath: 'images/901.jpg',
  normalizedBounds: [0, 0, 1, 1],
  pixelBounds: [0, 0, 100, 100],
  cropScale: 1,
  fragmentKind: 'whole',
  embeddingId: 'embedding-replay',
  formalFeatures: {
    normalizedPosition: [0.5, 0.5], cropToImageAreaRatio: 1,
    dominantColorsLab: [[50, 0, 0]], luminanceMean: 0.5, luminanceVariance: 0.1,
    luminanceHistogram: [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125],
    contrast: 0.5, edgeDensity: 0.5,
    edgeOrientationHistogram: [0.1, 0.1, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1],
    spatialDensity: 0.4, symmetry: 0.2, negativeSpace: 0.6,
    saliencyCentroid: [0.4, 0.6], dominantDirectionalFlow: 32,
  },
  provenance: {
    source: 'met-open-access', objectId: 901, title: 'Replay Source', artist: null,
    objectPageUrl: 'https://example.test/object/901', primaryImageUrl: 'https://example.test/image/901.jpg',
    publicDomain: true, sourceImageHash: 'a'.repeat(64), sourceRelativePath: 'images/901.jpg',
  },
  wholeFragmentId: 'fragment-replay', contextFragmentId: null,
};

function plan(): SamplingPlan {
  const controls = controlsFor('accent', { salience: 0.42, scope: 0.5 });
  const request = {
    requestId: 'request-replay', role: 'sample_subject', query: 'directional pressure around a date block',
    channels: ['mark_rhythm'] as const, mode: 'structural_analogy' as const,
    transformation: 'counterpoint' as const, preset: 'accent' as const, controls,
    perceptualGoal: 'The marks need a directional pressure that keeps the date block from settling into a notice.',
    origin: 'artist' as const,
  };
  const selected = {
    sampleId: 'sample-replay', requestId: request.requestId, role: 'anchor' as const,
    requestedRole: request.role, fragment,
    candidates: [{ rank: 1, fragment, scores: {
      embedding: 0.8, context: 0.7, metadata: 0.5, formal: 0.8,
      channelCompatibility: 1, quality: 0.8, diversity: 1, hybrid: 0.82,
    } }],
    borrowed: 'mark_rhythm', whyChosen: 'fixture', perceptualGoal: request.perceptualGoal,
    channels: [...request.channels], mode: request.mode, preset: request.preset, controls,
    transformation: request.transformation,
    intendedDifference: 'transpose directional rhythm into native marks without source pixels', enabled: true,
  };
  const body = {
    schemaVersion: SAMPLE_SCHEMA_VERSION, seed: 717, indexId: 'deleted-index',
    goal: { subject: 'a public date notice', percepts: ['directional interruption'], avoid: ['pastiche'] },
    requests: [{ ...request, channels: [...request.channels] }], samples: [selected],
  };
  return { ...body, planId: samplingPlanId(body), createdBy: { kind: 'artist', profile: 'stub' } };
}

class FailingSamplePolicy implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  constructor(private readonly errorKind: PolicyError['kind']) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    if (request.name === 'sample') throw new PolicyError('sample failed', this.errorKind);
    const action = { rejections: [] } as T;
    return {
      action, raw: JSON.stringify(action), usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1, failures: [], model: this.model,
    };
  }
}

const problem = {
  id: 'p-sample',
  text: 'The date block settles into a neutral notice unless a directional pressure interrupts it.',
  tension: { between: 'legibility', and: 'interruption', claim: 'the readable block wants to settle' },
  fieldRefs: ['the reader keeps walking'],
};

test('SAMPLE falls back only after the policy reports two schema failures', async () => {
  const commission = loadCommission('withheld', 'two-million-slips');
  const schemaDir = mkdtempSync(path.join(tmpdir(), 'artist-sample-schema-'));
  const result = await sample(
    new FailingSamplePolicy('schema'), new StudioLog(schemaDir), newSpend(), commission,
    [problem], 717, { recordedPlans: [plan()] }
  );
  assert.equal(result.fallback, true);

  const transportDir = mkdtempSync(path.join(tmpdir(), 'artist-sample-transport-'));
  await assert.rejects(
    () => sample(
      new FailingSamplePolicy('transport'), new StudioLog(transportDir), newSpend(), commission,
      [problem], 717, { recordedPlans: [plan()] }
    ),
    /sample failed/
  );
});

test('sampling replay injects sample_selected plans and never opens the deleted index', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'artist-sampling-replay-'));
  const original = path.join(root, 'original');
  const replayed = path.join(root, 'replayed');
  const missingIndex = path.join(root, 'deleted-index');
  assert.equal(existsSync(missingIndex), false);
  const env = installStubEnvModel({ rubricVerdict: 'fails' });
  try {
    const trajectory = await runTrajectory({
      policy: new StubPolicy(1), positionId: 'withheld', briefId: 'two-million-slips', seed: 717,
      outDir: original, maxSteps: 3, sketchesPerProblem: 1, useAudience: true,
      sampling: missingIndex,
      recordedSamplingPlans: [plan()],
    });
    assert.equal(existsSync(missingIndex), false, 'recorded selection did not recreate or read an index');
    assert.ok(trajectory.sampling, 'the terminal finish attempt produced the sampled derivative');
    const ablationEvent = readLog(path.join(original, 'studio.jsonl'))
      .filter((line) => line.kind === 'ablation_rendered')
      .at(-1)!.data as { ablationProgramHash: string };
    assert.equal(ablationEvent.ablationProgramHash, contentHash(trajectory.sampling!.baseProgram));
    assert.equal((trajectory.sampling!.baseProgram.meta as Record<string, unknown> | undefined)?.['sampling'], undefined);
    const result = await replay(original, replayed);
    assert.equal(existsSync(missingIndex), false, 'replay did not recreate or read the absent index');
    assert.equal(result.ok, true, result.differences.join('\n'));
    assert.deepEqual(result.observationMismatches, []);
  } finally {
    env.restore();
  }
});
