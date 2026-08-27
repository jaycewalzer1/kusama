// The one door to a model that is allowed to be trained.
//
// Every decision the artist makes is exactly one call through here: a name, a serialized
// observation, and a JSON schema the answer has to satisfy. There is no chain, no graph, no agent
// object holding hidden state between calls. That is not an aesthetic preference — it is the whole
// reason a trajectory can be replayed and rescored offline later. State that lives in a framework's
// memory is state that cannot be written to a log line.
//
// Two implementations satisfy this and nothing else in artist/ may import a model SDK:
//   policy/anthropic.ts           the SDK, structured output, one retry on a schema failure
//   policy/openai-compatible.ts   the same contract against an OpenAI-shaped /chat/completions
// tests/artist/framework-free.test.ts asserts both halves of that.
//
// Environment calls (DESCRIBE, AUDIENCE, the two disagreement checks) deliberately do NOT come
// through here. They go through ../env-model.ts, which is frozen and cached. Mixing them would mean
// training against a signal the policy could learn to move.

export interface PolicyImage {
  mediaType: 'image/png';
  base64: string;
}

export interface PolicyRequest {
  /** The decision being made: 'find' | 'choose' | 'act' | 'replan' | 'examine'. Logged verbatim. */
  name: string;
  system: string;
  /** The serialized observation. Produced only by ../observation.ts. */
  observation: string;
  /** JSON Schema the returned action must satisfy. Enforced by the provider and re-checked here. */
  schema: object;
  images?: PolicyImage[];
  /** Hard cap on output tokens for this decision. */
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface PolicyResponse<T = unknown> {
  action: T;
  /** The raw text or JSON the model emitted, kept so a failed trajectory can still be read. */
  raw: string;
  usage: Usage;
  /** 1 when the first answer validated, 2 when the retry did. */
  attempts: number;
  /** Validator errors from every attempt that failed. Empty on a first-try success. */
  failures: string[];
  model: string;
}

export interface Policy {
  readonly kind: string;
  readonly model: string;
  call<T>(request: PolicyRequest): Promise<PolicyResponse<T>>;
}

export class PolicyError extends Error {}

/**
 * Which implementation this process uses. `ARTIST_POLICY` picks it; there is no silent default to a
 * paid provider, because a test that quietly started spending money would be the worst thing here.
 * Tests construct a StubPolicy directly and never come through this function.
 */
export async function selectPolicy(): Promise<Policy> {
  const kind = process.env['ARTIST_POLICY'] ?? 'anthropic';
  if (kind === 'anthropic') {
    const { AnthropicPolicy } = await import('./anthropic.js');
    return new AnthropicPolicy();
  }
  if (kind === 'openai-compatible') {
    const { OpenAICompatiblePolicy } = await import('./openai-compatible.js');
    return new OpenAICompatiblePolicy();
  }
  throw new PolicyError(`ARTIST_POLICY="${kind}" is not a policy; use "anthropic" or "openai-compatible"`);
}
