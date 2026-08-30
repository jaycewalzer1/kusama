# Lineage elements, stage 1: the measurement pre-flight

Run before any schema code, to answer one question: **does a candidate lineage element pair actually
produce an unsatisfiable constraint set in this medium, or does it only look like it does?**

An element pack whose conflicts are all satisfiable is a mechanism that never fires. Everything in
`aesthetic/elements/conflicts.json` is seeded from this table and from nothing else.

## Headline

The obvious render-scope conflict — **horror vacui against negative space, written as
`inkDensityRange {min: 0.35}` versus `coverageRange {max: 0.40}` — is satisfiable**, and two probes
witness it:

| program | inkDensity | coverage |
| --- | --- | --- |
| `pf-aligned-100cells` | 0.3903 | 0.3906 |
| `pf-aligned-99cells` | 0.3874 | 0.3867 |

Had that pair gone into `conflicts.json` on the strength of the argument rather than the
measurement, the whole layer would have been a no-op with a plausible story attached.

The same tension **is** empty at `coverageRange {max: 0.30}`: measured max ink under that ceiling is
**0.2500**, against a floor of 0.35, a margin of **0.10**. That is the pair the pack ships.

## Method

29 programs measured through `aesthetic/measure.ts` (the cached, serial, post-`printRender` path —
NOTES R8, so one render at a time):

- 6 position fixtures (`aesthetic/fixtures/*.json`)
- 11 golden sources (`examples/v0`, `examples/v1`)
- 12 purpose-built probes sweeping the (inkDensity, coverage) plane

Base position throughout: **`cut-and-reset`**.

The probes matter more than the corpus. The corpus is what this repo happens to contain and says
nothing about what is *reachable*; the probes are built to sit at the corners, in particular the one
corner that decides every ink-versus-coverage pair.

### Why the grid-aligned probes exist

`measure.ts` computes coverage on a fixed 16x16 grid (`GRID = 16`) and counts a cell as covered once
**1%** of it holds ink (`CELL_INK = 0.01`). On a 600x900 sheet a cell is 37.5 x 56.25 px. Two
consequences:

1. Because a covered cell contributes `1/256` to coverage and at most one cell's worth of area to
   inkDensity, **ink is bounded above by coverage** — nearly. `pf-aligned-100cells` is a solid
   375x562 rectangle snapped to exactly 10x10 cells: the adversarial shape that puts as much ink as
   physically possible into as few cells as possible. It reaches ink 0.3903 at coverage 0.3906.
2. The bound is **not exact**. The grid uses `Math.floor` boundaries, so cells are 37 or 38 px wide
   and 56 or 57 px tall; a block landing on the large cells carries slightly more area per unit of
   coverage. `pf-aligned-99cells` measures **ink 0.3874 against coverage 0.3867** — ink exceeds
   coverage by 0.000729.

Point 2 is the reason ink-versus-coverage is a **declared** conflict in the pack and not a
**derived** one. "ink <= coverage" is not a theorem of the constraint parameters; it is a property of
the metric definitions *and the canvas dimensions*, and the constraints do not carry the canvas. A
derivation that quietly assumed it would be provably wrong on this corpus by 7e-4.

Measured worst cases:

```
ink - coverage, worst case over the corpus:
  pf-aligned-99cells       ink-cov = 0.000729
  pf-blank                 ink-cov = 0.000007
  clip-cut-paper           ink-cov = 0.000000
  pf-aligned-64cells       ink-cov = 0.000000

highest ink reached at each coverage ceiling:
  coverage <= 0.25: max ink = 0.2500  (pf-aligned-64cells)
  coverage <= 0.30: max ink = 0.2500  (pf-aligned-64cells)
  coverage <= 0.35: max ink = 0.2500  (pf-aligned-64cells)
  coverage <= 0.40: max ink = 0.3903  (pf-aligned-100cells)
  coverage <= 0.50: max ink = 0.5000  (pf-half)
```

## The measured corpus

