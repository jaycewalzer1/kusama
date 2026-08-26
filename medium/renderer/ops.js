// The eight primitive operators. Browser only.
//
// Substream discipline (build document section 5.3). Every operator declares which named stream it
// draws each kind of randomness from, and reseeds at the start of that use:
//
//   placement  positions we choose ourselves: field-mark sample points.
//   geometry   shape geometry we generate ourselves: per-mark angles for `paint` with a `field`
//              style, and the deckle of a torn fragment edge.
//   texture    everything p5.brush randomises internally once we hand it a shape: watercolour bleed,
//              hatch `rand`, brush stamp scatter and pressure.
//   glyph      per-glyph text jitter, kept apart from `texture` so that giving a line of type a shake
//              cannot move a single mark anywhere else in the program.
//   misc       seeded once per leaf before the operator runs, so an operator that uses no randomness
//              still leaves the generators in a node-determined state.
//
// A node's seeds never depend on its arguments, its position in the tree, or its siblings, so
// changing a placement argument cannot reshuffle the texture, and moving a node cannot change its
// marks at all.

import { regionPolygon, fragmentPolygon, tearPolygon, clipPolygon, clipPolyline, pointInPolygon, sprayParticleCount, CLIP_CIRCLE_SEGMENTS, DRIP_STEP } from './resolve.js';

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
  spray: opSpray,
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
  let pts = fragmentPolygon(a, ctx.pack);
  // Tear before clipping, so a torn fragment inside a clip is a torn edge cropped by the clip, not a
  // clean edge that grew teeth after the crop. The tear draws from this node's own geometry stream.
  if (a.tear) {
    const geo = stream('geometry');
    pts = tearPolygon(pts, a.tear, () => geo.next());
  }
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

// --- spray ---------------------------------------------------------------------------------------------

/**
 * A seeded particle spray: an aerosol can, not a brush.
 *
 * Particles are sampled in polar coordinates about the anchor. `r = radius * u^(falloff/2)` is the
 * inverse CDF of a density that goes as `(r/radius)^(2/falloff - 2)`, which makes `falloff: 1`
 * exactly a uniform disc -- the identity worth having, because it means the parameter has a
 * meaningful zero point rather than a taste-based default. Above 1 the cloud tightens to the centre
 * and the edge goes to overspray; below 1 it hollows out into a ring, which is what a can held too
 * close actually does.
 *
 * Drips are an exact `drip.count`, not a per-particle probability. The count has to be knowable in
 * Node for the same reason the particle count does, and "probability 0.05 of 226 particles" bounds
 * at 226 in the worst case, which is not a bound anyone can budget against. The drips are still
 * seeded random walks and still land wherever the spray happens to be thickest, because they start
 * from particle positions drawn from the same distribution in the same stream.
 *
 * Every particle is drawn as a degenerate `brush.line`, the same trick `paintField` uses for dots:
 * p5.brush has no dot call, and a zero-length line draws nothing at all.
 */
function opSpray(p, brush, node, ctx, stream) {
  const a = node.args;
  const n = sprayParticleCount(a);
  brush.set(a.brush, a.color, a.weight);

  // Placement and geometry are separate streams so that changing the drips cannot move a single
  // particle, and vice versa.
  const place = stream('placement');
  const pts = [];
  for (let i = 0; i < n; i++) {
    const theta = place.next() * Math.PI * 2;
    const rad = a.r * Math.pow(place.next(), a.falloff / 2);
    pts.push([a.x + Math.cos(theta) * rad, a.y + Math.sin(theta) * rad]);
  }

  stream('texture');
  for (const [x, y] of pts) {
    if (ctx.clip && !pointInPolygon(x, y, ctx.clip)) continue;
    brush.line(x, y, x + 0.4, y + 0.4);
  }

  const drip = a.drip;
  if (!drip || drip.count === 0 || n === 0) return;
  const geo = stream('geometry');
  const steps = Math.max(1, Math.round(drip.length / DRIP_STEP));
  for (let d = 0; d < drip.count; d++) {
    // Start from a particle rather than from a fresh sample, so a drip always begins somewhere the
    // spray actually reached.
    const start = pts[Math.min(n - 1, Math.floor(geo.next() * n))];
    let [x, y] = start;
    const walk = [[x, y]];
    for (let s = 0; s < steps; s++) {
      x += (geo.next() * 2 - 1) * drip.wander;
      y += DRIP_STEP;
      walk.push([x, y]);
    }
    const paths = ctx.clip ? clipPolyline(walk, ctx.clip) : [walk];
    for (const path of paths) {
      if (path.length < 2) continue;
      brush.beginShape(0);
      for (const [vx, vy] of path) brush.vertex(vx, vy);
      brush.endShape(false);
    }
  }
}

