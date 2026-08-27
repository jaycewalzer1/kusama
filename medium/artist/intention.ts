// Did the plan happen, and how far did the plan move?
//
// The Intention is a graph, not a paragraph, for exactly one reason: a paragraph can only be graded
// by a judge, and there is no judge. A graph over named elements that carry node ids can be held
// against the tree arithmetically. Two of the five edge types are decided here mechanically; the
// other three are honestly reported `judge-pending` rather than guessed, because guessing them would
// let a trajectory score well for a relationship nobody checked.
//
// Pure. No renders, no model calls, so `reward.ts` recomputes all of this from the log.

import { treeFacts } from '../aesthetic/facts.js';
import type { EdgeEstimate, EdgeType, Intention, IntentionEdge } from './types.js';

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every node id present in a tree, and the numbers each one carries in its own args. */
interface NodeGeometry {
  ids: Set<string>;
  /** id -> the x-ish and y-ish numbers found directly in that node's args, rounded to 1 unit. */
  xs: Map<string, Set<number>>;
  ys: Map<string, Set<number>>;
}

const X_KEYS = new Set(['x', 'cx', 'x1', 'x2', 'left']);
const Y_KEYS = new Set(['y', 'cy', 'y1', 'y2', 'top', 'baseline']);

/**
 * Reads coordinates out of the source tree, not the resolved one, for the same reason facts.ts does:
 * purity is what makes this cheap enough to run on every candidate. The cost is real and named — a
 * node inside a transformed group reports its untransformed coordinate, so `aligned-to` is a claim
 * about the numbers the artist wrote, not about where the ink landed. That is the honest reading of
 * an artist's intention anyway: it planned the number.
 */
function geometry(program: unknown): NodeGeometry {
  const geo: NodeGeometry = { ids: new Set(), xs: new Map(), ys: new Map() };

  const walk = (node: unknown) => {
    if (!isDict(node)) return;
    const id = typeof node['id'] === 'string' ? node['id'] : undefined;
    if (id !== undefined) geo.ids.add(id);
    const args = isDict(node['args']) ? node['args'] : {};
    if (id !== undefined) {
      const addX = (n: number) => (geo.xs.get(id) ?? geo.xs.set(id, new Set()).get(id)!).add(Math.round(n));
      const addY = (n: number) => (geo.ys.get(id) ?? geo.ys.set(id, new Set()).get(id)!).add(Math.round(n));
      const collect = (source: Dict) => {
        for (const [k, v] of Object.entries(source)) {
          if (typeof v === 'number') {
            if (X_KEYS.has(k)) addX(v);
            if (Y_KEYS.has(k)) addY(v);
            continue;
          }
          // A point in this medium is the tuple [x, y] — `rule` and `stroke` are written entirely in
          // them, so a geometry that only reads named x/y keys can see no coordinates at all in a
          // line and calls every `aligned-to` involving one violated.
          if (Array.isArray(v)) {
            for (const p of v.length === 2 && typeof v[0] === 'number' ? [v] : v) {
              if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
                addX(p[0]);
                addY(p[1]);
              }
            }
          }
        }
      };
      collect(args);
      // A region sits one level down (`args.region.x`), and it is where most positions actually live.
      if (isDict(args['region'])) collect(args['region']);
    }
    const children = node['children'];
    if (Array.isArray(children)) for (const c of children) walk(c);
  };

  walk(isDict(program) ? program['root'] : undefined);
  return geo;
}

/** Marks and colours per node id, so `echoes` can ask whether two elements are made the same way. */
function signatures(program: unknown): Map<string, Set<string>> {
  const facts = treeFacts(program);
  const sig = new Map<string, Set<string>>();
  const add = (id: string, token: string) => (sig.get(id) ?? sig.set(id, new Set()).get(id)!).add(token);
  for (const m of facts.marks) {
    if (m.style !== undefined) add(m.nodeId, `style:${m.style}`);
    if (m.brush !== undefined) add(m.nodeId, `brush:${m.brush}`);
  }
  for (const c of facts.colors) add(c.nodeId, `color:${c.hex}`);
  return sig;
}

