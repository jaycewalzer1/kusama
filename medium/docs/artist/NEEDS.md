# What the artist needs and does not have

Everything here is a known gap, not a bug. Each entry says what is missing, what the loop does
instead, and what it costs to leave it missing.

Its counterpart is `MEASUREMENT.md`, which is about what the loop *does* have: one entry per score,
what it is, what it is not, how it fails, and whether to believe it. A gap here and an untrustworthy
score there are different problems, so they are written down in different files.

The first version of this file was written under a brief that forbade changing the medium or the
aesthetic layer, so its first two entries described gaps that could not be closed from `artist/`.
That restriction was lifted and both are now closed; they are kept below as **Closed** so the
reasoning survives, because both were load-bearing arguments and not just chores.

## In the medium and the aesthetic layer

**CLOSED — `metricsFromRgba` is module-private in `aesthetic/measure.ts`.**
It is exported, and `Measurer.measureFrom(program, plate)` is the cached way in: it takes the
printed RGBA the caller already has and never launches a browser. `Canvas.render` passes the buffer
it just produced, or decodes its own cached PNG, so a metrics-bearing look renders **once**.
Verified on a cold cache: one render, no second browser, and the numbers byte-identical to what
`Measurer.measure` produced by rendering again — so `METRICS_VERSION` did not have to move and every
metric taken before the change stays comparable. The thunk matters: the metrics cache is checked
first, so a revisit does not even pay for a PNG decode.

**CLOSED — constraint evidence is free text, not structured node ids.**
`ConstraintResult` now carries `nodeIds: string[]` beside `evidence`, decided per kind by the
checker that knows what the kind means. `env.ts:loadBearing` reads it directly and
`destructionRate` is exact rather than an estimate. The rule is in `docs/constraints.md`: offenders
when violated, carriers when satisfied, and **empty when the verdict rests on an absence, on an
aggregate, or on the whole sheet** — empty being an answer, not a gap. The old substring scan was
wrong in both directions and one of the tests now pins the prefix case (`t` vs `t2`) that it got
wrong.

The one thing this does *not* buy: render-scope verdicts still name no node, because attributing a
pixel to the node that laid it down would need per-node coverage out of the renderer and it does not
report any. That is a real limit, not a stub.

**Nothing in the medium knows occlusion.**
So `masked-by` is one of the three intention edge types that `intention.ts` refuses to decide, and a
`cover` op is counted as destructive without working out what it landed on. See the comment on
`MECHANICAL` for why paint order is not a substitute.

**Missing constraint kinds.** Nothing in the 16 kinds can say:
- *this text is the first thing read* — reading order, as opposed to size or position separately.
- *these two elements are the same distance apart as those two* — a relation between relations,
  which is what most compositional rules actually are.
- *this mark is off the grid the rest of the sheet is on* — deviation from an implied structure.
- *this is legible at 3 metres* — the render metrics have coverage and contrast but no acuity model.

## What the loop knew and did not act on

**CLOSED — finishing was an assertion nobody could contradict.** It is now a request. `artist/gate.ts`
is a pure function from evidence to blockers; `run.ts` calls it when the artist says `finished`, and
either accepts the stop or hands the reasons back as a `finish-blocked` replan. Five blockers, all
falsifiable by the artist and all built from evidence the loop already had and already discarded: a
required fact a blind reader could not read off the sheet, a hard constraint still violated, the
watcher saying it would walk past, a self-score under 5, and plan relations the artist's own EXAMINE
says do not hold. Bounded by `maxFinishAttempts` (default 2); exhausting it is
`termination.kind: 'finish-blocked'`, which is never `legitimate`.

Three consequences worth stating. **EXAMINE moved inside the loop** — it now runs at the moment the
stop is requested, which is the only place its answer can change anything, and a run that finishes
on its first ask makes exactly the same number of calls as before, because that EXAMINE becomes the
trajectory's. **The gate never blocks on evidence it does not have**: a transcript that was not
taken and an audience that was not asked both return nothing, because a gate that read absence as
failure would block hardest on the runs it knows least about. And **`maxFinishAttempts: 0` turns the
gate off**, which is the pre-gate environment kept runnable, so "the gate changed the work" is a
comparison somebody can run rather than a claim.

**CLOSED — the blind read-back.** `transcribe` is a fifth env call: it is shown the plate, is never
told what it is looking for, and lists every string it can make out with a per-string `legible`
flag. `gate.ts` compares that against the brief's `textRequired.params.contains` using
`normalizeText`, exported from `aesthetic/kinds.ts` so that one function decides both questions — a
second normaliser here would make the gap between "it is in the tree" and "it can be read off the
sheet" partly an artefact of two spellings of `contains`. Asked only on a finish request: on every
other step the tree already answers it.

