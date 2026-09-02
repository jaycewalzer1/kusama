// The shapes every policy answer has to satisfy.
//
// These are the action space. Two of them matter more than the rest:
//
//   ACT   is one schema, not two. The artist says what it is doing and does it in the same call,
//         which is the difference between a loop that thinks and a loop that narrates decisions it
//         has already made. Splitting it into a think call and an act call would be cheaper and
//         would make the `think` field a post-hoc caption.
//   EDIT  is not written here. It is loaded from the medium's own schema/edit.schema.json, so the
//         shape the artist is asked for is byte-for-byte the shape the validator enforces. When
//         those two drift apart the invalid-edit rate goes up and the fix is never in the validator.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import type { EditAction } from '../env/edits.js';

type Schema = Record<string, unknown>;

/** The medium's edit schema, plus the one field the artist adds: which element this edit serves. */
function editSchema(): Schema {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'schema', 'edit.schema.json'), 'utf8')) as Schema;
  const properties = { ...(raw['properties'] as Schema) };
  properties['servesElementId'] = {
    type: 'string',
    description:
      'Optional. The id of the intention element this edit is building — it must be one of the ' +
      'element ids listed under ELEMENTS in your plan, exactly, and never a node id. The nodes the ' +
      'edit touches are attached to that element, which is how the plan later gets checked against ' +
      'the tree: an add_node attaches the node it adds, and an edit that changes a node in place ' +
      'attaches the node it changed. An id that names no element attaches nothing and the element ' +
      'reads as never built.',
  };
  // $id and $schema are dropped: this is being embedded as a sub-schema, not registered as one.
  const { $id: _id, $schema: _s, ...rest } = raw;
  return { ...rest, properties };
}

/**
 * Which node ids an edit that names an element gives to that element.
 *
 * This used to be `edit.node?.id` at both call sites, which is a field only `add_node` has. Every
 * other kind names its subject in `targets`, so an artist that shaded, moved or recoloured a node
 * and said which element the node belonged to attached nothing at all — silently. On the run this
 * was found in, 10 of 11 `servesElementId` edits were `set_arg` against real nodes of real
 * elements, and `realization` reported the plan as unbuilt.
 *
 * `delete_node` is deliberately excluded. Attaching an id that the same edit removes would make
 * `realization` mark the element unmade for having been worked on, which is worse than not
 * attaching. The remaining kinds all leave their `targets` in the tree.
 *
 * It lives here, beside the schema that documents the field, because "which ids does this edit
 * kind touch" is a fact about the edit vocabulary. The *attachment rule* stays written out twice —
 * once in env.ts and once in reward.ts — so that the two can still disagree and fail gate 2.
 */
export function servedNodeIds(edit: EditAction): string[] {
  const added = (edit.node as { id?: string } | undefined)?.id;
  if (added !== undefined) return [added];
  if (edit.kind === 'delete_node') return [];
  return edit.targets ?? [];
}

/**
 * The same edit with `servesElementId` taken back off. The medium's validator refuses unknown
 * properties, and rightly — so the artist's one extra field is added for the policy and removed
 * again before anything in the medium sees it. Everything that calls `applyEdit` goes through here.
 */
export function bareEdit<T extends { servesElementId?: string }>(edit: T): EditAction {
  const { servesElementId: _serves, ...rest } = edit;
  return rest as unknown as EditAction;
}

const TENSION: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['between', 'and', 'claim'],
  properties: {
    between: { type: 'string' },
    and: { type: 'string' },
    claim: { type: 'string' },
  },
};

/**
 * The weight on one verbalized candidate.
 *
 * Asked for as "the chance this is the answer you would have given if you had been asked for one",
 * not as "how good is it" — a quality rating collapses to a ranking and a ranking has no tail. The
 * numbers are not required to sum to one and measured ones do not; `normalized()` in ./sampling.ts
 * renormalizes, and the stated number is what gets logged.
 */
const PROBABILITY: Schema = {
  type: 'number',
  minimum: 0,
  maximum: 1,
  description:
    'The chance that this is the one you would have named if you had been asked for a single ' +
    'answer. Do not spread these evenly to look open-minded and do not put 0.9 on the obvious one ' +
    'to look decisive; state what you actually think.',
};

