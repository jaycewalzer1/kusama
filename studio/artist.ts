// `artist` — run the loop, and everything you can do to a run afterwards.
//
//   artist run <position> <brief>        one trajectory into a directory
//   artist grid <dir>                    the whole grid, serially, plus the control column
//   artist steps <dir>                   one record per step: before, action, after, what it moved
//   artist breaks <dir>                  which commitment broke, what forced it, declared or not
//   artist provenance <dir>              has this combination of lineages been made before?
//   artist archive <runs>                finished plates filed by what they look like, in a grid
//   artist envelope [runs]               how much of 0..1 each descriptor actually reaches
//   artist rate [--set p tier]           hand-rate plates into the pool everything else is checked against
//   artist validate-reward <runs>        the component-correlation gate and the top-k agreement readout
//   artist filmstrip <dir> [--story]     the piece rebuilt step by step, and the survival curve
//                                        --story adds index.html: each frame next to why it happened
//   artist twin <arm> <control>          does the position steer, or is it decoration? the two arms
//                                        compared on what they DID, not on what they scored
//   artist pass <dir> --prompt <text>    the optional diffusion pass over the finished plate
//   artist replay <dir>                  the same trajectory with the model unplugged
//   artist recompute <dir...>            rebuild scores.json from the log alone
//   artist strip <dir>                   every plate the trajectory stood on, left to right
//   artist sheet <dir>                   the grid image from directories already run
//   artist blindpack <dir...>            the human test: pictures, practices, and a sealed key
//   artist export <dir...>               chat-format JSONL for training
//
// Renders are strictly serial inside a process (NOTES R8), so `grid` runs its cells one after
// another and takes as long as it takes. Parallelism, if it is ever wanted, belongs across processes.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Canvas } from '../artist/canvas.js';
import { pairsOf, writePack } from '../artist/blindpack.js';
import { filmstrip, finalHashOf } from '../artist/filmstrip.js';
import {
  alreadyDone,
  cellName,
  gridSheet,
  parseCell,
  runDir,
  scoreSpreads,
  spreadText,
  strip,
  type Cell,
  type GridCell,
} from '../artist/grid.js';
import { selectPolicy } from '../artist/policy/interface.js';
import { recomputeMatches, scoresCsv } from '../artist/reward.js';
import { driftText } from '../artist/env-version.js';
import { judgeSummary, judgeTrajectory, type Judgment } from '../artist/judge.js';
import { finalPass, passText, type PassFidelity, type PassQuality, type PassSize } from '../artist/pass.js';
import { replay } from '../artist/replay.js';
import { runTrajectory } from '../artist/run.js';
import { storyOf, storyText, summarise as summariseLine } from '../artist/story.js';
import { readLog } from '../artist/studio-log.js';
import { processOf, processText } from '../artist/transition.js';
import { breakRecordOf, breakText } from '../artist/breaks.js';
import { provenanceOf, provenanceText } from '../artist/provenance.js';
import { archive, archiveText, measureRuns, DEFAULT_AXES, DEFAULT_BINS, DESCRIPTORS, type Descriptor } from '../artist/archive.js';
import { envelope, envelopeText, gather } from '../artist/envelope.js';
import {
  CORRELATION_LIMIT,
  DEFAULT_KS,
  TIER_NAMES,
  agreementText,
  assertIndependent,
  componentCorrelations,
  componentRows,
  correlationText,
  jaccardAt,
  pairwise,
  ratingsAsRanked,
  readPool,
  type Comparison,
  type Tier,
} from '../artist/ratings.js';
import { DEFAULT_POOL, rateInteractive, setRating, summary } from './rate.js';
import { twinOf, twinText } from '../artist/twin.js';
import { walkthroughOf, walkthroughHtml } from '../artist/walkthrough.js';
import { sftLines, toJsonl } from '../artist/export.js';
import { ROOT } from '../env/browser.js';
import type { Trajectory } from '../artist/types.js';

/**
 * Read off disk rather than listed here. A hardcoded catalog in the CLI goes stale the first time a
 * document is added or renamed, and it goes stale silently: `grid` just runs a smaller grid.
 */
const ids = (dir: string) =>
  readdirSync(path.join(ROOT, 'aesthetic', dir))
    .filter((f) => f.endsWith('.json') && !f.endsWith('.field.json'))
    .sort()
    .map((f) => f.slice(0, -'.json'.length));

const POSITIONS = ids('positions');
const BRIEFS = ids('briefs');

