# Thursday

Five commands and a folder of HTML. Every one of them runs with **no model call and no network** —
both API providers are out of credit, and nothing here needs them.

Read §0 first. It is the part that will bite.

---

## 0. What this machine has that a clone does not

The corpus is 20,000 works from three museums. What is **tracked in git** is the evidence:
`corpus/manifest.jsonl` (20,000 rows, one per work, each with a sha256 and a refetchable
`image_url`), `corpus/readings/`, and `aesthetic/influences/*.resolved.json`. Also tracked, and the
whole of the fallback: `docs/demo/rendered/` — the eight notebooks as HTML (4.6 MB), two atlas
overlay pages and both bare maps (1.7 MB each).

**Every command below was run cold from a fresh login shell on 2026-09-02**, in the order printed,
twice — once to find what was wrong with this file, once after fixing it. All exited 0 both times and
**not one wrote a single byte to stderr**. Total wall time **7.45 s cold, 6.48 s warm**; the ~0.9 s
of the difference is `tsc` on a warm cache, and every individual command is under 2 s. Nothing here
comes close to the ten seconds a live command is allowed.

What is **not** tracked is everything derived from it, because it is large and reproducible:

| on this machine | size | rebuilt by | cost |
|---|---|---|---|
| `corpus/images/` | 3.0 GB | `npm run corpus -- images` | hours, and it is 19,889 HTTP fetches |
| `.models/` (CLIP image + text towers) | 594 MB | first run of any embedding command | one download |
| `corpus/clip.f32` + `clip-index.json` | 39 MB | `npm run corpus -- embed` | 12 min |
| `corpus/analytics/` | 70 MB | `npm run corpus -- export-analytics` | 132 s |
| `.browsers/` (hermetic Chromium) | 478 MB | `PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright install chromium` | one download |
| `corpus/atlas-clip.html` | 3 MB | `npm run corpus -- atlas --clip --umap` | 53 s |
| `corpus/atlas.html` (metadata map) | 3 MB | `npm run corpus -- atlas` | 3 s |
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

The `--sheet` writes a contact sheet plus a **self-contained HTML** — the 6.0 MB PNG is inlined as a
data URI, so the file opens with no server and can be sent on its own. The HTML is 8.0 MB and takes
about 1.8 s to paint; open it *before* you need it.

**Say:** the position is now a region of the corpus, and the region is inspectable.

**Do not say** that the seven positions are distinguishable by their statistics. They are not, and
the report says so: same-museum share across all seven runs 36.5–41.8% against a **39.0% chance**
baseline — `NOTHING MEASURED`. Classification entropy is inside the chance band for two of the
seven. What *does* separate them is the works themselves, which is why the sheet exists.

---

## 3. What sits between two positions — 0.2 s

```bash
node dist/studio/corpus.js influences blend interference many-hands
```

The midpoint of two resolved sets, and then the part that matters: works near the midpoint but
**outside both sets' own spreads** — the only region a blend reaches that neither position could
have reached alone.

```
blend interference x many-hands — centroids sit at cosine 0.8769

near the midpoint but outside BOTH sets' own spreads (a<0.836, b<0.815):
  0.8513 (a 0.835 b 0.815)  met-33513    Early Sword
  0.8474 (a 0.834 b 0.808)  met-26941    Banner
  0.8465 (a 0.831 b 0.809)  aic-132945   Flowering Plum Blossom 梅花竹柄团扇
```

This is the operation that is hard to describe without the corpus and trivial with it.

**Use this pair, not `withheld interference`.** The command refuses to pretend: above a centroid
cosine of 0.95 it prints *"the two centroids are nearly the same point, so this blend has almost
nothing to blend"* and `withheld × interference` sits at **0.9598**, so it says exactly that.
The three pairs are 0.9598, 0.9319 and **0.8769** — `interference × many-hands` is the only one with
real distance between the two centroids, and it is the one whose far region returns swords, a banner
and a fan rather than twelve more textile fragments. If someone asks about the other pairs, the
degenerate warning is a feature and worth showing on purpose.

---

## 3b. A condition read through a shelf — 0.4 s, and the answer is *no*

This is the honest one. Run it twice:

```bash
node dist/studio/corpus.js influences lens "woven cloth, linen and thread" withheld -k 3
node dist/studio/corpus.js influences lens "a photograph of a modern sports car on a racetrack" withheld -k 3
```

Both print a ranking, and both print `NOTHING MEASURED`:

```
  against withheld: 48 works, mean cosine 0.2428
  against the corpus: 19,791 works, mean 0.2164 sd 0.0274
  NOTHING MEASURED. The set sits +0.97 sd from the corpus mean, inside the ±2 band.

    0.3014  p 99.17  met-545138   Length of Very Sheer Linen Cloth
```

**Say:** ranking 48 works against a phrase always produces a first-place work — it does for a phrase
about textiles and it does for a phrase about nothing, and the two look identical on the page. So the
ranking is never printed without the same query's distribution over all 19,791 works. The nearest
work here is at the 99th percentile of the whole corpus, and the *set* is at +0.97 sd. By that
measure this shelf is no more "about woven cloth" (+0.97) than it is "about sports cars" (+0.96).

**Do not say** the tool found the textiles. It ranked them. A position's influence set is not
selected for any brief, so this is the expected answer — the point of the command is that it says so
instead of letting you supply the significance.

