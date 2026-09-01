# notebooks

Eight notebooks over the corpus, the embeddings and the runs. They exist so that someone can look at
this project's numbers without reading TypeScript, and so that a claim made in a report can be
checked against the data in one place.

## The rule these notebooks follow

**They read; they do not recompute.** Every number in `corpus/` is produced by the TypeScript
pipeline — the sha256 dedupe, the kNN, the band, the CLIP tokenizer. A second implementation in
pandas would be a second thing that can disagree with the first, and nothing would notice, because a
wrong cosine is still a plausible cosine.

So `notebooks/kusama.py` is a loader and nothing else. It reads flat files the CLI wrote, and
reaches the text tower and the pixel metrics over a subprocess to `dist/studio/corpus.js`. The one
exception is notebook 03, which **deliberately** re-derives the retrieval gate in Python so the two
implementations can be compared — and they agree to four decimal places on all four statistics.

The second rule: **every number is printed with the baseline it has to beat**, or it is printed as
`NOTHING MEASURED` with the reason. `k.Reading(name, value, baseline)` exists to make that the path
of least resistance.

## Setup

```bash
python3 -m venv notebooks/.venv
notebooks/.venv/bin/pip install -r notebooks/requirements.txt
```

`notebooks/.venv/` and `notebooks/out/` are gitignored. The notebooks are committed **with** their
outputs, so the eight can be read on a machine that has none of the derived data.

## Running them

```bash
npm run notebooks      # execute all eight in place, then export HTML to docs/demo/rendered/notebooks/
```

Or one at a time:

```bash
cd notebooks && .venv/bin/jupyter nbconvert --to notebook --execute --inplace 02_embedding_space.ipynb
```

Each executes top to bottom in well under five minutes; the whole set takes about two.

## What they need on disk

Notebook `00_setup` checks all of this and names the command that builds anything missing. In short:

| file | tracked? | built by |
|---|---|---|
| `corpus/manifest.jsonl` | **yes** — it is the evidence | `corpus metadata` + `corpus select` |
| `aesthetic/influences/*.resolved.json` | **yes** | `corpus influences resolve` |
| `corpus/images/` (3.0GB) | no | `corpus images` |
| `corpus/clip.f32`, `clip-index.json` | no | `corpus embed` |
| `corpus/analytics/*.csv`, `band.json` | no | `corpus export-analytics` (~2 min) |
| `out/*/scores.corpus.json` | no | `corpus plates <dir>` |

A notebook run on a machine with only the tracked files will raise `FileNotFoundError` with the
command to run. It will not silently produce a smaller number.

## The eight

| | what it answers |
|---|---|
| `00_setup` | is everything here, and what is the one number to keep in mind |
| `01_corpus_distributions` | what is actually in the corpus — and what is wrong with it |
| `02_embedding_space` | do appearance neighbours cross the museum wall (yes, 1.70x chance) |
| `03_text_tower_gate` | are the two CLIP towers in the same space (yes, and the Python check agrees exactly) |
| `04_influences` | an artist's background as 48 weighted corpus works, per position |
| `05_trajectories` | the plates that exist, placed against the corpus |
| `06_pixel_metrics` | the pixel measurements, including one real null |
| `07_scratch` | an empty bench with every loader and baseline already in scope |

## A warning that has already cost this project two wrong numbers

A percentile is a fact about a **pool**. `artist resemblance` searches a 1,500-work stride sample;
the plate sidecars search all 19,791. The same plate scores 83.3 in one and 96.7 in the other, and
neither is wrong. Ordering between plates is stable; the level moves 13–14 points with the pool
size. Never carry a percentile from one pool into a sentence about another.
