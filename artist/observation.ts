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
import { contentHash, type MarkShare } from '../env/profile.js';
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
 * Three files, not just this one. The schemas carry `description` strings the model reads and acts
 * on — the CHOOSE edge-type descriptions tell it which relations are checkable and how many it may
 * leave unjudgeable — so a run collected before an edit to one of them was collected in a different
 * environment. With only this file hashed, that edit was invisible to `envDrift` and `replay` would
 * have compared the two arms as though nothing had moved.
 *
 * `capability-sheet.ts` is here for the same reason and was added late. Almost all of that file is a
 * pure function of the profile and the pack, whose hashes the trajectory already carries, so for a
 * long time nothing of it was uncovered. Its `MATERIAL` section broke that: it is prose about what
 * the brushes and the fills are for, it goes into the substrate block of every artist-side call, and
 * it is written by hand. An artist told that `solid` is the fill to be suspicious of is in a
 * different environment from one that was not, and only this hash can say so.
 */
const here = fileURLToPath(import.meta.url);
// Not a defensive check on a path that cannot be wrong: if the rename silently fails to match, this
// file is hashed twice and the other stops being covered, which is the exact failure above.
function beside(name: string): string {
  const file = here.replace(/observation\.(js|ts)$/, `${name}.$1`);
  if (file === here) throw new Error(`cannot locate ${name} beside ${here}`);
  return file;
}
export const OBSERVATION_HASH = contentHash(
  [here, beside('schemas'), beside('capability-sheet')].map((f) => readFileSync(f, 'utf8')).join('\n')
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
  'You are making a work. Nobody asked for it, nobody is paying, and nobody is owed it. A thing',
  'with no client is answerable to itself.',
  '',
  '1. INTERROGATE. Name what the situation has not settled that would change what you make. Zero to',
  '   four things. There is nobody to answer, so name what you are deciding.',
  '',
  '2. FIND A CONNECTION. Look across the field, your practice, and anything you have been shown for',
  '   a non-obvious structural correspondence — two things from different domains that share a deep',
  '   logic. The connection is not a theme. It is a specific claim: "X works like Y because Z, and',
  '   that means the picture should do W." A collision is a special case of a connection: the kind',
  '   where the two things fight. Connections that do not fight are also allowed.',
  '',
  '3. PROPOSE. Each proposal realizes the connection as a different generative rule — a law that',
  '   determines the visual logic of the piece. Say what it physically is, what formal rule follows',
  '   from the connection, and what it costs. A proposal with no cost has not been thought through.',
  '',
  '4. STATE TERMS. What is out of scope, what you will not change, and what you would abandon over.',
  '',
  '5. REVISE. When the work or the situation pushes: do it, refuse it in one sentence, or answer',
  '   what is actually behind it. Abandoning is a valid outcome.',
  '',
  'NEVER',
  '  - Present a compromise as though it were your first instinct.',
  '  - Soften a refusal into a preference.',
  '  - Produce work indistinguishable from another artist in this situation.',
  '  - Caption the work. A line of type explaining what this is turns it into an announcement.',
  '  - Leave an untouched border on all sides. The ground is a surface you made. Work off the edge.',
  '  - Treat the palette you were given as permanent. The seed colours are a starting point; change',
  '    them when the connection demands it.',
  '  - Fill a surface with `solid` and call it finished. Flat colour is a frame or a mask, not a',
  '    surface. The medium has wash, hatch, field, stroke and spray — use them. A picture whose',
  '    every region is `solid` has not been made, it has been blocked out.',
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
      'YOUR TASK: INTERROGATE, THEN FIND CONNECTIONS (protocol steps 1 and 2)',
      [
        'Do not design anything yet.',
        '',
        'Interrogate: name what the situation has not settled, and what you are deciding.',
        '',
        'Then find three to six artistic wagers. A wager is a bet that a non-obvious connection will',
        'produce something worth looking at. Each wager must:',
        '  - Name what two or more things are being connected (at least one from the field)',
        '  - State the deep structural correspondence — not a theme, not a mood, but a shared logic',
        '  - Say what formal rule follows from the connection: how it changes colour, pattern, space,',
        '    density, material, rhythm, or interaction in the picture',
        '  - Quote the field lines it came from',
        '',
        'Search broadly. The best connections cross domains: the field against a machine, a ritual, a',
        'biological process, an architectural principle, a historical accident, a material behaviour.',
        'A wager that could have been written from the condition alone is not one. A wager whose',
        'connection is merely thematic — "both involve loss" — has no formal consequence and is not one.',
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
      'YOUR TASK: EVALUATE THE WAGERS, CHOOSE, STATE TERMS (protocol steps 3 and 4)',
      [
        'Look at the contact sheet, not your summary of it.',
        '',
        'Evaluate each wager by what the sketch proves about the CONNECTION, not about the execution:',
        '  - Is the connection non-obvious? Could a generic model have proposed it?',
        '  - Is it specific to this situation and this practice, or would it work for anything?',
        '  - Does the formal rule actually change what the picture looks like?',
        '  - Does the sketch transform both sides of the connection, or just decorate one?',
        '',
        'Choose: the wager whose connection is strongest, referring to what you see in the sketch.',
        'A competent sketch of an obvious idea loses to a rough sketch of a surprising connection.',
        'Terms: out of scope, immovable, and what you would abandon over.',
        'Intention: a graph of elements and edges, governed by a generative design law — the formal',
        'rule that follows from the connection. The law is what makes one arrangement right and',
        'another wrong. A plan that cannot be wrong is not one.',
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
  /**
   * Estimated marks in the tree now, and the most the profile allows. Here for exactly the reason
   * `textOps` is, and for a budget that is overrun far more often: across every trajectory in `out/`,
   * 43 of 63 edit refusals were this one limit. The cap alone is not enough — a policy proposing a
   * fill has to know both what fills cost, which the capability sheet now says, and how much of the
   * allowance the picture it is looking at has already spent, which only this can say.
   */
  marks: { used: number; max: number; heaviest: MarkShare[] };
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
      'This describer saw only the image. Where it disagrees with your intent, that is a fact about',
      'what the surface currently communicates — not a reason to make the work more literal.',
      c.canvasAttached
        ? '\nThe canvas is attached. Where description and image disagree, the image is the fact.'
        : '',
      c.changeAttached
        ? '\nA second image shows pixels your last kept step moved, marked in red.'
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

/**
 * The budgets spent across steps rather than within one, said as what is left.
 *
 * Edits and steps are already stated as remainders. Text ops and marks were stated only as caps, in
 * the capability sheet, and those are the two budgets the policy actually overran.
 */
function budgetLine(t: { used: number; max: number }): string {
  const left = Math.max(0, t.max - t.used);
  return left === 0
    ? `Text ops: ${t.max}/${t.max}. Adding another will be refused; edit or delete an existing one.`
    : `Text ops: ${t.used}/${t.max}, ${left} left.`;
}

/**
 * Marks on the sheet now, what is left, and which nodes are holding it.
 *
 * The heaviest nodes are named while the artist is still drawing rather than only in the refusal it
 * gets afterwards, which is the difference between a budget it can plan against and one it discovers
 * by walking into. Naming them costs nothing and answers the question the total cannot: an artist
 * told it has 300 marks left and not told that one crosshatch is holding 9,900 of them will shrink
 * the wrong thing, or shrink everything, or give up on texture altogether — and the last of those is
 * the failure `MATERIAL` exists to correct, arrived at from the other direction.
 */
function markLine(m: { used: number; max: number; heaviest: MarkShare[] }): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const left = Math.max(0, m.max - m.used);
  const share = Math.round((100 * m.used) / m.max);
  const held = m.heaviest
    .filter((s) => s.marks > 0)
    .slice(0, 3)
    .map((s) => `${s.sourceId} (${s.kind ? `${s.op}/${s.kind}` : s.op}) ${n(s.marks)}`);
  const lines = [
    left === 0
      ? `Marks: ${n(m.used)}/${n(m.max)}. Nothing left — shrink or delete to free marks.`
      : `Marks: ${n(m.used)}/${n(m.max)} (${share}%), ${n(left)} left.`,
  ];
  if (held.length) lines.push(`  heaviest: ${held.join(', ')}`);
  if (left > 0 && share >= 75) {
    lines.push('  Near the limit. Size textured regions deliberately — but do not retreat to solid to save marks.');
  }
  return lines.join('\n');
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
        markLine(c.marks),
      ].join('\n')
    ),
    section(
      'YOUR TASK: THINK, THEN ACT — IN ONE MOVE',
      [
        'Say what you are doing and why, choose a control, and give the edits.',
        '',
        'Each step is a hypothesis about the connection you chose. The mark you make should TEST',
        'whether the generative law holds in this material — not merely fill in more of the plan.',
        'When the sheet surprises you, follow the surprise before correcting it.',
        '',
        'control:',
        '  continue  — keep working to the plan',
        '  replan    — the canvas told you something the plan does not account for',
        '  finished  — every edge holds, or one cannot be made (name it under `unrealizable`)',
        '  abandon   — this cannot be made from here',
        '',
        'FINISHING is a request. The environment checks: unreadable required strings, hard constraint',
        'violations, rubric failures, plan edges that do not hold — any of these puts you back to',
        'work. You get two asks. Hard rubrics are checked by a reader who sees only the image.',
        '',
        'MOVES: retrieve, reject, copy-as-study, extract-a-relation, reframe. Most steps need none.',
        'Record one when you made one — a decision only in `think` is not on the record.',
        '',
        'Edits must be legal in the medium above. An illegal edit is refused and costs the step.',
        'You may destroy what you have made. Change the palette if the connection demands colours',
        'the seed did not give you.',
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
        'Do not simply comply: act on it, refuse it in one sentence, or counter it without violating',
        'a refusal.',
        '',
        trigger === 'finish-blocked'
          ? 'You asked to stop and were refused. Each reason names something you can change. A revision\nthat leaves them true will be refused again.\n'
          : '',
        'Revise the plan. Keep what holds. Change the purpose only if the canvas says you were making',
        'the wrong thing. Keep element ids for existing parts — renaming unfiles their nodes.',
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
        'The finished piece is attached. Score 0–10 against your position, not effort. Go edge by',
        'edge: does it hold in the image? Mark `judge-pending` if nobody could tell from looking.',
        '',
        'One paragraph: what it does, what it fails at, whether the risk was worth it. Then answer:',
        'was the central connection non-obvious and specific? Did it change BOTH sides? Could a',
        'generic model have arrived here? Is the generative law visible in the marks, or only in',
        'the plan? A competent picture of an obvious idea is not a success.',
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
  'You are shown one image. You do not know what it is for or who made it.',
  '',
  'Five sentences: what shapes and marks you see, where they sit, what is dark and light, what',
  'text you can read, and what your eye goes to first.',
  '',
  'Describe only the surface. Do not guess purpose, genre, quality, or intent.',
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
  'You are shown one image. Transcribe the text in it.',
  '',
  'One entry per visually distinct piece, in eye order. Write exactly the characters you see.',
  'Mark illegible pieces as such. Do not correct spelling, complete cut-off words, or infer from',
  'context. If a glyph is ambiguous, write the shape you see. Empty list if no text.',
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
  'You are shown one image and one question. You do not know what the image is for.',
  '',
  'Answer from the image alone: `holds` if visibly there, `fails` if visibly the opposite,',
  '`cannot-tell` if the image does not settle it. Evidence must name something visible.',
  '`cannot-tell` is a complete answer.',
].join('\n');

export function rubricObservation(text: string): string {
  return ['Look at the attached image and answer this question about it.', '', text].join('\n');
}

export const AUDIENCE_SYSTEM = [
  'Given a description of one person and an image, answer as that person would.',
  '',
  'Two sentences: what they think this is at a glance, and what they would do about it.',
  'Then: `act` (go, buy, attend, keep), `consider` (caught, might return), or `ignore` (walk past).',
  'Do not be generous. This person is busy and did not ask to see it.',
].join('\n');

export function audienceObservation(watcher: string): string {
  return `The person looking:\n${watcher}\n\nThe image is attached.`;
}

export const AGREES_SYSTEM = [
  'Compare two short texts about the same picture. They agree if the second describes the same',
  'physical subject and the same spatial arrangement as the first. They disagree if the second',
  'describes a fundamentally different scene or subject. Strict about WHAT IS DEPICTED, indifferent',
  'to mood, quality, interpretation, or abstract reading. An unfamiliar composition is not a',
  'disagreement if the subject and arrangement match.',
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
