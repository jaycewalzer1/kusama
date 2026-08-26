# Proposed additions

**Nothing in this document is implemented.** No file under `renderer/`, `env/`, `profiles/` or
`assets/` was touched by this investigation. This is a specification only.

## Ranked by how many probes each unblocks

Counted from `trait-table.md` over all **twelve** probes: a capability "unblocks" a probe if it moves
at least one row of that probe's table out of the **faked** or **impossible** column.

| # | capability | probes unblocked | rows moved | kind | risk |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | more faces and weights in the asset pack (bold grotesque, condensed grotesque, monospace) | **7** — xerox-zine, ransom-note x2, rave-flyer x2, ikeda-austerity x2 | 7 | **asset pack only — not a primitive** | none |
| 2 | **`degrade`** — a per-pixel post-process pass (threshold, spread, dropout, generations) | 6 — xerox-zine x2, ransom-note x2, rave-flyer x2 | **8** | new pipeline stage, Node-side | very low |
| 3 | **`stencil`** — a hard-edge per-pixel mask on a group | 6 — xerox-zine x2, ur-stencil, ransom-note, crass-collage x2 | 6 | new node property, GPU | **high** |
| 4 | non-uniform `transform` (`scale: [sx, sy]`, `skew`) | 4 — rave-flyer x2, ransom-note x2 | 4 | schema + resolve | low |
| 5 | raster/photographic material in the pack, placeable by `fragment` | 3 — crass-collage x2 (decisively), xerox-zine | 3 | asset pack + one op arg | medium |
| 6 | `multiply` blend for true ink overprint | 2 — ransom-note x2 | 2 | renderer + profile `blendModes` | high |
| 7 | tonal / gradient fill style | 2 — crass-collage x2 | 2 | new PaintStyle | medium |
| 8 | text on a path | 1 — ur-stencil-b | 1 | new `text` arg | low |

Doubling the probe set from six to twelve **changed the order**. Row 1 was second on the six-probe
count and is first on the twelve-probe count, because the second attempt at each target ran into the
two-faces-one-weight limit again in a differently-built program — which is exactly the evidence a
second attempt was meant to produce. Row 6 dropped from three probes to two: on re-reading,
`multiply` does not move any row of `crass-collage`, whose two impossibles are photographic material
and continuous tone. That was an error in the first count and is corrected here.

Row 8 is new, from `ur-stencil-b`. It is listed for completeness and is not worth doing: it unblocks
one row of one probe.

Two things the brief expected to find missing are **already present** and need no work:

- **True high-contrast black.** `solid` at opacity 255 goes through plain p5 `fill` with
  antialiasing off. `#0d0d0d` renders as exactly `#0d0d0d` with a one-pixel edge.
- **Misregistration offset.** Two ops at coordinates differing by 0.5px, or a `group` with a
  `transform.translate`, already give a real second impression. `ur-stencil` and `ransom-note` both
  do it, and it survives any crop.

**Row 1 should be done before either specced item below.** Three more font files change the pack
hash and nothing else — no new primitive, no schema change, no determinism surface at all — and it
moves seven "faked" rows on seven of the twelve probes. It is not specced here because the brief
asked for primitives, but it is the cheapest change in this document by a very large margin, and the
twelve-probe count moved it from second place to first.

**One thing that is not a missing capability but should be written down.** An unclipped `solid`
circle goes to p5's WEBGL `ellipse`, which tessellates at a fixed 25 segments regardless of radius;
every other circle path in the renderer uses `CLIP_CIRCLE_SEGMENTS = 64`. So a circle above about
r 60 looks broken until the author discovers that wrapping it in a `clip` rect which contains it
fixes it. That is a documentation and possibly a default-value problem, not a new primitive. See
`inventory.md` under `paint`, and `out/substrate-test/circle-detail/circ2/` for the side-by-side.

---

## Spec 1 — `degrade`

A per-pixel pass over the finished canvas. The single missing capability that matters most, because
xerox, ransom-note and cheap-flyer aesthetics are not *ways of drawing* — they are **things that
happen to an image after it is drawn**, and this substrate currently has no "after".

### Where it sits in the pipeline

**Node-side, not an op, not in the browser.** `Renderer.render` already returns an RGBA buffer.
`degrade` is a pure function `(rgba, width, height, params, seed) -> rgba`, applied:

```
settledReadback (loops until two consecutive frames are byte-identical)
  -> degrade                          <-- new
  -> pixelHash / encodePng
```

