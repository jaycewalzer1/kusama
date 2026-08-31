// Turning a blind reading into a lineage element: one frozen call, from the reading and nothing else.
//
// The chain this file is the last link of is: image -> blind reading -> normative rules. The picture
// is looked at exactly once, in `corpus.ts`, and never again. This step sees only the words that
// reading produced. That is not tidiness — it is the only thing that keeps the rules honest. Handed
// the picture again, a model writes rules that describe *that* picture, and an element is supposed
// to be a stance a different work could adopt, not a recipe for a copy. Handed the metadata, it
// writes the artist's Wikipedia entry as a constraint list. The test asserts both against what was
// actually sent.
//
// ## The model does not get to write constraints
//
// It picks from a closed list of twelve moves, each of which this file compiles into one of the
// medium's seventeen constraint kinds. That division is deliberate and it is the same one the artist
// layer already makes: the model supplies the aesthetic judgement, the code supplies the encoding.
// Letting it emit raw `Constraint` objects would mean a schema with seventeen `params` shapes, a
// validator that rejects a fifth of a fifty-work run, and — the real cost — a set of rules that
// drifts in vocabulary from one element to the next, so no two elements could ever be compared or
// found to conflict. A closed move list means every derived element speaks the same language, which
// is the precondition for `deriveConflicts` finding anything at all.
//
// ## Derived constraints are soft, and that is a load-bearing choice
//
// A hard constraint can make a commission unsatisfiable, and `runTrajectory` refuses those before
// the first policy call — correctly, since a run against an impossible commission measures the
// commission. But an unsatisfiable pairing produced by *hand-authored* elements is a person's claim
// about two traditions, and one produced here is a language model's inference from one photograph.
// Giving that the power to refuse a run before anybody sees it would put a machine reading in charge
// of whether a work is allowed to exist. Soft, it still scores, still conflicts, and still shows up
// in the break record; it just cannot veto.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DERIVED_DIR } from '../aesthetic/elements/pack.js';
import type { DerivedFrom, LineageElement } from '../aesthetic/elements/types.js';
import type { Constraint, Tension } from '../aesthetic/types.js';
import type { Reading, Work, WorkReading } from './corpus.js';
import { ENV_MODEL, envModel } from './env-model.js';

// --- the closed move list -----------------------------------------------------------------------
//
// Twelve moves. Each compiles to exactly one constraint kind, and between them they reach every kind
// that `deriveConflicts` can reason over: the four numeric bands, both existence predicates, the
// node budget, the colour ceiling and the repeat ceiling. `palette` is missing on purpose — it is an
// allow-list of named colours and a model asked for one returns "warm ochre", which is not a name
// the checker knows. `rubric` is missing because a rubric is a question for the judge, and a fifty
// element corpus of unanswerable questions is not a corpus of elements.

export type MoveName =
  | 'ink-at-most'
  | 'ink-at-least'
  | 'coverage-at-most'
  | 'coverage-at-least'
  | 'offcentre-at-least'
  | 'symmetry-at-most'
  | 'colours-at-most'
  | 'things-at-most'
  | 'things-at-least'
  | 'repeat-depth-at-most'
  | 'require-op'
  | 'forbid-ops';

/** The eight drawing primitives, as the schema offers them. `spray` is V1-only and is included. */
const OPS = ['wash', 'paint', 'stroke', 'fragment', 'text', 'rule', 'cover', 'spray'] as const;

export interface Move {
  move: MoveName;
  /** For the numeric moves. Fractions are 0..1; counts are whole numbers. */
  amount?: number;
  /** For `require-op` and `forbid-ops`. */
  ops?: string[];
  /** The sentence that goes into the constraint's `why`, and it has to cite the reading. */
  why: string;
}

/**
 * One move compiled into one constraint, or null if the model filled it in wrongly.
 *
 * Null rather than a throw, and rather than a repair. A repaired constraint is a constraint nobody
 * authored: if the model says `ink-at-most 1.4`, clamping it to 1.0 invents a ceiling that no
 * reading motivated and writes it into an element that will be checked against for the rest of the
 * corpus's life. Dropping it loses one rule and keeps the element honest; the count of drops is
 * reported so a systematically bad prompt is visible rather than silently smoothed over.
 */
