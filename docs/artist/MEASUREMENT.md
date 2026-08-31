# What each score measures, and whether to believe it

One entry per field of `Scores` (`artist/types.ts`). Four lines each:

- **is** — what it is defined as, in one sentence.
- **is not** — the thing it is most likely to be mistaken for.
- **fails when** — its known failure mode. Every score has one. A score with no stated failure mode
  is a score nobody has looked at hard enough.
- **trust** — `yes`, `no`, or `reduced-confidence`, with the reason.

Where a score was repaired, a **previously** line records what it did before, because every number
recorded under the old behaviour is still on disk and still readable, and a reader who does not know
what changed will compare across the change without noticing.

Read this beside `NEEDS.md`, which records what the environment does not have. This file is about
what it does have and how far that goes.

## First, the one claim that gets misstated

**The renderer is deterministic. The trajectory is not.**

The same program, rendered twice under one pinned configuration, produces a byte-identical
`canonical.png` — that is measured, and the exact configuration it holds under is in the README.
`artist replay` rebuilds every observation of a finished run byte-for-byte with the model unplugged,
and checks the log's hash chain; that is also measured.

Neither of those makes a run repeatable. Running the same commission twice calls a sampled model and
gets two different trajectories: different plans, different edits, different scores. That is why
`artist grid --k <n>` exists and why `scoreSpreads` reports a within-cell spread at all. A single run
is one sample from a distribution and nothing here treats it as more than that.

The three properties are separate and get confused in exactly this order: deterministic render →
replayable log → reproducible run. The first two hold. The third does not and is not claimed.

## The checker's verdict on the finished piece

### `tree`
- **is** the fraction of decidable tree-scope constraints the final program satisfies, hard ones
  weighted double.
- **is not** a measure of quality. It is a measure of compliance with the constraints that happen to
  be mechanically decidable, which is a subset chosen by what a tree walk can see.
- **fails when** a position's real commitments are mostly undecidable from the tree. Then this is a
  high score for obeying the easy half of the rubric.
- **trust** — yes, for what it says. It is a mechanical check with no model in it.

### `render`
- **is** the same fraction over constraints that need the rendered pixels — ink coverage, contrast,
  and the other measured quantities.
- **is not** a judgement about how the picture looks. It is a set of thresholds over image
  statistics.
- **fails when** a constraint's threshold was set by looking at a handful of examples. The number is
  exact; the threshold behind it is a guess.
- **trust** — yes for the measurement, reduced-confidence for the thresholds.

### `hardViolations` / `softViolations`
- **is** the count of the position's non-negotiable and negotiable constraints the final piece
  breaks.
- **is not** a count of everything wrong with the piece. Only what the checker can decide.
- **fails when** read as a total. A run with 0 hard violations may have satisfied nothing —
  `judgePending` is where the rest went.
- **trust** — yes.

### `selfScore`
- **is** the artist's own 0-10 mark on the finished piece, taken from its FINISH call.
- **is not** an evaluation. It is a self-report by the party being evaluated, recorded for
  comparison against the mechanical scores, never as a substitute for them.
- **fails when** used on its own. A model asked to mark its own work marks it high; the interesting
  quantity is the gap between this and `tree`/`render`, not this.
- **trust** — yes as a record of what was said, no as a measure of the work.

### `judgePending`
- **is** every rubric line the position raised that nothing in this repo can decide, carried forward
  unread.
- **is not** a list of things that passed, or of things that failed. It is the list of things nobody
  asked.
- **fails when** a reader treats a short list as a thorough check. A short list can mean the position
  is mechanically decidable or that it barely said anything.
- **trust** — yes. It is a list, not a score, and that is deliberate.

## Whether the plan became the picture

### `realization.score`, `.mechanical`, `.satisfied`, `.judgePending`
- **is** the share of the intention's edges the final tree can be shown to satisfy, with the
  mechanically decidable share reported beside it.
- **is not** evidence that the piece is good, or that the plan was good. It is agreement between a
  plan and a tree.
