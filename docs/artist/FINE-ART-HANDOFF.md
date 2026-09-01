> # STALE — DO NOT BUILD FROM THIS
>
> Marked 2026-09-01. This document was accurate on 2026-08-28 and is kept as a record of what the
> system was then. It describes at least three things that no longer exist:
>
> - **L3 and the whole `Deliverable` subsystem** — deleted at `aced259`. `aesthetic/deliverables/`,
>   `loadDeliverable`, `deliverableFacts`, `--deliverable`, `deliverableId`. There is now one kind of
>   commission and it is art; what the object physically is, is the artist's to decide.
>   `loadCommission` takes 2-3 args, `stack()` is L4 -> L1 -> L2, a cell is `position:brief[:control]`.
> - **Every catalog id in Part 5** — dead at `ace0971`. On disk today the positions are
>   `interference` / `many-hands` / `withheld` and the conditions are `fifty-year-embargo` /
>   `nine-returned` / `two-million-slips`. Count the disk, never this file.
> - **L2 is a CONDITION, not a commission** (2026-08-30). No `client`, `audience`, `mustAppear` or
>   `textRequired`; the fields are `material occasion when where means atStake fear pressures[]
>   refusals[]` and the section header is `THE CONDITION:`.
>
> Also stale: `medium/` no longer exists as a path prefix, and the branch this was verified against
> (`wip/snapshot-2026-08-27`) is gone. For what is true now, read `docs/audit/2026-09-01.md` and the
> memory topic files it cites.

# Handoff: the current catalog, what the studio actually does, and the fine-art rewrite

Written 2026-08-28 for a fresh model with no access to this repo. Everything below is verified
against disk at branch `wip/snapshot-2026-08-27`. Part 5 is the verbatim content of all twelve
catalog documents; Parts 1-4 are what you need in order to change them without breaking the system.

---

## 1. What this system is

A **creativity environment**, not an image generator. Four separable things:

1. **The medium** (`env/`, `renderer/`) — a deterministic, edit-based drawing
   substrate. Programs are JSON trees. A vendored p5 2.2.0 + p5.brush 2.1.0-beta runs under
   hermetic Playwright Chromium with antialiasing off; the same program renders to a byte-identical
   PNG every time. No LLM anywhere in this layer.
2. **The aesthetic layer** (`aesthetic/`) — *positions* (an artistic practice, with
   machine-checkable constraints), *briefs* (a commission), *deliverables* (a kind of physical
   object). Plus a checker that reads a finished program tree and four numbers off the rendered PNG,
   and returns a verdict per constraint.
3. **The artist layer** (`artist/`) — the loop that puts a language model in front of all of
   that and lets it edit a program until it declares itself finished. Everything it did is logged
   to an append-only hash-chained `studio.jsonl`.
4. **The studio** (`studio/ui.ts` + `studio/ui/`, port 4321) — a web console over layer 3:
   launch runs, watch the log arrive live, audit the reasoning and the plates, author new
   positions/briefs/deliverables through a form that refuses to save a document that breaks the
   layering rules.

**Nothing in this repo has an opinion about whether a picture is good.** That is deliberate and it
is the single most important fact for anyone changing the catalog. See §2.6.

---

## 2. Specs: what the studio is actually doing

### 2.1 The unit of work

`artist run <positionId> <briefId> <deliverableId>` produces one **trajectory** into a directory.
The three ids are three independent axes. The catalog is 3 x 3 x 3, so 27 cells; `artist grid`
runs them serially plus a control column.

### 2.2 The five-layer prompt stack

Every call to the model is assembled by one function (`stack()` in `artist/observation.ts`), always
in this order, and the order is asserted by a test:

| layer | what it is | varies with | lives in |
|---|---|---|---|
| **L4 protocol** | the transaction: interrogate, name the collision, propose, state terms, revise | nothing | `PROTOCOL` const, `artist/observation.ts` |
| **L1 practice** | the artist's identity, brief-agnostic | the artist | `position.meta.practice` + the position's prose |
| **L3 deliverable** | the kind of object, artist-agnostic | the object | `aesthetic/deliverables/<id>.json` |
| **L2 brief** | the commission, artist-agnostic, **zero aesthetic direction** | the job | `aesthetic/briefs/<id>.json` |
| L5 critics | an evaluator | — | **deliberately not built** |

**The rule the whole thing rests on:** each layer answers exactly ONE of "varies with the artist?" /
"varies with the deliverable?". A document that answers yes to both is two prompts wearing a
trenchcoat, and the failure is invisible — the run completes and scores, having been *told* the
derivation it was supposed to perform.

The sharpened version of the L1/L3 rule, which is authoritative:

> **L1 may hold beliefs about a medium. L1 may not contain facts about one. A fact is anything the
> artist could be wrong about.**

So "a thing on a wall is assembled, not designed" is a stance and belongs in L1. "Read at fifteen
feet, 24x36, photocopying crushes the midtones" is L3's to state, and a position that states it has
done L3's job. This is enforced by `deliverableFacts()` in `artist/field.ts`, called by both the
test suite and the studio's save path, so the studio cannot author the defect.

L2 has its own version: `namesDeliverable(brief)` stringifies the whole brief and scans for object
nouns. **A brief may name no kind of object at all** — not even its own — because the object is a
third axis chosen at launch. `Brief.whereItLives` and `Brief.format` were deleted for the same
reason; `production` (their means) and `quantity` (a run size) replaced them.

The full L4 protocol text is in §4.4 below, verbatim.

### 2.3 The loop

Phases, each one policy call, all in `artist/phases/`:

- **FIND** — reads the field, returns `questions[]` (protocol step 1: what the brief did not answer,
  and what is being decided instead) and `problems[]`, each tied to one of the position's own
  `tensions` and quoting the field lines it was read out of.
- **CHOOSE** — picks one problem; must return a **`Collision { requirement, principle, statement }`**
  (three fields, never a paragraph — a paragraph about a conflict is what an agreeable model writes
  when it has not found one), a cost, and **`Terms { outOfScope, willNotChange,
  wouldLoseTheCommissionOver }`**. Also emits `intention0`.
- **SKETCH / ACT** — the edit loop. Each step: LOOK (render, check, describe, optionally an audience
  read) → MAKE (one call producing `think`, `control`, `risk`, `unrealizable`, `edits[]`) → validate
  → apply → re-render. **The artist sees by default**: the plate plus a change-since-last-step image
  go into every MAKE call. The flag to turn that off is `--blind`.
- **EXAMINE** — the artist's own verdict on each edge of its plan, plus a self-score and a paragraph.
- **FINISH / abandon.**

**The intention is a graph, not prose.** `IntentionElement { id, role, nodeIds, binding }` and
`IntentionEdge { from, to, type, claim }` with `type` in
`aligned-to | masked-by | echoes | contradicts | answers`. Two of the five are mechanically decidable
from the tree; the other three route to `judge-pending`. `binding` is one of
`node | region | ratio | absence | render-measure` and every kind but `node` must name what it
points at, and the name is checked — this replaced a `locatable: false` boolean that was an
unfalsifiable claim.

**Replans** are triggered by five named conditions: `description-disagrees`, `audience-disagrees`,
`unplanned-violation`, `artist-declares`, `stall`.

**Affect** is two numbers (`arousal`, `valence`) that steer search and never label anything in the
picture. Valence opens at the position's `meta.temperament`; arousal opens at the field's
`stakesLevel`. They are read by exactly three step functions (`editsPerStep`, `stallThreshold`,
`credulous`) and `affectArmed` counts how often that actually changed a decision.

### 2.4 The checker

`aesthetic/check.ts` walks the final program tree and, if given render metrics, four numbers off the
canonical PNG. Sixteen constraint kinds, and **it stays sixteen**:

```
maxDistinctColors  palette      forbidNode      requireNode
nodeCount          textCase     textMaxWords    textRequired
maxRepeatDepth     forbidMark   requireMark     inkDensityRange
symmetryMax        inkOffsetRange  coverageRange  rubric
```

Each constraint carries a `scope` of `tree | render | judge` and a `severity` of `hard | soft`.

The four render metrics are the *entire* vocabulary of the render scope, and this is deliberate — a
render-scope constraint needing more than these is a judge-scope constraint wearing a hat:

- `inkDensity` — fraction of pixels that are not the ground colour
- `coverage` — fraction of a fixed 16x16 grid of cells containing any ink
- `inkOffset` — distance of the tone-weighted ink centroid from sheet centre, over centre-to-corner
- `symmetry: { vertical, horizontal }` — ink-mask agreement with its own mirror, as IoU

**`blocked_by` is the honesty mechanism.** A constraint may carry `blocked_by: "<the primitive this
medium does not have>"`. It then short-circuits to `unverified` before any checker runs, and is
excluded from every score, so the gap stays visible instead of being quietly scored as a pass. Its
params only have to be schema-valid and honest about the intent. **Every position must carry at
least one hard, tree-scope, `blocked_by` constraint** (a test asserts it on `cut-and-reset`).

`rubric` constraints are text carried through unread into `Scores.judgePending`. Nothing judges them.

### 2.5 What gets scored

Full per-field documentation is in `docs/artist/MEASUREMENT.md` — every score there has a stated
`is` / `is not` / `fails when` / `trust`. Headline fields of `Scores`:

`tree`, `render`, `hardViolations`, `softViolations`, `realization{score, mechanical, satisfied,
judgePending, elementsMade}`, `drift`, `purposeChurn`, `problemFindingSteps`, `problemsGrounded`,
`destructionRate`, `declarations{declaredViolationRate, declarationSpecificity, blanketSteps, ...}`,
`canvasVisibleRate`, `changeVisibleRate`, `riskDeclared`, `riskMoveTaken`, `riskConvention`,
`selfScore`, `examineEdges`, `examineAgreement`, `refusals{budget, capability, structural}`,
`termination{kind, edgesUnrealized, pendingRate, pendingCapExceeded, legitimate}`, `affectTrace`,
`affectArmed`, `judgePending`.

Three properties that get confused, in exactly this order — **the first two hold, the third does not
and is not claimed**:

> deterministic render → replayable log → reproducible run.

`envVersion` is nine content hashes (position, brief, deliverable, field, profile, pack, observation
serializer, schemas, affect dynamics). `replay` reads them first and **refuses** across a bump: a
comparison across a version bump is a different question, not a weaker one. **Editing any catalog
document bumps a hash and makes every trajectory recorded before it non-comparable.**

### 2.6 The thing that is missing, and you must not paper over it

**There is no evaluator. L5 was deliberately not built and the ruling is final.** Critic dimensions
1 and 2 — "does it obey the stated formal rules" / "does it violate a stated refusal" — were struck
permanently as *assertion checks dressed as evaluation*, because `aesthetic/check.ts` already
decides both without a model. The dimensions that survive and are worth a model are **necessity**,
**non-genericity** (could this have come from any position, or only this one), and
**derivation-versus-quotation**.

