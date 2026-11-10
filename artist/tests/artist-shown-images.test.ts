// What the model was shown is now part of the record.
//
// The log used to say `hasImages: true` and stop. Eight call sites attach pictures — corpus works at
// FIND and RESEARCH, the plate and the change-mark on every MAKE step, the contact sheet at CHOOSE
// and COMPARE, the finished plate at EXAMINE, the sampled/ablation pair at the finish gate — and
// none of them left a trace beyond that boolean. So "which inspiration was used for what" was not
// answerable from a completed trajectory, and the contact sheets and change-marks, which exist for
// the length of one call, were gone the moment it returned.
//
// This pins the three properties the inspector depends on: the line names every picture, the sha256
// is over the bytes as the provider got them (so a corpus work's sha is also its file name and its
// manifest key), and a named picture is on disk before the line that names it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ROOT } from '../../env/browser.js';
import { callPolicy, newSpend } from '../call.js';
import { StudioLog, readLog } from '../studio-log.js';
import { PolicyError, type Policy, type PolicyImage, type PolicyResponse } from '../policy/interface.js';

const SHOWN_DIR = path.join(ROOT, '.cache', 'artist-shown');

const stub = (throws = false): Policy => ({
  kind: 'stub',
  model: 'stub-model',
  async call<T>(): Promise<PolicyResponse<T>> {
    if (throws) throw new PolicyError('the answer did not satisfy the schema', 'schema');
    return { action: {} as T, raw: '{}', usage: { inputTokens: 1, outputTokens: 1, usd: 0 }, attempts: 1, failures: [], model: 'stub-model' };
  },
});

const logIn = () => new StudioLog(mkdtempSync(path.join(tmpdir(), 'shown-')));

/** Deterministic bytes that are certainly not already in the content-addressed cache. */
const bytesOf = (seed: string) => Buffer.from(`${seed}:${'\u0089PNG'.repeat(40)}`, 'utf8');

const request = (images?: PolicyImage[]) => ({
  name: 'under-test',
  system: 'system',
  observation: 'observation',
  schema: { type: 'object' },
  ...(images ? { images } : {}),
});

async function callWith(images: PolicyImage[] | undefined, throws = false) {
  const log = logIn();
  try {
    await callPolicy(stub(throws), log, newSpend(), request(images));
  } catch {
    // The throwing arm is the point of that case: the line is written before the throw.
  }
  const lines = readLog(log.file);
  assert.equal(lines.length, 1);
  return lines[0]!.data as { hasImages: boolean; images: { label: string; sha256: string; mediaType: string; bytes: number }[] };
}

test('a call names every picture it was given, by the sha256 of the bytes the provider got', async () => {
  const png = bytesOf('a-plate');
  const jpg = bytesOf('a-corpus-work');
  const shaJpg = createHash('sha256').update(jpg).digest('hex');
  const d = await callWith([
    { mediaType: 'image/png', base64: png.toString('base64'), label: 'plate' },
    // The label a corpus work carries is its own sha256, which is also its corpus/images file name
    // and its manifest key. If the two ever disagreed the inspector's join would silently show the
    // wrong provenance under a picture, so they are asserted equal here rather than assumed.
    { mediaType: 'image/jpeg', base64: jpg.toString('base64'), label: `corpus:${shaJpg}` },
  ]);

  assert.equal(d.hasImages, true);
  assert.equal(d.images.length, 2);
  assert.deepEqual(
    d.images.map((i) => i.label),
    ['plate', `corpus:${shaJpg}`]
  );
  assert.equal(d.images[0]!.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(d.images[1]!.sha256, shaJpg);
  assert.equal(d.images[1]!.label.slice('corpus:'.length), d.images[1]!.sha256);
  assert.deepEqual(
    d.images.map((i) => i.bytes),
    [png.length, jpg.length]
  );
});

test('the bytes are on disk under the name the line gives them, byte for byte', async () => {
  const png = bytesOf('kept-on-disk');
  const d = await callWith([{ mediaType: 'image/png', base64: png.toString('base64'), label: 'contact-sheet' }]);
  const file = path.join(SHOWN_DIR, `${d.images[0]!.sha256}.png`);
  assert.ok(existsSync(file), `the line names ${file} and nothing wrote it`);
  assert.deepEqual(readFileSync(file), png, 'the cached picture is not the one the call was given');
});

test('a jpeg lands under .jpg and a png under .png, so one route can find either', async () => {
  const jpg = bytesOf('an-extension');
  const d = await callWith([{ mediaType: 'image/jpeg', base64: jpg.toString('base64'), label: 'corpus:whatever' }]);
  assert.ok(existsSync(path.join(SHOWN_DIR, `${d.images[0]!.sha256}.jpg`)));
});

test('a call given nothing says so, rather than saying nothing', async () => {
  const d = await callWith(undefined);
  assert.equal(d.hasImages, false);
  assert.deepEqual(d.images, []);
});

test('a call that throws still records what it was shown', async () => {
  // The failure line is a separate `log.append` from the success one and was the half missed the
  // first time this was written: `replace_all` matched only the differently-indented block.
  const png = bytesOf('shown-then-refused');
  const d = await callWith([{ mediaType: 'image/png', base64: png.toString('base64'), label: 'plate' }], true);
  assert.equal(d.hasImages, true);
  assert.equal(d.images.length, 1);
  assert.equal(d.images[0]!.label, 'plate');
  assert.ok(existsSync(path.join(SHOWN_DIR, `${d.images[0]!.sha256}.png`)));
});

/**
 * A sketch that drew used to leave no line at all.
 *
 * The failure path logged and the success path returned in silence, so the record said which
 * sketches died and never said which existed — and the hash that fetches the picture back out of the
 * render cache was nowhere in the file. Driving the real phase needs a browser, so this is a source
 * gate: cheap, and it fails the moment the append is removed.
 */
test('sketch.ts leaves a line whether the sketch drew or died', () => {
  const src = readFileSync(path.join(ROOT, 'artist', 'phases', 'sketch.ts'), 'utf8');
  assert.match(src, /log\.append\('note', \{[^}]*drawn: true/s, 'the drawn path logs nothing');
  assert.match(src, /log\.append\('note', \{[^}]*failure: base\.failure/s, 'the dead path logs nothing');
});
