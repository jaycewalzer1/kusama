# Trait table

One row per trait of each target look. **Achieved** means the substrate produces the thing itself.
**Faked** means it was approximated with a primitive not designed for it and would not survive close
viewing — the standard applied is a 2x crop, and every "faked" below was checked at 2x.
**Impossible** means no combination of the seven primitives produces it at all.

Rendered evidence: `out/substrate-test/probe-goldens/*.png` (pixel hashes in
`out/substrate-test/manifest.json`).

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

## Totals

| probe | achieved | faked | impossible |
| --- | ---: | ---: | ---: |
| xerox-zine | 2 | 3 | 0 |
| ur-stencil | 3 | 1 | 1 |
| ransom-note | 2 | 3 | 1 |
| rave-flyer | 1 | 3 | 1 |
| crass-collage | 2 | 1 | 2 |
| ikeda-austerity | 5 | 1 | 0 |
| **total** | **15** | **12** | **5** |

The distribution is the finding. `ikeda-austerity` is 5/6 achieved because it asks for hard-edged
geometry and nothing else. `xerox-zine`, `ransom-note` and `rave-flyer` are majority-faked because
all three want something done *to* an image after it exists. `crass-collage` has the two hardest
impossibles because it wants photographic material the pack does not contain.

## One more finding, from the batch rather than the traits

Across five seeds each, all 30 probe renders have **distinct pixel hashes** — and are **visually
near-identical**. See `out/substrate-test/sheets/probes-all-30.png`: only `ikeda-austerity` varies
in a way a viewer would notice, and only because its punched data band uses a scatter layout. This
is a direct consequence of the trait table. The primitives that get you print culture (`solid`,
`text`, hand-authored polygons) are precisely the ones that never consult the RNG, so **the closer
a program gets to looking like print, the less the seed does.** A generative system that cannot
vary its output within a style is a template, not a medium.
