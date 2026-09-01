// The corpus reaching the artist, and the four places it must not reach.
//
// This is the loop test for the influence layer, and it renders, so it is slow for the same reason
// artist-loop.test.ts is. It runs two whole trajectories with the model unplugged — one with a
// resolved set and one without — and asserts what each phase was actually sent, from the recorded
// requests rather than from the code that builds them.
//
// Four claims:
//
//   1. the run without the layer is byte-identical, observation for observation, to a run that
//      cannot have had it: same strings, and no `influencesHash` key anywhere in the log;
//   2. FIND is shown the block and the pictures, and SKETCH the block alone;
//   3. MAKE is shown neither unless asked, which is `--influences-in-make`;
//   4. DESCRIBE, TRANSCRIBE and AUDIENCE are shown nothing — the environment still cannot see what
//      the artist looked at, and this is the assertion that would fail first if the block were ever
//      moved into `observation.ts` where the env calls could pick it up.
//
// (4) is the one that matters most. The environment's read of the plate is the only unbiased signal
// in the loop; an describer that knew the artist had been shown eight museum textiles is a describer
// that can be led, and every reward computed from it would be measuring the prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTrajectory } from '../run.js';
import { loadInfluenceDoc } from '../influence-doc.js';
import { readLog } from '../studio-log.js';
import { StubPolicy, installStubEnvModel } from './artist-stub.js';
import type { PolicyRequest } from '../policy/interface.js';

const OUT = mkdtempSync(path.join(tmpdir(), 'artist-influences-'));

/** The set that exists on disk. Its 48 works are `withheld`'s, resolved in Stage 2. */
const SET = 'withheld';

async function run(dir: string, extra: { influences?: string; influencesInMake?: boolean }) {
  const stub = installStubEnvModel();
  const policy = new StubPolicy(3);
  try {
    const trajectory = await runTrajectory({
      policy,
      positionId: 'withheld',
      briefId: 'two-million-slips',
      seed: 4242,
      outDir: path.join(OUT, dir),
      maxSteps: 5,
      sketchesPerProblem: 1,
      useAudience: true,
      ...extra,
    });
    return { trajectory, requests: policy.requests, env: stub.requests, dir: path.join(OUT, dir) };
  } finally {
    stub.restore();
  }
}

const only = (requests: PolicyRequest[], name: string): PolicyRequest[] => requests.filter((r) => r.name === name);

/** Words that appear in the block and in nothing else the loop sends. */
const MARKERS = ['WHAT YOU HAVE LOOKED AT', 'works you have looked at', 'what is on the shelf'];

let off: Awaited<ReturnType<typeof run>>;
let on: Awaited<ReturnType<typeof run>>;
let inMake: Awaited<ReturnType<typeof run>>;

test('the resolved set for the position is on disk and carries works', () => {
  const doc = loadInfluenceDoc(SET);
  assert.equal(doc.resolved.works.length, 48);
  assert.equal(doc.hash.length, 64);
});

test('a run with no influences sends no influence text anywhere', async () => {
  off = await run('off', {});
  for (const r of off.requests) {
    for (const marker of MARKERS) assert.ok(!r.observation.includes(marker), `${r.name} carries "${marker}"`);
  }
  // And nothing in the log claims the layer. Not `influencesHash: null` and not an empty string —
  // absent, so a trajectory collected before this file existed and one collected after it are the
  // same environment.
  const start = readLog(path.join(off.dir, 'studio.jsonl')).find((l) => l.kind === 'trajectory-start')!;
  const keys = Object.keys(start.data as object);
  assert.deepEqual(keys.filter((k) => k.toLowerCase().includes('influence')), []);
});

