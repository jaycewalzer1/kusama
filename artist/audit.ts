// The reading audit: when the model wrote "placed slightly off-center", was it looking?
//
// `corpus/readings/` holds 50 blind readings — prose a vision model wrote about a work it was shown
// without its catalogue record. Those readings are the evidence every derived lineage element is
// built from, and nothing has ever checked one against the pixels it claims to describe.
//
// This file checks the one family of claim that a measured quantity can actually contradict:
// whether the weight of the picture sits in the middle or off to one side. `does`, `refuses` and
// `tension` are mostly unfalsifiable by construction and are left alone; a module that scored them
// would be inventing a verdict, not measuring one.
//
// ## What this can and cannot conclude, which is most of the design
//
// **It is an aggregate test, never a per-work verdict.** "Off-centre" in a person's or a model's
// sense is about the subject — a figure, a horizon, a doorway. `weight.offset` is about luminance
// mass. A portrait can have its sitter well to the left while its bright and dark areas balance
// almost exactly, and that is not the reading being wrong. So a single work's agreement or
// disagreement carries no information, and this file deliberately provides no way to ask for one.
// What *is* informative is whether the works the model called off-centre measure differently, as a
// group, from the works it called centred. If they do not, the prose is not tracking the picture.
//
// **The null must be stated, not assumed.** With seventeen works in one group and ten in the other,
// a gap between two medians is exactly the kind of number that looks like a finding and is noise.
// So the separation is reported against a permutation test: shuffle which work was called what, ten
// thousand times, and count how often chance alone produces a gap this big. That baseline is the
// number to read; the raw separation on its own means nothing at this sample size.
//
// ## The contamination split, which is the reason this file is worth having
//
// 38 of the 50 probes recognised the work — they named a real artist and a real title. A reading of
// a painting the model already knows is not necessarily a reading at all; it may be recall of what
// critics have written about a famous picture, dressed as observation. Those two cases are
// indistinguishable in the prose and completely distinguishable in the arithmetic: if the spatial
// claims track the pixels *only* on the works the model did not recognise, the recognised readings
// are memory. If they track on both, the model is looking. If they track on neither, this whole
// corpus of readings is prose about art in general.
//
// That is the repo's central epistemic worry — how much of what the corpus "sees" is art-historical
// memory — asked in a form that has an answer.

import { quantile } from './envelope.js';

/**
 * The two claims, as stated, arguable regexes rather than a classifier.
 *
 * Exported so a reader can disagree with the word list rather than with a black box. They are
 * deliberately narrow: every phrase here is one whose truth `weight.offset` bears on. Words like
 * "dynamic", "balanced" or "harmonious" are not included because no number in this repo contradicts
 * them, and matching them would manufacture a denominator.
 */
export const CLAIM_PATTERNS: Readonly<Record<ClaimFamily, RegExp>> = {
  'off-centre': /off-?cent(?:er|re)|to one side|placed (?:to the )?(?:left|right)|asymmetric(?:al|ally)?\b/i,
  centred: /\bcent(?:er|re)ed\b|centrally (?:placed|positioned|located)|dead cent(?:er|re)|(?:in|at) the (?:exact )?(?:middle|cent(?:er|re)) of the (?:composition|frame|canvas|picture)/i,
};

export type ClaimFamily = 'off-centre' | 'centred';

/** The prose fields a spatial claim can legitimately appear in. `tension` is prose about mood. */
const FIELDS = ['structuralMoves', 'materialFacts', 'does'] as const;

/**
 * Structural, so the pure half of this file never imports the corpus module and every test below
 * runs with no readings and no pixels on disk.
 */
export interface ReadingProse {
  does: string[];
  materialFacts: string[];
  structuralMoves: string[];
}

export interface Claim {
  family: ClaimFamily;
  /** The sentence that matched, so a disagreement can be checked against what was actually written. */
  quote: string;
  field: (typeof FIELDS)[number];
}

