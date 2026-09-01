// How much a finished plate looks like something in the corpus.
//
// ArtMine (arXiv:2607.08331 §4) rewards a policy for CSD/LPIPS/CLIP similarity to a reference work,
// because its goal is retrodiction: reproduce a specific painting from evidence about it. The metric
// is used with the sign that says *closer is better*.
//
// The goal here is the inverse, so the metric is read with the sign flipped. `j-only-this` is a
// rubric on every position — "derivation, not quotation" — and until now it was decided by a model
// reading a picture, which is exactly the kind of unfalsifiable judgement this repo tries to reduce.
// A high similarity to a specific corpus work is the one form of quotation that is mechanically
// visible, so it goes here as a *report*, never as a reward. Rewarding distance would teach the
// policy to avoid the corpus, which is not the same as teaching it not to quote, and would be a
// straightforwardly gameable objective (paint noise, score well).
//
// ## The reason this is written as an envelope and not as a number
//
// A cosine similarity between two CLIP embeddings has no absolute meaning. Two unrelated photographs
// routinely sit at 0.6. Before "this plate scores 0.71 against cma-102578" can be read at all, the
// question is what 0.71 is high or low *against*, so `resemblance()` computes the corpus's own
// internal pair distribution — 1,225 pairs over 50 works, none of which is a quotation of any other
// — and reports the plate's nearest neighbour as a position within it. This is the same treatment
// `artist envelope` gives the render descriptors, and for the same reason: a descriptor whose real
// range is 0.6-0.75 binned as though it ran 0 to 1 is a lie with four decimal places on it.
//
// ## What the artist can and cannot have seen
//
// Nothing in the loop ever shows the artist a corpus image. `element-derive.ts` sends one image to a
// model and keeps the *text* it comes back with; the element that reaches a run is prose and
// constraints. So a high score here cannot be quotation-by-copying, because there is no channel for
// it — it can only be convergence, or the encoder noticing that both things are rectangles. That
// limitation belongs on the report, not in a footnote, so `resemblanceText` prints it.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ROOT } from '../env/browser.js';

const require = createRequire(import.meta.url);

/**
 * `onnxruntime-node` is an optional dependency and is loaded through `require` rather than
 * imported, for two reasons that are the same reason: it is 150MB of native runtime that only two
 * commands need, and a fresh clone must stay installable and green without it. `available()` below
 * is what every caller checks first, so an absent runtime is a refusal with instructions in it and
 * never a crash on line one.
 */
function ort(): {
  InferenceSession: { create: (p: string) => Promise<Session> };
  Tensor: new (t: string, d: Float32Array, dims: number[]) => unknown;
} | null {
  try {
    return require('onnxruntime-node') as ReturnType<typeof ort> & object;
  } catch {
    return null;
  }
}

/**
 * The exact bytes this file was written against.
 *
 * `Xenova/clip-vit-base-patch32`, `onnx/vision_model.onnx` from Hugging Face. Recorded here rather
 * than in a VERSIONS.md because there is one weight file and it is checked on load: an encoder
 * silently swapped for a different one would move every number below while the code looked fine.
 */
export const MODEL_SHA256 = 'fd6e1402a588279d1723c7534d4bcba5bc0b14b47dfab0e46f8c47b8270d7d40';
export const MODEL_PATH = path.join(ROOT, '.models', 'clip-vit-base-patch32', 'vision_model.onnx');
export const MODEL_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx';

const SIDE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

/** Keyed on the image bytes AND the model, so a model swap invalidates rather than blends. */
const CACHE = path.join(ROOT, '.cache', 'resemblance');

/** The weights and the runtime, both. Either missing means this file cannot answer anything. */
export function available(): boolean {
  return existsSync(MODEL_PATH) && ort() !== null;
}

export function unavailableMessage(): string {
  const out: string[] = [];
  if (ort() === null) out.push('`onnxruntime-node` is not installed. It is optional: npm i onnxruntime-node');
  if (!existsSync(MODEL_PATH)) {
    out.push(
      `No encoder at ${path.relative(ROOT, MODEL_PATH)}.`,
      `Fetch it: curl -L --create-dirs -o "${MODEL_PATH}" "${MODEL_URL}"`,
      `It must hash to ${MODEL_SHA256}. 335MB, gitignored, refetchable.`
    );
  }
  return out.join('\n');
}

interface Rgb {
  width: number;
  height: number;
  /** RGB, one byte per channel, no alpha. */
  data: Uint8Array;
}

