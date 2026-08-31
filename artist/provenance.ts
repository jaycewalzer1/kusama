// Novelty by provenance: has this combination been made before?
//
// The claim a work of this kind wants to make is "this combination has not been made before". That
// is answerable off the corpus record alone, with no model, no embedding and no index, because the
// combination is known *by construction*: the run declares which elements it adopted, every derived
// element carries the object it came from, and two objects either share a maker or they do not.
//
// This is stronger evidence than a distance, not weaker. A cosine says two images look unalike,
// which is an inference about pixels; this says nobody has held these two positions at once, which
// is a fact about the record. The two answer different questions and only one of them is checkable
// by a person with a browser and the citation.
//
// ## What "made before" means here, and where the reading is soft
//
// Three co-occurrence verdicts over a pair, and they are reported separately rather than folded into
// a number:
//
//   same-hand    One maker made both source works. Whatever tension the pair has, an oeuvre already
//                held it. This is the strong refutation of novelty and the only one that rests on an
//                identifier rather than an interval.
//   same-period  Different makers, but the recorded date spans overlap. Nobody joined these two;
//                the period had both to hand. Weaker, and it is weak in a specific way — museum date
//                strings are prose ("c. 1600", "1882–83", "1000s"), so the span is parsed out of the
//                four-digit years in the string and a work dated "18th century" contributes nothing.
//                A pair reported `novel` on the strength of a date that did not parse is a pair
//                whose dates are in `note`, so the reader can see what was compared.
//   novel        Different makers, and no overlap in what could be parsed.
//
// And a fourth that is not a verdict: `unknown`, for any pair with a hand-authored element in it.
// Those elements have a `provenance` block written by a person and no `derivedFrom`, so there is no
// object to check and the question cannot be asked. Reported as its own count, never quietly added
// to `novel` — an unanswerable question is not a positive answer, and this file exists because that
// distinction is the whole of it.
//
// ## Prior runs
//
// The second half of the question. Every finished run under the runs directory logged its element
// set on the `trajectory-start` line, so "has this combination been run before" is a scan of those
// lines. Runs whose logs cannot be read are counted in `unreadableRuns` rather than skipped in
// silence, because "no prior run used this pair" and "I could not read the prior runs" are the same
// output otherwise.
//
// ## TODO: CSD embeddings with a CSLS readout — deliberately not built
//
// The similarity half of novelty is missing and should stay missing until it can be done properly.
// If it is ever taken up: raw CSD cosine *inverts* for roughly a quarter of artists who share a
// tradition — it ranks a different painter's work as closer to an artist than that artist's own —
// which makes it worse than nothing for exactly the pairs this repo cares about, since composing two
// lineages from one tradition is the interesting case. A CSLS readout at about 2.25x the cost cuts
// that failure rate from 15/91 artists to 4/91. So **CSLS is not optional**: CSD alone would produce
// a confident number that is wrong in the specific direction that matters here. It also brings torch,
// which is a scope fence in its own right. Provenance novelty is the definition this repo committed
// to and it needs neither.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadElement } from '../aesthetic/elements/pack.js';
import type { DerivedFrom } from '../aesthetic/elements/types.js';
import { readLog } from './studio-log.js';

export type CoOccurrence = 'same-hand' | 'same-period' | 'novel' | 'unknown';

export interface Combination {
  /** Two or three element ids, sorted, so a combination has one spelling. */
  elements: string[];
  corpus: CoOccurrence;
  /** What was actually compared. A verdict whose evidence is not shown is an assertion. */
  note: string;
  /** Run directories that already used every element in this combination. Empty is run-novel. */
  priorRuns: string[];
}

export interface ProvenanceRecord {
  elementIds: string[];
  /** Elements with a corpus object behind them. Only these can be asked the corpus question. */
  grounded: string[];
  /** Hand-authored elements. Not a failure — they were never derived from an object. */
  ungrounded: string[];
  /**
   * Grounded elements whose source work the leakage probe named correctly. Any novelty claim over a
   * combination containing one of these is contaminated by what the model already knew, and is
   * reported here so it can be excluded rather than discovered later.
   */
  canonical: string[];
  pairs: Combination[];
  triples: Combination[];
  /** Run directories whose log could not be read. Not zero prior runs — no answer. */
  unreadableRuns: string[];
  summary: {
    priorRunsScanned: number;
    pairs: number;
    /** Pairs no maker and no overlapping period already held. The headline. */
    corpusNovelPairs: number;
    samePeriodPairs: number;
    sameHandPairs: number;
    /** Pairs with a hand-authored element, which cannot be asked. */
    unknownPairs: number;
    /** Pairs no prior run has composed. */
    runNovelPairs: number;
    triples: number;
    corpusNovelTriples: number;
    runNovelTriples: number;
  };
}

