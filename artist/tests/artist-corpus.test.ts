// The corpus: that the reading is blind, and that the contamination count means what it says.
//
// Two things here are worth a test and the rest is bookkeeping. A reading that quietly grew a title
// in its prompt would still look like a reading and would be worthless, so blindness is asserted
// against the recorded request rather than against the source of the prompt. And the canonical count
// is the one number this module exists to produce, so the rule that decides it is tested on the
// cases that actually occurred in the first fifty works, including the eight that went wrong.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CORPUS_DIR,
  isJpeg,
  jpegSize,
  listWorks,
  loadReading,
  readingProtocolHash,
  readWork,
  verdict,
  withoutUpscale,
  type Leakage,
  type Work,
} from '../corpus.js';
import { imagePath, workId } from '../manifest.js';
import { recentEnvRequests, setEnvModel, type EnvRequest, type EnvResponse } from '../env-model.js';

/** Pixels are derived and gitignored, so a fresh clone has the manifest and no bytes. */
const hasPixels =
  existsSync(path.join(CORPUS_DIR, 'images')) &&
  readdirSync(path.join(CORPUS_DIR, 'images')).some((n) => n.endsWith('.jpg'));

const leak = (artist: string | null, work: string | null = null): Leakage => ({ artist, work, year: null, recognised: artist !== null });

const workOf = (creator: string | null, title: string): Work => ({
  id: 'cma-1',
  source: 'cma',
  object_id: '1',
  accession_number: '1889.1',
  url: 'https://example.invalid/1',
  rights: 'CC0',
  title,
  creator,
  date_display: '1889',
  date_begin: 1889,
  date_end: 1889,
  classification: 'Painting',
  medium: 'oil on canvas',
  culture: 'America',
  department: 'Modern European Painting and Sculpture',
  image_url: 'https://example.invalid/1.jpg',
  image: { source_url: 'https://example.invalid/1.jpg', sha256: 'a'.repeat(64), bytes: 3, width: 900, height: 700 },
  fetched_at: '2026-08-31T00:00:00.000Z',
});

test('naming it right is canonical', () => {
  const v = verdict(workOf('Winslow Homer (American, 1836-1910)', 'The Sponge Diver'), leak('Winslow Homer'));
  assert.deepEqual(v, { claimedCanonical: true, canonical: true, misattributed: false });
});

test('naming it wrong is not canonical — it is evidence the work was not memorised', () => {
  // All eight of these are real: the probe's misses over the first fifty works were stylistically
  // adjacent artists, not noise. Counting them as contamination would have inflated the contaminated
  // set by a quarter with cases where the model demonstrably did not know the work.
  const misses: [string, string][] = [
    ['Sir Joshua Reynolds (British, 1723-1792)', 'Thomas Gainsborough'],
    ['Charles Sheeler (American, 1883-1965)', "Georgia O'Keeffe"],
    ['Petrus Christus (Netherlandish, c. 1410-1475)', 'Rogier van der Weyden'],
    ['Robert Seldon Duncanson (American, 1821-1872)', 'Frederic Edwin Church'],
    ['William Merritt Chase (American, 1849-1916)', 'Joaquín Sorolla'],
    ['Benjamin West (American, 1738-1820)', 'Angelica Kauffman'],
    ['Dieric Bouts (Netherlandish, c. 1415-1475)', 'Rogier van der Weyden'],
    ['Dieric Bouts (Netherlandish, c. 1415-1475)', 'van der Weyden'],
  ];
  for (const [truth, said] of misses) {
    const v = verdict(workOf(truth, 'Portrait of a Man'), leak(said));
    assert.equal(v.canonical, false, `"${said}" was scored as knowing "${truth}"`);
    assert.equal(v.misattributed, true);
    assert.equal(v.claimedCanonical, true);
  }
});

test('declining is neither canonical nor misattributed', () => {
  assert.deepEqual(verdict(workOf('Winslow Homer', 'The Sponge Diver'), leak(null)), {
    claimedCanonical: false,
    canonical: false,
    misattributed: false,
  });
});

