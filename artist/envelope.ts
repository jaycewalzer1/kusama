// Where the edges actually are: the measured range of every descriptor over plates that exist.
//
// This file has one customer and it is not the archive. It is the move that has no code yet — take
// one dimension to the edge of what the medium can physically do and starve another. That move is
// expressible today, because five of the eighteen constraint kinds are ranges over exactly these
// quantities (`inkDensityRange`, `coverageRange`, `inkOffsetRange`, `symmetryMax`,
// `edgeContactRange`). What is missing is not a kind. It is a number: nobody knows what "the edge"
// is, so nobody can commit to it without making one up.
//
// ## The measurement this file refuses to make
//
// A descriptor is 0..1 *by construction*. Every one of them is a share — inked pixels over all
// pixels, covered cells over 256, a distance over the distance to the corner. So the arithmetic
// range is always [0,1] and it is worth nothing: it is a property of the definition, not of the
// medium. `inkDensity` cannot reach 1 on any sheet a person would call a picture, and a search told
// to aim at 1 aims at a black rectangle.
//
// So: measured, or nothing. And "nothing" has to be said out loud, because the failure mode here is
// the one this repo keeps finding — a summary that reports `min 0.00, max 1.00` over two plates
// reads exactly like a summary over two thousand. Hence `MIN_POINTS` and `stated: false`: under the
// threshold this reports a refusal, not a range. The archive is the cautionary tale sitting right
// beside it — it bins 0..1 uniformly on the assumption that plates use the whole interval, and
// nobody has ever checked whether they do. `envelopeText` prints the occupancy that answers it.
//
// ## Why the population is so small, which is itself a finding
//
// Three sources could supply points and only two can:
//
//   .cache/aesthetic-metrics    RenderMetrics keyed by program hash. Only entries at the CURRENT
//                               metrics version count. Older ones are not merely missing a field:
//                               v3 was invalidated because the renderer moved text, so its
//                               inkOffset, coverage and symmetry were taken off pixels that no
//                               longer exist. Reading them would be reading a different renderer.
//   finished runs               `final.png` + `final.json`, measured by `measureRuns` in
//                               archive.ts, which is reused here rather than reimplemented.
//   .cache/artist-png           470 plates, and NOT USABLE. The sidecar records
//                               `{pixelHash, width, height}` and no `ground`, and `ground` is a
//                               free hex per program — the example programs alone use eight
//                               distinct values, two of them near-black. Ink is measured as
//                               distance from the ground, so guessing it inverts the measurement on
//                               a dark sheet. They can be made usable by recording `ground` in the
//                               sidecar, which is a change to canvas.ts and is not made here.
//
// The way to grow the population is to render more programs; every render through `Measurer` writes
// its metrics into the cache and every plate widens the envelope. That costs a browser and no model
// call, which makes it the one part of the extremize move that can be built with no credit at all.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { DESCRIPTORS, descriptorsOf, measureRuns, type Descriptor } from './archive.js';
import type { RenderMetrics } from '../aesthetic/types.js';

/**
 * Below this, no range is stated.
 *
 * Six, and the number is an argument rather than a taste. An envelope is used to pick a target at
 * the edge, so what matters is the extreme, and the extreme of a sample is the least stable thing
 * in it: with two points the observed max is just the larger of two draws. Six is the fewest that
 * makes a p90 mean anything at all — it is the fifth of six — and it is still few enough that
 * `envelopeText` says so on every line rather than pretending the number has settled.
 */
export const MIN_POINTS = 6;

/** One measured plate. `from` is kept so a suspicious extreme can be traced back to a picture. */
export interface EnvelopePoint {
  id: string;
  from: 'metrics-cache' | 'run';
  values: Record<Descriptor, number>;
}

export interface DescriptorRange {
  descriptor: Descriptor;
  n: number;
  /**
   * False when `n < MIN_POINTS`. Every number below is still computed and still reported, because
   * hiding them would only mean the next caller recomputes them by hand; what this flag governs is
   * whether anything may be *concluded* from them. `envelopeText` prints the refusal, and any
   * caller that picks a target from an unstated range is choosing to make something up.
   */
  stated: boolean;
  min: number;
  max: number;
  p10: number;
  median: number;
  p90: number;
  /**
   * Observed span over the arithmetic span, which is 1 for every descriptor. The number the archive
   * needs and has never had: at 0.12 a uniform 6x6 grid over 0..1 puts every plate in one bin, and
   * the grid is not a grid.
   */
  occupancy: number;
}

export interface Envelope {
  points: number;
  /** Points that were found but thrown away, and why. Silent exclusions are how a sample lies. */
  excluded: { id: string; because: string }[];
  ranges: DescriptorRange[];
  sources: Record<EnvelopePoint['from'], number>;
  /**
   * Plates with no ink on them. Counted, kept, and said out loud rather than dropped.
   *
   * A blank sheet reads 0 on all nine descriptors at once, so a single one of them sets every
   * `min` in the table to 0.0000 — nine numbers that look like nine measurements and are one empty
   * picture. Dropping it would be worse: it is a thing the medium can produce, and an envelope that
   * quietly excludes the inconvenient end is not measured any more. So it stays in the sample and
   * the reader is told how much of the floor it is holding up.
   */
  blank: number;
}

