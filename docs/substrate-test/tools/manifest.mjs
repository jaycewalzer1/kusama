// Gathers every hash produced by the substrate test into out/substrate-test/manifest.json.
//
// Run from the repo root, after golden and batch:
//   node docs/substrate-test/tools/manifest.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { PROBES, SEED_OFFSETS } from './seeds.mjs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const goldens = read('out/substrate-test/probe-goldens/index.json');
const manifest = {
  note: 'Every hash produced by the punk/techno substrate test. Two independent browser processes agreed on all twelve probe goldens.',
  runtime: goldens.runtime,
  profile: 'default-v0@15ad87c16095',
  pack: 'core@003e484d9602',
  probeGoldens: goldens.entries,
  probeBatches: {},
  baseline: {},
};

for (const probe of PROBES) {
  const b = read(`out/substrate-test/batch/${probe}/batch.json`);
  manifest.probeBatches[probe] = {
    elapsedMs: b.elapsedMs,
    positionIndependent: b.positionIndependent,
    renders: b.renders.map((r) => ({ name: r.name, seed: read(r.file).seed, programHash: r.programHash, pixels: r.pixels })),
  };
  const distinct = new Set(manifest.probeBatches[probe].renders.map((r) => r.pixels)).size;
  manifest.probeBatches[probe].distinctPixelHashes = distinct;
}

const base = read('out/substrate-test/batch/baseline/batch.json');
manifest.baseline = {
  count: base.renders.length,
  elapsedMs: base.elapsedMs,
  positionIndependent: base.positionIndependent,
  renders: base.renders.map((r) => ({ name: r.name, programHash: r.programHash, pixels: r.pixels })),
};

writeFileSync('out/substrate-test/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
for (const probe of PROBES) {
  const p = manifest.probeBatches[probe];
  console.log(`${probe.padEnd(20)} ${p.distinctPixelHashes}/${SEED_OFFSETS.length} distinct   ${p.renders.map((r) => r.pixels.slice(0, 8)).join(' ')}`);
}
console.log(`baseline ${manifest.baseline.count} renders, ${new Set(manifest.baseline.renders.map((r) => r.pixels)).size} distinct`);
