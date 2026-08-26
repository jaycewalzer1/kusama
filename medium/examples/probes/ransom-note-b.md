# ransom-note-b

**Target.** The same target as `ransom-note` on a different object: one word stacked down a whole page on cut strips, rather than a slogan hand-set across the middle of one.

**Tried.** Each row is a `group` with its own `translate` and `rotate`, so the five strips are cut and laid down independently and the sheet is legible as five separate acts. Because a strip is a full-width torn polygon rather than a per-letter patch, the letters can be set at 142–158pt, and the tear becomes a page-width event instead of a decorative edge. The faces alternate grotesque and serif, the stock alternates paper and newsprint grey, and exactly one strip is torn from a red page. The marker stroke under the word is the only visible hand on the sheet.

**Could not do.** The tears are hand-authored 24-point polygons: straight segments, no fibre, no white core showing through, obviously polygonal at 2x. `transform.rotate` quantises to a whole degree, so the two 1.5° rotations had to become 2° and the strips are more regular than cut strips are. And the two available faces are both Regular, so mismatched *weight* — the thing that actually makes a ransom note look assembled — is faked with size and rotation.
