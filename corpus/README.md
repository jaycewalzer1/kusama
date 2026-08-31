# The corpus

Real works, fetched with their rights, read without their names. Everything the lineage elements in
`aesthetic/elements/` are derived from starts here.

## The split: what is in git and what is not

| | in git | why |
|---|---|---|
| `manifest.jsonl` | yes | one line per work. The evidence. A few hundred bytes each. |
| `readings/` | yes | the blind reading and leakage probe per work. Expensive to make, small to store. |
| `selection.json` | yes | which works were chosen, and by what deterministic rule. |
| `images/` | **no** | regenerable from the manifest, and 10.7GB at a 30,000-work corpus. |
| `failures.jsonl`, `import-failures.jsonl` | **no** | a log of one machine's run, not a fact about the works. |

The rule is not "big things are ignored". It is that **the manifest is the part a person needs in
order to check a claim** — what the work is, who holds it, what licence it was published under, and
the sha256 of exactly the bytes that were read — and the pixels carry no evidence the manifest does
not. Measured across all 41,511 of Cleveland's CC0 records the mean `web` derivative is 356KB; at
30,000 works that is 10.7GB, which is not a thing to put in git history for a file that can be
fetched again.

## Getting the images back

A fresh clone has every manifest row and no bytes:

```
npm run corpus -- verify        # says how many are missing
npm run corpus -- images        # refetches them, one at a time, politely
npm run corpus -- verify        # says 50/50 present and hashing to what the manifest claims
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
