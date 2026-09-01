// `influence` — per-layer pixel descriptors over the corpus, and what can be read off them.
//
//   influence describe [--limit N] [--concurrency 8]
//                                    describe every distinct corpus image into corpus/descriptors.v1.f32
//   influence pairs [-o docs/influence/pairs.md]
//                                    mine the manifest for copies and measure what a copyist holds
//   influence artists [--min 15]     who has enough works in this corpus to have a direction at all
//   influence directions [--min 15]  per-layer artist/culture directions into corpus/directions.v1.json
//   influence sweep --program <p> --artist <a> --layer <l> --k -1,0,1
//                                    render one program along one influence direction
//
// Everything here is offline and model-free: numpy/OpenCV/scikit-learn through the worker in
// `influence/descriptors.py`, plus TypeScript glue. Nothing in this file calls a model, and the
// influence layer moves no existing hash — see docs/influence/README.md.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { ROOT } from '../env/browser.js';
import {
  DESCRIPTOR_VERSION,
  INDEX,
  LAYERS,
  MATRIX,
  ROW,
  STATS,
  computeStats,
  descriptorsAvailable,
  descriptorsUnavailableMessage,
  describeImages,
  loadDescriptors,
  loadStats,
  pack,
  workerAvailable,
  workerUnavailableMessage,
  type Layer,
} from '../artist/influence/descriptors.js';
import { DEFAULT_SEEDS, MIN_SPLIT, Z_THRESHOLD, overallRatio, rankingLayers, runPairTest, type LayerResult, type PairMeasurement } from '../artist/influence/pairs.js';
import {
  COHESION_Z,
  DIRECTIONS,
  MIN_WORKS,
  PAIR_TEST_VERDICT,
  TEXT_LAYERS,
  computeDirections,
  groupWorks,
  type DirectionsFile,
} from '../artist/influence/directions.js';
import { PACKS_DIR, listPacks, loadPack, packDirections } from '../artist/influence/packs.js';
import { BIZARRENESS, applyInfluence } from '../artist/influence/apply.js';
import { SWEEPABLE, runSweep } from '../artist/influence/sweep.js';
import { kindOf, type CreatorKind } from '../artist/influence/creators.js';
import { contactSheet } from '../artist/influence/sheet.js';

const IMAGES = path.join(ROOT, 'corpus', 'images');

const program = new Command();
program.name('influence').description('per-layer pixel descriptors over the corpus');

