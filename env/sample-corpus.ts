// Reproducible Met corpus artifacts for the sampling subsystem.
//
// This is deliberately independent of artist/: env owns the bytes and facts that make a later
// retrieval replayable. The older artist/manifest.ts remains the shared three-museum corpus format;
// loadMetCorpus adapts it at the boundary so the existing 20k-image corpus is immediately usable.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './canonical.js';

export const MET_CORPUS_SCHEMA = 'kusama.met-corpus.v1';
export const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1';

export interface MetCorpusRecord {
  objectId: number;
  title: string;
  artist: string | null;
  culture: string | null;
  period: string | null;
  date: string | null;
  medium: string | null;
  dimensions: string | null;
  department: string | null;
  classification: string | null;
  objectName: string | null;
  tags: string[];
  objectPageUrl: string;
  primaryImageUrl: string;
  publicDomain: true;
  localImagePath: string | null;
  imageContentHash: string | null;
  ingestedAt: string;
  schemaVersion: typeof MET_CORPUS_SCHEMA;
}

export interface MetCorpusManifest {
  schemaVersion: typeof MET_CORPUS_SCHEMA;
  source: 'met-open-access';
  records: MetCorpusRecord[];
  /** Hash of canonical records only; changing a generated-at clock never changes corpus identity. */
  recordsHash: string;
}

type MetApiRecord = {
  objectID?: number;
  isPublicDomain?: boolean;
  primaryImage?: string;
  primaryImageSmall?: string;
  title?: string;
  artistDisplayName?: string;
  culture?: string;
  period?: string;
  objectDate?: string;
  medium?: string;
  dimensions?: string;
  department?: string;
  classification?: string;
  objectName?: string;
  tags?: { term?: string }[] | null;
  objectURL?: string;
};

export interface IngestOptions {
  output: string;
  limit: number;
  downloadImages?: boolean;
  concurrency?: number;
  requestDelayMs?: number;
  fetcher?: typeof fetch;
  now?: () => string;
  /** Tests and recorded-fixture runs may supply the object list without touching the API. */
  objectIds?: number[];
}

const MANIFEST_NAME = 'met-corpus.v1.json';
const STATE_NAME = 'ingest-state.v1.json';

export function manifestPath(input: string): string {
  return input.endsWith('.json') ? input : path.join(input, MANIFEST_NAME);
}

