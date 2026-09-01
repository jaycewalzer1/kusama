// The text tower, and the one question that decides whether it is worth anything.
//
// A text encoder that produces 512 unit-length floats looks correct from every angle. It looks
// correct if it came from a different checkpoint, if it read the pre-projection hidden state
// instead of `text_embeds`, and if the tokenizer were subtly wrong. In all three cases every
// downstream number would still be a plausible cosine in a plausible range, and nothing would throw.
//
// So the assertion that earns this file is the retrieval gate: take 500 corpus works, embed their
// titles, and ask whether each title finds its own image among the 500 candidates. If the two towers
// share a space this is far above chance; if they do not, it sits at chance and the whole stage is
// worthless. It is reported against 1/500 and 10/500 rather than as a bare percentage, because a
// retrieval percentage with no pool size beside it is not a number.
//
// The gate needs the weights and the pixels, so it skips by name on a machine without them. The
// tokenizer tests do not, and always run: `vocab.json` and `merges.txt` are 1.7MB, not 254MB.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOS,
  CONTEXT_LENGTH,
  EOS,
  loadTokenizer,
  tokenizerAvailable,
} from '../clip-tokenizer.js';
import { DIM, cosine, embedText, embedTokens, textAvailable, textUnavailableMessage } from '../clip-text.js';
import { embeddingsAvailable, loadCorpusEmbeddings, nearest } from '../clip-index.js';

const noTokenizer = tokenizerAvailable()
  ? false
  : 'vocab.json / merges.txt are not in .models/clip-vit-base-patch32/';
const noTower = textAvailable() && embeddingsAvailable()
  ? false
  : `needs the text tower and corpus/clip.f32.\n${textUnavailableMessage()}`;

test('the tokenizer reproduces CLIP\'s published ids for "a photo of a cat"', { skip: noTokenizer }, () => {
  const tok = loadTokenizer();
  // The canonical worked example. Every one of these five ids is a separate chance for the
  // byte mapping, the regex, the merge ranks or the `</w>` convention to be wrong.
  assert.deepEqual(tok.encode('a photo of a cat'), [320, 1125, 539, 320, 2368]);
  // Case and whitespace are normalised away before the split, not after.
  assert.deepEqual(tok.encode('  A   PHOTO of\na cat '), [320, 1125, 539, 320, 2368]);
});

test('a word absent from the vocabulary is split rather than dropped', { skip: noTokenizer }, () => {
  const tok = loadTokenizer();
  // `woodcut</w>` is not a vocabulary entry. A tokenizer that quietly emitted <unk>, or nothing,
  // would still "work" — and every printmaking query would be answered by a truncated phrase.
  const ids = tok.encode('woodcut');
  assert.equal(ids.length, 2, `woodcut tokenized to ${ids.length} pieces, expected a BPE split`);
  assert.ok(!ids.includes(EOS) && !ids.includes(BOS));
});

test('non-ascii text survives the byte mapping', { skip: noTokenizer }, () => {
  const tok = loadTokenizer();
  // `appliqué` and `Œuvres` are both really in the museums' medium fields, and both were previously
  // found mangled by a TF-IDF run that did not fold diacritics. Byte-level BPE must not need to.
  assert.ok(tok.encode('appliqué').length > 0);
  assert.ok(tok.encode('Œuvres').length > 0);
  assert.notDeepEqual(tok.encode('appliqué'), tok.encode('applique'));
});

test('tokenize brackets with BOS/EOS and pads to the context length', { skip: noTokenizer }, () => {
  const tok = loadTokenizer();
  const seq = tok.tokenize('a photo of a cat');
  assert.equal(seq.length, CONTEXT_LENGTH);
  assert.equal(seq[0], BOS);
  assert.equal(seq[6], EOS);
  assert.ok(seq.slice(7).every((t) => t === EOS), 'padding is EOS');

  // Overlong input is truncated, not rejected and not allowed to overflow the tensor.
  const long = tok.tokenize('woodcut '.repeat(200));
  assert.equal(long.length, CONTEXT_LENGTH);
  assert.equal(long[0], BOS);
  assert.equal(long[CONTEXT_LENGTH - 1], EOS, 'the sequence always ends in EOS, even when truncated');
});

test('embeddings are 512-d and unit length', { skip: noTower }, async () => {
  const vecs = await embedText(['a woodcut of a bird', 'a bronze figure']);
  assert.equal(vecs.length, 2);
  for (const v of vecs) {
    assert.equal(v.length, DIM);
    let n = 0;
    for (const x of v) n += x * x;
    assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-5, `norm ${Math.sqrt(n)}`);
  }
  // Two different phrases must not collapse to the same vector — the failure mode of feeding the
  // model an all-pad sequence by mistake.
  assert.ok(cosine(vecs[0]!, vecs[1]!) < 0.99);
});

test('batching does not change any embedding', { skip: noTower }, async () => {
  const strings = ['a woodcut of a bird', 'a bronze figure', 'a red silk robe', 'a clay bowl'];
  const batched = await embedText(strings, 4);
  const singly = await embedText(strings, 1);
  for (let i = 0; i < strings.length; i++) {
    assert.ok(
      cosine(batched[i]!, singly[i]!) > 0.9999,
      `row ${i} moved when the batch size changed: ${cosine(batched[i]!, singly[i]!)}`,
    );
  }
});

