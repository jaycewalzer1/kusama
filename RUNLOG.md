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

## 2026-08-31 (later) — the pixels, and a map that grades itself

- Two commits: `24b4dec` measured image dimensions and the IIIF upscale fix, `0bcebdd` the atlas,
  `6925dc3` the Art Institute finished and the two ingest documents corrected.
  **553 tests / 0 fail, 11 goldens**, recounted after `rm -rf dist`.
- **The Art Institute's residual 403s were never Cloudflare.** They had been written up as CDN
  residue for a day — a 403 from a host that had genuinely blocked us before is a very easy thing to
  stop investigating. What settled it cost one request: `full/400,/0/default.jpg` returns **200** on
  the same image id in the same second that `full/843,` returns 403. A block does not care about the
  size in the path. `info.json` then said it plainly — `"width":770,"height":779` — and 843 is the
  Art Institute's own viewer width, so it is an *upscale* for every work narrower than itself, and
  the IIIF spec permits a server to decline to enlarge. Asking for `full/!843,843` (fit inside, never
  enlarge) **only after 843 has been refused** recovered **203 of 203**. The general form is worth
  keeping: *a status code is not a diagnosis; ask the same host for something slightly different.*
- Pixels now: **aic 6,817/6,817, cma 3,183/3,183, met 64/10,000.** The Met's object API serves an
  **Imperva** challenge (not Akamai, as first written) after roughly two hundred requests, for our
  user agent, a browser user agent and no user agent alike — so it is the address, not the headers.
  Probes five minutes apart return 200 forever, which is exactly why this looks repeatedly like it
  has lifted. Later measured precisely: 637 consecutive 403s in one 5m36s window, then a **200 six
  minutes and thirty-six seconds after the last request**. A cooldown, not a ban — and the run that
  tripped it was at ~2.5 req/s against a documented 80 req/s, **32x under the published limit**, so
  the throttle is on sustained volume and slowing down would never have fixed it.
- Every fetched row now carries `image.width`/`height` **measured from the JPEG's own SOF marker**.
  That is a measurement of the bytes we hashed, not a claim about the work, which is the only reason
  it is allowed into a file whose rule is that facts are copied and never invented. The marker is
  found by **walking the segment chain**, never by scanning for `FF C0` — that byte pair occurs
  constantly inside entropy-coded scan data, and there is now a fixture with a decoy in it that a
  scanning parser reports as 500x600 and a walking one reports as 200x100.
- **`artist/atlas.ts` + `corpus atlas`** lays all 20,000 works out in two dimensions from metadata
  alone: 91 columns, PCA by power iteration, no new dependency, about three seconds, no model.
  It reports **40.8x chance** on k-neighbourhood preservation, so the neighbourhoods on it are real —
  and then it says the more useful thing, which is what the axes are made of. **Both axes are museum
  identity**, and `file:have-pixels` loads on the first axis about as heavily as `source:met`. A large
  part of the strongest structure in our corpus is an artefact of the Met download not having
  happened. Finishing that download is not housekeeping; it removes a confound the map found.
- The viewer is `corpus/atlas.html`, one self-contained file, and the verdict and the axis loadings
  are printed **above** the plot. A scatter plot is read in a second and its caveats are read never.
  It is not the notebook that was asked for because there is no numpy, matplotlib or jupyter on this
  machine and no shell to install them with; a notebook that cannot be executed is a picture of an
  analysis rather than one.
- **The Met half exists after all, and the museum supplied it itself.** The object API is the only
  live route to `primaryImageSmall`, and it is blocked; but the Met also publishes the same columns
  as a parquet dump, which is a file download and therefore not rate-anything. Scanning 259,874 rows
  resolved **9,956 of our 10,000** selected works (99.6%). Taking a fact from a second source is only
  allowed if the two sources agree, and they do: the 64 works resolved through the live API before
  the block came down are the control, and **all 64 URLs match exactly, 0 differ**. That check is not
  in a scratch script — it is `corpus met-urls <file>`, it runs against the manifest, and it refuses
  to write anything at all if a single URL disagrees. `--write` is a separate flag so a person reads
  the comparison once before ten thousand rows change.
- `images.metmuseum.org` is a plain CDN and was never the thing blocking us; only
  `collectionapi.metmuseum.org` was. The download runs past two hundred works without a single 403,
  which is the number at which the object API had failed twice.
- **The corpus is 99.4% complete: 19,889 of 20,000 works have their pixels.** The Met download ran
  9,925 works in 4,904s at a steady 2.0/s with **zero 403s** — past two hundred, which is the count
  at which the object API had failed twice — and 84 failures, every one a 404 for a URL the dump
  lists and the CDN no longer serves. The 111 works with no pixels are a fact about those works.
