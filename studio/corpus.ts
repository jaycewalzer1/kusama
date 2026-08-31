// `corpus` — fetch real works, read them blind, and say how many the model already knew.
//
//   corpus import [-n 50] [--skip 0]   fetch works and their rights into corpus/
//   corpus read                        one blind reading and one leakage probe per unread work
//   corpus status                      what is on disk, and the canonical count
//
// Both network stages are serial with a pause between requests. Not because anything here is heavy,
// but because a museum's open-access API is a courtesy and hammering it is how the courtesy gets
// withdrawn for everybody. `read` is idempotent: the environment model caches on request content, so
// re-running it costs nothing and returns exactly what the first run got.

import { Command } from 'commander';
import { derivedIds, loadElement } from '../aesthetic/elements/pack.js';
import {
  corpusSummary,
  importWork,
  listCandidates,
  listWorks,
  loadReading,
  readWork,
  readingProtocolHash,
  saveReading,
  workId,
} from '../artist/corpus.js';
import { deriveElement, deriveProtocolHash, saveDerived } from '../artist/element-derive.js';

const program = new Command();
program.name('corpus').description('the corpus of real works the lineage elements are derived from');

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

program
  .command('import')
  .description('fetch works with a CC0 licence and an image, and store their provenance')
  .option('-n, --number <n>', 'how many works to end up with', '50')
  .option('--skip <n>', 'how far into the source list to start, so a second import is not the first', '0')
  .action(async (opts: { number: string; skip: string }) => {
    const want = Number(opts.number);
    const have = new Set(listWorks().map((w) => w.id));
    let skip = Number(opts.skip);
    let added = 0;

    // Overfetch: the licence filter is server-side and reliable, but a record can still turn up with
    // no usable image, and a run that asked for fifty and stopped at forty-one because nine records
    // were thin is a corpus nobody can reason about the size of.
    while (added < want) {
      const batch = await listCandidates(Math.min(100, (want - added) * 2), skip);
      if (batch.length === 0) break;
      skip += batch.length;
      for (const record of batch) {
        if (added >= want) break;
        if (have.has(workId(record.id))) continue;
        try {
          const work = await importWork(record);
          if (!work) continue;
          have.add(work.id);
          added++;
          process.stdout.write(`${String(added).padStart(3)}  ${work.id}  ${work.image.hash.slice(0, 12)}  ${work.source.title.slice(0, 58)}\n`);
        } catch (e) {
          process.stdout.write(`     skipped ${record.id}: ${(e as Error).message}\n`);
        }
        await pause(120);
      }
    }
    const s = corpusSummary();
    process.stdout.write(`\nimported ${added}; corpus now holds ${s.works} works\n`);
  });

program
  .command('read')
  .description('a blind reading and a leakage probe for every work that has not got one')
  .option('--force', 'read works that already have a reading under this protocol', false)
  .action(async (opts: { force: boolean }) => {
    const protocol = readingProtocolHash();
    let read = 0;
    let canonical = 0;
    for (const work of listWorks()) {
      const existing = loadReading(work.id);
      // A reading made under a different protocol is not a reading of the same question, so a prompt
      // edit re-reads everything rather than leaving a corpus half in each protocol.
      if (existing && existing.promptHash === protocol && !opts.force) {
        if (existing.canonical) canonical++;
        continue;
      }
      const reading = await readWork(work);
      saveReading(reading);
      read++;
      if (reading.canonical) canonical++;
      const said = `${reading.leakage.artist ?? '?'} — ${reading.leakage.work ?? '?'}`;
      const named = reading.canonical ? `KNEW IT: ${said}` : reading.misattributed ? `wrong: ${said}` : 'declined';
      process.stdout.write(`${work.id}  ${named}\n`);
      await pause(120);
    }
    const s = corpusSummary();
    process.stdout.write(`\nread ${read} this run. ${s.read}/${s.works} works have readings.\n`);
    process.stdout.write(`named something      : ${s.claimed}/${s.read}\n`);
    process.stdout.write(`canonical (and right): ${s.canonical}/${s.read}\n`);
    process.stdout.write(`misattributed        : ${s.misattributed}/${s.read}\n`);
  });

program
  .command('derive')
  .description('turn each blind reading into a lineage element, from the reading alone')
  .option('--force', 'redo elements already derived under this protocol', false)
  .action(async (opts: { force: boolean }) => {
    const protocol = deriveProtocolHash();
    let made = 0;
    let dropped = 0;
    let skipped = 0;
    for (const work of listWorks()) {
      const reading = loadReading(work.id);
      if (!reading) {
        process.stdout.write(`${work.id}  no reading yet; run \`corpus read\` first\n`);
        skipped++;
        continue;
      }
      if (!opts.force && derivedIds().includes(work.id)) {
        // A protocol change is a different question, so an element derived under an older one is
        // redone rather than kept. Same rule as `read`.
        const existing = loadElement(work.id);
        if (existing.derivedFrom?.deriveProtocol === protocol) continue;
      }
      const { element, dropped: bad } = await deriveElement(work, reading);
      saveDerived(element);
      made++;
      dropped += bad;
      const n = (element.commitments?.length ?? 0) + element.generativeRules.length + element.prohibitions.length;
      process.stdout.write(`${work.id}  ${n} rules${bad ? ` (${bad} dropped)` : ''}  ${element.name}\n`);
      await pause(120);
    }
    process.stdout.write(`\nderived ${made} this run; ${derivedIds().length} elements on disk.\n`);
    if (dropped) process.stdout.write(`dropped ${dropped} malformed moves rather than repairing them.\n`);
    if (skipped) process.stdout.write(`skipped ${skipped} works with no reading.\n`);
    process.stdout.write(`protocol ${protocol.slice(0, 12)}\n`);
  });

program
  .command('status')
  .description('what is on disk, and how much of it the model already knew')
  .action(() => {
    const s = corpusSummary();
    process.stdout.write(
      `works          ${s.works}\nread           ${s.read}\nnamed          ${s.claimed}\ncanonical      ${s.canonical}\nmisattributed  ${s.misattributed}\nprotocol       ${readingProtocolHash().slice(0, 12)}\n`,
    );
    if (s.canonicalIds.length) {
      process.stdout.write(`\nContaminated — any claim resting on these is reported separately:\n`);
      for (const id of s.canonicalIds) {
        const r = loadReading(id);
        process.stdout.write(`  ${id}  ${r?.leakage.artist ?? '?'} — ${r?.leakage.work ?? '?'}\n`);
      }
    }
    if (s.misattributedIds.length) {
      // Not contamination: the probe guessed from style and missed, which is evidence the work is
      // *not* memorised. Listed so the two are never quietly added together.
      process.stdout.write(`\nNamed confidently and wrongly — clean, but the probe cannot be trusted alone:\n`);
      for (const id of s.misattributedIds) {
        const r = loadReading(id);
        process.stdout.write(`  ${id}  said "${r?.leakage.artist ?? '?'}"\n`);
      }
    }
  });

await program.parseAsync(process.argv);
