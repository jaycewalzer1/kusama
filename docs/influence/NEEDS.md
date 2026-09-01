# What the influence layer needs and does not have

Everything here is a known gap, not a bug. Each entry says what is missing, what the layer does
instead, and what it costs to leave it missing.

Its counterpart is [README.md](README.md), which is about what the layer *does* have. The headline
lives there and is repeated here in one line, because it changes how the rest of this file reads:
**three of the four measurable layers cannot tell a copy from a stranger, and the one that can is the
one with no way to say it.**

---

## The missing experiment

**There is no control arm on any sweep.**
Every column of every sweep renders the *edited* program. Nobody has rendered the **unedited**
program against the same target and measured its distance. So the only claim a sweep can currently
support is "these six numbers are different from each other", and the claim a reader will take from
it — "the edit moves the render toward the target" — is untested. It matters most because the numbers
go the wrong way: distance to target *rises* monotonically with `|k|` on all three sweeps. Without a
control there is no way to tell how much of that rise is the target running away into fields the dial
cannot touch (`fractions`, `chromaMean`, both in `blocked[]`) and how much is the edit being
useless or harmful.

**Cost of the fix:** one extra render per k, strictly serial (NOTES R8) — so roughly doubling a
sweep's wall clock. It is the cheapest real experiment left in this layer and it is not done.

**A second missing control:** a *random* direction of the same magnitude. If a random direction moved
the render as far as a Stieglitz direction did, the group identity would be doing no work. Nothing
here tests that either.

---

## Layers that need a model

**`subject` and `discourse` are reserved and empty, and cannot be filled by measurement.**
`subject` is what a work is *of*; `discourse` is what it argues and from where. Both are readings,
not measurements. They exist in the six-layer model, in `bizarreness.json` with weights 5 and 8, and
in `corpus/directions.v1.json` as explicit nulls. **No direction exists for either and none was
faked.** Their weights are among the four that can never be spent, which `bizarreness.json` states
about itself.

What they would need: a model that reads a work — title, catalogue prose and the image together —
and returns something comparable across works. That is a model call, which this build had none of.

**A text-side `source` on a direction has no producer.**
`Direction.source` allows `'text'` and nothing emits it. The type is honest about the intent and the
absence is deliberate: a `text` direction built out of catalogue prose would be a direction through
the museum's cataloguing conventions, and this corpus has already shown that metadata neighbours are
93.6% same-museum against 39.0% chance. Whatever that measures, it is not influence.

---

## Constraint kinds the language does not have

**`texture` — the only layer that passed the pair test — cannot be expressed at all.**
No constraint kind reads frequency content. A `texture` direction can be computed, saved, printed and
compared, and then nothing can be done with it. `applyInfluence` on `texture` returns **zero
constraints** and blocks all four of its fields, and a test asserts that as an equality so a future
kind that fixed it would have to say so.

A kind would need `RenderMetrics` to carry a Gabor or LBP summary of the render, which means the
measurement side growing a seventh field and `METRICS_VERSION` moving — a hash change, which this
work was forbidden to make. It is the single highest-value thing left undone.

**`form` has no kind either.** Nothing reads edge hardness, curvature or stroke orientation off a
render.

**`palette` cannot say *how much*.** `fractions` — what share of the sheet each colour covers — is
the second-strongest thing the palette descriptor knows and there is no colour-area constraint. So a
target that says "one dark mass over half the frame" is enforced as "these six colours are allowed",
which permits a sheet with all six colours in equal thin stripes.

**Nothing bounds saturation.** `chromaMean` is the palette layer's strongest single number
(corpus mean 7.8; the Owens pack asserts 1.5) and there is no kind for it. `palette` fixes exact
colours instead, which is a stricter and *different* thing.

**Armature has no floor on symmetry.** `symmetryMax` is a ceiling. A direction asking for a *more*
symmetrical work has nothing to emit, so an upward armature direction blocks both symmetry fields.

---

## Edits the layer cannot make

**Only `palette` has a deterministic edit, so only `palette` can be swept.**
Moving a render's ink density or centroid means moving marks, and any rule for doing so would be an
intervention this repo invented — a claim about what an armature direction *means* as a drawing
action. An armature sweep therefore renders the same program at every k with `edited: false`. That is
deliberate and reported, not a stub to be quietly filled in.

