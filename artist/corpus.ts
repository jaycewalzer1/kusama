// The corpus: real works, fetched with their rights, and read without their names.
//
// An artist's background has to be grounded in particular objects. "Punk zine aesthetic" written as
// prose is a description of the average of ten thousand zines, and the average is the thing this
// whole repo is trying to get away from — a pretrained model handed an adjective returns the mean of
// everything it has seen under that adjective, which is precisely the poster problem one layer up.
// So a lineage element starts from one work, with a source, a date and a licence.
//
// ## The reading is blind, and that is the load-bearing decision
//
// Every reading is made from the image and nothing else. No title, no artist, no date, no wall text.
// Hand a frontier model a famous painting *with its label* and what comes back is the accumulated
// critical literature on that painting — fluent, correct, and entirely secondhand. The artist
// downstream would then be reciting art history rather than deriving anything from a surface. The
// reading prompt therefore contains no field of `Work.source`, and `corpus.test.ts` asserts that
// against the recorded request rather than trusting this comment.
//
// ## Withholding the name is not a control, which is why there is a probe
//
// Memorization scales with duplication, and famous artworks are among the most duplicated images on
// the web; short prompts that never name a work are documented to reproduce specific memorized ones
// anyway. So blindness cannot be assumed to have worked. Each work gets one extra call — same image,
// separate request, no reading in context — asking it to name the work, the artist and the year, or
// say unknown.
//
// The answer is then checked against the record, because "it named something" and "it knew the work"
// are different facts and the first overstates the second by a quarter here. See `verdict`.
//
// Canonical works stay in the corpus and stay usable. What changes is what may be *claimed*: any
// research claim resting on a canonical element is contaminated by the model's prior knowledge of
// that element and has to be reported separately from claims resting on the rest. The count is the
// headline number this module produces.
//
// ## Why the Cleveland Museum of Art
//
// The brief named the Art Institute of Chicago. Its metadata API works exactly as described, but
// every request to its IIIF image host returns a Cloudflare managed-challenge 403 from this machine
// — plain fetch, browser user agent, and the repo's own headless Chromium alike. Metadata without
// pixels cannot be read blind. CMA satisfies every property AIC was chosen for: no key, an explicit
// per-work `share_license_status: "CC0"`, server-side filtering on licence and image presence, and
// a CDN that actually serves the file. WikiArt remains disqualified for the reasons it was
// disqualified: no clean licence grant, and it is the art dataset most likely to be inside every
// model's pretraining.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { contentHash } from '../env/profile.js';
import { ENV_MODEL, envModel } from './env-model.js';
import { type ManifestImage, type Work, imagePath, readManifest, workId, writeManifest } from './manifest.js';

export const CORPUS_DIR = path.join(ROOT, 'corpus');
export const MANIFEST = path.join(CORPUS_DIR, 'manifest.jsonl');
const IMAGES = path.join(CORPUS_DIR, 'images');
const READINGS = path.join(CORPUS_DIR, 'readings');

/** The source this module imports from. Another museum gets its own importer, mapping at the edge. */
export const SOURCE_CORPUS = 'cma';

// The record shape lives in manifest.ts, source-agnostic, and is re-exported here so that the
// existing consumers keep importing the corpus from one place.
export type { Work } from './manifest.js';
export { imagePath, workId } from './manifest.js';

/**
 * What a reading is allowed to say.
 *
 * Deliberately small and concrete. Every field has to survive being turned into something checkable
 * one layer up — `derive.ts` reads only this, never the image and never the metadata — so an
 * impression that cannot be cashed out as a rule about making is not worth the tokens. `tension` is
 * singular because a work that is holding four things unresolved is usually a reader who has not
 * decided what it is holding.
 */
export interface Reading {
  does: string[];
  refuses: string[];
  tension: string;
  materialFacts: string[];
  structuralMoves: string[];
}

export interface Leakage {
  /** What the model said the work was, or null if it declined. */
  work: string | null;
  artist: string | null;
  year: string | null;
  /** The model's own claim about whether it recognised it. Not the verdict — see `canonical`. */
  recognised: boolean;
}