test('the right title counts even when the artist is missed', () => {
  // Anonymous and workshop pieces have no usable creator, so the title is the only ground truth
  // there is. A probe that names the object is contaminated whatever it says about the hand.
  const v = verdict(workOf(null, 'Nataraja, Shiva as the Lord of Dance'), leak('Unknown (Chola Dynasty)', 'Shiva as Nataraja (Lord of the Dance)'));
  assert.equal(v.canonical, true);
});

test('a shared subject word is not an identification', () => {
  // All three of these were scored canonical by a one-word title rule and all three are works the
  // probe named wrongly. Titles are mostly subjects and the subjects repeat.
  const collisions: [string, string, string][] = [
    ['Portrait of Dora Wheeler', 'Joaquín Sorolla', 'Portrait of Emilie Ambre in Blue'],
    ['The Annunciation', 'Rogier van der Weyden', 'The Annunciation'],
    ['Saint John the Baptist in a Landscape', 'Rogier van der Weyden', 'Saint Mary Magdalene'],
  ];
  for (const [title, artist, said] of collisions) {
    const v = verdict(workOf('Somebody Else (Netherlandish, 1451-1549)', title), leak(artist, said));
    assert.equal(v.canonical, false, `"${said}" was scored as knowing "${title}"`);
    assert.equal(v.misattributed, true);
  }
});

test('a short shared word cannot carry a match on its own', () => {
  // "van", "de", "the". Without the length floor, every Netherlandish attribution matches every
  // other one and the canonical count becomes the number of works with a "van" in the label.
  assert.equal(verdict(workOf('Jan van Eyck', 'A Man'), leak('Rogier van der Weyden')).canonical, false);
});

test('the right hand and the wrong picture still counts as contaminated', () => {
  // Four works came back with the artist right and the title wrong (van Dyck, Cranach, Courbet,
  // Constable). Whether the model knew *this* object is unproven, but a contamination flag should
  // err toward including — the cost of over-reporting is a slightly smaller clean set, and the cost
  // of under-reporting is a claim that is quietly contaminated.
  const v = verdict(workOf('Anthony van Dyck (Flemish, 1599-1641)', 'A Genoese Lady with Her Child'), leak('Anthony van Dyck', 'Marchesa Elena Grimaldi Cattaneo'));
  assert.equal(v.canonical, true);
});

test("the model's own recognised flag does not decide", () => {
  // Both directions happen. A probe that fills in the right name while claiming not to recognise it
  // has recognised it; one that claims recognition and names nothing has not.
  const modest: Leakage = { artist: 'Winslow Homer', work: null, year: null, recognised: false };
  assert.equal(verdict(workOf('Winslow Homer', 'The Sponge Diver'), modest).canonical, true);
  const empty: Leakage = { artist: null, work: null, year: null, recognised: true };
  assert.equal(verdict(workOf('Winslow Homer', 'The Sponge Diver'), empty).claimedCanonical, false);
});

/**
 * Put bytes where `imagePath` will look for them, and point the work at them.
 *
 * The path is no longer stored on the record — it is derived from the sha256 — so a fixture cannot
 * be given an arbitrary filename any more. Hashing the bytes it actually writes is the only way to
 * keep the record and the file agreeing, which is exactly the property the change was made for.
 */
function putFixture(work: Work, bytes: Buffer): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  work.image = { source_url: work.image_url as string, sha256, bytes: bytes.length, width: null, height: null };
  const rel = imagePath(work) as string;
  mkdirSync(path.join(CORPUS_DIR, 'images'), { recursive: true });
  writeFileSync(path.join(CORPUS_DIR, rel), bytes);
  return rel;
}

