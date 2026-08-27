# NOTES

Library surprises, deviations from the build document, and things a reader should not have to
rediscover. Every entry cites the source line that explains it.

Vendored: p5 2.2.0 (`vendor/p5.min.js`), p5.brush 2.1.0-beta (`vendor/p5.brush.js`). The p5.brush
source referenced below is the `src/` tree of the published `p5.brush-2.1.0-beta.tgz` (the vendored
file is that package's `dist/p5.brush.js`).

## L1. `brush.clip()` is a no-op in 2.1.0-beta

```js
// src/stroke/stroke.js:306
export function clip(region) {
  isCanvasReady();
  return region;      // <- returns the argument, sets no state
}
export function noClip() { return; }
```

The library documents a clipping API (`llms.txt`: "brush.clip([x1,y1,x2,y2])") but the 2.1.0-beta
implementation stores nothing and no drawing code reads it. So the library provides **no** clipping.

**What we do instead:** `clip` is implemented geometrically in `renderer/compositing.js`. A group's
`clip.rect` is turned into a convex quad in world space, intersected with any enclosing clip, then
transformed into each leaf's local space; each operator clips its own geometry against that convex
polygon (Sutherland-Hodgman for areas, segment clipping for paths, point rejection for field marks)
before handing it to p5.brush. Consequences, both intended and recorded here:

- Clipping is **geometric, not per-pixel**. Brush marks are stamps with soft edges and watercolour
  bleed, so ink may still land a few pixels outside the clip boundary. It bounds the *shape*, not the
  *ink*. `resolve.js` therefore pads clipped node bounds by the same bleed margin as unclipped nodes.
- Only `clip.type: "rect"` exists. Any other clip shape is rejected by the schema, as the build
  document instructs when the library cannot clip arbitrarily.
- `text` ops are **rejected by validation inside a clipped group** (`env/validate.ts`). Glyph
  rasterisation happens in p5's text pipeline, which we cannot geometrically clip; refusing is
  honest, refusing loudly is cheap, and silently ignoring the clip would not be.
- Circles under an active clip are converted to a fixed 64-gon before clipping, so a clipped circle
  is not byte-identical to the same circle unclipped. This is visible in `examples/event-picture`.

## L2. `brush.fill()` throws unless `brush.load()` was called first

`llms.txt` says "brush.load() is not needed for the main canvas - it initializes automatically on
createCanvas()". That is true only for entry points that call `isCanvasReady()`. `fill()` does not:

```js
// src/fill/fill.js:81
State.fill.color = arguments.length < 3 ? Renderer.color(a) : Renderer.color(a, b, c);
```

`Renderer` (`src/core/target.js:8`) is `undefined` until `load()` runs, so the first `brush.fill()`
issued from `setup()` dies with `Cannot read properties of undefined (reading 'color')`. Stroke and
hatch entry points do call `isCanvasReady()` and so self-initialise, which is why this only bites
fills. We call `brush.load()` explicitly in `setup()`.

## L3. `brush.scaleBrushes()` is cumulative, not absolute

`scaleBrushes(s)` multiplies the currently registered brush parameters by `s`
(`src/stroke/stroke.js`, `scaleBrushes`). Calling it once per p5 instance in a page that renders more
than once gives brushes scaled by 3, then 9, then 27. Measured: a program containing only fills was
stable across renders while a program with brush strokes changed on every render. We call it exactly
once per page, in `setup()`, and there is exactly one render per page (see R1), so `brushScale` means
what the program says it means.

## L4. `brush.fill()` mixes pigment, so you cannot paint light over dark

The fill path never touches the canvas directly. It draws into p5.brush's own blend buffer and then
composites with a custom shader:

```js
// src/fill/fill.js:512
Mix.isBrush = false;
Mix.blend(color);              // <- pigment mixing, not source-over
```

Measured: a full-opacity `brush.fill('#fdf9f0', 255)` over a solid teal rectangle moved the centre
pixel from `[94,140,138]` to `[125,168,166]` — about an eighth of the way to the ground colour — and
raising `softness` made it *worse*, because the same ink is spread further. Plain p5 `fill()` over the
same rectangle restored `[253,249,240]` exactly, over both brush marks and native marks.

**What this means for `cover`.** The build document calls `cover` "the one way to take something
away", so an operator that only tints is not an implementation of it. `renderer/ops.js` therefore
draws `cover` with plain p5, not with a brush, and gets `softness` from geometry instead: it paints
`COVER_LAYERS = 6` nested copies of the region, scaled about the region's centre from `1 + s/2` down
to `1 - s/2`, each more opaque than the last. Every layer covers the core, so the core is exactly the
ground colour; only the faintest covers the outer band, so the edge fades. Consequences:

- `cover` is the one operator with no brush character at all. Its edge is a stepped alpha ramp, not
  a watercolour edge, and at large `softness` the six steps are visible on a flat field.
- `brushScale` does not affect `cover`, and `leafBounds` pads it by `max(w,h) * softness / 4` — the
  reach of that outermost layer — rather than by a brush bleed margin.
- The same finding is why group opacity could not be faked by washing the ground over a group.

## R1. Renderer protocol: one render per page, and how the frame is captured

Three separate sources of non-determinism were measured before this settled. The protocol below is
the configuration that is byte-stable; each clause is load-bearing.

1. **One p5 instance per page, exactly one render per page.** p5.brush keeps its GL mask/composite
   framebuffers on the renderer and blits the canvas into a blend-source framebuffer restricted to a
   *dirty rect* (`src/core/color.js:313-351`, `src/fill/composite.js:142`). Pixels outside that rect
   keep the previous render's content, so render N depends on render N-1. Measured: rendering the
   same program as the 2nd vs the 4th render in one page differed on 2 pixels by 1/255. Rather than
   depend on a fixed warm-up history, each render gets a fresh page (fresh JS context, fresh GL
   context). This **deviates from the build document's "page recycled every 25 renders"**; the batch
   runner discards each page after one render, and renders one at a time (R8).
2. **Draw in `draw()`, never in `setup()`.** The addon composites brush marks in its `postdraw`
   lifecycle hook (`src/index.js:156`). Marks issued from `setup()` are not flushed.
3. **Capture by reading the frame until two consecutive reads agree**, then `gl.finish()` and
   `gl.readPixels`. Capturing synchronously after `redraw()` returns an empty frame, and a fixed
   number of `requestAnimationFrame`s was the original protocol here: 2 rAFs was stable for simple
   programs but not for watercolour fills (1 of 5 fresh pages differed), and 5 rAFs was stable in
   every configuration measured *at the time*. That fixed count is gone, for the reason set out in
   R4 — `renderer/page.js` (`settledReadback`, `MIN_SETTLE_FRAMES = 3`, `MAX_SETTLE_FRAMES = 90`)
   re-reads once a frame until two readbacks are byte-identical, and gives up loudly rather than
   returning a half-composited frame. `manifest.settlePolicy` records the rule.
   `toDataURL`/`toBlob` are not used at all: the canonical PNG is encoded in Node from the raw RGBA
   readback, so the browser's PNG encoder is not part of the trusted path. `readPixels` returns
   bottom-up rows; `env/browser.ts` flips them.

Determinism claim proven under this protocol: 5 fresh pages x 3 different programs, byte-identical
per program. See `tests/determinism.test.ts` for the standing version of that check.

## R4. A fresh browser process is warmed up until it demonstrably settles

Even with R1 in force, the *first* render after `chromium.launch()` disagrees with every later render
of the same program: measured 32 differing bytes out of 640000, maximum delta 6/255, and renders 2..N
were then byte-identical to each other and to renders 2..N of a separate browser launch. It is a
warm-up effect in the browser process itself, not a settling problem in the page: raising the capture
delay from 5 to 20 frames did not change the first render's pixels at all, while rendering any
throwaway program first made the next render land on the converged value immediately.

A **fixed** number of warm-up renders is not enough, which cost a day to learn. With exactly one
discarded render, six fresh launches of the same program still produced two divergent first
user-visible renders, and the two divergences did not agree with each other — so there is no single
"cold" state to skip past. Renders 2..N were identical in every launch, including the divergent ones.

`Renderer.warmUp()` therefore does not count warm-ups; it checks them. It renders the throwaway
program (`WARMUP_PROGRAM`, a 128x128 wash) until two consecutive warm-up frames are byte-identical —
exactly the property every later render depends on — and records how many that took in
`manifest.warmupRenders`. Since R7 that is not a separate loop: `warmUp()` just calls `render()`,
which already converges, so there is one convergence mechanism and the warm-up is simply the first
program to go through it. Typically 2; measured 8 of 8 launches converged, all to the same pixels. If
it does not converge within `MAX_RENDER_ATTEMPTS` it throws instead of rendering anything, because at
that point the determinism claim is false on that machine and silence would be the worst outcome.
The content of the warm-up does not matter — a 400x400 wash and the 128x128 one both converge the
process — but it must actually exercise a brush.

## R6. Multisampling was the real source of non-determinism, and it is now off

R4 blamed a "cold browser". That was only half the story, and the other half was the expensive half.

What kept happening after R4's warm-up was in place looked like two bugs and turned out to be one.

**Symptom A: a render that drew text perturbed the *next* render.** Isolated by rendering the same
wash four times with a text render spliced in between: the wash immediately after the text render came
back with 4 pixels of 960000 wrong by up to 3/255, and wrong *differently* each time, while the wash
before it and the second wash after it were identical to each other. `loadFont()` is innocent — a font
loaded but never drawn produced a byte-identical wash — so it is drawing text that does it.

**Symptom B: programs that were stable in isolation would not repeat.** The `b0` batch program (a
wash, 12 hatched fragments, and a line of text at 800x1200) gave 5 distinct results over 8 renders,
4-10 differing bytes out of 3840000, maximum delta 8/255, and **no two consecutive renders ever
agreed** — while `wash` alone, the 12 fragments alone and `text` alone were each perfectly stable.

B is A. A program that draws text poisons *its own* next render, so consecutive renders of `b0` could
never agree. The same mistake made the operator bisection misleading: "wash + fragments" also looked
unstable, but only because the `text`-only case had been rendered immediately before it. This is worth
remembering as a method note — when a bug is carried from one render to the next, bisecting by
rendering candidates in sequence produces a confident, wrong answer. Each case now gets a fresh
browser, and the regression test in `tests/determinism.test.ts` keeps all three operators in one
program for exactly this reason.

The flickering pixels were the tell. There were only four of them — (55,666), (55,667), (57,678),
(215,693) — and every one sits on the soft outer edge of the wash's bleed where it meets the edge of a
hatch stroke, i.e. exactly where two nearly-transparent brush layers overlap. That is a multisample
resolve, not a brush. p5 gives the WEBGL canvas an antialiased (multisampled) default framebuffer, and
p5.brush's `blitToBlendSourceFramebuffer` blits *from that default framebuffer* into its blend source
every blend flush; the MSAA resolve that blit performs is implementation-defined, and under ANGLE +
SwiftShader it is not stable for pixels whose coverage lands on a rounding boundary.

Turning it off — `p.setAttributes('antialias', false)`, which in p5 2.2.0 must be called *after*
`createCanvas` or it throws `this._renderer._setAttributes is not a function` — made all of it go away
at once: every case above went to STABLE, including `b0`, and including single renders taken straight
after a text render with no convergence loop and no warm-up in between. Nothing else changed. Both
regression tests were checked against the bug rather than merely written: with `antialias` back on
they fail, and with it off they pass.

Two things are worth saying plainly. First, this cost very little visually: p5.brush's marks are
stamped textures rather than rasterised polygons, so there were almost no hard geometric edges for
MSAA to be smoothing in the first place. Second, `WEBGL_lose_context` before closing the page was
tried as a cheaper fix and does not help at all, so this was never leftover GPU state.

R4's warm-up is still needed and still converges in 2-4 renders; the cold-process effect is real and
separate from this one.

## R7. Every render is repeated until it repeats itself

Even after R6, a single render is not *checked*. R4 already established the house rule for this class
of bug: when a fixed count is tempting, wait for the property you actually depend on instead. R6 is
where that rule paid for itself, so `Renderer.render()` now applies it to real renders too
— it renders the program repeatedly until two consecutive renders are byte-identical, and throws after
`MAX_RENDER_ATTEMPTS` rather than returning a plausible-looking image.

The rejected alternative is worth recording, because it looked much cheaper. Splicing one throwaway
"barrier" render between real renders absorbs symptom A of R6 completely: 3/3 rounds recovered the
true pixels. But it only works if the barrier is big enough — a 128x128 barrier absorbs, 64x64
absorbs, **32x32 and 16x16 do not** — and the cost is flat at ~560-580ms regardless of size, because
it is page setup rather than drawing. A threshold nobody can explain is R4's fixed warm-up count
wearing a different hat, so it was not adopted. It would also not have helped with symptom B at all,
where no two consecutive renders agreed in the first place.

Keeping the convergence loop after R6 fixed the underlying cause is deliberate. It is what turned
that bug from silent wrong pixels into a loud failure, and it is the difference between "the
programs we happened to test were stable" and "this render was verified". `manifest.renderPolicy`
records the rule so a trace says which guarantee produced it.

## R2. Randomness sources are fully seedable; no `Math.random` shim is needed

p5.brush seeds its own PRNG and simplex noise from `Math.random()` at module load
(`src/core/utils.js:16,17,45,46`), which would be fatal, except that the addon overrides p5's seeding
functions:

```js
// src/index.js:177
fn.randomSeed = function (s) { _randomSeed.call(this, s); brushSeed(s); };
fn.noiseSeed  = function (s) { _noiseSeed.call(this, s);  brushNoiseSeed(s); };
```

`brushSeed` also re-fills the library's gaussian pools through its `_onSeed` hook
(`src/core/utils.js:33-39`, `src/fill/fill.js:127`), so no state survives a reseed. Those are the
only `Math.random()` call sites in `src/`. Therefore `p.randomSeed(n); p.noiseSeed(n)` before every
operator is sufficient and the `Math.random` shim contemplated by the build document is **not**
installed.

## R3. Group blend modes are rejected in V0

`p5.blendMode(MULTIPLY)` measurably changes the output of subsequent brush fills, but p5.brush does
its own colour mixing through a blend-source framebuffer and a custom shader
(`src/core/color.js`, `src/stroke/shader.frag`), so "it changed the pixels" is not evidence that it
composited *correctly*. The build document says to support group blend only if correctness can be
verified, otherwise reject at validation. `profiles/default-v0.profile.json` therefore ships
`"blendModes": []` and `env/validate.ts` rejects any `blend` on a group. The schema keeps the field
so a future profile can enable it without a format change.

**Since settled: see R11.** The correctness question turned out to be answerable arithmetically, and
`default-v1` ships three modes. `default-v0` still ships `"blendModes": []` and still hashes to
`15ad87c16095`. Group *opacity* is still not supported and was still not built; the reasoning and the
measurement are in R11 and in `docs/substrate-test/proposed-primitives.md`.

## R5. Pages are never recycled

`cli/batch.ts` does **not** recycle a page every 25 renders as the build document suggests. One fresh
page per render is forced by R1: p5.brush keeps a blend-source framebuffer between draws, so a second
render on a live page is not the same render. Pages are cheap and determinism is not, so the batch
reuses only the browser. What the batch does instead is prove the reuse was harmless: it re-renders
the first program again after every other program has been through that browser and refuses the batch
if the two hashes disagree (`positionIndependent` in `batch.json`).

This entry used to also claim that batch *concurrency* was byte-safe, on the strength of an 8-program
400x400 batch whose renders were identical at concurrency 1 and 4. That claim was wrong twice over —
first because of R6, and then, after R6 was fixed, on its own terms. See R8.

## R8. Renders in flight together are not deterministic, and the convergence loop does not save them

After R6 removed multisampling, a 20-program batch at 800x1200 still reported that three programs had
needed more than the minimum two renders to repeat themselves, and a 50-program run of the same set
aborted outright on `v12` — six renders, no two consecutive ones alike. Rendered one at a time, `v12`
is perfectly stable. The whole difference is whether other renders are in flight beside it:

```
v12 serial     : 0117b3a7030b 0117b3a7030b 0117b3a7030b 0117b3a7030b  AGREE
v12 parallel r1: b7061d17a0bb 0117b3a7030b b99121f326f9 ab8445534d5b  4 distinct
v12 parallel r2: 2d45ffad2537 23cd9f4eac55 21a6427a3396 b10032037d58  5 distinct
v12 parallel r3: cd30759696c8 8ac4ff345f4c 2d17b8fef511 0117b3a7030b  4 distinct
```

Four pages in one browser, the same resolved program on each, and almost every render came back
different. Pages do not share p5 or p5.brush state — they share Chromium's GPU process, and one
SwiftShader context's work is evidently not isolated from another's.

The dangerous part is not that concurrency is wrong. It is that **every check built to catch this
failed to.** In the concurrency-4 batch, `v12` converged: two consecutive renders agreed, R7's loop was
satisfied, and the batch recorded `7a803a84ffaa` — while the true, serial render of that same program
is `0117b3a7030b`. Two renders that are wrong in the same way are indistinguishable from two renders
that are right, so a loop that waits for agreement will happily certify a wrong image. Re-rendering
the whole set one at a time showed that **14 of the 20 images that batch wrote were wrong**, and that
only 3 of those 14 had shown any sign of it by needing extra attempts.

The batch's own `positionIndependent` guard reported `true` on that run, and the reason is worse than
bad luck. `v00` was itself one of the 14. The control render happens after every worker has finished,
so it really is alone — and it still returned `v00`'s *wrong* hash, matching the concurrent render and
passing the check. Rendered in a browser that had never rendered concurrently, `v00` gives
`dfa20785afc8` eight times out of eight across two processes; in run 1 both the batch render and the
control agreed on `e2e167ed8066`. So the perturbation outlives the concurrency that caused it: once a
browser has had pages in flight together, its later serial renders are contaminated too, which is
precisely how a guard designed to detect batch contamination was defeated by batch contamination.

So `--concurrency` is **removed**, not defaulted to 1 — a flag whose only safe value is its default is
a footgun, and the build document's request for concurrency 4 is one of the places this medium
knowingly does not do what it was asked. Nothing is lost: SwiftShader is a software rasteriser and the
work serialises in the GPU process anyway, which is why the original 400x400 measurement showed
concurrency 4 to be no faster (8.4s vs 8.6s) at the same time as it appeared to be safe.

The general lesson is the one R6 taught in a different costume: a check that a render "agrees with
itself" only means something if the two renders were produced independently. R7 is worth keeping for
what it does catch, but it is not a licence to render however one likes.

## R9. What a batch actually costs, and the one target that is missed

All at 800x1200 on the pinned runtime, one render at a time, on an otherwise idle machine:

| batch | wall clock | per render | result |
| --- | --- | --- | --- |
| 20 programs (`examples/batch/`) | 139.8s | 6.99s | position-independent, 20/20 distinct |
| 50 programs | 306.5s | 6.13s | position-independent, 50/50 distinct |
| 50 programs, repeated in a second process | 307.5s | 6.15s | **all 50 hashes identical to the run above** |

Two things worth reading off this table. The second 50-program run is the strongest determinism
evidence in the repo: fifty different programs, two separate browser processes, one hundred renders,
zero differing bytes. And every render in both 50-program runs converged on its **second** attempt,
which is the minimum R7 allows — so with R6 and R8 in force, nothing in that set is flaky any more.

The cost of the guarantees is visible and was paid deliberately. R7 renders every program at least
twice, so roughly half of the 6.1s is spent proving the other half; R1's fresh page per render adds
about 0.6s of page setup that a recycled page would not.

**The build document's target of "under 5 minutes for 50 at 800x1200" is missed, at 5m 06s.** It is
missed by 6 seconds and it is missed reproducibly (306.5s and 307.5s on two runs). Every way to close
that gap was a way of rendering less carefully — dropping the R7 second render would come in at about
2m 40s, and concurrency 4 would have made it slower *and* wrong (R8: the same 20 programs took 237.6s
concurrently versus 139.8s serially, and 14 of the 20 images were wrong). The target is reported as
missed rather than met by loosening the thing the target exists to protect.

For completeness, the 50-program set was also run at concurrency 4, and it never finished: it aborted
with R7's `the render never repeated: 6 renders of the same program never produced two identical images
in a row` after **5m 37s** of wall clock at 503% CPU. So at this size concurrency is not a trade of
correctness for speed in either direction — it burns five cores to be 31 seconds slower than the serial
run and then refuses to produce an answer at all. It is also the one case where R7 caught the
concurrency damage rather than certifying it, which is luck, not coverage: R7 fails only when the
perturbation happens to differ between attempts, and R8's whole point is that often it does not.

## R10. The print pass runs after the render is proven, never inside the proof

`env/print.ts` is a CPU post-process over the finished RGBA buffer: seven stages (`threshold`,
`posterize`, `halftone`, `grain`, `misregister`, `paper`, `generation`), declared as an ordered
`print` array on the program, allow-listed by the profile and capped by `limits.maxPrintStages`.
Where it sits in the pipeline is not a matter of taste, and the reasoning is copied here from
`docs/substrate-test/proposed-primitives.md` because it is the one thing about this pass that must
not be got wrong:

> A threshold quantises small differences away. If the settle loop, or R7's repeat-until-agreement
> loop, compared *printed* buffers, a genuinely nondeterministic render could converge because the
> threshold flattened the difference — and the substrate would then certify as deterministic an
> image that is not.

That is R8's meta-lesson in one sentence: a self-consistency check cannot detect a shared-cause
error, and a threshold is a machine for manufacturing shared-cause agreement. So the order in
`cli/render.ts` is render, then hash, then print. `Renderer.render()` returns only once two whole
renders agreed; `pixelHash(plate.rgba)` is taken at that moment; `runPrint` runs after. `batch.ts`,
`golden.ts` and `aesthetic/measure.ts` all do the same thing in the same order, and nothing
anywhere calls a print stage from inside a loop that is deciding whether a render is real.

Three consequences worth stating, because they are not the obvious ones:

- **`canonical.png` is the printed image.** `print` is declared in the program, covered by the
  program hash and validated against the profile, so it is causal, not cosmetic, and it belongs on
  the same side of the line as every other thing the program says. This is the opposite of
  `env/present.ts`, whose `--grain` and `--misregister` are render *options*, are not hashed, and
  only ever reach `display.png`. The two words now exist in both places on purpose, and which one is
  meant is decided by whether it came from the program or from the command line.
- **The trace carries a `plate` field**: the pre-print `pixelHash` plus one line per stage with its
  wall clock. It is equal to `canonical.pixelHash` when a program declares no stages, and when a
  program does declare them it is the only way to tell a changed render from a changed print. A
  moved `canonical.pixelHash` with a steady `plate.pixelHash` is a print edit; both moving is a
  render change.
- **`--trace-masks` diffs plates, not prints.** A threshold turns "this leaf moved four pixels" into
  either nothing at all or an entire region, so a printed mask measures the print and not the leaf.
  `cli/render.ts` compares `plate.rgba` against each leaf-omitted render for that reason.

Randomness for `grain`, `misregister`, `generation`'s dropout and speck comes from a `print` stream
seeded by `deriveSeed(seed, "print/<index>", 0, "print", 0)` — the stage's index in the chain, never
a node's `rngKey` — so adding, removing or reordering a print stage cannot move a single mark.

Say the other half of that plainly, because it is the one place the medium seeds from position and
`renderer/rng.js` opens by forbidding exactly that ("not its path, not its parent, not its index
among siblings"). The rule holds where it was written to hold — nodes — and the print pass is
downstream of every mark, so no drawing depends on it. But **the stages are not reorderable the way
nodes are**: inserting a stage at the front renumbers the ones behind it, and each gets different
noise. Same picture, differently grained. The property bought by indexing is isolation — a stage's
draw count cannot leak, so `grain` at `amount: 0` still consuming one draw per pixel perturbs
nothing after it. An author-supplied opaque key per stage, matching `rngKey`, would buy both; it is
not implemented, and the tests pin today's behaviour rather than the behaviour we might prefer.

## R11. Two of the four blend modes are accepted, ignored, and never mentioned again

R3 refused group blend because "it changed the pixels" is not evidence of a correct composite. That
was the right refusal and the wrong stopping point: correctness here is arithmetic, and arithmetic
can be checked. Paint a base of exactly `#404040` and a source of exactly `#c02418` over it, one
blend mode per column, and every mode predicts a different triple. A mode that is silently doing
nothing predicts the source unchanged, which is a prediction like any other.

| mode | expected | measured | |
| --- | --- | --- | --- |
| `multiply` | 48,9,6 | 48,9,6 | exact |
| `screen` | 208,91,82 | 208,91,82 | exact |
| `exclusion` | 160,82,76 | 160,82,76 | exact |
| `overlay` | 96,18,12 | **192,36,24** | source unchanged |
| `difference` | 128,28,40 | **192,36,24** | source unchanged |

Three are exact to the last bit. The other two are not wrong, they are *absent*: p5 2.2.0's WEBGL
`blendMode` matches the argument against a shortlist and, for anything off it, leaves the previous
mode in place. `OVERLAY` at least prints a console warning — "BURN, OVERLAY, HARD_LIGHT, SOFT_LIGHT,
and DODGE only work for blend mode in P2D" — but `DIFFERENCE` is in neither the accepted list nor the
warned list, so it falls through both branches and says nothing at all. A blend mode that is accepted
by the API, ignored by the renderer, and silent about it is the same failure shape as the variable
fonts in O6: the call succeeds, the effect never happens, and no gate that checks agreement can see
it. Both were caught by predicting a number and comparing, which is the only kind of check that can.

So `overlay` and `difference` are refused by `schema/program.schema.json`, one layer *below* the
profile, and stay refused even for a profile that names them. Whether a mode is allowed is policy and
belongs to the profile; whether a mode exists is not, and no profile should be able to promise a
composite the renderer never performs. `default-v1` ships `multiply`, `screen`, `exclusion`, and
`normal` — which is the opt-out, not a mode, and never reaches `blendMode` at all.

**Blend is per mark, not per layer.** There is no group at draw time: the tree is flattened to a list
of leaves and each is drawn straight onto the one canvas, so `blend` is carried down `ctx` exactly
like `clip` and applied in `withLeaf` *after* `resetBrushState`, which sets `BLEND` and would
otherwise wipe it. The consequence is visible and worth stating. Rendering a red hatch alone, a blue
hatch alone, and then both with the blue multiplying, 91.9% of channels land exactly on
`multiply(red, blue)` and the worst disagreement is 20/255 — all of it where two stamps of the *same*
hatch overlap. R3's mechanism was real: p5.brush mixes its own marks in its own framebuffer, so
under `MULTIPLY` a brush's overlapping stamps multiply with each other as well as with the ink
beneath. A layer-based compositor would flatten the hatch first and multiply once. This one does not,
and that is the better answer for what it is for — a second pass of real ink darkens where it crosses
itself too. It is not Photoshop's multiply and the note exists so nobody expects it to be.

Determinism was never actually the risk, and R1 did not bite: six v1 examples, two of them changing
blend mid-tree and one of them nesting `blend: "normal"` inside `blend: "exclusion"` to opt back out,
came back byte-identical across two independent Node processes. No restriction to top-level groups
was needed.

Group **opacity** is still not built. It cannot ride on `blendMode` — it needs the subtree composited
offscreen first, which means `brush.load(buffer)` against a WEBGL `p5.Graphics` (`src/core/target.js:131`),
a second brush target, and a decision about what a clip means across a buffer boundary. That is a
larger change than the rest of blend put together, and the leaf-level `opacity` on every style
already covers most of what it would be reached for. It is written up in
`docs/substrate-test/proposed-primitives.md` instead of half-built here.

## R12. A probability is not a budget, so the drips are counted

`spray` was specified as "density, radius, falloff, drip probability with drips as seeded random
walks". Everything in that list survived contact with the medium except the word *probability*, and
the reason is worth writing down because it is a constraint this medium imposes that most drawing
libraries do not.

Every other budget here is checked in Node, before a browser is launched, and is exact or
conservative. A per-particle drip probability is neither. If 226 particles each drip with probability
0.05, the honest bound on the vertex count is 226 drips, not 11 — the expected value is not a bound,
and a bound of 226 is so far from the typical case that budgeting against it would refuse every
program anyone would actually write. Both alternatives were worse than changing the parameter: bound
at the expectation and the limit stops being a limit, or let the renderer stop after N drips and the
picture starts depending on the value of a safety limit. So `drip` takes an exact `count`. The drips
are still seeded random walks, and they still start from particle positions drawn from the same
distribution in the same stream, so they still land where the paint is thickest. Only the *number* of
them moved from the RNG to the author.

The particle count went the same way and for the same reason. `round(density · π · r² / 100)` is a
pure function of two declared numbers, so `env/validate.ts` computes it and refuses it against
`limits.maxSprayParticles`. `density: 20` over `r: 400` is **100,531** brush stamps; it is refused in
about a millisecond, which is the whole argument for keeping the arithmetic in Node.

**The falloff parameterisation, and why it has a test rather than a default.** Particles are placed at
`r · u^(falloff/2)`, which is the inverse CDF picked so that `falloff: 1` is *exactly* a uniform disc.
That identity is the reason to prefer this form over any of the obvious alternatives: it gives the
parameter a meaningful zero point, so an author reading `falloff: 2.6` knows what it is 2.6 times
more concentrated *than*. It also gives the property a test can assert without a golden image, which
matters because a distribution is precisely the kind of thing that looks plausible when it is wrong.
The test checks the property a uniform disc actually has — **area** is uniformly distributed, not
radius, so half the particles must fall inside `r/√2`. Measured over 20,000 samples: `falloff: 1` puts
0.500 of them inside that circle, `falloff: 2.6` puts 0.74, `falloff: 0.4` puts 0.22. The middle
number was the design; the other two are what make the parameter mean anything.

The surprise, such as it was: `spray` is not the most expensive primitive by far, and the brief's
warning to "budget particles hard" was aimed at the wrong quantity. `examples/v1/spray-wall.json`
carries four sprays totalling about 1,900 particles and estimates ~15,568 marks — but 13,000 of those
are the single background hatch, not the aerosol. A spray particle is one degenerate `brush.line`, the
cheapest stamp p5.brush draws; a two-layer hatch over a full sheet is thousands of them and always
was. What needed the hard budget was not the primitive's cost per mark, it was that `density` and `r`
multiply, so a plausible-looking pair of numbers is four orders of magnitude out. That is a
validation problem, not a performance one, and it is now handled where validation problems are
handled.

## R13. The print pass is what finally made the seed visible, and it has an accidental control

The substrate test's closing finding was that "the closer a program gets to looking like print, the
less the seed does", because `solid`, `text` and hand-authored polygons never consult the RNG. That
diagnosis is still true and the conclusion drawn from it was still too strong.

Re-running the 60-render seed sweep under v1 (twelve designs, five seed offsets, 148.3s serial,
position-independent, 60/60 distinct hashes) and *measuring* the variation rather than counting
hashes: mean absolute per-channel difference between seed variant 1 and variant 2, as a percentage of
full scale, and the share of pixels that differ at all.

| design | v0 Δ | v0 px | v1 Δ | v1 px |
| --- | ---: | ---: | ---: | ---: |
| xerox-zine | 3.08% | 31.6% | 9.54% | 96.5% |
| rave-flyer-b | 0.21% | 46.8% | 9.55% | 98.0% |
| ransom-note | 2.00% | 5.9% | 6.89% | 97.5% |
| ur-stencil-b | 0.12% | 17.0% | 2.70% | 95.3% |
| *ikeda-austerity* | *0.95%* | *1.0%* | *0.95%* | *1.0%* |
| *ikeda-austerity-b* | *1.34%* | *1.5%* | *1.34%* | *1.5%* |

(Full table in `docs/substrate-test/trait-table-v1.md`.)

**The last two rows are a control nobody designed.** Both Ikeda probes refused every print stage on
their own merits — their author's argument was that each stage writes values that are not palette
colours and "absolute flatness" is the whole of that row. Checked mechanically rather than taken on
that argument: both have `print: null` and contain no `tear`, `blend` or `clip`, so they use none of
v1's new pixel-touching capabilities at all. They are consequently the only two probes
whose seed sensitivity is *identical to four decimal places* between v0 and v1, while every probe
that takes a stage moves by 3x to 45x. That isolates the cause without an experiment being run for
it: `grain`, `misregister` and `generation` draw from a seeded stream and touch every pixel, so they
are the first thing here that makes the RNG visible on marks that never consulted it.

Two cautions against over-reading this. A different grain field is a different sheet but not a
different design; the variation that is actually compositional comes from `tear`, which is seeded per
node *and per repeat instance*. And `ransom-note-b` inverts the usual shape — 2.28% of full scale
across only 3.0% of pixels — because its `halftone` quantises to two colours, so a seed change either
moves a dot or does nothing. A screen is a low-pass filter on the seed.

## O1. Operator/library mapping, and where the fixed constants are

- Our `PaintStyle.kind: "wash"` uses `brush.fill` + `fillBleed` + `fillTexture`. It does **not** use
  `brush.wash()`, which in p5.brush means the *opposite* thing: a fast solid pass with no bleed and
  no texture (`src/fill/wash.js`). Our `kind: "solid"` is the one that means "no brush texture", and
  it uses plain p5 `fill()`, not `brush.wash()`.
- Available brush presets, read from `src/stroke/stroke.js:801`: `pen`, `rotring`, `2B`, `HB`, `2H`,
  `cpencil`, `pastel`, `crayon`, `charcoal`, `spray`, `marker`. The profile allows a subset.
- Fixed constants that are deliberately not program-controllable, all in `renderer/ops.js`:
  `CIRCLE_IRREGULARITY = 0.12` (hand-drawn wobble passed to `brush.circle`), `CLIP_CIRCLE_SEGMENTS =
  64`, and the per-style bleed margins used for bounds padding in `resolve.js`.
- `brush.polygon()` is avoided in favour of `beginShape/vertex/endShape`, per `llms.txt`: polygon
  "bypasses the field-aware primitive generation ... and it can be a poor choice when fills are
  involved."

## O2. Text needs a font loaded before the WEBGL canvas will draw anything

A `text()` call with no `textFont` produced zero marked pixels in WEBGL, silently. Fonts are loaded
with `await p.loadFont(url)` inside an async `setup()`, before any drawing, and only the faces a
program actually uses are loaded, so an unused face cannot influence a render.

## O3. The page is served from disk over a fake origin, not from `file://`

`renderer/page.js` is an ES module and a `file://` document cannot load one (opaque origin, blocked by
CORS), nor can it `fetch` a sibling font. Instead of bundling, `env/browser.ts` intercepts every
request the page makes with `page.route()` and fulfils it from `medium/` on disk, under the origin
`http://medium.invalid`. Only `vendor/`, `renderer/`, `fonts/` and `assets/fonts/` are served;
nothing else can be reached and no request ever leaves the machine, so the render stays hermetic and
works offline. The vendored type library was added to `SERVED_PREFIXES` rather than fetched from
Google Fonts for exactly that reason: `assets/fonts/fetch.mjs` is the only thing in the repo that
touches the network, it is a build-time tool, and it is never run at render time.

## O4. The `core` pack is derived from control polygons, not drawn vertex by vertex

`assets/packs/core/author.mjs` is the source of truth for `pack.json`; the JSON is generated and must
never be hand-edited, since its content hash is what a program's `assetPack` pins. Each fragment is
written as a coarse control polygon in a convenient 0..100 box, then put through however many rounds
of Chaikin corner cutting that shape wants, then normalised so its longer axis is exactly 1. Three
consequences worth knowing:

- Chaikin doubles the point count per round, so the count is chosen per shape to land in the profile's
  20..80 window rather than by fiddling with vertices. Shapes that must stay crisp (`arch.arch`,
  `arch.column`, `debris.shard`, `light.beam`, `mark.sponsor-a`) get zero rounds and therefore carry
  every vertex explicitly.
- Normalisation to a longest axis of exactly 1 is what makes `span` mean the same thing for every
  fragment. `tests/pack.test.ts` asserts it, because a fragment that quietly normalised to 0.8 would
  make every layout that mixes fragments subtly wrong.
- Nothing here is traced. Every outline is a list of coordinates chosen by hand, which is also the
  only defensible answer to "where did this artwork come from".

`cli/fragments-sheet.ts` renders each fragment at 30/60/110px in a wash, a hatch and an outline. It
builds the sheet a row at a time — one small program and one render per fragment, pasted together in
Node — because a single program holding 135 cells plus a caption per row would blow the profile's
`maxTextOps` and resolved-node limits purely to be a contact sheet.

`assets/packs/core-v1/author.mjs` follows the same rule from one step further back: it does **not**
re-author a single shape. It reads `fragments` and `motifs` out of `assets/packs/core/pack.json` and
`faces`/`licenses` out of `assets/fonts/manifest.json`, so there is exactly one definition of
`figure.standing` in the repo and the two packs cannot drift. `core-v1@366521cbb036` is therefore
`core@003e484d9602`'s 15 fragments and 1 motif plus a 36-face `faces` map and a 32-entry `licenses`
map, and the only reason its hash differs is the type. Each face carries the `sha256` of its file,
which is what makes the pack hash cover the bytes the glyphs are drawn from and not merely their
names; `env/browser.ts` re-checks that hash the first time a face is used in a process and refuses
the render if the file on disk has moved.

## O5. `angleMode(DEGREES)` is a trap for new transform code

`renderer/page.js:116` calls `p.angleMode(p.DEGREES)`, so every p5 angle in this medium is in
degrees. The first implementation of the text `rotate` and `skew` arguments converted degrees to
radians before calling `p.rotate` / `p.shearX`, which turned a 9-degree rotation into 0.157 degrees.

The failure mode is the reason this is written down. 0.157 degrees is not a *wrong* rotation, it is
a rotation nobody can see — so the symptom was "the new argument does nothing at all", which is
exactly what an argument that was never wired through the schema, the resolver and the op would look
like. The natural first move is to check the plumbing, and the plumbing was fine, so the natural
first move led away from the bug. `compositing.js:applyWorld` was the evidence that settled it: it
had been passing group `transform.rotate` to `p.rotate` in degrees, unconverted, since V0.

The trap is that the conversion is not simply wrong everywhere. `textAnchorTransform` in
`resolve.js` bounds the same transform in Node with `Math.tan`, `Math.cos` and `Math.sin`, which do
take radians, so the two files are correct in opposite ways over the same numbers. Anything new that
computes a text or group bound in Node and then replays it in p5 has to convert on one side and not
the other.

## O6. A variable font loads, measures, and draws nothing — and the determinism gate cannot see it

Seven of the thirty-four faces first vendored into `core-v1` drew no glyphs at all. They were exactly
the seven whose upstream file is a variable font — google/fonts names those `Family[wght].ttf` — and
the correlation was perfect: all 7 variable faces blank, all 27 static faces inked.

The mechanism, from `out/probe/variable.mjs` (throwaway, in the gitignored `out/`): `loadFont`
resolves and returns a font object, and `textWidth('HELLO')` at size 60 returns a plausible,
face-specific number. Then `p.text(...)` on a white canvas leaves zero dark pixels.

| face | `variable` | `textWidth('HELLO')` | dark pixels |
| --- | --- | --- | --- |
| anton | no | 127.35 | 4364 |
| space-mono | no | 175.62 | 2168 |
| oswald | yes | 131.04 | **0** |
| league-gothic | yes | 94.80 | **0** |
| big-shoulders | yes | 90.08 | **0** |
| jetbrains-mono | yes | 169.14 | **0** |
| caveat | yes | 139.98 | **0** |
| orbitron | yes | 233.52 | **0** |
| big-shoulders-stencil | yes | 90.06 | **0** |

So p5 2.2.0 parses the metrics tables of a variable font and its WEBGL text path gets no contours
from it. There is no `static/` directory upstream for any of the seven, so there is nothing to swap
to within the same family; all seven were dropped and replaced with static families holding the same
role: `oswald`→`fjalla-one`, `league-gothic`→`pathway-gothic`, `big-shoulders`→`abel`,
`jetbrains-mono`→`share-tech-mono`, `caveat`→`indie-flower`, `orbitron`→`major-mono`,
`big-shoulders-stencil`→`saira-stencil`. All seven replacements ink (1244–4283 px on the same probe).

**The part worth keeping.** All seven blank faces passed the two-independent-process determinism gate
with a perfect score. Of course they did: nothing renders byte-identically to nothing. This is the
same shape of error as R8 from the other side — there, agreement was produced by a shared cause; here,
agreement is produced by there being no effect to disagree about. A determinism gate answers "did the
same thing happen twice", never "did anything happen". Any new capability needs a second gate that
asserts the capability had an effect. Two were added: `tests/fonts.test.ts` refuses a vendored face
whose manifest entry says `variable` (cheap, runs always), and
`docs/substrate-test/tools/face-ink.mjs` counts ink in every face golden and fails under 400 pixels
(expensive, run with the gate). `assets/fonts/fetch.mjs` also now refuses to fetch a `[axis]` file.

## Proposed operators and macros that were wanted but NOT added

Kept here rather than built, per the build document's instruction:

- `paint` with a `gradient` style (p5.brush exposes `{gradient: 0-1}` on both `hatch` and `mass`).
  Wanted for skies in `event-picture`; not added because it is a sixth PaintStyle.
- A `mass` style over `brush.mass()` (layered hand-filled value). This is the most obviously missing
  expressive primitive in the medium as specified.
- A `flow` op over `brush.field()` + `brush.flowLine()`. Vector fields are the library's signature
  feature and are entirely unused by this medium.
- `arc` as a stroke primitive (`brush.arc`), currently only expressible as a many-point `stroke`.
- A `text.path` op (text along a curve), wanted for the poster example.

## E1. Edit locality, measured: three typed edits to `event-picture` spill nothing

`examples/event-picture-edited.json` is `examples/event-picture.json` after exactly three actions, each
applied through `applyEdit` via `cli/apply-edit.ts` and chained (the output of one is the input of the
next), so all three are appended to `meta.provenance` in order with their own `before`/`after`/
`estimatedCost`:

| action | kind | target | what it does |
| --- | --- | --- | --- |
| `ep-edit-1-mark-b-restyle` | `set_style` | `mark-b` | solid grey -> a rust wash, inside the clipped sponsor strip |
| `ep-edit-2-speaker-smaller` | `set_arg` | `speaker` | `span` 190 -> 160 |
| `ep-edit-3-bird-over-title` | `add_node` | into `title` | one `animal.bird` fragment at (688, 196), span 62 |

`cli/diff.js` over the pair (committed at `examples/event-picture-diff/`):

```
1 added, 0 removed, 2 changed, 162 untouched
21166 pixels differ, 0 of them outside the declared bounds
spillover 0.0000
```

**Zero spilled pixels, not merely under the 0.05 threshold.** Three things had to hold at once for
that, and they are the reasons to keep it that way:

- Seeds are positional-free. `resolve.js` derives a leaf's seed from `nodeSeed(program.seed, rngKey,
  instance, seedOffset)` only, so inserting `title-bird` in the middle of the tree did not reseed a
  single other node. Had the seed depended on paint order, the add alone would have redrawn the page.
- `leafBounds` never intersects with the clip. `mark-b` sits in a clipped group but its declared box
  is the whole unclipped fragment plus the wash bleed margin, which is strictly larger than where the
  ink can land. Conservative in the direction that makes spillover honest.
- p5.brush's pigment mixing (L4) propagates a change into whatever is painted *over* it, so all three
  edits were chosen late in paint order, or with nothing brush-filled above them. An edit under a
  large later wash would still be local in the tree and could still show pixels moving outside its own
  box.

Two of the three actions record `estimatedCost: 0`, which is truthful rather than a bug:
`estimateMarks` charges a `solid` fill 1 mark regardless of area, and a `wash` `40 + bleed*400` marks
regardless of area, so neither adding a solid fragment nor shrinking a wash changes the estimate.

## E2. `layout: "scatter"` measures its box from the origin as a corner, not a centre

`resolve.js` does `px += rng.next() * layout.w` after `layoutPosition` returns `layout.origin`
verbatim, so a scatter occupies `[ox, ox+w] x [oy, oy+h]`. `ring` treats `origin` as a centre and
`grid`/`line` treat it as a first cell, so scatter reads like the odd one out and the schema says
nothing either way. Two of the twenty batch programs were written with a centred box first; the result
was not an error but a picture with two thirds of its instances off the bottom-right corner of the
canvas, which validates and renders happily. Worth knowing before blaming the jitter.

## E3. A space has zero advance width in the WEBGL text path, so tracked text loses its word gaps

> **Fixed. See E7**, which measures the same thing properly and records the fix and the four goldens
> it moved. What follows is the original entry, kept because the workaround it describes is still
> written into `examples/batch` and explains why those strings look the way they do.

`ops.js:drawTracked` steps `cx += p.textWidth(ch) + tracking` per character whenever `tracking` is
non-zero. Measured: `p.textWidth(' ')` contributes nothing, so `"A SINGLE OPENING"` at `tracking: 2`
renders as `A SINGLEOPENING` — the word gap collapses to one letter gap. At `tracking: 0` the branch
hands the whole string to `p.text()` and the spaces come back, but then `lineWidth` still sums
per-character widths, so a centred multi-word line is off-centre by half the missing space width.

Not fixed here (`renderer/` is not ours to edit). The workaround used across `examples/batch` is to
write three spaces between words in any tracked display string: the gap becomes `3 * tracking` and
reads as a word space. Small captions that want real spacing simply omit `tracking`.

## E4. The profile's cost estimate does not predict render wall clock, and ranks programs backwards

> **The absolute numbers in this entry are stale.** They were measured over `examples/batch/v00..v19`
> before the R6 antialias fix, with a `-c 1` flag that no longer exists, and came to 191.9s wall /
> 9.59s per render. The current figures are in **R9** (139.8s / 6.99s for the same 20 programs). What
> survives is the *ranking*, which is what this entry is actually about — the relationship between
> estimated cost and measured time, not the times themselves.

Per-render `timings.totalMs` ranged from **1.0s (`v09`) to 96.0s (`v12`)**, a 96x spread, and the
profile's own budget number ranks them almost backwards:

| program | est. marks | est. cost | measured |
| --- | --- | --- | --- |
| `v09` six hatched patches | 16039 | 16039 | 1.0s |
| `v11` five hatched columns | 4561 | 5073 | 3.3s |
| `v12` twelve hibiscus motifs | 6500 | 17207 | 96.0s |

`estimateBudget` prices a hatch stamp and a wash fill on the same scale (`costWeight` 1 vs 3), but a
wash is a full `Mix.blend` pass through p5.brush's blend-source framebuffer and a shader, while
hatching is thousands of cheap strokes. `v12` expands to 60 washes (five petals x twelve blooms) and
pays for each; `v09`'s 16000 hatch marks are nearly free. So the profile's `maxRenderCost` is a
guard against *unbounded* programs, not a time estimate — do not use it to schedule a batch. Counting
resolved nodes whose style is `wash` is a far better predictor of wall clock than `cost` is.

## E5. `cli/validate.ts` used to take one program and silently ignore the rest — fixed

`validate` declared a single `<program.json>` argument, so `node dist/cli/validate.js
examples/batch/*.json` exited 0 having checked `v00.json` only — commander accepts the excess
arguments without complaint and nothing warned. That is the worst failure mode a gate can have: it
does not err on the side of refusing, it passes while checking 5% of what it was handed, and the
green exit code is indistinguishable from a real one.

It is now `<programs...>`, matching `batch` and `diff`. All programs are checked even after one
fails (so you get the whole list of problems, not just the first), the exit code reflects every
program, and `--determinism` renders each of them in one browser, one at a time. `--json` still
prints a single object for a single program and prints an array only when given several.

## E6. What the twenty batch variants are for

`examples/batch/v00..v19.json` exist to exercise the medium broadly rather than to be twenty pictures:
all seven primitives, all three macros, all five `PaintStyle` kinds, all four layouts, both fonts,
eleven brushes, eight palettes, grounds from `#fbfaf7` to `#0f1220`, and `brushScale` 0.75 to 1.5.
Three of them are the cheapest useful checks in the repo:

- `v08` (`cover` over the last word of a type specimen) shows the L4 consequence directly: the cover
  leaves a faint ghost of the `J` where the outermost of the six alpha layers falls short.
- `v17` (nine flat diagonal `solid` stripes with a `cover` window) shows the stepped alpha ramp of
  `COVER_LAYERS = 6` as visible banding on the window's edge, which is the honest picture of what
  `softness` buys.
- `v12` is the slow one (E4) and is the program to reach for when measuring wash throughput.

## E7. `textWidth(' ')` returns exactly 0, and fixing that moved all four goldens

E3 recorded that a space "contributes nothing" and left it, on the grounds that `renderer/` was not
ours to edit. It is worth more than that. Measured in this vendored p5 2.2.0 under WEBGL and
SwiftShader, with `anton` at size 40:

| call | result |
| --- | --- |
| `textWidth(' ')` | 0 |
| `textWidth('n')` | 17.20703125 |
| `textWidth('nn')` | 37.1484375 |
| `textWidth('n n')` | 46.5234375 |
| `textWidth('helloworld')` | 168.18359375 |
| `textWidth('hello world')` | 177.55859375 |

A whitespace-only string is trimmed away to nothing before it is measured. A space *inside* a string
is not: `'n n' - 'nn'` is 9.375 and `'hello world' - 'helloworld'` is 9.375, exactly, on two
different strings of two different lengths. So the advance is measurable after all, and
`ops.js:spaceWidth` now measures it as `textWidth('n n') - textWidth('nn')` and `advance()` hands it
back for `' '`.

What was wrong before the fix is larger than "tracked text looks odd". Every path that measures or
draws one glyph at a time was silently deleting word spaces: all tracked text, all jittered text,
and `lineWidth`, which is what `maxWidth` wraps on and what `align: center`/`right` offset from. So
`SET AND SETTING` set itself as `SETANDSETTING`, and a wrapped paragraph measured far narrower than
it drew and therefore did not break where it should have. This was present in V0 and is on disk in
the committed golden `goldens/poster-less-is-more.png`, in the lines `ON SETTING TYPE` and
`SET IN THE MEDIUM`.

**A second-order observation that is not fixed and is not a bug.** `textWidth('nn')` is 37.148 while
`textWidth('n')` is 17.207 — the second `n` adds 19.94, not 17.21 — so summing per-glyph advances
does not reproduce p5's own whole-string layout, and cannot be made to. That is acceptable where
tracking or jitter is deliberately re-spacing the glyphs anyway, which is the only case the
per-glyph path exists for; `drawTracked` takes the whole-string `p.text()` path whenever there is
neither. The consequence to remember is that the two paths are **not** interchangeable, so a line
drawn one way and measured the other will not agree with itself.

**Four goldens moved, and they were re-pinned deliberately.** All four examples set tracked text, so
all four changed the instant word spacing came back:

| example | before | after |
| --- | --- | --- |
| `event-picture` | `626df27b0945` | `dca4125bd3ec` |
| `event-picture-edited` | `43ab77142371` | `7428a3c1efeb` |
| `hill-feast` | `5e278e1c86ee` | `d06eb1f14840` |
| `poster-less-is-more` | `61982d731298` | `aca457b2491c` |

`docs/substrate-test/proposed-primitives.md` predicted that none of this work would force a golden
rewrite, and was right about the part it was reasoning about: the examples name `default-v0`, so
adding `default-v1` and `core-v1` left them alone. What it did not anticipate is that the same
change set also touched `renderer/ops.js`, which every profile shares. A profile is versioned; the
renderer is not. The old PNGs remain in git history, which is where a picture of the defect lives
now.
