# Blockers, and what became of them

A source that refuses is a fact about the source, not a fact about the code, and it changes without
telling anybody. This file exists so a future 403 is recognised as a recurrence rather than
discovered from scratch and treated as a new bug.

## AIC images: Cloudflare managed challenge — CLEARED, with a residue

**Observed (before 2026-08-31).** Every request to `www.artic.edu/iiif/2/...` returned a Cloudflare
managed-challenge 403 — plain `fetch`, a browser user agent, and the repo's own headless Chromium
alike. This is why the corpus was originally built entirely from Cleveland.

**Retested 2026-08-31.** Metadata 200; `full/843,/0/default.jpg` 200 with `image/jpeg` and no
`cf-mitigated` header; `info.json` 200. A sustained burst of 23 works returned 23 JPEGs and zero
failures. A random 200-work sample (see `size-report.md`) returned **198 verified JPEGs and 2 HTTP
403s** with a 3,417-byte non-JPEG body.

**Status: cleared, ~1% residual.** The blanket block is gone. The 403s that remain are sparse and
did not correlate with anything visible in the sample. The fetcher treats them as retryable and
records anything that survives retry in `corpus/failures.jsonl`, so the residue is measured rather
than absorbed.

**Why status is not the test.** A block that returns an HTML apology with status 200 is precisely
what this source taught us to expect. Every image is therefore checked for the JPEG magic number
`FF D8 FF` before its hash is written, and a file that fails is not written at all.

**If it comes back.** It was IP-scoped or transient once. If a run starts returning 403 on nearly
every image, that is a recurrence and not a code change: fall back to metadata-only rows (`image:
null` is a legitimate manifest state, and `image_url` is still recorded so the pull can resume) and
email `engineering@artic.edu` — their API terms invite research use and the block appears to be
infrastructure rather than policy.

## AIC search: `page * limit` capped at 1,000, and the refusal is a 403

**Observed 2026-08-31.** `limit=100&page=10` is 200; `page=11` is **403** with
`{"error":"Invalid number of results"}`. The commonly cited cap for this API is 10,000; the measured
one is 1,000.

Two things make this worth writing down. The refusal arrives as **the same status as the image
block**, from the API rather than the CDN, so "AIC is 403ing" is ambiguous until the body is read.
And a walk written to 10,000 does not fail at the first request — it fails a thousand rows into a
range, after the run looks healthy.

**Handled.** `walkPublicDomain` in `artist/aic.ts` partitions the id space and halves any range
holding more than 1,000, so no single query ever reaches the cap. All 62,046 public-domain works are
reachable.

## AIC search: `query[term]` and `query[range]` cannot be siblings

**Observed 2026-08-31.** `query[term][is_public_domain]=true` alone is fine, and
`query[range][id][gte]=…` alone is fine, but both under one `query` is a **400**:
`parsing_exception … [term] malformed query, expected [END_OBJECT] but found [FIELD_NAME]`.
Elasticsearch reads the pair as one malformed `term` clause.

**Handled.** `searchUrl` always emits `query[bool][filter][n]…`, including for the single-clause
case, so the one-clause and two-clause URLs are the same shape and neither is exercised only in a
full run.

## Met: no image URL in the CSV

Not a blocker, but the same class of surprise. `MetObjects.csv` has no image column at all — a row
being public domain says nothing about whether an image exists. `primaryImageSmall` needs one object
API call per work, so the Met pipeline is: filter the whole CSV offline, select, then resolve image
URLs for the selected works only. Manifest rows from the Met therefore carry `image_url: null` until
that resolution step runs.
