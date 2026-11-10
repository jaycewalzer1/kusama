// CHOOSE: pick a problem, having seen what the problems look like drawn.
//
// The contact sheet goes in as an image, not as a description of an image. That is the whole design
// of this phase: an artist choosing between three ideas from their written summaries is choosing
// between summaries. Sketches exist so the choice is made against pixels, and the schema asks for a
// `why` that refers to what is visible, so a trajectory records whether it actually did.

import { callPolicy, type Spend } from '../call.js';
import { chooseObservation } from '../observation.js';
import { CHOOSE_SCHEMA } from '../schemas.js';
import { artistLayers } from '../field.js';
import type { Commission } from '../field.js';
import type { Policy, PolicyImage } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Collision, Intention, Problem, Sketch, Terms } from '../types.js';

const SYSTEM = [
  'You are choosing which problem to make this about, and setting your own terms.',
  '',
  'Judge your sketches as pictures, not intentions — a sketch proving an idea fails is worth',
  'more than a competent one. Prefer the sketch that shows the most surprising connection,',
  'not the most competent execution.',
  '',
  'Evaluate the wager: Is the connection non-obvious? Is it specific to this artist and this',
  'situation, or could a generic model have produced it? Does it transform both source domains,',
  'or merely decorate one with the other? A collision that changes how you see both sides is',
  'worth more than one that illustrates either.',
  '',
  'State the plan as a generative design law — not just elements and edges, but a rule that',
  'generates the visual logic of the piece. Name the one thing this genre would not do.',
].join('\n');

export interface Chosen {
  collision: Collision;
  problemId: string;
  why: string;
  cost: string;
  terms: Terms;
  intention: Intention;
}

export async function choose(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  problems: Problem[],
  sketches: Sketch[],
  contactSheet: Buffer | null,
  notes: string[]
): Promise<Chosen> {
  log.append('phase', { phase: 'choose', sketches: sketches.length });

  const note = sketches.length
    ? notes.join('\n')
    : 'No sketch survived: every one of them failed to render or was refused. Choose from the problems alone, and say that is what you are doing.';

  const images: PolicyImage[] = contactSheet
    ? [{ mediaType: 'image/png', base64: contactSheet.toString('base64'), label: 'contact-sheet' }]
    : [];

  const result = await callPolicy<Chosen>(policy, log, spend, {
    name: 'choose',
    system: SYSTEM,
    observation: chooseObservation(artistLayers(commission), problems, note),
    schema: CHOOSE_SCHEMA,
    images,
    maxTokens: 4000,
  });
  return result.action;
}