- **19,807 files hold 19,889 images and nothing is missing** (every hash a row claims is on disk).
  The gap is the content-addressed store working: 98 rows share bytes with another row, because a
  museum that photographs a knife and its fork together files one photograph against both catalogue
  records. That is worth knowing before anyone computes similarities over these images and reports a
  1.0 as a discovery.
- **The atlas confirmed its own criticism.** Before the Met arrived, `file:have-pixels` loaded on the
  first axis at 0.45, as heavily as `source:met` itself — a large part of the strongest structure in
  the corpus was the download not having happened. Re-run on the complete corpus it falls to **0.14**.
  The axes are now cleanly what the map always said they were, museum identity, and nothing else.
  Preservation is 34.0x chance over 20,000 works. The confound was real, it was named before it was
  fixed, and fixing it moved the number in the direction the criticism predicted.
- **CLIP needs no credit.** `artist/resemblance.ts` in the unmerged `artmine-recs` worktree runs on
  `onnxruntime-node` against a local ONNX CLIP; verified end to end tonight while both providers are
  still out of credit. It is not yet usable on this corpus: it reads the pre-manifest `corpus/works/`
  layout, and its baseline is all-pairs, which is 1,225 pairs at 50 works and 200 million at 20,000.
- **The whole corpus is embedded, and the catalogue turned out not to be what the pictures say.**
  `resemblance()` still does not scale, but `embed()` does not need it — it takes an absolute path
  and never touches `ROOT`, so it can be driven from the worktree against the main tree's images.
  19,807 distinct images, 27.4/s, twelve minutes, **zero failures**, into `corpus/clip.f32` (19,807 x
  512 float32, sha256 order, gitignored, 40.6MB). The scripts are `artist/clip-{embed,compare}.mjs`
  on the worktree branch, because `.models/` and `corpus/images/` are both gitignored and no single
  working directory holds the encoder and the corpus at once.

  The result is the one the metadata atlas asked for. That map scored 34x chance and then admitted
  both its axes were museum identity — it had largely learnt which of three institutions catalogued
  a thing. Over 1,500 works sampled by stride: **a work's 20 nearest by metadata are 93.6% from the
  same museum against 39.0% by chance; its 20 nearest by appearance are 55.4%.** CLIP has never seen
  the catalogue, and its neighbourhoods cross the wall the catalogue could not. The two maps share
  only 1.50 of 20 neighbours (5.6x chance), which is the honest reading — they measure different
  things, and the second one was the one missing.

  One pair in 1,124,250 exceeds 0.98 cosine, and it is `met-544757` against `met-591595`: two
  catalogue rows on one sha256. The near-duplicate hazard written down earlier fired exactly once,
  and was already explained before it fired.
- **A subagent's corpus totals were wrong by 2x, and re-counting caught it.** It reported
  `corpus/images/` at 9,846 files / 2.3GB; it is 19,807 / 3.0GB, so every per-image total it derived
  was half the truth. Its code reading was accurate and its arithmetic was not.
- **1,300 lines of ArtMine work were untracked.** The worktree tip was the *base* snapshot, not the
  work: `resemblance.ts`, `holdout.ts`, `warrant.ts`, `evidence.ts` and four test files were all
  `??`, one checkout from gone. Committed as `625224e`. A branch name in a note is not evidence that
  anything is saved.

## 2026-08-31 (after the shutdown) — master was broken, and a second map

- **`master` was shipping a tree that could not run its own tests.** `ac9624e` removed
  `aesthetic/deliverables/` from the index without removing the code that loads it. A clean checkout
  of HEAD typechecks with 0 errors and then fails 34 tests on `ENOENT ... scandir
  'aesthetic/deliverables'`: **526 tests / 492 pass / 34 fail**. The working tree was 553/0 the whole
  time, so nothing local ever said so. The fix was the other half of the change, uncommitted, left by
  an agent the shutdown killed — one `git checkout` from gone, the same failure mode as the ArtMine
  work earlier the same day. Committed as `aced259`, with `envelope.ts` and `pass.ts` in the same set
  because `studio/artist.ts` imports both and the tree does not compile without them. The damage had
  not reached the remote. **A green `npm test` in your working directory is not a claim about HEAD.**
- **`corpus atlas --clip [--umap]` — the map of what the works look like.** 19,889 of 20,000 works,
  joined to `clip.f32` by sha256 rather than by row, dropping the works with no pixels rather than
  giving them a zero row that would sit at the origin and pull the first axis through itself.