function summarise(t: Trajectory): string {
  const s = t.scores;
  const n = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
  return [
    // The stop, on the same line as the cell, never `outcome` alone. A run can end with every score
    // under it green and still not have earned the stop, and that gap is the thing most worth
    // seeing first — so it prints next to the word that used to absorb it.
    `${t.positionId} x ${t.briefId}  ${t.outcome}` +
      `  [${s.termination.kind}${s.termination.legitimate ? '' : ', not legitimate'}` +
      `${s.termination.edgesUnrealized > 0 ? `, ${s.termination.edgesUnrealized} edges unrealized` : ''}]`,
    `  tree ${n(s.tree)}  render ${n(s.render)}  hard ${s.hardViolations}  soft ${s.softViolations}`,
    `  realization ${n(s.realization.score)} (${s.realization.satisfied}/${s.realization.mechanical} decidable, ${s.realization.judgePending} judge-pending)` +
      `${s.realization.fused ? `  fused ${n(s.realization.fused.score)} (${s.realization.fused.satisfied}/${s.realization.fused.decidable}, ${s.realization.fused.fromEye} from the eye)` : ''}`,
    `  tree vs eye ${s.examineAgreement ? `${s.examineAgreement.agree}/${s.examineAgreement.comparable} agree (${s.examineAgreement.treeYesEyeNo} unseen, ${s.examineAgreement.treeNoEyeYes} claimed, ${s.examineAgreement.treePending} beyond the tree, ${s.examineAgreement.unplanned} unplanned)` : 'not examined'}`,
    // Where the reward stopped moving. Beside the outcome scores because a perfect `tree` over a
    // long trailing stall is a run that arrived early and then had nothing left to learn from.
    `  gradient ${s.gradient ? `${s.gradient.improvedSteps}/${t.steps.length} steps improved, ${s.gradient.trailing} trailing, longest stall ${s.gradient.longestStall}` : 'not recorded'}`,
    `  drift ${s.drift}  replans ${s.problemFindingSteps}  grounded ${s.problemsGrounded}/${t.problems.length}  destruction ${s.destructionRate}`,
    `  risk ${s.riskDeclared ? 'declared' : 'not declared'}, ${s.riskMoveTaken ? `taken: ${s.riskConvention}` : 'not taken'}  selfScore ${s.selfScore ?? 'n/a'}`,
    `  ${t.steps.length} steps, ${t.cost.policyCalls} policy calls, ${t.cost.renders} renders, $${t.cost.usd.toFixed(4)}, ${(t.cost.wallMs / 1000).toFixed(1)}s`,
  ].join('\n');
}

function trajectoriesIn(dir: string): { dir: string; trajectory: Trajectory }[] {
  const out: { dir: string; trajectory: Trajectory }[] = [];
  const walk = (d: string) => {
    const final = path.join(d, 'final.json');
    if (existsSync(final)) {
      out.push({ dir: d, trajectory: JSON.parse(readFileSync(final, 'utf8')) as Trajectory });
      return;
    }
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
    }
  };
  walk(dir);
  return out;
}

/**
 * k independent seeds of each named cell, serially, resumable.
 *
 * This is the shape the n=1-per-cell grid could not produce. One seed per cell cannot separate a
 * cell effect from run variance, so a table built from it reports differences that may be entirely
 * the seed; k seeds per cell gives every score a within-cell spread to be judged against, which is
 * what `scoreSpreads` then does.
 *
 * Serial because renders share one Chromium GPU process (NOTES R8) and concurrent renders diverge.
 * Resumable because a batch of this size will be interrupted: an existing `final.json` is loaded
 * rather than re-run, so continuing costs only the runs that never finished. Cost is real money and
 * hours, and restarting from zero after an interruption is how a batch never completes.
 */
