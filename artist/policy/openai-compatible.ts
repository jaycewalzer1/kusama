// OpenAICompatiblePolicy: the same contract against an OpenAI-shaped /chat/completions endpoint.
//
// This exists so that the policy can be swapped for a locally served checkpoint later without any
// other file in artist/ changing. It is deliberately written against `fetch` and the wire format
// rather than against a client library: vLLM, SGLang and friends all speak this shape, and none of
// them speak the same SDK.
//
// Structured output is asked for as a function tool with `tool_choice` pinned, and re-checked here,
// exactly as in ./anthropic.ts. Serving stacks vary in how well they honour a schema; the local
// re-check is what makes the retry loop mean the same thing on both.
//
// One asymmetry with the Anthropic path is load-bearing. `maxTokens` on a PolicyRequest is the
// phase's estimate of how long the *answer* is, and on a reasoning model the answer shares that
// budget with a hidden reasoning pass that can be several thousand tokens on its own. When the
// budget runs out mid-argument the endpoint returns `finish_reason: "length"` and no tool call,
// which is indistinguishable, from the outside, from a model that ignored the tool — so it gets
// reported as one, and the real cause stays invisible. Both halves of that are handled below: a
// truncated answer says it was truncated, and the retry raises the budget instead of lecturing the
// model about a schema it never got to finish writing.

import { usd } from '../pricing.js';
import { PolicyError, type Policy, type PolicyRequest, type PolicyResponse } from './interface.js';
import { schemaErrors } from './schema-check.js';

const TOOL = 'emit';

interface ChatResponse {
  choices: {
    finish_reason?: string;
    message: {
      content: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export class OpenAICompatiblePolicy implements Policy {
  readonly kind = 'openai-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly reasoningTokens: number;

  constructor() {
    this.baseUrl = (process.env['ARTIST_BASE_URL'] ?? '').replace(/\/+$/, '');
    if (!this.baseUrl) {
      throw new PolicyError('ARTIST_BASE_URL is not set, so there is no OpenAI-compatible endpoint to call', 'configuration');
    }
    this.apiKey = process.env['ARTIST_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? 'no-key';
    this.model = process.env['ARTIST_MODEL'] ?? 'local';
    this.temperature = Number(process.env['ARTIST_TEMPERATURE'] ?? '1');
    // Headroom for the hidden reasoning pass, added to whatever the phase asked for. Zero by
    // default, because a plain served checkpoint has no such pass and inflating its budget would
    // just let it ramble. Set it when the model reasons; the retry below is the safety net when
    // it is set too low, not a substitute for setting it.
    this.reasoningTokens = Number(process.env['ARTIST_REASONING_TOKENS'] ?? '0');
  }

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    const failures: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let raw = '';

    let budget = (request.maxTokens ?? 4096) + this.reasoningTokens;
    let truncated = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // A truncated answer gets the same question with more room, not a correction. It did not get
      // the schema wrong; it ran out of tokens before it could finish being right.
      const text =
        attempt === 1 || truncated
          ? request.observation
          : `${request.observation}\n\n---\nYour previous answer did not satisfy the schema:\n${failures.join('\n')}\n\nAnswer again, correcting exactly those problems. Change nothing else.`;

      const content: unknown[] = [];
      for (const image of request.images ?? []) {
        content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } });
      }
      content.push({ type: 'text', text });

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          // `max_completion_tokens`, not `max_tokens`: OpenAI rejects the older name outright on
          // gpt-5 and o3, and vLLM/SGLang accept both, so the current name is the portable one.
          max_completion_tokens: budget,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content },
          ],
          tools: [{ type: 'function', function: { name: TOOL, description: 'Emit the answer. This is the only way to answer.', parameters: request.schema } }],
          tool_choice: { type: 'function', function: { name: TOOL } },
        }),
      });
      if (!res.ok) {
        throw new PolicyError(`${request.name}: ${this.baseUrl} answered ${res.status} ${await res.text()}`, 'transport');
      }
      const body = (await res.json()) as ChatResponse;
      inputTokens += body.usage?.prompt_tokens ?? 0;
      outputTokens += body.usage?.completion_tokens ?? 0;

      const call = body.choices[0]?.message.tool_calls?.find((c) => c.function.name === TOOL);
      if (!call) {
        raw = body.choices[0]?.message.content ?? '';
        truncated = body.choices[0]?.finish_reason === 'length';
        if (truncated) {
          const reasoning = body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
          failures.push(
            `/ the answer was cut off at max_completion_tokens=${budget} before the tool call was complete` +
              (reasoning ? ` (${reasoning} of those went to reasoning, which the phase's token estimate does not see)` : '')
          );
          budget *= 4;
        } else {
          failures.push('/ the model answered without calling the emit tool, so there is no action');
        }
        continue;
      }
      truncated = false;
      raw = call.function.arguments;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        failures.push(`/ the tool arguments are not JSON: ${(e as Error).message}`);
        continue;
      }
      const errors = schemaErrors(parsed, request.schema);
      if (errors.length === 0) {
        return {
          action: parsed as T,
          raw,
          // Priced from the same table the other two doors use. It used to be a hard 0 with the
          // note that a self-hosted endpoint has no price — true of a local checkpoint, and false
          // of the hosted model this adapter has actually been pointed at, which reported half a
          // million input tokens against `usd: 0` and made the run unbudgetable. `usd()` still
          // returns 0 for a model it does not know, so the local case reads exactly as before.
          usage: { inputTokens, outputTokens, usd: usd(this.model, inputTokens, outputTokens) },
          attempts: attempt,
          failures,
          model: this.model,
        };
      }
      failures.push(...errors);
    }

    throw new PolicyError(
      `${request.name}: the policy did not produce a schema-valid action in two attempts:\n  ${failures.join('\n  ')}`,
      truncated ? 'output' : 'schema'
    );
  }
}
