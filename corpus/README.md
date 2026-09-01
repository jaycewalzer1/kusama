# The corpus

Real works, fetched with their rights, read without their names. Everything the lineage elements in
`aesthetic/elements/` are derived from starts here.

## The split: what is in git and what is not

| | in git | why |
|---|---|---|
| `manifest.jsonl` | yes | one line per work. The evidence. A few hundred bytes each. |
| `readings/` | yes | the blind reading and leakage probe per work. Expensive to make, small to store. |
| `selection.json` | yes | which works were chosen, and by what deterministic rule. |
| `size-report.md`, `BLOCKERS.md` | yes | what the images cost, measured, and what each API refused. |
| `images/` | **no** | regenerable from the manifest, and 10.7GB at a 30,000-work corpus. |
| `pool.jsonl` | **no** | 347,000 candidate rows, ~160MB. A fact about three public APIs, not about this corpus. |
| `failures.jsonl` | **no** | a log of one machine's run, not a fact about the works. |

The rule is not "big things are ignored". It is that **the manifest is the part a person needs in
order to check a claim** — what the work is, who holds it, what licence it was published under, and
the sha256 of exactly the bytes that were read — and the pixels carry no evidence the manifest does
not. Measured across all 41,511 of Cleveland's CC0 records the mean `web` derivative is 356KB; at
30,000 works that is 10.7GB, which is not a thing to put in git history for a file that can be
fetched again.

The argument for tracking the manifest was that the manifest is small. `pool.jsonl` does not inherit
that argument by having a similar name — it is the whole candidate set from all three museums, and
what it would justify (what was available, and why these works were chosen out of it) is in
`selection.json`, which is tracked.

## Building it from nothing

```
npm run corpus -- metadata cma                  # ~41,500 CC0 records, about four minutes
npm run corpus -- metadata met --csv MetObjects.csv   # 248,472 public-domain rows, offline
npm run corpus -- metadata aic                  # ~59,000 public-domain records with images
npm run corpus -- select --target 20000         # stratify the pool into the manifest
npm run corpus -- met-urls <dump.json>          # Met image URLs, from the parquet not the API
npm run corpus -- images                        # the long one: fetch the pixels
npm run corpus -- verify                        # every row against the bytes on disk
npm run corpus -- read                          # the blind reading and the leakage probe
```

Each stage is resumable and each is a separate command on purpose, because they fail differently.
`metadata` is cheap and idempotent. `select` is offline and deterministic. `images` is hours of
somebody else's bandwidth. `read` is the only one that costs money.

## Looking at it

```
npm run corpus -- atlas                    # from the catalogue: PCA, and the axes have names
npm run corpus -- atlas --clip --umap      # from the pixels: CLIP embeddings, laid out by UMAP
```

Each writes a self-contained HTML file into `corpus/` — `atlas.html` and `atlas-clip.html` — with a
button in the corner to the other one. Open either in a browser; neither needs a server. Both print
how much of the layout survived the projection, against what scattering the same points at random
would give, and refuse to call a map informative below twice chance.

The two projections are both kept because which one is right was *measured* rather than assumed. On
the catalogue vectors PCA preserves **34.0x** chance and UMAP **26.9x**, so PCA wins and its axes can
still be read off as named museum fields. On the 512 CLIP dimensions PCA collapses to **5.6x** — one
anonymous coordinate takes 64% of the variance, which is a known property of CLIP and not a fact
about art — while UMAP holds **24.2x**. So: PCA for the catalogue, UMAP for the pixels.

`--clip` needs `corpus/clip.f32`, which is not in the repo. It is 19,807 x 512 float32 in sorted
sha256 order, produced locally by the CLIP ViT-B/32 vision encoder in about twelve minutes with no
API and no key, and regenerable from the images at any time.

Both pages also report what the *full* space calls near, in terms a museum recorded, because
"axis 1 is +0.69 clip:92" is a true sentence about nothing. The answer is the reason the second map
exists: a work's 20 nearest by catalogue are **93% from the same museum** against 39% by chance,
and by appearance **55%**. The first map had largely learnt which institution catalogued a thing.

`MetObjects.csv` is the Met's own published dump of the whole collection (317MB, 484,956 rows), from
`github.com/metmuseum/openaccess`. It is not kept in this repo — it is a one-time input, consumed
into `pool.jsonl`, and `--csv` takes whatever path you downloaded it to. It is filtered locally
rather than by walking the Met's object API, which would be 484,956 requests to learn that 236,484
of them are not public domain.

