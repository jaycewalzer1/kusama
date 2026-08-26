# Proposed additions

**Nothing in this document is implemented.** No file under `renderer/`, `env/`, `profiles/` or
`assets/` was touched by this investigation. This is a specification only.

## Ranked by how many probes each unblocks

Counted from `trait-table.md`: a capability "unblocks" a probe if it moves at least one row of that
probe's table out of the **faked** or **impossible** column.

| # | capability | probes unblocked | rows moved | kind | risk |
| ---: | --- | ---: | ---: | --- | --- |
| 1 | **`degrade`** — a per-pixel post-process pass (threshold, spread, dropout, generations) | 4 — xerox-zine, ransom-note, rave-flyer, crass-collage | 5 | new pipeline stage, Node-side | very low |
| 2 | more faces and weights in the asset pack (bold grotesque, condensed grotesque, monospace) | 4 — xerox-zine, ransom-note, rave-flyer, ikeda-austerity | 4 | **asset pack only — not a primitive** | none |
| 3 | **`stencil`** — a hard-edge per-pixel mask on a group | 4 — xerox-zine, ur-stencil, ransom-note, crass-collage | 4 | new node property, GPU | **high** |
| 4 | raster/photographic material in the pack, placeable by `fragment` | 2 — crass-collage (decisively), xerox-zine | 3 | asset pack + one op arg | medium |
| 5 | non-uniform `transform` (`scale: [sx, sy]`, `skew`) | 2 — rave-flyer, ransom-note | 2 | schema + resolve | low |
| 6 | `multiply` blend for true ink overprint | 2 — ransom-note, crass-collage | 2 | renderer + profile `blendModes` | high |
| 7 | tonal / gradient fill style | 1 — crass-collage | 1 | new PaintStyle | medium |

Two things the brief expected to find missing are **already present** and need no work:

- **True high-contrast black.** `solid` at opacity 255 goes through plain p5 `fill` with
  antialiasing off. `#0d0d0d` renders as exactly `#0d0d0d` with a one-pixel edge.
- **Misregistration offset.** Two ops at coordinates differing by 0.5px, or a `group` with a
  `transform.translate`, already give a real second impression. `ur-stencil` and `ransom-note` both
  do it, and it survives any crop.

**Row 2 should be done before either specced item below.** Three more font files change the pack
hash and nothing else — no new primitive, no schema change, no determinism surface at all — and it
moves four "faked" rows on four different probes. It is not specced here because the brief asked
for primitives, but it is the cheapest change in this document by a very large margin.

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
