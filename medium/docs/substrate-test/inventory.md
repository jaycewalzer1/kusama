# Capability inventory

What the substrate can and cannot make, read off the code rather than remembered. Every number
below comes from `profiles/default.profile.json` (`default-v0@15ad87c16095`),
`schema/program.schema.json`, `schema/paintstyle.schema.json`, `assets/packs/core`
(`core@003e484d9602`), `renderer/ops.js`, `renderer/macros.js` and `env/profile.ts`.

## The three facts that decide everything below

1. **Only two styles draw with plain p5, and they are the only two with a hard edge.**
   `applyStyle` (`renderer/ops.js:73`) returns `'native'` for `solid` and nothing else; `opText`
   also calls `p.fill` / `p.noStroke` directly. Everything else goes through `brush.*`, which is
   p5.brush's pigment pipeline. Since `setAttributes('antialias', false)` is called after
   `createCanvas` (NOTES R6), a `solid` edge is a stair-stepped one-pixel transition and a brush
   edge is not. **Print culture lives on hard edges, so print culture in this medium lives in
   `solid` and `text`.**
2. **There is exactly one subtractive operation and it paints, it does not erase.** `cover`
   (`renderer/ops.js:243`) fills the region with `ctx.ground` using plain p5. It cannot restore
   anything except the canvas ground colour, so it only works over untouched ground. There is no
   mask, no clip-to-shape (clip is rect-only geometric intersection), no knockout, no blend mode
   (`profile.blendModes` is `[]`).
3. **Nothing is per-pixel.** There is no post-process pass anywhere in the pipeline. `render`
   reads back the framebuffer and hashes it; it never transforms it. Threshold, posterize,
   halftone, blur, noise, channel offset and levels are all absent, and there is nowhere in the
   current architecture for them to go.

## Primitives

### `wash`
`paint` under another name, restricted by convention to a `wash` style. `wash` sets
`brush.fill(color, opacity)` with `opacity` 0-255, `brush.fillBleed(bleed, 'out')` with `bleed`
0-0.6 on a 0.01 step, and `brush.fillTexture(t0, t1)` with both 0-1 on a **0.05 step**. It is the
only primitive whose entire purpose is watercolour, and it is the single most painterly thing here.
It produces soft mottled tone with an irregular bleeding edge, which is exactly right for stock
tone (dirty paper, a dull sheen on a black plate) and exactly wrong for anything with a boundary.
Marks estimate `40 + bleed*400`; cost weight 3, so it is among the most expensive things per unit
area. **Cannot** produce a flat tint, a hard edge, a gradient, or a tint of a *known* value —
`opacity` 34 over `#e2ded2` is not a computable colour, it is whatever the pigment shader does.

### `paint`
The general one, and the workhorse. Takes a `region` (rect / circle / polygon of 3-80 points /
`fragmentPlacement`) and any of the five styles. With `solid` it is a hard-edged flat fill at a
known colour and a known alpha, and rects, circles and arbitrary polygons are all available — this
one combination is responsible for nearly everything in `ikeda-austerity`, every bar and knockout
in `rave-flyer`, every chevron and bridge in `ur-stencil`, and every torn edge in `ransom-note`.
With `hatch` it fills the region with ruled brush lines at `spacing` 1-60 (profile 1.5-40, step
0.5), `angle`, `rand` 0-1 and `layers` 1 or 2, the second layer at `angle + 90`. With `field` it
scatters `density * area / 1000` marks (`density` 0.05-20, step 0.05) as `dots`, `dashes` or
`scribble`. With `outline` it is a single brush contour at `weight` 0.1-12. **Cannot** do a
gradient, a non-uniform scale, a rounded rect, a bezier region, or a region with a hole.

