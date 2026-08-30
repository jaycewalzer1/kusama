// Does the position steer, or is it decoration?
//
// A position is meant to be a persistent deformation of the action prior: it should make some moves
// cheap, some expensive and some unavailable, and hold that shape while reward pushes back. The test
// of that claim is an ablation the loop already supports — `runTrajectory({ control: true })` hands
// the artist the same brief, the same object, the same protocol and the same budgets with L1 removed
// (run.ts `stripped`), and scores the result against the real position anyway.
//
// What was missing is the comparison. `scores.csv` compares the two arms on OUTCOME, and outcome
// cannot answer this question: the control is graded by the position's own checker, so it scores
// worse whether or not it ever behaved differently. A position could be pure decoration — changing
// nothing about what the artist reaches for — and still open a wide score gap, because the checker
// knows the position and the control artist does not. Reading that gap as evidence of steering is
// the error this file exists to prevent.
//
// So the comparison here is over ACTIONS, not scores: what did each arm reach for, how often was it
// refused, how often did it tear its own work out, how often did the plan move. Two artists that
// took the same actions in the same proportions are the same artist, whatever the scoreboard said.
//
// Pure, like story.ts, transition.ts and walkthrough.ts, and for the same reasons: it computes
// nothing the runs did not write down, reads no files, calls no model and starts no browser. It runs
// on a finished pair of directories or on two live tails.
//
// The honest limit, stated here because the number is small and looks authoritative: one trajectory
// per arm is a sample of one. A dozen steps and thirty-odd edits is not enough to call a modest
// divergence real, and nothing in this file computes a p-value or implies one. `sample` carries the
// edit counts precisely so a reader can see how thin the evidence is, and `verdict` refuses to call
// anything at all below `MIN_EDITS`. Two arms, one seed, is a smoke test. A claim about a position
// needs the same pair run across seeds, and comparing the spread of those to this number is the
// experiment — not this number on its own.

import type { LogLine } from './studio-log.js';
import { processOf, type Process } from './transition.js';
import type { TriggerName } from './types.js';

/**
 * Below this many edits on either side, no verdict is offered. Not a significance threshold — there
 * is no test here to be significant — but the point below which total variation distance is mostly
 * reporting which of two short lists happened to be longer.
 *
 * Set to 8 because a trajectory at the default `--steps 12` lands at about ten edits: a floor of 12
 * would refuse a verdict on every run this repo actually produces, which is not caution, it is a
 * tool that never answers.
 */
export const MIN_EDITS = 8;

/**
 * Total variation distance under which two arms are called indistinguishable.
 *
 * The one calibration that exists: `out/studio/20260827-233801` and `-233803` are the same position,
 * the same brief and the same seed run twice, and they diverge by **0.091** over 10 edits against
 * 11. That is a floor made entirely of sampling — same everything, no ablation — so a difference
 * near it is not evidence of anything.
 *
 * 0.2 is a little over twice that, and it is thin. It rests on a single pair, which is the same
 * over-reading this file warns about everywhere else, and it is written down here as the weakest
 * part of the design rather than buried in a constant. Re-derive it from a real spread — one cell,
 * both arms, across seeds — and replace this paragraph with the measurement.
 */
export const DECORATION_BELOW = 0.2;

export interface ActionProfile {
  /**
   * Action label -> share of all edits, summing to 1. The label is the op for an `add_node` and the
   * edit kind otherwise, so the vocabulary is the artist's moves rather than the schema's verbs:
   * `add:text`, `add:paint`, `set_arg`, `delete_node`. An `add_node` whose op could not be recovered
   * is `add:?` and is kept rather than dropped, so the shares still describe every edit.
   */
  shares: Record<string, number>;
  /** The raw counts behind `shares`. */
  counts: Record<string, number>;
  edits: number;
  steps: number;
  /** Share of edits the environment refused. A position that forbids things should be refused more. */
  refusedShare: number;
  /** Share of steps reverted after rendering. */
  revertShare: number;
  /** Share of steps that declared themselves a risk move. */
  riskShare: number;
  /** Share of accepted steps that destroyed an existing node. */
  destroyShare: number;
  /** Replan trigger -> count. A steered artist should be interrupted by different things. */
  triggers: Record<string, number>;
}

export interface Twin {
  arm: ActionProfile;
  control: ActionProfile;
  /**
   * Total variation distance between the two `shares`, over the union of their labels: half the sum
   * of absolute differences. 0 when the two arms reached for the same things in the same
   * proportions, 1 when they share no action in common. It is a distance between distributions and
   * says nothing about which arm was better.
   */
  divergence: number;
  /** Per-label contributions to `divergence`, largest first. This is where to look, not the scalar. */
  moved: { label: string; arm: number; control: number; delta: number }[];
  /** Labels the arm used and the control never did, and the reverse. The clearest evidence there is. */
  onlyArm: string[];
  onlyControl: string[];
  verdict: 'steers' | 'decoration' | 'undersampled';
  /** Why `verdict` says what it says, in one sentence, including when it declines to say anything. */
  because: string;
}

