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
import { Canvas, InvalidProgramError, changeSince, check, type Change } from './canvas.js';
import { describe, audience, transcribe, type ReadString } from './env-calls.js';
import { bareEdit, servedNodeIds } from './schemas.js';
import { pruneDeadNodes } from './intention.js';
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
import type { Action, Affect, CheckReport, Intention, Look, Refusal, RefusalCause, Step } from './types.js';

/**
 * Below this share of the canvas moved, a kept step did not change the picture.
 *
 * 0.001 is a thousandth of the sheet — about 1,700 pixels at A3 print size, which is smaller than a
 * single character of body text. It is a floor for noise, not a judgement about how much change is
 * enough: any edit meant to be seen clears it by orders of magnitude, and an edit that does not
 * clear it is a rearrangement of the tree.
 */
export const INERT_THRESHOLD = 0.001;

/**
 * Which of the three causes a refusal was, from the validator's own sentence.
 *
 * Read off the `[code]` the medium already appends to every issue rather than off the prose, so
 * this is a rename of a fact and not a guess about one. Deliberately a pure function of the string:
 * that is what lets `reward.ts` recompute the split from a log written before this existed, instead
 * of trusting a `cause` field that older logs do not carry.
 */
export function refusalCause(reason: string): RefusalCause {
  if (/\[(budget|limit\.[a-zA-Z]+)\]/.test(reason)) return 'budget';
  if (/\[[a-zA-Z]+\.(notAllowed|unknown)\]/.test(reason)) return 'capability';
  return 'structural';
}

/**
 * Refused edits by cause. The zeroes are written out rather than omitted, so a run that refused
 * nothing and a run recorded before causes existed do not read the same in a table.
 */
export function refusalTally(steps: { refused: Refusal[] }[]): Record<RefusalCause, number> {
  const tally: Record<RefusalCause, number> = { budget: 0, capability: 0, structural: 0 };
  for (const s of steps) for (const r of s.refused) tally[r.cause]++;
  return tally;
}

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
 * Node ids that were doing constraint work before the step, read straight off the checker's
 * `nodeIds`. Those are the nodes a satisfied constraint rests on, decided by the checker that knows
 * what each kind means rather than by this file guessing.
 *
 * This used to scan `evidence` for id substrings, which was wrong in both directions: an id that is
 * a prefix of another matched, and a constraint that named no ids matched nothing. `destructionRate`
 * was an estimate because of it and now is not.
 *
 * Still filtered against the tree, because a checker may name a node the position mentions and the
 * program does not have, and a node that is not there was not destroyed by this step.
 */