program
  .command('describe')
  .description('describe every distinct corpus image into corpus/descriptors.v1.f32')
  .option('--limit <n>', 'stop after n images (for a smoke run)', (v) => Number(v))
  .option('--concurrency <n>', 'worker processes', (v) => Number(v), 8)
  .action(async (opts: { limit?: number; concurrency: number }) => {
    if (!workerAvailable()) {
      console.error(workerUnavailableMessage());
      process.exit(1);
    }

    // Files, not manifest rows. 98 rows share bytes with another row, so describing rows would
    // describe 98 images twice and the matrix would no longer be one row per distinct image — the
    // exact shape `loadEmbeddings` expects. Sorted sha256 order for the same reason `dino.f32` is:
    // the row order is then a property of the corpus and not of the directory listing.
    const shas = readdirSync(IMAGES)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => f.replace(/\.jpg$/, ''))
      .sort();
    const todo = opts.limit ? shas.slice(0, opts.limit) : shas;
    console.log(`describing ${todo.length} images at ${ROW} floats each, ${opts.concurrency} workers`);

    const rows = new Map<string, Float32Array>();
    const started = Date.now();
    let done = 0;
    const { failed } = await describeImages(
      todo.map((s) => path.join(IMAGES, `${s}.jpg`)),
      {
        concurrency: opts.concurrency,
        onResult: (d) => {
          rows.set(path.basename(d.path).replace(/\.jpg$/, ''), pack(d));
          if (++done % 1000 === 0) {
            const rate = done / ((Date.now() - started) / 1000);
            console.log(`  ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${(((todo.length - done) / rate) / 60).toFixed(1)}m`);
          }
        },
        onFailure: (f) => console.error(`  FAILED ${path.basename(f.path)}: ${f.error}`),
      },
    );

    // Only images that actually described get a row, and the index names exactly those. A zero row
    // for a failure would be indistinguishable from a real descriptor of a blank sheet — which the
    // corpus genuinely contains — so failures are omitted and counted instead.
    const kept = todo.filter((s) => rows.has(s));
    const matrix = new Float32Array(kept.length * ROW);
    kept.forEach((s, i) => matrix.set(rows.get(s)!, i * ROW));

    mkdirSync(path.dirname(MATRIX), { recursive: true });
    writeFileSync(MATRIX, Buffer.from(matrix.buffer, 0, matrix.byteLength));
    writeFileSync(INDEX, JSON.stringify(kept));
    const stats = computeStats(matrix, kept.length);
    writeFileSync(STATS, JSON.stringify(stats, null, 2) + '\n');

    const mb = (matrix.byteLength / 1e6).toFixed(1);
    console.log(
      `\n${kept.length}/${todo.length} described (${((kept.length / todo.length) * 100).toFixed(2)}%), ` +
        `${failed.length} failed, ${mb}MB, ${((Date.now() - started) / 60000).toFixed(1)}m`,
    );
    console.log(`  ${path.relative(ROOT, MATRIX)}\n  ${path.relative(ROOT, INDEX)}\n  ${path.relative(ROOT, STATS)}`);
    if (failed.length) {
      console.log(`\nfirst ${Math.min(10, failed.length)} failures:`);
      for (const f of failed.slice(0, 10)) console.log(`  ${path.basename(f.path)}  ${f.error}`);
    }
    console.log(`\ndescriptor version ${DESCRIPTOR_VERSION}`);
  });

program
  .command('pairs')
  .description('mine the manifest for copies and measure what a copyist holds')
  .option('-o, --out <file>', 'where to write the report', path.join(ROOT, 'docs', 'influence', 'pairs.md'))
  .option('--seeds <list>', 'comma-separated seeds for the random baseline draws', (v) => v.split(',').map(Number), DEFAULT_SEEDS)
  .action((opts: { out: string; seeds: number[] }) => {
    if (!descriptorsAvailable()) {
      console.error(descriptorsUnavailableMessage());
      process.exit(1);
    }
    const emb = loadDescriptors();
    const stats = loadStats();
    const report = runPairTest(emb, stats, opts.seeds);
    const { mining, layers, measurements } = report;

    console.log(`${emb.entries.length} images, ${mining.persons} named persons with own work in the corpus`);
    console.log(`${mining.derivations} works claim a derivation; ${mining.namedDerivations} name a person; ${mining.pairs.length} resolve`);
    console.log('');
    for (const r of layers) {
      console.log(
        `  ${r.layer.padEnd(9)} pair ${r.pairMedian.toFixed(3).padStart(8)}  random ${r.randomMedian.toFixed(3).padStart(8)}` +
          `  ratio ${r.ratio.toFixed(3)} [${r.ratioRange[0].toFixed(3)}-${r.ratioRange[1].toFixed(3)}]` +
          `  nearer ${r.wins}/${r.n} z=${r.z.toFixed(2)}${r.measuresNothing ? '   <-- MEASURES NOTHING' : `   ${r.direction.toUpperCase()}`}`,
      );
    }

    // Ranked on the layers that cleared the sign test only. See `overallRatio`.
    const rank = rankingLayers(report);
    const score = (m: PairMeasurement): number => overallRatio(m, rank.layers);
    const ranked = [...measurements].filter((m) => Number.isFinite(score(m))).sort((a, b) => score(a) - score(b));
    const tightest = ranked.slice(0, 10);
    const loosest = ranked.slice(-10).reverse();

    mkdirSync(path.dirname(opts.out), { recursive: true });
    const sheet = path.join(path.dirname(opts.out), 'pairs-tightest.png');
    // Two cells per pair: the copy, then the source artist's own work nearest it on the same
    // ordering. Naming the "nearest own work" is safe here in a way it is not for plates, because
    // the claim on the sheet is about this pair's own measured distance and not about retrieval.
    contactSheet(
      tightest.flatMap((m) => {
        const near = m.pair.originals[0]!;
        return [
          { image: path.join(IMAGES, `${m.pair.derivative.sha256}.jpg`), caption: [`copy ${m.pair.relation}`, `ratio ${score(m).toFixed(3)}`] },
          { image: path.join(IMAGES, `${near.sha256}.jpg`), caption: [m.pair.originalName, 'own work'] },
        ];
      }),
      4,
      sheet,
    );

    writeFileSync(opts.out, renderPairsReport(report, tightest, loosest, emb.entries.length, path.basename(sheet), rank));
    console.log(`\n  ${path.relative(ROOT, opts.out)}\n  ${path.relative(ROOT, sheet)}`);
  });

