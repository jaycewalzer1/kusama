import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSamplingEvent } from '../sampling-events.js';
import { readLog, StudioLog, verifyChain } from '../studio-log.js';

test('all six sampling event kinds remain inside the ordinary hash chain', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sampling-events-'));
  const log = new StudioLog(dir);
  log.append('sample_requested', { intents: [], fallback: false });
  log.append('sample_selected', { plan: {} });
  log.append('sample_rejected', { requestId: 'r', fragmentId: 'f', reason: 'the crop answers the wrong relation' });
  log.append('binding_declared', { status: 'bound', bindings: {}, accepted: true, faults: [] });
  log.append('ablation_rendered', {
    sampledProgramHash: 'a', sampledPixelHash: 'b', ablationProgramHash: 'c', ablationPixelHash: 'd',
    differingPixels: 1, totalPixels: 2, sampledFile: 's.png', ablationFile: 'a.png', resolutions: [],
  });
  log.append('sample_revised', { revision: { kind: 'none' }, accepted: true, faults: [] });
  const lines = readLog(log.file);
  assert.deepEqual(verifyChain(lines), []);
  assert.deepEqual(lines.map((line) => parseSamplingEvent(line)?.kind), [
    'sample_requested', 'sample_selected', 'sample_rejected', 'binding_declared', 'ablation_rendered', 'sample_revised',
  ]);
});

