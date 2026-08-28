// L5. Mostly tests of what the judge must NOT do.
//
// A judge is the easiest thing in this repo to make look like it works, because it emits a number
// and a number can be averaged. So the assertions here are about the ways the number could be
// meaningless while still being produced: the answer leaking into the question, a fixed candidate
// order turning a positional bias into an attribution rate, a non-answer scoring as a miss, and a
// prompt edit silently making old scores comparable with new ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { judgeSummary, judgeTrajectory, judgeVersion, setJudgeModel, type Judgment } from '../artist/judge.js';
import { loadPosition, practiceOf } from '../artist/field.js';

const POSITIONS = ['interference', 'many-hands', 'withheld'];

/** A minimal trajectory on disk: the judge reads `final.json` and `final.png` and nothing else. */
function trajectoryDir(positionId: string, id: string, control = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'judge-'));
  const position = loadPosition(positionId);
  writeFileSync(
    path.join(dir, 'final.json'),
    JSON.stringify({
      id,
      positionId,
      briefId: 'fifty-year-embargo',
      deliverableId: 'panel',
      control,
      // A tree the checker can read. It violates most of the position, which does not matter here:
      // the judge is asked about the picture, and what it consumes off the tree is the rubric list.
      finalProgram: { version: '1.0', profile: 'default-v1', pack: 'core-v1', masterSeed: 1, root: { id: 'root', type: 'group', children: [] } },
    })
  );
  writeFileSync(path.join(dir, 'final.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  return dir;
}

interface Seen {
  name: string;
  system: string;
  text: string;
}

/** Installs a stand-in that records every question and answers with the letter given. */
function stub(answers: { chose?: string; verdict?: 'derives' | 'quotes'; score?: number; cliches?: string[] }): Seen[] {
  const seen: Seen[] = [];
  setJudgeModel(async <T,>(request: { name: string; system: string; text: string }) => {
    seen.push({ name: request.name, system: request.system, text: request.text });
    const value =
      request.name === 'attribution'
        ? { chose: answers.chose ?? 'A', why: 'because' }
        : request.name === 'necessity'
          ? { score: answers.score ?? 4, mostNecessary: 'a', mostArbitrary: 'b', answer: 'c' }
          : { verdict: answers.verdict ?? 'derives', clichesTaken: answers.cliches ?? [], beyond: 'd', why: 'e' };
    return { value: value as T, cached: false, usd: 0 };
  });
  return seen;
}

test.afterEach(() => setJudgeModel(null));

test('the attribution critic is never told which position it is judging', async () => {
  // The whole dimension is worthless if the answer is in the question. `check.ts` can already tell
  // you which position a tree was checked against; the only thing a judge adds is a reading of the
  // picture by something that does not know.
  const seen = stub({});
  await judgeTrajectory(trajectoryDir('withheld', 't1'), { catalog: POSITIONS });
  const attribution = seen.find((s) => s.name === 'attribution')!;
  const haystack = `${attribution.system}\n${attribution.text}`.toLowerCase();
  for (const id of POSITIONS) {
    assert.ok(!haystack.includes(id), `the attribution prompt names the position "${id}"`);
  }
  assert.ok(!haystack.includes('withheld'), 'the attribution prompt names the answer');
});

test('neither does it carry the position name or its lineage', async () => {
  // Same rule the policy prompt lives under: a name is a label for a look, and a model handed one
  // reasons from the label rather than from the sheet.
  const seen = stub({});
  await judgeTrajectory(trajectoryDir('withheld', 't2'), { catalog: POSITIONS });
  const attribution = seen.find((s) => s.name === 'attribution')!;
  for (const id of POSITIONS) {
    const position = loadPosition(id);
    assert.ok(!attribution.text.includes(position.name), `the prompt carries the name "${position.name}"`);
    for (const l of position.lineage ?? []) {
      assert.ok(!attribution.text.includes(l.ref), `the prompt carries a lineage reference: ${l.ref}`);
    }
  }
});

test('the candidate order is shuffled per work, so a positional bias is not an attribution rate', async () => {
  // A judge with a mild preference for the first option scores 100% against a fixed order and
  // chance against a shuffled one. Only the second number is about the pictures.
  const orders = new Set<string>();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const seen = stub({});
    await judgeTrajectory(trajectoryDir('withheld', id), { catalog: POSITIONS });
    const text = seen.find((s) => s.name === 'attribution')!.text;
    orders.add(POSITIONS.map((p) => `${p}:${text.indexOf(practiceOf(loadPosition(p)).doing)}`).sort().join('|'));
  }
  assert.ok(orders.size > 1, 'six works were all shown the practices in the same order');
});

