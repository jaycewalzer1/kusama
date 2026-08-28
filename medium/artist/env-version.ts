// The eight hashes that say which environment a trajectory was collected in.
//
// Written once here and read by everything that either stamps a run or compares two of them. It was
// previously built inline in run.ts, twice — once onto the log's start line and once onto the
// finished Trajectory — and comparing a recorded run against the current tree was nobody's job at
// all. That gap had a cost: `replay` rebuilt every observation under today's serializer, compared
// them to observations recorded under a different one, and reported twenty-seven byte mismatches. It
// looked like the environment leaking state through the driver. It was the environment having moved.
//
// So the rule is: a comparison across a version bump is refused, not reported. A replay that says
// "these observations differ" when the serializer itself changed is answering a question nobody
// asked, and the answer reads as a fault in the log.

import { loadPackFor } from '../env/pack.js';
import { loadProfileFor } from '../env/profile.js';
import { loadCommission } from './field.js';
import { OBSERVATION_HASH, PROTOCOL_HASH } from './observation.js';
import { seedProgram } from './seed.js';
import type { EnvVersion } from './types.js';

/**
 * The environment as it stands right now, for this commission and seed.
 *
 * The commission hashes are the real position's in both arms — a control run is scored against the
 * position it is a control for, so stripping it does not put it in a different environment.
 */
export function envVersionNow(
  positionId: string,
  briefId: string,
  deliverableId: string,
  seed: number
): EnvVersion {
  const program = seedProgram(seed);
  const { hash: profileHash } = loadProfileFor(program);
  const loaded = loadCommission(positionId, briefId, deliverableId);
  return {
    observationHash: OBSERVATION_HASH,
    profileHash,
    packHash: loadPackFor(program).hash,
    protocolHash: PROTOCOL_HASH,
    positionHash: loaded.positionHash,
    deliverableHash: loaded.deliverableHash,
    briefHash: loaded.briefHash,
    fieldHash: loaded.fieldHash,
  };
}

export interface EnvDrift {
  field: keyof EnvVersion;
  recorded: string;
  current: string;
}

/**
 * Which of the eight moved. A field the record does not carry is skipped rather than reported as
 * having changed: logs written before a hash existed cannot be said to disagree about it, and
 * calling that drift would refuse every old run for the wrong reason.
 */
export function envDrift(recorded: Partial<EnvVersion>, current: EnvVersion): EnvDrift[] {
  const out: EnvDrift[] = [];
  for (const field of Object.keys(current) as (keyof EnvVersion)[]) {
    const was = recorded[field];
    if (typeof was === 'string' && was !== current[field]) {
      out.push({ field, recorded: was, current: current[field] });
    }
  }
  return out;
}

export function driftText(drift: EnvDrift[]): string {
  return drift.map((d) => `${d.field}: recorded ${d.recorded.slice(0, 12)}, now ${d.current.slice(0, 12)}`).join('\n  ');
}
