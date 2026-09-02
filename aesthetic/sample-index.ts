// Deterministic multiresolution fragments and their row-aligned embedding matrix.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MetCorpusManifest, MetCorpusRecord } from '../env/sample-corpus.js';
import { canonicalJson } from '../env/canonical.js';
import { decodeRgb, type RgbImage } from '../env/rgb.js';
import { type CorpusFragment, type FormalFeatures, type FragmentAnnotation, provenanceFrom } from './sample-types.js';

export const SAMPLE_INDEX_SCHEMA = 'kusama.sample-index.v1' as const;

export interface CropLevel {
  scale: number;
  grid: number;
  kind: 'context' | 'detail';
}

export interface FragmentProfile {
  schemaVersion: typeof SAMPLE_INDEX_SCHEMA;
  levels: CropLevel[];
  embeddingModel: string;
  embeddingWeights: string;
  embeddingDimensions: number;
}

export const DEFAULT_FRAGMENT_PROFILE: FragmentProfile = {
  schemaVersion: SAMPLE_INDEX_SCHEMA,
  levels: [
    { scale: 0.72, grid: 2, kind: 'context' },
    { scale: 0.48, grid: 3, kind: 'detail' },
    { scale: 0.3, grid: 4, kind: 'detail' },
  ],
  embeddingModel: 'Xenova/clip-vit-base-patch32',
  embeddingWeights: 'vision_model.onnx',
  embeddingDimensions: 512,
};

export interface SamplingIndexHeader {
  schemaVersion: typeof SAMPLE_INDEX_SCHEMA;
  indexId: string;
  manifestHash: string;
  profile: FragmentProfile;
  profileHash: string;
  rows: number;
  dimensions: number;
  fragmentsFile: 'fragments.json';
  embeddingsFile: 'embeddings.f32';
  /** Operational path only; excluded from indexId because moving an index must not change identity. */
  sourceRoot: string;
  works: MetCorpusRecord[];
}

export interface SamplingIndex {
  header: SamplingIndexHeader;
  fragments: CorpusFragment[];
  embeddings: Float32Array;
}

export type FragmentEmbedder = (crop: RgbImage, fragmentId: string) => Promise<Float32Array>;
export type FragmentBatchEmbedder = (crops: readonly RgbImage[], fragmentIds: readonly string[]) => Promise<readonly Float32Array[]>;

export interface FragmentAnnotator {
  /** Model/provider/version identity; part of every annotation cache key. */
  id: string;
  annotate(crop: RgbImage, work: MetCorpusRecord, fragment: CorpusFragment): Promise<unknown>;
}

export interface BuildIndexOptions {
  output: string;
  corpusRoot: string;
  manifest: MetCorpusManifest;
  embed: FragmentEmbedder;
  embedBatch?: FragmentBatchEmbedder;
  batchSize?: number;
  annotator?: FragmentAnnotator;
  profile?: FragmentProfile;
  limit?: number;
}

function checkedAnnotation(value: unknown): FragmentAnnotation {
  if (typeof value !== 'object' || value === null) throw new Error('fragment annotation is not an object');
  const annotation = value as Record<string, unknown>;
  for (const key of ['depictedSubjects', 'depictedParts', 'compositionalRoles', 'relationalDevices', 'affectivePossibilities']) {
    if (!Array.isArray(annotation[key]) || !(annotation[key] as unknown[]).every((item) => typeof item === 'string')) {
      throw new Error(`fragment annotation ${key} must be an array of strings`);
    }
  }
  for (const key of ['spatialDescription', 'scaleDescription', 'markDescription']) {
    if (annotation[key] !== undefined && typeof annotation[key] !== 'string') throw new Error(`fragment annotation ${key} must be a string`);
  }
  return value as FragmentAnnotation;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function atomic(file: string, bytes: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

/** Bounds in stable whole/context/detail order. Every non-whole level overlaps its neighbours. */
export function multiscaleBounds(width: number, height: number, profile = DEFAULT_FRAGMENT_PROFILE): {
  normalized: [number, number, number, number];
  pixels: [number, number, number, number];
  scale: number;
  kind: 'whole' | 'context' | 'detail';
}[] {
  const out: ReturnType<typeof multiscaleBounds> = [];
  const add = (x: number, y: number, w: number, h: number, scale: number, kind: 'whole' | 'context' | 'detail') => {
    const px = Math.round(x * width);
    const py = Math.round(y * height);
    const right = Math.round((x + w) * width);
    const bottom = Math.round((y + h) * height);
    out.push({ normalized: [x, y, w, h], pixels: [px, py, Math.max(1, right - px), Math.max(1, bottom - py)], scale, kind });
  };
  add(0, 0, 1, 1, 1, 'whole');
  for (const level of profile.levels) {
    for (let gy = 0; gy < level.grid; gy++) {
      const y = level.grid === 1 ? 0 : gy * (1 - level.scale) / (level.grid - 1);
      for (let gx = 0; gx < level.grid; gx++) {
        const x = level.grid === 1 ? 0 : gx * (1 - level.scale) / (level.grid - 1);
        add(x, y, level.scale, level.scale, level.scale, level.kind);
      }
    }
  }
  return out;
}

export function cropRgb(image: RgbImage, bounds: [number, number, number, number]): RgbImage {
  const [x, y, width, height] = bounds;
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * image.width + x) * 3;
    data.set(image.data.subarray(start, start + width * 3), row * width * 3);
  }
  return { width, height, data };
}

