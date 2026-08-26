# ur-stencil-b

**Target.** The same lineage as `ur-stencil` on a different object — a square record label rather than a poster. Centre hole, catalogue and matrix numbers, one red mark, nothing else.

**Tried.** The composition is built from circles and a ring layout instead of a grid, to find out whether the substrate's competence survives leaving the rectangle. Every circle is wrapped in a `group` with a `clip` rect that fully contains it: that removes nothing, but it routes the circle through `regionPolygon` at 64 segments instead of p5's fixed 25-segment `ellipse`, which is the difference between a disc and a visible polygon at r 300. Letter spacing is `tracking` alone; the only literal spaces in the strings are the triple spaces that separate words. The centre hole is a `cover` at `softness: 0` — the ground showing through, which is the only true hole available.

**Could not do.** There is no text on a path, so the catalogue type is set as straight lines above and below the spindle, which is the one thing on this sheet a real label would never do. The `ring` layout has no sweep argument, so the red spokes are distributed evenly around the whole circle rather than gathered into a single arc; the label calls them "every fourth spoke" because that is what they are. And a circle is still a 64-gon, not a circle — the substrate has no curve primitive at all.
