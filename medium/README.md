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
| fonts | `fonts/grotesque.ttf` (PT Sans) `9cc83149…6d0f10a`, `fonts/serif.ttf` (PT Serif) `a4951fad…a2557a` |
| asset pack | content-hashed; the shipped `core` pack is `003e484d…50fb540` |
| profile | content-hashed; the shipped `default-v0` is `15ad87c1…` |
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

- **`canonical.png`** — the causal image. No cosmetic pass ever runs on it, and it is on disk before
  the command so much as inspects a presentation option. **All diffing, hashing, goldens and any
  downstream evaluation read this file and only this file.**
- **`display.png`** — canonical put through `env/present.ts`: optional per-pixel luminance grain
  (`--grain`) and colour-plate misregistration (`--misregister dx,dy`). Written only when one of
  those options is passed, and never read back by anything. Presentation effects are render options,
  not nodes, so an edit cannot target them and a diff cannot report them.
- **`resolved.json`** — the fully resolved program (macros expanded, repeats instantiated, bounds
  computed), serialized with `canonicalJson` key ordering so its sha256 is exactly the
  `resolved.hash` recorded in the trace.
- **`trace.json`** — program/resolved/profile/pack hashes, the budget, the full renderer manifest,
  warnings, timings, and any `meta.provenance` carried by the program. Meant to be opened and read by
  a person.

With `--trace-masks`, `render` additionally renders once per resolved leaf with that leaf omitted and
writes each difference as a black-and-white mask under `masks/`, plus a `changedPixels` count per
leaf in the trace. This costs one render per leaf and warns before spending them.

## The program format

A program is a JSON document (`schema/program.schema.json`, `version: "0.2"`) holding the whole state
of a picture. There is no free code anywhere in it; unknown fields are rejected under every
executable key. Inert commentary is allowed only under `label`, `note`, `decisions` and `meta`.

Top level: `version`, `profile`, `assetPack`, `canvas` (`width`, `height`, `ground`, `brushScale`),
`seed`, an optional named `palette`, an optional inert `meta`, and `root`.

`root` is a tree of four node types:

- **`group`** — children, plus an optional `transform` (translate, then rotate, then scale) and an
  optional rect `clip`. `blend` exists in the schema but the shipped profile allows no blend modes,
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

A `MediumProfile` (`profiles/default.profile.json`, `schema/profile.schema.json`) says what this
medium can express at all for one episode. It is **mandatory**, **content-hashed**, and **immutable
while an episode runs** — a program only means anything relative to one, which is why the profile
hash sits in every trace next to the program hash. Episodes that want a narrower medium ship their
own profile rather than editing the default.

A profile gates:

- **Primitives, macros, layouts, styles** — which of the 7 ops, 3 macros, 4 layouts and 5 style kinds
  may be used at all.
- **Fonts and brushes** — the shipped profile allows both vendored faces and all 11 p5.brush presets
  (`pen`, `rotring`, `2B`, `HB`, `2H`, `cpencil`, `pastel`, `crayon`, `charcoal`, `spray`, `marker`).
- **Blend modes** — `[]` in the default profile, so group blend is rejected.
- **Asset packs** — which content-hashed packs a program may name.
- **Limits** — source nodes, resolved nodes, tree depth, repeat instances, repeat nesting, polygon
  points, stroke points, fragments, text ops, text length, estimated marks, render cost.
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
installed: p5, p5.brush and both fonts are committed under `vendor/` and `fonts/`, and the page is
served from disk over a fake `http://medium.invalid` origin with `page.route()`, so renders are
hermetic and work offline (NOTES O3). `Renderer.launch()` defaults `PLAYWRIGHT_BROWSERS_PATH` to
`medium/.browsers` itself, so once installed you do not have to set it again.

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

# Tests. These launch real browsers and render, so they are not fast.
npm test
```

`npm run <script> -- <args>` — the `--` is needed so npm passes flags through to the CLI rather than
eating them.

## Layout

```
cli/         the eight commands above
env/         Node side: browser control, validation, profiles, packs, edits, diffing, PNG, presentation
renderer/    plain ESM shared with the browser: resolve, draw, ops, macros, compositing, rng, page
schema/      program, paintstyle, edit and profile JSON Schemas
profiles/    medium profiles; default.profile.json is the shipped one
assets/packs/core/   the content-hashed asset pack (15 fragments, 1 motif) and the script that authors it
vendor/      p5, p5.brush, and VERSIONS.md with the pinned versions and hashes
fonts/       the two vendored faces and their OFL licence
examples/    four worked programs, plus batch/ (20 variants) and the committed edit diff
tests/       node:test suites, including the standing determinism and isolation checks
```

`NOTES.md` records the library surprises, the measurements behind the determinism protocol, and the
operators that were wanted but deliberately not built. Read it before changing anything in
`renderer/` or `env/browser.ts`.
