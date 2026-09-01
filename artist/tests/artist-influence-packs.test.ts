// The authored-pack format: the field table, the validator, and the z-scoring.
//
// A pack is the only place in this layer where numbers come from a person rather than from pixels,
// so it is the only place where a typo becomes a claim. `influence/packs/rick-owens.json` asserts
// that Owens' palette has a mean chroma of 1.5 against a corpus mean of 7.8 — a number nobody
// measured. That is allowed, and it is labelled `source: "authored"` everywhere it travels. What is
// not allowed is a pack that is silently wrong in a way the loader could have caught: eighteen
// values written where the descriptor wants eighteen is a claim, seventeen is a bug that shifts
// every subsequent Lab coordinate by one and still produces a direction, a magnitude and a sweep.
//
// So the validator throws with the offending field named, and every rejection it is capable of is
// exercised below against a temp file rather than described in a comment.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DESCRIPTOR_VERSION, DIMS, LAYERS, OFFSETS, ROW, type Layer, type Stats } from '../influence/descriptors.js';
import { FIELDS, PACKS_DIR, listPacks, loadPack, packDirections } from '../influence/packs.js';
import { PAIR_TEST_VERDICT, TEXT_LAYERS } from '../influence/directions.js';

test('the field table tiles every layer exactly, with no gap and no overlap', () => {
  // The claim written at packs.ts:44, which is what lets a person address a flat float array by
  // name. A field at the wrong offset does not fail: it writes a real number into the wrong
  // dimension and the pack goes on working, asserting something nobody wrote.
  for (const layer of LAYERS) {
    const fields = Object.entries(FIELDS[layer]).sort((a, b) => a[1].at - b[1].at);
    let at = 0;
    for (const [name, f] of fields) {
      assert.equal(f.at, at, `${layer}.${name} starts at ${f.at}, expected ${at}`);
      at += f.len;
    }
    assert.equal(at, DIMS[layer], `${layer} fields sum to ${at}, not DIMS ${DIMS[layer]}`);
  }
  const total = LAYERS.reduce((a, l) => a + Object.values(FIELDS[l]).reduce((b, f) => b + f.len, 0), 0);
  assert.equal(total, ROW);
});

test('the palette field table matches the descriptor packing it names', () => {
  // Spot-checked against `influence/descriptors.py`, which writes 6 Lab centres, then 6 fractions,
  // then the three scalars. These four offsets are the ones a pack author actually uses.
  assert.deepEqual(FIELDS.palette['centres'], { at: 0, len: 18 });
  assert.deepEqual(FIELDS.palette['fractions'], { at: 18, len: 6 });
  assert.deepEqual(FIELDS.palette['lMean'], { at: 24, len: 1 });
  assert.deepEqual(FIELDS.palette['chromaMean'], { at: 26, len: 1 });
  // 12 orientation bins over [0, pi), verified against synthetic probes: bin 0 horizontal, 6
  // vertical. A pack that authored bin 6 alone would be claiming a precision the descriptor does
  // not have, because a vertical stroke straddles bins 5 and 6.
  assert.deepEqual(FIELDS.form['orientation'], { at: 12, len: 12 });
});

// --- the shipped pack -----------------------------------------------------------------------------

test('the Rick Owens pack loads, and declares the two layers it declines to fill', () => {
  const packs = listPacks();
  assert.ok(packs.includes('rick-owens.json'), `no rick-owens.json in ${PACKS_DIR}`);
  const p = loadPack(path.join(PACKS_DIR, 'rick-owens.json'));
  assert.equal(p.source, 'authored');
  assert.equal(p.descriptorVersion, DESCRIPTOR_VERSION);
  assert.ok(p.basis.length > 100, 'a pack with no stated basis is somebody\'s taste with a schema on it');
  // Null, not absent. An author who could not state a 48-dimensional Gabor bank says so.
  assert.equal(p.layers.texture, null);
  assert.equal(p.layers.armature, null);
  assert.ok(p.layers.palette && p.layers.form);
});

test('the Owens pack does not author straightFraction, which is the one field it must not', () => {
  // 0.001 +/- 0.011 across all 19,807 works. Any value written there is an enormous z off a
  // dimension the corpus cannot distinguish, and the pack would push hardest on its own noise.
  const p = loadPack(path.join(PACKS_DIR, 'rick-owens.json'));
  assert.ok(!('straightFraction' in p.layers.form!.fields), 'straightFraction must stay unauthored');
  assert.match(p.layers.form!.note, /straightFraction/, 'and the refusal must be stated, not just enacted');
});

// --- validation -------------------------------------------------------------------------------------

const VALID = {
  id: 'fixture',
  label: 'Fixture',
  source: 'authored',
  descriptorVersion: DESCRIPTOR_VERSION,
  authored: '2026-09-02',
  basis: 'A fixture. Nothing was measured to produce it and nothing may be argued from it.',
  layers: {
    armature: null,
    texture: null,
    palette: { note: 'dark and grey', fields: { lMean: 27.3, chromaMean: 1.5 } },
  },
};

