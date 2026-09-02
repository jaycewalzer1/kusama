// Deterministic target discovery around the unchanged influence compiler.
//
// The renderer's resolver remains the authority on geometry. This module only aggregates its
// already-resolved leaf bounds, maps those facts back to source node ids, and synthesizes the same
// inert markers the compiler has always consumed.

import type { Bounds, ResolvedProgram } from '../renderer/resolve.js';
import type { SampleChannel, SamplingCompilation, SamplingPlan } from './sample-types.js';
import { compileSamplingPlan } from './sample-compiler.js';

type Node = Record<string, any>;
type Program = Record<string, any>;

export type SamplingBindings = Record<string, string[]>;
export type SamplingTargetRole = 'primary-mass' | 'scale-referent';

export interface SamplingResolvedProgram extends ResolvedProgram {
  /** Sampling-only source ancestry. It never reaches the renderer or a saved program. */
  samplingAncestors?: Record<string, string[]>;
  samplingRootSourceId?: string;
}

export interface TargetResolution {
  role: SamplingTargetRole;
  nodeIds: string[];
  measuredNodeIds: string[];
  resolvedBy: 'explicit' | 'structural';
  scaleRatio?: number;
}

export interface BindingValidation {
  valid: boolean;
  bindings: SamplingBindings;
  faults: string[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function walk(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node) => {
    out.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return out;
}

export function validateSamplingBindings(
  program: Record<string, unknown>,
  roles: ReadonlySet<string>,
  value: unknown
): BindingValidation {
  const faults: string[] = [];
  const bindings: SamplingBindings = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, bindings, faults: ['bindings must be an object'] };
  }
  const ids = new Set(walk((program as Program).root ?? {}).map((node) => String(node.id)));
  for (const [role, raw] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (!roles.has(role)) faults.push(`binding role "${role}" is not in the sampling plan`);
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === 'string')) {
      faults.push(`binding role "${role}" must contain one or more node IDs`);
      continue;
    }
    const nodeIds = raw as string[];
    if (new Set(nodeIds).size !== nodeIds.length) faults.push(`binding role "${role}" contains duplicate node IDs`);
    for (const id of nodeIds) if (!ids.has(id)) faults.push(`binding role "${role}" names missing node "${id}"`);
    bindings[role] = [...nodeIds];
  }
  return { valid: faults.length === 0, bindings, faults };
}

/** Attach raw-tree ancestry to exact resolved geometry without changing renderer/resolve.js. */
export function withSamplingAncestry(resolved: ResolvedProgram, program: Record<string, unknown>): SamplingResolvedProgram {
  const ancestry: Record<string, string[]> = {};
  const root = (program as Program).root as Node;
  const visit = (node: Node, parents: string[]) => {
    ancestry[String(node.id)] = [...parents];
    for (const child of node.children ?? []) visit(child, [...parents, String(node.id)]);
  };
  visit(root, []);
  return { ...resolved, samplingAncestors: ancestry, samplingRootSourceId: String(root.id) };
}

