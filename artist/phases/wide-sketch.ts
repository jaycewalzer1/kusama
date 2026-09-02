// WIDE SKETCH: a dozen a lens, cheap, on a sheet you can read across.
//
// The canonical SKETCH (./sketch.ts) draws three pictures per problem and hands them to CHOOSE. It
// is not this and this does not replace it. Three is the right number when every sketch is a
// canonical render on the hash chain and the next phase has to make one decision; it is the wrong
// number when the question is what this lens even looks like, because three draws from a
// preference-tuned model land near each other and a sheet of three near-identical pictures reads as
// "this lens has one appearance". Twelve is enough that the ones at the edges are visibly different
// from the ones in the middle, and twelve is only affordable because nothing here is canonical.
//
// ## Discovery is a different contract, and the difference is the point
//
// Canonical: slow, deterministic, hash-chained into studio.jsonl, typed edits only, agreement-looped,
// blind-judged. Discovery: fast, noncanonical, wide, whole programs allowed, preview renders. Every
// model call in this file goes to a DiscoveryLog, which has no `prev` and no `hash`, so a line from
// here cannot be mistaken for a line from there. Nothing in this file writes to studio.jsonl, moves
// a hash, or touches the eight edit kinds, gate.ts or the goldens.
//
// ## Why a whole program is allowed here and nowhere else
//
// The seed is a blank sheet. A typed edit against a blank sheet can only add one node at a time, so
// twelve sketches from an edit-only vocabulary are twelve piles of accumulated nodes and the sketch
// that would have needed a different ground colour, a different canvas rhythm, or the same six nodes
// in a different order never gets drawn. Relaxing authorship is the cheapest way to widen the shape
// of what comes back.
//
// What is NOT relaxed is what counts as a program. A whole program goes through `validate()` — the
// medium's own ajv over schema/program.schema.json, the tree checks, resolution, and the profile's
// budget — before anything expensive, and then through `Canvas.preview`, which validates it again
// against the profile the canvas is pinned to. A program that fails is a failed sketch, not a
// softened rule. That is what makes promotion safe: the caller hands the tree to the canonical path
// unchanged, because it has already passed the gate the canonical path would have applied.
//
// The one extra thing refused here that the validator would allow: a program naming a different
// `profile` or `assetPack` than the seed. Both are legal programs; neither is the same medium, and a
// sketch that quietly switched medium would be promoted into a run measuring something else.
//
// ## What twelve previews cost, measured
//
// On this machine, 520x700 under default-v1, twelve previews of twelve distinct programs, browser
// launch and determinism warm-up included:
//
//   six rules and two text ops      7.6s   (449ms each in steady state)
//   three washes and four rules    26.7s   (2.1s each)
//   ten washes                     53s     (4.4s each)
//
// The same sheets through the canonical `render()` cost 12.9s and 52.2s, almost exactly double,
// which is the agreement loop: canonical pays for at least two browser renders per plate and a
// preview pays for one. Cost tracks washes and not mark count, as it always has here.
//
// TODO, and it is the honest caveat on the brief's "a sheet of twelve has to cost less than a couple
// of minutes": nothing enforces that. The ten-wash program above is 2% of default-v1's
// `maxRenderCost`, and a forty-wash program — 6% of the ceiling, passed by the validator without an
// issue — measures 23.7s a preview, so twelve of those is 285s and over the budget by two and a
// half times. `estimateBudget` weights a wash mark at 3 and the measured ratio is far higher, so the
// profile's cost limit is not a wall-clock bound and cannot be read as one. Left as a finding rather
// than a governor: a cost cap is a component this phase was not asked for, and the wiring can cap
// `perLens` or pin a cheaper profile through the seed if a real run ever hits this.
//
// ## A refused sketch stays on the sheet
//
// Same reasoning as ./sketch.ts, and it matters more here. A sketch that is dropped when it fails
// leaves a contact sheet of whatever happened to render, and the next phase then chooses among
// survivors while believing it is choosing among ideas. Every failure gets exactly one retry, told
// what actually stopped it, and if it fails again it stays in the result with its reason and appears
// in the captions. It gets only one because an idea that cannot be drawn after being told what
// stopped it is a fact about the idea.
//
// ## The logic, and the citation check
//
// The brief's bar: "Every sketch should carry a short logic naming what each borrowed element
// contributes and where it came from. If the logic could have been written without seeing the
// sketch, the sketch has failed." No validator decides that — it is the same unenforceable line
// material-sheet.ts draws between a borrowing and a mood. What is enforceable is the citation, and
// it is enforced the way material-sheet.ts enforces it: every `sourceId` must be a material id or a
// work id from the sheet the artist itself wrote, and one that is not is a refusal with a retry.
// A model asked for provenance will produce provenance whether or not it has any.

