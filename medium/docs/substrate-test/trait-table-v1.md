# Trait table — v1 re-score

The same twelve probes, re-authored against `default-v1@be50e7c6f0a6` / `core-v1@dd47bb1c2e34` and
re-scored. `trait-table.md` is the v0 table and is left exactly as it was: it is the *before*, and
overwriting it would have destroyed the only thing this document is measuring against.

Rules are unchanged. **Achieved** means the substrate produces the thing itself. **Faked** means it
was approximated with a primitive not designed for it and would not survive a 2x crop. **Impossible**
means no combination of the primitives produces it at all.

Programs: `examples/probes/v1/*.json`, one findings file each beside them.
Pixels: `out/substrate-test/probe-goldens-v1/` — twelve goldens, pinned once and then confirmed by a
second, independent `golden --check` process. Seed sheet: `out/substrate-test/sheets/probes-all-60-v1.png`.

**A caveat that belongs at the top.** The twelve probes were authored by six agents working in
parallel, and renders are strictly serial (NOTES R8), so none of the authors could render. Rows
marked *predicted* in the findings files are arguments from `env/print.ts` and `renderer/resolve.js`,
not from pixels. The programs validate and the goldens are pinned and repeat; what has not been done
is a human looking at all twelve at 2x and disagreeing with an author. Treat every *predicted* row as
one confirmation short.

---

## xerox-zine — pixels `fb0eb7c565b9` (was `f7243f5a47a5`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| High contrast, true black on paper | achieved | **achieved** | `generation` now guarantees it for the whole sheet rather than leaving it to whichever style was opaque. The later `paper` stage lifts black to ~`#262524`. |
| Degraded edge | faked | **achieved** | `tear` resamples the bite into ~120 six-unit segments and displaces each along its normal. Geometry, not a drawn approximation. |
| Generational loss | faked | **achieved** | `generation` at 3 passes runs each blur-and-cut on the previous pass's output. The author's own scepticism is worth keeping: at `spread: 0` only the last pass's dropout survives, so the iteration buys stroke rounding rather than compounding noise. |
| Typewriter text | faked | **achieved** | `special-elite` for the body with per-glyph `jitter` off the node's `glyph` stream; `courier-prime` for the deck. |
| Paper tone | achieved | **achieved** | By a different mechanism: `generation` flattens the v0 `stock` wash to the ground, so the node that earned this row survives only in `trace.plate` and the `paper` stage carries the tone. |
| Toner dropout inside letterforms | — | **achieved** *(new)* | v0's prose called this impossible: "the flecks can only sit on top of the type ... there is no mask and no per-pixel operation". `generation.dropout` is a per-pixel operation over the ink set. |

**2 / 3 / 0 → 6 / 0 / 0.**

## xerox-zine-b — pixels `1a37a4a202c8` (was `99b36e56dc3e`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| High contrast, true black on paper | achieved | **achieved** | Unchanged in construction; `generation` now makes it global. |
| Paper tone | achieved | **achieved** | Carried by the `paper` stage; the v0 `stock` wash is now invisible in `canonical.png`. |
| Type reversed out of the plate | achieved | **achieved** | Unchanged. |
| Degraded edge | faked | **achieved** | `tear` at roughness 0.85 / segment 14 displaces each vertex up to ~12px, corners included, so no straight run is left to read as a cut. |
| Generational loss | faked | **achieved** | `generation` at 2 passes. What no repeat could buy: the damage lands *inside* the reversed-out letterforms. |
| Dense body copy | impossible | **faked** | Genuine typesetting now — six `text` ops wrapped on `maxWidth` in `space-mono` with a real ragged right. Still faked, for a completely different reason: `maxTextLength` 240 and `maxTextOps` 12 cap it at ~980 characters where the object wants several thousand. Real copy at a model scale is not a dense column. |

**3 / 2 / 1 → 5 / 1 / 0.**

