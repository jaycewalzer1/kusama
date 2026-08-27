# What the artist needs and does not have

Everything here is a known gap, not a bug. Each entry says what is missing, what the loop does
instead, and what it costs to leave it missing. Nothing in this file was fixed by changing the
medium or the aesthetic layer, because the brief forbids it.

## In the medium and the aesthetic layer

**`metricsFromRgba` is module-private in `aesthetic/measure.ts`.**
A look that needs `RenderMetrics` therefore renders the same program twice on a cold hash: once
through `Canvas.render` for the plate, once through `Measurer.measure` for the numbers. Both hit the
same on-disk caches afterwards, so the cost falls on the first visit to a program hash only — but
the first visit is most of a trajectory. Exporting that one function, or letting `Measurer` accept
an already-decoded RGBA buffer, would roughly halve the browser time of the whole system. This is
the single largest saving available and it is one line of `export`.

**Constraint evidence is free text, not structured node ids.**
`env.ts:loadBearing` has to decide which nodes were carrying a satisfied constraint, and the only
signal available is whether a node id appears as a substring of `result.evidence`. That is crude in
both directions: an id that happens to be a prefix of another matches, and a constraint that
describes its evidence without naming ids matches nothing. `destructionRate` is therefore an
estimate. If `CheckResult` carried `nodeIds: string[]` alongside `evidence`, it would be exact.

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

## Phases not built

**The judge.** Nothing in this repo judges. Every rubric a position raised that the checker could not
decide is carried forward unread in `Scores.judgePending`, and every intention edge that is not
`aligned-to` or `echoes` comes back `judge-pending`. The hook is those two fields: a judge is a
function from `(final.png, position, judgePending[])` to a score, and it can be run offline against
already-collected trajectories because both are on disk. Deliberately not built — a judge trained or
prompted alongside the artist is a signal the artist can move.

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

**LangSmith sink.** Not built. `call.ts` is the single place every policy call passes through and it
already has the whole request, response, usage and timing in one scope, so the sink is a wrapper
there and nowhere else. It must stay a sink: nothing may read from it, and it must be off unless
`LANGSMITH_TRACING=1`, so tests and replays never touch a network.

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

**`nodeIds` is not on the CHOOSE or REPLAN schema at all,** and must not be put back. The first real
run put it there, described as "empty until it has been built", and the artist filled it in with the
ids it was about to write. Four of those were never written, and because an edge is violated when
either end names a node that is not in the tree, six of seven edges came back violated on a piece
that scored 1.000 on the checker. Which nodes make an element is the environment's column: it is
filled in from `servesElementId` on an accepted edit and from nowhere else.
