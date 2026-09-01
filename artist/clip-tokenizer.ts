// CLIP's byte-level BPE tokenizer, written by hand.
//
// Why by hand: the alternative is `@huggingface/transformers`, which drags in a second
// onnxruntime build beside the `onnxruntime-node` this repo already loads through
// `createRequire`. Two runtimes in one process is a worse problem than 150 lines of BPE.
//
// The vocabulary and merge table are the checkpoint's own files, downloaded beside the
// weights in `.models/clip-vit-base-patch32/` (gitignored, like the weights). They are
// pinned by sha256 here for the same reason `resemblance.ts` pins MODEL_SHA256: a
// different vocabulary silently produces different token ids and therefore a different
// embedding space, with no error anywhere.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../env/browser.js';

export const TOKENIZER_DIR = path.join(ROOT, '.models', 'clip-vit-base-patch32');
export const VOCAB_PATH = path.join(TOKENIZER_DIR, 'vocab.json');
export const MERGES_PATH = path.join(TOKENIZER_DIR, 'merges.txt');

export const VOCAB_SHA256 = '5047b556ce86ccaf6aa22b3ffccfc52d391ea4accdab9c2f2407da5b742d4363';
export const MERGES_SHA256 = '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a';

export const VOCAB_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/vocab.json';
export const MERGES_URL =
  'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/merges.txt';

export const BOS = 49406; // <|startoftext|>
export const EOS = 49407; // <|endoftext|>
export const CONTEXT_LENGTH = 77;

export function tokenizerAvailable(): boolean {
  return existsSync(VOCAB_PATH) && existsSync(MERGES_PATH);
}

/** GPT-2/CLIP's reversible byte<->unicode map: every byte gets a printable codepoint. */
function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = '!'.charCodeAt(0); i <= '~'.charCodeAt(0); i++) bs.push(i);
  for (let i = 0xa1; i <= 0xac; i++) bs.push(i);
  for (let i = 0xae; i <= 0xff; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) map.set(bs[i]!, String.fromCodePoint(cs[i]!));
  return map;
}

// CLIP's own pattern. The three special-token alternatives come first so a literal
// "<|endoftext|>" in the text is not shredded into punctuation.
const PATTERN =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

export interface ClipTokenizer {
  encode(text: string): number[];
  /** Padded/truncated to CONTEXT_LENGTH, bracketed by BOS/EOS. */
  tokenize(text: string): number[];
  vocabSize: number;
  merges: number;
}

let cached: ClipTokenizer | null = null;

export function loadTokenizer(): ClipTokenizer {
  if (cached) return cached;
  if (!tokenizerAvailable()) {
    throw new Error(
      `CLIP tokenizer files missing. Fetch them into ${TOKENIZER_DIR}:\n` +
        `  curl -L -o ${VOCAB_PATH} ${VOCAB_URL}\n` +
        `  curl -L -o ${MERGES_PATH} ${MERGES_URL}`,
    );
  }

  const vocabRaw = readFileSync(VOCAB_PATH);
  const mergesRaw = readFileSync(MERGES_PATH);
  const vocabHash = createHash('sha256').update(vocabRaw).digest('hex');
  const mergesHash = createHash('sha256').update(mergesRaw).digest('hex');
  if (vocabHash !== VOCAB_SHA256) {
    throw new Error(`vocab.json sha256 ${vocabHash} != pinned ${VOCAB_SHA256}`);
  }
  if (mergesHash !== MERGES_SHA256) {
    throw new Error(`merges.txt sha256 ${mergesHash} != pinned ${MERGES_SHA256}`);
  }

  const vocab: Record<string, number> = JSON.parse(vocabRaw.toString('utf8'));

  const ranks = new Map<string, number>();
  const lines = mergesRaw.toString('utf8').split('\n');
  let rank = 0;
  for (const line of lines) {
    // The first line is a "#version: 0.2" header, not a merge.
    if (line.startsWith('#') || line.trim() === '') continue;
    ranks.set(line.trim(), rank++);
  }

  const byteEncoder = bytesToUnicode();
  const bpeCache = new Map<string, string[]>();

  function bpe(token: string): string[] {
    const hit = bpeCache.get(token);
    if (hit) return hit;

    // Word-final marker lives on the last symbol, which is how CLIP distinguishes
    // "in" inside a word from "in" as a word.
    const chars = [...token];
    let word = chars.slice(0, -1);
    word.push(chars[chars.length - 1] + '</w>');

    while (word.length > 1) {
      let bestRank = Infinity;
      let bestAt = -1;
      for (let i = 0; i < word.length - 1; i++) {
        const r = ranks.get(`${word[i]} ${word[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          bestAt = i;
        }
      }
      if (bestAt < 0) break;
      word = [
        ...word.slice(0, bestAt),
        word[bestAt]! + word[bestAt + 1]!,
        ...word.slice(bestAt + 2),
      ];
    }
    bpeCache.set(token, word);
    return word;
  }

  function encode(text: string): number[] {
    const cleaned = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const out: number[] = [];
    for (const match of cleaned.matchAll(PATTERN)) {
      const piece = match[0];
      // utf-8 bytes -> printable proxy chars, so any codepoint is representable.
      let mapped = '';
      for (const b of Buffer.from(piece, 'utf8')) mapped += byteEncoder.get(b)!;
      for (const sym of bpe(mapped)) {
        const id = vocab[sym];
        // Every byte proxy char is in the vocabulary, so BPE bottoms out and this
        // cannot miss. If it ever does, that is a corrupt vocab, not unknown text.
        if (id === undefined) throw new Error(`token ${JSON.stringify(sym)} not in vocab`);
        out.push(id);
      }
    }
    return out;
  }

  function tokenize(text: string): number[] {
    const ids = encode(text);
    const body = ids.slice(0, CONTEXT_LENGTH - 2);
    const seq = [BOS, ...body, EOS];
    // Pad with EOS, as CLIP does. The text tower pools at the FIRST eos position and
    // its attention is causal, so what follows that position cannot reach it.
    while (seq.length < CONTEXT_LENGTH) seq.push(EOS);
    return seq;
  }

  cached = { encode, tokenize, vocabSize: Object.keys(vocab).length, merges: ranks.size };
  return cached;
}
