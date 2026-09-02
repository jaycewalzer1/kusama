// AnthropicPolicy: the trainable half, against the Anthropic SDK.
//
// One call per decision. Structured output is asked for the only way that is actually enforced —
// a single tool whose input_schema is the action schema, with tool_choice pinned to it — and then
// re-checked here against the same schema. On a schema failure the call is retried exactly once with
// the validator's own words appended, and then it gives up: a loop that keeps asking until the model
// stumbles into a valid shape is a loop that hides how bad the schema is.
//
// This file and ./openai-compatible.ts are the only two files under artist/ permitted to import a
// model SDK, and tests/artist/framework-free.test.ts asserts it.

import Anthropic from '@anthropic-ai/sdk';
import { PolicyError, type Policy, type PolicyRequest, type PolicyResponse } from './interface.js';
import { schemaErrors } from './schema-check.js';
import { usd } from '../pricing.js';

const TOOL = 'emit';

export class AnthropicPolicy implements Policy {
  readonly kind = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly temperature: number;

  constructor() {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) throw new PolicyError('ANTHROPIC_API_KEY is not set, so there is no policy to call', 'configuration');
    this.client = new Anthropic({ apiKey: key });
    this.model = process.env['ARTIST_MODEL'] ?? 'claude-sonnet-4-6';
    this.temperature = Number(process.env['ARTIST_TEMPERATURE'] ?? '1');
  }

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    const failures: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let raw = '';
    let truncated = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const text =
        attempt === 1
          ? request.observation
          : `${request.observation}\n\n---\nYour previous answer did not satisfy the schema:\n${failures.join('\n')}\n\nAnswer again, correcting exactly those problems. Change nothing else.`;

      const content: Anthropic.ContentBlockParam[] = [];
      for (const image of request.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
      }
      content.push({ type: 'text', text });

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 4096,
        temperature: this.temperature,
        system: request.system,
        messages: [{ role: 'user', content }],
        tools: [{ name: TOOL, description: 'Emit the answer. This is the only way to answer.', input_schema: request.schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: 'tool', name: TOOL },
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      const block = response.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use' && c.name === TOOL);
      if (!block) {
        truncated = response.stop_reason === 'max_tokens';
        raw = JSON.stringify(response.content);
        failures.push('/ the model answered without calling the emit tool, so there is no action');
        continue;
      }
      truncated = false;
      raw = JSON.stringify(block.input);
      const errors = schemaErrors(block.input, request.schema);
      if (errors.length === 0) {
        return {
          action: block.input as T,
          raw,
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
