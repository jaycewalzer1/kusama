// The manifest: one line per work, one shape regardless of which museum it came from.
//
// Everything downstream reads only this. A source-specific record would mean every consumer —
// reading, deriving, selection, the image fetcher, `verify` — growing a branch per museum, and
// three branches is how the fourth museum becomes a rewrite instead of an adapter. So the mapping
// from a museum's own JSON or CSV happens once, at the edge, in that source's importer, and
// nothing past that edge knows the difference.
//
// ## Why this file is the evidence and the images are not
//
// `corpus/manifest.jsonl` is tracked in git; `corpus/images/` is not. The manifest is small (a few
// hundred bytes a work) and it is the part a person needs in order to check a claim: what the work
// is, who holds it, what licence it was published under, and the sha256 of exactly the bytes that
// were read. The pixels are large, regenerable, and carry no evidence the manifest does not — every
// image is refetchable from `image.source_url` and verifiable against `image.sha256`, which is what
// `corpus verify` exists to do. Measured on the CMA web tier the mean image is 356KB, so tracking
// them would put roughly 10.7GB in git at a 30,000-work corpus.
//
// ## Two rules that are load-bearing rather than tidy
//
// **Rights are copied verbatim and never inferred.** Not from a date, not from a department, not
// from the fact that a sibling record was CC0. A licence is a claim about what somebody is legally
// permitted to do, and a guessed licence is worse than an absent one because it looks like a fact.
//
// **`date_begin` / `date_end` are null when the source's prose does not parse.** Never invented,
// never defaulted to a century boundary, never quietly set to the year the record was created. The
// same discipline `provenance.ts` applies to its period parser: a date band that was guessed will
// later be sampled against as though it were measured, and a stratification built on invented dates
// is a stratification of nothing.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The sources this corpus is allowed to hold. Named so a fourth cannot be mixed in silently. */
export const SOURCES = ['cma', 'met', 'aic'] as const;
export type Source = (typeof SOURCES)[number];

/**
 * The evidence that particular bytes were read — not the intention to read them.
 *
 * This is why `image_url` on the row and `image` here are two fields rather than one. The URL is
 * known from metadata, before anything has been downloaded; the hash cannot exist until the bytes
 * arrive. Folding them together forces either a sha256 of the empty string (a hash that verifies
 * nothing while looking like a fact) or a nullable hash inside a non-null image (which every
 * consumer then has to re-check). Kept apart, `image === null` means exactly "not fetched yet", and
 * a non-null `image` is always a complete claim about bytes that existed.
 */
export interface ManifestImage {
  /** Where the bytes actually came from, which may differ from `image_url` if the tier changed. */
  source_url: string;
  sha256: string;
  bytes: number;
  /** Null when the source does not report dimensions; never inferred from the file. */
  width: number | null;
  height: number | null;
}

export interface Work {
  /**
   * `<source>-<their object id>`.
   *
   * Hyphen and numeric object id, NOT the `cma:1926.15` accession form. These ids are also the
   * lineage element ids — `derivedIds()` in the elements pack keys off `work.id` — so renaming them
   * moves the pack hash, which moves `envVersion`, which silently invalidates comparability with
   * every trajectory already on disk. The accession number is kept in its own field instead.
   */
  id: string;
  source: Source;
  object_id: string;
  /** The museum's own accession string, where it has one distinct from the object id. */
  accession_number: string | null;
  /** The human-viewable record page, so a provenance claim can be checked by a person. */
  url: string;
  /** Verbatim from the source. Never inferred. */
  rights: string;
  title: string;
  creator: string | null;
  /** The source's own prose, kept as written. */
  date_display: string;
  /** Null when the prose does not parse. Never guessed. */
  date_begin: number | null;
  date_end: number | null;
  /** The source's own word for what kind of object this is. */
  classification: string;
  medium: string;
  culture: string | null;
  department: string;
  /**
   * The image this work resolves to, known from metadata. Null when the source publishes no image
   * for it at all — which is different from having one that has not been downloaded.
   */
  image_url: string | null;
  /** Null until the bytes have actually been fetched. A metadata-only row is a legitimate state. */
  image: ManifestImage | null;
  fetched_at: string;
}

/** Where an image lives once fetched. Derived from the hash, so the manifest need not store it. */
export function imagePath(work: Work): string | null {
  return work.image ? path.join('images', `${work.image.sha256}.jpg`) : null;
}

/** `<source>-<object id>`. Filesystem-safe and stable across re-imports. */
export function workId(source: Source, objectId: string | number): string {
  return `${source}-${String(objectId)}`;
}

// --- validation ---------------------------------------------------------------------------------

/** Fields with no honest empty value: a row missing any of these is not identifiable or not usable. */
const STRINGS = ['id', 'object_id', 'url', 'rights', 'title', 'classification', 'department', 'fetched_at'] as const;

/**
 * Fields where the empty string is the source's own answer.
 *
 * `medium` and `date_display` are blank on real records — AIC leaves the medium off coins, the Met
 * leaves the date prose off objects it dates only numerically. Requiring them to be non-empty does
 * not make the data better; it makes the importer write `"(unknown)"`, which is a placeholder
 * indistinguishable from a fact two layers downstream. Empty means empty.
 */
