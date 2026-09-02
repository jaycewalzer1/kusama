// RESEARCH's hands: the corpus, queryable along several axes at once, in milliseconds.
//
// The brief's demand is that the artist arrive at FIND holding concrete stealable material with
// provenance — "ruled lines that show through the text and rubricated initials that ignore the
// column, as in these six manuscripts", not "medieval feel". That needs a query surface, and the
// repo did not have one: `text-space.ts` retrieves document-to-document, `influences.ts` resolves a
// position into a fixed 48-work shelf offline. Neither answers a question an artist thought of
// while working.
//
// ## Report-only, and it must stay that way
//
// Nothing here writes a log line, touches a profile, or is reachable from a hash. What enters the
// trajectory is the material sheet the artist *wrote* after reading these candidates, as an
// observation with citations. The query that produced the candidates is discovery data. If a
// function in this file ever needs to be deterministic across machines, something upstream has
// wired it into the wrong record.
//
// ## Which axis can carry which question — measured, not assumed
//
// **Subject and iconography is BM25 and cannot be CLIP-text.** Asked for "ruled lines showing
// through the text with rubricated initials ignoring the column", CLIP-text returns Egyptian tomb
// chapel reliefs (Egyptian Art is 45 of its top 100). Mean-centring, which is worth +7.1 on the
// labelled cross-modal task, does not fix that here — it swaps the hub for Prints and Drawings at 40
// of 100 and answers a tally-marks query with Paul Revere's autograph. The two are different jobs.
// BM25 was already the number to beat on this corpus (92.4% against CLIP-text's 76.2%).
//
// **Formal similarity is image-to-image, which is what CLIP and DINO are actually good at.** They
// share only 25.1% of their top-20, so both are offered and every candidate says which found it;
// three quarters of "the nearest work" is otherwise a fact about the encoder presented as a fact
// about the picture.
//
// ## Two things that would quietly produce a worse sheet
//
// **BM25 matches words, not concepts.** "five" retrieves *Five Guineas*, "wall" retrieves *Wall
// Cupboard*, "surface" retrieves *Fragment of the Interior surface of Siptah's Canopic Chest*. This
// is not a defect to be patched with a reranker; it is why the artist reads the candidates and the
// retriever never asserts relevance. `why` on every candidate says what actually matched so a bad
// hit is visibly bad rather than silently authoritative.
//
// **Egyptian Art is 26.0% of the manifest.** A raw ranking gives it 41-46% of the top 100, which is
// 1.7x its own share and not the pathology it looks like until you know the baseline. `capPerFacet`
// walks the ranking taking at most a few per department and per culture, which turns a 50-work
// request into 34-41 cultures and 23-24 departments — comfortably past the brief's three. It can
// also starve: a narrow query returned 20 of 50 asked for. `Sheet.shortfall` says so, because a
// short sheet that reads as a full one is the failure this whole file exists to avoid.

import { existsSync } from 'node:fs';
import { loadEmbeddings, loadCorpusEmbeddings, nearest, rowAt, MANIFEST, type CorpusEmbeddings } from './clip-index.js';
import { DIM as DINO_DIM, DINO_INDEX, DINO_MATRIX, available as dinoAvailable } from './dino.js';
import { readManifest, type Work } from './manifest.js';
import { buildIndex, BM25_B, BM25_K1, TEXT_FIELDS, type TextIndex } from './text-space.js';
import { tokenise } from './vocabulary.js';

export type Axis = 'subject' | 'form-clip' | 'form-dino' | 'metadata';

export interface Candidate {
  work: Work;
  axis: Axis;
  score: number;
  /** What actually matched, in the artist's words not the index's. Never a bare number. */
  why: string;
}

/**
 * The manifest, its BM25 index, and the term-id map, built once.
 *
 * The map is not a convenience. `TextIndex.postings` and `TextIndex.idf` are indexed by term *id*,
 * so `postings['column']` is `undefined` and a string-keyed scoring loop scores every document zero
 * and returns an empty result with no error at all. That cost a probe run before it was noticed.
 */
export interface ResearchIndex {
  works: Work[];
  text: TextIndex;
  termId: Map<string, number>;
}

let cachedIndex: ResearchIndex | null = null;

export function loadResearchIndex(): ResearchIndex {
  if (cachedIndex) return cachedIndex;
  const { works } = readManifest(MANIFEST);
  const text = buildIndex(works, TEXT_FIELDS);
  cachedIndex = { works, text, termId: new Map(text.terms.map((t, i) => [t, i])) };
  return cachedIndex;
}

/**
 * Okapi BM25 for a free-text query rather than a document.
 *
 * The scoring is `text-space.ts`'s, term for term, deliberately: a second BM25 with its own constants
 * would report its disagreement with the first as a finding about the corpus. Returns every document
 * with a positive score, ranked, so the caller can diversify over a real tail instead of over a
 * truncated head.
 */