test('a reading is made from the picture and nothing else', async () => {
  // The load-bearing test of this module, asserted against what was actually sent. Handed a famous
  // work *with its label*, a frontier model returns the accumulated critical literature on it, and
  // everything derived downstream would be art history rather than a reading of a surface.
  const work = workOf('Vincent van Gogh (Dutch, 1853-1890)', 'The Starry Night');
  work.date_display = 'June 1889';
  work.url = 'https://example.invalid/starry-night';
  const rel = putFixture(work, Buffer.from([0xff, 0xd8, 0xff, 0x01]));

  const before = recentEnvRequests.length;
  setEnvModel(async <T>(request: EnvRequest): Promise<EnvResponse<T>> => {
    const value =
      request.name === 'read-work'
        ? { does: ['a', 'b'], refuses: ['c'], tension: 'x'.repeat(25), materialFacts: ['d', 'e'], structuralMoves: ['f', 'g'] }
        : { recognised: false, work: null, artist: null, year: null };
    return { value: value as T, cached: true, inputTokens: 0, outputTokens: 0, usd: 0, cacheKey: 'stub' };
  });
  try {
    const reading = await readWork(work);
    assert.equal(reading.canonical, false);
    assert.equal(reading.promptHash, readingProtocolHash());
    assert.equal(reading.model, 'gpt-4o-2024-11-20');

    const sent = recentEnvRequests.slice(before);
    assert.deepEqual(sent.map((r) => r.name), ['read-work', 'identify-work']);
    const haystack = sent.map((r) => `${r.system}\n${r.text}`).join('\n').toLowerCase();
    for (const secret of ['starry', 'gogh', 'vincent', '1889', 'cma-1', 'example.invalid']) {
      assert.ok(!haystack.includes(secret), `the prompt leaked "${secret}"`);
    }
    // And it is a picture that was sent, not a description of one.
    for (const r of sent) assert.equal(r.hasImage, true);
  } finally {
    setEnvModel(null);
    rmSync(path.join(CORPUS_DIR, rel), { force: true });
  }
});

test('the identification is a separate call from the reading', async () => {
  // Asked in one breath, the identification conditions the reading and the reading conditions the
  // identification. This asserts the probe was not shown the reading it is supposed to be blind to.
  const work = workOf('Anon', 'A Thing');
  const rel = putFixture(work, Buffer.from([0xff, 0xd8, 0xff, 0x02]));
  const before = recentEnvRequests.length;
  setEnvModel(async <T>(request: EnvRequest): Promise<EnvResponse<T>> => {
    const value =
      request.name === 'read-work'
        ? { does: ['ONLYINREADING'], refuses: ['c'], tension: 'x'.repeat(25), materialFacts: ['d', 'e'], structuralMoves: ['f', 'g'] }
        : { recognised: false, work: null, artist: null, year: null };
    return { value: value as T, cached: true, inputTokens: 0, outputTokens: 0, usd: 0, cacheKey: 'stub' };
  });
  try {
    await readWork(work);
    const probe = recentEnvRequests.slice(before).find((r) => r.name === 'identify-work');
    assert.ok(probe && !`${probe.system}\n${probe.text}`.includes('ONLYINREADING'));
  } finally {
    setEnvModel(null);
    rmSync(path.join(CORPUS_DIR, rel), { force: true });
  }
});

test('the protocol hash covers the prompts, not just the model', () => {
  // A reading made under an older protocol is not an answer to the same question. If this ever stops
  // moving when a prompt is edited, `corpus read` will silently keep stale readings forever.
  const a = readingProtocolHash();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, readingProtocolHash());
});

test('every work on disk carries its rights and a content hash', () => {
  // A corpus without provenance is not a corpus, it is a folder of pictures. Skipped rather than
  // failed on a fresh clone, where nothing has been imported yet.
  const works = listWorks();
  if (works.length === 0) return;
  for (const w of works) {
    assert.equal(w.id, workId(w.source, w.object_id));
    assert.ok(w.rights.length > 0, `${w.id} is on disk without a rights statement`);
    assert.ok(w.url.length > 0 && w.object_id.length > 0);
    // A metadata-only row is legitimate; a row that claims bytes must be able to produce them.
    if (!w.image) continue;
    assert.match(w.image.sha256, /^[0-9a-f]{64}$/, `${w.id} has no content hash`);
    const rel = imagePath(w) as string;
    assert.equal(rel, path.join('images', `${w.image.sha256}.jpg`));
    // The bytes themselves are derived data and gitignored, so their absence is a fact about this
    // machine, not about the corpus. What is asserted unconditionally above — the id, the rights, the
    // hash, the path the hash implies — is the provenance claim, and that travels with the clone.
    if (!hasPixels) continue;
    assert.ok(existsSync(path.join(CORPUS_DIR, rel)), `${w.id} names an image that is not there`);
  }
});

