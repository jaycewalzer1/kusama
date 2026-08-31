# Overnight report — 2026-08-31

Eight stages were briefed. **Four shipped complete, one shipped as its offline three-quarters, two
are blocked on an external hard blocker, and one is partial.** Read §2 first — the brief asked for
the places the repo contradicted the instructions, and that section is where the night actually is.

---

## 1. What is committed

One line per commit, oldest first. `master` only; no branches were created.

| commit | what |
|---|---|
| `f749171` | **Housekeeping snapshot.** The L2-condition work that was already in the tree (24 modified + 3 new deliverables), committed before anything new started. Verified on the identical tree first: `rm -rf dist && npm test` = 379 pass / 0 fail, 11 goldens. |
| `d60b5ad` | **Stage 1.** Verbalized sampling at FIND and PROPOSE — ask for the distribution, then draw from it. |
| `78c5de0` | **Stage 2.** Fifty CC0 works imported, read blind, and probed for leakage. |
| `7f7fe76` | **Stage 3.** The break record: what broke, what forced it, and whether anyone said so first. |
| `17c3ad7` | RUNLOG, stage 3. |
| `de0b84c` | **Stage 5.** Novelty by provenance — has this combination been made before? |
| `7befd11` | **Stage 7.** The archive: finished plates filed by what they look like, not by what they scored. |
| `4992d91` | RUNLOG, stages 5 and 7. |
| `fac698e` | **Stage 6, offline.** The rated pool, and the two checks that come before any of it is a reward. |
| `bc97c2f` | RUNLOG, stage 6. |

Stage-by-stage:

- **Stage 1 — done.** `d60b5ad`.
- **Stage 2 — done, source changed under protest.** `78c5de0`. See §2.3.
- **Stage 3 — done except the derivation.** `7f7fe76`. `artist/breaks.ts`, `artist breaks <dir>`,
  `breaks.json` written beside `scores.json` at the end of every run, the observed conflict tier, one
  named fixture per tier. **The 50 elements are not derived** — that needs one model call per work.
- **Stage 4 — BLOCKED.** No credit. No trajectory, no prediction file, no break record from a run.
- **Stage 5 — done.** `de0b84c`. `artist/provenance.ts`, `artist provenance <dir>`,
  `provenance.json` per run, CSD+CSLS left as a TODO carrying the 15/91 → 4/91 numbers.
- **Stage 6 — three of four done, all the offline ones.** `fac698e`. The rating pool + CLI, the
  component-correlation gate, the Jaccard@k harness, and the both-orderings fold. **The comparator
  that would make a comparison is a model call and does not exist.**
- **Stage 7 — done, one part partial.** `7befd11`. 6×6 MAP-Elites over `out/`. §2.10.
- **Stage 8 — BLOCKED.** The noise floor is K identical trajectories.

## 1a. Test count, goldens, fresh clone

| | result |
|---|---|
| in-tree, after `rm -rf dist` | **496 tests / 0 fail** |
| goldens | **11 / 11**, both sets (`examples\|goldens/{v0,v1}`) |
| fresh clone of `master` | **496 tests / 0 fail, 11 goldens** |

Started the night at 379. The fresh-clone acceptance is real and was run:

```
git clone --branch master /Users/jaycewalzer/kusama /tmp/kusama-fresh
cd /tmp/kusama-fresh && npm install
PLAYWRIGHT_BROWSERS_PATH=/tmp/kusama-fresh/.browsers npx playwright install chromium-headless-shell
npm test        # 496 pass, 0 fail, 11 goldens
```

The middle line is required. Without it **35 tests fail, all from one cause** — `.browsers/` is
gitignored, so a fresh clone has no renderer. 20 of the 35 say so directly; the other 15 are the
cascade (no render → no `final.json` → `Cannot read properties of undefined`). The README does
document that command (line 446), so this is not a gap.

**But following the README verbatim on a fresh clone fails on its first line.** The Quickstart still
opens with `cd medium`, and `medium/` was deleted at `81089e8`. Three more stale paths in the same
document: `node assets/fonts/fetch.mjs` (twice, now `renderer/assets/fonts/`) and `node
dist/cli/golden.js` (twice, now `dist/studio/`). **Not fixed tonight** — the brief scoped the night
to features, and a README rewrite is the kind of change that should be read by the person whose
README it is. It is the cheapest item on the list below.

---

## 2. Every place the repo contradicted the instructions

The section the brief said would be the most useful. In rough order of how much it cost.

### 2.1 HARD BLOCKER: both providers are out of credit. Three stages died.

Not a repo contradiction — an external one — but it is the fact that shaped the night, so it goes
first. OpenAI answers `429 insufficient_quota` / `credit_balance_exhausted`. Anthropic answers `400`
"Your credit balance is too low". The whole stack reads `OPENAI_API_KEY`: the artist policy, the
environment (`gpt-4o-2024-11-20`) and the judge (`gpt-4.1-2025-04-14`).