function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${canonicalJson(value)}\n`);
  renameSync(tmp, file);
}

export function recordsHash(records: readonly MetCorpusRecord[]): string {
  return createHash('sha256').update(canonicalJson([...records].sort((a, b) => a.objectId - b.objectId))).digest('hex');
}

export function writeMetCorpus(output: string, records: readonly MetCorpusRecord[]): MetCorpusManifest {
  mkdirSync(output, { recursive: true });
  const ordered = [...new Map(records.map((r) => [r.objectId, r])).values()].sort((a, b) => a.objectId - b.objectId);
  const manifest: MetCorpusManifest = {
    schemaVersion: MET_CORPUS_SCHEMA,
    source: 'met-open-access',
    records: ordered,
    recordsHash: recordsHash(ordered),
  };
  atomicJson(path.join(output, MANIFEST_NAME), manifest);
  return manifest;
}

function validateRecord(record: unknown): record is MetCorpusRecord {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Partial<MetCorpusRecord>;
  return Number.isInteger(r.objectId) && r.publicDomain === true && typeof r.primaryImageUrl === 'string' &&
    r.primaryImageUrl.length > 0 && r.schemaVersion === MET_CORPUS_SCHEMA;
}

function readNativeManifest(file: string): MetCorpusManifest {
  const value = JSON.parse(readFileSync(file, 'utf8')) as MetCorpusManifest;
  if (value.schemaVersion !== MET_CORPUS_SCHEMA || !Array.isArray(value.records)) {
    throw new Error(`${file} is not a ${MET_CORPUS_SCHEMA} manifest`);
  }
  if (!value.records.every(validateRecord)) throw new Error(`${file} contains an invalid or non-public-domain record`);
  const actual = recordsHash(value.records);
  if (actual !== value.recordsHash) throw new Error(`${file} records hash is ${actual}, expected ${value.recordsHash}`);
  return value;
}

/**
 * Load either the subsystem manifest or Kusama's existing JSONL corpus. The adapter only admits Met
 * records with a downloaded, content-hashed image, so a non-public-domain or unusable image can
 * never enter an index through this compatibility path.
 */
export function loadMetCorpus(input: string): MetCorpusManifest {
  const native = manifestPath(input);
  if (existsSync(native)) return readNativeManifest(native);
  const jsonl = input.endsWith('.jsonl') ? input : path.join(input, 'manifest.jsonl');
  if (!existsSync(jsonl)) throw new Error(`no Met corpus manifest at ${native} or ${jsonl}`);
  const records: MetCorpusRecord[] = [];
  for (const [lineNo, line] of readFileSync(jsonl, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    const w = JSON.parse(line) as Record<string, any>;
    if (w.source !== 'met') continue;
    const image = w.image as { source_url?: string; sha256?: string } | null;
    const imageUrl = typeof image?.source_url === 'string' ? image.source_url : w.image_url;
    if (!image || typeof image.sha256 !== 'string' || typeof imageUrl !== 'string' || !/CC0|Public Domain/i.test(String(w.rights))) continue;
    const objectId = Number(w.object_id);
    if (!Number.isInteger(objectId)) throw new Error(`${jsonl}:${lineNo + 1}: invalid Met object id`);
    records.push({
      objectId,
      title: String(w.title ?? '(untitled)'),
      artist: typeof w.creator === 'string' && w.creator ? w.creator : null,
      culture: typeof w.culture === 'string' && w.culture ? w.culture : null,
      period: null,
      date: typeof w.date_display === 'string' && w.date_display ? w.date_display : null,
      medium: typeof w.medium === 'string' && w.medium ? w.medium : null,
      dimensions: null,
      department: typeof w.department === 'string' && w.department ? w.department : null,
      classification: typeof w.classification === 'string' && w.classification ? w.classification : null,
      objectName: null,
      tags: [],
      objectPageUrl: String(w.url),
      primaryImageUrl: imageUrl,
      publicDomain: true,
      localImagePath: path.join('images', `${image.sha256}.jpg`),
      imageContentHash: image.sha256,
      ingestedAt: String(w.fetched_at ?? 'unknown'),
      schemaVersion: MET_CORPUS_SCHEMA,
    });
  }
  const ordered = records.sort((a, b) => a.objectId - b.objectId);
  return { schemaVersion: MET_CORPUS_SCHEMA, source: 'met-open-access', records: ordered, recordsHash: recordsHash(ordered) };
}

function fromApi(record: MetApiRecord, ingestedAt: string): MetCorpusRecord | null {
  const image = record.primaryImageSmall || record.primaryImage;
  if (record.isPublicDomain !== true || !Number.isInteger(record.objectID) || !image) return null;
  return {
    objectId: record.objectID!,
    title: record.title?.trim() || '(untitled)',
    artist: record.artistDisplayName?.trim() || null,
    culture: record.culture?.trim() || null,
    period: record.period?.trim() || null,
    date: record.objectDate?.trim() || null,
    medium: record.medium?.trim() || null,
    dimensions: record.dimensions?.trim() || null,
    department: record.department?.trim() || null,
    classification: record.classification?.trim() || null,
    objectName: record.objectName?.trim() || null,
    tags: (record.tags ?? []).map((t) => t.term?.trim()).filter((t): t is string => Boolean(t)),
    objectPageUrl: record.objectURL || `https://www.metmuseum.org/art/collection/search/${record.objectID}`,
    primaryImageUrl: image,
    publicDomain: true,
    localImagePath: null,
    imageContentHash: null,
    ingestedAt,
    schemaVersion: MET_CORPUS_SCHEMA,
  };
}

class PermanentFetchError extends Error {}

async function fetchWithRetry(fetcher: typeof fetch, url: string, attempts = 4): Promise<Response> {
  let last: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { accept: url.startsWith(MET_API) ? 'application/json' : 'image/*', 'user-agent': 'kusama-samples/0.2' },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return response;
      if (response.status < 500 && response.status !== 429) {
        throw new PermanentFetchError(`${url} answered ${response.status}`);
      }
      last = new Error(`${url} answered ${response.status}`);
    } catch (error) {
      if (error instanceof PermanentFetchError) throw error;
      last = error as Error;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw last ?? new Error(`failed to fetch ${url}`);
}