import { contactSheet } from '../../env/sheet.js';
import { applyEdit } from '../../env/edits.js';
import { loadPackFor } from '../../env/pack.js';
import { loadProfileFor } from '../../env/profile.js';
import { decodePng, encodePng } from '../../env/png.js';
import type { SamplingPlan } from '../../aesthetic/sample-types.js';
import { validateSamplingBindings, type SamplingBindings } from '../../aesthetic/sample-targets.js';
import { callPolicy, type Spend } from '../call.js';
import { capabilitySheet } from '../capability-sheet.js';
import { validate, type Preview } from '../canvas.js';
import { artistLayers, type Commission } from '../field.js';
import { withMaterials, type MaterialSheet } from '../material-sheet.js';
import { stack } from '../observation.js';
import { withSamplingCommitments } from '../sampling-observation.js';
import { bareEdit, SKETCH_SCHEMA } from '../schemas.js';
import { assertTextBudget } from './sketch.js';
import type { DiscoveryLog } from '../discovery-log.js';
import type { StudioLog } from '../studio-log.js';
import type { Policy } from '../policy/interface.js';
import type { EditAction, Program } from '../types.js';

/** Sketches drawn per surviving lens. Twelve is the brief's floor, not a tuned number. */
export const PER_LENS = 12;

const RULE = '-'.repeat(88);

/**
 * A lens DIVERGE kept, as a plain shape.
 *
 * Structural on purpose. DIVERGE is being built in parallel and importing its type would couple two
 * phases that only ever exchange three strings; the caller adapts at the wiring site.
 */
export interface Lens {
  id: string;
  lens: string;
  /** What the lens was said to make emerge. Absent is legal; a lens need not have predicted one. */
  emergent?: string;
}

/**
 * The half of `Canvas` this phase is allowed to use.
 *
 * Narrowed to one method rather than taking `Canvas` so that discovery cannot reach `render()` by
 * accident — a canonical render from inside a discovery phase would be a hash-chained plate nobody
 * asked for — and so a test can hand it a stub instead of paying for a browser. `Canvas` satisfies
 * it structurally; the caller passes the real one.
 */
export interface PreviewCanvas {
  preview(program: unknown): Promise<Preview>;
}

/** One thing taken, what it does here, and where it came from. */
export interface Borrowing {
  /** A material id (m3) or a work id (met:436535) from the material sheet. Checked, never trusted. */
  sourceId: string;
  contributes: string;
}

export interface WideSketch {
  lensId: string;
  index: number;
  approach: string;
  /** Written against the picture, not against the plan. Unenforceable and asked for anyway. */
  logic: string;
  borrowings: Borrowing[];
  /** How this sketch was authored. `program` is the relaxation and exists only in discovery. */
  authored: 'edits' | 'program' | null;
  program: Program | null;
  programHash: string;
  png: Buffer | null;
  failure: string | null;
  /** 1 when it worked first time, 2 when the retry saved it or when both attempts failed. */
  attempts: number;
  /** Disposable advice only; BIND still has to name nodes in the actual final tree. */
  bindings?: SamplingBindings;
}

export interface WideSheet {
  lensId: string;
  /** Null when every sketch for this lens failed, which is a result and not an error. */
  png: Buffer | null;
  notes: string[];
}

export interface WideSketchResult {
  sketches: WideSketch[];
  sheets: WideSheet[];
  drawn: number;
  failed: number;
}