The obvious version of this — "can you read `3 MARCH` in this image?" — puts the answer in the
question and gets a yes. That is why it is a transcription and not a quiz.

**CLOSED — the audience said what it thought and never what it would do.** `AUDIENCE_SCHEMA` now
carries `wouldAct: 'act' | 'consider' | 'ignore'` beside the prose. Three words rather than a number
for the same reason `AGREES_SCHEMA` is a boolean: a number invites a threshold and a threshold gets
tuned until the trajectories look better.

**CLOSED — an edit that changed the tree and not the page earned the reward for improving.**
`env.step` treats a kept step under `INERT_THRESHOLD` (0.001 of the canvas) as a step that did not
happen: no stall reset, no mood lift. `Scores.inertSteps` counts them. `this.best` still advances,
so a later step is not credited twice for the same ground.

**CLOSED — nothing checked whether the commission was satisfiable before generating against it.**
`aesthetic/contradictions.ts` compares hard constraints pairwise over the *composed* position — the
artist's commitments plus the client's requirements, which is where the collision actually is — and
`loadCommission` puts the result on `Commission.unsatisfiable`. Non-empty and `runTrajectory` logs
and throws before the first policy call. Five families: an empty range, two ranges that do not meet,
two `textCase` constraints that disagree, a node or mark both required and forbidden, and a required
string with the `text` op forbidden.

Deliberately incomplete in one direction: everything it reports is real, and a pair it says nothing
about is **not** certified consistent. A false positive refuses a commission that could have been
made, which is the expensive mistake. Only `hard` constraints are compared — two soft ones pulling
against each other is the trade the position exists to hold.

**Not done: rollback, deletion and candidate replacement as first-class moves.** Revision is still
`add_node` and `delete_node` one step at a time; there is no "throw the last three steps away", no
branch, no keeping two candidates and choosing. The gate is expected to create the pressure that
makes this worth building — an artist that cannot leave is an artist that has to undo something —
and until a gated run has actually been observed getting stuck, building the machinery would be
guessing at which move it needed.

**Not done: intervention-based evaluation.** Nothing renders a controlled variant, shows it to a
blind viewer, and asks whether the interpretive change matches the predicted one. That is the only
design here that would make an aesthetic claim testable rather than assertable, and it needs a
variant generator and a paired-comparison harness that do not exist. `twin.ts` is the nearest thing
and it compares arms of a run, not variants of a picture.

## Phases not built

**The judge — L5 of the prompt stack. Deliberately not built, and the cost of that is named below.**

Nothing in this repo judges. Every rubric a position raised that the checker could not decide is
carried forward unread in `Scores.judgePending`, and every intention edge that is not `aligned-to` or
`echoes` comes back `judge-pending`. The hook is those two fields: a judge is a function from
`(final.png, position, judgePending[])` to a score, and it can be run offline against already
collected trajectories because both are on disk.

*Why it is not built.* A judge written this week, scoring compliance with prompts written this week,
is circular. It would agree with the stack because it was written by whoever wrote the stack, and
that agreement would be reported as a result.

*Two of the five proposed critic dimensions are struck from the spec permanently.* "Does it obey the
stated formal rules" and "does it violate a stated refusal" are assertion checks dressed as
evaluation: `aesthetic/check.ts` already decides both mechanically, on the tree and on the render,
without a model. Routing them through a judge would launder a deterministic check into a subjective
score and inflate agreement between the judge and the checker, which is not a measurement of
anything. They are not deferred. They are gone.

*Three survive and are the only ones worth a model:* whether a decision was **necessary** to the
piece or merely permitted by it; whether the result is **non-generic** — could this have come from
any position in the catalog, or only from this one; and whether the work **derives** from the
practice or **quotes** it, which is the difference the whole L1 layer exists to make visible.

*The shape when it is built:* consume `judgePending` rather than re-deciding what the checker already
decided, and run offline in a fresh context against trajectories already on disk, so the judge never
shares state with the run it is scoring.

*The cost, stated plainly.* Without L5 the ablation grid has no dependent variable. Removing a layer
and re-running can show that the layers are **separable** — different hashes, different observations,
different behaviour — but it cannot show that a layer makes the work **better**, because nothing in
the repo has an opinion about better. That is acceptable as a staging decision and is not acceptable
as a permanent one: any claim that the five-layer stack improves output is unsupported until this
exists.

