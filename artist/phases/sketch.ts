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

import { treeFacts } from '../../aesthetic/facts.js';
import { applyEdit } from '../../env/edits.js';
import { loadPackFor } from '../../env/pack.js';
import { loadProfileFor } from '../../env/profile.js';
import { decodePng, encodePng } from '../../env/png.js';
import { contactSheet } from '../../env/sheet.js';
import { callPolicy, type Spend } from '../call.js';
import { capabilitySheet } from '../capability-sheet.js';
import { distribution, rng, sampleIndices, streamSeed, tookTheMode } from '../sampling.js';
import { bareEdit, PROPOSE_SCHEMA, SKETCH_SCHEMA } from '../schemas.js';
import { stack } from '../observation.js';
import { artistLayers } from '../field.js';
import { withInfluences, type InfluenceDoc } from '../influence-doc.js';
import type { AestheticProgram } from '../../aesthetic/types.js';
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

/**
 * The fewest text ops this position can be satisfied with: whatever a `requireNode` on `text`
 * demands, and at least one op per required string, since a string has to live in some op.
 */
export function textDemand(position: AestheticProgram): number {
  const constraints = [...(position.commitments ?? []), ...(position.prohibitions ?? [])] as {
    kind: string;
    params: Record<string, unknown>;
  }[];
  let required = 0;
  let strings = 0;
  for (const c of constraints) {
    if (c.kind === 'requireNode' && c.params['op'] === 'text') required = Math.max(required, Number(c.params['min'] ?? 1));
    if (c.kind === 'textRequired') strings += (c.params['contains'] as string[] | undefined)?.length ?? 0;
  }
  return Math.max(required, strings, 1);
}

/**
 * The text budget is checked against the position, not set from it.
 *
 * It cannot be set from it: a profile is a file whose hash goes into the trajectory, so a profile
 * synthesised per position would be an unhashed medium and the run would no longer be reproducible
 * from what it recorded. So the derivation lives here, as an assertion.
 *
 * The ratio is two, because composing is not complying. An artist given exactly as many text ops as
 * the position requires can only place the mandatory strings, which is typesetting. `sketch-v1` used
 * to allow four against a position demanding three, and in one measured run the policy wrote a fifth
 * text op and had it refused twenty-two times — for a rule the capability sheet had told it about,
 * which is what a cap set too close to the floor looks like from inside. The next position that
 * outgrows the budget now says so at once instead of through refusals nobody reads.
 */