const SYSTEM = [
  'You are drawing one fast, rough sketch to find out what an idea looks like on a sheet.',
  '',
  'This is not the piece and it is not a candidate for the piece. A dozen sketches are being drawn',
  'against this same lens and they all land on one contact sheet, which is read as a whole. A sketch',
  'that draws what the obvious answer would have drawn adds nothing to that sheet even if it is the',
  'best picture on it. Test one idea, and test it clearly enough that looking at the render could',
  'prove it wrong.',
  '',
  'You may answer in either of two ways, and you should choose deliberately:',
  '',
  '  edits    the typed edits, applied in order to the sheet you were given.',
  '  program  a whole program, written out, replacing that sheet entirely.',
  '',
  'Writing a whole program is normally forbidden and is allowed here. It exists because a typed edit',
  'against an empty sheet can only add one node at a time, which pushes every sketch toward the same',
  'accumulation; a whole program lets you set the ground, the canvas and the order of everything at',
  'once. Nothing about what counts as a legal program is relaxed with it. The same validator, the',
  'same profile, the same budgets, and a program that fails them is a sketch that did not get drawn.',
  '',
  'Then say what the sketch is doing. Name each thing you took, say what it contributes to THIS',
  'picture, and cite where you took it from. A logic that would have read the same before the sketch',
  'existed is not a logic.',
].join('\n');

function borrowingSchema(required: boolean, available: string[]): Record<string, unknown> {
  return {
    type: 'array',
    minItems: required ? 1 : 0,
    maxItems: 6,
    description: required
      ? `What you took and what it does here. Cite only these ids: ${available.join(', ')}. An id ` +
        'that is not on that list is a fabricated provenance and the sketch will be refused for it.'
      : 'What you took and what it does here. You were shown no material sheet, so this may be empty.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceId', 'contributes'],
      properties: {
        sourceId: { type: 'string', description: 'A material id (m3) or a work id (met:436535) from the sheet you wrote.' },
        contributes: {
          type: 'string',
          minLength: 30,
          description:
            'What this element does in this sketch: where it is, what it changes about the surface, ' +
            'what the picture would lose without it. Not what it does in the work you took it from.',
        },
      },
    },
  };
}

/**
 * The answer shape.
 *
 * `program` is `type: object` with no properties rather than schema/program.schema.json embedded.
 * That is not laziness and it is not a weaker gate. The program schema's colours and styles are
 * `$ref`s into paintstyle.schema.json — an external file — which a provider resolving a tool's
 * input_schema cannot follow, so embedding it would ship a schema whose most-used branches silently
 * do not constrain anything. The real schema is applied where it can actually be applied: by ajv,
 * in `validate()`, over the object that comes back.
 */
function schemaFor(
  sheet: MaterialSheet | null,
  available: string[],
  sampling: SamplingPlan | null
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['approach', 'logic', 'borrowings'],
    properties: {
      approach: { type: 'string', minLength: 20, description: 'The one idea this sketch is testing, in a sentence.' },
      logic: {
        type: 'string',
        minLength: 80,
        description:
          'What this sketch is doing, written against the picture you have just described in edits ' +
          'or in a program. Name the parts, say where they sit and what they do to each other. The ' +
          'test: if this could have been written without seeing the sketch, the sketch has failed.',
      },
      borrowings: borrowingSchema(sheet !== null, available),
      // The edit shape is read out of the canonical SKETCH schema rather than rebuilt. schemas.ts
      // hashes its own source bytes into `envVersion.observationHash`, so a new export there would
      // declare every trajectory ever collected to be from a different environment; reading the one
      // it already publishes costs nothing and cannot drift from the validator.
      edits: {
        type: 'array',
        minItems: 1,
        items: (SKETCH_SCHEMA['properties'] as { edits: { items: unknown } }).edits.items,
        description: 'Typed edits applied in order to the sheet you were given. Send these OR a program, never both.',
      },
      program: {
        type: 'object',
        description:
          'A whole program replacing the sheet you were given. Same version, profile, assetPack and ' +
          'schema as the sheet you were shown — copy those four keys from it exactly. Everything ' +
          'else is yours. Send this OR edits, never both.',
      },
      ...(sampling
        ? {
            bindings: {
              type: 'object',
              description: 'Optional advisory map from a declared sampling bindingRole to node IDs in this sketch.',
              additionalProperties: {
                type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' },
              },
            },
          }
        : {}),
    },
  };
}

interface Answer {
  approach: string;
  logic: string;
  borrowings: Borrowing[];
  edits?: (EditAction & { servesElementId?: string })[];
  program?: Record<string, unknown>;
  bindings?: SamplingBindings;
}

/** Every id the artist is allowed to cite: its own material ids and the works those cite. */
function allowedSources(sheet: MaterialSheet | null): string[] {
  const ids: string[] = [];
  for (const m of sheet?.materials ?? []) {
    ids.push(m.id);
    for (const w of m.works) if (!ids.includes(w)) ids.push(w);
  }
  return ids;
}

