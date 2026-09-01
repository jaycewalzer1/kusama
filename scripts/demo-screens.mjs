// Screenshots every page the Thursday runbook opens, and fails loudly if one of them
// logs a console error or leaves the viewport empty.
//
// The pages are opened over `file://` because that is how the runbook opens them: `open <path>`.
// A page that only works behind a server is a page that will not work on stage, so testing it
// any other way would be testing the wrong thing.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'docs/demo/screens');
mkdirSync(OUT, { recursive: true });

/** name, path relative to the repo root, and how long to settle before the shot. */
const PAGES = JSON.parse(process.argv[2] ?? '[]');

const browser = await chromium.launch();
const report = [];

for (const p of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  const started = Date.now();
  await page.goto(`file://${path.join(ROOT, p.file)}`, { waitUntil: 'load' });
  await page.waitForTimeout(p.settle ?? 1200);

  // "Did anything actually draw" — a blank page is the failure mode a screenshot hides.
  const ink = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (c) {
      const g = c.getContext('2d');
      // A canvas painted by WebGL has no 2d context; fall back to its size.
      if (!g) return { kind: 'canvas-gl', w: c.width, h: c.height };
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] > 0) lit++;
      return { kind: 'canvas', w: c.width, h: c.height, litSamples: lit };
    }
    return { kind: 'dom', chars: document.body.innerText.length, imgs: document.images.length };
  });

  const dest = path.join(OUT, `${p.name}.png`);
  await page.screenshot({ path: dest, fullPage: p.fullPage ?? false });
  report.push({ name: p.name, file: p.file, ms: Date.now() - started, errors, ink });
  await page.close();
}

await browser.close();
writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const r of report) {
  const bad = r.errors.length > 0;
  process.stdout.write(
    `${bad ? 'FAIL' : 'ok  '} ${r.name.padEnd(34)} ${String(r.ms).padStart(5)}ms  ${JSON.stringify(r.ink)}${
      bad ? `\n       ${r.errors.join('\n       ')}` : ''
    }\n`,
  );
}
process.exitCode = report.some((r) => r.errors.length > 0) ? 1 : 0;
