// A trajectory's own pixels, placed in the corpus's space. Sidecar only.
//
// `artist/resemblance.ts` already asks "is this final plate a quotation of a museum work?" against a
// 1,500-work stride sample. This file asks more, and asks it of every plate a run left behind rather
// than only the last one: where does each sit against the whole 19,791-row corpus, and — the
// question the night was for — does it sit nearer the position's own influences than chance.
//
// ## Nothing here is written into `scores.json`
//
// The trajectory scores are a record of an experiment that has already been run under a stated
// `envVersion`. Adding a column to them retrospectively would make old runs and new runs
// incomparable while looking like it had made them more comparable. So this writes
// `scores.corpus.json` beside, and `plates.clip.f32` + `plates.clip-index.json` beside that.
//
// ## THE STEP PLATES DO NOT EXIST, and that is the finding
//
// The brief asked for "every `final.png` and every step plate". There are no step plates. A `render`
// log line records a `pixelHash` and a `programHash` and the renderer's PNG is not kept, so what
// survives a run is the final plate and the FIND/SKETCH thumbnails — and sketches are alternatives
// considered at one moment, not a canvas over time. The drift question in 3.3 ("does a trajectory
// move toward its influences during MAKE") is therefore **unanswerable from the data on disk**, and
// `drift` is null with that reason attached rather than being computed over sketches, which would
// have produced a number that looked like an answer to a question nobody asked.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { DIM, loadCorpusEmbeddings, rowAt } from './clip-index.js';
import { MODEL_SHA256, embed, similarity } from './resemblance.js';
import { loadResolved, type Resolved } from './influences.js';
import { decode } from './pixels.js';

/** Matches `resemblance.ts`, so the two files' percentiles mean the same thing. */
export const BAND_SAMPLE = 1500;
export const COPY_COSINE = 0.95;

export interface CorpusRef {
  sha256: string;
  id: string;
  title: string;
  museum: string;
  cosine: number;
}

export interface PlateRecord {
  /** sha256 of the PNG bytes. The plate's identity, and the cache key the embedding was made under. */
  sha256: string;
  /** Path relative to the trajectory directory. */
  file: string;
  kind: 'final' | 'sketch';
  /**
   * MAKE step this plate came from, or null. Always null today: no run has ever persisted a step
   * plate. Kept so that a run made after Stage 5 can fill it without a schema change.
   */
  step: number | null;
  width: number;
  height: number;
  /**
   * The plate's aspect before the encoder's centre-crop. A 3:1 plate loses its ends to the crop and
   * its embedding is of the middle third, so every cosine below is about less of it than it looks.
   */
  aspect: number;
  nearestCorpus: CorpusRef;
  /** Where `nearestCorpus.cosine` falls in the corpus's own pair distribution, 0..1. */
  corpusPercentile: number;
  nearestInfluence: CorpusRef | null;
  cosineToInfluenceCentroid: number | null;
  /**
   * Where that cosine falls among all 19,791 corpus works' cosines to the same centroid, 0..1.
   *
   * The raw cosine is unreadable on its own. CLIP image embeddings live in a narrow cone, so
   * everything is 0.5-0.8 from everything and 0.60 looks like a relationship when it is the floor.
   * This is the number that says whether a plate is actually near the influences: 0.50 means the
   * plate is exactly as near them as a corpus work drawn at random.
   */
  influencePercentile: number | null;
  /** `1 - nearestCorpus.cosine`. Distance from the nearest thing a museum already holds. */
  novelty: number;
  copyFlag: boolean;
}

export interface Band {
  works: number;
  pairs: number;
  min: number;
  median: number;
  max: number;
}

export interface Drift {
  measured: false;
  reason: string;
}

export interface PlateSidecar {
  version: 1;
  dir: string;
  /** The encoder these numbers are relative to. Mixing two is meaningless, so it is recorded. */
  model: string;
  positionId: string | null;
  influencesHash: string | null;
  band: Band;
  corpusRows: number;
  plates: PlateRecord[];
  drift: Drift | null;
}

function percentileIn(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length === 0 ? 0 : lo / sorted.length;
}

let band: { band: Band; sorted: Float64Array } | null = null;

/**
 * The corpus's own pair-similarity distribution, from a stride sample of the deduped rows.
 *
 * A stride and not a prefix: `corpus/manifest.jsonl` is written museum by museum, so the first 1,500
 * rows are all one museum and their pair distribution is a fact about that museum. All pairs of 1,500
 * is 1.1M numbers; all pairs of 19,791 is 195M, which is the reason for sampling at all.
 */
