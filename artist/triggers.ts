// The six triggers. Nothing else fires a replan.
//
// This file exists so that "the artist revised its plan" is always answerable with a name and a
// piece of evidence. A loop that replans whenever the model feels like it produces trajectories in
// which revision cannot be studied, because there is nothing to count. So: six names, each with a
// condition, each logged with the evidence that fired it.
//
//   description-disagrees  the blind describer's account of the sheet does not match what the artist
//                          said it was making
//   audience-disagrees     the person the field named would not take it the way it was meant
//   description-unchanged  consecutive kept steps that a blind reader could not tell apart
//   unplanned-violation    a constraint that was satisfied before this step is violated after it,
//                          and the artist did not say it was going to do that
//   artist-declares        the artist asked to replan
//   stall                  `stallThreshold` steps with no improvement in the position's own score
//
// Two of them cost a model call each, so they are checked at most once per step and only when there
// is something new to check. `description-unchanged` reads descriptions that have already been paid
// for, which is why it is checked before them.

import { credulous } from './affect.js';
import { descriptionAgrees, audienceAgrees, type Agreement } from './env-calls.js';
import type { Affect, CheckReport, Intention, StepDeclaration, TriggerName } from './types.js';

export interface Fired {
  trigger: TriggerName;
  detail: string;
  /** Model spend attributable to deciding this trigger, so cost can be attributed honestly. */
  usd: number;
  cached: boolean;
}

/**
 * What the artist claims the piece is doing, in one paragraph, for the describer to be compared
 * against. Assembled from the plan rather than written by a second model call: the intention is
 * already the artist's own words, and paraphrasing it would put a third opinion in the middle of a
 * two-way comparison.
 */
export function intendedReading(intention: Intention): string {
  const elements = intention.elements.map((e) => `${e.role}`).join('; ');
  return `${intention.purpose} It is built from: ${elements}.`;
}

/**
 * A constraint that was satisfied and now is not. Only `satisfied -> violated` counts: a constraint
 * that was already violated and still is has not been broken by this step, and one that moved from
 * `unverified` is not evidence of anything, because nobody had checked it.
 */
export function newViolations(before: CheckReport, after: CheckReport): string[] {
  const was = new Map(before.results.map((r) => [r.id, r.status]));
  return after.results
    .filter((r) => r.status === 'violated' && was.get(r.id) === 'satisfied')
    .map((r) => `${r.id} (${r.kind}): ${r.evidence}`);
}

/**
 * How many constraints one step's risk may name before it has declared nothing.
 *
 * Above this the step is not saying "I am going to break p-lowercase", it is holding a pass over the
 * rubric. Three leaves room to break a couple of things on purpose and say so; it does not leave
 * room to pre-authorize a page. Measured on the two recorded runs before this cap existed, steps
 * named 5, 4, 6 and 6 of a 9-constraint vocabulary without any adversarial intent at all — the model
 * does this by default.
 */
export const MAX_DECLARED_IDS = 3;

/**
 * What this step declared it was breaking.
 *
 * Read from `risk` alone. The MAKE schema has always said "naming a constraint id here is how you
 * declare that you meant to break it", and `here` is that field — but the check was run against
 * `think` concatenated with `risk`, so any incidental mention counted. That is not a narrow reading
 * of a loose rule; it is the code disagreeing with its own documented contract, and the artist is
 * shown every constraint id in the checker table on every call. On the two recorded runs the model
 * named up to 6 of the 9 constraints per step while reasoning about which ones it was *satisfying*,
 * and each of those steps held an undeclared-violation pass over all 6. Read from `risk` alone the
 * same seven steps name 1, 0, 0, 0 and 0, 0, 0.
 *
 * The match within `risk` stays loose — the ids are machine-generated and the risk is prose — but a
 * declaration naming more than a handful is treated as no declaration. A false negative costs one
 * replan. A false positive is the whole channel.
 */
export function declarationOf(risk: string | null, vocabulary: string[], broke: string[]): StepDeclaration {
  const said = (risk ?? '').toLowerCase();
  const namedIds = said.length === 0 ? [] : vocabulary.filter((id) => id.length > 0 && said.includes(id.toLowerCase()));
  const blanket = namedIds.length > MAX_DECLARED_IDS;
  const named = new Set(namedIds);
  return {
    namedIds,
    blanket,
    broke,
    covered: blanket ? [] : broke.filter((id) => named.has(id)),
  };
}

/** The constraint id a `newViolations` line starts with. */
export function violatedId(line: string): string {
  return line.split(' ')[0] ?? '';
}

