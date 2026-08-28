// The run as one file you can take away.
//
// The studio's beat view is a summary and the whole line is a click away on a server; the transcript
// is the case where the server is not there. So the properties worth pinning are the ones that make
// it worth downloading at all: the observation and the generated action survive whole, a step says
// edit by edit what it did to the program, and an absent field is never reported as a confident zero.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogLine } from '../artist/studio-log.js';
import { transcriptMarkdown } from '../artist/transcript.js';

let seq = 0;
function line(kind: string, data: Record<string, unknown>): LogLine {
  seq++;
  return { seq, t: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), kind: kind as LogLine['kind'], data, prev: '', hash: '' };
}

const OBSERVATION = 'THE SHEET\n----\nthree marks, and one of them is a lie about the date.';

function run(extra: Record<string, unknown> = {}): LogLine[] {
  seq = 0;
  return [
    line('trajectory-start', { positionId: 'generation-loss', briefId: 'arches-eviction', deliverableId: 'poster', seed: 7 }),
    line('phase', { phase: 'reset' }),
    line('render', { programHash: 'blank', treeScore: 0, renderScore: 0, hardViolations: 6, softViolations: 0 }),
    line('phase', { phase: 'make' }),
    line('policy-call', {
      name: 'act',
      model: 'claude-sonnet-4-6',
      observation: OBSERVATION,
      action: { think: 'Lay the structure down.', edits: [{ actionId: 'a1' }, { actionId: 'a2' }] },
      usage: { usd: 0.13 },
      ok: true,
    }),
    line('render', { programHash: 'plate-a', treeScore: 0.5, renderScore: 0.4, hardViolations: 2, softViolations: 1 }),
    line('step', {
      k: 1,
      accepted: true,
      edits: [
        { actionId: 'a1', kind: 'add_node', targets: ['sheet'] },
        { actionId: 'a2', kind: 'set_arg', targets: ['title'] },
      ],
      applied: ['a1'],
      refused: [{ actionId: 'a2', reason: 'set_arg replaces a value in place [schema.program]\nand a great deal more' }],
      ...extra,
    }),
    line('trajectory-end', { outcome: 'finished', scores: { tree: 0.5 }, cost: { usd: 0.13 } }),
  ];
}

test('the observation and the action survive whole, which is the reason to keep the file', () => {
  const md = transcriptMarkdown('a-run', run());
  assert.ok(md.includes(OBSERVATION), 'the observation the artist was shown is not in it');
  assert.ok(md.includes('"Lay the structure down."'), 'what the artist generated is not in it');
  assert.ok(md.includes('# generation-loss x arches-eviction'));
});

test('a step says, edit by edit, what it did to the program', () => {
  const md = transcriptMarkdown('a-run', run({ pixelsMoved: 0.0631 }));
  assert.match(md, /\*\*what changed\*\*.*kept · 1 of 2 edits applied · 6\.31% of the sheet moved/);
  assert.match(md, /`add_node` on sheet \(a1\) — applied/);
  assert.match(md, /`set_arg` on title \(a2\) — refused — set_arg replaces a value in place/);
  // The wall behind a refusal is cut to its first line; the beat above carries the families.
  assert.ok(!md.includes('and a great deal more'));
});

test('a field the run never wrote is said to be missing, not reported as zero', () => {
  const md = transcriptMarkdown('a-run', run());
  assert.ok(md.includes('how much moved was not recorded'));
  assert.ok(!md.includes('0.00% of the sheet moved'));
});
