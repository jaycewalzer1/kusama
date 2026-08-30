# Trait table

> **This is the v0 table and it is the *before*.** The same twelve probes were re-authored against
> `default-v1` / `core-v1` and re-scored in **`trait-table-v1.md`**, which carries the before/after
> per row. Nothing here has been edited: overwriting it would have destroyed the only thing the
> re-score measures against. Totals moved **35 / 22 / 11 → 53 / 10 / 5** on these 68 rows, and
> **62 / 11 / 5** across the 78 rows v1 makes expressible.

One row per trait of each target look. **Achieved** means the substrate produces the thing itself.
**Faked** means it was approximated with a primitive not designed for it and would not survive close
viewing — the standard applied is a 2x crop, and every "faked" below was checked at 2x.
**Impossible** means no combination of the seven primitives produces it at all.

Rendered evidence: `out/substrate-test/probe-goldens/*.png` (pixel hashes in
`out/substrate-test/manifest.json`).

Each of the six targets has **two** probes. The `-b` probe is not a variation on the `-a` probe: it
is a different object built a different way, authored after the first table was written, to test
whether a judgement of "faked" or "impossible" was a fact about the substrate or a fact about the
first thing that happened to be tried. Three rows moved as a result and each is called out where it
occurs.

## xerox-zine — pixels `f7243f5a47a5`

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| High contrast, true black on paper | **yes** | | |
| Degraded edge | | **yes** — a `cover` polygon bites a hard notch out of the plate, but it is a clean 7-gon. At 2x the "damage" is a straight-sided shape. | |
| Generational loss | | **yes** — 190 toner flecks and 180 paper dropouts *drawn on top of* clean marks. At 2x the type is perfectly crisp with rectangles lying on it. Nothing is a degraded copy of anything. | |
| Typewriter text | | **yes** — PT Serif Regular tracked out. No monospace, no ribbon fade, no uneven baseline. | |
| Paper tone | **yes** — `wash` at low opacity over a warm ground is exactly what `wash` is for. | | |

## ur-stencil — pixels `4d58c283303e`

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Two-colour plus one accent | **yes** | | |
| Stencil cut (bridges through letterforms) | | **yes** — three ground-coloured bars laid *over* the word. Correct only because the ground is flat; over any texture it would be three grey bars. | |
| Misregistration | **yes** — a second `text` op at (405.5, 425) against (400, 420). Real, half-pixel-quantised, and it survives any crop. | | |
| Text as coordinates and orders | **yes** | | |
| No polish / crudeness | | | **no** — every edge on this sheet is machine-exact. The substrate cannot be clumsy on purpose: `solid` is perfect and brush styles are *pretty*, and there is nothing between them. |

## ransom-note — pixels `c9d198f1c800`

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Letters cut individually and re-set | **yes** — eight independent groups, each with its own translate, rotate and uniform scale. | | |
| Mismatched size | **yes** — 82 to 104pt across the slogan, plus per-letter scale. | | |
| Mismatched face | | **yes** — two faces exist, both Regular. Real ransom notes mix ten faces and four weights; this mixes two and fakes the rest with rotation. | |
| Torn edge | | **yes** — hand-authored 14-point polygons. Convincing at thumbnail, obviously polygonal at 2x: straight segments, no fibre, no white core showing through the tear. | |
| Overprint (ink on ink) | | | **no** — `profile.blendModes` is `[]`. There is no multiply and no transparency that darkens. The red is a solid shape *behind* the paper patch, which is misregistration, not overprint. |
| Newsprint halftone screen | | **yes** — a `field` of `rotring` dots at fixed density. Not a screen: no dot-size modulation, no angle, no relationship to any image. A real crosshatch screen was tried and refused at 60,681 marks against a 60,000 budget. | |

## rave-flyer — pixels `62406d3d427e`

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Stretched / distorted display type | | **yes** — 96 translated copies of one text op smear TRESOR downward 144px. It reads as extrusion, which is a real flyer move, but the letterforms themselves are untouched. | |
| Non-uniform type scaling (condensed, stretched) | | | **no** — `transform.scale` is uniform only and there is no skew. |
| Dense information block | | **yes** — `maxTextLength: 240` forced two ops with a hand-chosen gap between them. A real dense block is one column of continuous copy at 8pt. | |
| One saturated colour on black | **yes** | | |
| Cheap-reproduction feel | | **yes** — a `wash` of grime over the ground. The type and bars are still pristine. | |

## crass-collage — pixels `3ce4f610aa22`

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Photographic / found material | | | **no** — the pack has fifteen hand-drawn vector outlines and nothing else. `animal.bird` at span 300 reads as a white blob. There is no image input of any kind in the program schema. |
| Continuous tone | | | **no** — `hatch` has a fixed spacing and no tonal ramp. It is engraving. There is no gradient style and no way to modulate a fill across a region. |
| Layering as argument | **yes** — stacking order is the substrate's native strength, and architecture-behind / crowd-beneath / sponsors-on-top is legible as an argument. | | |
| Clean type against dirty image | **yes** — the type genuinely is clean, because `text` is a plain p5 fill. | | |
| Type knocked out of an image | | **yes** — the caption is drawn in paper colour on a paper bar over the plate. Works because the plate is flat; over the hatched columns it would fail. | |

