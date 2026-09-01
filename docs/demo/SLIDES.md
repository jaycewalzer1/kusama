# Slide outline — Thursday 2026-09-03

Fourteen slides. Every one names a file that is **tracked in git** and a sentence that is **checked**.
Where a sentence carries a number, the chance baseline it is measured against is on the same slide,
because a number without its baseline is the thing this project exists to refuse.

The runbook is `docs/demo/THURSDAY.md`; the section numbers below point into it. The order is the
runbook's order, so the deck and the live path are the same path — if a command fails, put its slide
up and keep talking.

**The three asset folders, all tracked:**

| folder | what it is | when to use it |
|---|---|---|
| `docs/demo/screens/` | 10 PNGs, 1920x1080, this deck's images | the deck |
| `docs/demo/terminal/` | 12 `.txt`, the real stdout of every command in the runbook | the terminal died, or the room wants the full output |
| `docs/demo/video/` | a 887 KB webm and 7 stills of the atlas being driven | the atlas page will not open |

---

## 1 — Title

**Screen:** none, or `screens/07-atlas-clip.png` behind the title.

**Say:** "Nineteen thousand seven hundred and ninety-one museum photographs, placed by what they look
like. Nothing in this map has read a catalogue."

**Note:** the whole talk is one claim — that a picture can be evidence — and one honest admission,
that it is not yet wired into the thing that makes pictures. Do not bury the admission; it is slide 12.

---

## 2 — What is actually here §0

**Screen:** none. A list.

**Say:** "20,000 works from the Art Institute, the Cleveland Museum, and the Met. Every row carries a
sha256 and a URL that still fetches. 19,889 images downloaded, 99.4% of the manifest."

**The number and its baseline:** seven API faults were caught during ingest and **every one was a
200 with the right row count**. What caught them was `rowsReturned !== distinctIds`, not the status
code. *A status code is not a diagnosis.*

**Note:** this slide is the one that buys credibility for every later number. Do not rush it.

---

## 3 — A phrase reaches the corpus §1

**Screen:** `screens/01-search-handwriting.png`
**Backup text:** `terminal/02-search-handwriting.txt`

**Say:** "I type `a page of dense handwriting` and get back twelve dense pages — an album-leaf
colophon, a papyrus, three Ramayana folios, a Gutenberg Bible leaf, and a textile swatch sewn to a
letter."

**The number and its baseline:** retrieval is **P@10 54.8% against 2.0% chance — 27x** at finding a
work from its own title among 19,791 candidates. Same-museum pairs in this row: **28.8% against a
39.0% chance rate** — *below* chance, so the phrase is not just retrieving one museum's cataloguing.

**Note:** read the z and the percentile, never the cosine. A text-image cosine of 0.30 is a high one
and shares no scale with an image-image cosine, whose corpus median is 0.6428.

---

## 4 — The one the room reacts to §1

**Screen:** `screens/02-search-does-not-blink.png`
**Backup text:** `terminal/03-search-does-not-blink.txt`

**Say:** "`being watched by something that does not blink`. First result is a Lover's Eye miniature —
one painted human eye in a brooch. Then amulets of Horus, Khnum, Isis, a falcon, a baboon."

**The number and its baseline:** 47.0% same-museum pairs against 39.0% chance, across all three
museums. No catalogue contains the phrase.

**Note:** this is the slide that makes the case for CLIP in one image. If there is time for exactly
one search, it is this one.

---

## 5 — What it cannot do §1

**Screen:** `screens/04-search-flag-fails.png`
**Backup text:** `terminal/04-search-flag-fails.txt` and `terminal/05-search-accession-fails.txt`

**Say:** "`an upside-down flag hung from a granite cliff` returns a cliff photograph, and separately a
banner, and no image of the two together. There is no inversion anywhere. It keeps the nouns and
drops the syntax."

**The number and its baseline:** `1923.456` — an accession number — returns **eleven papal medals and
a wood-engraving block, from one museum**. An accession number has no appearance.

**Note:** say this *before* someone in the room finds it. Volunteering the failure is what makes the
successes believable.

---

## 6 — Coherence and crossing pull against each other §1

**Screen:** `screens/11-search-crowd-one-museum.png`, with `screens/03-search-corporate-greed.png`
as the contrast if there is room for two.

**Say:** "The most convincing row in the whole survey was `a crowd of people in the street`. Twelve
street scenes, every one from a single museum — **100% same-museum against 39.0% chance**. The
prettiest result on the page is the worst one by the measure that matters."

**Note:** this is the general lesson, not a caveat: a set that looks coherent is often a set that
found one museum's photographic style. `corporate greed` sits at 45.5% and covers two museums.

---

## 7 — A position becomes 48 works §2

**Screen:** `screens/05-influences-withheld.png`
**Backup text:** `terminal/06-influences-withheld.txt`

**Say:** "A position document names a lineage, a worldview, and a set of commitments. Each string
becomes a query, run verbatim with no interpretation. What comes back is 48 weighted works — the
artist's background expressed in the only vocabulary the corpus has."

**The number and its baseline:** the set is **50.0% two-dimensional works against a 14.7% corpus
share — 3.4x** — and **37.5% same-museum against 39.0% chance**, which is a null and is printed as
one. Nothing on the sheet was hand-picked; the `picks` field is empty.

**Note:** the axes are labelled with real works, not numbers: *calligraphy → furniture*,
*lace → chalk*, *tomb pottery → textile*.

---

## 8 — What sits between two positions §3

**Screen:** none — this one is live, 0.2 s. Fall back to `terminal/07-blend.txt`.

