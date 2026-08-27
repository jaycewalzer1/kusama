// SKETCH: draw each problem badly and quickly, before committing to one.
//
// Three sketches per problem, under `profiles/sketch-v1.profile.json` — every budget at or below
// default-v1 and the print pass removed, so a sketch costs a fraction of a plate and cannot be
// mistaken for a finished piece. The point is not to produce good pictures. It is to make CHOOSE a
// decision about images rather than about descriptions of images.
//
// A sketch is one policy call and one render. It is allowed to fail: a sketch whose edits are all
// refused, or which will not render, is recorded as failed and the contact sheet is simply shorter.
// Failing sketches are informative — a problem that cannot be sketched at all is a fact about the
// problem — so nothing here retries.

import { applyEdit } from '../../env/edits.js';
import { loadPackFor } from '../../env/pack.js';
import { loadProfileFor } from '../../env/profile.js';
import { decodePng, encodePng } from '../../env/png.js';
import { contactSheet } from '../../env/sheet.js';
import { callPolicy, type Spend } from '../call.js';
import { capabilitySheet } from '../capability-sheet.js';
import { bareEdit, SKETCH_SCHEMA } from '../schemas.js';
import { briefSection, positionSection } from '../observation.js';
import type { Canvas } from '../canvas.js';
import type { Commission } from '../field.js';
import type { Policy } from '../policy/interface.js';
import type { StudioLog } from '../studio-log.js';
import type { EditAction, Problem, Program } from '../types.js';

/** The profile every sketch is rendered under. Named here so a trajectory can record which. */
export const SKETCH_PROFILE = 'sketch-v1';

/**
 * The seed, redeclared under the sketch profile. The medium refuses a program that names one profile
 * and is validated against another — correctly, since the declaration is what a reader goes by — so
 * the sketch says what it is rather than being quietly checked against something else.
 */
function sketchSeed(seed: Program): Program {
  return { ...seed, profile: SKETCH_PROFILE };
}

const SYSTEM = [
  'You are an artist making a fast, rough sketch to find out what a problem looks like.',
  '',
  'This is not the piece. It is a question drawn on paper. Test one idea about composition, weight or',
  'contrast, and test it clearly enough that the sketch could turn out to be wrong — a sketch that',
  'proves an approach does not work has done its job.',
  '',
  'You are working under reduced budgets: fewer nodes, fewer text ops, no print pass. Do not attempt',
  'a finished plate.',
].join('\n');

export interface SketchResult {
  problemId: string;
  index: number;
  approach: string;
  program: Program | null;
  programHash: string;
  png: Buffer | null;
  failure: string | null;
}

function observation(commission: Commission, problem: Problem, capabilitySheet: string, index: number, seed: Program): string {
  return [
    `THE MEDIUM (sketch budgets: profile ${SKETCH_PROFILE})\n${capabilitySheet}`,
    positionSection(commission.position),
    briefSection(commission.brief),
    `THE PROBLEM YOU ARE SKETCHING\n[${problem.id}] ${problem.text}\ntension: ${problem.tension.between} vs ${problem.tension.and}: ${problem.tension.claim}`,
    `THE SHEET YOU ARE STARTING FROM\n${JSON.stringify(seed, null, 2)}`,
    `This is sketch ${index + 1} of 3 for this problem. Make it different from a sketch you would draw\nfor the same problem twice. One idea, drawn clearly enough to be refuted.`,
  ].join(`\n${'-'.repeat(88)}\n`);
}

export async function sketch(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  problem: Problem,
  index: number,
  seed: Program,
  canvas: Canvas
): Promise<SketchResult> {
  const base: SketchResult = {
    problemId: problem.id,
    index,
    approach: '',
    program: null,
    programHash: '',
    png: null,
    failure: null,
  };

  const start = sketchSeed(seed);
  const { profile } = loadProfileFor(start);
  const pack = loadPackFor(start);

  // The sheet is built from the sketch profile, not the finished one. It has to be: sketch-v1 allows
  // 4 text ops where default-v1 allows 12, and an artist handed the finished budgets writes a fifth
  // text op and has it refused for a rule it was never shown.
  const result = await callPolicy<{ approach: string; edits: (EditAction & { servesElementId?: string })[] }>(policy, log, spend, {
    name: 'sketch',
    system: SYSTEM,
    observation: observation(commission, problem, capabilitySheet(profile, pack), index, start),
    schema: SKETCH_SCHEMA,
    maxTokens: 8000,
  });
  base.approach = result.action.approach;

  let program = start;
  let applied = 0;
  for (const edit of result.action.edits) {
    const r = applyEdit(program, bareEdit(edit), profile, pack);
    if (!r.valid) {
      log.append('edit-refused', { phase: 'sketch', problemId: problem.id, index, actionId: edit.actionId, reason: r.reason });
      continue;
    }
    program = r.nextProgram;
    applied++;
  }
  if (applied === 0) {
    base.failure = 'every edit was refused';
    log.append('note', { phase: 'sketch', problemId: problem.id, index, failure: base.failure });
    return base;
  }

  try {
    const rendered = await canvas.render(program);
    base.program = program;
    base.programHash = rendered.programHash;
    base.png = rendered.png;
  } catch (e) {
    base.failure = e instanceof Error ? e.message : String(e);
    log.append('note', { phase: 'sketch', problemId: problem.id, index, failure: base.failure });
  }
  return base;
}

/** All the sketches that produced a picture, on one sheet, in the order CHOOSE will read them. */
export function sheetOf(sketches: SketchResult[]): Buffer | null {
  const images = sketches.filter((s) => s.png).map((s) => decodePng(s.png!));
  if (images.length === 0) return null;
  const sheet = contactSheet(images, {
    cols: Math.min(3, images.length),
    cell: 360,
    gap: 12,
    background: [0x20, 0x20, 0x20],
  });
  return encodePng(sheet.rgba, sheet.width, sheet.height);
}

/** The caption the contact sheet needs to be readable: which cell is which problem. */
export function sheetNotes(sketches: SketchResult[]): string[] {
  const drawn = sketches.filter((s) => s.png);
  const notes = drawn.map((s, cell) => `cell ${cell + 1} (reading left to right, top to bottom): problem ${s.problemId} — ${s.approach}`);
  const failed = sketches.filter((s) => !s.png);
  for (const f of failed) notes.push(`not drawn: problem ${f.problemId} sketch ${f.index + 1} — ${f.failure}`);
  return notes;
}
