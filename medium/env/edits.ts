// Typed, bounded edits: the only way a program changes after it is first written (spec 11).
//
// Two properties hold everything else up.
//
// Purity: applyEdit clones the program, mutates the clone and returns it. The program it was given
// is never touched, so a caller can try an edit, look at the result and throw it away.
//
// Same door as everyone else: the candidate goes through exactly the `validateProgram` a
// hand-written program faces -- schema, unique ids, quantization, ranges, profile gating, budget. An
// edit therefore cannot produce a program the medium would have refused, including one that is
// merely too expensive to draw; that refusal happens here, in Node, before any renderer exists.
//
// An invalid action is a refusal, never an exception: `valid: false`, a reason a human can act on,
// and the original program object handed straight back.

import type { AssetPack } from './pack.js';
import type { MediumProfile } from './profile.js';
import { validateEditAction, validateProgram, type Issue } from './validate.js';

export type Program = Record<string, unknown>;

export const EDIT_KINDS = [
  'add_node',
  'delete_node',
  'set_arg',
  'set_transform',
  'set_style',
  'reparent_node',
  'wrap_group',
  'duplicate_as_repeat',
] as const;

export type EditKind = (typeof EDIT_KINDS)[number];

/** One action, as edit.schema.json defines it. `before`/`after`/`estimatedCost` are filled in here. */
export interface EditAction {
  actionId: string;
  kind: EditKind;
  targets: string[];
  decisionRefs?: string[];
  note?: string;
  parent?: string;
  index?: number;
  node?: Record<string, unknown>;
  path?: string;
  value?: unknown;
  transform?: Record<string, unknown>;
  style?: Record<string, unknown>;
  groupId?: string;
  count?: number;
  layout?: Record<string, unknown>;
  jitter?: Record<string, unknown>;
  rngKey?: string;
  before?: unknown;
  after?: unknown;
  estimatedCost?: number;
}

export interface EditResult {
  /** The edited program, or the original object unchanged if the edit was refused. */
  nextProgram: Program;
  /** Source ids whose marks may have moved. Conservative: a group transform lists its whole subtree. */
  changedNodeIds: string[];
  /** Change in estimated render cost, after minus before. Negative means the edit made it cheaper. */
  cost: number;
  valid: boolean;
  reason?: string;
}

interface TreeNode {
  id: string;
  type: string;
  children?: TreeNode[];
  args?: Record<string, unknown>;
  transform?: Record<string, unknown>;
  rngKey?: string;
  [key: string]: unknown;
}

/** What one kind of edit did to the tree, or why it could not be done. */
type Applied = { changedNodeIds: string[]; before: unknown; after: unknown } | { reason: string };

const CONTAINERS = new Set(['group', 'repeat']);
const NEEDS_RNG_KEY = new Set(['op', 'macro', 'repeat']);

export function applyEdit(
  program: Program,
  action: unknown,
  profile: MediumProfile,
  pack: AssetPack
): EditResult {
  const actionIssues = validateEditAction(action);
  if (actionIssues.length) return refuse(program, `the action is not a valid EditAction: ${say(actionIssues)}`);
  const act = action as EditAction;

  const existing = (program['meta'] as Record<string, unknown> | undefined)?.['provenance'];
  if (existing !== undefined && !Array.isArray(existing)) {
    return refuse(program, 'meta.provenance is not an array, so there is no edit history to append to');
  }

  // The before-cost is only meaningful if the program was affordable to begin with, and an edit to a
  // program that is already refused would report a cost delta against nothing.
  const before = validateProgram(program, profile, pack);
  if (!before.valid) {
    return refuse(program, `the program being edited is not valid to begin with: ${say(before.issues)}`);
  }

  const next = structuredClone(program);
  const applied = mutate(next, act);
  if ('reason' in applied) return refuse(program, applied.reason);

  const after = validateProgram(next, profile, pack);
  if (!after.valid) return refuse(program, `the edit would make the program invalid: ${say(after.issues)}`);

  const cost = after.budget!.cost - before.budget!.cost;

  // Provenance is appended after validation rather than before it. It lives under `meta`, which the
  // program schema declares inert and which the resolver and the budget never read, so the program
  // that gets returned draws exactly the program that was just validated.
  if (next['meta'] === undefined) next['meta'] = {};
  const meta = next['meta'] as Record<string, unknown>;
  if (meta['provenance'] === undefined) meta['provenance'] = [];
  (meta['provenance'] as unknown[]).push({
    ...act,
    before: applied.before,
    after: applied.after,
    estimatedCost: cost,
  });

  return { nextProgram: next, changedNodeIds: applied.changedNodeIds, cost, valid: true };
}

