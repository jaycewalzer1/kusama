// WIDE SKETCH, with a policy that answers the two ways discovery allows and fails on purpose.
//
// The stub is local rather than the shared `StubPolicy` for the same reason RESEARCH's is: what is
// under test is a set of refusals, and a stub that only ever answers correctly would pass while
// proving that the refusal paths are never taken. This one answers per sketch index, from a fixed
// script: one whole program that is legal, one that is not, one answered with typed edits, and one
// that cites a material that is in no sheet.
//
// The canvas is stubbed everywhere except in the one test that is actually about rendering. A real
// preview costs a browser launch and a render, and twelve of them is what this phase spends its
// whole budget on; a unit test asserting that a failed sketch stays in the captions has no business
// paying for it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { encodePng } from '../../env/png.js';
import { contentHash } from '../../env/profile.js';
import { newSpend } from '../call.js';
import { Canvas, validate, type Preview } from '../canvas.js';
import { DiscoveryLog, readDiscovery } from '../discovery-log.js';
import { loadCommission } from '../field.js';
import { seedProgram } from '../seed.js';
import { corpusAvailable } from '../research-query.js';
import { sheetNotes, wideSketch, type Lens } from '../phases/wide-sketch.js';
import type { MaterialSheet } from '../material-sheet.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';
import type { Program } from '../types.js';

// The material sheet is rendered into the observation by `materialSection`, which reads the manifest
// to caption every citation. That is the only reason these tests need the corpus: the ids below are
// deliberately not real, because what is under test is whether a citation is checked against the
// sheet the artist wrote, not whether the sheet was honest — material-sheet.ts owns that question.
const skip = corpusAvailable() ? false : 'corpus/manifest.jsonl is not on this machine';

const SHEET: MaterialSheet = {
  materials: [
    { id: 'm1', material: 'Ruled lines that show through the text.', borrowing: 'A grid the marks ignore.', works: ['met:100'] },
    { id: 'm2', material: 'Rubricated initials that ignore the column.', borrowing: 'One red thing off the grid.', works: ['aic:200'] },
  ],
  queries: [],
  hash: 'test',
};

const LENSES: Lens[] = [{ id: 'l-grid', lens: 'The sheet is a ledger nobody balanced.', emergent: 'a grid that is disobeyed' }];

function ruleNode(id: string, y: number): Record<string, unknown> {
  return { id, type: 'op', op: 'rule', rngKey: id, args: { from: [40, y], to: [300, y], weight: 6, brush: 'marker', color: 'ink' } };
}

/** A legal whole program: the seed with one rule in it. Promotable, and the tests check that. */
function wholeProgram(seed: Program, nodeId: string): Record<string, unknown> {
  return {
    ...seed,
    root: { id: 'root', type: 'group', children: [{ id: 'sheet', type: 'group', children: [ruleNode(nodeId, 120)] }] },
  };
}

/**
 * An illegal whole program that is illegal for a reason the medium's own schema owns.
 *
 * The canvas is 9 units wide against a schema minimum of 16. `profile`, `assetPack` and `version`
 * are left correct on purpose: this has to exercise ajv over program.schema.json, not the cheaper
 * medium lock that runs before it.
 */
function badProgram(seed: Program): Record<string, unknown> {
  return { ...wholeProgram(seed, 'r-bad'), canvas: { ...(seed.canvas as Record<string, unknown>), width: 9 } };
}

/** An 8x8 grey plate. Real PNG bytes, because `sheetOf` decodes whatever it is handed. */
const PLATE = encodePng(Buffer.alloc(8 * 8 * 4, 0x40), 8, 8);

class StubCanvas {
  readonly previewed: unknown[] = [];
  async preview(program: unknown): Promise<Preview> {
    this.previewed.push(program);
    return { canonical: false, programHash: contentHash(program), png: PLATE, width: 8, height: 8 };
  }
}

/**
 * Answers by sketch index, and knows whether it is being retried.
 *
 * Index 1 is the one that never draws: it sends the same illegal program twice, which is what a
 * model that cannot fix the problem does, and is the case that decides whether a failed sketch stays
 * in the result or quietly disappears from it.
 */
