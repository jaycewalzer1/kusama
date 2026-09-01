// FIND: locate a problem before solving one.
//
// This runs before any picture exists, and it is the phase most likely to be quietly skipped by a
// system like this — a model handed a situation will happily start designing, and the design will
// be about the situation's subject rather than about any difficulty in making it. So FIND is a
// separate call with its own schema, and the schema forces every problem to quote the field lines
// it came from. A problem that cites nothing was invented, and `problemFindingSteps` counts it.
//
// The field is the whole reason this can work at all. Without it the model can only rediscover the
// condition; with it there is something outside the model to find a problem *in*.

import { callPolicy, type Spend } from '../call.js';
import { findObservation } from '../observation.js';
import { distribution, rng, sampleIndices, streamSeed, tookTheMode } from '../sampling.js';
import { FIND_SCHEMA } from '../schemas.js';
import { artistLayers } from '../field.js';
import { influenceImages, withInfluences, type InfluenceDoc } from '../influence-doc.js';
import type { Commission } from '../field.js';
import type { Policy } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { Problem, Question } from '../types.js';

/**
 * How many of the proposed problems are carried into SKETCH.
 *
 * Three, which is what the loop always sketched. The change is not how many problems get drawn but
 * how they are chosen: they used to be the whole of a short answer, and are now a draw from a longer
 * one. Raising this would raise the sketch bill linearly and narrow the distribution it draws from,
 * which is the wrong direction on both counts.
 */
export const FIND_KEEP = 3;

const SYSTEM = [
  'You are an artist with a fixed position, working in a situation you did not choose. Nobody has',
  'asked you for anything. There is no client, no audience owed an explanation, and nothing that has',
  'to be legible off the surface.',
  '',
  'You are not designing yet. You are doing the two things that come before designing: working out',
  'what the situation has not settled, and looking for the problem. Read the field for what is',
  'actually difficult here — what is contested, what has been used up, who will refuse to look — and',
  'find the places where that rubs against the tensions your own position already carries.',
  '',
  'Quote the field. A problem you could have written from the condition alone is not one.',
].join('\n');

export async function find(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  runSeed: number,
  influences: InfluenceDoc | null = null
): Promise<{ questions: Question[]; problems: Problem[]; proposed: Problem[] }> {
  log.append('phase', { phase: 'find', influences: influences?.id ?? null });
  const result = await callPolicy<{ questions: Question[]; problems: Problem[] }>(policy, log, spend, {
    name: 'find',
    system: SYSTEM,
    observation: withInfluences(findObservation(artistLayers(commission), commission.field), influences),
    schema: FIND_SCHEMA,
    // FIND is where the pictures go if they go anywhere. It is the one phase whose whole job is to
    // decide what is difficult here before anything has been drawn, so it is the phase where having
    // looked at something could plausibly change the answer rather than decorate it.
    ...(influences ? { images: influenceImages(influences) } : {}),
    maxTokens: 4000,
  });
  const proposed = result.action.problems;

  // The draw. Seeded off the run seed and the phase name, so it is a pure function of things already
  // in the log and `replay` takes the same three with the model unplugged.
  const seed = streamSeed(runSeed, 'find');
  const weighted = proposed.map((p) => ({ probability: p.probability ?? 0 }));
  const drawn = sampleIndices(weighted, FIND_KEEP, rng(seed));
  const d = distribution(
    'find',
    seed,
    proposed.map((p) => ({ key: p.id, probability: p.probability ?? 0 })),
    drawn
  );
  log.append('note', { phase: 'find', verbalized: d, tookTheMode: tookTheMode(d) });

  return { questions: result.action.questions, problems: drawn.map((i) => proposed[i]!), proposed };
}

/**
 * A citation is a run of words, not the punctuation somebody put around it. Models quote in
 * typographic quote marks about half the time, and a `“…”` wrapper makes an exact citation fail to
 * match a field that does not carry the marks. One measured run scored `problemsGrounded: 0` on
 * sixteen refs of which six were verbatim, purely because of the wrapper — a measurement reporting
 * the opposite of what happened. Only the outer marks come off; anything inside stays, so a
 * paraphrase still fails, which is the distinction this check exists to make.
 */
function unquote(ref: string): string {
  return ref.trim().replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, '');
}

/**
 * How many of the problems actually came from the field, by the only test available without a judge:
 * the quoted line has to appear in the field. A model that paraphrases loses the point, which is the
 * right way round — a paraphrase is not a citation.
 */
export function grounded(problems: Problem[], fieldText: string): number {
  const haystack = fieldText.toLowerCase();
  return problems.filter((p) =>
    p.fieldRefs.some((ref) => {
      const needle = unquote(ref).toLowerCase();
      // Long quotes are matched whole; short ones would match by accident, so they need eight words.
      const words = needle.split(/\s+/);
      return words.length >= 8 ? haystack.includes(needle) : false;
    })
  ).length;
}