// --- the individual edits ---------------------------------------------------------------------

function mutate(next: Program, act: EditAction): Applied {
  const root = next['root'] as TreeNode;

  switch (act.kind) {
    case 'add_node': {
      // `targets` names the receiving group: an add addresses the place the node lands, because the
      // node it creates does not exist in the program yet.
      const parentId = act.parent!;
      if (act.targets.length !== 1 || act.targets[0] !== parentId) {
        return { reason: `add_node targets must be exactly the receiving group ["${parentId}"]` };
      }
      const seat = container(root, parentId);
      if ('reason' in seat) return seat;

      // The caller supplies the rngKey; it is never derived from actionId. An rngKey is a node's
      // permanent identity as a mark-maker, so deriving it from whichever action happened to insert
      // the node would mean the same node added twice -- or deleted and put back -- came out looking
      // different. That is the property this whole layer exists to protect.
      const missing = missingRngKeys(act.node);
      if (missing.length) {
        return { reason: `add_node must carry an rngKey for every drawing node it inserts; missing on ${missing.join(', ')}` };
      }

      const kids = seat.node.children!;
      const index = act.index ?? kids.length;
      if (index > kids.length) {
        return { reason: `index ${index} is past the end of "${parentId}", which has ${kids.length} children` };
      }
      kids.splice(index, 0, structuredClone(act.node) as TreeNode);
      return { changedNodeIds: subtreeIds(act.node), before: null, after: act.node };
    }

    case 'delete_node': {
      const hit = only(root, act);
      if ('reason' in hit) return hit;
      if (!hit.parent) return { reason: 'the root cannot be deleted; a program is always a tree' };
      const ids = subtreeIds(hit.node);
      // The whole removed subtree is the `before`, so a delete can be read back out of provenance
      // and undone by an add_node.
      const removed = hit.parent.children!.splice(hit.index, 1)[0];
      return { changedNodeIds: ids, before: removed, after: null };
    }

    case 'set_arg': {
      const hit = only(root, act);
      if ('reason' in hit) return hit;
      const args = hit.node.args;
      if (!args) return { reason: `"${hit.node.id}" is a ${hit.node.type} and has no args to set` };
      const slot = resolveSlot(args, act.path!);
      if (!slot) return { reason: `"${act.path}" does not exist in the args of "${hit.node.id}"` };
      const was = read(slot);
      if (!sameShape(was, act.value)) {
        return { reason: `set_arg replaces a value in place: "${act.path}" holds ${describe(was)} but the action offers ${describe(act.value)}` };
      }
      write(slot, structuredClone(act.value));
      return { changedNodeIds: [hit.node.id], before: was, after: act.value };
    }

    case 'set_transform': {
      const hit = only(root, act);
      if ('reason' in hit) return hit;
      // Only groups carry a transform: an op's position lives in its own args, so that moving a
      // shape and moving a whole arrangement stay distinguishable edits.
      if (hit.node.type !== 'group') {
        return { reason: `"${hit.node.id}" is a ${hit.node.type}; only a group carries a transform` };
      }
      const was = hit.node.transform ?? null;
      hit.node.transform = structuredClone(act.transform);
      return { changedNodeIds: subtreeIds(hit.node), before: was, after: act.transform };
    }

    case 'set_style': {
      const hit = only(root, act);
      if ('reason' in hit) return hit;
      const args = hit.node.args;
      if (!args || args['style'] === undefined) {
        return { reason: `"${hit.node.id}" has no style to set` };
      }
      const was = args['style'];
      args['style'] = structuredClone(act.style);
      return { changedNodeIds: [hit.node.id], before: was, after: act.style };
    }

    case 'reparent_node': {
      const hit = only(root, act);
      if ('reason' in hit) return hit;
      if (!hit.parent) return { reason: 'the root cannot be reparented' };
      const seat = container(root, act.parent!);
      if ('reason' in seat) return seat;
      if (subtreeIds(hit.node).includes(seat.node.id)) {
        return { reason: `"${seat.node.id}" is inside "${hit.node.id}", so reparenting there would not leave a tree` };
      }
      const from = { parent: hit.parent.id, index: hit.index };
      hit.parent.children!.splice(hit.index, 1);
      // Indices are read after the removal, so reordering inside one parent means what it looks like.
      const kids = seat.node.children!;
      const index = act.index ?? kids.length;
      if (index > kids.length) {
        return { reason: `index ${index} is past the end of "${seat.node.id}", which has ${kids.length} children` };
      }
      kids.splice(index, 0, hit.node);
      return { changedNodeIds: subtreeIds(hit.node), before: from, after: { parent: seat.node.id, index } };
    }

    case 'wrap_group': {
      const hits: Found[] = [];
      for (const id of act.targets) {
        const hit = find(root, id);
        if (!hit) return { reason: `no node "${id}" in the program` };
        if (!hit.parent) return { reason: 'the root cannot be wrapped' };
        hits.push(hit);
      }
      const parent = hits[0]!.parent!;
      if (hits.some((h) => h.parent !== parent)) {
        return { reason: 'wrap_group can only wrap siblings, and these targets do not share a parent' };
      }
      // Contiguous, so wrapping cannot quietly restack the picture: paint order is program order.
      const at = hits.map((h) => h.index).sort((a, b) => a - b);
      if (at[at.length - 1]! - at[0]! !== at.length - 1) {
        return { reason: `wrap_group needs contiguous siblings; ${act.targets.join(', ')} sit at indices ${at.join(', ')}` };
      }
      const first = at[0]!;
      const taken = parent.children!.splice(first, at.length);
      const wrapper: TreeNode = { id: act.groupId!, type: 'group', children: taken };
      if (act.transform) wrapper.transform = structuredClone(act.transform);
      parent.children!.splice(first, 0, wrapper);
      return {
        changedNodeIds: [wrapper.id, ...taken.flatMap(subtreeIds)],
        before: { parent: parent.id, index: first },
        after: { parent: parent.id, index: first, groupId: wrapper.id, wrapped: act.targets.length },
      };
    }

    case 'duplicate_as_repeat': {
      const hit = only(root, act);
      if ('reason' in hit) return hit;
      if (!hit.parent) return { reason: 'the root cannot be turned into a repeat' };
      // The repeat's id is derived rather than asked for: `groupId` belongs to wrap_group, and a
      // derived id keeps the new node findable from the one it repeats. A collision is caught by the
      // duplicate-id check like any other.
      const repeat: TreeNode = {
        id: `${hit.node.id}.repeat`,
        type: 'repeat',
        rngKey: act.rngKey!,
        count: act.count!,
        layout: structuredClone(act.layout),
        children: [hit.node],
      };
      if (act.jitter) repeat['jitter'] = structuredClone(act.jitter);
      parentChildren(hit)[hit.index] = repeat;
      // The wrapped node keeps its own rngKey, and instance 0 of a repeat derives the same seed a
      // lone node does, so the first instance still makes the marks it made before.
      return {
        changedNodeIds: [repeat.id, ...subtreeIds(hit.node)],
        before: { parent: hit.parent.id, index: hit.index, count: 1 },
        after: { id: repeat.id, count: act.count },
      };
    }
  }
}