// --- the corpus question -------------------------------------------------------------------------

/** Four-digit years in a museum date string, as a span. Null when the string names no year. */
function span(date: string): [number, number] | null {
  const years = [...date.matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]));
  // "1882–83" and "1000s" both give one year, which is a point span and compares correctly.
  if (years.length === 0) return null;
  return [Math.min(...years), Math.max(...years)];
}

/**
 * Whether two makers are the same person.
 *
 * The creator field carries a whole biography — "William Merritt Chase (American, 1849–1916)" — so
 * it is compared verbatim after trimming and case-folding rather than parsed. Two records of the
 * same artist from one museum's API agree character for character; two artists who differ only in
 * the parenthetical are different artists. Nothing looser: a shared surname is not a shared hand,
 * and this verdict is the one that refutes a novelty claim outright.
 */
function sameHand(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function coOccurrence(from: (DerivedFrom | null)[]): { corpus: CoOccurrence; note: string } {
  if (from.some((f) => f === null)) {
    return { corpus: 'unknown', note: 'at least one element is hand-authored and has no source object, so the question cannot be asked.' };
  }
  const known = from as DerivedFrom[];
  const makers = known.map((f) => f.creator ?? 'maker not recorded');
  const dates = known.map((f) => f.date || 'date not recorded');
  const shown = known.map((f, i) => `${makers[i]}, ${dates[i]}`).join(' | ');

  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      if (sameHand(known[i]!.creator, known[j]!.creator)) {
        return { corpus: 'same-hand', note: `one maker made two of these source works, so an oeuvre already held this combination: ${shown}` };
      }
    }
  }

  const spans = known.map((f) => span(f.date));
  const unparsed = known.filter((f, i) => spans[i] === null).map((f) => f.objectId);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const x = spans[i];
      const y = spans[j];
      if (x && y && x[0] <= y[1] && y[0] <= x[1]) {
        return { corpus: 'same-period', note: `different makers, but the recorded spans overlap: ${shown}` };
      }
    }
  }
  const caveat = unparsed.length ? ` No year could be parsed for ${unparsed.join(', ')}, so those contributed nothing to the period test.` : '';
  return { corpus: 'novel', note: `different makers and no overlap in the parsed spans: ${shown}.${caveat}` };
}

// --- the prior-runs question ----------------------------------------------------------------------

export interface PriorRun {
  dir: string;
  elementIds: string[];
}

/**
 * The element set of every finished run under `runsDir`, except `self`.
 *
 * `self` is excluded by resolved path rather than by name: a run must not be reported as prior art
 * for itself, and comparing basenames would let `out/x` and `out/nested/x` collide.
 */