## ikeda-austerity — pixels `1599a5f9d110`

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Near-empty field | **yes** | | |
| Hairline rules | **yes** — one-device-pixel `solid` rects, hard-edged because antialiasing is off. Note this is *not* the `rule` primitive, which is a brush line with grain. | | |
| Data field with irregular structure | **yes** — 168 bars with 96 ground-coloured bars scattered back through them. | | |
| Tiny monospaced data | | **yes** — PT Sans Regular with a space between every character. Reads as tabular at a distance; the columns do not actually align, and 6pt is the floor. | |
| One interruption | **yes** | | |
| Absolute flatness | **yes** — the whole sheet is `solid` and `text`, so every value on it is exactly a palette colour. | | |

## xerox-zine-b — pixels `99b36e56dc3e`

A full-bleed black plate with everything reversed out of it, instead of black marks on white paper.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| High contrast, true black on paper | **yes** | | |
| Paper tone | **yes** | | |
| Type reversed out of the plate | **yes** — `text` carries its own colour and never consults the ground, so knocking type out of a plate is exactly as cheap as printing it on one. | | |
| Degraded edge | | **yes** — but this is the row that **moved**. On a full-bleed plate, `cover` stops being a trick that only works over blank ground and becomes a real subtraction: the torn corner is genuinely absent toner, not paper-coloured paint over a flat area. It is still a clean 10-gon at 2x, so it stays faked — but for a different and smaller reason than in `xerox-zine`. | |
| Generational loss | | **yes** — 150 dropout flecks are clean paper rectangles lying on crisp type. Unchanged, and unchangeable without a post-process stage. | |
| Dense body copy | | | **no** — `maxTextOps` 12 and `maxTextLength` 240 make 66 lines of 8pt copy inexpressible, so both columns are `repeat`s of 4px bars with ground-coloured bars scattered back over them for the rag. It reads correctly at arm's length and is not text at all. |

## ur-stencil-b — pixels `8d6d50382077`

A square record label rather than a poster: the same lineage asked to leave the rectangle.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Two-colour plus one accent | **yes** | | |
| Radial placement | **yes** — the `ring` layout places by angle, and it is the only placement in the substrate that is neither a grid nor a line. | | |
| A true hole at the centre | **yes** — `cover` at `softness: 0` over flat ground. The one place in the whole test where the substrate's only subtractive op does exactly what is wanted. | | |
| Letter-spaced catalogue type | **yes** — `tracking` letter-spaces properly; the earlier probes hand-spaced with literal spaces and got uneven results. | | |
| A disc | | **yes** — and this row **moved twice**. An unclipped `solid` circle goes to p5's WEBGL `ellipse`, which tessellates at a fixed 25 segments regardless of radius, so at r 300 it is an obvious polygon. Wrapping it in a `clip` rect that contains it re-routes it through `regionPolygon` at 64 segments and it reads as a disc. Still a polygon, so still faked — but the difference between the two is the difference between unusable and fine. Evidence: `out/substrate-test/circle-detail/circ2/`. | |
| Text set on a curve | | | **no** — there is no text-on-path and no per-character placement, so the ring of catalogue type that defines this object had to become straight lines above and below the spindle. |

## ransom-note-b — pixels `69f4eb347b95`

One word down a whole page on cut strips, rather than a slogan hand-set across the middle of one.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Letters cut individually and re-set | **yes** — five groups, each with its own translate and rotate. Making the strip page-width rather than letter-width lets the type run at 142–158pt, which is closer to the real object than `ransom-note` got. | | |
| Mismatched stock | **yes** — paper, newsprint grey and one strip torn from a red page. | | |
| Torn edge | | **yes** — 24-point hand-authored polygons. Straight segments, no fibre, no white core. Unchanged from `ransom-note`. | |
| Mismatched face and weight | | **yes** — two faces, both Regular. Alternating serif and grotesque helps; it is still two, not ten. | |
| Fine rotation | | **yes** — `transform.rotate` quantises to a whole degree, so 1.5° is not available and the strips are more regular than cut strips are. | |
| Overprint (ink on ink) | | | **no** — `profile.blendModes` is `[]`. Unchanged. |

## rave-flyer-b — pixels `13acb6a246d4`

One ink photocopied onto yellow stock, instead of saturated colour printed on black.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| One ink on tinted stock | **yes** — and it is the cheapest way to make this substrate look like cheap printing, because it removes every decision the substrate is bad at. | | |
| Display type reversed out of a mass | **yes** | | |
| Radial ornament | **yes** — 48 ticks on a `ring`. | | |
| Cheap-reproduction feel | | **yes** — a `wash` of grime over the stock. The type and the disc are pristine. | |
| Dense information block | | **yes** — still two ops with a hand-chosen gap, forced by `maxTextLength: 240`. | |
| Non-uniform type scaling (condensed, stretched) | | | **no** — `transform.scale` is uniform and there is no skew. This is the hardest single limit in the whole test, because a flyer of this kind is *made of* distorted type. |

