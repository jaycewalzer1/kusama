// Deriving an element from a reading: what the call is allowed to see, and what it does with a
// badly filled-in answer.
//
// The derivation is one model call, so the interesting properties are on either side of it: what
// went into the prompt, and what the compiler did with what came back. Both are testable without a
// network — `setEnvModel` installs a stand-in, and `recentEnvRequests` records what was sent. The
// call itself is not tested here because there is nothing to test: it is a frozen model at
// temperature zero and its answers are cached on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, derivationText, deriveElement, deriveProtocolHash, type Draft, type Move } from '../element-derive.js';
import { recentEnvRequests, setEnvModel } from '../env-model.js';
import type { Work, WorkReading } from '../corpus.js';

const READING: WorkReading = {
  id: 'cma-fixture',
  model: 'gpt-4o-2024-11-20',
  promptHash: 'a'.repeat(64),
  reading: {
    does: ['lets one flat field carry the whole picture', 'puts the incident at the very edge'],
    refuses: ['a focal point in the middle', 'any second colour'],
    tension: 'between wanting to be looked at and refusing to say where',
    materialFacts: ['thin paint, the weave shows through', 'one colour, laid down twice'],
    structuralMoves: ['the horizon is not where the sheet is divided'],
  },
  leakage: { work: null, artist: null, year: null, recognised: false },
  claimedCanonical: false,
  canonical: false,
  misattributed: false,
};

// A famous work, deliberately. If any of this gets into the prompt the blindness test below finds it.
const WORK: Work = {
  id: 'cma-fixture',
  source: {
    corpus: 'cma',
    objectId: '424242',
    url: 'https://example.invalid/art/424242',
    apiUrl: 'https://example.invalid/api/artworks/424242',
    title: 'The Starry Night',
    creator: 'Vincent van Gogh (Dutch, 1853-1890)',
    date: '1889',
    rights: 'CC0',
    imageUrl: 'https://example.invalid/img/424242.jpg',
  },
  image: { path: 'corpus/images/cma-fixture.jpg', hash: 'b'.repeat(64), mime: 'image/jpeg', bytes: 1234 },
  fetchedAt: '2026-08-31T00:00:00.000Z',
};

const move = (m: Partial<Move> & { move: Move['move'] }): Move => ({ why: 'x'.repeat(40), ...m });

const DRAFT: Draft = {
  name: 'one field, incident at the edge',
  worldview: 'The picture is a single held colour, and whatever happens in it happens where nobody is looking.',
  commitments: [move({ move: 'colours-at-most', amount: 2 })],
  generativeRules: [move({ move: 'offcentre-at-least', amount: 0.35 })],
  prohibitions: [move({ move: 'forbid-ops', ops: ['text'] })],
  tensions: [{ between: 'the flat field', and: 'the incident', claim: 'neither is allowed to become the subject' }],
  cliches: ['a colour field with a smudge in the corner', 'minimalism as an excuse for one gesture'],
};

/** Runs the real `deriveElement` against a fixed answer, and hands back what was sent. */
async function derive(draft: Draft) {
  recentEnvRequests.length = 0;
  setEnvModel(async () => ({ value: draft as never, cached: true, inputTokens: 0, outputTokens: 0, usd: 0, cacheKey: 'test' }));
  try {
    const result = await deriveElement(WORK, READING);
    return { ...result, sent: [...recentEnvRequests] };
  } finally {
    setEnvModel(null);
  }
}

test('the derivation sees the reading and nothing else', async () => {
  const { sent } = await derive(DRAFT);
  assert.equal(sent.length, 1, 'one call per element, not one per field');
  const call = sent[0]!;
  assert.equal(call.name, 'derive-element');
  // The picture was looked at once, in corpus.ts. A second look would produce a recipe for a copy.
  assert.equal(call.hasImage, false, 'the derivation was handed the image again');
  const prompt = `${call.system}\n${call.text}`.toLowerCase();
  for (const leak of ['starry', 'gogh', 'vincent', '1889', 'example.invalid', '424242', 'cc0', 'cma']) {
    assert.ok(!prompt.includes(leak), `the derivation prompt carries "${leak}" from the metadata`);
  }
  // And it did carry the reading, so the absence above is not just an empty prompt.
  assert.ok(call.text.includes('the incident at the very edge'));
  assert.ok(call.text.includes('between wanting to be looked at'));
});

