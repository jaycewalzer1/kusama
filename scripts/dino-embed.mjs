// Embed every distinct corpus image with the local DINOv2-small encoder, into `corpus/dino.f32`.
//
// The counterpart of the CLIP run that produced `corpus/clip.f32`, and deliberately the same shape:
// files rather than manifest rows (98 rows share bytes with another row, so embedding rows would
// encode 98 images twice), sorted sha256 order so the row order is deterministic and a kill costs at
// most one image, and a zero row written on failure so the matrix and the index never drift apart.
//
// Derived data, gitignored, ~30MB. Rebuildable from the images at any time with no API and no key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, DIM } from '../dist/artist/dino.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = path.join(ROOT, 'corpus', 'images');
const OUT = path.join(ROOT, 'corpus', 'dino.f32');
const ROW = DIM * 4;

const limit = Number(process.argv[2] ?? 0);

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
    failed++;
    process.stdout.write(`\n  FAILED ${sha}: ${err.message}\n`);
    out.write(Buffer.alloc(ROW));
  }
  if ((i + 1) % 500 === 0 || i + 1 === todo.length) {
    const rate = (i + 1 - done) / ((Date.now() - started) / 1000);
    process.stdout.write(
      `${i + 1}/${todo.length}  ${rate.toFixed(1)}/s  ${((todo.length - i - 1) / rate / 60).toFixed(1)} min left  ${failed} failed\n`,
    );
  }
}

await new Promise((r) => out.end(r));
const rows = Math.floor(fs.statSync(OUT).size / ROW);
process.stdout.write(`\n${OUT}: ${rows} rows x ${DIM}, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${failed} failed\n`);
fs.writeFileSync(path.join(ROOT, 'corpus', 'dino-index.json'), JSON.stringify(todo));
process.stdout.write(`corpus/dino-index.json: ${todo.length} sha256s, row i of the matrix is index i here\n`);
