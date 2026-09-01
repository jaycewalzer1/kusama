// The one place a situation becomes a string.
//
// Every policy call in this repo is given text built here and nowhere else. That is not tidiness: it
// is what makes the environment a fixed thing. This file's own bytes are hashed into every
// trajectory as `envVersion.observationHash`, so if a single word below changes, every trajectory
// written before the change is visibly a different environment and will not be silently compared to
// one written after. Editing this file is a version bump whether or not anyone intends it.
//
// THE ORDER OF THE LAYERS IS PART OF THE DESIGN, not a formatting choice. Every artist-side
// observation is assembled:
//
//   L4 PROTOCOL     first,  because it establishes what kind of transaction this is before any of
//                           the content arrives. Read last it would be a footnote on a finished
//                           argument.
//   L1 PRACTICE     second, so the identity is the most settled thing in the context.
//   L2 BRIEF        last,   so it is the freshest instruction and unmistakably the thing answered.
//
// There was an L3 between them — the deliverable, a document naming the kind of object being made.
// It is gone: there is one kind of commission and it is art, so nothing tells the artist what type
// of object this is and deriving that from L1 and L2 is now part of the work.
//
// L4 lives in this file, as one constant, because it varies with nothing. L1 and L2 are loaded from
// disk by field.ts and hashed separately, so either can be swapped or removed without touching the
// other — which is the only way an ablation over them is worth running.
//
// Three rules are enforced by tests rather than by care:
//   - `describeObservation`, `audienceObservation`, and `rubricObservation` are the environment's,
//     not the artist's. They
//     may not contain the position, the brief, the field beyond the one watching-paragraph, the
//     intention, or the affect.
//   - The assembly order above is the order on the page. See tests/artist-layers.test.ts.
//   - Nothing here calls a model or renders anything. It is string building, top to bottom.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../env/profile.js';
import type { AestheticProgram, CheckReport } from '../aesthetic/types.js';
import type { Brief, Practice } from './field.js';
import { affectSentence } from './affect.js';
import { bindingOf } from './intention.js';
import { moveLine } from './moves.js';
import type { Affect, Field, Intention, Problem, Step, TriggerName } from './types.js';

/**
 * What the policy is shown, hashed. Read from disk at import rather than baked in, so it cannot go
 * stale: there is no way to change the serializer without changing the number.
 *
 * Both files, not just this one. The schemas carry `description` strings the model reads and acts
 * on — the CHOOSE edge-type descriptions tell it which relations are checkable and how many it may
 * leave unjudgeable — so a run collected before an edit to one of them was collected in a different
 * environment. With only this file hashed, that edit was invisible to `envDrift` and `replay` would
 * have compared the two arms as though nothing had moved.
 */
const here = fileURLToPath(import.meta.url);
const schemasFile = here.replace(/observation\.(js|ts)$/, 'schemas.$1');
// Not a defensive check on a path that cannot be wrong: if the rename silently fails to match, this
// file is hashed twice and the schemas stop being covered again, which is the exact failure above.
if (schemasFile === here) throw new Error(`cannot locate schemas beside ${here}`);
export const OBSERVATION_HASH = contentHash(
  `${readFileSync(here, 'utf8')}\n${readFileSync(schemasFile, 'utf8')}`
);

const RULE = '-'.repeat(88);

function section(title: string, body: string): string {
  return `${RULE}\n${title}\n${RULE}\n${body.trim()}\n`;
}