/**
 * Nearest-rank, no interpolation.
 *
 * Interpolating would invent a value between two plates, and the whole point of this file is that
 * every number in it was taken off a picture that exists. `q` is 0..1; the result is always an
 * element of `sorted`.
 */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) throw new Error('quantile of an empty sample');
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** Pure: the envelope of a set of already-measured points. */
export function envelope(points: EnvelopePoint[], excluded: Envelope['excluded'] = []): Envelope {
  const ranges = DESCRIPTORS.map((descriptor): DescriptorRange => {
    const vs = points.map((p) => p.values[descriptor]).sort((a, b) => a - b);
    if (vs.length === 0) {
      return { descriptor, n: 0, stated: false, min: NaN, max: NaN, p10: NaN, median: NaN, p90: NaN, occupancy: NaN };
    }
    const min = vs[0]!;
    const max = vs[vs.length - 1]!;
    return {
      descriptor,
      n: vs.length,
      stated: vs.length >= MIN_POINTS,
      min,
      max,
      p10: quantile(vs, 0.1),
      median: quantile(vs, 0.5),
      p90: quantile(vs, 0.9),
      occupancy: max - min,
    };
  });

  const sources: Record<EnvelopePoint['from'], number> = { 'metrics-cache': 0, run: 0 };
  for (const p of points) sources[p.from]++;

  const blank = points.filter((p) => p.values.inkDensity === 0).length;

  return { points: points.length, excluded, ranges, sources, blank };
}

// --- gathering ------------------------------------------------------------------------------------

const METRICS_CACHE = path.join(ROOT, '.cache', 'aesthetic-metrics');

/**
 * The metrics-cache version this reads, taken from the file names rather than from a constant here.
 *
 * `METRICS_VERSION` is private to measure.ts and exporting it would make it look like a knob. The
 * highest `.v<n>.json` present *is* the current version by construction: a bump changes the name new
 * entries are written under, so the largest suffix on disk is what today's renderer produces. Null
 * when the cache is empty, which is a real state and not an error.
 */
