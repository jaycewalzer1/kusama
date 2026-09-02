// Finish-gate sampling decisions. BIND names the actual final tree; REVIEW compares the sampled
// plate with its salience-zero ablation. The ordinary artist EXAMINE remains separate and unchanged.

import { callPolicy, type Spend } from '../call.js';
import { actSchema } from '../schemas.js';
import { samplingBindingObservation, samplingReviewObservation } from '../sampling-observation.js';
import type { Policy, PolicyImage } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Program } from '../types.js';
import type { SamplingCompilation, SamplingPlan } from '../../aesthetic/sample-types.js';
import { validateSamplingBindings, type BindingValidation, type SamplingBindings } from '../../aesthetic/sample-targets.js';
import type { SampleRevision } from '../sampling-events.js';
import { samplingPlanId } from '../sample-planner.js';

const BIND_SYSTEM = [
  'You are at the finish gate, looking at the actual program you made.',
  'Bind each sampling role you can honestly locate to node IDs in this program. Omit a role when no',
  'node is its answer; structural resolution will then try and may report it unsupported. Never name',
  'an ID you intended to create but did not.',
].join('\n');

const REVIEW_SYSTEM = [
  'You are comparing your sampled work with the same base at salience zero.',
  'Image 1 is sampled. Image 2 is the ablation. Judge what actually changed against the problem that',
  'motivated each sample and the node IDs the compiler touched. You may make one revision total:',
  'change one existing sample, disable one, edit the unsampled base, or decline to revise.',
  'You may not add a request or bind a new role here.',
].join('\n');

const BIND_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['bindings'],
  properties: {
    bindings: {
      type: 'object',
      additionalProperties: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
    },
  },
} as const;

function reviewSchema(): object {
  const action = actSchema() as Record<string, any>;
  const edits = action.properties.edits;
  return {
    type: 'object', additionalProperties: false, required: ['assessment', 'revision'],
    properties: {
      assessment: { type: 'string', minLength: 40 },
      revision: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'none' } } },
          {
            type: 'object', additionalProperties: false, required: ['kind', 'sampleId'],
            properties: {
              kind: { const: 'sample' }, sampleId: { type: 'string' },
              salience: { type: 'number', minimum: 0, maximum: 1 },
              scope: { type: 'number', minimum: 0, maximum: 1 },
              transformation: { enum: ['echo', 'transpose', 'invert', 'compress', 'exaggerate', 'fragment', 'hybridize', 'counterpoint'] },
            },
          },
          { type: 'object', additionalProperties: false, required: ['kind', 'sampleId'], properties: { kind: { const: 'disable' }, sampleId: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['kind', 'edits'], properties: { kind: { const: 'base' }, edits } },
        ],
      },
    },
  };
}

function roles(plan: SamplingPlan): Set<string> {
  return new Set(plan.requests.map((request) => request.role));
}

export async function bindSamples(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  program: Program,
  plan: SamplingPlan
): Promise<BindingValidation> {
  const result = await callPolicy<{ bindings: SamplingBindings }>(policy, log, spend, {
    name: 'bind', system: BIND_SYSTEM,
    observation: samplingBindingObservation(plan, program),
    schema: BIND_SCHEMA,
    maxTokens: 3000,
  });
  const checked = validateSamplingBindings(program, roles(plan), result.action.bindings);
  log.append('binding_declared', { status: 'bound', bindings: checked.bindings, accepted: checked.valid, faults: checked.faults });
  return checked;
}

export async function reviewSampling(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  plan: SamplingPlan,
  compilation: SamplingCompilation,
  sampled: Buffer,
  ablation: Buffer
): Promise<{ assessment: string; revision: SampleRevision }> {
  const images: PolicyImage[] = [sampled, ablation].map((png) => ({ mediaType: 'image/png', base64: png.toString('base64') }));
  const result = await callPolicy<{ assessment: string; revision: SampleRevision }>(policy, log, spend, {
    name: 'sample_review', system: REVIEW_SYSTEM,
    observation: samplingReviewObservation(plan, compilation),
    schema: reviewSchema(), images, maxTokens: 5000,
  });
  return result.action;
}

export function reviseSamplingPlan(plan: SamplingPlan, revision: SampleRevision): { plan: SamplingPlan; faults: string[] } {
  const next = JSON.parse(JSON.stringify(plan)) as SamplingPlan;
  if (revision.kind === 'none' || revision.kind === 'base') return { plan: next, faults: [] };
  const sample = next.samples.find((item) => item.sampleId === revision.sampleId);
  if (!sample) return { plan, faults: [`revision names missing sample ${revision.sampleId}`] };
  if (revision.kind === 'disable') sample.enabled = false;
  else {
    if (revision.salience === undefined && revision.scope === undefined && revision.transformation === undefined) {
      return { plan, faults: ['sample revision changes no field'] };
    }
    if (revision.salience !== undefined) sample.controls.salience = revision.salience;
    if (revision.scope !== undefined) sample.controls.scope = revision.scope;
    if (revision.transformation !== undefined) sample.transformation = revision.transformation;
    const request = next.requests.find((item) => item.requestId === sample.requestId)!;
    request.controls = { ...sample.controls };
    request.transformation = sample.transformation;
  }
  next.planId = samplingPlanId(next);
  return { plan: next, faults: [] };
}
