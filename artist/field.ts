// The four layers the artist is held to, loaded off disk and hashed.
//
// A commission is assembled from four independent documents, and the whole design rests on their
// independence. Each answers exactly one of two questions and never both:
//
//   L1 PRACTICE     varies with the artist, never with the job   -> aesthetic/positions/<id>.json
//   L2 BRIEF        varies with the job, never with the artist   -> aesthetic/briefs/<id>.json
//   L3 DELIVERABLE  varies with the kind of object, and nothing else
//                                                                -> aesthetic/deliverables/<id>.json
//   L4 PROTOCOL     varies with nothing at all                   -> observation.ts, one constant
//
// The three that vary are three independent axes, chosen one at a time by whoever launches a run.
// The brief used to carry its own deliverable, which quietly collapsed two axes into one: there was
// no such thing as running the same job as a different kind of object, and the brief's `format` and
// `whereItLives` were L3's facts wearing the client's voice. Now the caller picks all three, every
// triple is coherent, and the grid is a real cross.
//
// A document that answers yes to more than one of the three columns is two documents wearing a
// trenchcoat, and the failure it produces is invisible: the artist appears to derive an object from
// its practice when in fact it was told what to draw. So three rules are mechanical rather than
// editorial:
//
//   - L2 may contain no aesthetic direction. `aestheticDirection` scans for it, the studio refuses to
//     write a brief that trips it, and a run that trips it anyway records the fact — its results are
//     not comparable with a run that did not.
//   - L1 and L3 never mention each other. A practice that says "on a flyer, do X" has done the
//     deriving that the whole arrangement exists to test. Enforced in tests/artist-layers.test.ts.
//   - L2 names no kind of object at all. It is not the client's to say any more, and a brief that
//     says one contradicts two thirds of the grid it will be run in. `namesDeliverable` scans for it.
//
// All four are hand-written, hashed, and never produced by a model. If two trajectories quote
// different hashes here they were not run against the same world and their scores are not comparable.
//
// The one piece of assembly that happens here is `effectivePosition`: a brief's `hard_constraints`
// are Constraints in exactly the aesthetic layer's sense, but nothing in the aesthetic layer knows
// about briefs. Rather than teach it, the artist composes a position whose commitments are the
// position's own plus the brief's, and hands that to the unmodified checker. The composition is
// deterministic, so it hashes.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { canonicalJson, contentHash } from '../env/profile.js';
import { loadAestheticProgram } from '../aesthetic/check.js';
import { contradictions, type Contradiction } from '../aesthetic/contradictions.js';
import { compose } from '../aesthetic/elements/compose.js';
import { elementPackHash, loadElements } from '../aesthetic/elements/pack.js';
import { qualify, type Composition } from '../aesthetic/elements/types.js';
import type { AestheticProgram, Constraint } from '../aesthetic/types.js';
import type { Field } from './types.js';

// --- L1: the practice ----------------------------------------------------------------------------

/**
 * The artist-side layer, brief-agnostic. It lives in `position.meta` rather than at the top of the
 * aesthetic program for the same reason `temperament` does: the aesthetic schema is closed at the
 * top level and `meta` is open, so a position carrying a practice is still a valid position to the
 * unmodified validator, and the aesthetic layer stays ignorant of the artist layer.
 *
 * The constraint machinery already in the position — commitments, prohibitions, generative rules —
 * is the checkable half of L1. This is the half no checker can reach: where the vocabulary came
 * from, what the work is doing, which period is being worked in, how it speaks, and what it will
 * not do whatever the client says.
 */
export interface Practice {
  /** Where the vocabulary came from. Treated as fact, never as metaphor. */
  origin: string;
  /** What the work is actually doing, as distinct from what it depicts. */
  doing: string;
  /** Exactly one period, set. Periods answer a situation differently and must not be blended. */
  period: string;
  /** How this artist speaks: person, tense, hedging or its absence. */
  register: string;
  /**
   * Refusals, which override anything the situation is pushing for. Prose rather than constraints on
   * purpose: a refusal is a thing the artist says out loud and loses work over, and the checkable
   * version of it is already in `prohibitions`. If the refusals block is doing no work, removing it
   * should collapse the piece's necessity without moving whether the constraints were met.
   */
  refusals: string[];
}

/**
 * The artist's temperament, read off `position.meta` for the same reason as the practice.
 */
