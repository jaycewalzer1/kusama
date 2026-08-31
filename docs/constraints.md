# The constraint language

Eighteen kinds, closed. Twelve decide from the program tree alone, five from the canonical PNG, one
decides nothing and says so. A nineteenth kind costs one of these.

Every kind is a pure function. Tree-scope checkers read `treeFacts()` — one walk over the **source**
JSON — and return `{status, evidence, nodeIds}`. Render-scope checkers read a `RenderMetrics` and
nothing else. `rubric` returns `unverified` always.

Four rules hold across the whole language:

- **`blocked_by` short-circuits everything.** A constraint that names a primitive the medium does not
  have is `unverified` before its checker is ever called, and is excluded from both the numerator and
  the denominator of the score. A position cannot score well by being untestable.
- **`unverified` is never a pass.** No metrics means no verdict, not a generous one.
- **A violation must carry evidence**: node ids, or a measured number against the bound it broke.
  "Violated" with neither is an opinion, and this layer does not have opinions.
- **`nodeIds` says the same thing as `evidence`, in a form a caller can compute with.** It is the
  nodes the verdict rests on: the offenders when violated, the carriers when satisfied — the ones
  whose removal could turn a pass into a violation. It is **empty**, and empty is a real answer, when
  the verdict rests on an absence (nothing forbidden is present), on an aggregate (the tree has 12
  nodes), or on the whole sheet (every render kind). A caller must never fall back to scanning
  `evidence` for ids: that was wrong in both directions, since an id that is a prefix of another
  matched and a verdict naming no ids matched nothing.

## The blind spot they all share

`treeFacts` walks the source tree, not the resolved one. **A `repeat` with `count: 40` contributes
one node, one mark and one colour use, not forty.** This is deliberate: resolving needs the profile
and the asset pack and is no longer pure, and purity is what makes these checks cheap enough to run
on every candidate edit inside a search loop. The cost is listed per kind below. The render scope is
where instance counts actually show up, because it measures pixels.

Second shared blind spot: **nothing here knows about stacking order or occlusion.** A `cover` op or a
later opaque block can hide an element completely and every tree-scope checker still counts it.

---

## Tree scope

### `maxDistinctColors`
`{ max: number, includeGround?: boolean }` — counts distinct `#rrggbb` after resolving palette names,
optionally plus `canvas.ground`. Default `includeGround: true`.

*Blind spots.* Two hexes one step apart (`#111111` and `#121212`) are two colours; a human sees one.
A colour used on one 4px mark counts the same as one used on the whole sheet. Opacity is invisible to
it, so `solid` at `opacity: 12` still registers as a full colour. It cannot see the colours p5.brush
actually mixes on the canvas (NOTES L4), only the ones the tree named.

### `palette`
`{ allow: string[], includeGround?: boolean }` — every colour must be in the list. Case-insensitive.
Reports the offending node and the colour it used.

*Blind spots.* An allow-list of near-identical greys is as satisfiable as a real restriction, so this
kind measures obedience to a list and not restraint. Same opacity and area blindness as above.

### `forbidNode`
`{ ops?: OpName[], macros?: MacroName[] }` — any occurrence is a violation.

*Blind spots.* Names, not effects. Forbidding `fragment` removes the pack's drawn figures; it does
not stop a figure being built out of six `stroke` ops. Forbidding the `frame` macro does not stop
four `rule` ops from forming a border. Every prohibition in this language is nameable-primitive deep,
and a determined tree can route around all of them.

### `requireNode`
`{ op?: OpName, macro?: MacroName, min?: number }` — a floor on one named node type. `min` defaults 1.

*Blind spots.* One name per constraint (there is no "four of any of these"). Counts source nodes, so
a `repeat` of 96 text instances counts as **one** — which is exactly the trick the rave-flyer probe
used to smear type without spending against `maxTextOps`. A floor cannot express "at four different
sizes", which is what most of the positions that use it actually mean.

### `nodeCount`
`{ min?: number, max?: number, countGroups?: boolean }` — drawing nodes, plus containers when asked.