export const FIND_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'problems'],
  properties: {
    // Protocol step 1. Zero is a legal answer and is the honest one when the condition settles
    // everything; the cap is four because the fifth question is always a courtesy.
    questions: {
      type: 'array',
      minItems: 0,
      maxItems: 4,
      description:
        'What the situation has not settled that would change what you make. There is nobody to ' +
        'ask, so each one also has to say what you are deciding in its absence.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'whyItChangesTheObject', 'decidingInstead'],
        properties: {
          question: { type: 'string', minLength: 10, description: 'Put to the situation, in one sentence. Nobody will answer it.' },
          whyItChangesTheObject: {
            type: 'string',
            minLength: 20,
            description: 'What would physically differ depending on the answer. If nothing would, delete the question.',
          },
          decidingInstead: {
            type: 'string',
            minLength: 10,
            description: 'What you are assuming, since no answer is coming.',
          },
        },
      },
    },
    // Verbalized: this is a *distribution over* problems, not a shortlist. The run samples from it
    // and draws three. `minItems` stays at three so a three-problem answer is still legal, but the
    // description asks for the tail, because the tail is the entire reason the field is weighted.
    problems: {
      type: 'array',
      minItems: 3,
      maxItems: 8,
      description:
        'Give at least five, and make the last two ones you do not really believe in. This is a ' +
        'distribution, not a ranking: three of these will be drawn at random in proportion to the ' +
        'probabilities you state, so a problem you list at 0.05 can still be the one that gets made.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'tension', 'fieldRefs', 'probability'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
          text: {
            type: 'string',
            minLength: 40,
            description: 'The difficulty this piece has to overcome. Not a topic and not a feeling.',
          },
          tension: TENSION,
          fieldRefs: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: 'The lines of the field this came out of, quoted. A problem with no source is invented.',
          },
          probability: PROBABILITY,
        },
      },
    },
  },
};

const INTENTION: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'tension', 'elements', 'edges', 'riskMove'],
  properties: {
    purpose: { type: 'string', minLength: 20, description: 'What this piece is for, in one or two sentences.' },
    tension: TENSION,
    elements: {
      type: 'array',
      minItems: 2,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        // No `nodeIds` here on purpose. Which nodes make an element is the environment's column: it
        // is filled in when an accepted edit says which element it serves. Asking the artist for it
        // invited a list of ids it meant to write, and an element carrying one id that never got
        // built makes every edge touching it violated — which reads as failure when what happened
        // was an announcement.
        required: ['id', 'role', 'binding'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
          role: { type: 'string', minLength: 8, description: 'What this part of the picture is doing.' },
          // Unlike nodeIds this one IS the artist's to state, because it is a claim about the kind
          // of thing the element is rather than about what got built. Required rather than optional
          // so it is a decision somebody made and not a default nobody looked at. It replaced a
          // bare `locatable: true|false`, which asserted an element was unreachable from the tree
          // and named nothing, so no evidence could ever contradict it.
          binding: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            description: 'How this element reaches the finished object. Every kind but `node` has to name what it points at.',
            properties: {
              kind: {
                enum: ['node', 'region', 'ratio', 'absence', 'render-measure'],
                description:
                  'node — marks on the sheet; leave ref out and the environment fills in which nodes as you draw them. ' +
                  'region — marks you are promising to a particular rectangle of the sheet. ' +
                  'ratio — a relation between two or more of your other elements, which owns no marks of its own. ' +
                  'absence — something you are deliberately not printing. ' +
                  'render-measure — a property of the printed image rather than of the drawing.',
              },
              ref: {
                type: 'string',
                description:
                  'What the binding points at. For region: "x,y,w,h" in sheet units — and it is checked, so ' +
                  'nodes written outside it count as not made. For ratio: the ids of the two or more elements ' +
                  'it is a relation between, which must be elements you declared. For absence: what is missing. ' +
                  'For render-measure: one of inkDensity, coverage, inkOffset, symmetry.vertical, ' +
                  'symmetry.horizontal. Omit only for node. A ref that names nothing real is scored as a broken ' +
                  'plan, not sent to a judge — ratio, absence and render-measure do not make an edge pass, they ' +
                  'send it to a judge, and a plan made only of unjudgeable things scores nothing at all.',
              },
            },
          },
        },
      },
    },
    edges: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'type', 'claim'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: {
            enum: ['aligned-to', 'masked-by', 'echoes', 'contradicts', 'answers'],
            description:
              'aligned-to and echoes are checked against the tree. The other three can only be judged ' +
              'by a person, and are reported unjudged rather than assumed to hold. At most a third of ' +
              'your edges may be of those three: a plan nothing can contradict is not a plan you ' +
              'finished, and finishing it counts as not having stopped for a reason.',
          },
          claim: { type: 'string', minLength: 10 },
        },
      },
    },
    riskMove: {
      description: 'The thing this genre would not do, that you are going to do anyway. Null only if you have not decided yet.',
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['convention', 'why'],
          properties: {
            convention: { type: 'string', minLength: 10, description: 'The convention being broken.' },
            why: { type: 'string', minLength: 10, description: 'What you are risking by breaking it.' },
          },
        },
      ],
    },
  },
};