export function assertTextBudget(position: AestheticProgram, limits: { maxTextOps: number }): number {
  const demand = textDemand(position);
  if (limits.maxTextOps < demand * 2) {
    throw new Error(
      `${SKETCH_PROFILE} allows ${limits.maxTextOps} text ops but this position demands ${demand} and needs ` +
        `room above it to compose. Raise maxTextOps to at least ${demand * 2}, or the sketches are typesetting.`
    );
  }
  return demand;
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

export interface ProposedApproach {
  id: string;
  approach: string;
  probability: number;
}

const PROPOSE_SYSTEM = [
  'You are about to sketch one problem three times, and you are naming the three before you draw any',
  'of them.',
  '',
  'Spread out. The obvious approach belongs on the list — pretending you did not think of it is its',
  'own kind of averaging — but so do the ones you suspect will fail, and you should say plainly how',
  'likely each is rather than flattening them all to the same number.',
  '',
  'No edits here. One sentence per approach, said so that a drawing of it could turn out to be wrong.',
].join('\n');

function proposeObservation(commission: Commission, problem: Problem, n: number): string {
  const l = artistLayers(commission);
  return [
    stack(l.position, l.practice, l.brief),
    `THE PROBLEM YOU ARE ABOUT TO SKETCH\n[${problem.id}] ${problem.text}\ntension: ${problem.tension.between} vs ${problem.tension.and}: ${problem.tension.claim}`,
    `WHAT HAPPENS TO THIS LIST\n${n} of the approaches you name will be drawn at random, weighted by the\nprobabilities you give. A low number does not remove an approach from the running; it makes it less\nlikely, and it is the only way you get to say that you thought of something and do not back it.`,
  ].join(`\n${'-'.repeat(88)}\n`);
}

/**
 * The three ideas this problem gets sketched as — drawn, not picked.
 *
 * One call, before any sketching. The loop it replaces made three independent sketch calls from one
 * prompt and got the same idea three times, because three independent draws from a preference-tuned
 * model land on the mode three times. Nothing else about SKETCH changes: it is still one call and one
 * render per sketch, and a sketch is still allowed to fail.
 *
 * Returns both halves. `drawn` is what gets made; `proposed` is the whole distribution, kept so the
 * caller can log what the run declined.
 */
export async function propose(
  policy: Policy,
  log: StudioLog,
  spend: Spend,
  commission: Commission,
  problem: Problem,
  runSeed: number,
  n: number
): Promise<{ drawn: ProposedApproach[]; proposed: ProposedApproach[] }> {
  const result = await callPolicy<{ approaches: ProposedApproach[] }>(policy, log, spend, {
    name: 'propose',
    system: PROPOSE_SYSTEM,
    observation: proposeObservation(commission, problem, n),
    schema: PROPOSE_SCHEMA,
    maxTokens: 4000,
  });
  const proposed = result.action.approaches;
  const seed = streamSeed(runSeed, `propose:${problem.id}`);
  const drawnIdx = sampleIndices(proposed, n, rng(seed));
  const d = distribution('propose', seed, proposed.map((a) => ({ key: a.id, probability: a.probability })), drawnIdx);
  log.append('note', { phase: 'sketch', problemId: problem.id, verbalized: d, tookTheMode: tookTheMode(d) });
  return { drawn: drawnIdx.map((i) => proposed[i]!), proposed };
}

function observation(
  commission: Commission,
  problem: Problem,
  capabilitySheet: string,
  index: number,
  seed: Program,
  textOps: { used: number; max: number },
  assigned: ProposedApproach | null
): string {
  const l = artistLayers(commission);
  const left = Math.max(0, textOps.max - textOps.used);
  // The assignment replaces the old closing line rather than sitting beside it: told both "make it
  // different from a sketch you would draw twice" and "draw this specific idea", the model split the
  // difference and drew neither.
  const task = assigned
    ? `THE IDEA THIS SKETCH IS TESTING\nYou named this one yourself and it was drawn from your own distribution:\n"${assigned.approach}"\nDraw that, not the approach you would have picked. It is sketch ${index + 1} of 3 for this problem\nand the other two are testing different ideas, so do not hedge toward them.`
    : `This is sketch ${index + 1} of 3 for this problem. Make it different from a sketch you would draw\nfor the same problem twice. One idea, drawn clearly enough to be refuted.`;
  return [
    `THE SUBSTRATE (sketch budgets: profile ${SKETCH_PROFILE})\n${capabilitySheet}`,
    stack(l.position, l.practice, l.brief),
    `THE PROBLEM YOU ARE SKETCHING\n[${problem.id}] ${problem.text}\ntension: ${problem.tension.between} vs ${problem.tension.and}: ${problem.tension.claim}`,
    `THE SHEET YOU ARE STARTING FROM\n${JSON.stringify(seed, null, 2)}`,
    // The remainder, not the cap. The cap is in the capability sheet above and was not enough: a
    // measured run overran it twenty-two times, having been told it and not told what was left.
    `THE BUDGET YOU WILL ACTUALLY HIT\nText ops: ${textOps.used} of ${textOps.max} used on this sheet, ${left} you can still add.\nA ${left + 1}th text op is refused, and the refusal costs you the sketch, not just the op.`,
    task,
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
  canvas: Canvas,
  assigned: ProposedApproach | null = null,
  influences: InfluenceDoc | null = null
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

  // The sheet is built from the sketch profile, not the finished one: an artist handed the finished
  // budgets writes to a limit it was never going to be measured against, and every edit over the
  // sketch profile's own smaller limits is refused for a rule it was never shown.
  const result = await callPolicy<{ approach: string; edits: (EditAction & { servesElementId?: string })[] }>(policy, log, spend, {
    name: 'sketch',
    system: SYSTEM,
    observation: withInfluences(
      observation(
        commission,
        problem,
        capabilitySheet(profile, pack),
        index,
        start,
        { used: treeFacts(start).texts.length, max: profile.limits.maxTextOps },
        assigned
      ),
      influences,
      // Catalogue entries only. The pictures were attached once, at FIND, and re-attaching them to
      // all nine sketch calls costs about 4,500 image tokens each for a set the artist has already
      // seen — roughly 40,000 input tokens to say the same thing nine times. Looking at a shelf is
      // something you do once; what carries forward is that you know what is on it.
      0
    ),
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
