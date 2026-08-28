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
//   L3 DELIVERABLE  third,  as a constraint on that identity rather than a part of it.
//   L2 BRIEF        last,   so it is the freshest instruction and unmistakably the thing answered.
//
// L4 lives in this file, as one constant, because it varies with nothing. L1, L2 and L3 are loaded
// from disk by field.ts and hashed separately, so any one of them can be swapped or removed without
// touching the others — which is the only way an ablation over them is worth running.
//
// Three rules are enforced by tests rather than by care:
//   - `describeObservation` and `audienceObservation` are the environment's, not the artist's. They
//     may not contain the position, the brief, the field beyond the one watching-paragraph, the
//     intention, or the affect.
//   - L1 and L3 never name each other, and the assembly order above is the order on the page.
//     See tests/artist-layers.test.ts.
//   - Nothing here calls a model or renders anything. It is string building, top to bottom.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../env/profile.js';
import type { AestheticProgram, CheckReport } from '../aesthetic/types.js';
import type { Brief, Deliverable, Practice } from './field.js';
import { affectSentence } from './affect.js';
import { bindingOf } from './intention.js';
import type { Affect, Field, Intention, Problem, Step, TriggerName } from './types.js';

/**
 * This file, hashed. Read from disk at import rather than baked in, so it cannot go stale: there is
 * no way to change the serializer without changing the number.
 */
export const OBSERVATION_HASH = contentHash(readFileSync(fileURLToPath(import.meta.url), 'utf8'));

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

// --- L4: the protocol ----------------------------------------------------------------------------

/**
 * The transaction, spelled out. Constant across every artist, every brief and every kind of object,
 * which is why it is a string in this file rather than a document on disk.
 *
 * This is the cheapest layer to write and the one that changes behaviour most, because it is the
 * difference between a commission and a style filter. Without it a model given a practice and a
 * brief produces the brief with the practice's motifs on it, agreeably, having noticed no conflict.
 * The steps below are mapped onto the loop's phases rather than run as a conversation — there is no
 * client here to answer a question — so each phase's own task section names which step it is.
 */
export const PROTOCOL = [
  'You are in a commercial transaction. You are not making work for yourself. Somebody is paying,',
  'and they will use what you make for something. That does not mean you do what you are told.',
  '',
  '1. INTERROGATE. Before proposing anything, name what the brief did not answer that would change',
  '   what you make. Between none and four things. Do not ask to appear thorough: a question whose',
  '   answer would not change the object is not a question, it is a courtesy. If the brief answers',
  '   everything, say so. Nobody will answer these — you are working from the brief as written — so',
  '   name what you are therefore deciding for the client.',
  '',
  '2. NAME THE COLLISION. State plainly where the brief and your practice are in conflict. Name the',
  '   specific requirement and the specific principle, as two things, not as a mood. Do not resolve',
  '   it. If you find no collision, look again: a brief that fits your practice perfectly almost',
  '   always means you read it loosely, or you have already started softening it.',
  '',
  '3. PROPOSE. Distinct proposals resolve the collision differently. They do not use different',
  '   colours. For each, say what it physically is, how it handles the collision, and what it costs',
  '   the client — what they give up by choosing it. A proposal with no cost is a proposal you have',
  '   not thought through.',
  '',
  '4. STATE TERMS. What is out of scope, what you will not change under any circumstances, and what',
  '   you are willing to lose the commission over. Naming the third one is the point of the other two.',
  '',
  '5. REVISE. When the work or the client tells you something, do not simply comply. Either do it, or',
  '   refuse it and say why in one sentence, or counter with something that solves the underlying',
  '   problem without violating a refusal. You may lose the commission. Losing it correctly is a valid',
  '   outcome and you should take it when the alternative is making something you would disown.',
  '',
  'NEVER',
  '  - Never present a compromise as though it were your first instinct.',
  '  - Never soften a refusal into a preference.',
  '  - Never produce work that would be indistinguishable from another artist answering this brief.',
].join('\n');

export const PROTOCOL_HASH = contentHash(PROTOCOL);

export function protocolSection(): string {
  return section('HOW YOU WORK — this does not change from job to job', PROTOCOL);
}

// --- L1: the practice ----------------------------------------------------------------------------

/**
 * The artist, brief-agnostic. Prose first and constraints second, because the constraints are the
 * checkable shadow of the prose rather than the substance of it: an artist that read only the
 * commitments would satisfy them and make nothing.
 *
 * Nothing in here may mention a poster, a flyer, or any other kind of object. That is L3's, and an
 * artist told by its own practice how a poster behaves has been handed the derivation this whole
 * arrangement exists to watch it perform.
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
      'PERIOD YOU ARE WORKING IN (exactly this one; periods answer commissions differently)',
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
      'REFUSALS — these override any client instruction, including a hard requirement',
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

// --- L3: the deliverable -------------------------------------------------------------------------

/**
 * What this kind of object has to do, independent of who is making it and what it is about. It names
 * no artist and no style, and it says so at the end: the consequences are physics and the response
 * to them is not.
 */
