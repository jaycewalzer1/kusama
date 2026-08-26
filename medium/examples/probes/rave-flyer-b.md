# rave-flyer-b

**Target.** The same target as `rave-flyer` with the opposite economics: a one-colour handbill photocopied onto coloured stock, rather than a saturated colour printed on black.

**Tried.** One ink on a tinted ground, so the only decisions left are size, mass and where the black stops — which is exactly the discipline a cheap flyer runs under. The headline is reversed out of a black disc; the disc is clip-wrapped so it tessellates at 64 segments rather than 25. The 48 radial ticks use the `ring` layout, the only placement in the substrate that is neither a grid nor a line. The barcode is a `repeat` of 64 bars with 14 ground-coloured slots scattered back through it, which is the one element on the sheet the seed actually changes.

**Could not do.** The headline still cannot be condensed or stretched: `transform.scale` is uniform and there is no skew, so the display type is set at whatever proportions PT Sans happens to have. That is the single hardest limit on this target — a flyer of this kind is *made of* distorted type. And the "photocopied not printed" claim at the foot is a caption, not a fact: nothing on the sheet has been copied.