It is declared once per program, next to the canvas, never per node:

```json
"canvas": { "width": 800, "height": 1200, "ground": "#e9e7e0", "brushScale": 1,
            "post": [{ "op": "degrade", "generations": 3, "threshold": 0.55,
                       "dark": "toner", "light": "paper",
                       "spread": 1, "dropout": 0.03, "speck": 0.015 }] }
```

### Parameters

| name | type | range | step | default | meaning |
| --- | --- | --- | --- | --- | --- |
| `threshold` | number | 0.05 – 0.95 | 0.05 | required | Luminance cut. `0.299r + 0.587g + 0.114b` on the 0-255 integers, compared against `round(threshold*255)`. Below goes to `dark`, at or above goes to `light`. |
| `dark` | palette key | — | — | required | The colour everything below the cut becomes. Taken from the program palette so the pass invents no colour of its own. |
| `light` | palette key | — | — | required | The colour everything at or above the cut becomes. |
| `spread` | integer | 0 – 3 | 1 | 0 | Morphological dilate of the dark set, in pixels, using a square structuring element. This is toner spread, and it is what makes a photocopy's type thicken with each generation. |
| `dropout` | number | 0 – 0.2 | 0.01 | 0 | Fraction of dark pixels flipped to `light`. Toner failing to transfer. |
| `speck` | number | 0 – 0.2 | 0.01 | 0 | Fraction of light pixels flipped to `dark`. Dirt on the platen. |
| `generations` | integer | 1 – 4 | 1 | 1 | How many times the whole pass runs, each on the previous result. **This is the point of the whole primitive**: generational loss is literally iteration, and iterating `spread` + `dropout` is what produces the closed-up counters and broken hairlines of a fourth-generation copy. |

Randomness for `dropout` and `speck` comes from a new `post` substream, seeded exactly like every
other stream: FNV-1a over `masterSeed + "post" + generationIndex`. It never touches node seeds, so
adding a post pass cannot change a single mark.

### Budget impact

Cost is a function of the canvas, not of the program, which is a new shape for this profile:

- `renderCost += 4000 * generations` — flat, independent of node count.
- New limit `maxPostPasses: 1`. One pass, not a chain; a chain is a compositing system and this is
  not that.
- `maxEstimatedMarks` is untouched: `degrade` adds no marks.

Measured expectation: 800x1200x4 generations is 3.84M pixel visits of integer arithmetic in Node,
which should land near 40ms — under 2% of the 2.1s a `ikeda-austerity` render currently takes.
It does **not** need to be inside the settle loop, so it is paid once, not once per settle
iteration.

### Determinism risk — low, and the reason is architectural