## crass-collage-b — pixels `297bafccab7c`

The same montage printed as a negative: white figures on a black field.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Found material that reads as found | **yes** — this row **moved**, and it is the most interesting move in the test. Inverting the plate turns the pack's vector outlines from bad photographs into good stencils: `figure.crowd` in white on black reads as a cut-out, because the eye stops asking a silhouette for detail. The capability did not change; the demand made of it did. | | |
| Layering as argument | **yes** | | |
| Clean type against dirty image | **yes** | | |
| Type knocked out of an image | | **yes** — bone type on a blood bar drawn over the top. Same fake as `crass-collage`. | |
| Photographic material | | | **no** — fifteen hand-drawn vector outlines and no image input in the schema. Inverting the plate makes them work *as stencils*; it does not make them photographs. |
| Continuous tone | | | **no** — `hatch` at a fixed spacing, no gradient style, no way to modulate a fill across a region. Every value on the sheet is exactly one of four palette colours. |

## ikeda-austerity-b — pixels `6603bf90958c`

The first probe reversed: black on white.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Near-empty field | **yes** | | |
| Hairline rules | **yes** — `solid` rects of `h: 1`. | | |
| Data field with irregular structure | **yes** — 132 paper rects scattered back through a black slab. | | |
| One interruption | **yes** | | |
| Absolute flatness | **yes** | | |
| Tiny monospaced data | | **yes** — PT Sans Regular letter-spaced with `tracking`. Reads as tabular at a distance; the columns do not align. | |

The point of this probe is what it did **not** find: nothing here is harder to draw on white than on
black. `solid` and `text` carry their own colour and never consult the ground, so the substrate's
competence is the hard-edged geometry, not the dark palette the first probe happened to use. At 571
marks and cost 187 it is the cheapest of the twelve and among the most convincing.

## Totals

| target | probe | achieved | faked | impossible |
| --- | --- | ---: | ---: | ---: |
| xerox | xerox-zine | 2 | 3 | 0 |
| | xerox-zine-b | 3 | 2 | 1 |
| Underground Resistance | ur-stencil | 3 | 1 | 1 |
| | ur-stencil-b | 4 | 1 | 1 |
| ransom note | ransom-note | 2 | 3 | 1 |
| | ransom-note-b | 2 | 3 | 1 |
| rave flyer | rave-flyer | 1 | 3 | 1 |
| | rave-flyer-b | 3 | 2 | 1 |
| Crass montage | crass-collage | 2 | 1 | 2 |
| | crass-collage-b | 3 | 1 | 2 |
| Ikeda austerity | ikeda-austerity | 5 | 1 | 0 |
| | ikeda-austerity-b | 5 | 1 | 0 |
| **total** | | **35** | **22** | **11** |

The distribution is the finding. Both Ikeda probes are 5/6 achieved because that target asks for
hard-edged geometry and nothing else. Both ransom-note probes are majority-faked because that target
wants ten faces and four weights and there are two faces and one weight. `crass-collage` keeps its
two hardest impossibles in both attempts because it wants photographic material the pack does not
contain.

## What the second attempt changed, and what it did not

Three rows moved between the `-a` and `-b` probe of a target, and all three moved because the
*argument* changed, not because the substrate did:

1. **`cover` becomes real subtraction on a full-bleed plate** (`xerox-zine-b`). Its documented
   limitation — it can only paint the ground colour — stops mattering when the ground is what you
   want back.
2. **A clipped circle is a 64-gon, an unclipped one is a 25-gon** (`ur-stencil-b`). This is not
   documented anywhere and was found by rendering a single circle to check. It is a real usability
   cliff: circles above about r 60 look broken until you know the trick.
3. **Inverting the plate makes the fragment library work** (`crass-collage-b`). Fifteen crude vector
   outlines are bad photographs and good stencils, and which one they are is decided by the
   surrounding page, not by the pack.

Nothing moved out of **impossible** in either direction. Every impossible in the first table is
still impossible in the second, in a differently-built program, which is the strongest evidence in
this document that those five are properties of the substrate rather than of the author.

## One more finding, from the batch rather than the traits

Across five seeds each, all 60 probe renders have **distinct pixel hashes** — and within a design
they are **visually near-identical**. See `out/substrate-test/sheets/probes-all-60.png`: twelve rows
of five, and only the rows whose data field uses a `scatter` layout vary in a way a viewer would
notice. This is a direct consequence of the trait table. The primitives that get you print culture
(`solid`, `text`, hand-authored polygons) are precisely the ones that never consult the RNG, so
**the closer a program gets to looking like print, the less the seed does.** A generative system
that cannot vary its output within a style is a template, not a medium — and doubling the probe set
doubled the number of designs without changing that at all, which is the point.