// --- tree helpers -----------------------------------------------------------------------------

interface Found {
  node: TreeNode;
  parent: TreeNode | null;
  index: number;
}

function find(node: TreeNode, id: string, parent: TreeNode | null = null, index = -1): Found | null {
  if (node.id === id) return { node, parent, index };
  const kids = node.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    const hit = find(kids[i]!, id, node, i);
    if (hit) return hit;
  }
  return null;
}

function parentChildren(hit: Found): TreeNode[] {
  return hit.parent!.children!;
}

/** The single node an action addresses. Kinds that name one target all check it the same way. */
function only(root: TreeNode, act: EditAction): Found | { reason: string } {
  if (act.targets.length !== 1) {
    return { reason: `${act.kind} addresses exactly one node, but targets names ${act.targets.length}` };
  }
  const id = act.targets[0]!;
  return find(root, id) ?? { reason: `no node "${id}" in the program` };
}

function container(root: TreeNode, id: string): Found | { reason: string } {
  const hit = find(root, id);
  if (!hit) return { reason: `no node "${id}" in the program` };
  if (!CONTAINERS.has(hit.node.type)) {
    return { reason: `"${id}" is a ${hit.node.type} and has no children; only a group or a repeat can receive a node` };
  }
  return hit;
}

function subtreeIds(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as TreeNode;
  const ids = typeof n.id === 'string' ? [n.id] : [];
  for (const kid of Array.isArray(n.children) ? n.children : []) ids.push(...subtreeIds(kid));
  return ids;
}

