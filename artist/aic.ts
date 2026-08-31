// The Art Institute of Chicago.
//
// ## The image blocker is cleared, and that is a measurement rather than an assumption
//
// This was the museum the corpus was originally meant to come from, and it was abandoned because
// every request to `www.artic.edu/iiif/2/...` returned a Cloudflare managed-challenge 403 — plain
// fetch, browser user agent, and the repo's own headless Chromium alike. That is why the fifty works
// on disk are Cleveland's.
//
// Retested 2026-08-31: metadata 200, `full/843,/0/default.jpg` 200 with `image/jpeg` and no
// `cf-mitigated` header, `info.json` 200, and a sustained burst of 23 public-domain works at one per
// second returned **23 JPEGs and zero failures**, every one verified by its `FF D8 FF` magic number
// rather than by its status code. A block that returns an HTML apology with status 200 is precisely
// the failure this source taught us to expect, so status alone is not evidence.
//
// The block was therefore transient or IP-scoped, not a policy. It may come back. The fetcher checks
// the magic number on every file for exactly that reason, and `corpus/BLOCKERS.md` records the
// original observation so that a future 403 is recognised as a recurrence rather than discovered
// from scratch.
//
// ## What this API does differently
//
// It has an `is_public_domain` boolean, which is the filter, and it wants an `AIC-User-Agent` header
// naming who is calling. The image is not a URL in the record: it is an `image_id` that has to be
// composed into a IIIF path, and the width in that path is a choice — `843,` is their own default
// viewer size and the tier that matches what the reader is shown.

import { type Work, workId } from './manifest.js';

const IIIF = 'https://www.artic.edu/iiif/2';
const SEARCH = 'https://api.artic.edu/api/v1/artworks/search';

/**
 * The fields worth asking for. Naming them matters: the default response is large, and over the
 * ~62,000 public-domain works the difference is tens of megabytes of JSON nobody reads.
 */
const FIELDS = [
  'id',
  'title',
  'artist_display',
  'date_display',
  'date_start',
  'date_end',
  'classification_title',
  'medium_display',
  'place_of_origin',
  'department_title',
  'main_reference_number',
  'is_public_domain',
  'image_id',
].join(',');

export interface AicRecord {
  id: number;
  title?: string;
  artist_display?: string;
  date_display?: string;
  date_start?: number | null;
  date_end?: number | null;
  classification_title?: string | null;
  medium_display?: string | null;
  place_of_origin?: string | null;
  department_title?: string | null;
  main_reference_number?: string;
  is_public_domain?: boolean;
  image_id?: string | null;
}

/**
 * One page of the public-domain search, optionally restricted to a range of object ids.
 *
 * The id range exists because `page * limit` is capped — measured at **1,000**, so a straight walk
 * reaches 1,000 of the 62,046 public-domain works and stops. Which 1,000 depends on the engine's
 * default ordering, which is not a property anybody chose and is not stable — a corpus built from
 * it would be "whatever Elasticsearch returned first", presented as a sample. Partitioning on id
 * instead is complete and reproducible, and every work has an id, so unlike a date partition there
 * is no null bucket quietly falling out.
 */
export function searchUrl(page: number, limit = 100, range?: { from: number; to: number }): string {
  // Always a `bool.filter`, even for the unrestricted query. The obvious form —
  // `query[term][is_public_domain]=true` plus `query[range][id][gte]=…` — is two sibling clauses
  // under one `query`, and Elasticsearch reads that as a single malformed `term` and answers 400
  // (`expected [END_OBJECT] but found [FIELD_NAME]`). Nesting both under `filter` is the shape that
  // holds however many clauses there are, so the one-clause and two-clause cases are not two
  // different URLs one of which is only exercised in a full run.
  // `sort[0]=id` is not tidiness, it is correctness. Without it the engine orders by `_score`, and
  // a filter-only query scores every document identically, so the order across pages is arbitrary
  // and unstable — a walk of one range yields some works twice and others never. Measured: a full
  // unsorted pull returned 59,042 rows containing only 57,701 distinct works, and the 1,341
  // duplicates are the visible half of the fault. Sorting makes `_score` null and the order total.
  const q = new URLSearchParams({
    'query[bool][filter][0][term][is_public_domain]': 'true',
    'sort[0]': 'id',
    fields: FIELDS,
    limit: String(limit),
    page: String(page),
  });
  if (range) {
    q.set('query[bool][filter][1][range][id][gte]', String(range.from));
    q.set('query[bool][filter][1][range][id][lte]', String(range.to));
  }
  return `${SEARCH}?${q}`;
}