async function runCells(opts: Record<string, string | boolean>): Promise<void> {
  const cells: Cell[] = String(opts['cells']).split(',').map(parseCell);
  const k = Number(opts['k']);
  const seed0 = Number(opts['seed0']);
  const root = String(opts['out']);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be a positive integer, got "${opts['k']}"`);

  // Every cell is validated against the catalog before the first model call. Finding out at cell
  // three of three that a brief id was misspelled costs the two cells already paid for.
  for (const c of cells) {
    const missing = [
      POSITIONS.includes(c.positionId) ? null : `position "${c.positionId}"`,
      BRIEFS.includes(c.briefId) ? null : `brief "${c.briefId}"`,
    ].filter(Boolean);
    if (missing.length) throw new Error(`cell ${cellName(c)}: no such ${missing.join(', ')}`);
  }

  // Selected on first use, not up front: a batch whose runs are all already on disk is a rescore of
  // work already paid for, and it should not need a key or a provider to rebuild spread.json.
  let policy: Awaited<ReturnType<typeof selectPolicy>> | null = null;
  const rows: { cell: string; scores: Trajectory['scores'] }[] = [];
  const done: Trajectory[] = [];
  const failed: string[] = [];
  let resumed = 0;
  const total = cells.length * k;
  let n = 0;

  for (const c of cells) {
    for (let i = 0; i < k; i++) {
      const seed = seed0 + i;
      const dir = runDir(root, c, seed);
      n++;
      const label = `[${n}/${total}] ${cellName(c)} seed ${seed}`;

      if (alreadyDone(dir)) {
        const t = JSON.parse(readFileSync(path.join(dir, 'final.json'), 'utf8')) as Trajectory;
        rows.push({ cell: cellName(c), scores: t.scores });
        done.push(t);
        resumed++;
        console.log(`${label}: already done, resumed`);
        continue;
      }

      mkdirSync(dir, { recursive: true });
      console.log(`${label}: running`);
      // Outside the try on purpose. A missing key is a fact about the machine, not about this seed,
      // and catching it per-run turns one configuration error into k*cells identical failures and an
      // empty corpus that then reports itself as having nothing wrong with it.
      policy ??= await selectPolicy();
      try {
        const t = await runTrajectory({
          policy,
          positionId: c.positionId,
          briefId: c.briefId,
          seed,
          outDir: dir,
          maxSteps: Number(opts['steps']),
          control: c.control,
        });
        rows.push({ cell: cellName(c), scores: t.scores });
        done.push(t);
        console.log(summarise(t));
      } catch (e) {
        // A dead seed is one hole, not the end of the batch: the remaining cells are still worth
        // the money already committed, and the hole is reported rather than averaged over.
        failed.push(`${cellName(c)} seed ${seed}: ${e instanceof Error ? e.message : String(e)}`);
        console.error(`FAILED ${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const spreads = scoreSpreads(rows);
  writeFileSync(path.join(root, 'spread.json'), `${JSON.stringify(spreads, null, 2)}\n`);
  writeFileSync(path.join(root, 'scores.csv'), `${scoresCsv(done)}\n`);
  console.log(
    `\n${done.length}/${total} run(s) in hand${resumed ? ` (${resumed} resumed)` : ''}; scores.csv and spread.json written.\n`
  );
  console.log(spreadText(spreads));
  if (failed.length) console.log(`\nfailed:\n  ${failed.join('\n  ')}`);
}

const program = new Command();
program.name('artist').description('Run the artist loop and inspect what it did.');

program
  .command('run')
  .argument('<position>')
  .argument('<brief>')
  .requiredOption('-o, --out <dir>', 'directory for studio.jsonl, final.json, final.png and sketches/')
  .option('--seed <n>', 'master seed for the program', '1')
  .option('--steps <n>', 'steps the artist is told it has', '12')
  .option('--hard-stop <n>', 'steps it may not exceed whatever it says', '20')
  .option('--sketches <n>', 'sketches per problem', '3')
  .option('--no-audience', 'skip the audience read and its trigger (saves one env call per look)')
  .option('--control', 'strip the position: same brief, same checker, no steering')
  .option('--blind', 'the ablation: take the canvas away during MAKE and work from the tree and the describer alone')
  .option('--elements <ids>', 'comma-separated lineage elements to compose into the position', '')
  .option('--pass <prompt>', 'after the run, put final.png through the diffusion model with this prompt')
  .option('--pass-size <size>', 'auto | 1024x1024 | 1536x1024 | 1024x1536', 'auto')
  .option('--pass-quality <q>', 'auto | low | medium | high', 'high')
  .option('--pass-fidelity <f>', 'low | high — how much of the plate survives the pass', 'high')
  .action(async (position: string, brief: string, opts: Record<string, string | boolean>) => {
    const t = await runTrajectory({
      policy: await selectPolicy(),
      positionId: position,
      briefId: brief,
      elementIds: String(opts['elements'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      seed: Number(opts['seed']),
      outDir: String(opts['out']),
      maxSteps: Number(opts['steps']),
      hardStop: Number(opts['hardStop']),
      sketchesPerProblem: Number(opts['sketches']),
      useAudience: opts['audience'] !== false,
      control: Boolean(opts['control']),
      showCanvas: !opts['blind'],
    });
    console.log(summarise(t));
    // After everything the run reports on, and outside its numbers. A pass that failed must not make
    // a finished trajectory look failed — the work is already on disk and already scored.
    if (opts['pass']) {
      const dir = String(opts['out']);
      try {
        console.log(`\n${passText(dir, await finalPass(dir, passOptions(String(opts['pass']), opts)))}`);
      } catch (e) {
        console.error(`\nthe run finished; the final pass did not: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      }
    }
  });

/** The three pass settings, shared by `run --pass` and `pass`, validated before any money is spent. */
function passOptions(prompt: string, opts: Record<string, unknown>) {
  const one = <T extends string>(name: string, value: unknown, allowed: readonly T[]): T => {
    if (!allowed.includes(value as T)) throw new Error(`--${name} must be one of: ${allowed.join(' ')}`);
    return value as T;
  };
  return {
    prompt,
    size: one('pass-size', opts['passSize'] ?? 'auto', ['auto', '1024x1024', '1536x1024', '1024x1536'] as const) as PassSize,
    quality: one('pass-quality', opts['passQuality'] ?? 'high', ['auto', 'low', 'medium', 'high'] as const) as PassQuality,
    inputFidelity: one('pass-fidelity', opts['passFidelity'] ?? 'high', ['low', 'high'] as const) as PassFidelity,
  };
}

program
  .command('pass')
  .description('put a finished plate through the diffusion model once — written as pass.png beside final.png')
  .argument('<dir>')
  .requiredOption('--prompt <text>', 'what the pass is being asked to do; recorded verbatim in pass.json')
  .option('--pass-size <size>', 'auto | 1024x1024 | 1536x1024 | 1024x1536', 'auto')
  .option('--pass-quality <q>', 'auto | low | medium | high', 'high')
  .option('--pass-fidelity <f>', 'low | high — how much of the plate survives the pass', 'high')
  .action(async (dir: string, opts: Record<string, string>) => {
    console.log(passText(dir, await finalPass(dir, passOptions(String(opts['prompt']), opts))));
  });

program
  .command('grid')
  .description('every position against every brief, serially, plus a control column')
  .requiredOption('-o, --out <dir>', 'root directory; one subdirectory per cell')
  .option('--seed <n>', 'master seed', '1')
  .option('--steps <n>', 'steps per trajectory', '12')
  .option('--positions <ids>', 'comma-separated subset', POSITIONS.join(','))
  .option('--briefs <ids>', 'comma-separated subset', BRIEFS.join(','))
  .option('--control-brief <id>', 'the brief the control column runs', BRIEFS[0])
  .option('--no-control', 'skip the control column')
  .option(
    '--cells <list>',
    'comma-separated position:brief[:control]; runs --k seeds of each instead of the cross-product'
  )
  .option('--k <n>', 'independent seeds per cell, only with --cells', '1')
  .option('--seed0 <n>', 'first seed; the k seeds are seed0..seed0+k-1', '1')
  .action(async (opts: Record<string, string | boolean>) => {
    if (opts['cells']) return runCells(opts);
    const positions = String(opts['positions']).split(',');
    const briefs = String(opts['briefs']).split(',');
    const root = String(opts['out']);
    const policy = await selectPolicy();
    const rows: GridCell[][] = [];
    const done: Trajectory[] = [];
    const failed: string[] = [];

    // Columns are the briefs, then one control cell on a single brief: the control arm answers
    // "does the position steer?", and one cell per position answers it. Five more would not.
    const columns: { brief: string; control: boolean }[] = briefs.map((brief) => ({ brief, control: false }));
    if (opts['control'] !== false) columns.push({ brief: String(opts['controlBrief']), control: true });

    for (const position of positions) {
      const row: GridCell[] = [];
      for (const { brief, control } of columns) {
        const dir = path.join(root, `${position}__${brief}${control ? '__control' : ''}`);
        mkdirSync(dir, { recursive: true });
        try {
          const t = await runTrajectory({
            policy,
            positionId: position,
            briefId: brief,
            seed: Number(opts['seed']),
            outDir: dir,
            maxSteps: Number(opts['steps']),
            control,
          });
          done.push(t);
          row.push({ dir });
          console.log(summarise(t));
        } catch (e) {
          // A cell that dies is a hole in the grid and a line in the report, not the end of the run.
          failed.push(`${position} x ${brief}${control ? ' (control)' : ''}: ${e instanceof Error ? e.message : String(e)}`);
          row.push({ dir: null });
          console.error(`FAILED ${position} x ${brief}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      rows.push(row);
    }

    const { png, missing } = gridSheet(rows);
    writeFileSync(path.join(root, 'grid.png'), png);
    writeFileSync(path.join(root, 'scores.csv'), `${scoresCsv(done)}\n`);
    console.log(`\ngrid.png written with ${missing} blank cell(s); scores.csv has ${done.length} rows.`);
    if (failed.length) console.log(`failed cells:\n  ${failed.join('\n  ')}`);
  });

program
  .command('sheet')
  .description('build grid.png from cell directories that have already been run')
  .argument('<dir>')
  .action((dir: string) => {
    const cells = trajectoriesIn(dir);
    const byPosition = new Map<string, GridCell[]>();
    for (const { dir: d, trajectory } of cells) {
      const row = byPosition.get(trajectory.positionId) ?? [];
      row.push({ dir: d });
      byPosition.set(trajectory.positionId, row);
    }
    const { png, missing } = gridSheet([...byPosition.values()]);
    const out = path.join(dir, 'grid.png');
    writeFileSync(out, png);
    console.log(`${out}: ${cells.length} cells, ${missing} blank`);
  });

program
  .command('story')
  .description('what the run did, folded into acts and beats — the log without the 200 lines')
  .argument('<dir>')
  .action((dir: string) => {
    const lines = readLog(path.join(dir, 'studio.jsonl'));
    console.log(storyText(storyOf(lines.map((l) => ({ seq: l.seq, t: l.t, kind: l.kind, summary: summariseLine(l.kind, l.data) })))));
  });

program
  .command('steps')
  .description('one line per step: before, the edits, after, what it moved — written as transitions.json')
  .argument('<dir>')
  .action((dir: string) => {
    const p = processOf(readLog(path.join(dir, 'studio.jsonl')));
    writeFileSync(path.join(dir, 'transitions.json'), `${JSON.stringify(p, null, 2)}\n`);
    console.log(processText(p));
  });

program
  .command('breaks')
  .description('which commitment broke, what forced it, and whether it was declared — written as breaks.json')
  .argument('<dir>')
  .action((dir: string) => {
    const r = breakRecordOf(readLog(path.join(dir, 'studio.jsonl')));
    writeFileSync(path.join(dir, 'breaks.json'), `${JSON.stringify(r, null, 2)}\n`);
    console.log(breakText(r));
  });

program
  .command('provenance')
  .description('whether this combination of lineages has been made before — written as provenance.json')
  .argument('<dir>')
  .action((dir: string) => {
    const start = readLog(path.join(dir, 'studio.jsonl')).find((l) => l.kind === 'trajectory-start');
    if (!start) throw new Error('no trajectory-start line: this is not a trajectory log');
    const r = provenanceOf(dir, (start.data as { elementIds?: string[] }).elementIds ?? []);
    writeFileSync(path.join(dir, 'provenance.json'), `${JSON.stringify(r, null, 2)}\n`);
    console.log(provenanceText(r));
  });

program
  .command('archive')
  .description('finished plates filed by what they look like — the MAP-Elites grid, storage and inspection only')
  .argument('<runs>', 'the directory holding the run directories')
  .option('--x <descriptor>', `x axis, one of: ${DESCRIPTORS.join(' ')}`, DEFAULT_AXES[0])
  .option('--y <descriptor>', `y axis, one of: ${DESCRIPTORS.join(' ')}`, DEFAULT_AXES[1])
  .option('--bins <n>', 'cells per side', String(DEFAULT_BINS))
  .action((runs: string, opts: { x: string; y: string; bins: string }) => {
    for (const d of [opts.x, opts.y]) {
      if (!(DESCRIPTORS as readonly string[]).includes(d)) {
        throw new Error(`"${d}" is not measured. The axes come from RenderMetrics: ${DESCRIPTORS.join(', ')}`);
      }
    }
    const { measured, skipped } = measureRuns(runs);
    const a = archive(measured, [opts.x as Descriptor, opts.y as Descriptor], Number(opts.bins));
    writeFileSync(path.join(runs, 'archive.json'), `${JSON.stringify(a, null, 2)}\n`);
    console.log(archiveText(a));
    for (const s of skipped) console.log(`skipped, not a readable finished run: ${s}`);
  });

program
  .command('envelope')
  .description('the measured range of every descriptor — what "the edge of the medium" is, or a refusal')
  .argument('[runs]', 'a directory of run directories to include alongside the metrics cache')
  .option('-o, --out <file>', 'also write the envelope as JSON')
  .action((runs: string | undefined, opts: { out?: string }) => {
    const { points, excluded } = gather(runs ?? null);
    const e = envelope(points, excluded);
    if (opts.out) writeFileSync(opts.out, `${JSON.stringify(e, null, 2)}\n`);
    console.log(envelopeText(e));
  });

program
  .command('rate')
  .description('hand-rate plates into the pool every later judge is validated against')
  .option('--runs <dir>', 'the directory holding the run directories', 'out')
  .option('--pool <file>', 'the ratings file', DEFAULT_POOL)
  .option('--rater <name>', 'who is rating', process.env['USER'] ?? 'me')
  .option('--again', 'go back over plates that already have a rating', false)
  .option('--open', 'hand each plate to the desktop image viewer', false)
  .option('--set <plate>', 'rate one plate without a terminal; needs --tier')
  .option('--tier <tier>', TIER_NAMES.join(' | '))
  .option('--status', 'print the pool and stop', false)
  .action(async (opts: Record<string, string | boolean>) => {
    const o = {
      runs: String(opts['runs']),
      pool: String(opts['pool']),
      rater: String(opts['rater']),
      again: Boolean(opts['again']),
      open: Boolean(opts['open']),
    };
    if (opts['status']) {
      console.log(summary(o));
      return;
    }
    if (opts['set']) {
      const tier = String(opts['tier'] ?? '');
      if (!(TIER_NAMES as readonly string[]).includes(tier)) {
        throw new Error(`--tier must be one of: ${TIER_NAMES.join(' ')}`);
      }
      console.log(setRating(String(opts['set']), tier as Tier, o));
      console.log(summary(o));
      return;
    }
    await rateInteractive(o);
  });

program
  .command('validate-reward')
  .description('the two checks that come before any of these numbers is a reward: independence, and top-k agreement')
  .argument('<runs>', 'the directory holding the run directories')
  .option('--pool <file>', 'the ratings file', DEFAULT_POOL)
  .option('--judgments <file>', 'judgments from `artist judge -o`, or a list of pairwise comparisons')
  .option('--limit <r>', 'the correlation above which two components are one component', String(CORRELATION_LIMIT))
  .action((runs: string, opts: Record<string, string>) => {
    const pool = readPool(opts['pool'] ?? DEFAULT_POOL);
    if (pool.ratings.length === 0) {
      console.log(`no ratings in ${opts['pool'] ?? DEFAULT_POOL}. Run \`artist rate\` first — this check is against a person.`);
      process.exitCode = 1;
      return;
    }

    // The gate, over the rated plates only. Correlating components across every run on disk would be
    // a bigger sample and the wrong one: the question is whether these components are independent
    // over the plates somebody actually looked at, which is the set any reward would be fit to.
    const { rows, missing } = componentRows(runs, pool.ratings.map((r) => r.plate));
    const report = componentCorrelations(rows, Number(opts['limit'] ?? CORRELATION_LIMIT));
    console.log(correlationText(report));
    if (missing.length) console.log(`  ${missing.length} rated plate(s) have no readable scores: ${missing.join(' ')}`);

    if (opts['judgments']) {
      const parsed = JSON.parse(readFileSync(opts['judgments'], 'utf8')) as unknown[];
      const theirs = isComparisons(parsed)
        ? (() => {
            const p = pairwise(parsed);
            console.log(
              `\n${p.verdicts.length} pair(s) compared both ways, ${p.unpaired.length} seen one way only, ` +
                `order bias ${p.orderBias === null ? 'unmeasurable' : p.orderBias.toFixed(3)}`
            );
            return p.ranked;
          })()
        : (parsed as Judgment[]).map((j) => ({ id: path.basename(j.trajectoryId), score: j.necessity.score }));
      console.log('');
      console.log(agreementText(DEFAULT_KS.map((k) => jaccardAt(k, ratingsAsRanked(pool.ratings), theirs))));
    } else {
      console.log('\nno --judgments: nothing to agree or disagree with yet.');
    }

    // Loud, and last, so the reason is on screen above it.
    assertIndependent(report);
  });

/** A comparisons file names two plates and a winner; a judgments file does not. */
function isComparisons(xs: unknown[]): xs is Comparison[] {
  const first = xs[0] as Partial<Comparison> | undefined;
  return typeof first?.first === 'string' && typeof first.second === 'string';
}

program
  .command('filmstrip')
  .description('the piece rebuilt step by step, and the pixel survival curve off it')
  .argument('<dir>')
  .option('--story', 'also write index.html: every frame next to the reasoning that produced it')
  .action(async (dir: string, opts: Record<string, boolean>) => {
    const lines = readLog(path.join(dir, 'studio.jsonl'));
    const canvas = new Canvas();
    try {
      const strip = await filmstrip(lines, canvas, finalHashOf(dir));
      const into = path.join(dir, 'filmstrip');
      mkdirSync(into, { recursive: true });
      for (const f of strip.frames) writeFileSync(path.join(into, `step-${String(f.k).padStart(2, '0')}.png`), f.png);
      writeFileSync(
        path.join(into, 'survival.json'),
        `${JSON.stringify({ meanSurvival: strip.meanSurvival, survival: strip.survival }, null, 2)}\n`
      );
      if (opts['story']) {
        const w = walkthroughOf(lines, strip.frames, strip.survival, strip.meanSurvival);
        writeFileSync(path.join(into, 'walkthrough.json'), `${JSON.stringify(w, null, 2)}\n`);
        writeFileSync(path.join(into, 'index.html'), walkthroughHtml(w));
      }
      for (const r of strip.survival) {
        const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
        console.log(
          `k${String(r.k).padStart(2)}  laid ${pct(r.laidDown).padStart(7)}  survived ${pct(r.survived).padStart(7)}  ${
            r.survival === null ? 'moved nothing' : `${pct(r.survival)} of it still visible at the end`
          }`
        );
      }
      console.log(
        strip.meanSurvival === null
          ? 'nothing was ever laid down, so there is no curve'
          : `\n${strip.frames.length} frames -> ${into}\nmean survival ${(strip.meanSurvival * 100).toFixed(2)}% — ` +
            (strip.meanSurvival >= 0.999
              ? 'nothing in this piece was painted over. It accumulated; it did not revise.'
              : 'some of what was made was covered by what came after.')
      );
      if (opts['story']) console.log(`\nwalkthrough -> ${path.join(into, 'index.html')}`);
    } finally {
      await canvas.close();
    }
  });

program
  .command('twin')
  .description('a position against its null twin, compared on actions rather than on scores')
  .argument('<arm>', 'the trajectory run with the position')
  .argument('<control>', 'the same commission and seed run with --control')
  .option('--json', 'write twin.json into the arm directory as well')
  .action((armDir: string, controlDir: string, opts: Record<string, boolean>) => {
    const log = (d: string) => readLog(path.join(d, 'studio.jsonl'));
    const t = twinOf(log(armDir), log(controlDir));
    // A pairing mistake makes every number below meaningless, so check it rather than trust the
    // argument order: two arms of one experiment differ in exactly one thing.
    const head = (d: string) => {
      const f = path.join(d, 'final.json');
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Trajectory) : null;
    };
    const a = head(armDir);
    const c = head(controlDir);
    if (a && c) {
      const mismatched = (['positionId', 'briefId', 'seed'] as const).filter((k) => a[k] !== c[k]);
      if (mismatched.length) {
        console.error(`WARNING: these are not two arms of one experiment — they differ in ${mismatched.join(', ')}`);
      }
      if (a.control) console.error('WARNING: the first directory is itself a control arm');
      if (!c.control) console.error('WARNING: the second directory was not run with --control');
    }
    console.log(twinText(t));
    if (opts['json']) {
      writeFileSync(path.join(armDir, 'twin.json'), `${JSON.stringify(t, null, 2)}\n`);
      console.log(`\n${path.join(armDir, 'twin.json')}`);
    }
  });

program
  .command('replay')
  .description('re-run a trajectory from its own log, with no model')
  .argument('<dir>')
  .option('-o, --out <dir>', 'where the replayed trajectory is written', '')
  .action(async (dir: string, opts: Record<string, string>) => {
    const into = opts['out'] || path.join(dir, 'replay');
    const r = await replay(dir, into);
    if (r.envDrift.length > 0) {
      console.log(`${r.id}: NOT COMPARABLE — the environment moved after this run was recorded`);
      console.log(`  ${driftText(r.envDrift)}`);
      console.log('  Nothing was replayed. Rebuilding this run\'s observations under a different');
      console.log('  serializer would report differences that are not the run\'s to answer for.');
      process.exitCode = 1;
      return;
    }
    console.log(`${r.id}: ${r.ok ? 'REPLAYED' : 'DIVERGED'}`);
    console.log(`  final hash  ${r.finalHash.original.slice(0, 16)} -> ${r.finalHash.replayed.slice(0, 16)}`);
    console.log(`  scores      ${r.scoresEqual ? 'identical' : 'DIFFERENT'}`);
    if (r.chainProblems.length) console.log(`  log chain:\n    ${r.chainProblems.map((p) => `line ${p.seq}: ${p.problem}`).join('\n    ')}`);
    if (r.observationMismatches.length) {
      console.log(`  observations that did not rebuild:\n    ${r.observationMismatches.map((m) => `call ${m.index} (${m.name})`).join('\n    ')}`);
    }
    if (r.differences.length) console.log(`  differences:\n    ${r.differences.join('\n    ')}`);
    process.exitCode = r.ok ? 0 : 1;
  });

program
  .command('recompute')
  .description('rebuild scores.json from studio.jsonl and compare')
  .argument('<dirs...>')
  .option('--write', 'write the recomputed scores to scores.v2.json beside the original')
  .action(async (dirs: string[], opts: Record<string, unknown>) => {
    const canvas = new Canvas();
    let bad = 0;
    try {
      for (const dir of dirs.flatMap((d) => trajectoriesIn(d).map((t) => t.dir))) {
        const r = await recomputeMatches(dir, canvas);
        if (r.unscorable) {
          bad++;
          console.log(`UNSCORABLE ${dir}\n  ${r.unscorable}`);
          continue;
        }
        console.log(`${r.ok ? 'exact  ' : 'DIFFERS'} ${dir}`);
        if (!r.ok) {
          bad++;
          console.log(`  ${r.differences.join('\n  ')}`);
        }
        // Not a failure. These are scores that did not exist when the run was recorded, and the
        // only dishonest thing to do with them is leave them out of the report.
        if (r.added.length > 0) console.log(`  + ${r.added.join('\n  + ')}`);
        if (opts['write'] && r.scores) {
          // Beside scores.json, never over it. The original is what the run actually reported, and
          // a rescore that edits it in place makes every later comparison unfalsifiable — there is
          // no longer anything on disk that says what the number was at the time.
          const to = path.join(dir, 'scores.v2.json');
          writeFileSync(to, JSON.stringify(r.scores, null, 2));
          console.log(`  wrote ${to}`);
        }
      }
    } finally {
      await canvas.close();
    }
    process.exitCode = bad === 0 ? 0 : 1;
  });

program
  .command('blindpack')
  .description('a folder of paired finals and unlabelled practices, plus a sealed answer key')
  .argument('<dirs...>')
  .option('-o, --out <dir>', 'where to write the pack', 'out/blindpack')
  .option('--seed <n>', 'the shuffle seed, so a pack can be regenerated exactly', '1')
  .action((dirs: string[], opts: Record<string, string>) => {
    const runs = dirs
      .flatMap((d) => trajectoriesIn(d))
      .map(({ dir, trajectory }) => ({
        dir,
        positionId: trajectory.positionId,
        briefId: trajectory.briefId,
      }));
    const pack = pairsOf(runs, Number(opts['seed']));
    if (pack.pairs.length === 0) {
      console.log('no pair of runs shares a brief and an object under different positions');
      for (const s of pack.skipped) console.log(`  skipped ${s.dir}: ${s.why}`);
      process.exitCode = 1;
      return;
    }
    const written = writePack(pack, opts['out']!);
    console.log(`${pack.pairs.length} pairs, ${written.length} files -> ${opts['out']}`);
    for (const p of pack.pairs) console.log(`  ${p.name}  ${p.briefId}`);
    // Loudly, not in a log file. A pack quietly missing half its runs is a test of a different
    // thing from the one it says it is.
    for (const s of pack.skipped) console.log(`  skipped ${s.dir}: ${s.why}`);
  });

program
  .command('judge')
  .description('L5: the three offline critics — attribution, necessity, derivation — over finished runs')
  .argument('<dirs...>')
  .option('-o, --out <file>', 'where to write the judgments as JSON')
  .action(async (dirs: string[], opts: Record<string, string>) => {
    const found = dirs.flatMap((d) => trajectoriesIn(d));
    if (!found.length) {
      console.log('no finished trajectory under those directories');
      process.exitCode = 1;
      return;
    }
    const judgments = [];
    for (const { dir } of found) {
      const j = await judgeTrajectory(dir);
      judgments.push(j);
      console.log(
        `${dir}  ${j.positionId}${j.control ? ' (control)' : ''}  ` +
          `attributed ${j.attribution.chose}${j.attribution.correct ? ' HIT' : ' miss'}  ` +
          `necessity ${j.necessity.score}/7  ${j.derivation.verdict}` +
          `${j.derivation.clichesTaken.length ? ` (${j.derivation.clichesTaken.length} cliche)` : ''}`
      );
    }
    console.log('');
    console.log(judgeSummary(judgments));
    if (opts['out']) {
      writeFileSync(opts['out'], `${JSON.stringify(judgments, null, 2)}\n`);
      console.log(`-> ${opts['out']}`);
    }
  });

program
  .command('strip')
  .description('every plate the trajectory stood on, in order')
  .argument('<dir>')
  .action((dir: string) => {
    const r = strip(dir);
    if (!r.png) {
      console.log('no plates are in the render cache for this trajectory');
      return;
    }
    const out = path.join(dir, 'strip.png');
    writeFileSync(out, r.png);
    console.log(`${out}: ${r.frames} frames${r.evicted ? `, ${r.evicted} evicted from the cache` : ''}`);
  });

program
  .command('export')
  .description('chat-format JSONL, one line per policy call')
  .argument('<dirs...>')
  .requiredOption('-o, --out <file>')
  .option('--format <f>', 'sft', 'sft')
  .action((dirs: string[], opts: Record<string, string>) => {
    if (opts['format'] !== 'sft') throw new Error(`unknown --format "${opts['format']}"; only "sft" exists`);
    const all = [];
    let dropped = 0;
    for (const dir of dirs.flatMap((d) => trajectoriesIn(d).map((t) => t.dir))) {
      const r = sftLines(dir);
      all.push(...r.lines);
      dropped += r.dropped;
    }
    writeFileSync(opts['out']!, toJsonl(all));
    console.log(`${opts['out']}: ${all.length} examples${dropped ? `, ${dropped} calls dropped (never validated)` : ''}`);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