function missingRngKeys(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as TreeNode;
  const out = NEEDS_RNG_KEY.has(n.type) && typeof n.rngKey !== 'string' ? [`"${String(n.id)}"`] : [];
  for (const kid of Array.isArray(n.children) ? n.children : []) out.push(...missingRngKeys(kid));
  return out;
}

// --- set_arg paths ----------------------------------------------------------------------------

/** A place a value already sits: the thing holding it and the key it is held under. */
interface Slot {
  holder: Record<string, unknown> | unknown[];
  key: string;
}

function resolveSlot(args: Record<string, unknown>, path: string): Slot | null {
  const parts = path.split('.');
  let cur: unknown = args;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return null;
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(cur)) {
    const i = Number(last);
    return Number.isInteger(i) && i >= 0 && i < cur.length ? { holder: cur, key: last } : null;
  }
  if (cur && typeof cur === 'object' && last in cur) return { holder: cur as Record<string, unknown>, key: last };
  return null;
}

function read(slot: Slot): unknown {
  return Array.isArray(slot.holder) ? slot.holder[Number(slot.key)] : slot.holder[slot.key];
}

function write(slot: Slot, value: unknown): void {
  if (Array.isArray(slot.holder)) slot.holder[Number(slot.key)] = value;
  else slot.holder[slot.key] = value;
}

/**
 * "The same shape as what it replaces", per edit.schema.json: same primitive type, or arrays of the
 * same length holding the same shapes, or objects with the same keys. Swapping a rect region for a
 * circle is a different edit -- delete and add it, or use set_style for the whole style union.
 */
function sameShape(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameShape(item, b[i]));
  }
  if (typeof a === 'object' || typeof b === 'object') {
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return typeof a === typeof b;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return `an object {${Object.keys(value as object).join(', ')}}`;
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

function say(issues: Issue[]): string {
  return issues.map((i) => `${i.path}: ${i.message} [${i.code}]`).join('; ');
}

function refuse(program: Program, reason: string): EditResult {
  return { nextProgram: program, changedNodeIds: [], cost: 0, valid: false, reason };
}
