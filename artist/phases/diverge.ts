// DIVERGE: widen to tens of ways of looking at the problem, then kill most of them on purpose.
//
// This phase runs between FIND and SKETCH, and it exists because of what the loop did without it.
// FIND named three problems, SKETCH drew each of them three times, and the nine sketches were nine
// attempts at the same reading of the same difficulty — the variation between them was rendering
// variation, not thinking variation. Nothing in the loop ever asked "what if this were a problem
// about drainage / bookbinding / crowd control instead". The brief's word for the fix is a lens: a
// way of looking at the problem borrowed from somewhere else, and the somewhere else now includes
// the works RESEARCH actually went and looked at.
//
// ## The one test, and why it is worth a whole policy call
//
// Borrowing is cheap and produces slop. "Treat the archive problem like a manuscript" is a sentence
// anybody can write about anything, and a loop that accepted it would spend a render on it. So every
// lens has to state something true of the combination that is true of neither input alone. That is
// the conceptual-blending test, and the operational form of it — the form the prompt gives the
// artist and the form a reader of `discovery.jsonl` can apply by hand — is: delete one of the two
// inputs and read the sentence again. If it survives, nothing was built, and the lens is a mood.
//
// "Both are old" is the canonical failure. It is true, it is about both inputs, and it is a property
// they SHARE rather than one the combination produced. Shared properties are the thing that makes
// prompt soup read as insight, which is why the schema says so in as many words rather than trusting
// the phrase "emergent structure" to carry it.
//
// ## Most of them die here, and the deaths are the output
//
// Twenty-plus lenses proposed, three to six kept. The cut list is not waste and is not a log level:
// the brief asks for the record of what was proposed and why it was cut, because that record is
// preference data. A kept lens tells you what this artist did. A lens cut with the reason "the
// emergent sentence survives deleting the manuscript" tells you what it can tell apart, which is the
// more informative of the two and the one no other file in this repo is collecting.
//
// Cutting is a second call rather than a `minItems: 3` on the first, because asking for twenty and
// six in one schema gets you six real ones and fourteen written to fill an array. The artist has to
// see its own twenty as a list before it can say which ones are soup, and the reasons are only worth
// anything if they were written against the actual text of the lens being cut.
//
// ## Discovery, not the chain
//
// Both calls go to a `DiscoveryLog`. Nothing in this file writes to `studio.jsonl`, moves a hash, or
// is replayable, and none of that is an oversight. Discovery is allowed to be wide, cheap and
// nondeterministic; the moment a lens set were hash-chained, somebody would have to make this phase
// deterministic to keep the chain whole, and a deterministic widening step is not a widening step.
// The lenses reach the trajectory the way the material sheet does — as part of a later phase's
// observation, which `callPolicy` logs into the chain in full.
//
// Prompt text and JSON schemas live here rather than in observation.ts or schemas.ts, whose source
// bytes are hashed into `envVersion.observationHash`; adding a word there would declare every
// trajectory ever collected to be from a different environment. influence-doc.ts made that call
// first and its header is the long version of the argument.
//
// ## `runSeed` draws nothing
//
// FIND takes a seed because it makes a weighted draw. DIVERGE does not draw: the artist proposes and
// the artist cuts, and neither is sampled by us. The seed is here so a discovery file can be joined
// back to the trajectory it belongs to, and it must stay that way. A seeded selection over the
// proposed lenses would be this file quietly deciding what the artist meant to keep.

import { callPolicy, type Spend } from '../call.js';
import { artistLayers, type Commission } from '../field.js';
import { withMaterials, type MaterialSheet } from '../material-sheet.js';
import { stack } from '../observation.js';
import type { DiscoveryLog } from '../discovery-log.js';
import type { Policy } from '../policy/interface.js';
import type { Problem } from '../types.js';

/**
 * The floor on the proposal, and it is a floor rather than a target. Twenty is the brief's number
 * and it is chosen to be past the point where a model can produce them one good idea at a time — at
 * five it writes five defensible lenses, at twenty it has to reach somewhere it would not have gone,
 * and the reaching is the whole point. The bad ones are not a cost here; cutting them is the next
 * call, and a lens costs nothing until SKETCH renders it.
 */
export const MIN_LENSES = 20;

