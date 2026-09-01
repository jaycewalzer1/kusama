// The TypeScript side of the per-layer descriptors: the worker's shape, how to run it, and how the
// cache is read back.
//
// The arithmetic itself is in `influence/descriptors.py` and deliberately not duplicated here. What
// this file owns is the *contract* -- the four layer widths and their offsets in a packed row -- and
// `tests/influence-descriptors.test.ts` asserts that contract against the worker's own `--spec`
// output whenever the venv exists, so the two sides cannot drift apart in silence. That check is the
// entire reason the dims are written down twice.
//
// ## Why the cache is written in `clip.f32`'s shape
//
// `corpus/descriptors.v1.f32` is rows of float32 in sorted sha256 order with a JSON index naming
// each row, which is byte-for-byte the layout `corpus/clip.f32` and `corpus/dino.f32` already use.
// That is not tidiness: it means `loadEmbeddings` in ../clip-index.ts reads it unchanged, and the
// dedupe rule -- 98 manifest rows share bytes with another row, and reading them twice has already
// produced two wrong numbers in this repo -- stays in exactly one place. A second loader that
// deduped differently would report its disagreement with the first as a finding about descriptors.
//
// One thing does NOT carry over. `nearest()` next to `loadEmbeddings` is a cosine over unit-length
// rows; descriptor rows are not unit-length and must never be fed to it. Distance here is z-scored
// Euclidean within one layer, which is what `distance()` below computes and the only comparison
// this layer licenses.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { loadEmbeddings, type CorpusEmbeddings } from '../clip-index.js';

export const LAYERS = ['armature', 'palette', 'texture', 'form'] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Must equal `influence/descriptors.py`'s `DIMS`. A test asserts it against `--spec`.
 *
 * armature 262 = a 16x16 luminance grid + aspect, area, centroid(2), symmetry(2)
 * palette   27 = 6 Lab centres (18) + 6 area fractions + L mean, L std, chroma mean
 * texture   58 = (mean, std) over a 4-scale x 6-orientation Gabor bank + a 10-bin uniform LBP
 * form      24 = 8 edge-hardness bins + curvature(3) + elongation + 12 orientation bins
 */
export const DIMS: Record<Layer, number> = { armature: 262, palette: 27, texture: 58, form: 24 };

/** Width of one packed row: the four layers concatenated in `LAYERS` order. */
export const ROW = LAYERS.reduce((n, l) => n + DIMS[l], 0);

/** Where each layer starts in a packed row. Derived, never written down by hand. */
export const OFFSETS: Record<Layer, number> = (() => {
  const out = {} as Record<Layer, number>;
  let at = 0;
  for (const l of LAYERS) {
    out[l] = at;
    at += DIMS[l];
  }
  return out;
})();

export const DESCRIPTOR_VERSION = 'v1';
export const WORKER = path.join(ROOT, 'influence', 'descriptors.py');
export const VENV_PYTHON = path.join(ROOT, 'influence', '.venv', 'bin', 'python');
export const MATRIX = path.join(ROOT, 'corpus', `descriptors.${DESCRIPTOR_VERSION}.f32`);
export const INDEX = path.join(ROOT, 'corpus', `descriptors.${DESCRIPTOR_VERSION}.index.json`);
export const STATS = path.join(ROOT, 'corpus', `descriptors.${DESCRIPTOR_VERSION}.stats.json`);

/**
 * The venv is gitignored, so a fresh clone has the worker and not its dependencies. Every caller
 * checks this first and a test skips on it, exactly as `artist/resemblance.ts` does for
 * `onnxruntime-node` -- an absent toolchain is a refusal with instructions in it, never a crash.
 */
export function workerAvailable(): boolean {
  return existsSync(VENV_PYTHON) && existsSync(WORKER);
}

export function workerUnavailableMessage(): string {
  return [
    `No descriptor worker at ${path.relative(ROOT, VENV_PYTHON)}.`,
    'It is Python and it is optional; the venv is gitignored and pinned by influence/requirements.txt:',
    '',
    '  python3.12 -m venv influence/.venv',
    '  influence/.venv/bin/pip install -r influence/requirements.txt',
    '',
    'Then re-run. See docs/influence/README.md.',
  ].join('\n');
}

export interface Described {
  path: string;
  armature: number[];
  palette: number[];
  texture: number[];
  form: number[];
  width: number;
  height: number;
}

export interface DescribeFailure {
  path: string;
  error: string;
}

/** One packed row from a worker result, in `LAYERS` order. */
export function pack(d: Described): Float32Array {
  const row = new Float32Array(ROW);
  for (const l of LAYERS) row.set(d[l], OFFSETS[l]);
  return row;
}

/**
 * Run the worker over `paths`, sharded across `concurrency` processes.
 *
 * Sharding is worth the complexity and was measured rather than assumed: one process with BLAS and
 * OpenCV threading free runs at 0.27s an image, and eight processes each pinned to a single thread
 * run at 0.040s -- 5.8x, because the operators here are too small to parallelise well internally and
 * the cores are better spent on whole images. Hence the four `*_NUM_THREADS` variables and
 * `cv2.setNumThreads` being left alone: they are the optimisation, not boilerplate.
 *
 * `onResult` is called per image as results stream back, so a 19,807-image run can report progress
 * and so a kill costs at most `concurrency` images rather than the whole run.
 */