The CSV carries **no image URL**, and the obvious way to get one does not work. Resolving them from
`collectionapi.metmuseum.org/…/objects/<id>` dies after roughly 700 requests with an Imperva 403,
and it is not a rate problem — that run was at 2.5 req/s against a documented 80 req/s. Nor is the
URL derivable from the objectID or the accession number; 15 of a known-good 64 are photography
negative numbers with no relation to either.

What does work is the Met's *other* publication of the same fields: the `metmuseum/openaccess`
parquet dump on HuggingFace, which is a file download and so has nothing to rate-limit. Scanning it
resolved 9,956 of 10,000. `corpus met-urls <file> --write` loads them, and it first re-checks every
URL against the works that *were* resolved through the live API before the throttle — 64 of 64
exact, 0 differing — and refuses to write if a single one disagrees. A fact taken from a second
source is only worth having if the two sources agree.

## Getting the images back

A fresh clone has every manifest row and no bytes:

```
npm run corpus -- verify        # says how many are missing
npm run corpus -- images        # refetches them, one at a time, politely
npm run corpus -- verify        # says N/N present and hashing to what the manifest claims
```

`images` refetches from the `image_url` on each row and **insists the bytes hash to the sha256 the
row already carries**. A mismatch is an error, not a warning: a museum that requoted its own
derivative at a different quality would otherwise silently change what every reading was made from,
and nothing downstream could tell. `verify --quick` checks only that the files exist, for when you
want the answer in a second rather than after rehashing gigabytes.

## The manifest row

One shape regardless of which museum it came from, so that reading, deriving, selection and the
image fetcher each have one code path rather than one per source. The mapping from a museum's own
JSON or CSV happens once, at the edge, in that source's importer. The schema and its validator are
`artist/manifest.ts`.

Two fields are load-bearing rather than tidy:

- **`rights` is copied verbatim and never inferred.** Not from a date, not from a department, not
  from the fact that a sibling record was CC0. A guessed licence is worse than an absent one because
  it looks like a fact.
- **`date_begin` / `date_end` are null when the source's prose does not parse.** Never invented,
  never defaulted to a century boundary. A date band that was guessed will later be sampled against
  as though it were measured.

`image_url` and `image` are deliberately two fields. The URL is known from metadata, before anything
has been downloaded; the hash cannot exist until the bytes arrive. So `image: null` means exactly
"not fetched yet", and a non-null `image` is always a complete claim about bytes that existed.

## How the works were chosen

`selection.json` is the decision record. The pool is not a sample of art — it is the union of three
institutions' cataloguing habits, and those habits are lopsided in ways that survive into anything
taken off the top of the file. Of the Met's 248,472 public-domain rows, 32,761 are Prints and 13,054
are Drawings; paintings are 2.1%. A corpus in file order would be a corpus of European prints, and
every element derived from it would inherit that without anybody having decided it.

So `corpus select` strata on **source × classification × period**, round-robins over the strata with
equal weight, and caps any one classification at 8% of the corpus and any one source at 50%. Within
a stratum it spreads across cultures before spreading within one. Three properties make it
checkable, and `artist/selection.ts` explains each at the point it is enforced:

- **Deterministic from a seed** — no `Math.random`, no clock. The file carries a sha256 of the
  chosen ids, so a later run either reproduces it or has changed something.
- **Additive** — a work already in the manifest is carried over whatever the caps say. Readings cost
  money; dropping a work that has been read to tidy a distribution throws away evidence.
- **Nothing silently excluded** — undated works get an `(undated)` bucket, and a work with no
  classification carries the source's own object name.

`select --dry-run` prints the whole census without writing anything.

## Why the readings are blind

Every reading is made from the image and nothing else — no title, no artist, no date, no wall text.
Hand a frontier model a famous painting *with its label* and what comes back is the accumulated
critical literature on that painting, and everything derived downstream is art history rather than a
reading of a surface. The prompt therefore contains no field of the manifest row, and
`artist/tests/artist-corpus.test.ts` asserts that against the recorded request rather than trusting
this paragraph.

Blindness cannot be assumed to have worked, because famous artworks are among the most duplicated
images on the web. So each work gets one extra call — same image, separate request, no reading in
context — asking it to name the work. Works it named *correctly* are marked canonical; they stay in
the corpus and stay usable, but any claim resting on one is contaminated by the model's prior
knowledge and is reported separately. `npm run corpus -- status` prints the count.
