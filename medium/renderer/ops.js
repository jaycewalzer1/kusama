// The seven primitive operators. Browser only.
//
// Substream discipline (build document section 5.3). Every operator declares which named stream it
// draws each kind of randomness from, and reseeds at the start of that use:
//
//   placement  positions we choose ourselves: field-mark sample points.
//   geometry   shape geometry we generate ourselves: clip intersection is deterministic, so this is
//              currently used only by `paint` with a `field` style, for per-mark angles.
//   texture    everything p5.brush randomises internally once we hand it a shape: watercolour bleed,
//              hatch `rand`, brush stamp scatter and pressure.
//   misc       seeded once per leaf before the operator runs, so an operator that uses no randomness
//              still leaves the generators in a node-determined state.
//
// A node's seeds never depend on its arguments, its position in the tree, or its siblings, so
// changing a placement argument cannot reshuffle the texture, and moving a node cannot change its
// marks at all.

import { regionPolygon, fragmentPolygon, clipPolygon, clipPolyline, pointInPolygon, CLIP_CIRCLE_SEGMENTS } from './resolve.js';

/** Hand-drawn wobble handed to brush.circle. Fixed on purpose: not a program-level decision. */
export const CIRCLE_IRREGULARITY = 0.12;

export const OPS = {
  wash: opPaint, // `wash` is `paint` with a wash style; kept as its own op for readability
  paint: opPaint,
  stroke: opStroke,
  fragment: opFragment,
  text: opText,
  rule: opRule,
  cover: opCover,
};

// --- shape helpers ---------------------------------------------------------------------------------

function brushPolygon(brush, pts, closed = true) {
  if (pts.length < 3) return;
  brush.beginShape(0);
  for (const [x, y] of pts) brush.vertex(x, y);
  brush.endShape(closed);
}

function p5Polygon(p, pts) {
  if (pts.length < 3) return;
  p.beginShape();
  for (const [x, y] of pts) p.vertex(x, y);
  p.endShape(p.CLOSE);
}

/**
 * Draw a region with the current brush state. Without a clip we hand p5.brush its own primitives
 * (rect/circle keep their hand-drawn character); under a clip we must intersect geometry ourselves,
 * so circles become a fixed 64-gon first. See NOTES L1.
 */
function drawRegion(p, brush, region, ctx, native) {
  const clip = ctx.clip;
  if (!clip) {
    if (region.type === 'rect') return native ? p.rect(region.x, region.y, region.w, region.h) : brush.rect(region.x, region.y, region.w, region.h);
    if (region.type === 'circle') {
      return native
        ? p.ellipse(region.cx, region.cy, region.r * 2, region.r * 2)
        : brush.circle(region.cx, region.cy, region.r, CIRCLE_IRREGULARITY);
    }
    const pts = regionPolygon(region, ctx.pack);
    return native ? p5Polygon(p, pts) : brushPolygon(brush, pts);
  }
  const pts = clipPolygon(regionPolygon(region, ctx.pack, CLIP_CIRCLE_SEGMENTS), clip);
  if (pts.length < 3) return undefined;
  return native ? p5Polygon(p, pts) : brushPolygon(brush, pts);
}

// --- style application -----------------------------------------------------------------------------

function applyStyle(p, brush, style, stream) {
  switch (style.kind) {
    case 'wash':
      stream('texture');
      brush.fill(style.color, style.opacity);
      brush.fillBleed(style.bleed, 'out');
      brush.fillTexture(style.texture[0], style.texture[1]);
      return 'brush';
    case 'hatch':
      stream('texture');
      brush.hatchStyle(style.brush, style.color, 1);
      brush.hatch(style.spacing, style.angle, { rand: style.rand, continuous: style.continuous ?? false });
      return 'brush';
    case 'outline':
      stream('texture');
      brush.set(style.brush, style.color, style.weight);
      return 'brush';
    case 'solid':
      p.fill(hexWithAlpha(p, style.color, style.opacity));
      p.noStroke();
      return 'native';
    case 'field':
      return 'field';
    default:
      throw new Error(`unknown paint style "${style.kind}"`);
  }
}

