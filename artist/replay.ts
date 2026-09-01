// Replay: run the trajectory again with the model unplugged.
//
// The policy below answers from studio.jsonl instead of from a model, in the order the calls were
// originally made, and refuses to answer if the observation it is handed is not byte-for-byte the
// one that produced the recorded answer. That refusal is the whole test. A replay that tolerated a
// different observation would prove only that the recorded actions can be applied, which is not
// interesting; what has to be true is that the environment, given the same history, builds the same
// situation. If that fails, some state is leaking through the driver instead of through the log.
//
// Environment calls are not replayed here because they do not need to be: env-model.ts is cached on
// disk by request content, so a replay hits the same cache entries the run wrote and gets the same
// answers without a network call. If the cache is cleared, a replay costs what the environment cost.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contentHash } from '../env/profile.js';
import { envDrift, envVersionNow, type EnvDrift } from './env-version.js';
import { readLog, verifyChain, type LogLine } from './studio-log.js';
import { runTrajectory } from './run.js';
import { PolicyError, type Policy, type PolicyRequest, type PolicyResponse } from './policy/interface.js';
import type { EnvVersion, Mode, Trajectory } from './types.js';

interface RecordedCall {
  name: string;
  observationHash: string;
  observation: string;
  action?: unknown;
  raw?: string;
  attempts?: number;
  failures?: string[];
  usage?: { inputTokens: number; outputTokens: number; usd: number };
  model?: string;
  ok: boolean;
}

/**
 * A Policy that has already made every decision. It costs nothing and never varies, which is what
 * makes it useful for more than replay: it is also how the integration test exercises the whole loop
 * without an API key.
 */
export class RecordedPolicy implements Policy {
  readonly kind = 'recorded';
  readonly model: string;
  private at = 0;
  readonly mismatches: { index: number; name: string; expected: string; got: string }[] = [];

  constructor(private readonly calls: RecordedCall[]) {
    this.model = calls.find((c) => c.model)?.model ?? 'recorded';
  }

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    const recorded = this.calls[this.at];
    if (!recorded) throw new PolicyError(`replay ran out of recorded calls at call ${this.at} ("${request.name}")`);
    this.at++;

    if (recorded.name !== request.name) {
      throw new PolicyError(`replay expected call ${this.at - 1} to be "${recorded.name}" but the driver asked for "${request.name}"`);
    }
    const got = contentHash(request.observation);
    if (got !== recorded.observationHash) {
      this.mismatches.push({ index: this.at - 1, name: request.name, expected: recorded.observationHash, got });
    }
    // A call that failed originally fails again, at the same point, for the same reason.
    if (!recorded.ok) throw new PolicyError(`replay of call ${this.at - 1} ("${request.name}"): the original call failed`);

    return {
      action: recorded.action as T,
      raw: recorded.raw ?? '',
      usage: recorded.usage ?? { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: recorded.attempts ?? 1,
      failures: recorded.failures ?? [],
      model: recorded.model ?? 'recorded',
    };
  }

  get consumed(): number {
    return this.at;
  }
}

export function recordedCalls(lines: LogLine[]): RecordedCall[] {
  return lines.filter((l) => l.kind === 'policy-call').map((l) => l.data as RecordedCall);
}

export interface ReplayResult {
  id: string;
  ok: boolean;
  chainProblems: { seq: number; problem: string }[];
  observationMismatches: RecordedPolicy['mismatches'];
  finalHash: { original: string; replayed: string };
  scoresEqual: boolean;
  differences: string[];
  /**
   * Which of the eight environment hashes moved since the run was recorded. Non-empty means the
   * replay did not happen: there is nothing to learn from rebuilding observations under a different
   * serializer, and every other field here is empty rather than misleadingly zero.
   */
  envDrift: EnvDrift[];
}

interface StartLine {
  id: string;
  positionId: string;
  briefId: string;
  control: boolean;
  seed: number;
  mode: Mode;
  maxSteps: number;
  hardStop: number;
  sketchesPerProblem: number;
  /** Absent in logs written before elements existed; those runs composed none. */
  elementIds?: string[];
  /** Absent in logs written before the ablation existed; those runs were all blind. */
  showCanvas?: boolean;
  useAudience: boolean;
}

/** The start line also carries the environment hashes, and has since before it carried all of them. */
type StartEnv = StartLine & Partial<EnvVersion>;

/**
 * Replays the trajectory in `dir` into `into`, and reports whether the two agree. Three things have
 * to hold and each one is reported separately, because they fail for different reasons: the log is
 * whole, every observation rebuilt identically, and the same program came out with the same scores.
 */
export async function replay(dir: string, into: string): Promise<ReplayResult> {
  const lines = readLog(path.join(dir, 'studio.jsonl'));
  const chainProblems = verifyChain(lines);
  const start = lines.find((l) => l.kind === 'trajectory-start')!.data as StartEnv;
  const original = JSON.parse(readFileSync(path.join(dir, 'final.json'), 'utf8')) as Trajectory;

  // Refused, not reported. A replay across a version bump rebuilds every observation under a
  // serializer the run never saw and then calls the difference a mismatch — which is what happened
  // to the two studio runs on disk, twenty-seven times each, and read as state leaking through the
  // driver rather than as the environment having moved underneath them.
  const drifted = envDrift(start, envVersionNow(start.positionId, start.briefId, start.seed, start.elementIds ?? []));
  if (drifted.length > 0) {
    return {
      id: original.id,
      ok: false,
      chainProblems,
      observationMismatches: [],
      finalHash: { original: original.finalHash, replayed: '' },
      scoresEqual: false,
      differences: [],
      envDrift: drifted,
    };
  }

  // The position id in the log is the real one even in a control run, so it round-trips as written.
  const policy = new RecordedPolicy(recordedCalls(lines));
  const replayed = await runTrajectory({
    policy,
    positionId: start.positionId,
    briefId: start.briefId,
    seed: start.seed,
    outDir: into,
    control: start.control,
    mode: start.mode,
    maxSteps: start.maxSteps,
    hardStop: start.hardStop,
    sketchesPerProblem: start.sketchesPerProblem,
    useAudience: start.useAudience,
    showCanvas: start.showCanvas ?? false,
  });

  const differences: string[] = [];
  const compare = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  compare('finalHash', original.finalHash, replayed.finalHash);
  compare('outcome', original.outcome, replayed.outcome);
  compare('steps', original.steps.length, replayed.steps.length);
  // Cost and wall time are not compared: a replay costs nothing, which is the point of it.
  compare('scores', original.scores, replayed.scores);

  return {
    id: original.id,
    ok: chainProblems.length === 0 && policy.mismatches.length === 0 && differences.length === 0,
    chainProblems,
    observationMismatches: policy.mismatches,
    finalHash: { original: original.finalHash, replayed: replayed.finalHash },
    scoresEqual: JSON.stringify(original.scores) === JSON.stringify(replayed.scores),
    differences,
    envDrift: [],
  };
}