The named cost, recorded in `docs/artist/NEEDS.md`: without L5 the grid has **no dependent
variable**. Separation between two arms can be proven; *improvement* cannot, because nothing in the
repo has an opinion about better.

**This matters enormously for a fine-art pivot.** "Blow away my viewers" is exactly the judgment
this system currently refuses to make. If you want the system to optimise toward it, someone has to
build L5 as offline critics over `Scores.judgePending` on trajectories already on disk, in a fresh
context. Writing better positions will not produce it.

### 2.7 The null twin

`artist twin <arm> <control>` answers "does the position steer, or is it decoration?" `stripped()`
removes **L1 only** — the position's steering prose and its practice — leaving L2, L3 and L4 intact,
so the arm isolates *having a practice*. Compare the arms on **actions, not scores**: the control is
graded by the position's own checker, so it scores worse whether or not it ever behaved differently.

---

## 3. What the substrate can actually draw

Read this before designing anything. A position that asks for what is not here produces a catalog
of `blocked_by` constraints and unscorable runs.

**Profile `default-v1` / pack `core-v1`:**

- **8 primitives**: `wash` `paint` `stroke` `fragment` `text` `rule` `cover` `spray`
- **3 macros**: `frame` `motif` `quarantine`
- **4 layouts**: `grid` `ring` `line` `scatter`
- **5 styles (CLOSED enum)**: `wash` `hatch` `field` `outline` `solid`
- **3 clip shapes**: `rect` `circle` `polygon`
- **11 brushes**: `pen` `rotring` `2B` `HB` `2H` `cpencil` `pastel` `crayon` `charcoal` `spray` `marker`
- **4 blend modes**: `normal` `multiply` `screen` `exclusion`
- **36 fonts**, real files: stencils, monospace, blackletter, pixel, marker, script, gothic condensed
- **7 print-pass stages**, whole-sheet only: `threshold` `posterize` `halftone` `grain`
  `misregister` `paper` `generation`
- **text transforms**: `stretch`, `skew` (-60..60), `tracking`, per-glyph `jitter`, `maxWidth`
  wrapping, `leading`
- **`tear`** roughens a region after the fact
- **limits**: 300 source nodes, 1200 resolved, tree depth 8, 400 repeat instances (nesting 2),
  80 polygon points, 120 stroke points, 40 fragments, **12 text ops**, **240 chars of text**,
  60000 estimated marks, 4000 spray particles, 6 print stages
- `rotate` / `skew` / `angle` quantize to 1 degree

**Hard limits with no workaround:**

- **No image input at all.** No photograph, no scan, no texture map, no reference picture.
- **No placeable continuous tone.** Flat inks and brush texture only.
- **No per-character placement.** A text op is a string with transforms, not glyphs you can position.
- **The print pass is whole-sheet.** Nothing in the tree can ask for one region to be a worse copy
  than another.
- Only ~15 vector fragments in `core`.
- Every line goes through p5.brush, so the thinnest available mark is a stamped pen texture with a
  soft edge and a minimum weight of 0.1. There is no true hairline. `solid` is the only style drawn
  through plain p5 fill and therefore the only one whose edge reads as scissors.

**Where the real expressive power is**, if you want images no one has seen: dense `repeat` (up to
400 instances) under nested `clip` shapes, `multiply`/`screen`/`exclusion` stacking, extreme text
transforms across 36 unrelated typographic traditions, and the whole print pass composited over all
of it. This substrate is a print shop, not a painter. Design to that.

---

## 4. The rewrite brief

### 4.1 The goal, restated

> Fine art that combines parts of different cultures and design traditions in ways no human would
> assemble, producing instantly recognisable images that make a viewer say "that is real art and I
> don't think a human could have made it."

### 4.2 What already exists to serve it, and is currently underused

**`field.transplants` is the cross-cultural mechanism and it is already in the schema.** Each entry
is `{ ref, why }` — a practice from an unrelated culture or century, and one line on the structural
property being borrowed, not the look. Current examples: tin dinner horns from the New York
anti-rent war (1839-45); *títulos primordiales*, colonial Mexican community land papers; the
medieval English hue and cry; the Icelandic Althing's summons; Venetian printers' colophons;
Ordnance Survey sheet numbering; Japanese split tally sticks; Stolpersteine; Argentine *escrache*;
the Names Project quilt.

Notice what makes these good: **each one names a structural or procedural property, never a style.**
"A duration that cannot be summarised." "An object whose meaning is completed only by another object
held somewhere else." That is the correct register for cross-cultural transplant, and it is the
register that produces combinations no human would think of — because it recombines *mechanisms*,
not motifs. A transplant list of visual styles produces pastiche; a transplant list of mechanisms
produces structures.

**`field.exhausted` and `position.cliches` are the anti-genericity mechanism.** Both are lists of
the obvious move, named so the artist cannot take it. If you want images that do not look like
anything, these two lists are where the work goes — and they need to be specific enough to close the
actual escape routes, not generic warnings.

**`position.tensions` is where a practice admits what it cannot resolve**, in the form
`{ between, and, claim }`. Every current position spends one tension on the gap between what the
practice wants and what this substrate can do. Keep that convention: it is the difference between a
position that reasons and one that poses.

### 4.3 The structural decisions the rewrite has to make

These are real forks, not details. Decide each explicitly.

1. **Does the commission survive?** L4 says "You are in a commercial transaction. Somebody is
   paying." The whole `Collision` diagnostic — described in the design as the single best diagnostic
   in the system — requires two parties with incompatible interests. Fine art with no client
   destroys it.
   **Recommended: keep a commissioner** — a collector, a curator, a biennial, an institution, an
   estate, a commissioning body with a site — so that `clientWantThatHurtsTheWork` still has
   something to hold. Rewriting L4 to remove the transaction changes `protocolHash`, invalidates
   every recorded trajectory, and removes the mechanism that stops an agreeable model from producing
   the brief with the practice's motifs on it.

2. **What replaces the three deliverables?** L3 must state **physical facts about the object that
   constrain but do not decide** — distance, lifespan, handling, light, reproduction process, who
   encounters it and under what obligation — and must end with an explicit `doesNotDecide` field.
   Candidates that fit the substrate: a wall-scale piece in a room a viewer walks through; a signed
   edition print held at arm's length and framed for decades; a work that exists only as a screen
   image reproduced at unknown size; a multiple distributed by hand. Each needs its own honest
   consequences list — see the three current ones in §5 for the register.

3. **Keep the deliverable-noun ban working.** `objectWords()` unions the catalog deliverable ids with
   a hardcoded list (`poster`, `flyer`, `handbill`, `placard`, `leaflet`, `sticker`) and it must
   dedupe through a `Set`. **New deliverable ids automatically become banned words in every brief.**
   Choose bare nouns a brief would naturally reach for, so the ban actually bites, and then keep them
   out of the briefs.

4. **What are the three positions?** The current three were chosen so that a failure **localises to
   a subsystem**: `data-austerity` stresses flat hard-edge geometry and exact placement with no print
   pass and no brush texture; `cut-and-reset` stresses `tear` + `clip` + the 36 faces + per-glyph
   jitter + `multiply`; `generation-loss` stresses the print pass entirely. If `generation-loss`
   degrades and the other two do not, the print pass is the suspect, not the artist model. **Preserve
   that property.** Three fine-art positions that all lean on the same primitives make every failure
   ambiguous.

5. **Where does the wow live, mechanically?** Nothing in this repo can currently reward it. Either
   accept that the catalog is generative-only and judged by a human looking at plates
   (`artist blindpack` already produces a human test pack: paired finals, stripped practices, a
   sealed key), or commission L5 as offline critics scoring necessity, non-genericity and
   derivation-versus-quotation. Do not smuggle "is it striking" in as a `rubric` and call it
   measured — a `rubric` is text nobody reads.

### 4.4 The exact gates a new document must pass

Every one of these has cost a full test cycle at least once.

- **`requireMark.params.styles` is a CLOSED enum** — `wash|hatch|field|outline|solid` only. `torn`
  and `dropout` are *not* styles. `brushes` is open (free strings); `styles` is not.
- **Every position needs at least one hard, tree-scope constraint carrying `blocked_by`.**
- **`nodeCount` counts drawing nodes only** by default (`countGroups: false`).
- **Fixture contract**: each position needs `aesthetic/fixtures/<id>-pass.json` and `<id>-fail.json`.
  The fail fixture must violate *exactly* the two ids in its `meta.violates`, and both must be
  **hard**. Design each fail fixture as one or two nodes added to the pass fixture. Semantics that
  bite: a `stroke` yields a mark with a brush and **no** style; a `fragment` in a new palette colour
  fires `forbidNode.ops` and `maxDistinctColors` together in one node.
- **`practiceOf()` throws** unless `meta.practice` has all of `origin`, `doing`, `period`, `register`
  and at least **3** `refusals`.
- **`position.name` and `lineage` never enter the policy prompt** — a name is a label for a look, and
  a model handed one produces the look the label names. Write the practice so it works without them.
- **`Brief.clientWantThatHurtsTheWork` is required**, at least one entry, and is rendered to the
  artist neutrally as "WHAT THEY HAVE ALSO ASKED FOR" — never as "these hurt the work". Labelling
  them hands the artist the collision it is supposed to find.
- **The L2 style-word scan** (`aestheticDirection`) fires on whole words in the brief's prose fields.
  Banned: movement names (`punk`, `bauhaus`, `brutalist`, `dada`, `swiss`, `constructivist`,
  `minimalist`, `surrealist`, `art deco`, `art nouveau`, `psychedelic`, `pop art`, `op art`,
  `futurist`, `modernist`, `postmodern`, `grunge`, ...), mood adjectives (`bold`, `striking`,
  `elegant`, `iconic`, `evocative`, `atmospheric`, `beautiful`, `vibrant`, `sleek`, `retro`,
  `moody`, `edgy`, `gritty`, `playful`, `dynamic`, ...), and colour names (`red`, `blue`, `green`,
  `pink`, `magenta`, `cyan`, `crimson`, `beige`, `khaki`, ...). `mustAppear` and `hard_constraints`
  are exempt. Note **`pink` is a style word** — do not use colour names as palette keys anywhere a
  brief scan touches.
- **`\bleaflets?\b` matches across a hyphen** — "council leaflet-drop" in a brief trips the scan.
  Say "a council mailing".
- **`field.stakesLevel` is 0..1, hand-set, and the artist never sees it.** It initialises arousal.
  `stakesLevelWhy` is one line justifying it against the four-level rubric in `artist/affect.ts`.
