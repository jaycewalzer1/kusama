// Hybrid retrieval: the lexical ranking and the dense ranking, fused by Reciprocal Rank Fusion.
//
// The repo already measures both arms over one population and one sample, and the measurement is
// the reason this file exists rather than a preference for hybrid search in the abstract. On the
// 1,000-query stride protocol at top-12, BM25 over the catalogue reads 92.4% same-museum and
// CLIP-text over the same fields reads 76.2% — and their top-12 sets share only **36.0%**. Two
// retrievers over the *same prose* that disagree about two thirds of the neighbourhood are the
// textbook case for fusion: neither list is a noisy copy of the other, so a rank-combining rule has
// something to combine.
//
// RRF (Cormack, Clarke & Buettcher 2009) is chosen over score interpolation for one reason that is
// not stylistic: BM25 scores are unbounded sums of IDF terms and cosines are bounded in [-1, 1], so
// any weighted sum of the two raw scores is a weighted sum of two different units, and the weight
// that looks best is the weight that happens to rescale them. RRF never reads a score. Each list
// contributes `1 / (k0 + rank)` and nothing else, so the fusion cannot be tuned by accident.
//
// ## There is NO relevance ground truth for corpus neighbours, and this file does not invent one
//
// Nobody has labelled which of 19,791 museum works *ought* to be a given work's neighbours. So the
// honest reading of every column here is bounded, and the file says so in its own report:
//
//   - **Same-museum share is a confound, not a score.** Lower is not better and higher is not
//     better; it measures how much of the neighbourhood is explained by which building holds the
//     object. It is here because both arms have already been published on it and the fused arm has
//     to be placed beside them.
//   - **Agreement with the picture is the only non-circular proxy available**, and it is a proxy.
//     CLIP-image is a *different modality* over the *same works*: it never reads the catalogue, so a
//     text-side list agreeing with it is agreeing with evidence its own inputs do not contain. That
//     is weak evidence of relevance and strong evidence against pure word-overlap. It is not a
//     quality metric and is not reported as one.
//   - **Overlap with each arm** is what shows the fusion did anything at all. A fused list that
//     shares 95% with BM25 is BM25 with extra steps.
//
// The one genuinely labelled retrieval task in this corpus — does a work's catalogue entry find that
// work's own photograph — is cross-modal, and BM25 cannot enter it: a work's own text retrieves its
// own text by construction. That task belongs to `hubness.ts`, which is where CSLS and centering are
// measured, because there the answer is known.
//
// Report-only. No model, no API key, no network. Nothing here feeds a run, a reward, or a hash.

import { createHash } from 'node:crypto';
import { evenSample } from './atlas.js';
import type { Work } from './manifest.js';
import { buildIndex, neighbours } from './text-space.js';
import {
  FIELD_SETS,
  joinToImages,
  nearestRows,
  type TextImageJoin,
} from './text-embed.js';

/**
 * RRF's damping constant, at the value the original paper used and every later comparison quotes.
 *
 * `k0` sets how fast rank 1 stops mattering. At 60 the gap between rank 1 and rank 2 is small
 * (1/61 vs 1/62), which is the point: RRF is deliberately insensitive to the top of any single
 * list, because the whole premise is that no one list is trusted. It is NOT tuned here — a constant
 * fitted on the same sample the fusion is then scored on would make every number below circular.
 */
export const RRF_K = 60;

/**
 * How deep each arm is asked before fusing, when the answer wanted is top-12.
 *
 * Fusing two top-12 lists can only ever return works one of them already had in its top 12, so the
 * fusion would be a re-ordering and never a recall improvement. Retrieving deeper and cutting after
 * is what lets a work that was rank 40 in both arms — agreed on by both, top-ranked by neither —
 * reach the answer. 100 is the standard depth and is far cheaper than it sounds: BM25 already scans
 * every posting and the dense arm already scores every row, so depth costs a longer sort and
 * nothing else.
 */
export const FUSE_DEPTH = 100;

