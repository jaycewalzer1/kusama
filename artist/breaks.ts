// The break record: which commitment broke, what forced it, at which step, and whether anybody said
// so in advance.
//
// This is the artifact the lineage layer exists to produce. Composing two elements is easy and
// proves nothing; the claim worth testing is that when a work cannot hold two inheritances at once,
// *something has to give*, and the interesting fact is what gave and why. `compose` says which pairs
// are in tension before the first mark. This says what happened to them.
//
// Four properties, and each is a decision that could have gone the other way:
//
//   machine-derived  Nothing here is self-reported. An artist asked whether it broke a commitment
//                    will say it was necessary, and an artist asked which rule forced it will
//                    produce a reason. Every field below is folded out of what the environment
//                    wrote down: the checker's verdicts on both sides of each step, and the step's
//                    own `risk` field matched against them (triggers.ts).
//   a view of the log Like transitions.json, and for the same reason. It computes nothing the run
//                    did not write down and reads no files, so the same command over a trajectory
//                    from last month produces the same artifact. If it needed to re-check a program
//                    it would be re-deciding, and a record that can re-decide is not a record.
//   its own file     `breaks.json`, beside `scores.json`, not a key inside it. A break record buried
//                    in a score object gets read as a component of the score, which is exactly what
//                    it is not: no number here is meant to go up.
//   honest about absence  A run whose log has no per-constraint verdicts — every trajectory
//                    collected before artist/env.ts logged them — reports `verdictsRecorded: false`
//                    and an empty list, which a reader must not confuse with "nothing broke".
//
// What is deliberately not here: any judgement about whether the break was *right*. Breaking a
// commitment to serve another lineage is what a blend is; the record says which one lost, and the
// question of whether that was the better work is L5's, from the finished picture, with no access
// to this file.

import type { ObservedState } from '../aesthetic/elements/conflicts.js';
import { observedConflicts } from '../aesthetic/elements/conflicts.js';
import type { Composition, Conflict, ConflictTier, SourceRef } from '../aesthetic/elements/types.js';
import { qualify } from '../aesthetic/elements/types.js';
import type { ConstraintResult } from '../aesthetic/types.js';
import type { LogLine } from './studio-log.js';
import type { StepDeclaration } from './types.js';

/** Why one constraint is named as what a break was paid for. Never the artist's word for it. */
export interface Forcing {
  /** The namespaced id, as it appears in the composition. */
  constraint: string;
  source: SourceRef;
  /**
   * `gained` — this one went violated -> satisfied on the very step the other broke. The strongest
   *            thing the record can say: the run traded them, in one move, and the checker saw both
   *            halves of the trade.
   * `conflict` — the two were already known to compete, by proof, by declaration or by observation.
   *            Weaker: it says the pressure existed, not that this step is where it was applied.
   */
  basis: 'gained' | 'conflict';
  /** Set only when `basis` is `conflict`. */
  tier?: ConflictTier;
  note: string;
}

export interface Break {
  k: number;
  constraint: string;
  source: SourceRef;
  part: ConstraintResult['part'];
  /**
   * The step's `risk` named this constraint before the edits were applied. False covers three
   * different things — said nothing, named something else, or named so many that the declaration
   * was treated as blanket — and `triggers.ts` is where they are told apart.
   */
  declaredInAdvance: boolean;
  /**
   * Whether the step that broke it was kept. A reverted step still recorded a real break of a real
   * constraint; it just did not survive, because the environment refuses a step that breaks a hard
   * constraint undeclared. Kept separate rather than filtered out: an artist that repeatedly tries
   * to break the same commitment and is repeatedly refused is a finding.
   */
  accepted: boolean;
  forcedBy: Forcing[];
}