class SketchStub implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly requests: PolicyRequest[] = [];

  constructor(private readonly seed: Program) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.requests.push(request);
    const action = this.answer(request);
    return { action: action as T, raw: JSON.stringify(action), usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, attempts: 1, failures: [], model: this.model };
  }

  private answer(request: PolicyRequest): unknown {
    const index = Number(/It is sketch (\d+) of/.exec(request.observation)?.[1] ?? '1') - 1;
    const retry = request.observation.includes('WHAT HAPPENED THE FIRST TIME');
    const common = {
      approach: `Sketch ${index + 1}: one rule across the sheet and nothing else on it.`,
      logic:
        `The rule sits at a third of the height and is the only mark, so the sheet reads as ruled ` +
        `rather than as drawn on. Sketch ${index + 1} of the set.`,
      borrowings: [{ sourceId: index === 3 ? 'met:999999' : 'm1', contributes: 'The ruled line the rest of the sheet is measured against.' }],
    };
    if (index === 0) return { ...common, program: wholeProgram(this.seed, 'r-good') };
    if (index === 1) return { ...common, program: badProgram(this.seed) };
    if (index === 2) {
      return { ...common, edits: [{ actionId: 'e1', kind: 'add_node', targets: ['sheet'], parent: 'sheet', node: ruleNode('r-edit', 200) }] };
    }
    // Index 3 cites a material that is on no sheet the first time, and corrects itself on the retry.
    return {
      ...common,
      borrowings: [{ sourceId: retry ? 'm2' : 'met:999999', contributes: 'The one red thing that ignores the column it is in.' }],
      program: wholeProgram(this.seed, 'r-cited'),
    };
  }
}

async function run(perLens: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wide-sketch-'));
  const discovery = new DiscoveryLog(dir);
  const seed = seedProgram(7);
  const canvas = new StubCanvas();
  const policy = new SketchStub(seed);
  const result = await wideSketch(
    policy,
    discovery,
    newSpend(),
    loadCommission('interference', 'fifty-year-embargo'),
    LENSES,
    SHEET,
    seed,
    canvas,
    7,
    { perLens }
  );
  return { dir, discovery, result, canvas, policy, seed };
}

test('an illegal whole program is refused, retried once with the reason, and still appears', { skip }, async () => {
  const { result, policy } = await run(2);
  const failed = result.sketches[1]!;

  assert.equal(failed.png, null);
  assert.equal(failed.attempts, 2, 'exactly one retry, never two');
  assert.equal(failed.program, null);
  assert.equal(failed.authored, null, 'a program that never validated was not how the sketch was written');
  assert.match(failed.failure ?? '', /not a legal program in this medium/);
  assert.match(failed.failure ?? '', /canvas\/width/, 'the failure names what the validator actually objected to');

  // The retry was told what stopped it. Without this the second attempt is just a second sample.
  const retried = policy.requests.filter((r) => r.observation.includes('WHAT HAPPENED THE FIRST TIME'));
  assert.equal(retried.length, 1);
  assert.match(retried[0]!.observation, /canvas\/width/);
  assert.match(retried[0]!.observation, /there is not another one/);

  // And it is still in the result and still in the captions. This is the whole point: a sheet of
  // survivors read as a sheet of ideas is how the next phase chooses something nobody proposed.
  assert.equal(result.sketches.length, 2);
  assert.equal(result.drawn, 1);
  assert.equal(result.failed, 1);
  const notes = result.sheets[0]!.notes;
  assert.ok(notes.some((n) => n.startsWith('not drawn: sketch 2')), notes.join('\n'));
  assert.ok(notes.some((n) => n.includes('2 attempts')));
});

test('a whole program written in discovery is a program the canonical path takes unchanged', { skip }, async () => {
  const { result, canvas } = await run(1);
  const drawn = result.sketches[0]!;

  assert.equal(drawn.authored, 'program');
  assert.ok(drawn.program, 'the tree is kept, not just the picture');
  // The gate is the medium's own, applied to the tree exactly as it stands. Nothing is normalised,
  // repaired or re-declared on the way out, so what is promoted is what was rendered.
  assert.deepEqual(validate(drawn.program).issues, []);
  assert.equal(drawn.programHash, contentHash(drawn.program));
  assert.deepEqual(canvas.previewed[0], drawn.program);
});

test('every sketch carries a logic, and a citation that is on no sheet is refused', { skip }, async () => {
  const { result } = await run(4);

  for (const s of result.sketches) {
    assert.ok(s.logic.length > 0, `sketch ${s.index} has a logic`);
    assert.ok(s.approach.length > 0);
  }
  // Only the drawn ones are claimed to cite something real; a sketch that never validated is not
  // asked to have got its provenance right either.
  const allowed = new Set(['m1', 'm2', 'met:100', 'aic:200']);
  for (const s of result.sketches.filter((x) => x.png)) {
    assert.ok(s.borrowings.length > 0, `sketch ${s.index} names what it took`);
    for (const b of s.borrowings) {
      assert.ok(allowed.has(b.sourceId), `${b.sourceId} is a material or work id from the sheet`);
      assert.ok(b.contributes.length > 0);
    }
  }

  // The fourth invented an id, was refused for it, and drew on the retry. A fabricated provenance
  // reads as authority, so it costs the sketch rather than being carried into the record.
  const cited = result.sketches[3]!;
  assert.equal(cited.attempts, 2);
  assert.ok(cited.png, 'it corrected itself and drew');
  assert.deepEqual(cited.borrowings.map((b) => b.sourceId), ['m2']);
});