/**
 * How many survive by default.
 *
 * Four, because the survivors are what SKETCH pays for and a sketch is a render. Small enough that
 * cutting is a real decision rather than a formality — at twelve of twenty nothing has been decided.
 */
export const KEEP_DEFAULT = 4;

const RULE = '-'.repeat(88);

const PROPOSE_SYSTEM = [
  'You are widening, not deciding. Nothing on this list gets drawn, nothing on it costs anything',
  'yet, and you will cut most of it yourself in a few minutes. Write the ones you do not believe in.',
  '',
  'A lens is a way of looking at the problem borrowed from somewhere else. The somewhere else can be',
  'a craft, a discipline, a machine, a failure mode, a legal procedure, a way a material behaves —',
  'and it should usually be one of the works or materials you have just been looking at, because you',
  'went and looked at them and this is what looking was for.',
  '',
  'There is one test and it is the only thing between this list and prompt soup. The combination has',
  'to have structure that belongs to neither half. Write your sentence, then delete one of the two',
  'inputs and read it again. If it is still true, you combined nothing and the lens is dead.',
  '',
  '"The archive is old and the manuscript is old" fails: old is a property they share, not one the',
  'combination produced. Nothing came out that was not already in both.',
  '',
  '"A margin that was ruled before anyone knew what would be written in it means the sheet commits',
  'to a shape before it commits to a content" is the kind of thing that passes: delete the ruling or',
  'delete the archive and the sentence stops being about anything.',
  '',
  'Do not hand back the source or the lens as the emergent sentence. Saying it again is not building.',
  '',
  'Spread out. Twenty lenses borrowed from three places are three lenses.',
].join('\n');

function cutSystem(keep: number): string {
  return [
    'Now cut your own list.',
    '',
    `Keep ${keep}. Everything else dies, and that is what the list was for — you wrote more than you`,
    'believed so that cutting would be a real decision instead of a formality.',
    '',
    'Every cut carries a reason and the reasons are the part worth keeping. "The emergent sentence is',
    'still true after I delete the manuscript, so nothing was built" is a reason. "This one is about a',
    'shared property, not an emergent one" is a reason. "Weaker" is not a reason, and neither is',
    '"less interesting" — say what is wrong with the lens.',
    '',
    'Keeping the ones you liked writing is the failure mode here. Keep the ones whose emergent',
    'structure actually holds and that you could not have arrived at without both inputs.',
    '',
    'You weighted these problems yourself, and the weights are printed. A lens on a problem you gave',
    'four percent is a lens on a problem you said was unlikely — that is a reason to keep it or a',
    'reason to cut it, but decide it rather than letting it decide itself.',
  ].join('\n');
}

const LENS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lenses'],
  properties: {
    lenses: {
      type: 'array',
      minItems: MIN_LENSES,
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'problem', 'source', 'sourceClaim', 'lens', 'emergent'],
        properties: {
          id: { type: 'string', pattern: '^l[0-9]+$', description: 'l1, l2, l3 …' },
          problem: {
            type: 'string',
            description: 'The id of the problem this looks at, from the list you were shown. One of the two inputs.',
          },
          source: {
            type: 'string',
            minLength: 2,
            description:
              'Where the way of looking is borrowed from. A material id (m3), a work id (met:436535), or the name of a practice, trade or machine. The other input.',
          },
          sourceClaim: {
            type: 'string',
            minLength: 25,
            description:
              'What is true in the source ALONE, before it touches the problem. This is the half you delete when you run the test, so state it plainly enough to be deleted.',
          },
          lens: {
            type: 'string',
            minLength: 30,
            description: 'How the problem looks once you carry the source onto it. One sentence.',
          },
          emergent: {
            type: 'string',
            minLength: 40,
            description:
              'Something true of the combination that is true of NEITHER input alone. A property the two inputs share ("both are old", "both involve waiting") is not emergent structure — it was already in both. If the sentence stays true when you delete either input, it has failed and the lens should be one you cut. Do not restate the source or the lens here.',
          },
        },
      },
    },
  },
};