function hexWithAlpha(p, hex, opacity) {
  const c = p.color(hex);
  c.setAlpha(opacity);
  return c;
}

// --- paint / wash -----------------------------------------------------------------------------------

function opPaint(p, brush, node, ctx, stream) {
  const { region, style } = node.args;
  if (style.kind === 'field') return paintField(p, brush, region, style, ctx, stream);

  const mode = applyStyle(p, brush, style, stream);
  if (mode === 'native') {
    drawRegion(p, brush, region, ctx, true);
    return;
  }
  drawRegion(p, brush, region, ctx, false);
  if (style.kind === 'hatch' && style.layers === 2) {
    stream('texture');
    brush.hatchStyle(style.brush, style.color, 1);
    brush.hatch(style.spacing, style.angle + 90, { rand: style.rand, continuous: style.continuous ?? false });
    drawRegion(p, brush, region, ctx, false);
  }
}

/**
 * `field` style: scattered directional marks inside the region. Positions come from `placement`,
 * per-mark angle jitter from `geometry`, and the brush's own stamp randomness from `texture`.
 */
function paintField(p, brush, region, style, ctx, stream) {
  const poly = regionPolygon(region, ctx.pack, CLIP_CIRCLE_SEGMENTS);
  const area = polyBounds(poly);
  const count = Math.max(1, Math.round(style.density * (area.w * area.h) / 1000));
  const place = stream('placement');
  const points = [];
  for (let i = 0; i < count * 3 && points.length < count; i++) {
    const pt = [area.x + place.next() * area.w, area.y + place.next() * area.h];
    if (!pointInPolygon(pt, poly)) continue;
    if (ctx.clip && !pointInPolygon(pt, ctx.clip)) continue;
    points.push(pt);
  }
  const geo = stream('geometry');
  const angles = points.map(() => style.angle + (geo.next() * 2 - 1) * style.jitter);
  stream('texture');
  brush.set(style.brush, style.color, 1);
  points.forEach(([x, y], i) => {
    const a = (angles[i] * Math.PI) / 180;
    const dx = Math.cos(a) * style.length;
    const dy = Math.sin(a) * style.length;
    if (style.marks === 'dots') {
      brush.line(x, y, x + 0.4, y + 0.4);
    } else if (style.marks === 'dashes') {
      brush.line(x - dx / 2, y - dy / 2, x + dx / 2, y + dy / 2);
    } else {
      brush.beginShape(0.6);
      brush.vertex(x - dx / 2, y - dy / 2);
      brush.vertex(x + dy / 3, y - dx / 3);
      brush.vertex(x + dx / 2, y + dy / 2);
      brush.endShape(false);
    }
  });
}