function linear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = linear(r), gl = linear(g), bl = linear(b);
  const x = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / 0.95047;
  const y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const z = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / 1.08883;
  const f = (n: number) => n > 0.008856 ? Math.cbrt(n) : 7.787 * n + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Cheap deterministic measurements over at most ~256x256 sampled pixels. */
export function formalFeatures(image: RgbImage, cropAreaRatio = 1, position: [number, number] = [0.5, 0.5]): FormalFeatures {
  const stride = Math.max(1, Math.ceil(Math.max(image.width, image.height) / 256));
  const sw = Math.ceil(image.width / stride), sh = Math.ceil(image.height / stride);
  const lum = new Float64Array(sw * sh);
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const hist = Array(8).fill(0) as number[];
  let sum = 0, sum2 = 0, n = 0;
  for (let sy = 0, y = 0; y < image.height; sy++, y += stride) {
    for (let sx = 0, x = 0; x < image.width; sx++, x += stride) {
      const i = (y * image.width + x) * 3;
      const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!;
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lum[sy * sw + sx] = l;
      sum += l; sum2 += l * l; n++;
      hist[Math.min(7, Math.floor(l * 8))]!++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cell = bins.get(key);
      if (cell) { cell.n++; cell.r += r; cell.g += g; cell.b += b; }
      else bins.set(key, { n: 1, r, g, b });
    }
  }
  const mean = sum / Math.max(1, n);
  const variance = Math.max(0, sum2 / Math.max(1, n) - mean * mean);
  const orientations = Array(8).fill(0) as number[];
  let edge = 0, symmetryError = 0, salienceMass = 0, sxMass = 0, syMass = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const gx = lum[y * sw + x + 1]! - lum[y * sw + x - 1]!;
      const gy = lum[(y + 1) * sw + x]! - lum[(y - 1) * sw + x]!;
      const magnitude = Math.hypot(gx, gy);
      if (magnitude > 0.08) edge++;
      let angle = Math.atan2(Math.abs(gy), Math.abs(gx)) * 180 / Math.PI;
      const ob = Math.min(7, Math.floor(angle / 90 * 8));
      orientations[ob]! += magnitude;
      salienceMass += magnitude;
      sxMass += magnitude * x / Math.max(1, sw - 1);
      syMass += magnitude * y / Math.max(1, sh - 1);
      symmetryError += Math.abs(lum[y * sw + x]! - lum[y * sw + (sw - 1 - x)]!);
    }
  }
  const inner = Math.max(1, (sw - 2) * (sh - 2));
  const oTotal = orientations.reduce((a, b) => a + b, 0) || 1;
  const dominant = orientations.indexOf(Math.max(...orientations));
  const dominantColorsLab = [...bins.values()]
    .sort((a, b) => b.n - a.n || a.r - b.r || a.g - b.g || a.b - b.b)
    .slice(0, 5)
    .map((c) => rgbToLab(c.r / c.n, c.g / c.n, c.b / c.n));
  const uniform = lum.reduce((count, l) => count + (Math.abs(l - mean) < Math.max(0.035, Math.sqrt(variance) * 0.35) ? 1 : 0), 0);
  return {
    normalizedPosition: position,
    cropToImageAreaRatio: cropAreaRatio,
    dominantColorsLab,
    luminanceMean: mean,
    luminanceVariance: variance,
    luminanceHistogram: hist.map((v) => v / Math.max(1, n)),
    contrast: Math.sqrt(variance),
    edgeDensity: edge / inner,
    edgeOrientationHistogram: orientations.map((v) => v / oTotal),
    spatialDensity: Math.min(1, 0.65 * edge / inner + 1.4 * Math.sqrt(variance)),
    symmetry: Math.max(0, 1 - symmetryError / inner),
    negativeSpace: uniform / Math.max(1, lum.length),
    saliencyCentroid: salienceMass ? [sxMass / salienceMass, syMass / salienceMass] : [0.5, 0.5],
    dominantDirectionalFlow: (dominant + 0.5) * 90 / 8,
  };
}

