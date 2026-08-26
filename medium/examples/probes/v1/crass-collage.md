# crass-collage — v1

Same sheet, same composition, same words as `examples/probes/crass-collage.json`, re-authored against
`default-v1` / `core-v1`. Program `f52a10908b0c`, 34 resolved nodes, ~27917 marks, cost 27869
(v0: `b8b51829d716`, 34 nodes, ~27185 marks) — the whole difference is 732 marks, which is the tear
resampling two outlines. The clip, the blend and the four print stages cost nothing.

Changed: the plate is cut off square by a convex polygon clip instead of being an axis-aligned rect;
the three beams and both columns carry a `tear`; the grey and smoke marks on the black plate sit
under `blend: "screen"`; six faces instead of two; `print` is posterize 6 → misregister → grain →
paper. **Not rendered** — every judgement below is marked predicted where it is not a fact about the
program text.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Photographic / found material | | | **no** — unchanged. Fifteen hand-drawn vector outlines and still no image input anywhere in the schema. `posterize` cannot help: the plate is flat, so quantising it is close to a no-op, and there is nothing for it to bite on except the `stock` wash. |
| Continuous tone | | | **no** — but the reason moved. `paper.vignette` is a genuine smooth radial ramp and `grain` genuine per-pixel noise, so values between the palette colours now exist on the sheet; there is still no way to **place** one. `halftone` is a screen and a screen needs a continuous-tone original — over a flat region every cell gets the same dot radius, which is a texture. |
| Layering as argument | **yes** — unchanged, and stronger: predicted, `screen` makes the smoke columns visible against the black plate at all, so the architecture-behind / crowd-beneath / sponsors-on-top reading has three legible strata rather than two. | | |
| Clean type against dirty image | **yes** — six faces doing six jobs: `anton` for the display lines, `courier-prime` for the plate caption, `barlow-condensed` for the running head and the ministry notice. But the print pass is global, so `grain` and `misregister` dirty the type too; at 2x the 12pt caption carries channel fringes the 96pt lines do not. | | |
| Type knocked out of an image | | **yes** — unchanged on purpose, kept as the control: paper bar, ink type. `blend` does not fix it. `screen` with paper-coloured type reads light over any background but leaves a residue that varies with what is under it, and goes invisible over the paper crowd silhouettes, because a knockout needs ink to remove. There is no glyph-shaped `cover`. Predicted. | |
| Cut and torn edges | **yes** — predicted. `tear` on the beams (0.4/8) and the columns (0.25/6), seeded per node and per repeat instance, so the three beams rip three ways from one authored edge; the plate itself is cut off square by a polygon clip. | | |
| Light laid over dark | **yes** — predicted. `blend: "screen"` on the beams, columns and arch. NOTES L4 says p5.brush mixes pigment so light cannot be laid over dark; v0 got a grey hatch onto a black plate only by luck of the mix, and this is the first mechanism that means it. | | |
| Off-register printing | **yes** — the `misregister` stage, offsets drawn from the print stream rather than typed. Caveat: it displaces R, G and B, not ink plates, so it models the red plate moving well on this sheet and would not on a four-colour one. The hand-drawn double bird is kept as the authored, ink-plate version of the same idea. | | |

**Refused, and why.** `halftone`, `threshold` and `generation` are all whole-sheet and two-colour:
each maps every pixel to `ink` or `paper`, so any of them deletes the blood. There is no way to screen
the photograph and leave the type and the red alone — the print pass has no region. That is the single
biggest thing v1 does not give this target. `tear` on `figure.crowd` was authored and removed: `tear`
deforms the fragment's own outline, so tearing a crowd tears the people rather than the paper they
were printed on, and `tear` is fragment-only, so the one edge a photomontage most wants to rip — the
rectangle of the photograph — can only be cut. `posterize` at 4 was computed by hand off
`env/print.ts` and dropped: it snaps channels to the neutral axis and takes the warm newsprint paper
`#e2ded2` to `#ffffaa`. Levels 6 is neutral, and the `paper` stage puts the warmth back.