export interface WorkReading {
  id: string;
  model: string;
  /** Hash of the two system prompts and the two schemas. A protocol change invalidates comparability. */
  promptHash: string;
  reading: Reading;
  leakage: Leakage;
  /**
   * The probe named something. This is the number the probe was originally specified to produce, and
   * it is kept because the gap between it and `canonical` is the interesting part.
   */
  claimedCanonical: boolean;
  /**
   * The probe named something **and it was right**. Claims over canonical elements are contaminated
   * by the model's prior knowledge of that specific work and get reported apart from the rest; they
   * are not thrown away.
   */
  canonical: boolean;
  /** Set when the probe named a work confidently and named the wrong one. */
  misattributed: boolean;
}

// --- the two prompts ----------------------------------------------------------------------------

const READ_SYSTEM = [
  'You are looking at one picture and describing how it is made. You have not been told what it is,',
  'and you must not guess: no title, no artist, no movement, no period, no country, and no "this',
  'resembles the work of". If a name is on the tip of your tongue, that is exactly the reflex this',
  'is built to defeat — describe the surface instead.',
  '',
  'Say what the thing does, what it refuses to do, what it is holding unresolved, what it is',
  'physically made of as far as the surface shows, and what structural decisions were taken. Be',
  'concrete and be short. "Melancholy" is not an observation; "the only warm colour is a single',
  'stroke at the far right, and everything else is within one step of grey" is.',
  '',
  'Write each item so that somebody making a new picture could follow it or break it on purpose.',
].join('\n');

const IDENTIFY_SYSTEM = [
  'Name this work if you recognise it. Give the title, the artist and the year.',
  '',
  'If you do not recognise the specific work, say so plainly and leave the fields null. A guess from',
  'style, period or subject is not recognition and is worse than nothing here: this answer is used to',
  'decide whether a later claim about the work is contaminated by what you already knew, and a',
  'confident guess makes a clean case look dirty exactly as often as the reverse.',
].join('\n');

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['does', 'refuses', 'tension', 'materialFacts', 'structuralMoves'],
  properties: {
    does: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' }, description: 'What the surface actively does to a viewer.' },
    refuses: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' }, description: 'What it could obviously have done and did not.' },
    tension: { type: 'string', minLength: 20, description: 'The one thing it is holding unresolved.' },
    materialFacts: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' }, description: 'Marks, edges, ground, layering — only what the surface shows.' },
    structuralMoves: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' }, description: 'Decisions about placement, scale, division, repetition, cropping.' },
  },
} as const;

const IDENTIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recognised', 'work', 'artist', 'year'],
  properties: {
    recognised: { type: 'boolean', description: 'True only if you know the specific work, not the style.' },
    work: { type: ['string', 'null'] },
    artist: { type: ['string', 'null'] },
    year: { type: ['string', 'null'] },
  },
} as const;

/**
 * The protocol every reading is stamped with. Any edit to a prompt or a schema moves this, which is
 * how a reading made under an older protocol is stopped from being compared with a newer one.
 */
export function readingProtocolHash(): string {
  return contentHash({ READ_SYSTEM, IDENTIFY_SYSTEM, READ_SCHEMA, IDENTIFY_SCHEMA, model: ENV_MODEL });
}

// --- reading ------------------------------------------------------------------------------------

/**
 * The prompt text a reading is made from, given nothing but the picture.
 *
 * A function rather than a constant so the blindness test can call it with a work and assert that
 * nothing about that work comes back. If this ever grows a parameter carrying a title, the test that
 * greps the recorded request is the thing that will notice.
 */
export function readingText(): string {
  return 'Describe how this picture is made.';
}

