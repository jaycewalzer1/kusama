// Whether the artist is allowed to stop.
//
// Everything the loop learns about a piece — the checker, the blind describer, the audience, the
// artist's own self-score — was until now advisory. It was computed, written to the log, and had no
// effect on what happened next. A run could read "I would ignore it" from the one person the brief
// exists to reach, score itself 4 out of 10, and finish, because finishing was a fact the artist
// asserted rather than a request anyone could refuse.
//
// This file is the refusal. It is a pure function from evidence to blockers: no model, no I/O, no
// state. `run.ts` calls it when the artist says `finished`, and every blocker it returns is fed back
// into the next observation as a `finish-blocked` replan.
//
// Two rules govern what may be a blocker.
//
// It must be **falsifiable by the artist**. Every blocker below names something the artist can go
// and change — a fact that could not be read, a hard constraint that is violated, a plan edge the
// tree says did not land. "The audience was unenthusiastic" is not a blocker; "the audience said it
// would walk past" is, because the run's own brief says attendance is the point.
//
// It must be **evidence that exists**. A check that cannot be run — no audience was asked, no
// transcript was taken — returns no blocker. Absence of evidence never blocks, because a gate that
// treated a missing field as a failure would block hardest on the runs it knows least about.

import { normalizeText } from '../aesthetic/kinds.js';
import type { ReadString } from './env-calls.js';
import type { Brief } from './field.js';
import type { CheckReport, EdgeEstimate, Examine, WouldAct } from './types.js';

/** Why the environment would not let this stop. */
export interface Blocker {
  kind: 'unreadable-fact' | 'hard-violation' | 'audience-ignores' | 'self-score' | 'unrealized-edge';
  /** One sentence, written for the artist. It is put in front of the artist verbatim. */
  detail: string;
}

/**
 * Below this the artist has said the piece does not work. Taking it at its word is the whole
 * change: the number was already computed and already on disk, and the only thing that was missing
 * was anything happening as a result.
 *
 * 5 is the artist's own midpoint on a 1-10 scale, not a tuned value. It is deliberately not
 * configurable per position: a threshold a commission could set is a threshold that gets set to 0.
 */
export const SELF_SCORE_FLOOR = 5;

export interface GateEvidence {
  brief: Brief;
  report: CheckReport;
  examine: Examine;
  /** Null when no transcript was taken. Absent evidence does not block. */
  transcript: ReadString[] | null;
  /** Undefined when no audience was asked. */
  wouldAct?: WouldAct;
  /** True when the artist named something as unrealizable on its terminal step. */
  declaredUnrealizable: string | null;
}

/**
 * The strings the brief requires to be readable, from its own hard constraints.
 *
 * `mustAppear` is prose for a person — "the time of the meeting, 19:00" — and cannot be looked for
 * in a transcript. `textRequired.params.contains` is the same requirement written as the exact
 * characters, which is what a reader either can or cannot make out.
 */
export function requiredStrings(brief: Brief): string[] {
  const out: string[] = [];
  for (const c of brief.hard_constraints) {
    if (c.kind !== 'textRequired' || c.severity !== 'hard') continue;
    const contains = (c.params as { contains?: unknown }).contains;
    if (Array.isArray(contains)) out.push(...contains.filter((s): s is string => typeof s === 'string'));
  }
  return out;
}

/**
 * Which required strings a blind reader could not get off the sheet.
 *
 * Compared with `normalizeText`, the same function `textRequired` uses on the tree, so that the
 * difference between the two answers is a fact about the picture and not about two spellings of
 * "contains". Illegible pieces are excluded from the haystack before matching: a piece the reader
 * said it could not make out is exactly the evidence that the fact is not readable, so allowing it
 * to satisfy the requirement would invert the test.
 */
export function unreadable(required: string[], transcript: ReadString[]): string[] {
  const readable = transcript
    .filter((s) => s.legible)
    .map((s) => normalizeText(s.text))
    .join(' ');
  return required.filter((r) => !readable.includes(normalizeText(r)));
}

/**
 * The evidence, as a list of reasons to keep working. Empty means the artist may stop.
 *
 * Order is deliberate: the mechanical failures come first, because they are the ones the artist can
 * act on without a judgement call, and the artist reads this list from the top.
 */
export function finishBlockers(e: GateEvidence): Blocker[] {
  const out: Blocker[] = [];

  // A fact the commission requires and a reader cannot read. This is the failure the run this file
  // was written for actually had: `19:00` was in the program and came off the sheet as `10:00`.
  if (e.transcript !== null) {
    for (const missing of unreadable(requiredStrings(e.brief), e.transcript)) {
      out.push({
        kind: 'unreadable-fact',
        detail: `"${missing}" is required by the commission and a reader looking at the sheet could not read it. It is either not there, or not legible, or rendered as something else.`,
      });
    }
  }

  // Already decided by the checker and already shown to the artist every step. What is new is that
  // it now stops the run rather than appearing in a table beside a score of 0.895.
  for (const v of e.report.results.filter((x) => x.severity === 'hard' && x.status === 'violated')) {
    out.push({ kind: 'hard-violation', detail: `[${v.id}] is a hard constraint and it is violated: ${v.evidence}` });
  }

  // The brief for this kind of work says what it is for. If the one person watching would walk
  // past, the piece has not done it — however well it scores on the tree.
  if (e.wouldAct === 'ignore') {
    out.push({
      kind: 'audience-ignores',
      detail: 'The person this is for said they would walk past it. Whatever else is true of the sheet, it has not done the job it was made for.',
    });
  }

  // The artist's own number, acted on. A piece its maker calls a failure is not finished.
  if (e.examine.selfScore < SELF_SCORE_FLOOR) {
    out.push({
      kind: 'self-score',
      detail: `You scored this ${e.examine.selfScore}/10. That is your own judgement that it does not work yet, and it is not a thing to record and walk away from.`,
    });
  }

  // Plan edges the tree says did not land. One is allowed, and only if the artist said out loud
  // which one and why — that is the difference between a decision and an oversight. It is the same
  // rule `terminationOf` uses to call a stop legitimate, applied before the stop instead of after.
  const unrealized = e.examine.edgeEstimates.filter((x) => x.status === 'violated');
  if (unrealized.length > 0 && !(unrealized.length === 1 && e.declaredUnrealizable)) {
    const named = unrealized.map((x) => `${x.from}->${x.to}`).join(', ');
    out.push({
      kind: 'unrealized-edge',
      detail: `Your own reading of the image says ${unrealized.length} of your plan's relations do not hold: ${named}. Either make them hold, or drop them from the plan and say why.`,
    });
  }

  return out;
}

/** The blockers as the sentences the artist is shown. */
export function blockerLines(blockers: Blocker[]): string[] {
  return blockers.map((b) => `[${b.kind}] ${b.detail}`);
}