function containingContext(bounds: [number, number, number, number], contexts: CorpusFragment[]): string | null {
  const [x, y, w, h] = bounds;
  const cx = x + w / 2, cy = y + h / 2;
  const matches = contexts.filter((c) => {
    const [a, b, cw, ch] = c.normalizedBounds;
    return cx >= a && cx <= a + cw && cy >= b && cy <= b + ch;
  });
  return matches.sort((a, b) => a.cropScale - b.cropScale || a.fragmentId.localeCompare(b.fragmentId))[0]?.fragmentId ?? null;
}

export async function buildSamplingIndex(options: BuildIndexOptions): Promise<SamplingIndexHeader> {
  const output = path.resolve(options.output);
  const profile = options.profile ?? DEFAULT_FRAGMENT_PROFILE;
  const profileHash = hash(profile);
  const works = options.manifest.records
    .filter((r) => r.publicDomain && r.localImagePath && r.imageContentHash)
    .sort((a, b) => a.objectId - b.objectId)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  mkdirSync(output, { recursive: true });
  const cacheDir = path.join(output, '.embedding-cache');
  mkdirSync(cacheDir, { recursive: true });
  const annotationDir = path.join(output, '.annotation-cache');
  if (options.annotator) mkdirSync(annotationDir, { recursive: true });
  const fragments: CorpusFragment[] = [];
  const vectors: Float32Array[] = [];
  const batchSize = Math.max(1, Math.min(32, options.batchSize ?? 8));

  const normalizedVector = (input: Float32Array, label: string): Float32Array => {
    if (input.length !== profile.embeddingDimensions) throw new Error(`${label}: embedding has ${input.length} dimensions, expected ${profile.embeddingDimensions}`);
    let norm = 0;
    for (const value of input) norm += value * value;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm === 0) throw new Error(`${label}: embedding is not finite and non-zero`);
    return Float32Array.from(input, (value) => value / norm);
  };

  for (const work of works) {
    const source = path.isAbsolute(work.localImagePath!) ? work.localImagePath! : path.join(options.corpusRoot, work.localImagePath!);
    if (!existsSync(source)) throw new Error(`missing source image for Met ${work.objectId}: ${source}`);
    const image = decodeRgb(source);
    const relative = path.isAbsolute(work.localImagePath!) ? path.relative(options.corpusRoot, source) : work.localImagePath!;
    const made: CorpusFragment[] = [];
    const workVectors: (Float32Array | undefined)[] = [];
    const missing: { row: number; crop: RgbImage; fragmentId: string; embeddingId: string }[] = [];
    for (const bounds of multiscaleBounds(image.width, image.height, profile)) {
      const fragmentId = `frag_${hash({ schema: SAMPLE_INDEX_SCHEMA, source: work.imageContentHash, bounds: bounds.normalized, profile: profileHash }).slice(0, 24)}`;
      const embeddingId = `emb_${hash({ fragmentId, model: profile.embeddingModel, weights: profile.embeddingWeights }).slice(0, 24)}`;
      const crop = cropRgb(image, bounds.pixels);
      const whole = made[0]?.fragmentId ?? fragmentId;
      const contexts = made.filter((f) => f.fragmentKind === 'context');
      const fragment: CorpusFragment = {
        fragmentId, objectId: work.objectId, sourceImageHash: work.imageContentHash!, sourceRelativePath: relative,
        normalizedBounds: bounds.normalized, pixelBounds: bounds.pixels, cropScale: bounds.scale,
        fragmentKind: bounds.kind, embeddingId,
        formalFeatures: formalFeatures(crop, bounds.scale ** 2, [bounds.normalized[0] + bounds.scale / 2, bounds.normalized[1] + bounds.scale / 2]),
        provenance: provenanceFrom(work, relative, work.imageContentHash!),
        wholeFragmentId: whole,
        contextFragmentId: bounds.kind === 'detail' ? containingContext(bounds.normalized, contexts) : null,
      };
      const cached = path.join(cacheDir, `${embeddingId}.json`);
      const row = made.length;
      if (existsSync(cached)) {
        workVectors[row] = normalizedVector(Float32Array.from(JSON.parse(readFileSync(cached, 'utf8')) as number[]), cached);
      } else missing.push({ row, crop, fragmentId, embeddingId });
      if (options.annotator) {
        const annotationId = hash({ fragmentId, annotator: options.annotator.id });
        const annotationFile = path.join(annotationDir, `${annotationId}.json`);
        if (existsSync(annotationFile)) fragment.annotation = checkedAnnotation(JSON.parse(readFileSync(annotationFile, 'utf8')));
        else {
          fragment.annotation = checkedAnnotation(await options.annotator.annotate(crop, work, fragment));
          atomic(annotationFile, `${canonicalJson(fragment.annotation)}\n`);
        }
      }
      made.push(fragment);
    }
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      const embedded = options.embedBatch
        ? await options.embedBatch(batch.map((item) => item.crop), batch.map((item) => item.fragmentId))
        : await (async () => {
          const rows: Float32Array[] = [];
          for (const item of batch) rows.push(await options.embed(item.crop, item.fragmentId));
          return rows;
        })();
      if (embedded.length !== batch.length) throw new Error(`embedding batch returned ${embedded.length} rows for ${batch.length} fragments`);
      batch.forEach((item, index) => {
        const vector = normalizedVector(embedded[index]!, item.fragmentId);
        workVectors[item.row] = vector;
        atomic(path.join(cacheDir, `${item.embeddingId}.json`), `${JSON.stringify([...vector])}\n`);
      });
    }
    fragments.push(...made);
    vectors.push(...workVectors.map((vector, row) => {
      if (!vector) throw new Error(`${made[row]!.fragmentId}: missing embedding row`);
      return vector;
    }));
  }
  const packed = new Float32Array(vectors.length * profile.embeddingDimensions);
  vectors.forEach((vector, row) => packed.set(vector, row * profile.embeddingDimensions));
  const indexId = `sample-index_${hash({ manifest: options.manifest.recordsHash, profile: profileHash, fragmentIds: fragments.map((f) => f.fragmentId) }).slice(0, 24)}`;
  const header: SamplingIndexHeader = {
    schemaVersion: SAMPLE_INDEX_SCHEMA, indexId, manifestHash: options.manifest.recordsHash, profile,
    profileHash, rows: fragments.length, dimensions: profile.embeddingDimensions,
    fragmentsFile: 'fragments.json', embeddingsFile: 'embeddings.f32', sourceRoot: path.resolve(options.corpusRoot), works,
  };
  atomic(path.join(output, 'fragments.json'), `${canonicalJson(fragments)}\n`);
  atomic(path.join(output, 'embeddings.f32'), Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength));
  atomic(path.join(output, 'index.json'), `${canonicalJson(header)}\n`);
  return header;
}