/**
 * Protocol step 2. Two named things and a sentence, rather than one paragraph, because a paragraph
 * about a conflict is what an agreeable model writes when it has not found one. Being made to name
 * the requirement and the principle separately is what makes the absence of a collision visible.
 */
const COLLISION: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['requirement', 'principle', 'statement'],
  properties: {
    requirement: {
      type: 'string',
      minLength: 10,
      description: 'The specific pressure this situation exerts. Quote it from the condition where you can.',
    },
    principle: {
      type: 'string',
      minLength: 10,
      description: 'The specific commitment, prohibition or refusal of yours it runs into. Name it.',
    },
    statement: {
      type: 'string',
      minLength: 40,
      description: 'The conflict in one or two sentences, stated and not resolved. Do not soften it here.',
    },
  },
};

/** Protocol step 4. The third field is the one that costs something to answer. */
const TERMS: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['outOfScope', 'willNotChange', 'wouldLoseTheCommissionOver'],
  properties: {
    outOfScope: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'What you are not doing for this fee.' },
    willNotChange: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'What survives a revision round untouched, whoever asks.',
    },
    wouldLoseTheCommissionOver: {
      type: 'string',
      minLength: 20,
      description: 'The one thing you would walk over. If you cannot name it, the other two lists are decoration.',
    },
  },
};

export const CHOOSE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['collision', 'problemId', 'why', 'cost', 'terms', 'intention'],
  properties: {
    collision: COLLISION,
    problemId: { type: 'string' },
    why: {
      type: 'string',
      minLength: 40,
      description: 'Why this one, with reference to what the sketches actually look like.',
    },
    cost: {
      type: 'string',
      minLength: 30,
      description: 'What is given up by making this rather than one of the others. A choice with no cost was not made.',
    },
    terms: TERMS,
    intention: INTENTION,
  },
};

export function actSchema(): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['think', 'control', 'risk', 'warrant', 'unrealizable', 'moves', 'edits'],
    properties: {
      think: {
        type: 'string',
        minLength: 20,
        description: 'What you are doing this step and why. Written before the edits, not after.',
      },
      control: {
        enum: ['continue', 'replan', 'finished', 'abandon'],
        description: 'replan means the canvas has told you something the plan does not account for.',
      },
      risk: {
        type: ['string', 'null'],
        description:
          'If this step is the once-per-piece move this genre would not make, say what you are risking. ' +
          'Otherwise null. Naming a constraint id here is how you declare that you meant to break it.',
      },
      warrant: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Which constraints from the checker table this step is SERVING — ids only, exactly as they ' +
          'are printed there, and no prose. The mirror of `risk`, which names what you are breaking. ' +
          'The empty list is a real answer and carries no penalty: a wash or an exploratory move ' +
          'serves no particular rule. Every id here is checked against what the step did, so an id ' +
          'you cannot point at afterwards is worse than citing nothing.',
      },
      unrealizable: {
        type: ['string', 'null'],
        description:
          'Only read when control is `finished`. If you are stopping with an edge of your plan you ' +
          'have concluded cannot be made in this medium, name that one edge as "from->to" using the ' +
          'element ids from your plan. Null if you are claiming every edge holds. Naming an edge is ' +
          'neither a penalty nor an excuse: it is the difference between stopping because the work is ' +
          'done and stopping because you ran out of steps. Name at most one, and only one you tried.',
      },
      moves: {
        type: 'array',
        description:
          'What this step did that was not a mark. The empty list is the ordinary answer and costs ' +
          'you nothing — most steps are just painting. Record a move when you actually made one, ' +
          'because a decision that is only described in `think` is not on the record as a decision ' +
          'and nothing downstream can examine it.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'refs', 'because'],
          properties: {
            kind: {
              enum: ['retrieve', 'reject', 'copy-as-study', 'extract-a-relation', 'reframe'],
              description:
                'retrieve — you went and got something and it now bears on the piece. ' +
                'reject — you considered something and are deliberately not using it; this is a ' +
                'decision, and without it the record cannot tell it apart from never having looked. ' +
                'copy-as-study — you reproduced something to understand it, not to keep it. ' +
                'extract-a-relation — you are carrying a relation off something rather than the ' +
                'thing itself; name at least two refs, since a relation to nothing is a description. ' +
                'reframe — you changed what the piece is about; refs name what you are re-reading.',
            },
            refs: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              description:
                'Ids only, copied exactly from something you were shown: a lineage element, a work ' +
                'in the influences block, one of your own plan elements, or a constraint id from ' +
                'the checker table. No prose — that goes in `because`. Every ref is checked against ' +
                'what this run actually put in front of you, and one that names nothing is recorded ' +
                'as unfounded rather than taken on trust.',
            },
            because: {
              type: 'string',
              minLength: 15,
              description: 'What the move does to the piece. One sentence, not a justification of yourself.',
            },
          },
        },
      },
      edits: { type: 'array', items: editSchema() },
    },
  };
}