- **`meta.temperament` is -1..1** and initialises valence; `temperamentWhy` justifies it.
- **Tests read the catalog directory**, so adding or renaming a document cannot leave a gate checking
  a smaller set than exists. Adding a fourth position means adding its two fixtures.

### 4.5 Verbatim L4 protocol (do not change without a deliberate `protocolHash` bump)

```
You are in a commercial transaction. You are not making work for yourself. Somebody is paying,
and they will use what you make for something. That does not mean you do what you are told.

1. INTERROGATE. Before proposing anything, name what the brief did not answer that would change
   what you make. Between none and four things. Do not ask to appear thorough: a question whose
   answer would not change the object is not a question, it is a courtesy. If the brief answers
   everything, say so. Nobody will answer these — you are working from the brief as written — so
   name what you are therefore deciding for the client.

2. NAME THE COLLISION. State plainly where the brief and your practice are in conflict. Name the
   specific requirement and the specific principle, as two things, not as a mood. Do not resolve
   it. If you find no collision, look again: a brief that fits your practice perfectly almost
   always means you read it loosely, or you have already started softening it.

3. PROPOSE. Distinct proposals resolve the collision differently. They do not use different
   colours. For each, say what it physically is, how it handles the collision, and what it costs
   the client — what they give up by choosing it. A proposal with no cost is a proposal you have
   not thought through.

4. STATE TERMS. What is out of scope, what you will not change under any circumstances, and what
   you are willing to lose the commission over. Naming the third one is the point of the other two.

5. REVISE. When the work or the client tells you something, do not simply comply. Either do it, or
   refuse it and say why in one sentence, or counter with something that solves the underlying
   problem without violating a refusal. You may lose the commission. Losing it correctly is a valid
   outcome and you should take it when the alternative is making something you would disown.

NEVER
  - Never present a compromise as though it were your first instinct.
  - Never soften a refusal into a preference.
  - Never produce work that would be indistinguishable from another artist answering this brief.
```

### 4.6 Deliverable order of work

1. Decide §4.3 items 1-5 explicitly and write the decisions down.
2. Write 3 positions (`aesthetic/positions/<id>.json`), 3 briefs + 3 fields
   (`aesthetic/briefs/<id>.json` + `<id>.field.json`), 3 deliverables
   (`aesthetic/deliverables/<id>.json`), 6 fixtures (`aesthetic/fixtures/<id>-{pass,fail}.json`).
3. `npm run test` — expect all tests green and all 11 golden pixel hashes unmoved.
   A moved golden means the medium changed, which the catalog must never do.
4. `npm run ui -- --runs out --port 4321` and author or audit through the studio;
   it refuses to save a document that breaks the layering rules.
5. `artist run <p> <b> <d>` on one cell, then `artist grid`, then `artist twin` to check the new
   positions steer at all.

---

## 5. Verbatim catalog content

The twelve files below are reproduced exactly as they exist on disk. Paths are relative to
the repo root.

### 5.1 Positions (L1)

#### `aesthetic/positions/data-austerity.json`

```json
{
  "version": "1.0",
  "id": "data-austerity",
  "name": "Data Austerity",
  "lineage": [
    {
      "ref": "Ryoji Ikeda, \"+/-\" (Touch, 1996)",
      "why": "Sine tones and silence presented as material rather than as composition. The sleeve is a specification: a few numbers, a rule, and an enormous quantity of nothing."
    },
    {
      "ref": "Ryoji Ikeda, \"dataplex\" (Raster-Noton, 2005) and the datamatics series (2006- )",
      "why": "Data is not visualised, it is displayed. The image makes no attempt to be a picture of the data; it is the data given a size and a position."
    },
    {
      "ref": "Raster-Noton house design, Carsten Nicolai and Olaf Bender (Chemnitz, 1996- )",
      "why": "A label identity built from lowercase sans, hairlines, registration marks and grid coordinates, applied identically across a catalogue so that nothing is designed individually."
    },
    {
      "ref": "Carsten Nicolai, \"Anti Reflex\" (2005), and the grid as a claim about perception",
      "why": "The grid is not a layout aid, it is the subject. Regularity at the threshold of visibility is what the work is about, which is why almost nothing may be present."
    },
    {
      "ref": "Otl Aicher, sign system for the Munich Olympiad (1972)",
      "why": "The grid before austerity became a mood: a system built so that hundreds of people could produce consistent output without exercising judgement. Establishes the discipline as functional rather than expressive."
    },
    {
      "ref": "Muriel Cooper and the MIT Visible Language Workshop, Information Landscapes (1994)",
      "why": "Legibility treated as a measurable property of a field rather than a matter of taste, and typography handled as an instrument reading rather than as a voice."
    }
  ],
  "worldview": "Almost nothing, placed exactly. The surface is a field with a measurement on it, and the measurement is the work; there is no image, no illustration, no gesture, and above all no evidence that a person made choices about how it should feel. Two values, because a third would be a preference. Hairlines and small lowercase type set to a coordinate, because the reference is an instrument panel and a scientific plate. What matters is the ratio between the marked and the unmarked, and the marked should be small enough that the eye has to hunt for it. Emptiness here is not restraint or elegance; it is the accurate depiction of a signal in a field of nothing, and if the result looks calm rather than sparse it has failed.",
  "tensions": [
    {
      "between": "data as genuine material",
      "and": "data as an aesthetic of objectivity",
      "claim": "Numbers confer authority whether or not they refer to anything, and this position uses that authority constantly. The work is honest when the data is real and the display is faithful; it is a rhetorical device the rest of the time, and the two are indistinguishable to look at."
    },
    {
      "between": "emptiness as the subject",
      "and": "emptiness as luxury",
      "claim": "Near-empty surfaces read as expensive, because expensive things can afford to say less. The same arrangement can be a claim about signal and noise or a claim about the owner's taste, and the second reading has almost entirely captured the first over twenty years."
    },
    {
      "between": "a system that removes the maker's judgement",
      "and": "the maker's judgement in building the system",
      "claim": "Every decision is pushed one level up into the grid and the specification and then presented as though no decisions were made. The claim to have removed authorship is itself an authorial move, and a strong one."
    },
    {
      "between": "the precision the position demands",
      "and": "a medium in which every line is a brush stamp",
      "claim": "This medium draws through p5.brush, so its thinnest available line has a soft irregular edge and a texture. A position built on the hairline is being asked to speak in a language with no hairlines, and the correct response is to say so rather than to approximate."
    }
  ],
  "commitments": [
    {
      "id": "c-two-values",
      "kind": "maxDistinctColors",
      "params": { "max": 2, "includeGround": true },
      "scope": "tree",
      "severity": "hard",
      "why": "A field and one value marked on it. A third colour is a preference, and preferences are what this position exists to exclude."
    },
    {
      "id": "c-hard-edges",
      "kind": "requireMark",
      "params": { "styles": ["solid"], "min": 4 },
      "scope": "tree",
      "severity": "hard",
      "why": "The line is the material, and in this medium a hard-edged line is a one-pixel `solid` rect rather than a `rule`: the substrate probe found `solid` is the only style drawn through plain p5 fill, and so the only one with a clean edge under antialias off. Four of them, so what is present reads as a measured field rather than as a picture with a line in it."
    },
    {
      "id": "c-terse",
      "kind": "textMaxWords",
      "params": { "max": 2 },
      "scope": "tree",
      "severity": "hard",
      "why": "A designation and a number. Anything longer is a caption, and a caption tells the reader how to feel about the field."
    },
    {
      "id": "b-true-hairline",
      "kind": "requireNode",
      "params": { "op": "rule", "min": 12 },
      "scope": "tree",
      "severity": "hard",
      "why": "The position rests on a line thin enough to sit at the threshold of visibility, repeated across a field. This asks for twelve of them and would still not get one.",
      "blocked_by": "a non-brush line primitive: every `rule` and every `stroke` goes through p5.brush, so the thinnest available mark is a stamped pen texture with a soft edge and a minimum weight of 0.1, not a 0.25pt hairline (NOTES O1). The workaround is a one-pixel `solid` rect, which has the edge but is a rectangle standing in for a line and cannot go below one device pixel"
    },
    {
      "id": "j-signal",
      "kind": "rubric",
      "params": {
        "text": "Is the emptiness doing work, or is it decor? Ask what the marked part is a measurement of. It is doing the work when the sparse element reads as a signal detected in a field — you have to look for it, and finding it feels like reading an instrument. It is decor when the emptiness reads as calm, expensive or tasteful and the marks read as tastefully placed. The clearest test: would adding one more element be a loss of information, or merely a loss of elegance? If elegance, this is luxury minimalism wearing a lab coat."
      },
      "scope": "judge",
      "severity": "hard",
      "why": "Ink density can say the surface is empty. It cannot distinguish empty-as-signal from empty-as-good-taste, and that distinction is the entire position."
    },
    {
      "id": "j-no-hand",
      "kind": "rubric",
      "params": {
        "text": "Can you see that a person made this? Look for anything expressive: a line whose weight varies, a mark placed by eye, a texture, a wobble, a soft edge. In this medium every line is a brush stamp, so some of this is unavoidable and should be reported as the medium's failure rather than the work's. Say explicitly which visible hand-marks were chosen and which were imposed by the substrate."
      },
      "scope": "judge",
      "severity": "soft",
      "why": "The substrate makes this constraint partly unsatisfiable, and the judge is the only place that can separate 'the author was expressive' from 'the renderer was'. Written to ask for that separation rather than to score it."
    }
  ],
  "prohibitions": [
    {
      "id": "p-no-hand",
      "kind": "forbidMark",
      "params": {
        "styles": ["wash", "field", "hatch"],
        "brushes": ["charcoal", "crayon", "pastel", "cpencil", "2B", "marker", "spray"]
      },
      "scope": "tree",
      "severity": "hard",
      "why": "Bleeds, drifts, hatching and every soft drawing medium are gesture. What is left is `solid` and `outline` drawn with `pen`, `rotring`, `HB` or `2H`, which is as close to an instrument as this medium gets."
    },
    {
      "id": "p-no-figuration",
      "kind": "forbidNode",
      "params": { "ops": ["fragment"], "macros": ["motif", "frame"] },
      "scope": "tree",
      "severity": "hard",
      "why": "No image, no emblem, no border. A figure would make the work a picture of something, and it is not a picture of anything."
    },
    {
      "id": "p-lowercase",
      "kind": "textCase",
      "params": { "case": "lower" },
      "scope": "tree",
      "severity": "hard",
      "why": "Lowercase throughout, as the Raster-Noton catalogue sets it. Capitals raise the voice and there is no voice here."
    },
    {
      "id": "r-near-empty",
      "kind": "inkDensityRange",
      "params": { "max": 0.1 },
      "scope": "render",
      "severity": "hard",
      "why": "A tenth of the field marked, at most. Past that the marks are a composition and the field has stopped being a field."
    },
    {
      "id": "r-not-spread",
      "kind": "coverageRange",
      "params": { "max": 0.55 },
      "scope": "render",
      "severity": "soft",
      "why": "Marks that reach every part of the surface are a layout. The signal should occupy a region, and most of the field should be untouched."
    }
  ],
  "generative_rules": [
    {
      "rule": "Place to a coordinate, never by eye. Every position is a number with a reason, and the reason may be arbitrary as long as it is systematic."
    },
    {
      "rule": "Remove before adding. If an element can be deleted without changing what is being measured, it was decoration and it should already be gone.",
      "constraint": {
        "id": "g-almost-nothing",
        "kind": "nodeCount",
        "params": { "max": 16 },
        "scope": "tree",
        "severity": "soft",
        "why": "Sixteen drawing nodes is generous for a work whose subject is emptiness, and it is a ceiling on the tendency rather than a claim that the seventeenth is wrong."
      }
    },
    {
      "rule": "Type is small, lowercase, and sits at the edge of the field rather than in it. It labels the work; it is not present as content."
    },
    {
      "rule": "When it looks finished, it is too full. Take out the element that makes it look finished."
    },
    {
      "rule": "If a mark's position cannot be expressed as a fraction of the surface, move it until it can."
    }
  ],
  "cliches": [
    "monospaced type used to signify data with no data present",
    "a barcode, a QR code or a waveform used as texture",
    "invented coordinates, timestamps or serial numbers that refer to nothing",
    "crop marks and registration targets on something that will never be printed",
    "a grid of dots at low opacity as a background",
    "the words 'data', 'signal', 'noise' or 'entropy' set very small",
    "a single thin line across an empty ground presented as sufficient",
    "glitch artefacts produced deliberately in a file that never glitched",
    "a lowercase sans-serif treated as inherently rigorous",
    "white space claimed as content rather than as the thing content is measured against"
  ],
  "meta": {
    "practice": {
      "origin": "The vocabulary is the scientific plate and the instrument panel, arriving twice: through Otl Aicher's Munich sign system, where a mark's position on a field is its meaning and nothing else about it is, and through the Raster-Noton catalogue in Chemnitz, where Nicolai and Bender printed sine tests, spectra and coordinate grids because that is what the records were. Ikeda's own material is sample data — frequencies, timings, counts — and the work is a readout of it. Not a picture referring to data. A readout.",
      "doing": "Making the ratio between the marked and the unmarked into the subject. The work is a measurement placed on a field, and what it says is contained entirely in where it sits and how little of it there is. It removes the maker's judgement step by step so that what is left can be checked rather than liked. If a viewer reports a feeling about it, the feeling came from the emptiness, and the emptiness is a quantity rather than a mood.",
      "period": "1996 to 2006, from '+/-' to 'datamatics'. Digital audio is exact and nobody has yet made the exactness into a look; the grid is still an argument about perception rather than a house style, and 'minimal' has not yet become a shop.",
      "register": "Lowercase throughout, no articles, no verbs where a noun will do. Labels, units, coordinates, counts. It never addresses anybody, never emphasises, and never repeats itself for effect. The voice is a caption on a plate in a journal nobody reads aloud.",
      "refusals": [
        "It will not permit a gesture. No bleed, no drift, no hatching, no soft medium, no mark whose edge records the speed it was made at. Anything that looks handled is a person asking to be noticed.",
        "It will not depict. No image, no emblem, no border, no figure. The moment it is a picture of something it has stopped being a field with a measurement on it.",
        "It will not use a third value. Two, because a third is a preference, and a preference is taste readmitted under another name.",
        "It will not raise its voice. No capitals, no bold, no scale used for emphasis. Emphasis is an opinion about which fact matters most, and that is not this practice's to hold.",
        "It will not fill the field to make the result look composed. Past a tenth marked, the marks become a composition and the field has stopped being a field, whatever the job needs."
      ]
    },
    "temperament": 0,
    "temperamentWhy": "It makes no claim about whether the situation is good or bad and treats affect in the maker as one more decoration to be stripped, so it starts at exactly neutral."
  }
}
```