## ur-stencil — pixels `d9f973b9a511` (was `4d58c283303e`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Two-colour plus one accent | achieved | **achieved** | Still two plus one, but no area is *exactly* a palette colour any more: `grain` dithers every pixel. The flatness was given up on purpose. |
| Stencil cut (bridges through letterforms) | faked | **achieved** | `saira-stencil`. The bridges are counters in the glyph outlines, so they are the letterform rather than three ground-coloured bars laid over it, and they would survive over a texture. |
| Misregistration | achieved | **achieved** | Unchanged authored offset, plus a whole-sheet `misregister` stage on top. |
| Text as coordinates and orders | achieved | **achieved** | `space-mono` and `share-tech-mono`: the columns line up because the advance is fixed, not because the strings were chosen to look tabular. |
| No polish / crudeness | impossible | **faked** | `misregister` + `grain` mean no edge is machine-exact. But that is the *press* being crude, uniformly, after the image exists. Not one mark is drawn clumsily and one line still cannot be worse than the line beside it. |
| Overprint where the two plates overlap | — | **achieved** *(new)* | `blend: "screen"` on the misregistered pair: the band where steel crosses red resolves to a third value belonging to neither plate. `multiply` was rejected as arithmetically wrong on a `#0b0b0b` ground. |

**3 / 1 / 1 → 5 / 1 / 0.**

## ur-stencil-b — pixels `04fb0e1789e4` (was `8d6d50382077`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Two-colour plus one accent | achieved | **achieved** | Unchanged; the sheet is no longer exactly three flat values, which is the intended cost of `print`. |
| Radial placement | achieved | **achieved** | `ring` still places by angle and still has no sweep. Nothing in v1 touches this. |
| A true hole at the centre | achieved | **achieved** | `cover` at `softness: 0`, the one op still going to p5's 25-segment `ellipse`. At r 15 that is 0.12px of chord sag. |
| Letter-spaced catalogue type | achieved | **achieved** | Same `tracking`; the strings that most wanted it are now on faces that do not need it. |
| A disc | faked | **faked** | **This row did not move, and that is the finding.** `clip: {type:"circle"}` exists now, so the rect-that-removes-nothing hack is gone — but `regionPolygon` still tessellates at `CLIP_CIRCLE_SEGMENTS = 64`, so the geometry is the same 64-gon. The new capability bought clarity in the source, not pixels. |
| Text set on a curve | impossible | **impossible** | Unchanged. `text.rotate` turns a whole line about its anchor, which is a chord; there is no per-character placement; `maxTextOps: 12` would refuse one op per glyph anyway. |
| Monospaced matrix / runout numbers | — | **achieved** *(new)* | A matrix number is a stamped fixed-advance string, and `share-tech-mono` / `space-mono` make it one. |
| No polish / crudeness | — | **faked** *(new)* | Carried over from the poster: the press is crude, the hand is not. |

**4 / 1 / 1 → 5 / 2 / 1.**

## ransom-note — pixels `9d51216400d0` (was `c9d198f1c800`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Letters cut individually and re-set | achieved | **achieved** | Unchanged: eight sibling groups, each with its own translate, rotate and scale. |
| Mismatched size | achieved | **achieved** | Unchanged: 82–110pt chosen per letter. |
| Mismatched face | faked | **achieved** | Nine real faces across display, condensed, typewriter, mono and blackletter roles, plus `skew: 9` on the F. v0 had two, both Regular. |
| Torn edge | faked | **achieved** | Every cutting is a `fragment` with `tear` (roughness 0.5–0.85), then cut to a convex quad `clip`: two scissor edges and two torn ones. |
| Overprint (ink on ink) | impossible | **achieved** | A second `misprint`-coloured impression inside a `blend: "multiply"` group, offset 16–24 units, yielding four distinct products against yellow, pink, paper and ground. v0 recorded this impossible because `blendModes` was `[]`. |
| Newsprint halftone screen | faked | **faked** | Deliberately left as the v0 `field` of dots. `halftone` is whole-canvas and strictly two-tone, so screening this sheet would erase the colour the overprint row depends on. The real screen is tested on `-b` instead. |

**2 / 3 / 1 → 5 / 1 / 0.**

## ransom-note-b — pixels `2510006b168e` (was `69f4eb347b95`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Letters cut individually and re-set | achieved | **achieved** | Unchanged. |
| Mismatched stock | achieved | **achieved** | Under this probe's halftone the three stocks read as three dot densities — 0.094 / 0.282 / 0.717 against a 0.944 ground. That is the correct newsprint reading of mixed stock, not a workaround. |
| Torn edge | faked | **achieved** | Five overlapping torn `object.bowl` fragments inside a rect clip: both long edges ripped, both ends square-cut. Caveat: this is *assembly*. No pack fragment is near 5:1 and `span` scales uniformly, so a page-width torn shape has to be tiled. |
| Mismatched face and weight | faked | **achieved** | Five faces, five weights. v0 ran one face at five sizes. |
| Fine rotation | faked | **faked** | `rotate` and `skew` still quantize to 1 whole degree in `default-v1`. Nothing in v1 moves this row. |
| Overprint (ink on ink) | impossible | **faked** | Mechanism achieved — a real `multiply` group — so v0's "impossible" is retired. But this probe's own halftone collapses red-on-red to 0.79 against red's 0.717, about one dot diameter. Scored faked because the *evidence* is gone even though the capability is not. |
| Newsprint halftone screen | — | **achieved** *(new)* | A real `halftone` stage, `cell: 4`, `angle: 15`, run in Node after the render is proven. v0's field of drawn dots was refused at 60,681 marks against a 60,000 budget; this probe costs 439. |

