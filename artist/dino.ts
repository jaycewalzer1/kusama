// A second way of looking, so that "the picture crosses the museum wall" can be checked against
// something other than the encoder that first said it.
//
// Every appearance number this repo has published — the 55.4% same-museum neighbour rate, the CLIP
// map, `resemblance`'s pair band, the retrieval P@10 — comes out of one encoder, CLIP ViT-B/32. That
// is a single point of failure of a specific kind: CLIP is trained on image-caption pairs scraped
// from the web, so what it calls "similar" is partly what the internet writes similar captions
// about. A museum's photography style is exactly the sort of thing captions covary with. If the
// crossing result were an artefact of that, nothing inside CLIP could tell us.
//
// DINOv2 is trained with no text at all — self-distillation over images only. It is the cleanest
// available disagreement: same corpus, same statistic, a model that has never read a caption. Where
// the two agree, the finding is about the pictures. Where they disagree, the finding was about the
// encoder, and this file exists to find out which.
//
// **Report-only, and deliberately not wired into anything.** No reward reads it, no run sees it, and
// it moves no hash — `envVersion` does not cover this file and nothing in `aesthetic/` imports it.
// It is a second opinion on published numbers, not a second input to the work.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { decode, type Rgb } from './pixels.js';

const require = createRequire(import.meta.url);

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
 * `onnx-community/dinov2-small`, `onnx/model.onnx`. Hashed and checked on load for the same reason
 * `resemblance.ts` hashes its encoder: every number below is relative to one set of weights, and an
 * encoder quietly swapped for another would move all of them while the code still looked right.
 */
export const MODEL_SHA256 = 'f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a';
export const MODEL_PATH = path.join(ROOT, '.models', 'dinov2-small', 'model.onnx');
export const MODEL_URL = 'https://huggingface.co/onnx-community/dinov2-small/resolve/main/onnx/model.onnx';

/** ViT-S/14: 224/14 = 16x16 patches, so `last_hidden_state` is 1 + 256 tokens of 384. */
export const DIM = 384;
export const SIDE = 224;
/** Shortest side goes here first, then a centre crop to `SIDE`. From the model's own processor config. */
const RESIZE = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export const DINO_MATRIX = path.join(ROOT, 'corpus', 'dino.f32');
export const DINO_INDEX = path.join(ROOT, 'corpus', 'dino-index.json');

const CACHE = path.join(ROOT, '.cache', 'dino');

export function available(): boolean {
  return existsSync(MODEL_PATH) && ort() !== null;
}

export function unavailableMessage(): string {
  const out: string[] = [];
  if (ort() === null) out.push('`onnxruntime-node` is not installed. It is optional: npm i onnxruntime-node');
  if (!existsSync(MODEL_PATH)) {
    out.push(
      `No second encoder at ${path.relative(ROOT, MODEL_PATH)}.`,
      `Fetch it: curl -L --create-dirs -o "${MODEL_PATH}" "${MODEL_URL}"`,
      `It must hash to ${MODEL_SHA256}. 88MB, gitignored, refetchable.`
    );
  }
  return out.join('\n');
}

/**
 * DINOv2's own preprocessing: shortest side to 256, centre crop to 224, rescale, normalize, NCHW.
 *
 * Written out here rather than shared with `resemblance.preprocess` because the two are not the same
 * function with different constants: CLIP scales straight to its 224 box, DINOv2 scales to 256 and
 * then throws away the margin, and the normalisation statistics are ImageNet's rather than CLIP's.
 * Making one function do both would need a flag whose two branches are the whole body, and the point
 * of a second encoder is that it is genuinely a second measurement — a shared preprocessing bug
 * would be the one error this whole file cannot detect.
 *
 * There is no `pad` option, unlike CLIP's. `artist/aspect.ts` already measured what padding costs in
 * the CLIP space and that question does not need re-asking here; this file only ever has to be the
 * same as itself.
 */
export function preprocess(img: Rgb): Float32Array {
  const scale = RESIZE / Math.min(img.width, img.height);
  const ox = (img.width * scale - SIDE) / 2;
  const oy = (img.height * scale - SIDE) / 2;
  const out = new Float32Array(3 * SIDE * SIDE);
  for (let y = 0; y < SIDE; y++) {
    // Bilinear, matching `resemblance.preprocess`. The model's config asks for bicubic; the
    // difference is far below the noise floor of a 384-d embedding, and this is stated rather than
    // hidden because it is the one place this file knowingly departs from the reference pipeline.
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

type Session = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
};
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

/**
 * Unit-length 384-d embedding of one image file: the CLS token of the last layer.
 *
 * The CLS token and not a mean over the 256 patch tokens. Both are defensible and DINOv2's own kNN
 * evaluation uses CLS, which is the reason to prefer it: the published DINOv2 retrieval numbers are
 * CLS numbers, so anything measured here can be read beside them. A patch mean is a different
 * quantity — it weights every part of the frame equally, which on this corpus would mostly weight
 * the museum's seamless paper — and mixing the two would make the space incomparable with itself.
 */
export async function embed(file: string): Promise<Float32Array> {
  const key = createHash('sha256').update(readFileSync(file)).update(MODEL_SHA256).digest('hex');
  const cached = path.join(CACHE, `${key}.json`);
  if (existsSync(cached)) return Float32Array.from(JSON.parse(readFileSync(cached, 'utf8')) as number[]);

  const { session: s, Tensor } = await encoder();
  const result = await s.run({ pixel_values: new Tensor('float32', preprocess(decode(file)), [1, 3, SIDE, SIDE]) });
  const out = result['last_hidden_state'];
  if (!out) throw new Error(`the encoder returned ${Object.keys(result).join(', ')}, not last_hidden_state`);
  const raw = out.data.subarray(0, DIM);
  let norm = 0;
  for (const v of raw) norm += v * v;
  norm = Math.sqrt(norm);
  const unit = Float32Array.from(raw, (v) => v / norm);

  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify([...unit]));
  return unit;
}