test('discovery keeps the whole record and writes nothing to the chain', { skip }, async () => {
  const { dir, discovery, result } = await run(3);
  const lines = readDiscovery(discovery.file);

  for (const l of lines) assert.ok(!('hash' in l) && !('prev' in l), 'a discovery line carries no chain');

  // studio.jsonl is the chain. Discovery must not have created one, and there is no other writer
  // that could have: everything here goes through callPolicy into the DiscoveryLog above.
  assert.throws(() => readFileSync(path.join(dir, 'studio.jsonl'), 'utf8'));

  // Every sketch is logged, the failed one included, and the log says it was not canonical.
  const sketched = lines.filter((l) => l.kind === 'sketch');
  assert.equal(sketched.length, 3);
  assert.equal(sketched.filter((l) => (l.data as { drawn: boolean }).drawn).length, result.drawn);
  for (const l of sketched.filter((x) => (x.data as { drawn: boolean }).drawn)) {
    assert.equal((l.data as { canonical: boolean }).canonical, false);
  }
  const calls = lines.filter((l) => l.kind === 'policy-call');
  assert.equal(calls.length, 4, 'three sketches, one of them retried');
  assert.ok((calls[0]!.data as { observation: string }).observation.length > 0, 'the observation is logged whole');
});

test('the contact sheet is one image per lens with a caption per cell', { skip }, async () => {
  const { result } = await run(3);
  assert.equal(result.sheets.length, 1);
  assert.ok(result.sheets[0]!.png, 'two sketches drew, so there is a sheet');
  const notes = result.sheets[0]!.notes;
  assert.match(notes[0]!, /^lens l-grid:/);
  assert.equal(notes.filter((n) => n.startsWith('cell ')).length, result.drawn);
  for (const n of notes.filter((x) => x.startsWith('cell '))) assert.match(n, /written as: (edits|program)/);
});

test('a lens whose every sketch failed gets a caption and no sheet, not silence', () => {
  const failed = [{
    lensId: 'l-x', index: 0, approach: 'a', logic: 'b', borrowings: [], authored: null,
    program: null, programHash: '', png: null, failure: 'it would not render', attempts: 2,
  }];
  const notes = sheetNotes({ id: 'l-x', lens: 'a lens' }, failed);
  assert.equal(notes.length, 2);
  assert.match(notes[1]!, /^not drawn: sketch 1 — it would not render/);
});

// The one test that pays for a browser. It is here rather than in a canvas test file because the
// preview path exists for this phase and nothing else calls it.
test('a preview is stamped noncanonical, leaves no cache entry, and does not change render()', async () => {
  const canvas = new Canvas();
  // A cold hash every run, so the cache assertion below is about this preview and not about what
  // some earlier run left on the machine.
  const program = {
    version: '0.2',
    profile: 'default-v1',
    assetPack: 'core-v1',
    canvas: { width: 64, height: 64, ground: '#ffffff', brushScale: 1 },
    seed: Date.now() % 4294967295,
    palette: { ink: '#111111' },
    root: { id: 'root', type: 'group', children: [ruleNode('r', 32)] },
  };

  try {
    const preview = await canvas.preview(program);
    assert.equal(preview.canonical, false);
    assert.equal('pixelHash' in preview, false, 'there is no name for pixels nothing showed repeat');
    assert.equal(canvas.previews, 1);
    assert.equal(canvas.renders, 0, 'a preview is not counted as a canonical render');
    assert.equal(
      existsSync(path.join(ROOT, '.cache', 'artist-png', `${preview.programHash}.png`)),
      false,
      'a preview must not land in the cache render() reads as the canonical image of this program'
    );

    const rendered = await canvas.render(program);
    assert.equal(rendered.canonical, true);
    assert.equal(canvas.renders, 1);
    assert.ok(rendered.pixelHash.length === 64);
    assert.equal(rendered.width, 64);
    assert.equal(preview.width, 64);
  } finally {
    await canvas.close();
  }
});