/**
 * Reciprocal Rank Fusion over any number of ranked lists of row indices.
 *
 * Lists may be different lengths and need not agree on a candidate set; a row absent from a list
 * simply contributes nothing from it, which is the behaviour that makes RRF safe when one arm
 * retrieves nothing at all (BM25 does this for works whose bag shares no term with the corpus).
 *
 * `keys` is the same id-hash tie-break used everywhere else in this subsystem. It matters more here
 * than in a dense space: RRF scores are sums of a small number of rationals with small denominators,
 * so exact ties are common rather than rare, and `corpus/manifest.jsonl` is grouped by source — a
 * tie broken by row order would hand ties to whichever museum sorts first and report that as a
 * property of fusion.
 */
export function rrf(
  lists: readonly (readonly number[])[],
  keys: Float64Array,
  k0 = RRF_K,
): { rows: number[]; scores: Map<number, number> } {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((row, i) => {
      scores.set(row, (scores.get(row) ?? 0) + 1 / (k0 + i + 1));
    });
  }
  const rows = [...scores.keys()].sort(
    (a, b) => (scores.get(b) as number) - (scores.get(a) as number) || (keys[a] as number) - (keys[b] as number),
  );
  return { rows, scores };
}

export interface FusedArm {
  name: string;
  /** Mean over queries of the share of a query's top-k drawn from the QUERY's own museum. */
  sameMuseum: number;
  sameMuseumSd: number;
  /** Mean share of a query's top-k that CLIP-image also names. The cross-modal agreement proxy. */
  agreesWithImage: number;
  agreesWithImageSd: number;
  /** Queries this arm returned nothing for. Only BM25 can do this. */
  unretrievable: number;
  /** Mean neighbours actually returned; below k when an arm runs out of candidates. */
  returned: number;
}

export interface ArmOverlap {
  a: string;
  b: string;
  /** Mean share of a query's top-k that both arms name. */
  mean: number;
  /** Queries whose two top-k sets share nothing. */
  disjoint: number;
}

