// A condition read through a shelf: which of the works an artist has looked at this brief makes
// relevant, and whether "relevant" means anything here.
//
// This is the model-free half of theme derivation. The half that needs a model — `artist
// derive-themes`, which would ask the artist what it makes of these works given this condition — is
// blocked on credit. This half needs no model at all: CLIP's text tower encodes the condition, the
// image tower already encoded the corpus, and the ranking falls out of one dot product per work.
//
// ## The only number that matters here is the baseline
//
// Ranking 48 works by cosine to a phrase always produces a first-place work. It produces one for a
// phrase about textiles and it produces one for a phrase about nothing, and the two look identical
// on the page. So every ranking this module prints is accompanied by the same query's distribution
// over the whole corpus, and the headline is not "which work is nearest" but "is this set nearer to
// this condition than a work drawn at random". When the answer is no — and it will often be no,
// because a position's influence set is not selected for any particular brief — the honest output is
// that the condition does not pick anything out of this shelf, and the report says so rather than
// printing a first place and letting the reader supply the significance.
//
// ## Why the text is split into sentences
//
// CLIP's context is 77 tokens including the two specials, so a condition of any length is silently
// cut in half by the tokenizer. `sentences()` — the same splitter `influences.ts` uses on a
// worldview — is applied first and the pieces are averaged, so a long brief is encoded whole rather
// than encoded as its opening clause. Anything still over the limit is reported, not swallowed.

import { rowAt, type CorpusEmbeddings } from './clip-index.js';
import { sentences } from './influences.js';
import type { Resolved, ResolvedWork } from './influences.js';

export interface LensHit {
  work: ResolvedWork;
  cosine: number;
  /** Where this work sits in the same query's distribution over the whole corpus, 0..100. */
  percentile: number;
}

export interface Lens {
  text: string;
  /** The sentences actually encoded. More than one means the query is their mean direction. */
  phrases: string[];
  setId: string;
  hits: LensHit[];
  /** The query against every distinct work in the corpus: this is the ruler. */
  corpus: { n: number; mean: number; sd: number };
  /** The set's mean cosine to the query, and how far that is from the corpus mean in corpus sds. */
  setMean: number;
  z: number;
  /**
   * True when the set as a whole is no nearer this condition than a random corpus work — the
   * `NOTHING MEASURED` case, and the common one. A ranking is still printed, because the works are
   * worth looking at; it just is not evidence of anything.
   */
  nothingMeasured: boolean;
}

/**
 * Two standard deviations. Not a significance test and not presented as one: it is the line above
 * which a shift is worth a sentence, chosen before looking at any result and applied to every
 * position the same way.
 */
export const Z_FLOOR = 2;

function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Mean of unit vectors, renormalised. The mean of directions, not of magnitudes. */
export function meanDirection(vectors: Float32Array[]): Float32Array {
  const dim = (vectors[0] as Float32Array).length;
  const out = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] = (out[i] as number) + (v[i] as number);
  let n = 0;
  for (let i = 0; i < dim; i++) n += (out[i] as number) ** 2;
  n = Math.sqrt(n);
  // A set of vectors that cancel exactly has no mean direction. Returning the zero vector makes
  // every cosine 0, which reads as "unlike everything" rather than as "this query is not a
  // direction"; the caller cannot tell those apart, so this is the one place to refuse.
  if (n < 1e-9) throw new Error('the sentences of this text cancel out and have no mean direction');
  for (let i = 0; i < dim; i++) out[i] = (out[i] as number) / n;
  return out;
}

/**
 * The query text, the set, and the corpus that is the ruler.
 *
 * `embed` is passed in rather than imported so this stays testable without the 594 MB of ONNX
 * towers, and so the module does not decide when a download happens.
 */