test('a hit and a miss are decided against the position that actually made it', async () => {
  const dir = trajectoryDir('withheld', 'hit');
  // Whatever letter the stub picks, `correct` must be the comparison of ids and not of letters.
  stub({ chose: 'A' });
  const a = await judgeTrajectory(dir, { catalog: POSITIONS });
  assert.equal(a.attribution.actual, 'withheld');
  assert.equal(a.attribution.correct, a.attribution.chose === 'withheld');
  assert.equal(a.attribution.candidates, 3);
  assert.ok(POSITIONS.includes(a.attribution.chose), 'the letter was mapped back to a position id');
});

test('a non-answer throws rather than scoring as a miss', async () => {
  // A judge that stopped answering and a judge that was wrong are different facts about the world.
  // Folding them together would let the first degrade into the second without anybody noticing.
  stub({ chose: 'Z' });
  await assert.rejects(
    () => judgeTrajectory(trajectoryDir('withheld', 'bad'), { catalog: POSITIONS }),
    /not one of/
  );
});

test('necessity and derivation consume the position, and derivation gets the cliche list verbatim', async () => {
  const seen = stub({});
  await judgeTrajectory(trajectoryDir('withheld', 't3'), { catalog: POSITIONS });
  const derivation = seen.find((s) => s.name === 'derivation')!;
  for (const c of loadPosition('withheld').cliches) {
    assert.ok(derivation.text.includes(c), `the cliche list is incomplete: ${c}`);
  }
});

test('the two dimensions the spec struck are absent: nothing here re-decides compliance', async () => {
  // Critic dimensions 1 and 2 — "does it obey the stated formal rules" and "does it violate a
  // stated refusal" — are struck permanently. `check.ts` decides both mechanically, and a judge
  // that also decided them would inflate its agreement with the checker and report that as a score.
  const seen = stub({});
  const j = await judgeTrajectory(trajectoryDir('withheld', 't4'), { catalog: POSITIONS });
  assert.deepEqual(Object.keys(j).filter((k) => ['compliance', 'obedience', 'violations'].includes(k)), []);
  for (const s of seen) {
    assert.ok(!/hard violation|constraint id|does it obey/i.test(s.system), `${s.name} re-decides compliance`);
  }
  // No prompt is handed the constraint verdicts. Only the rubrics the checker could not decide.
  const necessity = seen.find((s) => s.name === 'necessity')!;
  assert.ok(!necessity.text.includes('"status"'), 'the necessity prompt carries checker verdicts');
});

test('judgeVersion is stable and covers all three prompts', () => {
  assert.equal(judgeVersion(), judgeVersion());
  assert.match(judgeVersion(), /^[0-9a-f]{12}$/);
});

test('the summary keeps the arms apart and states the chance rate', () => {
  // The control arm is the arm that predicts chance. Averaging it into the position arm destroys
  // the only comparison in this file that has a baseline.
  const j = (control: boolean, correct: boolean, score: number): Judgment => ({
    trajectoryId: 'x',
    positionId: 'withheld',
    briefId: 'b',
    deliverableId: 'panel',
    control,
    judgeVersion: judgeVersion(),
    attribution: { chose: correct ? 'withheld' : 'many-hands', actual: 'withheld', correct, candidates: 3, why: '' },
    necessity: { score, mostNecessary: '', mostArbitrary: '', rubricIds: [], answer: '' },
    derivation: { verdict: 'derives', clichesTaken: [], beyond: '', why: '' },
    usd: 0,
    cached: false,
  });
  const text = judgeSummary([j(false, true, 6), j(false, true, 4), j(true, false, 2)]);
  assert.match(text, /position\s+n=2\s+attribution 2\/2 \(chance 0\.7\)/);
  assert.match(text, /control\s+n=1\s+attribution 0\/1 \(chance 0\.3\)/);
  assert.match(text, /necessity 5\.00\/7/);
});
