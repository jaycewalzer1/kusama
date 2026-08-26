# ur-stencil-b (v1)

Re-cut of `examples/probes/ur-stencil-b.json` against `default-v1` / `core-v1`. Same square label,
same strings, same seed 4201, every `rngKey` unchanged. No node added or deleted: the four
`clip` rects that removed nothing became four `clip` circles, and the shapes painted under them
became rects.

**I could not render.** Rows marked *predicted* are arguments from the mechanism, not from pixels.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Two-colour plus one accent | **yes** — unchanged. `print` (`misregister` 0.5/1, `grain` 0.04) means the sheet is no longer exactly three flat values, which is the intended cost. | | |
| Radial placement | **yes** — unchanged. `ring` still places by angle and still has no sweep, so the six red spokes are still spread around the whole circle rather than gathered into an arc. Nothing in v1 touches this. | | |
| A true hole at the centre | **yes** — unchanged: `cover` at `softness: 0`. It is the one op left in the program still going to p5's 25-segment `ellipse`; at r 15 that is 0.12px of chord sag, so wrapping it in a circle clip would have bought nothing and it was left alone. | | |
| Letter-spaced catalogue type | **yes** — unchanged mechanism (`tracking`), but the strings that most wanted it are now on faces that do not need it. | | |
| A disc | | **yes** — **this row did not move, and that is the finding.** `clip: {type:"circle"}` exists now, so the rect-that-removes-nothing hack is gone and the disc is honestly the shape of the clip over a plain rect. But `regionPolygon` still tessellates a clip circle at `CLIP_CIRCLE_SEGMENTS = 64`, so the geometry handed to the brush is the same 64-gon it was in v0 — 0.36px of sag at r 300. The new capability bought clarity in the source, not pixels. There is still no curve primitive. | |
| Text set on a curve | | | **no** — unchanged. `text.rotate` turns a whole line about its anchor, which gives a chord and not an arc; there is no per-character placement; and `maxTextOps: 12` would refuse one op per glyph even if that counted. The rim type is still two straight lines above and below the spindle. |
| Monospaced matrix / runout numbers | **yes (predicted)** — new row. `share-tech-mono` for `UR-041   A1` and `space-mono` for the runout line. A matrix number is a stamped fixed-advance string and now it is one; in v0 it was PT Sans pretending, which is the same complaint the `ikeda-austerity` table filed against "tiny monospaced data". | | |
| No polish / crudeness | | **yes (predicted)** — new row, carried over from the poster. `print` gives plate fringe and grain, so no edge on the sheet is machine-exact any more. It is still the press rather than the hand: uniform, image-wide, and applied after every mark has already been drawn perfectly. | |

**Deliberately unused.** No `blend` and no `tear` here. Neither serves a row on this table — the red
spokes sit on black, where `multiply` would swallow them and `screen` would change almost nothing —
and adding a capability with no trait behind it would have made the before/after harder to read, not
easier. The poster probe is where the blend claim is made.
