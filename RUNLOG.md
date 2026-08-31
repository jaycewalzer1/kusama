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
- Stage 5 done and committed as `de0b84c`. `artist/provenance.ts` + `artist provenance <dir>` +
  `provenance.json` per run. Corpus co-occurrence is three verdicts (`same-hand` / `same-period` /
  `novel`) plus a fourth non-verdict `unknown` for hand-authored elements, which is never added to
  `novel`; prior-run co-occurrence names the sibling runs. CSD+CSLS left as a TODO in the header with
  the 15/91 -> 4/91 number, because CSD alone inverts for exactly the same-tradition pairs this repo
  composes. **453 tests / 0 fail, 11 goldens.**
- Stage 5 caveat, recorded rather than smoothed: the period test parses four-digit years out of
  museum date prose, so "18th century" contributes nothing and the pair still reads `novel`. Reported
  in the note rather than fixed, because inventing a span is worse than admitting the gap. And with
  the derived set empty (no credit), every pair the shipped pack can produce is `unknown` — the
  three real verdicts are reachable only through the injected lookup, which is what the tests use and
  what the last test pins to the real disk.
- Stage 7 done and committed as `7befd11`. `artist/archive.ts` + `artist archive <runs>` +
  `archive.json`. 6x6 MAP-Elites, axes `inkDensity` x `inkOffset` from `RenderMetrics` (a test
  asserts every offered descriptor is a field of it), hard-violation gate with the rejections kept,
  no elite because there is no pairwise judge. Over `out/`: 2/2 admitted, 1/36 cells, both runs in
  the same cell — which is exactly what a same-seed A/B should look like. **467 tests / 0 fail.**
- Stage 7 finding, and it is the exactly-0 rule again: the constant-axis guard tested a sum of
  squares for `=== 0`, and three identical floats do not sum to zero because their mean is off by an
  ulp. It emitted `axisCorrelation: 0` — which reads as "independent" — for an axis that never moved.
  The test that asked for a constant axis caught it. Now tested on the spread.
- Stage 7, partial: "inspectable from `studio/`" is satisfied by the CLI, which lives in `studio/`.
  There is no page in the studio console. Left deliberately: the console is where the untested bugs
  live, and a grid view is not worth the surface tonight.
- Stage 3, not built on purpose: the 50 elements are not derived. That needs one model call per work
  and there is no credit. `artist/element-derive.ts` and its 8 tests are done and green against a
  stand-in; `corpus derive` is one command away from real data.
- Stage 6, the offline three of the four, committed as `fac698e`. `artist/ratings.ts` +
  `studio/rate.ts` + `artist rate` + `artist validate-reward`. Append-only JSONL pool at repo root
  (**not** under gitignored `out/` — it is the artifact everything else is validated against);
  `artist rate --set <plate> <tier>` exists because these notes record that the user's desktop build
  has **no PTY**, so a keyboard-only rating tool is one they cannot use. The 0.8 component-
  correlation gate throws with every offending pair named. Jaccard@5/@10/@20 and nothing aggregate.
  `pairwise()` refuses a pair seen in only one ordering and reports `orderBias` separately.
  **496 tests / 0 fail, 11 goldens** after `rm -rf dist`.
- Stage 6 finding, and it is the exactly-0 rule a fourth time, caught by running the thing rather
  than by reading it: over the real `out/` (2 plates) the gate printed `no pair over the limit` —
  across **45 components and zero measurable pairs**, because `pearson` returns null under three
  points. A gate that passes because it has been emptied is worse than no gate. It now prints
  `NOTHING MEASURED — 2 rated plate(s) is not enough to correlate anything. This is not a pass.`
- Stage 6 also found a false positive in an existing test: `invariant: exactly one file in artist/
  reaches the elements layer` scanned for the path *anywhere in the file*, so a comment saying "this
  copies a trick from `aesthetic/elements/pack.ts`" counted as an import. It now scans `from '...'`.
  The invariant had been widened twice already; at least one of those widenings should be re-checked.
- Stage 6, not built: the pairwise comparator itself. Every part that decides anything is done and
  tested — `pairwise` takes the comparisons and averages both orderings — but *making* a comparison
  is a model call. TODO is in the header of `artist/ratings.ts`, and it names the one rule that must
  not be lost: submit each pair twice with the plates swapped, and average here, not in the caller.
- Corpus ingest, Tasks 0–8, no model calls (both providers still out of credit). Four commits:
  `4c6aa23` README, `6677166`+`0ff9fc9` one manifest schema and the pixels out of git, `ac9624e` the
  measured size report, `abb6b8f` three importers into one pool, `d7a9f7a` stratified selection.
- Pool `348,983` across three museums; manifest `20,000` selected, seed `20260831`, ids sha256
  `18deff92377d26e0…`. 541 tests / 0 fail, 11 goldens on the tree that was committed.
- Six silent API faults found and each fixed against a measured number, not a guess. The pattern is
  the same every time: **the wrong answer arrived with a 200 and the right row count.** Cleveland's
  walk returned exactly 41,511 rows containing 40,477 distinct ids; the Art Institute's returned
  59,042 rows containing 57,701 distinct works. Neither errored. `distinct !== returned` is the only
  check that caught either, and it is now what the importers print. Full list in
  `corpus/INGEST_REPORT.md`; the refusals are in `corpus/BLOCKERS.md`.
- Two designs were wrong and the run said so. (1) The 8% classification cap **never binds** — over
  6,834 classifications the largest takes 367 of 20,000, 1.8%. Round-robin over 15,526 strata does
  the work; the cap is insurance, not the fix, and should not be described as the fix. (2) `Sculpture`
  and `sculpture` were two buckets: three museums are three house styles, and the split was 4,722/373
  for sculpture and 2,140/6,228 for textile. Bucketing is now case-folded; the manifest still stores
  what the museum wrote.
- Left standing, deliberately: 22 works with impossible dates (`1824528600s BCE`, `14865c`) are kept
  and printed, because a `byPeriod` with no absurdities in it would be one that had been edited.
