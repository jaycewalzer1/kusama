// Compile intentional samples into native Kusama program decisions. Raw embeddings and source
// pixels stop at this boundary; the renderer sees only ordinary groups, ops, palettes and rngKeys.

import { createHash } from 'node:crypto';
import { canonicalJson, contentHash } from '../env/canonical.js';
import type {
  CompiledInfluenceConstraint,
  SampleChannel,
  SamplingCompilation,
  SamplingPlan,
  SelectedSample,
} from './sample-types.js';

type AnyNode = Record<string, any>;
type Program = Record<string, any>;

const SUPPORTED = new Set<SampleChannel>([
  'composition', 'scale_relation', 'spatial_density', 'negative_space', 'silhouette', 'motif',
  'gesture', 'gaze_or_direction', 'palette', 'value_structure', 'edge_language', 'mark_rhythm', 'texture',
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function nodes(root: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  const visit = (node: AnyNode) => {
    out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(root);
  return out;
}

function target(program: Program, name: string): AnyNode | undefined {
  return nodes(program.root).find((node) => node.meta?.samplingTarget === name);
}

function safeId(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, '-');
  return clean.length <= 48 ? clean : `${clean.slice(0, 27)}-${createHash('sha256').update(clean).digest('hex').slice(0, 12)}`;
}

function own(node: AnyNode, sample: SelectedSample, channel: SampleChannel, effect: string): void {
  node.meta = {
    ...(node.meta ?? {}),
    derivedFromSampleId: sample.sampleId,
    channels: [...new Set([...(node.meta?.channels ?? []), channel])],
    application: sample.transformation,
    claimedEffect: effect,
  };
}

function constraint(sample: SelectedSample, channel: SampleChannel, before: unknown, after: unknown, affected: string[], effect: string, magnitude: number, scope?: 'local' | 'global'): CompiledInfluenceConstraint {
  return {
    constraintId: `constraint_${createHash('sha256').update(`${sample.sampleId}:${channel}`).digest('hex').slice(0, 18)}`,
    sampleId: sample.sampleId, derivedFromSampleId: sample.sampleId, channels: [channel],
    application: sample.transformation, claimedEffect: effect,
    scope: scope ?? (sample.controls.scope >= 0.65 ? 'global' : 'local'),
    before, after, affectedNodeIds: affected, magnitude, supported: true,
  };
}

/** Log-space extrapolation: +1 is 10x the source ratio; negative values compress multiplicatively. */
export function exaggeratedScaleRatio(sourceRatio: number, exaggeration: number): number {
  const source = Math.max(1.000001, sourceRatio);
  if (exaggeration === 0) return sourceRatio;
  return Math.exp(Math.log(source) + Math.max(-1, Math.min(1, exaggeration)) * Math.log(10));
}

function logBlend(a: number, b: number, t: number): number {
  return Math.exp(Math.log(Math.max(1e-6, a)) * (1 - t) + Math.log(Math.max(1e-6, b)) * t);
}

/** Transform verbs remain executable even when a caller edits them without changing the preset. */
function transformedExaggeration(sample: SelectedSample): number {
  const value = sample.controls.exaggeration;
  if (sample.transformation === 'compress') return -Math.max(0.15, Math.abs(value));
  if (sample.transformation === 'exaggerate') return value < 0 ? value : Math.max(0.15, value);
  if (sample.transformation === 'echo') return value * 0.35;
  if (sample.transformation === 'fragment') return value * 0.65;
  return value;
}

function transformedScope(sample: SelectedSample): number {
  if (sample.transformation === 'fragment') return sample.controls.scope * 0.45;
  if (sample.transformation === 'echo') return sample.controls.scope * 0.75;
  return sample.controls.scope;
}

function relationWeight(sample: SelectedSample): number {
  // Abstract use privileges the measured relationship; literal-looking colour transfer recedes.
  return 0.55 + 0.45 * sample.controls.abstraction;
}

function applyScale(program: Program, sample: SelectedSample): CompiledInfluenceConstraint {
  const referent = target(program, 'scale-referent');
  if (!referent) return unsupportedConstraint(sample, 'scale_relation', 'program has no node with meta.samplingTarget="scale-referent"');
  const f = sample.fragment.formalFeatures;
  // Without object segmentation, crop area is the crop configuration, not the size of the depicted
  // figure. Empty-space share is the honest deterministic proxy available for how isolated/small a
  // referent is in its context. It maps 0..1 to 4:1..100:1 and remains recorded as a proxy.
  const sourceRatio = 4 + 96 * f.negativeSpace ** 2;
  const baseRatio = Number(program.meta?.samplingBase?.scaleRatio ?? 50);
  const exaggeration = transformedExaggeration(sample);
  const basis = exaggeration > 0 ? Math.max(baseRatio, sourceRatio) : sourceRatio;
  let desired = exaggeratedScaleRatio(basis, exaggeration);
  if (sample.transformation === 'invert') desired = Math.max(1.000001, baseRatio ** 2 / desired);
  const targetRatio = logBlend(baseRatio, desired, sample.controls.salience * relationWeight(sample));
  const factor = Math.max(0.04, Math.min(5, baseRatio / targetRatio));
  const before = clone(referent.args ?? referent.transform ?? {});
  if (referent.args?.region?.w && referent.args.region.h) {
    const region = referent.args.region;
    const cx = region.x + region.w / 2;
    const bottom = region.y + region.h;
    region.w = Math.max(0.5, quantize(region.w * factor, 0.5));
    region.h = Math.max(0.5, quantize(region.h * factor, 0.5));
    region.x = quantize(cx - region.w / 2, 0.5); region.y = quantize(bottom - region.h, 0.5);
  } else if (referent.args?.span) {
    referent.args.span = Math.max(0.5, quantize(referent.args.span * factor, 0.5));
  } else {
    referent.transform = { ...(referent.transform ?? {}), scale: Math.max(0.01, quantize((referent.transform?.scale ?? 1) * factor, 0.01)) };
  }
  const effect = `change mountain-to-referent ratio from ${baseRatio.toFixed(1)}:1 toward ${targetRatio.toFixed(1)}:1 in log space`;
  own(referent, sample, 'scale_relation', effect);
  return constraint(sample, 'scale_relation', before, clone(referent.args ?? referent.transform ?? {}), [referent.id], effect, Math.abs(Math.log(targetRatio / baseRatio)));
}

function applyComposition(program: Program, sample: SelectedSample, channel: 'composition' | 'negative_space' | 'spatial_density' | 'silhouette'): CompiledInfluenceConstraint {
  const mass = target(program, 'primary-mass');
  if (!mass) return unsupportedConstraint(sample, channel, 'program has no node with meta.samplingTarget="primary-mass"');
  const before = clone(mass.args ?? mass.transform ?? {});
  const salience = sample.controls.salience * relationWeight(sample);
  const exaggeration = transformedExaggeration(sample);
  const f = sample.fragment.formalFeatures;
  let effect: string;
  if (channel === 'composition') {
    const canvas = program.canvas as { width: number; height: number };
    let [sourceX, sourceY] = f.saliencyCentroid;
    if (sample.transformation === 'invert') [sourceX, sourceY] = [1 - sourceX, 1 - sourceY];
    if (sample.transformation === 'counterpoint') [sourceX, sourceY] = [1 - sourceY, sourceX];
    const dx = (sourceX - 0.5) * canvas.width * 0.28 * salience * (1 + Math.max(0, exaggeration) * 2);
    const dy = (sourceY - 0.5) * canvas.height * 0.18 * salience * (1 + Math.max(0, exaggeration));
    mass.transform = { ...(mass.transform ?? {}), translate: [quantize(dx, 0.5), quantize(dy, 0.5)] };
    effect = `transpose source saliency centroid into primary-mass displacement (${dx.toFixed(1)}, ${dy.toFixed(1)})`;
  } else {
    const extreme = channel === 'negative_space' ? 0.96 : channel === 'spatial_density' ? 0.92 : 0.88;
    let sourceValue = channel === 'negative_space' ? f.negativeSpace : channel === 'spatial_density' ? f.spatialDensity : f.edgeDensity;
    if (sample.transformation === 'invert') sourceValue = 1 - sourceValue;
    const pushed = exaggeration >= 0
      ? sourceValue + (extreme - sourceValue) * exaggeration
      : sourceValue * (1 + 0.8 * exaggeration);
    const shrink = Math.max(0.42, 1 - salience * Math.max(0, pushed - 0.35) * (channel === 'silhouette' ? 0.3 : 0.55));
    mass.transform = { ...(mass.transform ?? {}), scale: Math.max(0.01, quantize((mass.transform?.scale ?? 1) * shrink, 0.01)) };
    effect = `${channel === 'negative_space' ? 'move occupied-area budget toward extreme empty space' : `transpose ${channel}`} at ${(pushed * 100).toFixed(1)}% measured intensity`;
  }
  own(mass, sample, channel, effect);
  return constraint(sample, channel, before, clone(mass.args ?? mass.transform ?? {}), [mass.id], effect, salience * (1 + Math.abs(exaggeration)));
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  return m ? [Number.parseInt(m[1]!.slice(0, 2), 16), Number.parseInt(m[1]!.slice(2, 4), 16), Number.parseInt(m[1]!.slice(4, 6), 16)] : null;
}

function hex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function blend(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return a.map((v, i) => v + (b[i]! - v) * t) as [number, number, number];
}

function labToRgb([l, a, b]: [number, number, number]): [number, number, number] {
  const fy = (l + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const inv = (v: number) => v ** 3 > 0.008856 ? v ** 3 : (v - 16 / 116) / 7.787;
  const x = 0.95047 * inv(fx), y = inv(fy), z = 1.08883 * inv(fz);
  let r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  let g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  let blue = 0.0557 * x - 0.204 * y + 1.057 * z;
  const gamma = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return [gamma(r), gamma(g), gamma(blue)];
}

function applyColor(program: Program, sample: SelectedSample, channel: 'palette' | 'value_structure'): CompiledInfluenceConstraint {
  if (!program.palette || typeof program.palette !== 'object') return unsupportedConstraint(sample, channel, 'program has no palette');
  const keys = Object.keys(program.palette).sort();
  const scope = transformedScope(sample);
  const amount = sample.controls.salience * (0.16 + 0.6 * scope) * (1 - 0.35 * sample.controls.abstraction);
  const take = Math.max(1, Math.ceil(keys.length * scope));
  const chosen = keys.slice(0, take);
  const before = Object.fromEntries(chosen.map((key) => [key, program.palette[key]]));
  let source = sample.fragment.formalFeatures.dominantColorsLab[0]
    ? labToRgb(sample.fragment.formalFeatures.dominantColorsLab[0])
    : [90, 105, 120] as [number, number, number];
  if (sample.transformation === 'invert') source = source.map((value) => 255 - value) as [number, number, number];
  const exaggeration = transformedExaggeration(sample);
  for (const key of chosen) {
    const current = parseHex(program.palette[key]);
    if (!current) continue;
    if (channel === 'palette') program.palette[key] = hex(blend(current, source, amount));
    else {
      const mean = (current[0] + current[1] + current[2]) / 3;
      const factor = exaggeration >= 0
        ? 1 + exaggeration * 2.5
        : 1 + exaggeration * 0.85;
      const adjusted = current.map((v) => 128 + (v - 128) * factor) as [number, number, number];
      program.palette[key] = hex(blend(current, adjusted.map((v) => (v + mean) / 2) as [number, number, number], amount));
    }
  }
  const affected = nodes(program.root).filter((node) => chosen.includes(node.args?.color) || chosen.includes(node.args?.style?.color)).map((node) => node.id);
  const effect = channel === 'palette'
    ? `transpose source dominant Lab colour into ${chosen.length} palette decision(s)`
    : `${exaggeration < 0 ? 'compress' : 'expand'} value separation across ${chosen.length} palette decision(s)`;
  for (const node of nodes(program.root).filter((node) => affected.includes(node.id))) own(node, sample, channel, effect);
  return constraint(sample, channel, before, Object.fromEntries(chosen.map((key) => [key, program.palette[key]])), affected, effect, amount, 'global');
}

function applyRhythm(program: Program, sample: SelectedSample, channel: 'mark_rhythm' | 'gesture' | 'gaze_or_direction' | 'edge_language' | 'texture' | 'motif'): CompiledInfluenceConstraint {
  const root = program.root as AnyNode;
  if (!Array.isArray(root.children)) return unsupportedConstraint(sample, channel, 'program root is not a group');
  const canvas = program.canvas as { width: number; height: number; ground: string };
  const salience = sample.controls.salience * relationWeight(sample);
  const scope = transformedScope(sample);
  const exaggeration = transformedExaggeration(sample);
  const count = Math.max(1, Math.round(1 + 10 * scope * Math.sqrt(salience) + 15 * Math.max(0, exaggeration) * salience));
  const baseAngle = sample.fragment.formalFeatures.dominantDirectionalFlow;
  let angle = baseAngle + (90 - baseAngle) * Math.max(0, exaggeration);
  if (sample.transformation === 'invert') angle = 180 - angle;
  if (sample.transformation === 'counterpoint') angle = (angle + 90) % 180;
  const radians = angle * Math.PI / 180;
  const length = canvas.height * (0.08 + 0.58 * scope) * (1 + Math.max(0, exaggeration));
  const colour = hex(blend(parseHex(canvas.ground) ?? [245, 245, 245], [25, 31, 42], Math.max(0.04, salience * 0.72)));
  const prefix = safeId(`sampling-${sample.sampleId}-${channel}`);
  const children: AnyNode[] = [];
  for (let i = 0; i < count; i++) {
    const u = (i + 1) / (count + 1);
    const x = canvas.width * (0.08 + 0.84 * u);
    const y = canvas.height * (0.2 + 0.55 * ((i * 0.61803398875) % 1));
    const half = length / 2;
    children.push({
      id: safeId(`${prefix}-${i}`), type: 'op', op: 'stroke', rngKey: safeId(`sample-${sample.sampleId}-${channel}-${i}`),
      args: {
        points: [
          [quantize(Math.max(0, Math.min(canvas.width, x - Math.cos(radians) * half)), 0.5), quantize(Math.max(0, Math.min(canvas.height, y + Math.sin(radians) * half)), 0.5)],
          [quantize(Math.max(0, Math.min(canvas.width, x + Math.cos(radians) * half)), 0.5), quantize(Math.max(0, Math.min(canvas.height, y - Math.sin(radians) * half)), 0.5)],
        ],
        brush: 'charcoal', color: colour, weight: Math.max(0.1, quantize(0.15 + salience * 2.8, 0.1)), curve: channel === 'gesture' ? 0.65 : 0,
      },
      meta: { derivedFromSampleId: sample.sampleId, channels: [channel], application: sample.transformation,
        claimedEffect: `native ${channel} marks; no source pixels` },
    });
  }
  const group: AnyNode = {
    id: prefix, type: 'group', children,
    meta: { derivedFromSampleId: sample.sampleId, channels: [channel], application: sample.transformation,
      claimedEffect: `transpose measured direction ${angle.toFixed(1)} degrees into ${count} native marks` },
  };
  root.children.push(group);
  const effect = `${channel === 'motif' ? 'adapt a motif as' : 'transpose source rhythm into'} ${count} native marks at ${angle.toFixed(1)}°; no source pixels`;
  return constraint(sample, channel, null, clone(group), children.map((node) => node.id), effect, count * salience);
}

function unsupportedConstraint(sample: SelectedSample, channel: SampleChannel, reason: string): CompiledInfluenceConstraint {
  return {
    constraintId: `constraint_${createHash('sha256').update(`${sample.sampleId}:${channel}`).digest('hex').slice(0, 18)}`,
    sampleId: sample.sampleId, derivedFromSampleId: sample.sampleId, channels: [channel], application: sample.transformation,
    claimedEffect: 'not applied', scope: sample.controls.scope >= 0.65 ? 'global' : 'local', before: null, after: null,
    affectedNodeIds: [], magnitude: 0, supported: false, unsupportedReason: reason,
  };
}

function applyChannel(program: Program, sample: SelectedSample, channel: SampleChannel): CompiledInfluenceConstraint {
  if (!SUPPORTED.has(channel)) return unsupportedConstraint(sample, channel, `no native compiler for ${channel}`);
  if (channel === 'scale_relation') return applyScale(program, sample);
  if (channel === 'composition' || channel === 'negative_space' || channel === 'spatial_density' || channel === 'silhouette') {
    return applyComposition(program, sample, channel);
  }
  if (channel === 'palette' || channel === 'value_structure') return applyColor(program, sample, channel);
  return applyRhythm(program, sample, channel as 'mark_rhythm' | 'gesture' | 'gaze_or_direction' | 'edge_language' | 'texture' | 'motif');
}

export function compileSamplingPlan(baseProgram: Record<string, unknown>, plan: SamplingPlan, disabled: Iterable<string> = []): SamplingCompilation {
  const program = clone(baseProgram) as Program;
  const disabledSet = new Set(disabled);
  const constraints: CompiledInfluenceConstraint[] = [];
  const provenance: SamplingCompilation['provenance'] = [];
  for (const sample of plan.samples) {
    const request = plan.requests.find((r) => r.requestId === sample.requestId);
    if (!request) throw new Error(`${sample.sampleId} names missing request ${sample.requestId}`);
    if (!sample.enabled || disabledSet.has(sample.sampleId) || sample.controls.salience === 0) {
      provenance.push({ commissionGoal: plan.goal, request, candidates: sample.candidates, chosenFragment: sample.fragment,
        transformation: sample.transformation, constraints: [], affectedProgramNodes: [] });
      continue;
    }
    if (sample.mode === 'literal_fragment') {
      const c = unsupportedConstraint(sample, sample.channels[0]!, 'literal_fragment is explicit but unsupported: no CC0 raster asset-pack adapter is configured');
      constraints.push(c);
      provenance.push({ commissionGoal: plan.goal, request, candidates: sample.candidates, chosenFragment: sample.fragment,
        transformation: sample.transformation, constraints: [c], affectedProgramNodes: [] });
      continue;
    }
    const applied = sample.channels.map((channel) => applyChannel(program, sample, channel));
    constraints.push(...applied);
    provenance.push({
      commissionGoal: plan.goal, request, candidates: sample.candidates, chosenFragment: sample.fragment,
      transformation: sample.transformation, constraints: applied,
      affectedProgramNodes: [...new Set(applied.flatMap((c) => c.affectedNodeIds))],
    });
  }
  const actual = constraints.filter((c) => c.supported && canonicalJson(c.before) !== canonicalJson(c.after));
  if (actual.length > 0) {
    program.meta = {
      ...(program.meta ?? {}),
      sampling: {
        planId: plan.planId,
        indexId: plan.indexId,
        disabledSampleIds: [...disabledSet].sort(),
        applications: actual.map((c) => ({
          derivedFromSampleId: c.sampleId, channels: c.channels, application: c.application,
          claimedEffect: c.claimedEffect, affectedNodeIds: c.affectedNodeIds, magnitude: c.magnitude,
        })),
      },
      provenance: { samplingPlanId: plan.planId, records: provenance },
    };
  }
  return {
    program,
    baseProgramHash: contentHash(baseProgram),
    compiledProgramHash: contentHash(program),
    constraints,
    unsupported: constraints.filter((c) => !c.supported).map((c) => ({ sampleId: c.sampleId, channel: c.channels[0]!, reason: c.unsupportedReason! })),
    provenance,
    disabledSampleIds: [...disabledSet].sort(),
  };
}

/** A native, deterministic base whose named targets make sample effects inspectable and reversible. */
export function mountainBaseProgram(seed = 42): Record<string, unknown> {
  return {
    version: '0.2', profile: 'default-v1', assetPack: 'core-v1', seed,
    canvas: { width: 720, height: 900, ground: '#ebe9e2', brushScale: 1.25 },
    palette: { ink: '#171b22', mountain: '#4b5663', atmosphere: '#aeb9c0', snow: '#d9dcda' },
    meta: { samplingBase: { scaleRatio: 50 }, note: 'Native base for the 100,000-foot mountain sampling demo.' },
    root: {
      id: 'root', type: 'group', children: [
        {
          id: 'atmosphere', type: 'op', op: 'wash', rngKey: 'mountain-atmosphere',
          args: { region: { type: 'rect', x: 0, y: 0, w: 720, h: 900 },
            style: { kind: 'wash', color: 'atmosphere', opacity: 75, bleed: 0.08, texture: [0.35, 0.2] } },
          meta: { samplingTarget: 'atmosphere' },
        },
        {
          id: 'mountain', type: 'group', meta: { samplingTarget: 'primary-mass' }, children: [
            {
              id: 'mountain-mass', type: 'op', op: 'paint', rngKey: 'mountain-mass',
              args: { region: { type: 'polygon', points: [[40, 820], [110, 650], [205, 570], [350, 120], [465, 520], [610, 690], [690, 820]] },
                style: { kind: 'hatch', brush: '2B', color: 'mountain', spacing: 6, angle: 78, rand: 0.16, layers: 2 } },
            },
            {
              id: 'snow-line', type: 'op', op: 'stroke', rngKey: 'mountain-snow',
              args: { points: [[205, 570], [350, 120], [465, 520]], brush: 'charcoal', color: 'snow', weight: 7, curve: 0.2 },
            },
          ],
        },
        {
          id: 'figure', type: 'op', op: 'paint', rngKey: 'solitary-figure',
          args: { region: { type: 'rect', x: 573, y: 794, w: 6, h: 18 }, style: { kind: 'solid', color: 'ink', opacity: 255 } },
          meta: { samplingTarget: 'scale-referent' },
        },
        {
          id: 'ground-rule', type: 'op', op: 'rule', rngKey: 'ground-rule',
          args: { from: [0, 823], to: [720, 823], brush: 'charcoal', color: 'ink', weight: 1.2 },
        },
      ],
    },
  };
}
