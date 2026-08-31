// The archive: finished plates filed by what they look like, not by what they scored.
//
// Archive-based search beats greedy search in every ablation anybody has run, and the reason is not
// that the archive finds better things — it is that a greedy loop deletes the intermediate that was
// going to be the ancestor of the good one. So: keep them all, filed by behaviour.
//
// But the documented way this fails describes this repo exactly. Novelty search over an unbounded
// behaviour space collapsed from 39/40 to 5/100, and "a JSON tree rendered to an image" is as
// unbounded as a space gets. Three constraints follow, and none of them is negotiable:
//
//   the descriptors are measured, not invented
//     Both axes come from `RenderMetrics`, which the checker already computes for every plate and
//     which is already normalised to 0..1 by construction. Nothing here defines a new quantity. A
//     descriptor invented for the archive would be a descriptor nothing else in the system can see,
//     and the grid would start reporting on itself.
//   there is a gate
//     A candidate with a hard constraint violated does not enter. Unbounded novelty is free and
//     worthless; the gate is what makes an occupied cell mean "a work that holds, and looks like
//     this" rather than "a failure, and it looks like this". Rejected candidates stay in the record
//     with the reason, because a gate whose rejections are invisible is a gate nobody can audit.
//   storage and inspection only
//     No mutation, no selection, no loop. This files the candidates that already exist. The moment
//     it proposes a candidate it is a search, and a search needs the pairwise judge that does not
//     exist yet to know which of two neighbours to keep.
//
// ## Why the default axes are inkDensity x inkOffset
//
// Five quantities are available and two get to be axes. The pair chosen is a mass and a position:
// how much ink there is, and how far from the centre it sits. Those are close to independent by
// construction — you can put a little ink anywhere and a lot of ink anywhere — which is the property
// a grid needs. `inkDensity` x `coverage` is the obvious pair and is the wrong one: both count ink,
// one per pixel and one per cell of a 16x16 grid, and two axes that measure the same thing make a
// 6x6 grid into a 6-cell diagonal. The archive reports the correlation between its own two axes for
// exactly this reason; see `summary.axisCorrelation`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { metricsFromRgba } from '../aesthetic/measure.js';
import type { RenderMetrics } from '../aesthetic/types.js';
import { decodePng } from '../env/png.js';

/** The five bounded quantities the checker already measures. Nothing else may be an axis. */
export const DESCRIPTORS = ['inkDensity', 'coverage', 'inkOffset', 'symmetryVertical', 'symmetryHorizontal'] as const;
export type Descriptor = (typeof DESCRIPTORS)[number];

export const DEFAULT_AXES: [Descriptor, Descriptor] = ['inkDensity', 'inkOffset'];
export const DEFAULT_BINS = 6;

export function descriptorsOf(m: RenderMetrics): Record<Descriptor, number> {
  return {
    inkDensity: m.inkDensity,
    coverage: m.coverage,
    inkOffset: m.inkOffset,
    symmetryVertical: m.symmetry.vertical,
    symmetryHorizontal: m.symmetry.horizontal,
  };
}

export interface Candidate {
  /** The run directory's name. One finished run is one candidate. */
  id: string;
  dir: string;
  pixelHash: string;
  /** All five, so a re-binning on different axes needs no pixels. */
  descriptors: Record<Descriptor, number>;
  hardViolations: number;
  admitted: boolean;
  /** Set when the gate refused it. Kept in the record: a silent gate cannot be audited. */
  rejectedBecause?: string;
  /** Null exactly when the candidate was not admitted. */
  cell: [number, number] | null;
}

export interface ArchiveCell {
  x: number;
  y: number;
  members: string[];
  /**
   * The best of the members, or null when nothing can rank them.
   *
   * The elite is meant to be the best pairwise judge rank in the cell. Until that judge exists there
   * is no ranking, and picking one by any of the numbers already on disk would be the wrong move
   * twice over: those are constraint scores, and a cell full of candidates that all satisfy every
   * constraint is exactly the case an archive is for. So the cell keeps its members and says it has
   * no elite, rather than electing one by a proxy nobody chose.
   */
  elite: string | null;
  eliteBasis: 'rank' | 'unranked';
}

