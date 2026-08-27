// `artist` — run the loop, and everything you can do to a run afterwards.
//
//   artist run <position> <brief>        one trajectory into a directory
//   artist grid <dir>                    the whole grid, serially, plus the control column
//   artist replay <dir>                  the same trajectory with the model unplugged
//   artist recompute <dir...>            rebuild scores.json from the log alone
//   artist strip <dir>                   every plate the trajectory stood on, left to right
//   artist sheet <dir>                   the grid image from directories already run
//   artist export <dir...>               chat-format JSONL for training
//
// Renders are strictly serial inside a process (NOTES R8), so `grid` runs its cells one after
// another and takes as long as it takes. Parallelism, if it is ever wanted, belongs across processes.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { Canvas } from '../artist/canvas.js';
import { gridSheet, strip, type GridCell } from '../artist/grid.js';
import { selectPolicy } from '../artist/policy/interface.js';
import { recomputeMatches, scoresCsv } from '../artist/reward.js';
import { replay } from '../artist/replay.js';
import { runTrajectory } from '../artist/run.js';
import { sftLines, toJsonl } from '../artist/export.js';
import type { Trajectory } from '../artist/types.js';

const POSITIONS = [
  'situationist-ransom',
  'crass-collage',
  'riot-grrrl-zine',
  'underground-resistance',
  'berlin-rave-flyer',
  'ikeda-austerity',
];
const BRIEFS = [
  'stop-the-convoy',
  'rye-lane-evictions',
  'night-market-bombing',
  'tresor-last-night',
  'transmission-four',
];

function summarise(t: Trajectory): string {
  const s = t.scores;
  const n = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
  return [
    `${t.positionId} x ${t.briefId}  ${t.outcome}`,
    `  tree ${n(s.tree)}  render ${n(s.render)}  hard ${s.hardViolations}  soft ${s.softViolations}`,
    `  realization ${n(s.realization.score)} (${s.realization.satisfied}/${s.realization.mechanical} decidable, ${s.realization.judgePending} judge-pending)`,
    `  drift ${s.drift}  replans ${s.problemFindingSteps}  grounded ${s.problemsGrounded}/${t.problems.length}  destruction ${s.destructionRate}`,
    `  risk ${s.riskMoveTaken ? `taken: ${s.riskConvention}` : 'not taken'}  selfScore ${s.selfScore ?? 'n/a'}`,
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
  .action(async (position: string, brief: string, opts: Record<string, string | boolean>) => {
    const t = await runTrajectory({
      policy: await selectPolicy(),
      positionId: position,
      briefId: brief,
      seed: Number(opts['seed']),
      outDir: String(opts['out']),
      maxSteps: Number(opts['steps']),
      hardStop: Number(opts['hardStop']),
      sketchesPerProblem: Number(opts['sketches']),
      useAudience: opts['audience'] !== false,
      control: Boolean(opts['control']),
    });
    console.log(summarise(t));
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
  .action(async (opts: Record<string, string | boolean>) => {
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
  .command('replay')
  .description('re-run a trajectory from its own log, with no model')
  .argument('<dir>')
  .option('-o, --out <dir>', 'where the replayed trajectory is written', '')
  .action(async (dir: string, opts: Record<string, string>) => {
    const into = opts['out'] || path.join(dir, 'replay');
    const r = await replay(dir, into);
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
  .action(async (dirs: string[]) => {
    const canvas = new Canvas();
    let bad = 0;
    try {
      for (const dir of dirs.flatMap((d) => trajectoriesIn(d).map((t) => t.dir))) {
        const r = await recomputeMatches(dir, canvas);
        console.log(`${r.ok ? 'exact  ' : 'DIFFERS'} ${dir}`);
        if (!r.ok) {
          bad++;
          console.log(`  ${r.differences.join('\n  ')}`);
        }
      }
    } finally {
      await canvas.close();
    }
    process.exitCode = bad === 0 ? 0 : 1;
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
