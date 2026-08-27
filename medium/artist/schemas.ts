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
      'element ids listed under ELEMENTS in your plan, exactly, and never a node id. Nodes added ' +
      'under it are attached to that element, which is how the plan later gets checked against the ' +
      'tree. An id that names no element attaches nothing and the element reads as never built.',
  };
  // $id and $schema are dropped: this is being embedded as a sub-schema, not registered as one.
  const { $id: _id, $schema: _s, ...rest } = raw;
  return { ...rest, properties };
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

export const FIND_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['problems'],
  properties: {
    problems: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'tension', 'fieldRefs'],
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
        required: ['id', 'role'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
          role: { type: 'string', minLength: 8, description: 'What this part of the picture is doing.' },
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
              'by a person, and are reported unjudged rather than assumed to hold.',
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

export const CHOOSE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['problemId', 'why', 'intention'],
  properties: {
    problemId: { type: 'string' },
    why: {
      type: 'string',
      minLength: 40,
      description: 'Why this one, with reference to what the sketches actually look like.',
    },
    intention: INTENTION,
  },
};

export function actSchema(): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['think', 'control', 'risk', 'edits'],
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
