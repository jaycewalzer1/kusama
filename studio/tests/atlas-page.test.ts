// The atlas page, checked as a string — there is no browser in the suite.
//
// What is worth pinning here is not that the HTML renders. It is that the page cannot quietly go
// back to asserting what it used to assume: the "distance between clusters means nothing" sentence
// is received wisdom, and once `--stability` has measured it the page must print the measurement
// instead. And that zoom does not scale the dots, which would defeat the only reason to zoom into
// 20,000 points drawn on 900 pixels.

import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasPage } from '../atlas-page.js';
import type { Atlas, Stability } from '../../artist/atlas.js';

function base(projection: Atlas['projection'] = 'umap'): Atlas {
  return {
    works: 3,
    projection,
    columns: ['clip:0', 'clip:1'],
    varianceExplained: [0.4, 0.2],
    loadings: [],
    preservation: { k: 20, n: 3, preserved: 0.5, chance: 0.1, informative: true },
    composition: [{ field: 'same museum', share: 0.6, chance: 0.39 }],
    points: [
      { id: 'a', source: 'met', x: 0, y: 0, kind: 'Print', period: '19c', title: 'A', creator: 'Hokusai', date: '1830', medium: 'woodblock', sha256: 'f'.repeat(64) },
      { id: 'b', source: 'aic', x: 1, y: 1, kind: 'Print', period: '19c', title: 'B & <b>', creator: null, date: '', medium: 'ink', sha256: null },
      { id: 'c', source: 'cma', x: 2, y: 0, kind: 'Bowl', period: '18c', title: 'C', creator: null, date: '', medium: '', sha256: null },
    ],
  };
}

function stab(neighbourAgreement: number, distanceRho: number): Stability {
  return {
    n: 1500,
    k: 20,
    chance: 0.013,
    runs: [
      { seed: 1, neighbours: 15, minDist: 0.1, preserved: 0.4 },
      { seed: 2, neighbours: 15, minDist: 0.1, preserved: 0.41 },
    ],
    seedPairs: [{ a: 0, b: 1, neighbourAgreement, distanceRho }],
    paramPairs: [{ a: 0, b: 1, neighbourAgreement: 0.3, distanceRho: 0.2 }],
    preservedMean: 0.405,
    preservedSd: 0.005,
  };
}

test('the page renders without a stability block and keeps the assumed caveat', () => {
  const html = atlasPage(base(), '2026-01-01');
  assert.match(html, /the gap between two clusters here means nothing/);
  assert.ok(!html.includes('SEED-DEPENDENT'));
  assert.ok(!html.includes('Measured over'));
});

test('once stability is measured the page prints the measurement instead of the assumption', () => {
  const html = atlasPage({ ...base(), stability: stab(0.72, 0.81) }, '2026-01-01');
  assert.ok(
    !html.includes('the gap between two clusters here means nothing, and only which points sit together does'),
    'the assumed sentence must not survive beside a measurement of the same thing',
  );
  assert.match(html, /Measured over 2 fits/);
  assert.match(html, /rho <b>0\.81<\/b>/);
  assert.match(html, /relative distance carries some information/);
  assert.match(html, /not assumed/);
});

test('a seed-dependent layout is refused on the page, in the words that stop a reader', () => {
  const html = atlasPage({ ...base(), stability: stab(0.11, 0.04) }, '2026-01-01');
  assert.match(html, /SEED-DEPENDENT/);
  assert.match(html, /Name no cluster from this map/);
  assert.match(html, /the distance between two clusters here means nothing/);
});

test('PCA never carries a stability block, because PCA has no seed', () => {
  const html = atlasPage(base('pca'), '2026-01-01');
  assert.ok(!html.includes('SEED-DEPENDENT'));
  assert.match(html, /% of the variance in 2 columns/);
});

test('the canvas takes a wheel, a drag and a double-click, and offers buttons beside them', () => {
  const html = atlasPage(base(), '2026-01-01');
  for (const ev of ['wheel', 'pointerdown', 'pointerup', 'pointercancel', 'dblclick']) {
    assert.ok(html.includes(`addEventListener('${ev}'`), `no ${ev} handler`);
  }
  assert.match(html, /passive: false/, 'the wheel must be able to preventDefault or the page scrolls instead');
  for (const id of ['zin', 'zout', 'zreset']) assert.ok(html.includes(`id="${id}"`), `no ${id} button`);
  assert.match(html, /touch-action:none/, 'without this a drag is a scroll on a trackpad');
});

test('zooming does not grow the dots, which is the only reason to zoom at all', () => {
  const html = atlasPage(base(), '2026-01-01');
  assert.match(html, /fillRect\(px\(p\) - 1\.2, py\(p\) - 1\.2, 2\.4, 2\.4\)/, 'the dot size must stay in screen pixels');
  assert.ok(!/2\.4 \* zoom|zoom \* 2\.4/.test(html));
});

test('hover reads the same transform the plot is drawn with', () => {
  const html = atlasPage(base(), '2026-01-01');
  // One definition of the projection, used by both the painter and the hit test. Two would drift,
  // and the drift would show up as a tooltip naming a work that is not under the cursor.
  assert.equal((html.match(/const px = p =>/g) ?? []).length, 1);
  assert.match(html, /px = p => bx\(p\) \* zoom \+ panX/);
  assert.match(html, /if \(drag\)/, 'a drag must suppress the tooltip rather than chase it');
});

test('hovering a dot offers the work itself, not only its coordinates', () => {
  const html = atlasPage(base(), '2026-01-01');
  // The sha is what an image can be found by, so it has to survive into the page; the record the
  // map was drawn from has to be there too, or the card is a title and a filename.
  assert.match(html, /"f{64}"/);
  assert.match(html, /"Hokusai"/);
  assert.match(html, /"woodblock"/);
  assert.match(html, /IMG \+ p\[7\] \+ '\.jpg/);
  // A work whose pixels never arrived is a legitimate manifest row: it must not render an <img>
  // pointing at a file that does not exist.
  assert.match(html, /no image on disk/);
  // Museum prose goes through innerHTML, so it goes through an escape first.
  assert.match(html, /function esc|const esc =/);
  assert.ok(!/hover\.innerHTML = *['"`]/.test(html), 'nothing may be written into the card unescaped');
});

test('the card is rebuilt only when the thing under the cursor changes', () => {
  // Otherwise every mousemove restarts the image request for the dot the cursor is already on.
  const html = atlasPage(base(), '2026-01-01');
  assert.match(html, /if \(key !== hovered\) \{ hover\.innerHTML = best; hovered = key; \}/);
});

test('a page written away from the images is told where they are', () => {
  const html = atlasPage(base(), '2026-01-01', { imageBase: '../../../corpus/images/' });
  assert.match(html, /const IMG = "\.\.\/\.\.\/\.\.\/corpus\/images\/"/);
  assert.match(atlasPage(base(), '2026-01-01'), /const IMG = "images\/"/);
});

test('the view is clamped so the corpus cannot be dragged off the canvas', () => {
  const html = atlasPage(base(), '2026-01-01');
  assert.match(html, /function clampPan/);
  // Three callers, and all three matter: the drag, the zoom and the resize. A resize that did not
  // re-clamp would leave the plot half off a narrowed window with no way to drag it back.
  assert.ok((html.match(/clampPan\(\);/g) ?? []).length >= 3, 'clamped on drag, on zoom and on resize');
  assert.match(html, /addEventListener\('resize', \(\) => \{ fit\(\); clampPan\(\); draw\(\); \}\)/);
});