- **PCA is the wrong projection for CLIP, and UMAP is the wrong projection for the catalogue.**
  Measured with the `preservation()` that was already there, over the same 1,500-work stride sample:

  | space | PCA | UMAP |
  |---|---|---|
  | catalogue metadata, 91 named columns | **34.0x** chance | 26.9x |
  | CLIP, 512 anonymous columns | 5.6x | **24.2x** |

  PCA collapses on CLIP because one coordinate takes 64% of the variance — a documented property of
  the encoder, not a fact about art. Both projections kept, `--umap` a flag, the choice per space.
  The convenient outcome would have been one winner; there isn't one, which is why it was measured.
- **`composition()` — what a space calls near, in words a museum wrote.** The loadings answer "what
  is this axis made of", which over 512 ordinals is `+0.69 clip:92`: true, and about nothing. So the
  question is asked from the other side, always against the chance two works from the same sample
  agree (39% for museum here — a share printed without it can be made to mean anything). Catalogue
  neighbourhoods are 93% same-museum; appearance neighbourhoods are 55%.
- **The two pages cross-link, and clicking between them *is* the result**: three clean colour blocks
  by museum, then one thoroughly mixed cloud. The link is only rendered when the other file exists,
  because a button that 404s teaches a reader that the buttons on this page do not work.
- **`worktree-artmine-recs` is merged into `master` (`faa5af4`).** Seven conflicts, and the split was
  clean once stated: the branch is right about the artist layer and stale about the corpus. It was
  built against a snapshot from before the pool/selection rebuild, so its `.gitignore`, `corpus.ts`,
  `manifest.ts` and `studio/corpus.ts` all describe `corpus/works/` and `imageUrl` — a layout that no
  longer exists. Master's side taken on all four; the branch's side taken on `studio/artist.ts` and
  the evidence `tier` in `element-derive.ts`. Verified the merge re-adds **0** files under
  `corpus/images/`, which is the thing a stale `.gitignore` could quietly have undone.
  **592 tests / 586 pass / 0 fail / 6 skipped, 11 goldens.** The 6 skips name what they need
  (`onnxruntime-node` + the 335MB encoder) rather than passing empty.
- Gained: a held-out split with a hash check (`artist holdout`), evidence tiers (`artist evidence`),
  cite-then-verify (`artist warrant`), and corpus resemblance (`artist resemblance`). `artist grid`
  now defaults to the open cells and needs `--include-held-out` to reach `many-hands` /
  `two-million-slips`. **This bumps `observationHash` and `elementPackHash`** — trajectories collected
  before it are not the same experiment.
- `artist evidence withheld` on the real pack: **100% `position`, 0% `direct`**. Nothing that grades a
  run rests on a primary source. Worth having precisely because it is unflattering.
- **The merge shipped a metric that was measuring a deleted directory, and the tests that would have
  caught it were the ones hiding it** (`82ec395`). `corpusImages()` globbed `corpus/works/*.json`,
  gone since the ingest; the branch forked before that, so on the branch it was correct. Worse: the
  six tests gated on `existsSync(corpus/works)` — *the same dead directory* — so a gate meant to say
  "no encoder installed" silently also said "no corpus", and five encoder tests reported ok while
  running nothing. **A skip condition that names one missing thing and covers two is worse than no
  test**, because the count goes up.
- Installed the encoder (hash checked against the pin: `fd6e1402…`) and `jpeg-js`, which came in with
  the merge and had never been `npm install`ed. **593 tests / 593 pass / 0 skipped**, 11 goldens.
- Two defects only visible once it ran. (1) The baseline is all pairs: 1,225 at the 50 works it was
  written for, **197,780,116** at 19,889. Sampled by stride to 1,500 = 1,124,250, never by prefix —
  the manifest is grouped by source. (2) **The corpus holds one picture twice and scored it 1.0000.**
  98 rows share a sha256; the max is what every plate is read against. One row per hash: 19,889 ->
  19,791, max 1.0000 -> **0.9685**. The predicted hazard fired exactly where it was predicted.
- Thresholds restated, not loosened. `min > 0.2` / `max < 0.95` were set over 1,225 pairs and fail
  over 1.12M **because a thousand times as many draws reach further into both tails** — an extreme of
  a million samples is a fact about the sample size, so the assertions moved to p1 and p99. Measured:
  min 0.1555, p1 0.4148, median 0.6428, p99 0.8374, max 0.9685; 2 pairs under 0.20, 10 at or over
  0.95, **none at or over 0.99**.
- First real reading, on the L2 A/B pair: `openai-withheld`'s nearest corpus work sits at the
  **44.9th** percentile of the corpus's own pairs, `condition-withheld`'s at the **87.9th**. Hub
  disclosed (`met-248517`, mean 0.7183) and neither plate matched it. Reported, never rewarded, and
  it can only be convergence — no corpus image is ever shown to the artist.
- `master` is **26 commits ahead of `origin/master`** and unpushed.
