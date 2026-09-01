# Thursday

Five commands and a folder of HTML. Every one of them runs with **no model call and no network** —
both API providers are out of credit, and nothing here needs them.

Read §0 first. It is the part that will bite.

---

## 0. What this machine has that a clone does not

The corpus is 20,000 works from three museums. What is **tracked in git** is the evidence:
`corpus/manifest.jsonl` (20,000 rows, one per work, each with a sha256 and a refetchable
`image_url`), `corpus/readings/`, and `aesthetic/influences/*.resolved.json`.

What is **not** tracked is everything derived from it, because it is large and reproducible:

| on this machine | size | rebuilt by | cost |
|---|---|---|---|
| `corpus/images/` | 3.0 GB | `npm run corpus -- images` | hours, and it is 19,889 HTTP fetches |
| `.models/` (CLIP image + text towers) | 594 MB | first run of any embedding command | one download |
| `corpus/clip.f32` + `clip-index.json` | 39 MB | `npm run corpus -- embed` | 12 min |
| `corpus/analytics/` | 70 MB | `npm run corpus -- export-analytics` | 132 s |
| `.browsers/` (hermetic Chromium) | 478 MB | `PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright install chromium` | one download |
| `corpus/atlas-clip.html` | 3 MB | `npm run corpus -- atlas --clip --umap` | 53 s |
| `docs/demo/influences/*.html` | 97 MB | `npm run corpus -- influences show <id> --sheet` | ~1.4 s each |
| `out/condition-withheld`, `out/openai-withheld`, `out/first-withheld` | — | a model run | **not reproducible — no credit** |

**Demo on this machine.** A fresh clone would need the pixels and the embeddings before four of the
five commands below say anything, and the three trajectories in `out/` exist nowhere else — they are
untracked, gitignored, and on no remote. If the laptop is not the laptop, the fallback is §6: the
pre-rendered HTML, which is tracked and needs nothing.

Build once at the start of the day, then call `node` directly — `npm run corpus --` re-runs `tsc`
(1.8 s) before every command.

```bash
cd ~/kusama
npm run build            # 1.8s
```

---

## 1. A phrase reaches the corpus — 0.4 s

```bash
node dist/studio/corpus.js search "a woodcut print of a wave" -k 5
```

CLIP's text tower encodes the phrase; the corpus's 19,791 distinct images were encoded by the image
tower of the **same checkpoint**. Both land in the same 512-d space, so a sentence can be compared to
a photograph.

What comes back, and what to say about it:

```
  0.3179   4.07   99.99  aic-88398     woodcut | The Girls on the Bridge
```

Read **the z and the percentile, not the cosine**. Cosines here are against this query's own
distribution over the whole corpus (mean 0.1642, sd 0.0378). A raw cosine of 0.32 sounds low and is
in fact the 99.99th percentile.

The command also prints museum crossing — for this query, 60% of hits are the Art Institute against
34.3% of the corpus, and 0% are the Met against 49.6%. That is a real skew and it is printed on
purpose.

**The claim this supports:** the retrieval gate is P@10 **54.8% against 2.0% chance** (27x) at
finding a work from its own title among 19,791 candidates; P@1 **20.4% against 0.2%** (102x).

**The claim it does not support:** that CLIP understands these works. Retrieval was measured on
titles, and a museum title is catalogue prose, not a description of the picture. "Fragment" appears
hundreds of times.

---

## 2. An artist's background, as 48 corpus works — 1.3 s

```bash
node dist/studio/corpus.js influences show withheld --sheet
open docs/demo/influences/withheld.html
```

A position document (`aesthetic/positions/withheld.json`) names a `lineage`, a `worldview` and a set
of `commitments`. Each of those strings becomes a query — the lineage refs as written, the worldview
split into sentences, each commitment's `why` — run through the text tower **verbatim, with no
interpretation** (`aesthetic/influences/withheld.json` is that query list, tracked). What comes back
is a weighted set of 48 corpus works. That set is the artist's
background expressed in the only vocabulary the corpus has.

The command then walks the set's own principal axes out to the corpus's hull, so each axis gets a
label made of real works rather than a number:

```
  axis 0 — 27.5% of the set's variance — calligraphy -> furniture; aic -> met
```

The `--sheet` writes a contact sheet plus a **self-contained HTML** — the 1.8 MB PNG is inlined as a
data URI, so the file opens with no server and can be sent on its own.

**Say:** the position is now a region of the corpus, and the region is inspectable.

**Do not say** that the seven positions are distinguishable by their statistics. They are not, and
the report says so: same-museum share across all seven runs 36.5–41.8% against a **39.0% chance**
baseline — `NOTHING MEASURED`. Classification entropy is inside the chance band for two of the
seven. What *does* separate them is the works themselves, which is why the sheet exists.

---

## 3. What sits between two positions — 0.2 s

```bash
node dist/studio/corpus.js influences blend withheld interference
```

