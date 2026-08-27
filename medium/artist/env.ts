// The environment, as reset/step.
//
// Everything that is not the artist lives behind this class: the medium, the checker, the renderer,
// the blind describer, the audience, the triggers, and the affect arithmetic. `run.ts` is a driver
// over it and holds no state of its own. That split is what makes the loop trainable later — a
// policy that replaced the model calls in run.ts would face exactly this interface and exactly these
// signals, with nothing hidden in the driver.
//
// Two things this class will not do, both of which would be convenient and both of which would
// quietly destroy the experiment:
//   - it never renders two programs at once (NOTES R8), so there is no batch method to reach for;
//   - it never lets an unvalidated program reach the browser, so an over-budget edit costs
//     microseconds and is reported as a refusal, not as a crash.

import { applyEdit, type EditAction, type Program } from '../env/edits.js';
import { loadPackFor } from '../env/pack.js';
import { contentHash, loadProfileFor } from '../env/profile.js';
import { editsPerStep, onAcceptImproved, onRevert, onStall, stallThreshold } from './affect.js';
import { Canvas, InvalidProgramError, check } from './canvas.js';
import { describe, audience } from './env-calls.js';
import { bareEdit } from './schemas.js';
import { treeFacts } from '../aesthetic/facts.js';
import {
  descriptionDisagrees,
  audienceDisagrees,
  stalled,
  unplannedViolation,
  type Fired,
} from './triggers.js';
import type { StudioLog } from './studio-log.js';
import type { Commission } from './field.js';
import type { Action, Affect, CheckReport, Intention, Look, Step } from './types.js';

/**
 * How well the piece stands against its own position, as one number so "better" and "worse" are
 * decidable. Hard violations dominate everything, because a position's hard constraints are the part
 * it is not willing to trade; soft violations cost one each; the tree score breaks ties.
 *
 * Never shown to the artist. It exists so `stall` and "improved" mean something.
 */
export function standing(report: CheckReport): number {
  return -10 * report.hardViolations - report.softViolations + (report.treeScore ?? 0);
}

/** Every node id in a tree. */
function nodeIds(program: Program): Set<string> {
  const ids = new Set<string>();
  const walk = (n: unknown) => {
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    if (typeof node['id'] === 'string') ids.add(node['id']);
    if (Array.isArray(node['children'])) for (const c of node['children']) walk(c);
  };
  walk(program['root']);
  return ids;
}

/**
 * Node ids that were doing constraint work before the step. The aesthetic layer reports evidence as
 * free text, so an id counts as load-bearing when it appears in the evidence of a satisfied
 * constraint. Matching text is crude, but the alternative is changing the aesthetic layer to emit
 * structured node ids, which the brief forbids; the limit is recorded in docs/artist/NEEDS.md.
 */
function loadBearing(program: Program, report: CheckReport): Set<string> {
  const ids = nodeIds(program);
  const carrying = new Set<string>();
  for (const r of report.results) {
    if (r.status !== 'satisfied') continue;
    for (const id of ids) if (r.evidence.includes(id)) carrying.add(id);
  }
  return carrying;
}

/**
 * What this step destroyed: nodes that were holding a satisfied constraint and are no longer in the
 * tree. Covering is counted separately and approximately — a `cover` op added this step is recorded
 * as a destructive act without working out what it landed on, because nothing in this medium knows
 * occlusion. Destruction is never penalised anywhere; it is counted because a position that can only
 * add is not making choices.
 */
function destroyed(before: Program, after: Program, report: CheckReport, edits: EditAction[]): string[] {
  const gone = [...loadBearing(before, report)].filter((id) => !nodeIds(after).has(id));
  const covers = edits
    .filter((e) => e.kind === 'add_node' && (e.node as { op?: string } | undefined)?.op === 'cover')
    .map((e) => `cover:${(e.node as { id?: string }).id ?? e.actionId}`);
  return [...gone, ...covers];
}

export interface EnvOptions {
  commission: Commission;
  canvas: Canvas;
  log: StudioLog;
  seedProgram: Program;
  /** Off for sketches: an audience read costs a call and a sketch is not for an audience. */
  useAudience?: boolean;
  /** Off for sketches, where render-scope constraints are not worth a second render. */
  useMetrics?: boolean;
  profileId?: string;
}

export interface StepOutcome {
  step: Step;
  fired: Fired | null;
  /** The environment is finished with this episode: the artist said so, or the budget ran out. */
  done: boolean;
}

export class ArtistEnv {
  program: Program;
  programHash = '';
  look!: Look;
  affect!: Affect;
  intention!: Intention;
  k = 0;
  private sinceImprovement = 0;
  private best = -Infinity;

  /** Accumulated cost of everything the environment did. Policy spend is the driver's to count. */
  envUsd = 0;
  envCalls = 0;
  cachedEnvCalls = 0;