function polyBounds(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// --- fragment -----------------------------------------------------------------------------------------

function opFragment(p, brush, node, ctx, stream) {
  const a = node.args;
  const pts = fragmentPolygon(a, ctx.pack);
  const region = { type: 'polygon', points: ctx.clip ? clipPolygon(pts, ctx.clip) : pts };
  if (region.points.length < 3) return;
  if (a.style.kind === 'field') return paintField(p, brush, region, a.style, { ...ctx, clip: null }, stream);
  const mode = applyStyle(p, brush, a.style, stream);
  if (mode === 'native') p5Polygon(p, region.points);
  else brushPolygon(brush, region.points);
  if (a.style.kind === 'hatch' && a.style.layers === 2) {
    stream('texture');
    brush.hatchStyle(a.style.brush, a.style.color, 1);
    brush.hatch(a.style.spacing, a.style.angle + 90, { rand: a.style.rand, continuous: a.style.continuous ?? false });
    brushPolygon(brush, region.points);
  }
}

// --- stroke / rule ------------------------------------------------------------------------------------

function opStroke(p, brush, node, ctx, stream) {
  const a = node.args;
  stream('texture');
  brush.set(a.brush, a.color, a.weight);
  const paths = ctx.clip ? clipPolyline(a.closed ? [...a.points, a.points[0]] : a.points, ctx.clip) : [a.closed ? [...a.points, a.points[0]] : a.points];
  for (const path of paths) {
    if (path.length < 2) continue;
    brush.beginShape(a.curve ?? 0);
    for (const [x, y] of path) brush.vertex(x, y);
    brush.endShape(false);
  }
}

function opRule(p, brush, node, ctx, stream) {
  const a = node.args;
  stream('texture');
  brush.set(a.brush, a.color, a.weight);
  const paths = ctx.clip ? clipPolyline([a.from, a.to], ctx.clip) : [[a.from, a.to]];
  for (const path of paths) {
    if (path.length < 2) continue;
    brush.line(path[0][0], path[0][1], path[path.length - 1][0], path[path.length - 1][1]);
  }
}

// --- cover ---------------------------------------------------------------------------------------------

/** Nested copies used to fade a soft-edged cover. Fixed on purpose: not a program-level decision. */
export const COVER_LAYERS = 6;

/**
 * `cover` paints the ground back over a region: the one way to take something away.
 *
 * It deliberately does not go through `brush.fill`. p5.brush mixes pigment through its own blend
 * shader rather than compositing source-over, so light paint over dark paint muddies it instead of
 * hiding it -- measured, a full-opacity `brush.fill(ground)` over solid teal moved the pixel only
 * about an eighth of the way to the ground colour. Plain p5 `fill()` restores the ground exactly.
 * See NOTES L4.
 *
 * `softness` is therefore a geometric soft edge: COVER_LAYERS nested copies of the region, scaled
 * about its centre from (1 + s/2) down to (1 - s/2), each more opaque than the last. The core is
 * painted by every layer and ends up exactly the ground colour; the outer band is painted by only
 * the faintest of them, so the edge fades out.
 */
function opCover(p, brush, node, ctx) {
  const a = node.args;
  const region = regionPolygon(a.region, ctx.pack, CLIP_CIRCLE_SEGMENTS);
  const base = ctx.clip ? clipPolygon(region, ctx.clip) : region;
  if (base.length < 3) return;
  const b = polyBounds(base);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const layers = a.softness > 0 ? COVER_LAYERS : 1;
  p.noStroke();
  for (let i = 0; i < layers; i++) {
    const k = 1 + a.softness * (0.5 - i / Math.max(1, layers - 1));
    p.fill(hexWithAlpha(p, ctx.ground, Math.round((255 * (i + 1)) / layers)));
    p5Polygon(p, base.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]));
  }
}

// --- text ------------------------------------------------------------------------------------------------

function opText(p, brush, node, ctx) {
  const a = node.args;
  const font = ctx.fonts[a.font];
  if (!font) throw new Error(`font "${a.font}" is not loaded`);
  p.textFont(font);
  p.textSize(a.size);
  p.fill(a.color);
  p.noStroke();
  p.textAlign(p.LEFT, p.BASELINE);
  const lines = a.maxWidth ? wrapLines(p, a.text, a.maxWidth, a.tracking ?? 0) : [a.text];
  lines.forEach((line, i) => {
    const y = a.y + i * a.size * 1.25;
    const w = lineWidth(p, line, a.tracking ?? 0);
    const x = a.align === 'center' ? a.x - w / 2 : a.align === 'right' ? a.x - w : a.x;
    drawTracked(p, line, x, y, a.tracking ?? 0);
  });
}

function lineWidth(p, text, tracking) {
  let w = 0;
  for (const ch of text) w += p.textWidth(ch) + tracking;
  return w - (text.length ? tracking : 0);
}

function drawTracked(p, text, x, y, tracking) {
  if (!tracking) {
    p.text(text, x, y);
    return;
  }
  let cx = x;
  for (const ch of text) {
    p.text(ch, cx, y);
    cx += p.textWidth(ch) + tracking;
  }
}

function wrapLines(p, text, maxWidth, tracking) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (lineWidth(p, next, tracking) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