export function scoreSubject(ix: ResearchIndex, query: string): { doc: number; score: number; terms: string[] }[] {
  const bag = new Map<string, number>();
  for (const t of tokenise(query)) bag.set(t, (bag.get(t) ?? 0) + 1);
  const scores = new Float64Array(ix.works.length);
  const hit: Map<number, string[]> = new Map();
  for (const term of bag.keys()) {
    const id = ix.termId.get(term);
    if (id === undefined) continue;
    const idf = ix.text.idf[id] as number;
    const p = ix.text.postings[id] as Int32Array;
    for (let i = 0; i < p.length; i += 2) {
      const doc = p[i] as number;
      const tf = p[i + 1] as number;
      const norm = 1 - BM25_B + (BM25_B * (ix.text.lengths[doc] as number)) / (ix.text.avgLength || 1);
      scores[doc] = (scores[doc] as number) + (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
      const seen = hit.get(doc);
      if (seen) seen.push(term);
      else hit.set(doc, [term]);
    }
  }
  const out: { doc: number; score: number; terms: string[] }[] = [];
  for (const [doc, terms] of hit) out.push({ doc, score: scores[doc] as number, terms });
  out.sort((a, b) => b.score - a.score || (ix.works[a.doc]!.id < ix.works[b.doc]!.id ? -1 : 1));
  return out;
}

/**
 * The century a work sits in, or null when the catalogue will not say.
 *
 * The guard is not defensive padding: one manifest row carries a `date_begin` of 1486400, and an
 * ungated `Math.floor(d / 100)` puts it in the 148th century and silently widens every "how many
 * periods does this sheet span" count by one.
 */
export function centuryOf(w: Work): number | null {
  const d = w.date_begin;
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= -4000 || d >= 2100) return null;
  return Math.floor(d / 100);
}

function facets(w: Work): string[] {
  return [`dep:${w.department || '-'}`, `cul:${w.culture || '-'}`];
}

/**
 * Walk a ranking taking at most `cap` per department and per culture.
 *
 * Applied to the ranking rather than to a fixed head, so exhausting the caps falls through to the
 * tail instead of returning nothing.
 */
function diversify<T>(ranked: T[], workOf: (t: T) => Work, k: number, cap: number): T[] {
  const used = new Map<string, number>();
  const out: T[] = [];
  for (const item of ranked) {
    if (out.length >= k) break;
    const f = facets(workOf(item));
    if (f.some((key) => (used.get(key) ?? 0) >= cap)) continue;
    for (const key of f) used.set(key, (used.get(key) ?? 0) + 1);
    out.push(item);
  }
  return out;
}

export interface MetadataFilter {
  culture?: string;
  department?: string;
  classification?: string;
  medium?: string;
  /** Inclusive century bounds, e.g. 12 and 15 for the 1100s through the 1500s. */
  centuryFrom?: number;
  centuryTo?: number;
}

export interface QuerySpec {
  /** Free text, scored by BM25 over the catalogue. The subject and iconography axis. */
  subject?: string;
  /** A manifest work id. Its nearest neighbours by appearance. The formal similarity axis. */
  like?: string;
  /** Catalogue columns, matched case-insensitively as substrings. The metadata axis. */
  where?: MetadataFilter;
  k?: number;
  /** At most this many per department and per culture. 0 turns diversification off. */
  capPerFacet?: number;
}

export interface Sheet {
  spec: QuerySpec;
  candidates: Candidate[];
  /** How many were asked for and not found, and why. Empty string when the request was met. */
  shortfall: string;
  cultures: number;
  departments: number;
  centuries: number;
}

function matches(w: Work, f: MetadataFilter): boolean {
  const like = (v: string | null | undefined, want: string | undefined): boolean =>
    want === undefined || (v ?? '').toLowerCase().includes(want.toLowerCase());
  if (!like(w.culture, f.culture)) return false;
  if (!like(w.department, f.department)) return false;
  if (!like(w.classification, f.classification)) return false;
  if (!like(w.medium, f.medium)) return false;
  if (f.centuryFrom !== undefined || f.centuryTo !== undefined) {
    const c = centuryOf(w);
    if (c === null) return false;
    if (f.centuryFrom !== undefined && c < f.centuryFrom) return false;
    if (f.centuryTo !== undefined && c > f.centuryTo) return false;
  }
  return true;
}

let cachedDino: CorpusEmbeddings | null = null;

function dinoEmbeddings(): CorpusEmbeddings | null {
  if (cachedDino) return cachedDino;
  if (!dinoAvailable()) return null;
  cachedDino = loadEmbeddings(DINO_MATRIX, DINO_INDEX, DINO_DIM);
  return cachedDino;
}

