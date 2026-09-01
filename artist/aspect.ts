// What the centre crop costs, measured rather than assumed.
//
// Every CLIP number in this repo — the 19,791-row corpus matrix, the plate sidecars, the resemblance
// band, the atlas — is downstream of one preprocessing choice: scale the shortest side to 224 and
// centre-crop the rest away. That is what CLIP was trained with, so it is the right default. But it
// is a choice, and for a 520x700 plate it throws away the top 13% and the bottom 13% of the sheet —
// of a project whose own descriptors (`edgeContact`, the untouched margin) say the edge of a sheet
// is where the information is.
//
// This file measures how much the answer moves if that choice is reversed: fit the LONGEST side to
// 224 instead, and fill the remainder with CLIP's own channel means, which normalize to exactly 0.
//
// ## The two numbers, and what each is against
//
// 1. **Self-cosine.** One picture, encoded twice. Read against 0.6428, the median cosine between two
//    *unrelated* corpus works: a self-cosine near that number means the preprocessing moves a
//    picture about as far as changing the picture does.
// 2. **Top-1 agreement.** Which corpus work each version says the picture most resembles. Both
//    searches run over the same crop-preprocessed corpus matrix, so this is not a comparison of two
//    indexes — it is one index asked the same question by two encodings of the same file. Against a
//    chance baseline of 1/19,791.
//
// Neither preprocessing is declared correct here, and this file does not change any default. The
// crop stays. What this produces is a bound on how much of every downstream number is a property of
// the pictures and how much is a property of that decision.

import path from 'node:path';
import { evenSample } from './atlas.js';
import { loadCorpusEmbeddings, rowAt, type CorpusEmbeddings } from './clip-index.js';
import { decode } from './pixels.js';
import { platesIn } from './plates.js';
import { corpusImages, embed, similarity } from './resemblance.js';

/** The median cosine between two unrelated corpus works. Every self-cosine is read against this. */
export const CORPUS_PAIR_MEDIAN = 0.6428;

export interface AspectHit {
  label: string;
  kind: 'plate' | 'corpus';
  width: number;
  height: number;
  /** width / height. 1.0 is square, and a square image is unaffected by either scheme. */
  aspect: number;
  /** Share of the pixels the centre crop discards. 0 for a square image. */
  cropped: number;
  /** The same file, encoded both ways, against itself. */
  selfCosine: number;
  cropTop1: { id: string; cosine: number };
  padTop1: { id: string; cosine: number };
  agree: boolean;
}

export interface AspectAudit {
  model: string;
  hits: AspectHit[];
  corpusRows: number;
  /** Chance that two independent picks from the corpus name the same work. */
  agreeChance: number;
  agreeRate: number;
  selfMedian: number;
  selfMin: number;
  /** Self-cosine over the images the crop does not touch. The instrument's own noise floor. */
  squareSelfMedian: number | null;
}

function top1(corpus: CorpusEmbeddings, v: Float32Array): { id: string; cosine: number } {
  const dim = corpus.rows.length / corpus.entries.length;
  let best = -2;
  let at = 0;
  for (let i = 0; i < corpus.entries.length; i++) {
    const c = similarity(v, rowAt(corpus.rows, i, dim));
    if (c > best) {
      best = c;
      at = i;
    }
  }
  return { id: corpus.entries[at]!.work.id, cosine: best };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[s.length >> 1] as number);
};

/**
 * `dirs` contribute their plates, and `sample` corpus works are drawn evenly for contrast.
 *
 * Both populations are needed. The plates are what the question is about, but they are all close to
 * one aspect (the medium has two sheet sizes), so on their own they cannot show whether an effect
 * tracks aspect ratio or is just the encoder's noise. The corpus works run from 0.3 to 3.0 and
 * supply that gradient — and, at aspect 1.0, the noise floor itself.
 */
