// The practice store, tested for the one property it exists to have: an old version does not move.
//
// Everything else here is secondary. A store that recorded borrowings and lenses beautifully but let
// version 1 change when version 2 was written would be worse than no store at all, because the
// trajectories quoting v1 would go on quoting it and nobody would find out. So the load-bearing test
// reads the *bytes* of v1 off disk before and after later versions are written, not the parsed
// object: a reformat that preserved the JSON would still break the claim that the artist saw this
// exact prose.
//
// The store lives in a temp directory throughout. A test that wrote into `aesthetic/practice/` would
// put a version the artist never made into the history the artist is held to, and — because the
// store is append-only on purpose — there would be no supported way to take it back out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newSpend } from '../call.js';
import type { Practice } from '../field.js';
import type { MaterialSheet } from '../material-sheet.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';
import {
  latestVersion,
  loadPracticeVersion,
  updatePractice,
  versionFile,
  writePracticeVersion,
  type PracticeVersion,
  type Tried,
} from '../practice-version.js';

const PRACTICE: Practice = {
  origin: 'Ruled account books, kept by people who were not drawing.',
  doing: 'Making the count visible at the cost of the thing counted.',
  period: 'After the ledgers were digitised and before anyone had read them.',
  register: 'First person, past tense, no hedging.',
  refusals: ['no decorative rule', 'no photograph of a person', 'no title that explains the piece'],
};

const SHEET: MaterialSheet = {
  materials: [
    {
      id: 'm1',
      material: 'Ruled lines that show through the text and are not erased where the text crosses them.',
      borrowing: 'The grid would stop being a scaffold and start being a mark.',
      works: ['met:436535', 'aic:28560'],
    },
    {
      id: 'm2',
      material: 'Rubricated initials set outside the column they belong to.',
      borrowing: 'One element would sit off the measure without the measure breaking.',
      works: ['cma:1942.166'],
    },
    // Cites nothing, so it is not provenance and must not enter the record as if it were.
    { id: 'm3', material: 'A feeling of accumulated time.', borrowing: 'Unclear.', works: [] },
  ],
  queries: [],
  hash: 'sheet-hash',
};

const FERTILE: Tried[] = [
  { id: 'l2', what: 'read the condition as an accounting problem', why: 'it produced the only sketch that was not a poster' },
];

const REJECTED: Tried[] = [
  { id: 'l1', what: 'read the condition as a memorial', why: 'every sketch it produced was a wreath; it answers grief and the condition is not about grief' },
  { id: 'l4', what: 'read the condition as a joke', why: 'it could not survive the fifty-year embargo being real' },
];

/** Writes an entry that names a work, a lens and a rejection, because the schema demands all three. */
class UpdateStub implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly requests: PolicyRequest[] = [];

  constructor(private readonly changed: string) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.requests.push(request);
    const action = { changed: this.changed };
    return {
      action: action as T,
      raw: JSON.stringify(action),
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }
}

/** A sink of the shape run.ts passes, remembering what it was handed. */
class Sink {
  readonly file = 'studio.jsonl';
  readonly lines: { kind: string; data: unknown }[] = [];
  append(kind: 'policy-call' | 'note', data: unknown): unknown {
    const line = { kind, data };
    this.lines.push(line);
    return line;
  }
}

function store(): string {
  return mkdtempSync(path.join(tmpdir(), 'practice-'));
}

function draft(changed: string, trajectoryId: string) {
  return {
    positionId: 'interference',
    practice: PRACTICE,
    borrowed: [{ id: 'm1', works: ['met:436535'], borrowing: 'the grid becomes a mark' }],
    fertile: FERTILE,
    rejected: REJECTED,
    trajectoryId,
    changed,
  };
}