  constructor(private readonly o: EnvOptions) {
    this.program = o.seedProgram;
  }

  get maxEdits(): number {
    return editsPerStep(this.affect);
  }

  /**
   * Establishes the opening look and the opening affect. Renders once: the artist is not allowed to
   * plan against a canvas it has not seen, which is the whole difference between planning from
   * evidence and planning from the brief.
   */
  async reset(intention: Intention, affect: Affect): Promise<Look> {
    this.intention = intention;
    this.affect = affect;
    this.k = 0;
    this.sinceImprovement = 0;
    this.program = this.o.seedProgram;
    this.look = await this.observe(this.program);
    this.best = standing(this.look.checkReport);
    this.o.log.append('phase', { phase: 'reset', programHash: this.programHash, standing: this.best });
    return this.look;
  }

  /** Render, check, describe, and — when asked — hear an audience. One render, at most two calls. */
  private async observe(program: Program): Promise<Look> {
    const rendered = await this.o.canvas.render(program, { metrics: this.o.useMetrics ?? false });
    this.programHash = rendered.programHash;
    const report = check(program, this.o.commission.effective, rendered.metrics);

    const d = await describe(rendered.png);
    this.account(d);
    const look: Look = {
      renderHash: rendered.pixelHash,
      checkReport: report,
      description: d.value.description,
    };

    if (this.o.useAudience) {
      const a = await audience(rendered.png, this.o.commission.field.whoIsWatching.audience);
      this.account(a);
      look.audienceRead = a.value.read;
    }

    this.o.log.append('render', {
      programHash: rendered.programHash,
      pixelHash: rendered.pixelHash,
      standing: standing(report),
      hardViolations: report.hardViolations,
      softViolations: report.softViolations,
      treeScore: report.treeScore,
      renderScore: report.renderScore,
      description: look.description,
      audienceRead: look.audienceRead ?? null,
    });
    return look;
  }

  private account(r: { usd: number; cached: boolean }): void {
    this.envUsd += r.usd;
    this.envCalls++;
    if (r.cached) this.cachedEnvCalls++;
  }

  /**
   * One step. Applies the edits to a copy, looks at what came out, and keeps it or throws it away.
   *
   * The revert rule is narrow on purpose: a candidate is thrown away only when it breaks a hard
   * constraint that was holding and the artist did not say it was going to. Everything else is kept,
   * including candidates that score worse. An artist that can only move uphill cannot make the move
   * where a piece gets worse before it gets better, and that move is most of what making is.
   */
  async step(action: Action): Promise<StepOutcome> {
    this.k++;
    const before = this.program;
    const beforeReport = this.look.checkReport;

    const { profile } = loadProfileFor(before, this.o.profileId);
    const pack = loadPackFor(before);

    // Edits apply one at a time, each re-validated, so a batch that goes bad half way through is
    // reported at the edit that broke rather than as a failed batch.
    let candidate = before;
    const applied: EditAction[] = [];
    const refused: { actionId: string; reason: string }[] = [];
    for (const edit of action.edits.slice(0, this.maxEdits)) {
      const result = applyEdit(candidate, bareEdit(edit), profile, pack);
      if (!result.valid) {
        refused.push({ actionId: edit.actionId, reason: result.reason ?? 'refused' });
        this.o.log.append('edit-refused', { k: this.k, actionId: edit.actionId, kind: edit.kind, reason: result.reason });
        continue;
      }
      candidate = result.nextProgram;
      applied.push(edit);
    }

    const step: Step = {
      k: this.k,
      look: this.look,
      action,
      replan: null,
      accepted: false,
      isRiskMove: action.risk !== null,
      destroyedNodeIds: [],
      appliedActionIds: [],
      affect: this.affect,
      observationHash: '',
    };

    step.appliedActionIds = applied.map((e) => e.actionId);

    // Nothing applied: the step happened, cost a call, and changed nothing.
    if (applied.length === 0) {
      step.revertedBecause = refused.length
        ? `every edit was refused (${refused.map((r) => r.reason).join('; ')})`
        : 'the step offered no edits';
      this.affect = onRevert(this.affect);
      step.affect = this.affect;
      this.sinceImprovement++;
      const fired = this.checkStall();
      this.o.log.append('step', this.logShape(step, refused, applied));
      return { step, fired, done: action.control === 'abandon' || action.control === 'finished' };
    }

    let after: Look;
    try {
      after = await this.observe(candidate);
    } catch (e) {
      // A candidate that validates edit-by-edit but will not render is a refusal, not a crash.
      if (!(e instanceof InvalidProgramError)) throw e;
      step.revertedBecause = `the result would not render: ${e.message}`;
      this.affect = onRevert(this.affect);
      step.affect = this.affect;
      this.sinceImprovement++;
      this.o.log.append('step', this.logShape(step, refused, applied));
      return { step, fired: this.checkStall(), done: false };
    }

    const broke = unplannedViolation(beforeReport, after.checkReport, `${action.think} ${action.risk ?? ''}`);
    const brokeHard = broke !== null && after.checkReport.hardViolations > beforeReport.hardViolations;

    if (brokeHard) {
      step.revertedBecause = broke!.detail;
      this.affect = onRevert(this.affect);
      step.affect = this.affect;
      this.sinceImprovement++;
      this.o.log.append('step', this.logShape(step, refused, applied));
      // The look does not move: the canvas is still what it was.
      return { step, fired: broke, done: false };
    }

    // Kept.
    step.accepted = true;
    step.destroyedNodeIds = destroyed(before, candidate, beforeReport, applied);
    this.program = candidate;
    this.programHash = contentHash(candidate);
    this.look = after;

    const now = standing(after.checkReport);
    if (now > this.best) {
      this.best = now;
      this.sinceImprovement = 0;
      this.affect = onAcceptImproved(this.affect);
    } else {
      this.sinceImprovement++;
    }
    step.affect = this.affect;

    // Element node ids are learned here, not declared: an edit that says which element it serves
    // attaches its new nodes to that element, so `realization` can later ask whether it exists.
    this.attachNodes(action, applied);

    this.o.log.append('step', this.logShape(step, refused, applied));

    const fired = await this.fire(broke, after);
    return { step, fired, done: action.control === 'finished' || action.control === 'abandon' };
  }