// --- text ------------------------------------------------------------------------------------------------

/**
 * Type. Everything past `tracking` is a transform of the same measured lines, applied around the
 * anchor (a.x, a.y) rather than around the canvas, so moving a text op moves its skew and rotation
 * with it. The stack is pushed scale, rotate, shear and therefore applies shear first, then rotate,
 * then stretch -- the order `textAnchorTransform` in resolve.js uses to bound the same box in Node.
 *
 * Glyph jitter draws its four numbers per glyph unconditionally, even when an amount is zero, so
 * that turning the rotation down does not reshuffle the offsets of every glyph after it.
 */
function opText(p, brush, node, ctx, stream) {
  const a = node.args;
  const font = ctx.fonts[a.font];
  if (!font) throw new Error(`font "${a.font}" is not loaded`);
  p.textFont(font);
  p.textSize(a.size);
  p.fill(a.color);
  p.noStroke();
  p.textAlign(p.LEFT, p.BASELINE);
  const tracking = a.tracking ?? 0;
  const body = a.case === 'upper' ? a.text.toUpperCase() : a.case === 'lower' ? a.text.toLowerCase() : a.text;
  // `jitter` is decided before the text is measured because it selects which of `drawTracked`'s two
  // paths will run, and the two do not measure the same (see `drawnWidth`).
  const jitter = a.jitter && (a.jitter.translate || a.jitter.rotate || a.jitter.scale) ? a.jitter : null;
  const lines = a.maxWidth ? wrapLines(p, body, a.maxWidth, tracking, jitter) : [body];
  const rng = jitter ? stream('glyph') : null;
  const [sx, sy] = a.stretch ?? [1, 1];

  p.push();
  p.translate(a.x, a.y);
  if (sx !== 1 || sy !== 1) p.scale(sx, sy);
  // Degrees, not radians: the sketch runs under angleMode(DEGREES) (renderer/page.js). Converting
  // first turned a nine-degree rotation into a sixth of a degree, which looks exactly like a
  // transform that was never applied at all.
  if (a.rotate) p.rotate(a.rotate);
  // p5's shearX is x += tan(k) * y, and y is down, so the sign is flipped to make a positive skew
  // lean the tops of the letters to the right the way an italic does.
  if (a.skew) p.shearX(-a.skew);
  lines.forEach((line, i) => {
    const y = i * a.size * (a.leading ?? 1.25);
    const w = drawnWidth(p, line, tracking, jitter);
    const x = a.align === 'center' ? -w / 2 : a.align === 'right' ? -w : 0;
    drawTracked(p, line, x, y, tracking, jitter, rng);
  });
  p.pop();
}

/**
 * How wide a space is, measured the only way that works here. `textWidth(' ')` returns exactly 0 in
 * this p5/WEBGL build -- a whitespace-only string is trimmed to nothing -- but a space *inside* a
 * string measures fine, so the advance is the difference between a string with one and a string
 * without. Measured at size 40 with anton: textWidth(' ') = 0, textWidth('n n') - textWidth('nn')
 * = 9.375, and textWidth('hello world') - textWidth('helloworld') = 9.375 exactly.
 *
 * Without this, every per-glyph path -- which is every tracked line, every jittered line, and the
 * measurement `maxWidth` wraps on -- silently deleted all word spacing, so `SET AND SETTING` set
 * itself as `SETANDSETTING` and a wrapped paragraph measured far narrower than it drew.
 */
