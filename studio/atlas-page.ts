// One self-contained HTML file showing the corpus laid out, for a reader with no terminal.
//
// A file and not a served page, because the person this is for cannot run a command: they open it.
// A file and not a notebook, because there is no jupyter, numpy or matplotlib on this machine, and a
// notebook that cannot be executed is a picture of an analysis rather than one.
//
// The panel leads with what the layout is *made of* and whether it beats chance, above the plot
// rather than beneath it. That ordering is the entire point. A scatter plot is read in a second and
// its caveats are read never, so the caveat goes where the eye lands first.

import { STABILITY_BAND, type Atlas, type Stability } from '../artist/atlas.js';
import type { Overlay } from '../artist/overlay.js';

/** One colour and radius per landmark kind. Fixed, so two overlay pages can be compared. */
const MARK: Record<string, { fill: string; r: number }> = {
  influence: { fill: '#f58231', r: 3.0 },
  extreme: { fill: '#ffd8b1', r: 4.5 },
  sketch: { fill: '#42d4f4', r: 3.4 },
  final: { fill: '#e6194b', r: 6.5 },
};

/** Colour by the label, stable across renders: the same category is the same colour every time. */
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9'];

export interface PageOptions {
  /**
   * What the layout was computed from, in the reader's words. Passed in rather than inferred,
   * because the headline is the one line everyone reads, and "placed by metadata only, no pixels
   * read" printed over a map of image embeddings would be a lie told in the largest type.
   */
  basis?: string;
  /** The other map, if it has been built. Omitted rather than rendered dead when it has not. */
  alsoSee?: { href: string; label: string };
  /**
   * Things that are not corpus works, placed on the corpus's coordinates without refitting them.
   * When present the corpus is drawn grey and dim by default, because the overlay is the subject
   * and 19,791 coloured dots underneath it are not a background, they are camouflage.
   */
  overlay?: Overlay;
}

/**
 * The overlay's own honesty block, under the plot.
 *
 * Under and not over, unlike the corpus verdict — because the corpus verdict is about whether the
 * picture may be read at all, and this is about how much to trust the handful of points added to a
 * picture that has already been vouched for. The row whose k equals the placement's own k is marked
 * in the table itself rather than in a paragraph beneath it; it is not circular (see `overlay.ts`),
 * it is the row that shows the placement is not where its own neighbours are.
 *
 * The recall figure is not printed here. It arrives as a note from `overlay.ts` with the paragraph
 * that explains it, and a bare percentage repeated above that paragraph invites reading it as a
 * quality score.
 */
function overlayFooter(o: Overlay): string {
  const rows = o.fidelity
    .map(
      (f) =>
        `<tr><td>k=${f.k}</td><td>${f.preserved.toFixed(4)}</td><td>${f.chance.toFixed(4)}</td>` +
        `<td>${(f.preserved / (f.chance || 1)).toFixed(1)}x</td>` +
        `<td style="color:#888">${f.wider ? '' : 'the k the placement used'}</td></tr>`,
    )
    .join('');
  const anchor = o.anchoring
    ? `<p>The placed points sit at mean cosine <b>${o.anchoring.meanCosine.toFixed(4)}</b> to the 20 corpus works each
       was placed from (range ${o.anchoring.minCosine.toFixed(4)}&ndash;${o.anchoring.maxCosine.toFixed(4)}). The weights
       across those 20 differ by only <b>${o.anchoring.weightSpread.toFixed(3)}x</b>, so each placement is very nearly
       the plain centroid of its twenty neighbours rather than a weighted pull toward the nearest.</p>`
    : '';
  return `<section id="footer">
  <h2>${o.caption}</h2>
  <p>The map was <b>not refitted</b>. The 2D coordinates of every corpus work are exactly the ones on the
     corpus's own page; each added point sits at the cosine-weighted average of the coordinates of its 20
     nearest corpus works in the full 512-d space. Refitting would have moved the corpus to accommodate
     the plates, and a cluster that a plate created would be indistinguishable from one it landed in.</p>
  <table><tr><th>neighbourhood</th><th>preserved</th><th>chance</th><th></th><th></th></tr>${rows}</table>
  ${anchor}
  ${o.notes.map((n) => `<p class="note">${n}</p>`).join('')}
</section>`;
}

