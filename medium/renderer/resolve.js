// program -> resolved tree: macros expanded, repeats unrolled, world transforms, clips, bounds,
// seeds. Runs in Node (so budgets are enforced before a browser is ever launched) and is pure.

import { fnv1a32, makeRng, deriveSeed, nodeSeed } from './rng.js';
import { expandMacro } from './macros.js';

export class ResolveError extends Error {}

// --- 2x3 affine matrices: [a,b,c,d,e,f] with x' = a*x + c*y + e, y' = b*x + d*y + f -------------

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function matMul(m, n) {
  // returns m applied after n (i.e. m * n)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function matInvert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) throw new ResolveError('non-invertible transform (scale 0?)');
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

/** Uniform scale factor of a matrix, used to scale stroke weights and bleed margins into canvas px. */
export function matScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/**
 * Local transform of a node: translate, then rotate, then scale (build document section 3).
 * Degrees, clockwise positive in screen space (y down).
 */
export function localMatrix(transform) {
  if (!transform) return IDENTITY;
  const [tx, ty] = transform.translate ?? [0, 0];
  const deg = transform.rotate ?? 0;
  const s = transform.scale ?? 1;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // T * R * S
  return [cos * s, sin * s, -sin * s, cos * s, tx, ty];
}

// --- convex polygon clipping (Sutherland-Hodgman) -----------------------------------------------

const EPS = 1e-9;

function insideEdge(p, a, b) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -EPS;
}

function edgeIntersect(p, q, a, b) {
  const r = [q[0] - p[0], q[1] - p[1]];
  const s = [b[0] - a[0], b[1] - a[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < EPS) return q.slice();
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / denom;
  return [p[0] + t * r[0], p[1] + t * r[1]];
}

/** Clip `subject` (any polygon) by `clip` (must be convex, counter-clockwise or clockwise). */
export function clipPolygon(subject, clip) {
  if (!clip || clip.length < 3) return subject;
  const oriented = polygonArea(clip) < 0 ? clip.slice().reverse() : clip;
  let out = subject;
  for (let i = 0; i < oriented.length && out.length; i++) {
    const a = oriented[i];
    const b = oriented[(i + 1) % oriented.length];
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = insideEdge(cur, a, b);
      const prevIn = insideEdge(prev, a, b);
      if (curIn) {
        if (!prevIn) out.push(edgeIntersect(prev, cur, a, b));
        out.push(cur);
      } else if (prevIn) {
        out.push(edgeIntersect(prev, cur, a, b));
      }
    }
  }
  return out;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Clip a polyline against a convex polygon. Returns an array of polylines. */
export function clipPolyline(points, clip) {
  if (!clip || clip.length < 3) return [points];
  const out = [];
  let run = [];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = clipSegment(points[i], points[i + 1], clip);
    if (!seg) {
      if (run.length > 1) out.push(run);
      run = [];
      continue;
    }
    const [a, b] = seg;
    if (run.length === 0) run.push(a);
    else if (dist2(run[run.length - 1], a) > 1e-6) {
      if (run.length > 1) out.push(run);
      run = [a];
    }
    run.push(b);
  }
  if (run.length > 1) out.push(run);
  return out;
}

