// THINK+ACT, and REPLAN.
//
// One call. Never two. The artist says what it is doing, chooses a control, names a risk if this is
// the step where it takes one, and gives the edits — all in a single response. Splitting the thought
// from the action is the obvious refactor and it is the wrong one: two calls make `think` a caption
// written after the fact, and a caption cannot be studied.
//
// The system prompt says the risk sentence exactly once per piece. It is here rather than in the
// observation because it is a standing instruction about how to work, not a fact about the
// situation, and putting it in the observation would make it drift with the serializer's hash.

import { callPolicy, type CallResult, type Spend } from '../call.js';
import { makeObservation, replanObservation, type MakeContext } from '../observation.js';
import { REPLAN_SCHEMA, actSchema } from '../schemas.js';
import { withInfluences, type InfluenceDoc } from '../influence-doc.js';
import { withSamplingCommitments } from '../sampling-observation.js';
import type { SamplingPlan } from '../../aesthetic/sample-types.js';
import type { Policy, PolicyImage } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Action, Intention, TriggerName } from '../types.js';

const SYSTEM = [
  'You are an artist working on one piece in a medium with hard limits.',
  '',
  'Each step is a hypothesis about the central connection. The mark you make should test whether',
  'the connection holds in this material — not illustrate what you already decided.',
  '',
  'When the sheet surprises you, that is the work talking back. Follow the surprise further',
  'before correcting it. A step that makes the piece more predictable has failed even if it',
  'makes it more finished.',
  '',
  'Density is not decoration. A surface that reads as thin or spare has not been worked — it has',
  'been left. Wash, hatch, field and stroke are where this medium lives; use them to build the',
  'surface, not to ornament it. A picture made only of solids is a diagram.',
  '',
  'The generative law you stated should be visible in the marks, not just described in your',
  'thinking. If the law cannot be seen, the piece has not found it yet.',
  '',
  'You may destroy or abandon what you have made.',
].join('\n');

const REPLAN_SYSTEM = [
  'You are revising your plan because the canvas told you something it did not account for.',
  '',
  'Keep whatever still holds. Do not rewrite the plan to describe what you already made — that is',
  'retrofitting. If the purpose was wrong, change it and say so.',
].join('\n');

/**
 * What the artist looks at: the canvas as it stands, and what its last kept step did to it.
 *
 * Order matters and is the order the observation describes them in. Both switches come off the
 * context that built the text, so the pictures and the sentences about the pictures cannot
 * disagree — the blind arm attaches neither and claims neither.
 *
 * The throw is what makes that sentence true. `canvasAttached` is what puts "The canvas itself is
 * attached. Look at it." into the observation, so a null plate under a true flag is a call whose
 * text promises an image it does not carry — the artist is told to look at something that is not
 * there, and the run's own record says it could see. Returning `undefined` there would make that
 * silent. The caller builds the flag as `showCanvas && env.plate !== null`, so this cannot fire;
 * it fires if that ever stops being true.
 */
export function framesOf(context: MakeContext, plate: Buffer | null, change: Buffer | null): PolicyImage[] | undefined {
  if (!context.canvasAttached) return undefined;
  if (!plate) throw new Error('canvasAttached is set but there is no plate to attach');
  // Labelled by position, not by hash: `MakeContext` does not carry the program hash and cannot be
  // given one, because OBSERVATION_HASH is taken over the source bytes of observation.ts. The
  // inspector resolves the standing hash from the log line's own place in the run instead.
  const images: PolicyImage[] = [{ mediaType: 'image/png', base64: plate.toString('base64'), label: 'plate' }];
  if (context.changeAttached && change) {
    images.push({ mediaType: 'image/png', base64: change.toString('base64'), label: 'change' });
  }
  return images;
}

/**
 * The influence block during MAKE is off unless asked for, and the reason is not token cost.
 *
 * FIND and SKETCH happen before there is a picture; MAKE happens with one in front of the artist. A
 * shelf of other people's work held up beside a canvas mid-piece is the condition under which
 * "derivation" turns into "quotation", which is the thing `judge.ts` grades and would then be
 * grading a pressure the environment applied. So the default arm shows the works once, early, and
 * lets the piece proceed from what that did — and `--influences-in-make` is the other arm, to be
 * compared against it rather than assumed better.
 *
 * The text is appended here rather than inside `makeObservation`, so `observationHash` does not move
 * and a run without the layer sends the identical bytes.
 */
export async function act(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  context: MakeContext,
  plate: Buffer | null = null,
  change: Buffer | null = null,
  influences: InfluenceDoc | null = null,
  sampling: SamplingPlan | null = null
): Promise<CallResult<Action>> {
  return callPolicy<Action>(policy, log, spend, {
    name: 'act',
    system: SYSTEM,
    // Catalogue entries and no pictures, hence the 0. The images this call carries are the canvas
    // and what the last step moved, and the observation says so by position — "the canvas itself is
    // attached" stops being true of image 1 if eight museum works are prepended to the list.
    observation: withSamplingCommitments(withInfluences(makeObservation(context), influences, 0), sampling),
    schema: actSchema(),
    images: framesOf(context, plate, change),
    maxTokens: 8000,
  });
}

export async function replan(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  context: MakeContext,
  trigger: TriggerName,
  detail: string,
  plate: Buffer | null = null,
  change: Buffer | null = null,
  influences: InfluenceDoc | null = null,
  sampling: SamplingPlan | null = null
): Promise<Intention> {
  log.append('phase', { phase: 'replan', trigger });
  const result = await callPolicy<{ intention: Intention; why: string }>(policy, log, spend, {
    name: 'replan',
    system: REPLAN_SYSTEM,
    observation: withSamplingCommitments(withInfluences(replanObservation(context, trigger, detail), influences, 0), sampling),
    schema: REPLAN_SCHEMA,
    images: framesOf(context, plate, change),
    maxTokens: 4000,
  });
  return result.action.intention;
}