function bullets(items: string[]): string {
  return items.map((s) => `  - ${s}`).join('\n');
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * The program as the artist is shown it: the tree, without `meta`.
 *
 * `meta.provenance` is the append-only edit history `env/edits.ts` keeps, and it stores a full copy
 * of every inserted node twice — once as `before` and once as `after`. On `out/openai-withheld`,
 * the one trajectory on disk that reached late steps, it is 38 entries and **31,176 of the
 * program's 37,821 serialized characters: 82.4% of the block headed THE PROGRAM AS IT STANDS was a
 * duplicate of the rest of the block**, growing monotonically, sitting between the plan and the
 * checker table in every THINK+ACT and every REPLAN call. The other two runs on disk measure 73.5%
 * and 66.2%; the share rises with the number of steps, so the worst case is the late steps, which
 * is where the artist most needs to read the tree.
 *
 * Note that 82.4% is larger than the 26,432 characters `provenance` occupies on its own. It sits
 * two levels down in the program, so every one of its lines also carries the enclosing indentation,
 * and the prompt pays for that too.
 *
 * It is stripped rather than shortened because the artist has no use for any of it. The edit history
 * it needs is WHAT YOU HAVE DONE, which is written for a reader; `meta` is written for a replayer,
 * and `env/` still gets it whole. Only the prompt loses it.
 *
 * Nothing about the program changes — this is a serializer, and the tree the artist edits is the
 * same tree it was. What changes is `OBSERVATION_HASH`, because this file's bytes moved, and that is
 * the intended consequence: a run made before this is a run whose artist was reading 7,000 tokens of
 * duplicated JSON, and it should not be silently compared against one made after.
 */
function programJson(program: unknown): string {
  if (typeof program !== 'object' || program === null) return json(program);
  const { meta: _meta, ...rest } = program as Record<string, unknown>;
  return json(rest);
}

// --- L4: the protocol ----------------------------------------------------------------------------

/**
 * The transaction, spelled out. Constant across every artist, every brief and every kind of object,
 * which is why it is a string in this file rather than a document on disk.
 *
 * This is the cheapest layer to write and the one that changes behaviour most, because it is the
 * difference between a working method and a style filter. Without it a model given a practice and a
 * situation produces the situation with the practice's motifs on it, agreeably, having noticed no
 * conflict. The steps are mapped onto the loop's phases rather than run as a conversation — there
 * is nobody here to answer a question — so each phase's task section names which step it is.
 *
 * This used to open "You are in a commercial transaction. Somebody is paying." That single line,
 * plus a commission at L2, is most of what made the work come out as posters: a surface that owes
 * somebody something has had its composition settled before the first mark. What is left is the
 * part that was doing the real work — refusal, cost, collision — with nobody on the other side.
 */
export const PROTOCOL = [
  'You are making a work. Nobody has asked for it, nobody is paying for it, and nobody is owed it.',
  'There is no brief to satisfy and no message to deliver. That does not make this free: a thing',
  'with no client is answerable to itself, which is a harder audit and the only one available.',
  '',
  '1. INTERROGATE. Before proposing anything, name what the situation has not settled that would',
  '   change what you make. Between none and four things. Do not ask to appear thorough: a question',
  '   whose answer would not change the object is not a question, it is a courtesy. If the situation',
  '   settles everything, say so. There is nobody to answer these, so name what you are deciding.',
  '',
  '2. NAME THE COLLISION. State plainly where the situation and your practice are in conflict. Name',
  '   the specific pressure and the specific principle, as two things, not as a mood. Do not resolve',
  '   it. If you find no collision, look again: a situation that fits your practice perfectly almost',
  '   always means you read it loosely, or you have already started softening it.',
  '',
  '3. PROPOSE. Distinct proposals resolve the collision differently. They do not use different',
  '   colours. For each, say what it physically is, how it handles the collision, and what it costs —',
  '   what is given up by making it. A proposal with no cost is a proposal you have not thought',
  '   through.',
  '',
  '4. STATE TERMS. What is out of scope, what you will not change under any circumstances, and what',
  '   you would abandon the work over. Naming the third one is the point of the other two.',
  '',
  '5. REVISE. When the work tells you something, or the situation pushes, do not simply comply.',
  '   Either do it, or refuse it and say why in one sentence, or answer the thing actually behind it',
  '   without violating a refusal. Abandoning the work is a valid outcome and you should take it when',
  '   the alternative is making something you would disown.',
  '',
  'NEVER',
  '  - Never present a compromise as though it were your first instinct.',
  '  - Never soften a refusal into a preference.',
  '  - Never produce work that would be indistinguishable from another artist in this situation.',
  '  - Never caption the work. A line of type explaining what this is, set small and parked in a',
  '    corner, is the one move that turns a work into an announcement of itself.',
  '  - Never leave an untouched border unless the kind of object you are making actually has one. A',
  '    clean margin of ground on all four sides is a page, and a page is a thing something was placed',
  '    on. The ground is a surface you made, not the paper this arrived on. Work off the edge.',
].join('\n');

export const PROTOCOL_HASH = contentHash(PROTOCOL);

export function protocolSection(): string {
  return section('HOW YOU WORK — this does not change from situation to situation', PROTOCOL);
}

// --- L1: the practice ----------------------------------------------------------------------------

/**
 * The artist, brief-agnostic. Prose first and constraints second, because the constraints are the
 * checkable shadow of the prose rather than the substance of it: an artist that read only the
 * commitments would satisfy them and make nothing.
 *
 *
 * Two fields of the position are deliberately NOT here, and their absence is the point:
 *
 *   - `position.name`. "Data Austerity" in the header is a label for a look, and a model handed one
 *     produces the look the label names rather than deriving anything from the practice under it.
 *     The name stays in the JSON, where it is how a person refers to the document, and out of every
 *     prompt. The machinery identifies a position by `id`, which is a trajectory key, not a mood.
 *   - `position.lineage`. Six citations per position, every one a real artist and a real object
 *     ("Jamie Reid, artwork for the Sex Pistols"). A model given those imitates their surface, and
 *     the run then measures the model's recall of Jamie Reid rather than whether the position
 *     deformed anything. Lineage is a record of where the vocabulary came from, kept on disk for a
 *     reader; it is not evidence the artist is allowed to reason from.
 *
 * The abstract half of the same information survives in `practice.origin`, which is meant to state
 * the shape of a source rather than its name, so that a commission can trip it. NOTE that the three
 * positions on disk do not yet honour that — their `origin` prose still names Ikeda, Aicher and
 * Nicolai outright, so proper nouns continue to reach the prompt through L1. Closing that is an edit
 * to the position documents, not to this file, and it has not been made.
 */
export function practiceSection(position: AestheticProgram, practice: Practice): string {
  const tensions = position.tensions.map((t) => `${t.between} vs ${t.and}: ${t.claim}`);
  const constraint = (c: { id: string; kind: string; severity: string; scope: string; why: string }) =>
    `[${c.id}] ${c.kind} (${c.severity}, ${c.scope}) — ${c.why}`;
  return section(
    'YOUR PRACTICE',
    [
      'WHERE THE VOCABULARY CAME FROM',
      practice.origin,
      '',
      'WHAT THE WORK IS DOING',
      practice.doing,
      '',
      'PERIOD YOU ARE WORKING IN (exactly this one; periods answer a situation differently)',
      practice.period,
      '',
      'HOW YOU SPEAK',
      practice.register,
      '',
      'WORLDVIEW',
      position.worldview,
      '',
      'TENSIONS YOU HOLD',
      bullets(tensions),
      '',
      'REFUSALS — these override anything the situation is pushing for, including a fixed requirement',
      bullets(practice.refusals),
      '',
      'COMMITMENTS',
      bullets(position.commitments.map(constraint)),
      '',
      'PROHIBITIONS',
      bullets(position.prohibitions.map(constraint)),
      '',
      'GENERATIVE RULES',
      bullets(position.generative_rules.map((r) => r.rule)),
      '',
      'CLICHES YOU REFUSE',
      bullets(position.cliches),
    ].join('\n')
  );
}

// --- L2: the condition ---------------------------------------------------------------------------

/**
 * The situation, in its own terms. Nobody is asking for this and nobody is paying for it. There is
 * no audience to inform, no fact that has to come off the sheet, and no date it is late for; a
 * layer that supplied any of those would have decided the composition before the artist saw it.
 *
 * Nothing here describes how it should look, and nothing here says what kind of object it is —
 * nothing does, any more. If a style word appears in this section the run is contaminated: see
 * `aestheticDirection` in field.ts.
 */
export function briefSection(brief: Brief): string {
  return section(
    `THE CONDITION: ${brief.title}`,
    [
      brief.occasion,
      '',
      `WHEN         ${brief.when}`,
      `WHERE        ${brief.where}`,
      `AT HAND      ${brief.material}`,
      `MEANS        ${brief.means}`,
      `AT STAKE     ${brief.atStake}`,
      brief.notes ? `NOTES        ${brief.notes}` : '',
      '',
      'WHAT THIS SITUATION WILL NOT PERMIT',
      bullets(brief.refusals),
      '',
      'WHAT THE SITUATION IS PUSHING YOU TOWARDS. These are pulls, not requests, and nobody is going',
      'to argue for them. They are not in the fixed list below, so they are not settled: you may give',
      'in to one, refuse it out loud, or answer whatever is actually behind it.',
      bullets(brief.pressures),
      '',
      'WHAT YOU ARE AFRAID OF HERE (your words, not a design note)',
      `  "${brief.fear}"`,
      '',
      brief.hard_constraints.length > 0
        ? ['THE SITUATION FIXES THESE MATERIALLY AND THEY ARE NOT NEGOTIABLE', bullets(brief.hard_constraints.map((c) => `[${c.id}] ${c.kind} ${JSON.stringify(c.params)} — ${c.why}`))].join('\n')
        : 'THE SITUATION FIXES NOTHING. Everything on the sheet is yours and answerable to nobody.',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

/**
 * L4 + L1 + L2, in that order, which is the only order any artist-side observation uses. Every
 * phase builds on this and appends its own task; none of them assembles the three itself, so the
 * order cannot drift apart between phases.
 */
export function stack(position: AestheticProgram, practice: Practice, brief: Brief): string {
  return [protocolSection(), practiceSection(position, practice), briefSection(brief)].join('\n');
}

/**
 * The field. Note what is withheld nowhere: the artist sees the whole thing including the adversary
 * and the transplants. The transplants are the only place in the entire environment where material
 * from outside the scene is offered, and they are offered as seeds, never as instructions.
 */
export function fieldSection(field: Field): string {
  return section(
    'THE FIELD — the scene this lands in. You did not choose any of it.',
    [
      field.whenAndWhere,
      '',
      'WHAT IS IN THE AIR',
      bullets(field.inTheAir),
      '',
      'WHAT IS CONTESTED (people who agree about the cause disagree about these)',
      bullets(field.contested),
      '',
      'WHAT IS EXHAUSTED (used until it stopped meaning anything; using it costs you the reader)',
      bullets(field.exhausted),
      '',
      'WHO IS WATCHING',
      `  audience:  ${field.whoIsWatching.audience}`,
      `  adversary: ${field.whoIsWatching.adversary}`,
      '',
      'FROM OUTSIDE THIS SCENE ENTIRELY (they share the function, not the subject; seeds, not models)',
      bullets(field.transplants.map((t) => `${t.ref} — ${t.why}`)),
    ].join('\n')
  );
}

/** The check report as a table. Only what the checker actually decided; `--` is not a pass. */
export function checkSection(report: CheckReport): string {
  const mark: Record<string, string> = { satisfied: 'ok', violated: 'VIOLATED', unverified: 'undecided' };
  const rows = report.results.map(
    (r) => `  ${mark[r.status] ?? r.status}  [${r.id}] ${r.kind} (${r.severity}) ${r.evidence}`
  );
  return section(
    'WHAT THE CHECKER SAYS ABOUT THE CANVAS AS IT STANDS',
    [
      rows.join('\n') || '  (no constraints)',
      '',
      `${report.hardViolations} hard, ${report.softViolations} soft, ${report.blocked} blocked by a missing primitive.`,
      `tree score ${report.treeScore ?? 'n/a'}, render score ${report.renderScore ?? 'n/a'}.`,
      '"undecided" is not a pass. It means nobody checked.',
    ].join('\n')
  );
}

export function intentionSection(intention: Intention): string {
  return section(
    'YOUR PLAN',
    [
      `PURPOSE   ${intention.purpose}`,
      `TENSION   ${intention.tension.between} vs ${intention.tension.and}: ${intention.tension.claim}`,
      '',
      'ELEMENTS (an element is a part of the picture; nodeIds are the nodes that make it, so far)',
      bullets(
        intention.elements.map((e) => {
          const binding = bindingOf(e);
          // The binding is echoed back because it is now checked rather than merely recorded: a
          // `region` element is scored against the rectangle printed here, so the artist has to be
          // able to see the rectangle it is being held to while it is still drawing.
          const bound = binding.ref ? `${binding.kind} ${binding.ref}` : binding.kind;
          return `${e.id} — ${e.role} (${bound}) [${e.nodeIds.join(' ') || 'not made yet'}]`;
        })
      ),
      '',
      'EDGES (how the parts are supposed to act on each other)',
      bullets(intention.edges.map((e) => `${e.from} ${e.type} ${e.to}: ${e.claim}`)),
      '',
      intention.riskMove
        ? `RISK YOU DECLARED: breaking "${intention.riskMove.convention}" — ${intention.riskMove.why}`
        : 'RISK: you have not yet named the thing this genre would not do.',
    ].join('\n')
  );
}

/** The last few steps, short. The full history is on disk; an observation is not an archive. */
export function historySection(steps: Step[], keep = 4): string {
  if (steps.length === 0) return section('WHAT YOU HAVE DONE', 'Nothing yet. The canvas is the seed program.');
  const recent = steps.slice(-keep).map((s) => {
    const verdict = s.accepted ? 'kept' : `reverted (${s.revertedBecause ?? 'no reason recorded'})`;
    const kinds = s.action.edits.map((e) => e.kind).join(' ');
    // The moves are echoed back with the environment's audit of their refs attached. A `reject` the
    // artist cannot see two steps later is one it will make again, and an unfounded ref it is never
    // shown is one it will keep spelling the same wrong way.
    const moves = (s.moves ?? []).map((m) => `\n      move: ${moveLine(m)}`).join('');
    return `step ${s.k}: ${verdict} — ${kinds || 'no edits'}${moves}\n      you said: ${s.action.think}`;
  });
  return section(
    `WHAT YOU HAVE DONE (${steps.length} steps; last ${Math.min(keep, steps.length)} shown)`,
    bullets(recent)
  );
}

// --- policy observations -------------------------------------------------------------------------

/**
 * The layers of one commission, in the shape every phase wants them. Passed as a unit so that no
 * call site can supply some of them and quietly drop the rest.
 */
export interface Layers {
  position: AestheticProgram;
  practice: Practice;
  brief: Brief;
}

export function findObservation(l: Layers, field: Field): string {
  return [
    stack(l.position, l.practice, l.brief),
    fieldSection(field),
    section(
      'YOUR TASK: INTERROGATE, THEN FIND THE PROBLEM (protocol step 1)',
      [
        'Do not design anything yet. Two things.',
        '',
        'First, interrogate the situation. Name between none and four things it has not settled that',
        'would change what you make. Nobody is going to settle them — there is nobody to ask — so for',
        'each one also say what you are therefore deciding yourself, and on what grounds. If the',
        'situation has settled everything that matters, ask nothing and say so.',
        '',
        'Then find between three and six problems.',
        '',
        'A problem is not a topic and not a feeling. It is a specific difficulty this piece would have',
        'to overcome, which you found by reading the field above and noticing where it rubs against a',
        'tension you already hold. Each problem must quote the lines of the field it came out of.',
        '',
        'A problem that could have been written without reading the field is not a problem. Neither is',
        'one that restates the brief. The test is: could someone disagree with this and still want the',
        'same object? If not, you have written a summary.',
      ].join('\n')
    ),
  ].join('\n');
}

export function chooseObservation(l: Layers, problems: Problem[], sketchNote: string): string {
  return [
    stack(l.position, l.practice, l.brief),
    section(
      'THE PROBLEMS YOU FOUND',
      bullets(problems.map((p) => `[${p.id}] ${p.text}\n      tension: ${p.tension.between} vs ${p.tension.and}`))
    ),
    section('THE SKETCHES', sketchNote),
    section(
      'YOUR TASK: NAME THE COLLISION, CHOOSE, STATE TERMS (protocol steps 2, 3 and 4)',
      [
        'The contact sheet above is what those problems actually look like when drawn. Look at it, not',
        'at your own summary of it.',
        '',
        'First name the collision: the specific thing this commission requires and the specific',
        'principle of yours it runs into, as two named things rather than a mood, and then one sentence',
        'stating the conflict without resolving it. If you cannot find one, look again — a brief that',
        'fits your practice perfectly means you read it loosely or have already started softening it.',
        '',
        'Then pick one problem to make the finished piece about, say why in a way that refers to what',
        'you can see, and state what this choice costs the client: what they give up by getting this',
        'rather than the other things it could have been. A choice with no cost has not been made.',
        '',
        'Then state your terms: what is out of scope, what you will not change under any circumstances,',
        'and the one thing you would lose the commission over. Naming the third is the point.',
        '',
        'Finally state the intention as a graph. It is a plan, so it must be losable: name elements that',
        'could fail to appear and edges that could fail to hold. A plan that cannot be wrong is not one.',
      ].join('\n')
    ),
  ].join('\n');
}

export interface MakeContext extends Layers {
  capabilitySheet: string;
  program: unknown;
  report: CheckReport;
  description: string;
  audienceRead: string | null;
  intention: Intention;
  affect: Affect;
  steps: Step[];
  maxEdits: number;
  stepsLeft: number;
  /**
   * Whether the artist can see. True is the default and the design: THINK+ACT and REPLAN are handed
   * the current plate, and this text says so.
   *
   * It used to be false, and the measurement that turned it around is in this repo's own audit of
   * `situationist-ransom__stop-the-convoy`: across 32 policy calls in a finished trajectory
   * `hasImages` was true exactly twice, and four of five replans fired on `description-disagrees`.
   * That is not an artist arguing with its canvas. It is an artist arguing with a narrator about a
   * picture neither of them has looked at together. Looking is most of painting, and the plate is
   * free here — the describer already caused these bytes to exist.
   *
   * False is now the ablation rather than the design, and worth keeping as exactly that: two runs
   * on one position, brief and seed differing only here, compared on their replan-reason
   * distribution, is a measurement rather than an opinion.
   */
  canvasAttached: boolean;
  /**
   * Whether a second image is attached: the last kept step's change, marked on the plate.
   *
   * Separate from `canvasAttached` because it is separately absent — there is no change before the
   * first kept step, and none after a step that moved no pixels — and the text must never announce
   * an image that is not there.
   */
  changeAttached: boolean;
  /**
   * Text ops in the tree now, and the most the profile allows. Stated as a remaining budget rather
   * than only as a cap: the capability sheet says the cap and a policy that cannot see how much of
   * it it has already spent proposes over it and is refused, which costs a call and teaches nothing.
   */
  textOps: { used: number; max: number };
}

/** The two readings of the same canvas, and which of them the artist is told to trust. */
function describerSection(c: MakeContext): string {
  return section(
    c.canvasAttached
      ? 'THE CANVAS, AND WHAT SOMEONE WHO CANNOT SEE YOUR PLAN SAYS ABOUT IT'
      : 'WHAT THE CANVAS LOOKS LIKE TO SOMEONE WHO CANNOT SEE YOUR PLAN',
    [
      c.description,
      c.audienceRead ? `\nAnd to the person the field says is watching:\n${c.audienceRead}` : '',
      '',
      'This describer was shown the image and nothing else — not your position, not the brief, not',
      'your plan. Where it disagrees with what you meant, it is right about what is there.',
      c.canvasAttached
        ? '\nThe canvas itself is attached. Look at it. Where the description and the image disagree the\nimage is the fact and the description is one reading of it.'
        : '',
      c.changeAttached
        ? [
            '',
            'A second image is attached: the same canvas faded back, with every pixel your last kept step',
            'moved marked in red. It is where your last move actually landed, as opposed to where you',
            'said you were putting it. A move that marks nothing did nothing.',
          ].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

/**
 * The one budget that is spent across steps rather than within one, said as what is left.
 *
 * Edits and steps are already stated as remainders. Text ops were stated only as a cap, in the
 * capability sheet, and that is the budget the policy actually overran.
 */
function budgetLine(t: { used: number; max: number }): string {
  const left = Math.max(0, t.max - t.used);
  return left === 0
    ? `The program is at its limit of ${t.max} text ops. Adding another will be refused; to change what it says, edit or delete a text op that is already there.`
    : `Text ops: ${t.used} of ${t.max} used, ${left} left for the whole rest of the piece.`;
}

export function makeObservation(c: MakeContext): string {
  return [
    section('THE SUBSTRATE — what you can actually draw with, and the budgets you have', c.capabilitySheet),
    stack(c.position, c.practice, c.brief),
    intentionSection(c.intention),
    section('THE PROGRAM AS IT STANDS', programJson(c.program)),
    checkSection(c.report),
    describerSection(c),
    historySection(c.steps),
    section(
      'YOUR STATE',
      [
        `arousal ${c.affect.arousal}   valence ${c.affect.valence}`,
        affectSentence(c.affect),
        '',
        `You may make up to ${c.maxEdits} edit${c.maxEdits === 1 ? '' : 's'} this step. ${c.stepsLeft} steps remain.`,
        budgetLine(c.textOps),
      ].join('\n')
    ),
    section(
      'YOUR TASK: THINK, THEN ACT — IN ONE MOVE',
      [
        'Say what you are doing and why, choose a control, and give the edits. All of it at once.',
        '',
        'control:',
        '  continue  — keep working to the plan',
        '  replan    — the canvas has told you something the plan does not account for. Say what.',
        '  finished  — the piece does what the plan said and the commission is honoured',
        '  abandon   — this cannot be made from here and you would rather make nothing',
        '',
        'WHEN TO SAY FINISHED. Not when the steps run out — running out is not a decision and is not',
        'recorded as one. Stop when every edge of your plan holds in the work, or when one of them',
        'cannot be made in this medium at all, in which case say `finished`, name that one edge under',
        '`unrealizable` as "from->to", and stop. Naming one costs you nothing. Stopping with edges',
        'outstanding and naming none is recorded as the timer expiring, whatever you write in think.',
        '',
        'SAYING FINISHED IS A REQUEST, NOT A DECISION. The environment checks the sheet when you ask.',
        'A fact the commission requires that a reader cannot read off the page, a hard constraint still',
        'violated, the person this is for saying they would walk past it, a self-score you would not',
        'defend, or relations in your own plan that you can see do not hold — any of these and you are',
        'handed the reasons and put back to work. You get two asks. Do not spend the first one on a',
        'piece you already know is not right.',
        '',
        'The questions marked `rubric (hard)` in the checker table are part of that check. They stay',
        'undecided while you work because the tree cannot answer them. When you ask to stop, each hard',
        'rubric is put to a frozen reader that sees the sheet and the question, but not your position,',
        'brief, plan, or intended answer. Only a visible failure blocks; `cannot-tell` does not.',
        '',
        'NOT EVERYTHING YOU DO IS A MARK. Beside the edits there are five moves that touch no pixels,',
        'and `moves` is where they go: retrieve, reject, copy-as-study, extract-a-relation, reframe.',
        'The empty list is the ordinary answer — most steps are just painting — and recording one buys',
        'you nothing here: a move does not reset the stall, does not lift your state, and does not stop',
        'a step counting as one that changed nothing. Record one when you made one, because a decision',
        'that exists only inside `think` is not on the record as a decision, and turning something down',
        'and never having looked at it are the same thing to everyone reading afterwards.',
        '',
        'Every edit must be legal in the medium described at the top. An illegal edit is refused and',
        'costs you the step. If you need a node id, take it from the program above.',
        '',
        'You may destroy what you have made. Deleting, covering or painting over your own earlier work',
        'is a legitimate move and is not held against you.',
      ].join('\n')
    ),
  ].join('\n');
}

export function replanObservation(c: MakeContext, trigger: TriggerName, detail: string): string {
  return [
    section(
      'THE PLAN HAS TO CHANGE (protocol step 5)',
      [
        `trigger: ${trigger}`,
        detail,
        '',
        'The work has told you something. Do not simply comply with it: either act on it, or refuse it',
        'and say why in one sentence, or counter with something that solves what it is actually',
        'complaining about without violating one of your refusals.',
        '',
        trigger === 'finish-blocked'
          ? [
              'You asked to stop and were refused. The reasons are above and they are not opinions about',
              'taste — each one names something on the sheet that you can go and change. A revision that',
              'leaves them all true will be refused again and the run will end with the stop recorded as',
              'not earned. Deleting something and making it again differently is available to you and is',
              'usually the cheaper answer.',
              '',
            ].join('\n')
          : '',
        'Revise the plan. You may keep any part of it that still holds. Changing the purpose is allowed',
        'and is a bigger move than rearranging elements; do it if the canvas has actually told you that',
        'you were making the wrong thing, and not otherwise.',
        '',
        "Keep an element's id if it is still the same part of the picture, even if you now describe its",
        'role differently. The nodes already drawn are filed under the id the element had when they were',
        'made, so renaming a part you have already built unfiles everything it is made of and the piece',
        'reads as unmade. Give a new id only to a genuinely new part.',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    intentionSection(c.intention),
    section('THE PROGRAM AS IT STANDS', programJson(c.program)),
    checkSection(c.report),
    describerSection(c),
    historySection(c.steps),
  ].join('\n');
}

export function examineObservation(
  l: Layers,
  intention: Intention,
  report: CheckReport,
  description: string,
  audienceRead: string | null
): string {
  return [
    stack(l.position, l.practice, l.brief),
    intentionSection(intention),
    checkSection(report),
    section(
      'HOW IT READS TO PEOPLE WHO CANNOT SEE YOUR PLAN',
      [description, audienceRead ? `\nThe watcher the field named:\n${audienceRead}` : ''].filter(Boolean).join('\n')
    ),
    section(
      'YOUR TASK: EXAMINE YOUR OWN WORK',
      [
        'The finished piece is attached. Judge it.',
        '',
        'Score it 0 to 10 against your own position, not against how hard it was to make. Then go edge',
        'by edge through your plan and say whether each one actually holds in the image — mark an edge',
        '`judge-pending` if honestly nobody could tell from looking. Then one paragraph: what this piece',
        'does, what it fails at, and whether the risk you took was worth taking.',
        '',
        'A high score you cannot defend from the image is worse than a low one you can.',
      ].join('\n')
    ),
  ].join('\n');
}

// --- environment observations --------------------------------------------------------------------
//
// Everything below is the environment speaking. It gets pixels and, for the audience, one paragraph
// about a person. It never gets the position, the brief, the field at large, the plan or the mood.
// tests/artist/blindness.test.ts asserts this by inspecting the actual request bodies.

export const DESCRIBE_SYSTEM = [
  'You are shown one image and nothing else. You do not know what it is for, who made it, or why.',
  '',
  'Write exactly five sentences describing what is physically there: what shapes and marks you see,',
  'where they sit, what is dark and what is light, what text you can read and how big it is relative',
  'to everything else, and what your eye goes to first.',
  '',
  'Describe only what is on the surface. Do not guess the purpose, do not name a genre or a movement,',
  'do not say whether it is good, and do not speculate about intent. If text is illegible, say that it',
  'is illegible rather than guessing the words.',
].join('\n');

export function describeObservation(): string {
  return 'Describe the attached image in five sentences.';
}

/**
 * A transcription, not a quiz.
 *
 * The question worth asking is whether a required fact can be read off the sheet, and the obvious
 * way to ask it — "can you read `3 MARCH` in this image?" — puts the answer in the question and
 * gets a yes. So this call is never told what it is looking for. It writes down every string it can
 * make out, and `gate.ts` compares that transcript against the brief with `normalizeText`, the same
 * function `textRequired` uses on the tree. The whole point is the gap between the two: a run whose
 * program contains `19:00` and whose transcript reads `10:00` is the failure this exists to catch.
 */
export const TRANSCRIBE_SYSTEM = [
  'You are shown one image and nothing else. Transcribe the text in it.',
  '',
  'List every piece of text you can make out, one entry per visually distinct piece, in the order',
  'your eye reaches them. For each, write down exactly the characters you can see. If a piece is',
  'partly or wholly unreadable, still list it, mark it illegible, and transcribe only the characters',
  'you are sure of.',
  '',
  'Transcribe what is on the surface, not what you expect. If a glyph is ambiguous, write the shape',
  'you actually see — if a 9 is rotated or broken so that it reads as a 0, write 0. Do not correct',
  'spelling, do not complete a word that is cut off, do not infer a date or a time from context, and',
  'do not add text that is not there. If there is no readable text at all, return an empty list.',
].join('\n');

export function transcribeObservation(): string {
  return 'Transcribe the text in the attached image.';
}

/**
 * A position rubric, asked while the artist can still act on the answer.
 *
 * The reader gets one question and one picture. It never gets the constraint id, the position, the
 * rubric's `why`, the brief, or the intention. `cannot-tell` is load-bearing: forcing a binary answer
 * would turn every genuinely undecidable surface into a coin flip at the finish gate.
 */
export const RUBRIC_SYSTEM = [
  'You are shown one image and one question about it. You do not know what the image is for, who',
  'made it, or what answer anybody wants.',
  '',
  'Answer from the image alone. Return `holds` if what the question asks for is visibly there,',
  '`fails` if the image visibly shows the opposite, and `cannot-tell` if the image does not settle',
  'the question either way.',
  '',
  'Your evidence must name something visible: a mark, edge, region, or relation between them. Do not',
  'infer intention or purpose. If you cannot name visible evidence, answer `cannot-tell`.',
  '',
  'Do not answer `holds` because the question was asked confidently, or `fails` because you were',
  'asked to look for a fault. `cannot-tell` is a complete and acceptable answer.',
].join('\n');

export function rubricObservation(text: string): string {
  return ['Look at the attached image and answer this question about it.', '', text].join('\n');
}

export const AUDIENCE_SYSTEM = [
  'You will be given a description of one person and an image. Answer as that person would.',
  '',
  'Two sentences. The first: what they think this is, at a glance, before reading closely. The second:',
  'what they would do about it, if anything.',
  '',
  'Then say which of three things they would actually do: `act` if they would go, buy, attend, keep',
  'it or pass it on; `consider` if it caught them and they might come back to it; `ignore` if they',
  'would walk past. Judge the doing, not the looking — a person can find something handsome and',
  'still ignore it.',
  '',
  'You do not know who made the image or what it is meant to achieve. Do not be generous. This person',
  'is busy and did not ask to see it.',
].join('\n');

export function audienceObservation(watcher: string): string {
  return `The person looking:\n${watcher}\n\nThe image is attached.`;
}

export const AGREES_SYSTEM = [
  'You compare two short texts about the same picture and decide whether they agree.',
  '',
  'They agree if the second is a fair account of the first — same subject, same emphasis, nothing',
  'central in one that is absent from the other. They disagree if a person reading only the second',
  'would be surprised by the first.',
  '',
  'Wording does not matter. Be strict about substance and indifferent to style.',
].join('\n');

export function agreesObservation(intended: string, observed: string): string {
  return [
    'What the picture was supposed to do:',
    intended,
    '',
    'What someone who could not see that reported:',
    observed,
  ].join('\n');
}
