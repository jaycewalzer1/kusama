// The brief, the field, and the position the artist is actually held to.
//
// Three files on disk become one `Commission`. All three are environment: hand-written, hashed, and
// never produced by a model. If two trajectories quote different hashes here they were not run
// against the same world and their scores are not comparable.
//
// The one piece of assembly that happens here is `effectivePosition`: a brief's `hard_constraints`
// are Constraints in exactly the aesthetic layer's sense, but nothing in the aesthetic layer knows
// about briefs. Rather than teach it (the prompt forbids changing that layer), the artist composes a
// position whose commitments are the position's own plus the brief's, and hands that to the
// unmodified checker. The composition is deterministic, so it hashes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { canonicalJson, contentHash } from '../env/profile.js';
import { loadAestheticProgram } from '../aesthetic/check.js';
import type { AestheticProgram, Constraint } from '../aesthetic/types.js';
import type { Field } from './types.js';

export interface Brief {
  version: string;
  id: string;
  title: string;
  event: string;
  when: string;
  where: string;
  function: string;
  stakes: string;
  hard_constraints: Constraint[];
  notes?: string;
}

/**
 * The artist's temperament, read off `position.meta`. Written into `meta` rather than as a top-level
 * field because the aesthetic schema is closed at the top level and `meta` is open — so a position
 * carrying a temperament is still a valid position to the unmodified validator.
 */
export interface Temperament {
  value: number;
  why: string;
}

export interface Commission {
  position: AestheticProgram;
  positionHash: string;
  temperament: Temperament;
  brief: Brief;
  briefHash: string;
  field: Field;
  fieldHash: string;
  /** position + brief hard_constraints, which is what the checker is actually run against. */
  effective: AestheticProgram;
}

function resolveIn(dir: string, idOrPath: string): string {
  return idOrPath.endsWith('.json') ? idOrPath : path.join(ROOT, dir, `${idOrPath}.json`);
}

export function loadBrief(idOrPath: string): Brief {
  const file = resolveIn('aesthetic/briefs', idOrPath);
  return JSON.parse(readFileSync(file, 'utf8')) as Brief;
}

/**
 * Fields live beside their briefs as `<id>.field.json`. Absent is an error, not an empty field: an
 * artist asked to find a problem in a scene it was told nothing about will invent one, and the whole
 * point of FIND is that the problem comes from outside the model.
 */
export function loadField(briefId: string): Field {
  const file = path.join(ROOT, 'aesthetic/briefs', `${briefId}.field.json`);
  const field = JSON.parse(readFileSync(file, 'utf8')) as Field;
  if (field.briefId !== briefId) {
    throw new Error(`${file} declares briefId ${field.briefId} but sits beside brief ${briefId}`);
  }
  return field;
}

/**
 * Temperament is required. A position without one cannot initialise valence, and defaulting it to
 * zero would silently make every position the same artist.
 */
export function temperamentOf(position: AestheticProgram): Temperament {
  const meta = (position.meta ?? {}) as { temperament?: unknown; temperamentWhy?: unknown };
  if (typeof meta.temperament !== 'number' || typeof meta.temperamentWhy !== 'string') {
    throw new Error(
      `position ${position.id} has no meta.temperament (-1..1) and meta.temperamentWhy; ` +
        'the artist cannot initialise valence without one'
    );
  }
  if (meta.temperament < -1 || meta.temperament > 1) {
    throw new Error(`position ${position.id} has meta.temperament ${meta.temperament}, outside -1..1`);
  }
  return { value: meta.temperament, why: meta.temperamentWhy };
}

/**
 * The position the checker sees. The brief's constraints are appended to commitments, not merged
 * into them, and their ids are left exactly as the brief wrote them so a report can say `hc-meeting`
 * and mean the brief. An id collision is refused rather than resolved: two constraints with one id
 * would make the report ambiguous about which one was violated.
 */
export function effectivePosition(position: AestheticProgram, brief: Brief): AestheticProgram {
  const taken = new Set(
    [...position.commitments, ...position.prohibitions].map((c) => c.id)
  );
  for (const c of brief.hard_constraints) {
    if (taken.has(c.id)) {
      throw new Error(`brief ${brief.id} constraint ${c.id} collides with a constraint in position ${position.id}`);
    }
  }
  return {
    ...position,
    id: `${position.id}+${brief.id}`,
    commitments: [...position.commitments, ...brief.hard_constraints],
  };
}

export function loadCommission(positionIdOrPath: string, briefIdOrPath: string): Commission {
  const position = loadAestheticProgram(resolveIn('aesthetic/positions', positionIdOrPath));
  const brief = loadBrief(briefIdOrPath);
  const field = loadField(brief.id);
  return {
    position,
    positionHash: contentHash(canonicalJson(position)),
    temperament: temperamentOf(position),
    brief,
    briefHash: contentHash(canonicalJson(brief)),
    field,
    fieldHash: contentHash(canonicalJson(field)),
    effective: effectivePosition(position, brief),
  };
}
