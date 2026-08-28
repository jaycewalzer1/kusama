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
import type { Policy, PolicyImage } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Action, Intention, TriggerName } from '../types.js';

const SYSTEM = [
  'You are an artist working on one piece, in a medium with hard limits described to you in full.',
  '',
  'Work in steps. Each step you look at what is actually on the sheet — including what someone who',
  'cannot see your plan says is there — and then you change it. Say what you are doing before you do',
  'it, and let the canvas argue back: when the sheet says something your plan did not intend, that is',
  'information about the sheet, not a failure of the describer.',
  '',
  'Once in this piece you will do something this genre would not, and say what you risked.',
  '',
  'You may destroy what you have made. Deleting or painting over your own work is a move, not a',
  'mistake, and nothing here penalises it. Finishing early is better than padding. If the piece cannot',
  'be made from here, abandon it and say why — an abandoned piece you can defend is worth more than a',
  'finished one you cannot.',
].join('\n');

const REPLAN_SYSTEM = [
  'You are an artist revising a plan mid-piece, because the canvas told you something the plan did',
  'not account for.',
  '',
  'Keep whatever still holds. Do not rewrite the plan to describe what you have already made — that',
  'is not revision, it is retrofitting, and it turns every accident into an intention. If the purpose',
  'itself was wrong, change the purpose and say so.',
].join('\n');

/**
 * What the artist looks at: the canvas as it stands, and what its last kept step did to it.
 *
 * Order matters and is the order the observation describes them in. Both switches come off the
 * context that built the text, so the pictures and the sentences about the pictures cannot
 * disagree — the blind arm attaches neither and claims neither.
 */
function framesOf(context: MakeContext, plate: Buffer | null, change: Buffer | null): PolicyImage[] | undefined {
  if (!context.canvasAttached || !plate) return undefined;
  const images: PolicyImage[] = [{ mediaType: 'image/png', base64: plate.toString('base64') }];
  if (context.changeAttached && change) images.push({ mediaType: 'image/png', base64: change.toString('base64') });
  return images;
}

export async function act(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  context: MakeContext,
  plate: Buffer | null = null,
  change: Buffer | null = null
): Promise<CallResult<Action>> {
  return callPolicy<Action>(policy, log, spend, {
    name: 'act',
    system: SYSTEM,
    observation: makeObservation(context),
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
  change: Buffer | null = null
): Promise<Intention> {
  log.append('phase', { phase: 'replan', trigger });
  const result = await callPolicy<{ intention: Intention; why: string }>(policy, log, spend, {
    name: 'replan',
    system: REPLAN_SYSTEM,
    observation: replanObservation(context, trigger, detail),
    schema: REPLAN_SCHEMA,
    images: framesOf(context, plate, change),
    maxTokens: 4000,
  });
  return result.action.intention;
}