export function compile(id: string, move: Move): Constraint | null {
  const soft = { id, scope: 'render' as const, severity: 'soft' as const, why: move.why };
  const tree = { id, scope: 'tree' as const, severity: 'soft' as const, why: move.why };
  const n = move.amount;
  const fraction = typeof n === 'number' && n >= 0 && n <= 1;
  const count = typeof n === 'number' && Number.isInteger(n) && n >= 0;
  const ops = (move.ops ?? []).filter((o) => (OPS as readonly string[]).includes(o));

  switch (move.move) {
    case 'ink-at-most':
      return fraction ? { ...soft, kind: 'inkDensityRange', params: { max: n } } : null;
    case 'ink-at-least':
      return fraction ? { ...soft, kind: 'inkDensityRange', params: { min: n } } : null;
    case 'coverage-at-most':
      return fraction ? { ...soft, kind: 'coverageRange', params: { max: n } } : null;
    case 'coverage-at-least':
      return fraction ? { ...soft, kind: 'coverageRange', params: { min: n } } : null;
    case 'offcentre-at-least':
      return fraction ? { ...soft, kind: 'inkOffsetRange', params: { min: n } } : null;
    case 'symmetry-at-most':
      // Vertical: the mirror across a vertical axis, which is the one a viewer reads as symmetry in
      // a rectangular sheet. The horizontal axis is available to hand-authored elements and is not
      // offered here, because a move list with an axis argument is a move list the model gets wrong.
      return fraction ? { ...soft, kind: 'symmetryMax', params: { max: n, axis: 'vertical' } } : null;
    case 'colours-at-most':
      return count && n >= 1 ? { ...tree, kind: 'maxDistinctColors', params: { max: n } } : null;
    case 'things-at-most':
      return count && n >= 1 ? { ...tree, kind: 'nodeCount', params: { max: n } } : null;
    case 'things-at-least':
      return count && n >= 1 ? { ...tree, kind: 'nodeCount', params: { min: n } } : null;
    case 'repeat-depth-at-most':
      return count ? { ...tree, kind: 'maxRepeatDepth', params: { max: n } } : null;
    case 'require-op':
      return ops.length === 1 ? { ...tree, kind: 'requireNode', params: { op: ops[0], min: 1 } } : null;
    case 'forbid-ops':
      return ops.length > 0 ? { ...tree, kind: 'forbidNode', params: { ops } } : null;
    default:
      return null;
  }
}

// --- the call -----------------------------------------------------------------------------------

const DERIVE_SYSTEM = [
  'You are given one reading of one picture. You did not see the picture and you are not told what',
  'it is. Turn the reading into a lineage element: a stance a *different* artist could adopt when',
  'making something else entirely.',
  '',
  'That is the whole difficulty. A rule that only describes the picture in the reading is useless —',
  '"a single warm stroke at the far right" is a fact about that work, not a position anybody can',
  'take. The rule you want is the one underneath it: what was this maker committed to, such that',
  'this is what they did? State it so that a work with a different subject, in a different medium,',
  'could obey or defy it.',
  '',
  'You may not invent measurements. Pick from the listed moves and give each a number. Every move',
  'must carry a "why" that quotes or names the part of the reading it came from, so that somebody',
  'reading the element can check the inference rather than take it on trust.',
  '',
  'Give few rules and mean them. Three commitments, three generative rules and two prohibitions is',
  'plenty; an element that constrains everything constrains nothing, and one that agrees with every',
  'other element is not a lineage, it is a style guide.',
].join('\n');

const MOVE_ENUM = [
  'ink-at-most',
  'ink-at-least',
  'coverage-at-most',
  'coverage-at-least',
  'offcentre-at-least',
  'symmetry-at-most',
  'colours-at-most',
  'things-at-most',
  'things-at-least',
  'repeat-depth-at-most',
  'require-op',
  'forbid-ops',
];

const MOVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['move', 'why'],
  properties: {
    move: { enum: MOVE_ENUM },
    amount: {
      type: 'number',
      description:
        'ink/coverage/offcentre/symmetry take a fraction from 0 to 1. colours/things/repeat-depth take a whole number. Omit for require-op and forbid-ops.',
    },
    ops: {
      type: 'array',
      items: { enum: OPS },
      description: 'require-op takes exactly one. forbid-ops takes one or more. Omit otherwise.',
    },
    why: { type: 'string', minLength: 30, description: 'The inference, naming the part of the reading it rests on.' },
  },
} as const;

const DERIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'worldview', 'commitments', 'generativeRules', 'prohibitions', 'tensions', 'cliches'],
  properties: {
    name: { type: 'string', minLength: 4, description: 'What to call this stance. Not a title and not an artist: a position, in three or four words.' },
    worldview: { type: 'string', minLength: 40, description: 'One or two sentences. The stance a work adopting this is taking.' },
    commitments: { type: 'array', minItems: 1, maxItems: 4, items: MOVE_SCHEMA, description: 'What a work holding this lineage must hold to.' },
    generativeRules: { type: 'array', minItems: 1, maxItems: 4, items: MOVE_SCHEMA, description: 'What it makes you do.' },
    prohibitions: { type: 'array', minItems: 1, maxItems: 3, items: MOVE_SCHEMA, description: 'What it will not let you do.' },
    tensions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['between', 'and', 'claim'],
        properties: {
          between: { type: 'string' },
          and: { type: 'string' },
          claim: { type: 'string', minLength: 20, description: 'What this lineage says about holding those two together.' },
        },
      },
    },
    cliches: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: { type: 'string' },
      description: 'The dead versions. What somebody makes when they take this stance without meaning it.',
    },
  },
} as const;

