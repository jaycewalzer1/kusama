// Affect: two numbers that steer the search.
//
// The one rule that matters here is the one that is easiest to break by accident: affect is a state
// of the *artist*, never a property of the *picture*. It reaches exactly one place — the THINK+ACT
// system prompt, as two numbers and a sentence — and it changes exactly two mechanical things: how
// many edits a step may carry, and how long the artist tolerates getting nowhere. It is never shown
// to DESCRIBE or AUDIENCE (they would start reporting mood instead of pixels), it never appears in
// an edit schema, and no constraint can read it.
//
// Everything below is a pure function. `affect.ts` imports nothing that can render or call a model,
// so `reward.ts` can replay the whole affect trace from the log arithmetically.

import type { Affect, Field } from './types.js';

/** arousal is 0..1, valence is -1..1. Both clamped after every update. */
export function clamp(a: Affect): Affect {
  return {
    arousal: Math.min(1, Math.max(0, a.arousal)),
    valence: Math.min(1, Math.max(-1, a.valence)),
  };
}

/** Rounded to 3dp so a replayed trace compares equal to a logged one without float noise. */
function round(a: Affect): Affect {
  return { arousal: Math.round(a.arousal * 1000) / 1000, valence: Math.round(a.valence * 1000) / 1000 };
}

/**
 * Initial arousal is the field's `stakesLevel`, unchanged. Deterministic and model-free: if a model
 * set the starting arousal it would be a policy output, and the environment would stop being fixed
 * across a cell of the grid.
 *
 * An earlier version of this scored the brief's prose with keyword regexes. It was replaced because
 * it did not work — of the five briefs, three landed on the floor and one saturated, and inspection
 * showed the score was tracking which words happened to be in the pattern rather than what was at
 * stake. A regex over prose measures the regex. So the number is hand-set per brief instead, in the
 * field file, against this rubric:
 *
 *   0.9 - 1.0  acting on the piece exposes the reader to arrest, injury, or the loss of their home,
 *              and the date cannot slip
 *   0.7 - 0.8  named people lose something concrete and irreversible on a fixed date, but the reader
 *              risks only their time
 *   0.4 - 0.6  something ends or cannot be repeated, and the loss is real but nobody is harmed
 *   0.1 - 0.3  the piece announces something; if it fails, it is remade next week
 *
 * The rubric is coarse on purpose. It is a starting condition, not a measurement, and the update
 * rules below do the real work — but it is now a claim a person made and can be argued with, which
 * the regex version only pretended to be.
 */
export function initialArousal(field: Field): number {
  if (field.stakesLevel < 0 || field.stakesLevel > 1) {
    throw new Error(`field ${field.briefId} has stakesLevel ${field.stakesLevel}, outside 0..1`);
  }
  return field.stakesLevel;
}

/**
 * Valence starts at the position's temperament and nothing else. Temperament is the standing
 * disposition — how sour or how buoyant this artist is before anything has happened — and the brief
 * does not change who is holding the pen.
 */
export function initialAffect(field: Field, temperament: number): Affect {
  return round(clamp({ arousal: initialArousal(field), valence: temperament }));
}

/** A candidate was rendered, checked, and thrown away. Agitation up, mood down. */
export function onRevert(a: Affect): Affect {
  return round(clamp({ arousal: a.arousal + 0.1, valence: a.valence - 0.1 }));
}

/** A step was kept and the position's own checker scored it better than before. */
export function onAcceptImproved(a: Affect): Affect {
  return round(clamp({ arousal: a.arousal, valence: a.valence + 0.1 }));
}

/** stallThreshold steps in a row without improvement. The largest single move in either number. */
export function onStall(a: Affect): Affect {
  return round(clamp({ arousal: a.arousal + 0.2, valence: a.valence - 0.2 }));
}

/**
 * How many edits this step may carry. High arousal buys bigger swings, which is the whole
 * behavioural content of arousal: 1 edit at rest, 5 at full agitation. The medium refuses an edit
 * batch that breaks a budget regardless, so this cannot run away.
 */
export function editsPerStep(a: Affect): number {
  return 1 + Math.round(4 * a.arousal);
}

/**
 * How many unimproving steps the artist tolerates before `stall` fires. A sour artist waits longer
 * before admitting it is stuck — which is the pessimist's actual failure mode, not impatience.
 */
export function stallThreshold(a: Affect): number {
  return 3 + Math.round(3 * Math.max(0, -a.valence));
}

/**
 * Above this valence the artist is pleased with itself, and `description-disagrees` is allowed to
 * fire on a weaker signal — the environment gets more say precisely when the artist is least
 * inclined to listen. Consumed by the trigger code in ./triggers.ts.
 *
 * Measured over every step on disk (25 steps, 4 pilot cells plus the launch cell): valence ran
 * min 0.30, median 0.50, max 0.60, and never once went below its starting temperament. So this is
 * true on 20 of 25 steps. It is not a dead gate — it is a gate that is almost always open, which
 * makes the weaker `description-disagrees` threshold the normal case and the stricter one the
 * exception. That is a defensible design (an artist working from a blank sheet upward is credulous
 * most of the time) but it is not the design the sentence above describes, and the number is left
 * where it is rather than tuned to make the code match the comment. Raising it would need a run
 * where valence actually falls, and no run on disk has one.
 */
export function credulous(a: Affect): boolean {
  return a.valence > 0.3;
}

/** The one sentence that goes to THINK+ACT beside the two numbers. */
export function affectSentence(a: Affect): string {
  const arousal =
    a.arousal >= 0.75 ? 'very agitated' : a.arousal >= 0.5 ? 'agitated' : a.arousal >= 0.25 ? 'steady' : 'calm';
  const valence =
    a.valence >= 0.3 ? 'and it is going well' : a.valence <= -0.3 ? 'and it is going badly' : 'and it is going neither way';
  return `You are ${arousal} ${valence}. This is your state, not the picture's: do not draw it, let it set how much you change at once and how long you put up with getting nowhere.`;
}
