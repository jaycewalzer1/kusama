// One pass over a program tree, producing everything the tree-scope checkers need.
//
// This reads the *source* tree, not the resolved one. That is a deliberate choice and it is the
// single largest blind spot in the layer: a `repeat` with count 40 contributes one node here, not
// forty. Resolving would fix that and would cost the pack, the profile, and purity — tree-scope
// checkers are pure functions of the JSON, which is what makes them free enough to run on every
// candidate edit. docs/constraints.md lists what that costs, per kind.
//
// Nothing here validates. The tree is assumed to have passed the medium's own validateProgram; a
// malformed tree produces facts that are merely uninteresting, never an exception.

export interface ColorUse {
  /** Normalized #rrggbb, lowercase. Palette names are resolved through the program's palette. */
  hex: string;
  nodeId: string;
  /** Where in the node: "style.color", "boxColor", "ground", ... */
  at: string;
}

export interface MarkUse {
  nodeId: string;
  /** A PaintStyle kind, when this node has one. Strokes, rules, glyphs and cover have none. */
  style?: string;
  brush?: string;
}

export interface TextUse {
  nodeId: string;
  text: string;
  /** A quarantine label is a text op by any other name (env/validate.ts counts it as one). */
  from: 'text' | 'quarantine.label';
}

export interface TreeFacts {
  ground: string;
  colors: ColorUse[];
  /** Every node id per operator name, in tree order. */
  ops: Record<string, string[]>;
  /** Every node id per macro name, in tree order. */
  macros: Record<string, string[]>;
  marks: MarkUse[];
  texts: TextUse[];
  /** Deepest nesting of `repeat` nodes. 0 when the tree has none. */
  repeatDepth: number;
  drawingNodes: number;
  containerNodes: number;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A palette name or a literal. Unknown names are dropped: the medium already refused that program. */
function resolveColor(value: unknown, palette: Record<string, string>): string | undefined {
  const name = str(value);
  if (name === undefined) return undefined;
  const hex = name.startsWith('#') ? name : palette[name];
  return hex === undefined ? undefined : hex.toLowerCase();
}

export function treeFacts(program: unknown): TreeFacts {
  const prog = isDict(program) ? program : {};
  const canvas = isDict(prog['canvas']) ? prog['canvas'] : {};
  const palette: Record<string, string> = {};
  if (isDict(prog['palette'])) {
    for (const [k, v] of Object.entries(prog['palette'])) if (typeof v === 'string') palette[k] = v;
  }

  const facts: TreeFacts = {
    ground: (str(canvas['ground']) ?? '#ffffff').toLowerCase(),
    colors: [],
    ops: {},
    macros: {},
    marks: [],
    texts: [],
    repeatDepth: 0,
    drawingNodes: 0,
    containerNodes: 0,
  };

  const color = (value: unknown, nodeId: string, at: string) => {
    const hex = resolveColor(value, palette);
    if (hex !== undefined) facts.colors.push({ hex, nodeId, at });
  };

  const mark = (nodeId: string, style: unknown, brush: unknown) => {
    const s = isDict(style) ? str(style['kind']) : undefined;
    const b = str(brush) ?? (isDict(style) ? str(style['brush']) : undefined);
    if (s !== undefined || b !== undefined) facts.marks.push({ nodeId, style: s, brush: b });
  };

  const walk = (node: unknown, repeatsAbove: number) => {
    if (!isDict(node)) return;
    const id = str(node['id']) ?? '(anonymous)';
    const type = str(node['type']);
    const args = isDict(node['args']) ? node['args'] : {};

    if (type === 'group' || type === 'repeat') {
      facts.containerNodes++;
      const depth = type === 'repeat' ? repeatsAbove + 1 : repeatsAbove;
      if (depth > facts.repeatDepth) facts.repeatDepth = depth;
      const children = node['children'];
      if (Array.isArray(children)) for (const c of children) walk(c, depth);
      return;
    }

    facts.drawingNodes++;

    if (type === 'macro') {
      const name = str(node['macro']) ?? '(unknown)';
      (facts.macros[name] ??= []).push(id);
      color(args['color'], id, 'args.color');
      color(args['boxColor'], id, 'args.boxColor');
      if (isDict(args['style'])) color((args['style'] as Dict)['color'], id, 'args.style.color');
      mark(id, args['style'], args['brush'] ?? args['boxBrush']);
      const label = str(args['label']);
      if (label !== undefined) facts.texts.push({ nodeId: id, text: label, from: 'quarantine.label' });
      return;
    }

    // op
    const op = str(node['op']) ?? '(unknown)';
    (facts.ops[op] ??= []).push(id);
    color(args['color'], id, 'args.color');
    if (isDict(args['style'])) color((args['style'] as Dict)['color'], id, 'args.style.color');
    mark(id, args['style'], args['brush']);
    if (op === 'text') {
      const text = str(args['text']);
      if (text !== undefined) facts.texts.push({ nodeId: id, text, from: 'text' });
    }
  };

  walk(prog['root'], 0);
  return facts;
}

/** Distinct colours, ground optionally included. Sorted, so evidence reads the same every time. */
export function distinctColors(facts: TreeFacts, includeGround: boolean): string[] {
  const set = new Set(facts.colors.map((c) => c.hex));
  if (includeGround) set.add(facts.ground);
  return [...set].sort();
}