**Say:** "The midpoint of two positions, and then the part that matters: works near the midpoint but
outside *both* sets' own spreads. The only region a blend reaches that neither position could reach
alone. `interference × many-hands` returns an early sword, a banner, and a painted fan."

**Note:** if asked about other pairs, show `terminal/08-blend-degenerate.txt` — above a centroid
cosine of 0.95 the command says *"the two centroids are nearly the same point, so this blend has
almost nothing to blend"*, and `withheld × interference` is 0.9598. The refusal is a feature.

---

## 9 — The honest one §3b

**Screen:** none — live, 0.4 s. Fall back to `terminal/09`, `10`, `11`.

**Say:** "Ranking 48 works against a phrase always produces a first-place work. It does for a phrase
about textiles and it does for a phrase about a sports car, and the two look identical on the page.
So the ranking is never printed without the same query's distribution over all 19,791 works."

**The number and its baseline:** the real brief — `fifty-year-embargo`'s own material text — reads
**+1.78 sd from the corpus mean, inside the ±2 band. NOTHING MEASURED.** The textile phrase reads
+0.97, the sports car +0.96.

**Note:** **+1.78 is the strongest reading in the whole demo and it is still a null.** The threshold
was fixed before the number was seen. A tool that wanted to impress you would have called it a hit.
This is the most important slide in the deck.

---

## 10 — The map §5

**Screen:** `screens/07-atlas-clip.png`
**Backup:** `video/atlas-overlay-condition-withheld.webm`, or the 7 stills beside it.

**Say:** "19,791 works laid out by appearance. The catalogue was not consulted."

**The number and its baseline:** 20-neighbourhoods preserved **0.3348 against 0.0133 by chance —
25.1x**. On the atlas's 1,500-work sample, appearance neighbours share a museum **55.9% against
38.9% chance** and share a *kind* **3.8% against 0.3% — 14.5x**.

**Note:** the contrast that sells it, and **both halves must come from the same pool** — over the
whole corpus, *metadata* neighbours are **93.6%** same-museum and *appearance* neighbours are
**66.3%**, against 39.0% chance. The catalogue cannot leave the building it was written in; the
picture can. **Do not pair 93.6% with the 55.9% above** — that one is the 1,500-work sample, and the
two are not the same quantity.

---

## 11 — The run laid over the map §5

**Screen:** `screens/06-atlas-overlay-condition-withheld.png`
**Backup:** `video/05-hover-final-plate.png` — the readout is on screen in that frame.

**Say:** "Orange is the position's 48 influence works. On top of them, this run's 17 plates, placed at
the cosine-weighted average of their 20 nearest corpus works' existing coordinates."

**The caveat, out loud:** **the map was not refitted to add the plates.** Refitting would move the
corpus to accommodate them, and a cluster a plate *created* would look exactly like one it landed in.
And of the 20 works a plate was placed *from*, only **1.5%** are among the 20 points nearest it on
screen — UMAP keeps adjacency, not distance. The plates are in the right *region*, not beside the
works they resemble.

---

## 12 — The number that is not good §4

**Screen:** `screens/10-notebook-06-pixel-metrics.png`, or none.
**Backup text:** `terminal/12-plates.txt`

**Say:** "The plates this project has already made, measured against the background its own position
describes. The final of this run lands at the **46.4th percentile**. The other finished trajectory
lands at the **1.5th**. Fifty percent means *as near as a corpus work drawn at random*."

**The number and its baseline:** so one run is at chance and the other is worse than chance. **No
corpus image has ever reached an artist prompt.** These numbers were taken before anything was wired
in; they are the numbers the wiring would have to move.

**Note:** do not soften this. It is the slide that makes slides 3–11 worth believing.

---

## 13 — One real null, found by looking §6

**Screen:** `screens/10-notebook-06-pixel-metrics.png`

**Say:** "Reading order versus pixel weight, over a 40x range of offsets. Off-centre median 0.0439,
centred 0.0440. **Chance 100%.** That is not an instrument that failed — it is a measurement that
came back empty, and it is in the notebook with its outputs committed."

**The number and its baseline:** and the reason it can be trusted: only **9 of 1,500 sampled images**
are sheets with a measurable ground, because museums shoot 2D works with the mount in the border. The
project reports the sample size that makes most of the metric unusable.

---

## 14 — Where it stands

**Screen:** `screens/09-notebook-02-embedding-space.png`

**Three sentences, in this order:**

1. **The corpus is real evidence, not a demo fixture.** 20,000 works, three museums, every row with a
   sha256 and a refetchable URL. Seven ingest faults caught, every one a 200 with the right row count.
2. **A phrase reaches it, and a position resolves into it.** Text and image in one space at **27x
   chance** on retrieval; a position document becomes 48 named works with labelled axes.
3. **It is not yet in the loop, and the numbers say the loop needs it.** The plates that exist sit at
   the 46th and 1.5th percentile against their own position's influences. That wiring is written up as
   pending, not as done.

---

## What not to say, on any slide

- Not that CLIP *understands* these works. Retrieval was measured on **titles**, and a museum title is
  catalogue prose. "Fragment" appears hundreds of times.
- Not that the seven positions are distinguishable by their statistics. Same-museum share across all
  seven is 36.5–41.8% against 39.0% chance — `NOTHING MEASURED`.
- Not that the tool *found* the textiles in §3b. It **ranked** them.
- Never put a text-image cosine and an image-image cosine in the same sentence. Corpus medians 0.2887
  and 0.6428; they are different rulers.
- Never carry a percentile from `artist resemblance` (1,500-work stride sample) into a sentence about
  `corpus plates` (all 19,791). The same plate reads 83.3 in one and 96.7 in the other. Ordering is
  stable; the level moves 13–14 points.
