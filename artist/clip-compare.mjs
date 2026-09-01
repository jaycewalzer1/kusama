// Does what a work LOOKS LIKE agree with what its museum SAYS about it?
//
// The metadata atlas found real neighbourhoods (34x chance) but both of its axes turned out to be
// museum identity — it had largely learnt which of three institutions catalogued a thing. CLIP has
// never seen the catalogue. So the interesting number is not whether the CLIP map is good; it is
// whether the two maps agree, and whether appearance crosses the museum wall that metadata could not.
import fs from 'node:fs';
import { vectorise, standardise, evenSample } from '/Users/jaycewalzer/kusama/dist/artist/atlas.js';

const ROOT = '/Users/jaycewalzer/kusama';
const DIM = 512;
const K = 20;

const rows = fs.readFileSync(`${ROOT}/corpus/manifest.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const index = JSON.parse(fs.readFileSync(`${ROOT}/corpus/clip-index.json`, 'utf8'));
const rowOf = new Map(index.map((sha, i) => [sha, i]));
const buf = fs.readFileSync(`${ROOT}/corpus/clip.f32`);
const clip = (i) => new Float32Array(buf.buffer, buf.byteOffset + i * DIM * 4, DIM);

const withPixels = rows.filter((w) => w.image && rowOf.has(w.image.sha256));
// Stride, never a prefix: the manifest is written grouped by source, so the first 1500 rows are one
// museum and would answer the question by construction.
const sample = evenSample(withPixels, 1500);
const n = sample.length;

// --- the two spaces ---
const meta = standardise(vectorise(sample).rows);
const pix = sample.map((w) => Float64Array.from(clip(rowOf.get(w.image.sha256))));

const cosine = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};
const euclid2 = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) * (a[i] - b[i]);
  return d;
};

function neighbours(space, metric) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const scored = [];
    for (let j = 0; j < n; j++) if (j !== i) scored.push([metric(space[i], space[j]), j]);
    // cosine: bigger is nearer. euclid2: smaller is nearer.
    scored.sort(metric === cosine ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
    out.push(scored.slice(0, K).map(([, j]) => j));
  }
  return out;
}

process.stdout.write(`${n} works sampled by stride from ${withPixels.length} with pixels\n\n`);
const nMeta = neighbours(meta, euclid2);
const nPix = neighbours(pix, cosine);

// --- 1. do the two maps agree? ---
let overlap = 0;
for (let i = 0; i < n; i++) {
  const s = new Set(nMeta[i]);
  overlap += nPix[i].filter((j) => s.has(j)).length;
}
const chanceOverlap = (K * K) / (n - 1);
process.stdout.write('1. AGREEMENT between the catalogue and the picture\n');
process.stdout.write(
  `   of a work's ${K} nearest by appearance, ${(overlap / n).toFixed(2)} are also among its ${K} nearest by metadata\n` +
    `   ${chanceOverlap.toFixed(2)} would be by chance, so ${(overlap / n / chanceOverlap).toFixed(1)}x chance\n\n`,
);

// --- 2. does appearance cross the museum wall? ---
const share = (nbrs, of) => {
  let same = 0;
  for (let i = 0; i < n; i++) same += nbrs[i].filter((j) => of(sample[j]) === of(sample[i])).length;
  return same / (n * K);
};
// Chance = probability two independently drawn works share the value, over this sample.
const chanceShare = (of) => {
  const counts = new Map();
  for (const w of sample) counts.set(of(w), (counts.get(of(w)) ?? 0) + 1);
  let p = 0;
  for (const c of counts.values()) p += (c / n) * ((c - 1) / (n - 1));
  return p;
};

for (const [label, of] of [
  ['same museum     ', (w) => w.source],
  ['same class      ', (w) => (w.classification ?? '(none)').toLowerCase()],
  ['same culture    ', (w) => (w.culture ?? '(none)').toLowerCase()],
]) {
  process.stdout.write(
    `2. ${label} chance ${(100 * chanceShare(of)).toFixed(1)}%  |  metadata ${(100 * share(nMeta, of)).toFixed(1)}%  |  appearance ${(100 * share(nPix, of)).toFixed(1)}%\n`,
  );
}

// --- 3. near-duplicate images the content hash could not catch ---
// Byte-identical files already collapsed into one sha. This finds the other kind: the same object
// photographed twice, which will read as a 1.0 discovery to anything that does not know.
let pairs = 0;
const close = [];
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    pairs++;
    const c = cosine(pix[i], pix[j]);
    if (c > 0.98) close.push([c, sample[i], sample[j]]);
  }
}
close.sort((a, b) => b[0] - a[0]);
process.stdout.write(`\n3. NEAR-DUPLICATES over ${pairs.toLocaleString()} pairs: ${close.length} above 0.98 cosine\n`);
for (const [c, a, b] of close.slice(0, 6)) {
  process.stdout.write(`   ${c.toFixed(4)}  ${a.id} "${(a.title ?? '').slice(0, 34)}"  <->  ${b.id} "${(b.title ?? '').slice(0, 34)}"\n`);
}