export async function readWork(work: Work): Promise<WorkReading> {
  const rel = imagePath(work);
  // A metadata-only row is a legitimate state in the manifest and an impossible one here: the whole
  // protocol is a reading made from pixels and nothing else, so there is no degraded mode to fall
  // back to. Refusing loudly beats a reading made from a filename.
  if (!rel) throw new Error(`${work.id} has no image; a blind reading has nothing to read`);
  const base64 = readFileSync(path.join(CORPUS_DIR, rel)).toString('base64');

  const reading = await envModel<Reading>({
    name: 'read-work',
    system: READ_SYSTEM,
    text: readingText(),
    imageBase64: base64,
    imageMime: 'image/jpeg',
    // A structured reading of a painting does not fit in the environment's usual 1024.
    maxTokens: 1500,
    schema: READ_SCHEMA,
  });

  // A separate call, not a second field on the first. Asked in the same breath, the identification
  // conditions the reading and the reading conditions the identification, and neither answer means
  // anything afterwards.
  const probe = await envModel<Leakage>({
    name: 'identify-work',
    system: IDENTIFY_SYSTEM,
    text: 'What is this?',
    imageBase64: base64,
    imageMime: 'image/jpeg',
    schema: IDENTIFY_SCHEMA,
  });

  return {
    id: work.id,
    model: ENV_MODEL,
    promptHash: readingProtocolHash(),
    reading: reading.value,
    leakage: probe.value,
    ...verdict(work, probe.value),
  };
}

/**
 * The verdict on one probe. Three flags, because the obvious one flag is wrong.
 *
 * Taken from what the probe *said* rather than from its own `recognised` boolean: a model that says
 * `recognised: false` and then fills in a title and an artist has recognised it, and one that says
 * `recognised: true` and names nothing has not. Both happen. The flag stays in the record because
 * the disagreement is informative, but it is not what decides.
 *
 * And naming something is not the same as naming it right. Measured over the first fifty works, the
 * probe named 38 and was correct on 30; the other eight were confident style inferences — Reynolds
 * called Gainsborough, Sheeler called O'Keeffe, an anonymous Chola bronze called "Unknown (Chola
 * Dynasty)". Counting those as contamination would have inflated the contaminated set by a quarter
 * with cases where the model demonstrably did *not* know the work. So `claimedCanonical` keeps the
 * naive number, `canonical` is the one that gates a research claim, and `misattributed` is kept
 * because a confident wrong name is its own finding about what the probe is worth.
 *
 * The ground truth comes off the manifest row, which is on disk and never enters a prompt, so
 * checking the answer costs nothing and breaks no blindness.
 */
export function verdict(work: Work, leak: Leakage): { claimedCanonical: boolean; canonical: boolean; misattributed: boolean } {
  const claimedCanonical = Boolean(leak.work) || Boolean(leak.artist);
  if (!claimedCanonical) return { claimedCanonical: false, canonical: false, misattributed: false };
  // One shared word is enough for a maker and not enough for a title. A surname is an identifier;
  // a title is mostly a subject, and the subjects repeat. Scored on one word, "The Annunciation"
  // matched "The Annunciation" by a different hand, "Portrait of Dora Wheeler" matched "Portrait of
  // Emilie Ambre", and "Saint John the Baptist" matched "Saint Mary Magdalene" — three works the
  // model plainly did not know, counted as three works it did. Two words is the cheapest thing that
  // separates naming an object from naming its subject, and it still passes the case the title rule
  // exists for: an anonymous bronze has no maker, and "Nataraja, Shiva as the Lord of Dance" shares
  // four words with what the probe said.
  const canonical = shares(work.creator, leak.artist, 1) || shares(work.title, leak.work, 2);
  return { claimedCanonical, canonical, misattributed: !canonical };
}

/**
 * Whether two names overlap in at least `need` words of four letters or more.
 *
 * Deliberately loose about form. The source's creator field carries a whole biography ("Winslow
 * Homer (American, 1836-1910)") and the probe answers with a bare name, so anything stricter than
 * token overlap scores every correct answer wrong. Short words are dropped so "van", "the" and "de"
 * cannot carry a match alone. It can still be fooled by two artists who share a surname, which is
 * why the number it produces is reported next to the misattribution count rather than on its own.
 */