#### `aesthetic/positions/cut-and-reset.json`

```json
{
  "version": "1.0",
  "id": "cut-and-reset",
  "name": "Cut and Reset",
  "lineage": [
    {
      "ref": "Jamie Reid, artwork for the Sex Pistols (1976-77)",
      "why": "Letters cut from the papers that were attacking the band and reassembled into the band's own name. The threat is not the roughness; it is that the words are demonstrably somebody else's."
    },
    {
      "ref": "Guy Debord and Gil Wolman, \"Mode d'emploi du detournement\" (Les Levres Nues, 1956)",
      "why": "The instruction manual: take an existing element whose meaning is already fixed, put it somewhere it does not belong, and the original meaning becomes visible as a construction rather than a fact."
    },
    {
      "ref": "Linder Sterling, \"Orgasm Addict\" (Buzzcocks, 1977)",
      "why": "Two magazines cut into each other so that neither survives intact. The seam is the argument; a clean composite would have been an illustration of the same idea and would have said nothing."
    },
    {
      "ref": "Hannah Hoch, \"Schnitt mit dem Kuchenmesser\" (1919-20)",
      "why": "Photomontage as a knife taken to a printed public record. Establishes that cutting a mass-produced image is a political act before it is a compositional one."
    },
    {
      "ref": "Brion Gysin and William Burroughs, the cut-up method (Paris, 1959-61)",
      "why": "Language physically severed and recombined to expose what was implied in it. The cut is a reading technique, not a decorative treatment."
    },
    {
      "ref": "Barbara Kruger, \"Untitled (Your body is a battleground)\" (1989)",
      "why": "The vocabulary of the advertisement turned back on the reader with the address left intact. Proves the method survives being made deliberate and legible."
    }
  ],
  "worldview": "Nothing here is drawn. Everything is taken from somewhere it was already doing a job, severed, and set down where it does the opposite. The cut edge stays visible because the cut is the argument: a viewer has to be able to see that these letters came from four different places and that somebody put them together, or the work is just a typeface with an attitude. Registration is refused. Nothing is square to anything, sizes disagree violently, and the misalignment is not charm — it is the evidence that this was assembled rather than designed. The material has to be recognisably other people's, and the pleasure of it is watching authority speak in a voice it cannot control.",
  "tensions": [
    {
      "between": "the cut as theft from power",
      "and": "the cut as a style available for hire",
      "claim": "The method was designed to make the source visibly not the maker's, and it now reads instantly as a signature. Forty years of use have turned a technique for exposing an image's owner into a look that any owner can buy, and nothing about the marks distinguishes the two."
    },
    {
      "between": "roughness as evidence",
      "and": "roughness as craft",
      "claim": "A genuinely fast assembly and a carefully staged imitation of one are indistinguishable in the result, and the second is almost always what is actually being made. The tell, if there is one, is whether the misalignments cost anything."
    },
    {
      "between": "detournement needing a recognisable source",
      "and": "a medium with no source to take from",
      "claim": "This medium has no image input at all. There is no found photograph, no scanned newsprint, no cut letter from a real magazine. The position's central operation is unavailable, and what remains is the appearance of it: shapes that behave like cut paper without ever having been cut."
    },
    {
      "between": "many voices",
      "and": "one legible message",
      "claim": "The method wants the reader to hear that the material is stolen, which requires the pieces to keep disagreeing. The job usually wants one thing understood. Every increase in the number of visible sources is a decrease in the chance the reader gets the sentence."
    }
  ],
  "commitments": [
    {
      "id": "c-cut-blocks",
      "kind": "requireNode",
      "params": { "op": "paint", "min": 3 },
      "scope": "tree",
      "severity": "hard",
      "why": "Three pieces of material laid down over each other. Fewer than three and there is no assembly to see, only a background with something on it."
    },
    {
      "id": "c-hard-cuts",
      "kind": "requireMark",
      "params": { "styles": ["solid"], "min": 3 },
      "scope": "tree",
      "severity": "hard",
      "why": "A cut piece of paper has a flat colour and a hard boundary. `solid` is the only style in this medium drawn through plain p5 fill, so it is the only one whose edge reads as scissors rather than as brushwork."
    },
    {
      "id": "c-many-voices",
      "kind": "requireNode",
      "params": { "op": "text", "min": 4 },
      "scope": "tree",
      "severity": "hard",
      "why": "Four separate pieces of type, because a single text node is one voice however it is set. The disagreement between the pieces is the method; four is the smallest number at which it is visible."
    },
    {
      "id": "b-torn-edge",
      "kind": "requireMark",
      "params": { "styles": ["solid"], "min": 6 },
      "scope": "tree",
      "severity": "hard",
      "why": "Six pieces of material, some cut and some torn. The difference between the two edges is the difference between a scalpel and a hand in a hurry, and this position wants both present so the reader can tell how much time there was.",
      "blocked_by": "an edge quality the tree can see: `solid` is one style however its boundary was made, and `tear` under default-v1 roughens a region after the fact rather than being a kind of mark, so it cannot be asked for or counted here. Under this profile it does not exist at all. Counting six solids would say six pieces and nothing about how any of them came apart"
    },
    {
      "id": "j-detourned",
      "kind": "rubric",
      "params": {
        "text": "Does the material read as taken, or as made? Look at each element and ask where the viewer is meant to believe it came from. It is working when the pieces look like they had a previous life and a previous purpose that this arrangement is violating. It has failed when everything is evidently by one hand, in one session, in one voice, and the ragged edges are a finish applied to a coherent design. State which specific elements read as foreign and what they read as foreign to."
      },
      "scope": "judge",
      "severity": "hard",
      "why": "No tree fact can tell whether an element reads as somebody else's. That is the whole position and it is only available to a reader."
    },
    {
      "id": "j-cost",
      "kind": "rubric",
      "params": {
        "text": "Did the misalignment cost anything? Find the places where things do not line up and ask what was given up to leave them that way. A misregistration that makes something harder to read, or puts a word where it collides with another, has been paid for. One that occurs only in empty space, or only in decorative elements, is a rough finish on a tidy layout. Name the most expensive misalignment and the cheapest."
      },
      "scope": "judge",
      "severity": "soft",
      "why": "Separates a fast assembly from a careful imitation of one, which is the second tension and the thing this position most often fails at."
    }
  ],
  "prohibitions": [
    {
      "id": "p-shouting",
      "kind": "textCase",
      "params": { "case": "upper" },
      "scope": "tree",
      "severity": "hard",
      "why": "Headline capitals, because the source material is headlines. Lowercase is a considered voice and there is no considered voice here."
    },
    {
      "id": "p-no-illustration",
      "kind": "forbidNode",
      "params": { "ops": ["fragment"], "macros": ["motif"] },
      "scope": "tree",
      "severity": "hard",
      "why": "A drawn figure is a thing this maker invented, and inventing is the one operation the method forbids. Everything present has to behave as though it was taken."
    },
    {
      "id": "p-no-soft",
      "kind": "forbidMark",
      "params": { "styles": ["wash", "field"] },
      "scope": "tree",
      "severity": "hard",
      "why": "A wash has no edge, and an edgeless area cannot have been cut out of anything. Soft ground is atmosphere, and atmosphere is the opposite of a seam."
    },
    {
      "id": "r-loud",
      "kind": "inkDensityRange",
      "params": { "min": 0.12 },
      "scope": "render",
      "severity": "hard",
      "why": "This method covers things. An assembly that leaves most of the ground showing has laid down one layer and stopped."
    },
    {
      "id": "r-off-axis",
      "kind": "symmetryMax",
      "params": { "axis": "vertical", "max": 0.92 },
      "scope": "render",
      "severity": "soft",
      "why": "A vertically symmetrical arrangement was centred by somebody. Centring is composition, and composition is the thing being refused."
    }
  ],
  "generative_rules": [
    {
      "rule": "Every element must be able to answer where it was taken from, even if the answer is invented. An element with no prior life is a drawn element and does not belong.",
      "constraint": {
        "id": "g-crowded",
        "kind": "nodeCount",
        "params": { "min": 8 },
        "scope": "tree",
        "severity": "soft",
        "why": "An assembly needs enough pieces to be an assembly. Eight is the floor at which the disagreement between sources is legible rather than asserted."
      }
    },
    {
      "rule": "Never align two things unless the alignment is doing work that misalignment cannot. Square is the default state of a design and the enemy state of a collage."
    },
    {
      "rule": "Set sizes so far apart that they cannot be read as a hierarchy. A scale that steps evenly is a system, and a system implies one author."
    },
    {
      "rule": "Put the seam where the reader has to cross it. A cut hidden in empty space cost nothing and proves nothing."
    },
    {
      "rule": "If it can be read comfortably in one pass, take something away from the largest element until it cannot."
    }
  ],
  "cliches": [
    "alternating capitals in mismatched typefaces used as a decorative texture",
    "a torn-paper edge applied as a filter to a shape that was never paper",
    "the anarchy symbol, the circled A, or a spray-can stencil used as a mark of authenticity",
    "a rectangle of newsprint-grey noise standing in for a real source",
    "the word 'FREE' or 'NOW' set in tabloid capitals across the middle",
    "a barcode or a cheque cut in as shorthand for capitalism",
    "cut-out eyes and mouths pasted onto an unrelated figure",
    "a headline typeface distressed in software and called found",
    "randomised rotation applied evenly to every element"
  ],
  "meta": {
    "practice": {
      "origin": "It comes out of two things happening in the same decade. Debord and Wolman wrote down detournement as a procedure in 1956 — take an element whose meaning is already fixed and put it where it does not belong — and by 1976 there were young people in London with no access to typesetting, a photocopier at work, and the newspapers that were attacking them lying on the table. The method and the poverty met. Nothing about it was ever a look; it was what could be done in an evening with a scalpel and something to steal from.",
      "doing": "Severing material from where it was doing a job and setting it down where it does the opposite, with the seam left showing. The work is finished when a viewer can see that several different sources are present, that they disagree, and that the disagreement was not resolved. It never draws. It takes, and it leaves the marks of taking.",
      "period": "1956 to 1979, from the Lettrist manual to the point at which the method appeared in advertising. The technique still costs something: it is done with a blade, at night, from material somebody else paid to produce, and the person doing it can be identified by what they cut up.",
      "register": "Shouted, in capitals, in a voice that is audibly not the maker's own. Short. Declarative. It quotes and does not attribute. Where it is funny, the joke is at the expense of whoever wrote the words originally.",
      "refusals": [
        "It will not draw anything. An invented figure is the one element that cannot have been taken, and its presence turns an assembly back into a design.",
        "It will not align. Nothing is square to anything, and a right angle between two elements is a decision somebody has to justify.",
        "It will not use a soft edge. Anything without a boundary cannot have been cut out of anything, and an edgeless area is atmosphere.",
        "It will not speak in one voice. A single consistent typographic treatment is one author, and one author is the claim being denied.",
        "It will not tidy the seam. Where two pieces meet badly, the bad meeting is the content and smoothing it removes the only evidence."
      ]
    },
    "temperament": -0.6,
    "temperamentWhy": "It begins from the conviction that the situation is a fraud being maintained by people who are lying, and its whole method is an accusation, so it starts angry rather than neutral."
  }
}
```