export function currentMetricsVersion(dir = METRICS_CACHE): number | null {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .map((f) => /\.v(\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  return versions.length === 0 ? null : Math.max(...versions);
}

/**
 * Every plate the metrics cache can honestly speak for, plus every one it cannot and why.
 *
 * An entry at an older version is excluded rather than partly used. It is tempting to keep v3's
 * `inkDensity` on the grounds that only text moved — but v3 was invalidated because the renderer
 * changed what the pixels are, and `inkDensity` is over those pixels too. A sample mixing two
 * renderers measures neither.
 */
export function fromMetricsCache(dir = METRICS_CACHE): { points: EnvelopePoint[]; excluded: Envelope['excluded'] } {
  const points: EnvelopePoint[] = [];
  const excluded: Envelope['excluded'] = [];
  const current = currentMetricsVersion(dir);
  if (current === null) return { points, excluded };

  for (const file of readdirSync(dir).sort()) {
    const m = /^(.+)\.v(\d+)\.json$/.exec(file);
    if (!m) continue;
    const [, hash, version] = m as unknown as [string, string, string];
    const id = `cache:${hash.slice(0, 12)}`;
    if (Number(version) !== current) {
      excluded.push({ id, because: `metrics v${version}, and the current version is v${current}` });
      continue;
    }
    // Three ways this goes wrong and they are three different facts about the file, so they are
    // three different reasons. Collapsing them into one `try` reported a well-formed JSON file
    // missing `edgeContact` as "unreadable", which is a sample lying about why it dropped a point.
    let metrics: RenderMetrics;
    try {
      metrics = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as RenderMetrics;
    } catch {
      excluded.push({ id, because: 'unreadable' });
      continue;
    }
    // A version number is a claim about the shape, not a check of it. `descriptorsOf` throws on a
    // missing nested object and yields undefined for a missing flat one — and undefined read as a
    // confident zero is the recurring bug here, so both are caught rather than trusted.
    let values: Record<Descriptor, number>;
    try {
      values = descriptorsOf(metrics);
    } catch {
      excluded.push({ id, because: `at v${current} and not shaped like RenderMetrics` });
      continue;
    }
    const missing = DESCRIPTORS.filter((d) => !Number.isFinite(values[d]));
    if (missing.length > 0) {
      excluded.push({ id, because: `at v${current} and missing ${missing.join(', ')}` });
      continue;
    }
    points.push({ id, from: 'metrics-cache', values });
  }
  return { points, excluded };
}

/** Finished runs, through the same measurement the archive uses. */
export function fromRuns(runsDir: string): { points: EnvelopePoint[]; excluded: Envelope['excluded'] } {
  const { measured, skipped } = measureRuns(runsDir);
  return {
    points: measured.map((m) => ({ id: `run:${m.id}`, from: 'run' as const, values: descriptorsOf(m.metrics) })),
    excluded: skipped.map((dir) => ({ id: `run:${path.basename(dir)}`, because: 'not a readable finished run' })),
  };
}

/**
 * Both sources, deduplicated on the pixels.
 *
 * A finished run's plate is normally in the metrics cache too, and counting it twice would tighten
 * every quantile for free. The key is the pixel hash rather than the id, because the same image
 * reached here under two different names — that is the whole reason it is a duplicate.
 */
export function gather(runsDir: string | null): { points: EnvelopePoint[]; excluded: Envelope['excluded'] } {
  const cache = fromMetricsCache();
  const runs = runsDir === null ? { points: [], excluded: [] } : fromRuns(runsDir);

  const seen = new Set<string>();
  const points: EnvelopePoint[] = [];
  const excluded = [...cache.excluded, ...runs.excluded];
  // Runs first: a run has a directory a person can open, which makes it the more useful of two
  // names for the same picture.
  for (const p of [...runs.points, ...cache.points]) {
    const key = DESCRIPTORS.map((d) => p.values[d].toFixed(12)).join('|');
    if (seen.has(key)) {
      excluded.push({ id: p.id, because: 'the same plate is already counted under another name' });
      continue;
    }
    seen.add(key);
    points.push(p);
  }
  return { points, excluded };
}

// --- inspection -------------------------------------------------------------------------------------

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '   -  ');

export function envelopeText(e: Envelope): string {
  const head = [
    `${e.points} plate(s): ${e.sources.run} finished run(s), ${e.sources['metrics-cache']} from the metrics cache.`,
    '',
  ];

  if (e.points === 0) {
    return [
      ...head,
      'NOTHING MEASURED. There are no plates at the current metrics version and no finished runs.',
      'This is not an envelope of zero width; it is the absence of a measurement, and no target may',
      'be chosen from it.',
      ...excludedLines(e),
    ].join('\n');
  }

  const rows = e.ranges.map((r) =>
    [
      `  ${pad(r.descriptor, 20)}`,
      `n=${String(r.n).padStart(3)}`,
      ` min ${num(r.min)}`,
      ` p10 ${num(r.p10)}`,
      ` med ${num(r.median)}`,
      ` p90 ${num(r.p90)}`,
      ` max ${num(r.max)}`,
      `  uses ${(r.occupancy * 100).toFixed(1).padStart(5)}% of 0..1`,
      r.stated ? '' : '  NOT STATED',
    ].join('')
  );

  const unstated = e.ranges.filter((r) => !r.stated).length;
  const tail = unstated > 0
    ? [
        '',
        `${unstated} of ${e.ranges.length} descriptors have fewer than ${MIN_POINTS} plates and are marked NOT STATED.`,
        'Their numbers are printed because withholding them only invites recomputation by hand, but an',
        'extreme drawn from fewer than six plates is the larger of a handful of draws, not an edge of',
        'the medium. Render more programs — every render through Measurer widens this for free.',
      ]
    : [];

  const blankNote = e.blank > 0
    ? [
        '',
        `${e.blank} of these plates has no ink on it, which is where the 0.0000 in every min column`,
        'comes from. It is kept — a blank sheet is something the medium does — but no lower edge in',
        'this table has been measured against a picture.',
      ]
    : [];

  const widest = [...e.ranges].filter((r) => r.stated).sort((a, b) => b.occupancy - a.occupancy)[0];
  const narrowest = [...e.ranges].filter((r) => r.stated).sort((a, b) => a.occupancy - b.occupancy)[0];
  const archiveNote = widest && narrowest
    ? [
        '',
        `Widest observed: ${widest.descriptor} over ${(widest.occupancy * 100).toFixed(1)}% of 0..1.`,
        `Narrowest:       ${narrowest.descriptor} over ${(narrowest.occupancy * 100).toFixed(1)}%.`,
        'The archive bins 0..1 uniformly. A descriptor occupying a small share of that interval puts',
        'every plate in a couple of bins, and its grid is a line however many plates it holds.',
      ]
    : [];

  return [
    ...head,
    'descriptor              n   min     p10     med     p90     max',
    ...rows,
    ...blankNote,
    ...tail,
    ...archiveNote,
    ...excludedLines(e),
  ].join('\n');
}

function excludedLines(e: Envelope): string[] {
  if (e.excluded.length === 0) return [];
  const byReason = new Map<string, number>();
  for (const x of e.excluded) byReason.set(x.because, (byReason.get(x.because) ?? 0) + 1);
  return [
    '',
    `${e.excluded.length} plate(s) found and not counted:`,
    ...[...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([because, n]) => `  ${String(n).padStart(4)}  ${because}`),
  ];
}
