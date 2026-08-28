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
import type { Policy, PolicyImage, PolicyResponse } from './policy/interface.js';
import type { StudioLog } from './studio-log.js';
import { traceCall, tracingEnabled } from './trace.js';

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
  log: StudioLog,
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