export interface Temperament {
  value: number;
  why: string;
}

/**
 * Practice is required. A position without one is a style filter: it can be prompted with and it
 * will produce motifs, but there is nothing in it that could refuse a brief, so nothing distinguishes
 * it from "in the style of X".
 */
export function practiceOf(position: AestheticProgram): Practice {
  const meta = (position.meta ?? {}) as { practice?: Partial<Practice> };
  const p = meta.practice;
  const missing = (['origin', 'doing', 'period', 'register'] as const).filter(
    (k) => typeof p?.[k] !== 'string' || !p[k]!.trim()
  );
  if (!p || missing.length > 0) {
    throw new Error(
      `position ${position.id} has no meta.practice${p ? ` with ${missing.join(', ')}` : ''}; ` +
        'without it there is nothing in the position that could refuse a brief'
    );
  }
  if (!Array.isArray(p.refusals) || p.refusals.length < 3) {
    throw new Error(
      `position ${position.id} declares ${p.refusals?.length ?? 0} refusals; a practice that refuses ` +
        'fewer than three things is decoration'
    );
  }
  return { origin: p.origin!, doing: p.doing!, period: p.period!, register: p.register!, refusals: p.refusals };
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

// --- L2: the condition ---------------------------------------------------------------------------

/**
 * The situation the work comes out of: artist-agnostic, object-agnostic, and — since the fine-art
 * turn — client-agnostic. This layer used to be a commission. It had a `client`, an `audience`, a
 * `function` ("a visitor has to leave able to say these three things"), a `budget`, a `timeline`, a
 * `quantity`, a `mustAppear` list, and `textRequired` hard constraints carrying the facts. That is
 * a specification for a poster, and it was producing posters: a surface obliged to deliver named
 * facts to a named audience by a date has already had its composition decided for it, and the only
 * thing left to choose is where the type block goes.
 *
 * What replaces it is a condition rather than a job. There is nobody to satisfy, nothing that has
 * to be legible, and no date the work is late for. What is here instead is what is at hand, what
 * happened, what it costs to get wrong, and what the situation will not permit.
 *
 * Two fields earn their place by causing trouble and are kept from the old shape:
 *  - `fear` is where the condition collides with a practice, and the collision is the experiment
 *    (see `Trajectory.collision`).
 *  - `pressures` is what makes compliance and judgment separable. A situation that only pushes in
 *    helpful directions produces the same trajectory whether the artist has a practice or not.
 *
 * `hard_constraints` survives as a mechanism and is expected to be near-empty. A condition may bind
 * the work materially — one ink because there is one ink — but it may not require a string, because
 * requiring a string is the commission coming back in through the constraint list.
 */
export interface Brief {
  version: string;
  id: string;
  title: string;
  /** What is physically at hand, and how it came to be at hand. Not a budget: a heap of stuff. */
  material: string;
  /** What has happened, and has not been settled. No audience outcome and no success condition. */
  occasion: string;
  when: string;
  where: string;
  /** What can actually be made here, with what. Means, never the object's dimensions. */
  means: string;
  /** What is lost by getting this wrong. The maker's cost, not a client's risk. */
  atStake: string;
  /** What the maker is afraid of, in their own words. This is where the collision usually is. */
  fear: string;
  /**
   * Pulls the situation exerts that damage the work. At least one, stated as a pressure rather than
   * as a diagnosis — the artist is never told these are the damaging ones. Unlike a hard constraint
   * these are not settled: the artist may give in to one, refuse it out loud, or answer what is
   * actually behind it (protocol step 5), and which of the three it does is the measurement.
   */
  pressures: string[];
  /** What this situation will not permit, whatever the work turns out to be. */
  refusals: string[];
  hard_constraints: Constraint[];
  notes?: string;
}

/**
 * The condition's prose, as the artist reads it. Scanned for contamination; `notes` included, and
 * `pressures` included because a pressure is exactly where taste would smuggle itself in. "It has
 * to survive being rolled" is a pressure; "make it striking" is not, and the field would be a hole
 * in this check if it were exempt.
 */
const BRIEF_PROSE: (keyof Brief)[] = [
  'title',
  'material',
  'occasion',
  'when',
  'where',
  'means',
  'atStake',
  'fear',
  'pressures',
  'refusals',
  'notes',
];

/**
 * Words that would be the artist's job to choose. Three groups: named movements and periods, mood
 * adjectives, and colour names.
 *
 * This is a smoke alarm, not a proof. It cannot catch "make it feel like the ones the record shops
 * put up", and it will not try — a scan that attempted judgement would need a model, and a model in
 * the contamination check is a model deciding what counts as aesthetic direction, which is the thing
 * being measured. What it does catch is the failure that actually happens, which is a condition
 * written by someone who could not resist saying "bold and playful". `hard_constraints` is exempt:
 * a constraint is checked rather than read, and "PINK" may be someone's name.
 */
const STYLE_WORDS = [
  // movements and periods, which import a whole visual language by reference
  'punk', 'situationist', 'bauhaus', 'brutalist', 'constructivist', 'dada', 'dadaist', 'swiss',
  'futurist', 'modernist', 'postmodern', 'art deco', 'art nouveau', 'psychedelic', 'grunge',
  'minimalist', 'minimalism', 'op art', 'pop art', 'surrealist', 'rave aesthetic', 'zine aesthetic',
  // mood adjectives, which are taste wearing the clothes of a requirement
  'bold', 'playful', 'edgy', 'gritty', 'elegant', 'tasteful', 'striking', 'dynamic', 'vibrant',
  'moody', 'sleek', 'retro', 'vintage', 'clean-looking', 'eye-catching', 'aesthetic', 'stylish',
  'beautiful', 'ugly', 'cool-looking', 'atmospheric', 'evocative', 'iconic',
  // colours, which are a choice of ink and therefore the artist's
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'magenta', 'cyan', 'turquoise',
  'crimson', 'scarlet', 'lilac', 'beige', 'khaki',
];

/**
 * Every place the brief told the artist what it should look like. Empty is the only acceptable
 * result; anything else means the run is contaminated and is not comparable with a clean one.
 */
export function aestheticDirection(brief: Brief): string[] {
  const found: string[] = [];
  for (const key of BRIEF_PROSE) {
    const value = brief[key];
    // One field is a list of demands and the rest are paragraphs; both are prose the artist reads.
    const parts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const part of parts) {
      const text = String(part).toLowerCase();
      for (const word of STYLE_WORDS) {
        // Whole words only: "green" must not fire on "Greenwich", "red" must not fire on "hundred".
        if (new RegExp(`\\b${word}\\b`).test(text)) found.push(`${key}: "${word}"`);
      }
    }
  }
  return found;
}

