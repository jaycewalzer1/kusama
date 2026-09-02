// One policy call, logged whole.
//
// The brief's rule is that every model call is logged in full, including failures and retries, and
// that a trajectory with a missing log line is a failed trajectory. This is the only function that
// calls `policy.call`, so "every call is logged" is a property of one function rather than a habit
// spread across seven phase files.
//
// What goes in the log line is deliberately everything: the whole observation, the whole schema, the
// raw response, and every validator error from every failed attempt. The observation is the largest
// thing in the file by far, and it is kept because an offline rescore that cannot see what the model
// was actually shown is not a rescore of anything.
//
// Because this is the one funnel, it is also the one place a trace goes out from. ./trace.ts is a
// sink and is off unless LANGSMITH_TRACING=1; it is sent *after* the log line is written, so the
// record on disk is complete before anything leaves the machine, and a failed trace cannot lose a
// line. Nothing reads back from it.

import { contentHash } from '../env/profile.js';
import { PolicyError, type Policy, type PolicyImage, type PolicyResponse } from './policy/interface.js';
import { traceCall, tracingEnabled } from './trace.js';

/**
 * Where a logged call is written. `StudioLog` and `DiscoveryLog` both satisfy it and they are the
 * only two.
 *
 * It is an interface rather than `StudioLog` because RESEARCH's calls must not enter the hash chain.
 * The brief is explicit that what crosses into the trajectory is the material sheet the artist
 * wrote, and that the corpus query which produced it is not logged into the chain. Those calls still
 * have to be logged in full and still have to be billed, so they come through this same funnel and
 * land in `discovery.jsonl` instead. Widening the parameter is the whole change: nothing about what
 * gets written, billed or traced differs between the two sinks.
 */
export interface CallSink {
  readonly file: string;
  append(kind: 'policy-call', data: unknown): unknown;
}

export interface Spend {
  policyCalls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** Calls whose first answer broke the schema. Gate 3 is this over `policyCalls`, for `act` only. */
  retried: number;
  /** Calls that never validated, even after the retry. */
  failed: number;
}

export function newSpend(): Spend {
  return { policyCalls: 0, inputTokens: 0, outputTokens: 0, usd: 0, retried: 0, failed: 0 };
}

export interface CallResult<T> extends PolicyResponse<T> {
  observationHash: string;
}

export async function callPolicy<T>(
  policy: Policy,
  log: CallSink,
  spend: Spend,
  request: { name: string; system: string; observation: string; schema: object; images?: PolicyImage[]; maxTokens?: number }
): Promise<CallResult<T>> {
  const observationHash = contentHash(request.observation);
  const trace = tracingEnabled(policy.kind);
  const startedAt = Date.now();
  let response: PolicyResponse<T>;
  try {
    response = await policy.call<T>(request);
  } catch (e) {
    // A call that never validated is still a call that happened, and it is logged before it throws.
    spend.policyCalls++;
    spend.failed++;
    const error = e instanceof Error ? e.message : String(e);
    log.append('policy-call', {
      name: request.name,
      model: policy.model,
      observationHash,
      observation: request.observation,
      system: request.system,
      schema: request.schema,
      hasImages: Boolean(request.images?.length),
      error,
      ...(e instanceof PolicyError ? { errorKind: e.kind } : {}),
      ok: false,
    });
    if (trace) {
      await traceCall({
        name: request.name,
        traceGroup: log.file,
        model: policy.model,
        system: request.system,
        observation: request.observation,
        observationHash,
        startedAt,
        endedAt: Date.now(),
        ok: false,
        error,
      });
    }
    throw e;
  }

  spend.policyCalls++;
  spend.inputTokens += response.usage.inputTokens;
  spend.outputTokens += response.usage.outputTokens;
  spend.usd += response.usage.usd;
  if (response.attempts > 1) spend.retried++;

  log.append('policy-call', {
    name: request.name,
    model: response.model,
    observationHash,
    observation: request.observation,
    system: request.system,
    schema: request.schema,
    hasImages: Boolean(request.images?.length),
    action: response.action,
    raw: response.raw,
    attempts: response.attempts,
    failures: response.failures,
    usage: response.usage,
    ok: true,
  });

  if (trace) {
    await traceCall({
      name: request.name,
      traceGroup: log.file,
      model: response.model,
      system: request.system,
      observation: request.observation,
      observationHash,
      startedAt,
      endedAt: Date.now(),
      ok: true,
      action: response.action,
      raw: response.raw,
      attempts: response.attempts,
      failures: response.failures,
      usage: response.usage,
    });
  }

  return { ...response, observationHash };
}
