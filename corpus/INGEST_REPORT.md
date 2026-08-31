# Ingest report

What was built, what it measured, where the APIs disagreed with the plan, and what was deliberately
left unbuilt. Written 2026-08-31, at commit `d7a9f7a`, after the metadata is complete and before the
images are.

## The numbers

| | rows | notes |
|---|---|---|
| pool, all sources | **348,983** | `corpus/pool.jsonl`, untracked |
| — Cleveland | 41,469 | of 41,511 the API reports for `cc0=1&has_image=1` |
| — the Met | 248,472 | of 484,956 rows in `MetObjects.csv` |
| — Art Institute | 59,042 | all public-domain works with an image |
| selected | **20,000** | `corpus/manifest.jsonl`, tracked |
| — with pixels on disk | 50 | the works read in the earlier stage; the rest is the long download |

Selection: seed `20260831`, 15,526 strata, ids sha256 `18deff92377d26e0…`. Split `met 10,000 /
aic 6,817 / cma 3,183`.

Projected disk for the 20,000 at the tiers chosen (`size-report.md`): **~4.0GB**. The abort
threshold was 60GB at 30,000 works, so no resolution tier was dropped.

## Where the API contradicted the plan

Six times. Each one was a **silent** fault — the wrong answer arrived with a 200 and a plausible
shape — which is why every fix below carries a number that was measured rather than assumed.

**1. Cleveland's pagination is not a partition over time.** A straight walk of `skip=0,100,200…`
returns exactly 41,511 rows containing only **40,477 distinct ids**. The count is right and the set
is wrong: the index reorders while the walk runs, so some works are served twice and others are
never served. Repeating the walk added **zero** — it slides past the same records. Checked and
rejected: `sort` is silently ignored, `orderby=id` returns a total of 0, and
`orderby=accession_number_sortable` is accepted but ties break arbitrarily so adjacent windows still
disagree. What was *not* wrong: two pages of 100 against one page of 200 over the same span are
identical sets, so the paging is clean at an instant and only drifts across a run. Fix: department
is an exact partition (the 21 departments sum to 41,511, missing 0), and a short department is
re-walked. First sweep 40,865; one re-sweep of the three short departments recovered 319 of 646; a
second recovered 0, so the loop stops. Final 41,446 this run, 41,469 cumulative.

**2. Cleveland publishes records matching `has_image=1` that carry no image object.** 42 of them.
They are the whole of the residual gap and they are reported, not rounded away.

**3. The Art Institute's search is `_score`-ordered unless told otherwise.** A filter-only
Elasticsearch query scores every document identically, so page order is arbitrary between requests.
Measured: a full unsorted pull returned **59,042 rows containing 57,701 distinct works** — and the
1,341 duplicates were the visible half of the fault; the same number were being missed. Fixed with
`sort[0]=id`, after which `_score` comes back `null` and a re-pull added exactly 1,341.

**4. The Art Institute's result cap is 1,000, not the documented 10,000.** Page 10 of a 100-row
query returns 200 rows; page 11 returns **403 `{"error":"Invalid number of results"}`**. The
id-range bisection now splits at 1,000, and a range that cannot be split any further throws instead
of quietly returning its first thousand.

**5. `query[term]` and `query[range]` cannot be siblings.** The obvious form —
`query[term][is_public_domain]=true&query[range][id][gte]=0` — is two clauses under one `query`, and
Elasticsearch reads the pair as a single malformed `term` and answers **400** (`expected
[END_OBJECT] but found [FIELD_NAME]`). Every query now goes through `query[bool][filter][n]`,
including the single-clause case, so both shapes are exercised by the same code path.

**6. The Met's CSV has no image URL and 147 rows have `begin > end`.** The CSV is the only sane way
in — 484,956 rows offline against 484,956 object-API calls — but it means `image_url` is null at
selection time and is resolved per work afterwards, for the ~10,000 chosen rather than the quarter
of a million not. Separately, every date parses as a number but **147 rows have the two columns
inverted** (met-107853 is `"1800–1875"` backwards). Those become `null`. The guard that earns its
place is `begin <= end`, not the NaN check.