function observation(
  commission: Commission,
  lens: Lens,
  sheet: MaterialSheet | null,
  capabilities: string,
  seed: Program,
  index: number,
  perLens: number,
  sampling: SamplingPlan | null
): string {
  const l = artistLayers(commission);
  return withSamplingCommitments(withMaterials(
    [
      `THE SUBSTRATE\n${capabilities}`,
      stack(l.position, l.practice, l.brief),
      [
        'THE LENS YOU ARE SKETCHING THROUGH',
        `[${lens.id}] ${lens.lens}`,
        lens.emergent ? `what you said would come out of it: ${lens.emergent}` : '',
      ]
        .filter((s) => s !== '')
        .join('\n'),
      `THE SHEET YOU ARE STARTING FROM\n${JSON.stringify(seed, null, 2)}`,
      [
        'WHAT HAPPENS TO THIS SKETCH',
        `It is sketch ${index + 1} of ${perLens} through this lens, and all ${perLens} go on one contact sheet that is`,
        'read side by side. It is rendered at preview quality: one render, not repeated, not recorded',
        'in the trajectory. Nothing here is a commitment and nothing here is scored. The only way to',
        'waste it is to draw what the sketch beside it was always going to draw.',
      ].join('\n'),
    ].join(`\n${RULE}\n`),
    sheet
  ), sampling);
}

/**
 * A whole program, checked as hard as the canonical path would check it, and then a little harder.
 *
 * The extra check is the medium lock. `validate()` is happy with any profile that exists on disk, so
 * an artist that wrote `"profile": "default-v2"` into a run using default-v1 would produce a legal
 * program in the wrong medium — legal, promotable, and measuring something else. The seed names the
 * medium and the sketch does not get to change it.
 */
