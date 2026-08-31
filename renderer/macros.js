// Macro expansion. Pure functions of (args, rngKey): a macro is a fixed recipe of primitives, never
// a hidden decision. Expansion happens at resolve time and every part appears in resolved.json with
// its own id `<macroId>/<partName>` and `expandedFrom`.

export class MacroError extends Error {}

/**
 * @returns {{part: string, node: object}[]} primitive nodes, in paint order.
 */
export function expandMacro(node, pack) {
  const a = node.args;
  switch (node.macro) {
    case 'frame':
      return expandFrame(a);
    case 'motif':
      return expandMotif(a, pack);
    case 'quarantine':
      return expandQuarantine(a);
    default:
      throw new MacroError(`unknown macro "${node.macro}"`);
  }
}

// --- frame ----------------------------------------------------------------------------------------
// A border around a rect. style `corners` draws four L brackets, `full` draws four rules,
// `dots` places a ring of small solid dots along the border.

function expandFrame(a) {
  const { x, y, w, h, inset = 0, style, brush: brushName, color, weight = 1 } = a;
  const x0 = x + inset;
  const y0 = y + inset;
  const x1 = x + w - inset;
  const y1 = y + h - inset;
  const rule = (part, from, to) => ({
    part,
    node: { type: 'op', op: 'rule', args: { from, to, brush: brushName, color, weight } },
  });

  if (style === 'full') {
    return [
      rule('top', [x0, y0], [x1, y0]),
      rule('right', [x1, y0], [x1, y1]),
      rule('bottom', [x1, y1], [x0, y1]),
      rule('left', [x0, y1], [x0, y0]),
    ];
  }
  if (style === 'dots') {
    const count = a.count ?? 12;
    const r = a.dotRadius ?? 3;
    const parts = [];
    const perimeter = [];
    for (let i = 0; i < count; i++) {
      const t = i / count;
      // walk the rectangle perimeter
      const total = 2 * (x1 - x0) + 2 * (y1 - y0);
      let d = t * total;
      let px;
      let py;
      if (d < x1 - x0) {
        px = x0 + d;
        py = y0;
      } else if ((d -= x1 - x0) < y1 - y0) {
        px = x1;
        py = y0 + d;
      } else if ((d -= y1 - y0) < x1 - x0) {
        px = x1 - d;
        py = y1;
      } else {
        d -= x1 - x0;
        px = x0;
        py = y1 - d;
      }
      perimeter.push([px, py]);
    }
    perimeter.forEach(([px, py], i) => {
      parts.push({
        part: `dot${i}`,
        node: {
          type: 'op',
          op: 'paint',
          args: {
            region: { type: 'circle', cx: px, cy: py, r },
            style: { kind: 'solid', color, opacity: a.opacity ?? 255 },
          },
        },
      });
    });
    return parts;
  }
  // corners
  const arm = a.arm ?? Math.min(w, h) * 0.12;
  return [
    rule('tl_h', [x0, y0], [x0 + arm, y0]),
    rule('tl_v', [x0, y0], [x0, y0 + arm]),
    rule('tr_h', [x1 - arm, y0], [x1, y0]),
    rule('tr_v', [x1, y0], [x1, y0 + arm]),
    rule('br_h', [x1 - arm, y1], [x1, y1]),
    rule('br_v', [x1, y1 - arm], [x1, y1]),
    rule('bl_h', [x0, y1], [x0 + arm, y1]),
    rule('bl_v', [x0, y1 - arm], [x0, y1]),
  ];
}

// --- motif ----------------------------------------------------------------------------------------
// Small compounds defined by the asset pack. A motif definition is a list of primitive parts in a
// unit box (-0.5..0.5); the macro places and scales them.

function expandMotif(a, pack) {
  const def = pack.motifs[a.name];
  if (!def) throw new MacroError(`unknown motif "${a.name}" in pack ${pack.id}`);
  const s = a.size;
  const rot = ((a.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const px = a.x ?? 0;
  const py = a.y ?? 0;
  const place = ([ux, uy]) => {
    const x = ux * s;
    const y = uy * s;
    return [px + x * cos - y * sin, py + x * sin + y * cos];
  };
  const styleFor = (partStyle) => {
    const base = { ...partStyle };
    if (a.color) base.color = a.color;
    if (base.kind === 'hatch' && a.brush) base.brush = a.brush;
    if (base.kind === 'outline' && a.brush) base.brush = a.brush;
    return base;
  };

  return def.parts.map((part, i) => {
    if (part.type === 'stroke') {
      return {
        part: part.name ?? `p${i}`,
        node: {
          type: 'op',
          op: 'stroke',
          args: {
            points: part.points.map(place),
            brush: a.brush ?? part.brush,
            color: a.color ?? part.color,
            weight: part.weight ?? 1,
            closed: part.closed ?? false,
            curve: part.curve ?? 0,
          },
        },
      };
    }
    if (part.type === 'paint') {
      const region =
        part.region.type === 'circle'
          ? (() => {
              const [cx, cy] = place([part.region.cx, part.region.cy]);
              return { type: 'circle', cx, cy, r: part.region.r * s };
            })()
          : { type: 'polygon', points: part.region.points.map(place) };
      return {
        part: part.name ?? `p${i}`,
        node: { type: 'op', op: 'paint', args: { region, style: styleFor(part.style) } },
      };
    }
    throw new MacroError(`motif "${a.name}" part ${i} has unknown type "${part.type}"`);
  });
}

// --- quarantine -----------------------------------------------------------------------------------
// The region painted, a thin rule box around it, and an optional text label. Used to fence off
// material the picture does not want to integrate.

function expandQuarantine(a) {
  const { x, y, w, h } = a;
  const parts = [
    {
      part: 'field',
      node: {
        type: 'op',
        op: 'paint',
        args: { region: { type: 'rect', x, y, w, h }, style: a.style },
      },
    },
    { part: 'box_top', node: ruleNode([x, y], [x + w, y], a) },
    { part: 'box_right', node: ruleNode([x + w, y], [x + w, y + h], a) },
    { part: 'box_bottom', node: ruleNode([x + w, y + h], [x, y + h], a) },
    { part: 'box_left', node: ruleNode([x, y + h], [x, y], a) },
  ];
  if (a.label) {
    parts.push({
      part: 'label',
      node: {
        type: 'op',
        op: 'text',
        args: {
          text: a.label,
          font: a.labelFont ?? 'grotesque',
          size: a.labelSize ?? 11,
          x: x + w / 2,
          y: y + h + (a.labelSize ?? 11) + 6,
          align: 'center',
          color: a.boxColor ?? 'ink',
          tracking: a.labelTracking ?? 1,
        },
      },
    });
  }
  return parts;
}

function ruleNode(from, to, a) {
  return {
    type: 'op',
    op: 'rule',
    args: { from, to, brush: a.boxBrush ?? 'rotring', color: a.boxColor ?? 'ink', weight: a.boxWeight ?? 0.5 },
  };
}