export function loadSamplingIndexHeader(dir: string): SamplingIndexHeader {
  const root = path.resolve(dir);
  const header = JSON.parse(readFileSync(path.join(root, 'index.json'), 'utf8')) as SamplingIndexHeader;
  if (header.schemaVersion !== SAMPLE_INDEX_SCHEMA) throw new Error(`${dir}: unsupported index schema`);
  return header;
}

export function loadSamplingIndex(dir: string): SamplingIndex {
  const root = path.resolve(dir);
  const header = loadSamplingIndexHeader(root);
  const fragments = JSON.parse(readFileSync(path.join(root, header.fragmentsFile), 'utf8')) as CorpusFragment[];
  const bytes = readFileSync(path.join(root, header.embeddingsFile));
  if (fragments.length !== header.rows) throw new Error(`${dir}: ${header.rows} rows but ${fragments.length} fragment records`);
  if (bytes.length !== header.rows * header.dimensions * 4) {
    throw new Error(`${dir}: matrix is ${bytes.length} bytes, expected ${header.rows * header.dimensions * 4}`);
  }
  for (let row = 0; row < fragments.length; row++) {
    if (!fragments[row]?.embeddingId) throw new Error(`${dir}: row ${row} has no embedding mapping`);
  }
  const embeddings = new Float32Array(header.rows * header.dimensions);
  for (let i = 0; i < embeddings.length; i++) embeddings[i] = bytes.readFloatLE(i * 4);
  return { header, fragments, embeddings };
}
