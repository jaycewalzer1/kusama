# rave-flyer-b (v1)

Re-authored against `default-v1` / `core-v1`. Same handbill, same words, same `rngKey`s, same seed
3307. Program `5850ac084207`, 142 resolved nodes, ~639 marks, cost 567.

**Not rendered.** Every row below that is a claim about pixels is marked *predicted*.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| One ink on tinted stock | **yes** — unchanged. Two palette entries do the whole sheet, and the `generation` stage's `dark`/`light` are those same two, so the print pass invents no third colour. | | |
| Display type reversed out of a mass | **yes** — unchanged in mechanism, cleaner in construction: the disc is now clipped by `{type:"circle"}` at r 270 rather than by a rect that happened to contain it. Both routes go through `regionPolygon` at 64 segments, so this buys honesty rather than pixels. | | |
| Radial ornament | **yes** — 48 ticks on a `ring`, unchanged. | | |
| Cheap-reproduction feel | **yes** *(predicted)* — this row moves, and it is the one that matters. `generation` at 3 passes (cut 0.52, blur 1, spread 1, dropout 0.06, speck 0.02) is a photocopy of a photocopy of a photocopy: each pass blurs, re-cuts and drops out the previous pass's result. The foot has said PHOTOCOPIED NOT PRINTED since v0, where the v0 note called it "a caption, not a fact". It is now a description of what happened to the image. | | |
| Dense information block | | **yes** — unchanged, and for exactly the old reason. `maxTextOps` 12 and `maxTextLength` 240 did not move, so the block is still two hand-placed ops. Single spaces now measure correctly (`spaceWidth` in `ops.js`), which shortens every string on the sheet by a third, but shorter strings are not a denser block. | |
| Non-uniform type scaling (condensed, stretched) | **yes** *(predicted)* — this row moves from **impossible**. STATIC is `archivo-black`, a wide heavy face, at `stretch: [0.68, 1.6]`; PRESSURE is `bebas-neue` at `stretch: [1.62, 0.88]` with `skew: -10`. Condensed on one line and extended and back-slanted on the next, from the same substrate feature. | | |

**What did not move and why.** No `blend` on this sheet. `multiply` is the right mode for ink on
tinted stock, but every mark here is either `ink` or `acid` on an `acid` ground and nothing overlaps
anything, so a blend would have been a mode set for the sake of setting it. Nothing is set on a
curve; there is still no text-on-path, and that remains the other hard limit on this object.

**Not verified.** Advance widths are browser-side, so the fit of STATIC and PRESSURE inside the disc
is estimated. The layout above them was moved up 20pt (`head-rule` 288 → 268, `date-in-disc` 260 →
246) to clear the taller stretched caps; if STATIC still crosses the rule, `stretch[1]` is the one
number to pull back.
