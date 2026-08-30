// One record per step, folded out of the log.
//
// The loop already writes down everything a step did. It writes it down in five places: the ACT
// policy call has the edits, the `render` line has the pixels, the `step` line has which edits
// landed and what it cost, the `phase: replan` line has why the plan moved, and the next `render`
// line has where the picture ended up. Nothing on disk puts a step's before, its action, its after
// and its price on one line, so every question about *this edit caused that change* is currently a
// join somebody performs by hand.
//
// A Transition is that join, done once. `(before, action, after)` with the pixel hashes attached is
// the shape a training loop wants, the shape an attribution question wants, and the shape a person
// scrubbing a trajectory wants, and they are the same shape — so it is one artifact rather than
// three.
//
// Pure, like story.ts and for the same reason: it computes nothing the run did not write down and
// reads no files. So this runs on a finished directory, on a live tail, and on any trajectory
// collected before this file existed. Nothing here re-decides anything; where the run made a
// choice, the log is authoritative.
//
// Not in here, deliberately: the leave-one-out ablation. Attribution by *removing* step k and
// re-rendering costs N renders per step, and the cheap version of the same question — how much of
// what step k laid down survived to the end — is a fact about pixels the filmstrip already has to
// produce. See filmstrip.ts. A mask set stored here would be a promise this file cannot keep.

import type { LogLine } from './studio-log.js';
import type { Affect, TriggerName } from './types.js';

/** The canvas at one moment: which program, which pixels, and how it stood against the position. */
export interface State {
  programHash: string;
  pixelHash: string;
  standing: number;
  hardViolations: number;
  softViolations: number;
  treeScore: number | null;
  renderScore: number | null;
}

export interface TransitionEdit {
  actionId: string;
  kind: string;
  targets?: unknown;
  /** The node id this edit put in the tree, when it added one and it landed. */
  nodeId: string | null;
  /**
   * The primitive an `add_node` proposed — `text`, `paint`, `rule`, a macro name. Null on every
   * other kind, and null on an `add_node` whose act call is not among the lines being folded.
   *
   * Read off the proposal rather than off the tree, and recorded even when the edit was refused: the
   * question it answers is what the artist reached for, which a refusal does not erase. `kind` alone
   * cannot answer it — nearly every edit is an `add_node`, so a histogram over `kind` is close to
   * constant and would report two very different artists as identical.
   */
  op: string | null;
  applied: boolean;
  refusedBecause: string | null;
}

export interface Transition {
  k: number;
  before: State;
  /**
   * The state after the step. Identical to `before` on any step that was not kept — a reverted step
   * is a transition to the same place, which is the honest `(s, a, s')` for a move the environment
   * refused, and never a gap in the sequence.
   */
  after: State;
  /**
   * What the rejected candidate would have looked like, or null. Only ever set on a step that was
   * not kept: it is the road not taken, and it is the only place the counterfactual is recorded.
   */
  candidate: State | null;
  edits: TransitionEdit[];
  /** Node ids this step put in the tree, in edit order. */
  born: string[];
  destroyedNodeIds: string[];
  /** Share of the canvas the step moved. 0 on a step that was not kept. */
  pixelsMoved: number;
  accepted: boolean;
  revertedBecause: string | null;
  isRiskMove: boolean;
  /** What made the plan change after this step, or null if it did not. */
  replanTrigger: TriggerName | null;
  /** studio.jsonl line numbers. The full observation and the raw response are on these lines. */
  calls: { act: number | null; replan: number | null };
  affect: Affect;
}

export interface Process {
  transitions: Transition[];
  /**
   * Node id -> the step that first put it in the tree. Nodes absent from this map were in the seed,
   * which in this medium is `root` and an empty `sheet` and nothing else.
   */
  birth: Record<string, number>;
}

interface RenderLine {
  programHash: string;
  pixelHash: string;
  standing: number;
  hardViolations: number;
  softViolations: number;
  treeScore: number | null;
  renderScore: number | null;
}

interface StepLine {
  k: number;
  edits: { actionId: string; kind: string; targets?: unknown }[];
  refused: { actionId: string; reason: string }[];
  applied: string[];
  accepted: boolean;
  revertedBecause: string | null;
  isRiskMove: boolean;
  destroyedNodeIds: string[];
  pixelsMoved?: number;
  affect: Affect;
  programHash: string;
}

function stateOf(r: RenderLine): State {
  return {
    programHash: r.programHash,
    pixelHash: r.pixelHash,
    standing: r.standing,
    hardViolations: r.hardViolations,
    softViolations: r.softViolations,
    treeScore: r.treeScore ?? null,
    renderScore: r.renderScore ?? null,
  };
}

const NOWHERE: State = {
  programHash: '',
  pixelHash: '',
  standing: 0,
  hardViolations: 0,
  softViolations: 0,
  treeScore: null,
  renderScore: null,
};

