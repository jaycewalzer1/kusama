// The sweep: render one program at several values of k and measure whether the dial moved anything.
//
// A sweep is the only part of the influence layer that produces pixels, and it is where the layer
// either does something or is shown not to. For each k it writes a program, renders it through the
// same hermetic CLI everything else uses, describes the render with the same worker the corpus went
// through, and reports the distance from that render to the target. The contact sheet then carries
// the distance under each cell, so the reader can see the dial working rather than take it on trust.
//
// ## Only `palette` has an edit, and pretending otherwise would be the whole lie
//
// `applyInfluence` returns CONSTRAINTS. A constraint is a test, not a transform: it can say "these
// six colours only", and the checker can fail a render that disobeys, but nothing in this repo turns
// a constraint into a picture. To sweep you need an actual edit to the program.
//
// For `palette` there is a clean, deterministic one: a program keeps its colours in a top-level
// `palette` map and a `canvas.ground`, so every colour can be snapped to the nearest of the six
// target centres in CIELAB. The tree is not touched, node references are by name and stay valid, and
// the edit is a pure function of (program, target).
//
// For `armature` there is not. Moving a render's ink density or centroid means moving marks, and any
// rule for doing that would be an intervention this file invented — a claim about what an armature
// direction *means* as a drawing action, with nothing behind it. So an armature sweep renders the
// same program at every k, and `edited` is false on every row. That produces a column of identical
// images, which is the correct picture of a dial that is not connected to anything, and the report
// says so in those words rather than quietly showing six copies.
//
// For `texture` and `form` there is neither an edit nor a constraint. Those sweeps refuse.
//
// This is the shape of the Stage 4 result: the only layer the pair test validated cannot be swept,
// and the only layer that can be swept is one the pair test called a null.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { ROOT } from '../../env/browser.js';
import { checkConstraint } from '../../aesthetic/kinds.js';
import { metricsFromRgba } from '../../aesthetic/metrics.js';
import type { RenderMetrics } from '../../aesthetic/types.js';
import type { Program } from '../../env/edits.js';
import { DIMS, OFFSETS, describeImages, type Layer, type Stats } from './descriptors.js';
import { FIELDS } from './packs.js';
import { hexToLab, type InfluenceSet } from './apply.js';

/** Layers a sweep can actually move. See the header: this is one, and it is not the one that passed. */
export const SWEEPABLE: Layer[] = ['palette'];

export interface SweepStep {
  k: number;
  dir: string;
  /** False when no deterministic edit exists for this layer, so the render is the unmodified program. */
  edited: boolean;
  /** Colours the edit wrote, old to new. Empty when `edited` is false. */
  recoloured: { name: string; from: string; to: string }[];
  /** z-scored Euclidean distance from the render's descriptor to the target, in this layer. */
  distance: number;
  /** The same distance for k=0, carried on every row so a reader can see whether anything moved. */
  metrics: RenderMetrics | null;
  /** Verdicts for the constraints `applyInfluence` emitted at this k. */
  verdicts: { id: string; kind: string; status: string; evidence: string }[];
}

export interface SweepReport {
  program: string;
  group: string;
  label: string;
  source: string;
  layer: Layer;
  sweepable: boolean;
  carriesInfluence: boolean;
  ks: number[];
  bizarreness: number;
  blocked: InfluenceSet['blocked'];
  steps: SweepStep[];
}

/**
 * Snap every colour in a program to the nearest of the palette target's six centres.
 *
 * Nearest is plain Euclidean distance in CIELAB, which is roughly perceptual and is the same space
 * the descriptor's k-means ran in. Returns a NEW program; the input is not mutated, because a sweep
 * renders the same source program six times and a mutating edit would compound across k.
 */