| tag | program | inkDensity | coverage | inkOffset | symV | symH |
| --- | --- | --- | --- | --- | --- | --- |
| fixture | cut-and-reset-fail | 0.4366 | 0.7070 | 0.1140 | 0.6339 | 0.4478 |
| fixture | cut-and-reset-pass | 0.4366 | 0.7070 | 0.1130 | 0.6362 | 0.4484 |
| fixture | data-austerity-fail | 0.0298 | 0.1758 | 0.0651 | 0.2632 | 0.1169 |
| fixture | data-austerity-pass | 0.0050 | 0.0781 | 0.3476 | 0.5061 | 0.0041 |
| fixture | generation-loss-fail | 0.1959 | 0.6563 | 0.3661 | 0.2783 | 0.0914 |
| fixture | generation-loss-pass | 0.1925 | 0.6523 | 0.3716 | 0.2778 | 0.0892 |
| golden-v0 | event-picture | 0.9419 | 1.0000 | 0.0744 | 0.9899 | 0.8839 |
| golden-v0 | event-picture-edited | 0.9419 | 1.0000 | 0.0758 | 0.9899 | 0.8839 |
| golden-v0 | hill-feast | 0.8378 | 0.9961 | 0.1066 | 0.7642 | 0.6814 |
| golden-v0 | poster-less-is-more | 0.1034 | 0.7188 | 0.2404 | 0.2812 | 0.1156 |
| golden-v1 | blend-negative | 0.8788 | 1.0000 | 0.0894 | 0.7965 | 0.7901 |
| golden-v1 | blend-overprint | 0.5181 | 0.7305 | 0.0719 | 0.7392 | 0.5197 |
| golden-v1 | clip-aperture | 0.3016 | 0.5781 | 0.0709 | 0.4958 | 0.2672 |
| golden-v1 | clip-cut-paper | 1.0000 | 1.0000 | 0.0281 | 1.0000 | 1.0000 |
| golden-v1 | spray-wall | 0.7577 | 1.0000 | 0.0444 | 0.6276 | 0.6209 |
| golden-v1 | tear-ransom | 0.8103 | 1.0000 | 0.1713 | 0.6918 | 0.6806 |
| golden-v1 | tear-strata | 0.4751 | 0.7344 | 0.0413 | 0.7595 | 0.6926 |
| probe | pf-blank | 0.0000 | 0.0000 | 0.9718 | 0.0000 | 0.0000 |
| probe | pf-field | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| probe | pf-scatter | 0.0060 | 0.1563 | 0.1447 | 0.0000 | 0.0000 |
| probe | pf-sparse-rules | 0.0091 | 0.1836 | 0.0663 | 0.0798 | 0.0827 |
| probe | pf-corner | 0.1404 | 0.1406 | 0.6254 | 0.0000 | 0.0000 |
| probe | pf-hatch | 0.1620 | 0.7656 | 0.0386 | 0.1243 | 0.1281 |
| probe | pf-aligned-64cells | 0.2500 | 0.2500 | 0.0000 | 1.0000 | 1.0000 |
| probe | pf-aligned-99cells | 0.3874 | 0.3867 | 0.0633 | 0.7979 | 0.8314 |
| probe | pf-aligned-100cells | 0.3903 | 0.3906 | 0.0009 | 0.9947 | 1.0000 |
| probe | pf-half | 0.5000 | 0.5000 | 0.4160 | 1.0000 | 0.0000 |
| probe | pf-two-thirds | 0.6667 | 0.6875 | 0.2774 | 1.0000 | 0.3333 |
| probe | pf-full-bleed | 1.0000 | 1.0000 | 0.0000 | 1.0000 | 1.0000 |

`pf-field` was written as a `field`-style paint over 540x820 and rendered **no ink at all**. Left in
the table as measured rather than tuned away. It is not load-bearing for any pair below, and chasing
it is a separate question about the `field` style, not about this layer.

## The candidate pair table

`|A|` / `|B|` / `|A&B|` are counts of the 29 measured programs satisfying each side and both.
`|A&B| = 0` is evidence of emptiness; `|A&B| >= 1` kills the candidate outright.

| # | pair | kinds | scope | \|A\| | \|B\| | \|A&B\| | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `inkDensityRange{min:0.35}` vs `inkDensityRange{max:0.18}` | same | render | 16 | 9 | **0** | **empty (algebraic)** — `min > max`, no measurement needed |
| R2 | `inkDensityRange{min:0.35}` vs `coverageRange{max:0.40}` | cross | render | 16 | 10 | **2** | **satisfiable — REJECTED** |
| R3 | `inkDensityRange{min:0.35}` vs `coverageRange{max:0.30}` | cross | render | 16 | 8 | **0** | **empty (measured)**, margin 0.10 |
| R4 | `coverageRange{min:0.75}` vs `coverageRange{max:0.30}` | same | render | 9 | 8 | **0** | **empty (algebraic)** |
| R5 | `symmetryMax{v,0.55}` vs `symmetryMax{v,0.92}` | same | render | 12 | 21 | **12** | **not a conflict** — two ceilings intersect at `min()` |
| R6 | `inkOffsetRange{min:0.35}` vs `inkOffsetRange{max:0.12}` | same | render | 5 | 19 | **0** | **empty (algebraic)** |
| R7 | `inkDensityRange{min:0.35}` vs `inkOffsetRange{min:0.35}` | cross | render | 16 | 5 | **1** | **satisfiable — REJECTED** (`pf-half`) |
| R8 | `inkDensityRange{min:0.35}` vs `symmetryMax{v,0.55}` | cross | render | 16 | 12 | **0** | empty on this corpus, but **unknown**: no reason a dense asymmetric sheet cannot exist. Not shipped. |

