# The influence layer

A way of saying *this work is made under the influence of that one*, in terms the environment can
check. Six named layers, four of them measurable, one dial, and a set of honest nulls.

Everything here is **optional and off by default**. Nothing in a run reads it, nothing it produces
feeds `scores.json`, and no existing hash moved to make room for it. There is exactly one entry
point — `npm run influence` — and a test asserts that no file outside `artist/influence/` imports the
layer except that CLI and the layer's own tests.

**Zero model calls.** numpy, OpenCV and scikit-learn in a pinned venv, plus TypeScript glue. Every
step that would have needed a model is written down in [NEEDS.md](NEEDS.md) and skipped.

---

## The headline, before anything else

**Three of the four measurable layers cannot tell a copy from a stranger.** The pair test — 82 works
whose catalogue entry names what they were made after, each measured against its named artist's own
works and against fifty random works — clears its threshold on `texture` only.

| layer | pairs nearer their source | sign-test z | verdict |
|---|---|---|---|
| `armature` | 47/82 | 1.33 | **NOTHING MEASURED** |
| `palette` | 49/82 | 1.77 | **NOTHING MEASURED** |
| `texture` | 58/82 | 3.75 | nearer its source |
| `form` | 43/82 | 0.44 | **NOTHING MEASURED** |

And then the second half of the result, which is worse:

**`texture` is the one layer with no way to say it.** The constraint language has eighteen kinds and
not one of them reads frequency content. So the only layer the pair test validated cannot be dialled
at all, and the only layer that can be dialled — `palette` — is one the pair test called a null.

Every sweep in this repo is therefore a demonstration of machinery, not evidence about influence. The
sweep report says so on every row, the constraint `why` strings say so in the constraints themselves,
and `docs/influence/pairs.md` says so at the top. Do not let any of it get softened into "the palette
dial works". It moves colours. Nobody has shown that moving them moves influence.

Full table, splits, the ten tightest and ten loosest pairs: **[pairs.md](pairs.md)**.

---

## The six layers

A model of what one work can take from another, ordered roughly from surface to argument.

| layer | what it is | source | state |
|---|---|---|---|
| `armature` | where the mass sits — silhouette, ink distribution, centroid, symmetry | pixels | measured, pair test **null** |
| `palette` | which colours, in what proportion | pixels | measured, pair test **null** |
| `texture` | the grain: frequency content and local binary pattern | pixels | measured, pair test **passes**, **cannot be dialled** |
| `form` | edge hardness, curvature, stroke orientation, elongation | pixels | measured, pair test **null** |
| `subject` | what the work is *of* | text | **reserved, empty** |
| `discourse` | what the work argues, and from where | text | **reserved, empty** |

`subject` and `discourse` are in the model, in `bizarreness.json`, and in the directions file as
explicit nulls. They are not faked. Filling them needs a reading of the work rather than a
measurement of it — see [NEEDS.md](NEEDS.md).

### Three kinds of source, and they are not interchangeable

Every direction carries a `source` field, and it is the first thing to read.

- **`pixels`** — the group's mean descriptor minus the corpus mean, over works actually in the
  corpus. `coverage` is always 1: it fills every dimension, whether or not the number is
  interesting. It also always *exists*: a group sitting on the corpus mean still gets a vector, so
  magnitude alone is close to meaningless and `cohesionZ` is what discriminates.
- **`text`** — reserved. Always null. Nothing produces one.
- **`authored`** — a person wrote the numbers down. `influence/packs/*.json`, validated on load.
  `coverage` is far below 1 and the gap is the point: a hand can state a palette in CIELAB and cannot
  state a 48-dimensional Gabor bank, so unfilled dimensions stay at the corpus mean rather than being
  invented. `cohesionZ` is null and `works` is 0, because one assertion is not a set of works.
  **Reading an authored magnitude without reading its coverage overstates the pack.**

The one authored pack is `rick-owens`, which fills `palette` and `form` and leaves `armature` and
`texture` null. Its `basis` field says in its own words that no Owens image was ever passed through
the descriptor worker and that nobody with expertise in the work has checked the numbers.

---

## Operator vocabulary

The words a person would use for what one work does to another. Naming them is not implementing
them; this table is mostly a list of what does not exist.

| operator | meaning | state |
|---|---|---|
| **hold** | keep a layer where the source has it (k=0 relative to the group) | implemented — `--k 0` |
| **exaggerate** | go further along the direction than the group itself does (k>1) | implemented — `--k 2` |
| **invert** | go the opposite way from the group (k<0) | implemented — `--k -1` |
| **transpose-scale** | apply a layer at a different magnitude, keeping direction | implemented — k *is* the scale |
| **quote** | reproduce a specific passage of a specific work, identifiably | **not implemented.** Needs the source work in the program, not a direction through a corpus mean. Nothing here can address one work. |
| **strip** | remove a layer the source has, leaving the rest | **not implemented.** The dial only adds constraints; there is no "unset this field" and no way to say "no palette at all". |
| **substitute** | swap one source's layer for another's, holding the rest | **not implemented** as an operator, though two `applyInfluence` calls on different layers approximate it. `overlaps` reports when two sets would collide; nothing resolves it. |
| **repeat** | take the source's rhythm rather than its marks | **not implemented.** No descriptor measures periodicity; the Gabor bank measures how much energy sits at a scale, not how regularly it recurs. |

