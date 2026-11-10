// What this medium can do, on one page, generated.
//
// The shape of the medium is never hand-written. Every argument list, range, budget and name below
// is read off the profile, the asset pack and the two JSON schemas at runtime, so a sheet cannot
// describe a medium that no longer exists. That matters more than it sounds: the artist writes edits
// against this sheet, and the single largest source of refused edits in a system like this is a
// capability list that drifted away from the validator. If the invalid-edit rate is high, this file
// is the thing to fix, not the validator.
//
// It is also deliberately blunt about what the medium cannot do. A sheet that only lists powers
// invites an artist to spend three steps discovering that text cannot be clipped. The budget block
// says what a mark IS for the same reason: the limits used to be printed as a row of key=value pairs
// in a unit nothing on the page defined, and 43 of the 63 edit refusals ever recorded in `out/` were
// a program going over `maxEstimatedMarks`. The rates there are probed out of the estimator, so the
// prose is hand-written but every number in it comes from the function that does the refusing.
//
// THE ONE EXCEPTION IS `MATERIAL`, AND IT IS HAND-WRITTEN ON PURPOSE. A schema can say that a wash
// takes `bleed` 0..0.6; nothing on disk can say that a wash is the wet fill and `solid` is a flat
// vector rectangle. Three finished trajectories were measured before this section existed: 40 solid
// fills, 12 non-solid, and zero uses of the `wash`, `spray`, `fragment` or `stroke` operators, zero
// print stages and zero blend groups — an artist working a brush engine as though it were a chart
// library, because the sheet described the parameters of the material and never the material. The
// descriptions are ordering claims about p5.brush's own per-brush parameters (grain, scatter,
// opacity), not levels, for the reason every other ordering claim in this repo is preferred to a
// level: the ordering survives a re-vendor and the numbers do not.
//
// Two rules keep the exception from rotting into a second, unversioned medium description. The
// tables are keyed by the names the profile uses, so a brush or style the profile drops leaves the
// sheet with it; and a name the profile has that the table does not is printed as `(undescribed)`
// rather than omitted, so the gap is visible on the sheet the artist is reading. A test pins both.
// This file's bytes are also hashed into `OBSERVATION_HASH`, which is what stops a run made before
// an edit here being compared against one made after.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import type { AssetPack } from '../env/pack.js';
import { markRates, PROBE_LARGE, PROBE_SMALL, type MediumProfile } from '../env/profile.js';
import { EDIT_KINDS } from '../env/edits.js';

interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  type?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

function schema(name: string): JsonSchema {
  return JSON.parse(readFileSync(path.join(ROOT, 'schema', name), 'utf8')) as JsonSchema;
}

function range(prop: JsonSchema): string {
  const lo = prop.minimum ?? prop.exclusiveMinimum;
  const hi = prop.maximum;
  if (lo === undefined && hi === undefined) return '';
  return ` ${lo ?? ''}..${hi ?? ''}`;
}

/**
 * The shape and bounds a field carries in the schema itself. Two things live only here and nowhere
 * in the profile's range table below: numeric bounds like `opacity` 0..255, and the fact that some
 * fields are arrays. Both have been guessed wrong in a real run — `opacity: 1` and `texture: 0.15`
 * where the schema wants 0..255 and a pair — and neither guess is unreasonable from a bare name.
 */
function shape(prop: JsonSchema | undefined): string {
  if (!prop) return '';
  if (prop.$ref?.endsWith('point')) return '=[x,y]';
  if (prop.type === 'array') {
    const items = prop.items;
    if (items?.$ref?.endsWith('point')) return '=[[x,y],...]';
    const n = prop.minItems === prop.maxItems && prop.minItems !== undefined ? String(prop.minItems) : 'n';
    return `=[${n}${items ? ` ${items.type ?? ''}` : ''}${items ? range(items) : ''}]`;
  }
  const r = range(prop);
  return r ? `[${r.trim()}]` : '';
}