**The $30 cap was never the constraint.** Spend through Stage 2 was well under $1 (§6). Stage 2
survived only because `corpus read --force` came back 100% cache hits.

Dead until credit is added: `corpus derive` (Stage 3's 50 elements, one call per work), Stage 4
entirely, Stage 6's comparator, Stage 8's noise floor.

### 2.2 `docs/KUSAMA_RESEARCH_EVIDENCE.md` does not exist

The brief names it as a source. It is not in the tree and not in git history. Proceeded from the
stage specs alone. Anything in the brief that was *only* in that document is not in this repo.

### 2.3 The Art Institute of Chicago is unreachable from this machine

Stage 2 named AIC. `api.artic.edu` answers fine — 59,042 public-domain works with images, the
structured ES query works as specified. But **every** `https://www.artic.edu/iiif/2/...` request
returns a Cloudflare managed-challenge 403: plain curl, curl with `AIC-User-Agent`, curl with a full
browser UA + Referer, and the repo's own vendored headless Chromium, which also 403s and does not
clear the challenge. Metadata without pixels cannot be read blind, so AIC cannot be the corpus.

Switched to the **Cleveland Museum of Art** open-access API. No key, explicit
`share_license_status: "CC0"` per work, `cc0=1&has_image=1` filters server-side, image URLs inline,
and `openaccess-cdn.clevelandart.org` downloads clean. The Met also works and was the runner-up; CMA
won on needing one query instead of one per object.

### 2.4 `measure.ts` has no entropy and no edge-band contact

Stage 7 said the behaviour descriptors must come from existing `measure.ts` outputs and that nothing
may be invented. Those two constraints are in tension with the descriptors the brief gestures at.
`RenderMetrics` is exactly five bounded quantities: `inkDensity`, `coverage`, `inkOffset`,
`symmetry.vertical`, `symmetry.horizontal`. **There is no entropy measure and no edge-contact
measure in this repo.** The "nothing invented" fence won: the axes are `inkDensity × inkOffset` (a
mass and a position, close to independent by construction) and a test asserts every offered
descriptor is a field of `RenderMetrics`.

### 2.5 The user's desktop build has no shell or PTY

Stage 6 asked for a keyboard-driven rating CLI. This repo's own working notes record
`startShellPty unavailable` — the person this tool is for cannot open a terminal.

Built anyway, because the brief asked, **and** given a second door: `artist rate --set <plate>
<tier>` appends the same line with no TTY, and the interactive loop detects a non-terminal stdin and
prints that command instead of hanging on a keypress that will never come. The pool is the artifact
every later judge is validated against; a rating tool that person cannot use is no rating tool.

### 2.6 `deriveConflicts` reports same-source pairs, and one of them is real

`aesthetic/elements/conflicts.ts` carried a comment claiming the derived tier excluded pairs from one
source, and `observedConflicts` excluded them to match. **The live pack falsifies the comment.**
`position:withheld/c-covered × position:withheld/g-few` is a derived conflict: the `withheld`
position is in provable conflict with its own node budget.

The exclusion is gone. All three tiers now ask the same question, and the cross-source rule lives in
`breaks.ts` where it means something — deciding what *forced* a break rather than what a conflict is.
A scan was the hypothesis; the pack was the measurement.

### 2.7 The rated pool cannot be seeded from `out/` the way the brief expects

Stage 6 says "seed the pool from existing plates in `out/`". There are **three** run directories and
only **two** have a `final.png`. Two plates is not a pool; it is also not enough to correlate
anything (§3.4). The seeding works and is tested; the constraint is that there is almost nothing to
seed it with, and that will stay true until Stage 4 can run.

### 2.8 `out/` is gitignored, so the protected A/B is untracked

As instructed: `out/condition-withheld/` and `out/openai-withheld/` are **untracked working-tree
data**, ignored via `.gitignore:14`. Neither was written to. `artist archive out` wrote
`out/archive.json` — their *parent*, also ignored — and nothing inside either directory. If this
disk is lost, the A/B is lost; it exists in no commit and on no remote.

### 2.9 An existing invariant test was scanning comments, not imports

`invariant: exactly one file in artist/ reaches the elements layer` matched the string
`aesthetic/elements/` **anywhere in the file**, so a comment saying "this copies a trick from
`aesthetic/elements/pack.ts`" counted as an import. It fired on `artist/ratings.ts`, which imports
nothing from that layer.

Now scans `from '...'`. The allow-list had already been widened twice tonight on the strength of the
old scan; both of those widenings are legitimate (verified by reading the imports), but **the
widening habit is the real finding** — a test that reports a dependency nobody has is a test that
gets widened rather than fixed.

### 2.10 "Inspectable from `studio/`" is satisfied only by the CLI

Stage 7 asked for the archive to be inspectable from `studio/`. `artist archive` lives in `studio/`,
so this is literally true and substantively partial: **there is no page in the studio console.** Left
deliberately. The console is where this repo's untested bugs live, and a grid view is not worth that
surface on an unattended night.

---

## 3. Things that smell wrong

The brief asked for metrics at exactly 0 or 1, hashes that moved, and tests that passed for reasons
I do not fully understand. **The exactly-0/1 rule fired four times tonight and was right every
time.** Every one was caught by a test or by running the thing, never by reading the code.

### 3.1 A weighted draw came back 400/400 on the heavy candidate (Stage 1)

`xorshift32` near small seeds returns nearly the same first value for seeds 1, 2 and 3, so the
verbalized-sampling draw was not sampling. Fixed with a 6-turn warm-up. The test caught it.

### 3.2 The leakage probe reported 38/50 and the true number is 31 (Stage 2)

The probe as specified is *canonical if it can name the work*, which gave **38/50**. Checked against
the museum record it was **31 right and 7 confidently wrong**. The seven are style inferences, not
memory — Reynolds named as Gainsborough, Sheeler as O'Keeffe, Petrus Christus as van der Weyden,
Duncanson as Church, Chase as Sorolla, West as Kauffman, Albert Bouts as van der Weyden. Counting
those as contamination would have thrown away 23% of the clean set using cases where the model
demonstrably did **not** know the work.

So the verdict is three flags: `claimedCanonical` (38), `canonical` (31), `misattributed` (7).

**The first fix was itself broken.** Scoring a title match on one shared word made "The
Annunciation" match a different Annunciation, "Portrait of Dora Wheeler" match "Portrait of Emilie
Ambre", and "Saint John the Baptist" match "Saint Mary Magdalene" — 34/4 instead of 31/7. Titles are
subjects and subjects repeat. A title now needs two shared words, a maker needs one. **Both wrong
versions are pinned as tests.**

### 3.3 `axisCorrelation: 0` for an axis that never moved (Stage 7)

The constant-axis guard tested a sum of squared deviations for `=== 0`. Three identical floats do not
sum to zero, because their mean is off by an ulp — `dy ≈ 9.2e-33`, the guard did not fire, and
Pearson returned `0`, which reads as *independent* when the truth is *no evidence*. Now tested on the
spread (`max - min > 1e-9`), and the function is exported so `ratings.ts` cannot grow a second copy
of the same bug.

### 3.4 The correlation gate reported a pass over zero measurable pairs (Stage 6)

Found by running `artist validate-reward out` against the real two-plate pool, ten minutes after
writing it. It printed:

```
45 component(s) over 2 rated plate(s), limit 0.8
  no pair over the limit
```

`pearson` returns null under three points, so every pair was unmeasurable and the offender list was
empty for the same reason an unasked question has no wrong answer. **A gate that passes because it
has been emptied is worse than no gate.** It now prints `NOTHING MEASURED — 2 rated plate(s) is not
enough to correlate anything. This is not a pass.`

### 3.5 Hashes that moved

`PROTOCOL_HASH` and `OBSERVATION_HASH` moved at `f749171`. **By design** — that is the L2 condition
rewrite, which changes the brief fields and the prompt section, and `envVersion` exists precisely so
that change cannot pass as the same experiment. It predates tonight's work and is recorded here only
so it is not read as new.

### 3.6 The model cache records no cost

`.cache/artist-env/` entries are `{request, value}` and carry no `usd`. **Spend for the night cannot
be reconstructed from the repo**, only estimated (§6). For a project with a dollar cap in its own
brief, that is a gap worth closing.

### 3.7 The README's Quickstart cannot be followed

`cd medium` on line 442, and `medium/` was deleted at `81089e8`. Plus `assets/fonts/fetch.mjs` ×2 and
`dist/cli/golden.js` ×2. See §1a. The whole document was presumably correct before the flattening and
nothing re-read it afterwards.

### 3.8 `corpus/` is 18 MB and tracked

Stage 2 committed 50 works, 50 content-hashed images and 50 readings. That is the right call —
readings that vanish are not evidence — but it is 18 MB in git and it will grow linearly with any
future import. Nobody has decided what the ceiling is.

---

## 4. What I deliberately did not build

Each of these is a TODO, in the code, at the place a person will be standing when they need it.

- **The pairwise comparator.** `artist/ratings.ts` header. Every part that *decides* anything is
  built and tested — `pairwise()` folds comparisons, requires both orderings, refuses a pair it has
  seen one way round, and reports `orderBias` as its own number. Making a comparison is a model call.
  The TODO names the rule that must not be lost: **submit each pair twice with the plates swapped,
  and average in `pairwise`, not in the caller.**
- **CSD embeddings + CSLS readout.** `artist/provenance.ts` header, with the numbers: raw CSD cosine
  inverts for ~25% of artists who share a tradition; CSLS at ~2.25× cost cuts the failure rate from
  15/91 to 4/91. **If that TODO is ever taken, CSLS is not optional.** Not started tonight — the
  brief's own scope fence forbids embedding models, CLIP, torch and retrieval indexes.
- **A mutation/search loop over the archive.** Explicitly out of scope for the night. The archive is
  storage and inspection. The moment it proposes a candidate it is a search, and a search needs the
  comparator that does not exist.
- **A studio page for the archive.** §2.10.
- **The 50 derived elements.** `artist/element-derive.ts` and its 8 tests are done and green against
  a stand-in; `corpus derive` is one command away from real data and no credit.
- **Any fix for the period parser.** `provenance.ts` reads four-digit years out of museum date prose,
  so "18th century" contributes nothing and the pair still reads `novel`. Reported in the note rather
  than fixed: **inventing a span is worse than admitting the gap**, and a test pins the note.
- **Any run.** Nothing model-dependent was attempted after the blocker was confirmed.
- **The README's four stale paths.** §3.7. Five minutes, and it is your document.

---

## 5. The numbers the brief asked for by name

### Canonical count (Stage 2)

```
works          50
read           50
named          38     <- claimedCanonical: it produced a title or a maker
canonical      31     <- and was right, checked against the museum record
misattributed   7     <- named confidently, and wrong. NOT contamination.
protocol       2595d0b6863a
```

Any claim resting on the 31 is reported separately by `corpus status`, which lists them by name.

### Break record contents (Stage 4)

**Blocked. There is no run, so there is no break record from one.** What exists is the machinery and
the shipped pack's conflicts, which is what a run would break against. Composing `withheld` with all
four pack elements gives **29 constraints and 15 conflicts**:

```
derived   element:chromolith-broadside/e-twelve-sizes        x position:withheld/g-few
derived   element:chromolith-broadside/e-all-the-stones      x element:rodchenko-red-black/e-two-inks
derived   position:withheld/c-covered                        x element:ma-interval/e-few-things
derived   element:chromolith-broadside/e-no-quiet-corner     x element:ma-interval/e-interval-holds
derived   element:kuba-shoowa-surface/e-many-panels          x position:withheld/g-few
derived   element:chromolith-broadside/e-twelve-sizes        x element:ma-interval/e-few-things
derived   element:chromolith-broadside/e-the-vignette        x position:withheld/g-few
derived   position:withheld/c-covered                        x position:withheld/g-few      <- §2.6
derived   element:ma-interval/e-not-filled                   x position:withheld/r-heavy
derived   element:rodchenko-red-black/e-members-under-load   x element:ma-interval/e-few-things
derived   element:chromolith-broadside/e-the-vignette        x element:ma-interval/e-few-things
derived   element:kuba-shoowa-surface/e-worked-through       x element:ma-interval/e-not-filled
derived   element:kuba-shoowa-surface/e-many-panels          x element:ma-interval/e-few-things
derived   element:rodchenko-red-black/e-members-under-load   x position:withheld/g-few
declared  element:kuba-shoowa-surface/e-worked-through       x element:ma-interval/e-interval-holds
```

Fourteen proved, one measured and cited to `docs/artist/element-preflight.md`, zero observed —
because observation requires a run. The observed tier is tested against a hand-built pair that
reaches neither of the other two, and the empty case is pinned: **`observedConflicts(c, [])` is `[]`,
and "no observed conflict" must never read as "compatible".**

---

## 6. Spend

**Under $1, and probably around $0.60–$1.20.** It cannot be stated exactly (§3.6).

| stage | spend |
|---|---|
| 1 | $0. Code and tests only; the tests drive a stand-in through `setEnvModel`. |
| 2 | **All of it.** ~125 environment calls against `gpt-4o-2024-11-20` with an image each — 50 blind readings + 50 leakage probes + retries. Estimated from cache-file mtimes since local midnight. |
| 3, 5, 6, 7 | $0. Every one is offline by construction. |
| 4, 8 | $0. Never started. |

The $30 cap was not approached and was never the binding constraint. Credit exhaustion was.

---

## 7. The one thing I would do next

**Add credit, run `corpus derive` to turn the 50 read works into 50 derived elements, then run one
trajectory with two of them named on the commission — because every artifact built tonight (the break
record, provenance, the archive, the rated pool) is a reader of a run, and there is exactly one
real run on disk for all four of them to read.**
