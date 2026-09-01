// Embed every distinct corpus image with the local CLIP vision encoder.
//
// Run from the worktree (which has the model and onnxruntime), but pointed at the MAIN tree's
// corpus, because `embed()` takes an absolute path and does not go through ROOT. The two halves of
// this live in different directories only because .models/ and corpus/images/ are gitignored and a
// worktree does not inherit them.
//
// Output is one packed Float32 matrix, appended a row at a time, so a kill costs at most one image.
// The row order is the sorted sha256 order, which is deterministic, so resume = skip the first N.
//
// The absolute paths are not laziness. `.models/` and `corpus/images/` are gitignored, so a worktree
// does not inherit them: the 351MB encoder and onnxruntime are HERE and the 19,807-image corpus is
// THERE, and neither tree has both. This file is the join, and it stops being necessary the day
// resemblance.ts is merged to master — which the measurement says costs no envVersion hash.
//
// Ran 2026-08-31: 19,807 images, 27.4/s, 12 minutes, 40.6MB, zero failures.
import fs from 'node:fs';
import path from 'node:path';
import { embed } from '/Users/jaycewalzer/kusama/.claude/worktrees/artmine-recs/dist/artist/resemblance.js';

const MAIN = '/Users/jaycewalzer/kusama';
const IMAGES = path.join(MAIN, 'corpus', 'images');
const OUT = path.join(MAIN, 'corpus', 'clip.f32');
const DIM = 512;
const ROW = DIM * 4;

const limit = Number(process.argv[2] ?? 0);

// Files, not manifest rows. 98 rows share bytes with another row, so embedding rows would encode
// 98 images twice and then report the duplicates as a discovery.
const shas = fs
  .readdirSync(IMAGES)
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => f.replace(/\.jpg$/, ''))
  .sort();

const todo = limit ? shas.slice(0, limit) : shas;
const done = fs.existsSync(OUT) ? Math.floor(fs.statSync(OUT).size / ROW) : 0;
if (done > todo.length) throw new Error(`${OUT} already holds ${done} rows, more than the ${todo.length} planned`);

process.stdout.write(`${todo.length} images, ${done} already embedded, ${todo.length - done} to go\n`);

const out = fs.createWriteStream(OUT, { flags: 'a' });
const started = Date.now();
let failed = 0;

for (let i = done; i < todo.length; i++) {
  const sha = todo[i];
  try {
    const v = await embed(path.join(IMAGES, `${sha}.jpg`));
    if (v.length !== DIM) throw new Error(`expected ${DIM} dims, got ${v.length}`);
    if (!out.write(Buffer.from(v.buffer, v.byteOffset, v.byteLength))) {
      await new Promise((r) => out.once('drain', r));
    }
  } catch (err) {
    // A row must exist for every image or the index no longer lines up with the matrix. A zero row
    // is a legible failure — its norm is 0, which no real embedding has.
    failed++;
    process.stdout.write(`\n  FAILED ${sha}: ${err.message}\n`);
    out.write(Buffer.alloc(ROW));
  }
  if ((i + 1) % 200 === 0 || i + 1 === todo.length) {
    const rate = (i + 1 - done) / ((Date.now() - started) / 1000);
    const left = (todo.length - i - 1) / rate;
    process.stdout.write(
      `\r${i + 1}/${todo.length}  ${rate.toFixed(1)}/s  ${(left / 60).toFixed(1)} min left  ${failed} failed   `,
    );
  }
}

await new Promise((r) => out.end(r));
const rows = Math.floor(fs.statSync(OUT).size / ROW);
process.stdout.write(`\n${OUT}: ${rows} rows x ${DIM}, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${failed} failed\n`);
fs.writeFileSync(path.join(MAIN, 'corpus', 'clip-index.json'), JSON.stringify(todo));
process.stdout.write(`corpus/clip-index.json: ${todo.length} sha256s, row i of the matrix is index i here\n`);