test('every reading on disk agrees with the rule that scored it', () => {
  // The stored verdict is what everything downstream reads, so it must be recomputable. This is also
  // what would catch a corpus half-scored under the old one-flag rule.
  const works = listWorks();
  if (works.length === 0) return;
  for (const w of works) {
    const r = loadReading(w.id);
    if (!r) continue;
    assert.deepEqual(
      { claimedCanonical: r.claimedCanonical, canonical: r.canonical, misattributed: r.misattributed },
      verdict(w, r.leakage),
      `${w.id} carries a verdict the rule does not reproduce`,
    );
  }
});

// --- reading the picture's own dimensions ---------------------------------------------------------

/** SOI, an APP0 whose *payload* contains a decoy `FF C0`, then the real SOF0 saying 200x100. */
const jpegWithDecoy = (): Buffer =>
  Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, length 16 => 14 bytes of payload follow
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xf4, 0x02, 0x58, 0, 0, 0, 0, 0, // the decoy: "500x600"
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, // SOF0: 200x100
  ]);

test('the frame header is walked, not scanned, so a FF C0 inside a segment is not a size', () => {
  // This is the whole reason the function follows the segment chain. `FF C0` is a perfectly ordinary
  // byte pair inside APP0 thumbnails and inside entropy-coded scan data, and a scan for it finds a
  // "start of frame" in the middle of the picture and reports two bytes of image data as a width.
  assert.deepEqual(jpegSize(jpegWithDecoy()), { width: 200, height: 100 });
});

test('anything that is not a JPEG has no size and does not throw', () => {
  // A Cloudflare challenge page written to `<hash>.jpg` is the case that actually occurred: it
  // hashes fine, it is a real file, and it is not a picture.
  const apology = Buffer.from('<!DOCTYPE html><title>Just a moment...</title>', 'utf8');
  assert.equal(isJpeg(apology), false);
  assert.deepEqual(jpegSize(apology), { width: null, height: null });
  // Truncated mid-segment: refuse rather than read past the end.
  assert.deepEqual(jpegSize(jpegWithDecoy().subarray(0, 12)), { width: null, height: null });
  // Desynchronised — a byte that is not 0xFF where a marker must be.
  const broken = jpegWithDecoy();
  broken[2] = 0x41;
  assert.deepEqual(jpegSize(broken), { width: null, height: null });
});

test('every measured row on disk still agrees with the bytes it was measured from', () => {
  // The dimensions are a claim about the file, not about the work, so they are recomputable — and a
  // row whose stored size no longer matches its own pixels means the file under that hash changed.
  const works = listWorks().filter((w) => w.image?.width != null);
  if (works.length === 0) return;
  for (const w of works.slice(0, 40)) {
    const rel = imagePath(w);
    if (!rel || !existsSync(path.join(CORPUS_DIR, rel))) continue;
    assert.deepEqual(jpegSize(readFileSync(path.join(CORPUS_DIR, rel))), { width: w.image?.width, height: w.image?.height }, `${w.id}`);
  }
});

test('a 403 on an upscale is answered by asking for the size that exists', () => {
  // 203 of 6,817 selected Art Institute works are narrower than the 843px the corpus asks for, and
  // IIIF answers 403 rather than enlarging. For a day these were logged as a Cloudflare block; what
  // ruled that out was `full/400,` returning 200 on the same image id in the same second.
  const asked = 'https://www.artic.edu/iiif/2/e16d6339-72f5-ce3b-b355-ed9fd1f005ba/full/843,/0/default.jpg';
  assert.equal(withoutUpscale(asked), 'https://www.artic.edu/iiif/2/e16d6339-72f5-ce3b-b355-ed9fd1f005ba/full/!843,843/0/default.jpg');
  // Nothing else is rewritten. If the requested tier ever changes, this returns null and the 403
  // surfaces as a 403 instead of being retried against a path that no longer means anything.
  assert.equal(withoutUpscale('https://www.artic.edu/iiif/2/abc/full/full/0/default.jpg'), null);
  assert.equal(withoutUpscale('https://openaccess-cdn.clevelandart.org/1916.1030/1916.1030_web.jpg'), null);
});