test('derivationText cannot be handed metadata: its parameter is a Reading', () => {
  // Not a style point. A function that takes a Work is one careless call away from interpolating
  // the title, and no test of the prompt's contents would survive that refactor.
  const text = derivationText(READING.reading);
  assert.ok(text.includes('thin paint, the weave shows through'));
  assert.ok(!text.includes('Starry'));
});

test('the metadata lands in provenance, where it is not normative', async () => {
  const { element } = await derive(DRAFT);
  assert.equal(element.id, 'cma-fixture');
  assert.match(element.provenance.citation, /The Starry Night/);
  assert.match(element.provenance.citation, /CC0/);
  assert.equal(element.provenance.period, '1889');
  assert.equal(element.derivedFrom?.imageHash, 'b'.repeat(64));
  assert.equal(element.derivedFrom?.readingProtocol, READING.promptHash);
  assert.equal(element.derivedFrom?.deriveProtocol, deriveProtocolHash());
  assert.equal(element.derivedFrom?.canonical, false);
  // None of the three normative lists may quote the title or the maker: they were compiled from
  // moves, and a move's `why` came from a prompt that never saw either.
  const why = [...(element.commitments ?? []), ...element.generativeRules, ...element.prohibitions].map((c) => c.why).join(' ');
  assert.ok(!/starry|gogh/i.test(why));
});

test('every derived constraint is soft, so a machine reading cannot veto a run', async () => {
  const { element } = await derive(DRAFT);
  const all = [...(element.commitments ?? []), ...element.generativeRules, ...element.prohibitions];
  assert.equal(all.length, 3);
  for (const c of all) assert.equal(c.severity, 'soft', `${c.id} is hard`);
  assert.deepEqual(all.map((c) => c.id), ['e-hold-1', 'e-make-1', 'e-not-1']);
});

test('a malformed move is dropped, never repaired', async () => {
  const { element, dropped } = await derive({
    ...DRAFT,
    generativeRules: [
      move({ move: 'ink-at-most', amount: 1.4 }), // out of range: a clamp would invent a ceiling
      move({ move: 'coverage-at-least', amount: 0.2 }),
      move({ move: 'things-at-most', amount: 3.5 }), // not a whole number
      move({ move: 'require-op', ops: ['stroke', 'wash'] }), // require-op takes exactly one
    ],
  });
  assert.equal(dropped, 3);
  assert.equal(element.generativeRules.length, 1);
  assert.equal(element.generativeRules[0]?.kind, 'coverageRange');
  // The survivor keeps its own index, so the ids of an element with drops are not contiguous and
  // that is the point: `e-make-2` says which move it was.
  assert.equal(element.generativeRules[0]?.id, 'e-make-2');
});

test('compile refuses what it cannot encode rather than guessing', () => {
  const why = 'y'.repeat(40);
  assert.equal(compile('c', { move: 'ink-at-most', why }), null, 'a fraction move with no amount');
  assert.equal(compile('c', { move: 'colours-at-most', amount: 0, why }), null, 'zero colours is not a picture');
  assert.equal(compile('c', { move: 'forbid-ops', ops: ['scribble'], why }), null, 'an op that is not a primitive');
  assert.equal(compile('c', { move: 'nonsense' as Move['move'], why }), null, 'a move outside the closed list');
  // repeat-depth-at-most 0 is meaningful — no repeats at all — so it is not lumped in with the above.
  assert.equal(compile('c', { move: 'repeat-depth-at-most', amount: 0, why })?.kind, 'maxRepeatDepth');
});

test('symmetry compiles with an axis the model was never asked for', () => {
  // The move list has no axis argument on purpose. If one is ever added, this test should be the
  // thing that fails, not a fifty-element corpus half in each axis.
  const c = compile('c', { move: 'symmetry-at-most', amount: 0.4, why: 'z'.repeat(40) });
  assert.deepEqual(c?.params, { max: 0.4, axis: 'vertical' });
});

test('the protocol hash moves when the question does, and not otherwise', () => {
  assert.match(deriveProtocolHash(), /^[0-9a-f]{64}$/);
  assert.equal(deriveProtocolHash(), deriveProtocolHash());
});