function cutSchema(keep: number): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['keep', 'cut'],
    properties: {
      keep: {
        type: 'array',
        minItems: 1,
        maxItems: keep,
        items: { type: 'string' },
        description: 'Lens ids that survive. Every other lens must appear in `cut` with a reason.',
      },
      cut: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'reason'],
          properties: {
            id: { type: 'string' },
            reason: {
              type: 'string',
              minLength: 20,
              description:
                'What is wrong with this lens. Name the defect — the emergent claim survives deleting an input, the two inputs only share a property, the lens is a restatement of the problem, the source is one you have already used better elsewhere. A comparative like "weaker" names nothing.',
            },
          },
        },
      },
    },
  };
}

/** One way of looking at the problem, borrowed from somewhere else. */
export interface DivergeLens {
  id: string;
  /** The problem id this looks at. One of the two inputs; its text lives in FIND's output. */
  problem: string;
  /** The other input: a material id, a work id, or a named practice. */
  source: string;
  /** What is true in the source alone. Stated so that the delete-one-input test can be run on it. */
  sourceClaim: string;
  /** How the problem looks once the source is carried onto it. */
  lens: string;
  /** Something true of the combination that is true of neither input alone. */
  emergent: string;
}

export interface CutLens {
  lens: DivergeLens;
  reason: string;
}

