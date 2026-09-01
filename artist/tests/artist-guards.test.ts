// The rules that are only rules if something checks them.
//
// Three properties of this codebase are load-bearing for whether any of it can be trained on later,
// and all three are the kind that decay silently under ordinary maintenance: no framework, one door
// to the policy, a different door to the environment. Each is asserted here by reading the source
// files, which is blunt but is the only way to assert "nobody imported X" without running everything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tracingEnabled } from '../trace.js';

// Three levels up from `dist/artist/tests/`, because these read the TypeScript sources, not the
// build. The scan skips `artist/tests/` itself: a test that asserts nobody imports a model SDK has
// to name one to do it, and a guard that trips on its own guard is not checking anything.
const ARTIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'artist');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'tests') return [];
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

const FILES = sources(ARTIST);
const rel = (f: string) => path.relative(ARTIST, f);

test('gate 7: no agent framework is imported anywhere in artist/', () => {
  const banned = ['langchain', 'langgraph', '@langchain', 'llamaindex', 'crewai', 'autogen', 'haystack', 'semantic-kernel'];
  for (const file of FILES) {
    const source = read(file).toLowerCase();
    for (const name of banned) {
      assert.ok(!source.includes(`from '${name}`), `${rel(file)} imports ${name}`);
      assert.ok(!source.includes(`require('${name}`), `${rel(file)} requires ${name}`);
    }
  }
  assert.ok(FILES.length > 15, 'the guard is reading the real source tree');
});

test('gate 7: exactly one file imports a model SDK, and it is a policy', () => {
  const importers = FILES.filter((f) => /from '(@anthropic-ai\/sdk|openai)'/.test(read(f))).map(rel);
  assert.deepEqual(importers, [path.join('policy', 'anthropic.ts')]);
});

test('the policy has one door: only call.ts invokes it', () => {
  const callers = FILES.filter((f) => /policy\.call</.test(read(f))).map(rel);
  assert.deepEqual(callers, ['call.ts']);
});

test('policy calls and environment calls do not share a path', () => {
  // Nothing that reaches envModel may also reach the policy, and vice versa. If these ever merge,
  // the artist is being trained against a signal it can move, which is the one unrecoverable mistake.
  // `corpus.ts` and `element-derive.ts` are on this list and neither is part of a trajectory: they
  // run offline, once, when a work is imported and when an element is derived from it. They are
  // here rather than exempted because the property being asserted is not "few files call the
  // environment" but "no file calls both", and the loop below is what checks that.
  const envCallers = FILES.filter((f) => /\benvModel[<(]/.test(read(f))).map(rel).sort();
  assert.deepEqual(envCallers, ['corpus.ts', 'element-derive.ts', 'env-calls.ts', 'env-model.ts']);

  for (const file of FILES.filter((f) => envCallers.includes(rel(f)))) {
    assert.ok(!/policy\.call</.test(read(file)), `${rel(file)} reaches both the policy and the environment`);
    assert.ok(!/from '\.\/policy\/interface\.js'/.test(read(file)), `${rel(file)} imports the policy interface`);
  }
  assert.ok(!/envModel/.test(read(path.join(ARTIST, 'call.ts'))), 'call.ts must not reach the environment model');
});

test('the environment model is frozen in one place and read nowhere else', () => {
  const source = read(path.join(ARTIST, 'env-model.ts'));
  assert.match(source, /export const ENV_MODEL = 'gpt-4o-2024-11-20'/);
  assert.match(source, /export const ENV_TEMPERATURE = 0/);
  // Named, not chosen: `corpus.ts` stamps ENV_MODEL onto every reading and into the protocol hash so
  // a reading can say which eyes made it. What matters is that no second file *decides* what the
  // model is, so the check is that nothing else assigns it.
  const others = FILES.filter((f) => rel(f) !== 'env-model.ts' && /ENV_MODEL\s*=/.test(read(f)));
  assert.deepEqual(others.map(rel), [], 'nothing else sets the environment model');
});

test('the judge shares no door with the artist or its environment', () => {
  // L5 scores runs that are already finished. If it could reach the policy it would be a signal the
  // artist could learn to move; if it could reach `envModel` it would inherit the environment's
  // cache and its frozen model, and a judgment would stop being an independent reading. Its
  // isolation is the entire reason its number is worth anything.
  const source = read(path.join(ARTIST, 'judge.ts'));
  assert.ok(!/policy\.call</.test(source), 'the judge reaches the policy');
  assert.ok(!/from '\.\/policy\/interface\.js'/.test(source), 'the judge imports the policy interface');
  assert.ok(!/\benvModel[<(]/.test(source), 'the judge reaches the environment model');
  assert.match(source, /export const JUDGE_MODEL = 'gpt-4.1-2025-04-14'/);
  assert.match(source, /export const JUDGE_TEMPERATURE = 0/);
  // And it does not see with the environment's eyes. Sharing a model id would leave the judge's
  // isolation nominal: same weights, same blind spots, reading the same picture.
  const envSource = read(path.join(ARTIST, 'env-model.ts'));
  const judgeModel = /JUDGE_MODEL = '([^']+)'/.exec(source)?.[1];
  const envModelId = /ENV_MODEL = '([^']+)'/.exec(envSource)?.[1];
  assert.notEqual(judgeModel, envModelId, 'the judge and the environment are the same model');
  const others = FILES.filter((f) => rel(f) !== 'judge.ts' && /JUDGE_MODEL/.test(read(f)));
  assert.deepEqual(others.map(rel), [], 'nothing else names the judge model');
  // And nothing in the loop reads it back. A judgment that could reach a running trajectory would
  // put the evaluator inside the thing it is evaluating.
  const importers = FILES.filter((f) => /from '\.\/judge\.js'|from '\.\.\/judge\.js'/.test(read(f))).map(rel);
  assert.deepEqual(importers, [], 'the judge is imported by the CLI only, never by artist/');
});

