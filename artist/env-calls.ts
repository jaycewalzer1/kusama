// The environment calls, wrapped in their schemas.
//
// Each one is a fixed question asked of a frozen model at temperature 0 and cached by its whole
// request. None of them is a policy call: nothing here is ever trained, and the split is enforced by
// tests/artist-blindness.test.ts, which asserts that no policy call goes through `envModel` and no
// env call goes through `policy`.
//
// Note what DESCRIBE and AUDIENCE are given: an image, and — for AUDIENCE only — one paragraph
// naming a person. RUBRIC gets an image and one question. That is all. The prompts live in
// observation.ts with everything else the system says out loud, so there is exactly one file to
// read to know what any model in this repo was told.

import {
  AGREES_SYSTEM,
  AUDIENCE_SYSTEM,
  DESCRIBE_SYSTEM,
  RUBRIC_SYSTEM,
  TRANSCRIBE_SYSTEM,
  agreesObservation,
  audienceObservation,
  describeObservation,
  rubricObservation,
  transcribeObservation,
} from './observation.js';
import { envModel, type EnvResponse } from './env-model.js';
import type { WouldAct } from './types.js';

const DESCRIPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description'],
  properties: {
    description: { type: 'string', description: 'Exactly five sentences describing what is physically on the sheet.' },
  },
} as const;

const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['strings'],
  properties: {
    strings: {
      type: 'array',
      description: 'Every visually distinct piece of text, in reading order. Empty if none is readable.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'legible'],
        properties: {
          text: { type: 'string', description: 'Exactly the characters visible. Not corrected, not completed.' },
          legible: { type: 'boolean', description: 'False if any of this piece could not be made out.' },
        },
      },
    },
  },
} as const;

/**
 * `wouldAct` is three words rather than a number, for the reason `AGREES_SCHEMA` is a boolean: a
 * number invites a threshold and a threshold gets tuned until the trajectories look better. The
 * prose stays beside it because the enum alone cannot be argued with.
 */
const AUDIENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['read', 'wouldAct'],
  properties: {
    read: { type: 'string', description: 'Two sentences: what they think it is, and what they would do.' },
    wouldAct: { type: 'string', enum: ['act', 'consider', 'ignore'] },
  },
} as const;

/**
 * `agree` is a boolean and `reason` is one sentence. Deliberately not a score: a number here would
 * invite a threshold, a threshold would get tuned, and the tuning would be done to make trajectories
 * look better. A boolean plus a reason can be read and argued with.
 */
const AGREES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agree', 'reason'],
  properties: {
    agree: { type: 'boolean' },
    reason: { type: 'string', description: 'One sentence. What is in one text and missing or contradicted in the other.' },
  },
} as const;

export interface Agreement {
  agree: boolean;
  reason: string;
}

/** One string a blind reader could make out, and whether they could make all of it out. */
export interface ReadString {
  text: string;
  legible: boolean;
}

export type RubricVerdict = 'holds' | 'fails' | 'cannot-tell';

const RUBRIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['holds', 'fails', 'cannot-tell'] },
    evidence: {
      type: 'string',
      minLength: 10,
      description: 'One or two sentences naming the visible evidence that decided the answer.',
    },
  },
} as const;

export interface RubricRead {
  verdict: RubricVerdict;
  evidence: string;
}

/** A rubric reading joined back to the constraint that asked for it. */
export interface RubricAnswer extends RubricRead {
  id: string;
}

export interface AudienceRead {
  read: string;
  wouldAct: WouldAct;
}

/** What is physically on the sheet, to someone who has never heard of the commission. */
export async function describe(png: Buffer): Promise<EnvResponse<{ description: string }>> {
  return envModel({
    name: 'describe',
    system: DESCRIBE_SYSTEM,
    text: describeObservation(),
    imageBase64: png.toString('base64'),
    schema: DESCRIPTION_SCHEMA,
  });
}

/** Every string a reader who knows nothing can get off the sheet. Never told what to look for. */
export async function transcribe(png: Buffer): Promise<EnvResponse<{ strings: ReadString[] }>> {
  return envModel({
    name: 'transcribe',
    system: TRANSCRIBE_SYSTEM,
    text: transcribeObservation(),
    imageBase64: png.toString('base64'),
    schema: TRANSCRIPT_SCHEMA,
  });
}

/**
 * Answer one rubric from the sheet. The question is passed verbatim; its id and explanatory `why`
 * are deliberately withheld because both reveal how the author expects it to be answered.
 */
export async function readRubric(png: Buffer, text: string): Promise<EnvResponse<RubricRead>> {
  return envModel({
    name: 'rubric',
    system: RUBRIC_SYSTEM,
    text: rubricObservation(text),
    imageBase64: png.toString('base64'),
    schema: RUBRIC_SCHEMA,
  });
}

/** How the one person the field says is watching would take it. */
export async function audience(png: Buffer, watcher: string): Promise<EnvResponse<AudienceRead>> {
  return envModel({
    name: 'audience',
    system: AUDIENCE_SYSTEM,
    text: audienceObservation(watcher),
    imageBase64: png.toString('base64'),
    schema: AUDIENCE_SCHEMA,
  });
}

/**
 * Does the description match what the artist said it was making? Text against text, no image: the
 * image already produced the description, and showing it again would let this call re-describe the
 * picture instead of comparing the two accounts.
 */
export async function descriptionAgrees(intended: string, description: string): Promise<EnvResponse<Agreement>> {
  return envModel({
    name: 'description-agrees',
    system: AGREES_SYSTEM,
    text: agreesObservation(intended, description),
    schema: AGREES_SCHEMA,
  });
}

export async function audienceAgrees(intended: string, read: string): Promise<EnvResponse<Agreement>> {
  return envModel({
    name: 'audience-agrees',
    system: AGREES_SYSTEM,
    text: agreesObservation(intended, read),
    schema: AGREES_SCHEMA,
  });
}