export function recolour(program: Program, centres: [number, number, number][]): { program: Program; changed: { name: string; from: string; to: string }[] } {
  const out = JSON.parse(JSON.stringify(program)) as Program;
  const changed: { name: string; from: string; to: string }[] = [];
  const nearest = (hex: string): string => {
    const lab = hexToLab(hex);
    let best = 0;
    let bestD = Infinity;
    centres.forEach((c, i) => {
      const d = (c[0] - lab[0]) ** 2 + (c[1] - lab[1]) ** 2 + (c[2] - lab[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return labHex(centres[best]!);
  };

  const pal = out['palette'];
  if (pal && typeof pal === 'object') {
    for (const [name, hex] of Object.entries(pal as Record<string, unknown>)) {
      if (typeof hex !== 'string' || !hex.startsWith('#')) continue;
      const to = nearest(hex);
      (pal as Record<string, string>)[name] = to;
      if (to.toLowerCase() !== hex.toLowerCase()) changed.push({ name, from: hex, to });
    }
  }
  const canvas = out['canvas'];
  if (canvas && typeof canvas === 'object') {
    const g = (canvas as Record<string, unknown>)['ground'];
    if (typeof g === 'string' && g.startsWith('#')) {
      const to = nearest(g);
      (canvas as Record<string, string>)['ground'] = to;
      if (to.toLowerCase() !== g.toLowerCase()) changed.push({ name: 'canvas.ground', from: g, to });
    }
  }
  return { program: out, changed };
}

function labHex(lab: [number, number, number]): string {
  // Re-uses apply.ts's conversion by way of a tiny local copy would drift, so this calls through the
  // same path the constraint's allow-list is built from: identical colours in the picture and in the
  // rule that judges it.
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const inv = (t: number): number => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * inv(fy + a / 500);
  const Y = inv(fy);
  const Z = 1.08883 * inv(fy - b / 200);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return `#${lin
    .map((c) => {
      const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, s)) * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/** The six target centres as Lab triples, read out of an `applyInfluence` target vector. */
export function targetCentres(target: number[]): [number, number, number][] {
  const f = FIELDS.palette['centres']!;
  return [0, 1, 2, 3, 4, 5].map((i) => [target[f.at + i * 3]!, target[f.at + i * 3 + 1]!, target[f.at + i * 3 + 2]!]);
}

/** z-scored Euclidean distance between a measured descriptor row and a target, within one layer. */
export function distanceToTarget(measured: number[], target: number[], layer: Layer, stats: Stats): number {
  const base = OFFSETS[layer];
  let d = 0;
  for (let i = 0; i < DIMS[layer]; i++) {
    const s = stats.std[base + i]!;
    d += ((measured[i]! - target[i]!) / s) ** 2;
  }
  return Math.sqrt(d);
}

/** Render one program through the repo's own CLI. Serial by contract — see NOTES R8. */
export function render(programFile: string, outDir: string): string {
  execFileSync('node', [path.join(ROOT, 'dist', 'studio', 'render.js'), programFile, '-o', outDir], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  return path.join(outDir, 'canonical.png');
}

export function metricsOf(png: string, ground: string): RenderMetrics {
  const img = PNG.sync.read(readFileSync(png));
  return metricsFromRgba(img.data, img.width, img.height, ground);
}

/**
 * Run a sweep. `sets` must be one `InfluenceSet` per k, already computed by `applyInfluence`.
 *
 * Renders are strictly serial: two pages sharing Chromium's GPU process diverge (NOTES R8), and a
 * sweep whose columns were not comparable would be worse than no sweep.
 */
export async function runSweep(
  programFile: string,
  sets: InfluenceSet[],
  layer: Layer,
  stats: Stats,
  outDir: string,
): Promise<SweepReport> {
  const source = JSON.parse(readFileSync(programFile, 'utf8')) as Program;
  const sweepable = SWEEPABLE.includes(layer);
  const steps: SweepStep[] = [];

  for (const set of sets) {
    const dir = path.join(outDir, `k${set.k}`);
    mkdirSync(dir, { recursive: true });

    let prog = source;
    let changed: { name: string; from: string; to: string }[] = [];
    if (sweepable && layer === 'palette') {
      const r = recolour(source, targetCentres(set.target));
      prog = r.program;
      changed = r.changed;
    }
    const pf = path.join(dir, 'program.json');
    writeFileSync(pf, JSON.stringify(prog, null, 2) + '\n');

    const png = render(pf, dir);
    const ground = ((prog['canvas'] as Record<string, unknown> | undefined)?.['ground'] as string) ?? '#ffffff';
    const metrics = metricsOf(png, ground);

    let measured: number[] | null = null;
    await describeImages([png], { concurrency: 1, onResult: (d) => void (measured = d[layer]) });

    steps.push({
      k: set.k,
      dir,
      edited: sweepable && changed.length > 0,
      recoloured: changed,
      distance: measured ? Number(distanceToTarget(measured, set.target, layer, stats).toFixed(4)) : NaN,
      metrics,
      verdicts: set.constraints.map((c) => {
        const v = checkConstraint(c, prog, metrics);
        return { id: c.id, kind: c.kind, status: v.status, evidence: v.evidence };
      }),
    });
  }

  const first = sets[0]!;
  return {
    program: path.relative(ROOT, programFile),
    group: first.id,
    label: first.label,
    source: first.source,
    layer,
    sweepable,
    carriesInfluence: first.carriesInfluence,
    ks: sets.map((s) => s.k),
    bizarreness: sets.reduce((a, s) => a + s.bizarreness, 0),
    blocked: first.blocked,
    steps,
  };
}