**2 / 3 / 1 → 5 / 2 / 0.**

## rave-flyer — pixels `0cfcf576afd8` (was `62406d3d427e`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Stretched / distorted display type | faked | **achieved** | The distortion is on the glyphs: `stretch: [1.45, 2]` on TRESOR, `skew: 14` with `stretch: [1.55, 0.95]` on the line below. |
| Non-uniform type scaling (condensed, stretched) | impossible | **achieved** | `stretch` takes `[sx, sy]` independently. This is mechanical distortion of one cut — stems thicken and thin with the axis — which is what a photocopier did, and is the right wrongness for this target. |
| Dense information block | faked | **faked** | Unchanged, and now measured: the copy is 258 characters and merging the two ops was tried and refused with `limit.textLength` at 240. |
| One saturated colour on black | achieved | **achieved** | The extrusion group is now `blend: "screen"`, so 24 copies accumulate toward the acid instead of overpainting: exposure rather than paint. |
| Cheap-reproduction feel | faked | **achieved** | `misregister` + `grain` + `paper` act on the finished canvas. The v0 fake was a wash drawn *under* pristine type; that is the whole difference. |

**1 / 3 / 1 → 4 / 1 / 0.**

## rave-flyer-b — pixels `f6d0d7e52ca4` (was `13acb6a246d4`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| One ink on tinted stock | achieved | **achieved** | Two palette entries do the whole sheet and `generation`'s `dark`/`light` are those same two, so the print pass invents no third colour. |
| Display type reversed out of a mass | achieved | **achieved** | The disc is now clipped by `{type:"circle"}` rather than a rect that happened to contain it. Both routes are 64 segments, so this buys honesty rather than pixels. |
| Radial ornament | achieved | **achieved** | 48 ticks on a `ring`, unchanged. |
| Cheap-reproduction feel | faked | **achieved** | `generation` at 3 passes. The foot has said PHOTOCOPIED NOT PRINTED since v0, where the v0 note called it "a caption, not a fact". It is now a description of what happened to the image. |
| Dense information block | faked | **faked** | `maxTextOps` and `maxTextLength` did not move. |
| Non-uniform type scaling (condensed, stretched) | impossible | **achieved** | `stretch: [0.68, 1.6]` on one line and `[1.62, 0.88]` with `skew: -10` on the next. v0 called this "the hardest single limit in the whole test". |

**3 / 2 / 1 → 5 / 1 / 0.**

## crass-collage — pixels `3a99bc39ec1f` (was `3ce4f610aa22`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Photographic / found material | impossible | **impossible** | Fifteen hand-drawn vector outlines and still no image input anywhere in the schema. `posterize` cannot help: the plate is flat, so quantising it is near a no-op. |
| Continuous tone | impossible | **impossible** | The *reason* moved. `paper.vignette` is a genuine smooth radial ramp and `grain` genuine per-pixel noise, so intermediate values now exist on the sheet — there is still no way to **place** one. |
| Layering as argument | achieved | **achieved** | Stronger: `screen` makes the smoke columns visible against the black plate at all, so the reading has three legible strata rather than two. |
| Clean type against dirty image | achieved | **achieved** | Six faces doing six jobs. Caveat: the print pass is global, so at 2x the 12pt caption carries the same channel fringes as the picture. |
| Type knocked out of an image | faked | **faked** | Kept unchanged as the control. `screen` with paper-coloured type leaves a residue that varies with what is under it and goes invisible over the paper silhouettes: a knockout needs ink to remove, and there is no glyph-shaped `cover`. |
| Cut and torn edges | — | **achieved** *(new)* | `tear` on the beams and columns, seeded per node *and per repeat instance*, so three beams rip three ways from one authored edge; the plate is cut off square by a polygon clip. A scalpel and a rip, and they are different edges. |
| Light laid over dark | — | **achieved** *(new)* | NOTES L4 says p5.brush mixes pigment so light cannot be laid over dark. v0 got a grey hatch onto a black plate by luck of the mix; `screen` is the first mechanism that means it. |
| Off-register printing | — | **achieved** *(new)* | The `misregister` stage, offsets drawn from the print stream rather than typed. Caveat: it displaces R, G and B, not ink plates, so it models this sheet well and would not model a four-colour one. |

