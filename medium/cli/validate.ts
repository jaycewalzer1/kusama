// `validate` — say yes or no to a program without rendering it, and say why.
//
// Exit code 0 means every program given may be rendered under this profile and pack. Anything else
// prints one line per issue and exits 1, so this is usable as a gate in a script.
//
// It takes many programs, like `batch` and `diff` do. It used to take exactly one, which meant
// `validate examples/batch/*.json` exited 0 having checked `v00.json` and silently dropped the other
// nineteen (NOTES E5) -- the worst failure mode available to a gate, since it passes while checking
// almost nothing. Every program is checked and the exit code reflects all of them.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadProfileFor, ProfileError } from '../env/profile.js';
import { loadPackFor, PackError } from '../env/pack.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed } from '../renderer/resolve.js';

const cli = new Command()
  .name('validate')
  .argument('<programs...>', 'the programs to check')
  .option('-p, --profile <id|path>', 'override the profile each program names')
  .option('-a, --pack <id|path>', 'asset pack (defaults to the pack the program names)')
  .option('--determinism', 'also render the program twice and compare the two canonical images')
  .option('--json', 'print the whole result as JSON instead of prose');

cli.action(async (files: string[], opts: { profile?: string; pack?: string; determinism?: boolean; json?: boolean }) => {
  const reports = [];
  const checkable = [];
  let failed = false;

  for (const file of files) {
    const program = JSON.parse(readFileSync(file, 'utf8')) as { assetPack?: string };
    let pack;
    let profile;
    let profileHash: string;
    try {
      ({ profile, hash: profileHash } = loadProfileFor(program, opts.profile));
      pack = loadPackFor(program, opts.pack);
    } catch (e) {
      // A missing or tampered artefact is a validation failure like any other, not a crash. It fails
      // this program and the run, but the remaining programs are still checked.
      if (!(e instanceof PackError) && !(e instanceof ProfileError)) throw e;
      console.error(`${file}: ${e.message}`);
      failed = true;
      continue;
    }

    const result = validateProgram(program, profile, pack);
    if (!result.valid) failed = true;

    if (opts.json) {
      const { resolved: _dropped, ...rest } = result;
      reports.push({ file, ...rest, profileHash, packHash: pack.hash });
    } else {
      for (const issue of result.issues) console.error(`${file}${issue.path}: ${issue.message} [${issue.code}]`);
      if (result.valid) {
        const b = result.budget!;
        console.log(`ok  ${file}`);
        console.log(`    program ${result.programHash.slice(0, 12)}  profile ${profile.id}@${profileHash.slice(0, 12)}  pack ${pack.id}@${pack.hash.slice(0, 12)}`);
        console.log(`    ${b.resolvedNodes} resolved nodes, ${b.repeatInstances} repeat instances, ~${b.marks} marks, cost ${b.cost}`);
      } else {
        console.error(`invalid  ${file}  (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`);
      }
    }
    if (result.valid) checkable.push({ file, pack, resolved: result.resolved! });
  }

  // One object for one program, an array for several, so a single-program invocation is unchanged.
  if (opts.json) console.log(JSON.stringify(files.length === 1 ? reports[0] : reports, null, 2));
  if (failed) process.exit(1);

  if (opts.determinism) {
    // The expensive check, and the only part of this command that starts a browser. One browser for
    // all of them, one render at a time -- renders in flight together are not deterministic (NOTES R8).
    const { Renderer } = await import('../env/browser.js');
    const { pixelHash } = await import('../env/png.js');
    const renderer = await Renderer.launch();
    try {
      for (const job of checkable) {
        // The fonts matter: a text op with no font loaded draws nothing at all (NOTES O2), so without
        // this the check would pass on an image that is missing every word the program asked for.
        const fonts = fontsUsed(job.resolved);
        const a = await renderer.render(job.resolved, job.pack, fonts);
        const b = await renderer.render(job.resolved, job.pack, fonts);
        const [ha, hb] = [pixelHash(a.rgba), pixelHash(b.rgba)];
        if (ha !== hb) {
          console.error(`nondeterministic  ${job.file}  two renders hashed ${ha.slice(0, 12)} and ${hb.slice(0, 12)}`);
          failed = true;
          continue;
        }
        console.log(`    deterministic across two contexts: ${job.file} pixels ${ha.slice(0, 12)}`);
      }
    } finally {
      await renderer.close();
    }
    if (failed) process.exit(1);
  }
});

await cli.parseAsync();