function refuseProgram(candidate: Record<string, unknown>, seed: Program): string | null {
  for (const key of ['profile', 'assetPack', 'version'] as const) {
    const got = candidate[key];
    if (got !== seed[key]) {
      return `"${key}" is ${JSON.stringify(got)} but this run's medium is ${JSON.stringify(seed[key])}. Copy that key from the sheet you were shown; a sketch does not get to change the medium.`;
    }
  }
  try {
    const { issues } = validate(candidate);
    if (issues.length > 0) return issues.map((i) => `${i.path} ${i.message} [${i.code}]`).join('; ');
  } catch (e) {
    // loadProfileFor and loadPackFor throw rather than returning issues when the program names
    // something that is not on disk. That is a refusal like any other, not a dead run.
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}

/** Edits applied in order. Null when every one of them was refused, with the reasons. */
function applyAll(
  seed: Program,
  edits: (EditAction & { servesElementId?: string })[],
  discovery: DiscoveryLog,
  lensId: string,
  index: number
): { program: Program } | { refusals: string[] } {
  const { profile } = loadProfileFor(seed);
  const pack = loadPackFor(seed);
  let program = seed;
  let applied = 0;
  const refusals: string[] = [];
  for (const edit of edits) {
    const r = applyEdit(program, bareEdit(edit), profile, pack);
    if (!r.valid) {
      discovery.append('note', { phase: 'wide-sketch', lensId, index, actionId: edit.actionId, refused: r.reason });
      refusals.push(`${edit.kind} ${edit.actionId}: ${r.reason}`);
      continue;
    }
    program = r.nextProgram;
    applied++;
  }
  return applied === 0 ? { refusals } : { program };
}

/** Citations checked against the sheet the artist wrote. An invented id is not a rounding error. */
function unresolvedCitations(borrowings: Borrowing[], allowed: string[]): string[] {
  if (allowed.length === 0) return [];
  return borrowings.map((b) => b.sourceId).filter((id) => !allowed.includes(id));
}

async function oneSketch(
  policy: Policy,
  discovery: DiscoveryLog,
  spend: Spend,
  commission: Commission,
  lens: Lens,
  sheet: MaterialSheet | null,
  seed: Program,
  canvas: PreviewCanvas,
  capabilities: string,
  index: number,
  perLens: number,
  runSeed: number,
  sampling: SamplingPlan | null,
  samplingLog: StudioLog | null
): Promise<WideSketch> {
  const out: WideSketch = {
    lensId: lens.id,
    index,
    approach: '',
    logic: '',
    borrowings: [],
    authored: null,
    program: null,
    programHash: '',
    png: null,
    failure: null,
    attempts: 0,
  };

  const allowed = allowedSources(sheet);
  const schema = schemaFor(sheet, allowed, sampling);
  const observed = observation(commission, lens, sheet, capabilities, seed, index, perLens, sampling);

  let failure = '';
  for (const attempt of [1, 2]) {
    out.attempts = attempt;
    const answer = await callPolicy<Answer>(policy, discovery, spend, {
      name: 'wide-sketch',
      system: SYSTEM,
      observation:
        attempt === 1
          ? observed
          : `${observed}\n${RULE}\nWHAT HAPPENED THE FIRST TIME YOU DREW THIS\nNothing was drawn. ${failure}\nThis is the retry and there is not another one. Answer again so that it draws. If the idea will\nnot fit, draw a plainer version of it rather than sending the same thing back.`,
      schema,
      maxTokens: 16000,
    });
    const action = answer.action;
    out.approach = action.approach;
    out.logic = action.logic;
    out.borrowings = action.borrowings ?? [];

    const invented = unresolvedCitations(out.borrowings, allowed);
    if (invented.length > 0) {
      failure = `You cited ${invented.join(', ')}, which is in no material you wrote. Cite only these: ${allowed.join(', ')}.`;
      continue;
    }

    const hasEdits = (action.edits?.length ?? 0) > 0;
    const hasProgram = action.program !== undefined && action.program !== null;
    if (hasEdits === hasProgram) {
      failure = hasEdits
        ? 'You sent both edits and a whole program, so it is not decided what the sketch is. Send one.'
        : 'You sent neither edits nor a program, so there was nothing to draw. Send one.';
      continue;
    }

    let program: Program;
    if (hasProgram) {
      const refused = refuseProgram(action.program!, seed);
      if (refused) {
        failure = `The program you wrote is not a legal program in this medium: ${refused}`;
        continue;
      }
      program = action.program as unknown as Program;
      out.authored = 'program';
    } else {
      const applied = applyAll(seed, action.edits!, discovery, lens.id, index);
      if ('refusals' in applied) {
        failure = `Every edit was refused:\n${applied.refusals.join('\n')}`;
        continue;
      }
      program = applied.program;
      out.authored = 'edits';
    }

    if (sampling && action.bindings !== undefined) {
      const checked = validateSamplingBindings(
        program,
        new Set(sampling.requests.map((request) => request.role)),
        action.bindings
      );
      samplingLog?.append('binding_declared', {
        status: 'intended',
        bindings: checked.bindings,
        accepted: checked.valid,
        faults: checked.faults,
        lensId: lens.id,
        sketchIndex: index,
      });
      if (!checked.valid) {
        failure = `The sampling bindings were invalid: ${checked.faults.join('; ')}`;
        continue;
      }
      program = {
        ...program,
        meta: { ...((program as Record<string, any>).meta ?? {}), samplingBindings: checked.bindings },
      };
      out.bindings = checked.bindings;
    }

    try {
      const rendered = await canvas.preview(program);
      out.program = program;
      out.programHash = rendered.programHash;
      out.png = rendered.png;
      discovery.append('sketch', {
        runSeed,
        lensId: lens.id,
        index,
        approach: out.approach,
        logic: out.logic,
        borrowings: out.borrowings,
        authored: out.authored,
        programHash: out.programHash,
        attempts: attempt,
        canonical: rendered.canonical,
        drawn: true,
      });
      return out;
    } catch (e) {
      out.authored = null;
      failure = `It would not render: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  out.failure = failure;
  discovery.append('sketch', {
    runSeed,
    lensId: lens.id,
    index,
    approach: out.approach,
    logic: out.logic,
    borrowings: out.borrowings,
    authored: null,
    attempts: out.attempts,
    drawn: false,
    failure,
  });
  return out;
}

/**
 * `perLens` sketches through each surviving lens, previewed, captioned and put on a sheet per lens.
 *
 * `runSeed` is written into the discovery lines and is used for nothing else. It is deliberately not
 * fed to a sampler: nothing in this phase is reproducible from a seed and it must not look as though
 * it is. The policy is called at whatever temperature the run configured, every sketch is an
 * independent draw, and two runs of this function with the same arguments will not agree. That is
 * the point of discovery and the reason none of it may enter the chain. The seed is in the record so
 * a discovery line can be attributed to the run it came from, and for no stronger claim than that.
 *
 * Sketches are drawn one at a time. The canvas renders one program at a time by construction, so
 * running the policy calls concurrently would buy nothing but interleaved log lines.
 */
export async function wideSketch(
  policy: Policy,
  discovery: DiscoveryLog,
  spend: Spend,
  commission: Commission,
  lenses: Lens[],
  sheet: MaterialSheet | null,
  seedProgram: Program,
  canvas: PreviewCanvas,
  runSeed: number,
  opts: { perLens?: number; sampling?: SamplingPlan; samplingLog?: StudioLog } = {}
): Promise<WideSketchResult> {
  const perLens = opts.perLens ?? PER_LENS;
  const { profile } = loadProfileFor(seedProgram);
  const pack = loadPackFor(seedProgram);
  // Borrowed from ./sketch.ts unchanged: a position demanding more text than the profile allows
  // should say so once, here, rather than through refusals nobody reads on every one of 36 sketches.
  assertTextBudget(commission.effective, profile.limits);
  const capabilities = capabilitySheet(profile, pack);

  const sketches: WideSketch[] = [];
  for (const lens of lenses) {
    for (let i = 0; i < perLens; i++) {
      sketches.push(
        await oneSketch(
          policy,
          discovery,
          spend,
          commission,
          lens,
          sheet,
          seedProgram,
          canvas,
          capabilities,
          i,
          perLens,
          runSeed,
          opts.sampling ?? null,
          opts.samplingLog ?? null
        )
      );
    }
  }

  const sheets = lenses.map((lens) => {
    const mine = sketches.filter((s) => s.lensId === lens.id);
    return { lensId: lens.id, png: sheetOf(mine), notes: sheetNotes(lens, mine) };
  });
  const drawn = sketches.filter((s) => s.png).length;
  discovery.append('note', {
    phase: 'wide-sketch',
    runSeed,
    perLens,
    lenses: lenses.map((l) => l.id),
    drawn,
    failed: sketches.length - drawn,
    wholePrograms: sketches.filter((s) => s.authored === 'program').length,
  });
  return { sketches, sheets, drawn, failed: sketches.length - drawn };
}

/**
 * One lens's sketches on one sheet.
 *
 * Not `sheetOf` from ./sketch.ts, which fixes three columns at 360px because it is tiling nine
 * pictures. Twelve at those numbers is four rows of 360 — a strip 1500 pixels tall that nobody reads
 * across, which is the failure this phase exists to avoid. A near-square grid at 200 keeps twelve
 * inside one screen; the cells are small, and they are meant to be. A contact sheet is for seeing
 * whether the batch is varied, and that is a question you answer at thumbnail size.
 */
export function sheetOf(sketches: WideSketch[]): Buffer | null {
  const images = sketches.filter((s) => s.png).map((s) => decodePng(s.png!));
  if (images.length === 0) return null;
  const sheet = contactSheet(images, {
    cols: Math.ceil(Math.sqrt(images.length)),
    cell: 200,
    gap: 8,
    background: [0x20, 0x20, 0x20],
  });
  return encodePng(sheet.rgba, sheet.width, sheet.height);
}

/**
 * Which cell is which sketch, and which sketches are not on the sheet at all.
 *
 * The failures are listed with the drawn ones and not in a separate report, because a reader looking
 * at eleven cells and told nothing has no way to know a twelfth was attempted.
 */
export function sheetNotes(lens: Lens, sketches: WideSketch[]): string[] {
  const notes = [`lens ${lens.id}: ${lens.lens}`];
  let cell = 0;
  for (const s of sketches) {
    if (!s.png) continue;
    cell++;
    const took = s.borrowings.map((b) => `${b.sourceId} (${b.contributes})`).join('; ');
    notes.push(
      `cell ${cell} (left to right, top to bottom): ${s.approach}` +
        `\n    written as: ${s.authored}` +
        `\n    logic: ${s.logic}` +
        (took ? `\n    took: ${took}` : '')
    );
  }
  for (const s of sketches) {
    if (s.png) continue;
    notes.push(`not drawn: sketch ${s.index + 1} — ${s.failure} (${s.attempts} attempt${s.attempts === 1 ? '' : 's'})`);
  }
  return notes;
}