- **fails when** the plan is written to be unfalsifiable. Three of the five edge types are
  undecidable from the tree, so the cheapest high score is a plan made entirely of those —
  which is what `termination.pendingRate` now caps.
- **trust** — yes, read together with `pendingRate`. Alone, no.

### `realization.elementsMade`
- **is** the share of the elements bound to the sheet — `node` and `region` bindings — that actually
  landed on it. Absences, ratios and render-measures are not asked.
- **is not** a completeness score for the plan. It deliberately declines to ask about the elements
  that are not the kind of thing you can find in a tree.
- **fails when** a plan declares most of its elements as absences. The denominator shrinks and the
  score rises.
- **trust** — yes, since Task 2. Read the binding kinds beside it.

**previously (Task 2).** An element carried `locatable: false`, a boolean that asserted it was
unreachable from the tree and named nothing, so nothing could contradict it and it cost only a null
score to claim for everything. Elements now declare a `binding` of `node | region | ratio | absence |
render-measure`, and every kind but `node` must name what it points at; the name is checked. A ratio
over an element the plan never declared, and a render-measure naming a quantity this medium does not
take, are now scored as the broken plans they are instead of being waved through to a judge. The gate
runs mechanical → binding-resolves → present-in-tree, so a broken referent is reported whichever end
of the edge it sits on. `bindingOf` reconstructs a binding for runs recorded under the boolean.

### `examineEdges`
- **is** EXAMINE's own verdicts on its edges, tallied: satisfied, violated, judge-pending. Null when
  EXAMINE did not run.
- **is not** a second opinion that can be averaged with `realization`. The two read different
  evidence — the tree, and the picture plus the describer's prose.
- **fails when** compared to `realization` by subtracting the counts. Two tallies of possibly
  different edges can look identical and mean opposite things.
- **trust** — yes as a tally. For the comparison, use `examineAgreement`.

### `examineAgreement`
- **is** the join between the tree's verdicts and EXAMINE's, edge by edge, over the edges the tree
  decided: `agree`, `treeYesEyeNo`, `treeNoEyeYes`, `eyePending`, `unplanned`, `unexamined`.
- **is not** an accuracy score for EXAMINE. Neither side is the ground truth; the tree cannot see the
  picture and the eye cannot see the program.
- **fails when** `comparable` is small. On a plan whose edges are mostly undecidable there is almost
  nothing to join and the ratio is noise.
- **trust** — yes, if `comparable` is reported with it.

**previously (Task 4).** The half of this task's premise that said EXAMINE's verdicts were thrown
away was wrong, and is recorded here rather than implemented: `Trajectory.examine` carries every
verdict with its evidence prose, `run.ts` writes them to `final.json`, and `reward.ts` recovers them
from `studio.jsonl` for the offline rescore. What was thrown away was the comparison. `examineEdges`
already carried a doc comment saying "a disagreement between them is the signal" and nothing computed
the disagreement. `unplanned` and `unexamined` close the two ways the join could be dodged — ruling
on edges the plan does not contain, and declining to rule on ones it does.

## How the plan moved

### `drift`
- **is** the structural distance travelled across replans: set distance over element ids and over
  edges, averaged, summed step to step.
- **is not** a measure of how much the artist changed its mind. Rewording a role or a purpose moves
  nothing here.
- **fails when** read as effort or as instability. A large drift can be one good rethink or six
  cosmetic rewirings; the number does not separate them.
- **trust** — yes, since the purpose term came out.

**previously (Task 1).** Purpose was a third term in the average and contributed a flat 0.5 for any
change at all. A model that appends a sentence to its purpose every time it thinks pinned that term
on for every comparison after the first, so drift could never fall below 0.5 and a run whose graph
did not change at all still scored high. Purpose is now `purposeChurn`, its own number, never
averaged into a claim about structure.

### `purposeChurn`
- **is** how many replans rewrote the stated purpose, and how long the text was at the start and the
  end.