function withPack<T>(body: (write: (pack: unknown) => string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'influence-pack-'));
  try {
    return body((pack) => {
      const file = path.join(dir, 'p.json');
      writeFileSync(file, JSON.stringify(pack));
      return file;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a malformed pack is refused with the offending field named', () => {
  withPack((write) => {
    assert.deepEqual(loadPack(write(VALID)).id, 'fixture', 'the fixture itself must be valid');

    const cases: [string, unknown, RegExp][] = [
      [
        'an array of the wrong length',
        { ...VALID, layers: { palette: { note: 'n', fields: { centres: new Array(17).fill(1) } } } },
        /palette\.centres needs 18 value\(s\), got 17/,
      ],
      [
        'a field the descriptor does not have',
        { ...VALID, layers: { palette: { note: 'n', fields: { warmth: 3 } } } },
        /palette has no field warmth; known: centres, fractions, lMean, lStd, chromaMean/,
      ],
      ['a layer that does not exist', { ...VALID, layers: { colour: { note: 'n', fields: {} } } }, /unknown layer colour/],
      ['numbers with no note', { ...VALID, layers: { palette: { fields: { lMean: 27.3 } } } }, /palette has fields but no note/],
      ['a source that claims measurement', { ...VALID, source: 'pixels' }, /source must be "authored", got pixels/],
      ['no stated basis', { ...VALID, basis: '' }, /id, label and basis are all required/],
      // JSON has no NaN, but 1e400 parses to Infinity and would sail through a `typeof === number`.
      ['a non-finite value', { ...VALID, layers: { palette: { note: 'n', fields: { lMean: 1e400 } } } }, /palette\.lMean has a non-finite value/],
    ];

    for (const [what, pack, message] of cases) {
      const file = write(pack);
      assert.throws(() => loadPack(file), message, `accepted ${what}`);
    }
  });
});

// --- z-scoring ----------------------------------------------------------------------------------------

/** Corpus stats where the z-score is the raw value minus 10, so the arithmetic is checkable by eye. */
function stats(): Stats {
  return { version: DESCRIPTOR_VERSION, rows: 100, mean: new Array(ROW).fill(10), std: new Array(ROW).fill(2) };
}

test('an authored value is z-scored against the corpus of the day, not written down as a z', () => {
  const d = withPack((write) => packDirections(loadPack(write(VALID)), stats()));
  const palette = d.directions['palette']!;
  // (27.3 - 10) / 2 and (1.5 - 10) / 2. Absolute in the file, z on the way out: a pack written
  // against last year's corpus still means the same thing, and the corpus does the standardising.
  assert.equal(palette.vector![FIELDS.palette['lMean']!.at], 8.65);
  assert.equal(palette.vector![FIELDS.palette['chromaMean']!.at], -4.25);
});

test('a field the author did not name stays at exactly zero, pushing nothing', () => {
  const d = withPack((write) => packDirections(loadPack(write(VALID)), stats()));
  const palette = d.directions['palette']!;
  const named = new Set([FIELDS.palette['lMean']!.at, FIELDS.palette['chromaMean']!.at]);
  for (let i = 0; i < DIMS.palette; i++) {
    if (!named.has(i)) assert.equal(palette.vector![i], 0, `dimension ${i} was invented`);
  }
  // Zero in z-space IS the corpus mean, so an unnamed field is not a claim of averageness that the
  // author would have to defend — it is the absence of a claim, and the dial does not move it.
  assert.equal(palette.vector!.length, DIMS.palette);
});

test('coverage says how much of the layer the hand actually filled', () => {
  const d = withPack((write) => packDirections(loadPack(write(VALID)), stats()));
  // 2 of 27. A reader seeing magnitude 9.6 at coverage 0.074 knows where that length came from;
  // reading magnitude alone would put this pack alongside a direction measured over 262 dimensions.
  assert.equal(d.directions['palette']!.coverage, Number((2 / DIMS.palette).toFixed(4)));
  assert.ok(d.directions['palette']!.magnitude > 9);
});

test('an authored direction has no spread, no cohesion and no works behind it', () => {
  const d = withPack((write) => packDirections(loadPack(write(VALID)), stats()));
  const palette = d.directions['palette']!;
  assert.equal(palette.source, 'authored');
  assert.equal(d.works, 0, 'nobody measured any works to produce this');
  assert.equal(palette.spread, 0, 'there is one assertion, so it has no spread');
  // Null and not zero. A zero cohesionZ would read as "average tightness", which is a permutation
  // test result nobody ran — an assertion is not a group and has no tightness at all.
  assert.equal(palette.cohesionZ, null);
  assert.equal(palette.cohesive, false);
  assert.equal(d.kind, 'artist');
});

test('a layer the author left null stays null, and the text layers are null too', () => {
  const d = withPack((write) => packDirections(loadPack(write(VALID)), stats()));
  assert.equal(d.directions['armature'], null);
  assert.equal(d.directions['texture'], null);
  for (const l of TEXT_LAYERS) assert.equal(d.directions[l], null);
});

test('an authored direction still carries the pair test\'s verdict for its layer', () => {
  // Authoring a palette does not make the palette descriptor carry influence. The pack asserts a
  // target; the pair test asserted whether that layer transmits anything, and those are different
  // claims that must not merge on their way into the same object.
  const d = withPack((write) => packDirections(loadPack(write(VALID)), stats()));
  assert.equal(d.directions['palette']!.carriesInfluence, PAIR_TEST_VERDICT.palette);
  assert.equal(PAIR_TEST_VERDICT.palette, false, 'palette was a null in the pair test');
});

test('every layer offset the pack loader writes through lands inside that layer', () => {
  // `packDirections` indexes `stats.mean[OFFSETS[layer] + f.at + i]`. An off-by-one in either
  // table would z-score a palette value against a texture dimension's mean and produce a plausible
  // number, so the bound is asserted rather than trusted.
  for (const layer of LAYERS) {
    for (const [name, f] of Object.entries(FIELDS[layer])) {
      assert.ok(OFFSETS[layer as Layer] + f.at + f.len <= OFFSETS[layer as Layer] + DIMS[layer as Layer], `${layer}.${name} runs past its layer`);
    }
  }
});