test('version 1 is byte-identical and hashes the same after later versions are written', () => {
  const dir = store();
  const v1 = writePracticeVersion(draft('the first entry, naming m1 and lens l2', 'run-a'), dir);
  const file = versionFile('interference', 1, dir);
  const bytes = readFileSync(file);
  const hash = v1.hash;

  writePracticeVersion(draft('the second entry', 'run-b'), dir);
  writePracticeVersion(draft('the third entry', 'run-c'), dir);

  assert.deepEqual(readFileSync(file), bytes, 'v1 on disk is byte-for-byte what it was');
  assert.equal(loadPracticeVersion('interference', 1, dir).hash, hash, 'and it still hashes to the same thing');
  assert.equal(loadPracticeVersion('interference', 1, dir).changed, 'the first entry, naming m1 and lens l2');
});

test('loading version 1 after three versions returns version 1, not the latest', () => {
  const dir = store();
  writePracticeVersion(draft('first', 'run-a'), dir);
  writePracticeVersion(draft('second', 'run-b'), dir);
  writePracticeVersion(draft('third', 'run-c'), dir);

  assert.equal(loadPracticeVersion('interference', 1, dir).changed, 'first');
  assert.equal(loadPracticeVersion('interference', 2, dir).changed, 'second');
  assert.equal(latestVersion('interference', dir)!.version, 3);
  assert.equal(latestVersion('interference', dir)!.changed, 'third');
});

test('the parent hashes form a chain a reader can walk back to the first version', () => {
  const dir = store();
  writePracticeVersion(draft('first', 'run-a'), dir);
  writePracticeVersion(draft('second', 'run-b'), dir);
  writePracticeVersion(draft('third', 'run-c'), dir);

  const walked: PracticeVersion[] = [];
  let at: PracticeVersion | null = latestVersion('interference', dir);
  while (at) {
    walked.push(at);
    at = at.version === 1 ? null : loadPracticeVersion('interference', at.version - 1, dir);
    if (at) assert.equal(walked[walked.length - 1]!.parent, at.hash, `v${walked.length} names v${at.version} as its parent`);
  }
  assert.deepEqual(walked.map((v) => v.version), [3, 2, 1]);
  assert.equal(walked[2]!.parent, null, 'the first version has no parent');
});

test('a version that has been edited since it was written is refused, not returned', () => {
  const dir = store();
  writePracticeVersion(draft('first', 'run-a'), dir);
  const file = versionFile('interference', 1, dir);
  const record = JSON.parse(readFileSync(file, 'utf8')) as PracticeVersion;
  record.changed = 'something the artist never wrote';
  writeFileSync(file, JSON.stringify(record, null, 2));

  assert.throws(() => loadPracticeVersion('interference', 1, dir), /does not match its own hash/);
});

test('a version already sitting where the next one would land is never overwritten', () => {
  const dir = store();
  writePracticeVersion(draft('first', 'run-a'), dir);
  // Two runs finishing at once is the way this actually happens: the second reads the store, sees
  // one version, and writes to slot 2 after the first has already filled it. Copying v1's bytes into
  // slot 2 reproduces that exactly — the file is a whole, hash-consistent record, so nothing but the
  // write flag can catch it.
  const occupied = readFileSync(versionFile('interference', 1, dir));
  writeFileSync(versionFile('interference', 2, dir), occupied);

  assert.throws(() => writePracticeVersion(draft('second', 'run-b'), dir));
  assert.deepEqual(readFileSync(versionFile('interference', 2, dir)), occupied, 'the file was not touched');
});

test('a store with no versions answers null, conjures no file, and does not throw', () => {
  const dir = store();
  assert.equal(latestVersion('interference', dir), null);
  assert.equal(existsSync(path.join(dir, 'interference')), false, 'asking created nothing');
  assert.throws(() => loadPracticeVersion('interference', 3, dir), /no practice version 3/);
});

