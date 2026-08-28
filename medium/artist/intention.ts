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
import type {
  EdgeEstimate,
  EdgeType,
  ElementBinding,
  Intention,
  IntentionElement,
  IntentionEdge,
  Termination,
} from './types.js';

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

// --- bindings ------------------------------------------------------------------------------------

/**
 * The numbers measure.ts takes off the canonical image, by name.
 *
 * Written out rather than imported: `measure.ts` pulls in `env/browser.ts`, and putting a browser
 * behind this file would end the offline rescore that `reward.ts` depends on. This is a vocabulary,
 * not a measurement — nothing here reads a pixel. A test in artist-core holds the list against a
 * `RenderMetrics` literal so a rename in the aesthetic layer fails to compile rather than silently
 * turning every render-measure binding into a broken one.
 */
export const RENDER_MEASURES: ReadonlySet<string> = new Set([
  'inkDensity',
  'coverage',
  'inkOffset',
  'symmetry.vertical',
  'symmetry.horizontal',
]);

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function refParts(ref: string): string[] {
  return ref.split(/[\s,]+/).filter((s) => s.length > 0);
}

/** `x,y,w,h`. Null when the ref is not four finite numbers enclosing a positive area. */
function parseRect(ref: string): Rect | null {
  const parts = refParts(ref).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The binding an element declared, or the one implied by a trajectory recorded before bindings
 * existed.
 *
 * `locatable: false` said only "not the kind of thing the tree holds" and named no referent, which
 * is `absence` minus the obligation to say what is absent; `true` and the unstated default both
 * meant `node`. Reconstructing rather than defaulting to `node` matters: reading those old elements
 * as node-bound would mark every declared absence as a thing the artist failed to build.
 */
export function bindingOf(element: IntentionElement): ElementBinding {
  if (element.binding) return element.binding;
  return element.locatable === false ? { kind: 'absence', ref: element.role } : { kind: 'node' };
}

/**
 * `points-at-nodes` — the tree is the right place to look, so carry on to the tree gate.
 * `judge`       — this element is genuinely not in the tree and never could be.
 * `broken`      — it claims to point at something that does not exist. Not the same as absent.
 */
interface BindingVerdict {
  kind: 'points-at-nodes' | 'judge' | 'broken';
  why: string;
}

function resolveBinding(element: IntentionElement, intention: Intention): BindingVerdict {
  const binding = bindingOf(element);
  const ref = binding.ref?.trim() ?? '';
  switch (binding.kind) {
    case 'node':
      return { kind: 'points-at-nodes', why: '' };
    case 'region':
      return parseRect(ref) === null
        ? { kind: 'broken', why: `${element.id} is bound to a region, but "${ref}" is not x,y,w,h` }
        : { kind: 'points-at-nodes', why: '' };
    case 'ratio': {
      const ids = refParts(ref);
      if (ids.length < 2) {
        return { kind: 'broken', why: `${element.id} is a ratio, but "${ref}" names fewer than two elements` };
      }
      const undeclared = ids.filter((id) => !intention.elements.some((e) => e.id === id));
      if (undeclared.length > 0) {
        return { kind: 'broken', why: `${element.id} is a ratio over elements the intention never declares: ${undeclared.join(' ')}` };
      }
      return { kind: 'judge', why: `${element.id} is a ratio between ${ids.join(' and ')}, which no node carries` };
    }
    case 'absence':
      return ref.length === 0
        ? { kind: 'broken', why: `${element.id} is an absence that does not say what is absent` }
        : { kind: 'judge', why: `${element.id} is the deliberate absence of ${ref}` };
    case 'render-measure':
      return RENDER_MEASURES.has(ref)
        ? { kind: 'judge', why: `${element.id} is a property of the printed image (${ref}), not of the tree` }
        : {
            kind: 'broken',
            why: `${element.id} is bound to "${ref}", which is not a measure this medium takes: ${[...RENDER_MEASURES].join(' ')}`,
          };
  }
}

/** Was one of this element's nodes actually written inside the rectangle it was promised to? */
function insideRegion(element: IntentionElement, rect: Rect, geo: NodeGeometry): boolean {
  return element.nodeIds.some((id) => {
    const xs = [...(geo.xs.get(id) ?? [])];
    const ys = [...(geo.ys.get(id) ?? [])];
    return (
      xs.some((x) => x >= rect.x && x <= rect.x + rect.w) && ys.some((y) => y >= rect.y && y <= rect.y + rect.h)
    );
  });
}

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

  // The type gate comes FIRST, before anything is asked of the tree. It used to come last, so an
  // edge whose endpoint had no node was reported `violated` even when its type was one this file
  // has already said it cannot decide — and, worse, was counted in `mechanical` and so pushed the
  // realization score down through a denominator it had no business being in. A `contradicts` edge
  // is undecidable whether or not its elements are in the tree; saying so is the honest order.
  if (!MECHANICAL.has(edge.type)) {
    return { ...base, status: 'judge-pending', evidence: `${edge.type} is not decidable from the tree: "${edge.claim}"` };
  }

  // Gate 2, before the tree is asked anything: does each endpoint's binding resolve? Some elements
  // are not the kind of thing that can own a node id. An absence (the missing logo that does the
  // work of the missing organisation) and a ratio (the size differential between two other
  // elements) are both real parts of a plan and neither can ever appear in `geo.ids`. Scoring them
  // `violated` for that punished the artist for declaring exactly the elements its position was
  // about, which is a reward-hacking incentive pointed at the thesis. They route to the judge.
  //
  // A binding whose referent does not exist is the opposite case and is kept apart from it. Broken
  // is checked before judge so that a plan claiming a ratio over an element it never declared is
  // scored as the broken plan it is, whichever end of the edge it sits on.
  //
  // None of this can be used to escape scoring: an intention whose edges are ALL judge-pending
  // scores `null`, never 1 (see `realization`), so binding everything away from the tree earns
  // nothing, and every non-node binding now has to name a referent that survives a check.
  const verdicts = [from, to].map((e) => resolveBinding(e, intention));
  const broken = verdicts.find((v) => v.kind === 'broken');
  if (broken) return { ...base, status: 'violated', evidence: broken.why };
  const judged = verdicts.find((v) => v.kind === 'judge');
  if (judged) return { ...base, status: 'judge-pending', evidence: judged.why };

  // Gate 3. A node-bound element with no node in the tree did not get made, whatever the edge claims.
  const missing = [...from.nodeIds, ...to.nodeIds].filter((id) => !geo.ids.has(id));
  if (from.nodeIds.length === 0 || to.nodeIds.length === 0 || missing.length > 0) {
    const which = from.nodeIds.length === 0 ? from.id : to.nodeIds.length === 0 ? to.id : missing.join(' ');
    return { ...base, status: 'violated', evidence: `not in the tree: ${which}` };
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
  /** Fraction of the elements bound to the sheet that actually landed on it. */
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
  // Only elements that COULD have been built are asked whether they were. An absence has not failed
  // to be made; there was never anything to make. A ratio and a render-measure likewise.
  const onSheet = intention.elements.filter((e) => {
    const kind = bindingOf(e).kind;
    return kind === 'node' || kind === 'region';
  });
  // A `region` binding is answered more strictly than a `node` one, and that asymmetry is the whole
  // reason the kind exists: promising a part of the picture to a named rectangle and then writing it
  // somewhere else is not the same as making it. Nodes present but outside the rectangle is unmade.
  const made = onSheet.filter((e) => {
    if (e.nodeIds.length === 0 || !e.nodeIds.every((id) => geo.ids.has(id))) return false;
    const binding = bindingOf(e);
    if (binding.kind !== 'region') return true;
    const rect = parseRect(binding.ref?.trim() ?? '');
    return rect !== null && insideRegion(e, rect, geo);
  });
  return {
    score: decidable.length === 0 ? null : satisfied / decidable.length,
    mechanical: decidable.length,
    satisfied,
    judgePending: estimates.length - decidable.length,
    elementsMade: onSheet.length === 0 ? 0 : made.length / onSheet.length,
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

// --- stopping ------------------------------------------------------------------------------------

/**
 * How the run stopped, decided against the plan rather than against the step counter.
 *
 * Lives here, beside the edge verdicts it reads, and is shared by `run.ts` and `reward.ts` rather
 * than written twice. The rescorer's whole claim is that every number is a function of the record; a
 * legitimacy rule implemented in two places is a rule that eventually becomes two rules, and the
 * disagreement would surface as a gate-2 failure blamed on the log.
 *
 * Read against `realization`'s tree verdicts and never against EXAMINE's. EXAMINE is the artist
 * grading its own picture, and a stopping rule scored off it would let the artist finish by saying
 * so twice.
 */
export function terminationOf(
  estimates: EdgeEstimate[],
  kind: Termination['kind'],
  declaredUnrealizable: string | null
): Termination {
  const unrealizedEdges = estimates.filter((e) => e.status === 'violated').map((e) => `${e.from}->${e.to}`);
  // Only a `finished` step's claim counts. A run that ran out of steps, or abandoned, is not making
  // the claim, and honouring the field there would let a timeout present itself as a decision.
  const named = kind === 'declared-finished' ? declaredUnrealizable : null;
  return {
    kind,
    edgesUnrealized: unrealizedEdges.length,
    unrealizedEdges,
    declaredUnrealizable: named,
    legitimate:
      kind === 'declared-finished' &&
      (unrealizedEdges.length === 0 ||
        (unrealizedEdges.length === 1 && named !== null && named === unrealizedEdges[0])),
  };
}

// --- drift ---------------------------------------------------------------------------------------

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return 1 - shared / (a.size + b.size - shared);
}

/**
 * An element's identity is its id and nothing else.
 *
 * This used to be `${id}:${role}`, which made drift a string diff over prose the artist rewrites on
 * every replan as a matter of course. On the run that exposed it, five replans kept all six element
 * ids and all seven edges — the plan's structure never moved once — and drift read 4.71 out of a
 * possible 5.0, which is what "the artist abandoned its plan five times" looks like. It had not.
 * A metric that cannot tell rewording from rethinking is measuring the writing.
 */
function elementKeys(i: Intention): Set<string> {
  return new Set(i.elements.map((e) => e.id));
}

function edgeKeys(i: Intention): Set<string> {
  return new Set(i.edges.map((e) => `${e.from}-${e.type}->${e.to}`));
}

/**
 * How far intention B sits from intention A structurally: 0 is the same parts wired the same way,
 * 1 shares nothing. Set distance over element ids and over edges, averaged.
 *
 * Purpose is deliberately NOT in here any more. It carried a flat 0.5 for any change at all, which
 * on a model that appends a sentence to its purpose every time it thinks meant the term was pinned
 * on for all but the first comparison and drift could never fall below 0.5. Purpose churn is a real
 * thing to want to know and it is now its own number — see `purposeChurn` — where it can be read
 * without being averaged into a claim about structure.
 */
export function drift(a: Intention, b: Intention): number {
  const structural = (jaccardDistance(elementKeys(a), elementKeys(b)) + jaccardDistance(edgeKeys(a), edgeKeys(b))) / 2;
  return Math.round(Math.min(1, structural) * 1000) / 1000;
}

/** Total structural drift across a replan history: the distance travelled, not first-to-last. */
export function totalDrift(intentions: Intention[]): number {
  let sum = 0;
  for (let i = 1; i < intentions.length; i++) sum += drift(intentions[i - 1]!, intentions[i]!);
  return Math.round(sum * 1000) / 1000;
}

/**
 * How many replans rewrote the stated purpose, and by how much the text grew. Reported, never
 * averaged into drift: an artist that restates its purpose in new words each step and an artist that
 * changes what the piece is for produce the same number here, and only a judge can separate them.
 */
export function purposeChurn(intentions: Intention[]): { changed: number; charsFirst: number; charsLast: number } {
  let changed = 0;
  for (let i = 1; i < intentions.length; i++) {
    if (intentions[i - 1]!.purpose.trim() !== intentions[i]!.purpose.trim()) changed++;
  }
  return {
    changed,
    charsFirst: intentions[0]?.purpose.length ?? 0,
    charsLast: intentions[intentions.length - 1]?.purpose.length ?? 0,
  };
}

/**
 * Did any version of the plan name a convention to break?
 *
 * A declaration, and reported as one. `riskMoveTaken` is the outcome, and the two are deliberately
 * separate numbers: declaring a risk and never taking it is the cheapest way for an agreeable model
 * to look bold, and a single number cannot show that case in either direction. Read across the whole
 * replan history, so a risk planned and then quietly replanned away still counts as declared.
 */
export function riskDeclared(intentions: Intention[]): boolean {
  return intentions.some((i) => i.riskMove !== null);
}
