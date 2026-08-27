// The five triggers. Nothing else fires a replan.
//
// This file exists so that "the artist revised its plan" is always answerable with a name and a
// piece of evidence. A loop that replans whenever the model feels like it produces trajectories in
// which revision cannot be studied, because there is nothing to count. So: five names, each with a
// condition, each logged with the evidence that fired it.
//
//   description-disagrees  the blind describer's account of the sheet does not match what the artist
//                          said it was making
//   audience-disagrees     the person the field named would not take it the way it was meant
//   unplanned-violation    a constraint that was satisfied before this step is violated after it,
//                          and the artist did not say it was going to do that
//   artist-declares        the artist asked to replan
//   stall                  `stallThreshold` steps with no improvement in the position's own score
//
// The first two cost a model call each, so they are checked at most once per step and only when
// there is something new to check.

import { credulous } from './affect.js';
import { descriptionAgrees, audienceAgrees, type Agreement } from './env-calls.js';
import type { Affect, CheckReport, Intention, TriggerName } from './types.js';

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
 * Did the artist say it was going to break something? A declared risk excuses a violation; an
 * undeclared one is the trigger. The match is deliberately loose — the artist writes the risk in
 * prose and the constraint id is machine-generated — so it looks for the id appearing anywhere in
 * what the artist said this step. A false negative here costs one replan, which is cheap; a false
 * positive would let an artist dodge the trigger by naming a constraint at random, which is not.
 */
export function declared(said: string, violation: string): boolean {
  const id = violation.split(' ')[0] ?? '';
  return id.length > 0 && said.toLowerCase().includes(id.toLowerCase());
}

export function unplannedViolation(
  before: CheckReport,
  after: CheckReport,
  said: string
): Fired | null {
  const undeclared = newViolations(before, after).filter((v) => !declared(said, v));
  if (undeclared.length === 0) return null;
  return {
    trigger: 'unplanned-violation',
    detail: `this step broke something that was holding, and you did not say you would: ${undeclared.join('; ')}`,
    usd: 0,
    cached: true,
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