async function sha256Stream(response: Response): Promise<{ bytes: Buffer; hash: string }> {
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

/** Serialize request starts; the 150ms default is far below the Met's documented 80 req/s cap. */
function rateLimited(fetcher: typeof fetch, intervalMs: number): typeof fetch {
  let gate = Promise.resolve();
  let nextStart = 0;
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const turn = gate.then(async () => {
      const wait = Math.max(0, nextStart - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      nextStart = Date.now() + intervalMs;
    });
    gate = turn.catch(() => undefined);
    await turn;
    return fetcher(input, init);
  }) as typeof fetch;
}

/** Resumable, bounded-concurrency Met ingestion. Cached object JSON is the resume journal. */
export async function ingestMetCorpus(options: IngestOptions): Promise<MetCorpusManifest> {
  const output = path.resolve(options.output);
  const objectsDir = path.join(output, 'objects');
  const imagesDir = path.join(output, 'images');
  mkdirSync(objectsDir, { recursive: true });
  if (options.downloadImages) mkdirSync(imagesDir, { recursive: true });
  const now = options.now ?? (() => new Date().toISOString());
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
  const delay = Math.max(0, options.requestDelayMs ?? 150);
  const fetcher = rateLimited(options.fetcher ?? fetch, delay);

  let ids = options.objectIds;
  if (!ids) {
    const list = await fetchWithRetry(fetcher, `${MET_API}/objects`);
    const body = (await list.json()) as { objectIDs?: number[] };
    ids = body.objectIDs ?? [];
  }
  const old = existsSync(manifestPath(output)) ? readNativeManifest(manifestPath(output)).records : [];
  const accepted = new Map(old.map((r) => [r.objectId, r]));
  const stateFile = path.join(output, STATE_NAME);
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, 'utf8')) as { visited: number[] }
    : { visited: [] as number[] };
  const visited = new Set([...state.visited, ...accepted.keys()]);

  // Metadata-only ingestion is intentionally useful. A later --download upgrades those same rows
  // in place without walking object metadata again.
  if (options.downloadImages) {
    for (const record of [...accepted.values()].sort((a, b) => a.objectId - b.objectId)) {
      if (record.localImagePath && record.imageContentHash) continue;
      const got = await sha256Stream(await fetchWithRetry(fetcher, record.primaryImageUrl));
      const relative = path.join('images', `${got.hash}.jpg`);
      writeFileSync(path.join(output, relative), got.bytes);
      record.localImagePath = relative;
      record.imageContentHash = got.hash;
    }
    writeMetCorpus(output, [...accepted.values()]);
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (accepted.size < options.limit && cursor < ids!.length) {
      const objectId = ids![cursor++]!;
      if (visited.has(objectId)) continue;
      const cache = path.join(objectsDir, `${objectId}.json`);
      let raw: MetApiRecord;
      if (existsSync(cache)) raw = JSON.parse(readFileSync(cache, 'utf8')) as MetApiRecord;
      else {
        const response = await fetchWithRetry(fetcher, `${MET_API}/objects/${objectId}`);
        raw = await response.json() as MetApiRecord;
        atomicJson(cache, raw);
      }
      const record = fromApi(raw, now());
      if (record && options.downloadImages) {
        const got = await sha256Stream(await fetchWithRetry(fetcher, record.primaryImageUrl));
        const relative = path.join('images', `${got.hash}.jpg`);
        writeFileSync(path.join(output, relative), got.bytes);
        record.localImagePath = relative;
        record.imageContentHash = got.hash;
      }
      // Another conservative worker may have filled the last slot while this request was in
      // flight. Keep the cached object unvisited in that case so increasing --limit later can admit
      // it without a second request.
      if (record && accepted.size < options.limit) {
        accepted.set(record.objectId, record);
        visited.add(objectId);
      } else if (!record) visited.add(objectId);
      atomicJson(stateFile, { schemaVersion: MET_CORPUS_SCHEMA, visited: [...visited].sort((a, b) => a - b) });
      // Flush accepted rows after every object: interruption loses at most the in-flight request.
      writeMetCorpus(output, [...accepted.values()].slice(0, options.limit));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return writeMetCorpus(output, [...accepted.values()].slice(0, options.limit));
}