export interface BreakRecord {
  elementIds: string[];
  /**
   * False when the log carries no per-constraint verdicts, which is every trajectory recorded before
   * artist/env.ts logged them. The lists below are then empty because nothing could be read, and a
   * reader that treats that as "nothing broke" has the wrong answer.
   */
  verdictsRecorded: boolean;
  /** How many checked states the run passed through. The denominator behind the observed tier. */
  statesObserved: number;
  breaks: Break[];
  /**
   * Conflicts this run's states demonstrate and that nobody had proved or declared. Empty is the
   * expected result on a short run and is not a claim that the elements are compatible.
   */
  observed: Conflict[];
  summary: {
    /** Breaks on steps that were kept. */
    stuck: number;
    /** Breaks on steps the environment threw away. */
    reverted: number;
    /** Of the ones that stuck, how many the step had named in advance. */
    declared: number;
    /** Of the ones that stuck, how many nothing in the record explains. */
    unexplained: number;
    /** Broken commitments by the source that owned them. */
    bySource: Record<string, number>;
  };
}

interface RenderData {
  satisfied?: string[];
  violated?: string[];
}

interface StepData {
  k: number;
  accepted: boolean;
  declaration: StepDeclaration | null;
}

const EMPTY: BreakRecord['summary'] = { stuck: 0, reverted: 0, declared: 0, unexplained: 0, bySource: {} };

/**
 * Folds a log and the composition it ran under into one record.
 *
 * The composition is passed in rather than recomposed from the element ids: recomposing would read
 * today's element pack, and an element edited since the run would silently rewrite what that run is
 * said to have broken. `runTrajectory` logs it on the `trajectory-start` line for exactly this
 * reason, and `breakRecordOf` below takes it from there.
 */
export function breaks(lines: LogLine[], composition: Composition | null, elementIds: string[]): BreakRecord {
  const sourceOf = new Map<string, { source: SourceRef; part: ConstraintResult['part'] }>(
    (composition?.constraints ?? []).map((c) => [c.id, { source: c.source, part: c.part }])
  );
  const conflicts = composition?.conflicts ?? [];

  const states: ObservedState[] = [];
  const out: Break[] = [];

  // The state the run is standing in, and the one a candidate render proposed. Same bookkeeping as
  // transition.ts: the first render is the seed's, every later one is a candidate until a `step`
  // line says whether it was kept.
  let current: Set<string> | null = null;
  let candidate: RenderData | null = null;
  let sawVerdicts = false;
  let k = 0;

  for (const line of lines) {
    if (line.kind === 'render') {
      const r = line.data as RenderData;
      // Absent is "this run did not record it", never "nothing was satisfied". A default of `[]`
      // here would make every old trajectory report a full set of observed conflicts.
      if (r.satisfied === undefined || r.violated === undefined) continue;
      sawVerdicts = true;
      states.push({ k, satisfied: r.satisfied, violated: r.violated });
      if (current === null) current = new Set(r.satisfied);
      else candidate = r;
      continue;
    }

    if (line.kind !== 'step') continue;
    const step = line.data as StepData;
    k = step.k;
    const declaration = step.declaration;
    const gained = new Set(
      candidate && current ? candidate.satisfied!.filter((id) => !current!.has(id)) : []
    );

    for (const id of declaration?.broke ?? []) {
      const known = sourceOf.get(id);
      // A break of a constraint the composition does not name means the log and the composition
      // disagree about what was being checked, which is a broken pairing rather than a finding.
      // Skipped rather than guessed at, and visible as a break count lower than the log's.
      if (!known) continue;
      out.push({
        k: step.k,
        constraint: id,
        source: known.source,
        part: known.part,
        declaredInAdvance: (declaration?.covered ?? []).includes(id),
        accepted: step.accepted,
        forcedBy: forcings(id, known.source, gained, sourceOf, conflicts),
      });
    }

    if (step.accepted && candidate) current = new Set(candidate.satisfied!);
    candidate = null;
  }

  const observed = composition && sawVerdicts ? observedConflicts(composition, states) : [];
  const stuck = out.filter((b) => b.accepted);
  const summary: BreakRecord['summary'] = {
    ...EMPTY,
    stuck: stuck.length,
    reverted: out.length - stuck.length,
    declared: stuck.filter((b) => b.declaredInAdvance).length,
    unexplained: stuck.filter((b) => b.forcedBy.length === 0).length,
    bySource: {},
  };
  for (const b of stuck) {
    const key = `${b.source.kind}:${b.source.id}`;
    summary.bySource[key] = (summary.bySource[key] ?? 0) + 1;
  }

  return { elementIds, verdictsRecorded: sawVerdicts, statesObserved: states.length, breaks: out, observed, summary };
}