export async function aspectAudit(dirs: string[], sample = 120): Promise<AspectAudit> {
  const corpus = loadCorpusEmbeddings();
  const files: { label: string; kind: 'plate' | 'corpus'; file: string }[] = [];
  for (const dir of dirs) {
    for (const p of platesIn(dir)) {
      files.push({ label: `${path.basename(dir)}/${p.file}`, kind: 'plate', file: path.join(dir, p.file) });
    }
  }
  for (const w of evenSample(corpusImages(), sample)) {
    files.push({ label: w.id, kind: 'corpus', file: w.file });
  }

  const hits: AspectHit[] = [];
  for (const f of files) {
    const img = decode(f.file);
    const long = Math.max(img.width, img.height);
    const short = Math.min(img.width, img.height);
    const [cropV, padV] = [await embed(f.file, false), await embed(f.file, true)];
    const cropTop1 = top1(corpus, cropV);
    const padTop1 = top1(corpus, padV);
    hits.push({
      label: f.label,
      kind: f.kind,
      width: img.width,
      height: img.height,
      aspect: img.width / img.height,
      cropped: 1 - short / long,
      selfCosine: similarity(cropV, padV),
      cropTop1,
      padTop1,
      agree: cropTop1.id === padTop1.id,
    });
  }

  const square = hits.filter((h) => h.cropped < 0.02).map((h) => h.selfCosine);
  return {
    model: 'clip-vit-base-patch32',
    hits,
    corpusRows: corpus.entries.length,
    agreeChance: 1 / corpus.entries.length,
    agreeRate: hits.length === 0 ? 0 : hits.filter((h) => h.agree).length / hits.length,
    selfMedian: median(hits.map((h) => h.selfCosine)),
    selfMin: hits.length === 0 ? 0 : Math.min(...hits.map((h) => h.selfCosine)),
    squareSelfMedian: square.length > 0 ? median(square) : null,
  };
}

/** Self-cosine by how much the crop throws away. The gradient is the finding, if there is one. */
function bands(hits: AspectHit[]): string[] {
  const edges = [0, 0.05, 0.15, 0.3, 0.5, 1.01];
  const out: string[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    const inBand = hits.filter((h) => h.cropped >= lo && h.cropped < hi);
    if (inBand.length === 0) continue;
    const agreed = inBand.filter((h) => h.agree).length;
    out.push(
      `  ${(100 * lo).toFixed(0).padStart(3)}-${(100 * hi > 100 ? 100 : 100 * hi).toFixed(0).padEnd(3)}% cropped  ` +
        `n ${String(inBand.length).padStart(3)}  self-cosine median ${median(inBand.map((h) => h.selfCosine)).toFixed(4)}  ` +
        `top-1 agrees ${agreed}/${inBand.length}`
    );
  }
  return out;
}

export function aspectText(a: AspectAudit): string {
  const out: string[] = [];
  const plates = a.hits.filter((h) => h.kind === 'plate');
  out.push(
    `aspect audit — ${a.hits.length} images (${plates.length} plates, ${a.hits.length - plates.length} corpus works)`,
    `  centre crop (the default everywhere in this repo) vs pad-to-square, ${a.model}`,
    ''
  );
  out.push(`ONE PICTURE, ENCODED BOTH WAYS — median self-cosine ${a.selfMedian.toFixed(4)}, min ${a.selfMin.toFixed(4)}`);
  out.push(
    `  Against ${CORPUS_PAIR_MEDIAN.toFixed(4)}, the median cosine between two UNRELATED corpus works. A self-cosine`,
    '  near that line means the preprocessing moves a picture about as far as changing the picture does.'
  );
  if (a.squareSelfMedian !== null) {
    out.push(
      `  Images the crop does not touch (under 2% discarded) sit at ${a.squareSelfMedian.toFixed(4)} — the floor, and`,
      '  anything at it is this instrument agreeing with itself.'
    );
  }
  out.push('');
  out.push(
    `TOP-1 OVER THE SAME CORPUS — the two encodings name the same nearest work ${(100 * a.agreeRate).toFixed(1)}% of the time,`,
    `  against ${(100 * a.agreeChance).toFixed(4)}% for two independent picks out of ${a.corpusRows.toLocaleString()}.`
  );
  out.push('');
  out.push('BY HOW MUCH THE CROP THROWS AWAY');
  out.push(...bands(a.hits));
  out.push('');
  out.push('THE PLATES');
  for (const h of plates.slice(0, 20)) {
    out.push(
      `  ${h.selfCosine.toFixed(4)}  ${h.width}x${h.height} (${(100 * h.cropped).toFixed(0)}% cropped)  ` +
        `${h.agree ? 'same' : 'DIFFERENT'} top-1  ${h.label}`
    );
  }
  out.push('');
  out.push('  Nothing here changes a default. The crop is what CLIP was trained with and it stays. This is a');
  out.push('  bound on how much of every downstream number is a property of that decision rather than of the');
  out.push('  pictures — and the padded encoding is itself out of distribution, so a disagreement is not');
  out.push('  evidence that the crop got it wrong.');
  return out.map((s) => `${s}\n`).join('');
}
