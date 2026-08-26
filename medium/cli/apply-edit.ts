// `apply-edit` — apply one typed action to a program, or say why it cannot be applied.
//
// Exit code 0 means the edit was applied and the result is a program the medium would accept.
// Anything else prints the reason and exits 1. Without `-o` nothing is written, which makes this a
// dry run: ask whether an edit is allowed, and what it would cost, before committing to it.

import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { applyEdit } from '../env/edits.js';
import { loadPackFor, PackError } from '../env/pack.js';
import { loadProfileFor } from '../env/profile.js';

const cli = new Command()
  .name('apply-edit')
  .argument('<program.json>', 'the program to edit')
  .argument('<action.json>', 'the edit action to apply')
  .option('-p, --profile <id|path>', 'override the profile the program names')
  .option('-a, --pack <id|path>', 'asset pack (defaults to the pack the program names)')
  .option('-o, --out <file>', 'where to write the edited program');

cli.action((programFile: string, actionFile: string, opts: { profile?: string; pack?: string; out?: string }) => {
  const program = JSON.parse(readFileSync(programFile, 'utf8')) as { assetPack?: string };
  const action = JSON.parse(readFileSync(actionFile, 'utf8')) as { actionId?: string; kind?: string };
  const { profile } = loadProfileFor(program, opts.profile);
  let pack;
  try {
    pack = loadPackFor(program, opts.pack);
  } catch (e) {
    // A tampered pack is a refusal like any other, not a crash.
    if (!(e instanceof PackError)) throw e;
    console.error(`/assetPack: ${e.message} [pack.hash]`);
    process.exit(1);
  }

  const result = applyEdit(program, action, profile, pack);
  if (!result.valid) {
    console.error(result.reason);
    console.error(`refused  ${actionFile}`);
    process.exit(1);
  }

  console.log(`ok  ${actionFile}`);
  console.log(`    ${action.kind}  changed ${result.changedNodeIds.join(' ') || '(nothing)'}`);
  console.log(`    cost ${result.cost >= 0 ? '+' : ''}${result.cost}`);
  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify(result.nextProgram, null, 2)}\n`);
    console.log(`    wrote ${opts.out}`);
  }
});

cli.parse();
