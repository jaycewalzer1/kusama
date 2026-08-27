// What this medium can do, on one page, generated.
//
// Never hand-written. Every line below is read off the profile, the asset pack and the two JSON
// schemas at runtime, so a sheet cannot describe a medium that no longer exists. That matters more
// than it sounds: the artist writes edits against this sheet, and the single largest source of
// refused edits in a system like this is a capability list that drifted away from the validator.
// If the invalid-edit rate is high, this file is the thing to fix, not the validator.
//
// It is also deliberately blunt about what the medium cannot do. A sheet that only lists powers
// invites an artist to spend three steps discovering that text cannot be clipped.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import type { AssetPack } from '../env/pack.js';
import type { MediumProfile } from '../env/profile.js';
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
  say(`LAYOUTS      ${profile.layouts.map((l) => `${l}${argLine(defs, 'layout') ? '' : ''}`).join(' ')}`);
  for (const branch of defs['layout']?.oneOf ?? []) {
    const type = String(branch.properties?.['type']?.const ?? '');
    if (!profile.layouts.includes(type)) continue;
    const required = (branch.required ?? []).filter((k) => k !== 'type');
    const optional = Object.keys(branch.properties ?? {}).filter((k) => k !== 'type' && !(branch.required ?? []).includes(k));
    say(`  ${type}: required ${required.join(' ')}${optional.length ? `; optional ${optional.join(' ')}` : ''}`);
  }
  say(`BLEND MODES  ${profile.blendModes.join(' ')} (on a group; carried to the leaves, so it is per mark)`);
  say(`BRUSHES      ${profile.brushes.join(' ')}`);
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
