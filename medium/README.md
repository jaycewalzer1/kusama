# medium

A deterministic rendering substrate. You hand it a JSON program; it validates the program against a
profile, draws it with p5 and p5.brush inside a pinned headless Chromium, and returns the exact same
bytes every time.

## What this is not

This is a *medium*, in the sense that oil paint is a medium. It is not an artist.

- It has no taste, no preferences and no goals. It never chooses what to draw.
- It does not generate programs, suggest edits, or complete anything.
- It does not evaluate, score, rank or critique its own output. Nothing in this repository looks at
  a rendered image and forms an opinion about it. `diff` reports how many pixels changed and where;
  `golden` reports whether a hash moved. Neither is a judgement about the picture.
- It has no model weights and makes no network calls. `env/browser.ts` serves the vendored runtime
  to the browser off local disk, so a render works with the machine offline.

Everything expressive about an output came from the program. The medium's only contributions are
determinism, refusal, and brush character.

## What is deterministic, and under exactly which configuration

The claim is narrow and worth stating precisely:

> The same program, rendered twice under one pinned configuration, produces byte-identical
> `canonical.png`.

The pinned configuration is:

| pin | value |
| --- | --- |
| p5.js | 2.2.0, `vendor/p5.min.js`, sha256 `994ad504…47522c` |
| p5.brush | 2.1.0-beta, `vendor/p5.brush.js`, sha256 `05584f62…761190` |
| Chromium | playwright 1.55.0's `chromium-1187` (Chrome 140.0.7339.16), installed into `medium/.browsers` |
| launch flags | `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` |
| GL | software WebGL2 through ANGLE + SwiftShader; no host GPU is used |
| antialiasing | off — the page calls `setAttributes('antialias', false)` and `pixelDensity(1)` |
| fonts | `fonts/grotesque.ttf` (PT Sans) `9cc83149…6d0f10a`, `fonts/serif.ttf` (PT Serif) `a4951fad…a2557a`, plus the 34 faces vendored under `assets/fonts/`, each hashed in the pack |
| asset pack | content-hashed; `core@003e484d9602` (15 fragments, 1 motif) or `core-v1@dd47bb1c2e34` (the same shapes plus 36 faces) |
| profile | content-hashed; `default-v0@15ad87c16095` or `default-v1@2738ad37acce` |
| OS / arch | the same one; recorded per render as e.g. `darwin` / `arm64` |

Every one of those, plus the Node version and the GL renderer string, is written into `trace.json`
under `renderer` on every render, so the configuration a claim was made under is always recoverable
from the artefact rather than from this document.

What is **not** claimed:

- **Not** reproducible across different Chromium builds. A Chromium revision bump is expected to move
  pixels; that is exactly what `golden --check` exists to catch, and its failure message names the
  revision the goldens were made under versus the one in use.
- **Not** reproducible across GPU vendors, or on hardware GL at all. SwiftShader is used precisely so
  that the host GPU is not an input.
- **Not** reproducible with multisampling on. Antialiasing is disabled deliberately.
- **Not** reproducible across operating systems or architectures. Nothing has been measured there and
  nothing is promised.

Determinism *within* one machine and configuration is the property that has been measured. See
`NOTES.md` (R1, R4, R6, R7) for the measurements and for the three separate non-determinism sources
that had to be eliminated to get it: a cold browser process, a partially composited frame, and the
multisample resolve.

## The two safeguards

Both of these exist because a fixed number of throwaway renders was tried, and measured to be
insufficient. They are unusual, they cost time, and they are the reason a render can fail rather than
quietly return something plausible.

**1. The browser is warmed up until it demonstrably settles.** `Renderer.launch()` does not return a
usable renderer until it has proved the process can repeat itself. It renders `WARMUP_PROGRAM` — a
throwaway 128x128 wash — over and over until two consecutive warm-up frames are byte-identical, and
records how many that took in `manifest.warmupRenders` (typically 2 or 3). A *fixed* warm-up count is
not enough: with exactly one discarded render, six fresh launches of the same program still produced
two divergent first user-visible renders, and the two divergences did not agree with each other, so
there is no single cold state to skip past (NOTES R4). If warm-up never converges, `launch()` closes
the browser and throws, because at that point the determinism claim is false on that machine.