program
  .command('artists')
  .description('who has enough works in this corpus to have a direction at all')
  .option('--min <n>', 'works a group needs to qualify', (v) => Number(v), MIN_WORKS)
  .action((opts: { min: number }) => {
    if (!descriptorsAvailable()) {
      console.error(descriptorsUnavailableMessage());
      process.exit(1);
    }
    const emb = loadDescriptors();
    const groups = groupWorks(emb, opts.min);
    const byKind = new Map<CreatorKind, { id: string; n: number }[]>();
    for (const [id, g] of groups) {
      const k = kindOf(id);
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k)!.push({ id, n: g.entries.length });
    }
    console.log(`${groups.size} groups with >=${opts.min} works, over ${emb.entries.length} images\n`);
    for (const kind of ['artist', 'studio', 'culture'] as const) {
      const rows = (byKind.get(kind) ?? []).sort((a, b) => b.n - a.n);
      console.log(`${kind.toUpperCase()} (${rows.length})`);
      for (const r of rows) console.log(`  ${String(r.n).padStart(4)}  ${r.id}`);
      console.log('');
    }
  });

program
  .command('directions')
  .description('per-layer group directions into corpus/directions.v1.json')
  .option('--min <n>', 'works a group needs to qualify', (v) => Number(v), MIN_WORKS)
  .option('-o, --out <file>', 'where to write the directions file', DIRECTIONS)
  .action((opts: { min: number; out: string }) => {
    if (!descriptorsAvailable()) {
      console.error(descriptorsUnavailableMessage());
      process.exit(1);
    }
    const emb = loadDescriptors();
    const stats = loadStats();
    const file = computeDirections(emb, stats, opts.min);
    file.packs = listPacks().map((f) => packDirections(loadPack(path.join(PACKS_DIR, f)), stats));

    console.log(`${file.groups.length} groups with >=${opts.min} works, ${file.permutations} permutations per size\n`);
    const head = `  ${'group'.padEnd(32)} ${'kind'.padEnd(8)} works  ` + LAYERS.map((l) => l.padStart(16)).join('');
    console.log(head);
    console.log(`  ${'-'.repeat(head.length - 2)}`);
    for (const g of file.groups) {
      const cells = LAYERS.map((l) => {
        const d = g.directions[l]!;
        // Magnitude and cohesion together, because either alone misleads: a large magnitude with a
        // cohesion that did not clear is a group that sits far from the corpus mean and nowhere in
        // particular. `*` marks the ones that cleared.
        const z = d.cohesionZ === null ? 'n/a' : d.cohesionZ.toFixed(1);
        return `${d.magnitude.toFixed(2)}${d.cohesive ? '*' : ' '}/${z}`.padStart(16);
      }).join('');
      console.log(`  ${g.id.slice(0, 32).padEnd(32)} ${g.kind.padEnd(8)} ${String(g.works).padStart(5)}  ${cells}`);
    }

    for (const p of file.packs) {
      const cells = LAYERS.map((l) => {
        const d = p.directions[l];
        // Coverage, not cohesion, is the number that qualifies an authored magnitude — there is no
        // group behind it to be tight or loose.
        return (d ? `${d.magnitude.toFixed(2)} /${(d.coverage * 100).toFixed(0)}%` : '-').padStart(16);
      }).join('');
      console.log(`  ${p.id.slice(0, 32).padEnd(32)} ${'authored'.padEnd(8)} ${'-'.padStart(5)}  ${cells}`);
    }

    const cells = file.groups.length * LAYERS.length;
    const cohesive = file.groups.reduce((a, g) => a + LAYERS.filter((l) => g.directions[l]!.cohesive).length, 0);
    console.log(`\n  magnitude(*=cohesive)/cohesionZ. ${cohesive}/${cells} directions are tighter than chance at z<${COHESION_Z}.`);
    console.log(`  ${cells - cohesive} are not, and may be any ${opts.min} works.`);
    const carrying = LAYERS.filter((l) => PAIR_TEST_VERDICT[l]);
    console.log(
      `  The pair test cleared ${carrying.length ? carrying.join(', ') : 'no layer'}; the other ` +
        `${LAYERS.length - carrying.length} columns are directions in a descriptor not shown to carry influence.`,
    );
    console.log(`  ${TEXT_LAYERS.join(' and ')} are reserved and null — they need a reading, not a measurement.`);
    if (file.packs.length) {
      console.log(
        `  ${file.packs.length} authored pack(s) print magnitude/coverage instead: no works stand behind them, ` +
          `so they have no cohesion, and their magnitude comes only from the fields a person filled in.`,
      );
    }

    mkdirSync(path.dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(file, null, 2) + '\n');
    console.log(`\n  ${path.relative(ROOT, opts.out)}`);
  });

