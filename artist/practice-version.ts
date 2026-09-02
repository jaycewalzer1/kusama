// UPDATE PRACTICE: the artist's practice gains a version, and every earlier version stays readable
// forever.
//
// The loop ends with the artist writing down what this run added to its practice — which works it
// borrowed from, which lenses proved fertile, what it rejected and why. That record accumulates.
// After ten runs there are ten versions and the artist can be shown, and held to, what it said it
// was doing in run three.
//
// ## Append-only and content-addressed, and that is the whole design
//
// Writing version N+1 must never mutate, rewrite or reformat version N. This is not tidiness. The
// L1 practice prose goes into every prompt the artist ever sees, and `callPolicy` logs the whole
// observation verbatim into the hash chain. If loading "the practice" silently returned different
// prose later, a trajectory that recorded `practice v3` could no longer be replayed or rescored
// against what it actually saw — the run would be measured against a document that did not exist
// when it ran. That failure is silent: nothing throws, the numbers simply stop meaning what they
// say. So:
//
//   - one file per version, `NNN.json`, written with the `wx` flag. A version that already exists
//     is a write that fails loudly rather than an overwrite that succeeds quietly.
//   - every version carries `hash`, taken over itself with `hash` removed, and `parent`, the hash of
//     the version before it. `loadPracticeVersion` recomputes and refuses a record whose bytes have
//     been edited since it was written. A hand-edited v3 is not a v3.
//   - no timestamp anywhere in the record. This repo hashes content, not clocks; a wall-clock field
//     inside the hashed body would make the identity of a version depend on when it was written and
//     two identical records would stop being the same record. The order is the version number and
//     the occasion is `trajectoryId`.
//
// ## What the model writes, and what it does not
//
// One policy call, and it produces exactly one field: `changed`, the artist's own short account of
// what this run did to its practice. Everything else in the record — the borrowed works and their
// ids, the fertile lenses, the rejections — is assembled mechanically from the run's own data. A
// model asked to list the works it borrowed from will produce a plausible list whether or not it
// borrowed from any, and this is a provenance record; the same reasoning that makes material-sheet.ts
// check every citation against the manifest applies with more force here, because these ids are what
// a later reader will use to say what this artist has actually looked at.
//
// The five fields of `Practice` are copied forward verbatim and the model does not touch them.
// field.ts states the rule: the layers "are hand-written, hashed, and never produced by a model. If
// two trajectories quote different hashes here they were not run against the same world." A version
// that let the artist rewrite its own `origin` and `refusals` would make L1 model-generated and
// every cross-run comparison would be comparing two worlds. What accumulates is the record beside
// the practice, not a rewrite of it. This is a record, not a learned preference model: nothing here
// optimises anything, and no number computed here is ever fed back into a decision.
//
// ## Where the versions live, and why they are tracked
//
// `aesthetic/practice/<positionId>/NNN.json`. Data, not source.
//
// Beside the practice it descends from: L1 is the position, positions live in `aesthetic/positions/`,
// and everything under `aesthetic/` that a run is held to — briefs, elements, exemplars, the resolved
// influence sets — sits there and is tracked. The alternative was the run's own output directory, and
// it is wrong: `out/` is gitignored scratch, a version written there would be deleted by the first
// person clearing space, and a version that only exists in one run's output is not a history.
//
// Tracked, not ignored. Read .gitignore: everything excluded there is large, refetchable, or derived
// from something untracked. A practice version is none of those. It is a few hundred bytes, it is not
// regenerable — the run that produced these words will never run again — and it is the thing the
// artist is supposed to be held to, which is worth nothing if a clone cannot read it.
//
// ## Why this is not in observation.ts
//
// observation.ts hashes its own bytes into `envVersion.observationHash`, so a word added there
// declares every trajectory ever collected to be from a different environment. influence-doc.ts made
// this decision first and material-sheet.ts followed it; this file follows both. The prompt text and
// the schema for the one call live here.
//
// TODO: when the accumulated versions are to be shown *to* the artist in later runs, the block that
// renders them belongs in this file for exactly the reason above — not in observation.ts. Nothing
// renders them today. The record is being accumulated before it is read, on purpose: a history has
// to exist before it can be quoted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { contentHash } from '../env/profile.js';
import { callPolicy, type Spend } from './call.js';
import type { Practice } from './field.js';
import type { Material, MaterialSheet } from './material-sheet.js';
import type { Policy } from './policy/interface.js';