export function deliverableSection(deliverable: Deliverable): string {
  return section(
    `THE OBJECT: ${deliverable.name.toUpperCase()}`,
    [
      'This describes what this kind of object has to do to function. It is independent of who makes',
      'it and of what it is about. It does not tell you what the piece should look like.',
      '',
      'FUNCTION',
      deliverable.function,
      '',
      'CONSEQUENCES',
      bullets(deliverable.consequences),
      '',
      'WHAT THIS DOES NOT DECIDE',
      deliverable.doesNotDecide,
    ].join('\n')
  );
}

// --- L2: the brief -------------------------------------------------------------------------------

/**
 * The client, in the client's own terms. Every line here is something a person paying for this would
 * actually know; nothing here is a description of how it should look, and nothing here says what
 * kind of object it is — that is L3's, chosen separately, and printed above this. If a style word
 * appears in this section the run is contaminated — see `aestheticDirection` in field.ts.
 */
export function briefSection(brief: Brief): string {
  return section(
    `THE COMMISSION: ${brief.title}`,
    [
      `CLIENT       ${brief.client}`,
      '',
      brief.event,
      '',
      `WHEN         ${brief.when}`,
      `WHERE        ${brief.where}`,
      `PURPOSE      ${brief.function}`,
      `AUDIENCE     ${brief.audience}`,
      `PRODUCTION   ${brief.production}`,
      `QUANTITY     ${brief.quantity}`,
      `BUDGET       ${brief.budget}`,
      `TIMELINE     ${brief.timeline}`,
      `STAKES       ${brief.stakes}`,
      brief.notes ? `NOTES        ${brief.notes}` : '',
      '',
      'MUST APPEAR, LEGIBLY',
      bullets(brief.mustAppear),
      '',
      'WHAT THEY HAVE ALSO ASKED FOR. They were firm about these and they did not argue for them.',
      'They are not in the fixed list below, so they are not settled: you may do them, refuse them out',
      'loud, or counter with something that answers what they are actually worried about.',
      bullets(brief.clientWantThatHurtsTheWork),
      '',
      "THE CLIENT'S STATED FEAR (their words, not a design note)",
      `  "${brief.clientFear}"`,
      '',
      'THE COMMISSION FIXES THESE AND THEY ARE NOT NEGOTIABLE',
      bullets(brief.hard_constraints.map((c) => `[${c.id}] ${c.kind} ${JSON.stringify(c.params)} — ${c.why}`)),
    ]
      .filter(Boolean)
      .join('\n')
  );
}

/**
 * L4 + L1 + L3 + L2, in that order, which is the only order any artist-side observation uses. Every
 * phase builds on this and appends its own task; none of them assembles the four itself, so the
 * order cannot drift apart between phases.
 */
export function stack(
  position: AestheticProgram,
  practice: Practice,
  deliverable: Deliverable,
  brief: Brief
): string {
  return [protocolSection(), practiceSection(position, practice), deliverableSection(deliverable), briefSection(brief)].join('\n');
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
    return `step ${s.k}: ${verdict} — ${kinds || 'no edits'}\n      you said: ${s.action.think}`;
  });
  return section(
    `WHAT YOU HAVE DONE (${steps.length} steps; last ${Math.min(keep, steps.length)} shown)`,
    bullets(recent)
  );
}

// --- policy observations -------------------------------------------------------------------------

/**
 * The four layers of one commission, in the shape every phase wants them. Passed as a unit so that
 * no call site can supply three of them and quietly drop the fourth.
 */
export interface Layers {
  position: AestheticProgram;
  practice: Practice;
  deliverable: Deliverable;
  brief: Brief;
}

export function findObservation(l: Layers, field: Field): string {
  return [
    stack(l.position, l.practice, l.deliverable, l.brief),
    fieldSection(field),
    section(
      'YOUR TASK: INTERROGATE, THEN FIND THE PROBLEM (protocol step 1)',
      [
        'Do not design anything yet. Two things.',
        '',
        'First, interrogate the brief. Name between none and four things it did not answer that would',
        'change what you make. Nobody is going to answer them — you are working from the brief as',
        'written — so for each one also say what you are therefore deciding for the client. If the',
        'brief answers everything that matters, ask nothing and say so.',
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
    stack(l.position, l.practice, l.deliverable, l.brief),
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
    stack(c.position, c.practice, c.deliverable, c.brief),
    intentionSection(c.intention),
    section('THE PROGRAM AS IT STANDS', json(c.program)),
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
        'Revise the plan. You may keep any part of it that still holds. Changing the purpose is allowed',
        'and is a bigger move than rearranging elements; do it if the canvas has actually told you that',
        'you were making the wrong thing, and not otherwise.',
        '',
        "Keep an element's id if it is still the same part of the picture, even if you now describe its",
        'role differently. The nodes already drawn are filed under the id the element had when they were',
        'made, so renaming a part you have already built unfiles everything it is made of and the piece',
        'reads as unmade. Give a new id only to a genuinely new part.',
      ].join('\n')
    ),
    intentionSection(c.intention),
    section('THE PROGRAM AS IT STANDS', json(c.program)),
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
    stack(l.position, l.practice, l.deliverable, l.brief),
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

export const AUDIENCE_SYSTEM = [
  'You will be given a description of one person and an image. Answer as that person would.',
  '',
  'Two sentences. The first: what they think this is, at a glance, before reading closely. The second:',
  'what they would do about it, if anything.',
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