export function unplannedViolation(
  before: CheckReport,
  after: CheckReport,
  risk: string | null
): { fired: Fired | null; declaration: StepDeclaration } {
  const lines = newViolations(before, after);
  const declaration = declarationOf(risk, after.results.map((r) => r.id), lines.map(violatedId));
  const covered = new Set(declaration.covered);
  const undeclared = lines.filter((v) => !covered.has(violatedId(v)));
  if (undeclared.length === 0) return { fired: null, declaration };
  return {
    fired: {
      trigger: 'unplanned-violation',
      detail: declaration.blanket
        ? `this step broke something that was holding. Your risk named ${declaration.namedIds.length} ` +
          `constraints, which declares none of them — name the one you are breaking: ${undeclared.join('; ')}`
        : `this step broke something that was holding, and you did not say you would: ${undeclared.join('; ')}`,
      usd: 0,
      cached: true,
    },
    declaration,
  };
}

export function stalled(stepsWithoutImprovement: number, threshold: number): Fired | null {
  if (stepsWithoutImprovement < threshold) return null;
  return {
    trigger: 'stall',
    detail: `${stepsWithoutImprovement} steps in a row have not improved the score against your own position.`,
    usd: 0,
    cached: true,
  };
}

/**
 * How many kept steps in a row have to read the same before the branch is called stuck.
 *
 * Three. Two is one repetition and models repeat themselves; three is a run, and it is well inside
 * what was actually observed — in one logged trajectory the describer returned the same sentence for
 * six consecutive kept steps and nothing in the environment noticed. Higher than three and the
 * trigger cannot fire at all on a short run, which is most of them.
 */
export const SAME_READ_STEPS = 3;

function flatten(read: string): string {
  return read.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:'"]/g, '');
}

/**
 * The branch is stuck: the last few kept steps changed the program and changed nothing a blind
 * reader could report.
 *
 * `reads` are the descriptions from *accepted* steps only. A reverted step leaves the canvas where
 * it was, so its read is trivially the same as the one before it and counting it would fire this on
 * a run that was making progress between two failures.
 *
 * The comparison is equality after flattening whitespace, case and punctuation, and that is
 * deliberately the weakest test that catches the observed failure rather than the strongest test
 * that could be written. A similarity threshold over two reworded paragraphs would need a cutoff,
 * and there is no measurement in this repo that would set one; a cutoff picked by feel would make
 * this fire on branches that were moving. What it therefore CANNOT catch is a describer that says
 * the same thing in different words, and that is a real gap, not a rounding error — this is a floor.
 *
 * It costs nothing. Both strings were already paid for by `observe`.
 */
export function describedTheSame(reads: string[], window: number = SAME_READ_STEPS): Fired | null {
  if (reads.length < window) return null;
  const recent = reads.slice(-window).map(flatten);
  if (recent.some((r) => r.length === 0)) return null;
  if (!recent.every((r) => r === recent[0])) return null;
  return {
    trigger: 'description-unchanged',
    detail:
      `${window} kept steps in a row and someone who cannot see your plan has described the sheet ` +
      'in the same words every time. Whatever you have been doing is not reaching the page. Change ' +
      `what kind of move you are making — not a bigger version of the last one — or abandon this ` +
      `line. What they keep saying: ${reads[reads.length - 1]!.trim()}`,
    usd: 0,
    cached: true,
  };
}

/**
 * The one place affect touches a decision other than step size. A pleased artist (valence > 0.3) is
 * the one least likely to accept that the sheet is not saying what it thinks, so at high valence the
 * describer's disagreement is taken at face value, while at ordinary valence a disagreement must
 * also be substantive — the describer has to have given a reason with something in it.
 *
 * This is the asymmetry on purpose: the environment gets more say precisely when the artist is
 * least inclined to listen.
 */
function disagreementCounts(agreement: Agreement, affect: Affect): boolean {
  if (agreement.agree) return false;
  return credulous(affect) || agreement.reason.trim().length > 30;
}

export async function descriptionDisagrees(
  intention: Intention,
  description: string,
  affect: Affect
): Promise<Fired | null> {
  const r = await descriptionAgrees(intendedReading(intention), description);
  if (!disagreementCounts(r.value, affect)) return null;
  return {
    trigger: 'description-disagrees',
    detail: `someone who cannot see your plan does not read the sheet as doing what you say it does: ${r.value.reason}`,
    usd: r.usd,
    cached: r.cached,
  };
}

export async function audienceDisagrees(
  intention: Intention,
  read: string,
  affect: Affect
): Promise<Fired | null> {
  const r = await audienceAgrees(intendedReading(intention), read);
  if (!disagreementCounts(r.value, affect)) return null;
  return {
    trigger: 'audience-disagrees',
    detail: `the person the field says is watching would not take it the way you meant: ${r.value.reason}`,
    usd: r.usd,
    cached: r.cached,
  };
}
