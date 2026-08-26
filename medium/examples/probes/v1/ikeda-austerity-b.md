# ikeda-austerity-b — v1

**Target.** Unchanged: the same target as `ikeda-austerity`, inverted — a white field, black
hairlines, one dense black data slab, one blue interruption.

**What changed.** Three fields. The three `text` ops swap `grotesque` for `ibm-plex-mono` and drop
the literal space v0 put between every character. `size` stays 9, `tracking` stays 2, and the face
is the **same** face the black variant uses, so the only difference between this sheet and
`ikeda-austerity` is still the palette. Every rect, every `rngKey`, the seed and therefore the 132
scattered punch positions are v0's. No `print` stage, no `tear`, no `blend`, no non-rect `clip`.

`644e78bf4338` · 248 resolved nodes · ~411 marks · cost 108. v0 was `6603bf90958c` pixels /
`bff6469898b2` program, 571 marks, cost 187. It was the cheapest probe in the test and it got
cheaper: the fake cost 160 glyph-marks to spell the same three strings, because a space between
every character is a character.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Near-empty field | **yes** — unchanged. | | |
| Hairline rules | **yes** — `solid` rects of `h: 1`, unchanged. | | |
| Data field with irregular structure | **yes** — the same 132 paper rects scattered back through the same black slab, from the same seed. | | |
| One interruption | **yes** — unchanged. | | |
| Absolute flatness | **yes** — and unlike the black variant there is no `wash` on this sheet at all, so here the claim is exact: every value is one of four palette colours. No print stage was added; `grain` or `paper` would have cost exactly this row. | | |
| Tiny monospaced data | **yes** (predicted) — the one row that **moved**. `ibm-plex-mono` is a real fixed-advance face, so `132 null in 672 x 208` sets on a true cell grid instead of being PT Sans letter-spaced until it reads like one. Predicted, not observed: authored and validated, not rendered. | | |

**The argument this probe exists to make survives the new face intact.** v0's finding was a
negative one — nothing here is harder to draw on white than on black, because `solid` and `text`
carry their own colour and never consult the ground — and the point of re-authoring it was to check
whether anything in v1 gives the substrate an opinion about which way round a sheet is. Nothing
does. A monospaced face is set the same way on either ground. `blend` would have been the one
capability that could break this, since `multiply` and `screen` are exactly opinions about what is
underneath, and it is not used here for that reason: adding it would have turned the control into a
different experiment. The substrate's competence is still hard-edged geometry, not a dark palette.

**Still not done.** No rule finer than one device pixel and none softer than one either — `rule` is
a brush line with grain, so every hairline is still a `solid` rect of `h: 1`. `size` still
range-checks to `[6, 300]` and `5.5` is refused, though `stretch: [0.5, 0.5]` at `size: 6`
validates and would draw effective 3pt; see the black variant's note for why I did not take it.
