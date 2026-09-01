// The corpus as three flat files, so pandas never has to reimplement the pipeline.
//
// Everything here is already computable from `corpus/manifest.jsonl` and `corpus/clip.f32`. The
// point of exporting it is that the alternative is a second implementation of the join, the sha256
// dedupe and the kNN in Python — and a second implementation is a second thing that can disagree
// with the first without anyone noticing. `corpus/analytics/` is derived and gitignored; the CSVs
// are a view of the tracked manifest, not a new source of truth.
//
// The dedupe is inherited from `clip-index.ts` rather than repeated: `manifest.csv` has one row per
// manifest work (including the 98 that share bytes with another, flagged), and `knn-k20.csv` has one
// row per *distinct image*, which is what a neighbour query can honestly be asked about.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { loadCorpusEmbeddings, rowAt } from './clip-index.js';
import { readManifest } from './manifest.js';
import { dimensionalityOf } from './vocabulary.js';
import { corpusBand } from './plates.js';

export const ANALYTICS_DIR = path.join(ROOT, 'corpus', 'analytics');
export const KNN_K = 20;

/** RFC 4180 enough for pandas: quote everything that could contain a comma, quote or newline. */
function csv(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rows(header: string[], body: unknown[][]): string {
  return [header.join(','), ...body.map((r) => r.map(csv).join(','))].join('\n') + '\n';
}

export interface ExportSummary {
  manifestRows: number;
  distinctImages: number;
  duplicateRows: number;
  knnRows: number;
  files: string[];
  seconds: number;
}

export function exportAnalytics(k = KNN_K): ExportSummary {
  const started = Date.now();
  const corpus = loadCorpusEmbeddings();
  const works = readManifest(path.join(ROOT, 'corpus', 'manifest.jsonl')).works;

  // Which manifest rows lost the sha256 tie, so `manifest.csv` can say so per row rather than
  // silently containing 98 works that no kNN row will ever mention.
  const kept = new Map(corpus.entries.map((e) => [e.sha256, e]));
  const alias = new Set<string>();
  for (const e of corpus.entries) for (const id of e.aliases) alias.add(id);

  const manifest = rows(
    [
      'id', 'sha256', 'museum', 'title', 'creator', 'date_display', 'date_begin', 'date_end',
      'classification', 'medium', 'culture', 'department', 'width', 'height', 'aspect', 'bytes',
      'dimensionality', 'is2D', 'has_image', 'is_duplicate_of_kept_row', 'embedding_row',
    ],
    works.map((w) => {
      const img = w.image ?? null;
      const dim = dimensionalityOf(w);
      const entry = img ? kept.get(img.sha256) : undefined;
      return [
        w.id,
        img?.sha256 ?? '',
        w.source,
        w.title ?? '',
        w.creator ?? '',
        w.date_display ?? '',
        w.date_begin ?? '',
        w.date_end ?? '',
        w.classification ?? '',
        w.medium ?? '',
        w.culture ?? '',
        w.department ?? '',
        img?.width ?? '',
        img?.height ?? '',
        img?.width && img.height ? (img.width / img.height).toFixed(6) : '',
        img?.bytes ?? '',
        dim ?? 'unknown',
        dim === null ? '' : dim === '2d' ? 1 : 0,
        img ? 1 : 0,
        alias.has(w.id) ? 1 : 0,
        entry && entry.work.id === w.id ? entry.row : '',
      ];
    }),
  );

  // kNN over the deduped rows. A full scan is 19,791 x 19,791 x 512 multiply-adds; there is no index
  // here and building one would be a second thing to keep correct for a query that runs once.
  const n = corpus.entries.length;
  const knnBody: unknown[][] = [];
  const best: { row: number; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    const q = rowAt(corpus.rows, i);
    best.length = 0;
    let worst = -Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let s = 0;
      const off = j * 512;
      for (let d = 0; d < 512; d++) s += corpus.rows[off + d]! * q[d]!;
      if (best.length < k) {
        best.push({ row: j, score: s });
        if (best.length === k) {
          best.sort((a, b) => b.score - a.score);
          worst = best[k - 1]!.score;
        }
      } else if (s > worst) {
        best[k - 1] = { row: j, score: s };
        let at = k - 1;
        while (at > 0 && best[at]!.score > best[at - 1]!.score) {
          const t = best[at]!;
          best[at] = best[at - 1]!;
          best[at - 1] = t;
          at--;
        }
        worst = best[k - 1]!.score;
      }
    }
    if (best.length < k) best.sort((a, b) => b.score - a.score);
    const self = corpus.entries[i]!;
    for (let rank = 0; rank < best.length; rank++) {
      const other = corpus.entries[best[rank]!.row]!;
      knnBody.push([
        self.sha256,
        self.work.id,
        self.work.source,
        rank + 1,
        other.sha256,
        other.work.id,
        other.work.source,
        best[rank]!.score.toFixed(6),
        self.work.source === other.work.source ? 1 : 0,
      ]);
    }
  }
  const knn = rows(
    ['sha256', 'id', 'museum', 'rank', 'neighbour_sha256', 'neighbour_id', 'neighbour_museum', 'cosine', 'same_museum'],
    knnBody,
  );

  const { band } = corpusBand();
  const sameMuseum = knnBody.reduce((a, r) => a + (r[8] as number), 0) / knnBody.length;
  // Chance is the probability two works drawn at random share a museum, from the museum shares
  // themselves — not 1/3, because the three museums contributed very different counts.
  const counts = new Map<string, number>();
  for (const e of corpus.entries) counts.set(e.work.source, (counts.get(e.work.source) ?? 0) + 1);
  let chance = 0;
  for (const c of counts.values()) chance += (c / n) * ((c - 1) / (n - 1));

  const bandJson = {
    version: 1,
    note:
      'The corpus pair-similarity band, from a 1,500-work stride sample of the deduped rows. Every ' +
      'cosine anywhere in this project is meaningless without it.',
    sample: band.works,
    pairs: band.pairs,
    min: band.min,
    median: band.median,
    max: band.max,
    corpusRows: n,
    manifestRows: works.length,
    duplicateRows: corpus.duplicates,
    knnK: k,
    sameMuseumShareAtK: sameMuseum,
    sameMuseumChance: chance,
    museums: [...counts].map(([museum, works]) => ({ museum, works, share: works / n })),
  };

  mkdirSync(ANALYTICS_DIR, { recursive: true });
  const files = [
    path.join(ANALYTICS_DIR, 'manifest.csv'),
    path.join(ANALYTICS_DIR, `knn-k${k}.csv`),
    path.join(ANALYTICS_DIR, 'band.json'),
  ];
  writeFileSync(files[0]!, manifest);
  writeFileSync(files[1]!, knn);
  writeFileSync(files[2]!, JSON.stringify(bandJson, null, 2) + '\n');

  return {
    manifestRows: works.length,
    distinctImages: n,
    duplicateRows: corpus.duplicates,
    knnRows: knnBody.length,
    files,
    seconds: (Date.now() - started) / 1000,
  };
}