function shares(truth: string | null, said: string | null, need: number): boolean {
  if (!truth || !said) return false;
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length > 3));
  const a = words(truth);
  let hits = 0;
  for (const w of words(said)) if (a.has(w) && ++hits >= need) return true;
  return false;
}

// --- the source ---------------------------------------------------------------------------------

interface CmaImage {
  url?: string;
  width?: string;
  height?: string;
}

/**
 * What the list endpoint actually returns, as measured rather than as documented.
 *
 * Three fields do not match the shape a reader would guess. `type` is the classification word and
 * `technique` is the medium, so neither name says what it holds. `culture` is an **array**
 * (`["America"]`), not a string. And `api_link` is simply absent from list responses, so the
 * canonical record URL has to be reconstructed. Every one of these is a place a plausible-looking
 * mapping would have written the wrong thing into the manifest and been believed.
 */
interface CmaRecord {
  id: number;
  accession_number?: string;
  title?: string;
  creation_date?: string;
  creation_date_earliest?: number | null;
  creation_date_latest?: number | null;
  share_license_status?: string;
  url?: string;
  type?: string;
  technique?: string;
  culture?: string[];
  department?: string;
  creators?: { description?: string }[];
  images?: { web?: CmaImage; print?: CmaImage; full?: CmaImage };
}

const LIST_URL = 'https://openaccess-api.clevelandart.org/api/artworks/';

/**
 * Who is knocking. An open-access API is a courtesy, and a courtesy is extended to somebody rather
 * than to an anonymous socket; a museum that can see who is pulling and why can raise a limit or
 * send a mail instead of a block.
 */
const USER_AGENT = 'kusama-corpus/0.2 (research; deriving lineage elements from open-access works)';

/**
 * One request, with the patience a run measured in hours needs.
 *
 * The importer used to be a bare `fetch`, which is correct for fifty works and wrong for twenty
 * thousand: over that many requests a 429 or a 502 stops being an anomaly and becomes an
 * arithmetic certainty, and a crawl that dies on the first one has to be babysat. Retries are
 * bounded and only cover the answers that mean "later" — a 404 is not a transient condition and
 * retrying it four times is just four more requests the museum did not ask for.
 *
 * The `try` around `fetch` is not defensive tidying. An earlier version retried on status codes
 * only, and a throwaway copy of exactly this logic died on `ETIMEDOUT` at record 25,000 of 41,511 —
 * `fetch` *throws* on a dropped socket rather than returning a status, so the whole retry ladder was
 * unreachable for the one failure mode that a long crawl is guaranteed to hit. The timeout is here
 * for the same reason: without it a half-open connection hangs the run indefinitely, which is worse
 * than an error because nothing reports it.
 */
async function politely(url: string, accept = 'application/json', tries = 4): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    // Honour what the server asked for if it asked for anything; otherwise back off geometrically
    // from a second. `Retry-After` is the museum telling us its own limit, and guessing over the
    // top of it is how a slow crawl becomes a blocked one.
    const wait = (res?: Response) => {
      const after = Number(res?.headers.get('retry-after'));
      return new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1)));
    };
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (attempt >= tries) throw new Error(`${url} could not be reached after ${tries} attempts: ${(e as Error).message}`);
      await wait();
      continue;
    }
    if (res.ok) return res;
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= tries) throw new Error(`the corpus source answered ${res.status} for ${url}`);
    await wait(res);
  }
}

/**
 * One request for a page of the list. The whole point of preferring this API: the licence and the
 * image are both filterable server-side, so nothing is fetched that then has to be thrown away for
 * having the wrong rights.
 *
 * `skip` is exposed because a corpus is grown, not built once, and the second fifty must not be the
 * first fifty again. `filters` is exposed because the first twenty thousand records in accession
 * order are not a corpus anybody chose — they are whatever the museum happens to have numbered
 * first. `type=Textile` and `department=Islamic Art` are server-side, so choosing the range costs
 * the same as not choosing it.
 */