test('FIND is shown the block and the pictures; SKETCH the block alone', async () => {
  on = await run('on', { influences: SET });

  const find = only(on.requests, 'find');
  assert.equal(find.length, 1);
  for (const marker of MARKERS) assert.ok(find[0]!.observation.includes(marker), `FIND is missing "${marker}"`);
  // The pictures, and the sentence that says they are there, agreeing about the count.
  //
  // How many pictures is a fact about this machine — `corpus/images/` is 3GB of derived, gitignored
  // bytes, so a fresh clone resolves the same 48 works and can show none of them. The claim under
  // test is not "there are pictures", it is that the sentence follows the payload either way. A
  // block promising eight images over a message carrying none is the defect, and it is reachable
  // from both branches.
  const images = find[0]!.images ?? [];
  assert.ok(images.every((i) => i.mediaType === 'image/jpeg'));
  assert.match(
    find[0]!.observation,
    images.length > 0
      ? new RegExp(`${images.length} of them are attached to this message as images`)
      : /No pictures are attached to this message/,
  );

  // SKETCH gets the catalogue and says outright that it has no pictures — the same works, named,
  // without paying the image tokens nine times over.
  const sketches = only(on.requests, 'sketch');
  assert.ok(sketches.length > 0);
  for (const s of sketches) {
    for (const marker of MARKERS) assert.ok(s.observation.includes(marker), `SKETCH is missing "${marker}"`);
    assert.equal(s.images, undefined);
    assert.match(s.observation, /No pictures are attached to this message/);
  }
});

test('MAKE is blind to the shelf by default and carries it only when asked', async () => {
  for (const r of only(on.requests, 'act')) {
    for (const marker of MARKERS) assert.ok(!r.observation.includes(marker), `act carries "${marker}" by default`);
  }

  inMake = await run('in-make', { influences: SET, influencesInMake: true });
  const acts = only(inMake.requests, 'act');
  assert.ok(acts.length > 0);
  for (const r of acts) {
    for (const marker of MARKERS) assert.ok(r.observation.includes(marker), `act is missing "${marker}" under the flag`);
    // Text only. The canvas is still image 1, which is what `makeObservation` promises by position.
    assert.match(r.observation, /No pictures are attached to this message/);
    assert.ok((r.images ?? []).every((i) => i.mediaType === 'image/png'));
  }
});

test('the environment never learns what the artist was shown', () => {
  // Every env call from the run that had the layer on, including the one that had it in MAKE.
  const titles = loadInfluenceDoc(SET).resolved.works.map((w) => w.title);
  for (const requests of [on.env, inMake.env]) {
    assert.ok(requests.length > 0);
    for (const r of requests) {
      const text = JSON.stringify(r);
      for (const marker of MARKERS) assert.ok(!text.includes(marker), `${r.name} carries "${marker}"`);
      // Not just the framing — the works themselves. A describer that had been handed the titles
      // could name a textile because it was told about one rather than because it saw one.
      for (const title of titles) {
        if (title.length < 12) continue; // 'Steps', 'Figure' — real words, would match by accident
        assert.ok(!text.includes(title), `${r.name} names the influence work "${title}"`);
      }
    }
  }
});

test('the layer changes the run id and the envVersion, and nothing else about the environment', () => {
  assert.notEqual(on.trajectory.id, off.trajectory.id, 'two runs of one cell would overwrite each other');

  // But `--influences-in-make` does NOT change the id, and that is deliberate rather than an
  // oversight found by this test. The id carries what the artist *is* — position, brief, seed,
  // control arm, element pack, and now which shelf it was shown — and not how the driver was run.
  // `showCanvas`, the older ablation, is absent from it for the same reason. Both arms of an
  // ablation are written to different `--out` directories by whoever is running it; folding every
  // switch into the id would make a resumable grid unable to recognise a cell it had already done.
  assert.equal(on.trajectory.id, inMake.trajectory.id);
  // The log is where the arm is recorded, so a directory still says which one it is.
  const start = readLog(path.join(inMake.dir, 'studio.jsonl')).find((l) => l.kind === 'trajectory-start')!;
  assert.equal((start.data as { influencesInMake?: boolean }).influencesInMake, true);
  assert.equal((start.data as { influencesId?: string }).influencesId, SET);
  assert.equal((start.data as { influenceWorks?: number }).influenceWorks, 48);
  const a = off.trajectory.envVersion;
  const b = on.trajectory.envVersion;
  assert.ok(!('influencesHash' in a));
  assert.equal(b.influencesHash, loadInfluenceDoc(SET).hash);
  // The position, the brief, the medium and the protocol are untouched: being shown a corpus is not
  // a change to what the artist was commissioned to do or what it can do it with.
  assert.deepEqual({ ...b, influencesHash: undefined }, { ...a, influencesHash: undefined });
});

test('a set that does not exist is refused, not silently treated as no influences', async () => {
  await assert.rejects(
    () => run('missing', { influences: 'no-such-position' }),
    /no resolved influence set/,
    'a typo in --influences must not be indistinguishable from the layer being off'
  );
});