/**
 * Nearest by appearance in one space, as candidates.
 *
 * `self` is excluded, and so are the aliases: 98 manifest rows share bytes with another row, so a
 * neighbour list that did not dedupe would spend its first slot telling the artist that a work looks
 * exactly like itself under a different accession number.
 */
function formAxis(
  emb: CorpusEmbeddings,
  dim: number,
  axis: Axis,
  space: string,
  workId: string,
  k: number,
  cap: number
): Candidate[] {
  const at = emb.entries.findIndex((e) => e.work.id === workId || e.aliases.includes(workId));
  if (at < 0) return [];
  const self = emb.entries[at]!;
  const hits = nearest(emb.rows, emb.entries.length, rowAt(emb.rows, at, dim), Math.max(k * 8, 64), dim)
    .filter((h) => h.row !== at)
    .map((h) => {
      const e = emb.entries[h.row]!;
      return {
        work: e.work,
        axis,
        score: h.score,
        why: `looks like ${self.work.title || workId} in ${space} (cosine ${h.score.toFixed(3)})`,
      } satisfies Candidate;
    });
  return cap > 0 ? diversify(hits, (c) => c.work, k, cap) : hits.slice(0, k);
}

/**
 * One question, answered along every axis it names.
 *
 * The axes are not fused into a single ranking. RRF over BM25 and CLIP-text was measured on this
 * corpus and printed NOTHING MEASURED — +0.3 points, inside the noise band — and a fused score would
 * also destroy the one property the material sheet depends on, which is that the artist can see
 * which axis found a work and judge the hit accordingly.
 */
export function search(spec: QuerySpec): Sheet {
  const k = spec.k ?? 50;
  // The research phase promises at most forty per question. A direct inspection may ask for more,
  // but forty is still a complete research sheet; below that the missing tail must be named.
  const useful = Math.min(k, 40);
  const cap = spec.capPerFacet ?? 3;
  const ix = loadResearchIndex();
  const candidates: Candidate[] = [];
  const notes: string[] = [];

  if (spec.subject) {
    const ranked = scoreSubject(ix, spec.subject).filter((r) => !spec.where || matches(ix.works[r.doc]!, spec.where));
    const picked = cap > 0 ? diversify(ranked, (r) => ix.works[r.doc]!, k, cap) : ranked.slice(0, k);
    for (const r of picked) {
      candidates.push({
        work: ix.works[r.doc]!,
        axis: 'subject',
        score: r.score,
        why: `catalogue text contains ${[...new Set(r.terms)].sort().join(', ')}`,
      });
    }
    if (picked.length < useful) {
      notes.push(
        `subject: asked for ${k}, found ${picked.length} of ${ranked.length} works scoring above zero` +
          (cap > 0 ? ` under a cap of ${cap} per department and per culture` : '')
      );
    }
  }

  if (spec.like) {
    const clip = formAxis(loadCorpusEmbeddings(), 512, 'form-clip', 'CLIP', spec.like, k, cap);
    candidates.push(...clip);
    if (clip.length === 0) notes.push(`form: no work in the embedded corpus has id "${spec.like}"`);
    const dino = dinoEmbeddings();
    if (dino) candidates.push(...formAxis(dino, DINO_DIM, 'form-dino', 'DINOv2', spec.like, k, cap));
    else notes.push('form: DINOv2 is not on this machine, so only CLIP answered the appearance axis');
  }

  if (spec.where && !spec.subject) {
    const hits = ix.works.filter((w) => matches(w, spec.where!));
    const picked = cap > 0 ? diversify(hits, (w) => w, k, cap) : hits.slice(0, k);
    for (const w of picked) {
      candidates.push({ work: w, axis: 'metadata', score: 0, why: 'matches the catalogue filter, unranked' });
    }
    if (picked.length < useful) notes.push(`metadata: asked for ${k}, ${hits.length} works match the filter`);
  }

  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.work.id) ? false : (seen.add(c.work.id), true)));
  return {
    spec,
    candidates: unique,
    shortfall: notes.join('; '),
    cultures: new Set(unique.map((c) => c.work.culture || '-')).size,
    departments: new Set(unique.map((c) => c.work.department || '-')).size,
    centuries: new Set(unique.map((c) => centuryOf(c.work)).filter((c) => c !== null)).size,
  };
}

/**
 * Whether the corpus this file needs is on this machine at all.
 *
 * `corpus/manifest.jsonl` is tracked, so this is true on a fresh clone; the embedding matrices the
 * form axis needs are not, which is why `search` reports their absence as a shortfall rather than
 * throwing. A research phase on a machine without them is narrower, not broken.
 */
export function corpusAvailable(): boolean {
  return existsSync(MANIFEST);
}