export interface Archive {
  axes: [Descriptor, Descriptor];
  bins: number;
  candidates: Candidate[];
  /** Occupied cells only, in row-major order. An empty grid is 0 cells, not 36 nulls. */
  cells: ArchiveCell[];
  summary: {
    scanned: number;
    admitted: number;
    rejected: number;
    occupied: number;
    /** Occupied over bins squared. The number an archive is judged by. */
    fill: number;
    /**
     * Pearson correlation between the two axis values over admitted candidates, or null under three
     * candidates. Above 0.8 the two axes are one axis and the grid is a line; that is reported here
     * rather than enforced, because with two runs on disk the number is noise and a gate on noise is
     * worse than no gate.
     */
     axisCorrelation: number | null;
  };
}

// --- binning ---------------------------------------------------------------------------------------

/** A 0..1 value to a bin index. 1.0 lands in the last bin rather than falling off the end. */
export function bin(value: number, bins: number): number {
  if (!Number.isFinite(value)) throw new Error(`descriptor value must be a number, got ${String(value)}`);
  const clamped = Math.min(1, Math.max(0, value));
  return Math.min(bins - 1, Math.floor(clamped * bins));
}

/** Whether an axis moved at all, on a scale where every value is already 0..1. */
function varies(vs: number[]): boolean {
  return Math.max(...vs) - Math.min(...vs) > 1e-9;
}

/**
 * Pearson, or null when there is no evidence. Exported because `ratings.ts` needs exactly this
 * function and a second copy would be a second chance to reintroduce the constant-axis bug below.
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  // Tested on the spread, not on the sum of squares. Three identical values do not give a variance
  // of exactly zero in floating point — their mean is off by an ulp — so a `=== 0` guard let a
  // correlation of 0 out for an axis that never moved, which reads as "independent" when the truth
  // is "no evidence". The test that caught it is the one that asked for a constant axis.
  if (!varies(xs) || !varies(ys)) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return num / Math.sqrt(dx * dy);
}

// --- building ----------------------------------------------------------------------------------------

export interface Measured {
  id: string;
  dir: string;
  metrics: RenderMetrics;
  hardViolations: number;
}

/**
 * File measured candidates into a grid.
 *
 * Pure: takes the measurements rather than reading pixels, so the binning, the gate and the fill are
 * testable without a PNG. `ranks` is the pairwise judge's ordering when there is one — lower is
 * better — and its absence is reported per cell rather than papered over.
 */