**A `solid` circle is a 25-gon, and this is visible.** `drawRegion` (`renderer/ops.js:58-62`) sends
an unclipped native circle to `p.ellipse`, and p5's WEBGL ellipse tessellates at a **fixed** 25
segments (`ellipseDetail`'s default; the medium never calls `ellipseDetail`, and p5.brush does not
patch `ellipse` — the string does not occur in `vendor/p5.brush.js`). The segment count does not
scale with radius, so with antialiasing off a circle of r 180 is a hard-edged polygon whose flats
are about 45px long. Verified with a minimal one-circle program: `out/substrate-test/circle-detail/circ/`
(pixels `f635d3dc3ac2`).

Every **other** circle path in the renderer uses `CLIP_CIRCLE_SEGMENTS = 64`
(`renderer/resolve.js:192`): `cover` circles (`ops.js:245`), `field`-style circles (`ops.js:132`),
and any circle inside a **clipped** group (`ops.js:66`). So the workaround is to wrap the circle in
a `group` with a `clip` rect that fully contains it — the clip removes nothing and the circle is
re-routed through `regionPolygon` at 64 segments. Verified side by side in
`out/substrate-test/circle-detail/circ2/` (pixels `07529fc84cf5`): same radius, left plain and faceted, right
clipped and round. The cost is that `text` is refused inside a clipped group, so the clip must wrap
the circles only.

This qualifies fact 1 above: `solid`'s hard edge is *exact* for rects and authored polygons, and for
circles it is exactly a 25-gon rather than exactly a circle.

### `stroke`
2-120 points, one brush from the eleven (`pen rotring 2B HB 2H cpencil pastel crayon charcoal
spray marker`), `weight` 0.1-12, `closed`, and `curve` 0-1 fed to `brush.beginShape`. It is the
gestural primitive. Everything it draws has visible brush grain and a soft, slightly wandering
edge, which reads as *drawing*, never as *printing*. In the probes it appears exactly once, as the
pin wire in `ransom-note`, because a punk flyer that shows a pencil line stops being a punk flyer.
**Cannot** be dashed, cannot vary weight along its length, cannot be filled, cannot be hairline
(the brush stamp has width even at `weight` 0.1).