export interface DivergeResult {
  /** Every lens the artist wrote, in the order it wrote them. */
  proposed: DivergeLens[];
  /** The survivors. What SKETCH would pay to draw. */
  kept: DivergeLens[];
  /** The deaths, each with the artist's reason. `kept` and `cut` partition `proposed`. */
  cut: CutLens[];
  /** Lenses whose emergent sentence is degenerate. Reported, never thrown; see the checker. */
  degenerate: DivergeLens[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
}

/**
 * The lenses whose emergent sentence is broken in a way a machine can see.
 *
 * Three cases, and they are all degenerate: the sentence is empty, it is a copy of one of the
 * lens's own strings, or it is a copy of another lens's sentence. That is the whole of it.
 *
 * What this CANNOT do is the thing the phase actually cares about. No validator can tell a real
 * emergent-structure claim from a plausible-sounding one; "a margin ruled before anyone knew what
 * would be written in it commits the sheet to a shape before a content" and an equally fluent
 * sentence that is really just "both involve waiting" are the same object to any check that does not
 * understand either of them. The delete-one-input test is a test a reader runs, not a test this
 * function runs. So this is a floor, not a filter: it catches copy-paste and blank filler, and a
 * lens that passes it has been shown to be non-empty and non-duplicated and nothing else.
 *
 * It is reported rather than enforced because a degenerate emergent sentence is a fact about the
 * artist worth having in the record. Dropping those lenses silently would delete exactly the
 * evidence that the widening call is producing filler.
 */
export function emergentStructureFailures(lenses: DivergeLens[]): DivergeLens[] {
  const seen = new Map<string, string>();
  const out: DivergeLens[] = [];
  for (const l of lenses) {
    const e = normalize(l.emergent);
    if (e.length === 0) {
      out.push(l);
      continue;
    }
    if (e === normalize(l.sourceClaim) || e === normalize(l.lens) || e === normalize(l.source)) {
      out.push(l);
      continue;
    }
    const first = seen.get(e);
    if (first !== undefined && first !== l.id) out.push(l);
    else seen.set(e, l.id);
  }
  return out;
}

/**
 * The problems as the artist reads them back, weights included.
 *
 * The weights are printed because they are the artist's own ranking of its own problems and a later
 * phase has to answer to them: a run that keeps four lenses all hanging off the problem it scored at
 * four percent has made a decision, and it can only be seen to have made it if the number was on the
 * page when it decided. A missing weight prints as `unranked` rather than as zero — an absent field
 * read as a confident zero is the standing trap in this repo, and trajectories collected before
 * verbalized sampling do not carry one.
 */
function problemBlock(problems: Problem[]): string {
  return problems
    .map((p) =>
      [
        `  [${p.id}] (${p.probability === undefined ? 'unranked' : `you weighted this ${Math.round(p.probability * 100)}%`})`,
        `        ${p.text}`,
        `        the tension: ${p.tension.between} against ${p.tension.and} — ${p.tension.claim}`,
      ].join('\n')
    )
    .join('\n\n');
}

function lensBlock(lenses: DivergeLens[]): string {
  return lenses
    .map((l) =>
      [
        `  [${l.id}] on ${l.problem}, borrowed from ${l.source}`,
        `        true of the source alone: ${l.sourceClaim}`,
        `        the lens: ${l.lens}`,
        `        what only the combination has: ${l.emergent}`,
      ].join('\n')
    )
    .join('\n\n');
}

export async function diverge(
  policy: Policy,
  discovery: DiscoveryLog,
  spend: Spend,
  commission: Commission,
  problems: Problem[],
  sheet: MaterialSheet | null,
  runSeed: number,
  keep: number = KEEP_DEFAULT
): Promise<DivergeResult> {
  const layers = artistLayers(commission);
  const brief = withMaterials(stack(layers.position, layers.practice, layers.brief), sheet);
  discovery.append('note', {
    phase: 'diverge',
    runSeed,
    keep,
    problems: problems.map((p) => p.id),
    sheet: sheet?.hash ?? null,
  });

  const proposal = await callPolicy<{ lenses: DivergeLens[] }>(policy, discovery, spend, {
    name: 'diverge-propose',
    system: PROPOSE_SYSTEM,
    observation: [
      brief,
      RULE,
      `THE PROBLEMS YOU FOUND (${problems.length})`,
      problemBlock(problems),
      RULE,
      'WIDEN.',
      `Write at least ${MIN_LENSES} lenses across these problems. Not ${MIN_LENSES} lenses on your`,
      'favourite one, and not one apiece: put several on the problem you think is hardest and put',
      'some on the ones you weighted low, because a low weight is a guess you made before you had',
      'anywhere else to look from.',
      '',
      sheet
        ? 'Borrow from the works and materials above by id wherever you can. You went and looked at them.'
        : 'You have not looked at any works this session, so every source here is one you brought with you.',
    ].join('\n'),
    schema: LENS_SCHEMA,
    maxTokens: 16000,
  });

  // Ids are the join key for the whole rest of this file, so a repeated id would silently merge two
  // lenses into one and lose a proposal. First writer wins and the duplicate is dropped before it is
  // logged, because a lens the artist can no longer be asked about is not a proposal.
  const byId = new Map<string, DivergeLens>();
  for (const l of proposal.action.lenses) if (!byId.has(l.id)) byId.set(l.id, l);
  const proposed = [...byId.values()];
  for (const l of proposed) discovery.append('lens-proposed', l);

  const degenerate = emergentStructureFailures(proposed);
  if (degenerate.length > 0) {
    discovery.append('note', { phase: 'diverge', degenerate: degenerate.map((l) => l.id) });
  }

  const review = await callPolicy<{ keep: string[]; cut: { id: string; reason: string }[] }>(
    policy,
    discovery,
    spend,
    {
      name: 'diverge-cut',
      system: cutSystem(keep),
      observation: [
        brief,
        RULE,
        `THE PROBLEMS YOU FOUND (${problems.length})`,
        problemBlock(problems),
        RULE,
        `WHAT YOU WROTE (${proposed.length} lenses)`,
        lensBlock(proposed),
        RULE,
        `CUT. Keep at most ${keep}. Give a reason for every one you kill.`,
      ].join('\n'),
      schema: cutSchema(keep),
      maxTokens: 8000,
    }
  );

  // Reconciliation, and it is not defensive plumbing — it is what makes "kept plus cut is every
  // lens" true by construction rather than by hoping the model listed all twenty. A lens the artist
  // simply failed to mention is cut, because the survivors are the explicit list; it is cut with a
  // stated reason so that no line in the cut record is a blank, which is the one property the brief
  // asks of this record. Unknown ids in the keep list name nothing and are ignored.
  const cutReason = new Map(review.action.cut.map((c) => [c.id, c.reason]));
  const keptIds = new Set(review.action.keep.filter((id) => byId.has(id)).slice(0, keep));
  const kept: DivergeLens[] = [];
  const cut: CutLens[] = [];
  for (const l of proposed) {
    if (keptIds.has(l.id)) {
      kept.push(l);
      discovery.append('lens-kept', l);
    } else {
      const reason = cutReason.get(l.id)?.trim() || 'not named when the artist reviewed its own list';
      cut.push({ lens: l, reason });
      discovery.append('lens-cut', { lens: l, reason });
    }
  }

  return { proposed, kept, cut, degenerate };
}