/** The union of one element's nodes' tokens. An element is the sum of the marks it is made of. */
function unionFor(ids: string[], per: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) for (const t of per.get(id) ?? []) out.add(t);
  return out;
}

function unionNumbers(ids: string[], per: Map<string, Set<number>>): Set<number> {
  const out = new Set<number>();
  for (const id of ids) for (const n of per.get(id) ?? []) out.add(n);
  return out;
}

/**
 * `aligned-to` and `echoes` are decided from the tree. The other three are not, and each is refused
 * for a reason worth stating rather than a shrug:
 *
 *   masked-by    needs occlusion. The medium knows paint order but not overlap, and the capability
 *                sheet says so outright. A `masked-by` decided on paint order alone would call a
 *                mark hidden that sits a thousand units away from the thing meant to hide it.
 *   contradicts  is a claim about meaning between two marks. Nothing in a JSON tree contradicts
 *                anything.
 *   answers      the same, plus a direction. If either of these could be decided mechanically they
 *                would be constraint kinds in the aesthetic layer already.
 */
const MECHANICAL: ReadonlySet<EdgeType> = new Set<EdgeType>(['aligned-to', 'echoes']);

export function estimateEdge(
  edge: IntentionEdge,
  intention: Intention,
  program: unknown,
  geo: NodeGeometry,
  sig: Map<string, Set<string>>
): EdgeEstimate {
  const base = { from: edge.from, to: edge.to, type: edge.type };
  const from = intention.elements.find((e) => e.id === edge.from);
  const to = intention.elements.find((e) => e.id === edge.to);

  if (!from || !to) {
    return { ...base, status: 'violated', evidence: 'edge names an element the intention does not declare' };
  }

  // An element with no node in the tree did not get made, whatever the edge claims about it.
  const missing = [...from.nodeIds, ...to.nodeIds].filter((id) => !geo.ids.has(id));
  if (from.nodeIds.length === 0 || to.nodeIds.length === 0 || missing.length > 0) {
    const which = from.nodeIds.length === 0 ? from.id : to.nodeIds.length === 0 ? to.id : missing.join(' ');
    return { ...base, status: 'violated', evidence: `not in the tree: ${which}` };
  }

  if (!MECHANICAL.has(edge.type)) {
    return { ...base, status: 'judge-pending', evidence: `${edge.type} is not decidable from the tree: "${edge.claim}"` };
  }

  if (edge.type === 'echoes') {
    const shared = [...unionFor(from.nodeIds, sig)].filter((t) => unionFor(to.nodeIds, sig).has(t)).sort();
    return shared.length > 0
      ? { ...base, status: 'satisfied', evidence: `shares ${shared.join(' ')}` }
      : { ...base, status: 'violated', evidence: 'no shared style, brush or colour' };
  }

  // aligned-to: the two elements were written on a common x or a common y.
  const sharedX = [...unionNumbers(from.nodeIds, geo.xs)].filter((n) => unionNumbers(to.nodeIds, geo.xs).has(n));
  const sharedY = [...unionNumbers(from.nodeIds, geo.ys)].filter((n) => unionNumbers(to.nodeIds, geo.ys).has(n));
  if (sharedX.length > 0) return { ...base, status: 'satisfied', evidence: `common x=${sharedX.sort((a, b) => a - b).join(',')}` };
  if (sharedY.length > 0) return { ...base, status: 'satisfied', evidence: `common y=${sharedY.sort((a, b) => a - b).join(',')}` };
  return { ...base, status: 'violated', evidence: 'no coordinate in common on either axis' };
}

export function estimateEdges(intention: Intention, program: unknown): EdgeEstimate[] {
  const geo = geometry(program);
  const sig = signatures(program);
  return intention.edges.map((e) => estimateEdge(e, intention, program, geo, sig));
}