*Blind spots.* The worst instance-count blindness in the set: a two-node tree can resolve to four
hundred marks. It is a proxy for visual density and a bad one; `inkDensityRange` is the one that
knows. Used here as a ceiling on a *tendency* (strip until it looks like a label), never as a claim
that node n+1 is wrong.

### `textCase`
`{ case: 'upper' | 'lower' }` — every string in the tree, including `quarantine.label`.

*Blind spots.* Strings with no case (`"014"`, `"0.0031"`, `"23:00"`) satisfy both settings silently.
It cannot see typographic voice at all: the medium has two fonts, both Regular, so "capitals" here is
a string property and not a face. Mixed-script or accented text is whatever the JS locale-free
`toUpperCase` says it is.

### `textMaxWords`
`{ max: number }` — per string, split on whitespace runs.

*Blind spots.* Splitting on runs means the three-space word-separator workaround (NOTES E3) is free,
which is correct, but it also means `"A B"` and `"ANTIDISESTABLISHMENTARIANISM"` are both one-word-ish
to it. It measures word count, not read time, line length or how much of the sheet the words eat.

### `textRequired`
`{ contains: string[] }` — case- and whitespace-insensitive substring match over all strings joined.

*Blind spots.* Joining before matching means a required phrase can be satisfied by an accident that
spans two unrelated text ops. It cannot check that the string is legible, large enough, on the sheet,
or not covered by a later block. **This is the one kind briefs use, and it is the weakest guarantee
in the file**: a poster can contain "14 NOVEMBER" at 6pt behind a solid rectangle and pass.

### `textMinHeight`
`{ min: number }` — every text op's `size` as a fraction of the sheet's **height**. The caption test:
type set small enough to read as apparatus rather than as image.

*Blind spots.* `size` is a declared unit, not a measured cap height, so it does not know what the face
actually renders at, and the two fonts differ. A `quarantine` label is set by the macro at a size the
program never states, so it is excluded rather than failed — unmeasured, not small. It says nothing
about where on the sheet the type sits, so a huge string tucked into a corner passes.

### `maxRepeatDepth`
`{ max: number }` — deepest nesting of `repeat` nodes. 0 for a tree with none.

*Blind spots.* Depth, not width: `count: 4096` at depth 1 satisfies `max: 1`. Two sibling repeats are
depth 1, which is usually the right reading and occasionally not.

### `forbidMark`
`{ styles?: StyleKind[], brushes?: string[] }` — either match is a violation. Reads `style.kind`,
`args.brush`, `style.brush` and `quarantine.boxBrush`.

*Blind spots.* Brush names, not brush behaviour. It cannot tell `rotring` at weight 12 from
`charcoal` at weight 1, and the first is by far the heavier mark. `brushScale` is invisible to it.

### `requireMark`
`{ styles?: StyleKind[], brushes?: string[], min?: number }` — styles and brushes counted together
against one floor.

*Blind spots.* Counts nodes that *asked* for the mark, not marks made or area covered. Two `solid`
rects of 4px satisfy `min: 2` as well as two full-bleed plates. The union of styles and brushes into
one floor means `{styles:['solid'], brushes:['spray'], min:3}` can be satisfied by three sprays and
no solid — a shape the positions here deliberately do not use.

---

## Render scope

All five read a `RenderMetrics` produced by `aesthetic/measure.ts` from the **canonical** RGBA:
the deterministic path, hermetic Chromium, antialiasing off, cached by program hash. With no metrics
they are `unverified`. They never launch a browser themselves.

### `inkDensityRange`
`{ min?: number, max?: number }` — fraction of pixels differing from `canvas.ground` by more than a
small threshold.

*Blind spots.* Says how much is marked, never what the marks are. A page of even 50% grey noise and a
page with one enormous black rectangle can report the same number. Ground-coloured marks drawn over
other marks (the stencil-bridge trick, the `cover` op) read as *removal* here, which is right for the
sheet and wrong if you wanted to know how much was drawn.

### `coverageRange`
`{ min?: number, max?: number }` — fraction of a fixed 16×16 grid of cells containing any ink.