export const PRACTICE_STORE = path.join(ROOT, 'aesthetic', 'practice');

/**
 * Something the run tried and either kept or cut: a lens, an approach, a way of reading the
 * condition. Taken as a parameter rather than read out of `discovery.jsonl` here, because the phase
 * that writes those lines is not this file's business and a reader that knew their shape would break
 * the moment DIVERGE changed its mind about them.
 */
export interface Tried {
  id: string;
  /** The lens or approach itself, as it was proposed. */
  what: string;
  /** Why it proved fertile, or why it was cut. A rejection without a reason records nothing. */
  why: string;
}

/** A material the run took, and the museum works it rests on. Copied from the sheet, not invented. */
export interface Borrowing {
  id: string;
  works: string[];
  borrowing: string;
}

export interface PracticeVersion {
  positionId: string;
  /** 1-based. There is no version 0: version 0 is the position document on disk. */
  version: number;
  /** The hash of the version before this one, or null for the first. Walk it to read the history. */
  parent: string | null;
  /** The practice as it stood for this version, copied forward verbatim. Never model-written. */
  practice: Practice;
  borrowed: Borrowing[];
  fertile: Tried[];
  rejected: Tried[];
  /** The run that produced this version. The occasion, and the only date this record needs. */
  trajectoryId: string;
  /** The artist's own account of what changed. The one part of this record a model wrote. */
  changed: string;
  /** Over this record with `hash` removed. Recomputed on load; a mismatch is a refusal. */
  hash: string;
}

export type VersionDraft = Omit<PracticeVersion, 'version' | 'parent' | 'hash'>;

function versionHash(v: Omit<PracticeVersion, 'hash'>): string {
  return contentHash(v);
}

/**
 * Where a numbered version sits. Zero-padded so a directory listing is in version order, which is
 * the order a history has to be read in.
 */
export function versionFile(positionId: string, version: number, store: string = PRACTICE_STORE): string {
  return path.join(store, positionId, `${String(version).padStart(3, '0')}.json`);
}

/**
 * The version by number, exactly as it was written.
 *
 * A missing numbered version throws. Asking for version 3 is asking for a specific record that some
 * trajectory quoted; its absence means the record has been broken, and returning null there would
 * let a rescore proceed against a practice nobody can produce.
 */
export function loadPracticeVersion(
  positionId: string,
  version: number,
  store: string = PRACTICE_STORE
): PracticeVersion {
  const file = versionFile(positionId, version, store);
  if (!existsSync(file)) throw new Error(`no practice version ${version} for ${positionId} at ${file}`);
  const record = JSON.parse(readFileSync(file, 'utf8')) as PracticeVersion;
  const { hash, ...rest } = record;
  if (versionHash(rest) !== hash) {
    throw new Error(
      `${file} does not match its own hash: it has been edited since it was written, and the ` +
        'prose a trajectory quoting this version was shown is no longer recoverable'
    );
  }
  return record;
}

/**
 * The newest version, or null when this position has never been through UPDATE PRACTICE.
 *
 * Null rather than a throw, and no directory is created by asking: a repo with no versions on disk
 * has to behave exactly as it did before this file existed. Counting upwards rather than listing the
 * directory because the store has no gaps by construction, and a gap would mean a version was
 * deleted — which the count then reports as a shorter history rather than silently skipping over.
 */
export function latestVersion(positionId: string, store: string = PRACTICE_STORE): PracticeVersion | null {
  let n = 0;
  while (existsSync(versionFile(positionId, n + 1, store))) n++;
  return n === 0 ? null : loadPracticeVersion(positionId, n, store);
}

