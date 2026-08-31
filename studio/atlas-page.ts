// One self-contained HTML file showing the corpus laid out, for a reader with no terminal.
//
// A file and not a served page, because the person this is for cannot run a command: they open it.
// A file and not a notebook, because there is no jupyter, numpy or matplotlib on this machine, and a
// notebook that cannot be executed is a picture of an analysis rather than one.
//
// The panel leads with what the layout is *made of* and whether it beats chance, above the plot
// rather than beneath it. That ordering is the entire point. A scatter plot is read in a second and
// its caveats are read never, so the caveat goes where the eye lands first.

import type { Atlas } from '../artist/atlas.js';

/** Colour by the label, stable across renders: the same category is the same colour every time. */
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9'];

export function atlasPage(a: Atlas, generatedAt: string): string {
  // Only the columns the page draws with. The full record stays in atlas.json; duplicating it here
  // would triple the file for fields nothing on the page reads.
  const points = a.points.map((p) => [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), p.source, p.kind, p.period, p.title, p.id]);
  const p = a.preservation;
  const ratio = p.preserved / (p.chance || 1);
  const verdict = p.informative
    ? `Neighbourhoods on this map are real: ${ratio.toFixed(1)}x what scattering the same ${p.n} points at random would give.`
    : `NOTHING MEASURED. At ${ratio.toFixed(1)}x chance this layout is decoration. Do not read clusters off it.`;

  return `<!doctype html>
<meta charset="utf-8">
<title>the corpus, from its metadata alone</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; background:#111; color:#ddd; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
  header { padding:14px 18px; border-bottom:1px solid #333 }
  h1 { font-size:15px; margin:0 0 6px; font-weight:600 }
  .verdict { padding:8px 12px; border-left:3px solid ${p.informative ? '#3cb44b' : '#e6194b'}; background:#1a1a1a; margin:8px 0 }
  .cols { display:flex; gap:26px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:#999 }
  .cols b { color:#ddd; font-weight:600 }
  .cols div { max-width:320px }
  main { display:flex }
  canvas { background:#0b0b0b; cursor:crosshair }
  aside { width:270px; padding:12px 14px; border-left:1px solid #333; height:calc(100vh - 190px); overflow:auto }
  button { background:#222; color:#ddd; border:1px solid #444; padding:4px 9px; margin:0 4px 4px 0; cursor:pointer; font:inherit }
  button[aria-pressed=true] { background:#3a3a3a; border-color:#888 }
  .key { display:flex; align-items:center; gap:6px; margin:2px 0; font-size:11px }
  .sw { width:10px; height:10px; flex:none; border-radius:2px }
  #hover { position:fixed; pointer-events:none; background:#000d; border:1px solid #555; padding:5px 8px; max-width:340px; display:none; font-size:11px }
</style>
<header>
  <h1>${a.works.toLocaleString()} works from three museums, placed by metadata only &mdash; no model, no pixels read</h1>
  <div class="verdict">${verdict}<br>
    <span style="color:#999">${p.k}-neighbourhoods over ${p.n} works: ${p.preserved.toFixed(3)} preserved, ${p.chance.toFixed(3)} by chance.
    The two axes hold ${(((a.varianceExplained[0] ?? 0) + (a.varianceExplained[1] ?? 0)) * 100).toFixed(1)}% of the variance in ${a.columns.length} columns, so most of the spread is not on this page at all.</span></div>
  <div class="cols">
    ${a.loadings.map((axis) => `<div><b>axis ${axis[0]?.axis} is made of</b><br>${axis.slice(0, 5).map((l) => `${l.weight >= 0 ? '+' : '&minus;'}${Math.abs(l.weight).toFixed(2)} ${l.column}`).join('<br>')}</div>`).join('')}
  </div>
</header>
<main><canvas id="c"></canvas><aside><div id="controls"></div><div id="legend"></div></aside></main>
<div id="hover"></div>
<script>
const POINTS = ${JSON.stringify(points)};
const PALETTE = ${JSON.stringify(PALETTE)};
const FIELD = { source: 2, kind: 3, period: 4 };
let by = 'source';

const c = document.getElementById('c'), ctx = c.getContext('2d');
const hover = document.getElementById('hover');
let W = 0, H = 0, cats = [], colour = new Map();

// The categorical fields have long tails — 6,834 classifications — so only the commonest get a
// colour of their own and everything else is grey. A legend with 6,834 entries names nothing.
function recolour() {
  const f = FIELD[by], n = new Map();
  for (const p of POINTS) n.set(p[f], (n.get(p[f]) || 0) + 1);
  cats = [...n].sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length);
  colour = new Map(cats.map(([k], i) => [k, PALETTE[i]]));
  document.getElementById('legend').innerHTML = '<div style="margin:10px 0 4px;color:#999">' + by + '</div>' +
    cats.map(([k, v], i) => '<div class="key"><span class="sw" style="background:' + PALETTE[i] + '"></span>' + k + ' <span style="color:#777">' + v + '</span></div>').join('') +
    '<div class="key"><span class="sw" style="background:#444"></span>everything else</div>';
  draw();
}

let sx, sy, ox, oy;
function fit() {
  W = c.width = Math.max(400, innerWidth - 300);
  H = c.height = Math.max(300, innerHeight - 190);
  const xs = POINTS.map(p => p[0]), ys = POINTS.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 24;
  sx = (W - pad * 2) / (x1 - x0 || 1); sy = (H - pad * 2) / (y1 - y0 || 1);
  ox = pad - x0 * sx; oy = pad - y0 * sy;
}
const px = p => p[0] * sx + ox, py = p => H - (p[1] * sy + oy);

function draw() {
  ctx.clearRect(0, 0, W, H);
  const f = FIELD[by];
  // Painted with alpha rather than solid: 20,000 points on 900 pixels overlap heavily, and opaque
  // dots would show only whichever category happened to be drawn last.
  ctx.globalAlpha = 0.55;
  for (const p of POINTS) {
    ctx.fillStyle = colour.get(p[f]) || '#444';
    ctx.fillRect(px(p) - 1.2, py(p) - 1.2, 2.4, 2.4);
  }
  ctx.globalAlpha = 1;
}

c.addEventListener('mousemove', e => {
  const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  let best = null, bd = 64;
  for (const p of POINTS) {
    const d = (px(p) - mx) ** 2 + (py(p) - my) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) { hover.style.display = 'none'; return; }
  hover.style.display = 'block';
  hover.style.left = (e.clientX + 14) + 'px';
  hover.style.top = (e.clientY + 14) + 'px';
  hover.textContent = best[6] + ' — ' + best[5] + '  [' + best[3] + ', ' + best[4] + ']';
});
c.addEventListener('mouseleave', () => hover.style.display = 'none');

document.getElementById('controls').innerHTML = 'colour by ' + Object.keys(FIELD)
  .map(k => '<button data-by="' + k + '" aria-pressed="' + (k === by) + '">' + k + '</button>').join('');
document.getElementById('controls').onclick = e => {
  if (!e.target.dataset.by) return;
  by = e.target.dataset.by;
  for (const b of document.querySelectorAll('#controls button')) b.setAttribute('aria-pressed', b.dataset.by === by);
  recolour();
};
addEventListener('resize', () => { fit(); draw(); });
fit(); recolour();
</script>
<!-- generated ${generatedAt} -->
`;
}