export function archive(
  measured: Measured[],
  axes: [Descriptor, Descriptor] = DEFAULT_AXES,
  bins: number = DEFAULT_BINS,
  ranks: Record<string, number> = {}
): Archive {
  const candidates: Candidate[] = measured.map((m) => {
    const descriptors = descriptorsOf(m.metrics);
    const admitted = m.hardViolations === 0;
    return {
      id: m.id,
      dir: m.dir,
      pixelHash: m.metrics.pixelHash,
      descriptors,
      hardViolations: m.hardViolations,
      admitted,
      ...(admitted ? {} : { rejectedBecause: `${m.hardViolations} hard constraint(s) violated` }),
      cell: admitted ? ([bin(descriptors[axes[0]], bins), bin(descriptors[axes[1]], bins)] as [number, number]) : null,
    };
  });

  const byCell = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.cell) continue;
    const key = `${c.cell[0]},${c.cell[1]}`;
    byCell.set(key, [...(byCell.get(key) ?? []), c]);
  }

  const cells: ArchiveCell[] = [...byCell.entries()]
    .map(([key, members]) => {
      const [x, y] = key.split(',').map(Number) as [number, number];
      const ranked = members.filter((m) => ranks[m.id] !== undefined);
      const elite = ranked.length
        ? ranked.reduce((best, m) => (ranks[m.id]! < ranks[best.id]! ? m : best)).id
        : null;
      return {
        x,
        y,
        members: members.map((m) => m.id).sort(),
        elite,
        eliteBasis: (elite === null ? 'unranked' : 'rank') as 'rank' | 'unranked',
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const admitted = candidates.filter((c) => c.admitted);
  return {
    axes,
    bins,
    candidates,
    cells,
    summary: {
      scanned: candidates.length,
      admitted: admitted.length,
      rejected: candidates.length - admitted.length,
      occupied: cells.length,
      fill: cells.length / (bins * bins),
      axisCorrelation: pearson(
        admitted.map((c) => c.descriptors[axes[0]]),
        admitted.map((c) => c.descriptors[axes[1]])
      ),
    },
  };
}

// --- reading finished runs off disk -------------------------------------------------------------------

interface FinalJson {
  finalProgram?: { canvas?: { ground?: string } };
  scores?: { hardViolations?: number };
}

/**
 * Measure every finished run under `runsDir`.
 *
 * The plate is re-measured from `final.png` rather than read out of the log, because the log does
 * not carry `RenderMetrics` and adding it would change what a run records — a bigger change than
 * this file is worth. `final.png` is the printed image (`Canvas.render` encodes it post-
 * `printRender`), which is what `metricsFromRgba` requires; measuring the browser plate would score
 * a picture nobody will ever see and nothing here could tell the difference.
 *
 * A directory missing either file is not a finished run and is skipped. One missing `hardViolations`
 * is a different matter: it is refused rather than defaulted to 0, because defaulting would admit an
 * unknown through the one gate this file has.
 */
export function measureRuns(runsDir: string): { measured: Measured[]; skipped: string[] } {
  const measured: Measured[] = [];
  const skipped: string[] = [];
  if (!existsSync(runsDir)) return { measured, skipped };

  for (const entry of readdirSync(runsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    const png = path.join(dir, 'final.png');
    const json = path.join(dir, 'final.json');
    if (!existsSync(png) || !existsSync(json)) continue;
    try {
      const final = JSON.parse(readFileSync(json, 'utf8')) as FinalJson;
      const ground = final.finalProgram?.canvas?.ground;
      const hard = final.scores?.hardViolations;
      if (typeof ground !== 'string' || typeof hard !== 'number') {
        skipped.push(dir);
        continue;
      }
      const { rgba, width, height } = decodePng(readFileSync(png));
      measured.push({ id: entry.name, dir, metrics: metricsFromRgba(rgba, width, height, ground), hardViolations: hard });
    } catch {
      skipped.push(dir);
    }
  }
  return { measured, skipped };
}

// --- inspection ---------------------------------------------------------------------------------------

/** The grid as a block of text, y downward, with a count per cell. */
export function archiveText(a: Archive): string {
  const at = new Map(a.cells.map((c) => [`${c.x},${c.y}`, c]));
  const rows: string[] = [];
  for (let y = a.bins - 1; y >= 0; y--) {
    const cells: string[] = [];
    for (let x = 0; x < a.bins; x++) {
      const c = at.get(`${x},${y}`);
      cells.push(c ? String(c.members.length).padStart(3) : '  .');
    }
    rows.push(`${(((y + 1) / a.bins) * 100).toFixed(0).padStart(4)}% |${cells.join('')}`);
  }
  const s = a.summary;
  const corr =
    s.axisCorrelation === null
      ? 'axis correlation: not enough candidates to say (needs 3 that vary on both axes)'
      : `axis correlation: ${s.axisCorrelation.toFixed(2)}${Math.abs(s.axisCorrelation) > 0.8 ? '  ** above 0.8: these two axes are one axis, and the grid is a line **' : ''}`;

  return [
    `axes: x = ${a.axes[0]}, y = ${a.axes[1]}, ${a.bins}x${a.bins}`,
    '',
    ...rows,
    `     +${'-'.repeat(a.bins * 3)}`,
    `      ${a.axes[0]} 0% -> 100%`,
    '',
    `${s.admitted}/${s.scanned} admitted, ${s.rejected} refused by the gate.`,
    `${s.occupied}/${a.bins * a.bins} cells occupied (fill ${(s.fill * 100).toFixed(1)}%).`,
    corr,
    a.cells.some((c) => c.eliteBasis === 'unranked')
      ? 'No cell has an elite: that needs the pairwise judge, and electing one by a constraint score would be the wrong instrument.'
      : '',
    ...a.candidates
      .filter((c) => !c.admitted)
      .map((c) => `refused: ${c.id} — ${c.rejectedBecause}`),
  ]
    .filter((l) => l !== '')
    .join('\n');
}