**2. Every render is repeated until two consecutive renders agree.** `Renderer.render()` renders the
same resolved program, on a fresh page each time, and only returns once two consecutive renders hash
identically — up to `MAX_RENDER_ATTEMPTS = 6` tries, after which it throws. A single render is not
trustworthy even with a fresh page and a settled frame: rendering a page of text perturbs the *next*
render, which comes back with a few pixels of 960,000 off by up to three, differently wrong each time
(NOTES R6). Rather than guess which programs perturb which, this waits for the property callers
actually depend on. The number of attempts the winning render needed is reported as
`timings.attempts`.

There is a third, smaller version of the same idea inside the page: `settledReadback()` in
`renderer/page.js` waits a minimum of 3 frames and then re-reads the drawing buffer once a frame
until two consecutive readbacks agree, up to 90 frames. A flat frame count read back partially
composited frames whenever the machine was busy (NOTES R6). The policies, not the counts, are what get recorded:
`manifest.settlePolicy` and `manifest.renderPolicy`.

## Outputs

`npm run render -- <program.json> -o <dir>` writes, in this order:

- **`canonical.png`** — the causal image: the render with the program's own `print` stages applied.
  No cosmetic pass ever runs on it, and it is on disk before the command so much as inspects a
  presentation option. **All diffing, hashing, goldens and any downstream evaluation read this file
  and only this file.**
- **`display.png`** — canonical put through `env/present.ts`: optional per-pixel luminance grain
  (`--grain`) and colour-plate misregistration (`--misregister dx,dy`). Written only when one of
  those options is passed, and never read back by anything. Presentation effects are render options,
  not nodes, so an edit cannot target them and a diff cannot report them.
- **`resolved.json`** — the fully resolved program (macros expanded, repeats instantiated, bounds
  computed), serialized with `canonicalJson` key ordering so its sha256 is exactly the
  `resolved.hash` recorded in the trace.
- **`trace.json`** — program/resolved/profile/pack hashes, the budget, the full renderer manifest,
  warnings, timings, and any `meta.provenance` carried by the program. `plate` records the pixel hash
  the browser produced *before* `print` ran, plus one line per stage with its wall clock; it equals
  `canonical.pixelHash` when a program declares no stages, and when it declares some it is the only
  way to tell a changed render from a changed print. Meant to be opened and read by a person.

`grain` and `misregister` exist twice, and the difference is the whole point: as `--grain` and
`--misregister` they are command-line options that reach `display.png` only and are not hashed; as
print stages they are declared in the program, covered by the program hash and part of
`canonical.png`.

With `--trace-masks`, `render` additionally renders once per resolved leaf with that leaf omitted and
writes each difference as a black-and-white mask under `masks/`, plus a `changedPixels` count per
leaf in the trace. This costs one render per leaf and warns before spending them. Masks diff *plates*
rather than prints: a threshold turns "this leaf moved four pixels" into either nothing at all or an
entire region, so a printed mask would measure the print instead of the leaf.

## The program format

A program is a JSON document (`schema/program.schema.json`, `version: "0.2"`) holding the whole state
of a picture. There is no free code anywhere in it; unknown fields are rejected under every
executable key. Inert commentary is allowed only under `label`, `note`, `decisions` and `meta`.

Top level: `version`, `profile`, `assetPack`, `canvas` (`width`, `height`, `ground`, `brushScale`),
`seed`, an optional named `palette`, an optional ordered `print` list, an optional inert `meta`, and
`root`. **`profile` and `assetPack` are mandatory and there is no default for either**: a program
that omits one is refused, rather than rendered against whatever happened to be shipped.

`root` is a tree of four node types:

- **`group`** — children, plus an optional `transform` (translate, then rotate, then scale) and an
  optional rect `clip`. `blend` exists in the schema but both shipped profiles allow no blend modes,
  so it is rejected (NOTES R3).
- **`repeat`** — a subtree instanced `count` times over a `grid`, `line`, `ring` or `scatter` layout,
  with optional `jitter` on translate/rotate/scale.
- **`macro`** — one of 3: `frame` (corners / full / dots border), `motif` (a named multi-part shape
  from the asset pack), `quarantine` (a boxed, labelled region). Macros are pure functions of
  `(args, rngKey)` expanded at resolve time; each part appears in `resolved.json` with its own id
  `<macroId>/<partName>` and an `expandedFrom`.
- **`op`** — one of the 7 drawing primitives: `wash`, `paint`, `stroke`, `fragment`, `text`, `rule`,
  `cover`. `cover` paints the ground colour back over a region and is the one way to take something
  away.

Two structural rules matter:

- **Ids are globally unique** across the whole tree, and are what diffs, edits and masks address.
- **Every drawing node carries an `rngKey`**: an opaque, permanent string. A node's randomness is
  derived from the master seed, its own `rngKey`, its repeat instance, a stream name and a
  `seedOffset` — and from nothing else. Not its path, not its parent, not its sibling index. That is
  what lets a node be moved, reparented or wrapped in a new group and keep its exact marks. Edits
  never change an `rngKey`.

`paint`, `wash`, `fragment` and the filled parts of macros all take exactly one style union,
`PaintStyle` (`schema/paintstyle.schema.json`), with 5 kinds:

| kind | what it is |
| --- | --- |
| `wash` | `brush.fill` with bleed and texture — watercolour, pigment-mixing (NOTES L4) |
| `hatch` | brush hatching at a spacing and angle, 1 or 2 layers |
| `field` | scattered brush marks — `dots`, `dashes` or `scribble` — at a density and direction |
| `outline` | the region's boundary drawn with a brush |
| `solid` | plain p5 fill, no brush texture at all |

Colours are either a `palette` name or a literal `#rrggbb`.

## Type

A `text` op takes `text`, `font`, `size`, `x`, `y`, `color`, and then:

| argument | what it does |
| --- | --- |
| `align` | `left` / `center` / `right`, about the anchor `(x, y)` |
| `tracking` | extra advance per glyph; non-zero puts the line on the per-glyph path |
| `maxWidth` | wrap width, measured with tracking included |
| `leading` | line advance as a multiple of `size`. Default 1.25, the number V0 hard-coded |
| `rotate` | degrees about the anchor |
| `skew` | horizontal shear in degrees about the anchor; positive leans the tops right |
| `stretch` | non-uniform `[sx, sy]` about the anchor |
| `case` | `upper` / `lower`, applied before the line is measured or drawn |
| `jitter` | per-glyph `translate` / `rotate` / `scale` |

The transform stack is pushed scale, rotate, shear, so it applies **shear first, then rotate, then
stretch**, all about `(x, y)`. `textAnchorTransform` in `renderer/resolve.js` puts the declared
bounds through the identical order, because a node whose bounds stop describing its marks is a node
`diff` reports as somebody else's spillover.

`jitter` draws from the node's own `glyph` substream, so shaking a line of type cannot move a mark
anywhere else in the program. It draws all four of its numbers per glyph even when an amount is
zero, so turning the rotation down does not reshuffle every later glyph's offset.

**Faces.** `core-v1` carries 36: the two V0 faces (`grotesque`, `serif`) plus 34 vendored from the
Google Fonts repo under `assets/fonts/`, in the roles `display`, `condensed`, `mono`, `typewriter`,
`hand`, `stencil`, `blackletter`, `pixel` and `techno`. `assets/fonts/manifest.json` and the pack's
`faces` map are the list; both record family, role, file, byte count, sha256, licence, licence file
and the upstream URL. Licences are OFL-1.1 and Apache-2.0 (Special Elite, Permanent Marker, Rock
Salt), with 31 licence texts vendored under `assets/fonts/licenses/`.

