# rave-flyer (v1)

Re-authored against `default-v1` / `core-v1`. Same sheet, same words, same `rngKey`s, same seed
7734. Program `bbfbf46e1065`, 186 resolved nodes, ~2107 marks, cost 1346.

**Not rendered.** Every row below that is a claim about pixels is marked *predicted*.

| trait | achieved | faked | impossible |
| --- | :---: | :---: | :---: |
| Stretched / distorted display type | **yes** *(predicted)* — the distortion is now on the glyphs: TRESOR is `anton` at `stretch: [1.45, 2]`, and NEW BUILDING is `skew: 14` with `stretch: [1.55, 0.95]`, so one line is pulled tall and the other sheared and squashed. | | |
| Non-uniform type scaling (condensed, stretched) | **yes** *(predicted)* — `stretch` takes `[sx, sy]` independently and `ops.js` pushes `p.scale(sx, sy)` around the anchor. This is mechanical distortion of one cut, not a separately drawn condensed cut: stems thicken and thin with the axis, which is what a photocopier or a Letraset stretch did and is the right wrongness for this target. | | |
| Dense information block | | **yes** — unchanged, and now measured. The door-policy copy is 258 characters with single spaces; merging the two ops was actually tried and refused with `limit.textLength` at 240. The only improvement is that the second op's baseline sits exactly 5 leading steps below the first, so the two set as one column instead of two paragraphs. | |
| One saturated colour on black | **yes** — one acid, unchanged. The `stretch` group is now `blend: "screen"`, so the 24 extruded copies accumulate toward the acid instead of overpainting each other: exposure rather than paint. *(predicted)* | | |
| Cheap-reproduction feel | **yes** *(predicted)* — this row moves. `misregister` (0.6 at spread 2), `grain` 0.12 and `paper` (grime 0.12, vignette 0.24) run over the finished canvas in Node. The v0 fake was a `wash` drawn *under* pristine type; these stages act on the type itself, which is the whole difference. | | |

**Did `stretch` replace the 96-copy smear?** Partly. It replaced the *reason* for it — the smear
existed only because there was no way to make a letterform taller — so the extrusion drops from 96
copies to 24 and stops pretending to be a stretch. What is left is an extrusion, which is a real
flyer move and was always honestly that. Keeping it also keeps the before/after legible: the smear
is still there and the letterforms are now distorted anyway.

**Other v1 capabilities used.** Six faces instead of one: `anton`, `barlow-condensed-black`,
`barlow-condensed`, `ibm-plex-mono`, `share-tech-mono`. `leading` on both body blocks.
`tear: { roughness: 0.55, segment: 4 }` on the foot shard, which is the same fragment as v0 with a
resampled deckle instead of a cut edge.

**Not verified.** Advance widths are only measurable in the browser, so the fitted widths of the
stretched headline and the line counts of the two wrapped blocks are estimates. If TRESOR overruns
the 704pt measure, `stretch[0]` is the single number to pull back.