/** "required a, b, c; optional d, e" for one args definition, or "" if the schema has no such def. */
function argLine(defs: Record<string, JsonSchema>, defName: string): string {
  const def = defs[defName];
  if (!def?.properties) return '';
  const props = def.properties;
  const required = new Set(def.required ?? []);
  const named = (k: string) => `${k}${shape(props[k])}`;
  const req = Object.keys(props).filter((k) => required.has(k)).map(named);
  const opt = Object.keys(props).filter((k) => !required.has(k)).map(named);
  const parts = [];
  if (req.length) parts.push(`required ${req.join(' ')}`);
  if (opt.length) parts.push(`optional ${opt.join(' ')}`);
  return parts.join('; ');
}

/**
 * Which style each op and macro will actually take. Not decoration: `washArgs.style` is the wash
 * style alone and `frameArgs.style` is an enum that is not a paint style at all, so a sheet that
 * calls the styles "one union" invites a solid-styled wash, which is refused with a page of oneOf
 * noise that names none of this.
 */
function styleTakers(defs: Record<string, JsonSchema>): string[] {
  const out: string[] = [];
  for (const [defName, def] of Object.entries(defs)) {
    if (!defName.endsWith('Args')) continue;
    const style = def.properties?.['style'];
    if (!style) continue;
    const who = defName.slice(0, -'Args'.length);
    if (style.enum) out.push(`  ${who}.style: one of ${style.enum.join(' ')} — a keyword, not a paint style`);
    else if (style.$ref === '#/$defs/style') out.push(`  ${who}.style: any of the styles above`);
    else if (style.$ref) out.push(`  ${who}.style: ${style.$ref.split('/').pop()} only`);
  }
  return out.sort();
}

function printStageLine(program: JsonSchema, stage: string): string {
  const branch = (program.$defs?.['printStage']?.oneOf ?? []).find(
    (b) => b.properties?.['stage']?.const === stage
  );
  if (!branch?.properties) return stage;
  const required = new Set(branch.required ?? []);
  const req = Object.keys(branch.properties).filter((k) => required.has(k) && k !== 'stage');
  const opt = Object.keys(branch.properties).filter((k) => !required.has(k));
  return `${stage}: required ${req.join(' ') || '(none)'}${opt.length ? `; optional ${opt.join(' ')}` : ''}`;
}