**Every vendored face is a static `.ttf`, and that is enforced.** Seven families were vendored from
their upstream variable fonts first and every one of them drew nothing at all: p5 2.2.0 loads a
variable font, measures sensible advance widths from it, and then puts no glyph outlines on the
canvas (NOTES O6). They passed the two-independent-process determinism gate with a perfect score,
because nothing renders byte-identically to nothing. `oswald`, `league-gothic`, `big-shoulders`,
`jetbrains-mono`, `caveat`, `orbitron` and `big-shoulders-stencil` were dropped and replaced with
static families in the same role — `fjalla-one`, `pathway-gothic`, `abel`, `share-tech-mono`,
`indie-flower`, `major-mono`, `saira-stencil`. `assets/fonts/fetch.mjs` now refuses a `Family[axis]`
file outright, `tests/fonts.test.ts` fails if any manifest entry says `variable`, and
`docs/substrate-test/tools/face-ink.mjs` counts ink in every face golden and fails a blank one.

There is **no `face` argument**. `font` already was that argument; it is now checked against two
gates rather than one — the profile says which faces this medium may speak in at all, and the pack
is the artefact whose hash covers the bytes those glyphs are drawn from. `env/browser.ts` re-hashes
a face's file the first time a process draws with it and refuses the render if the bytes do not
match what the pack declares. Adding a second name for one field would have been two ways to do one
thing.

```bash
node assets/fonts/fetch.mjs --check   # re-hash the vendored type against manifest.json
node assets/fonts/fetch.mjs           # fetch anything missing and rewrite the manifest
```

`fetch.mjs` is a build-time tool and the only thing in the repo that touches the network. It is
never run at render time; the page loads faces off disk over the same hermetic route as everything
else (NOTES O3).

Both halves of the face gate, which is how a face earns its way into the pack:

```bash
node docs/substrate-test/tools/face-programs.mjs out/faces        # one dense program per face
node dist/cli/golden.js -e out/faces -g out/faces-goldens --update  # process 1: pin
node dist/cli/golden.js -e out/faces -g out/faces-goldens --check   # process 2: agree
node docs/substrate-test/tools/face-ink.mjs out/faces-goldens       # and did anything happen
```

The last line is not redundant. The first three ask whether the same thing happened twice; only the
fourth asks whether anything happened at all.

## The print pass

`print` is an ordered list of post-process stages run once, in Node, over the finished canvas. It is
the medium's "after" — xerox, ransom-note and cheap-flyer looks are not ways of drawing, they are
things that happen to an image once it exists.

| stage | arguments |
| --- | --- |
| `threshold` | `cut` (0.05–0.95 luminance), `dark`, `light` |
| `posterize` | `levels` (2–8) |
| `halftone` | `shape` (`dot`/`line`), `cell` (2–32), `angle` (0–180), `ink`, `paper` |
| `grain` | `amount` (0–1), `mono` (default true) |
| `misregister` | `amount` (0–1), `spread` (0–3); the per-plate offsets are seeded, not given |
| `paper` | `tint`, `amount` (0–1), `vignette` (0–1) |
| `generation` | `passes` (1–6), `cut`, `dark`, `light`, `blur` (0–3), `spread` (0–3), `dropout` (0–0.5), `speck` (0–0.5) |

Every stage name must be on the profile's `print` allow-list, the list is capped by
`limits.maxPrintStages`, every colour resolves through the palette so the pass invents none, and
every number is quantized and range-checked in Node before a browser starts. Each stage draws from
its own RNG derived from its index in the chain, never from a node's `rngKey`, so adding, removing
or reordering a stage cannot change a single mark.

**The pass runs after a render has been proven to repeat, never inside the proof.** A threshold
quantises small differences away, so a print stage inside the settle loop or inside the
repeat-until-agreement loop would be a machine for making a nondeterministic render converge, and
the medium would then certify it as deterministic. See NOTES R10.

## The edit model

