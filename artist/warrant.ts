// Cite-then-verify. The positive twin of `StepDeclaration`.
//
// `declaration` asks what a step said it would BREAK and checks it against what went satisfied ->
// violated. This asks the other half: what a step says it is SERVING, checked against what went
// violated -> satisfied. Both are read from a field the artist fills in on the same call as the
// edits, and neither is a self-report that gets believed.
//
// ## Why this is worth a field
//
// ArtMine (arXiv:2607.08331 §2) has its policy cite evidence for each move and never checks that the
// citation is honoured; the citation is a prompt-engineering device that improves the prose. This
// repo has the opposite half — `check.ts` decides every constraint mechanically — and until now had
// no record of what the artist THOUGHT it was serving, so a step that worked toward the wrong rule
// and a step that worked toward the right one were indistinguishable in the log.
//
// Putting the two together makes one question decidable that neither system can ask alone: does the
// artist know what it is doing? Not "is the work good" — that is `check.ts` and the judge — but "is
// the account the artist gives of its own move the account the constraint table gives".
//
// ## The four buckets, and why `undecided` is expected to be the biggest
//
//   invented      the id is not in the vocabulary. The artist cited a rule that does not exist. This
//                 is the bucket with no excuses: every constraint id is printed in the checker table
//                 on every call, so an invented id is a fabrication and not a near miss.
//   redeemed      the constraint was not satisfied before this step and is satisfied after. The
//                 citation was made good on the same step.
//   contradicted  the constraint was satisfied before and is violated after. The step claimed to be
//                 serving it and broke it — the one bucket that is worse than saying nothing.
//   undecided     the id is real and its verdict did not move on this step.
//
// `undecided` will dominate any honest run and that is not a failure. Most work toward a constraint
// takes more than one step, and a constraint that was already satisfied and stayed satisfied is the
// normal case. A metric that treated `undecided` as a miss would punish an artist for building
// something over four steps instead of one, which is why the rate reported below is
// `contradicted + invented` over the cited total — the share of citations that are provably wrong —
// and not `redeemed` over the total.
//
// ## What this deliberately does not do
//
// It does not enter the reward. `warrant` is a field the artist writes, and a number computed from a
// field the artist writes, added to the score the artist is optimising, is a number the artist can
// raise by writing differently. A cheap policy would cite nothing (empty warrant, no wrong
// citations, perfect rate) or cite only what it has already satisfied. So this is a *report*, in the
// manner of `envelope` and `evidence`: it says what happened and stays out of the loop.
//
// ## The version bump this cost
//
// `warrant` is a required key on the ACT schema, so it changed what the artist is asked for on every
// MAKE call. `schemas.ts` is hashed into `observationHash` (observation.ts:53-59 hashes itself and
// schemas.ts together), so adding the field moved `observationHash` and with it `envVersion`, and
// every trajectory on disk now drifts on that field. Measured against snapshot 1f52bfe with
// observation.ts held fixed: the hash moves on schemas.ts alone. That is the mechanism working, not
// a cost to be minimised — a run collected before the artist was asked this question was collected
// under a different set of instructions, and `envDrift` is supposed to say so.
//
// The other bump in the same change set is `elementPackHash`, from `provenance.tier` becoming
// required; the argument for paying it is in aesthetic/elements/types.ts beside the field.

import type { CheckReport, Status } from '../aesthetic/types.js';
import type { LogLine } from './studio-log.js';

export type WarrantVerdict = 'invented' | 'redeemed' | 'contradicted' | 'undecided';

export interface CitedConstraint {
  id: string;
  verdict: WarrantVerdict;
  /** The constraint's status before and after this step. Both null when the id was invented. */
  before: Status | null;
  after: Status | null;
}

/** One step's citations, checked. */
export interface StepWarrant {
  /** The ids as the artist wrote them, deduplicated, in the order given. */
  cited: string[];
  checked: CitedConstraint[];
}

const statusOf = (report: CheckReport, id: string): Status | null =>
  report.results.find((r) => r.id === id)?.status ?? null;

/**
 * Check one step's citations against what the step did.
 *
 * Exact id match, unlike `declarationOf` which greedily substring-matches prose. The difference is
 * deliberate: `risk` is a sentence that may happen to contain an id, and the loose match is the
 * safe direction there. `warrant` is a list of ids and nothing else, so a value that is not an id
 * is an invented citation rather than a parsing problem, and reporting it as such is the point.
 */
