// The final pass: an optional diffusion pass over the finished plate.
//
// This is the one thing in the repo that is not deterministic and does not want to be, so the rules
// around it are stricter than the rules around anything else here:
//
//   after      it runs on `final.png` once the trajectory is over and every artifact is written. It
//              takes no part in the loop, changes no score, moves no hash, and is invisible to
//              `reward.ts`, `replay.ts`, `recompute` and `envVersion`. A run with a pass and the same
//              run without one are the same run.
//   beside     the result is `pass.png`, never `final.png`. The plate the artist actually made stays
//              on disk untouched, so the two can always be put next to each other and the pass can
//              always be thrown away.
//   attached   `pass.json` holds the prompt verbatim, the model, the settings and the SHA-256 of both
//              the image that went in and the image that came out. A pass whose prompt is not written
//              down is an unreproducible picture of unknown provenance, which is the opposite of what
//              the rest of this directory is for.
//   sealed     nothing in `artist/` may import this file — a guard test pins that. If the loop could
//              read a pass back, the artist would be making decisions about a picture it did not
//              make and cannot make again.
//
// Cached by the whole request, like the environment and the judge, for a different reason than
// either: those cache so a rescore agrees with the run, this caches because the call is not
// repeatable. Asking twice gives two different pictures, and a command that quietly replaces the
// picture you looked at yesterday is worse than one that costs money.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { canonicalJson } from '../env/profile.js';

/**
 * Named here and nowhere else. It is not frozen the way the environment's and the judge's model ids
 * are — nothing downstream compares two passes as measurements of one thing — but it is recorded on
 * every result so that a picture can say what made it.
 */
export const PASS_MODEL = 'gpt-image-1';

const CACHE_DIR = path.join(ROOT, '.cache', 'artist-pass');

/** `auto` matches the plate's own aspect as closely as the model's fixed sizes allow. */
export type PassSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
export type PassQuality = 'auto' | 'low' | 'medium' | 'high';
/**
 * `high` is the default because this is a pass *through* a finished picture. At `low` the model
 * treats the plate as a suggestion and returns something else, which is a generation, not a pass.
 */
export type PassFidelity = 'low' | 'high';

export interface PassOptions {
  /** Written into `pass.json` exactly as given. There is no default: an unprompted pass is noise. */
  prompt: string;
  size?: PassSize;
  quality?: PassQuality;
  inputFidelity?: PassFidelity;
}

export interface PassRecord {
  model: string;
  prompt: string;
  size: PassSize;
  quality: PassQuality;
  inputFidelity: PassFidelity;
  /** SHA-256 of `final.png` — the plate this was a pass over, identified by its bytes. */
  sourceSha256: string;
  /** SHA-256 of `pass.png`. */
  outputSha256: string;
  /** From the API. Left as tokens rather than converted: image tokens do not price like text ones. */
  tokens: { input: number; output: number } | null;
  cached: boolean;
  at: string;
}

interface ImageResponse {
  data?: { b64_json?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function sha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * One pass, cached by model + prompt + settings + the source image's bytes. Returns the PNG; writing
 * it is `finalPass`'s job, so the network half stays testable without a run directory.
 */
async function passThrough(
  png: Buffer,
  o: Required<PassOptions>
): Promise<{ png: Buffer; tokens: PassRecord['tokens']; cached: boolean }> {
  const key = createHash('sha256')
    .update(
      canonicalJson({
        model: PASS_MODEL,
        prompt: o.prompt,
        size: o.size,
        quality: o.quality,
        inputFidelity: o.inputFidelity,
        image: sha(png),
      })
    )
    .digest('hex');
  const file = path.join(CACHE_DIR, `${key}.png`);
  if (existsSync(file)) return { png: readFileSync(file), tokens: null, cached: true };

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so there is no final pass');

  const form = new FormData();
  form.set('model', PASS_MODEL);
  form.set('prompt', o.prompt);
  form.set('size', o.size);
  form.set('quality', o.quality);
  form.set('input_fidelity', o.inputFidelity);
  form.set('n', '1');
  form.set('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'final.png');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`the final pass answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as ImageResponse;

  const b64 = body.data?.[0]?.b64_json;
  // No retry. A pass that has to be asked twice is being asked for a different picture, and the
  // second one is not the one that was paid for or the one the error would have described.
  if (!b64) throw new Error('the final pass returned no image');
  const out = Buffer.from(b64, 'base64');

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, out);

  return {
    png: out,
    tokens: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
    cached: false,
  };
}

/**
 * Run the pass over a finished run directory. Writes `pass.png` and `pass.json` into it and touches
 * nothing else that is already there.
 */
export async function finalPass(dir: string, options: PassOptions): Promise<PassRecord> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error('a final pass needs a prompt; there is no default');

  const source = path.join(dir, 'final.png');
  if (!existsSync(source)) throw new Error(`no final.png in ${dir}: there is no finished plate to pass through`);
  const png = readFileSync(source);

  const o: Required<PassOptions> = {
    prompt,
    size: options.size ?? 'auto',
    quality: options.quality ?? 'high',
    inputFidelity: options.inputFidelity ?? 'high',
  };
  const result = await passThrough(png, o);

  const record: PassRecord = {
    model: PASS_MODEL,
    prompt: o.prompt,
    size: o.size,
    quality: o.quality,
    inputFidelity: o.inputFidelity,
    sourceSha256: sha(png),
    outputSha256: sha(result.png),
    tokens: result.tokens,
    cached: result.cached,
    at: new Date().toISOString(),
  };

  writeFileSync(path.join(dir, 'pass.png'), result.png);
  writeFileSync(path.join(dir, 'pass.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function passText(dir: string, r: PassRecord): string {
  return [
    `${path.join(dir, 'pass.png')}${r.cached ? '  (cached — the same pass, not a new one)' : ''}`,
    `  model     ${r.model}  size ${r.size}  quality ${r.quality}  fidelity ${r.inputFidelity}`,
    `  in -> out ${r.sourceSha256.slice(0, 12)} -> ${r.outputSha256.slice(0, 12)}`,
    r.tokens ? `  tokens    ${r.tokens.input} in, ${r.tokens.output} out` : '  tokens    n/a (served from cache)',
    `  prompt    ${r.prompt}`,
    '  final.png, final.json and scores.json are unchanged: a pass is not scored.',
  ].join('\n');
}
