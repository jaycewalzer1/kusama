// Writes five seed variants of each probe into out/substrate-test/seeds/.
//
// The only field that changes is `seed`; everything else, including every rngKey, is untouched, so
// any variation between the five is variation the substrate produced and not variation authored.
//
// Run from the medium/ directory:
//   node docs/substrate-test/tools/seeds.mjs                       # the v0 probes
//   node docs/substrate-test/tools/seeds.mjs examples/probes/v1 out/substrate-test/seeds-v1
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PROBES = [
  'xerox-zine', 'xerox-zine-b',
  'ur-stencil', 'ur-stencil-b',
  'ransom-note', 'ransom-note-b',
  'rave-flyer', 'rave-flyer-b',
  'crass-collage', 'crass-collage-b',
  'ikeda-austerity', 'ikeda-austerity-b',
];
export const SEED_OFFSETS = [0, 101, 2027, 30011, 400009];

// The other two tools import PROBES from here, so the writing is guarded: importing this module
// must not touch the disk.
if (process.argv[1]?.endsWith('seeds.mjs')) {
  const srcDir = process.argv[2] ?? 'examples/probes';
  const outDir = process.argv[3] ?? 'out/substrate-test/seeds';
  mkdirSync(outDir, { recursive: true });
  for (const probe of PROBES) {
    const program = JSON.parse(readFileSync(path.join(srcDir, `${probe}.json`), 'utf8'));
    SEED_OFFSETS.forEach((offset, i) => {
      const variant = { ...program, seed: program.seed + offset };
      writeFileSync(path.join(outDir, `${probe}-s${i + 1}.json`), `${JSON.stringify(variant, null, 2)}\n`);
    });
  }
  console.log(`wrote ${PROBES.length * SEED_OFFSETS.length} seed variants to ${outDir}`);
}
