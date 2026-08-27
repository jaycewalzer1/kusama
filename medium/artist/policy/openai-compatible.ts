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

import { PolicyError, type Policy, type PolicyRequest, type PolicyResponse } from './interface.js';
import { schemaErrors } from './schema-check.js';

const TOOL = 'emit';

interface ChatResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatiblePolicy implements Policy {
  readonly kind = 'openai-compatible';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;

  constructor() {
    this.baseUrl = (process.env['ARTIST_BASE_URL'] ?? '').replace(/\/+$/, '');
    if (!this.baseUrl) {
      throw new PolicyError('ARTIST_BASE_URL is not set, so there is no OpenAI-compatible endpoint to call');
    }
    this.apiKey = process.env['ARTIST_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? 'no-key';
    this.model = process.env['ARTIST_MODEL'] ?? 'local';
    this.temperature = Number(process.env['ARTIST_TEMPERATURE'] ?? '1');
  }

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    const failures: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let raw = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const text =
        attempt === 1
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
          max_tokens: request.maxTokens ?? 4096,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content },
          ],
          tools: [{ type: 'function', function: { name: TOOL, description: 'Emit the answer. This is the only way to answer.', parameters: request.schema } }],
          tool_choice: { type: 'function', function: { name: TOOL } },
        }),
      });
      if (!res.ok) {
        throw new PolicyError(`${request.name}: ${this.baseUrl} answered ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as ChatResponse;
      inputTokens += body.usage?.prompt_tokens ?? 0;
      outputTokens += body.usage?.completion_tokens ?? 0;

      const call = body.choices[0]?.message.tool_calls?.find((c) => c.function.name === TOOL);
      if (!call) {
        raw = body.choices[0]?.message.content ?? '';
        failures.push('/ the model answered without calling the emit tool, so there is no action');
        continue;
      }
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
          // No price table for a self-hosted endpoint; the token counts are the honest cost.
          usage: { inputTokens, outputTokens, usd: 0 },
          attempts: attempt,
          failures,
          model: this.model,
        };
      }
      failures.push(...errors);
    }

    throw new PolicyError(
      `${request.name}: the policy did not produce a schema-valid action in two attempts:\n  ${failures.join('\n  ')}`
    );
  }
}