After a program is first written, the only way it changes is through a typed, bounded edit action
(`schema/edit.schema.json`, applied by `applyEdit` in `env/edits.ts`). There are 8 kinds:
`add_node`, `delete_node`, `set_arg`, `set_transform`, `set_style`, `reparent_node`, `wrap_group`,
`duplicate_as_repeat`.

**There is deliberately no `replace_program`.** No action can swap out the whole tree, and no action
carries code.

`applyEdit` is pure: it clones the program, mutates the clone and returns it, so a caller can try an
edit, look at the result and throw it away. The candidate then goes through exactly the
`validateProgram` a hand-written program faces — schema, unique ids, quantization, ranges, profile
gating, budget — so an edit cannot produce a program the medium would have refused, including one
that is merely too expensive to draw. An invalid action is a refusal (`valid: false` plus a reason a
human can act on), never an exception, and the original program object is handed straight back. Every
result reports `changedNodeIds` and the change in estimated render `cost`.

```
npm run apply-edit -- program.json action.json          # dry run: allowed? what would it cost?
npm run apply-edit -- program.json action.json -o next.json
```

## The profile

A `MediumProfile` (`profiles/*.profile.json`, `schema/profile.schema.json`) says what this
medium can express at all for one episode. It is **mandatory**, **content-hashed**, and **immutable
while an episode runs** — a program only means anything relative to one, which is why the profile
hash sits in every trace next to the program hash. Episodes that want a narrower medium ship their
own profile rather than editing a shipped one.

Two are shipped, and a program says which it means:

| profile | pack | what it is |
| --- | --- | --- |
| `default-v0@15ad87c16095` | `core@003e484d9602` | V0 unchanged: 2 faces, no print pass. The four committed goldens are rendered against it. |
| `default-v1@2738ad37acce` | `core-v1@dd47bb1c2e34` | v0 widened: 36 faces, the `print` allow-list, `limits.maxPrintStages: 6`, and ranges and quantize steps for the new text and print fields. |

`default-v0.profile.json` is the file V0 shipped as `default.profile.json`; only the filename
changed, because profiles are looked up by name and the name should be the `id`. Its hash is
unchanged by the rename.

**A program that names no profile is an error, not a default.** `loadProfileFor` and `loadPackFor`
throw when the program declares nothing, and every command's `-p/--profile` is an override rather
than a default. This used to be the other way round: every command defaulted to the profile literally
named `default`, so a program could be validated and rendered against a medium it never asked for,
and the mismatch surfaced only afterwards, as an equality check between what the program declared and
what was loaded. With more than one profile on disk that is no longer a theoretical hole, and the
whole point of hashing the profile into the trace is that it cannot happen.

A profile gates:

- **Primitives, macros, layouts, styles** — which of the 7 ops, 3 macros, 4 layouts and 5 style kinds
  may be used at all.
- **Fonts and brushes** — `default-v0` allows the 2 vendored faces, `default-v1` allows all 36; both
  allow all 11 p5.brush presets (`pen`, `rotring`, `2B`, `HB`, `2H`, `cpencil`, `pastel`, `crayon`,
  `charcoal`, `spray`, `marker`). A font name must additionally be a face in the pack.
- **Blend modes** — `[]` in both shipped profiles, so group blend is rejected.
- **Asset packs** — which content-hashed packs a program may name.
- **Print stages** — which of the 7 post-process stages a program's `print` list may use. Absent, as
  in `default-v0`, means this medium has no "after" at all.
- **Limits** — source nodes, resolved nodes, tree depth, repeat instances, repeat nesting, polygon
  points, stroke points, fragments, text ops, text length, estimated marks, render cost, print
  stages.
- **Ranges** — the allowed interval for each numeric argument name.
- **Quantization** — the grid every numeric argument must lie on (`x`/`y` to 0.5, `angle` to 1,
  `bleed` to 0.01, and so on). An argument whose name has no declared quantum is itself an error.