  /** Which trigger, if any. Checked in order of cost: free ones first, model calls only if needed. */
  private async fire(broke: Fired | null, after: Look): Promise<Fired | null> {
    if (broke) return broke;
    const stall = this.checkStall();
    if (stall) return stall;

    const d = await descriptionDisagrees(this.intention, after.description, this.affect);
    if (d) {
      this.envUsd += d.usd;
      this.envCalls++;
      if (d.cached) this.cachedEnvCalls++;
      this.o.log.append('trigger', d);
      return d;
    }
    if (after.audienceRead) {
      const a = await audienceDisagrees(this.intention, after.audienceRead, this.affect);
      if (a) {
        this.envUsd += a.usd;
        this.envCalls++;
        if (a.cached) this.cachedEnvCalls++;
        this.o.log.append('trigger', a);
        return a;
      }
    }
    return null;
  }

  private checkStall(): Fired | null {
    const fired = stalled(this.sinceImprovement, stallThreshold(this.affect));
    if (!fired) return null;
    this.affect = onStall(this.affect);
    this.sinceImprovement = 0;
    this.o.log.append('trigger', fired);
    return fired;
  }

  /** An accepted `add_node` that named the element it serves gives that element its node id. */
  private attachNodes(action: Action, applied: EditAction[]): void {
    for (const edit of applied) {
      const serves = (edit as { servesElementId?: string }).servesElementId;
      if (!serves) continue;
      const element = this.intention.elements.find((e) => e.id === serves);
      const id = (edit.node as { id?: string } | undefined)?.id;
      // A serves that names no element attaches nothing, and used to do so in silence — which made
      // an element look unbuilt for a reason nothing on disk could explain. It is not an error; the
      // edit stands. It is logged so the gap between the plan and the work is countable.
      if (!element) {
        this.o.log.append('note', {
          phase: 'make',
          unattached: { actionId: edit.actionId, serves, nodeId: id ?? null, elements: this.intention.elements.map((e) => e.id) },
        });
        continue;
      }
      if (id && !element.nodeIds.includes(id)) element.nodeIds.push(id);
    }
    void action;
  }

  private logShape(step: Step, refused: { actionId: string; reason: string }[], applied: EditAction[]): unknown {
    return {
      k: step.k,
      control: step.action.control,
      think: step.action.think,
      risk: step.action.risk,
      edits: step.action.edits.map((e) => ({ actionId: e.actionId, kind: e.kind, targets: e.targets })),
      refused,
      // The actionIds that actually landed, in order. reward.ts rebuilds the program from these plus
      // the full edits on the matching policy-call line, so a rescore never has to re-derive which
      // edits the affect budget allowed through.
      applied: applied.map((e) => e.actionId),
      maxEdits: this.maxEdits,
      accepted: step.accepted,
      revertedBecause: step.revertedBecause ?? null,
      isRiskMove: step.isRiskMove,
      destroyedNodeIds: step.destroyedNodeIds,
      affect: step.affect,
      programHash: this.programHash,
      standing: standing(this.look.checkReport),
    };
  }

  /** Text ops present, used by the sketch phase to report what a sketch actually said. */
  texts(): string[] {
    return treeFacts(this.program).texts.map((t) => t.text);
  }
}