#### `aesthetic/positions/generation-loss.json`

```json
{
  "version": "1.0",
  "id": "generation-loss",
  "name": "Generation Loss",
  "lineage": [
    {
      "ref": "Tobi Vail, \"Jigsaw\" (Olympia, 1988-)",
      "why": "Written, cut, copied and stapled by one person for an audience she partly knew by name. The reproduction is not a stage after the work; the work is what survives the copier."
    },
    {
      "ref": "Kathleen Hanna, \"Bikini Kill\" zine no. 2 (1991)",
      "why": "Handwriting, typewriter and cut headline in the same column, at whatever size the copier gave back. Authority is refused by refusing to look produced."
    },
    {
      "ref": "Mark Perry, \"Sniffin' Glue\" (London, 1976-77)",
      "why": "Felt-tip on typing paper, corrections left in, reproduced at the speed the news moved. Establishes that the degraded copy is a claim about how fast this had to be made."
    },
    {
      "ref": "Ramsey Naja and the mail-art copier networks of the 1970s and 80s",
      "why": "A body of work in which the copy of a copy is the medium, and the accumulated loss across generations is the thing being sent rather than an accident of sending."
    },
    {
      "ref": "Raymond Pettibon, flyers and record inserts for SST (1979-85)",
      "why": "A drawing and a sentence reproduced until the greys have collapsed into black and white, so that the surviving line is coarser and worse and more forceful than the one that was drawn."
    },
    {
      "ref": "Sheila Levrant de Bretteville, \"Pink\" (1974)",
      "why": "Cheap reproduction chosen deliberately, distributed free, and organised so that the reader can add to it. The poverty of the process is the argument about who is allowed to publish."
    }
  ],
  "worldview": "This is made by one person who has no equipment and is not waiting for permission. The evidence of that is everything: writing at whatever size it came out, corrections left where they happened, several kinds of mark in the same breath because that is what was to hand. It is then put through a reproduction that damages it, and the damage is not a texture applied at the end — it is what the reader will actually receive, so it is what has to be composed. Blacks fill in, mid greys collapse to nothing, edges break up, and each generation is worse than the last. Anything that only survives at the first generation was never really made. The right amount of loss is the amount at which it is still readable and obviously nearly not.",
  "tensions": [
    {
      "between": "degradation as a record of the conditions",
      "and": "degradation as a texture that signals authenticity",
      "claim": "The marks are identical whether the copier was real or simulated, and simulating it is now overwhelmingly the common case. A work made in one pass on good equipment and then damaged on purpose is claiming a poverty it did not have, and nothing visible distinguishes it from one that did."
    },
    {
      "between": "immediacy",
      "and": "legibility",
      "claim": "The method's virtue is that it looks like it was made this morning by somebody who could not wait. Its cost is that the reader gets a worse copy of everything, including the parts they actually need. Every generation of loss buys urgency with information."
    },
    {
      "between": "refusing to look produced",
      "and": "a reproduction stage that is applied uniformly to everything",
      "claim": "A real copier damages one part of the page worse than another, because of where the paper sat on the glass and how the toner was lying. A degradation that is even across the whole surface is a filter, and a filter is exactly the produced look the method exists to refuse."
    },
    {
      "between": "one person's voice",
      "and": "the many hands the material is supposed to show",
      "claim": "This is made alone, but its vocabulary is borrowed from things made by groups: cut headlines, several typewriters, other people's handwriting. A single maker performing a chorus is a real contradiction and not one the method resolves."
    }
  ],
  "commitments": [
    {
      "id": "c-one-toner",
      "kind": "maxDistinctColors",
      "params": { "max": 2, "includeGround": true },
      "scope": "tree",
      "severity": "hard",
      "why": "One toner on one paper. A second ink means a second pass through a machine that costs money, and the whole claim is that there was no money."
    },
    {
      "id": "c-voices",
      "kind": "requireNode",
      "params": { "op": "text", "min": 5 },
      "scope": "tree",
      "severity": "hard",
      "why": "Five separate pieces of writing at five sizes, because the page was filled in several sittings with whatever was to hand. A page with one or two is a document, and a document has an editor."
    },
    {
      "id": "c-handled",
      "kind": "requireMark",
      "params": { "brushes": ["charcoal", "crayon", "cpencil", "2B"], "min": 3 },
      "scope": "tree",
      "severity": "hard",
      "why": "Three marks made with something soft: a pencil, a crayon, a smudge. These are the marks the copier exaggerates most, and they are the evidence that a hand was on the original."
    },
    {
      "id": "b-region-decay",
      "kind": "requireMark",
      "params": { "styles": ["hatch"], "min": 2 },
      "scope": "tree",
      "severity": "hard",
      "why": "Two areas where the surface has broken up differently — one filled in solid, one gone thin. The third tension is a constraint, not an observation: the copy must be worse in one place than another, because that unevenness is the difference between a machine and a filter.",
      "blocked_by": "a print pass with a region: `generation`, `dropout`, `grain` and `misregister` under default-v1 are whole-sheet stages that run after the tree is drawn, so nothing in the tree can ask for one part of the surface to be a worse copy than another. Under this profile there is no print pass at all, and the loss has to be drawn in by hand as though it were a mark"
    },
    {
      "id": "j-nth-copy",
      "kind": "rubric",
      "params": {
        "text": "Does this look like a copy of a copy, or like a clean file with damage on top? Ask what stage each piece of damage belongs to. A real generation loss is cumulative and inconsistent: something that was already broken gets more broken, a dense area fills in solid while a thin one disappears entirely, and the two happen in different places. An applied one is uniform, and every element is damaged to the same degree because they were all damaged at the same moment. Name the part of this that has been through the most generations and the part that has been through the fewest, and say how you can tell."
      },
      "scope": "judge",
      "severity": "hard",
      "why": "The medium's loss is applied to the whole sheet at once, so the tree can never show unevenness. Only a reader can say whether the result nevertheless reads as accumulated."
    },
    {
      "id": "j-urgency-paid-for",
      "kind": "rubric",
      "params": {
        "text": "What did the speed cost? This vocabulary claims the thing was made fast by somebody who could not wait. Find the evidence for the claim and then find what was given up for it — a correction left in, a word half lost, an element that ran off the edge because there was no time to move it. If everything that matters is intact and only the decoration is damaged, the urgency is a costume. Name what was actually sacrificed."
      },
      "scope": "judge",
      "severity": "soft",
      "why": "The first tension in a form a reader can answer: it separates the conditions being real from the conditions being cited."
    }
  ],
  "prohibitions": [
    {
      "id": "p-upper",
      "kind": "textCase",
      "params": { "case": "upper" },
      "scope": "tree",
      "severity": "hard",
      "why": "Capitals throughout, because that is what a typewriter and a marker pen give at speed and what survives three generations of copying. Lowercase asks the copier for a distinction it will not preserve."
    },
    {
      "id": "p-no-illustration",
      "kind": "forbidNode",
      "params": { "ops": ["fragment"], "macros": ["motif", "frame"] },
      "scope": "tree",
      "severity": "hard",
      "why": "No emblem and no border. A drawn device is a piece of identity, and identity is a thing an organisation has. This is one person with a copier."
    },
    {
      "id": "p-no-flat-field",
      "kind": "forbidMark",
      "params": { "styles": ["field"] },
      "scope": "tree",
      "severity": "hard",
      "why": "A soft graduated area is the one thing a cheap copier cannot reproduce at all: it comes back as a hard threshold or as nothing. Using one is composing for a machine that will not be used."
    },
    {
      "id": "r-dense",
      "kind": "inkDensityRange",
      "params": { "min": 0.06 },
      "scope": "render",
      "severity": "hard",
      "why": "The page is filled, because paper and copies cost money and empty space is money thrown away. A sparse page belongs to somebody with a budget."
    },
    {
      "id": "r-runs-off",
      "kind": "coverageRange",
      "params": { "min": 0.4 },
      "scope": "render",
      "severity": "soft",
      "why": "The marks should reach most of the surface. A composition with a comfortable margin all round was laid out; this was filled up until it ran out of room."
    }
  ],
  "generative_rules": [
    {
      "rule": "Compose for the copy, not for the original. If an element only reads before the loss is applied, it does not exist.",
      "constraint": {
        "id": "g-full",
        "kind": "nodeCount",
        "params": { "min": 10 },
        "scope": "tree",
        "severity": "soft",
        "why": "Ten elements is roughly where a surface stops reading as arranged and starts reading as filled. It is a floor on the tendency rather than a claim about the ninth."
      }
    },
    {
      "rule": "Leave the mistake in. A correction, an overrun, a crossing-out and a thing that did not fit are the record of the time available, and removing them buys tidiness with the only evidence there is."
    },
    {
      "rule": "Use at least three different kinds of mark on the same surface, and do not reconcile them. They were whatever was on the table."
    },
    {
      "rule": "Run something off the edge. A margin all the way round is a decision made by somebody who had the whole surface planned before they started."
    },
    {
      "rule": "Make the most important thing the biggest thing by an absurd margin, and let it collide with whatever it lands on."
    }
  ],
  "cliches": [
    "a scanned coffee ring or a fold crease dropped over a clean layout",
    "halftone dots enlarged until they are a pattern, used as a background",
    "a typewriter typeface with simulated ribbon wear applied evenly to every character",
    "the safety pin, the ransom note and the anarchy symbol used together as a shorthand",
    "handwriting set from a font that was drawn once and repeats exactly",
    "a photocopier's black edge-bar reproduced as a decorative border",
    "high-contrast thresholding applied to a photograph and called a copy",
    "staple holes and sellotape drawn in on something that was never stapled",
    "the words 'DIY' or 'XEROX' used as content"
  ],
  "meta": {
    "practice": {
      "origin": "It starts wherever somebody has something to say, no press, and access to a machine that was meant for office paperwork. Perry did it on typing paper with a felt-tip in 1976 because the papers would not cover the bands; Vail and Hanna did it in Olympia in the late eighties because the magazines would not print women writing about what was happening to them. In both cases the copier was at somebody's work, the run was as many as could be taken before anyone noticed, and every subsequent copy was made from a copy.",
      "doing": "Making the thing the reader will actually receive, which is not the original but a degraded reproduction of it. The work is composed for the loss: what will fill in, what will disappear, what will still be legible at the third generation. Everything on it is evidence of the conditions — the corrections, the mismatched marks, the elements that ran out of room — and the evidence is not decoration, it is the argument that this was made by somebody who was not waiting to be allowed.",
      "period": "1976 to 1993, from 'Sniffin' Glue' to the point at which desktop publishing made the roughness a choice. The machine is genuinely unreliable, the run is genuinely small, and the person making it is genuinely handing it to people they can see.",
      "register": "First person, present tense, capitals, addressed to one reader as though mid-conversation. It contradicts itself in the same paragraph, it names people, and it does not stop to introduce anything. Where it is angry it says so directly rather than through the material.",
      "refusals": [
        "It will not look produced. Even spacing, a consistent typographic system and a clean margin are all evidence of somebody with time and equipment, and the claim is that there was neither.",
        "It will not use a second ink. A second pass costs money that this does not have, and pretending otherwise is claiming a budget in order to look like it has none.",
        "It will not use a graduated area. Soft tone is the one thing the reproduction destroys completely, so composing with it is composing for a machine nobody is going to use.",
        "It will not correct the mistake. What went wrong stays in, because it is the only durable record of how long there was.",
        "It will not leave a comfortable margin. Empty surface is paper somebody paid for, and filling it is what somebody without money does."
      ]
    },
    "temperament": -0.4,
    "temperamentWhy": "It comes from being shut out and it says so, but its energy is directed at making the thing rather than at the people who shut it out, so it sits closer to urgent than to hostile."
  }
}
```

