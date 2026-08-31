// The Metropolitan Museum of Art, imported from its published CSV rather than from its API.
//
// ## Why the CSV and not 485,000 API calls
//
// `MetObjects.csv` is the whole collection — 484,956 rows, 317MB — published by the Met itself and
// updated on a schedule. Walking the object API instead would be 484,956 requests to learn that
// 236,484 of them are not public domain, which is a day of somebody else's bandwidth spent
// discovering a fact that is already in a file they publish for exactly this purpose. So the filter
// runs over the CSV, locally, and the API is touched only for the works that survive selection —
// and only because the CSV has **no image URL column at all** (`Link Resource` is the human record
// page). That is the one thing the API is needed for.
//
// ## What the CSV does that a naive reader gets wrong
//
// **Quoted fields contain commas and newlines.** A title is `"Fragment, possibly from a sleeve"` and
// a credit line runs to several lines. Splitting on `,` produces plausible-looking garbage: it
// silently shifts every later column, so `Classification` reads a date and `Object ID` reads a
// department, and nothing throws. Hence the character-by-character parser below rather than a regex.
//
// **`Classification` is pipe-delimited multi-value** — `Photographs|Ephemera`, `Books|Prints|Ornament
// & Architecture`. Kept verbatim here and split by whoever is bucketing, because collapsing to the
// first segment at import time throws away the fact that the object is also ephemera.
//
// **32,538 public-domain rows (13%) have an empty `Classification`.** Measured, not estimated. They
// are given the `Object Name` instead of being silently dropped: a corpus that quietly excludes an
// eighth of the Met is not the corpus anybody thinks they selected from.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { type Work, workId } from './manifest.js';

/**
 * The Met's open-access grant, which is stated for the collection rather than per row.
 *
 * This is the one place a rights string is not copied from a field, and it is worth being explicit
 * about why that is not the inference the manifest forbids. The forbidden move is guessing a licence
 * from a date or a department — a per-object judgement nobody made. This is different: the Met
 * publishes a single policy saying that every object flagged `Is Public Domain` is released CC0, and
 * the flag is copied verbatim. The string records both halves so that a reader can see which is
 * which rather than having to trust that a bare "CC0" came from somewhere.
 */
const MET_RIGHTS = 'CC0 (Is Public Domain: True — The Metropolitan Museum of Art Open Access)';

/**
 * RFC4180, streamed, one row at a time.
 *
 * Streamed because the file is 317MB and reading it into a string to `.split('\n')` costs more than
 * a gigabyte of heap for a job whose whole point is to be cheap. One row at a time because the
 * caller filters 484,956 down to 248,472 and there is no reason for the rejected 236,484 to exist
 * simultaneously.
 */
export async function* csvRows(file: string): AsyncGenerator<Record<string, string>> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY });
  let header: string[] | null = null;
  // A quoted field may contain newlines, so a physical line is not a record. `carry` holds the part
  // of a record read so far when the line ended inside quotes.
  let carry = '';
  for await (const line of rl) {
    const text = carry ? `${carry}\n${line}` : line;
    const fields = parseRecord(text);
    if (fields === null) {
      carry = text;
      continue;
    }
    carry = '';
    if (!header) {
      // The file is UTF-8 with a BOM, and a BOM welded to the first column name means every lookup
      // of `Object Number` silently misses.
      header = fields.map((f, i) => (i === 0 ? f.replace(/^\uFEFF/, '') : f));
      continue;
    }
    const row: Record<string, string> = {};
    for (const [i, name] of header.entries()) row[name] = fields[i] ?? '';
    yield row;
  }
}

/** One record's fields, or null if the record is unterminated because a quoted field ran on. */
function parseRecord(text: string): string[] | null {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else field += c;
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/**
 * One CSV row as a manifest row, or null if this corpus may not hold it.
 *
 * `image_url` is null on purpose and is not an omission: the CSV does not carry one, and resolving
 * it costs an API call per object. That call is made after selection, for the twenty thousand works
 * that were chosen, rather than before it for the quarter of a million that were not.
 */
export function metadataFrom(row: Record<string, string>): Work | null {
  if (row['Is Public Domain'] !== 'True') return null;
  const objectId = row['Object ID']?.trim();
  if (!objectId) return null;

  const begin = Number(row['Object Begin Date']);
  const end = Number(row['Object End Date']);
  // Measured over all 248,472 public-domain rows: every one parses as a number, but **147 have
  // `begin > end`** — met-107853 is `"1800–1875"` with the two columns inverted. So the guard that
  // earns its place is not the NaN check, it is `begin <= end`; those 147 become `null`, which is
  // the honest answer, rather than a band that runs backwards and would be sampled against.
  const dated = Number.isInteger(begin) && Number.isInteger(end) && begin <= end;

  // 32,538 rows have no Classification. `Object Name` is the Met's own word for the same thing at a
  // finer grain ("Vase", "Fragment"), and it is a better bucket key than a shared "(unclassified)".
  const classification = row.Classification?.trim() || row['Object Name']?.trim() || '(unclassified)';

  return {
    id: workId('met', objectId),
    source: 'met',
    object_id: objectId,
    accession_number: row['Object Number']?.trim() || null,
    url: row['Link Resource']?.trim() || `https://www.metmuseum.org/art/collection/search/${objectId}`,
    rights: MET_RIGHTS,
    title: row.Title?.trim() || '(untitled)',
    creator: row['Artist Display Name']?.trim() || null,
    date_display: row['Object Date']?.trim() || '',
    date_begin: dated ? begin : null,
    date_end: dated ? end : null,
    classification,
    medium: row.Medium?.trim() || '',
    culture: row.Culture?.trim() || null,
    department: row.Department?.trim() || '(no department)',
    image_url: null,
    image: null,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * The one thing the CSV cannot answer: where the picture is.
 *
 * `primaryImageSmall` rather than `primaryImage` — the large one is the print master, which is tens
 * of megabytes to be downsampled before it ever reaches a model. Returns null rather than throwing
 * when a public-domain object simply has no image, which is common and is not an error.
 */
export async function resolveImageUrl(objectId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const res = await fetcher(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`, {
    headers: { accept: 'application/json', 'user-agent': 'kusama-corpus/0.2 (research; deriving lineage elements from open-access works)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`the Met answered ${res.status} for object ${objectId}`);
  const body = (await res.json()) as { primaryImageSmall?: string; primaryImage?: string };
  return body.primaryImageSmall || body.primaryImage || null;
}