function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/** Liang-Barsky style clip of one segment against a convex polygon. */
export function clipSegment(p, q, clip) {
  const oriented = polygonArea(clip) < 0 ? clip.slice().reverse() : clip;
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (let i = 0; i < oriented.length; i++) {
    const a = oriented[i];
    const b = oriented[(i + 1) % oriented.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    // inside test: cross(edge, point - a) >= 0
    const num = ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
    const den = -(ex * dy - ey * dx);
    if (Math.abs(den) < EPS) {
      if (num < 0) return null;
      continue;
    }
    const t = num / den;
    if (den > 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  if (t1 < t0) return null;
  return [
    [p[0] + t0 * dx, p[1] + t0 * dy],
    [p[0] + t1 * dx, p[1] + t1 * dy],
  ];
}

// --- regions -------------------------------------------------------------------------------------

export const CLIP_CIRCLE_SEGMENTS = 64;

/**
 * Fragment outline in local coordinates, honouring x/y/span/rotate/flipX. `span` is the size of the
 * fragment's unit box in local units. It is deliberately not called `scale`: transform scale and
 * fragment size want different ranges and different quantization steps.
 */
export function fragmentPolygon(args, pack) {
  const frag = pack.fragments[args.name];
  if (!frag) throw new ResolveError(`unknown fragment "${args.name}" in pack ${pack.id}`);
  const rot = ((args.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const s = args.span;
  return frag.points.map(([px, py]) => {
    const x = (args.flipX ? -px : px) * s;
    const y = py * s;
    return [args.x + x * cos - y * sin, args.y + x * sin + y * cos];
  });
}

/** Region as a polygon in the node's local space. */
export function regionPolygon(region, pack, segments = CLIP_CIRCLE_SEGMENTS) {
  switch (region.type) {
    case 'rect':
      return [
        [region.x, region.y],
        [region.x + region.w, region.y],
        [region.x + region.w, region.y + region.h],
        [region.x, region.y + region.h],
      ];
    case 'circle': {
      const pts = [];
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pts.push([region.cx + Math.cos(a) * region.r, region.cy + Math.sin(a) * region.r]);
      }
      return pts;
    }
    case 'polygon':
      return region.points.map((p) => [p[0], p[1]]);
    case 'fragment':
      return fragmentPolygon(region, pack);
    default:
      throw new ResolveError(`unknown region type "${region.type}"`);
  }
}

// --- bleed margins -------------------------------------------------------------------------------
// Conservative padding added to a node's bounding box, in the node's local units, before the world
// transform is applied. Brush marks are stamps: they always exceed their geometry a little.

export function styleMargin(style, brushScale) {
  const bs = brushScale ?? 1;
  if (!style) return 4 * bs;
  switch (style.kind) {
    case 'wash':
      return (10 + (style.bleed ?? 0) * 120) * bs;
    case 'hatch':
      return (3 + (style.spacing ?? 1)) * bs;
    case 'field':
      return ((style.length ?? 0) + 4) * bs;
    case 'outline':
      return (3 + (style.weight ?? 1) * 3) * bs;
    case 'solid':
      return 1;
    default:
      return 4 * bs;
  }
}

function boundsOfPoints(pts, margin) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: minX - margin,
    y: minY - margin,
    w: maxX - minX + margin * 2,
    h: maxY - minY + margin * 2,
  };
}

/** Conservative canvas-space bounds for one resolved leaf. */
export function leafBounds(node, pack, brushScale) {
  const world = node.world;
  const ws = matScale(world);
  const a = node.args;
  let localPts;
  let margin;
  switch (node.op) {
    case 'wash':
    case 'paint':
      localPts = regionPolygon(a.region, pack);
      margin = styleMargin(a.style, brushScale);
      break;
    case 'cover': {
      // No brush is involved (ops.js opCover), so brushScale is irrelevant here. The furthest the
      // op reaches is its outermost soft-edge layer: the region scaled by 1 + softness/2 about its
      // own centre, which pushes each side out by half-extent * softness/2.
      localPts = regionPolygon(a.region, pack);
      const extent = boundsOfPoints(localPts, 0);
      margin = (Math.max(extent.w, extent.h) * (a.softness ?? 0)) / 4 + 1;
      break;
    }
    case 'fragment':
      localPts = fragmentPolygon(a, pack);
      margin = styleMargin(a.style, brushScale);
      break;
    case 'stroke':
      localPts = a.points.map((p) => [p[0], p[1]]);
      margin = (4 + (a.weight ?? 1) * 4) * (brushScale ?? 1);
      break;
    case 'rule':
      localPts = [a.from, a.to];
      margin = (4 + (a.weight ?? 1) * 4) * (brushScale ?? 1);
      break;
    case 'text': {
      const size = a.size;
      const est = a.maxWidth ?? a.text.length * size * 0.62 + a.text.length * (a.tracking ?? 0);
      const half = a.align === 'center' ? est / 2 : a.align === 'right' ? est : 0;
      const leading = a.leading ?? DEFAULT_LEADING;
      const lines = a.maxWidth ? Math.max(1, Math.ceil((a.text.length * size * 0.62) / a.maxWidth)) : 1;
      const box = [
        [a.x - half, a.y - size],
        [a.x - half + est, a.y - size],
        [a.x - half + est, a.y + size * 0.35 + (lines - 1) * size * leading],
        [a.x - half, a.y + size * 0.35 + (lines - 1) * size * leading],
      ];
      // The glyph transform happens about the anchor, so the box goes through it too. Without this a
      // rotated headline reports bounds it does not occupy, and `diff` reads its spillover as
      // somebody else's.
      localPts = box.map(([x, y]) => textAnchorTransform(a, x, y));
      const j = a.jitter ?? {};
      margin = 3 + (j.translate ?? 0) + (j.scale ?? 0) * size;
      break;
    }
    default:
      throw new ResolveError(`unknown op "${node.op}"`);
  }
  const worldPts = localPts.map(([x, y]) => matApply(world, x, y));
  return boundsOfPoints(worldPts, margin * ws);
}

// --- text ------------------------------------------------------------------------------------------

/** Line advance as a multiple of size when a program says nothing. V0 hard-coded this number. */
export const DEFAULT_LEADING = 1.25;

/**
 * Where a point near a text op ends up once the op's own skew / rotate / stretch have been applied
 * about its anchor. Shared by the bounds estimate here and by the p5 transform in ops.js, because
 * the two disagreeing is exactly how a node's declared bounds stop describing its marks.
 *
 * Order is skew, then rotate, then stretch -- which is the order p5 replays it in when the
 * equivalent translate / scale / rotate / shearX stack is pushed before drawing.
 */
export function textAnchorTransform(a, x, y) {
  let u = x - a.x;
  let v = y - a.y;
  const skew = a.skew ?? 0;
  if (skew) u -= Math.tan((skew * Math.PI) / 180) * v;
  const deg = a.rotate ?? 0;
  if (deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    [u, v] = [u * c - v * s, u * s + v * c];
  }
  const [sx, sy] = a.stretch ?? [1, 1];
  return [a.x + u * sx, a.y + v * sy];
}

// --- repeat layouts --------------------------------------------------------------------------------

function layoutPosition(layout, i, count) {
  switch (layout.type) {
    case 'grid': {
      const cols = layout.cols;
      const [ox, oy] = layout.origin;
      return [ox + (i % cols) * layout.dx, oy + Math.floor(i / cols) * layout.dy];
    }
    case 'line': {
      const [ox, oy] = layout.origin;
      return [ox + i * layout.dx, oy + i * layout.dy];
    }
    case 'ring': {
      const [ox, oy] = layout.origin;
      const start = layout.startAngle ?? 0;
      const a = ((start + (360 * i) / count) * Math.PI) / 180;
      return [ox + Math.cos(a) * layout.r, oy + Math.sin(a) * layout.r];
    }
    case 'scatter':
      return [layout.origin[0], layout.origin[1]];
    default:
      throw new ResolveError(`unknown repeat layout "${layout.type}"`);
  }
}

// --- colour ---------------------------------------------------------------------------------------

export function resolveColor(name, palette) {
  if (typeof name !== 'string') throw new ResolveError(`bad colour ${JSON.stringify(name)}`);
  if (name.startsWith('#')) return name.toLowerCase();
  const hit = palette[name];
  if (!hit) throw new ResolveError(`colour "${name}" is not in the palette`);
  return hit.toLowerCase();
}

function resolveStyleColors(style, palette) {
  if (!style) return style;
  return { ...style, color: resolveColor(style.color, palette) };
}

function resolveArgColors(op, args, palette) {
  const out = { ...args };
  if (out.style) out.style = resolveStyleColors(out.style, palette);
  if (out.color) out.color = resolveColor(out.color, palette);
  return out;
}

/** Colour-bearing fields of a print stage. The pass never invents a colour of its own. */
const PRINT_COLORS = ['dark', 'light', 'ink', 'paper', 'tint'];

function resolvePrint(print, palette) {
  return (print ?? []).map((stage) => {
    const out = { ...stage };
    for (const key of PRINT_COLORS) {
      if (out[key] !== undefined) out[key] = resolveColor(out[key], palette);
    }
    return out;
  });
}

// --- the resolver ----------------------------------------------------------------------------------

/**
 * @param {object} program  a schema-valid program
 * @param {object} pack     asset pack (fragments + motifs), already hash-checked
 * @param {object} limits   { maxResolvedNodes, maxDepth, maxRepeatInstances, maxRepeatNesting }
 * @returns {{canvas, palette, seed, nodes, groups, warnings, counts}}
 */
export function resolveProgram(program, pack, limits = {}) {
  const palette = program.palette ?? {};
  const brushScale = program.canvas.brushScale ?? 1;
  const nodes = [];
  const groups = [];
  const warnings = [];
  let repeatInstances = 0;

  const maxResolved = limits.maxResolvedNodes ?? Infinity;
  const maxDepth = limits.maxDepth ?? Infinity;
  const maxInstances = limits.maxRepeatInstances ?? Infinity;
  const maxNesting = limits.maxRepeatNesting ?? Infinity;

  const walk = (node, ctx) => {
    if (ctx.depth > maxDepth) {
      throw new ResolveError(`tree depth ${ctx.depth} exceeds profile maxTreeDepth ${maxDepth}`);
    }
    const idSuffix = ctx.instancePath.length ? `#${ctx.instancePath.join('#')}` : '';
    const resolvedId = `${node.id}${idSuffix}`;

    if (node.type === 'group') {
      const world = matMul(ctx.world, localMatrix(node.transform));
      let clip = ctx.clip;
      if (node.clip) {
        // Any convex region, not just a rect. The `type: 'rect'` override that used to sit here was
        // the whole of the V0 restriction -- `clipPolygon` has always been a general convex clipper.
        // Convexity is the real requirement and it is checked in Node (env/validate.ts), because
        // Sutherland-Hodgman does not fail on a concave clip, it silently returns a wrong shape.
        const local = regionPolygon(node.clip, pack);
        const poly = local.map(([x, y]) => matApply(world, x, y));
        // Nested clips intersect. Two convex polygons intersect to a convex polygon, so a clip
        // inside a clip is still a legal clip for everything below it.
        clip = ctx.clip ? clipPolygon(poly, ctx.clip) : poly;
        if (clip.length < 3) warnings.push(`clip of group "${resolvedId}" is empty; its subtree paints nothing`);
      }
      groups.push({
        id: resolvedId,
        sourceId: node.id,
        type: 'group',
        world,
        clip: clip ? clip.map(([x, y]) => [round4(x), round4(y)]) : null,
        decisions: node.decisions ?? [],
        label: node.label,
        note: node.note,
        expandedFrom: ctx.expandedFrom,
      });
      const child = { ...ctx, world, clip, depth: ctx.depth + 1 };
      for (const c of node.children ?? []) walk(c, child);
      return;
    }

    if (node.type === 'repeat') {
      if (ctx.repeatNesting + 1 > maxNesting) {
        throw new ResolveError(`repeat nesting ${ctx.repeatNesting + 1} exceeds profile maxRepeatNesting ${maxNesting}`);
      }
      repeatInstances += node.count;
      if (repeatInstances > maxInstances) {
        throw new ResolveError(
          `repeat expansion reached ${repeatInstances} instances, over profile maxRepeatInstances ${maxInstances}`
        );
      }
      groups.push({
        id: resolvedId,
        sourceId: node.id,
        type: 'repeat',
        world: ctx.world,
        clip: ctx.clip ? ctx.clip.map(([x, y]) => [round4(x), round4(y)]) : null,
        decisions: node.decisions ?? [],
        label: node.label,
        note: node.note,
        count: node.count,
        expandedFrom: ctx.expandedFrom,
      });
      const jitter = node.jitter ?? { translate: 0, rotate: 0, scale: 0 };
      for (let i = 0; i < node.count; i++) {
        const inst = instanceIndex([...ctx.instancePath, i]);
        const rng = makeInstanceRng(program.seed, node.rngKey, inst, node.seedOffset ?? 0);
        let [px, py] = layoutPosition(node.layout, i, node.count);
        if (node.layout.type === 'scatter') {
          px += rng.next() * node.layout.w;
          py += rng.next() * node.layout.h;
        }
        const jt = jitter.translate ?? 0;
        const jr = jitter.rotate ?? 0;
        const js = jitter.scale ?? 0;
        const transform = {
          translate: [px + (rng.next() * 2 - 1) * jt, py + (rng.next() * 2 - 1) * jt],
          rotate: (rng.next() * 2 - 1) * jr,
          scale: 1 + (rng.next() * 2 - 1) * js,
        };
        const world = matMul(ctx.world, localMatrix(transform));
        const child = {
          ...ctx,
          world,
          depth: ctx.depth + 1,
          instancePath: [...ctx.instancePath, i],
          repeatNesting: ctx.repeatNesting + 1,
        };
        for (const c of node.children ?? []) walk(c, child);
      }
      return;
    }

    if (node.type === 'macro') {
      const parts = expandMacro(node, pack);
      groups.push({
        id: resolvedId,
        sourceId: node.id,
        type: 'macro',
        macro: node.macro,
        world: ctx.world,
        clip: ctx.clip ? ctx.clip.map(([x, y]) => [round4(x), round4(y)]) : null,
        decisions: node.decisions ?? [],
        label: node.label,
        note: node.note,
        expandedFrom: ctx.expandedFrom,
        parts: parts.map((p) => `${resolvedId}/${p.part}`),
      });
      for (const part of parts) {
        walk(
          {
            ...part.node,
            id: `${node.id}/${part.part}`,
            rngKey: part.node.rngKey ?? `${node.rngKey}/${part.part}`,
            decisions: node.decisions,
          },
          { ...ctx, expandedFrom: resolvedId }
        );
      }
      return;
    }

    // op leaf
    const instance = instanceIndex(ctx.instancePath);
    const seedOffset = node.seedOffset ?? 0;
    const leaf = {
      id: resolvedId,
      sourceId: node.id,
      op: node.op,
      args: resolveArgColors(node.op, node.args, palette),
      world: ctx.world.map(round6),
      rngKey: node.rngKey,
      seedOffset,
      instance,
      seed: nodeSeed(program.seed, node.rngKey, instance, seedOffset),
      clip: ctx.clip ? ctx.clip.map(([x, y]) => [round4(x), round4(y)]) : null,
      decisions: node.decisions ?? [],
      label: node.label,
      note: node.note,
      expandedFrom: ctx.expandedFrom,
    };
    leaf.bounds = roundBounds(leafBounds({ ...leaf, world: ctx.world }, pack, brushScale));
    nodes.push(leaf);
    if (nodes.length > maxResolved) {
      throw new ResolveError(`resolved node count ${nodes.length} exceeds profile maxResolvedNodes ${maxResolved}`);
    }
  };

  walk(program.root, {
    world: IDENTITY,
    clip: null,
    depth: 0,
    instancePath: [],
    repeatNesting: 0,
    expandedFrom: undefined,
  });

  return {
    version: program.version,
    profile: program.profile,
    assetPack: program.assetPack,
    canvas: program.canvas,
    palette,
    seed: program.seed,
    meta: program.meta ?? {},
    print: resolvePrint(program.print, palette),
    nodes,
    groups,
    warnings,
    counts: { resolvedNodes: nodes.length, repeatInstances, groups: groups.length },
  };
}

function makeInstanceRng(masterSeed, rngKey, instance, seedOffset) {
  return makeRng(deriveSeed(masterSeed, rngKey, instance, 'placement', seedOffset));
}

function instanceIndex(instancePath) {
  if (instancePath.length === 0) return 0;
  if (instancePath.length === 1) return instancePath[0];
  return fnv1a32(instancePath.join(','));
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
function roundBounds(b) {
  return { x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h) };
}

/**
 * The font names a resolved program needs loaded, sorted.
 *
 * Every command that renders has to work this out, and the one that forgot -- `validate
 * --determinism` -- silently checked an image with no text in it, because a `text` op with no font
 * loaded draws nothing at all rather than failing (NOTES O2). It lives here so there is one answer.
 */
export function fontsUsed(resolved) {
  const names = new Set();
  for (const node of resolved.nodes) {
    if (node.op === 'text') names.add(String(node.args['font']));
  }
  return [...names].sort();
}
