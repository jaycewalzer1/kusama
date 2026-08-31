# How big is this, measured

Measured 2026-08-31, before any bulk pull. The point of this document is that nothing here is an
estimate from a specification: every number below came from bytes that actually arrived, or from a
size the museum itself reports. The threshold set before measuring was **abort and drop a resolution
tier if 30,000 works exceeds 60GB**. It does not, on any source, so the tier stays.

## Method

| Source | Tier | How | n |
| --- | --- | --- | --- |
| CMA | `images.web` | `images.web.filesize` is in the metadata, so all 41,511 CC0 records were measured from ~42 metadata requests and **zero downloads** | 40,989 of 41,511 (522 records omit the field) |
| AIC | IIIF `full/843,` | downloaded | 200 sampled, 198 arrived |
| Met | `primaryImageSmall` | downloaded | 200 sampled |

The AIC and Met samples are **random** — random pages of the search, then a random row from each
page — under a fixed seed (`20260831`) so the draw is reproducible. This is not a formality. The
earlier AIC reconnaissance took the unpaginated default order and drew 17 coins out of 23 works; its
mean was about a third of what real works run. An unrepresentative sample is worse than no sample,
because it produces a number people then quote.

Every downloaded file was checked for a JPEG/PNG magic number rather than for a 200 status.

## Measured bytes per image

| Source | mean | median | p95 | max |
| --- | --- | --- | --- | --- |
| CMA `web` | 356KB | 288KB | 856KB | 1.24MB |
| AIC `843,` | 274KB | 228KB | 624KB | 973KB |
| Met `primaryImageSmall` | 100KB | 88KB | 246KB | 364KB |

The distributions are right-skewed on all three — the p95 is roughly 2.4-3x the median — so a
mean-based projection is the conservative one and is what is used below.

## Projected total, at the mean

| Source | 10,000 | 30,000 | 100,000 | whole open-access set |
| --- | --- | --- | --- | --- |
| CMA | 3.6GB | 10.7GB | 35.6GB | **14.6GB** (all 41,511, exact — this is a sum, not a projection) |
| AIC | 2.7GB | 8.2GB | 27.4GB | ~17GB (62,046) |
| Met | 1.0GB | 3.0GB | 10.0GB | ~24GB (248,472) |

A 30,000-work corpus drawn across all three lands between 3GB and 10.7GB depending on the mix —
against a 60GB threshold. **No resolution downgrade.**

## What the tiers actually are, and why not a larger one

- **CMA `web`.** Measured across all 41,511 records the longest edge has a median of 900px, a p95 of
  1263px, and a **maximum of 1263px** — the tier is capped, not merely usually small. The `print`
  tier above it is uncapped and would be several times the size for pictures nobody is printing.
- **AIC `full/843,`.** 843px is the museum's own viewer width — the size a reader is actually shown.
  The IIIF endpoint will serve `full/full/` and it is much larger.
- **Met `primaryImageSmall`.** The Met's own thumbnail-plus tier. `primaryImage` is the full
  original and is frequently 5-20MB, which is the one tier here that would blow the threshold: at
  30,000 works it is plausibly 200-400GB.

These are the sizes a person looks at. The readings are made from the same bytes the manifest hashes,
so the tier is part of the evidence and changing it later invalidates every reading made before the
change.

## Two things the measurement found that the plan did not predict

**The AIC image blocker is residual, not cleared.** 198 of 200 random samples returned verified
JPEGs; **2 returned HTTP 403 with a 3,417-byte non-JPEG body**. The original abandonment of AIC was
a blanket Cloudflare managed challenge, and that is gone — but a ~1% rate survives it. This is
exactly the failure mode the magic-number check exists for, since a block that answers with an HTML
apology can carry any status it likes. Recorded in `corpus/BLOCKERS.md`.

**Disk was never the binding constraint.** At these sizes the pixels are free. The cost that
actually bounds the corpus is the blind reading: two vision calls a work, about $0.011 each, so
20,000 works is roughly $220-$300 — and both providers are out of credit as of today. The ingest is
built to run to completion anyway, because metadata and pixels are bandwidth and the readings are
the only part that needs a model.

## Reproducing this

The CMA figure re-derives from the API in about a minute. The AIC and Met samples are downloads and
take roughly 25 minutes for the pair at the pause rates used. The raw sample output is not tracked —
it is 400 rows of byte counts, and the summary above is the whole of what it says.