export function corpusBand(sample = BAND_SAMPLE): { band: Band; sorted: Float64Array } {
  if (band && band.band.works === Math.min(sample, loadCorpusEmbeddings().entries.length)) return band;
  const corpus = loadCorpusEmbeddings();
  const n = corpus.entries.length;
  const take = Math.min(sample, n);
  const stride = n / take;
  const vectors: Float32Array[] = [];
  for (let i = 0; i < take; i++) vectors.push(rowAt(corpus.rows, Math.floor(i * stride)));

  const pairs = new Float64Array((take * (take - 1)) / 2);
  let at = 0;
  for (let i = 0; i < take; i++) {
    for (let j = i + 1; j < take; j++) pairs[at++] = similarity(vectors[i]!, vectors[j]!);
  }
  pairs.sort();
  band = {
    band: {
      works: take,
      pairs: pairs.length,
      min: pairs[0]!,
      median: pairs[Math.floor(pairs.length / 2)]!,
      max: pairs[pairs.length - 1]!,
    },
    sorted: pairs,
  };
  return band;
}

/**
 * Every plate a trajectory directory kept, in a stable order.
 *
 * `final.png` first because it is the one that matters, then the sketches in name order. Ordering is
 * not cosmetic: it is the row order of `plates.clip.f32`, which the index file names.
 */
export function platesIn(dir: string): { file: string; kind: 'final' | 'sketch' }[] {
  const out: { file: string; kind: 'final' | 'sketch' }[] = [];
  if (existsSync(path.join(dir, 'final.png'))) out.push({ file: 'final.png', kind: 'final' });
  const sketches = path.join(dir, 'sketches');
  if (existsSync(sketches)) {
    for (const f of readdirSync(sketches).sort()) {
      if (f.endsWith('.png')) out.push({ file: path.join('sketches', f), kind: 'sketch' });
    }
  }
  return out;
}

/**
 * The position a trajectory was run under, from its own log rather than from its directory name.
 *
 * `out/condition-withheld` is named after a condition and a position, and reading the name would be
 * guessing. The `trajectory-start` line records what was actually loaded.
 */
