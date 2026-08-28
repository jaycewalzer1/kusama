// Dollars per million tokens, for the cost line in a report.
//
// Reporting only. Nothing in the loop reads a price to make a decision, and nothing should: an artist
// that could see what it was spending would be optimising something nobody asked it to optimise.
//
// It lives in its own file so that env-model.ts — which is the frozen environment and must not depend
// on a model SDK's version — can quote a price without importing the SDK through the policy.

const PRICE: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-2025-08-07': { input: 1.25, output: 10 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-2025-04-14': { input: 2, output: 8 },
  'gpt-4o-2024-11-20': { input: 2.5, output: 10 },
};

/** Zero for a model with no entry: an unknown price is reported as unknown, never guessed. */
export function usd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICE[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