- **Budgets** — `estimateBudget` walks the resolved leaves and estimates marks and weighted render
  cost.

**An over-budget or malformed program is refused in Node, in milliseconds, before a browser is ever
launched.** Nothing unvalidated is ever rendered.

## Quickstart

```bash
cd medium
npm install

# Fetch the pinned Chromium into the repo, not into the user-wide Playwright cache.
PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright install chromium
```

The browser lives in `medium/.browsers/` (currently `chromium-1187`). Nothing else needs to be
installed: p5, p5.brush and every font are committed under `vendor/`, `fonts/` and `assets/fonts/`,
and the page is served from disk over a fake `http://medium.invalid` origin with `page.route()`, so
renders are hermetic and work offline (NOTES O3). `Renderer.launch()` defaults
`PLAYWRIGHT_BROWSERS_PATH` to `medium/.browsers` itself, so once installed you do not have to set it
again.

Every script below builds to `dist/` first.

```bash
# Check a program without rendering it. Exit 0 means it may be rendered.
npm run validate -- examples/poster-less-is-more.json
npm run validate -- examples/poster-less-is-more.json --json
npm run validate -- examples/poster-less-is-more.json --determinism   # also renders it twice

# Render one program.
npm run render -- examples/poster-less-is-more.json -o out
npm run render -- examples/poster-less-is-more.json -o out --grain 0.02 --misregister 1,0
npm run render -- examples/poster-less-is-more.json -o out --trace-masks

# Render many programs in one browser, and prove the batch did not change any of them:
# the first program is re-rendered last and the batch is refused if the hashes disagree.
# One render at a time; there is no concurrency option, because renders in flight
# together disagree with each other and with their own serial renders (NOTES R8).
npm run batch -- examples -o batch-out

# What changed between two programs, in the tree and on the page.
# `spillover` is the share of changed pixels lying outside the changed nodes' declared bounds.
npm run diff -- before.json after.json -o out --max-spillover 0.05

# The committed evidence that this medium still renders what it used to.
npm run golden -- --update     # re-render examples/ and rewrite goldens/
npm run golden -- --check      # re-render and compare pixel hashes; exit 1 on any difference

# Utilities.
npm run apply-edit -- program.json action.json -o next.json
npm run contact-sheet -- out/canonical.png other/canonical.png -o sheet.png --cols 5
npm run fragments-sheet -- --pack core -o fragments-sheet.png

# Verify the vendored type against its manifest. No network unless a file is missing.
node assets/fonts/fetch.mjs --check

# Tests. These launch real browsers and render, so they are not fast.
npm test
```

`npm run <script> -- <args>` — the `--` is needed so npm passes flags through to the CLI rather than
eating them.

Every command reads the profile and the pack the program names. `-p/--profile` and `-a/--pack` are
**overrides**, not defaults: leave them off and the program decides, pass one and you are deliberately
reading the program against a medium other than the one it declares.

## Layout

```
cli/         the eight commands above
env/         Node side: browser control, validation, profiles, packs, edits, diffing, PNG, print, presentation
renderer/    plain ESM shared with the browser: resolve, draw, ops, macros, compositing, rng, page
schema/      program, paintstyle, edit and profile JSON Schemas
profiles/    medium profiles; default-v0 and default-v1 are the shipped ones
assets/packs/core/     the content-hashed asset pack (15 fragments, 1 motif) and the script that authors it
assets/packs/core-v1/  core's shapes read straight out of core, plus the 36-face type library
assets/fonts/          34 vendored faces, their licence texts, manifest.json, and fetch.mjs
vendor/      p5, p5.brush, and VERSIONS.md with the pinned versions and hashes
fonts/       the two V0 faces and their OFL licence
examples/    four worked programs, plus batch/ (20 variants) and the committed edit diff
tests/       node:test suites, including the standing determinism and isolation checks
```

`NOTES.md` records the library surprises, the measurements behind the determinism protocol, and the
operators that were wanted but deliberately not built. Read it before changing anything in
`renderer/` or `env/browser.ts`.
