// EXAMINE: the artist judges its own finished work, looking at it.
//
// The final PNG goes in as an image. That matters more here than anywhere else in the loop: an
// artist scoring its own piece from a description of the piece is scoring its own description, and
// would reliably score its intentions rather than its results.
//
// The schema allows `judge-pending` on any edge, and the prompt says outright that it is the honest
// answer when nobody could tell from looking. That is deliberate — the alternative is an artist that
// must claim every relation held, which teaches it to claim.

import { callPolicy, type Spend } from '../call.js';
import { examineObservation } from '../observation.js';
import { EXAMINE_SCHEMA } from '../schemas.js';
import { artistLayers } from '../field.js';
import type { Commission } from '../field.js';
import type { Policy } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { CheckReport, Examine, Intention } from '../types.js';

const SYSTEM = [
  'You are looking at your own finished piece and saying what it is worth.',
  '',
  'Score against your position, not effort or plan-adherence. Abandoned plan + better = good;',
  'executed plan + inert = bad. Say `judge-pending` where you cannot tell from the image.',
  '',
  'Evaluate invention, not competence. Competent execution of an obvious idea scores lower',
  'than rough execution of a surprising one. Ask:',
  '- Was the central connection non-obvious? Is it specific to this situation?',
  '- Did it transform both source domains, or just decorate one with the other?',
  '- Could a generic model have produced this image?',
  '- Is the risk actually visible in the piece, or merely described in the plan?',
  '- Does the piece teach the viewer something about BOTH the subject and the referenced domain?',
].join('\n');

export async function examine(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  intention: Intention,
  report: CheckReport,
  description: string,
  audienceRead: string | null,
  png: Buffer
): Promise<Examine> {
  log.append('phase', { phase: 'examine' });
  const result = await callPolicy<Examine>(policy, log, spend, {
    name: 'examine',
    system: SYSTEM,
    observation: examineObservation(artistLayers(commission), intention, report, description, audienceRead),
    schema: EXAMINE_SCHEMA,
    images: [{ mediaType: 'image/png', base64: png.toString('base64'), label: 'plate' }],
    maxTokens: 4000,
  });
  return result.action;
}