**Break: a stranger-eye describer that is allowed to be hostile.** `DESCRIBE` is neutral by
construction and `AUDIENCE` is one named person from the field. Neither is the reading that makes an
artist throw a piece away. Design note: same blindness rules, third env call, prompt asks for the
worst honest reading rather than the plainest one; it would feed a sixth trigger.

**Learn: position versioning across a series.** A position is currently immutable and hashed into
every trajectory, so an artist cannot come out of ten pieces having changed its mind. Design note:
positions get a `parent` hash and a changelog; a Learn phase proposes a diff to the position after a
series and the diff is applied by hand, never by the loop, so the environment stays fixed within a
run.

**Reference retrieval for the field.** `Field.transplants` is three hand-written references per
brief. They are the most laborious part of writing a field and the most obviously automatable, and
automating them would make the field a function of a retrieval index rather than a fixed input.
Design note: if built, the retrieval result must be frozen into the field file and hashed, not
fetched at run time — otherwise two trajectories with the same `fieldHash` saw different worlds.

## Observability

**CLOSED — LangSmith sink.** `artist/trace.ts`, sent from `call.ts` and imported nowhere else, and
a guard test asserts both. It stays a sink: it exports exactly `tracingEnabled` and `traceCall`,
makes exactly one `fetch`, and that request is a POST. Off in three independent ways —
`LANGSMITH_TRACING` must be exactly `"1"`, `LANGSMITH_API_KEY` must be set, and the policy must be
`anthropic` or `openai-compatible`. That last one is the one that matters: a replay drives the real
loop with a `RecordedPolicy` and a test drives it with a `StubPolicy`, and neither made a model
call, so neither may put a request on the network however the environment is set.

Two deliberate choices. The trace is sent **after** the studio.jsonl line is written, so the record
on disk is complete before anything leaves the machine and a failed trace cannot lose a line. And it
is **awaited**, with a 5s timeout and every error swallowed: an un-awaited POST can be lost at
process exit and can surface as an unhandled rejection, and one bounded round trip is nothing beside
the model call that just happened. If the trace and the log ever disagree, the file on disk is
right.

Written against the ingest endpoint with `fetch`, for the reason `env-model.ts` is: the guard tests
say no file in `artist/` imports a framework and only `policy/anthropic.ts` imports a model SDK, and
those statements are worth more than the convenience of a client library.

## Known sharp edges

**`sketch-v1` is a third profile.** Sketches render under `profiles/sketch-v1.profile.json` and the
seed is redeclared under that profile name before any edit is applied, because the medium refuses a
program that declares one profile and is validated against another. A sketch program hash is
therefore not comparable with a finished program hash even if the trees are identical.

**Replay does not replay the environment.** `env-model.ts` caches on disk by request content, so a
replay hits the entries the original run wrote. After `rm -rf .cache` a replay costs what the
environment cost. The policy side is genuinely replayed from the log and is checked byte-for-byte.

**`carryNodeIds` is a rule, not a fact.** A replan that re-declares an element under the same id
keeps the nodes that element was made of. Element identity is by id, and the alternative — dropping
them — measured how recently the artist last changed its mind rather than what it built.

**The `32e3e8b..81bdd4c` work is unattributed and unreviewed.** Fourteen commits titled "Task N",
28 files, +4736/-260 across `artist/` and `aesthetic/`. The sessions that wrote them were terminated
on 2026-08-27 and their intent was never read. It is kept rather than quarantined: it passes, and
`dynamicsHash` is a real improvement — a change to the response rules can no longer pass as the same
experiment. Surgery on the one commit that cleared the acceptance test is the worse trade.

Two things follow. **`reward.ts` is in the blast radius of the three mismeasuring scorers** — `drift`,
`realization`, `riskConvention` — and took +171 in this range; read
`git diff 32e3e8b 81bdd4c -- artist/reward.ts artist/affect.ts artist/env-version.ts` before the
scorer fix touches those files. And **the series is incomplete**: Tasks 1 and 7 exist in no commit on
any ref, so whatever they were meant to do is undone and unrecorded. Do not infer them; the numbering
is the only evidence they were ever planned.

**`nodeIds` is not on the CHOOSE or REPLAN schema at all,** and must not be put back. The first real
run put it there, described as "empty until it has been built", and the artist filled it in with the
ids it was about to write. Four of those were never written, and because an edge is violated when
either end names a node that is not in the tree, six of seven edges came back violated on a piece
that scored 1.000 on the checker. Which nodes make an element is the environment's column: it is
filled in from `servesElementId` on an accepted edit and from nowhere else.