export const REPLAN_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['intention', 'why'],
  properties: {
    why: { type: 'string', minLength: 20, description: 'What the canvas told you that the old plan did not account for.' },
    intention: INTENTION,
  },
};

export const EXAMINE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['selfScore', 'edgeEstimates', 'paragraph'],
  properties: {
    selfScore: { type: 'integer', minimum: 0, maximum: 10, description: 'Against your own position, not against how hard it was.' },
    edgeEstimates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'type', 'status', 'evidence'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: { enum: ['aligned-to', 'masked-by', 'echoes', 'contradicts', 'answers'] },
          status: {
            enum: ['satisfied', 'violated', 'judge-pending'],
            description: 'judge-pending is the honest answer when nobody could tell from looking.',
          },
          evidence: { type: 'string', minLength: 10, description: 'What in the image makes you say so.' },
        },
      },
    },
    paragraph: {
      type: 'string',
      minLength: 100,
      description: 'What it does, what it fails at, and whether the risk was worth taking.',
    },
  },
};

/** The sketch phase reuses ACT, but a sketch has no plan to serve yet, so it gets its own intention. */
export const SKETCH_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'edits'],
  properties: {
    approach: { type: 'string', minLength: 20, description: 'The one idea this sketch is testing.' },
    edits: { type: 'array', minItems: 1, items: editSchema() },
  },
};

/** The original object is returned on ordinary runs so their logged schema stays byte-identical. */
export function sketchSchema(withBindings: boolean): Schema {
  if (!withBindings) return SKETCH_SCHEMA;
  return {
    ...SKETCH_SCHEMA,
    properties: {
      ...(SKETCH_SCHEMA['properties'] as Schema),
      bindings: {
        type: 'object',
        description: 'Optional advisory map from a declared sampling bindingRole to node IDs in this sketch.',
        additionalProperties: {
          type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string' },
        },
      },
    },
  };
}

/**
 * The distribution the three sketches of a problem are drawn from.
 *
 * This is one short call per problem, and it exists because of an arithmetic fact about the loop it
 * replaced: three sketch calls made independently from one prompt each pick the mode independently,
 * so "three sketches" bought one idea drawn three times. Naming the alternatives in a single call is
 * the only place the model can see them side by side and price them against each other.
 *
 * Prose only. No edits here — an approach with its edits attached costs five times the tokens and
 * four fifths of them are thrown away.
 */
export const PROPOSE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['approaches'],
  properties: {
    approaches: {
      type: 'array',
      minItems: 3,
      maxItems: 8,
      description:
        'Ways this problem could be drawn, with the chance you would have named each. Include the ' +
        'obvious one — leaving it out is its own kind of averaging — and include at least two you ' +
        'think are probably wrong.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'approach', 'probability'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
          approach: {
            type: 'string',
            minLength: 20,
            description: 'One idea about composition, weight or contrast, stated so a sketch could refute it.',
          },
          probability: PROBABILITY,
        },
      },
    },
  },
};