function editLine(edit: JsonSchema, kind: string): string {
  const extra = (edit.allOf ?? [])
    .filter((rule) => (rule as { if?: JsonSchema }).if?.properties?.['kind']?.const === kind)
    .flatMap((rule) => (rule as { then?: JsonSchema }).then?.required ?? []);
  return `${kind}: actionId, kind, targets${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

function facesByRole(pack: AssetPack): string[] {
  const byRole = new Map<string, string[]>();
  for (const [name, face] of Object.entries(pack.faces ?? {})) {
    const list = byRole.get(face.role) ?? [];
    list.push(name);
    byRole.set(face.role, list);
  }
  return [...byRole.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([role, names]) => `  ${role}: ${names.sort().join(' ')}`);
}

/**
 * What each brush does to the sheet, ordered clean to dirty. p5.brush gives every brush a `grain`
 * (texture samples per mark), a `scatter` (how far each sample strays) and a per-sample `opacity`;
 * the three together are the whole character, and a low opacity with a high scatter is a dry medium
 * that can only build by overlapping itself. Insertion order here is the ordering claim.
 */
const BRUSH_CHARACTER: Record<string, string> = {
  marker: 'flat felt tip. No grain and no sharpness at all — the one brush that leaves an even mark.',
  rotring: 'technical pen. Thin, near-opaque, almost no wander. The most controlled line here.',
  pen: 'a clean nib. Slight grain, slight scatter. The neutral line.',
  '2H': 'hard pencil. Faint and grey and it will not go dark however often you draw it.',
  cpencil: 'coloured pencil. Translucent — the colour arrives by layering, not in one pass.',
  HB: 'ordinary pencil.',
  '2B': 'soft pencil. Darker, broader, visibly grainy.',
  pastel: 'chalk dragged sideways. Very wide, very faint, and it rotates with the stroke.',
  crayon: 'wax. Heavily broken up; it skips over its own texture and leaves the paper showing.',
  charcoal: 'the dirtiest mark available. Dusty, wide, and the edge of it smudges.',
  // No cross-reference to the `spray` operator, however tempting: default-v0 carries this brush and
  // refuses that operator, so the sentence would name a primitive the profile does not have — the
  // exact drift the rest of this file is generated to avoid.
  spray: 'aerosol. Thrown rather than drawn; the mark falls off from wherever it was aimed.',
};

/**
 * What each fill is FOR, which is the thing the schema cannot say. `solid` is first because it is
 * the default failure mode and saying so is the point of the section.
 */
const BRUSH_PAD = 11;
const STYLE_PAD = 14;

const STYLE_CHARACTER: Record<string, string> = {
  wash: [
    'WHERE COLOUR LIVES. The wet fill: `bleed` pushes pigment past the region edge, `texture` is',
    'the paper tooth under it. Depth is made by layering several low-opacity washes over each other.',
    'This is the primary way to build a surface that reads as painted rather than plotted.',
  ].join(`\n${' '.repeat(STYLE_PAD + 2)}`),
  hatch: [
    'WHERE TONE LIVES. Ruled parallel lines at a spacing and an angle, drawn with a brush;',
    '`layers: 2` crosses them. Engraving: tone comes from spacing and angle, never from a ramp.',
    'A crosshatch at charcoal is an entirely different surface from one at rotring.',
  ].join(`\n${' '.repeat(STYLE_PAD + 2)}`),
  field: [
    'WHERE TEXTURE LIVES. Loose marks scattered through the region — dots, dashes or scribble, at',
    'a density and a length. Where a wash is wet, a field is dry. A field over a wash is grain.',
  ].join(`\n${' '.repeat(STYLE_PAD + 2)}`),
  outline: 'the region\'s edge only, in a brush at a weight. Nothing inside it.',
  solid: [
    'flat colour, no texture, no brush. Use it for framing, masking and structural elements —',
    'never as the primary surface. A picture built only from solid is a vector diagram that',
    'happens to run on a brush engine.',
  ].join(`\n${' '.repeat(STYLE_PAD + 2)}`),
};

/**
 * Names the profile allows, in the table's order, with anything the table does not describe called
 * out rather than dropped. Omitting it would hide the gap in exactly the file whose job is to not
 * have gaps.
 */
function characterLines(allowed: string[], table: Record<string, string>, pad: number): string[] {
  const known = Object.keys(table).filter((name) => allowed.includes(name));
  const missing = allowed.filter((name) => !(name in table));
  return [...known, ...missing].map(
    (name) => `  ${name.padEnd(pad)}${table[name] ?? '(undescribed — this file has no entry for it)'}`
  );
}

function materialSection(profile: MediumProfile): string[] {
  const lines = ['MATERIAL     this is a brush engine, not a vector tool. The richness is in the marks.'];
  lines.push('BRUSHES, cleanest first:');
  lines.push(...characterLines(profile.brushes, BRUSH_CHARACTER, BRUSH_PAD));
  lines.push('FILLS:');
  lines.push(...characterLines(profile.styles ?? [], STYLE_CHARACTER, STYLE_PAD));
  if (profile.blendModes.some((m) => m !== 'normal')) {
    lines.push('  A blend mode is carried down to the leaves, so it is per mark: two overlapping stamps of one');
    lines.push('  hatch multiply with each other as well as with the ground, which is what overprinting ink does.');
    lines.push('  `normal` throws that away.');
  }
  if ((profile.print ?? []).length) {
    lines.push('  The print pass changes the material of the whole sheet rather than its drawing, once, at the');
    lines.push('  end. `paper` and `grain` do that and nothing else; `generation` is a photocopy of a photocopy.');
  }
  return lines;
}

function pairs(record: Record<string, number | [number, number]>, format: (v: number | [number, number]) => string): string {
  return Object.entries(record)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${format(v)}`)
    .join('  ');
}

/**
 * The whole sheet. Given a profile and pack, this is a pure function of files on disk, so two
 * trajectories that quote different sheets were run against different mediums.
 */