---

## 4. The plates this project has already made, placed in that corpus — 1.0 s

```bash
node dist/studio/corpus.js plates out/condition-withheld
```

**17 plates** — one final and sixteen sketches, this one trajectory. (52 is the figure for all three
trajectory directories at once; pass them all if you want it, but on stage run the one.) Each is
embedded with the image tower and measured against the corpus and against the position's own
influence set. It writes **sidecars only** —
`scores.corpus.json`, `plates.clip.f32`, `plates.clip-index.json`. No byte of any existing
`scores.json` moves.

The last column is the one to read: percentile against the influence set, where **50.0% means "as
near this position's influences as a corpus work drawn at random."**

**The honest headline, and it is a negative one:** this run's final lands at the **46.4th
percentile** — the number on screen. The other finished trajectory (`out/openai-withheld`, add it to
the command line to see it) lands at the **1.5th**. The work this project has made is not near the
background the position describes. That is a measurement, taken before anything was wired in, and it is the number Stage 5's
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

## 5. The map, and the run laid over it — already built, 53 s if it is not

```bash
open docs/demo/rendered/atlas-condition-withheld__inf-withheld.html   # tracked, 1.7 MB
```

The "the same works by metadata →" button top-right now works: `docs/demo/rendered/atlas.html` is
tracked alongside it, so the two maps sit in one folder and the link between them resolves. Before
today it pointed at a file that was only ever in `corpus/`, and clicking it on stage would have
given a file-not-found.

**Do not run the rebuild on stage.** It is 53 s, which is five times the ten seconds anything live is
allowed to take, and the page it produces is the page already open:

```bash
# node dist/studio/corpus.js atlas --clip --umap --overlay out/condition-withheld --influences withheld   # 53s
```

19,791 works laid out by appearance, with `withheld`'s 48 influence works picked out in orange and
that run's 17 plates placed on top. The header carries the number that makes it a map rather than a
picture: **20-neighbourhoods preserved 0.3348 against 0.0133 by chance — 25.1x.**

Three facts worth having ready:

- Neighbours in the full space share a museum **55.9% of the time against 38.9% chance**, share a
  *kind* 3.8% against 0.3% — **14.5x**.
- Metadata neighbours are **93.6%** same-museum. Appearance neighbours are 66.3% over the whole
  corpus (notebook 02) — the picture crosses the museum wall the catalogue could not, and much of why
  the catalogue cannot is that `Ceramic`, `ceramics` and `earthenware` are three different labels
  here. *The 55.9% above is the same quantity over the atlas's 1,500-work sample; do not put the two
  in one sentence.*
- **The map was not refitted to add the plates.** Each plate sits at the cosine-weighted average of
  its 20 nearest corpus works' existing coordinates. Refitting would move the corpus to accommodate
  the plates, and a cluster a plate *created* would look exactly like one it landed in.

**The honest caveat, which is in the page footer and should be said out loud:** of the 20 corpus
works a plate was placed *from*, only **1.5%** are among the 20 corpus points nearest it on screen.
UMAP keeps adjacency and not distance, so twenty mutually-near works can be scattered across the page
and their centroid lands in the gap. The plates are in the right *region* and are **not** necessarily
beside the works they resemble. For the actual neighbours, read `corpus plates` (§4).

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

## 7. Servers, ports, and what to do when one dies

**Nothing in §1–§6 needs a server.** Every page above is opened with `open <file>` over `file://`:
the atlas pages inline their 19,791 points into one `<script>` and draw to a `<canvas>`, and the
influences sheet inlines its PNG as a data URI. All six were loaded headless from `file://` and
**none logged a console error**. This is the whole reason the fallback is credible.

Two servers may be running from earlier work, and **neither is needed**:

```bash
lsof -nP -iTCP:4321 -sTCP:LISTEN     # the studio UI  (npm run ui)
lsof -nP -iTCP:4322 -sTCP:LISTEN     # the atlas server (python3 -m http.server)
```

If you want the atlas served rather than opened as a file — the only reason being that a server lets
you reload without re-picking the file — then:

```bash
python3 -m http.server 4322 --directory corpus     # then http://localhost:4322/atlas-clip.html
```

**If that port is taken or the server dies mid-demo, do not debug it.** Both maps are also sitting in
the tracked folder as plain files:

```bash
open docs/demo/rendered/atlas-clip.html    # the appearance map, bare
open docs/demo/rendered/atlas.html         # the metadata map, bare
```

and if you want everything behind one URL instead, one line with no install and no repo state:

```bash
npx serve docs/demo/rendered               # or: python3 -m http.server 8080 --directory docs/demo/rendered
```

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
- Do not read the works *around* a plate on the atlas overlay as the works it resembles. Placement
  recall is 1.5%. The region is meaningful; the immediate neighbours on screen are not.
- Do not say the sketches on the overlay are a path through the space. Nothing joins them, on
  purpose: no run has ever persisted a plate per MAKE step, so there is no sequence to draw.
- Do not name a single work as "the one this plate is nearest to". The plates are 520x700, so the
  centre crop throws away 26% of the sheet before CLIP sees it; encode them the other way and only
  62 of 101 images in that band keep the same top-1. Bands and regions survive that; a named
  neighbour is close to a coin flip. `corpus aspect-audit` prints the whole gradient.