**`quote`, `strip` and `repeat` have no implementation and no obvious one.**
See the operator table in the README. `quote` needs to address a specific passage of a specific work
and nothing here can address one work — a direction is a displacement of a corpus mean. `strip` needs
an "unset this field" that constraints, being additive tests, cannot express. `repeat` needs a
descriptor of periodicity; the Gabor bank measures how much energy sits at a scale, not how regularly
it recurs.

---

## The corpus, and what it will not tell you

**There is no artist authority file, so a name is the identity.**
Two people with the same name are one person here; one person with two spellings is two. The pair
test joins on normalised spelling and says so. This is not fixable inside this repo — it needs an
external authority (ULAN, Wikidata) and a matching pass, which is a project.

The visible symptom: creator strings carry life dates that collide. `Hiroshige` and `Hokusai` entries
in this corpus include date ranges that overlap and are inconsistent between museums for the same
person. Nothing reconciles them, and `normalizeName` throws the dates away rather than pretending to
use them.

**2,061 works can never be grouped, because their creator field is one word.**
100 distinct single-word creator fields — `China` (576 works), `Egyptian` (415), `Roman` (88),
`Korea` (83), `Italian` (81), `Japan` (76) — parse to all nulls and never reach `groupWorks`.
`isMetadataLine` discards them, and it is right to: it cannot tell `China` in the creator column from
the `French, 1848-1903` nationality line the same museums put in the same field. The nine cultures
that *do* have directions got there on a multi-**line** field whose first line happens to be one word
(`Chimú\nNorth coast, Peru`), so the rule is about the shape of the field, not the length of the name.

Recovering the 2,061 needs a per-museum rule about which column means what. `CULTURE_WORDS` already
classifies them correctly for any caller that hands them over; nothing hands them over.

**`parseCreator` mis-splits a hedge.**
`'Possibly the workshop of Pierre Fromery (…)'` yields `maker: 'Possibly the'`. A test asserts the
wart rather than hiding it. It costs almost nothing — `possibly the` groups two works in 19,807 and
never reaches `MIN_WORKS` — but it is the shape of a bug that would matter on a corpus with more
hedged attributions.

**`copy after` and `copy of` occur zero times.** Both are in the relation list because the brief
asked for them; the manifest contains neither. A test asserts the zero, so a future corpus that has
them will change the test rather than silently changing the sample.

**`after` dominates the sample.** 66 of 82 pairs. `workshop of` has 6, `follower of` 3, and four
relations have 2 or fewer. Splits below 20 pairs get a count and no table, because at n=6 the sign
test calls 6/6 significant and it reads exactly like a result off 66.

**Most works have no measurable ground.** Only 0.92% of imaged works are sheets with a confident
ground, and only 14.7% of the manifest is 2D. Every descriptor here was measured on a museum
photograph, so an `armature` centroid over a photographed vase is a fact about the photograph and
the lighting. Both armature constraints carry the caveat in their `why`.

**`corpus/descriptors.v1.f32` is tracked but not reproducible from a fresh clone.**
It is derived from `corpus/images/`, which is not tracked. So a clone can read the matrix and cannot
regenerate it. Regenerating needs the images plus the venv.

---

## Calibration nobody has done

**The bizarreness weights are a judgement with nothing behind them.**
`palette 1, armature 2, texture 2, form 3, subject 5, discourse 8`. No viewer has been asked whether
a texture departure reads as stranger than a palette one, and no run has been scored against them.
The file says this about itself and states that the *ordering* is the claim, more than the numbers
are. Four of the six can never be spent.

**No human has looked at a sweep.** Not one person has been shown the k=2 column and asked whether it
reads as more like anything. Until that happens the entire layer is machinery with a plausible shape.

**No multiple-comparison correction.** The pair test's z=2.0 threshold is applied to four layers
independently and to eight splits. It is a threshold, not a p-value, and `pairs.md` says so — but a
reader scanning eight tables for the one cell that cleared it is doing something the statistics do
not support.

---

## Out of bounds by instruction

These were noticed and deliberately not acted on, because the brief forbade touching them:

- **`RenderMetrics` needs a seventh field** for any texture constraint to exist. That moves
  `METRICS_VERSION` and invalidates every metric taken before it.
- **The elements layer and the judge** were read and not changed. A `resemblance` direction and an
  influence direction are measuring adjacent things over the same corpus and nobody has compared
  them.
- **`scores.json`** does not know bizarreness exists, by instruction. If influence ever becomes part
  of a run's reward, this file is where the argument for that should start — and it should start with
  the control arm at the top of this page, not with the weights.
