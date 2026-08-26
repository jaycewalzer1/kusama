# ransom-note (v1)

Same sheet as the v0 probe: `GOD SAVE THE QUEUE` over eight cut letters spelling
`N O F U T U R E`, same seed 4103, same eight letter transforms, same palette.
Re-authored against `default-v1` / `core-v1`.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Letters cut individually and re-set | **yes** — unchanged from v0: eight sibling groups, each with its own `translate`/`rotate`/`scale`, so every letter carries its own baseline and angle. | | |
| Mismatched size | **yes** — unchanged: 82, 86, 88, 90, 96, 100, 104, 110pt, sizes chosen per letter rather than per line. | | |
| Mismatched face | **yes** — nine real faces on one sheet (`rubik-mono-one`, `anton`, `barlow-condensed-black`, `courier-prime-bold`, `six-caps`, `archivo-black`, `unifraktur`, `special-elite`, `pirata-one`) across display, condensed, typewriter, mono and blackletter roles; the F additionally carries `skew: 9`. v0 had two faces. | | |
| Torn edge | **yes (predicted)** — every cutting is an `op: fragment` with `tear` (`roughness` 0.5–0.85, `segment` 6–13); the outline is resampled and each vertex displaced from that node's own `geometry` stream, so no two rips repeat. Each is then cut to a convex quad `clip`, giving two scissor edges and two torn ones. Not yet seen at 2x — this row is predicted from the resolve, not observed. | | |
| Overprint (ink on ink) | **yes** — each letter now carries a second `misprint`-coloured impression inside a `blend: "multiply"` group offset 16–24 units, so the red multiplies against yellow, pink, paper and ground and yields four distinct products. v0 recorded this as impossible because `blendModes` was empty. | | |
| Newsprint halftone screen | | **still faked** — the v0 `field` of rotring dots at fixed density 19 is deliberately left on the sheet unchanged. `halftone` in v1 is a whole-canvas, strictly two-tone stage (`onInk ? ink : paper`), so screening this sheet would erase the colour that the overprint row depends on. The real screen is tested on `ransom-note-b` instead. | |

## Notes against the claims

- The `masthead-notch` and the diagonal `strip` are still hand-authored polygons.
  `tear` attaches only to `op: fragment`, and no pack fragment is anywhere near
  10:1 while `span` scales uniformly, so a long torn bar is not reachable there.
- Text inside a clipped subtree is refused (`text.clipped`), so each letter is a
  *sibling* of its own clipped patch, not a child. The rotation and scale still
  apply to both because they sit on the shared parent group.
- The validator refused `jitter.scale: 0.02` on the footer: the profile's `scale`
  range `[0.05, 8]` is shared by `transform.scale`, `text.stretch` and
  `text.jitter.scale`, so sub-5% jitter is unreachable. Set to `0.05`.
- Budget: ~22969 marks against 60000. The newsprint field is ~19000 of that; the
  tears are pure geometry and cost nothing.
