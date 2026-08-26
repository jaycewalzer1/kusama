# xerox-zine (v1)

`examples/probes/v1/xerox-zine.json` — `default-v1` / `core-v1`, program `e16275a5eda7`,
33 resolved nodes, ~3106 marks, cost 3307. The same page as `examples/probes/xerox-zine.json`
(program `f7243f5a47a5` pixels), same seed 4101, same slogans, same layout.
**Not rendered — another process owns the renderer, so every judgement below marked "predicted"
is reasoning about `env/print.ts` and `renderer/resolve.js`, not about pixels.**

**Changed.** Three repeats deleted — `masthead-dropout` (110), `footer-dropout` (70), `spatter`
(190) — because they were the fakery and `print` now does the thing. `plate` gains a `clip` rect;
`plate-bite` stops being a `cover` 7-gon and becomes a torn `mark.sponsor-c`; `gutter-shadow` moves
under a `multiply` group; five faces replace two; `print` is `generation` → `paper` → `grain`.
Every surviving node keeps its v0 `rngKey`.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| High contrast, true black on paper | **yes** — `generation` cuts every pixel on the sheet to exactly `toner` or `paper`, so the two-tone is now a property of the page rather than of the one style that happened to be opaque. Caveat: the later `paper` stage mixes 20% grey in, so the black lands near #262524, not #0d0d0d. | | |
| Degraded edge | **yes (predicted)** — `tear` resamples the bite's outline into ~120 segments of 6 units and displaces each along its normal by up to 3.7px, unsmoothed. It is geometry, not a drawn approximation, and it is not straight-sided at 2x. The two sides where the bite meets the plate edge are straight, which is right: those are cut, not torn. | | |
| Generational loss | **yes (predicted)** — `generation` at 3 passes runs each blur-and-cut on the previous pass's result, which is the one thing no amount of drawing reproduces. Be sceptical about how much the iteration buys: with `spread: 0`, dropout from passes 1 and 2 is healed by the next pass's blur, so only the last pass's 3% survives as pinholes. The iteration's real work is stroke rounding and closing counters. | | |
| Typewriter text | **yes** — Special Elite for the body, a face whose outlines are already ribbon-worn, with per-glyph `jitter` (translate 0.5, rotate 1) off the node's own `glyph` stream, so no two strikes land alike. Courier Prime, actually monospaced, sets the deck and colophon. The pack has no face that is both, and `jitter` has no opacity axis, so ribbon *fade* still varies per letterform rather than per impression. | | |
| Paper tone | **yes** — but by a different mechanism, and this is worth saying out loud: `generation` flattens the `stock` wash to the same tone as the bare ground, so the v0 node that earned this row is now invisible in `canonical.png` and survives only in `trace.plate`. The `paper` stage carries the tone instead. | | |
| Toner dropout inside letterforms | **yes (predicted)** — v0 called this impossible ("the flecks can only sit on top of the type ... there is no mask and no per-pixel operation"). `generation.dropout` is exactly a per-pixel operation over the ink set, so it pinholes glyph interiors and bar interiors alike, with no node addressing where. | | |

**Still not there.** No regional print: `print` is a property of the whole sheet, so the plate
cannot be screened while the type stays clean. `halftone` was deliberately not used for that
reason — it would be a real coverage-modulated screen (`env/print.ts` sizes each dot from that
pixel's own luma), but applied globally it would trade the true-black row away for it. There is
still no ribbon fade per impression and no way to make one glyph lighter than its neighbour.
