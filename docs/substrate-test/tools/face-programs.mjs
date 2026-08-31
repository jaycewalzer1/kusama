// Write one text-heavy program per face in a pack, so every face can be put through the same
// determinism gate the renderer went through.
//
//   node docs/substrate-test/tools/face-programs.mjs out/faces
//   npm run golden -- -e out/faces -g out/faces-goldens --update
//   npm run golden -- -e out/faces -g out/faces-goldens --check      # a second process
//
// The `--update` / `--check` pair is the point. A single process rendering the same program twice
// only shows that the process agrees with itself, and NOTES R8 is the record of that kind of
// agreement being wrong: four pages sharing one GPU process agreed on four different answers. Two
// separate `node` invocations, each launching its own Chromium, is the weakest thing that is still
// evidence.
//
// The programs are deliberately dense -- 8 text ops, tracking, wrapping, the full transform stack
// and glyph jitter -- because a face that only ever draws one word at 40px is not being tested.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'out/faces';
const packId = process.argv[3] ?? 'core-v1';
const pack = JSON.parse(readFileSync(path.join('assets', 'packs', packId, 'pack.json'), 'utf8'));
const faces = Object.keys(pack.faces).sort();

const SAMPLE = 'The medium refuses what it cannot repeat';

/** Eight text ops that between them exercise every text argument the profile allows. */
function textOps(face) {
  return [
    { id: 't-head', y: 70, size: 44, text: 'SET AND SETTING', align: 'left', tracking: 2, case: 'upper' },
    { id: 't-rot', y: 130, size: 26, text: 'rotated nine degrees', align: 'left', rotate: 9 },
    { id: 't-skew', y: 180, size: 26, text: 'skewed twelve degrees', align: 'left', skew: 12 },
    { id: 't-wide', y: 232, size: 26, text: 'stretched wide', align: 'left', stretch: [1.6, 1] },
    { id: 't-tall', y: 292, size: 26, text: 'stretched tall', align: 'left', stretch: [1, 1.5] },
    { id: 't-jit', y: 344, size: 26, text: 'jittered per glyph', align: 'left', jitter: { translate: 1.5, rotate: 4, scale: 0.08 } },
    { id: 't-wrap', y: 396, size: 20, text: SAMPLE, align: 'left', maxWidth: 300, leading: 1.5, tracking: 0.5 },
    { id: 't-low', y: 486, size: 22, text: 'LOWERCASED-BY-THE-PROGRAM', align: 'left', case: 'lower' },
  ].map((o) => {
    const { id, ...rest } = o;
    return {
      id,
      type: 'op',
      op: 'text',
      rngKey: id,
      args: { x: 40, font: face, color: 'ink', ...rest },
    };
  });
}

function program(face) {
  return {
    version: '0.2',
    profile: 'default-v1',
    assetPack: packId,
    canvas: { width: 400, height: 520, ground: '#f2efe6', brushScale: 1 },
    seed: 4711,
    palette: { ink: '#141414', rule: '#8a2020' },
    root: {
      id: 'root',
      type: 'group',
      children: [
        {
          id: 'r-under',
          type: 'op',
          op: 'rule',
          rngKey: 'r-under',
          args: { from: [40, 86], to: [360, 86], brush: 'marker', color: 'rule', weight: 3 },
        },
        ...textOps(face),
      ],
    },
  };
}

mkdirSync(outDir, { recursive: true });
for (const face of faces) {
  writeFileSync(path.join(outDir, `${face}.json`), `${JSON.stringify(program(face), null, 2)}\n`);
}
console.log(`wrote ${faces.length} face programs to ${outDir}`);