// --- L3: the deliverable -------------------------------------------------------------------------

/**
 * What this kind of object has to do to function, independent of who makes it and what it is about.
 *
 * This is the layer the arrangement is really testing. Given L1 and L3 separately and never joined,
 * the artist has to derive "so the shout has to resolve at ten metres" for itself. A practice that
 * already said that would be doing L3's job, and the derivation — the thing being measured — would
 * have been supplied rather than performed.
 */
export interface Deliverable {
  version: string;
  id: string;
  name: string;
  function: string;
  consequences: string[];
  doesNotDecide: string;
}

// --- the whole commission ------------------------------------------------------------------------

export interface Commission {
  position: AestheticProgram;
  positionHash: string;
  practice: Practice;
  temperament: Temperament;
  brief: Brief;
  briefHash: string;
  deliverable: Deliverable;
  deliverableHash: string;
  field: Field;
  fieldHash: string;
  /** Every place L2 did L1's job. Empty on a clean run; recorded, never silently tolerated. */
  contamination: string[];
  /**
   * Hard constraints of the composed position that cannot all hold. Non-empty means no program
   * satisfies this commission, so a run against it would measure the composition rather than the
   * artist. Computed here rather than discovered by the artist mid-piece.
   */
  unsatisfiable: Contradiction[];
  /** position + brief hard_constraints + any elements, which is what the checker is run against. */
  effective: AestheticProgram;
  /** The lineage elements this run adopted, sorted. Empty is the ordinary case. */
  elementIds: string[];
  /**
   * The identity of that set. Always present, including for the empty set, and it goes into
   * `envVersion` as a tenth field. Two runs under different element packs are different experiments
   * and must not compare as the same one — the same defect `dynamicsHash` was added to close.
   */
  elementPackHash: string;
  /**
   * What `compose` derived between the position and the elements. Null when no element was adopted,
   * which is the one case where there is nothing for two sources to disagree about.
   */
  composition: Composition | null;
}