/**
 * Append one version. The number and the parent link are derived here so that no caller can choose
 * them, and the write refuses a file that already exists — that refusal is what makes "the previous
 * version stays reproducible" a property of the filesystem rather than of everyone's good intentions.
 */
export function writePracticeVersion(draft: VersionDraft, store: string = PRACTICE_STORE): PracticeVersion {
  const previous = latestVersion(draft.positionId, store);
  const body: Omit<PracticeVersion, 'hash'> = {
    ...draft,
    version: (previous?.version ?? 0) + 1,
    parent: previous?.hash ?? null,
  };
  const record: PracticeVersion = { ...body, hash: versionHash(body) };
  const file = versionFile(draft.positionId, record.version, store);
  mkdirSync(path.dirname(file), { recursive: true });
  // Pretty-printed because a history is meant to be read and diffed by a person. The identity of the
  // record is `hash`, taken over the canonical serialization, so the layout of the file is free.
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return record;
}

// --- the phase ------------------------------------------------------------------------------------

const RULE = '-'.repeat(88);

const SYSTEM = [
  'The work is finished. Write down what this run did to your practice.',
  '',
  'This is a record, not a plan and not a resolution. It goes in a file, it is numbered, and it does',
  'not get edited afterwards. Later runs can be shown it and you can be asked to answer for it.',
  '',
  'You are not rewriting your practice. Where the vocabulary came from, what the work is doing, the',
  'period, how you speak, what you refuse — those stand as they are written. What you are writing is',
  'the account of what this run added to them, or found wanting in them.',
  '',
  'Point at things. Name the work you took something from, name the lens that opened the piece up,',
  'name the thing you cut and say what was wrong with it. A paragraph that names no work, no lens and',
  'no rejection is not a record of a change — it is a record of nothing, and it will read as nothing',
  'to whoever comes back to it.',
  '',
  'If this run genuinely moved nothing in your practice, say that, and say what would have had to',
  'happen for it to move. That is a real entry. "I deepened my engagement with materiality" is not.',
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changed'],
  properties: {
    changed: {
      type: 'string',
      minLength: 120,
      description:
        'What this run did to your practice, in your own words. Name at least one work you took ' +
        'from by its id, at least one lens and what it opened, and at least one thing you cut and ' +
        'why it was wrong. Prose that names none of those three is not a change and does not belong ' +
        'in the record. Do not restate your practice back; state what happened to it.',
    },
  },
};

/** Only materials that actually cite something. A borrowing resting on no work is not provenance. */
function borrowings(sheet: MaterialSheet | null): Borrowing[] {
  return (sheet?.materials ?? [])
    .filter((m: Material) => m.works.length > 0)
    .map((m: Material) => ({ id: m.id, works: m.works, borrowing: m.borrowing }));
}

function tried(label: string, items: Tried[]): string {
  if (items.length === 0) return `${label}\n  (none recorded)`;
  return [label, ...items.map((t) => `  [${t.id}] ${t.what}\n        ${t.why}`)].join('\n');
}

function history(versions: PracticeVersion[]): string {
  if (versions.length === 0) {
    return 'This is the first version. Your practice has no recorded history before this run.';
  }
  return [
    `${versions.length} earlier versions. What you wrote then, in order:`,
    ...versions.map((v) => `  v${v.version} (${v.trajectoryId})\n        ${v.changed}`),
  ].join('\n');
}

/**
 * Where this phase writes: one policy call and one note.
 *
 * It is not `CallSink` because `CallSink` accepts `'policy-call'` and nothing else — it exists to
 * describe what `callPolicy` needs, and widening it in call.ts would widen it for every caller. Both
 * `StudioLog` and `DiscoveryLog` satisfy this, and anything satisfying this satisfies `CallSink`.
 */
export interface PracticeSink {
  readonly file: string;
  append(kind: 'policy-call' | 'note', data: unknown): unknown;
}

