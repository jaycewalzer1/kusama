// `check` — hold one program tree, or a directory of them, against one aesthetic program.
//
//   check <tree.json> <aesthetic.json>            one table, one row per constraint
//   check --batch <dir> <aesthetic.json>          one row per tree, plus a JSON report
//
// Tree-scope constraints are decided here with no browser and no model. `--render` additionally
// measures the canonical image and decides the render-scope constraints; without it they are
// reported `unverified`, which is the honest answer and not a pass. Judge-scope rubrics are always
// unverified: this layer has no judge, and the rubric text is printed for whoever eventually does.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { checkProgram, loadAestheticProgram } from '../src/aesthetic/check.js';
import { Measurer } from '../src/aesthetic/measure.js';
import type { CheckReport, RenderMetrics } from '../src/aesthetic/types.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function table(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const MARK: Record<string, string> = { satisfied: 'ok', violated: 'VIOLATED', unverified: '--' };

function score(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(3);
}

function printOne(file: string, report: CheckReport): void {
  console.log(`${file}  against  ${report.aesthetic}`);
  console.log(
    table(
      report.results.map((r) => [
        r.id,
        r.kind,
        r.scope,
        r.severity,
        MARK[r.status] ?? r.status,
        r.evidence,
        r.why,
      ]),
      ['constraint', 'kind', 'scope', 'sev', 'status', 'evidence', 'why']
    )
  );
  console.log(
    `\n${report.hardViolations} hard, ${report.softViolations} soft, ${report.blocked} blocked by a missing primitive` +
      `   tree ${score(report.treeScore)}  render ${score(report.renderScore)}`
  );
  for (const r of report.pendingRubrics) console.log(`\npending judge rubric [${r.id}]:\n  ${r.text.replace(/\n/g, '\n  ')}`);
}

const cli = new Command()
  .name('check')
  .argument('<tree|dir>', 'a program tree, or with --batch a directory of them')
  .argument('<aesthetic.json>', 'the aesthetic program to hold it against')
  .option('--batch', 'treat the first argument as a directory of program trees')
  .option('--render', 'also measure the canonical image and decide the render-scope constraints')
  .option('-o, --out <file>', 'where the JSON report goes in batch mode', 'out/check-report.json')
  .option('-p, --profile <id|path>', 'medium profile', 'default');

interface Options {
  batch?: boolean;
  render?: boolean;
  out: string;
  profile: string;
}

cli.action(async (target: string, aestheticFile: string, opts: Options) => {
  const ap = loadAestheticProgram(aestheticFile);

  const files = opts.batch
    ? readdirSync(target)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(target, f))
    : [target];

  // One browser for the whole run, one render at a time (NOTES R8), and only if asked.
  const measurer = opts.render ? new Measurer(opts.profile) : null;
  const reports: { file: string; report: CheckReport }[] = [];
  try {
    for (const file of files) {
      const tree = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      let metrics: RenderMetrics | null = null;
      if (measurer) metrics = await measurer.measure(tree);
      reports.push({ file, report: checkProgram(tree, ap, metrics) });
    }
  } finally {
    await measurer?.close();
  }

  if (!opts.batch) {
    printOne(files[0]!, reports[0]!.report);
    process.exit(reports[0]!.report.hardViolations > 0 ? 1 : 0);
  }

  console.log(`${files.length} trees  against  ${ap.id}`);
  console.log(
    table(
      reports.map(({ file, report }) => [
        path.basename(file),
        String(report.hardViolations),
        String(report.softViolations),
        score(report.treeScore),
        score(report.renderScore),
        String(report.blocked),
      ]),
      ['tree', 'hard', 'soft', 'tree score', 'render score', 'blocked']
    )
  );

  const outFile = path.resolve(opts.out);
  writeFileSync(
    outFile,
    `${JSON.stringify({ aesthetic: ap.id, rendered: Boolean(opts.render), trees: reports }, null, 2)}\n`
  );
  console.log(`\n${outFile}`);
});

await cli.parseAsync();