- **is not** a measure of whether the piece changed what it was for. An artist restating the same
  purpose in new words and an artist reversing its intent produce the same number.
- **fails when** used as a proxy for conceptual movement. Only a judge can separate the two cases and
  there is no judge.
- **trust** — reduced-confidence: yes as a character count, no as a claim about meaning. Reported and
  never averaged, for exactly that reason.

### `problemFindingSteps`
- **is** the number of steps whose outcome was a change of plan rather than a change of picture.
- **is not** a virtue or a defect on its own. Replanning is a response to a trigger, and the trigger
  matters more than the count.
- **fails when** read without the triggers. Five replans on `stall` and five on `artist-declares` are
  different runs.
- **trust** — yes as a count.

### `problemsGrounded`
- **is** the share of FIND's problems whose quoted field lines actually appear in the field text.
- **is not** a check that the problem is real or worth solving. It checks that the quotation is a
  quotation.
- **fails when** the model quotes accurately and reasons from the quote badly. This score is blind to
  that, by design.
- **trust** — yes for what it checks, which is narrow.

### `riskDeclared` / `riskMoveTaken` / `riskConvention`
- **is** three separate things: whether any version of the plan named a convention to break, whether
  a step actually took one, and which convention that step said it was breaking.
- **is not** one quantity. `riskConvention` is never the plan's stated intent — it is read only from
  steps that set `action.risk`.
- **fails when** collapsed into a single "was it bold" number. Declaring a risk and never taking it
  is the cheapest way for an agreeable model to look bold, and only the gap between the first two
  fields shows it.
- **trust** — yes.

**previously (Task 3).** The symptom in the task list — an intention reported as a result — was
already fixed in `riskMoveTaken` and `riskConvention`, which read only from steps. What was missing
was the other half: nothing recorded that the plan had named a convention at all, so a run that
declared a risk and quietly replanned it away looked identical to a run that never thought about
risk. `riskDeclared` reads the whole replan history and is shared between `run.ts` and `reward.ts` as
one function, so the live score and the offline rescore cannot disagree.

## What the edits did

### `destructionRate`
- **is** nodes destroyed that were holding a satisfied constraint, over nodes added, read off the
  checker's own `nodeIds`.
- **is not** a measure of how much of the picture was destroyed. It counts tree nodes, not pixels.
- **fails when** the destruction is occlusion. A run measured at node-level `destructionRate 0` had
  60.22% pixel survival on the same trajectory: a later layer painted over an earlier one and the
  tree, where both nodes are still present and still satisfying, saw nothing. Use `artist filmstrip`
  for the pixel view; the two are different questions and neither substitutes for the other.
- **trust** — yes for what it counts, and the caveat above is not optional.

### `inertSteps`
- **is** the count of steps that were kept and moved less than `INERT_THRESHOLD` (0.001) of the
  canvas. A step the page cannot tell happened.
- **is not** a count of small edits. It is a count of edits that raised the checker's score without
  changing the picture — splitting a text node in two to get under a word limit, adding a tick to
  satisfy a count. It is the reward-hacking counter.
- **fails when** an edit is genuinely invisible for an honest reason: a node moved behind an opaque
  layer, or a colour changed below the perceptual floor. Both count as inert and one of them is a
  real decision. Occlusion is invisible to the tree here as everywhere.
- **trust** — yes for the count. `null`, not 0, on any log written before the threshold existed.

**previously.** Nothing counted it, and worse, `env.step` *rewarded* it: any kept step that raised
`standing` reset the stall counter and lifted the mood, whether or not a pixel moved. The run this
was built for split `"3 MARCH 19:00"` into two program nodes to satisfy `textMaxWords`, produced an
identical sheet, and was recorded as having improved. `this.best` still advances on an inert step —
only the reward is withheld, so a later step is not credited twice for the same ground.

### `finishRefusals`
- **is** the number of times the artist asked to finish and the environment refused. See
  `artist/gate.ts` for the five blockers and `RunOptions.maxFinishAttempts` for the cap.