/** Every spatial claim in a reading, with its source sentence. */
export function claimsOf(reading: ReadingProse): Claim[] {
  const out: Claim[] = [];
  for (const field of FIELDS) {
    for (const sentence of reading[field] ?? []) {
      for (const family of Object.keys(CLAIM_PATTERNS) as ClaimFamily[]) {
        if (CLAIM_PATTERNS[family].test(sentence)) out.push({ family, quote: sentence, field });
      }
    }
  }
  return out;
}

/**
 * One work that has both a reading and a measurement.
 *
 * `offset` is `Surface.weight.offset` — the ground-free luminance-deviation centroid. It is NOT
 * `RenderMetrics.inkOffset`, and the two must never be mixed in one sample: `inkOffset` is defined
 * against a known paper colour, which no painting in this corpus has.
 */
export interface AuditPoint {
  id: string;
  families: ClaimFamily[];
  offset: number;
  /** The probe's own claim to have recognised the work. The contamination axis. */
  recognised: boolean;
}

export interface Band {
  n: number;
  min: number;
  median: number;
  max: number;
}

export interface Comparison {
  centred: Band;
  offCentre: Band;
  /** median(off-centre) − median(centred). Positive is the direction the readings predict. */
  separation: number;
  /**
   * Share of label shuffles whose |separation| is at least the observed one. This is the number to
   * read. It is not a p-value from a named test and is not called one; it is the chance baseline
   * this repo reports everywhere else, computed by shuffling rather than by a formula.
   */
  chance: number;
  permutations: number;
  /** False when either group is under MIN_GROUP. Every number above is still reported. */
  stated: boolean;
}

export interface Audit {
  works: number;
  withClaim: number;
  /** Works whose reading says both things. Excluded from the comparison, counted here. */
  contradictory: string[];
  /** Works with a claim but no measurement — no pixels, or the image would not decode. */
  unmeasured: string[];
  all: Comparison;
  /** Null when either subgroup is empty; the split is the point, but it cannot be faked. */
  recognised: Comparison | null;
  unrecognised: Comparison | null;
}

/**
 * Below this, a median is one or two works and a permutation test has too few distinct arrangements
 * to produce a small chance figure even when the effect is total. Matches `envelope.ts`'s
 * `MIN_POINTS` convention: compute everything, report everything, and mark it NOT STATED.
 */
export const MIN_GROUP = 5;

const band = (vs: number[]): Band => {
  const s = [...vs].sort((a, b) => a - b);
  return s.length === 0
    ? { n: 0, min: NaN, median: NaN, max: NaN }
    : { n: s.length, min: s[0]!, median: quantile(s, 0.5), max: s[s.length - 1]! };
};

/** mulberry32. Small, and the only property that matters is that it is the same sequence twice. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The comparison, and the shuffle that says whether to believe it.
 *
 * Two-sided on purpose. A one-sided test would quietly assume the readings are right about the
 * direction, which is the thing being checked; and readings that are *anti*-correlated with the
 * pixels would be the most interesting result of all, so a test that could not see them would be
 * the wrong test.
 */
function compare(points: AuditPoint[], permutations: number, seed: number): Comparison {
  const off = points.filter((p) => p.families.includes('off-centre')).map((p) => p.offset);
  const cen = points.filter((p) => p.families.includes('centred')).map((p) => p.offset);
  const offBand = band(off);
  const cenBand = band(cen);
  const separation = offBand.median - cenBand.median;

  const pooled = [...off, ...cen];
  const nOff = off.length;
  let atLeast = 0;
  if (pooled.length > 0 && nOff > 0 && cen.length > 0) {
    const next = rng(seed);
    for (let i = 0; i < permutations; i++) {
      // Fisher-Yates over a copy. Shuffling the pooled values and re-splitting is the same thing as
      // shuffling the labels, and cheaper.
      const shuffled = [...pooled];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(next() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!];
      }
      const a = band(shuffled.slice(0, nOff)).median;
      const b = band(shuffled.slice(nOff)).median;
      if (Math.abs(a - b) >= Math.abs(separation)) atLeast++;
    }
  }

  return {
    centred: cenBand,
    offCentre: offBand,
    separation,
    chance: permutations > 0 ? atLeast / permutations : NaN,
    permutations,
    stated: offBand.n >= MIN_GROUP && cenBand.n >= MIN_GROUP,
  };
}

