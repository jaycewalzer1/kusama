// Verbalized sampling: ask for a distribution, then sample it, instead of taking the first answer.
//
// A preference-tuned model handed "give me an approach" returns the modal approach. That is what
// preference tuning is for, and it is exactly wrong here: three sketches of one problem, generated
// independently from one prompt, converge on the same idea because each call independently picks the
// mode. The fix is not a temperature knob — temperature widens the tail of the *token* distribution,
// which mostly buys typos. It is to make the model name several candidates and state how likely each
// is, and then to sample from what it said rather than reading the top line.
//
// Two properties this file exists to guarantee:
//
//  1. **The distribution is a record, not a mechanism.** What the model proposed and what weight it
//     gave each candidate is written to the log whether or not the candidate was used. An offline
//     reader can therefore ask what the run declined, which is the only way to tell "the model had
//     one idea" from "the model had five and we picked one".
//  2. **The draw is a pure function of the run seed and the candidates.** No `Math.random`, no clock.
//     `replay` re-runs a trajectory with the model unplugged; if the sampler were not seeded off
//     something already in the log, replay would take a different draw and the whole chain would
//     diverge one line later.
//
// Nothing here calls a model or touches disk. The phases do that.

/** How many candidates a verbalized call asks for. Five is the smallest k that has a tail at all. */
export const VS_K = 5;

export interface Weighted {
  /** What the model says the chance is that this is the answer it would have given. */
  probability: number;
}

/**
 * A candidate the model refused to weight, or weighted with a number that is not a number, is worth
 * recording and not worth trusting. It gets the floor rather than being dropped: dropping it would
 * quietly shrink k and make the distribution look tighter than it was.
 */
const FLOOR = 1e-6;

function clean(p: unknown): number {
  const n = typeof p === 'number' ? p : Number(p);
  if (!Number.isFinite(n) || n <= 0) return FLOOR;
  return n;
}

/**
 * The stated probabilities renormalized to sum to one. Models do not add up — measured sums land
 * anywhere from 0.6 to 1.4 — and a sampler that trusted the raw numbers would silently weight a run
 * whose numbers happened to sum high differently from one whose numbers summed low.
 *
 * The returned weights are parallel to the input; the input is not modified, because the *stated*
 * numbers are what gets logged and rewriting them would destroy the record this file exists to keep.
 */
export function normalized(candidates: readonly Weighted[]): number[] {
  const raw = candidates.map((c) => clean(c.probability));
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => r / total);
}

/**
 * xorshift32. Small, seedable from an integer, and identical on every platform.
 *
 * The first few outputs are discarded. xorshift is badly behaved near small seeds — seeded 1, 2, 3
 * in turn its first output is very nearly the same number three times, so a run whose seed is 1 and
 * a run whose seed is 2 would take the same draw. This showed up as a failing test rather than as
 * reasoning: the weighted draw came back 400/400 on the heavy candidate when it should have come
 * back around 380. Six turns is enough to decorrelate; it costs nothing.
 */
export function rng(seed: number): () => number {
  let x = seed | 0 || 0x9e3779b9;
  const step = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    // >>> 0 first: the shifts leave a signed 32-bit value and a negative one would break the draw.
    return (x >>> 0) / 0x100000000;
  };
  for (let i = 0; i < 6; i++) step();
  return step;
}

/** FNV-1a over a label, so a phase can name its own stream without the caller counting calls. */
export function streamSeed(runSeed: number, label: string): number {
  let h = 0x811c9dc5 ^ (runSeed | 0);
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * `n` draws from the distribution, without replacement, by repeated weighted draw with the taken
 * mass removed each time.
 *
 * Without replacement because every caller here wants a *set* — three different problems, three
 * different approaches — and a with-replacement draw returns the mode twice about a third of the
 * time, which is the failure this whole file is about.
 *
 * Returns indices, not items, so the caller keeps its own types and can line the draw up against the
 * distribution it logged.
 */
export function sampleIndices(candidates: readonly Weighted[], n: number, next: () => number): number[] {
  const weights = normalized(candidates);
  const remaining = candidates.map((_, i) => i);
  const picked: number[] = [];
  const want = Math.min(n, candidates.length);
  while (picked.length < want) {
    const mass = remaining.reduce((a, i) => a + weights[i]!, 0);
    let r = next() * mass;
    let chosen = remaining[remaining.length - 1]!;
    for (const i of remaining) {
      r -= weights[i]!;
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    picked.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return picked;
}

/** What the log line carries: everything proposed, and which of it was drawn. */
export interface Distribution {
  /** Which verbalized call this was — `find`, or `propose:<problemId>`. */
  stream: string;
  seed: number;
  /** Every candidate as the model stated it, in the order it stated them. */
  stated: { key: string; probability: number }[];
  /** Indices into `stated`, in draw order. */
  drawn: number[];
}

export function distribution(
  stream: string,
  seed: number,
  candidates: readonly (Weighted & { key: string })[],
  drawn: number[]
): Distribution {
  return {
    stream,
    seed,
    stated: candidates.map((c) => ({ key: c.key, probability: c.probability })),
    drawn,
  };
}

/**
 * Did the run take the mode? Not a score — a diagnostic. If this is true on every stream of every
 * run, the sampler is present and doing nothing, and that is worth being able to see without
 * re-reading the logs by hand.
 */
export function tookTheMode(d: Distribution): boolean {
  if (d.stated.length === 0 || d.drawn.length === 0) return false;
  let best = 0;
  for (let i = 1; i < d.stated.length; i++) if (d.stated[i]!.probability > d.stated[best]!.probability) best = i;
  return d.drawn[0] === best;
}