export function positionOf(dir: string): string | null {
  const log = path.join(dir, 'studio.jsonl');
  if (!existsSync(log)) return null;
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { kind?: string; data?: Record<string, unknown> };
      if (row.kind !== 'trajectory-start') continue;
      const d = row.data ?? {};
      for (const key of ['positionId', 'position', 'cell']) {
        const v = d[key];
        if (typeof v === 'string' && v.length > 0) return v.split(':')[0]!;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function readTrajectory(dir: string): Promise<{ sidecar: PlateSidecar; vectors: Float32Array[] }> {
  const corpus = loadCorpusEmbeddings();
  const { band: b, sorted } = corpusBand();
  const positionId = positionOf(dir);
  const resolved: Resolved | null = positionId ? loadResolved(positionId) : null;
  const centroid = resolved ? Float32Array.from(resolved.centroid) : null;
  // Every corpus work's cosine to that centroid, sorted, so a plate's cosine can be read as a
  // percentile against the corpus rather than as a bare number in a range nobody knows.
  let centroidBand: Float64Array | null = null;
  if (centroid) {
    centroidBand = new Float64Array(corpus.entries.length);
    for (let i = 0; i < corpus.entries.length; i++) centroidBand[i] = similarity(centroid, rowAt(corpus.rows, i));
    centroidBand.sort();
  }
  const influenceRows = resolved
    ? resolved.works
        .map((w) => corpus.entries.find((e) => e.sha256 === w.sha256))
        .filter((e): e is NonNullable<typeof e> => e !== undefined)
    : [];

  const files = platesIn(dir);
  const vectors: Float32Array[] = [];
  const plates: PlateRecord[] = [];

  for (const { file, kind } of files) {
    const full = path.join(dir, file);
    const v = await embed(full);
    vectors.push(v);
    const px = decode(full);

    let bestRow = 0;
    let best = -Infinity;
    for (let i = 0; i < corpus.entries.length; i++) {
      const s = similarity(v, rowAt(corpus.rows, i));
      if (s > best) {
        best = s;
        bestRow = i;
      }
    }
    const ref = (row: number, cos: number): CorpusRef => {
      const e = corpus.entries[row]!;
      return {
        sha256: e.sha256,
        id: e.work.id,
        title: e.work.title ?? '',
        museum: e.work.source,
        cosine: cos,
      };
    };

    let nearestInfluence: CorpusRef | null = null;
    for (const e of influenceRows) {
      const s = similarity(v, rowAt(corpus.rows, e.row));
      if (nearestInfluence === null || s > nearestInfluence.cosine) nearestInfluence = ref(e.row, s);
    }

    plates.push({
      sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
      file,
      kind,
      step: null,
      width: px.width,
      height: px.height,
      aspect: px.width / px.height,
      nearestCorpus: ref(bestRow, best),
      corpusPercentile: percentileIn(sorted, best),
      nearestInfluence,
      cosineToInfluenceCentroid: centroid ? similarity(v, centroid) : null,
      influencePercentile: centroidBand ? percentileIn(centroidBand, similarity(v, centroid!)) : null,
      novelty: 1 - best,
      copyFlag: best > COPY_COSINE,
    });
  }

  const sidecar: PlateSidecar = {
    version: 1,
    dir: path.relative(ROOT, path.resolve(dir)),
    model: MODEL_SHA256,
    positionId,
    influencesHash: resolved?.influencesHash ?? null,
    band: b,
    corpusRows: corpus.entries.length,
    plates,
    drift: driftOf(plates),
  };
  return { sidecar, vectors };
}

/**
 * Whether the trajectory moved toward its influences over the run. It cannot be computed, and the
 * reason is stated rather than the question being dropped.
 */
function driftOf(plates: PlateRecord[]): Drift | null {
  if (plates.length === 0) return null;
  const steps = plates.filter((p) => p.step !== null);
  if (steps.length >= 2) return null;
  return {
    measured: false,
    reason:
      'NOTHING MEASURED: drift needs a plate per MAKE step and no run has ever persisted one. A ' +
      '`render` log line keeps a pixelHash, not the pixels. Sketches are alternatives considered ' +
      'at one moment, not a canvas over time, so a "drift" computed over them would answer a ' +
      'different question while looking like an answer to this one.',
  };
}

export function writeSidecar(dir: string, sidecar: PlateSidecar, vectors: Float32Array[]): string[] {
  const matrix = Buffer.allocUnsafe(vectors.length * DIM * 4);
  vectors.forEach((v, i) => {
    for (let j = 0; j < DIM; j++) matrix.writeFloatLE(v[j]!, (i * DIM + j) * 4);
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plates.clip.f32'), matrix);
  writeFileSync(
    path.join(dir, 'plates.clip-index.json'),
    JSON.stringify(sidecar.plates.map((p) => p.sha256), null, 2) + '\n',
  );
  writeFileSync(path.join(dir, 'scores.corpus.json'), JSON.stringify(sidecar, null, 2) + '\n');
  return ['plates.clip.f32', 'plates.clip-index.json', 'scores.corpus.json'].map((f) => path.join(dir, f));
}

export async function readAndWrite(dir: string): Promise<{ sidecar: PlateSidecar; written: string[] }> {
  const { sidecar, vectors } = await readTrajectory(dir);
  return { sidecar, written: writeSidecar(dir, sidecar, vectors) };
}

export function loadSidecar(dir: string): PlateSidecar | null {
  const file = path.join(dir, 'scores.corpus.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PlateSidecar) : null;
}

export function sidecarText(s: PlateSidecar): string {
  const out: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  out.push(
    `${s.dir} — ${s.plates.length} plates against ${s.corpusRows} deduped corpus works`,
    `  position ${s.positionId ?? '(not recorded in studio.jsonl)'}` +
      `  influences ${s.influencesHash ?? 'none resolved for this position'}`,
    `  band from ${s.band.works} works / ${s.band.pairs.toLocaleString()} pairs — ` +
      `min ${s.band.min.toFixed(4)} median ${s.band.median.toFixed(4)} max ${s.band.max.toFixed(4)}`,
    '',
    '  plate                                              novelty  nearest corpus work              pctile   to influences (vs corpus)',
  );
  for (const p of s.plates) {
    out.push(
      `  ${(p.kind === 'final' ? '* ' : '  ') + p.file}`.padEnd(53) +
        `${p.novelty.toFixed(4)}  ${p.nearestCorpus.id.padEnd(12)} ${(p.nearestCorpus.title || '?').slice(0, 20).padEnd(20)} ` +
        `${pct(p.corpusPercentile).padStart(6)}  ` +
        `${p.cosineToInfluenceCentroid === null ? '        —' : `${p.cosineToInfluenceCentroid.toFixed(4)} at ${pct(p.influencePercentile ?? 0).padStart(6)}`}` +
        `${p.copyFlag ? '   COPY FLAG' : ''}`,
    );
  }
  if (s.plates.some((p) => p.influencePercentile !== null)) {
    out.push(
      '',
      '  The last column is the one to read. A plate at 50.0% is exactly as near this position\'s',
      '  influences as a corpus work drawn at random, i.e. not near them at all. The raw cosine is',
      '  not interpretable on its own: CLIP image embeddings sit in a narrow cone.',
    );
  }
  if (s.drift) out.push('', `  ${s.drift.reason}`);
  return out.join('\n') + '\n';
}