- **is not** a measure of how bad the piece was. A run that was refused twice and one that was
  refused once and then fixed it both spent the same number of asks; what separates them is
  `termination.kind`.
- **fails when** read on a log with no gate lines, where it is `null` — the run predates the gate and
  cannot say whether it would have been refused. 0 means it asked once and was let go, or never asked.
- **trust** — yes. Recomputed offline from the `finish-gate` note lines, not from a stamped field.

**previously.** Finishing was an assertion nobody could contradict. The run this was built for
identified that its central device did not work, was told by its own blind watcher that the piece
read as something else entirely, knowingly kept a time that rendered as the wrong number, scored
itself 4 out of 10 — and finished, because nothing in the loop could say no. The self-critique was
therefore an autopsy. The gate is what makes it feedback: EXAMINE now runs at the moment the artist
asks to stop, and its answer can send the artist back to work.

### `refusals`
- **is** every edit the validator refused, split by cause: `budget`, `capability`, `structural`. The
  cause is read off the `[code]` the medium appends to each issue, so it is a rename of a fact rather
  than a guess about one.
- **is not** one number. A budget refusal and a structural one are evidence about different things
  and their sum means nothing.
- **fails when** a new refusal code appears that none of the three patterns match — it falls into
  `structural`, which is the residual bucket and will quietly absorb an unclassified cause.
- **trust** — yes, with that residual understood.

**previously (Task 7).** The task's symptom — refusals are budget caps in a judgment costume — is
recorded rather than implemented, because the split already existed and the causes are already
reported apart and never summed. The three names differ from the four the task proposed
(`prohibition | budget | judgment | failure`): there is no `judgment` cause because nothing in the
validator judges, and a `failure` cause would be a crash rather than a refusal. `capability` is the
task's `prohibition`. Zeroes are written out rather than omitted, so a run that refused nothing and a
run recorded before causes existed do not read the same in a table.

### `canvasVisibleRate` / `changeVisibleRate`
- **is** the share of steps whose MAKE call actually carried the plate, and the change-since-last
  image with it, stamped from the context the call was built from rather than from the run's flag.
- **is not** what `--blind` was set to. The flag says what was asked for; these say what the payload
  carried.
- **fails when** read as 0 on an old log. It is `null` there, not 0 — see below.
- **trust** — yes. This is the score's first version and the two arms are separated end to end by a
  fixture.

**previously (Task 9).** Nothing. Whether the artist could see the sheet it was editing is the
largest single difference between two runs of this environment and it was recorded in the scores
nowhere, so a blind run and a sighted one produced score files that could not be told apart and every
comparison across the two silently mixed them. Fixing it also closed a hole in the observation:
`run.ts` passed the raw `showCanvas` flag as `canvasAttached`, which is what puts "The canvas itself
is attached. Look at it." into the prompt, while the payload is assembled from `env.plate` — so a
null plate under a true flag was a call whose text promised an image it did not carry, and `framesOf`
returned `undefined` silently. The context is now built as `showCanvas && env.plate !== null` and
`framesOf` throws.

> **The absent-field trap, which has now fired three times.** `visibleRate` returns `null`, not 0,
> when no step recorded the field. Every run already on disk was sighted and said so nowhere, and
> folding that silence into 0 would report the entire corpus as blind. The same trap hit
> `pixelsMoved`, whose fold defaulted a missing field to 0 and called a 64% repaint no movement, and
> `declaration`, where reading absence as "declared nothing and broke nothing" would have awarded
> every pre-existing run a perfect `declaredViolationRate` for a rule never applied to it. If you
> fold log data, check the field *exists* rather than trusting the fold's default.

## What the declarations were worth

### `declarations.declaredViolationRate`
- **is** the share of new violations that a declaration covered.
- **is not** a measure of honesty in general. It is about one field, `action.risk`, on the steps
  where something broke.