const MAY_BE_EMPTY = ['date_display', 'medium'] as const;
const NULLABLE_STRINGS = ['accession_number', 'creator', 'culture'] as const;

/**
 * Every reason this object is not a manifest row, rather than the first one.
 *
 * Returns a list because a writer that stops at the first fault makes a 250,000-row import into a
 * quarter of a million sequential fixes. An empty array means valid.
 */
export function manifestFaults(v: unknown): string[] {
  const bad: string[] = [];
  if (typeof v !== 'object' || v === null) return ['not an object'];
  const w = v as Record<string, unknown>;

  for (const k of STRINGS) if (typeof w[k] !== 'string' || (w[k] as string).length === 0) bad.push(`${k} must be a non-empty string`);
  for (const k of MAY_BE_EMPTY) if (typeof w[k] !== 'string') bad.push(`${k} must be a string, empty if the source does not record it`);
  for (const k of NULLABLE_STRINGS) if (w[k] !== null && typeof w[k] !== 'string') bad.push(`${k} must be a string or null`);
  if (!SOURCES.includes(w.source as Source)) bad.push(`source must be one of ${SOURCES.join(', ')}`);
  if (typeof w.id === 'string' && typeof w.source === 'string' && typeof w.object_id === 'string') {
    if (w.id !== workId(w.source as Source, w.object_id)) bad.push(`id ${w.id} does not match source and object_id`);
  }

  for (const k of ['date_begin', 'date_end'] as const) {
    const d = w[k];
    // Null is the correct answer for unparseable prose, so it is allowed — but a non-integer or a
    // NaN is a parser that failed and reported success, which is the thing this guards.
    if (d !== null && (typeof d !== 'number' || !Number.isInteger(d))) bad.push(`${k} must be an integer or null`);
  }
  if (typeof w.date_begin === 'number' && typeof w.date_end === 'number' && w.date_begin > w.date_end) {
    bad.push(`date_begin ${w.date_begin} is after date_end ${w.date_end}`);
  }

  if (w.image_url !== null && (typeof w.image_url !== 'string' || !w.image_url)) bad.push('image_url must be a non-empty string or null');

  if (w.image !== null) {
    if (typeof w.image !== 'object' || w.image === null) bad.push('image must be an object or null');
    else {
      const i = w.image as Record<string, unknown>;
      if (typeof i.source_url !== 'string' || !i.source_url) bad.push('image.source_url must be a non-empty string');
      if (typeof i.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.sha256)) bad.push('image.sha256 must be 64 hex characters');
      if (typeof i.bytes !== 'number' || i.bytes <= 0) bad.push('image.bytes must be a positive number');
      for (const k of ['width', 'height'] as const) {
        if (i[k] !== null && (typeof i[k] !== 'number' || (i[k] as number) <= 0)) bad.push(`image.${k} must be a positive number or null`);
      }
    }
  }
  return bad;
}

// --- reading and writing ------------------------------------------------------------------------

/**
 * Read the whole manifest.
 *
 * `strict` throws on the first malformed row; the default reports them to the caller instead, so a
 * single bad line written by an interrupted import cannot make the entire corpus unreadable.
 */
export function readManifest(file: string, strict = false): { works: Work[]; faults: { line: number; why: string }[] } {
  if (!existsSync(file)) return { works: [], faults: [] };
  const works: Work[] = [];
  const faults: { line: number; why: string }[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      faults.push({ line: i + 1, why: `unparseable JSON: ${(e as Error).message}` });
      continue;
    }
    const bad = manifestFaults(parsed);
    if (bad.length) faults.push({ line: i + 1, why: bad.join('; ') });
    else works.push(parsed as Work);
  }
  const first = faults[0];
  if (strict && first) throw new Error(`${file}: ${faults.length} malformed rows, first at line ${first.line}: ${first.why}`);
  return { works, faults };
}

/** One row, canonical. Keys in a fixed order so a diff of the manifest is readable. */
export function manifestLine(w: Work): string {
  const bad = manifestFaults(w);
  if (bad.length) throw new Error(`refusing to write ${(w as Work).id ?? '(no id)'}: ${bad.join('; ')}`);
  return JSON.stringify({
    id: w.id,
    source: w.source,
    object_id: w.object_id,
    accession_number: w.accession_number,
    url: w.url,
    rights: w.rights,
    title: w.title,
    creator: w.creator,
    date_display: w.date_display,
    date_begin: w.date_begin,
    date_end: w.date_end,
    classification: w.classification,
    medium: w.medium,
    culture: w.culture,
    department: w.department,
    image_url: w.image_url,
    image: w.image,
    fetched_at: w.fetched_at,
  });
}

/**
 * Write the whole manifest, sorted by id, via a temporary file.
 *
 * Sorted because an unordered append-only file makes every re-import look like a total rewrite in
 * git. Via a rename because this file is the evidence: a process killed halfway through writing it
 * directly would leave a truncated manifest and no way to tell that is what happened.
 */
export function writeManifest(file: string, works: Work[]): void {
  const sorted = [...works].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, sorted.map(manifestLine).join('\n') + (sorted.length ? '\n' : ''));
  renameSync(tmp, file);
}