function spaceWidth(p) {
  return p.textWidth('n n') - p.textWidth('nn');
}

function advance(p, ch, space) {
  return ch === ' ' ? space : p.textWidth(ch);
}

function lineWidth(p, text, tracking) {
  const space = spaceWidth(p);
  let w = 0;
  for (const ch of text) w += advance(p, ch, space) + tracking;
  return w - (text.length ? tracking : 0);
}

/**
 * How wide a line will be *as drawn*, which is not one question but two.
 *
 * `drawTracked` has two paths. An untracked, unjittered line is handed to p5 whole, so its width is
 * p5's own advance for the whole string. Any other line is placed glyph by glyph, so its width is
 * the sum of the parts plus the tracking between them. Those are not the same number, because
 * `textWidth` is not additive over a string -- E7 already found `textWidth('nn')` is not
 * `2 * textWidth('n')` in this build.
 *
 * The old code always used the per-glyph sum, which is right for a tracked or jittered line and
 * wrong for every other one. E7 fixed this class of mistake for spaces; this is the other half of
 * it, and the rule is E7's: measure the way you are about to draw.
 *
 * It has two symptoms, and the second is the one that cost the goldens. Both were measured rather
 * than argued, over the 14 committed programs that hold an untracked, unjittered text node:
 *
 *   Alignment -- one program. `x` is derived from the width only when `align` is not `left`, and
 *   for a single glyph the sum *is* the advance, so of the seven candidates six were byte-identical
 *   either way. The one real case, `examples/batch/v15.json`'s centred "pen 2B charcoal cpencil
 *   marker", moved dbef195f7ebb -> 8c405b761cf0: 2310 pixels, 0.241% of the sheet, one 319x14 band
 *   displaced 17px. Centred, so the width was wrong by 34px in 319 -- about 11%, roughly the
 *   kerning of a 28-character line.
 *
 *   Wrapping -- 31 nodes across 13 programs, and it does not need `align` at all. `wrapLines`
 *   breaks on this measurement, so an overestimate broke lines earlier than the drawn text needed,
 *   leaving `maxWidth` paragraphs narrower than they asked to be. This is why three left-aligned
 *   v1 goldens moved when a fix "about alignment" landed.
 *
 * None of the four v0 goldens moved, and that is not luck: all four track their centred lines, so
 * both sides of the comparison were already taking the per-glyph path.
 */
function drawnWidth(p, text, tracking, jitter) {
  return !tracking && !jitter ? p.textWidth(text) : lineWidth(p, text, tracking);
}

function drawTracked(p, text, x, y, tracking, jitter, rng) {
  if (!tracking && !jitter) {
    p.text(text, x, y);
    return;
  }
  const space = spaceWidth(p);
  let cx = x;
  for (const ch of text) {
    const w = advance(p, ch, space);
    if (!jitter) {
      p.text(ch, cx, y);
    } else {
      const dx = (rng.next() * 2 - 1) * (jitter.translate ?? 0);
      const dy = (rng.next() * 2 - 1) * (jitter.translate ?? 0);
      const rot = (rng.next() * 2 - 1) * (jitter.rotate ?? 0);
      const scale = 1 + (rng.next() * 2 - 1) * (jitter.scale ?? 0);
      p.push();
      p.translate(cx + w / 2 + dx, y + dy);
      if (rot) p.rotate(rot);
      if (scale !== 1) p.scale(scale);
      p.text(ch, -w / 2, 0);
      p.pop();
    }
    cx += w + tracking;
  }
}

function wrapLines(p, text, maxWidth, tracking, jitter) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (drawnWidth(p, next, tracking, jitter) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
