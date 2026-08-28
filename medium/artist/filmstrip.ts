// The piece rebuilt one step at a time, and the one number that comes off it.
//
// The animation is not the point. The point is the pixel survival curve: of the ink laid down at
// step k, how much of it is still visible in the finished piece. For a human oil painter most of
// step one is gone by the end — the block-in is under the picture, not in it — and the curve
// climbs. For an artist that only ever adds, every step survives whole and the curve is flat at
// 1.0. That makes "does this loop revise like a painter or accumulate like a printer" a number
// somebody can plot against a timelapse, rather than a thing to have an opinion about.
//
// Frames are built by replaying the edits the log says landed, not by pruning the final tree back to
// the nodes that existed at step k. Pruning was the first version and it was wrong in a way that
// only showed on real data: an edit that re-argues an existing node shows at every frame from that
// node's birth, because a pruned tree carries the final arguments. On the first sighted run that put
// all of steps 3-5's pixels on step 1 and reported four steps that "moved nothing".
//
// The replay is a second copy of the one in reward.ts, deliberately — the same reason `attach` is
// duplicated there. If this drifts from that one, the last frame stops hashing to the trajectory's
// finalHash and `filmstrip` throws, which is the alarm that should ring.
//
// N frames is N serial renders (NOTES R8 — never concurrent). The canvas caches by program hash, so
// a second run of this over the same trajectory is free, and every frame that is also a step's
// accepted program was already rendered by the run itself.

import { readFileSync } from 'node:fs';
import { applyEdit, type EditAction } from '../env/edits.js';
import { loadPackFor } from '../env/pack.js';
import { decodePng } from '../env/png.js';
import { loadProfileFor } from '../env/profile.js';
import type { Canvas } from './canvas.js';
import { bareEdit } from './schemas.js';
import { seedProgram } from './seed.js';
import type { LogLine } from './studio-log.js';
import type { Program } from './types.js';

/**
 * The program as it stood after each step, starting with the seed.
 *
 * A step that was reverted contributes a frame identical to the one before it: the artist spent a
 * step and the sheet did not change, which is a true thing about the process and should be visible
 * in the strip rather than skipped.
 */
export function programsOf(lines: LogLine[]): Program[] {
  const start = lines.find((l) => l.kind === 'trajectory-start')?.data as { seed: number } | undefined;
  if (!start) throw new Error('filmstrip: the log has no trajectory-start, so there is no seed to build from');

  let program: Program = seedProgram(start.seed);
  const { profile } = loadProfileFor(program);
  const pack = loadPackFor(program);
  const programs: Program[] = [program];
  let pending: (EditAction & { servesElementId?: string })[] = [];

  for (const line of lines) {
    if (line.kind === 'policy-call') {
      const call = line.data as {
        name: string;
        ok?: boolean;
        action?: { edits?: (EditAction & { servesElementId?: string })[] };
      };
      if (call.ok !== false && call.name === 'act') pending = call.action?.edits ?? [];
      continue;
    }
    if (line.kind !== 'step') continue;
    const step = line.data as { k: number; applied: string[]; accepted: boolean };

    let candidate = program;
    for (const id of step.applied) {
      const edit = pending.find((e) => e.actionId === id);
      if (!edit) throw new Error(`filmstrip: step ${step.k} says ${id} landed, but no act call offered it`);
      const r = applyEdit(candidate, bareEdit(edit), profile, pack);
      if (!r.valid) {
        throw new Error(`filmstrip: step ${step.k} edit ${id} was accepted at run time and is refused now: ${r.reason}`);
      }
      candidate = r.nextProgram;
    }
    if (step.accepted) program = candidate;
    programs.push(program);
    pending = [];
  }
  return programs;
}

export interface SurvivalRow {
  k: number;
  /** Pixels this step changed, as a share of the canvas. Its footprint. */
  laidDown: number;
  /** How many of those pixels the finished piece still shows unchanged. */
  survived: number;
  /** survived / laidDown. Null when the step moved no pixels: nothing was laid, so nothing died. */
  survival: number | null;
}