Tree scope is decided by arithmetic on the tree, not by pixels, so these are proofs rather than
counts. Checked by hand against `aesthetic/kinds.ts` and against `cut-and-reset`:

| # | pair | kinds | scope | verdict |
| --- | --- | --- | --- | --- |
| T1 | `requireNode{paint,5}` + `requireNode{text,6}` vs `nodeCount{max:6}` | budget | tree | **empty** — `5 + 6 = 11 > 6` |
| T2 | `forbidNode{ops:[fragment]}` vs `requireNode{op:fragment,min:2}` | existence | tree | **empty** — same op |
| T3 | `forbidMark{styles:[wash,field]}` vs `requireMark{styles:[field],min:3}` | existence | tree | **empty** — same style |
| T4 | `textCase{upper}` vs `textCase{lower}`, text required | derived | tree | **empty** — real, but never the headline example |
| T5 | `palette{allow:S}` vs `palette{allow:T}`, `S ∩ T = ∅`, ground counted | budget | tree | **empty** — the ground colour would have to be in both |
| T6 | `maxDistinctColors{max:3}` vs `palette{allow:[5 colours]}` | budget | tree | **NOT empty — REJECTED**, see below |

### T6: the colour-budget rule in the brief is unsound and is not implemented

The brief asks for "`maxDistinctColors {max: n}` against a `palette` requiring more than n non-ground
entries". **`palette` has no such semantics.** Read `kinds.ts:102-115`: it is an *allow*-list. It
permits a set of colours and violates only on a colour outside it. It never requires that any of them
appear. A program using three of a five-colour allow-list satisfies both constraints, so the pair is
satisfiable and the derivation would emit a false conflict.

There is no minimum-entries constraint in the closed sixteen, and the brief forbids adding a
seventeenth. So the colour-budget conflict ships as **T5, disjoint allow-sets**, which is sound
unconditionally when the ground is counted. Recorded in NEEDS.md.

## The four elements selected

| element | carries | conflicts with |
| --- | --- | --- |
| `kuba-shoowa-surface` | `inkDensityRange{min:0.35}`, `requireNode{paint,5}`, `requireMark{field,3}` | `ma-interval` (R1, R3, T1); base `p-no-soft` (T3) |
| `ma-interval` | `inkDensityRange{max:0.18}`, `coverageRange{max:0.30}`, `nodeCount{max:6}`, `textCase{lower}` | `kuba-shoowa-surface` (R1, R3, T1); base `p-shouting` (T4) |
| `rodchenko-red-black` | `palette{allow:[paper,ink,red]}`, `requireNode{rule,5}` | `chromolith-broadside` (T5) |
| `chromolith-broadside` | `palette{allow:[5 disjoint]}`, `requireNode{text,6}`, `requireNode{fragment,2}` | `rodchenko-red-black` (T5); `ma-interval` (T1); base `p-no-illustration` (T2) |

Requirements from the brief, met:

- **4 elements** ✔
- **at least 2 conflicting pairs** ✔ (six pairs across four sources, counting the base position)
- **at least one render-scope pair with a measured empty intersection** ✔ — R1 and R3, both between
  `kuba-shoowa-surface` and `ma-interval`

## Reproducing this

The probe generator and the two analysis scripts are scratch, not corpus: this repo deletes probe
directories (`examples/probes` went on 2026-08-27) and 12 more files that feed one document is the
wrong trade. The probes are fully specified above and in the numbers below; regenerate with a
600x900 `default-v0` / `core` program, seed 4471, ground `#f2efe9`, and:

- `pf-aligned-64cells` — solid `ink` rect at `(150, 225, 300, 450)`
- `pf-aligned-99cells` — solid `ink` rect at `(112, 112, 338, 619)`
- `pf-aligned-100cells` — solid `ink` rect at `(112, 169, 375, 562)`
- `pf-half` — solid `ink` rect at `(0, 0, 600, 450)`
- `pf-two-thirds` — solid `ink` rect at `(0, 0, 600, 600)`
- `pf-full-bleed` — solid `ink` rect at `(0, 0, 600, 900)`
- `pf-corner` — solid `ink` rect at `(0, 0, 225, 337)`
- `pf-blank` — solid `ink` rect at `(10, 10, 2, 2)`
- `pf-scatter` — 40 solid 9x9 rects on an 8-column grid at `x = 18 + 74i`, `y = 26 + 172j`
- `pf-sparse-rules` — three `marker` rules, weight 2, across the sheet at y ≈ 150 / 450 / 745
- `pf-hatch` — `hatch` paint, `marker`, spacing 6, angle 30, over `(40, 60, 520, 780)`
- `pf-field` — `field` paint, `marker`, density 6, length 24, angle 0, over `(30, 40, 540, 820)`