function resolveIn(dir: string, idOrPath: string): string {
  return idOrPath.endsWith('.json') ? idOrPath : path.join(ROOT, dir, `${idOrPath}.json`);
}

/**
 * A position by id, or by path if it is given one. `loadAestheticProgram` takes a file, so every
 * caller that has only an id has to know where positions live; naming that once keeps the answer in
 * one place.
 */
export function loadPosition(idOrPath: string): AestheticProgram {
  return loadAestheticProgram(resolveIn('aesthetic/positions', idOrPath));
}

export function loadBrief(idOrPath: string): Brief {
  const file = resolveIn('aesthetic/briefs', idOrPath);
  return JSON.parse(readFileSync(file, 'utf8')) as Brief;
}

/**
 * Absent is an error rather than an empty layer. An artist given no account of what a poster has to
 * survive will assume a screen, and the resulting piece will be judged by a checker that assumes
 * paste and rain.
 */
export function loadDeliverable(id: string): Deliverable {
  const file = path.join(ROOT, 'aesthetic/deliverables', `${id}.json`);
  if (!existsSync(file)) {
    throw new Error(`no deliverable ${id}: expected aesthetic/deliverables/${id}.json`);
  }
  const deliverable = JSON.parse(readFileSync(file, 'utf8')) as Deliverable;
  if (deliverable.id !== id) throw new Error(`${file} declares id ${deliverable.id}, not ${id}`);
  return deliverable;
}

export function listDeliverables(): Deliverable[] {
  const dir = path.join(ROOT, 'aesthetic/deliverables');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Deliverable);
}

// --- the boundary between L1 and L3 --------------------------------------------------------------

/**
 * The catalog's own ids, plus the nouns a document reaches for instead of one. Deduped, because the
 * two sources overlap the moment a deliverable is called what people call it.
 */
const objectWords = () => [
  ...new Set([
    ...listDeliverables().map((d) => d.id),
    'poster',
    'flyer',
    'handbill',
    'placard',
    'leaflet',
    'sticker',
  ]),
];

/** Plural-aware and whole-word, so it fires on "flyers" and not on "flyered". */
const names = (text: string, word: string) => new RegExp(`\\b${word}s?\\b`).test(text);

/**
 * Every place a position states a fact about a kind of object instead of a belief about a medium.
 *
 * L1 may hold beliefs about a medium. L1 may not contain facts about one, and a fact is anything the
 * artist could be wrong about. "A thing on a wall is assembled, not designed" is a stance and belongs
 * here; "it is read at fifteen feet, it is 24x36, photocopying crushes the midtones" is L3's to
 * state, and a position that states it has done L3's job. The artist then appears to derive the
 * object's behaviour from its own vocabulary when in fact it was told, and that derivation is the
 * thing the run exists to measure.
 *
 * This is worse than untidiness. Five of six positions once argued with a poster in their worldview
 * and their tensions, which the artist reads in full on every phase, so every flyer commission run
 * against them degraded for a reason that had nothing to do with the artist model — a confound
 * sitting directly across the axis the layers exist to isolate.
 *
 * `lineage` is the allowlist, and the only one: an entry naming a real 1977 sleeve cites an object
 * that existed, and stripping the noun out of it would falsify the record for a checker's
 * convenience. The id is deliberately not exempt — an id that named the deliverable is how this went
 * unnoticed the first time, and it cost a rename to fix.
 */
export function deliverableFacts(position: AestheticProgram): string[] {
  const { lineage: _cited, ...rest } = position;
  const text = JSON.stringify(rest).toLowerCase();
  return objectWords()
    .filter((word) => names(text, word))
    .map((word) => `it names the deliverable "${word}"`);
}

/**
 * Every place a condition says what kind of object is being made.
 *
 * This layer used to be allowed exactly one of these on the grounds that the client knows what it
 * ordered. There is no client now, and the kind of object is a third axis chosen by whoever
 * launches the run: the same condition is meant to be workable as any of them. A condition that
 * says "poster" is wrong in most of the cells it will appear in, and it hands the artist a fact
 * about L3 that L3 may contradict.
 *
 * Checked on the condition and not on its field: the field describes the world this lands in, and
 * that world contains other people's objects.
 */