function decode(file: string): Rgb {
  const bytes = readFileSync(file);
  if (file.toLowerCase().endsWith('.png')) {
    const png = PNG.sync.read(bytes);
    const out = new Uint8Array(png.width * png.height * 3);
    for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
      // Composited onto white, not dropped. A plate's alpha is the sheet showing through, and
      // reading RGB straight would turn the untouched margin into whatever the buffer happened to
      // hold — which on this renderer is black, and would dominate the embedding.
      const a = png.data[i + 3]! / 255;
      out[j] = Math.round(png.data[i]! * a + 255 * (1 - a));
      out[j + 1] = Math.round(png.data[i + 1]! * a + 255 * (1 - a));
      out[j + 2] = Math.round(png.data[i + 2]! * a + 255 * (1 - a));
    }
    return { width: png.width, height: png.height, data: out };
  }
  const jpeg = require('jpeg-js') as {
    decode: (b: Buffer, o: { useTArray: boolean }) => { width: number; height: number; data: Uint8Array };
  };
  const img = jpeg.decode(bytes, { useTArray: true });
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    out[j] = img.data[i]!;
    out[j + 1] = img.data[i + 1]!;
    out[j + 2] = img.data[i + 2]!;
  }
  return { width: img.width, height: img.height, data: out };
}

/** CLIP's own preprocessing: shortest side to 224, centre crop, rescale, normalize, NCHW. */
function preprocess(img: Rgb): Float32Array {
  const scale = SIDE / Math.min(img.width, img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  const ox = (sw - SIDE) / 2;
  const oy = (sh - SIDE) / 2;
  const out = new Float32Array(3 * SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    // Bilinear, not bicubic. The difference is well under the noise floor of a 512-d embedding and
    // bicubic here would be forty lines of code nobody would check.
    const fy = Math.min(img.height - 1, Math.max(0, (y + oy) / scale));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < SIDE; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + ox) / scale));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const at = (yy: number, xx: number) => img.data[(yy * img.width + xx) * 3 + c]!;
        const top = at(y0, x0) * (1 - wx) + at(y0, x1) * wx;
        const bot = at(y1, x0) * (1 - wx) + at(y1, x1) * wx;
        out[c * SIDE * SIDE + y * SIDE + x] = ((top * (1 - wy) + bot * wy) / 255 - MEAN[c]!) / STD[c]!;
      }
    }
  }
  return out;
}

type Session = { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>> };
let session: Session | null = null;

async function encoder(): Promise<{ session: Session; Tensor: new (t: string, d: Float32Array, dims: number[]) => unknown }> {
  const rt = ort();
  if (rt === null || !existsSync(MODEL_PATH)) throw new Error(unavailableMessage());
  if (session === null) {
    const got = createHash('sha256').update(readFileSync(MODEL_PATH)).digest('hex');
    if (got !== MODEL_SHA256) {
      throw new Error(
        `The encoder at ${MODEL_PATH} hashes to ${got}, not ${MODEL_SHA256}. Every number this file ` +
          `produces is relative to one set of weights; refusing to mix two.`
      );
    }
    session = await rt.InferenceSession.create(MODEL_PATH);
  }
  return { session, Tensor: rt.Tensor };
}

/** Unit-length 512-d embedding of one image file. Cached on the image bytes plus the model hash. */
export async function embed(file: string): Promise<Float32Array> {
  const key = createHash('sha256')
    .update(readFileSync(file))
    .update(MODEL_SHA256)
    .digest('hex');
  const cached = path.join(CACHE, `${key}.json`);
  if (existsSync(cached)) return Float32Array.from(JSON.parse(readFileSync(cached, 'utf8')) as number[]);

  const { session: s, Tensor } = await encoder();
  const result = await s.run({ pixel_values: new Tensor('float32', preprocess(decode(file)), [1, 3, SIDE, SIDE]) });
  const raw = result['image_embeds']!.data;
  let norm = 0;
  for (const v of raw) norm += v * v;
  norm = Math.sqrt(norm);
  const unit = Float32Array.from(raw, (v) => v / norm);

  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify([...unit]));
  return unit;
}

/** Both arguments are unit vectors, so this is the cosine. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export interface Neighbour {
  workId: string;
  similarity: number;
}

export interface PlateResemblance {
  dir: string;
  /** Nearest first. */
  nearest: Neighbour[];
  /**
   * Where the nearest neighbour's similarity falls in the corpus's own pair distribution, 0..1.
   * 0.99 means only 1% of corpus pairs are as alike as this plate is to its nearest work — the only
   * reading of the raw number that is worth anything.
   */
  percentileInCorpus: number;
}

export interface CorpusBaseline {
  works: number;
  pairs: number;
  min: number;
  median: number;
  max: number;
  /**
   * The work with the highest mean similarity to all the others, and that mean.
   *
   * The disclosure that keeps "nearest neighbour" from being read as a discovery. A CLIP embedding
   * space has hubs — a work that is nearest to everything is nearest to a plate for reasons that
   * have nothing to do with the plate. If the hub is also every plate's top match, the answer is a
   * property of the corpus and the column should be read as noise.
   */
  hub: { workId: string; meanSimilarity: number };
  /** Every pairwise similarity, sorted ascending. Kept so a percentile is a lookup, not a model. */
  sorted: number[];
}

export interface Resemblance {
  model: string;
  baseline: CorpusBaseline;
  plates: PlateResemblance[];
  /** Run directories that had no `final.png`. */
  skipped: string[];
}