/**
 * What six fits of the same input agreed on, printed beside the plot rather than assumed.
 *
 * The page has always carried the sentence "the gap between two clusters here means nothing".
 * That was received wisdom about UMAP, correctly stated and never checked on this data. When the
 * atlas was built with `--stability` it has been checked, and the sentence is replaced by the
 * measurement — including in the case where the measurement disagrees with the wisdom.
 */
function stabilityBlock(s: Stability): string {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const worstSeed = s.seedPairs.reduce((m, p) => Math.min(m, p.neighbourAgreement), 1);
  const worstRho = s.seedPairs.reduce((m, p) => Math.min(m, p.distanceRho), 1);
  const worstParam = s.paramPairs.reduce((m, p) => Math.min(m, p.neighbourAgreement), 1);
  const ok = worstSeed >= STABILITY_BAND;
  return `<div class="verdict" style="border-left-color:${ok ? '#3cb44b' : '#e6194b'}">
    ${
      ok
        ? `Two seeds keep <b>${pct(worstSeed)}</b> of each point's ${s.k} nearest, so togetherness on this map is about the works and not about the random start.`
        : `SEED-DEPENDENT. Two seeds keep only <b>${pct(worstSeed)}</b> of each point's ${s.k} nearest. Name no cluster from this map.`
    }<br>
    <span style="color:#999">Measured over ${s.runs.length} fits of the same ${s.n.toLocaleString()} points, not assumed.
    Pairwise distances correlate at rho <b>${worstRho.toFixed(2)}</b> across seeds &mdash;
    ${worstRho >= STABILITY_BAND ? 'relative distance carries some information' : 'the distance between two clusters here means nothing'}.
    Changing nNeighbors keeps ${pct(worstParam)} of neighbourhoods, so the parameter moves the picture
    ${worstParam < worstSeed ? 'more' : 'less'} than the seed does.
    Preserved across fits: ${s.preservedMean.toFixed(3)} &plusmn; ${s.preservedSd.toFixed(3)}.
    These fits are over the same stride sample the verdict above uses; the plotted map is fitted on every work.</span></div>`;
}

export function atlasPage(a: Atlas, generatedAt: string, opts: PageOptions = {}): string {
  const o = opts.overlay;
  const marks = (o?.landmarks ?? []).map((l) => [
    Number(l.x.toFixed(3)),
    Number(l.y.toFixed(3)),
    l.kind,
    l.label,
    l.detail,
    Number(l.weight.toFixed(3)),
    l.step,
  ]);
  const basis = opts.basis ?? 'metadata only &mdash; no model, no pixels read';
  // Only the columns the page draws with. The full record stays in atlas.json; duplicating it here
  // would triple the file for fields nothing on the page reads.
  const points = a.points.map((p) => [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), p.source, p.kind, p.period, p.title, p.id]);
  const p = a.preservation;
  // A decimal below ten, because "chance 0%" beside "same kind 4%" reads as a broken measurement
  // when the true baseline is 0.3% and the effect is the largest one on the page at 11.6x.
  const pct = (x: number) => `${(100 * x).toFixed(100 * x < 10 ? 1 : 0)}%`;
  const ratio = p.preserved / (p.chance || 1);
  const verdict = p.informative
    ? `Neighbourhoods on this map are real: ${ratio.toFixed(1)}x what scattering the same ${p.n} points at random would give.`
    : `NOTHING MEASURED. At ${ratio.toFixed(1)}x chance this layout is decoration. Do not read clusters off it.`;

  return `<!doctype html>