**7. The Art Institute's residual 403s were an upscale refusal, not a block.** Written up here for a
day as Cloudflare residue: 203 of 6,817 AIC works (3.0%) refused `full/843,/0/default.jpg`. They are
works **narrower than 843 pixels**, and IIIF permits a server to decline to enlarge. `full/400,`
returns 200 on the same id in the same second, which is what ruled the CDN out. Asking for
`full/!843,843` — fit inside, never enlarge — **only after 843 has been refused** recovered all 203.
Detail in `BLOCKERS.md`.

**8. The Met IP-blocks its own object API by volume.** After roughly 200 requests to
`collectionapi.metmuseum.org/…/objects/<id>` it begins serving an Akamai bot-manager challenge with a
**403**, and it does so for our user agent, a full browser user agent, and no user-agent header at
all — so it is IP-level, not headers. Probes spaced five minutes apart keep returning 200
indefinitely, which is why this looks like it has lifted and then does not. The documented limit (80
req/s, no key) is not the limit being enforced. The CSV import is untouched; it is only the per-work
image-URL resolve that is blocked, which is the one Met step that needs the API at all.

## What the corpus honestly contains

Three things a reader should know before quoting a number off it.

**The classification cap does not bind.** Over 6,834 classifications the largest takes 367 of 20,000
— **1.8% against a ceiling of 8%**. Round-robin over 15,526 strata flattens the distribution long
before the cap is reached. The cap stays because a lopsided pool is exactly what it is for and the
fixture proves it fires; but nobody should describe it as the thing that fixed the Prints problem.
What actually binds is the source cap: the Met sits at exactly 10,000.

**The source cap is doing something arguable.** Cleveland is 11.9% of the pool and 15.9% of the
corpus; the Art Institute is 16.9% of the pool and 34.1% of the corpus. Equal weight per stratum
means a source that catalogues in finer categories gets more of the corpus, and the Art Institute
does. That is a choice, not an accident, and reversing it is one line in `artist/selection.ts`.

**Eleven works have impossible dates and they were kept.** `1824528600s BCE`, `400000s BCE`,
`14865c` — 22 works across 11 nonsense period buckets, from `date_begin` values the sources
published. The rule is that dates are copied and never invented, so these stay, and the census
prints them rather than clamping them into a plausible century. A cleaner-looking `byPeriod` would
be a `byPeriod` that had been edited.

## What was deliberately not built

- **No image resizing, thumbnailing, or format conversion.** The bytes on disk are the bytes the
  museum served, because that is what the sha256 on the manifest row is a claim about. A derivative
  pipeline would put a step between the evidence and the reading.
- **No database.** The manifest is a JSONL file that sorts and diffs, 20,000 lines and 11MB. An index
  is not needed until something asks a question that a full scan cannot answer in a second.
- **No parallel image fetching.** One request at a time per source, 250–700ms apart. It makes the
  download take most of a day. Three museums giving away their collections for free are owed that,
  and a 429 from any of them would cost more than the time it saves.
- **No retry loop.** A failure goes to `corpus/failures.jsonl` and the run continues; re-running
  `corpus images` retries exactly the rows that have no hash. Resumability already is the retry, and
  a backoff loop inside the fetcher would hide the failure rate from the summary line.
- **No Wikimedia Commons, Europeana, Rijksmuseum or Smithsonian.** Out of scope by instruction.
- **No `date` normalisation across sources, no culture vocabulary, no classification thesaurus.**
  Bucketing case-folds and that is all. Mapping `earthenware` onto `ceramic` is a curatorial claim
  and it would be invisible in the manifest afterwards.
- **The 50 existing readings were not re-run.** They are carried into the selection unconditionally,
  and works already read are never dropped to tidy a distribution.

## What is left

`corpus images` has 19,950 rows to fetch. It resumes from the manifest and the disk on every run, so
it is safe to kill and restart:

```
node dist/studio/corpus.js images          # or: npm run corpus -- images
node dist/studio/corpus.js verify --quick  # how many are still missing
```

Nothing after that can run yet. The blind readings are the only stage that costs money, and both
providers are out of credit.
