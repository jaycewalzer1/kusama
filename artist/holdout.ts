// The held-out cells: the part of the catalog that development is not allowed to look at.
//
// Every threshold in this repo was chosen by somebody who could see the results of changing it. That
// is not a scandal, it is how thresholds get chosen; the scandal would be reporting the number
// afterwards as though it had been predicted. `PENDING_CAP` is 0.34 because three of five edge types
// are undecidable. `MAX_DECLARED_IDS` is 3 because more than three names cover nothing. `INERT_
// THRESHOLD` is 0.001. Each was set by looking. So a score on a cell that was available while those
// numbers were being set is an in-sample score, and the only honest thing to do with it is to say so.
//
// A held-out cell is one that was frozen before the looking and left alone. It buys exactly one
// thing, and it is worth having: when a number finally is taken on it, that number was not
// available to the person who chose the thresholds. Everything else in this file exists to make
// that claim checkable rather than remembered.
//
// ## What is frozen is the document, not the intention
//
// "We did not tune against many-hands" is unfalsifiable. What is falsifiable is "the bytes of
// many-hands.json have not moved since 2026-08-31", and that is what `holdoutDrift` decides, by
// recomputing the same `contentHash(canonicalJson(...))` that `envVersion` stamps on every
// trajectory. If somebody edits a held-out position — to loosen a constraint that was failing, say,
// which is the exact move this exists to catch — the hash moves and the test fails by name.
//
// The brief's field is frozen too. `<brief>.field.json` is what FIND reads, and a held-out brief
// whose field could be rewritten would be held out in name only.
//
// ## What this does NOT buy, stated because it will be overstated
//
// The held-out position was written by the same author, in the same week, in the same house style,
// against the same seventeen constraint kinds, and graded by a checker that author also wrote. It is
// held out from *tuning*. It is not independent, not adversarial, and not a test set in the sense a
// benchmark means. Read `docs/artist/MEASUREMENT.md` under "who wrote the thing being measured"
// before quoting any number taken here as evidence of generalisation.
//
// The honest one-line summary: this separates "the thresholds were fitted to this cell" from "they
// were not", and separates nothing else.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { canonicalJson, contentHash } from '../env/profile.js';
import { loadBrief, loadField, loadPosition } from './field.js';

export const HOLDOUT_FILE = path.join(ROOT, 'aesthetic', 'holdout.json');

/** One frozen document: what it is, and the hash it had at the freeze. */
export interface FrozenDoc {
  id: string;
  /** `contentHash(canonicalJson(doc))` — the same function `positionHash` and `briefHash` use. */
  hash: string;
  /** Briefs only: the hash of `<id>.field.json`, which FIND reads and which is tunable too. */
  fieldHash?: string;
}

export interface Holdout {
  frozenAt: string;
  note: string;
  positions: FrozenDoc[];
  briefs: FrozenDoc[];
}

export function loadHoldout(): Holdout {
  return JSON.parse(readFileSync(HOLDOUT_FILE, 'utf8')) as Holdout;
}

export function heldOutPositions(h = loadHoldout()): string[] {
  return h.positions.map((p) => p.id);
}

export function heldOutBriefs(h = loadHoldout()): string[] {
  return h.briefs.map((b) => b.id);
}

/**
 * A cell is held out if EITHER axis is, which is the conservative reading and the one that matches
 * what the split is for.
 *
 * The alternative — held out only when both axes are — would leave `many-hands x fifty-year-embargo`
 * available for tuning, and a constraint loosened there is loosened for `many-hands` everywhere,
 * because the constraint lives in the position document and not in the cell. A row is contaminated
 * by any cell in it.
 */
export function isHeldOut(positionId: string, briefId: string, h = loadHoldout()): boolean {
  return heldOutPositions(h).includes(positionId) || heldOutBriefs(h).includes(briefId);
}

export interface HoldoutDrift {
  kind: 'position' | 'brief' | 'field';
  id: string;
  frozen: string;
  now: string;
}

/**
 * Which frozen documents have moved. Empty is the only passing answer.
 *
 * A missing file is drift with `now: 'absent'` rather than a thrown error: a held-out document
 * deleted is the strongest possible form of the thing being guarded against, and it should read as a
 * failed check rather than as a crash in the checker.
 */
export function holdoutDrift(h = loadHoldout()): HoldoutDrift[] {
  const out: HoldoutDrift[] = [];
  const hashOf = (load: () => unknown): string => {
    try {
      return contentHash(canonicalJson(load()));
    } catch {
      return 'absent';
    }
  };

  for (const p of h.positions) {
    const now = hashOf(() => loadPosition(p.id));
    if (now !== p.hash) out.push({ kind: 'position', id: p.id, frozen: p.hash, now });
  }
  for (const b of h.briefs) {
    const now = hashOf(() => loadBrief(b.id));
    if (now !== b.hash) out.push({ kind: 'brief', id: b.id, frozen: b.hash, now });
    if (b.fieldHash !== undefined) {
      const nowField = hashOf(() => loadField(b.id));
      if (nowField !== b.fieldHash) out.push({ kind: 'field', id: b.id, frozen: b.fieldHash, now: nowField });
    }
  }
  return out;
}

/** Split a list of cells into the two samples, so a report can never average across the line. */
export function splitBySample<T>(
  items: T[],
  cellOf: (item: T) => { positionId: string; briefId: string },
  h = loadHoldout()
): { inSample: T[]; heldOut: T[] } {
  const inSample: T[] = [];
  const heldOut: T[] = [];
  for (const item of items) {
    const { positionId, briefId } = cellOf(item);
    (isHeldOut(positionId, briefId, h) ? heldOut : inSample).push(item);
  }
  return { inSample, heldOut };
}

export function holdoutText(h = loadHoldout()): string {
  const drift = holdoutDrift(h);
  const lines = [
    `frozen ${h.frozenAt}`,
    `positions held out: ${heldOutPositions(h).join(', ') || '(none)'}`,
    `briefs held out:    ${heldOutBriefs(h).join(', ') || '(none)'}`,
    '',
    h.note,
    '',
    drift.length === 0
      ? 'INTACT — every frozen document hashes to what it hashed at the freeze.'
      : `BROKEN — ${drift.length} frozen document(s) have moved since the freeze:\n  ${drift
          .map((d) => `${d.kind} ${d.id}: frozen ${d.frozen.slice(0, 12)}, now ${d.now === 'absent' ? 'ABSENT' : d.now.slice(0, 12)}`)
          .join('\n  ')}\n\nA moved held-out document is no longer held out. Either revert it, or move it to the\nin-sample side and say so in the run that reports on it.`,
  ];
  return lines.join('\n');
}