test('UPDATE PRACTICE records the works borrowed from, the fertile lenses and the rejections', async () => {
  const dir = store();
  const policy = new UpdateStub(
    'I took the ruled lines from met:436535 and stopped erasing the grid where the text crosses it. ' +
      'The accounting lens (l2) was the only one that produced anything that was not a poster. I cut ' +
      'the memorial reading (l1): it answers grief, and nothing here is about grief.'
  );
  const sink = new Sink();
  const spend = newSpend();

  const version = await updatePractice(
    policy,
    sink,
    spend,
    { positionId: 'interference', practice: PRACTICE, trajectoryId: 'run-a', sheet: SHEET, fertile: FERTILE, rejected: REJECTED },
    dir
  );

  assert.equal(spend.policyCalls, 1, 'one call, not one per lens');
  assert.deepEqual(policy.requests.map((r) => r.name), ['update-practice']);

  // The provenance is mechanical: the two materials that cite works are in, the one that cites
  // nothing is out, and the ids are the sheet's own.
  assert.deepEqual(version.borrowed.map((b) => b.id), ['m1', 'm2']);
  assert.deepEqual(version.borrowed.flatMap((b) => b.works), ['met:436535', 'aic:28560', 'cma:1942.166']);
  assert.deepEqual(version.fertile, FERTILE);
  assert.deepEqual(version.rejected, REJECTED);
  for (const r of version.rejected) assert.ok(r.why.length > 0, 'a rejection carries its reason');
  assert.equal(version.trajectoryId, 'run-a');
  assert.equal(version.version, 1);
  assert.equal(version.parent, null);

  // The practice itself was copied forward, not rewritten. The model wrote one field and no other.
  assert.deepEqual(version.practice, PRACTICE);
  assert.match(version.changed, /met:436535/);

  // It is on disk and it reads back identically.
  assert.deepEqual(loadPracticeVersion('interference', 1, dir), version);

  // The chain says which version this run produced, and the call went into the chain rather than
  // being lost with the discovery record.
  assert.deepEqual(sink.lines.map((l) => l.kind), ['policy-call', 'note']);
  assert.deepEqual(sink.lines[1]!.data, {
    phase: 'update-practice',
    positionId: 'interference',
    version: 1,
    hash: version.hash,
    parent: null,
  });
});

test('the artist is shown its own earlier entries, and a second run appends rather than replaces', async () => {
  const dir = store();
  const first = 'I took the ruled lines from met:436535; the accounting lens l2 held; I cut the memorial reading l1.';
  await updatePractice(
    new UpdateStub(first),
    new Sink(),
    newSpend(),
    { positionId: 'interference', practice: PRACTICE, trajectoryId: 'run-a', sheet: SHEET, fertile: FERTILE, rejected: REJECTED },
    dir
  );

  const policy = new UpdateStub(
    'The second time I borrowed nothing: I did not go and look, and the grid stayed a scaffold ' +
      'because of it. The accounting lens l2 did no work here and I cut it, and the memorial reading ' +
      'l1 was still a wreath. Nothing moved. Looking first would have been what moved it.'
  );
  const v2 = await updatePractice(
    policy,
    new Sink(),
    newSpend(),
    { positionId: 'interference', practice: PRACTICE, trajectoryId: 'run-b', sheet: null, fertile: [], rejected: REJECTED },
    dir
  );

  // The history reaches the prompt verbatim. Without this the record accumulates where nobody reads it.
  const observation = policy.requests[0]!.observation;
  assert.match(observation, /v1 \(run-a\)/);
  assert.ok(observation.includes(first), 'the earlier entry is quoted as written');
  assert.match(observation, /this run did no research, and borrowed from no work/);

  assert.equal(v2.version, 2);
  assert.equal(v2.parent, loadPracticeVersion('interference', 1, dir).hash);
  assert.deepEqual(v2.borrowed, [], 'a run without a sheet borrowed from nothing and claims nothing');
  assert.equal(loadPracticeVersion('interference', 1, dir).changed, first, 'v1 still says what it said');
});