export async function describeImages(
  paths: string[],
  opts: {
    concurrency?: number;
    onResult?: (d: Described) => void;
    onFailure?: (f: DescribeFailure) => void;
  } = {},
): Promise<{ described: number; failed: DescribeFailure[] }> {
  if (!workerAvailable()) throw new Error(workerUnavailableMessage());
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const shards: string[][] = Array.from({ length: concurrency }, () => []);
  paths.forEach((p, i) => shards[i % concurrency]!.push(p));

  const failed: DescribeFailure[] = [];
  let described = 0;

  await Promise.all(
    shards.filter((s) => s.length).map(
      (shard) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(VENV_PYTHON, [WORKER], {
            cwd: ROOT,
            // Pinned to one thread each: see the note above. Without this the shards fight over the
            // same cores and the whole exercise is slower than a single process.
            env: {
              ...process.env,
              OMP_NUM_THREADS: '1',
              OPENBLAS_NUM_THREADS: '1',
              MKL_NUM_THREADS: '1',
              NUMEXPR_NUM_THREADS: '1',
              VECLIB_MAXIMUM_THREADS: '1',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let buf = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line.trim()) continue;
              const r = JSON.parse(line) as (Described & { ok: true }) | (DescribeFailure & { ok: false });
              if (r.ok) {
                described++;
                opts.onResult?.(r);
              } else {
                failed.push({ path: r.path, error: r.error });
                opts.onFailure?.({ path: r.path, error: r.error });
              }
            }
          });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (c: string) => (stderr += c));
          child.on('error', reject);
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`descriptor worker exited ${code}: ${stderr.slice(0, 2000)}`)),
          );
          child.stdin.write(shard.map((p) => JSON.stringify({ path: p }) + '\n').join(''));
          child.stdin.end();
        }),
    ),
  );

  return { described, failed };
}

/** The worker's own `--spec`, for the drift test. Throws if the venv is missing. */
export async function workerSpec(): Promise<Record<string, unknown>> {
  if (!workerAvailable()) throw new Error(workerUnavailableMessage());
  return await new Promise((resolve, reject) => {
    const child = spawn(VENV_PYTHON, [WORKER, '--spec'], { cwd: ROOT });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`--spec exited ${code}`))));
  });
}

// --- reading the cache back -----------------------------------------------------------------------

export function descriptorsAvailable(): boolean {
  return existsSync(MATRIX) && existsSync(INDEX);
}

export function descriptorsUnavailableMessage(): string {
  return (
    `No descriptor cache at ${path.relative(ROOT, MATRIX)}. Build it with:\n` +
    `  npm run influence -- describe\n` +
    `It takes about 13 minutes over the 19,807 distinct corpus images.`
  );
}

/**
 * The cache joined to the manifest and deduped, through the one loader that knows those rules.
 * `dim` is `ROW`, not 512 -- passing the default would read 512 floats out of a 371-float row and
 * return a clean, entirely wrong answer rather than throwing.
 */
export function loadDescriptors(): CorpusEmbeddings {
  if (!descriptorsAvailable()) throw new Error(descriptorsUnavailableMessage());
  return loadEmbeddings(MATRIX, INDEX, ROW);
}

/** Per-dimension mean and standard deviation over the whole corpus. */
export interface Stats {
  version: string;
  rows: number;
  mean: number[];
  std: number[];
}

export function loadStats(): Stats {
  if (!existsSync(STATS)) {
    throw new Error(`No descriptor stats at ${path.relative(ROOT, STATS)}. Run: npm run influence -- describe`);
  }
  const s = JSON.parse(readFileSync(STATS, 'utf8')) as Stats;
  if (s.mean.length !== ROW || s.std.length !== ROW) {
    throw new Error(`${STATS} holds ${s.mean.length}-wide stats but a row is ${ROW} wide`);
  }
  return s;
}

/**
 * Mean and std per dimension.
 *
 * A dimension with no spread gets std 1, not 0. Several are legitimately constant on some corpora --
 * an LBP bin that never fires, a symmetry score on a corpus of one -- and dividing by their real
 * std would turn a dimension carrying no information into an infinity that dominates every distance.
 * Substituting 1 makes such a dimension contribute exactly 0 to every z-scored distance, which is
 * the honest answer: it separates nothing.
 */
export function computeStats(rows: Float32Array, count: number): Stats {
  const mean = new Array<number>(ROW).fill(0);
  const std = new Array<number>(ROW).fill(0);
  for (let i = 0; i < count; i++) for (let j = 0; j < ROW; j++) mean[j]! += rows[i * ROW + j]!;
  for (let j = 0; j < ROW; j++) mean[j]! /= count || 1;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < ROW; j++) {
      const d = rows[i * ROW + j]! - mean[j]!;
      std[j]! += d * d;
    }
  }
  for (let j = 0; j < ROW; j++) {
    const v = Math.sqrt(std[j]! / (count || 1));
    std[j] = v > 1e-9 ? v : 1;
  }
  return { version: DESCRIPTOR_VERSION, rows: count, mean, std };
}

/**
 * z-scored Euclidean distance between two packed rows, over one layer only.
 *
 * Per-dimension z-scoring is what makes the four layers comparable at all: raw, a Lab centre runs
 * 0..100 and an LBP bin runs 0..1, so an unscaled Euclidean over the palette layer would be a
 * measurement of L* and nothing else.
 */
export function distance(a: Float32Array, b: Float32Array, layer: Layer, stats: Stats): number {
  const from = OFFSETS[layer];
  const to = from + DIMS[layer];
  let sum = 0;
  for (let j = from; j < to; j++) {
    const d = (a[j]! - b[j]!) / stats.std[j]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** The mean of `rows` at the given row indices, as a packed row. */
export function centroid(rows: Float32Array, indices: number[]): Float32Array {
  const out = new Float32Array(ROW);
  if (!indices.length) return out;
  for (const i of indices) for (let j = 0; j < ROW; j++) out[j]! += rows[i * ROW + j]!;
  for (let j = 0; j < ROW; j++) out[j]! /= indices.length;
  return out;
}
