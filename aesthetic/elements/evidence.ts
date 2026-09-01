// What share of the rules a run is graded against rests on what kind of evidence.
//
// The tiers on their own are labels. This is the number they exist to produce, and it is the same
// move `artist envelope` makes on the descriptors: state the quantity, compute it over what is
// actually on disk, and let the answer be as unflattering as it is. `envelope` found that three
// edgeContact descriptors are 0.0000 on every measurable plate. The expected finding here is of the
// same kind — that on a run adopting no elements, 100% of the constraints deciding the score have no
// evidence tier at all, because a position is not sourced and never claimed to be.
//
// ## Positions are their own bucket and it is the largest one
//
// A `LineageElement` claims to carry something out of a tradition, so asking what backs that claim is
// fair. An `AestheticProgram` claims nothing of the kind: it is a made-up aesthetic position, written
// here, and honest about it. Grading those constraints on an evidence scale would be a category
// error dressed as rigour.
//
// So they get a bucket named `position` rather than a tier, and the bucket is reported beside the
// tiers instead of being left out. Leaving it out is what would mislead: a report showing "100%
// indirect" over the two element constraints in a twenty-three constraint composition would be true
// and would give exactly the wrong impression of how much of the run is evidenced.

import type { Composition, EvidenceTier, LineageElement } from './types.js';

/** The tiers, plus the bucket for constraints that come from a position and make no claim. */
export type EvidenceBucket = EvidenceTier | 'position';

export interface EvidenceProfile {
  /** Constraint counts per bucket. Every bucket is present, including the zeroes. */
  counts: Record<EvidenceBucket, number>;
  total: number;
  /** Constraints from a lineage element, i.e. everything except the `position` bucket. */
  sourced: number;
  /**
   * Elements named in the composition that were not supplied to this function, by id.
   *
   * Non-empty means the profile is incomplete and its counts are wrong, which is why it is a field
   * rather than a thrown error: a caller that has the composition but not the elements should get a
   * profile that says so, not one that quietly under-counts.
   */
  unknownElements: string[];
}

const ZERO: Record<EvidenceBucket, number> = {
  direct: 0,
  indirect: 0,
  interpretation: 0,
  speculative: 0,
  position: 0,
};

/**
 * Count a composition's constraints by the evidence behind them.
 *
 * `elements` is the set the composition was built from. Order does not matter and extras are
 * ignored; what matters is that every element the composition cites is in it.
 */
export function evidenceProfile(composition: Composition, elements: LineageElement[]): EvidenceProfile {
  const tierOf = new Map(elements.map((e) => [e.id, e.provenance.tier]));
  const counts = { ...ZERO };
  const unknown = new Set<string>();

  for (const c of composition.constraints) {
    if (c.source.kind === 'position') {
      counts.position++;
      continue;
    }
    const tier = tierOf.get(c.source.id);
    if (tier === undefined) {
      unknown.add(c.source.id);
      continue;
    }
    counts[tier]++;
  }

  const total = composition.constraints.length;
  return {
    counts,
    total,
    sourced: total - counts.position - unknown.size,
    unknownElements: [...unknown].sort(),
  };
}

export function evidenceText(p: EvidenceProfile): string {
  if (p.total === 0) return 'no constraints; nothing to say about evidence.';
  const pct = (n: number) => `${((n / p.total) * 100).toFixed(1)}%`;
  const rows = (['direct', 'indirect', 'interpretation', 'speculative', 'position'] as EvidenceBucket[]).map(
    (b) => `  ${b.padEnd(15)} ${String(p.counts[b]).padStart(3)}  ${pct(p.counts[b]).padStart(6)}`
  );
  const out = [
    `${p.total} constraint(s) decide this run's score. What backs each:`,
    ...rows,
    '',
    p.counts.direct === 0
      ? 'Nothing here rests on a primary source. `direct` requires the source quoted into the element,'
      : `${p.counts.direct} constraint(s) claim a quoted primary source.`,
    p.counts.direct === 0 ? 'and no element on disk does that.' : '',
    `\`indirect\` names a book nobody in this repo has opened. See aesthetic/elements/types.ts.`,
  ].filter((l) => l !== '');
  if (p.unknownElements.length > 0) {
    out.push('', `INCOMPLETE — these elements were cited but not supplied: ${p.unknownElements.join(', ')}`);
  }
  return out.join('\n');
}