program
  .command('sweep')
  .description('render one program along one influence direction, one column per k')
  .requiredOption('--program <file>', 'the program to sweep')
  .requiredOption('--group <id>', 'a group id from corpus/directions.v1.json, or an authored pack id')
  .requiredOption('--layer <layer>', 'armature | palette | texture | form')
  .option('--k <list>', 'comma-separated signed k values', (v) => v.split(',').map(Number), [-1, 0, 0.5, 1, 1.5, 2])
  .option('-o, --out <dir>', 'where to write the sweep')
  .action(async (opts: { program: string; group: string; layer: string; k: number[]; out?: string }) => {
    if (!descriptorsAvailable()) {
      console.error(descriptorsUnavailableMessage());
      process.exit(1);
    }
    const layer = opts.layer as Layer;
    if (!LAYERS.includes(layer)) {
      console.error(`--layer must be one of ${LAYERS.join(', ')}`);
      process.exit(1);
    }
    const file = JSON.parse(readFileSync(DIRECTIONS, 'utf8')) as DirectionsFile;
    const stats = loadStats();
    const weights = (JSON.parse(readFileSync(BIZARRENESS, 'utf8')) as { weights: Record<string, number> }).weights;
    const source = JSON.parse(readFileSync(opts.program, 'utf8'));
    const out = opts.out ?? path.join(ROOT, 'out', `sweep-${opts.group}-${layer}`);

    const sets = opts.k.map((k) => applyInfluence(source, file, opts.group, layer, k, stats, weights));
    const head = sets[0]!;

    console.log(`${head.label} (${head.source}) ${layer} at k=${opts.k.join(', ')}`);
    if (!head.carriesInfluence) {
      console.log(`  NOTE: the pair test did NOT show ${layer} carries influence through this corpus.`);
    }
    for (const set of sets) {
      if (!set.impossible.length) continue;
      // Printed before any rendering, because a sweep that spends ten minutes of Chromium on a
      // target no image can occupy should say so first.
      console.log(
        `  k=${set.k}: ${set.impossible.length} target value(s) OUTSIDE the descriptor's domain — ` +
          set.impossible.slice(0, 3).map((i) => `${i.field}[${i.index}]=${i.value} (allowed ${i.range[0]}..${i.range[1]})`).join(', ') +
          (set.impossible.length > 3 ? ', ...' : '') +
          '. No image can measure there, so this column is not "more of the direction", it is off the end of it.',
      );
    }
    if (!SWEEPABLE.includes(layer)) {
      // Refusing to render four identical columns and call it a sweep. A texture or form sweep has
      // neither an edit nor a constraint behind it, so there is nothing for the pixels to show.
      // The two reasons are different and the message must not fuse them. `armature` HAS
      // constraints and no edit: the checker can refuse a render for being too symmetric, and
      // nothing here can make one less symmetric. `texture` and `form` have neither.
      console.error(
        `\n  NO SWEEP: ${layer} has no deterministic program edit, so every column would be the same image.\n` +
          (head.constraints.length
            ? `  It DOES yield ${head.constraints.length} constraint(s) — ${[...new Set(head.constraints.map((c) => c.kind))].join(', ')} — which \`artist check\` can test a render against.\n` +
              `  What is missing is a rule for MAKING a render satisfy them, and inventing one here would be this file asserting what an ${layer} direction means as a drawing action.\n`
            : `  It also yields NO constraints: no kind in the closed eighteen reads this descriptor at all.\n`) +
          `  ${head.blocked.length} of its fields are unsayable; see docs/influence/NEEDS.md.\n` +
          `  Sweepable layers: ${SWEEPABLE.join(', ')}.`,
      );
      process.exit(1);
    }

    mkdirSync(out, { recursive: true });
    const report = await runSweep(opts.program, sets, layer, stats, out);

    console.log('');
    for (const s of report.steps) {
      const bad = s.verdicts.filter((v) => v.status === 'violated').length;
      console.log(
        `  k=${String(s.k).padStart(4)}  distance ${s.distance.toFixed(3).padStart(8)}  ` +
          `${s.edited ? `${s.recoloured.length} colours moved` : 'program UNCHANGED'}  ` +
          `${bad ? `${bad} constraint(s) violated` : 'constraints satisfied'}`,
      );
    }

    const sheet = path.join(out, 'sweep.png');
    contactSheet(
      report.steps.map((s) => ({
        image: path.join(s.dir, 'canonical.png'),
        caption: [`k=${s.k}  d=${s.distance.toFixed(2)}`, s.edited ? `${s.recoloured.length} colours` : 'unchanged'],
      })),
      report.steps.length,
      sheet,
    );
    writeFileSync(path.join(out, 'sweep.json'), JSON.stringify(report, null, 2) + '\n');
    // Break records: which of the emitted influence constraints each k actually breaks. Not
    // `artist/breaks.ts` — that reads a trajectory log and asks whether an ARTIST broke its own
    // commitments, which is a different question with no artist in it here.
    writeFileSync(
      path.join(out, 'breaks.json'),
      JSON.stringify(
        {
          note: 'Which influence constraints each k breaks. A sweep has no artist and no trajectory, so this is not an artist/breaks.ts BreakRecord.',
          group: report.group,
          layer,
          breaks: report.steps.flatMap((s) => s.verdicts.filter((v) => v.status !== 'satisfied').map((v) => ({ k: s.k, ...v }))),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`\n  bizarreness over this sweep: ${report.bizarreness.toFixed(2)} (reported, NOT in scores.json)`);
    console.log(`  ${path.relative(ROOT, sheet)}\n  ${path.relative(ROOT, out)}/sweep.json\n  ${path.relative(ROOT, out)}/breaks.json`);
  });

function layerTable(rows: LayerResult[]): string {
  const head =
    '| layer | median to source | median to 50 random | ratio (range over seeds) | pairs nearer source | sign-test z | verdict |\n|---|---|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| \`${r.layer}\` | ${r.pairMedian.toFixed(3)} | ${r.randomMedian.toFixed(3)} | ` +
        `${r.ratio.toFixed(3)} (${r.ratioRange[0].toFixed(3)}–${r.ratioRange[1].toFixed(3)}) | ` +
        `${r.wins}/${r.n} | ${r.z.toFixed(2)} | ` +
        `${r.measuresNothing ? '**NOTHING MEASURED**' : r.direction === 'nearer' ? 'nearer its source' : '**further from its source**'} |`,
    )
    .join('\n');
  return `${head}\n${body}`;
}

function pairRows(ms: PairMeasurement[], on: readonly Layer[]): string {
  const head = `| ratio (${on.join('+')}) | relation | copy (sha256, title) | source artist (own works) |\n|---|---|---|---|`;
  const body = ms
    .map((m) => {
      const t = m.pair.derivative.work.title.replace(/\|/g, '\\|').slice(0, 60);
      return `| ${overallRatio(m, on).toFixed(3)} | ${m.pair.relation} | \`${m.pair.derivative.sha256.slice(0, 12)}\` ${t} | ${m.pair.originalName} (${m.pair.originals.length}) |`;
    })
    .join('\n');
  return `${head}\n${body}`;
}

function renderPairsReport(
  r: ReturnType<typeof runPairTest>,
  tightest: PairMeasurement[],
  loosest: PairMeasurement[],
  images: number,
  sheetName: string,
  rank: { layers: Layer[]; measured: boolean },
): string {
  const nulls = r.layers.filter((l) => l.measuresNothing);
  const real = r.layers.filter((l) => !l.measuresNothing);
  return `# The pair test — does a copy land nearer its source?

Generated by \`npm run influence -- pairs\`. Descriptors \`${DESCRIPTOR_VERSION}\`.
${r.baselineSample} random works drawn per pair, repeated over ${r.seeds.length} seeds (${r.seeds.join(', ')}).

## The headline

**${nulls.length} of the ${r.layers.length} descriptor layers did not separate a copy from a stranger.**
${
  real.length
    ? `Only ${real.map((l) => `\`${l.layer}\``).join(' and ')} cleared the sign test — ` +
      real.map((l) => `${l.layer} at ${l.wins}/${l.n} pairs nearer their source (z=${l.z.toFixed(2)})`).join(', ') +
      `. Everything else on this page is a null: \`${nulls.map((l) => l.layer).join('`, `')}\`.`
    : 'No layer cleared the sign test. The whole descriptor set is a null on this question.'
}

This is the gate for the rest of the influence layer, and most of it did not pass. A direction, a
dial or a sweep built on a layer marked NOTHING MEASURED below is moving a number that has **not**
been shown to carry influence through this corpus. That does not make it useless — it makes every
claim about it a claim about the descriptor, not about influence.
${
  r.layers.some((l) => l.measuresNothing && l.ratio > 1)
    ? `\nNote the direction on \`${r.layers.filter((l) => l.measuresNothing && l.ratio > 1).map((l) => l.layer).join('`, `')}\`: ` +
      `the median copy sits *further* from its named source artist than from fifty random works. The sign test does not ` +
      `clear the threshold, so this is reported as a null rather than as a reversal — but it is not evidence of a weak ` +
      `positive effect either, and should not be quoted as one.`
    : ''
}

## What was measured

${images} distinct corpus images carry a descriptor row. ${r.mining.persons} named persons have at
least one work in the corpus that is not itself a copy. ${r.mining.derivations} works have a creator
field that claims a derivation; ${r.mining.namedDerivations} of those name a person rather than a
placeholder; **${r.mining.pairs.length}** name a person this corpus also holds work by, and those are
the pairs below.

The corpus almost never holds the specific painting a print was made after, so the pair distance is
the **median distance from the copy to the named artist's own works**, and the baseline is the
median distance from the same copy to ${r.baselineSample} random corpus works. Same estimator on
both sides. A ratio below 1 means the copy sits nearer its source than nearer a stranger.

## The table

${layerTable(r.layers)}

### Why the verdict is the sign test and not the ratio

The ratio was the obvious statistic and it is not a stable one. Re-running this test over the five
seeds moved \`palette\` between 0.937 and 0.955 — across a ±0.05 band around 1.0 — so a band verdict
for that layer would have been a fact about which fifty works were drawn. The count of pairs sitting
nearer their source moved by at most two over the same seeds, because it asks about each pair
separately rather than about a median of medians. So \`wins\` decides and the ratio is reported with
its spread. z=${Z_THRESHOLD.toFixed(1)} is roughly the 5% two-sided point; it is a threshold, not a
p-value, and there is no multiple-comparison correction across the ${r.layers.length} layers.

${
  nulls.length
    ? `### ${nulls.length} of ${r.layers.length} layers measured nothing\n\n` +
      nulls
        .map(
          (l) =>
            `- **\`${l.layer}\` — ${l.wins}/${l.n} pairs nearer, z=${l.z.toFixed(2)}, ratio ${l.ratio.toFixed(3)} ` +
            `(${l.ratioRange[0].toFixed(3)}–${l.ratioRange[1].toFixed(3)}).** A copy is not measurably nearer its ` +
            `source than a random object in this corpus is, on this descriptor.`,
        )
        .join('\n')
    : 'Every layer separated a copy from a stranger.'
}

