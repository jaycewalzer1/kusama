# Overnight run log — 2026-08-31

One line per milestone. Written as it happens.

- `f749171` snapshot: the L2-condition work committed (24 modified + 3 new deliverables). Baseline verified before the commit on the identical tree: `rm -rf dist && npm test` = 379 pass / 0 fail, 11 goldens green.
- `docs/KUSAMA_RESEARCH_EVIDENCE.md` does not exist in the repo. Proceeding from the stage specs alone.
- `out/` is gitignored (`.gitignore:14`), so `out/condition-withheld` and `out/openai-withheld` are untracked working-tree data. Not touched.
- Stage 1 done. Verbalized sampling at FIND and PROPOSE (new short call before SKETCH). 394 tests / 0 fail, 11 goldens. Found: xorshift32 near small seeds returns nearly the same first value for seeds 1/2/3 — a weighted draw came back 400/400 on the heavy candidate. Fixed with a 6-turn warm-up; the test caught it, not inspection.
- Stage 2, source changed under protest and recorded: **the Art Institute of Chicago image host is unreachable from here.** `api.artic.edu` answers fine (59,042 public-domain works with images, structured ES query as specified), but every `https://www.artic.edu/iiif/2/...` request returns a Cloudflare managed-challenge 403 — plain curl, curl with `AIC-User-Agent`, curl with a full browser UA + Referer, and the repo's own vendored headless Chromium (which also 403s and does not clear the challenge). Metadata without pixels cannot be read blind, so AIC cannot be the corpus. Switched to the **Cleveland Museum of Art** open-access API: no key, explicit `share_license_status: "CC0"` per work, `cc0=1&has_image=1` filters server-side, image URLs returned inline, and `openaccess-cdn.clevelandart.org` downloads clean. The Met was the other candidate and also works; CMA won on one query instead of one per object.
- Stage 2 done. 50 CC0 works in `corpus/` (works + content-hashed images + readings), each read blind and probed for leakage under one protocol hash. 407 tests / 0 fail, 11 goldens.
- Stage 2 finding, and it is the "a metric is broken until proven otherwise" rule paying for itself twice.
  The probe as specified — *canonical if it can name the work* — reported **38/50**. Checked against
  the record it was **31 right, 7 confidently wrong**. The seven wrong ones are style inferences, not
  memory: Reynolds named as Gainsborough, Sheeler as O'Keeffe, Petrus Christus as van der Weyden,
  Duncanson as Church, Chase as Sorolla, West as Kauffman, Albert Bouts as van der Weyden. Counting
  those as contamination would have shrunk the clean set by 23% using cases where the model
  demonstrably did *not* know the work. So the verdict is three flags now: `claimedCanonical` (38),
  `canonical` (31), `misattributed` (7). **The first version of the fix was itself broken**: scoring a
  title match on one shared word made "The Annunciation" match a different Annunciation, "Portrait of
  Dora Wheeler" match "Portrait of Emilie Ambre", and "Saint John the Baptist" match "Saint Mary
  Magdalene" — 34/4 instead of 31/7. Titles are subjects and subjects repeat, so a title now needs two
  shared words and a maker needs one. Both wrong versions are pinned as tests.
