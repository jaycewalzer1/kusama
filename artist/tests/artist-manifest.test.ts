// The manifest: that a row survives a round trip, and that the two invented-data rules are enforced
// by code rather than by discipline.
//
// This file is the evidence for the whole corpus, and the two things that could quietly ruin it are
// not crashes. They are a guessed licence and a guessed date — both of which look exactly like facts
// once written down, and neither of which any downstream consumer can detect. So the tests that
// matter here are the ones asserting that a malformed row is *refused* rather than repaired.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type Work, imagePath, manifestFaults, manifestLine, readManifest, workId, writeManifest } from '../manifest.js';

const WORK: Work = {
  id: 'cma-102578',
  source: 'cma',
  object_id: '102578',
  accession_number: '1921.1239',
  url: 'https://clevelandart.org/art/1921.1239',
  rights: 'CC0',
  title: 'Portrait of Dora Wheeler',
  creator: 'William Merritt Chase (American, 1849–1916)',
  date_display: '1882–83',
  date_begin: 1882,
  date_end: 1883,
  classification: 'Painting',
  medium: 'oil on canvas',
  culture: 'America',
  department: 'American Painting and Sculpture',
  image_url: 'https://openaccess-cdn.clevelandart.org/1921.1239/1921.1239_web.jpg',
  image: {
    source_url: 'https://openaccess-cdn.clevelandart.org/1921.1239/1921.1239_web.jpg',
    sha256: 'e516121c316dcc420843fbae9710f772903088c5a1977b65bdd3a432bc0f7d54',
    bytes: 179089,
    width: 939,
    height: 893,
  },
  fetched_at: '2026-08-31T05:49:12.974Z',
};

function inTmp(fn: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'kusama-manifest-'));
  try {
    fn(path.join(dir, 'manifest.jsonl'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a row survives being written and read back exactly', () => {
  inTmp((file) => {
    writeManifest(file, [WORK]);
    const { works, faults } = readManifest(file);
    assert.deepEqual(faults, []);
    assert.equal(works.length, 1);
    assert.deepEqual(works[0], WORK);
    // And writing what was read produces the same bytes, which is what makes a re-import a no-op in
    // git rather than a whole-file diff.
    assert.equal(manifestLine(works[0] as Work), manifestLine(WORK));
  });
});

test('the file is sorted by id, so a re-import is not a rewrite', () => {
  inTmp((file) => {
    const b: Work = { ...WORK, id: 'cma-2', object_id: '2' };
    const a: Work = { ...WORK, id: 'cma-1', object_id: '1' };
    writeManifest(file, [b, a]);
    assert.deepEqual(readManifest(file).works.map((w) => w.id), ['cma-1', 'cma-2']);
  });
});

test('a metadata-only row is legitimate and round-trips', () => {
  // The AIC fallback and the whole metadata-before-pixels ordering depend on this being a valid
  // state rather than an error, so it is asserted rather than assumed.
  inTmp((file) => {
    const pending: Work = { ...WORK, image: null };
    writeManifest(file, [pending]);
    assert.deepEqual(readManifest(file).works[0], pending);
    assert.equal(imagePath(pending), null);
  });
});

test('one bad line does not make the corpus unreadable', () => {
  // An import killed mid-write leaves a truncated last line. A reader that threw on it would turn a
  // one-row loss into a total one, at exactly the moment somebody needs to see what survived.
  inTmp((file) => {
    writeFileSync(file, `${manifestLine(WORK)}\n{"id":"cma-3","sourc\n${manifestLine({ ...WORK, id: 'cma-9', object_id: '9' })}\n`);
    const { works, faults } = readManifest(file);
    assert.deepEqual(works.map((w) => w.id), ['cma-102578', 'cma-9']);
    assert.equal(faults.length, 1);
    assert.equal(faults[0]?.line, 2);
    assert.throws(() => readManifest(file, true), /malformed rows, first at line 2/);
  });
});

test('every fault is reported, not just the first', () => {
  // A writer that stops at the first fault turns a 250,000-row import into a quarter of a million
  // sequential fixes.
  const bad = manifestFaults({ ...WORK, title: '', rights: '', source: 'louvre' });
  assert.ok(bad.length >= 3, `expected several faults, got ${JSON.stringify(bad)}`);
  assert.deepEqual(manifestFaults(WORK), []);
});

test('a date that was guessed cannot be written', () => {
  // The rule the corpus is stratified on. A band that was invented will later be sampled against as
  // though it were measured, and there is nothing downstream that could tell the difference.
  assert.deepEqual(manifestFaults({ ...WORK, date_begin: null, date_end: null }), []);
  assert.ok(manifestFaults({ ...WORK, date_begin: 1882.5 }).some((f) => f.includes('date_begin')));
  assert.ok(manifestFaults({ ...WORK, date_begin: Number.NaN }).some((f) => f.includes('date_begin')));
  assert.ok(manifestFaults({ ...WORK, date_begin: 1900, date_end: 1800 }).some((f) => f.includes('after')));
});

test('an absent licence is refused, because a blank one reads as a grant', () => {
  assert.ok(manifestFaults({ ...WORK, rights: '' }).some((f) => f.includes('rights')));
});

test('the id has to match the source and object id it claims', () => {
  // The ids are also the lineage element ids, and `derivedIds()` keys off them. A row whose id does
  // not derive from its own fields is a row that silently points an element at the wrong object.
  assert.equal(workId('cma', 102578), 'cma-102578');
  assert.ok(manifestFaults({ ...WORK, id: 'cma-999' }).some((f) => f.includes('does not match')));
});

test('an image claim has to name bytes that could exist', () => {
  const badHash = manifestFaults({ ...WORK, image: { ...WORK.image!, sha256: 'nope' } });
  assert.ok(badHash.some((f) => f.includes('sha256')));
  const badBytes = manifestFaults({ ...WORK, image: { ...WORK.image!, bytes: 0 } });
  assert.ok(badBytes.some((f) => f.includes('bytes')));
  // Dimensions are null when the source does not report them, and never zero.
  assert.deepEqual(manifestFaults({ ...WORK, image: { ...WORK.image!, width: null, height: null } }), []);
  assert.ok(manifestFaults({ ...WORK, image: { ...WORK.image!, width: 0 } }).some((f) => f.includes('width')));
});

test('writing refuses a bad row rather than recording it', () => {
  assert.throws(() => manifestLine({ ...WORK, rights: '' } as Work), /refusing to write cma-102578/);
});

test('the image path is derived from the hash, not stored', () => {
  // Content addressing is what lets the pixels be untracked: the path is a function of the bytes, so
  // a clone can rebuild the whole layout from the manifest alone.
  assert.equal(imagePath(WORK), path.join('images', `${WORK.image!.sha256}.jpg`));
});