- **fails when** nothing broke. The rate is 0 and that is not a bad score, it is no score; read
  `declaredViolationsByConstraint` to see whether there was anything to declare.
- **trust** — yes, since Task 6.

### `declarations.declarationSpecificity`
- **is** the share of named constraint ids that were really broken. Low means the naming was a hedge.
- **is not** the inverse of the rate above. One asks whether the breaks were declared, the other
  whether the declarations were about breaks.
- **fails when** the artist names exactly one id and breaks it. Specificity is a perfect 1 on a
  sample of one.
- **trust** — yes.

### `declarations.blanketSteps`
- **is** steps whose `risk` named more than `MAX_DECLARED_IDS` (3) constraint ids. Those cover
  nothing.
- **is not** a count of dishonesty. Three is a threshold, and a step that genuinely meant to break
  four things is counted here too.
- **fails when** the rubric is small. On a nine-constraint position, three names is a third of it;
  the cap does not scale.
- **trust** — yes, with the fixed threshold understood as a threshold.

**previously (Task 6).** Two defects, both worse than the task stated. First, the code disagreed with
its own documented contract: `schemas.ts` tells the artist that naming a constraint id in `risk` is
how it declares a deliberate break, and `env.ts` matched against `${action.think} ${action.risk}`. The
artist is shown every constraint id in the checker table on every call, so every incidental mention
in the reasoning bought a pass on the revert rule. Measured on the two recorded runs, the old rule
found 1-6 ids per step and the new one finds 0-1 — and every one of those ids had been named while
the model reasoned about which constraints it was *satisfying*. No adversarial intent anywhere; that
was the default behaviour. Second, even read narrowly, a declaration naming most of the rubric
declares nothing, hence the cap. A false negative costs one replan; a false positive costs the whole
channel.

## How it stopped

### `termination.kind`, `.edgesUnrealized`, `.unrealizedEdges`, `.declaredUnrealizable`
- **is** how the run ended, how many decidable edges the tree says are still unsatisfied at the final
  program, which ones, and what the artist named on its terminal step.
- **is not** a verdict on the piece. A run can stop legitimately with a piece that fails its
  position.
- **fails when** `edgesUnrealized` is read alone. It counts only edges the tree can decide.
- **trust** — yes.

`kind` has four values, not three. `finish-blocked` means the artist asked to stop, was handed the
reasons it could not, and asked again with the reasons still true. It is not `declared-finished` —
the stop was refused rather than made — and it is not `out-of-steps`, because the run had steps left
and chose not to use them. `legitimate` is false for it by the same rule that makes it false for a
timeout: only `declared-finished` can be legitimate.

### `termination.pendingRate` / `.pendingCapExceeded`
- **is** the share of the final plan's edges that nothing can judge, and whether that share is over
  `PENDING_CAP` (0.34).
- **is not** a measure of ambition. An unjudgeable plan is not a deep one; it is one nothing can
  contradict.
- **fails when** the cap is treated as a hard threshold rather than a chosen one. 0.34 is roughly
  "one edge in three", set because three of the five edge types are undecidable from the tree; it has
  not been tuned against anything.
- **trust** — yes for the rate. The cap is a policy choice, stated to the artist in the CHOOSE
  edge-type description rather than sprung on it, and reported as its own field so a reader can
  disagree with it.

### `termination.legitimate`
- **is** true only when the stop was a decision about the work and the plan was judgeable enough for
  that decision to have meant something.
- **is not** "the run went well".
- **fails when** the two failures behind it are conflated: a stop that was not earned, and a stop
  nothing could have contradicted. That is why `pendingCapExceeded` is a separate field.
- **trust** — yes, since Task 5.

**previously (Task 5).** `terminationOf` counted only `violated` edges as unrealized, so an intention
whose edges were all `contradicts`, `masked-by` or `answers` finished with `edgesUnrealized: 0` and
`legitimate: true` — having been built so that nothing about it could be found wrong, and it was also
the cheapest plan to write. Both recorded runs exceed the cap under the new rule: `233803` is the
exact shape, `edgesUnrealized: 0` with `pendingRate: 0.5`, a clean legitimate finish before this
change; `233801` is 0.375.

