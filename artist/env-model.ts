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

/**
 * Frozen. Changing either of these is a new environment version, not a tweak.
 *
 * Repointed from `claude-haiku-4-5-20251001` on 2026-08-28 because the Anthropic account has no
 * credit and the environment cannot describe anything without one. That is a forced move, not an
 * upgrade, and it is recorded here rather than in a config file so that reading this line tells you
 * what eyes the reward signal was computed with. Every cache entry written before it is dead: the
 * cache key hashes ENV_MODEL, so old entries can never be served to a run under the new one.
 *
 * The model has to hold three properties at once and this is the cheapest OpenAI model that does:
 * it accepts `temperature: 0`, it reads images, and it honours a forced tool call. `gpt-5` and `o3`
 * fail the first — they accept only their default temperature of 1 — which disqualifies them from
 * being an environment at all, whatever else they are good at.
 */
export const ENV_MODEL = 'gpt-4o-2024-11-20';
export const ENV_TEMPERATURE = 0;

const CACHE_DIR = path.join(ROOT, '.cache', 'artist-env');

export type EnvCallName =
  | 'describe'
  | 'transcribe'
  | 'audience'
  | 'description-agrees'
  | 'audience-agrees'
  // The corpus reader. Not part of a trajectory — these run once, offline, when a work is imported —
  // but they belong to the environment for exactly the reason the four above do: a reading made with
  // a different model is not comparable with a reading made with this one, and the whole corpus is
  // supposed to stay comparable with itself for as long as the elements derived from it are in use.
  | 'read-work'
  | 'identify-work';

export interface EnvRequest {
  name: EnvCallName;
  system: string;
  text: string;
  /** base64 image bytes. Present for describe, audience and the corpus reader; absent otherwise. */
  imageBase64?: string;
  /**
   * The image's media type. Omitted means PNG, which is what the medium renders and what every call
   * that predates the corpus sends. It is omitted rather than defaulted to `image/png` on purpose:
   * `canonicalJson` drops undefined keys, so an absent mime hashes to exactly the key it hashed to
   * before this field existed and no cache entry in `.cache/artist-env` is invalidated.
   */
  imageMime?: string;
  /**
   * Completion budget. Omitted means 1024, which is what the four trajectory calls have always used
   * and must keep using. A structured reading of a painting does not fit in 1024 and truncation here
   * is reported as "answered without calling the emit tool", which is a lie about the cause.
   */
  maxTokens?: number;
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
        imageMime: request.imageMime,
        maxTokens: request.maxTokens,
        schema: request.schema,
      })
    )
    .digest('hex');
}

interface ChatResponse {
  choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Written against the wire format with `fetch`, not against the SDK, and the reason is the word
 * "frozen" above. A frozen environment cannot have a dependency whose minor version can change how
 * it behaves; the HTTP shape is the thing that is actually stable. It also keeps the rule that only
 * the two policy files import a model SDK literally true — see tests/artist-guards.test.ts.
 */
async function post(body: unknown): Promise<ChatResponse> {
  const key = process.env['OPENAI_API_KEY'];
  if (!key) throw new Error('OPENAI_API_KEY is not set, so the environment has no describer');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`the environment model answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as ChatResponse;
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
    const mime = request.imageMime ?? 'image/png';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${request.imageBase64}` } });
  }
  content.push({ type: 'text', text: request.text });

  const response = await post({
    model: ENV_MODEL,
    max_completion_tokens: request.maxTokens ?? 1024,
    temperature: ENV_TEMPERATURE,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content },
    ],
    tools: [{ type: 'function', function: { name: 'emit', description: 'Emit the answer.', parameters: request.schema } }],
    tool_choice: { type: 'function', function: { name: 'emit' } },
  });

  const call = response.choices[0]?.message.tool_calls?.find((c) => c.function.name === 'emit');
  if (!call) throw new Error(`env call "${request.name}" answered without calling the emit tool`);
  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments);
  } catch (e) {
    throw new Error(`env call "${request.name}" emitted arguments that are not JSON: ${(e as Error).message}`);
  }
  const errors = schemaErrors(value, request.schema);
  // No retry. The environment is frozen: if it cannot answer its own fixed question in its own fixed
  // shape, that is a fact about the environment and the run should stop rather than paper over it.
  if (errors.length) throw new Error(`env call "${request.name}" broke its own schema: ${errors.join('; ')}`);

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ request: { name: request.name, system: request.system, text: request.text }, value }, null, 2)}\n`);

  return {
    value: value as T,
    cached: false,
    inputTokens,
    outputTokens,
    usd: usd(ENV_MODEL, inputTokens, outputTokens),
    cacheKey: key,
  };
}