/**
 * Walk the whole public-domain set by halving any id range that holds more than the cap.
 *
 * `count` is called once per range and returns that range's total; `page` fetches one page of it.
 * Splitting rather than striding because the ids are not dense — the Art Institute's public-domain
 * works are scattered across a much larger id space — so a fixed stride would either make thousands
 * of empty requests or miss a dense region.
 *
 * The cap is **1,000, not the documented 10,000**. Measured 2026-08-31: `limit=100&page=10` is 200
 * and `page=11` is 403 `"Invalid number of results"` — a refusal that arrives as the same status the
 * old Cloudflare block used, from the API rather than the CDN. A walk written to the documented
 * number does not fail early; it fails a thousand rows into a range, which is why this is a
 * constant with a measurement attached rather than a number copied from a page.
 */
export async function* walkPublicDomain(
  count: (range: { from: number; to: number }) => Promise<number>,
  page: (range: { from: number; to: number }, n: number) => Promise<AicRecord[]>,
  bounds = { from: 0, to: 300_000 },
  cap = 1_000,
): AsyncGenerator<AicRecord> {
  const queue = [bounds];
  while (queue.length) {
    const range = queue.pop() as { from: number; to: number };
    const total = await count(range);
    if (total === 0) continue;
    if (total > cap) {
      // A single id holding more than the cap cannot be split any further, and paging it would
      // silently return the first `cap` rows — the "whatever came back first, presented as a
      // sample" failure this whole partition exists to avoid. Unreachable in practice; loud anyway.
      if (range.to <= range.from) throw new Error(`id ${range.from} alone holds ${total} works, above the ${cap} cap, and cannot be split`);
      const mid = Math.floor((range.from + range.to) / 2);
      queue.push({ from: range.from, to: mid }, { from: mid + 1, to: range.to });
      continue;
    }
    for (let n = 1; n <= Math.ceil(total / 100); n++) {
      const rows = await page(range, n);
      if (!rows.length) break;
      for (const r of rows) yield r;
    }
  }
}

/** `843,` — the museum's own viewer width, and the tier the reader is actually shown. */
export function imageUrl(imageId: string): string {
  return `${IIIF}/${imageId}/full/843,/0/default.jpg`;
}

export function metadataFrom(record: AicRecord): Work | null {
  if (!record.is_public_domain || !record.image_id) return null;

  const begin = record.date_start ?? null;
  const end = record.date_end ?? null;
  const dated = typeof begin === 'number' && typeof end === 'number' && Number.isInteger(begin) && Number.isInteger(end) && begin <= end;

  return {
    id: workId('aic', record.id),
    source: 'aic',
    object_id: String(record.id),
    accession_number: record.main_reference_number ?? null,
    url: `https://www.artic.edu/artworks/${record.id}`,
    // The API's own boolean, copied rather than translated into a licence name it does not use.
    rights: 'Public Domain (is_public_domain: true — Art Institute of Chicago)',
    title: record.title ?? '(untitled)',
    creator: record.artist_display ?? null,
    date_display: record.date_display ?? '',
    date_begin: dated ? begin : null,
    date_end: dated ? end : null,
    classification: record.classification_title || '(unclassified)',
    medium: record.medium_display ?? '',
    culture: record.place_of_origin ?? null,
    department: record.department_title || '(no department)',
    image_url: imageUrl(record.image_id),
    image: null,
    fetched_at: new Date().toISOString(),
  };
}