export async function listCandidates(limit: number, skip = 0, filters: Record<string, string> = {}): Promise<CmaRecord[]> {
  const query = new URLSearchParams({ cc0: '1', has_image: '1', limit: String(limit), skip: String(skip) });
  for (const [k, v] of Object.entries(filters)) if (v) query.set(k, v);
  const res = await politely(`${LIST_URL}?${query}`);
  const body = (await res.json()) as { data: CmaRecord[] };
  return body.data;
}

function pickImage(record: CmaRecord): CmaImage | null {
  // `web` on purpose: around 800px on the long edge, which is what the reader is shown. Fetching the
  // print master would cost fifty times the bytes to be downsampled before it reaches the model.
  // Measured across all 41,511 CC0 records, no `web` derivative exceeds 1263px, so this tier is
  // under the reader's ceiling everywhere rather than usually.
  return record.images?.web ?? record.images?.full ?? record.images?.print ?? null;
}

/**
 * One CMA record as a manifest row, with no image yet.
 *
 * Separate from fetching the pixels because metadata is cheap and pixels are not: 41,511 records is
 * about forty requests, and the same set of images is 14.6GB. Deciding which works to keep should
 * happen between those two facts, not after both.
 *
 * Returns null rather than throwing for a record this corpus may not hold — the licence check is
 * here and not in the caller so that no path exists which writes a row without it.
 */
export function metadataFrom(record: CmaRecord): Work | null {
  if (record.share_license_status !== 'CC0') return null;
  const image = pickImage(record);
  if (!image?.url) return null;

  // Both bounds or neither. CMA reports 0 for "not known", which is a sentinel and not a year, and a
  // corpus stratified on a band of 0–0 is stratified on a bug.
  const begin = record.creation_date_earliest ?? null;
  const end = record.creation_date_latest ?? null;
  const dated = typeof begin === 'number' && typeof end === 'number' && begin !== 0 && begin <= end;

  return {
    id: workId(SOURCE_CORPUS, record.id),
    source: SOURCE_CORPUS,
    object_id: String(record.id),
    accession_number: record.accession_number ?? null,
    url: record.url ?? `https://www.clevelandart.org/art/${record.id}`,
    rights: record.share_license_status,
    title: record.title ?? '(untitled)',
    creator: record.creators?.[0]?.description ?? null,
    date_display: record.creation_date ?? '',
    date_begin: dated ? begin : null,
    date_end: dated ? end : null,
    classification: record.type ?? '(unclassified)',
    medium: record.technique ?? '',
    culture: record.culture?.[0] ?? null,
    department: record.department ?? '(no department)',
    image_url: image.url,
    image: null,
    fetched_at: new Date().toISOString(),
  };
}

