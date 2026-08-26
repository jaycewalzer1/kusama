# ikeda-austerity — v1

**Target.** Unchanged: Raster-Noton lineage — a near-empty field, hairline rules, tiny monospaced
data, one interruption.

**What changed.** Five fields and nothing else. Each of the five `text` ops swaps `grotesque` for
`ibm-plex-mono` (role `mono` in `core-v1`) and drops the literal space v0 put between every
character: `"0 0 0 0 . 0 0 0 8 . 4 4 1 0 0 h z"` becomes `"0000.0008.44100hz"`. `size` stays 9 and
`tracking` stays 2 — the numbers v0 chose — so the before/after isolates the face. Every rect, every
`rngKey`, the seed and therefore the 96 scattered punch positions are byte-for-byte v0's.
No `print` stage, no `tear`, no `blend`, no non-rect `clip`.

`22f208734efb` · 377 resolved nodes · ~653 marks · cost 378. v0 was `5081ad5bcf3d`, 805 marks,
cost 454: the fake was not free, it cost 152 glyph-marks to spell the same strings.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Near-empty field | **yes** — unchanged, and slightly emptier: the real strings are about half the measure the letter-spaced ones were. | | |
| Hairline rules | **yes** — one-device-pixel `solid` rects, unchanged from v0. Still not the `rule` primitive, which is a brush line with grain. | | |
| Data field with irregular structure | **yes** — the same 168 bars and the same 96 seeded punches, unchanged. | | |
| Tiny monospaced data | **yes** (predicted) — this is the row that **moved**. `ibm-plex-mono` is a real fixed-advance face, so the columns now genuinely align rather than reading as aligned: in `0000.0008.44100hz` the `.` and the `1` occupy cells of identical width, and `tracking` adds the same constant to every advance so the pitch stays uniform. Marked predicted because I authored and validated this but did not render it. | | |
| One interruption | **yes** — unchanged. | | |
| Absolute flatness | **yes** — unchanged, and deliberately not risked: `grain`, `paper`, `halftone` and `generation` all write values that are not palette colours, and "every value on the sheet is exactly a palette colour" is the whole of this row. `validate` accepts `print: [{stage:"grain",...}]` on this program without complaint, so the constraint here is mine, not the medium's. | | |

**Generous.** Flatness was scored "the whole sheet is `solid` and `text`" in v0 and that was never
quite true: `plate` is a `wash` at opacity 18 over the ground. Invisible at 2x, and I left it rather
than change the object — but the row is 99.9% flat, not flat.

**The floor is not where it says it is.** `size` still range-checks to `[6, 300]` and `5.5` is
refused as `range`. But `stretch` is `p.scale(sx, sy)` about the anchor *after* `textSize`, so
`size: 6` with `stretch: [0.5, 0.5]` validates clean and draws effective 3pt. I did not use it: at
3pt with `antialias: false` an IBM Plex stem is well under a device pixel, so I expect noise rather
than fine data, and a claim I cannot render is not one to bake into the artefact. `silkscreen` and
`press-start` would survive down there — axis-aligned rectangles on an integer grid — but that
trades this target's clinical register for an 8-bit one.

**Declined.** `tear` is a deckle on a `fragment` and there is no torn paper in this object.
`multiply` on `band-punch` would make v0's "only subtractive move" a real darkening rather than a
repaint in ground colour, but over a `void` ground the pixels are identical. `difference` is refused
by the schema; text in a clipped group is still `text.clipped`.