### `fragment`
Places one of the pack's fifteen shapes — `figure.standing figure.seated figure.crowd hand.open
hand.pointing animal.bird animal.dog arch.arch arch.column object.bowl debris.shard light.beam
mark.sponsor-a/-b/-c` — at `x, y` (centre), `span` (unit-box size, 0-4000), optional `rotate`
-360..360 and `flipX`, with any style. `maxFragments` is 40. The fragment is a closed polygon
derived from hand-drawn control points through Chaikin smoothing (NOTES O4), so with `solid` it is
a clean silhouette and with `hatch` it is an engraving. **This is the whole of the found-material
budget and it is not photographic.** Fifteen vector outlines cannot supply a face, a crowd
photograph, a bombed street, a royal portrait or a magazine cutting, which is what a Vaucher
montage or a Reid sleeve is *made of*. At small sizes the shapes read as abstract blobs;
`animal.bird` at span 300 in `crass-collage` does not read as a bird.

### `text`
`text`, `font` (`grotesque` = PT Sans Regular, `serif` = PT Serif Regular — **two faces, one weight
each, no bold, no italic, no condensed, no monospace**), `size` 6-300 on a 0.5 step, `x`, `y`,
`color`, and optional `align` (left/center/right), `tracking` -5..40 on a 0.05 step, and
`maxWidth` 20-4000. Drawn with plain p5 `fill` at full opacity, so type is the second hard-edged
thing in the medium and the sharpest thing on any of these sheets. Limits bite hard:
`maxTextOps: 12` counted **per source node**, `maxTextLength: 240` characters, leading fixed at
`size * 1.25`, no `\n` handling (a newline renders as one line), and no per-character colour or
position. Two workarounds are load-bearing in these probes: a space has zero advance width in the
WEBGL text path so word gaps must be **three spaces** *and* enough `tracking` to be visible
(NOTES E3); and a `repeat` wrapping a text op costs one text op, which is what makes the extruded
type in `rave-flyer` affordable.

### `rule`
`from`, `to`, `brush`, `color`, `weight` 0.1-12. A single straight `brush.line`. Because it is a
brush line it has grain and a soft edge, which means **a `rule` is not a hairline** — a true
one-pixel hairline has to be a `solid` rect of `h: 1`, which is what `ikeda-austerity` does for
every rule on the sheet. `rule` is useful when you want the line to look ruled by hand.

### `cover`
`region` plus `softness` 0-0.6 (step 0.01). Paints `ctx.ground` back over the region with plain p5.
At `softness: 0` it is a single hard-edged ground-colour polygon, which is the only true
knockout available and is what cuts the torn bite out of the `xerox-zine` plate and the zigzag out
of the `ransom-note` masthead. Above 0 it draws `COVER_LAYERS = 6` nested copies scaled from
`1 + s/2` down to `1 - s/2` with rising alpha, giving a geometric soft edge. Marks estimate
`40 + softness*400`, cost weight 3. **Cannot** cover with anything but the ground colour, cannot
follow a non-polygon boundary, and cannot be used over another mark without destroying it.

## Macros

### `frame`
A border around a rect in three styles: `full` (four `rule`s), `corners` (eight `rule`s forming
four L brackets, `arm` defaulting to `min(w,h)*0.12`), `dots` (`count` circles, default 12, radius
default 3, walked around the perimeter as `solid` fills). `corners` is genuinely useful here — crop
marks and registration brackets are print-culture vocabulary, and `ur-stencil` uses it as trim.
`full` and `dots` are decorative and read as illustration.

### `motif`
The pack defines exactly one motif, `hibiscus`. It is a flower. It has no use in any of these six
probes and was not placed on any of them.

### `quarantine`
A `paint` of the region in a given style, four `rule`s boxing it, and an optional centred `text`
label placed **below** the box at `y + h + labelSize + 6`. It is the closest thing the substrate has
to a caption-with-a-box, which is a real print form (a notice, a legal warning, a specimen block),
and it earns its place on three of the six probes. Its label is a text op like any other, so the
three-space rule and the 240-character limit apply.

## Budgets that shaped the probes

| limit | value | where it bit |
| --- | --- | --- |
| `maxEstimatedMarks` | 60,000 | A full-page fine halftone screen is **arithmetically impossible**. `ransom-note` at `hatch` spacing 6 / layers 2 estimated 60,681 marks and was refused. At spacing 10 it passed at 38,182 but read as gingham. The final `field`-of-dots ground costs 22,403. |
| `maxTextOps` | 12 (source nodes) | Caps a hand-set ransom slogan at eleven letters. Does **not** cap `repeat`ed text, which is the loophole `rave-flyer` uses. |
| `maxTextLength` | 240 chars | Split the `rave-flyer` door policy into two ops; a genuinely dense info block wants one flowing column. |
| `maxRepeatInstances` | 400 | `ikeda-austerity` uses 368 and `xerox-zine` 379. A denser data field or a finer fleck scatter is out of reach. |
| `maxFragments` | 40 | Not binding. The binding constraint is that there are only fifteen fragments to choose from. |
| `maxPolygonPoints` | 80 | Not binding. Torn edges at 14-18 points are already convincing. |
| `transform.scale` | uniform only | No type stretching, no condensing, no skew. This is the single hardest limit on `rave-flyer`. |
| quantize steps | `x/y/w/h` 0.5px, `texture` 0.05, `tracking` 0.05, `opacity` 1 | Half-pixel misregistration is available (`ur-stencil` prints red at x 405.5 against steel at 400). Sub-half-pixel is not. |

## What the substrate is actually good at

Hard-edged flat geometry in a small palette, and type set cleanly on top of it. That is a real and
specific competence, and it happens to be most of Raster-Noton and a good deal of Underground
Resistance. It is not most of xerox, ransom-note or photomontage, because those three are all
about *what happens to an image after it is made*, and this substrate has no after.