*Blind spots.* Deliberately coarse, so it measures reach rather than amount. One thin line crossing
the sheet corner to corner lights up a diagonal of cells and scores as well-spread. The grid is
axis-aligned and fixed, so a composition on a 15- or 17-part rhythm interacts with it arbitrarily.

### `symmetryMax`
`{ axis: 'vertical' | 'horizontal', max: number }` — intersection-over-union of the ink mask against
its own mirror. 0 when there is no ink.

*Blind spots.* Binary mask only: colour, weight and shape are invisible, so a picture that is
symmetric in silhouette and wildly asymmetric in colour scores as symmetric. It tests reflection
about the exact centre line and nothing else — near-symmetry offset by ten pixels reads as
asymmetric. On a sparse page (Ikeda) the IoU is dominated by a handful of marks and is jumpy.

**It is unusable above roughly 0.8 ink.** The IoU of a mask with its own mirror rises mechanically
with the mask's area, and at full bleed it is 1 by construction, whatever the picture is. Any
position that also demands a filled sheet has written a contradiction — which is exactly what
crass-collage had, and why `inkOffsetRange` exists.

### `inkOffsetRange`
`{ min?: number, max?: number }` — distance of the tone-weighted ink centroid from the sheet centre,
over the distance from centre to corner. 0 is dead centre, 0 for a blank sheet, and 1 is the
unreachable limit of one corner pixel. Each pixel is weighted by the same distance-from-ground that
decides whether it is ink at all, so a black half against a pale half reads as off-centre and a full
bleed still has an answer.

*Blind spots.* One point summarises the whole sheet, so it cannot tell a single heavy corner from
two balanced heavy corners — both average back to the middle. Tone weighting means a large pale area
counts less than a small black one, which is right for "where is the weight" and wrong if you wanted
"where are the marks". It says nothing about which direction the weight went.

*It decays as the sheet fills — far less than `symmetryMax`, but it does decay.* "A full bleed still
has an answer" is true, but the answer gets smaller. Four renders against the `crass-collage`
position, `min: 0.08`:

| tree | ink | `inkOffset` |
|---|---|---|
| `examples/probes/crass-collage.json` (v0) | 0.3978 | 0.1914 |
| `aesthetic/fixtures/crass-collage-pass.json` | 0.9854 | 0.2011 |
| `aesthetic/fixtures/crass-collage-fail.json` | 0.9854 | 0.2014 |
| `examples/probes/v1/crass-collage.json` | **0.9967** | **0.0849** |

The floor was calibrated against the pass fixture and has ~2.5x headroom there, which is the number
to trust. The v1 probe is the warning: at 0.9967 ink it clears `0.08` by **6%**. That is not the old
degeneracy — `symmetryMax` would read a flat 1.0 and measure nothing at all — but a position pairing
this with `inkDensityRange {min}` up near 1.0 is working in the last few percent of the measure's
useful range. **If you raise an ink floor, re-measure this; the headroom does not travel.**

### `edgeContactRange`
`{ min?: number, max?: number, sides?: ('top'|'right'|'bottom'|'left')[], minSides?: number }` — per
side, the fraction of a band 5% of the sheet's shorter side wide that carries ink. `sides` defaults to
all four and `minSides` to all of the ones named, so the plain form is the strict one: **every side
must be in range**. Four numbers and not one, because a picture that runs off three sides and leaves
the fourth clean is the interesting case and any scalar reports it as the same thing as a picture that
leaves all four alone.

The kind exists because nothing else could say "this must reach the sheet". `inkDensityRange` and
`coverageRange` are quantities of ink, not places; `inkOffsetRange` moves the centroid without ever
requiring the border. Measured on the two finished runs that motivated it: `openai-withheld` reads
`0.0000` on all four sides with 31% of its pixels inked, and `condition-withheld` reaches one side.

*Blind spots.* A band, not a row: a one-pixel test would be asking about the renderer's clipping
rather than about the picture, but 5% is a choice and a mark that stops 6% short reads as no contact
at all. Corners are counted in two bands, so a single inked corner raises two numbers. It cannot tell
a deliberate bleed from an overflow, and it says nothing about *what* reaches the edge — a hairline
rule along the border satisfies it exactly as well as a full-bleed field does at the same fraction.

