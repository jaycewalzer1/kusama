# ikeda-austerity

**Target.** Raster-Noton lineage: a near-empty field, hairline rules, tiny monospaced data, one interruption.

**Tried.** Every rule is a one-pixel `solid` rect rather than a brush stroke, because `solid` is the only style that draws through plain p5 fill and therefore the only one with a hard edge under `antialias: false`. The data band is a `repeat` of 168 two-pixel bars with a scattered `repeat` of 96 ground-coloured bars punched back through it — the only subtractive move the substrate has. The dot matrix is a 24x4 `grid` of 2x2 rects. The interruption is a single 144x144 `#d8232a` square, the one element on the sheet that is not information. Tiny data is set by putting a single space between every character and letting `tracking: 2` do the spacing, which works because a space has zero advance width in the WEBGL text path.

**Could not do.** There is no monospaced face, so tabular data is PT Sans tracked out until it *reads* as tabular; the columns do not actually align. Type cannot go below 6pt and a rule cannot go below one device pixel, so the finest data here is roughly four times coarser than the references. This is the probe the substrate is best at, and the reason is that it is the probe that asks for the least: the entire sheet is rectangles and hairlines, and the substrate's one true strength is hard-edged geometry.
