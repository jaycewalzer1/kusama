# rave-flyer

**Target.** Tresor-era Berlin flyer: distorted or stretched display type, a dense information block, one saturated colour on black.

**Tried.** The type is stretched by *extrusion*, not by scaling: a `repeat` of 96 instances wrapping a single `text` op, stepping 1.5px per instance, smears TRESOR downward 144px in a dark acid, and one crisp acid copy is struck on top. NEW BUILDING gets the same treatment sideways (64 instances at dx 1.5, origin offset -48 so the smear is centred). Because a `repeat` wrapping a text op costs one text op, this trick is free against `maxTextOps`. One colour, `#c8ff00`, does the whole sheet. The barcode is a `repeat` of 58 bone bars with a second `repeat` of 12 acid slots knocked through it.

**Could not do.** `transform.scale` is uniform only and there is no skew, so there is no actual type distortion anywhere on this sheet — only translation stacks. No condensed, bold or outline face exists, so the display type is PT Sans Regular smeared. `maxTextLength: 240` forced the door-policy block to be cut into two `text` ops, which is the wrong shape for a genuinely dense information block. Word spaces need the three-space workaround *and* enough tracking to make it visible: at size 15 with tracking 0.5 the gaps were 1.5px and the block rendered as one word.