The midpoint of two resolved sets, and then the part that matters: works near the midpoint but
**outside both sets' own spreads** — the only region a blend reaches that neither position could
have reached alone.

```
near the midpoint but outside BOTH sets' own spreads (a<0.806, b<0.836):
  0.8274 (a 0.805 b 0.833)  met-314372   Figure
```

This is the operation that is hard to describe without the corpus and trivial with it.

---

## 4. The plates this project has already made, placed in that corpus — 1.0 s

```bash
node dist/studio/corpus.js plates out/condition-withheld
```

52 plates from three trajectories, embedded with the image tower and measured against the corpus and
against the position's own influence set. It writes **sidecars only** —
`scores.corpus.json`, `plates.clip.f32`, `plates.clip-index.json`. No byte of any existing
`scores.json` moves.

The last column is the one to read: percentile against the influence set, where **50.0% means "as
near this position's influences as a corpus work drawn at random."**

**The honest headline, and it is a negative one:** the two finished finals land at the **46.4th and
1.5th percentile**. The work this project has made is not near the background the position
describes. That is a measurement, taken before anything was wired in, and it is the number Stage 5's
wiring would have to move.

Two more nulls printed by this command:

- **drift during MAKE is `NOTHING MEASURED`** — no run has ever persisted a plate per step. The log
  keeps a `pixelHash`, not the pixels. Sketches are alternatives considered at one moment, not a
  canvas over time.
- A percentile is a fact about a **pool**. `artist resemblance` searches a 1,500-work stride sample;
  this command searches all 19,791. The same plate reads 83.3 in one and 96.7 in the other and
  neither is wrong. Ordering is stable; the level moves 13–14 points. Never carry one into a
  sentence about the other.

---

## 5. The map — already built, 53 s if it is not

```bash
open corpus/atlas-clip.html          # already on this machine
# node dist/studio/corpus.js atlas --clip --umap    # 53s to rebuild
```

19,791 works laid out by appearance. The footer carries the number that makes it a map rather than a
picture: **20-neighbourhoods preserved 0.3232 against 0.0133 by chance — 24.2x.**

Two facts worth having ready:

- Neighbours in the full space share a museum **55.4% of the time against 39.0% chance**, share a
  *kind* 3.6% against 0.3% — **11.6x**.
- Metadata neighbours are **93.6%** same-museum. Appearance neighbours are 55.4%. The picture crosses
  the museum wall that the catalogue could not, and much of why the catalogue cannot is that
  `Ceramic`, `ceramics` and `earthenware` are three different labels here.

---

## 6. The fallback, and the thing to leave open — needs nothing

```bash
open docs/demo/rendered/notebooks/00_setup.html
```

Eight notebooks over the corpus, the embeddings and the runs, **committed with their outputs** and
pre-rendered to tracked HTML (4.6 MB). These open on any machine with a browser — no Python, no
pixels, no embeddings, no network.

| | what it answers |
|---|---|
| `00_setup` | is everything here, and the one number to keep in mind: two random corpus works are at cosine **0.64** |
| `01_corpus_distributions` | what is in the corpus, and what is wrong with it |
| `02_embedding_space` | do appearance neighbours cross the museum wall — yes, 1.70x chance |
| `03_text_tower_gate` | are the two towers in the same space — yes, and an independent Python check agrees to 0.0000 |
| `04_influences` | an artist's background as 48 weighted works, per position |
| `05_trajectories` | the plates that exist, against the corpus |
| `06_pixel_metrics` | the pixel measurements, **including one real null** |
| `07_scratch` | an empty bench with every loader in scope |

If there is time for one: **02**. If there is time for one and the audience is sceptical: **06**,
because it is where the project reports that something it built measures nothing.

To re-execute all eight (84 s, needs the venv and the derived data):

```bash
npm run notebooks
```

---

## The three sentences to have ready

1. **The corpus is real evidence, not a demo fixture.** 20,000 works, three museums, every row
   carrying a sha256 and a refetchable URL, and `corpus verify` checks the bytes against the row.
   Seven API faults were caught during ingest and **every one of them was a 200 with the right row
   count** — `rowsReturned !== distinctIds` found them all.

2. **A phrase now reaches it, and a position now resolves into it.** Text and image are in one space
   at 27x chance on retrieval, and a position document becomes 48 named works with labelled axes.

3. **It is not yet in the loop, and the numbers say the loop needs it.** No corpus image has ever
   reached an artist prompt. The plates that exist sit at the 46th and 1.5th percentile against their
   own position's influences. Stage 5 is the wiring; it is written up as pending, not as done.

## What not to claim

- Do not say the positions are statistically distinguishable. Same-museum, entropy and intra-set
  coherence are all inside the chance band. `NOTHING MEASURED`.
- Do not quote a percentile without its pool.
- Do not say the artist uses the corpus. It does not yet.
- Do not compare a text–image cosine to an image–image cosine. Medians 0.2887 and 0.6428 — they are
  different rulers, and the sentence that mixes them sounds confident and is wrong.