function tally<T extends string>(xs: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

/** What one arm reached for. */
export function actionProfile(lines: LogLine[]): ActionProfile {
  const p: Process = processOf(lines);
  const ts = p.transitions;
  const allEdits = ts.flatMap((t) => t.edits);

  const counts = tally(
    allEdits.map((e) => (e.kind === 'add_node' ? `add:${e.op ?? '?'}` : e.kind))
  );
  const edits = allEdits.length;
  // Divide by the count, never by a hardcoded denominator: an arm that made no edits at all has an
  // empty distribution, and an empty distribution is a fact rather than a division by zero.
  const shares: Record<string, number> = {};
  for (const [label, n] of Object.entries(counts)) shares[label] = edits === 0 ? 0 : n / edits;

  const accepted = ts.filter((t) => t.accepted);
  const share = (n: number, d: number) => (d === 0 ? 0 : n / d);
  const triggers = tally(
    ts.flatMap((t) => (t.replanTrigger ? [t.replanTrigger as TriggerName] : []))
  );

  return {
    shares,
    counts,
    edits,
    steps: ts.length,
    refusedShare: share(allEdits.filter((e) => e.refusedBecause !== null).length, edits),
    revertShare: share(ts.filter((t) => !t.accepted).length, ts.length),
    riskShare: share(ts.filter((t) => t.isRiskMove).length, ts.length),
    destroyShare: share(accepted.filter((t) => t.destroyedNodeIds.length > 0).length, accepted.length),
    triggers,
  };
}

/**
 * The acceptance test for a position, run on one pair of trajectories.
 *
 * Argument order is (position arm, control arm) and it is not symmetric in the reporting: `onlyArm`
 * means the position reached for something its twin never did, which is the finding, while
 * `onlyControl` means the position suppressed something, which is the other half of the same claim.
 * The divergence itself is symmetric.
 */
export function twinOf(armLines: LogLine[], controlLines: LogLine[]): Twin {
  const arm = actionProfile(armLines);
  const control = actionProfile(controlLines);

  const labels = [...new Set([...Object.keys(arm.shares), ...Object.keys(control.shares)])];
  const moved = labels
    .map((label) => {
      const a = arm.shares[label] ?? 0;
      const c = control.shares[label] ?? 0;
      return { label, arm: a, control: c, delta: a - c };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const divergence = moved.reduce((s, m) => s + Math.abs(m.delta), 0) / 2;

  const undersampled = arm.edits < MIN_EDITS || control.edits < MIN_EDITS;
  const verdict: Twin['verdict'] = undersampled
    ? 'undersampled'
    : divergence < DECORATION_BELOW
      ? 'decoration'
      : 'steers';

  const because = undersampled
    ? `${arm.edits} edits against ${control.edits}: below ${MIN_EDITS} on one side, so the distance ` +
      'is reporting sampling noise and no verdict is offered'
    : verdict === 'decoration'
      ? `the two arms reached for the same things: total variation ${divergence.toFixed(3)} over ` +
        `${labels.length} action labels, under ${DECORATION_BELOW}. On this pair the position did ` +
        'not change what the artist did, whatever it changed about the score'
      : `total variation ${divergence.toFixed(3)} over ${labels.length} action labels, driven by ` +
        moved
          .slice(0, 3)
          .map((m) => `${m.label} ${m.delta > 0 ? '+' : ''}${(m.delta * 100).toFixed(1)}pp`)
          .join(', ');

  return {
    arm,
    control,
    divergence,
    moved,
    onlyArm: labels.filter((l) => (arm.counts[l] ?? 0) > 0 && (control.counts[l] ?? 0) === 0),
    onlyControl: labels.filter((l) => (control.counts[l] ?? 0) > 0 && (arm.counts[l] ?? 0) === 0),
    verdict,
    because,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** For a terminal. The table first, the scalar last: the scalar is the least informative line. */
export function twinText(t: Twin): string {
  const rows = t.moved.map((m) =>
    [
      `  ${m.label.padEnd(16)}`,
      pct(m.arm).padStart(7),
      pct(m.control).padStart(9),
      `${m.delta > 0 ? '+' : ''}${(m.delta * 100).toFixed(1)}pp`.padStart(9),
    ].join('')
  );

  const rates = (label: string, a: number, c: number) =>
    `  ${label.padEnd(16)}${pct(a).padStart(7)}${pct(c).padStart(9)}`;

  return [
    `  ${'action'.padEnd(16)}${'position'.padStart(7)}${'control'.padStart(9)}${'delta'.padStart(9)}`,
    ...rows,
    '',
    `  ${'rate'.padEnd(16)}${'position'.padStart(7)}${'control'.padStart(9)}`,
    rates('refused', t.arm.refusedShare, t.control.refusedShare),
    rates('reverted', t.arm.revertShare, t.control.revertShare),
    rates('risk move', t.arm.riskShare, t.control.riskShare),
    rates('destroyed', t.arm.destroyShare, t.control.destroyShare),
    '',
    `  replans  position: ${JSON.stringify(t.arm.triggers)}  control: ${JSON.stringify(t.control.triggers)}`,
    t.onlyArm.length ? `  only the position: ${t.onlyArm.join(' ')}` : null,
    t.onlyControl.length ? `  only the control: ${t.onlyControl.join(' ')}` : null,
    '',
    `  ${t.arm.steps} steps / ${t.arm.edits} edits against ${t.control.steps} steps / ${t.control.edits} edits`,
    `  divergence ${t.divergence.toFixed(3)} — ${t.verdict.toUpperCase()}`,
    `  ${t.because}`,
    '',
    '  One pair, one seed. This is a smoke test, not a result: run the pair across seeds and compare',
    '  the spread of these numbers before saying anything about the position.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