/**
 * The corpus images a work record claims, in work-id order.
 *
 * Driven from `corpus/works/` and not from `readdir` of the image directory. An image nobody's
 * record points at is skipped rather than listed under its own content hash: a neighbour that
 * cannot be looked up is not a finding, and the images are gitignored while the records are not.
 */
const corpusImages = (): { id: string; file: string }[] => {
  const worksDir = path.join(ROOT, 'corpus', 'works');
  if (!existsSync(worksDir)) return [];
  const out: { id: string; file: string }[] = [];
  for (const f of readdirSync(worksDir).filter((n) => n.endsWith('.json')).sort()) {
    const w = JSON.parse(readFileSync(path.join(worksDir, f), 'utf8')) as {
      id: string;
      image?: { path: string; hash: string };
    };
    if (!w.image) continue;
    const file = path.join(ROOT, 'corpus', w.image.path);
    if (existsSync(file)) out.push({ id: w.id, file });
  }
  return out;
};

function percentile(sorted: number[], v: number): number {
  if (sorted.length === 0) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/**
 * The corpus against itself, then each plate against the corpus.
 *
 * `dirs` are run directories; each contributes its `final.png` or is skipped by name. Serial because
 * the sessions are, and because fifty embeddings is seconds.
 */
export async function resemblance(dirs: string[], topK = 3): Promise<Resemblance> {
  const works = corpusImages();
  if (works.length < 2) throw new Error(`corpus/images/ holds ${works.length} image(s); a baseline needs at least two`);

  const vectors: Float32Array[] = [];
  for (const w of works) vectors.push(await embed(w.file));

  const pairs: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) pairs.push(similarity(vectors[i]!, vectors[j]!));
  }
  const means = vectors.map((v, i) => {
    let total = 0;
    for (let j = 0; j < vectors.length; j++) if (j !== i) total += similarity(v, vectors[j]!);
    return total / (vectors.length - 1);
  });
  let hubAt = 0;
  for (let i = 1; i < means.length; i++) if (means[i]! > means[hubAt]!) hubAt = i;

  pairs.sort((a, b) => a - b);
  const baseline: CorpusBaseline = {
    works: works.length,
    pairs: pairs.length,
    min: pairs[0]!,
    median: pairs[Math.floor(pairs.length / 2)]!,
    max: pairs[pairs.length - 1]!,
    hub: { workId: works[hubAt]!.id, meanSimilarity: means[hubAt]! },
    sorted: pairs,
  };

  const plates: PlateResemblance[] = [];
  const skipped: string[] = [];
  for (const dir of dirs) {
    const plate = path.join(dir, 'final.png');
    if (!existsSync(plate)) {
      skipped.push(dir);
      continue;
    }
    const v = await embed(plate);
    const nearest = works
      .map((w, i) => ({ workId: w.id, similarity: similarity(v, vectors[i]!) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
    plates.push({ dir, nearest, percentileInCorpus: percentile(pairs, nearest[0]!.similarity) });
  }

  return { model: MODEL_SHA256, baseline, plates, skipped };
}

export function resemblanceText(r: Resemblance): string {
  const n = (v: number) => v.toFixed(4);
  const out = [
    `Corpus against itself: ${r.baseline.pairs} pair(s) over ${r.baseline.works} work(s), none a quotation of any other.`,
    `  min ${n(r.baseline.min)}   median ${n(r.baseline.median)}   max ${n(r.baseline.max)}`,
    `That band is what any number below has to be read against. A cosine has no absolute meaning.`,
    `  hub ${r.baseline.hub.workId} at mean ${n(r.baseline.hub.meanSimilarity)} — the work nearest to everything.`,
    '',
  ];
  const hubbed = r.plates.filter((p) => p.nearest[0]?.workId === r.baseline.hub.workId).length;
  if (r.plates.length === 0) out.push('No plate was measured.');
  for (const p of r.plates) {
    out.push(`${p.dir}`);
    for (const nb of p.nearest) out.push(`    ${n(nb.similarity)}  ${nb.workId}`);
    out.push(
      `    nearest sits at the ${(p.percentileInCorpus * 100).toFixed(1)}th percentile of the corpus's own pairs`
    );
  }
  if (hubbed > 0 && hubbed === r.plates.length) {
    out.push(
      '',
      `EVERY plate's top match is the hub. Read that column as noise: it is answering "which work is`,
      `nearest to everything" and not "which work does this plate resemble". Only the percentile,`,
      `which compares against the whole distribution, survives this.`
    );
  }
  out.push(
    '',
    'Reported, never rewarded. And note what a high number here could not be: no corpus image is',
    'ever shown to the artist — element-derive.ts keeps the model\'s prose and throws the pixels',
    'away — so this measures convergence, not copying. See artist/resemblance.ts.'
  );
  if (r.skipped.length > 0) out.push('', `no final.png: ${r.skipped.join(', ')}`);
  return out.join('\n');
}