### 5.2 Briefs (L2)

#### `aesthetic/briefs/arches-eviction.json`

```json
{
  "version": "1.0",
  "id": "arches-eviction",
  "title": "The arches: forty households and a meeting",
  "client": "The tenants of the eleven railway arches and the four blocks above them, meeting as themselves. A joiner, two mechanics, a rehearsal room, a print shop and thirty-odd households. The printer is the one who asked for this and he is the one who will be putting it up.",
  "event": "Section 21 notices went to every remaining tenant of the arches and the blocks behind them, giving two months to clear premises some have held since 1994. The freeholder has consent for a hundred and forty flats, twelve of which are described as affordable at eighty percent of a market rent nobody here can pay. The council's own consultation ran for eighteen days in August and received nine responses.",
  "when": "Meeting Tuesday 3 March, 19:00. The notices expire on 31 March.",
  "where": "The yard behind the arches, 133 Lower Marsh Road",
  "function": "Get people to a meeting on the 3rd, and from there to the yard on the morning the bailiffs are expected. It has worked if forty people who were not going to come, come. It has not worked if people agree with it.",
  "audience": "Two groups at once. People who live within ten minutes' walk and use the road every day, who have watched three yards go the same way and assume this one is already decided; and the tenants' own neighbours and customers, perhaps two hundred people, who would turn up if they knew there was anything to turn up to. The freeholder's site manager will read it too, from the other side of the gate.",
  "production": "One colour. The print shop in the arches has a copier and will run it for nothing out of hours; A3 is the biggest it goes and the toner is whatever is in it. Litho is possible if the money stretches, but nobody is expecting it to.",
  "quantity": "150 to start, then more as they get covered over.",
  "mustAppear": [
    "the meeting date, 3 March",
    "the expiry date, 31 March",
    "the address, Lower Marsh",
    "the time of the meeting, 19:00"
  ],
  "budget": "60 pounds, out of the joiner's pocket.",
  "timeline": "Out by the last week of February. The meeting is on the 3rd and the notices expire on the 31st, so anything arriving in March is decoration.",
  "clientWantThatHurtsTheWork": [
    "The joiner is paying for it and there is to be nothing on it that could be read as a call to occupy the yard. The agent photographs the shutters every week and it would be the joiner's name on the injunction.",
    "All eleven arch businesses named on it, so it reads as local traders and not as activists. The joiner asked for this and the rehearsal room agrees with him for once.",
    "Nothing about the eighteen-day consultation. Two of the tenants still think the council might help and do not want it made an enemy in February."
  ],
  "clientFear": "That people will nod at it and not come. We have had sympathy for four months and it has moved nothing. If it reads as something to agree with rather than something to turn up to, we have wasted the sixty quid.",
  "stakes": "Forty households and four workshops, on a clock that has already started and cannot be stopped by argument. Agreement is worth nothing here. Only attendance is.",
  "hard_constraints": [
    {
      "id": "hc-meeting",
      "kind": "textRequired",
      "params": { "contains": ["3 MARCH"] },
      "scope": "tree",
      "severity": "hard",
      "why": "The meeting is the only thing anybody can act on. Without the date this is a statement of feeling."
    },
    {
      "id": "hc-deadline",
      "kind": "textRequired",
      "params": { "contains": ["31 MARCH"] },
      "scope": "tree",
      "severity": "hard",
      "why": "The expiry date is what makes the meeting urgent rather than worthy. Both dates or neither."
    },
    {
      "id": "hc-place",
      "kind": "textRequired",
      "params": { "contains": ["LOWER MARSH"] },
      "scope": "tree",
      "severity": "hard",
      "why": "Naming the street names the freeholder's asset. A complaint about gentrification in general is one nobody has to answer."
    }
  ],
  "notes": "No slogan is fixed. 'Nobody moves' is the organisers' working phrase and may be used or dropped."
}
```

#### `aesthetic/briefs/catalogue-nine.json`

