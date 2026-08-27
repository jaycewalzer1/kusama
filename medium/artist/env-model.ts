// The environment's model: frozen, cached, and blind.
//
// Four calls live here and none of them is the artist. DESCRIBE says what is on the sheet. AUDIENCE
// says what one passer-by would take it to mean. Two disagreement checks compare those two answers
// against the intention. All four are part of the environment, exactly like `checkProgram` and
// `render` are, and they are treated the way an environment has to be treated if any of this is
// going to be trainable later:
//
//   frozen   one model id, temperature 0, one system prompt each, pinned in this file. If the
//            describer improves next quarter, every trajectory scored before it becomes
//            incomparable with every trajectory scored after, so it does not get to improve.
//   cached   keyed by the whole request, on disk. A rescore is free and, more importantly, gives
//            the same answer as the run did. reward.ts depends on this and nothing else.
//   blind    DESCRIBE is handed a PNG and nothing else. AUDIENCE is handed a PNG and the field's
//            who-is-watching paragraph and nothing else. Neither ever sees the position, the brief,
//            or the intention, because a describer that knows what the picture was meant to be will
//            describe what it was meant to be. That is the entire value of the signal.
//
// Nothing here is ever trained. tests/artist/blindness.test.ts asserts the second and third points
// against the recorded requests, which is why every request is recorded whole.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { canonicalJson } from '../env/profile.js';
import { schemaErrors } from './policy/schema-check.js';
import { usd } from './pricing.js';

/** Frozen. Changing either of these is a new environment version, not a tweak. */
export const ENV_MODEL = 'claude-haiku-4-5-20251001';
export const ENV_TEMPERATURE = 0;

const CACHE_DIR = path.join(ROOT, '.cache', 'artist-env');

export type EnvCallName = 'describe' | 'audience' | 'description-agrees' | 'audience-agrees';

export interface EnvRequest {
  name: EnvCallName;
  system: string;
  text: string;
  /** base64 PNG. Present for describe and audience, absent for the two text comparisons. */
  imageBase64?: string;
  schema: object;
}

export interface EnvResponse<T> {
  value: T;
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cacheKey: string;
}

/**
 * Every request this process made, minus the image bytes. Read by the blindness test, which is the
 * only honest way to assert what a prompt did not contain.
 */
export const recentEnvRequests: { name: EnvCallName; system: string; text: string; hasImage: boolean }[] = [];

type EnvModelFn = <T>(request: EnvRequest) => Promise<EnvResponse<T>>;

let override: EnvModelFn | null = null;

/** Tests install a deterministic stand-in here. There is no env var for this on purpose. */
export function setEnvModel(fn: EnvModelFn | null): void {
  override = fn;
}

function cacheKey(request: EnvRequest): string {
  const image = request.imageBase64 ? createHash('sha256').update(request.imageBase64).digest('hex') : null;
  return createHash('sha256')
    .update(
      canonicalJson({
        model: ENV_MODEL,
        temperature: ENV_TEMPERATURE,
        name: request.name,
        system: request.system,
        text: request.text,
        image,
        schema: request.schema,
      })
    )
    .digest('hex');
}

interface AnthropicResponse {
  content: { type: string; name?: string; input?: unknown }[];
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Written against the wire format with `fetch`, not against the SDK, and the reason is the word
 * "frozen" above. A frozen environment cannot have a dependency whose minor version can change how
 * it behaves; the HTTP shape is the thing that is actually stable. It also keeps the rule that only
 * the two policy files import a model SDK literally true — see tests/artist-guards.test.ts.
 */
async function post(body: unknown): Promise<AnthropicResponse> {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set, so the environment has no describer');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`the environment model answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as AnthropicResponse;
}

/**
 * One environment call. Cached first, so a replay or a rescore never reaches the network and never
 * gets a different answer than the run did.
 */
export async function envModel<T>(request: EnvRequest): Promise<EnvResponse<T>> {
  recentEnvRequests.push({ name: request.name, system: request.system, text: request.text, hasImage: Boolean(request.imageBase64) });
  if (override) return override<T>(request);

  const key = cacheKey(request);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const hit = JSON.parse(readFileSync(file, 'utf8')) as { value: T };
    return { value: hit.value, cached: true, inputTokens: 0, outputTokens: 0, usd: 0, cacheKey: key };
  } catch {
    // A miss is the normal path the first time and is not an error.
  }

  const content: unknown[] = [];
  if (request.imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: request.imageBase64 } });
  }
  content.push({ type: 'text', text: request.text });

  const response = await post({
    model: ENV_MODEL,
    max_tokens: 1024,
    temperature: ENV_TEMPERATURE,
    system: request.system,
    messages: [{ role: 'user', content }],
    tools: [{ name: 'emit', description: 'Emit the answer.', input_schema: request.schema }],
    tool_choice: { type: 'tool', name: 'emit' },
  });

  const block = response.content.find((c) => c.type === 'tool_use' && c.name === 'emit');
  if (!block) throw new Error(`env call "${request.name}" answered without calling the emit tool`);
  const errors = schemaErrors(block.input, request.schema);
  // No retry. The environment is frozen: if it cannot answer its own fixed question in its own fixed
  // shape, that is a fact about the environment and the run should stop rather than paper over it.
  if (errors.length) throw new Error(`env call "${request.name}" broke its own schema: ${errors.join('; ')}`);

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ request: { name: request.name, system: request.system, text: request.text }, value: block.input }, null, 2)}\n`);

  return {
    value: block.input as T,
    cached: false,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    usd: usd(ENV_MODEL, response.usage.input_tokens, response.usage.output_tokens),
    cacheKey: key,
  };
}
