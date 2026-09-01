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
  'You are an artist looking at your own finished piece and saying what it is worth.',
  '',
  'Score it against your own position, not against the effort it cost and not against how close it',
  'came to your plan. A piece that abandoned the plan and is better for it scores well; a piece that',
  'executed the plan exactly and is inert scores badly.',
  '',
  'Where you cannot tell from the image whether a relation in your plan actually holds, say so. A',
  'high score you cannot point at in the picture is worse than a low one you can.',
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
    images: [{ mediaType: 'image/png', base64: png.toString('base64') }],
    maxTokens: 4000,
  });
  return result.action;
}