export interface PracticeUpdate {
  positionId: string;
  /** The practice as it stands, from the commission. Copied into the version untouched. */
  practice: Practice;
  trajectoryId: string;
  /** RESEARCH's output, or null when the run did no research. */
  sheet: MaterialSheet | null;
  /** Lenses and approaches that opened something up, and the ones that were cut, with reasons. */
  fertile: Tried[];
  rejected: Tried[];
}

/**
 * One call, one appended version.
 *
 * run.ts is expected to pass the **StudioLog** as the sink, not the DiscoveryLog. The
 * choice is not obvious and it goes the other way from RESEARCH and DIVERGE, so: discovery.jsonl is
 * explicitly the record that is allowed to be nondeterministic, reordered, resumed and thrown away.
 * That is right for the material that was proposed and cut during a run. It is wrong for this. A
 * practice version is a thing the artist is held to across every later run, and a claim whose
 * supporting record may legitimately be deleted is not a claim anyone can be held to. Putting the
 * call in the chain is what makes the prose in the version file traceable to an observation the model
 * demonstrably saw.
 *
 * The cost of that choice: this adds one `policy-call` line to the trajectory, so it must be logged
 * after the loop's last call, before `trajectory-end`. `replay` walks recorded calls in order and a
 * call inserted in the middle would shift the cursor for every call after it.
 */
export async function updatePractice(
  policy: Policy,
  log: PracticeSink,
  spend: Spend,
  update: PracticeUpdate,
  store: string = PRACTICE_STORE
): Promise<PracticeVersion> {
  const previous = latestVersion(update.positionId, store);
  const earlier: PracticeVersion[] = [];
  for (let n = 1; n <= (previous?.version ?? 0); n++) earlier.push(loadPracticeVersion(update.positionId, n, store));

  const borrowed = borrowings(update.sheet);
  const p = update.practice;

  const call = await callPolicy<{ changed: string }>(policy, log, spend, {
    name: 'update-practice',
    system: SYSTEM,
    observation: [
      RULE,
      'YOUR PRACTICE AS IT IS WRITTEN. It is not changing here; you are recording what happened to it.',
      RULE,
      `WHERE THE VOCABULARY CAME FROM\n  ${p.origin}`,
      `WHAT THE WORK IS DOING\n  ${p.doing}`,
      `PERIOD\n  ${p.period}`,
      `HOW YOU SPEAK\n  ${p.register}`,
      `REFUSALS\n${p.refusals.map((r) => `  - ${r}`).join('\n')}`,
      RULE,
      'WHAT YOU HAVE WRITTEN IN THIS FILE BEFORE',
      history(earlier),
      RULE,
      'WHAT YOU BORROWED FROM, THIS RUN. These citations are already in the record; they are here so',
      'you can point at them, and they are checked against the museum catalogue.',
      borrowed.length > 0
        ? borrowed.map((b) => `  [${b.id}] ${b.borrowing}\n        from: ${b.works.join(', ')}`).join('\n')
        : '  (nothing: this run did no research, and borrowed from no work)',
      RULE,
      tried('LENSES THAT OPENED SOMETHING UP', update.fertile),
      '',
      tried('WHAT YOU CUT, AND WHY', update.rejected),
      RULE,
      'WRITE THE ENTRY.',
    ].join('\n'),
    schema: SCHEMA,
    maxTokens: 2000,
  });

  const version = writePracticeVersion(
    {
      positionId: update.positionId,
      practice: update.practice,
      borrowed,
      fertile: update.fertile,
      rejected: update.rejected,
      trajectoryId: update.trajectoryId,
      changed: call.action.changed,
    },
    store
  );
  // The chain says which version this run produced. Without it the link runs one way only — the
  // version names its trajectory, but the trajectory would not name its version.
  log.append('note', {
    phase: 'update-practice',
    positionId: version.positionId,
    version: version.version,
    hash: version.hash,
    parent: version.parent,
  });
  return version;
}