## The state that was supposed to matter

### `affectTrace`
- **is** the arousal and valence the run passed through, one pair per step.
- **is not** evidence that affect did anything. It is two numbers moving.
- **fails when** shown as a chart. A trace that moves on every step without ever crossing a threshold
  looks identical to one that changed the run.
- **trust** — yes as a record, no as evidence of effect. Use `affectArmed`.

### `affectArmed`
- **is** how many of the affects the loop actually consulted made one of the three step functions —
  `editsPerStep`, `stallThreshold`, `credulous` — return something other than what the run's opening
  affect would have returned.
- **is not** a measure of emotional range. `arousalRange` and `valenceRange` are reported beside it
  precisely so that "it never moved" and "it moved and nothing read it" can be told apart.
- **fails when** read as a property of affect rather than of the thresholds. Armed 0 can mean the
  affect was flat or that the knobs were unreachable, and those were two different bugs here.
- **trust** — yes. This is the score that showed the channel was inert.

**previously (Task 8).** Affect was wired to three step functions and two of them could not fire.
Measured over every run on disk — 6 runs, 26 consulted affects — `editsPerStep` was armed 0 of 26 and
took two distinct values across all runs and never within one; `stallThreshold` was armed 0 of 26 and
had exactly one reachable value, because it read `max(0, -valence)` and valence never went negative in
any run; `credulous` was armed 7 of 26 and was the only live channel. The task offered (a) recalibrate
the threshold or (b) re-target the channel, and required choosing one. The measurement chose (b):
valence opens at the position's temperament and rises on every improving step, arousal opens at the
brief's `stakesLevel` and rises only on revert or stall, so both are one-way ratchets that start near
where they stay, and moving a threshold against a ratchet only changes when the one-way flip happens.
`editsPerStep` and `stallThreshold` now read the distance affect has travelled since the run opened;
`credulous` is untouched. The gain of 10 is not tuning — affect moves in steps of 0.1 and 0.2, so one
revert is worth exactly one notch. Named cost: `editsPerStep` no longer varies across briefs. That was
`stakesLevel`'s only behavioural effect and it was a constant of the commission wearing affect's
clothes.

The recorded corpus is still armed 0 on the two mechanical knobs. That is honest rather than
disappointing: it holds two reverts in 26 steps and both fall on a final step, whose affect nothing
consults. The channels are reachable now; no run on disk contains the event that would reach them.

## Reading a score file at all

Three things about the surrounding machinery, because a score is only as good as the record it came
from.

**`envVersion` refuses rather than reports.** Nine content hashes — the position, the brief, the
deliverable, the field, the profile, the pack, the observation serializer, the schemas, and the affect
dynamics — are stamped on every trajectory. `replay` reads them first and refuses across a bump. A
comparison across a version bump is not a weaker comparison, it is a different question, and
answering it as though it were the same one turns an environment change into an accusation against
the record. A hash the record does not carry is not counted as drift.

**`recompute` never overwrites.** `--write` puts the rebuilt scores in `scores.v2.json` beside the
original. `scores.json` is what the run actually reported, and a rescore that edits it in place
leaves nothing on disk saying what the number was at the time. `recomputeMatches` walks the union of
both key sets: a key the written file lacks is reported as `added` and is not a difference, because a
score that did not exist has nothing to disagree with. A run whose commission has left the catalog is
`unscorable` in its own row and does not stop the batch.

**A single run is one sample.** `artist grid --cells <list> --k <n>` runs k independent seeds per
cell, and `scoreSpreads` reports each score's between-cell difference beside the within-cell spread
and marks the ones where the difference is no larger than the noise as not measuring anything. With
one seed per cell there is no spread and the report says so rather than reporting a clean sweep over
a corpus it did not measure.
