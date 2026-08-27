// The four environment calls, wrapped in their schemas.
//
// Each one is a fixed question asked of a frozen model at temperature 0 and cached by its whole
// request. None of them is a policy call: nothing here is ever trained, and the split is enforced by
// tests/artist-blindness.test.ts, which asserts that no policy call goes through `envModel` and no
// env call goes through `policy`.
//
// Note what DESCRIBE and AUDIENCE are given: an image, and — for AUDIENCE only — one paragraph
// naming a person. That is all. The prompts live in observation.ts with everything else the system
// says out loud, so there is exactly one file to read to know what any model in this repo was told.

import {
  AGREES_SYSTEM,
  AUDIENCE_SYSTEM,
  DESCRIBE_SYSTEM,
  agreesObservation,
  audienceObservation,
  describeObservation,
} from './observation.js';
import { envModel, type EnvResponse } from './env-model.js';

const DESCRIPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description'],
  properties: {
    description: { type: 'string', description: 'Exactly five sentences describing what is physically on the sheet.' },
  },
} as const;

const AUDIENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['read'],
  properties: {
    read: { type: 'string', description: 'Two sentences: what they think it is, and what they would do.' },
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

/** How the one person the field says is watching would take it. */
export async function audience(png: Buffer, watcher: string): Promise<EnvResponse<{ read: string }>> {
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