/**
 * Folds a log into one record per step.
 *
 * The sequence the environment writes is fixed and this depends on all of it: `reset` renders the
 * seed, then each step is an `act` call, then zero or one `render` for the candidate, then the
 * `step` line, then — if the plan moved — a `phase: replan` and a `replan` call. A step whose every
 * edit was refused renders nothing, which is why the candidate is nullable rather than assumed.
 */
export function processOf(lines: LogLine[]): Process {
  const transitions: Transition[] = [];
  const birth: Record<string, number> = {};

  let current: State | null = null;
  let candidate: State | null = null;
  let actSeq: number | null = null;
  let actEdits: { actionId: string; node?: { id?: string; op?: string } }[] = [];
  let pendingTrigger: TriggerName | null = null;

  for (const line of lines) {
    if (line.kind === 'render') {
      const state = stateOf(line.data as RenderLine);
      // The first render is the seed's: reset() observes before it logs `phase: reset`. Every later
      // one is a candidate until a `step` line says whether it was kept.
      if (current === null) current = state;
      else candidate = state;
      continue;
    }

    if (line.kind === 'policy-call') {
      const call = line.data as {
        name: string;
        ok?: boolean;
        action?: { edits?: { actionId: string; node?: { id?: string; op?: string } }[] };
      };
      if (call.ok === false) continue;
      if (call.name === 'act') {
        actSeq = line.seq;
        actEdits = call.action?.edits ?? [];
      }
      if (call.name === 'replan' && transitions.length > 0) {
        const last = transitions[transitions.length - 1]!;
        last.calls.replan = line.seq;
        last.replanTrigger = pendingTrigger;
        pendingTrigger = null;
      }
      continue;
    }

    if (line.kind === 'phase') {
      const phase = line.data as { phase: string; trigger?: TriggerName };
      if (phase.phase === 'replan') pendingTrigger = phase.trigger ?? null;
      continue;
    }

    if (line.kind !== 'step') continue;
    const step = line.data as StepLine;
    const before: State = current ?? NOWHERE;
    const proposed = (actionId: string) => actEdits.find((e) => e.actionId === actionId)?.node;

    const edits: TransitionEdit[] = step.edits.map((e) => {
      const applied = step.applied.includes(e.actionId);
      const node = e.kind === 'add_node' ? proposed(e.actionId) : undefined;
      return {
        actionId: e.actionId,
        kind: e.kind,
        ...(e.targets === undefined ? {} : { targets: e.targets }),
        nodeId: applied && e.kind === 'add_node' ? node?.id ?? null : null,
        op: node?.op ?? null,
        applied,
        refusedBecause: step.refused.find((r) => r.actionId === e.actionId)?.reason ?? null,
      };
    });

    const born = step.accepted ? edits.flatMap((e) => (e.nodeId ? [e.nodeId] : [])) : [];
    for (const id of born) birth[id] ??= step.k;

    const after: State = step.accepted && candidate ? candidate : before;
    transitions.push({
      k: step.k,
      before,
      after,
      candidate: step.accepted ? null : candidate,
      edits,
      born,
      destroyedNodeIds: step.destroyedNodeIds,
      pixelsMoved: step.pixelsMoved ?? 0,
      accepted: step.accepted,
      revertedBecause: step.revertedBecause ?? null,
      isRiskMove: step.isRiskMove,
      replanTrigger: null,
      calls: { act: actSeq, replan: null },
      affect: step.affect,
    });

    current = after;
    candidate = null;
    actSeq = null;
    actEdits = [];
  }

  return { transitions, birth };
}

/** One line per transition, for a terminal. Wide on purpose: the point is that it is one line. */
export function processText(p: Process): string {
  const rows = p.transitions.map((t) => {
    const verdict = t.accepted ? 'kept' : `revert (${t.revertedBecause ?? 'unstated'})`;
    const moved = `${(t.pixelsMoved * 100).toFixed(2)}%`;
    const landed = t.edits.filter((e) => e.applied).length;
    return [
      `k${String(t.k).padStart(2)}`,
      `${t.before.pixelHash.slice(0, 8)} -> ${t.after.pixelHash.slice(0, 8)}`,
      `${landed}/${t.edits.length} edits`,
      `${moved} moved`,
      `standing ${t.before.standing.toFixed(2)} -> ${t.after.standing.toFixed(2)}`,
      t.born.length ? `+${t.born.join(' +')}` : '',
      t.destroyedNodeIds.length ? `-${t.destroyedNodeIds.join(' -')}` : '',
      verdict,
      t.replanTrigger ? `replan: ${t.replanTrigger}` : '',
    ]
      .filter(Boolean)
      .join('  ');
  });
  return rows.join('\n');
}