k is a signed real. It scales the target linearly, k=0 is exactly the corpus mean, and negative k
walks the other way rather than clamping.

---

## What is actually implemented

```
npm run influence -- describe          # PNG -> 371 floats, over every distinct corpus image
npm run influence -- pairs             # the pair test -> docs/influence/pairs.md
npm run influence -- artists           # who has enough works to have a direction at all
npm run influence -- directions        # -> corpus/directions.v1.json
npm run influence -- sweep --program <p> --group <g> --layer <l> [--k -1,0,0.5,1,1.5,2]
```

### The descriptor — `influence/descriptors.py`, version `v1`, 371 floats

| offset | layer | width | contents |
|---|---|---|---|
| 0 | `armature` | 262 | 16x16 luminance grid over the Otsu foreground mask, silhouette aspect, area fraction, centroid x/y, h/v symmetry |
| 262 | `palette` | 27 | k-means k=6 in CIELAB sorted by area: 6 Lab centres + 6 area fractions + L mean, L std, chroma mean |
| 289 | `texture` | 58 | Gabor mean+std over 4 scales x 6 orientations (48) + 10-bin uniform LBP, P=8 R=1 |
| 347 | `form` | 24 | 8-bin edge-hardness histogram at Canny edges + curvature mean/std/straight-fraction over the top 20 contours + elongation of the largest + 12-bin structure-tensor orientation |

Resize policy, colour space and the alpha rule are argued in comments at the top of the worker, and
the four widths are asserted against the worker's own `--spec` by
`artist/tests/artist-influence-descriptors.test.ts`, so the TypeScript and the Python cannot drift.

Cached over 19,807 distinct images into `corpus/descriptors.v1.f32` (29.4 MB) in sha256 order, with
`corpus/descriptors.v1.index.json` as the sidecar and `corpus/descriptors.v1.stats.json` as the
per-dimension mean and std. **Every downstream distance is z-scored per dimension against those
stats.** Zero-variance dimensions are held out rather than dividing by zero.

### The directions — `corpus/directions.v1.json`

21 groups qualify at `MIN_WORKS = 15`: **8 artists, 4 studios, 9 cultures**. Three kinds, kept apart
on purpose — a direction from Wedgwood's 45 works is a real and coherent thing, and calling it an
*artist* direction would be a claim about a person who never existed.

Each direction carries `magnitude`, `spread`, `coverage`, `cohesionZ` (a 200-permutation test against
random same-size groups), `cohesive`, `source`, and `carriesInfluence` — the pair test's verdict for
that layer, carried on every direction so it travels with the number.

### The dial — `applyInfluence(program, directions, group, layer, k, stats, weights)`

Returns a **`ConstraintSet`**, not an edit. A constraint is a test: it can say "these six colours
only" and `checkConstraint` can fail a render that disobeys, but nothing in `applyInfluence` changes
a picture. All constraints are emitted `soft`.

It spends 3 of the language's 18 constraint kinds:

- **`palette`** — the six target centres converted CIELAB -> sRGB, plus `includeGround`. Out-of-gamut
  centres are clamped to the nearest displayable colour and the count is stated in the constraint's
  own `why`. It deliberately does **not** emit `maxDistinctColors`: every palette descriptor has
  exactly six centres because k is fixed at 6, so "6" is a fact about the algorithm, not the artist.
- **`inkDensityRange`** and **`inkOffsetRange`** — for `armature`. Both carry a caveat that the
  descriptor was measured on museum photographs of which only 14.7% are 2D.
- **nothing at all** for `texture` and `form`, which block every field they have.

Everything it cannot say goes into `blocked[]` with the field, the value it wanted, and why. On a
palette sweep that is `chromaMean` (no saturation constraint exists) and `fractions` (no colour-area
constraint exists). A target walked off the end of a descriptor's physical domain — `L*` is bounded
at 0 and 100 — is reported per field in `impossible[]` and **not clamped**, because clamping would
relabel "k=2" as "k=1.4 in some dimensions and k=2 in others" while still calling it k=2.

### Bizarreness — `influence/bizarreness.json`

`bizarreness(assignment) = sum over layers of weight * |k|`, weights `palette 1, armature 2, texture
2, form 3, subject 5, discourse 8`. Linear in `|k|` and blind to its sign.

In a **data file, not in source**, and a test asserts no weight has been copied into `apply.ts`. The
file says of itself that the weights are a judgement nobody has calibrated: no viewer has been asked
whether a texture departure reads as stranger than a palette one. **Four of the six weights can never
be spent** by the current implementation, and the file lists which and why.

**Reported, never wired.** It does not reach `scores.json` and a test asserts `artist/reward.ts` has
never heard of it.

---

## The sweeps

Three, all on `examples/v1/clip-aperture.json`, k = -1, 0, 0.5, 1, 1.5, 2.

