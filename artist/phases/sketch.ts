// SKETCH: draw each problem badly and quickly, before committing to one.
//
// Three sketches per problem, under `profiles/sketch-v1.profile.json` — every budget at or below
// default-v1 and the print pass removed, so a sketch costs a fraction of a plate and cannot be
// mistaken for a finished piece. The point is not to produce good pictures. It is to make CHOOSE a
// decision about images rather than about descriptions of images.
//
// A sketch is one policy call and one render. It is allowed to fail: a sketch whose edits are all
// refused, or which will not render, is recorded as failed and the contact sheet is simply shorter.
// A failure gets exactly one retry, and the retry is told what was refused and why. It gets one
// because dropping a refused sketch silently hands CHOOSE a contact sheet of whatever happened to
// render, and in one measured run that meant choosing a problem the artist had itself ranked at 8%:
// the choice was made among survivors rather than among problems. It gets only one because a problem
// that cannot be drawn even when told what stopped it is a fact about the problem, not an accident.

import { treeFacts } from '../../aesthetic/facts.js';
import { applyEdit } from '../../env/edits.js';
import { loadPackFor } from '../../env/pack.js';
import { loadProfileFor, markRates, type MediumProfile } from '../../env/profile.js';
import { decodePng, encodePng } from '../../env/png.js';
import { contactSheet } from '../../env/sheet.js';
import { callPolicy, type Spend } from '../call.js';
import { capabilitySheet } from '../capability-sheet.js';
import { distribution, rng, sampleIndices, streamSeed, tookTheMode } from '../sampling.js';
import { bareEdit, PROPOSE_SCHEMA, sketchSchema } from '../schemas.js';
import { stack } from '../observation.js';
import { artistLayers } from '../field.js';
import { withInfluences, type InfluenceDoc } from '../influence-doc.js';
import { withPracticeHistory } from '../practice-version.js';
import { withSamplingCommitments } from '../sampling-observation.js';
import { validateSamplingBindings, type SamplingBindings } from '../../aesthetic/sample-targets.js';
import type { SamplingPlan } from '../../aesthetic/sample-types.js';
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
 *
 * Only hard, unblocked constraints count. A soft constraint is scored, not required — `check.ts`
 * treats exactly the hard ones as what a plate must satisfy — and a blocked one is not checked at
 * all, so neither can put a floor under the budget. Counting them did: `many-hands` carries a soft
 * and blocked `requireNode text min 30`, which made every run of that position die between FIND and
 * SKETCH over a number no plate was ever going to be held to.
 */
export function textDemand(position: AestheticProgram): number {
  const constraints = [...(position.commitments ?? []), ...(position.prohibitions ?? [])].filter(
    (c) => c.severity === 'hard' && c.blocked_by === undefined
  ) as { kind: string; params: Record<string, unknown> }[];
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
  'You are an artist making a fast, rough sketch to find out what a connection looks like.',
  '',
  'Test the connection, not just the layout. The sketch should make the generative rule visible:',
  'if the rule says "every concealment generates visibility", then the sketch must show that',
  'happening, not merely arrange elements in a plausible composition. A sketch that proves the',
  'connection does not work has done its job.',
  '',
  'Rough means mark-abundant, not mark-sparse. Use wash, hatch, field and stroke to test what',
  'the surface will be — a sketch of solids and thin lines tests the layout but not the picture.',
  'If someone can only say "some rectangles", you tested nothing. Reduced budgets: fewer nodes,',
  'fewer text ops, no print pass.',
  '',
  'Change the palette if the connection demands it. The seed colours are a starting point, not a',
  'constraint. Different connections should produce visibly different colour worlds.',
].join('\n');

export interface SketchResult {
  problemId: string;
  index: number;
  approach: string;
  program: Program | null;
  programHash: string;
  png: Buffer | null;
  failure: string | null;
  bindings?: SamplingBindings;
}

export interface ProposedApproach {
  id: string;
  approach: string;
  probability: number;
}