/** Pure: everything above, over points somebody else measured. */
export function auditFrom(points: AuditPoint[], permutations = 10000, seed = 1): Audit {
  const usable = points.filter((p) => p.families.length === 1 && Number.isFinite(p.offset));
  const contradictory = points.filter((p) => p.families.length > 1).map((p) => p.id);
  const unmeasured = points.filter((p) => p.families.length > 0 && !Number.isFinite(p.offset)).map((p) => p.id);
  const sub = (f: (p: AuditPoint) => boolean): Comparison | null => {
    const s = usable.filter(f);
    return s.length === 0 ? null : compare(s, permutations, seed);
  };
  return {
    works: points.length,
    withClaim: points.filter((p) => p.families.length > 0).length,
    contradictory,
    unmeasured,
    all: compare(usable, permutations, seed),
    recognised: sub((p) => p.recognised),
    unrecognised: sub((p) => !p.recognised),
  };
}

const line = (label: string, c: Comparison | null): string => {
  if (c === null) return `  ${label.padEnd(14)} no works in this group\n`;
  const n = `n ${c.offCentre.n} vs ${c.centred.n}`.padEnd(12);
  if (!c.stated) {
    return `  ${label.padEnd(14)} ${n} NOT STATED — under ${MIN_GROUP} in a group, so the medians are anecdotes\n`;
  }
  const verdict =
    c.chance <= 0.05
      ? c.separation > 0
        ? 'the prose tracks the pixels'
        : 'the prose runs OPPOSITE to the pixels'
      : 'NOTHING MEASURED — chance produces this gap as often as not';
  return (
    `  ${label.padEnd(14)} ${n} off-centre median ${c.offCentre.median.toFixed(4)}  centred median ${c.centred.median.toFixed(4)}\n` +
    `  ${''.padEnd(14)} ${''.padEnd(12)} separation ${c.separation >= 0 ? '+' : ''}${c.separation.toFixed(4)}  chance ${(100 * c.chance).toFixed(1)}%  — ${verdict}\n`
  );
};

export function auditText(a: Audit): string {
  let out =
    `${a.withClaim}/${a.works} readings make a claim about where the weight sits\n` +
    `${a.contradictory.length} say both things and are excluded${a.contradictory.length ? `: ${a.contradictory.join(' ')}` : ''}\n` +
    `${a.unmeasured.length} have a claim and no measurement${a.unmeasured.length ? `: ${a.unmeasured.join(' ')}` : ''}\n\n` +
    `weight.offset by what the reading said, over ${a.all.permutations} label shuffles:\n` +
    line('all', a.all) +
    line('recognised', a.recognised) +
    line('unrecognised', a.unrecognised);

  // The comparison the file exists for, stated in words rather than left to the reader. Two groups
  // that disagree here mean the readings are not one thing and cannot be pooled downstream.
  if (a.recognised?.stated && a.unrecognised?.stated) {
    const r = a.recognised.chance <= 0.05;
    const u = a.unrecognised.chance <= 0.05;
    out +=
      '\n' +
      (r && u
        ? 'Both hold. The prose tracks the picture whether or not the model knew the work.\n'
        : !r && u
          ? 'Only the works it did NOT recognise hold. The recognised readings are recall, not looking.\n'
          : r && !u
            ? 'Only the works it DID recognise hold — the opposite of the contamination worry, and\nworth explaining before it is used.\n'
            : 'Neither holds. Nothing here shows these readings track where the weight actually sits.\n');
  } else {
    out += '\nThe recognised/unrecognised split is NOT STATED at this sample size.\n';
  }
  return out;
}
