# ransom-note-b (v1)

Same sheet as the v0 probe: five full-width strips torn from three stocks,
one letter each, `N O I S E`, on a near-black ground, seed 6606.
Re-authored against `default-v1` / `core-v1`. This is the probe that takes the screen.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Letters cut individually and re-set | **yes** — unchanged from v0: five sibling row groups, each with its own `translate` and `rotate`, each letter set on its own strip. | | |
| Mismatched stock | **yes** — still three stocks (`paper`, `news`, `blood`), but under this probe's `halftone` they read as three *dot densities* rather than three colours: computed coverage 0.094 / 0.282 / 0.717 against a 0.944 ground. That is the correct newsprint reading of mixed stock, and it is a real consequence, not a workaround. | | |
| Torn edge | **yes (predicted)** — each strip is five overlapping `object.bowl` fragments with `tear` (`roughness` 0.5–0.7, `segment` 10–14) inside a `rect` clip, so both long edges are ripped and both ends are square-cut. Caveat: this is *assembly*, not one torn strip — no pack fragment is near 5:1 and `span` scales uniformly, so a page-width torn shape has to be tiled. Predicted from the resolve; not observed at 2x. | | |
| Mismatched face and weight | **yes** — five faces, five weights: `archivo-black` 150, `courier-prime` 142 with `skew: -7`, `rubik-mono-one` 158, `unifraktur` 146, `barlow-condensed` 152, plus `space-mono` and `stardos-stencil` on the furniture. v0 ran one face at five sizes. | | |
| Fine rotation | | **still faked** — `transform.rotate`, `text.rotate` and `skew` all quantize to 1 whole degree in `default-v1`, exactly as in v0. The rows still sit at -2, 2, -1, 2, -2. Nothing in v1 moves this row. | |
| Overprint (ink on ink) | | **mechanism achieved, evidence flattened** — there is now a real `blend: "multiply"` group running a second `blood` impression out of register across rows N and O, so v0's "impossible" verdict is retired. But this probe's own halftone collapses red-on-red to 0.79 coverage against red's 0.717, a difference of roughly one dot diameter. The colour evidence for this trait lives in `ransom-note`, not here. | |
| Newsprint halftone screen | **yes (predicted)** — a real `halftone` print stage, `shape: dot`, `cell: 4`, `angle: 15`, run in Node after the render is proven to repeat. Replaces v0's field of drawn dots, which was refused at 60,681 marks against a 60,000 budget. This probe costs 439 marks. Predicted, not observed. | | |

## Notes against the claims

- Strip geometry was checked by hand rather than rendered: bowl half-height
  0.3535 x 170 = 60.1, plus tear +/-6.6 = 66.7 against a 75 clip half-height, so
  the tear survives the clip on the long edges; five centres at -252/-126/0/126/252
  with +/-73 flat-top coverage union continuously from -325 to +325 against a
  +/-310 clip, so the ends are cut, not gapped.
- `halftone` and colour are mutually exclusive on one sheet: the stage returns
  `onInk ? ink : paper` for every pixel. Splitting the pair was the only way to
  test both the screen and the overprint honestly.
- Nothing here was refused by the validator; the only refusal in the pair was on
  `ransom-note` (`jitter.scale` below the shared `scale` range floor).
