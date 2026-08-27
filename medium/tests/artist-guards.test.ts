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

const ARTIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'artist');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
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
  const envCallers = FILES.filter((f) => /\benvModel[<(]/.test(read(f))).map(rel).sort();
  assert.deepEqual(envCallers, ['env-calls.ts', 'env-model.ts']);

  for (const file of FILES.filter((f) => envCallers.includes(rel(f)))) {
    assert.ok(!/policy\.call</.test(read(file)), `${rel(file)} reaches both the policy and the environment`);
    assert.ok(!/from '\.\/policy\/interface\.js'/.test(read(file)), `${rel(file)} imports the policy interface`);
  }
  assert.ok(!/envModel/.test(read(path.join(ARTIST, 'call.ts'))), 'call.ts must not reach the environment model');
});

test('the environment model is frozen in one place and read nowhere else', () => {
  const source = read(path.join(ARTIST, 'env-model.ts'));
  assert.match(source, /export const ENV_MODEL = 'claude-haiku-4-5-20251001'/);
  assert.match(source, /export const ENV_TEMPERATURE = 0/);
  const others = FILES.filter((f) => rel(f) !== 'env-model.ts' && /ENV_MODEL/.test(read(f)));
  assert.deepEqual(others.map(rel), [], 'nothing else names the environment model');
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