/**
 * The curve. `frames[i]` is the canvas after step `i`, and the last frame is the finished piece, so
 * this needs no separate final render and cannot compare against a differently-rendered one.
 *
 * A pixel counts as surviving if the finished piece shows the same colour as the frame that laid
 * it. That is deliberately strict: a mark half-covered by a later wash has partly died, and it
 * reads here as partly dead rather than as intact because its node is still in the tree. Occlusion
 * is the thing this measures and the tree is exactly where occlusion is invisible.
 */
export function survivalOf(frames: Buffer[], width: number, height: number): SurvivalRow[] {
  const final = frames[frames.length - 1]!;
  const rows: SurvivalRow[] = [];
  const total = width * height;
  for (let k = 1; k < frames.length; k++) {
    const before = frames[k - 1]!;
    const after = frames[k]!;
    let laid = 0;
    let survived = 0;
    for (let p = 0; p < total; p++) {
      const i = 4 * p;
      if (before[i] === after[i] && before[i + 1] === after[i + 1] && before[i + 2] === after[i + 2]) continue;
      laid++;
      if (final[i] === after[i] && final[i + 1] === after[i + 1] && final[i + 2] === after[i + 2]) survived++;
    }
    rows.push({
      k,
      laidDown: Math.round((laid / total) * 1e4) / 1e4,
      survived: Math.round((survived / total) * 1e4) / 1e4,
      survival: laid === 0 ? null : Math.round((survived / laid) * 1e4) / 1e4,
    });
  }
  return rows;
}

export interface Filmstrip {
  frames: { k: number; programHash: string; pixelHash: string; png: Buffer }[];
  survival: SurvivalRow[];
  /**
   * Share of the finished canvas that was laid down and never touched again, over every step that
   * laid anything. 1.0 means nothing in this piece was painted over: the artist added and added and
   * never revised occlusively. It is the headline of the curve and the number to compare across
   * runs.
   */
  meanSurvival: number | null;
}

/**
 * Every frame, rendered serially, plus the curve.
 *
 * `finalHash` is the trajectory's own, and passing it turns this into a check on the replay: if the
 * last frame is not the piece the run finished with, the curve is measuring some other picture and
 * saying so is worth more than a number.
 */
export async function filmstrip(lines: LogLine[], canvas: Canvas, finalHash?: string): Promise<Filmstrip> {
  const programs = programsOf(lines);
  const frames: Filmstrip['frames'] = [];
  const rgba: Buffer[] = [];
  let width = 0;
  let height = 0;

  for (const [k, program] of programs.entries()) {
    const rendered = await canvas.render(program);
    frames.push({ k, programHash: rendered.programHash, pixelHash: rendered.pixelHash, png: rendered.png });
    const decoded = decodePng(rendered.png);
    rgba.push(decoded.rgba);
    width = decoded.width;
    height = decoded.height;
  }

  const last = frames[frames.length - 1]!;
  if (finalHash && last.programHash !== finalHash) {
    throw new Error(
      `filmstrip: the last frame is ${last.programHash} but the trajectory finished at ${finalHash}. ` +
        'The replay has drifted from the run, so these frames are not this piece.'
    );
  }

  const survival = survivalOf(rgba, width, height);
  const laid = survival.filter((r) => r.survival !== null);
  const totalLaid = laid.reduce((n, r) => n + r.laidDown, 0);
  return {
    frames,
    survival,
    // Weighted by footprint, not a mean of ratios: a step that moved four pixels and lost them all
    // should not count as much as the block-in.
    meanSurvival:
      totalLaid === 0 ? null : Math.round((laid.reduce((n, r) => n + r.survived, 0) / totalLaid) * 1e4) / 1e4,
  };
}

/** The hash a finished trajectory ended on. Undefined for a run that abandoned or is still going. */
export function finalHashOf(dir: string): string | undefined {
  const final = JSON.parse(readFileSync(`${dir}/final.json`, 'utf8')) as { finalHash?: string };
  return final.finalHash;
}