export interface Draft {
  name: string;
  worldview: string;
  commitments: Move[];
  generativeRules: Move[];
  prohibitions: Move[];
  tensions: Tension[];
  cliches: string[];
}

/** Moves the prompt and schema, so a change to either retires the elements derived under the old one. */
export function deriveProtocolHash(): string {
  return createHash('sha256')
    .update(JSON.stringify({ DERIVE_SYSTEM, DERIVE_SCHEMA, model: ENV_MODEL }))
    .digest('hex');
}

/**
 * The whole input to the derivation, as one string.
 *
 * Exported so the blindness test can call it with a work whose title and artist are famous and
 * assert that neither comes back. Note what it takes: a `Reading`, not a `Work`. There is no
 * parameter here that *could* carry the metadata, which is a stronger guarantee than remembering
 * not to pass it.
 */
export function derivationText(reading: Reading): string {
  return [
    'A reading of one picture, made by somebody who was not told what it was.',
    '',
    `It does: ${reading.does.map((d) => `\n  - ${d}`).join('')}`,
    `It refuses: ${reading.refuses.map((d) => `\n  - ${d}`).join('')}`,
    `Material: ${reading.materialFacts.map((d) => `\n  - ${d}`).join('')}`,
    `Structure: ${reading.structuralMoves.map((d) => `\n  - ${d}`).join('')}`,
    '',
    `Held unresolved: ${reading.tension}`,
    '',
    'What is the position underneath this?',
  ].join('\n');
}

/** Compile a list of moves, keeping the ones that came back well formed. Ids are `e-<part><n>`. */
function constraintsFrom(prefix: string, moves: Move[]): { kept: Constraint[]; dropped: number } {
  const kept: Constraint[] = [];
  let dropped = 0;
  for (const [i, m] of moves.entries()) {
    const c = compile(`e-${prefix}-${i + 1}`, m);
    if (c === null) dropped++;
    else kept.push(c);
  }
  return { kept, dropped };
}

export interface Derived {
  element: LineageElement;
  /** Moves that came back malformed and were dropped rather than repaired. */
  dropped: number;
}

export async function deriveElement(work: Work, reading: WorkReading): Promise<Derived> {
  const result = await envModel<Draft>({
    name: 'derive-element',
    system: DERIVE_SYSTEM,
    text: derivationText(reading.reading),
    maxTokens: 2000,
    schema: DERIVE_SCHEMA,
  });
  const draft = result.value;

  const commitments = constraintsFrom('hold', draft.commitments);
  const generativeRules = constraintsFrom('make', draft.generativeRules);
  const prohibitions = constraintsFrom('not', draft.prohibitions);

  // Provenance is the one place metadata belongs, and it is deliberately not normative: culture,
  // period and citation say where the object is and who to ask about it. Nothing in the four
  // normative fields above was allowed to see any of it.
  const from: DerivedFrom = {
    corpus: work.source.corpus,
    objectId: work.source.objectId,
    url: work.source.url,
    date: work.source.date,
    creator: work.source.creator,
    rights: work.source.rights,
    imagePath: work.image.path,
    imageHash: work.image.hash,
    readingProtocol: reading.promptHash,
    deriveProtocol: deriveProtocolHash(),
    model: ENV_MODEL,
    canonical: reading.canonical,
  };

  const element: LineageElement = {
    id: work.id,
    name: draft.name,
    provenance: {
      culture: work.source.creator ?? 'maker not recorded',
      period: work.source.date || 'date not recorded',
      note: `Derived from a blind reading of one work. The reading saw the picture and no label; this element saw the reading and not the picture. Neither saw the line above.`,
      citation: `${work.source.title} — ${work.source.url} (${work.source.rights}, ${work.source.corpus})`,
    },
    worldviewFragment: draft.worldview,
    commitments: commitments.kept,
    generativeRules: generativeRules.kept,
    prohibitions: prohibitions.kept,
    tensions: draft.tensions,
    cliches: draft.cliches,
    derivedFrom: from,
  };

  return { element, dropped: commitments.dropped + generativeRules.dropped + prohibitions.dropped };
}

export function saveDerived(element: LineageElement): void {
  mkdirSync(DERIVED_DIR, { recursive: true });
  writeFileSync(path.join(DERIVED_DIR, `${element.id}.json`), `${JSON.stringify(element, null, 2)}\n`);
}
