// CHOOSE: pick a problem, having seen what the problems look like drawn.
//
// The contact sheet goes in as an image, not as a description of an image. That is the whole design
// of this phase: an artist choosing between three ideas from their written summaries is choosing
// between summaries. Sketches exist so the choice is made against pixels, and the schema asks for a
// `why` that refers to what is visible, so a trajectory records whether it actually did.

import { callPolicy, type Spend } from '../call.js';
import { chooseObservation } from '../observation.js';
import { CHOOSE_SCHEMA } from '../schemas.js';
import type { Commission } from '../field.js';
import type { Policy, PolicyImage } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Intention, Problem, Sketch } from '../types.js';

const SYSTEM = [
  'You are an artist choosing which of your own problems to make a piece about.',
  '',
  'You are looking at your own sketches. Judge them as pictures, not as intentions: a sketch that',
  'proves an idea does not work is worth more than one that looks competent, and you should say so if',
  'that is what you see.',
  '',
  'Then state the plan as a graph of parts and the relations between them, and name the one thing',
  'this genre would not do that you intend to do anyway.',
].join('\n');

export interface Chosen {
  problemId: string;
  why: string;
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
    ? [{ mediaType: 'image/png', base64: contactSheet.toString('base64') }]
    : [];

  const result = await callPolicy<Chosen>(policy, log, spend, {
    name: 'choose',
    system: SYSTEM,
    observation: chooseObservation(commission.position, commission.brief, problems, note),
    schema: CHOOSE_SCHEMA,
    images,
    maxTokens: 4000,
  });
  return result.action;
}