export function namesDeliverable(brief: Brief): string[] {
  const text = JSON.stringify(brief).toLowerCase();
  return objectWords()
    .filter((word) => names(text, word))
    .map((word) => `it calls the work a "${word}"`);
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

/**
 * The composed position the checker sees when a run adopts lineage elements, plus the conflicts
 * `compose` derived between them.
 *
 * Two decisions here, and both are about not changing runs that adopt nothing.
 *
 * **Elements are opt-in and the empty case is byte-identical to no elements at all.** `compose`
 * namespaces every id on the way in, so a composed report reads `position:withheld/c-covered` where
 * an uncomposed one reads `c-covered`. That is right when there are two sources and a report has to
 * say which one it means; it is noise when there is one. So an empty element list returns the
 * position untouched and every fixture, golden and recorded score keeps its ids.
 *
 * **The element's constraints keep their part.** `compose` returns one flat list, but the checker
 * reports `commitment` / `prohibition` / `generative_rule` per constraint and that distinction is
 * read by anything looking at why a run failed. So the flat list is unflattened back onto the parts
 * it came from rather than being poured into `commitments`, which would have relabelled every
 * element prohibition as a commitment.
 */
export function withElements(
  effective: AestheticProgram,
  elementIds: string[]
): { position: AestheticProgram; composition: Composition | null } {
  if (elementIds.length === 0) return { position: effective, composition: null };

  const elements = loadElements(elementIds);
  const composition = compose(effective, elements);
  // `compose` qualified every id; the same qualification applied here is what makes the two lists
  // join. Deriving it rather than string-matching keeps one definition of the namespacing rule.
  const from = { kind: 'position' as const, id: effective.id };
  const requalify = (c: Constraint) => ({ ...c, id: qualify(from, c.id) });

  return {
    position: {
      ...effective,
      id: `${effective.id}+${[...elementIds].sort().join('+')}`,
      commitments: effective.commitments.map(requalify),
      prohibitions: [
        ...effective.prohibitions.map(requalify),
        ...elements.flatMap((e) => e.prohibitions.map((c) => ({ ...c, id: qualify({ kind: 'element', id: e.id }, c.id) }))),
      ],
      generative_rules: [
        ...effective.generative_rules.map((r) => (r.constraint ? { ...r, constraint: requalify(r.constraint) } : r)),
        ...elements.flatMap((e) =>
          e.generativeRules.map((c) => ({
            rule: c.why,
            constraint: { ...c, id: qualify({ kind: 'element', id: e.id }, c.id) },
          }))
        ),
      ],
      // The stance each element carries, appended so the artist is shown what it adopted rather than
      // only being checked against it. A lineage the artist cannot read is a parameter bundle.
      worldview: [effective.worldview, ...elements.map((e) => e.worldviewFragment)].join('\n\n'),
      cliches: [...effective.cliches, ...elements.flatMap((e) => e.cliches)],
    },
    composition,
  };
}

/** The identity of the elements a run adopted. The empty pack is a real, stable hash, not a null. */
export function packHashFor(elementIds: string[]): string {
  return elementPackHash(loadElements(elementIds));
}

/**
 * The three variable layers, chosen independently. The deliverable is an argument rather than a
 * property of the brief: which kind of object a job becomes is the third axis of the grid, and a
 * commission that carried its own would make two thirds of that grid unreachable.
 */
export function loadCommission(
  positionIdOrPath: string,
  briefIdOrPath: string,
  deliverableId: string,
  elementIds: string[] = []
): Commission {
  const position = loadPosition(positionIdOrPath);
  const brief = loadBrief(briefIdOrPath);
  const deliverable = loadDeliverable(deliverableId);
  const field = loadField(brief.id);
  const composed = withElements(effectivePosition(position, brief), elementIds);
  const effective = composed.position;
  return {
    elementIds: [...elementIds].sort(),
    elementPackHash: packHashFor(elementIds),
    composition: composed.composition,
    position,
    positionHash: contentHash(canonicalJson(position)),
    practice: practiceOf(position),
    temperament: temperamentOf(position),
    brief,
    briefHash: contentHash(canonicalJson(brief)),
    deliverable,
    deliverableHash: contentHash(canonicalJson(deliverable)),
    field,
    fieldHash: contentHash(canonicalJson(field)),
    contamination: aestheticDirection(brief),
    // Over the composed position, not over the brief alone. Every contradiction worth catching is
    // between a commitment the artist brought and a requirement the client added; a brief checked on
    // its own is checked against the half of the rubric that cannot conflict with it.
    unsatisfiable: contradictions(effective),
    effective,
  };
}