function loadBearing(program: Program, report: CheckReport): Set<string> {
  const present = nodeIds(program);
  const carrying = new Set<string>();
  for (const r of report.results) {
    if (r.status !== 'satisfied') continue;
    for (const id of r.nodeIds) if (present.has(id)) carrying.add(id);
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
  /**
   * Off for sketches. It no longer costs a second render — the canvas measures the pixels it
   * already has — but a sketch renders under `sketch-v1`, so its ink density is a fact about a
   * sketch and not about the piece, and a render-scope constraint decided against it would be
   * decided wrong.
   */
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
  /**
   * The plate the current look was taken from. Deliberately NOT on `Look`: a Look is written into
   * every Step and out to final.json, and a megabyte of base64 per step would make the trajectory
   * unreadable. Held here so MAKE can attach it without costing a second render — the canvas caches
   * by program hash, so this is the same bytes.
   */
  plate: Buffer | null = null;
  /**
   * What the last accepted step did to the page. Null at reset and after a step that changed
   * nothing. The plate says what is there; this says what the artist just did, which is the other
   * half of looking and the half a single frame cannot carry.
   *
   * Computed only from plates that were kept. A reverted candidate never becomes the baseline, so
   * the diff always answers "what changed since the picture you last saw".
   */
  change: Change | null = null;
  /** The kept plate the next change is measured against. Not the last one rendered. */
  private baseline: Buffer | null = null;
  affect!: Affect;
  /** What this run opened with. Both mechanical knobs read the distance from it, not the level. */
  affect0!: Affect;
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
    return editsPerStep(this.affect, this.affect0);
  }

  /**
   * Establishes the opening look and the opening affect. Renders once: the artist is not allowed to
   * plan against a canvas it has not seen, which is the whole difference between planning from
   * evidence and planning from the brief.
   */
  async reset(intention: Intention, affect: Affect): Promise<Look> {
    this.intention = intention;
    this.affect = affect;
    this.affect0 = affect;
    this.k = 0;
    this.sinceImprovement = 0;
    this.program = this.o.seedProgram;
    this.look = await this.observe(this.program);
    this.baseline = this.plate;
    this.change = null;
    this.best = standing(this.look.checkReport);
    this.o.log.append('phase', { phase: 'reset', programHash: this.programHash, standing: this.best });
    return this.look;
  }

  /** Render, check, describe, and — when asked — hear an audience. One render, at most two calls. */
  private async observe(program: Program): Promise<Look> {
    const rendered = await this.o.canvas.render(program, { metrics: this.o.useMetrics ?? false });
    this.programHash = rendered.programHash;
    this.plate = rendered.png;
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
      look.wouldAct = a.value.wouldAct;
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
      wouldAct: look.wouldAct ?? null,
      // Which constraints held and which did not, by id, in this state. Two lists and not one:
      // `Status` has a third value, so "absent from `violated`" is not "held" — and the observed
      // conflict tier is built on the difference. The counts above are kept because they are what
      // `standing` was computed from; these are the evidence behind them.
      //
      // A log written before this existed has neither field. Every reader must treat that as "this
      // run did not record it" and not as "nothing was violated", which is the same trap absent
      // `pixelsMoved` set: see transition.ts.
      satisfied: report.results.filter((r) => r.status === 'satisfied').map((r) => r.id),
      violated: report.results.filter((r) => r.status === 'violated').map((r) => r.id),
    });
    return look;
  }

  /**
   * Every string a blind reader can get off the current plate.
   *
   * Not part of `observe`: it is only asked when the artist wants to stop, because it exists to
   * answer one question — can the facts the brief requires actually be read — and asking it every
   * step would buy a call per step to be told what the tree already says on all but the last one.
   */
  async readBack(): Promise<ReadString[]> {
    if (!this.plate) return [];
    const t = await transcribe(this.plate);
    this.account(t);
    this.o.log.append('env-call', {
      name: 'transcribe',
      programHash: this.programHash,
      strings: t.value.strings,
      cached: t.cached,
    });
    return t.value.strings;
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
  async step(action: Action, saw: { canvas: boolean; change: boolean }): Promise<StepOutcome> {
    this.k++;
    const before = this.program;
    const beforeReport = this.look.checkReport;

    const { profile } = loadProfileFor(before, this.o.profileId);
    const pack = loadPackFor(before);

    // Edits apply one at a time, each re-validated, so a batch that goes bad half way through is
    // reported at the edit that broke rather than as a failed batch.
    let candidate = before;
    const applied: EditAction[] = [];
    const refused: Refusal[] = [];
    for (const edit of action.edits.slice(0, this.maxEdits)) {
      const result = applyEdit(candidate, bareEdit(edit), profile, pack);
      if (!result.valid) {
        const reason = result.reason ?? 'refused';
        refused.push({ actionId: edit.actionId, kind: edit.kind, cause: refusalCause(reason), reason });
        this.o.log.append('edit-refused', { k: this.k, actionId: edit.actionId, kind: edit.kind, cause: refusalCause(reason), reason });
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
      refused,
      affect: this.affect,
      observationHash: '',
      pixelsMoved: 0,
      // False from the start, not undefined, so that every path out of this method carries a
      // verdict. A step that was refused, reverted or would not render did not improve anything,
      // and leaving it undefined would drop it from `gradientOf`'s denominator — which is the fold
      // that is supposed to notice runs that stop improving.
      improved: false,
      declaration: null,
      sawCanvas: saw.canvas,
      sawChange: saw.change,
    };

    step.appliedActionIds = applied.map((e) => e.actionId);

    // Nothing applied: the step happened, cost a call, and changed nothing.
    if (applied.length === 0) {
      // ...unless it was the last step. An artist that says `finished` and offers no edits has not
      // reverted anything — it has stopped, which is the move this design explicitly asks for. It
      // used to be recorded as `the step offered no edits`, punished with `onRevert` and counted
      // toward the stall, which reads back as a failed terminal step. In an SFT export that is a
      // mislabelled final action: the one place the label has to be right.
      const stopping = action.control === 'finished' || action.control === 'abandon';
      if (!stopping || refused.length > 0) {
        step.revertedBecause = refused.length
          ? `every edit was refused (${refused.map((r) => r.reason).join('; ')})`
          : 'the step offered no edits';
        this.affect = onRevert(this.affect);
        this.sinceImprovement++;
      }
      step.affect = this.affect;
      const fired = stopping ? null : this.checkStall();
      this.o.log.append('step', this.logShape(step, refused, applied));
      return { step, fired, done: stopping };
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

    // `action.risk` and not `${action.think} ${action.risk}`. The schema tells the artist that naming
    // a constraint id in `risk` is how it declares a break; reading `think` as well made every
    // incidental mention a declaration, and the checker table shows it every id on every call.
    const { fired: broke, declaration } = unplannedViolation(beforeReport, after.checkReport, action.risk);
    step.declaration = declaration;
    const brokeHard = broke !== null && after.checkReport.hardViolations > beforeReport.hardViolations;

    if (brokeHard) {
      step.revertedBecause = broke!.detail;
      this.affect = onRevert(this.affect);
      step.affect = this.affect;
      this.sinceImprovement++;
      this.o.log.append('step', this.logShape(step, refused, applied));
      // The look does not move: the canvas is still what it was. `observe` has already pointed
      // `plate` at the rejected candidate, so put it back — an artist shown a plate that was thrown
      // away is looking at a picture that does not exist.
      this.plate = this.baseline;
      return { step, fired: broke, done: false };
    }

    // Kept.
    step.accepted = true;
    step.destroyedNodeIds = destroyed(before, candidate, beforeReport, applied);
    this.program = candidate;
    this.programHash = contentHash(candidate);
    this.look = after;
    this.change = this.baseline && this.plate ? changeSince(this.baseline, this.plate) : null;
    this.baseline = this.plate;
    step.pixelsMoved = this.change?.fraction ?? 0;

    // An improvement has to show. Splitting one text node into two to get under a word limit raises
    // `standing` and moves nothing on the sheet, and the environment used to read that as progress:
    // it reset the stall counter, it lifted the mood, and the artist got the reward for satisfying
    // the checker rather than for changing the picture. Now a step that the page cannot tell
    // happened counts as a step that did not happen. The threshold is a pixel-diff floor, not zero,
    // because a repaint of identical marks can differ in a handful of pixels.
    const now = standing(after.checkReport);
    step.inert = step.pixelsMoved < INERT_THRESHOLD;
    // Stamped here, on the one branch that decides it, so that "when did the reward last move" is
    // readable off the log. It compares against the running best, which no per-step field carries,
    // so a rescorer cannot reconstruct it from anything else. See `gradientOf`.
    step.improved = now > this.best && !step.inert;
    if (step.improved) {
      this.best = now;
      this.sinceImprovement = 0;
      this.affect = onAcceptImproved(this.affect);
    } else {
      // The best standing still moves, so a later step is not credited twice for the same ground.
      // Only the reward for reaching it is withheld.
      if (now > this.best) this.best = now;
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
    const fired = stalled(this.sinceImprovement, stallThreshold(this.affect, this.affect0));
    if (!fired) return null;
    this.affect = onStall(this.affect);
    this.sinceImprovement = 0;
    this.o.log.append('trigger', fired);
    return fired;
  }

  /** An accepted edit that named the element it serves gives that element the node ids it touched. */
  private attachNodes(action: Action, applied: EditAction[]): void {
    for (const edit of applied) {
      const serves = (edit as { servesElementId?: string }).servesElementId;
      if (!serves) continue;
      const element = this.intention.elements.find((e) => e.id === serves);
      const ids = servedNodeIds(edit);
      // A serves that names no element attaches nothing, and used to do so in silence — which made
      // an element look unbuilt for a reason nothing on disk could explain. It is not an error; the
      // edit stands. It is logged so the gap between the plan and the work is countable.
      if (!element) {
        this.o.log.append('note', {
          phase: 'make',
          unattached: { actionId: edit.actionId, serves, nodeIds: ids, elements: this.intention.elements.map((e) => e.id) },
        });
        continue;
      }
      // The other half of the same silence: the element existed, the edit named it, and the edit
      // carried no id this rule could read. That case is logged too, because an element that is
      // worked on and never attached is exactly how `realization` reads 0 on a run that built the
      // picture it planned.
      if (ids.length === 0) {
        this.o.log.append('note', {
          phase: 'make',
          unattached: { actionId: edit.actionId, serves, nodeIds: [], kind: edit.kind },
        });
        continue;
      }
      for (const id of ids) if (!element.nodeIds.includes(id)) element.nodeIds.push(id);
    }
    // Attaching is only half of it. A step that adds nodes to one element and deletes nodes from
    // another leaves the second holding ids for a tree that no longer contains them.
    pruneDeadNodes(this.intention, this.program);
    void action;
  }

  private logShape(step: Step, refused: Refusal[], applied: EditAction[]): unknown {
    return {
      k: step.k,
      control: step.action.control,
      think: step.action.think,
      risk: step.action.risk,
      // Only ever meaningful on a `finished` step. Logged on every one so an offline reader gets it
      // off the step line — the same line that carries `control` — rather than having to join back
      // to the policy call that produced it.
      unrealizable: step.action.unrealizable,
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
      // Environment-side evidence, logged like `refused` and `standing` rather than re-derived: the
      // offline rescore would otherwise have to re-render and re-check every intermediate program
      // to answer what this step broke and what it had said about it.
      declaration: step.declaration,
      // The step's size on the page. Logged so an offline reader can tell a step that rewrote the
      // picture from one that nudged an argument, which the tree diff alone will not say.
      pixelsMoved: step.pixelsMoved,
      // Kept but invisible. Derivable from `pixelsMoved` and `accepted`, and logged anyway so that
      // the threshold this run applied is on the record: change `INERT_THRESHOLD` and an offline
      // rescore of an old log would otherwise silently re-decide steps under the new one.
      inert: step.inert ?? null,
      // Whether the reward moved on this step. Logged rather than derived because it compares
      // against the running best standing, which no other field on this line carries — without it,
      // "how long has this run been flat" is not answerable from the record at all.
      improved: step.improved ?? null,
      // What the act call could see. Logged per step rather than once at the top from the run's
      // flag: the flag is what was asked for, and this is what the payload carried.
      sawCanvas: step.sawCanvas,
      sawChange: step.sawChange,
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
