# crass-collage-b — v1

The same negative as `examples/probes/crass-collage-b.json`, same composition, same words, against
`default-v1` / `core-v1`. Program `32a7a3610259`, 28 resolved nodes, ~6683 marks, cost 6783 — the
mark count is **identical** to v0's, which is the cleanest evidence that the clip, the two tears, the
two blends and the four print stages are geometry and post-process, not drawing.

Changed: the whole picture sits under `blend: "screen"`; the architecture is cropped by a convex
polygon clip; the columns and the red beam are torn; the beam opts back out with `blend: "normal"`;
`anton` and `courier-prime` replace the two v0 faces; the caption wraps on `maxWidth` instead of
running off the right edge on one line as it did in v0; `print` is posterize 6 → misregister → grain
→ paper.
**Not rendered** — rows are marked predicted where they are not facts about the program text.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Found material that reads as found | **yes** — still the v0 move, and it is still the inversion doing the work, not new material. `tear` on the columns adds a second reason: predicted, a bone slab with a ripped edge on black reads as something removed from a page rather than drawn on one. | | |
| Layering as argument | **yes** — unchanged. | | |
| Clean type against dirty image | **yes** — `anton` for the two slogan lines, `courier-prime` for the caption. The print pass is global and cannot exclude the type, so `grain` 0.1 and the ±1px channel offsets land on the 12pt caption as well as on the picture; at 2x that caption is no longer clean. | | |
| Type knocked out of an image | | **yes** — unchanged: bone type on a blood bar drawn over the top, the same fake as v0. `multiply` with the ground colour would knock type out over *any* background rather than only a flat one, which is the specific thing v0 could not do — but multiply by `#0b0b0c` returns `(8,1,1)` over the blood and `(0,0,0)` over the ground, so the letterform comes out **darker** than the paper it is pretending to be, and paper never does that. Predicted; not shipped. | |
| Photographic material | | | **no** — unchanged. Fifteen hand-drawn vector outlines, no image input in the schema, and nothing in v1 adds material. |
| Continuous tone | | | **no** — `hatch` is still fixed-spacing engraving and there is still no gradient style. The print pass now makes real intermediate values (`paper.vignette` is a smooth radial ramp, `grain` is noise) but neither can be aimed at a shape, and `halftone` is whole-sheet two-colour, so screening this negative would delete the blood. |
| Cut and torn edges | **yes** — predicted. Polygon clip on the architecture, `tear` 0.3/6 on the columns and 0.45/10 on the beam. The clip is a scalpel and the tear is a rip and they are different edges, which is what a paste-up has. | | |
| Light laid over dark | **yes** — predicted, and this is the row v1 actually moves for this probe. A negative *is* light over dark, and NOTES L4 says p5.brush's pigment mixing refuses it. v0 got away with it only because `solid` bypasses the brush entirely; the two marks that did go through a brush — the ash `hatch` sky and the bone `outline` arch — were the two weakest things on the sheet. `screen` is the first mechanism that means it. | | |

**Refused, and why.** The red is the constraint on the whole print pass. `halftone`, `threshold` and
`generation` each map every pixel to one of two colours, so all three are unavailable to any sheet
that carries one colour once, which is exactly what this position asks for. Only `posterize`,
`misregister`, `grain` and `paper` survive. `tear` on `figure.crowd` was authored and removed for the
same reason as in the `-a` probe: the tear displaces the fragment's own outline, so it tears the
people rather than the paper. The beam's `blend: "normal"` is there because `screen` over the bone
columns turned the one saturated red mass pale pink — the opt-out is load-bearing, not a demonstration.