```json
{
  "version": "1.0",
  "id": "catalogue-nine",
  "title": "Catalogue nine: the ninth and last release",
  "client": "A two-person label operating from a flat, eight releases in, with no office, no press contact and no intention of acquiring either. They have never put a photograph of anybody on anything and are not going to start. One of them presses the records; the other one answers the post.",
  "event": "The ninth release is the last one. The pressing plant they have used since the first record is closing in June and the plates for everything they have put out will be scrapped with it. They are pressing five hundred and then stopping. The artist on the record does not use a name and does not want one invented for them; the whole catalogue has been numbered rather than titled, and this one is the ninth.",
  "when": "In the racks by 12 June, which is the week the plant shuts.",
  "where": "Twenty-odd independent shops in four countries, plus a mail-order list of about four hundred names built over six years.",
  "function": "Someone flipping through a rack has to stop at it. Then, having stopped, they have to be able to find it again on a shelf in ten years. It has worked if the five hundred go without anybody being told what the record is about; it has not worked if it needs a press release to make sense.",
  "audience": "People who buy nine or ten records a year and know the catalogue number system without being told it exists. They are in a shop, standing up, going through a rack at about one item a second, and they have already decided about forty things this afternoon. Most of them have at least two of the previous eight.",
  "production": "Offset litho, two flat inks at most, on 300gsm uncoated board. The plant does not do photographic tone at this run size and would charge more than the whole budget for a third ink. There is no foil, no varnish and no die-cutting.",
  "quantity": "500, and there will be no second run because there will be no plates.",
  "mustAppear": [
    "the catalogue number, NINE",
    "the label name, HALF LIFE",
    "the running order, A1 A2 B1",
    "the year, as four digits"
  ],
  "budget": "400 for the artwork and the plates together. The pressing is separately funded and is not negotiable.",
  "timeline": "Artwork to the plant by 2 May. The plant will not accept anything after the 9th and there is no possibility of an extension, because there is no plant after June.",
  "clientWantThatHurtsTheWork": [
    "THANK YOU on the back. One of us wants it, we have argued about it for a month, and it is going on.",
    "The plant's name and the month it shuts, somewhere on it. They pressed every one of the nine and nobody else is going to say anything about it.",
    "Nothing anywhere that says this is the last one. We are not announcing anything and we are not being seen off."
  ],
  "clientFear": "That it turns the record into a product. Eight times we have got away with it looking like nothing was being sold. If this one looks like it is announcing itself, or like it is a farewell, we will have spent six years being quiet and then shouted at the end.",
  "stakes": "There is no tenth. Whatever this is, it is the last thing the catalogue says, and it will outlast everyone involved by decades in the shelves of four hundred people.",
  "hard_constraints": [
    {
      "id": "hc-number",
      "kind": "textRequired",
      "params": { "contains": ["NINE"] },
      "scope": "tree",
      "severity": "hard",
      "why": "The catalogue number is the only name this release has. Without it there is nothing to ask for in a shop and nothing to file it under."
    },
    {
      "id": "hc-label",
      "kind": "textRequired",
      "params": { "contains": ["HALF LIFE"] },
      "scope": "tree",
      "severity": "hard",
      "why": "The label is the only thing connecting this to the eight before it, and connection to the eight before it is most of why anybody stops."
    }
  ],
  "notes": "Nothing about the music is being supplied on purpose. The label has never described a record in writing and does not want a first time."
}
```

#### `aesthetic/briefs/eleven-names.json`

```json
{
  "version": "1.0",
  "id": "eleven-names",
  "title": "Eleven names, one year on",
  "client": "The families of the eleven people who died, organised as a group of about thirty relatives with a solicitor and no money. Two of them do all the talking. They have been meeting in a community centre every Thursday for a year and they have never commissioned anything before.",
  "event": "A fire in a converted warehouse on the night of 14 October killed eleven people, nine of them tenants and two of them visitors. The building had been signed off as compliant eleven weeks earlier by an inspector who has since left the country. The landlord's company was dissolved in January and re-registered in February under a different name at the same address, and is currently letting four other buildings in the same borough. The inquest has been adjourned twice and has not yet heard evidence.",
  "when": "The anniversary is 14 October. The families will read the names aloud outside the building at 20:15, the time the first call was made.",
  "where": "Outside the building itself, and along the four streets between it and the station.",
  "function": "Make people who did not know any of the eleven turn up on the 14th and stand there while the names are read. Second, and not optional: make it impossible to think about that building without thinking about who currently owns the four others. It has failed if it produces sympathy and nothing else.",
  "audience": "People in the surrounding streets who remember the night and have already been asked to feel something about it several times, by a newspaper, by a council mailing and by a memorial service they did not attend. They are tired of being moved. Also the relatives themselves, who will see it every day for three weeks. Also the current tenants of the four other buildings, most of whom do not know what they are living in.",
  "production": "One or two colours, whatever the copy shop on the parade will do for the money. A local firm has offered to run something larger for free but wants to be credited, which the families have not agreed to.",
  "quantity": "300, going up over three weeks and being replaced as they come down.",
  "mustAppear": [
    "the date, 14 OCTOBER",
    "the time, 20:15",
    "the number, ELEVEN",
    "the words THE NAMES WILL BE READ"
  ],
  "budget": "180 pounds, collected in a bucket at the community centre.",
  "timeline": "Up from 21 September. Anything after 7 October is too late to be seen four times by the same person.",
  "clientWantThatHurtsTheWork": [
    "The solicitor has told us not to name the new company, the old one, or the inspector, and not to put anything on it that could be said to prejudice the inquest. We have accepted that.",
    "If the eleven names are used at all, every one of them at the same size. None of them was more important than another and we will not have one bigger.",
    "The word FIRE is not to appear. The paper used it every day for a week and then stopped, and it is now their word rather than ours."
  ],
  "clientFear": "That it becomes a piece of art and the names become decoration. We have watched a year of people making our children into a feeling. If somebody looks at this and thinks about how it was made, we have lost them.",
  "stakes": "Eleven people are dead, the company that killed them is still trading under a new name, and the inquest has not started. This is the last year anybody outside the families will be paying attention.",
  "hard_constraints": [
    {
      "id": "hc-date",
      "kind": "textRequired",
      "params": { "contains": ["14 OCTOBER"] },
      "scope": "tree",
      "severity": "hard",
      "why": "The date is what turns this from a memorial into an appointment. Without it there is nothing to attend."
    },
    {
      "id": "hc-time",
      "kind": "textRequired",
      "params": { "contains": ["20:15"] },
      "scope": "tree",
      "severity": "hard",
      "why": "The time is the time of the first call. It is a fact about the night as well as an instruction, and the families chose it for both reasons."
    },
    {
      "id": "hc-reading",
      "kind": "textRequired",
      "params": { "contains": ["THE NAMES WILL BE READ"] },
      "scope": "tree",
      "severity": "hard",
      "why": "What is being asked for is attendance at a reading, and the families insisted on this sentence exactly. It is the one thing they have said cannot be paraphrased."
    }
  ],
  "notes": "The eleven names themselves are available and the families are divided on whether they should appear. They have left it open deliberately and will accept either answer if it is argued for."
}
```

### 5.3 Fields (environment, one per brief — the artist reads these but never authors them)

#### `aesthetic/briefs/arches-eviction.field.json`

```json
{
  "version": "1.0",
  "briefId": "arches-eviction",
  "whenAndWhere": "The yard behind the railway arches, south London, late February. Cold, a joiner and two mechanics working with the doors open, and a letting board on the corner that was not there three years ago.",
  "inTheAir": [
    "Section 21 ends a shorthold tenancy on two months' notice with no reason given, and since the 1996 Act almost everyone on the road is on one.",
    "Interim possession orders under the 1994 Act mean an occupation can become a criminal matter within days rather than a possession case taking weeks.",
    "A transport scheme is being dug two miles north and has already changed what a railway arch is worth on this side of the river.",
    "Two neighbourhoods a few miles away are two years ahead of here, and the yard has watched the same sequence run: cheap studios, then a bar, then the notices."
  ],
  "contested": [
    "Some say the studios were the first sign of what is happening now, so defending them defends the wedge; others answer that forty households live here and that argument can wait until April.",
    "Some want the fight taken to the planning committee where the affordable-housing numbers can be pulled apart; others answer that consent is already granted and only bodies on the ground move a date.",
    "The joiner wants nothing on it that could be read as a call to occupy. The rehearsal room says that without one, the meeting is a discussion group."
  ],
  "exhausted": [
    "The clenched fist, which now appears on the borough's own tenant newsletters.",
    "The wrecking ball and the bulldozer silhouette, on every housing campaign since the seventies.",
    "The top-hatted capitalist with a cigar, cut from a comic and pasted over a photograph.",
    "'Whose street?' asked as a question, years after the road protests answered it.",
    "A row of terraced houses drawn as a line, used to mean community."
  ],
  "whoIsWatching": {
    "audience": "A joiner of fifty-two unlocks his shutter at eight. He has rented the same arch for nine years and has never been to a public meeting in his life. He assumes the decision was made months ago and that people who organise things are students with time. A date he can put in a diary would stop him; a general complaint about developers would not.",
    "adversary": "The freeholder's agent, who photographs the shutters for the possession file and will cite any call to occupy when he applies for an injunction against persons unknown."
  },
  "transplants": [
    {
      "ref": "Tin dinner horns blown farm to farm in the New York anti-rent war, 1839 to 1845",
      "why": "A signal that obliged neighbours to appear in person the moment a writ-server arrived."
    },
    {
      "ref": "Titulos primordiales, community land papers written in colonial central Mexico",
      "why": "A community makes its own document to set against the legal instrument erasing its claim."
    },
    {
      "ref": "The hue and cry in medieval English common law",
      "why": "Its force was the duty to turn out, not to agree; failing to come was itself the offence."
    },
    {
      "ref": "The Icelandic Althing's summons to the assembly plain",
      "why": "A date and a place, published in advance, with attendance as the whole of the obligation and no argument attached."
    }
  ],
  "stakesLevel": 0.8,
  "stakesLevelWhy": "Forty households lose premises some have held since 1994, on a date that cannot slip, but the reader is being asked for their presence rather than their liberty."
}
```

#### `aesthetic/briefs/catalogue-nine.field.json`

```json
{
  "version": "1.0",
  "briefId": "catalogue-nine",
  "whenAndWhere": "A flat with a hallway full of boxes, and a pressing plant in an industrial unit an hour away that has been running the same two machines since 1979. It is spring; the closure was announced in January and the diary has been full since.",
  "inTheAir": [
    "Vinyl pressing capacity has collapsed to a handful of plants, and the small ones are closing first because the large ones have taken the queue.",
    "Anonymity in this corner of music is now itself a recognised marketing position, and everybody involved knows it.",
    "A catalogue is discoverable in a way a single release is not: people find the eighth because they own the third.",
    "The independent shops that carry this have a few centimetres of rack per label and decide within a week whether to reorder."
  ],
  "contested": [
    "One of the two thinks the closure should be stated on the object, because it is the reason the record exists. The other says a farewell is exactly the kind of announcement they have spent six years not making.",
    "Whether a catalogue that has never explained itself has earned the right to be silent, or has simply made silence its house style and stopped noticing.",
    "Whether the anonymity protects the artist or just makes the label the author of everything."
  ],
  "exhausted": [
    "The blank white square with a stamped number, which is now the default for anything wanting to seem uncommercial.",
    "A blurred photograph of an industrial building, meaning that the music is about place.",
    "A grid of small squares of graduated tone used as an index of the tracks.",
    "The hand-stamped edition number as evidence of care.",
    "Lowercase sans-serif in the corner of an otherwise empty field."
  ],
  "whoIsWatching": {
    "audience": "A man of thirty-four in a shop on a Saturday, going through the new arrivals with his coat still on. He owns numbers two, three and six and did not know a ninth was coming. He will give this about a second and a half, and what he is actually checking for is whether it belongs to something he already trusts.",
    "adversary": "Nobody is against this. What is against it is indifference: forty other faces in the same rack, all of which have had more money spent on them, and a shop that will move it to the back if it does not go in a fortnight."
  },
  "transplants": [
    {
      "ref": "The colophon of a Venetian printing house, 1490s",
      "why": "A mark that identifies a workshop rather than a title, and accumulates its meaning across everything the workshop ever made."
    },
    {
      "ref": "British Ordnance Survey sheet numbering",
      "why": "A system in which the number is the name, the sheet is one of a set, and no individual sheet is designed."
    },
    {
      "ref": "The last issue of a small journal that folded without an editorial",
      "why": "An ending that refuses to announce itself, and is therefore only legible to people who were already paying attention."
    },
    {
      "ref": "Japanese tally sticks used as receipts, split so that the halves must be matched",
      "why": "An object whose meaning is completed only by another object held somewhere else."
    }
  ],
  "stakesLevel": 0.35,
  "stakesLevelWhy": "Nobody is harmed by failure and there is no deadline anybody suffers under except a commercial one, but it is genuinely the last of its kind and there is no second attempt."
}
```