**2 / 1 / 2 → 5 / 1 / 2.**

## crass-collage-b — pixels `839de1535aca` (was `297bafccab7c`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Found material that reads as found | achieved | **achieved** | Still the inversion doing the work. `tear` adds a second reason: a bone slab with a ripped edge on black reads as something removed from a page. |
| Layering as argument | achieved | **achieved** | Unchanged. |
| Clean type against dirty image | achieved | **achieved** | Same global-print caveat as the `-a` probe: at 2x the caption is no longer clean. |
| Type knocked out of an image | faked | **faked** | `multiply` with the ground colour would knock type out over *any* background, which is exactly what v0 could not do — but multiply by `#0b0b0c` returns `(8,1,1)` over the blood, so the letterform comes out **darker** than the paper it is pretending to be. Computed, not shipped. |
| Photographic material | impossible | **impossible** | Unchanged. |
| Continuous tone | impossible | **impossible** | Unchanged; the print pass makes real intermediate values but neither can be aimed at a shape. |
| Cut and torn edges | — | **achieved** *(new)* | Polygon clip on the architecture, `tear` on the columns and the beam. |
| Light laid over dark | — | **achieved** *(new)* | A negative *is* light over dark. v0 got away with it only because `solid` bypasses the brush; the two marks that did go through a brush were the two weakest things on the sheet. |

**3 / 1 / 2 → 5 / 1 / 2.**

## ikeda-austerity — pixels `5f089b6ecf17` (was `1599a5f9d110`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Near-empty field | achieved | **achieved** | Slightly emptier: the real strings are about half the measure of the letter-spaced ones. |
| Hairline rules | achieved | **achieved** | Unchanged one-device-pixel `solid` rects. Still not the `rule` primitive. |
| Data field with irregular structure | achieved | **achieved** | The same 168 bars and the same 96 seeded punches. |
| Tiny monospaced data | faked | **achieved** | `ibm-plex-mono` is a real fixed-advance face, so the columns genuinely align rather than reading as aligned. The fake was not free: it cost 152 glyph-marks to spell the same strings (805 → 653). |
| One interruption | achieved | **achieved** | Unchanged. |
| Absolute flatness | achieved | **achieved** | Deliberately not risked — no print stage, because every stage writes non-palette values. **v0 was generous here:** `plate` is a `wash` at opacity 18, so the row is 99.9% flat, not flat. Left as-is rather than change the object. |

**5 / 1 / 0 → 6 / 0 / 0.**

## ikeda-austerity-b — pixels `c35c9728f5d2` (was `6603bf90958c`)

| trait | before | after | note |
| --- | :---: | :---: | --- |
| Near-empty field | achieved | **achieved** | Unchanged. |
| Hairline rules | achieved | **achieved** | Unchanged. |
| Data field with irregular structure | achieved | **achieved** | Same 132 punches from the same seed. |
| One interruption | achieved | **achieved** | Unchanged. |
| Absolute flatness | achieved | **achieved** | Here the claim is exact — no wash on this sheet at all, every value is one of four palette colours. |
| Tiny monospaced data | faked | **achieved** | The same face as the black variant, so the only difference between the two sheets is still the palette. 571 → 411 marks: the fake cost 160 glyph-marks, because a space between every character is a character. |

**5 / 1 / 0 → 6 / 0 / 0.**

---

## Totals

