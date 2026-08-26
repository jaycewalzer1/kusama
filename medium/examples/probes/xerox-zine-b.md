# xerox-zine-b

**Target.** The same target as `xerox-zine` built the opposite way round: a full-bleed black handbill where every mark is reversed out of the toner, rather than black marks printed onto white paper.

**Tried.** The page is one `solid` plate and everything on it is a hole. That configuration changes what `cover` is: `cover` paints the canvas ground colour, which normally makes it a trick that only works over blank paper, but over a full-bleed plate it becomes a real knockout — the torn corner and the bitten right edge are genuine subtraction. The two columns of body copy are `repeat`s of 4px paper bars with a second `repeat` of plate-coloured bars scattered back over them, which produces a ragged right edge and word gaps that the seed decides. The one picture is `figure.standing` in toner on a paper block, because a silhouette is what actually survives a photocopier.

**Could not do.** The degradation is still additive. 150 dropout flecks are clean rectangles lying on top of clean type; at 2x the headline is perfectly crisp with small paper rectangles sitting on it. Nothing here is a degraded copy of anything, because the pipeline has no stage after drawing. The columns are bars rather than text because `maxTextOps` is 12 and `maxTextLength` is 240, so 66 lines of 8pt copy is not expressible at all.