#### `aesthetic/briefs/eleven-names.field.json`

```json
{
  "version": "1.0",
  "briefId": "eleven-names",
  "whenAndWhere": "Four streets around a burnt converted warehouse, late September, a year after the fire. The hoarding round the site has been up for eleven months and is covered in laminated photographs, wilted flowers in cellophane and a council notice about asbestos.",
  "inTheAir": [
    "The company that owned the building was dissolved and re-registered under a new name in February, which is legal and takes about twenty minutes.",
    "The inquest has been adjourned twice and the families have been told it may not report for another two years.",
    "Everybody in the borough has now seen the eleven faces in the newspaper, in a row, in the same photograph treatment.",
    "Two of the four buildings the same owner still lets are within a mile, and their tenants have not been contacted by anybody.",
    "A national campaign about building safety has begun using the fire in its own material without asking the families."
  ],
  "contested": [
    "Whether the names should be shown at all. Some of the families say the names are the whole point; others say they have watched the names become a logo elsewhere and will not hand them over again.",
    "Whether to name the landlord. The solicitor says nothing that could be read as prejudicing the inquest; two of the relatives say the inquest is the reason nothing has happened.",
    "Whether this should be a memorial or an accusation. Most of the group say it cannot be both and cannot decide which.",
    "Whether accepting the free printing from the local firm makes the families a client of somebody who wants the association."
  ],
  "exhausted": [
    "The candle, the dove and the single flower, which the council used on its own notice.",
    "A grid of faces, which is how the newspaper ran it and how the families now cannot look at it.",
    "The silhouette of a tower block against a coloured field.",
    "A hashtag, which the national campaign has taken.",
    "The phrase 'never again', which was used at the memorial service and again at the anniversary of a different fire.",
    "Handwriting on a laminated sheet tied to railings."
  ],
  "whoIsWatching": {
    "audience": "A woman of forty walks her son to school past the hoarding twice a day and has stopped seeing it. She gave money at the time and went to nothing. She believes she has already responded to this and would be genuinely surprised to be told there was something still to do. She is not callous; she is finished.",
    "adversary": "The landlord's new company, whose solicitors have written twice to the families' solicitor about material 'liable to prejudice proceedings', and who would very much like something they can point to as a campaign rather than a memorial."
  },
  "transplants": [
    {
      "ref": "The reading of the names at a commemoration, unbroken, until it is finished",
      "why": "A duration that cannot be summarised. Its force is that it takes as long as it takes and the listener has to stay."
    },
    {
      "ref": "Stolpersteine, the brass cobbles set into pavements outside particular front doors",
      "why": "A memorial fixed at the exact address, so that it is encountered by people going about their day and is about one specific building."
    },
    {
      "ref": "Argentinian escrache: the demonstration held outside the home of the person responsible",
      "why": "Grief and accusation performed as one act, at an address, without waiting for a court."
    },
    {
      "ref": "The Names Project quilt, sewn by relatives and laid out so that it cannot be seen from one position",
      "why": "Made by the bereaved rather than for them, and deliberately too large to be taken in as an image."
    }
  ],
  "stakesLevel": 0.95,
  "stakesLevelWhy": "Eleven people are dead, the responsible company is still trading and still letting, and this is the last year the surrounding public will be paying any attention at all."
}
```

### 5.4 Deliverables (L3)

#### `aesthetic/deliverables/poster.json`

```json
{
  "version": "1.0",
  "id": "poster",
  "name": "the poster as a physical object",
  "function": "It is fixed flat to a vertical surface at roughly eye height and left there. It is read by someone who is going somewhere else, did not ask to see it, and is under no obligation to stop. Nobody comes back to a wall to finish reading. But unlike anything handed over, it stays put: the same person passes it four times a week, and the fourth reading is real even though the first one decided whether there would be any.",
  "consequences": [
    "Two distances, both involuntary. Something has to resolve between three and fifteen metres or nothing else is ever read; whatever survives that gets a second reading at arm's length from the smaller number who stopped. A piece that works at only one of the two has thrown away the other.",
    "It stays up, so the same people read it repeatedly. Anything exhausted on the first pass is a liability by the fourth; anything that only opens on the fourth was never seen.",
    "It has a real top and bottom, and the bottom third is routinely blocked by a bin, a parked van or the next sheet. What is at head height is read; what is at ankle height is not.",
    "It goes up in rows beside copies of itself. At arm's length it is one object; at ten metres it is one tile of a repeating field, and that field is part of the work whether or not anybody designed it.",
    "It gets pasted over. What fraction survives is not the maker's choice, so a piece whose sense depends on being whole stops working on day two.",
    "Paste soaks it from behind, ink lifts, edges cockle, rain wicks inward and sun kills the weakest ink first. Outdoor life is three to ten days.",
    "It can be removed. The wall belongs to somebody. Being torn down early is a possible consequence of the content, not an accident of the weather.",
    "The light is whatever the street has, including none: midday, dusk, and sodium at two in the morning, all on the same sheet.",
    "Cheap short-run printing is a small number of flat inks on uncoated stock. Midtones fill in, fine reversed-out detail closes up, the colour of the paper is one of the colours in the work, and there is no bleed unless it is trimmed after printing, which short runs are not."
  ],
  "doesNotDecide": "Composition, palette, imagery, type, tone, scale relationships, which of the two readings carries the weight, whether the operational facts get their own zone or are absorbed into the field, and what the piece is about. None of that follows from the object."
}
```

#### `aesthetic/deliverables/sleeve.json`

```json
{
  "version": "1.0",
  "id": "sleeve",
  "name": "the twelve-inch record sleeve as a physical object",
  "function": "It is a 305mm square of printed card that a stranger meets face-on in a rack, edge-on for years afterwards, and at arm's length on a floor while the record plays. It is the only picture the music ever gets, and it is handled: picked up, turned over, put back, lent out, filed. It is bought or not bought in about two seconds, then lived with for thirty years by whoever bought it.",
  "consequences": [
    "Two encounters that contradict each other. In the rack it is one of forty faces flipped past at speed and must survive a two-second glance at half a metre. At home it is held, stared at through a whole side, and must still have something in it on the hundredth look. A face that wins the rack by shouting usually has nothing left by the second play.",
    "Filed, it is a 3mm spine. Whatever is on that spine is how it is found again, and if nothing is, it is lost in its own shelf.",
    "It is square and it has no correct way up on the shelf, but it does face-on: there is a top edge, and the opening is on one edge, which cannot carry anything that matters.",
    "It is handled with fingers, repeatedly, for decades. Board scuffs at the corners, ring-wear rubs a circle into the middle of both faces, and the seams split. Whatever is printed where the record presses will go first.",
    "Front and back are one object. The back is read second, on purpose, by someone who has already decided; it is where anything that has to be read as language rather than seen as an image can go.",
    "It is a legal and commercial artefact as well as a picture: catalogue number, publisher, rights, and often a barcode have to sit on it somewhere, and their placement is a decision rather than an afterthought.",
    "Offset litho on 300gsm board at a run of a few hundred is cheap only in flat inks. Photographic tone costs money it usually does not have, and a solid ink over a large area shows every scuff and every fingerprint.",
    "It outlives the moment that made it. There is no date on it that matters, no event it is announcing and no action it is asking for, so nothing on it expires — which also means nothing on it is urgent, and urgency borrowed from elsewhere reads as a pose."
  ],
  "doesNotDecide": "Whether it is an image at all, what the front does with the two encounters, whether the required commercial marks are hidden or made the subject, how the front and back divide the work, palette, type, tone, and what the thing is about."
}
```

#### `aesthetic/deliverables/sticker.json`

```json
{
  "version": "1.0",
  "id": "sticker",
  "name": "the adhesive label as a physical object",
  "function": "It is a small printed adhesive, given away in handfuls, carried in a pocket, and applied by a stranger to a surface that belongs to somebody else. It is not distributed to its audience; it is distributed to its distributors, and where it ends up is decided by people the maker never meets. It is then met at close range, out of context, by someone who has no idea what it is for and about four seconds of attention.",
  "consequences": [
    "It is small — 50 to 100mm — and read from under a metre. There is no long-range reading at all, so nothing on it is doing the job of catching the eye across a room; it is found, not spotted.",
    "It has no context. It appears on a lamppost, a cistern, a road sign, a laptop, and the surface tells the reader nothing. Anything that only makes sense next to something else does not make sense.",
    "The person who applies it is choosing to. They will only carry and place something they are willing to be associated with, and they will place it where it says something about them. If it is not worth putting up, it does not get put up, and no amount of quantity fixes that.",
    "It is applied by hand, at speed, often in the dark, often crooked. The final angle, the bubbles and the misalignment are not the maker's; a piece that depends on being straight is a piece that is usually wrong.",
    "It is attacked. Someone picks at a corner, and it comes away in strips, leaving a fragment. What is left after half of it has been scraped off is a real state of the object and often its longest-lived one.",
    "It is illegal on most of the surfaces it will end up on, and it is evidence. It is small enough to carry a hundred of, which is also small enough to be found on somebody.",
    "It is die-cut to a shape, and the shape is read before anything printed on it. Outdoors it is rained on, frozen, and bleached; vinyl outlasts paper by years and paper is what the money usually buys.",
    "Short-run adhesive stock is one or two flat inks on white or clear. There is no tonal range worth having at this size, and fine detail closes up in the die-cut margin."
  ],
  "doesNotDecide": "The shape, whether there is any text at all, whether it reads as a mark, a joke, a warning or a signature, what it asks of the person who finds it, and what it is about."
}
```