const PROPOSE_SYSTEM = [
  'You are naming three approaches to sketch before drawing any of them.',
  '',
  'Spread out. Each approach should realize the connection through a different visual logic — not',
  'three compositions of the same idea, but three genuinely different ways the connection could',
  'become marks on the sheet. Include the obvious one and the ones you suspect will fail. Say',
  'plainly how likely each is. One sentence per approach, said so a drawing could turn out wrong.',
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
  n: number,
  sampling: SamplingPlan | null = null
): Promise<{ drawn: ProposedApproach[]; proposed: ProposedApproach[] }> {
  const result = await callPolicy<{ approaches: ProposedApproach[] }>(policy, log, spend, {
    name: 'propose',
    system: PROPOSE_SYSTEM,
    observation: withSamplingCommitments(proposeObservation(commission, problem, n), sampling),
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

/**
 * What this sheet's whole mark allowance actually buys, priced on this canvas.
 *
 * SKETCH is one call: the artist writes every edit before any of them is applied, and gets no
 * feedback until they have all been judged. So the cap is only useful to it if it is already
 * converted into the thing it is about to write. `sketch-v1` cuts marks to a fifth of `default-v1`
 * and does not cut the canvas, so a fill that is ordinary in a finished plate is over the limit in a
 * sketch on its own — and the log says so plainly: every one of the 43 mark refusals in `out/` is a
 * sketch, and three of them are a first edit against a blank sheet.
 */
export function sheetCost(profile: MediumProfile, seed: Program, max: number): string {
  const canvas = seed['canvas'] as { width: number; height: number };
  const box = { w: canvas.width, h: canvas.height };
  const rows = markRates(profile, box)
    .map((r) => `  ${r.kind.padEnd(10)}${String(r.marks).padStart(7)}  ${Math.round((100 * r.marks) / max)}% of your whole allowance`)
    .join('\n');
  return [
    `WHAT YOUR ${max} MARKS BUY ON THIS SHEET (${canvas.width}x${canvas.height})`,
    rows,
    'A fill over a fraction of the sheet costs that fraction. Spend the allowance on purpose.',
    'Do not reach for `solid` to save marks — that is a vector drawing on a brush engine.',
  ].join('\n');
}

function observation(
  commission: Commission,
  problem: Problem,
  capabilitySheet: string,
  index: number,
  seed: Program,
  profile: MediumProfile,
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
    sheetCost(profile, seed, profile.limits.maxEstimatedMarks),
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
  influences: InfluenceDoc | null = null,
  sampling: SamplingPlan | null = null
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
  const observed = withPracticeHistory(
    withSamplingCommitments(withInfluences(
      observation(
        commission,
        problem,
        capabilitySheet(profile, pack),
        index,
        start,
        profile,
        { used: treeFacts(start).texts.length, max: profile.limits.maxTextOps },
        assigned
      ),
      influences,
      // Catalogue entries only. The pictures were attached once, at FIND, and re-attaching them to
      // all nine sketch calls costs about 4,500 image tokens each for a set the artist has already
      // seen — roughly 40,000 input tokens to say the same thing nine times. Looking at a shelf is
      // something you do once; what carries forward is that you know what is on it.
      0
    ), sampling),
    commission.positionAsWritten.id
  );

  // What the sketch will be recorded as failing with, and the longer text the retry gets told. They
  // differ for refused edits: the record keeps the same short sentence it always did, while the model
  // needs the validator's actual sentences to have any chance of avoiding them.
  let failure = '';
  let detail = '';
  for (const attempt of [0, 1]) {
    if (attempt === 1) log.append('note', { phase: 'sketch', problemId: problem.id, index, retry: failure });
    const result = await callPolicy<{ approach: string; edits: (EditAction & { servesElementId?: string })[]; bindings?: SamplingBindings }>(policy, log, spend, {
      name: 'sketch',
      system: SYSTEM,
      observation:
        attempt === 0
          ? observed
          : `${observed}\n${'-'.repeat(88)}\nWHAT HAPPENED THE FIRST TIME YOU DREW THIS\nNothing was drawn. ${detail}\nThis is the retry and there is not another one. Send edits that avoid what is described above.\nIf the idea will not fit these budgets, draw a plainer version of it rather than the same edits again.`,
      schema: sketchSchema(sampling !== null),
      maxTokens: 8000,
    });
    base.approach = result.action.approach;

    let program = start;
    let applied = 0;
    const refusals: string[] = [];
    for (const edit of result.action.edits) {
      const r = applyEdit(program, bareEdit(edit), profile, pack);
      if (!r.valid) {
        log.append('edit-refused', { phase: 'sketch', problemId: problem.id, index, actionId: edit.actionId, reason: r.reason });
        refusals.push(`${edit.kind} ${edit.actionId}: ${r.reason}`);
        continue;
      }
      program = r.nextProgram;
      applied++;
    }
    if (applied === 0) {
      failure = 'every edit was refused';
      detail = `Every edit was refused:\n${refusals.join('\n')}`;
      continue;
    }

    if (sampling && result.action.bindings !== undefined) {
      const checked = validateSamplingBindings(program, new Set(sampling.requests.map((request) => request.role)), result.action.bindings);
      log.append('binding_declared', {
        status: 'intended', bindings: checked.bindings, accepted: checked.valid, faults: checked.faults,
        problemId: problem.id, sketchIndex: index,
      });
      if (!checked.valid) {
        failure = 'sampling bindings were invalid';
        detail = checked.faults.join('\n');
        continue;
      }
      program = {
        ...program,
        meta: { ...((program as Record<string, any>).meta ?? {}), samplingBindings: checked.bindings },
      };
      base.bindings = checked.bindings;
    }

    try {
      const rendered = await canvas.render(program);
      base.program = program;
      base.programHash = rendered.programHash;
      base.png = rendered.png;
      // A sketch that drew used to leave no line at all: the failures were logged and the successes
      // were not, so the record said which sketches died and never said which ones existed. The hash
      // that fetches the picture back out of the render cache was nowhere in the file either. The
      // caller does write a PNG afterwards, but only on the default arm and only under a name built
      // from two fields the log did not carry.
      log.append('note', {
        phase: 'sketch',
        problemId: problem.id,
        index,
        attempt,
        approach: base.approach,
        programHash: rendered.programHash,
        drawn: true,
      });
      return base;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      detail = `The program you built would not render: ${failure}`;
    }
  }

  base.failure = failure;
  log.append('note', { phase: 'sketch', problemId: problem.id, index, failure: base.failure });
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