/** Bounding envelope of a geometric union. Null is the honest answer for an empty set. */
export function unionBounds(bounds: readonly Bounds[]): Bounds | null {
  if (bounds.length === 0) return null;
  const left = Math.min(...bounds.map((b) => b.x));
  const top = Math.min(...bounds.map((b) => b.y));
  const right = Math.max(...bounds.map((b) => b.x + b.w));
  const bottom = Math.max(...bounds.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Exact leaf bounds aggregated back to every source leaf, group, repeat, and macro id. */
export function aggregateResolvedNodeBounds(resolved: SamplingResolvedProgram): Record<string, Bounds> {
  const buckets = new Map<string, Bounds[]>();
  const add = (id: string, bounds: Bounds) => {
    const list = buckets.get(id) ?? [];
    list.push(bounds);
    buckets.set(id, list);
  };
  for (const leaf of resolved.nodes) {
    add(leaf.sourceId, leaf.bounds);
    for (const ancestor of resolved.samplingAncestors?.[leaf.sourceId] ?? []) add(ancestor, leaf.bounds);
    // Macro parts do not exist in the raw tree. `expandedFrom` is the resolved macro instance id;
    // its source id is available on the group table and lets repeated instances aggregate together.
    if (leaf.expandedFrom) {
      const group = resolved.groups.find((item) => item.id === leaf.expandedFrom);
      if (group) {
        add(group.sourceId, leaf.bounds);
        for (const ancestor of resolved.samplingAncestors?.[group.sourceId] ?? []) add(ancestor, leaf.bounds);
      }
    }
  }
  return Object.fromEntries(
    [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([id, values]) => {
        const bounds = unionBounds(values);
        return bounds ? [[id, bounds] as const] : [];
      })
  );
}

export function targetRoleForChannel(channel: SampleChannel): SamplingTargetRole | null {
  if (channel === 'scale_relation') return 'scale-referent';
  if (channel === 'composition' || channel === 'negative_space' || channel === 'spatial_density' || channel === 'silhouette') {
    return 'primary-mass';
  }
  return null;
}

/** Resolve only the two structural roles consumed by the existing compiler. */
export function resolveTargets(resolved: SamplingResolvedProgram, channel: SampleChannel): TargetResolution | null {
  const role = targetRoleForChannel(channel);
  if (!role) return null;
  const bounds = aggregateResolvedNodeBounds(resolved);
  const candidates = Object.entries(bounds)
    .filter(([id, b]) => id !== resolved.samplingRootSourceId && b.w > 0 && b.h > 0)
    .map(([id, b]) => ({ id, area: b.w * b.h }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (role === 'primary-mass') {
    const chosen = [...candidates].sort((a, b) => b.area - a.area || a.id.localeCompare(b.id))[0];
    return chosen ? { role, nodeIds: [chosen.id], measuredNodeIds: [chosen.id], resolvedBy: 'structural' } : null;
  }
  if (candidates.length < 2) return null;
  let best: { large: typeof candidates[number]; small: typeof candidates[number]; ratio: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!, b = candidates[j]!;
      const large = a.area > b.area || (a.area === b.area && a.id < b.id) ? a : b;
      const small = large === a ? b : a;
      const ratio = large.area / small.area;
      const pair = [large.id, small.id].sort().join('\u0000');
      const prior = best ? [best.large.id, best.small.id].sort().join('\u0000') : '';
      if (!best || ratio > best.ratio || (ratio === best.ratio && pair < prior)) best = { large, small, ratio };
    }
  }
  return best
    ? { role, nodeIds: [best.large.id], measuredNodeIds: [best.large.id, best.small.id], resolvedBy: 'structural', scaleRatio: best.ratio }
    : null;
}

function marker(program: Program, role: SamplingTargetRole): Node | undefined {
  return walk(program.root).find((node) => node.meta?.samplingTarget === role);
}

function mark(program: Program, role: SamplingTargetRole, ids: string[]): string[] {
  const wanted = new Set(ids);
  const nodes = walk(program.root);
  for (const node of nodes) {
    if (node.meta?.samplingTarget === role && !wanted.has(String(node.id))) {
      const { samplingTarget: _target, ...rest } = node.meta;
      node.meta = rest;
    }
    if (wanted.has(String(node.id))) node.meta = { ...(node.meta ?? {}), samplingTarget: role };
  }
  return nodes.filter((node) => wanted.has(String(node.id))).map((node) => String(node.id));
}

/** Clone a base and synthesize compiler inputs. The returned base is still never a compiled program. */
export function synthesizeSamplingTargets(
  baseProgram: Record<string, unknown>,
  plan: SamplingPlan,
  resolved: SamplingResolvedProgram
): { program: Record<string, unknown>; resolutions: TargetResolution[] } {
  const program = clone(baseProgram) as Program;
  const bindings = (program.meta?.samplingBindings ?? {}) as SamplingBindings;
  const resolutions: TargetResolution[] = [];
  const activeRequests = new Set(
    plan.samples
      .filter((sample) => sample.enabled && sample.controls.salience > 0)
      .map((sample) => sample.requestId)
  );
  for (const role of ['primary-mass', 'scale-referent'] as const) {
    const relevant = plan.requests.filter(
      (request) => activeRequests.has(request.requestId) && request.channels.some((channel) => targetRoleForChannel(channel) === role)
    );
    if (relevant.length === 0) continue;
    const bound = relevant.flatMap((request) => bindings[request.role] ?? []);
    if (bound.length > 0) {
      const marked = mark(program, role, [...new Set(bound)]);
      if (marked.length > 0) resolutions.push({ role, nodeIds: [marked[0]!], measuredNodeIds: marked, resolvedBy: 'explicit' });
      continue;
    }
    const existing = marker(program, role);
    if (existing) {
      resolutions.push({ role, nodeIds: [String(existing.id)], measuredNodeIds: [String(existing.id)], resolvedBy: 'explicit' });
      continue;
    }
    const channel = relevant[0]!.channels.find((item) => targetRoleForChannel(item) === role)!;
    const structural = resolveTargets(resolved, channel);
    if (!structural) continue;
    mark(program, role, structural.nodeIds);
    if (role === 'scale-referent' && structural.scaleRatio !== undefined) {
      program.meta = { ...(program.meta ?? {}), samplingBase: { ...(program.meta?.samplingBase ?? {}), scaleRatio: structural.scaleRatio } };
    }
    resolutions.push(structural);
  }
  return { program, resolutions };
}

/** Compile through synthesized markers, then add target provenance outside the unchanged compiler. */
export function compileWithSamplingTargets(
  baseProgram: Record<string, unknown>,
  plan: SamplingPlan,
  resolved: SamplingResolvedProgram,
  disabled: Iterable<string> = []
): { compilation: SamplingCompilation; resolutions: TargetResolution[]; preparedProgram: Record<string, unknown> } {
  const prepared = synthesizeSamplingTargets(baseProgram, plan, resolved);
  const compilation = compileSamplingPlan(prepared.program, plan, disabled);
  for (const constraint of compilation.constraints) {
    const channel = constraint.channels[0];
    if (!channel) continue;
    const role = targetRoleForChannel(channel);
    const resolution = role ? prepared.resolutions.find((item) => item.role === role) : undefined;
    if (resolution) {
      constraint.resolvedBy = resolution.resolvedBy;
      constraint.resolvedTargetNodeIds = [...resolution.nodeIds];
    }
  }
  for (const record of compilation.provenance) {
    record.rejections = (plan.rejections ?? []).filter((item) => item.requestId === record.request.requestId);
  }
  return { compilation, resolutions: prepared.resolutions, preparedProgram: prepared.program };
}
