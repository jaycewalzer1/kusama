# ur-stencil (v1)

Re-cut of `examples/probes/ur-stencil.json` against `default-v1` / `core-v1`. Same sheet, same
strings, same seed 4102, same `rngKey`s on every node that survived. One node was deleted
(`stencil-bridges`, and its `bridge` child), one was added (`cut-clip`, a group).

**I could not render.** Rows marked *predicted* are arguments from the mechanism, not from pixels.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Two-colour plus one accent | **yes** — unchanged, but `print` now means no area is *exactly* a palette colour: `grain` at 0.05 dithers every pixel and `misregister` fringes every edge. The scheme is still two plus one; the flatness is gone on purpose. | | |
| Stencil cut (bridges through letterforms) | **yes (predicted)** — TRANSMIT is set in `saira-stencil` (Saira Stencil One). The bridges are counters in the glyph outlines, so they are the letterform rather than something laid over it, and they would survive over a photograph, a texture or another plate. The three ground-coloured bars are deleted, not hidden. | | |
| Misregistration | **yes** — unchanged: `misreg-red` at (405.5, 425) against `misreg-steel` at (400, 420). The `misregister` print stage adds a second, whole-sheet kind on top of it, so the trace's `plate` hash is now the only way to tell the two apart. | | |
| Text as coordinates and orders | **yes (predicted)** — the four coordinate lines are `space-mono` and the catalogue line is `share-tech-mono`, so the columns line up because the advance is fixed, not because the strings were chosen to look tabular. Still four ops, because `text` still does not honour `\n`. | | |
| No polish / crudeness | | **yes (predicted)** — moved from **impossible**. `print` runs `misregister` (amount 0.6, spread 2) then `grain`, so every edge carries a plate fringe and no area is flat. But that is the *press* being crude, applied uniformly to the whole image after it exists. Not one mark on this sheet is drawn clumsily, and one line still cannot be worse than the line beside it. | |
| Overprint where the two plates overlap | **yes (predicted)** — new row. `blend: "screen"` on the `misreg` group, which reaches both text leaves. Two light inks on black stock add, so the band where steel crosses red resolves to roughly `#f2cdcb` — a third value belonging to neither plate — instead of the upper plate simply winning. | | |

**Rejected, not refused.** `multiply` was the obvious blend and is arithmetically wrong here: on a
`#0b0b0b` ground it takes `red` to about 8/255 and the accent disappears into the stock. `screen`
lifts the non-overlapping ink by under 3/255, which is invisible, and only the overlap changes.

**Also changed, below the level of a row.** Each lower chevron's red slot is now a `paint` inside a
group clipped by the convex polygon `[[22,0],[44,0],[66,30],[44,60],[22,60]]` — a slice of the arrow
itself — so it resolves to `[[22,0],[44,0],[48,5.45],[48,54.55],[44,60],[22,60]]` and ends on the
arrow's diagonals. In v0 the slot was a bare rect that spilled left into the arrow's notch. The v0
findings did not notice that; the polygon clip is what made it fixable.

**Deliberately unused.** `skew`, `stretch`, `jitter` and `tear` all exist now and none of them belong
to this target: UR's marks are machine-exact and its crudeness is the printing. Reaching for them
would have made the before/after unreadable. **Still impossible:** text on a path.
