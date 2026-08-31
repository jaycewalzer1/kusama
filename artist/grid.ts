// Two sheets: the grid, and the strip.
//
// The grid is the only artefact in this system that can be looked at rather than read. Thirty cells,
// six positions down and five briefs across, plus a sixth column that is the control arm of the same
// briefs. Reading a table of tree scores tells you whether the checker was satisfied; looking at the
// grid tells you whether six positions produced six different kinds of picture, which is the actual
// question and is not in any of the numbers.
//
// The strip is one trajectory over time: the sheet after every accepted step. It answers a different
// question — whether the artist was working or accumulating — and it costs nothing, because every
// intermediate plate is already in the PNG cache under its program hash.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { decodePng, encodePng } from '../env/png.js';
import { contactSheet, type Image } from '../env/sheet.js';
import { readLog } from './studio-log.js';
import type { Scores } from './types.js';

const PNG_CACHE = path.join(ROOT, '.cache', 'artist-png');

/** A blank cell, so a missing trajectory leaves a hole in the grid rather than shifting everything. */
function blank(cell: number, shade = 0x30): Image {
  const rgba = Buffer.alloc(cell * cell * 4, shade);
  for (let p = 0; p < cell * cell; p++) rgba[4 * p + 3] = 255;
  return { rgba, width: cell, height: cell };
}

export interface GridCell {
  /** Directory of a finished trajectory, or null for a cell that was not run. */
  dir: string | null;
}

/**
 * `rows` is one row per position, each row one cell per column in order. Columns are the briefs, then
 * the control column last. Missing cells are drawn blank rather than skipped: a grid whose cells do
 * not line up with its axes is worse than no grid.
 */
export function gridSheet(rows: GridCell[][], cell = 300): { png: Buffer; missing: number } {
  const images: Image[] = [];
  let missing = 0;
  const cols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const dir = row[c]?.dir ?? null;
      const file = dir ? path.join(dir, 'final.png') : null;
      if (file && existsSync(file)) images.push(decodePng(readFileSync(file)));
      else {
        images.push(blank(cell));
        missing++;
      }
    }
  }
  const sheet = contactSheet(images, { cols, cell, gap: 10, background: [0x18, 0x18, 0x18] });
  return { png: encodePng(sheet.rgba, sheet.width, sheet.height), missing };
}

/**
 * Every plate this trajectory stood on, in order: the seed, then the result of each accepted step.
 * Pulled from the render cache by program hash, so this never opens a browser. A step whose plate has
 * been evicted from the cache is dropped, and the count of those is returned.
 */
export function strip(dir: string, cell = 220): { png: Buffer | null; frames: number; evicted: number } {
  const lines = readLog(path.join(dir, 'studio.jsonl'));
  const hashes: string[] = [];
  for (const line of lines) {
    if (line.kind === 'render') {
      const h = (line.data as { programHash: string }).programHash;
      if (hashes[hashes.length - 1] !== h) hashes.push(h);
    }
  }

  const images: Image[] = [];
  let evicted = 0;
  for (const h of hashes) {
    const file = path.join(PNG_CACHE, `${h}.png`);
    if (!existsSync(file)) {
      evicted++;
      continue;
    }
    images.push(decodePng(readFileSync(file)));
  }
  if (images.length === 0) return { png: null, frames: 0, evicted };

  const sheet = contactSheet(images, {
    cols: images.length,
    cell,
    gap: 8,
    background: [0x18, 0x18, 0x18],
  });
  return { png: encodePng(sheet.rgba, sheet.width, sheet.height), frames: images.length, evicted };
}

// --- cells, seeds and the spread -----------------------------------------------------------------
//
// The grid above answers "do six positions make six kinds of picture". These answer a different and
// harsher question: is any score in this system separating cells at all, or is every apparent cell
// effect inside the noise of running the same cell twice?
//
// n=1 per cell cannot tell those apart. Nothing below computes a p-value or a significance claim —
// there is no such claim to be made off five seeds — it reports the between-cell difference beside
// the within-cell spread and lets the reader see which is bigger.

/** One point in the design: a commission, an arm, and nothing else. Seeds vary within it. */
export interface Cell {
  positionId: string;
  briefId: string;
  /** The null-twin arm: L1 stripped, still graded against the real position. */
  control: boolean;
}

/**
 * `position:brief` with an optional trailing `:control`.
 *
 * Deliberately strict about arity. A cell spec with a part nobody reads would run a different
 * experiment than the one written on the command line, and the difference would not show up until
 * the scores were already collected.
 */
export function parseCell(spec: string): Cell {
  const parts = spec.split(':');
  const control = parts.length === 3 && parts[2] === 'control';
  if (parts.length !== 2 && !control) {
    throw new Error(`cell "${spec}" is not position:brief[:control] — got ${parts.length} part(s)`);
  }
  const [positionId, briefId] = parts as [string, string];
  if (!positionId || !briefId) throw new Error(`cell "${spec}" has an empty part`);
  return { positionId, briefId, control };
}

export function cellName(c: Cell): string {
  return `${c.positionId}__${c.briefId}${c.control ? '__control' : ''}`;
}

/** Where one seed of one cell lives. Stable, so an interrupted batch can find what it already did. */
export function runDir(root: string, c: Cell, seed: number): string {
  return path.join(root, cellName(c), `seed-${seed}`);
}

/**
 * A run counts as already done only if `final.json` is there. `scores.json` is written first and a
 * directory holding one but not the other is a run that died between the two writes — resuming over
 * it would keep a half-recorded trajectory and quietly shrink k.
 */
export function alreadyDone(dir: string): boolean {
  return existsSync(path.join(dir, 'final.json'));
}