export interface FusionComparison {
  n: number;
  queries: number;
  k: number;
  depth: number;
  k0: number;
  /** P(two works drawn without replacement share a museum), on THESE works. */
  chance: number;
  /** `k / (n - 1)` — expected overlap between two arms ranking at random. */
  overlapChance: number;
  arms: FusedArm[];
  overlaps: ArmOverlap[];
  /** Works with text but no deduped image row, and so outside all of it. */
  textOnly: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = (xs: number[], m: number) =>
  xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0;

/** The same id-hash tie-break as `text-space.ts` and `text-embed.ts`, never row order. */
export function tieKeys(works: readonly Work[]): Float64Array {
  return Float64Array.from(works, (w) => createHash('sha256').update(w.id).digest().readUInt32BE(0));
}

/**
 * BM25, CLIP-text, and their RRF fusion — one statistic set, one sample, one population.
 *
 * The sample is drawn by stride and never by prefix, because `corpus/manifest.jsonl` is written
 * grouped by source and a prefix would measure one museum and report it as the corpus.
 */
export function fusionComparison(
  k = 12,
  depth = FUSE_DEPTH,
  sampleSize = 1000,
  join: TextImageJoin = joinToImages(),
  k0 = RRF_K,
): FusionComparison {
  const { entries, imageRows, textRows, n, textOnly } = join;
  if (n < depth + 2) throw new Error(`only ${n} work(s) hold both text and pixels; depth ${depth} cannot be drawn`);
  if (depth < k) throw new Error(`depth ${depth} is below k ${k}: the fusion would be a truncation`);

  const works = entries.map((e) => e.work);
  const sources = works.map((w) => w.source);
  const counts: Record<string, number> = {};
  for (const s of sources) counts[s] = (counts[s] ?? 0) + 1;
  const chance = Object.values(counts).reduce((acc, c) => acc + (c / n) * ((c - 1) / (n - 1)), 0);

  const queries = evenSample(
    works.map((_, i) => i),
    sampleSize,
  );

  const keys = tieKeys(works);
  const bm25 = buildIndex(works, FIELD_SETS.all);
  const dense = textRows.all;
  if (!dense) throw new Error('the `all` text matrix is required to fuse against BM25 over the same fields');

  // Every arm is retrieved to `depth` once, then cut to `k`. The fused arm reads the deep lists;
  // the two single arms are cut from the very same deep lists, so no arm gets a different retrieval.
  const deepLexical: number[][] = [];
  const deepDense: number[][] = [];
  const deepFused: number[][] = [];
  const imageNear: number[][] = [];
  for (const q of queries) {
    const lex = neighbours(bm25, q, depth, keys).rows;
    const den = nearestRows(dense, dense, n, q, depth, keys, true);
    deepLexical.push(lex);
    deepDense.push(den);
    deepFused.push(rrf([lex, den], keys, k0).rows);
    imageNear.push(nearestRows(imageRows, imageRows, n, q, k, keys, true));
  }

  const named: { name: string; near: number[][] }[] = [
    { name: 'BM25 (all fields)', near: deepLexical.map((r) => r.slice(0, k)) },
    { name: 'CLIP-text (all)', near: deepDense.map((r) => r.slice(0, k)) },
    { name: `RRF (BM25 + CLIP-text)`, near: deepFused.map((r) => r.slice(0, k)) },
  ];

  const arms: FusedArm[] = named.map(({ name, near }) => {
    const rates: number[] = [];
    const agree: number[] = [];
    const got: number[] = [];
    let unretrievable = 0;
    near.forEach((row, i) => {
      got.push(row.length);
      if (row.length === 0) {
        unretrievable++;
        return;
      }
      const mine = sources[queries[i] as number] as string;
      rates.push(row.reduce((a, r) => a + (sources[r] === mine ? 1 : 0), 0) / row.length);
      const inImage = new Set(imageNear[i] as number[]);
      agree.push(row.filter((r) => inImage.has(r)).length / row.length);
    });
    const m = mean(rates);
    const a = mean(agree);
    return {
      name,
      sameMuseum: m,
      sameMuseumSd: stdev(rates, m),
      agreesWithImage: a,
      agreesWithImageSd: stdev(agree, a),
      unretrievable,
      returned: mean(got),
    };
  });

  const pair = (a: string, b: string): ArmOverlap => {
    const A = named.find((x) => x.name === a) as { near: number[][] };
    const B = named.find((x) => x.name === b) as { near: number[][] };
    const shares: number[] = [];
    let disjoint = 0;
    for (let i = 0; i < queries.length; i++) {
      const inB = new Set(B.near[i] as number[]);
      const both = (A.near[i] as number[]).filter((x) => inB.has(x)).length;
      if (both === 0) disjoint++;
      shares.push(both / k);
    }
    return { a, b, mean: mean(shares), disjoint };
  };

  const [lexName, denseName, fusedName] = named.map((x) => x.name) as [string, string, string];

  return {
    n,
    queries: queries.length,
    k,
    depth,
    k0,
    chance,
    overlapChance: k / (n - 1),
    arms,
    overlaps: [pair(lexName, denseName), pair(fusedName, lexName), pair(fusedName, denseName)],
    textOnly,
  };
}

/** How close two arms have to be on a share before the report refuses to call them different. */
export const ARM_BAND = 0.02;

export function fusionComparisonText(r: FusionComparison): string {
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const out: string[] = [];
  const arm = (name: string) => r.arms.find((a) => a.name === name);
  const lex = arm('BM25 (all fields)');
  const den = arm('CLIP-text (all)');
  const fused = arm('RRF (BM25 + CLIP-text)');

  out.push(
    `Hybrid retrieval over ${r.n.toLocaleString()} works — the lexical arm, the dense arm, and their RRF fusion.`,
    `Every row is the same statistic on the same ${r.queries.toLocaleString()} stride-drawn queries at top-${r.k}.`,
    `Each arm was retrieved to depth ${r.depth} and cut to ${r.k}; the fusion reads the deep lists, k0 = ${r.k0}.`,
    `${r.textOnly} works have catalogue text but no deduped image row and are outside all of it.`,
    '',
    'SAME-MUSEUM SHARE — a confound, not a score. Neither direction is better.',
  );
  for (const a of r.arms) {
    out.push(`  ${a.name.padEnd(24)} ${pct(a.sameMuseum)}  (sd ${pct(a.sameMuseumSd)})`);
  }
  out.push(
    `  ${'chance'.padEnd(24)} ${pct(r.chance)}  two works drawn at random`,
    '',
    'AGREEMENT WITH THE PICTURE — the only non-circular proxy here, and it is a proxy.',
    `  CLIP-image never reads the catalogue, so a text-side list that names works the photograph also`,
    `  names is agreeing with evidence its own input does not contain. Read it as evidence against`,
    `  pure word overlap. Do NOT read it as relevance: nobody has labelled these neighbourhoods.`,
  );
  for (const a of r.arms) {
    out.push(`  ${a.name.padEnd(24)} ${pct(a.agreesWithImage)}  (sd ${pct(a.agreesWithImageSd)}, chance ${pct(r.overlapChance)})`);
  }
  out.push('');

  out.push('DID THE FUSION DO ANYTHING');
  const fl = r.overlaps.find((o) => o.a.startsWith('RRF') && o.b.startsWith('BM25'));
  const fd = r.overlaps.find((o) => o.a.startsWith('RRF') && o.b.startsWith('CLIP-text'));
  const ld = r.overlaps.find((o) => o.a.startsWith('BM25'));
  if (ld) {
    out.push(
      `  The two arms share ${pct(ld.mean)} of a query's ${r.k} (chance ${pct(r.overlapChance)}); ${ld.disjoint} of ${r.queries}`,
      `  queries share nothing at all. That disagreement is the entire reason to fuse.`,
    );
  }
  if (fl && fd) {
    out.push(
      `  The fused list shares ${pct(fl.mean)} with BM25 and ${pct(fd.mean)} with CLIP-text.`,
      Math.max(fl.mean, fd.mean) > 0.9
        ? `  One of those is above 90%: the fusion is substantially that arm with extra steps, and the`
          + `\n  numbers above should be read as that arm's.`
        : `  Neither is dominant, so the fused list is a third neighbourhood and not a re-labelling of`
          + `\n  one arm. That is a fact about the lists, not a claim that the third one is better.`,
    );
  }
  if (lex && den && fused) {
    const best = Math.max(lex.agreesWithImage, den.agreesWithImage);
    const gain = fused.agreesWithImage - best;
    out.push(
      '',
      'WHAT THE PROXY SAYS, WITH ITS OWN LIMITS ATTACHED',
      Math.abs(gain) <= ARM_BAND
        ? `  The fusion agrees with the picture within ${pct(ARM_BAND)} of the better single arm`
          + `\n  (${pct(fused.agreesWithImage)} against ${pct(best)}). On this proxy the fusion has shown NOTHING MEASURED.`
          + `\n  It still returns a different neighbourhood; it has not been shown to return a better one.`
        : gain > 0
          ? `  The fusion agrees with the picture ${pct(gain)} MORE than either arm alone`
            + `\n  (${pct(fused.agreesWithImage)} against ${pct(best)}). On one sample, on a proxy, that is the outcome`
            + `\n  fusion is supposed to produce — and it is one number, not a benchmark.`
          : `  The fusion agrees with the picture ${pct(-gain)} LESS than the better single arm`
            + `\n  (${pct(fused.agreesWithImage)} against ${pct(best)}). Fusion is not free here; say so.`,
    );
  }
  out.push(
    '',
    'There is no relevance ground truth for museum-work neighbourhoods. Nothing above is a quality',
    'measurement, and the labelled cross-modal task — does a catalogue entry find its own photograph —',
    'lives in `corpus hubness`, where BM25 cannot compete because a work retrieves its own text.',
  );
  return out.map((s) => `${s}\n`).join('');
}
