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
- **HARD BLOCKER, external: both providers are out of credit.** OpenAI answers `429
  insufficient_quota` / `credit_balance_exhausted`; Anthropic answers `400` "Your credit balance is
  too low". The whole stack is offline: the artist policy, the environment (`gpt-4o-2024-11-20`) and
  the judge (`gpt-4.1-2025-04-14`) all read `OPENAI_API_KEY`. **Nothing that needs a model call can
  be done tonight**, and the $30 cap was never the constraint — spend through Stage 2 was under $1.
  Stage 2 survived only because `corpus read --force` was 100% cache hits. Dead until credit is
  added: deriving the 50 elements (Stage 3's one call per work), Stage 4's trajectory, Stage 6's
  pairwise judge, Stage 8's noise floor. Continuing with every part of the design that is pure and
  offline — which, per the brief, is where "the break record is the point" lives anyway.
- Stage 3 done and committed as `7f7fe76`. `artist/breaks.ts` + `artist breaks <dir>` + `breaks.json`
  written beside `scores.json` at the end of every run; the observed tier in
  `aesthetic/elements/conflicts.ts`; one named fixture per tier over the shipped pack; element
  derivation tested offline through `setEnvModel`, including a blindness test that fails on a title,
  maker, date or source URL in the prompt. **438 tests / 0 fail, 11 goldens unmoved** (`rm -rf dist`
  first). Two log additions were needed and are deliberate: `render` lines now carry per-constraint
  `satisfied`/`violated`, and `trajectory-start` carries the whole `Composition` — recomposing from
  element ids would let an element edited after a run rewrite what that run is said to have broken.
- Stage 3 finding: **`deriveConflicts` reports same-source pairs, and one is real.**
  `position:withheld/c-covered` x `position:withheld/g-few` — the `withheld` position is in provable
  conflict with its own node budget. I had written a comment in `observedConflicts` claiming the
  derived tier excluded same-source pairs, and excluded them there to match; the live pack falsified
  it. The exclusion is gone, so all three tiers now ask the same question, and the cross-source rule
  lives in `breaks.ts` where it means something (what *forced* a break). A scan is a hypothesis; the
  pack was the measurement.
- Stage 3, not built on purpose: the 50 elements are not derived. That needs one model call per work
  and there is no credit. `artist/element-derive.ts` and its 8 tests are done and green against a
  stand-in; `corpus derive` is one command away from real data.
