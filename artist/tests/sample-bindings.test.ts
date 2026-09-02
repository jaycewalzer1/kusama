import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateSamplingBindings } from '../../aesthetic/sample-targets.js';
import { bindSamples } from '../phases/sample-finish.js';
import { newSpend } from '../call.js';
import { StudioLog } from '../studio-log.js';
import type { Policy } from '../policy/interface.js';
import { requestsFromGoal, createSamplingPlan } from '../sample-planner.js';
import type { RetrievedCandidate } from '../../aesthetic/sample-types.js';

const program = { root: { id: 'root', type: 'group', children: [{ id: 'subject', type: 'group', children: [] }] } };

test('the shared sketch/bind validator rejects unknown roles and actual-program node IDs', () => {
  assert.equal(validateSamplingBindings(program, new Set(['subject_role']), { subject_role: ['subject'] }).valid, true);
  assert.deepEqual(
    validateSamplingBindings(program, new Set(['subject_role']), { invented_role: ['missing'] }).faults,
    ['binding role "invented_role" is not in the sampling plan', 'binding role "invented_role" names missing node "missing"']
  );
});

test('the finish-gate bind call records an invalid semantic binding instead of dropping it', async () => {
  const requests = requestsFromGoal({ subject: 'field', percepts: ['pressure'], avoid: [] }).slice(0, 1);
  const fragment = {
    fragmentId: 'f', objectId: 1, sourceImageHash: 'a'.repeat(64), sourceRelativePath: 'x.jpg',
    normalizedBounds: [0, 0, 1, 1], pixelBounds: [0, 0, 1, 1], cropScale: 1, fragmentKind: 'whole', embeddingId: 'e',
    formalFeatures: { normalizedPosition: [0.5, 0.5], cropToImageAreaRatio: 1, dominantColorsLab: [], luminanceMean: 0.5, luminanceVariance: 0,
      luminanceHistogram: [], contrast: 0, edgeDensity: 0, edgeOrientationHistogram: [], spatialDensity: 0, symmetry: 0, negativeSpace: 0,
      saliencyCentroid: [0.5, 0.5], dominantDirectionalFlow: 0 },
    provenance: { source: 'met-open-access', objectId: 1, title: 'x', artist: null, objectPageUrl: 'x', primaryImageUrl: 'x', publicDomain: true,
      sourceImageHash: 'a'.repeat(64), sourceRelativePath: 'x.jpg' }, wholeFragmentId: 'f', contextFragmentId: null,
  } as const;
  const candidate = { rank: 1, fragment, scores: { embedding: 1, context: 1, metadata: 1, formal: 1, channelCompatibility: 1, quality: 1, diversity: 1, hybrid: 1 } } as unknown as RetrievedCandidate;
  const plan = await createSamplingPlan({ goal: { subject: 'field', percepts: ['pressure'], avoid: [] }, requests, indexId: 'i', seed: 1, temperature: 0,
    candidates: async () => [candidate] });
  const policy: Policy = {
    kind: 'stub', model: 'stub',
    async call<T>() { return { action: { bindings: { [requests[0]!.role]: ['missing'] } } as T, raw: '', usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, attempts: 1, failures: [], model: 'stub' }; },
  };
  const log = new StudioLog(mkdtempSync(path.join(tmpdir(), 'sampling-bind-')));
  const result = await bindSamples(policy, log, newSpend(), program, plan);
  assert.equal(result.valid, false);
  assert.match(result.faults[0]!, /missing node/);
});

