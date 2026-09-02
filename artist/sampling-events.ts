// The six sampling records that enter studio.jsonl. Payload checking is deliberately narrow and
// replay-specific; StudioLog remains a general append-only hash chain.

import type { ArtistSampleIntent, SampleRejection, SamplingPlan } from '../aesthetic/sample-types.js';
import type { SamplingBindings, TargetResolution } from '../aesthetic/sample-targets.js';
import type { LogLine } from './studio-log.js';

export interface SampleRequestedEvent {
  intents: ArtistSampleIntent[];
  fallback: boolean;
}

export interface SampleSelectedEvent {
  plan: SamplingPlan;
}

export interface SampleRejectedEvent extends SampleRejection {}

export interface BindingDeclaredEvent {
  status: 'intended' | 'bound';
  bindings: SamplingBindings;
  accepted: boolean;
  faults: string[];
  problemId?: string;
  sketchIndex?: number;
  lensId?: string;
}

export interface AblationRenderedEvent {
  sampledProgramHash: string;
  sampledPixelHash: string;
  ablationProgramHash: string;
  ablationPixelHash: string;
  differingPixels: number;
  totalPixels: number;
  sampledFile: string;
  ablationFile: string;
  resolutions: TargetResolution[];
  effects?: { sampleId: string; problem: string; channel: string; claimedEffect: string; touchedNodeIds: string[] }[];
}

export type SampleRevision =
  | { kind: 'none' }
  | { kind: 'sample'; sampleId: string; salience?: number; scope?: number; transformation?: SamplingPlan['samples'][number]['transformation'] }
  | { kind: 'disable'; sampleId: string }
  | { kind: 'base'; edits: unknown[] };

export interface SampleRevisedEvent {
  revision: SampleRevision;
  assessment?: string;
  accepted: boolean;
  faults: string[];
}

export type SamplingEvent =
  | { kind: 'sample_requested'; data: SampleRequestedEvent }
  | { kind: 'sample_selected'; data: SampleSelectedEvent }
  | { kind: 'sample_rejected'; data: SampleRejectedEvent }
  | { kind: 'binding_declared'; data: BindingDeclaredEvent }
  | { kind: 'ablation_rendered'; data: AblationRenderedEvent }
  | { kind: 'sample_revised'; data: SampleRevisedEvent };

const KINDS = new Set<SamplingEvent['kind']>([
  'sample_requested', 'sample_selected', 'sample_rejected', 'binding_declared', 'ablation_rendered', 'sample_revised',
]);

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

/** The only runtime parser for sampling lines, kept small because replay is its only consumer. */
export function parseSamplingEvent(line: LogLine): SamplingEvent | null {
  if (!KINDS.has(line.kind as SamplingEvent['kind'])) return null;
  const data = object(line.data, `${line.kind} payload`);
  switch (line.kind) {
    case 'sample_requested':
      if (!Array.isArray(data['intents']) || typeof data['fallback'] !== 'boolean') throw new Error('invalid sample_requested payload');
      break;
    case 'sample_selected':
      object(data['plan'], 'sample_selected plan');
      break;
    case 'sample_rejected':
      if (typeof data['requestId'] !== 'string' || typeof data['fragmentId'] !== 'string' || typeof data['reason'] !== 'string') throw new Error('invalid sample_rejected payload');
      break;
    case 'binding_declared':
      if ((data['status'] !== 'intended' && data['status'] !== 'bound') || typeof data['accepted'] !== 'boolean' || !Array.isArray(data['faults'])) throw new Error('invalid binding_declared payload');
      object(data['bindings'], 'binding_declared bindings');
      break;
    case 'ablation_rendered':
      for (const field of ['sampledProgramHash', 'sampledPixelHash', 'ablationProgramHash', 'ablationPixelHash', 'sampledFile', 'ablationFile']) {
        if (typeof data[field] !== 'string') throw new Error(`invalid ablation_rendered ${field}`);
      }
      break;
    case 'sample_revised':
      object(data['revision'], 'sample_revised revision');
      if (typeof data['accepted'] !== 'boolean' || !Array.isArray(data['faults'])) throw new Error('invalid sample_revised payload');
      break;
  }
  return { kind: line.kind, data } as unknown as SamplingEvent;
}

export function recordedSamplingPlans(lines: LogLine[]): SamplingPlan[] {
  return lines.flatMap((line) => {
    const event = parseSamplingEvent(line);
    return event?.kind === 'sample_selected' ? [event.data.plan] : [];
  });
}