export interface Realization {
  /** Satisfied over decidable. null when nothing was decidable — never 1. */
  score: number | null;
  mechanical: number;
  satisfied: number;
  judgePending: number;
  /** Fraction of declared elements that actually have a node in the final tree. */
  elementsMade: number;
  estimates: EdgeEstimate[];
}

/**
 * Realization is deliberately harsh in one specific way: an intention whose edges are all
 * `contradicts` scores `null`, not 1. An artist cannot earn a realization score by planning only
 * things nobody can check.
 */
export function realization(intention: Intention, program: unknown): Realization {
  const estimates = estimateEdges(intention, program);
  const decidable = estimates.filter((e) => e.status !== 'judge-pending');
  const satisfied = decidable.filter((e) => e.status === 'satisfied').length;
  const geo = geometry(program);
  const made = intention.elements.filter((e) => e.nodeIds.length > 0 && e.nodeIds.every((id) => geo.ids.has(id)));
  return {
    score: decidable.length === 0 ? null : satisfied / decidable.length,
    mechanical: decidable.length,
    satisfied,
    judgePending: estimates.length - decidable.length,
    elementsMade: intention.elements.length === 0 ? 0 : made.length / intention.elements.length,
    estimates,
  };
}

/**
 * A replanned intention, with the node ids the environment already knows about put back.
 *
 * `nodeIds` is a fact about the tree, not a claim the artist makes: it is filled in by the
 * environment when an edit says which element it serves. A replan that re-declares an element under
 * the same id is talking about the same part of the picture, so the nodes that part is made of
 * survive the change of plan. Without this, every replan would silently unmake everything built so
 * far and `realization` would measure how recently the artist last changed its mind.
 */
export function carryNodeIds(before: Intention, after: Intention): Intention {
  const fresh = declared(after);
  return {
    ...fresh,
    elements: fresh.elements.map((e) => {
      const was = before.elements.find((b) => b.id === e.id);
      return was ? { ...e, nodeIds: [...was.nodeIds] } : e;
    }),
  };
}

/**
 * An intention exactly as the policy stated it, with the environment's column blank.
 *
 * The CHOOSE and REPLAN schemas do not ask for `nodeIds`, so this normally just adds the empty
 * array the `Intention` type requires. It is a function rather than a spread because it is also the
 * one place that would drop a `nodeIds` a future schema let back in.
 */
export function declared(i: Intention): Intention {
  return { ...i, elements: i.elements.map((e) => ({ ...e, nodeIds: [] })) };
}

// --- drift ---------------------------------------------------------------------------------------

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return 1 - shared / (a.size + b.size - shared);
}

function elementKeys(i: Intention): Set<string> {
  return new Set(i.elements.map((e) => `${e.id}:${e.role}`));
}

function edgeKeys(i: Intention): Set<string> {
  return new Set(i.edges.map((e) => `${e.from}-${e.type}->${e.to}`));
}

/**
 * How far intention B sits from intention A: 0 is the same plan, 1 shares nothing. Set distance over
 * elements and over edges, averaged, plus a flat 0.5 if the stated purpose changed at all — because
 * a plan that keeps every element and every edge but is now for a different reason has drifted more
 * than any rearrangement of parts.
 */
export function drift(a: Intention, b: Intention): number {
  const structural = (jaccardDistance(elementKeys(a), elementKeys(b)) + jaccardDistance(edgeKeys(a), edgeKeys(b))) / 2;
  const purposeMoved = a.purpose.trim() === b.purpose.trim() ? 0 : 0.5;
  return Math.round(Math.min(1, structural + purposeMoved) * 1000) / 1000;
}

/** Total drift across a replan history: the distance actually travelled, not first-to-last. */
export function totalDrift(intentions: Intention[]): number {
  let sum = 0;
  for (let i = 1; i < intentions.length; i++) sum += drift(intentions[i - 1]!, intentions[i]!);
  return Math.round(sum * 1000) / 1000;
}