test('padding cannot reach the vector, which is why there is no attention mask', { skip: noTower }, async () => {
  const tok = loadTokenizer();
  const text = 'a woodcut of a bird';
  const real = [BOS, ...tok.encode(text), EOS];
  const eosPadded = tok.tokenize(text);
  const zeroPadded = [...real, ...new Array(CONTEXT_LENGTH - real.length).fill(0)];
  assert.equal(eosPadded.length, CONTEXT_LENGTH);
  assert.ok(real.length < CONTEXT_LENGTH);

  // Three separate forward passes, because the sequences are different lengths.
  const [a] = await embedTokens([real]);
  const [b] = await embedTokens([eosPadded]);
  const [c] = await embedTokens([zeroPadded]);
  // The export takes `input_ids` only. If the transformer were bidirectional, or pooled anywhere
  // but the eos position, these would differ and every embedding in the repo would silently carry
  // 69 tokens of padding in it.
  assert.ok(cosine(a!, b!) > 0.99999, `eos padding moved the vector: ${cosine(a!, b!)}`);
  assert.ok(cosine(a!, c!) > 0.99999, `zero padding moved the vector: ${cosine(a!, c!)}`);
});

test('the corpus index holds one row per distinct image, not per manifest row', { skip: noTower }, () => {
  const c = loadCorpusEmbeddings();
  const shas = new Set(c.entries.map((e) => e.sha256));
  assert.equal(shas.size, c.entries.length, 'a sha256 appears twice in the index');
  // 98 manifest rows share bytes with another row. That has produced a wrong number twice, so the
  // dedupe is asserted here rather than trusted: this is the loader every similarity goes through.
  assert.ok(c.duplicates > 0, 'expected the known duplicate rows to be collapsed');
  assert.ok(
    c.entries.length > 19000 && c.entries.length <= c.rowsInFile,
    `${c.entries.length} entries against ${c.rowsInFile} rows in the file`,
  );
  const withAliases = c.entries.filter((e) => e.aliases.length > 0);
  assert.equal(
    withAliases.reduce((n, e) => n + e.aliases.length, 0),
    c.duplicates,
    'every collapsed row is recorded as an alias rather than silently dropped',
  );
});

test('corpus image rows are unit length, so a dot product is a cosine', { skip: noTower }, () => {
  const c = loadCorpusEmbeddings();
  for (let i = 0; i < 100; i++) {
    const at = Math.floor((i * c.entries.length) / 100);
    let n = 0;
    for (let j = 0; j < DIM; j++) n += c.rows[at * DIM + j]! ** 2;
    assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-4, `row ${at} has norm ${Math.sqrt(n)}`);
  }
});

test('THE GATE: a title retrieves its own image far above chance', { skip: noTower }, async () => {
  const c = loadCorpusEmbeddings();
  // Works with a title worth embedding. "Untitled" is excluded because it is not a description of
  // anything and would put an irreducible floor of confusable queries into the pool.
  const usable = c.entries.filter(
    (e) => e.work.title && e.work.title.trim().length >= 4 && !/^untitled$/i.test(e.work.title.trim()),
  );
  const N = 500;
  assert.ok(usable.length > N * 2, `only ${usable.length} usable titles`);
  // Stride, not random: the sample must be the same on every machine and every run, and a stride
  // over manifest order spreads across all three museums by construction.
  const stride = Math.floor(usable.length / N);
  const pick = Array.from({ length: N }, (_, i) => usable[i * stride]!);

  const vecs = await embedText(pick.map((e) => e.work.title));
  let p1 = 0;
  let p10 = 0;
  let mrr = 0;
  for (let q = 0; q < N; q++) {
    const v = vecs[q]!;
    const scores = pick.map((e) => {
      let s = 0;
      for (let j = 0; j < DIM; j++) s += c.rows[e.row * DIM + j]! * v[j]!;
      return s;
    });
    const gold = scores[q]!;
    const rank = 1 + scores.reduce((n, s) => n + (s > gold ? 1 : 0), 0);
    if (rank === 1) p1++;
    if (rank <= 10) p10++;
    mrr += 1 / rank;
  }
  // Chance is 1/500 and 10/500 because the candidate pool is the 500 sampled images. Measured on
  // 2026-09-01: P@1 20.4%, P@10 54.8%, MRR 0.3188 — 102x and 27x chance. The thresholds sit well
  // below that so a small drift does not fail the suite, but they are far enough above chance that
  // a broken tokenizer, a mismatched checkpoint or a pre-projection read cannot pass.
  assert.ok(p1 / N > 0.05, `P@1 ${(100 * p1) / N}% against 0.2% chance — the towers do not share a space`);
  assert.ok(p10 / N > 0.2, `P@10 ${(100 * p10) / N}% against 2% chance`);
  assert.ok(mrr / N > 0.1, `MRR ${mrr / N} against ~0.0136 chance`);
});

test('a zero-shot phrase lands on the right kind of object', { skip: noTower }, async () => {
  const c = loadCorpusEmbeddings();
  const [vase] = await embedText(['a Greek vase']);
  const hits = nearest(c.rows, c.entries.length, vase!, 5);
  // Not "the top hit is work X" — that would be a golden over derived data that is gitignored and
  // rebuildable. The claim is weaker and more honest: the neighbourhood is about vessels.
  const words = hits
    .map((h) => `${c.entries[h.row]!.work.title} ${c.entries[h.row]!.work.classification}`.toLowerCase())
    .join(' ');
  assert.match(words, /vase|vessel|amphora|krater|jar|pitcher|cup|oinochoe|hydria|skyphos|ceramic/);
});
