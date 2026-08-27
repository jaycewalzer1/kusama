// The one place a situation becomes a string.
//
// Every policy call in this repo is given text built here and nowhere else. That is not tidiness: it
// is what makes the environment a fixed thing. This file's own bytes are hashed into every
// trajectory as `envVersion.observationHash`, so if a single word below changes, every trajectory
// written before the change is visibly a different environment and will not be silently compared to
// one written after. Editing this file is a version bump whether or not anyone intends it.
//
// Two rules are enforced by tests rather than by care:
//   - `describeObservation` and `audienceObservation` are the environment's, not the artist's. They
//     may not contain the position, the brief, the field beyond the one watching-paragraph, the
//     intention, or the affect. See tests/artist/blindness.test.ts.
//   - Nothing here calls a model or renders anything. It is string building, top to bottom.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../env/profile.js';
import type { AestheticProgram, CheckReport } from '../aesthetic/types.js';
import type { Brief } from './field.js';
import { affectSentence } from './affect.js';
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

// --- shared sections -----------------------------------------------------------------------------

/** The position, as the artist reads it. Prose parts included; they are the point of a position. */
export function positionSection(position: AestheticProgram): string {
  const tensions = position.tensions.map((t) => `${t.between} vs ${t.and}: ${t.claim}`);
  const constraint = (c: { id: string; kind: string; severity: string; scope: string; why: string }) =>
    `[${c.id}] ${c.kind} (${c.severity}, ${c.scope}) — ${c.why}`;
  return section(
    `POSITION: ${position.name}`,
    [
      position.worldview,
      '',
      'LINEAGE',
      bullets(position.lineage.map((l) => `${l.ref} — ${l.why}`)),
      '',
      'TENSIONS YOU HOLD',
      bullets(tensions),
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

export function briefSection(brief: Brief): string {
  return section(
    `BRIEF: ${brief.title}`,
    [
      brief.event,
      '',
      `WHEN      ${brief.when}`,
      `WHERE     ${brief.where}`,
      `FUNCTION  ${brief.function}`,
      `STAKES    ${brief.stakes}`,
      brief.notes ? `NOTES     ${brief.notes}` : '',
      '',
      'THE COMMISSION FIXES THESE AND THEY ARE NOT NEGOTIABLE',
      bullets(brief.hard_constraints.map((c) => `[${c.id}] ${c.kind} ${JSON.stringify(c.params)} — ${c.why}`)),
    ]
      .filter(Boolean)
      .join('\n')
  );
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
      bullets(intention.elements.map((e) => `${e.id} — ${e.role} [${e.nodeIds.join(' ') || 'not made yet'}]`)),
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

export function findObservation(position: AestheticProgram, brief: Brief, field: Field): string {
  return [
    positionSection(position),
    briefSection(brief),
    fieldSection(field),
    section(
      'YOUR TASK: FIND THE PROBLEM',
      [
        'Do not design anything yet. Find between three and six problems.',
        '',
        'A problem is not a topic and not a feeling. It is a specific difficulty this piece would have',
        'to overcome, which you found by reading the field above and noticing where it rubs against a',
        'tension you already hold. Each problem must quote the lines of the field it came out of.',
        '',
        'A problem that could have been written without reading the field is not a problem. Neither is',
        'one that restates the brief. The test is: could someone disagree with this and still want the',
        'same poster? If not, you have written a summary.',
      ].join('\n')
    ),
  ].join('\n');
}

export function chooseObservation(position: AestheticProgram, brief: Brief, problems: Problem[], sketchNote: string): string {
  return [
    positionSection(position),
    briefSection(brief),
    section(
      'THE PROBLEMS YOU FOUND',
      bullets(problems.map((p) => `[${p.id}] ${p.text}\n      tension: ${p.tension.between} vs ${p.tension.and}`))
    ),
    section('THE SKETCHES', sketchNote),
    section(
      'YOUR TASK: CHOOSE',
      [
        'The contact sheet above is what those problems actually look like when drawn. Look at it, not',
        'at your own summary of it. Pick one problem to make the finished piece about, say why in a way',
        'that refers to what you can see, and then state the intention as a graph.',
        '',
        'The intention is a plan, so it must be losable. Name elements that could fail to appear and',
        'edges that could fail to hold. A plan that cannot be wrong is not a plan.',
      ].join('\n')
    ),
  ].join('\n');
}

export interface MakeContext {
  capabilitySheet: string;
  position: AestheticProgram;
  brief: Brief;
  program: unknown;
  report: CheckReport;
  description: string;
  audienceRead: string | null;
  intention: Intention;
  affect: Affect;
  steps: Step[];
  maxEdits: number;
  stepsLeft: number;
}

export function makeObservation(c: MakeContext): string {
  return [
    section('THE MEDIUM', c.capabilitySheet),
    positionSection(c.position),
    briefSection(c.brief),
    intentionSection(c.intention),
    section('THE PROGRAM AS IT STANDS', json(c.program)),
    checkSection(c.report),
    section(
      'WHAT THE CANVAS LOOKS LIKE TO SOMEONE WHO CANNOT SEE YOUR PLAN',
      [
        c.description,
        c.audienceRead ? `\nAnd to the person the field says is watching:\n${c.audienceRead}` : '',
        '',
        'This describer was shown the image and nothing else — not your position, not the brief, not',
        'your plan. Where it disagrees with what you meant, it is right about what is there.',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    historySection(c.steps),
    section(
      'YOUR STATE',
      [
        `arousal ${c.affect.arousal}   valence ${c.affect.valence}`,
        affectSentence(c.affect),
        '',
        `You may make up to ${c.maxEdits} edit${c.maxEdits === 1 ? '' : 's'} this step. ${c.stepsLeft} steps remain.`,
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
      'THE PLAN HAS TO CHANGE',
      [
        `trigger: ${trigger}`,
        detail,
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
    section('WHAT IT LOOKS LIKE TO SOMEONE WHO CANNOT SEE YOUR PLAN', c.description),
    historySection(c.steps),
  ].join('\n');
}

export function examineObservation(
  position: AestheticProgram,
  brief: Brief,
  intention: Intention,
  report: CheckReport,
  description: string,
  audienceRead: string | null
): string {
  return [
    positionSection(position),
    briefSection(brief),
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