export function priorRuns(runsDir: string, self?: string): { runs: PriorRun[]; unreadable: string[] } {
  if (!existsSync(runsDir)) return { runs: [], unreadable: [] };
  const mine = self ? path.resolve(self) : null;
  const runs: PriorRun[] = [];
  const unreadable: string[] = [];

  for (const entry of readdirSync(runsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    if (mine && path.resolve(dir) === mine) continue;
    const file = path.join(dir, 'studio.jsonl');
    if (!existsSync(file)) continue;
    try {
      const start = readLog(file).find((l) => l.kind === 'trajectory-start');
      if (!start) {
        unreadable.push(dir);
        continue;
      }
      runs.push({ dir, elementIds: (start.data as { elementIds?: string[] }).elementIds ?? [] });
    } catch {
      // A half-written log from a run still in flight, or one whose chain does not verify. Either
      // way it is not an answer, and counting it as "did not use this pair" would be one.
      unreadable.push(dir);
    }
  }
  return { runs, unreadable };
}

// --- the record ------------------------------------------------------------------------------------

function combos<T>(xs: T[], k: number): T[][] {
  if (k > xs.length) return [];
  if (k === 0) return [[]];
  const [head, ...rest] = xs;
  return [...combos(rest, k - 1).map((c) => [head!, ...c]), ...combos(rest, k)];
}

/**
 * A hand-authored element has no source object and answers null. An id naming no element at all is
 * a different problem and is left to `loadElement` to throw about.
 */
export type SourceLookup = (id: string) => DerivedFrom | null;

const fromDisk: SourceLookup = (id) => loadElement(id).derivedFrom ?? null;

/**
 * What this run drew on, and which of those combinations are new.
 *
 * Takes the prior runs rather than reading them, and the source lookup is injectable, so the whole
 * judgement is testable against a hand-built history and a hand-built corpus. That matters more than
 * usual here: the derived set is empty until `corpus derive` has run, so a test that could only use
 * what is on disk could not reach `same-hand` or `same-period` at all and would pass by being
 * unable to ask the question.
 */
export function provenance(
  elementIds: string[],
  prior: PriorRun[],
  unreadable: string[] = [],
  sourceLookup: SourceLookup = fromDisk
): ProvenanceRecord {
  const ids = [...elementIds].sort();
  const sourceOf = new Map<string, DerivedFrom | null>(ids.map((id) => [id, sourceLookup(id)]));

  const grounded = ids.filter((id) => sourceOf.get(id) !== null);
  const ungrounded = ids.filter((id) => sourceOf.get(id) === null);
  const canonical = grounded.filter((id) => sourceOf.get(id)!.canonical);

  const usedBy = (set: string[]): string[] => prior.filter((r) => set.every((id) => r.elementIds.includes(id))).map((r) => r.dir);
  const build = (set: string[]): Combination => ({
    elements: set,
    ...coOccurrence(set.map((id) => sourceOf.get(id)!)),
    priorRuns: usedBy(set),
  });

  const pairs = combos(ids, 2).map(build);
  const triples = combos(ids, 3).map(build);

  return {
    elementIds: ids,
    grounded,
    ungrounded,
    canonical,
    pairs,
    triples,
    unreadableRuns: unreadable,
    summary: {
      priorRunsScanned: prior.length,
      pairs: pairs.length,
      corpusNovelPairs: pairs.filter((p) => p.corpus === 'novel').length,
      samePeriodPairs: pairs.filter((p) => p.corpus === 'same-period').length,
      sameHandPairs: pairs.filter((p) => p.corpus === 'same-hand').length,
      unknownPairs: pairs.filter((p) => p.corpus === 'unknown').length,
      runNovelPairs: pairs.filter((p) => p.priorRuns.length === 0).length,
      triples: triples.length,
      corpusNovelTriples: triples.filter((t) => t.corpus === 'novel').length,
      runNovelTriples: triples.filter((t) => t.priorRuns.length === 0).length,
    },
  };
}

/** The record for one run directory, scanning its siblings for prior art. How every caller gets one. */
export function provenanceOf(dir: string, elementIds: string[]): ProvenanceRecord {
  const { runs, unreadable } = priorRuns(path.dirname(dir), dir);
  return provenance(elementIds, runs, unreadable);
}

/** One block for a terminal. */
export function provenanceText(r: ProvenanceRecord): string {
  if (r.elementIds.length < 2) {
    return `${r.elementIds.length} element(s) adopted, so there is no combination to be novel.\n${r.summary.priorRunsScanned} prior runs scanned.`;
  }
  const row = (c: Combination) =>
    `  ${c.corpus.padEnd(12)} ${c.priorRuns.length === 0 ? 'run-novel' : `run before in ${c.priorRuns.join(', ')}`}\n    ${c.elements.join(' + ')}\n    ${c.note}`;
  const s = r.summary;
  return [
    `elements: ${r.elementIds.join(', ')}`,
    r.ungrounded.length ? `hand-authored, so no corpus answer: ${r.ungrounded.join(', ')}` : '',
    r.canonical.length ? `CONTAMINATED — the probe knew these source works: ${r.canonical.join(', ')}` : '',
    `${s.priorRunsScanned} prior runs scanned${r.unreadableRuns.length ? `, ${r.unreadableRuns.length} unreadable` : ''}`,
    '',
    'pairs:',
    ...r.pairs.map(row),
    r.triples.length ? '\ntriples:' : '',
    ...r.triples.map(row),
    '',
    `${s.corpusNovelPairs}/${s.pairs} pairs are corpus-novel; ${s.samePeriodPairs} share a period, ${s.sameHandPairs} share a hand, ${s.unknownPairs} cannot be asked.`,
    `${s.runNovelPairs}/${s.pairs} pairs have not been run before.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
