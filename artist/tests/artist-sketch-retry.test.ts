// A refused sketch gets one retry, and the retry is told what was refused.
//
// CHOOSE decides between problems by looking at their sketches, so a sketch dropped on a refusal is a
// problem removed from the running for a reason that has nothing to do with the problem: in one
// measured run that left the artist choosing the problem it had itself ranked at 8%, because those
// were the sketches that happened to render. These four cases pin the two failure sources, the
// recovery, and the fact that the retry is not a loop.
//
// No model and no browser. The policy is a script and the canvas is a stub, so this costs nothing and
// says nothing about whether a real sketch renders — only about what SKETCH does when one does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sketch } from '../phases/sketch.js';
import { loadCommission } from '../field.js';
import { seedProgram } from '../seed.js';
import { newSpend } from '../call.js';
import { readLog, StudioLog } from '../studio-log.js';
import type { Canvas } from '../canvas.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';
import type { Problem } from '../types.js';
import { requestsFromGoal } from '../sample-planner.js';
import { SAMPLE_SCHEMA_VERSION, type SamplingPlan } from '../../aesthetic/sample-types.js';

const PROBLEM: Problem = {
  id: 'p-date',
  text: 'A date is the only part of this anyone can act on, and the least interesting thing to draw.',
  tension: { between: 'information', and: 'form', claim: 'the actionable part is the dull part' },
  fieldRefs: ['a date he can put in a diary would stop him'],
};

/** A rule the validator takes, and the same rule aimed at a parent that does not exist. */
const GOOD = {
  actionId: 'ok',
  kind: 'add_node',
  targets: ['sheet'],
  parent: 'sheet',
  node: { id: 'r-bar', type: 'op', op: 'rule', rngKey: 'r-bar', args: { from: [40, 120], to: [300, 120], weight: 6, brush: 'marker', color: 'ink' } },
};
const BAD = { ...GOOD, actionId: 'bad', targets: ['nowhere'], parent: 'nowhere' };

/** Answers `sketch` from a fixed script, one entry per call, and keeps what it was shown. */
class ScriptedPolicy implements Policy {
  readonly kind = 'scripted';
  readonly model = 'scripted';
  readonly requests: PolicyRequest[] = [];
  private n = 0;

  constructor(private readonly script: Record<string, unknown>[][]) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.requests.push(request);
    const edits = this.script[Math.min(this.n++, this.script.length - 1)]!;
    return {
      action: { approach: 'One rule, and nothing else on the sheet.', edits } as T,
      raw: '',
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }
}

/** Renders nothing. `fail` is thrown from `render`, so the second failure source needs no browser. */
function stubCanvas(fail: string | null): Canvas {
  return {
    async render() {
      if (fail) throw new Error(fail);
      return { programHash: 'ph', pixelHash: 'xh', png: Buffer.from('png'), width: 520, height: 700, metrics: null };
    },
  } as unknown as Canvas;
}

const OUT = mkdtempSync(path.join(tmpdir(), 'sketch-retry-'));
let dirs = 0;

async function run(script: Record<string, unknown>[][], fail: string | null) {
  const policy = new ScriptedPolicy(script);
  const log = new StudioLog(path.join(OUT, `run-${dirs++}`));
  const commission = loadCommission('interference', 'nine-returned');
  const result = await sketch(policy, log, newSpend(), commission, PROBLEM, 0, seedProgram(4242), stubCanvas(fail));
  return { result, requests: policy.requests };
}

test('a sketch whose edits are all refused is retried once, with the validator sentences', async () => {
  const { requests } = await run([[BAD]], null);
  assert.equal(requests.length, 2);
  const retry = requests[1]!.observation;
  assert.match(retry, /WHAT HAPPENED THE FIRST TIME YOU DREW THIS/);
  assert.match(retry, /Every edit was refused/);
  assert.match(retry, /bad/);
  assert.ok(retry.startsWith(requests[0]!.observation), 'the retry is the first observation plus a section, not a different prompt');
});

test('a sketch that will not render is retried once, with the render error', async () => {
  const { result, requests } = await run([[GOOD]], 'canvas: no such brush');
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.observation, /would not render: canvas: no such brush/);
  assert.equal(result.failure, 'canvas: no such brush');
  assert.equal(result.png, null);
});

test('the retry is the last one: a sketch that fails twice is dropped as it always was', async () => {
  const { result, requests } = await run([[BAD]], null);
  assert.equal(requests.length, 2);
  assert.equal(result.failure, 'every edit was refused');
  assert.equal(result.png, null);
  assert.equal(result.program, null);
});

test('a retry that works is a sketch, not a failure', async () => {
  const { result, requests } = await run([[BAD], [GOOD]], null);
  assert.equal(requests.length, 2);
  assert.equal(result.failure, null);
  assert.ok(result.png, 'the second attempt rendered');
  assert.equal(result.programHash, 'ph');
});

test('a sketch that works first time is one call, unchanged', async () => {
  const { result, requests } = await run([[GOOD]], null);
  assert.equal(requests.length, 1);
  assert.equal(result.failure, null);
  assert.ok(result.png);
});

test('an invalid advisory binding rejects the sketch attempt and a valid retry is recorded', async () => {
  const goal = { subject: 'a public date notice', percepts: ['interruption'], avoid: ['pastiche'] };
  const request = requestsFromGoal(goal)[0]!;
  const sampling = {
    schemaVersion: SAMPLE_SCHEMA_VERSION,
    planId: 'binding-plan',
    seed: 4242,
    indexId: 'binding-index',
    goal,
    requests: [request],
    // SKETCH consumes declared requests, not selected source data. The compiler never sees this
    // fixture; its one placeholder only keeps the plan's min-one contract honest at the type edge.
    samples: [{} as SamplingPlan['samples'][number]],
    createdBy: { kind: 'deterministic-fallback' as const },
  } satisfies SamplingPlan;
  class BindingPolicy implements Policy {
    readonly kind = 'scripted';
    readonly model = 'scripted';
    calls = 0;
    async call<T>(): Promise<PolicyResponse<T>> {
      const bindings = this.calls++ === 0
        ? { [request.role]: ['missing-node'] }
        : { [request.role]: ['r-bar'] };
      const action = { approach: 'One rule, and nothing else on the sheet.', edits: [GOOD], bindings };
      return {
        action: action as T, raw: JSON.stringify(action),
        usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, attempts: 1, failures: [], model: this.model,
      };
    }
  }
  const policy = new BindingPolicy();
  const dir = path.join(OUT, `run-${dirs++}`);
  const log = new StudioLog(dir);
  const result = await sketch(
    policy, log, newSpend(), loadCommission('interference', 'nine-returned'), PROBLEM,
    0, seedProgram(4242), stubCanvas(null), null, null, sampling
  );
  assert.equal(policy.calls, 2);
  assert.deepEqual(result.bindings, { [request.role]: ['r-bar'] });
  const events = readLog(log.file).filter((line) => line.kind === 'binding_declared');
  assert.deepEqual(events.map((line) => (line.data as { accepted: boolean }).accepted), [false, true]);
});
