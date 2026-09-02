// Sampling-only serialization. Kept out of observation.ts so an unflagged trajectory retains the
// exact observationHash it had before sampling existed; sampled runs carry this file's own hash.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../env/profile.js';
import type { SamplingCompilation, SamplingPlan } from '../aesthetic/sample-types.js';
import { stack, type Layers } from './observation.js';
import type { Problem, Program } from './types.js';

const RULE = '-'.repeat(88);
const here = fileURLToPath(import.meta.url);
export const SAMPLING_OBSERVATION_HASH = contentHash(readFileSync(here, 'utf8'));

function section(title: string, body: string): string {
  return `${RULE}\n${title}\n${RULE}\n${body.trim()}\n`;
}

function bullets(items: string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

function programJson(program: Program): string {
  const { meta: _meta, ...rest } = program as Record<string, unknown>;
  return JSON.stringify(rest, null, 2);
}

/** Source-neutral commitments: why and how to borrow, never which collection object supplied it. */
export function samplingCommitments(plan: SamplingPlan): string {
  return [
    'SAMPLING COMMITMENTS — declared before drawing and still binding',
    ...plan.requests.map((request) =>
      [
        `[${request.role}] problem: ${request.perceptualGoal}`,
        `  channel: ${request.channels[0]}  transformation: ${request.transformation}`,
        `  salience: ${request.controls.salience}  scope: ${request.controls.scope}`,
        '  You will bind this role to node IDs in the actual final program when you ask to finish.',
      ].join('\n')
    ),
  ].join('\n');
}

/** Appending is conditional so an ordinary run receives exactly the pre-sampling observation. */
export function withSamplingCommitments(text: string, plan: SamplingPlan | null): string {
  return plan ? `${text}\n${RULE}\n${samplingCommitments(plan)}` : text;
}

export function samplingIntentObservation(l: Layers, problems: Problem[]): string {
  return [
    stack(l.position, l.practice, l.brief),
    section('THE VISUAL PROBLEMS YOU NAMED', bullets(problems.map((problem) => `[${problem.id}] ${problem.text}`))),
    section(
      'YOUR TASK: DECLARE BORROWING JOBS BEFORE YOU DRAW',
      'Declare one to four sampling intents. Each problem sentence must say why that borrowing job exists.'
    ),
  ].join('\n');
}

export function samplingFeedbackObservation(feedback: string): string {
  return [
    section('THE TEXT-ONLY RETRIEVALS', feedback),
    section('YOUR TASK', 'Reject zero, one, or two selected fragments.'),
  ].join('\n');
}

export function samplingBindingObservation(plan: SamplingPlan, program: Program): string {
  return [
    section(
      'DECLARED SAMPLING ROLES',
      bullets(plan.requests.map((request) => `[${request.role}] ${request.perceptualGoal} (${request.channels[0]})`))
    ),
    section('ACTUAL UNSAMPLED PROGRAM', programJson(program)),
  ].join('\n');
}

export function samplingReviewObservation(plan: SamplingPlan, compilation: SamplingCompilation): string {
  const evidence = plan.samples.map((sample) => {
    const constraints = compilation.constraints.filter((constraint) => constraint.sampleId === sample.sampleId);
    return [
      `[${sample.sampleId}] role ${sample.requestedRole}`,
      `problem: ${sample.perceptualGoal}`,
      `channel/transformation: ${sample.channels.join(', ')}/${sample.transformation}`,
      ...constraints.map((constraint) =>
        `claimed effect: ${constraint.claimedEffect}; touched: ${constraint.affectedNodeIds.join(', ') || '(none)'}; target: ${constraint.resolvedBy ?? 'not-required'}`
      ),
    ].join('\n');
  }).join('\n\n');
  return `${section('WHAT THE SAMPLE COMPILER DID', evidence)}\nImage 1 is sampled. Image 2 is salience zero.`;
}