/**
 * Every number in a Scores object, flattened to dotted paths.
 *
 * Walks the object rather than naming the scores, so a score added by a later repair appears in the
 * spread table without anyone remembering to list it here — the failure mode of an explicit list is
 * that the newest and least trusted score is the one missing from the analysis. Booleans count as
 * 0/1 because a rate over seeds is exactly what is wanted of them. Arrays are skipped: `affectTrace`
 * and `pendingRubrics` are traces, not scores, and averaging them would produce a number with no
 * referent. `null` is dropped rather than zeroed — see `Stat.n`.
 */
export function flattenScores(scores: Scores): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (v: unknown, prefix: string) => {
    if (typeof v === 'number') out.set(prefix, v);
    else if (typeof v === 'boolean') out.set(prefix, v ? 1 : 0);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, sub] of Object.entries(v)) walk(sub, prefix ? `${prefix}.${k}` : k);
    }
  };
  walk(scores, '');
  return out;
}

export interface Stat {
  /** How many seeds actually produced a number. Lower than k when the score was null on some. */
  n: number;
  mean: number;
  /** Population sd over the seeds in this cell. 0 when n < 2, which is not the same as agreement. */
  sd: number;
}

export interface ScoreSpread {
  score: string;
  perCell: { cell: string; stat: Stat }[];
  /** Largest cell mean minus smallest. The effect, if there is one. */
  between: number;
  /** Mean of the per-cell sds. The noise the effect has to clear. */
  within: number;
  /**
   * False when `between <= within`: on this data the score does not separate these cells. Not a
   * claim that it never could — it is a claim that this run is not evidence that it does.
   */
  separates: boolean;
}

function stat(values: number[]): Stat {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean: Math.round(mean * 1e6) / 1e6, sd: Math.round(sd * 1e6) / 1e6 };
}

/**
 * Per score: the mean and sd within each cell, and the between-cell difference against the pooled
 * within-cell spread.
 *
 * Cells with fewer than two seeds contribute an sd of 0, which flatters `separates`. That is why
 * `Stat.n` is reported per cell rather than assumed equal to k: a table whose within-cell spread is
 * zero because nothing was repeated should be readable as such.
 */
export function scoreSpreads(runs: { cell: string; scores: Scores }[]): ScoreSpread[] {
  const cells = [...new Set(runs.map((r) => r.cell))];
  const flat = runs.map((r) => ({ cell: r.cell, values: flattenScores(r.scores) }));
  const names = [...new Set(flat.flatMap((f) => [...f.values.keys()]))].sort();

  return names.map((score) => {
    const perCell = cells.map((cell) => ({
      cell,
      stat: stat(
        flat.filter((f) => f.cell === cell).map((f) => f.values.get(score)).filter((v): v is number => v !== undefined)
      ),
    }));
    const present = perCell.filter((p) => p.stat.n > 0);
    const means = present.map((p) => p.stat.mean);
    const between = means.length < 2 ? 0 : Math.max(...means) - Math.min(...means);
    const within = present.length === 0 ? 0 : present.reduce((a, p) => a + p.stat.sd, 0) / present.length;
    return {
      score,
      perCell,
      between: Math.round(between * 1e6) / 1e6,
      within: Math.round(within * 1e6) / 1e6,
      separates: between > within,
    };
  });
}

/**
 * The spread table, plainly, with the scores that measure nothing called out as such.
 *
 * Three ways this could congratulate itself on nothing. All three are closed here, and the first
 * one is closed because it actually happened: a batch that failed all nine runs printed "Every
 * score separated these cells by more than the spread within them," because an empty corpus has no
 * scores and so has no failing ones. A summary that reads as a pass when there is no data is the
 * same defect this whole repair pass is about.
 */
export function spreadText(spreads: ScoreSpread[]): string {
  if (spreads.length === 0) {
    return 'No scores: this corpus has no finished runs in it, so there is nothing to compare.';
  }

  const rows = spreads.map((s) => {
    const cells = s.perCell.map((p) => `${p.cell}=${p.stat.mean.toFixed(3)}+-${p.stat.sd.toFixed(3)}(n${p.stat.n})`);
    return `${s.separates ? '  ' : '! '}${s.score.padEnd(28)} between ${s.between.toFixed(3).padStart(8)}  within ${s.within
      .toFixed(3)
      .padStart(8)}  ${cells.join('  ')}`;
  });

  // Read off any score: every score carries the same cell list and the same per-cell n.
  const perCell = spreads[0]!.perCell;
  const withRuns = perCell.filter((p) => p.stat.n > 0);
  const unrepeated = withRuns.filter((p) => p.stat.n < 2).map((p) => p.cell);
  const dead = spreads.filter((s) => !s.separates);

  const notes: string[] = [];
  if (withRuns.length < 2) {
    notes.push(
      'Only one cell has runs in it, so every between-cell difference is 0 by construction and no score\n' +
        'can separate anything. This table reports within-cell spread and nothing else.'
    );
  }
  if (unrepeated.length > 0) {
    notes.push(
      `${unrepeated.length} cell(s) have fewer than two seeds, so their within-cell spread is 0 because nothing\n` +
        'was repeated, not because the seeds agreed. Any "separates" verdict resting on them is unearned:\n  ' +
        unrepeated.join('\n  ')
    );
  }
  notes.push(
    dead.length === 0
      ? 'Every score separated these cells by more than the spread within them.'
      : `${dead.length} score(s) marked ! have a between-cell difference no larger than the spread within a cell.\n` +
          'On this data they are not measuring anything:\n  ' +
          dead.map((s) => s.score).join('\n  ')
  );

  return [...rows, '', ...notes].join('\n\n');
}