---

## Judge scope

### `rubric`
`{ text: string }` — carried, never executed. Always `unverified`. `checkProgram` returns every
rubric in `pendingRubrics`, verbatim, for a judge that is not part of this layer and never will be.

The rubrics in `aesthetic/positions/` are where the positions put what the tree and the pixels cannot hold:
mode of address, whether an image refers to anything outside itself, whether roughness was caused or
applied, whether emptiness is signal or good taste. See the final section of each program's `why`
fields for what specifically was pushed here and why.

---

## What was dropped, merged or renamed

The task's suggested list had thirteen tree kinds, three render kinds and `rubric`. It came out at
fifteen by these moves, and later at sixteen when `inkOffsetRange` was added:

| Suggested | Became | Why |
|---|---|---|
| `forbidPrimitive`, `forbidMacro` | `forbidNode` | Ops and macros are both just node types with a name. Two kinds to check one field was a waste of a slot. |
| `requirePrimitive`, `requireMacro` | `requireNode` | Same. |
| `maxNodes`, `minNodes` | `nodeCount` | One kind with optional `min` and `max`, matching `inkDensityRange` and `coverageRange`, which already had that shape. |
| `requireCover` | *dropped* | It is `requireNode {op: 'cover'}`. A kind whose whole content is one argument value is not a kind. |
| — | **`forbidMark`, `requireMark`** *(new)* | Style kind and brush are the strongest aesthetic levers this substrate has — `solid` versus `wash` is the whole difference between a printed block and a painted one (probes: xerox-zine, ikeda-austerity), and `rotring` versus `charcoal` decides whether a hand was in the room. The suggested list had no way to reach either. Four freed slots bought these two. |
| — | **`edgeContactRange`** *(new, eighteenth)* | Nothing in the other seventeen could name the sheet's border. A run came back with 31% of its pixels inked and an untouched margin on all four sides, and every constraint on it was satisfied — density and coverage count ink without caring where it is, and offset moves the centroid without requiring the edge to be reached. Nothing was given up: the four slots freed by the merges above had one left. |
| — | **`textMinHeight`** *(new, seventeenth)* | The caption ban. `textMaxWords` limits how much may be said and nothing limited what saying it could *be* — a short line set small in a corner is a label attached to a work rather than a mark on it, and no combination of the other sixteen could tell those apart. |
| — | **`inkOffsetRange`** *(new, sixteenth)* | `symmetryMax` is the only asymmetry measure the set had and it degenerates to 1 as the sheet fills, so a position holding both `inkDensityRange {min}` and `symmetryMax {max}` had written a contradiction with no picture in it. Nothing was given up for this one, because `symmetryMax` is still the right measure on a sparse page and two positions use it that way. The count went to sixteen and the language is closed there. |

Kinds considered and **not** added, because the tree cannot support them:

- **`fontCount` / `requireFonts`** — a ransom note is defined by mismatched faces. This was rejected
  because `core` has two fonts and both are Regular (probe: ransom-note), so any constraint over
  faces would have a range of two and be satisfiable by accident. **That reason expired on
  2026-08-26.** `core-v1` carries 36 faces across 10 roles, each with a `role` field, so
  `fontCount {min}` and a role-aware `requireFonts` are now both meaningful and both cheap — the
  tree already names its faces, so this stays a pure tree-scope walk. It is still not implemented,
  and the gap is still carried by nothing: not a constraint, not a rubric. Reconsider it against
  `core-v1` rather than inheriting this entry's verdict.
- **`maxTextSizeRatio`** ("one element far too big for its box") — expressible, but it needs resolved
  geometry to know what the box is, and tree-scope checkers are pure by design.
- **`requireOverlap` / `requireCollision`** — the situationist and crass positions both ask for
  butted and colliding elements as a *generative rule*, and both would need resolved bounding boxes.
  Left as prose for the artist model.
