import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedLeaf, ResolvedProgram } from '../../renderer/resolve.js';
import { aggregateResolvedNodeBounds, resolveTargets, unionBounds, type SamplingResolvedProgram } from '../sample-targets.js';

function leaf(id: string, sourceId: string, x: number, y: number, w: number, h: number, expandedFrom?: string): ResolvedLeaf {
  return {
    id, sourceId, op: 'paint', args: {}, world: [1, 0, 0, 1, 0, 0], rngKey: id, seedOffset: 0,
    instance: 0, seed: 1, clip: null, blend: null, decisions: [], bounds: { x, y, w, h }, expandedFrom,
  };
}

function resolved(): SamplingResolvedProgram {
  const base = {
    version: '0.2', profile: 'default-v1', assetPack: 'core-v1',
    canvas: { width: 100, height: 100, ground: '#ffffff', brushScale: 1 }, palette: {}, seed: 1, meta: {}, print: [],
    nodes: [
      leaf('mass-a', 'mass-a', 10, 10, 20, 20),
      leaf('mass-b', 'mass-b', 60, 60, 30, 30),
      leaf('tiny', 'tiny', 0, 0, 2, 2),
      leaf('macro/part', 'macro/part', 35, 40, 10, 5, 'macro'),
    ],
    groups: [
      { id: 'root', sourceId: 'root', type: 'group', world: [1, 0, 0, 1, 0, 0], clip: null, decisions: [] },
      { id: 'subject', sourceId: 'subject', type: 'group', world: [1, 0, 0, 1, 0, 0], clip: null, decisions: [] },
      { id: 'macro', sourceId: 'macro', type: 'macro', macro: 'motif', world: [1, 0, 0, 1, 0, 0], clip: null, decisions: [] },
    ],
    warnings: [], counts: { resolvedNodes: 4, repeatInstances: 0, groups: 3 },
  } satisfies ResolvedProgram;
  return {
    ...base,
    samplingRootSourceId: 'root',
    samplingAncestors: {
      'mass-a': ['root', 'subject'],
      'mass-b': ['root', 'subject'],
      tiny: ['root'],
      macro: ['root', 'subject'],
    },
  };
}

test('union and group/macro aggregation use exact descendant leaf bounds', () => {
  assert.deepEqual(unionBounds([{ x: 10, y: 5, w: 3, h: 4 }, { x: 2, y: 8, w: 4, h: 2 }]), { x: 2, y: 5, w: 11, h: 5 });
  const bounds = aggregateResolvedNodeBounds(resolved());
  assert.deepEqual(bounds.subject, { x: 10, y: 10, w: 80, h: 80 });
  assert.deepEqual(bounds.macro, { x: 35, y: 40, w: 10, h: 5 });
});

test('resolveTargets uses largest resolved mass and deterministic largest area ratio', () => {
  const primary = resolveTargets(resolved(), 'composition');
  assert.deepEqual(primary, {
    role: 'primary-mass', nodeIds: ['subject'], measuredNodeIds: ['subject'], resolvedBy: 'structural',
  });
  const scale = resolveTargets(resolved(), 'scale_relation');
  assert.equal(scale?.nodeIds[0], 'subject');
  assert.deepEqual(scale?.measuredNodeIds, ['subject', 'tiny']);
  assert.equal(scale?.scaleRatio, 1600);
  assert.equal(resolveTargets(resolved(), 'palette'), null);
});