| target | probe | before A/F/I | after A/F/I | new rows |
| --- | --- | ---: | ---: | ---: |
| xerox | xerox-zine | 2 / 3 / 0 | **6 / 0 / 0** | +1 |
| | xerox-zine-b | 3 / 2 / 1 | **5 / 1 / 0** | — |
| Underground Resistance | ur-stencil | 3 / 1 / 1 | **5 / 1 / 0** | +1 |
| | ur-stencil-b | 4 / 1 / 1 | **5 / 2 / 1** | +2 |
| ransom note | ransom-note | 2 / 3 / 1 | **5 / 1 / 0** | — |
| | ransom-note-b | 2 / 3 / 1 | **5 / 2 / 0** | +1 |
| rave flyer | rave-flyer | 1 / 3 / 1 | **4 / 1 / 0** | — |
| | rave-flyer-b | 3 / 2 / 1 | **5 / 1 / 0** | — |
| Crass montage | crass-collage | 2 / 1 / 2 | **5 / 1 / 2** | +3 |
| | crass-collage-b | 3 / 1 / 2 | **5 / 1 / 2** | +2 |
| Ikeda austerity | ikeda-austerity | 5 / 1 / 0 | **6 / 0 / 0** | — |
| | ikeda-austerity-b | 5 / 1 / 0 | **6 / 0 / 0** | — |
| **total** | | **35 / 22 / 11** (68 rows) | **62 / 11 / 5** (78 rows) | **+10** |

Ten rows are new — capabilities that did not exist in v0, so no v0 probe could have a row for them.
Nine of the ten are achieved; the tenth (`ur-stencil-b` / no polish) is faked. Scoring **only the
original 68 rows**, so that the before and after count the same things:

| | achieved | faked | impossible |
| --- | ---: | ---: | ---: |
| v0 | 35 | 22 | 11 |
| v1, same 68 rows | **53** | **10** | **5** |

Fifteen rows moved faked → achieved. Three moved impossible → achieved. Three moved impossible →
faked. Nothing moved backwards.

### The six impossibles that fell

| probe | trait | to | what did it |
| --- | --- | :---: | --- |
| ransom-note | Overprint (ink on ink) | achieved | `blend: "multiply"` |
| rave-flyer | Non-uniform type scaling | achieved | `text.stretch` |
| rave-flyer-b | Non-uniform type scaling | achieved | `text.stretch` |
| ur-stencil | No polish / crudeness | faked | `misregister` + `grain` |
| ransom-note-b | Overprint (ink on ink) | faked | `multiply`, then flattened by the same sheet's `halftone` |
| xerox-zine-b | Dense body copy | faked | `maxWidth` wrapping — real typesetting, still too little of it |

### The five that did not

| probe | trait | why |
| --- | --- | --- |
| ur-stencil-b | Text set on a curve | No per-character placement. Deliberately not shipped today — see `proposed-primitives.md`. |
| crass-collage | Photographic / found material | No image input in the schema. Fifteen vector outlines is what the pack has. |
| crass-collage-b | Photographic material | Same. |
| crass-collage | Continuous tone | The print pass makes intermediate values; nothing can aim one at a shape. |
| crass-collage-b | Continuous tone | Same. |

v0's strongest claim was that "nothing moved out of impossible in either direction ... which is the
strongest evidence in this document that those five are properties of the substrate rather than of
the author." That claim was about a *fixed* substrate and it held. Six of eleven fell the moment the
substrate moved, which is the correct outcome: they were properties of `default-v0`, not of the idea
of a deterministic plotter. The five that remain are of a different kind — two are the absence of an
input format, two are the absence of a way to place a value, and one is the absence of per-glyph
placement. None of them is a taste judgement and none was reachable by trying harder.

## What v1 did not give, that the probes kept asking for

Three constraints were hit by more than one probe, independently, by authors who could not see each
other's work. They are the shortlist for whatever comes next, and none of them is a new primitive.

1. **The print pass has no region.** `halftone`, `threshold` and `generation` each map every pixel to
   one of two colours, so all three are unavailable to any sheet that carries a colour it wants to
   keep. `crass-collage`, `crass-collage-b`, `ransom-note` and `xerox-zine` each refused a stage for
   exactly this reason, and `ransom-note` and `ransom-note-b` had to *split the pair* — one probe
   takes the screen, the other takes the overprint — because the two cannot coexist on one sheet.
   This is the single most-cited limitation in the twelve findings files.
2. **`tear` attaches only to `op: fragment`.** So the one edge a photomontage most wants to rip — the
   rectangle of the photograph — can only be cut. `xerox-zine-b` gets a torn *knockout* only by the
   coincidence that its ground and its paper are the same six hex digits. And because `span` scales
   uniformly and no pack fragment is near 5:1, a page-width torn strip has to be assembled from five
   overlapping bowls (`ransom-note-b`).
