// The other half of the dual tower: text -> the same 512-d space the corpus is embedded in.
//
// `resemblance.ts` has had the vision tower since 2026-08-31, and `corpus/clip.f32` holds 19,807
// image embeddings made with it. Until this file existed there was no way to ask the corpus a
// question in words — every neighbour query had to start from an image.
//
// ## The one thing that makes this correct or worthless
//
// The text tower must come from the SAME checkpoint as the vision tower. CLIP's two towers are
// trained together with two learned projection matrices onto a shared space; a text encoder from a
// different checkpoint produces 512 numbers that are the right shape and mean nothing against these
// images. So the weights here are `Xenova/clip-vit-base-patch32`, `onnx/text_model.onnx` — the same
// repository and revision as `resemblance.ts`'s `vision_model.onnx` — and both files are pinned by
// sha256. Shape agreement is not evidence of space agreement; the retrieval gate in
// `artist/tests/clip-text.test.ts` is.
//
// The output read is `text_embeds`, which is POST-projection. Reading the pooled hidden state
// instead (768-d, pre-projection) is the standard way to get this silently wrong.
//
// ## No attention mask
//
// This export takes `input_ids` only — there is no `attention_mask` input. That is not a defect of
// the export: CLIP's text transformer is causally masked and pools at the eos position, so nothing
// after the first eos can influence the vector that is read. Padding is therefore a no-op rather
// than a leak. Measured, not assumed: "a woodcut of a bird" at its real length of 8 tokens, padded
// to 77 with eos, and padded to 77 with zeros all give the SAME vector to eight decimal places.
// `artist-clip-text.test.ts` keeps that assertion.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { CONTEXT_LENGTH, loadTokenizer, tokenizerAvailable } from './clip-tokenizer.js';

const require = createRequire(import.meta.url);

export const TEXT_MODEL_SHA256 =
  '3f6571f5bad13a97c469c1622e1cfc4d9aef78b79fdbfcff804ca357bfada8cc';
export const TEXT_MODEL_PATH = path.join(
  ROOT,
  '.models',
  'clip-vit-base-patch32',
  'text_model.onnx',
);
export const TEXT_MODEL_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model.onnx';

export const DIM = 512;

type Session = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
};
type Runtime = {
  InferenceSession: { create: (p: string) => Promise<Session> };
  Tensor: new (t: string, d: BigInt64Array, dims: number[]) => unknown;
};

function ort(): Runtime | null {
  try {
    return require('onnxruntime-node') as Runtime;
  } catch {
    return null;
  }
}

export function textAvailable(): boolean {
  return existsSync(TEXT_MODEL_PATH) && tokenizerAvailable() && ort() !== null;
}

export function textUnavailableMessage(): string {
  const out: string[] = [];
  if (ort() === null) {
    out.push('`onnxruntime-node` is not installed. It is optional: npm i onnxruntime-node');
  }
  if (!existsSync(TEXT_MODEL_PATH)) {
    out.push(
      `No text tower at ${path.relative(ROOT, TEXT_MODEL_PATH)}.`,
      `Fetch it: curl -L --create-dirs -o "${TEXT_MODEL_PATH}" "${TEXT_MODEL_URL}"`,
      `It must hash to ${TEXT_MODEL_SHA256}. 254MB, gitignored, refetchable.`,
    );
  }
  if (!tokenizerAvailable()) {
    out.push(
      'No tokenizer files. Fetch vocab.json and merges.txt from the same checkpoint:',
      `  curl -L --create-dirs -o "${path.join(path.dirname(TEXT_MODEL_PATH), 'vocab.json')}" https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/vocab.json`,
      `  curl -L -o "${path.join(path.dirname(TEXT_MODEL_PATH), 'merges.txt')}" https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/merges.txt`,
    );
  }
  return out.join('\n');
}

let session: Session | null = null;

async function encoder(): Promise<{ session: Session; Tensor: Runtime['Tensor'] }> {
  const rt = ort();
  if (rt === null || !existsSync(TEXT_MODEL_PATH)) throw new Error(textUnavailableMessage());
  if (session === null) {
    const got = createHash('sha256').update(readFileSync(TEXT_MODEL_PATH)).digest('hex');
    if (got !== TEXT_MODEL_SHA256) {
      throw new Error(
        `The text tower at ${TEXT_MODEL_PATH} hashes to ${got}, not ${TEXT_MODEL_SHA256}. ` +
          `A text encoder from a different checkpoint does not share a space with the images.`,
      );
    }
    session = await rt.InferenceSession.create(TEXT_MODEL_PATH);
  }
  return { session, Tensor: rt.Tensor };
}

/**
 * Unit-length 512-d embeddings, one per input string, in the same space as `corpus/clip.f32`.
 *
 * Not cached on disk. An image embedding costs a JPEG decode and a ViT forward pass; a text
 * embedding is a few hundred microseconds of transformer over 77 tokens, and the 218MB / 19,807-inode
 * cache the image side accumulated is not a mistake worth repeating for something this cheap.
 */
export async function embedText(strings: string[], batchSize = 64): Promise<Float32Array[]> {
  if (strings.length === 0) return [];
  const tok = loadTokenizer();
  const out: Float32Array[] = [];
  for (let start = 0; start < strings.length; start += batchSize) {
    out.push(...(await embedTokens(strings.slice(start, start + batchSize).map((s) => tok.tokenize(s)))));
  }
  return out;
}

/**
 * One forward pass over already-tokenized sequences, which must all be the same length.
 *
 * Exposed only so the padding claim in this file's header can be *tested* rather than argued:
 * `artist-clip-text.test.ts` runs the same phrase at its real length and padded to 77 and requires
 * the two vectors to agree. Everything in the repo calls `embedText`.
 */
export async function embedTokens(sequences: number[][]): Promise<Float32Array[]> {
  if (sequences.length === 0) return [];
  const width = sequences[0]!.length;
  if (sequences.some((s) => s.length !== width)) {
    throw new Error('every sequence in one batch must be the same length');
  }
  const { session: s, Tensor } = await encoder();
  const ids = new BigInt64Array(sequences.length * width);
  sequences.forEach((seq, row) => {
    for (let i = 0; i < width; i++) ids[row * width + i] = BigInt(seq[i]!);
  });
  const result = await s.run({ input_ids: new Tensor('int64', ids, [sequences.length, width]) });
  const raw = result['text_embeds']!.data;
  if (raw.length !== sequences.length * DIM) {
    throw new Error(`text_embeds is ${raw.length} floats, expected ${sequences.length * DIM}`);
  }
  const out: Float32Array[] = [];
  for (let row = 0; row < sequences.length; row++) {
    const vec = raw.slice(row * DIM, (row + 1) * DIM);
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    out.push(Float32Array.from(vec, (v) => v / norm));
  }
  return out;
}

/** Plain dot product. Both sides are unit-length, so this is the cosine. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
