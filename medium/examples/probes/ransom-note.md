# ransom-note

**Target.** Jamie Reid lineage: one slogan cut letter by letter out of other printed matter, mismatched size and face, torn edges, overprint.

**Tried.** Each of the eight letters of NO FUTURE is its own `group` with a `transform` (translate, rotate, uniform scale) containing three things: a misprint-red torn polygon offset by a few pixels, the same torn polygon in a cut-paper colour, and one `text` op. The torn edges are three hand-authored 14-point polygons reused at different rotations and scales — real hard-edged geometry, not an effect. The newsprint ground is a `field` of `rotring` dots at density 19, length 0.5. The masthead bar has a fourteen-point zigzag `cover` at `softness: 0` taken out of its bottom edge.

**Could not do.** There are two fonts and both are Regular, so "mismatched face" is carried almost entirely by size and rotation; a real ransom note mixes ten faces and four weights. `maxTextOps: 12` counts source nodes, which caps a hand-set slogan at eleven letters — NO FUTURE fits, NOTHING WAS ARRANGED did not and had to become one strip of ordinary type. The first attempt at a halftone newsprint ground (a two-layer crosshatch at spacing 6) failed the budget at 60,681 estimated marks against a 60,000 limit, so a full-page fine screen is *arithmetically* out of reach, not just aesthetically.