## Splits

Only splits with at least ${MIN_SPLIT} pairs get a table. The rest are listed underneath as counts
and nothing else: at n=6 the sign test calls 6/6 significant, and a "nearer its source" verdict off
six works reads exactly like one off sixty-six.

${r.splits.map((s) => `### ${s.name} (n=${s.n})\n\n${layerTable(s.layers)}`).join('\n\n')}

### Too small to measure

${r.tooSmall.length ? r.tooSmall.map((s) => `- ${s.name} — ${s.n} pair${s.n === 1 ? '' : 's'}`).join('\n') : 'None.'}

## The ten tightest pairs

Ranked on \`${rank.layers.join('`, `')}\`${
    rank.measured
      ? ' — the layer' + (rank.layers.length === 1 ? '' : 's') + ' that cleared the sign test, and nothing else.'
      : ' — **no layer cleared the sign test, so this ordering is over four nulls and means nothing.** ' +
        'The sheet below is here because it was asked for, not because it is evidence.'
  }
${
  rank.measured
    ? `Averaging all four layers would have ranked these pairs mostly on the ${r.layers.length - rank.layers.length} ` +
      'that measure nothing, and produced a contact sheet of noise that looked exactly like evidence.'
    : ''
}

![tightest pairs](${sheetName})

Cells alternate: the copy, then one of the source artist's own works.

${pairRows(tightest, rank.layers)}

## The ten loosest pairs

${pairRows(loosest, rank.layers)}

## How to read this honestly

- The ratio is a **median over pairs of a median over works**. It is robust to one bad join and it is
  not a significance test. With n=${r.mining.pairs.length}, a layer 3% from 1.0 has shown nothing.
- "Source artist" is a **name**, joined on spelling. This corpus has no artist authority file, so two
  people with the same name are one person here and one person with two spellings is two.
- The count in brackets after each artist is how many of their own works the median was taken over.
  A pair whose artist has one work in the corpus is a distance between two images wearing the same
  clothes as a distance between an image and an oeuvre.
- \`after\` dominates the sample. The other relations are reported where n>=5 and are too small to
  carry an argument on their own.
`;
}

await program.parseAsync(process.argv);
