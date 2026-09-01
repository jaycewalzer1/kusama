// Drives the atlas overlay page through every interaction it actually has, recording a video and
// a still after each step.
//
// The page has no pan and no zoom. Its whole interactive surface is: the `colour by` buttons, the
// corpus grey/coloured toggle, and a hover readout. So this drives those, and nothing pretends
// otherwise — a recording of a gesture the page does not support would be a recording of a lie.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PAGE = process.argv[2] ?? 'docs/demo/rendered/atlas-condition-withheld__inf-withheld.html';
const OUT = path.join(ROOT, 'docs/demo/video');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`file://${path.join(ROOT, PAGE)}`, { waitUntil: 'load' });
await page.waitForTimeout(2500);

const frames = [];
let n = 0;
const shot = async (label) => {
  const name = `${String(++n).padStart(2, '0')}-${label}`;
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  frames.push(name);
};

await shot('open');

// Every `colour by` field the page offers, in the order it offers them.
const fields = await page.$$eval('#controls button[data-by]', (bs) => bs.map((b) => b.dataset.by));
for (const f of fields) {
  await page.click(`#controls button[data-by="${f}"]`);
  await page.waitForTimeout(900);
  await shot(`colour-by-${f}`);
}

// Hover the final plate, so the readout is on screen in at least one frame. The page keeps its
// landmarks in `LANDMARKS` and its projection in `px`/`py`, so ask the page where the plate is
// rather than guessing a pixel.
const at = await page.evaluate(() => {
  const l = LANDMARKS.find((x) => x[2] === 'final') ?? LANDMARKS[0];
  return l ? { x: Math.round(px(l)), y: Math.round(py(l)), label: l[4] } : null;
});
if (at) {
  const box = await page.locator('#c').boundingBox();
  await page.mouse.move(box.x + at.x, box.y + at.y);
  await page.waitForTimeout(900);
  await shot('hover-final-plate');
  await page.mouse.move(box.x + 20, box.y + 20);
}

// The corpus grey/coloured toggle, and back. Grey is the default and the legible one — against
// 19,791 coloured points the plates disappear — so the sequence ends where it started.
if (await page.$('#dim')) {
  await page.click('#dim');
  await page.waitForTimeout(700);
  await shot('corpus-coloured');
  await page.click('#dim');
  await page.waitForTimeout(700);
  await shot('corpus-grey-again');
}

await page.close();
await ctx.close();
await browser.close();

const report = { page: PAGE, frames, hover: at, errors };
writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${frames.length} frames, hover ${at ? at.label : 'none'}, ${errors.length} console errors\n`);
process.exitCode = errors.length > 0 ? 1 : 0;