export async function lens(
  text: string,
  resolved: Resolved,
  corpus: CorpusEmbeddings,
  embed: (phrases: string[]) => Promise<Float32Array[]>
): Promise<Lens> {
  // `sentences` drops anything under 12 characters, which is right for splitting a worldview into
  // clauses and wrong for a query typed at a prompt: "lace" is a condition someone would ask about
  // and it is not an empty text. So a text the splitter rejects entirely is encoded whole.
  const phrases = sentences(text).length > 0 ? sentences(text) : [text.replace(/\s+/g, ' ').trim()];
  if (phrases[0] === '') throw new Error('nothing to encode: the text is empty');
  const q = meanDirection(await embed(phrases));

  // The ruler first. Every distinct work, so the percentile below is a fact about the whole corpus
  // and not about a sample of it — `artist resemblance` strides 1,500 and reads 13 points different
  // on the same plate, which is exactly the mistake this avoids by not sampling.
  // Read from the matrix rather than from `rowAt`'s 512 default. The corpus is 512-wide and always
  // will be, but a silently mismatched width does not throw — `subarray` clamps, `dot` returns 0 for
  // every work, and the result is a corpus with sd 0 and a z of 0, which reads as a clean
  // NOTHING MEASURED rather than as a bug. The one failure mode this module exists to prevent.
  const dim = corpus.rows.length / corpus.entries.length;
  if (q.length !== dim) {
    throw new Error(`the query is ${q.length}-dimensional and the corpus is ${dim}: different spaces`);
  }
  const all = new Float64Array(corpus.entries.length);
  for (let i = 0; i < corpus.entries.length; i++) all[i] = dot(q, rowAt(corpus.rows, i, dim));
  let sum = 0;
  for (const c of all) sum += c;
  const mean = sum / all.length;
  let varSum = 0;
  for (const c of all) varSum += (c - mean) ** 2;
  const sd = Math.sqrt(varSum / all.length);
  const sorted = Float64Array.from(all).sort();

  const percentileOf = (c: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) < c) lo = mid + 1;
      else hi = mid;
    }
    return (100 * lo) / sorted.length;
  };

  const rowOf = new Map(corpus.entries.map((e, i) => [e.sha256, i]));
  const hits: LensHit[] = [];
  for (const work of resolved.works) {
    const row = rowOf.get(work.sha256);
    // A work in the resolved set with no row is a set resolved against a different embedding file.
    // Skipped rather than scored as 0, which would drag the set mean toward the corpus mean and
    // make a real effect look like nothing.
    if (row === undefined) continue;
    const c = dot(q, rowAt(corpus.rows, row, dim));
    hits.push({ work, cosine: c, percentile: percentileOf(c) });
  }
  hits.sort((a, b) => b.cosine - a.cosine);

  const setMean = hits.length > 0 ? hits.reduce((s, h) => s + h.cosine, 0) / hits.length : 0;
  const z = sd > 0 ? (setMean - mean) / sd : 0;
  return {
    text,
    phrases,
    setId: resolved.positionId,
    hits,
    corpus: { n: corpus.entries.length, mean, sd },
    setMean,
    z,
    nothingMeasured: Math.abs(z) < Z_FLOOR,
  };
}

export function lensText(l: Lens, k = 10): string {
  const out: string[] = [];
  out.push(`"${l.text}"`);
  out.push(
    `  encoded as ${l.phrases.length} sentence${l.phrases.length === 1 ? '' : 's'}, averaged` +
      `${l.phrases.length > 1 ? ' — the query is their mean direction, not any one of them' : ''}`
  );
  out.push(
    `  against ${l.setId}: ${l.hits.length} works, mean cosine ${l.setMean.toFixed(4)}\n` +
      `  against the corpus: ${l.corpus.n.toLocaleString()} works, mean ${l.corpus.mean.toFixed(4)} sd ${l.corpus.sd.toFixed(4)}`
  );
  out.push(
    l.nothingMeasured
      ? `  NOTHING MEASURED. The set sits ${l.z >= 0 ? '+' : ''}${l.z.toFixed(2)} sd from the corpus mean, inside the ±${Z_FLOOR} band.\n` +
        `  This condition does not pick this shelf out of the corpus. The ranking below is still the\n` +
        `  order the works come in; it is not evidence that the condition found them.`
      : `  The set sits ${l.z >= 0 ? '+' : ''}${l.z.toFixed(2)} sd from the corpus mean — this condition does\n` +
        `  ${l.z > 0 ? 'lean toward' : 'lean away from'} this shelf.`
  );
  out.push('');
  out.push(`  nearest ${Math.min(k, l.hits.length)} of the works this artist has looked at:`);
  for (const h of l.hits.slice(0, k)) {
    out.push(
      `    ${h.cosine.toFixed(4)}  p${h.percentile.toFixed(2).padStart(6)}  ${h.work.id.padEnd(12)} ${(h.work.title || '').slice(0, 44)}`
    );
  }
  out.push('');
  out.push('  Read the percentile, not the cosine. A text-image cosine of 0.30 is a high one; the two');
  out.push('  towers do not share a scale with image-image cosines, whose corpus median is 0.6428.');
  return out.map((s) => `${s}\n`).join('');
}