3. **`ranges` and `quantize` are keyed by field name globally.** `scale` is shared by
   `transform.scale`, `text.stretch` and `text.jitter.scale`, so its `[0.05, 8]` floor makes sub-5%
   glyph jitter unreachable — `ransom-note` was refused at `jitter.scale: 0.02`. Relatedly,
   `rotate` and `skew` quantize to a whole degree, which is why `ransom-note-b`'s "fine rotation" row
   did not move.

One more, smaller and stranger: `size` range-checks to `[6, 300]`, but `stretch` is applied as
`p.scale(sx, sy)` *after* `textSize`, so `size: 6` with `stretch: [0.5, 0.5]` validates clean and
draws effective 3pt. Both Ikeda probes found this and neither used it. The floor is not where the
profile says it is.

## The seed finding, re-run — and overturned

v0's closing finding was the sharpest thing in that document:

> The primitives that get you print culture (`solid`, `text`, hand-authored polygons) are precisely
> the ones that never consult the RNG, so **the closer a program gets to looking like print, the less
> the seed does.** A generative system that cannot vary its output within a style is a template, not
> a medium.

60 renders — twelve designs at seed offsets `0, 101, 2027, 30011, 400009` — in 148.3s, one at a time,
position-independent. All 60 pixel hashes distinct, and the five `-s1` renders reproduce the twelve
pinned goldens exactly, which is a *third* independent process agreeing with them.
Sheet: `out/substrate-test/sheets/probes-all-60-v1.png`. Hashes: `out/substrate-test/batch-v1/batch.json`.

Distinct hashes were never the interesting number, though — v0 had 60 distinct too and still
concluded the seed did nothing, because one moved pixel makes a new hash. So this time the variation
was measured. Below: the mean absolute per-channel difference between seed variant 1 and variant 2 of
each design, as a percentage of full scale, and the share of pixels that differ at all.

| design | v0 Δ | v0 px changed | v1 Δ | v1 px changed |
| --- | ---: | ---: | ---: | ---: |
| xerox-zine | 3.08% | 31.6% | **9.54%** | **96.5%** |
| xerox-zine-b | 0.72% | 9.5% | **7.61%** | **96.4%** |
| ur-stencil | 1.11% | 64.7% | **4.88%** | **96.9%** |
| ur-stencil-b | 0.12% | 17.0% | **2.70%** | **95.3%** |
| ransom-note | 2.00% | 5.9% | **6.89%** | **97.5%** |
| ransom-note-b | 0.80% | 52.7% | **2.28%** | 3.0% |
| rave-flyer | 0.21% | 33.3% | **5.17%** | **89.0%** |
| rave-flyer-b | 0.21% | 46.8% | **9.55%** | **98.0%** |
| crass-collage | 2.24% | 43.9% | **5.88%** | **96.1%** |
| crass-collage-b | 1.19% | 38.9% | **5.77%** | **86.7%** |
| ikeda-austerity | 0.95% | 1.0% | 0.95% | 1.0% |
| ikeda-austerity-b | 1.34% | 1.5% | 1.34% | 1.5% |

**The last two rows are the control, and they were not planned as one.** Both Ikeda probes declined
the print pass — their author's note says so explicitly, because every stage writes values that are
not palette colours and "absolute flatness" is the whole of that row. Their numbers are *identical*
to four decimal places between v0 and v1. Every other probe takes at least one print stage and every
one of them moves by 3x to 45x.

So the seed does much more under v1, and the measurement says exactly why: it is the print pass and
nothing else. `grain`, `misregister` and `generation` draw from a seeded stream and touch every pixel
on the sheet, so they are the first thing in this medium that makes the RNG visible on marks that
never consulted it. The v0 diagnosis was right — `solid`, `text` and hand-authored polygons still
never touch the RNG, and that has not changed — but the conclusion drawn from it was too strong. The
variation did not have to come from the marks.

Whether this is the *good* kind of variation is a separate question and the honest answer is: partly.
A different grain field is a different sheet, but it is not a different design. What did change
compositionally is `tear`, which is seeded per node *and per repeat instance* — `crass-collage`'s
three beams rip three ways from one authored edge, and that is variation in the drawing rather than
on top of it.

**One anomaly worth keeping.** `ransom-note-b` moves 2.28% while touching only 3.0% of pixels — the
one probe where the two columns disagree. Its `halftone` stage quantises the whole sheet to two
colours, so a seed change either moves a dot or it does not; few pixels change, and the ones that do
change all the way. Every other v1 probe is the opposite shape: nearly every pixel changes, slightly.
A screen is a low-pass filter on the seed.
