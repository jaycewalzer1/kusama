// The nine hashes that say which environment a trajectory was collected in.
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPackFor } from '../env/pack.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { loadCommission } from './field.js';
import { OBSERVATION_HASH, PROTOCOL_HASH } from './observation.js';
import { SAMPLING_OBSERVATION_HASH } from './sampling-observation.js';
import { seedProgram } from './seed.js';
import type { EnvVersion } from './types.js';

/**
 * The environment's mechanical response rules: how affect updates, and the two knobs that read it.
 *
 * The other seven hashes cover what the policy is shown and what the medium does with a program.
 * None of them covered how the environment reacts, so `editsPerStep` could go from returning 4 to
 * returning 3 — changing both the loop's behaviour and a number written into every observation —
 * without a single hash moving. That is the same defect as the one that let a schema edit change
 * what the artist is told while `observationHash` stayed still, and it has the same cost: two runs
 * collected under different rules compare as though they were the same experiment.
 */
const hereFile = fileURLToPath(import.meta.url);
const dynamicsFile = hereFile.replace(/env-version\.(js|ts)$/, 'affect.$1');
// Not a defensive check on a path that cannot be wrong: a rename that silently fails to match would
// hash this file instead, and the hash would then be stable across exactly the changes it exists to
// catch. Failing loudly here is cheaper than a corpus that quietly spans two environments.
if (dynamicsFile === hereFile) throw new Error(`cannot locate affect.ts beside ${hereFile}`);
export const DYNAMICS_HASH = contentHash(readFileSync(dynamicsFile, 'utf8'));

/**
 * The environment as it stands right now, for this commission and seed.
 *
 * The commission hashes are the real position's in both arms — a control run is scored against the
 * position it is a control for, so stripping it does not put it in a different environment.
 */
export function envVersionNow(
  positionId: string,
  briefId: string,
  seed: number,
  elementIds: string[] = [],
  influencesHash?: string,
  sampling = false
): EnvVersion {
  const program = seedProgram(seed);
  const { hash: profileHash } = loadProfileFor(program);
  const loaded = loadCommission(positionId, briefId, elementIds);
  return {
    observationHash: OBSERVATION_HASH,
    dynamicsHash: DYNAMICS_HASH,
    profileHash,
    packHash: loadPackFor(program).hash,
    protocolHash: PROTOCOL_HASH,
    positionHash: loaded.positionHash,
    briefHash: loaded.briefHash,
    fieldHash: loaded.fieldHash,
    elementPackHash: loaded.elementPackHash,
    // Spread rather than assigned, so a run without the layer produces an object with no such key at
    // all. `influencesHash: undefined` would be a different thing: `Object.keys` reports it, so
    // `envDrift` would iterate a field whose current value is undefined and report every run that
    // *does* carry one as having drifted. It would also serialize into a log line as an absent key
    // anyway, which is exactly the kind of difference between the object and its JSON that makes a
    // byte-identity test pass while the behaviour is wrong.
    ...(influencesHash ? { influencesHash } : {}),
    ...(sampling ? { samplingObservationHash: SAMPLING_OBSERVATION_HASH } : {}),
  };
}

export interface EnvDrift {
  field: keyof EnvVersion;
  recorded: string;
  current: string;
}

/**
 * What a field the current environment does not have at all reads as. Not a hash, and cannot be
 * mistaken for one in a drift line.
 */
export const ABSENT = '(absent)';

/**
 * The fields of `EnvVersion` that may legitimately be missing from a current environment.
 *
 * Named explicitly, and this is not a stylistic choice. `envDrift` is called with the whole
 * `trajectory-start` line as `recorded` — a `StartLine & Partial<EnvVersion>`, carrying `id`,
 * `positionId`, `briefId`, `mode` and a dozen more — so a loop over `Object.keys(recorded)` reports
 * every one of those as a field the current environment has lost. It did, immediately, on the first
 * run of the suite after the union was introduced. The key set of `EnvVersion` is therefore the
 * required fields (which `current` always carries) plus exactly this list, and nothing read off the
 * record.
 */
const OPTIONAL_FIELDS = ['influencesHash', 'samplingObservationHash'] as const satisfies readonly (keyof EnvVersion)[];

/**
 * Which of them moved. A field the record does not carry is skipped rather than reported as
 * having changed: logs written before a hash existed cannot be said to disagree about it, and
 * calling that drift would refuse every old run for the wrong reason.
 *
 * The other direction is drift, and reads as `(absent)`. A run recorded with an optional hash —
 * today that is `influencesHash`, meaning a run that was shown a corpus — compared against an
 * environment that has no such hash is not two environments agreeing about nothing. It is a replay
 * about to rebuild every observation without a block the run actually saw, and then report the
 * difference as an observation mismatch. That is the exact fault this module exists to stop, and
 * iterating only the current object's keys would have let it through silently for precisely the
 * fields that are permitted to be missing.
 */
export function envDrift(recorded: Partial<EnvVersion>, current: EnvVersion): EnvDrift[] {
  const out: EnvDrift[] = [];
  const fields = new Set([...(Object.keys(current) as (keyof EnvVersion)[]), ...OPTIONAL_FIELDS]);
  for (const field of fields) {
    const was = recorded[field];
    const now = current[field] ?? ABSENT;
    if (typeof was === 'string' && was !== now) out.push({ field, recorded: was, current: now });
  }
  return out;
}

export function driftText(drift: EnvDrift[]): string {
  return drift.map((d) => `${d.field}: recorded ${d.recorded.slice(0, 12)}, now ${d.current.slice(0, 12)}`).join('\n  ');
}