/**
 * What, in the record, accounts for this break.
 *
 * Both bases require the other end to be from a *different* source. One lineage breaking its own
 * rule to keep another of its own rules is that lineage being incoherent — a real finding, and a
 * different one — and reporting it here would drown the cross-source trades this file is for.
 *
 * An empty list is a result, not a gap: the artist broke a commitment and nothing the environment
 * recorded explains what it bought. That is counted as `unexplained` and it is the number to look
 * at first.
 */
function forcings(
  broken: string,
  from: SourceRef,
  gained: Set<string>,
  sourceOf: Map<string, { source: SourceRef; part: ConstraintResult['part'] }>,
  conflicts: Conflict[]
): Forcing[] {
  const other = (s: SourceRef) => !(s.kind === from.kind && s.id === from.id);
  const out: Forcing[] = [];

  for (const id of gained) {
    const known = sourceOf.get(id);
    if (!known || !other(known.source)) continue;
    out.push({
      constraint: id,
      source: known.source,
      basis: 'gained',
      note: `${id} went from violated to satisfied on the same step ${broken} broke.`,
    });
  }

  const gainedIds = new Set(out.map((f) => f.constraint));
  for (const c of conflicts) {
    const a = qualify(c.a.source, c.a.constraintId);
    const b = qualify(c.b.source, c.b.constraintId);
    const end = a === broken ? { id: b, side: c.b } : b === broken ? { id: a, side: c.a } : null;
    if (!end || !other(end.side.source) || gainedIds.has(end.id)) continue;
    out.push({ constraint: end.id, source: end.side.source, basis: 'conflict', tier: c.tier, note: c.note });
  }
  return out;
}

/**
 * The whole record from the log alone, which is how every caller should get one.
 *
 * The composition and the element ids come off the `trajectory-start` line, so this reads one file
 * and joins against nothing. A log with no start line is not a trajectory.
 */
export function breakRecordOf(lines: LogLine[]): BreakRecord {
  const start = lines.find((l) => l.kind === 'trajectory-start');
  if (!start) throw new Error('no trajectory-start line: this is not a trajectory log');
  const data = start.data as { composition?: Composition | null; elementIds?: string[] };
  return breaks(lines, data.composition ?? null, data.elementIds ?? []);
}

/** One block for a terminal. Written to be scanned, not parsed. */
export function breakText(r: BreakRecord): string {
  if (!r.verdictsRecorded) {
    return 'This log has no per-constraint verdicts, so nothing can be said about what broke.\nIt predates artist/env.ts recording them. Re-running the trajectory is the only way to get them.';
  }
  if (r.elementIds.length === 0) {
    return `No elements were adopted, so there is one source and nothing to trade.\n${r.statesObserved} states checked; ${r.summary.stuck} constraints broke and stuck.`;
  }
  const rows = r.breaks.map((b) => {
    const how = b.forcedBy.length === 0 ? 'nothing in the record forced it' : b.forcedBy.map((f) => `${f.basis}: ${f.constraint}`).join('; ');
    return `k${String(b.k).padStart(2)}  ${b.accepted ? 'kept   ' : 'reverted'}  ${b.declaredInAdvance ? 'declared' : 'silent  '}  ${b.part.padEnd(16)}  ${b.constraint}\n        ${how}`;
  });
  const by = Object.entries(r.summary.bySource)
    .map(([k, n]) => `  ${k}: ${n}`)
    .join('\n');
  return [
    `elements: ${r.elementIds.join(', ')}`,
    `${r.statesObserved} states checked`,
    '',
    ...rows,
    '',
    `${r.summary.stuck} broke and stuck, ${r.summary.reverted} were reverted.`,
    `${r.summary.declared} of the ${r.summary.stuck} were declared in advance; ${r.summary.unexplained} are unexplained.`,
    by ? `broken by source:\n${by}` : '',
    r.observed.length ? `\n${r.observed.length} observed conflicts, none of them proved or declared:` : '',
    ...r.observed.map((c) => `  ${qualify(c.a.source, c.a.constraintId)} x ${qualify(c.b.source, c.b.constraintId)}\n    ${c.note}`),
  ]
    .filter((l) => l !== '')
    .join('\n');
}