| sweep | source | k=-1 | k=0 | k=0.5 | k=1 | k=1.5 | k=2 |
|---|---|---|---|---|---|---|---|
| [Alfred Stieglitz](sweep-alfred-stieglitz-palette.png) | pixels, 42 works | 3.57 | 2.99 | 4.17 | 4.37 | 5.13 | 5.79 |
| [James McNeill Whistler](sweep-james-mcneill-whistler-palette.png) | pixels, 20 works | 4.00 | 2.99 | 2.99 | 3.21 | 3.57 | 4.03 |
| [Rick Owens](sweep-owens-palette.png) | authored | 7.47 | 2.99 | 3.43 | 5.85 | 7.69 | 9.24 |

The number is the z-scored Euclidean distance from the rendered image's measured `palette` descriptor
to the target the dial asked for, printed under each cell. The palette constraint is satisfied on
every cell of every sweep — the edit and the rule that judges it are built from the same six centres,
so they cannot disagree.

### Read the table again: the distance goes UP with k

This is the honest reading and it should not be buried. The recolour moves every colour in the
program to the nearest of the six target centres, and the render *still* lands further from the
target the further the target is pushed. Two reasons, and only one of them is benign:

1. The target runs away faster than the picture can follow. Snapping three named colours and a ground
   onto six centres cannot reproduce six centres in the right *proportions*, and `fractions` and
   `chromaMean` are exactly the fields listed in `blocked[]`. So part of the rise is the dial being
   measured on dimensions it was never able to touch.
2. **There is no control arm.** Nobody rendered the *unedited* program against the same target. So
   "distance 5.79 at k=2" has nothing to be compared with, and the claim "the edit moves the render
   toward the target" is not tested anywhere in this repo. That is a missing experiment, not a
   detail — it is first in [NEEDS.md](NEEDS.md).

### Why only `palette` can be swept at all

`SWEEPABLE = ['palette']`, and the reason is written into `sweep.ts`. For palette there is a clean
deterministic edit: a program keeps its colours in a top-level `palette` map and a `canvas.ground`,
so every colour can be snapped to its nearest target centre in CIELAB. The tree is untouched, node
references are by name and stay valid, and the edit is a pure function of (program, target).

For `armature` there is not. Moving a render's ink density or centroid means moving marks, and any
rule for doing that would be an intervention this repo invented — a claim about what an armature
direction *means* as a drawing action, with nothing behind it. So an armature sweep renders the same
program at every k and reports `edited: false` on every row, producing a column of identical images.
That is the correct picture of a dial connected to nothing, and the report says it in those words
rather than quietly showing six copies.

For `texture` and `form` there is neither an edit nor a constraint, and those sweeps refuse.

**Do not run texture sweeps above k=1 in demo material.** They produce nothing and the numbers under
them would be read as evidence.

---

## Reading anything here honestly

- **The pair test is the gate, and most of the layer did not pass it.** A direction, a dial or a
  sweep on a layer marked NOTHING MEASURED is moving a number that has not been shown to carry
  influence through this corpus. Not useless — but every claim about it is a claim about the
  descriptor, not about influence.
- **A direction always exists.** Even for a group sitting on the corpus mean. On a synthetic corpus,
  magnitude barely separates a displaced group from an undisplaced one; `cohesionZ` does. Read the
  cohesion.
- **"Source artist" is a name, joined on spelling.** This corpus has no artist authority file, so two
  people with the same name are one person here, and one person with two spellings is two.
- **The descriptors were measured on museum photographs.** Only 14.7% of the manifest is 2D and only
  0.92% are sheets with a measurable ground. An `armature` centroid over a photographed vase is a
  fact about the photograph.
- **An authored pack is a hypothesis with a name on it.** It may be used to sweep and to argue about
  the machinery. It may not be used to argue about the artist.
- **Nothing here has been looked at by an artist.** No one has been shown a sweep and asked whether
  the k=2 column reads as more like anything.

---

## Files

| path | what | tracked |
|---|---|---|
| `influence/descriptors.py` | the worker: PNG -> 371 floats | yes |
| `influence/requirements.txt` | pinned numpy / OpenCV / scikit-learn | yes |
| `influence/.venv/` | the wheels | no |
| `influence/bizarreness.json` | the cost weights, as data | yes |
| `influence/packs/*.json` | authored packs | yes |
| `artist/influence/*.ts` | descriptors glue, creator parser, pair test, directions, packs, dial, sweep, sheet | yes |
| `studio/influence.ts` | the only door | yes |
| `corpus/descriptors.v1.f32` | 19,807 x 371 f32, sha256 order, 29.4 MB | yes |
| `corpus/descriptors.v1.index.json` | sha256 -> row | yes |
| `corpus/descriptors.v1.stats.json` | per-dimension mean and std | yes |
| `corpus/directions.v1.json` | 21 group directions + 1 authored pack | yes |

The `.f32` is tracked because it is under the 50 MB line, but it is worth knowing what that means: it
is derived from `corpus/images/`, which is **not** tracked, so a fresh clone can read the matrix and
cannot reproduce it. Regenerating it needs the images and a venv: `npm run influence -- describe`.
