// A sink for policy calls, and only a sink.
//
// LangSmith is a place to look at a trajectory while it is running. It is not a place this loop ever
// reads from, and that is the whole design constraint: studio.jsonl is the record, this is a copy of
// part of it for a human, and if the two ever disagreed the file on disk is right. Nothing in
// artist/ imports this module except call.ts, nothing exports a way to query it, and a trace that
// fails is not an error — a trajectory must not die because an observability vendor was down.
//
// Off by default, and off in three separate ways, because a trace that fired during a test or a
// replay would put the network inside a path that is supposed to be offline and reproducible:
//   - LANGSMITH_TRACING must be exactly "1";
//   - LANGSMITH_API_KEY must be set;
//   - the policy must be one of the two that actually reach a model. A replay drives the real loop
//     with a RecordedPolicy and a test drives it with a StubPolicy; neither made a model call, so
//     neither has anything to trace.
//
// Written with `fetch` against the ingest endpoint rather than against langsmith's SDK, for the same
// reason env-model.ts is: see tests/artist-guards.test.ts, which asserts that no file here imports a
// framework and that only policy/anthropic.ts imports a model SDK.

import { createHash, randomUUID } from 'node:crypto';

const REAL_POLICIES = new Set(['anthropic', 'openai-compatible']);

/** How long a trace POST may take before it is abandoned. Bounded so the loop cannot be held up. */
const TIMEOUT_MS = 5000;

export function tracingEnabled(policyKind: string): boolean {
  return (
    process.env['LANGSMITH_TRACING'] === '1' &&
    Boolean(process.env['LANGSMITH_API_KEY']) &&
    REAL_POLICIES.has(policyKind)
  );
}

export interface TraceCall {
  /** The decision: 'find' | 'choose' | 'act' | 'replan' | 'examine'. Becomes the run name. */
  name: string;
  /** Groups every call of one trajectory under one trace. Derived from the studio log's path. */
  traceGroup: string;
  model: string;
  system: string;
  observation: string;
  observationHash: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  action?: unknown;
  raw?: string;
  attempts?: number;
  failures?: string[];
  usage?: { inputTokens: number; outputTokens: number; usd: number };
  error?: string;
}

/** A stable UUID from any string, so one trajectory keeps one trace id across its calls. */
function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Sends one call. Awaited rather than fired and forgotten: an un-awaited POST can be lost when the
 * process exits and can surface as an unhandled rejection, and the cost of waiting is one bounded
 * round trip against a model call that already took seconds. Every failure is swallowed.
 */
export async function traceCall(call: TraceCall): Promise<void> {
  const endpoint = process.env['LANGSMITH_ENDPOINT'] ?? 'https://api.smith.langchain.com';
  const traceId = uuidFrom(call.traceGroup);
  const runId = randomUUID();

  try {
    await fetch(`${endpoint}/runs/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env['LANGSMITH_API_KEY'] as string },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        post: [
          {
            id: runId,
            trace_id: traceId,
            // A flat trace: every call is a child of the trajectory, because the loop has no nesting
            // to report. Inventing a phase hierarchy here would be a second model of the run.
            dotted_order: `${new Date(call.startedAt).toISOString()}${traceId}.${new Date(call.startedAt).toISOString()}${runId}`,
            parent_run_id: null,
            name: call.name,
            run_type: 'llm',
            start_time: new Date(call.startedAt).toISOString(),
            end_time: new Date(call.endedAt).toISOString(),
            session_name: process.env['LANGSMITH_PROJECT'] ?? 'kusama-artist',
            inputs: { system: call.system, observation: call.observation },
            outputs: call.ok ? { action: call.action, raw: call.raw } : undefined,
            error: call.error,
            extra: {
              metadata: {
                model: call.model,
                observationHash: call.observationHash,
                attempts: call.attempts,
                failures: call.failures,
                usd: call.usage?.usd,
              },
            },
          },
        ],
      }),
    });
  } catch {
    // Deliberately silent and deliberately total. The trajectory is the work; this is a mirror.
  }
}