export function capabilitySheet(profile: MediumProfile, pack: AssetPack): string {
  const program = schema('program.schema.json');
  const paint = schema('paintstyle.schema.json');
  const edit = schema('edit.schema.json');
  const defs = program.$defs ?? {};
  const paintDefs = paint.$defs ?? {};
  const limits = profile.limits as unknown as Record<string, number | undefined>;

  const lines: string[] = [];
  const say = (s = '') => lines.push(s);

  say(`MEDIUM ${profile.id} / pack ${pack.id}`);
  say(profile.description ?? '');
  say();

  say('A program is a JSON tree. Node types: group (children, optional transform/clip/blend),');
  say('repeat (rngKey, count, layout, children), macro (macro, rngKey, args), op (op, rngKey, args).');
  say('Ids are globally unique and match ^[a-zA-Z][a-zA-Z0-9._-]*$. rngKey is a node\'s permanent');
  say('identity as a mark-maker: it is never derived from position and edits never change it, so');
  say('moving a node cannot change the marks it makes. Paint order is program order: later covers earlier.');
  say();

  say('PRIMITIVES (op)');
  for (const op of profile.primitives) say(`  ${op}: ${argLine(defs, `${op}Args`)}`);
  // Two budgets bind a single field each and are the two most often walked into, so they are said
  // here as well as in the budget block: a paragraph of body copy is longer than it looks.
  say(
    `  text is capped at ${limits['maxTextLength']} characters per op and ${limits['maxTextOps']} text ops in the whole program.`
  );
  say();

  say('MACROS');
  for (const macro of profile.macros) say(`  ${macro}: ${argLine(defs, `${macro}Args`)}`);
  say();

  say('PAINT STYLES (`kind` is the discriminator and must equal the style name)');
  for (const kind of profile.styles ?? []) say(`  ${kind}: ${argLine(paintDefs, kind)}`);
  say('WHICH STYLE GOES WHERE');
  for (const line of styleTakers(defs)) say(line);
  say();

  say('REGIONS      every region carries a `type` discriminator; there is no untagged region:');
  say('  {type:"rect",x,y,w,h}  {type:"circle",cx,cy,r}  {type:"polygon",points}');
  say('  {type:"fragment",name,x,y,span,rotate?,flipX?}');
  say(`CLIP SHAPES  ${(profile.clipShapes ?? ['rect']).join(' ')} (convex only; a concave polygon is refused)`);
  say('LAYOUTS');
  for (const branch of defs['layout']?.oneOf ?? []) {
    const type = String(branch.properties?.['type']?.const ?? '');
    if (!profile.layouts.includes(type)) continue;
    const required = (branch.required ?? []).filter((k) => k !== 'type');
    const optional = Object.keys(branch.properties ?? {}).filter((k) => k !== 'type' && !(branch.required ?? []).includes(k));
    say(`  ${type}: required ${required.join(' ')}${optional.length ? `; optional ${optional.join(' ')}` : ''}`);
  }
  say(`BLEND MODES  ${profile.blendModes.join(' ')} (on a group; carried to the leaves, so it is per mark)`);
  say();

  for (const line of materialSection(profile)) say(line);
  say();

  say(`FONTS (${profile.fonts.length} faces, by role)`);
  for (const line of facesByRole(pack)) say(line);
  say();

  say(`FRAGMENTS    ${Object.keys(pack.fragments).sort().join(' ')}`);
  say(`MOTIFS       ${Object.keys(pack.motifs).sort().join(' ')}`);
  say();

  if ((profile.print ?? []).length) {
    say('PRINT PASS (a program-level `print` array; runs once in Node on the finished canvas)');
    for (const stage of profile.print ?? []) say(`  ${printStageLine(program, stage)}`);
    say();
  }

  say('EDIT ACTIONS (the only way a program changes)');
  for (const kind of EDIT_KINDS) say(`  ${editLine(edit, kind)}`);
  say('  add_node must carry an rngKey on every drawing node it inserts.');
  say('  add_node `index` is OPTIONAL and appends at the end when omitted. Omit it unless you mean to');
  say('    insert underneath something. An explicit index is read against the parent as it stands when');
  say('    that edit runs, so if an earlier edit in the same step is refused, every later hard-coded');
  say('    index is off by one and is refused too — one mistake becomes all of them.');
  say('  set_arg replaces a value in place and the replacement must be the same shape as what it replaces.');
  say('  set_arg `path` is relative to that node\'s args and NEVER starts with "args.". To move the node');
  say('    whose id is n1 to x=120: {kind:"set_arg", targets:["n1"], path:"x", value:120}. One level down,');
  say('    a region\'s width is path:"region.w"; an endpoint of a rule is path:"to.1". Writing "args.x"');
  say('    is refused with `"args.x" does not exist in the args of "n1"`, which names the right node and');
  say('    the wrong field, and costs the whole step.');
  say('  wrap_group needs contiguous siblings under one parent.');
  say('  Only a group carries a transform; an op\'s position lives in its own args.');
  say();

  say('BUDGET (checked in Node before any browser starts; an edit that breaks one is refused)');
  say(
    `  ${Object.entries(limits)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')}`
  );
  say();

  // `maxEstimatedMarks` above is a number in a unit the artist has no way to convert into. This is
  // the conversion, probed out of the estimator itself rather than described, so it cannot drift
  // from the function that will actually refuse the edit.
  say(`WHAT A MARK IS, AND WHAT EACH FILL COSTS IN THEM — you are budgeting in these, so count them`);
  say('A mark is one brush stamp. Every fill below is priced by filling a square of the given size:');
  const small = markRates(profile, PROBE_SMALL);
  const large = markRates(profile, PROBE_LARGE);
  const head = (b: { w: number; h: number }) => `${b.w}x${b.h}`;
  say(`${' '.repeat(14)}${head(PROBE_SMALL).padStart(9)}${head(PROBE_LARGE).padStart(12)}`);
  for (const [i, rate] of small.entries()) {
    say(
      `  ${rate.kind.padEnd(12)}${String(rate.marks).padStart(9)}${String(large[i]!.marks).padStart(12)}` +
        (rate.params ? `   (${rate.params})` : '')
    );
  }
  say(`The right-hand box is 9x the area of the left. A fill whose two numbers differ scales with the`);
  say(`area you give it, so doubling a region's width and height quadruples what it costs; one whose`);
  say('numbers match costs the same at any size. This is the whole reason a picture can be refused:');
  say(`a single textured fill across a large region can spend the entire ${limits['maxEstimatedMarks']}-mark allowance by`);
  say('itself, while the same region filled `solid` spends one. Cost is not a reason to reach for');
  say('`solid` — see MATERIAL — it is a reason to size a textured region deliberately rather than by');
  say('default, and to know before you send an edit roughly what it will come to.');
  say('Other ops: `text` is 2 marks per character, `rule` and `stroke` are priced by length, and');
  say('`spray` is exactly its particle count, so its `density` and `r` are the whole bill.');
  say();

  say('EVERY NUMBER must sit on its field\'s quantization step and inside its field\'s range.');
  say(`  step:  ${pairs(profile.quantize, (v) => String(v))}`);
  say(`  range: ${pairs(profile.ranges as Record<string, [number, number]>, (v) => `[${(v as [number, number])[0]},${(v as [number, number])[1]}]`)}`);
  say();

  say('WHAT THIS MEDIUM CANNOT DO');
  say('  Text cannot be clipped: a `text` op inside a clipped group is refused outright.');
  say('  Light cannot be laid over dark. There is no eraser; `cover` repaints the ground colour.');
  say('  `hatch` is engraving, not halftone: fixed spacing, no tonal ramp, no midtone, no face.');
  say('  There is no per-glyph font change. One text op is one face at one size on one baseline;');
  say('    `jitter` displaces glyphs but cannot swap them, and mismatched faces need separate ops.');
  say('  Clip polygons must be convex, so a fragment outline cannot be a clip.');
  say('  A `repeat` is one node to the constraint checker however many instances it draws.');
  say('  Nothing knows stacking order or occlusion: a required string can be satisfied at 6pt behind');
  say('    an opaque rectangle, and the checker will call that satisfied. Do not rely on it.');

  return lines.join('\n');
}
