// The moves that touch no pixels.
//
// Until now the artist's whole action space was `edits`. Everything else it did — deciding a work
// was worth looking at, deciding one was not, taking a relation off something and carrying it into
// the plan, changing what the piece is about — happened inside `think`, which is prose, and prose is
// not a move. The consequence is precise and it is not stylistic: a critic asked to audit *this
// run's decisions* can only reach the brushwork, because the brushwork is the only thing the record
// holds as a decision. Everything upstream of it was already collapsed into a paragraph by the time
// anything could look.
//
// So five moves get names, get refs, and get written down on the step that made them.
//
//   retrieve            You went and got something and it is now bearing on the piece.
//   reject              You considered something and are deliberately not using it. A rejection is a
//                       decision; an omission is not, and the record cannot otherwise tell them
//                       apart — which is why "the model never looked at X" and "the model looked at
//                       X and turned it down" have always read identically here.
//   copy-as-study       You reproduced something in order to understand it, not in order to keep it.
//   extract-a-relation  You took a relation off one thing and are carrying the relation, not the
//                       thing. Names two or more refs, because a relation between one thing and
//                       nothing is a description.
//   reframe             You changed what the piece is about. Refs name what you are re-reading.
//
// ## What is checked, and what deliberately is not
//
// One thing is checked: **every ref has to name something the environment actually put in front of
// the artist.** The environment knows what it showed — the lineage elements, the works of any
// influence block, the artist's own declared plan, the constraint table — so a ref outside that set
// is a move about something the run never saw, and it is recorded as unfounded rather than taken on
// trust. This is the same test `problemsGrounded` applies to a quoted field line, and it is here for
// the same reason: a claim whose referent nobody can look up is `locatable: false` again, and this
// repo has already paid for that once.
//
// Nothing else is checked. Whether a `reject` was honoured downstream, whether a
// `extract-a-relation` really carried the relation and not the thing — those need a critic, and the
// critic needs this record to exist first. That is the order.
//
// ## These moves earn nothing
//
// A move does not reset the stall counter, does not lift the mood, does not make a step non-inert
// and does not enter any score that anything optimises. That is deliberate and it is the whole
// safety property of the feature. `inertSteps` is this repo's reward-hacking counter — steps that
// were kept and changed nothing — and the first thing an artist under pressure would do with a
// free-text epistemic move is attach one to an empty step and buy its way out of the counter. So
// `inert` keeps its old meaning exactly, and `pixellessSteps` is reported *beside* it: the reader
// sees "nine inert steps, three of which carried a grounded move" and decides what that is worth.
// Nothing here decides it for them.
//
// The point of writing them down is not to reward them. It is that a judge cannot audit a decision
// that was never recorded as one.

import type { CheckReport } from '../aesthetic/types.js';
import type { EpistemicMove, Intention, MoveKind, MoveRecord, MoveSummary } from './types.js';

export const MOVE_KINDS: readonly MoveKind[] = [
  'retrieve',
  'reject',
  'copy-as-study',
  'extract-a-relation',
  'reframe',
] as const;

/**
 * Everything the environment put in front of the artist, by id.
 *
 * Assembled from what the environment holds rather than declared, so it cannot claim to have shown
 * something it did not. Each list is a different provenance and they are kept apart in the type for
 * readability only — the check flattens them.
 */
export interface Shown {
  /** Lineage element ids composed into the position. */
  elements: string[];
  /** Corpus works held up in an influence block. Empty on the runs that were shown no corpus. */
  works: string[];
  /** The artist's own plan: the element ids it declared. */
  planned: string[];
  /** Constraint ids in the checker table, which is printed on every act call. */
  constraints: string[];
}

export function shown(commission: { elementIds: string[] }, intention: Intention, report: CheckReport, works: string[] = []): Shown {
  return {
    elements: [...commission.elementIds],
    works,
    planned: intention.elements.map((e) => e.id),
    constraints: report.results.map((r) => r.id),
  };
}

/**
 * The moves of one step, each with the refs that named nothing.
 *
 * Comparison is exact, not fuzzy. A ref is an id the artist was shown printed verbatim, and
 * accepting a near miss would make the check a spell-corrector: the failure this catches is a move
 * about a work the run never saw, and that failure does not look like a typo.
 */
export function record(moves: EpistemicMove[], s: Shown): MoveRecord[] {
  const known = new Set([...s.elements, ...s.works, ...s.planned, ...s.constraints]);
  return moves.map((move) => ({ move, unknownRefs: move.refs.filter((r) => !known.has(r)) }));
}

export function grounded(r: MoveRecord): boolean {
  return r.unknownRefs.length === 0;
}

/**
 * The fold over a run's steps.
 *
 * Returns null when not one step carried the field, which is every trajectory collected before this
 * existed. That is the standing rule in this repo and it is load-bearing here: a zeroed summary
 * would report the entire back catalogue as having been asked for epistemic moves and made none,
 * when in fact it was never asked. See `inertSteps`.
 */
export function moveSummary(steps: { moves?: MoveRecord[] | null; pixelsMoved?: number }[]): MoveSummary | null {
  if (!steps.some((s) => s.moves !== undefined && s.moves !== null)) return null;
  const byKind = Object.fromEntries(MOVE_KINDS.map((k) => [k, 0])) as Record<MoveKind, number>;
  let total = 0;
  let ok = 0;
  let pixelless = 0;
  let withMoves = 0;
  for (const step of steps) {
    const records = step.moves ?? [];
    if (records.length === 0) continue;
    withMoves++;
    // `=== 0`, with no `?? 0` anywhere above it. A step whose `pixelsMoved` the record does not
    // carry is not a step that moved no pixels, it is a step nobody measured, and defaulting it
    // would report the older logs as one long stretch of pixelless deliberation.
    if (step.pixelsMoved === 0) pixelless++;
    for (const r of records) {
      total++;
      byKind[r.move.kind]++;
      if (grounded(r)) ok++;
    }
  }
  return { total, byKind, grounded: ok, pixellessSteps: pixelless, stepsWithMoves: withMoves };
}

/** One block for a terminal, and for the step history the artist is shown. */
export function moveLine(r: MoveRecord): string {
  const refs = r.move.refs.join(' ');
  const bad = grounded(r) ? '' : ` [UNFOUNDED: ${r.unknownRefs.join(' ')} named nothing you were shown]`;
  return `${r.move.kind} ${refs}${bad} — ${r.move.because}`;
}