Integer arithmetic on a `Buffer` in Node. No GPU, no float accumulation across pixels, no
`Math.random`, no iteration-order dependence (each output pixel of each generation depends only on
the previous generation's buffer). Under NOTES R6 the suspect surface is MSAA resolve and
GPU-dependent sampling, and this pass touches neither. Under R8 the suspect surface is shared
Chromium GPU state, and this pass runs after the browser has been closed out of the picture.

**The one constraint that must not be got wrong:**

> `degrade` must run **after** the settle loop has converged, never inside it and never instead of
> it. A threshold quantises small differences away. If the settle loop compared post-processed
> buffers, a genuinely nondeterministic raw render could converge because the threshold flattened
> the difference — the substrate would then certify as deterministic an image that is not. This is
> NOTES R8's meta-lesson exactly: a self-consistency check cannot detect a shared-cause error, and
> a threshold is a machine for creating shared-cause agreement.

Required evidence before merge, notwithstanding the low risk — because "low risk" is a claim, and
the claim is the thing being tested:

1. `batch` over the 20-program batch set with a `degrade` pass, run in **two independent
   processes**, 0 differing hashes.
2. `generations: 4` specifically, since iteration is where any accumulation error would show.
3. `golden --check` against `default-v0` still green for all four existing goldens, proving the
   pass is inert when not asked for.

### Profile change

`default.profile.json` gains `post: ["degrade"]`, ranges for `threshold`/`spread`/`dropout`/
`speck`/`generations`, quantize steps for each, and `limits.maxPostPasses`. That is a content
change, so the id and hash both move: **`default-v0@15ad87c16095` → `default-v1@<new>`**.

`default-v0` must be **left on disk unchanged**. Every existing example names its profile by id, so
they continue to resolve `default-v0`, their `profileHash` in `goldens/index.json` stays
`15ad87c16095`, and the four committed goldens `626df27b0945` / `43ab77142371` / `5e278e1c86ee` /
`61982d731298` keep passing without being regenerated. Nothing about this change forces a golden
rewrite, and if it appears to, that is a bug in the change and not in the goldens.

> **Outcome, 2026-08-26 — the prediction held, and the four hashes above are still dead.** Read
> that carefully, because the two halves look contradictory. `default-v0` is byte-identical and
> still hashes `15ad87c16095`; the shipped profile is `default-v1@be50e7c6f0a6` with pack
> `core-v1@dd47bb1c2e34`; and **no part of the v1 work moved a v0 pixel.** The goldens were
> nevertheless re-pinned to `dca4125bd3ec` / `7428a3c1efeb` / `d06eb1f14840` / `aca457b2491c`,
> because a separate bug fix landed the same day: `textWidth(' ')` returns exactly 0, so every
> per-glyph path had been dropping word spaces (NOTES E7). That is the case this paragraph
> explicitly did not cover — a golden rewrite forced by a *correctness fix*, not by a capability
> addition. The rule "if a v1 change appears to force a v0 golden rewrite, that is a bug in the
> change" survives intact; it just is not the only reason a golden can legitimately move. The
> re-pin is commit `c98bdf3`, kept separate so it can be reverted alone.
>
> Two naming drifts from this section as written: the profile key shipped as **`print`**, not
> `post`, and the stage list is `threshold` / `posterize` / `halftone` / `grain` / `misregister` /
> `paper` / `generation` rather than a single `degrade`. The limit is `limits.maxPrintStages`.

---

## Spec 2 — `stencil`

A hard-edge per-pixel mask on a `group`. What `clip` should have been.

### Why the cheap version does not work

`clip` already exists but is rect-only and **geometric**: it intersects each op's polygon against
the clip rect on the CPU (NOTES L1). That is why `text` is refused inside a clipped group — a p5
text draw has no polygon to intersect. Generalising `clip` from a rect to an arbitrary region is a
small change and would be genuinely useful, but it would **not** unblock any row of the trait
table, because every row that wants a mask wants to mask **type**: the stencil bridges in
`ur-stencil`, the toner dropout inside glyphs in `xerox-zine`, the knockout caption in
`crass-collage`. Masking type requires a real per-pixel mask.

Nor does `cover` solve it. `cover` paints the ground colour back, so it only works over untouched
ground; over the hatched columns in `crass-collage` it would be a grey rectangle, not a cut.

### Where it sits in the pipeline

Op-time, in the browser, on the GPU. A group carrying `stencil` renders its children into a
`p5.Framebuffer` the size of the canvas, the mask region is rasterised into a second framebuffer as
a plain `solid` polygon, and the two are composited with a one-line alpha-multiply before being
drawn to the main buffer.

```json
{ "id": "word", "type": "group",
  "stencil": { "region": { "type": "polygon", "points": [[...]] }, "invert": true },
  "children": [ ... ] }
```

### Parameters

| name | type | range | default | meaning |
| --- | --- | --- | --- | --- |
| `region` | `$defs/region` | rect / circle / polygon (3-80 points) / `fragmentPlacement` | required | The mask shape. Reuses the existing region schema exactly, so `maxPolygonPoints: 80` already governs it. |
| `invert` | boolean | — | `false` | `false` keeps what is inside the region; `true` keeps what is outside it. `true` is the one that cuts stencil bridges. |

Deliberately **no feather and no softness**. A feathered mask is a blur, a blur is a texture sample
with a kernel, and a texture sample under SwiftShader is precisely the surface NOTES R6 caught. If
soft edges are wanted later they must be argued for separately and measured separately.

### Budget impact

- New limit `maxStencilGroups: 6`. Each one costs a full canvas-sized framebuffer; six 800x1200
  RGBA framebuffers is about 23MB of GPU memory, which is the point at which a cap is needed rather
  than a suggestion.
- New limit `maxStencilNesting: 1` — a stencil inside a stencil is a compositing tree, and that is
  a different project.
- `renderCost += 2000` per stencilled group.
- `maxEstimatedMarks` untouched; a stencil removes marks, it never adds them.

### Determinism risk — high. The highest thing in this document.

Three named reasons, all of them things this repo has already been burned by:

1. **R6.** The medium is deterministic *because* `setAttributes('antialias', false)` removed the
   MSAA resolve. A framebuffer composite reintroduces a GPU resolve step on a path that has never
   been measured. There is no reason to assume it behaves like the main buffer.
2. **R1.** p5.brush already keeps a blend-source framebuffer alive between draws, which is why every
   render gets a fresh page. Adding six more framebuffers to that page interacts with a mechanism
   the medium currently handles by avoidance rather than by understanding.
3. **R8.** Framebuffer allocation is GPU-process state, and the GPU process is shared. Whatever
   makes concurrent renders diverge today has a larger surface to act on tomorrow.

Required evidence before merge — and this is a hard gate, not a checklist:

1. 50-program batch including stencilled programs, run in **two independent OS processes**, 0
   differing hashes. Not two runs in one process; that is the self-consistency trap.
2. The settle loop's iteration count must be **recorded and reported** for stencilled programs. If
   a stencilled program needs materially more frames to converge than an unstencilled one, the
   composite is nondeterministic and is being hidden by the loop rather than fixed by it.
3. The same stencilled program rendered through the preview UI on a real GPU (ANGLE Metal), and
   compared **for structure only, never for hash** — if the mask lands in a different place on a
   different GPU, the feature is not portable even if it is self-consistent.

If any of the three fails, the honest outcome is to ship `degrade` alone and leave stencilling
undone, because a nondeterministic mask would cost more than every trait it unblocks is worth.

### Profile change

`default.profile.json` gains `limits.maxStencilGroups` and `limits.maxStencilNesting`;
`program.schema.json` gains `stencil` on `group` alongside `clip`. Same hash consequence as
Spec 1 — **`default-v0@15ad87c16095` → `default-v1@<new>`**, `default-v0` left on disk untouched so
the four committed goldens keep passing unchanged.

---

## Spec (not built): group `opacity`

Written up rather than shipped, 2026-08-26, alongside group `blend`. Blend landed in `default-v1`
(`multiply`, `screen`, `exclusion` — NOTES R11). Opacity did not, and this records why and what was
measured, so the next person does not have to find it out again.

### What was asked for

`group` gains `opacity`, so a whole subtree can be laid down at less than full strength — a ghosted
under-layer, a second impression that did not take, a photocopy of a photocopy sitting behind the
sharp copy.

### Why it did not ride along with `blend`

Because `blend` turned out not to need a group and `opacity` does. There is no group at draw time:
`resolve.js` flattens the tree to a list of leaves and `page.js` draws each one straight onto the one
canvas. `blend` therefore reduces to a per-leaf `p.blendMode()` call, carried down `ctx` exactly like
`clip` — about fifteen lines. `opacity` does not reduce that way. Fading each leaf to 60%
individually is not the same picture as fading the composited subtree to 60%: wherever two leaves in
the group overlap, the first is twice-attenuated. The difference is not subtle and it is largest
exactly where a group is doing something worth grouping.

Doing it properly means compositing the subtree offscreen and drawing the result once. p5.brush
supports that — `brush.load(buffer)` against a WEBGL `p5.Graphics` (`src/core/target.js:131`), and
R3 records that the offscreen probe rendered correctly. But it drags in:

- a second brush target, which means `resetBrushState` and the leaf-isolation contract in
  `compositing.js` now have to be correct across a target switch as well as across a leaf;
- a decision about what a `clip` means across a buffer boundary, since our clip is geometric and
  computed in world coordinates (NOTES L1) and the buffer has its own origin;
- interaction with `blend`, because a group that is both blended and faded has to composite first
  and blend second, which is the one ordering the current per-leaf design cannot express;
- the whole of the framebuffer determinism risk already itemised for `stencil` above — R6, R1, R8 —
  on a path that has never been measured under SwiftShader.

### What is already there instead

Every style carries `opacity` at the leaf, and it is honoured. `examples/v1/blend-negative.json` uses
`opacity: 190` on two `light.beam` fragments inside a `screen` group and gets exactly the ghosted
second-impression reading the feature was wanted for. For a subtree with no self-overlap — which is
most of them — per-leaf opacity *is* group opacity. The gap is real but it is narrower than it looks.

### If it is built

The gate is the one written for `stencil` above, unchanged and for the same three reasons: 50
programs including faded groups, two independent OS processes, zero differing hashes; the settle
loop's iteration count recorded and compared against unfaded programs, because a composite that is
nondeterministic and merely slow to converge would otherwise be hidden by the loop rather than caught
by it; and a structure-only comparison against a real GPU. Plus one more that is specific to this
feature: a numerical check, in the manner of R11 — a group of two known overlapping solids at a known
opacity has one right answer per channel, and if the implementation cannot hit it exactly then it is
not compositing, it is just dimming.

### Profile change, when it happens

`limits.maxOpacityGroups` alongside `maxStencilGroups`; `opacity` on `group` in
`program.schema.json`; `ranges.opacity` and `quantize.opacity` already exist and already mean the
same thing, so no new field name is needed. Hash consequence: `default-v1` moves, `default-v0`
untouched.

---

## Spec (not built): type on a path, and mesh warp

Tier 3b of the widening brief. `spray` (Tier 3a) shipped; this did not, and the reason is not that it
is hard but that the honest version of it is a different feature than the one the brief describes.

### What was asked for

"Text along a polyline, and a simple mesh warp (arc, bulge, wave)."

### Why it did not ship as one thing

These are two features wearing one bullet point, and only one of them fits the medium as built.

**Type on a path is tractable.** `opText` already measures per-glyph advances (`drawTracked`) and
already draws each glyph under its own `push`/`translate`/`rotate` when jitter is on. Putting a glyph
on a polyline is the same loop with the transform read off an arc-length parameterisation of the path
instead of off a seeded stream. The measurement it needs — `spaceWidth`, and NOTES E7's warning that
`textWidth(' ')` is 0 — is already solved. The work is arc-length tabulation of the polyline, and
bounds in `leafBounds` that follow the path rather than a box, which is the only part with any risk in
it: a text op whose declared bounds stop describing its marks is how `diff` starts reading one node's
spillover as somebody else's.

**Mesh warp is not tractable on this path, and would be a lie if shipped.** A warp deforms *rendered
output*, and there is no rendered output to deform until p5 has finished — at which point we are in
the print pass, on the CPU, working on a whole canvas rather than on one node. The three options were
all bad:

- Warp the glyph outlines. p5's WEBGL text does not expose outlines here; we draw glyphs, we do not
  own their contours. There is nothing to bend.
- Warp per glyph — place each glyph on the arc/bulge/wave with its own rotation and scale. This is
  *type on a path* with a curve generator attached, not a mesh warp. It bends the baseline and leaves
  every letterform rigid, which at large sizes is visibly not a warp. Shipping it under the name
  `warp` would be the O6 failure shape again: the call succeeds, the effect the name promises never
  happens, and nothing in the determinism gate can see the difference.
- Warp in the print pass, per-pixel. Deterministic and real, but it warps the entire sheet including
  everything that was not the text, which is a different primitive with a different name.

So the useful, honest subset is **one** feature: `text` gains a `path`, and the arc/bulge/wave curves
become ways of *generating* that path rather than a separate `warp` argument. What is lost against the
brief is per-letterform deformation, and that is lost because the renderer genuinely cannot do it,
not because it was skipped.

### The measurement that decided it

None — and that is why it is here rather than in the medium. The rule for today was that a capability
that cannot be proven deterministic does not ship, and the corollary that was applied twice this
session (overlay/difference in R11, blank variable fonts in O6) is that a capability that *cannot be
distinguished from its own failure* must not ship either. `warp` on rigid glyphs cannot be
distinguished from `warp` unimplemented by any gate this repo owns. Type on a path can: put a known
string on a known circle and the glyph centres have closed-form positions, in the manner of R11.

### If it is built

`textArgs` gains `path`: either an explicit polyline (reusing `maxStrokePoints`) or
`{ kind: "arc" | "bulge" | "wave", ... }` generating one. Glyphs are placed by arc length from the
existing `align` anchor; `tracking`, `case`, `leading` and the glyph jitter stream all continue to
mean what they mean, and `maxWidth` wrapping is refused on a path, because a wrapped second line has
nowhere to go.

Gate: the R11-style closed-form check above; then the standard loop — the text-heavy per-face program
re-run on a path for all 36 faces, two independent processes, zero differing hashes — plus a
`leafBounds` assertion that the declared box contains every drawn glyph, checked against the rendered
alpha rather than against the same arithmetic that produced it.

Profile change, when it happens: `limits.maxPathTextGlyphs`; `ranges`/`quantize` for whatever the
curve generators need (`bulge` and `wave` would add two field names; `arc` reuses `r` and
`startAngle`, both of which already exist and already mean this). Hash consequence: `default-v1`
moves, `default-v0` untouched.