<meta charset="utf-8">
<title>the corpus, laid out by ${a.projection.toUpperCase()}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; background:#111; color:#ddd; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
  header { padding:14px 18px; border-bottom:1px solid #333 }
  h1 { font-size:15px; margin:0 0 6px; font-weight:600 }
  .also { float:right; font-weight:400; background:#222; color:#ddd; border:1px solid #444; padding:3px 10px; text-decoration:none }
  .also:hover { background:#3a3a3a; border-color:#888 }
  .verdict { padding:8px 12px; border-left:3px solid ${p.informative ? '#3cb44b' : '#e6194b'}; background:#1a1a1a; margin:8px 0 }
  .cols { display:flex; gap:26px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:#999 }
  .cols b { color:#ddd; font-weight:600 }
  .cols div { max-width:320px }
  main { display:flex }
  canvas { background:#0b0b0b; cursor:crosshair; touch-action:none }
  canvas.dragging { cursor:grabbing }
  #view { margin-top:8px; color:#888; font-size:11px }
  aside { width:270px; padding:12px 14px; border-left:1px solid #333; height:calc(100vh - 190px); overflow:auto }
  button { background:#222; color:#ddd; border:1px solid #444; padding:4px 9px; margin:0 4px 4px 0; cursor:pointer; font:inherit }
  button[aria-pressed=true] { background:#3a3a3a; border-color:#888 }
  .key { display:flex; align-items:center; gap:6px; margin:2px 0; font-size:11px }
  .sw { width:10px; height:10px; flex:none; border-radius:2px }
  #hover { position:fixed; pointer-events:none; background:#000d; border:1px solid #555; padding:5px 8px; max-width:380px; display:none; font-size:11px; white-space:pre-line }
  #footer { padding:14px 18px; border-top:1px solid #333; max-width:860px }
  #footer h2 { font-size:14px; margin:0 0 8px }
  #footer p { color:#aaa; margin:8px 0 }
  #footer .note { border-left:3px solid #e6194b; background:#1a1a1a; padding:8px 12px; color:#ddd }
  #footer table { border-collapse:collapse; margin:10px 0; font-size:12px }
  #footer td, #footer th { padding:2px 14px 2px 0; text-align:left; font-weight:400; color:#ccc }
  #footer th { color:#888 }
</style>
<header>
  <h1>${a.works.toLocaleString()} works from three museums, placed by ${basis}
    ${opts.alsoSee ? `<a class="also" href="${opts.alsoSee.href}">${opts.alsoSee.label} &rarr;</a>` : ''}</h1>
  <div class="verdict">${verdict}<br>
    <span style="color:#999">${p.k}-neighbourhoods over ${p.n} works: ${p.preserved.toFixed(3)} preserved, ${p.chance.toFixed(3)} by chance.
    ${
      a.projection === 'umap'
        ? `Projected with UMAP over ${a.columns.length} columns, which keeps neighbourhoods and does not keep distance: ${a.stability ? 'how much of either survived a change of seed is measured below.' : 'the gap between two clusters here means nothing, and only which points sit together does.'}`
        : `The two axes hold ${(((a.varianceExplained[0] ?? 0) + (a.varianceExplained[1] ?? 0)) * 100).toFixed(1)}% of the variance in ${a.columns.length} columns, so most of the spread is not on this page at all.`
    }</span></div>
  ${a.stability ? stabilityBlock(a.stability) : ''}
  <div class="cols">
    ${
      // Only under PCA. The loadings describe the principal axes, and under UMAP the axes on this
      // page are not those — printing them beside a UMAP plot would label the wrong thing.
      a.projection === 'pca'
        ? a.loadings.map((axis) => `<div><b>axis ${axis[0]?.axis} is made of</b><br>${axis.slice(0, 5).map((l) => `${l.weight >= 0 ? '+' : '&minus;'}${Math.abs(l.weight).toFixed(2)} ${l.column}`).join('<br>')}</div>`).join('')
        : '<div><b>the axes are made of nothing</b><br>UMAP has no loadings. Neither direction on this page is a quantity; only togetherness is.</div>'
    }
    <div><b>its ${p.k} nearest, in the full space</b><br>${a.composition.map((c) => `${c.field} ${pct(c.share)} <span style="color:#888">(chance ${pct(c.chance)}, ${c.chance > 0 ? `${(c.share / c.chance).toFixed(1)}x` : '&mdash;'})</span>`).join('<br>')}</div>
  </div>
</header>
<main><canvas id="c"></canvas><aside><div id="controls"></div><div id="legend"></div></aside></main>
${o ? overlayFooter(o) : ''}
<div id="hover"></div>
<script>
const POINTS = ${JSON.stringify(points)};
const LANDMARKS = ${JSON.stringify(marks)};
const MARK = ${JSON.stringify(MARK)};
const PALETTE = ${JSON.stringify(PALETTE)};
const FIELD = { source: 2, kind: 3, period: 4 };
let by = 'source';
// With an overlay the corpus is background. Coloured is still one button away, because "is that
// cluster the Met" is the first question anyone asks and the answer should not need a rerun.
let dim = LANDMARKS.length > 0;

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
  const overlayKey = LANDMARKS.length
    ? '<div style="margin:14px 0 4px;color:#999">laid over the map</div>' +
      Object.keys(MARK).filter(k => LANDMARKS.some(l => l[2] === k)).map(k =>
        '<div class="key"><span class="sw" style="border-radius:50%;background:' + MARK[k].fill + '"></span>' + k +
        ' <span style="color:#777">' + LANDMARKS.filter(l => l[2] === k).length + '</span></div>').join('')
    : '';
  document.getElementById('legend').innerHTML = '<div style="margin:10px 0 4px;color:#999">' + by + '</div>' +
    cats.map(([k, v], i) => '<div class="key"><span class="sw" style="background:' + PALETTE[i] + '"></span>' + k + ' <span style="color:#777">' + v + '</span></div>').join('') +
    '<div class="key"><span class="sw" style="background:#444"></span>everything else</div>' + overlayKey;
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

// The view. fit() puts the whole corpus on the canvas once; this rides on top of it, so resizing
// the window never loses where the reader had navigated to.
//
// Dot RADIUS is deliberately NOT scaled by zoom. 20,000 points on 900 pixels overlap so heavily
// that at 1x a dot is mostly other dots; growing the dots with the zoom would keep that overlap at
// every magnification and the reader would never get to see individual works, which is the only
// reason to zoom in at all.
const MAX_ZOOM = 60, MIN_ZOOM = 1;
let zoom = 1, panX = 0, panY = 0;
const bx = p => p[0] * sx + ox, byy = p => H - (p[1] * sy + oy);
const px = p => bx(p) * zoom + panX, py = p => byy(p) * zoom + panY;

function clampPan() {
  // Never let the plot be dragged entirely off the canvas: at zoom 1 it is pinned, and beyond that
  // the reader may pan within the magnified image and no further.
  const lo = W - W * zoom, hi = 0;
  panX = Math.min(hi, Math.max(lo, panX));
  panY = Math.min(hi, Math.max(H - H * zoom, panY));
}

function setZoom(next, cx, cy) {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  if (z === zoom) return;
  // Hold the point under the cursor still: it is the only zoom that feels like a magnifier.
  panX = cx - ((cx - panX) / zoom) * z;
  panY = cy - ((cy - panY) / zoom) * z;
  zoom = z;
  clampPan();
  showView();
  draw();
}

function showView() {
  const v = document.getElementById('view');
  if (v) v.textContent = zoom > 1.001 ? 'zoom ' + zoom.toFixed(1) + 'x — drag to pan, double-click to reset' : 'scroll to zoom, drag to pan';
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  const f = FIELD[by];
  // Painted with alpha rather than solid: 20,000 points on 900 pixels overlap heavily, and opaque
  // dots would show only whichever category happened to be drawn last.
  ctx.globalAlpha = dim ? 0.30 : 0.55;
  for (const p of POINTS) {
    ctx.fillStyle = dim ? '#555' : (colour.get(p[f]) || '#444');
    ctx.fillRect(px(p) - 1.2, py(p) - 1.2, 2.4, 2.4);
  }
  ctx.globalAlpha = 1;
  drawLandmarks();
}

// Any landmark carrying a step number, in step order. Empty today — no run has ever persisted a
// plate per MAKE step — so nothing is joined up, and the footer says why rather than the page
// drawing a line through points that were never a sequence.
function pathOf() {
  return LANDMARKS.filter(l => l[6] !== null && (l[2] === 'sketch' || l[2] === 'final'))
    .sort((a, b) => a[6] - b[6]);
}

function drawLandmarks() {
  if (!LANDMARKS.length) return;
  const path = pathOf();
  if (path.length >= 2) {
    ctx.strokeStyle = '#e6194b'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8;
    ctx.beginPath();
    path.forEach((l, i) => i ? ctx.lineTo(px(l), py(l)) : ctx.moveTo(px(l), py(l)));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Influences first, then extremes, then plates: later is on top, and the plates are the subject.
  for (const kind of ['influence', 'extreme', 'sketch', 'final']) {
    const m = MARK[kind];
    for (const l of LANDMARKS) {
      if (l[2] !== kind) continue;
      // Weight only scales influence dots. A sketch has no weight and drawing one would invent it.
      const r = kind === 'influence' ? m.r * (0.55 + 0.9 * Math.min(1, l[5])) : m.r;
      ctx.beginPath();
      ctx.arc(px(l), py(l), r, 0, 6.2832);
      ctx.fillStyle = m.fill; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
      if (l[3]) {
        ctx.fillStyle = '#fff'; ctx.font = '10px ui-monospace,monospace';
        ctx.fillText(l[3], px(l) + r + 3, py(l) + 3);
      }
    }
  }
}

let drag = null;
c.addEventListener('wheel', e => {
  e.preventDefault();
  const r = c.getBoundingClientRect();
  setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
c.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  c.classList.add('dragging');
  c.setPointerCapture(e.pointerId);
});
const endDrag = e => {
  if (!drag) return;
  drag = null;
  c.classList.remove('dragging');
  if (e && e.pointerId !== undefined && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
};
c.addEventListener('pointerup', endDrag);
c.addEventListener('pointercancel', endDrag);
c.addEventListener('dblclick', () => { zoom = 1; panX = 0; panY = 0; showView(); draw(); });

c.addEventListener('mousemove', e => {
  const r = c.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (drag) {
    panX += e.clientX - drag.x;
    panY += e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved = true;
    clampPan();
    hover.style.display = 'none';
    draw();
    return;
  }
  // Landmarks win ties over corpus points, and over a wider radius: they are what the page is for,
  // and there is a corpus dot within two pixels of almost everything.
  let best = null, bd = 196;
  for (const l of LANDMARKS) {
    const d = (px(l) - mx) ** 2 + (py(l) - my) ** 2;
    if (d < bd) { bd = d; best = l[4]; }
  }
  if (best === null) {
    bd = 64;
    for (const p of POINTS) {
      const d = (px(p) - mx) ** 2 + (py(p) - my) ** 2;
      if (d < bd) { bd = d; best = p[6] + ' — ' + p[5] + '  [' + p[3] + ', ' + p[4] + ']'; }
    }
  }
  if (best === null) { hover.style.display = 'none'; return; }
  hover.style.display = 'block';
  hover.style.left = (e.clientX + 14) + 'px';
  hover.style.top = (e.clientY + 14) + 'px';
  hover.textContent = best;
});
c.addEventListener('mouseleave', () => hover.style.display = 'none');

document.getElementById('controls').innerHTML = 'colour by ' + Object.keys(FIELD)
  .map(k => '<button data-by="' + k + '" aria-pressed="' + (k === by) + '">' + k + '</button>').join('')
  + (LANDMARKS.length ? '<div style="margin-top:8px">corpus <button id="dim" aria-pressed="' + dim + '">grey</button></div>' : '')
  + '<div style="margin-top:8px"><button id="zin">zoom +</button><button id="zout">zoom &minus;</button><button id="zreset">reset</button></div>'
  + '<div id="view"></div>';
document.getElementById('controls').onclick = e => {
  if (e.target.id === 'zin' || e.target.id === 'zout') {
    setZoom(zoom * (e.target.id === 'zin' ? 1.6 : 1 / 1.6), W / 2, H / 2);
    return;
  }
  if (e.target.id === 'zreset') { zoom = 1; panX = 0; panY = 0; showView(); draw(); return; }
  if (e.target.id === 'dim') {
    dim = !dim;
    e.target.setAttribute('aria-pressed', dim);
    e.target.textContent = dim ? 'grey' : 'coloured';
    draw();
    return;
  }
  if (!e.target.dataset.by) return;
  by = e.target.dataset.by;
  for (const b of document.querySelectorAll('#controls button[data-by]')) b.setAttribute('aria-pressed', b.dataset.by === by);
  recolour();
};
addEventListener('resize', () => { fit(); clampPan(); draw(); });
fit(); showView(); recolour();
</script>
<!-- generated ${generatedAt} -->
`;
}