export function warrantOf(cited: string[], before: CheckReport, after: CheckReport): StepWarrant {
  const unique = [...new Set(cited)];
  const checked = unique.map((id): CitedConstraint => {
    const b = statusOf(before, id);
    const a = statusOf(after, id);
    // Absent from `after` means absent from the vocabulary: the constraint list is a property of the
    // commission and does not change within a run.
    if (a === null) return { id, verdict: 'invented', before: null, after: null };
    if (b === 'satisfied' && a === 'violated') return { id, verdict: 'contradicted', before: b, after: a };
    if (b !== 'satisfied' && a === 'satisfied') return { id, verdict: 'redeemed', before: b, after: a };
    return { id, verdict: 'undecided', before: b, after: a };
  });
  return { cited: unique, checked };
}

export interface WarrantSummary {
  /** Steps that carried a warrant field at all. Steps logged before it existed are not counted. */
  steps: number;
  /** Steps in the trajectory with no `warrant` field. Not asked, which is not the same as cited nothing. */
  notAsked: number;
  /** Steps that were asked and cited nothing. Permitted — a wash serves no particular rule. */
  silent: number;
  citations: number;
  counts: Record<WarrantVerdict, number>;
  /**
   * `(invented + contradicted) / citations` — the share of citations the constraint table refutes.
   * Null when nothing was cited, because 0/0 here would read as a clean record.
   */
  wrongRate: number | null;
  /** Every invented id, once each, sorted. The list worth reading rather than the count. */
  inventedIds: string[];
}

const ZERO: Record<WarrantVerdict, number> = { invented: 0, redeemed: 0, contradicted: 0, undecided: 0 };

/** `warrant` is optional on `Step`, and `undefined` must not fold in as an empty citation list. */
export function warrantSummary(warrants: (StepWarrant | null | undefined)[]): WarrantSummary {
  const asked = warrants.filter((w): w is StepWarrant => w !== null && w !== undefined);
  const counts = { ...ZERO };
  const invented = new Set<string>();
  let citations = 0;
  for (const w of asked) {
    for (const c of w.checked) {
      counts[c.verdict]++;
      citations++;
      if (c.verdict === 'invented') invented.add(c.id);
    }
  }
  return {
    steps: asked.length,
    notAsked: warrants.length - asked.length,
    silent: asked.filter((w) => w.cited.length === 0).length,
    citations,
    counts,
    wrongRate: citations === 0 ? null : (counts.invented + counts.contradicted) / citations,
    inventedIds: [...invented].sort(),
  };
}

/**
 * The same fold off a finished run's log.
 *
 * Reads the stamped verdicts rather than re-checking. Re-checking would need every intermediate
 * render, and worse, it would decide an old run's citations against today's checker — the same
 * mistake `breaks.ts` avoids by taking the composition off the `trajectory-start` line.
 */
export function warrantsIn(lines: LogLine[]): (StepWarrant | null | undefined)[] {
  return lines
    .filter((l) => l.kind === 'step')
    .map((l) => (l.data as { warrant?: StepWarrant | null }).warrant);
}

export function warrantText(s: WarrantSummary): string {
  if (s.steps === 0) {
    return `No step in this run carried a warrant (${s.notAsked} step(s) predate the field). Nothing to check.`;
  }
  const out = [
    `${s.citations} citation(s) over ${s.steps} step(s) that were asked; ${s.silent} cited nothing.`,
    `  redeemed      ${String(s.counts.redeemed).padStart(3)}  went unsatisfied -> satisfied on the citing step`,
    `  undecided     ${String(s.counts.undecided).padStart(3)}  real id, verdict did not move — the expected majority`,
    `  contradicted  ${String(s.counts.contradicted).padStart(3)}  claimed to serve it and broke it`,
    `  invented      ${String(s.counts.invented).padStart(3)}  no such constraint in this commission`,
    '',
    s.wrongRate === null
      ? 'Nothing was cited, so there is no rate. That is not a clean record, it is an empty one.'
      : `${(s.wrongRate * 100).toFixed(1)}% of citations are refuted by the constraint table ` +
        `(invented + contradicted). This number is reported and never rewarded — see artist/warrant.ts.`,
  ];
  if (s.inventedIds.length > 0) out.push('', `Fabricated ids: ${s.inventedIds.join(', ')}`);
  if (s.notAsked > 0) out.push('', `${s.notAsked} step(s) carry no warrant field and are excluded from every count above.`);
  return out.join('\n');
}
