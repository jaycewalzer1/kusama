# xerox-zine-b (v1)

`examples/probes/v1/xerox-zine-b.json` — `default-v1` / `core-v1`, program `e43bd680d84d`,
22 resolved nodes, ~2335 marks, cost 1914. The same full-bleed handbill as
`examples/probes/xerox-zine-b.json` (pixels `99b36e56dc3e`), same seed 8802, same slogans.
**Not rendered — another process owns the renderer, so every row marked "predicted" is reasoning
about `env/print.ts` and `renderer/resolve.js`, not about pixels.**

**Changed.** `bite-top` and `bite-right` stop being `cover` polygons and become torn `arch.column`
fragments in `paper`; on a full-bleed plate the ground hex and the paper hex are the same string,
so that loses nothing and gains a deckle. The four bar-repeats that stood in for body copy
(`column-left`, `column-left-ragged`, `column-right`, `column-right-ragged`) and the 150-fleck
`dropout` repeat are deleted; six real `text` ops and the `generation` stage replace them. One node
is new: `flare`, a `screen`-blended wash under a convex polygon `clip`, which lifts part of the
plate past the generation cut — a lid-open light leak that is a hole burned in the toner rather
than paint laid over it. Every surviving node keeps its v0 `rngKey`.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| High contrast, true black on paper | **yes** — unchanged in construction, and `generation` now guarantees it globally rather than leaving it to whichever style was opaque. The `paper` stage lifts the black off zero by 14%. | | |
| Paper tone | **yes** — but by the `paper` print stage, not by `stock`. The v0 wash only ever showed in the 32px margin and `generation` flattens that margin to the same tone as the ground, so the node is kept for correspondence and is invisible in `canonical.png`. | | |
| Type reversed out of the plate | **yes** — unchanged: `text` carries its own colour and never consults the ground, so knocking type out of a plate is exactly as cheap as printing it on one. | | |
| Degraded edge | **yes (predicted)** — this row was already a real subtraction in v0 and failed only on being a clean 10-gon. `tear` at roughness 0.85 / segment 14 displaces each resampled vertex by up to ~12px along the normal, unsmoothed and with the corners displaced too, so there is no straight run left to read as a cut. Same knockout, now with an edge. | | |
| Generational loss | **yes (predicted)** — `generation` at 2 passes (the headline is literal). Same scepticism as the `-a` probe: with `spread: 0` only the final pass's 4% dropout and 2% speck survive, so the iteration is doing stroke rounding rather than compounding noise. What it does buy that no repeat could is that the damage lands *inside* the reversed-out letterforms. | | |
| Dense body copy | | **yes** — and the row **moved**, from impossible. It is genuine typesetting now: six `text` ops wrapped on `maxWidth` in Space Mono, with a real ragged right the wrapper decides. But `maxTextLength` 240 and `maxTextOps` 12 are unchanged, so ~980 characters at 16pt stand in for the several thousand at 8pt the object wants. Real copy at a model scale is not a dense column, so it stays faked — for a completely different reason than in v0. | |

**Still not there.** `maxTextLength` is the binding constraint on this object and nothing in v1
touched it. A torn *knockout* is only available here by coincidence — `tear` lives on `fragment`
and `cover` takes no tear, so this works solely because `canvas.ground` and `palette.paper` are the
same six hex digits. Change the ground and the bites stop being subtraction.