/** CMA reports dimensions as strings. Anything that is not a positive number is absent, not zero. */
function num(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The dimensions the source claims for the tier we take, kept only when it claims any. */
function claimedSize(record: CmaRecord): { width: number | null; height: number | null } {
  const i = pickImage(record);
  return { width: num(i?.width), height: num(i?.height) };
}

/** Metadata plus pixels, for the fifty-works case where doing both at once is simply easier. */
export async function importWork(record: CmaRecord): Promise<Work | null> {
  const work = metadataFrom(record);
  if (!work) return null;
  await fetchImage(work, claimedSize(record));
  return work;
}

/**
 * Fetch one work's pixels and write the row that will be verified against them forever after.
 *
 * Mutates `work.image` because the sha256 is not knowable until the bytes arrive — until then the
 * field is null, which is precisely the state `corpus verify` and the resumable fetcher look for.
 * `claimed` carries the source's own dimensions when the caller has the source record in hand; it is
 * left null rather than measured off the file, on the same rule as every other field here.
 */
export async function fetchImage(work: Work, claimed: { width: number | null; height: number | null } = { width: null, height: null }): Promise<void> {
  if (!work.image_url) throw new Error(`${work.id} has no image url to fetch`);
  const res = await politely(work.image_url, 'image/*');
  const bytes = Buffer.from(await res.arrayBuffer());
  // A Cloudflare challenge is an HTML page, and an HTML page written to `<hash>.jpg` is a file that
  // hashes fine, verifies fine, and is not a picture. The magic number is the only check that tells
  // a JPEG from an apology, and it is cheap enough that there is no argument for skipping it.
  if (!isJpeg(bytes)) throw new Error(`${work.id}: ${work.image_url} did not return a JPEG (${bytes.length} bytes)`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  mkdirSync(IMAGES, { recursive: true });
  writeFileSync(path.join(IMAGES, `${sha256}.jpg`), bytes);
  work.image = { source_url: work.image_url, sha256, bytes: bytes.length, ...claimed };
}

/** `FF D8 FF` — the SOI marker every JPEG starts with, and no HTML error page does. */
export function isJpeg(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Whether this work's pixels are on this machine. Manifest rows are tracked; images are not. */
export function hasImage(work: Work): boolean {
  const rel = imagePath(work);
  return rel !== null && existsSync(path.join(CORPUS_DIR, rel));
}

/**
 * Put back one work's pixels from the URL its manifest row already carries.
 *
 * The images are content-addressed and gitignored, so a clone has every provenance record and none
 * of the bytes. That is only a safe trade if the bytes come back *identical*, which is exactly what
 * a sha256 in the row lets us insist on rather than hope for — a museum that requotes its own
 * derivative at a different quality would otherwise silently change what every reading was made
 * from. A mismatch is an error, not a warning.
 */
export async function refetchImage(work: Work): Promise<void> {
  if (!work.image) throw new Error(`${work.id} has no image to refetch`);
  const want = work.image.sha256;
  const copy: Work = { ...work, image: null };
  await fetchImage(copy);
  const got = copy.image as ManifestImage;
  if (got.sha256 !== want) {
    throw new Error(`${work.id}: the source now serves ${got.sha256.slice(0, 12)}, but the row was made from ${want.slice(0, 12)}`);
  }
}

// --- reading the corpus back ---------------------------------------------------------------------

export function listWorks(): Work[] {
  return readManifest(MANIFEST).works;
}

/**
 * Merge rows into the manifest, newest wins on id.
 *
 * Whole-file because the file is sorted and the sort is what keeps a re-import from reading as a
 * total rewrite in git. At 250,000 rows this is a few hundred milliseconds and it is called once per
 * batch, not once per work.
 */
export function saveWorks(works: Work[]): void {
  const by = new Map(readManifest(MANIFEST).works.map((w) => [w.id, w]));
  for (const w of works) by.set(w.id, w);
  mkdirSync(CORPUS_DIR, { recursive: true });
  writeManifest(MANIFEST, [...by.values()]);
}

export function loadReading(id: string): WorkReading | null {
  const file = path.join(READINGS, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as WorkReading;
}

export function saveReading(reading: WorkReading): void {
  mkdirSync(READINGS, { recursive: true });
  writeFileSync(path.join(READINGS, `${reading.id}.json`), `${JSON.stringify(reading, null, 2)}\n`);
}

export interface CorpusSummary {
  works: number;
  read: number;
  /** Named and right. The set a research claim has to be reported apart from. */
  canonical: number;
  canonicalIds: string[];
  /** Named anything at all. Always >= canonical; the gap is the probe's false-positive rate. */
  claimed: number;
  /** Named confidently and wrongly. */
  misattributed: number;
  misattributedIds: string[];
}

/** Works, readings, and how many of them the model actually knew. The headline of an import. */
export function corpusSummary(): CorpusSummary {
  const works = listWorks();
  const readings = works.map((w) => loadReading(w.id)).filter((r): r is WorkReading => r !== null);
  const canonicalIds = readings.filter((r) => r.canonical).map((r) => r.id);
  const misattributedIds = readings.filter((r) => r.misattributed).map((r) => r.id);
  return {
    works: works.length,
    read: readings.length,
    canonical: canonicalIds.length,
    canonicalIds,
    claimed: readings.filter((r) => r.claimedCanonical).length,
    misattributed: misattributedIds.length,
    misattributedIds,
  };
}