test('the final pass is sealed off from the loop and from the scores', () => {
  // The pass is the only nondeterministic thing in the repo. It runs after the trajectory is over,
  // on bytes that are already written, and nothing may read it back: an artist that could see a
  // pass would be reasoning about a picture it did not make and could not make again, and a score
  // computed off one would not survive a rescore.
  const source = read(path.join(ARTIST, 'pass.ts'));
  assert.ok(!/policy\.call</.test(source), 'the final pass reaches the policy');
  assert.ok(!/from '\.\/policy\/interface\.js'/.test(source), 'the final pass imports the policy interface');
  assert.ok(!/\benvModel[<(]/.test(source), 'the final pass reaches the environment model');
  const importers = FILES.filter((f) => /from '\.\/pass\.js'|from '\.\.\/pass\.js'/.test(read(f))).map(rel);
  assert.deepEqual(importers, [], 'the final pass is imported by the CLI only, never by artist/');
});

test('the trace sink is reachable from call.ts and nowhere else', () => {
  const importers = FILES.filter((f) => /from '\.\/trace\.js'|from '\.\.\/trace\.js'/.test(read(f))).map(rel);
  assert.deepEqual(importers, ['call.ts']);
});

test('the trace sink is a sink: it sends and never reads', () => {
  // A loop that could read its own traces back would have state living at an observability vendor,
  // which is the same failure as state living in a framework: it is not in studio.jsonl.
  const source = read(path.join(ARTIST, 'trace.ts'));
  const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ['traceCall', 'tracingEnabled']);
  assert.equal((source.match(/fetch\(/g) ?? []).length, 1, 'exactly one request leaves this file');
  assert.match(source, /method: 'POST'/);
});

test('tracing is off by default, and off for policies that never reached a model', () => {
  const saved = { tracing: process.env['LANGSMITH_TRACING'], key: process.env['LANGSMITH_API_KEY'] };
  try {
    delete process.env['LANGSMITH_TRACING'];
    process.env['LANGSMITH_API_KEY'] = 'test-key';
    assert.equal(tracingEnabled('anthropic'), false, 'unset LANGSMITH_TRACING must mean off');

    process.env['LANGSMITH_TRACING'] = 'true';
    assert.equal(tracingEnabled('anthropic'), false, 'only the exact string "1" turns it on');

    process.env['LANGSMITH_TRACING'] = '1';
    assert.equal(tracingEnabled('anthropic'), true);
    assert.equal(tracingEnabled('openai-compatible'), true);
    // A replay and a test both drive the real loop with a policy that answers from disk. Neither
    // made a call, so neither may put a request on the network however the environment is set.
    assert.equal(tracingEnabled('recorded'), false);
    assert.equal(tracingEnabled('stub'), false);

    delete process.env['LANGSMITH_API_KEY'];
    assert.equal(tracingEnabled('anthropic'), false, 'no key means off, not an error later');
  } finally {
    if (saved.tracing === undefined) delete process.env['LANGSMITH_TRACING'];
    else process.env['LANGSMITH_TRACING'] = saved.tracing;
    if (saved.key === undefined) delete process.env['LANGSMITH_API_KEY'];
    else process.env['LANGSMITH_API_KEY'] = saved.key;
  }
});

test('every observation a policy sees is built by observation.ts and nothing else', () => {
  // A phase that built its own prompt would be invisible to the observation hash, and every
  // trajectory recorded before and after that change would be silently incomparable.
  const phases = FILES.filter((f) => rel(f).startsWith('phases'));
  assert.ok(phases.length >= 5);
  for (const file of phases) {
    assert.match(read(file), /from '\.\.\/observation\.js'/, `${rel(file)} does not use the serializer`);
  }
});
