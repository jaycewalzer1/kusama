// `corpus` — fetch real works, read them blind, and say how many the model already knew.
//
//   corpus import [-n 50] [--skip 0] [--type T] [--department D]
//                                      fetch works and their rights into corpus/manifest.jsonl
//   corpus images                      refetch pixels for works whose images are missing
//   corpus verify                      every row against the bytes on disk: present, and the right ones
//   corpus read                        one blind reading and one leakage probe per unread work
//   corpus status                      what is on disk, and the canonical count
//
// Both network stages are serial with a pause between requests. Not because anything here is heavy,
// but because a museum's open-access API is a courtesy and hammering it is how the courtesy gets
// withdrawn for everybody. `read` is idempotent: the environment model caches on request content, so
// re-running it costs nothing and returns exactly what the first run got.

import { appendFileSync, createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Command } from 'commander';
import { derivedIds, loadElement } from '../aesthetic/elements/pack.js';
import {
  CORPUS_DIR,
  MANIFEST,
  SOURCE_CORPUS,
  corpusSummary,
  hasImage,
  importWork,
  listCandidates,
  listWorks,
  loadReading,
  readWork,
  readingProtocolHash,
  refetchImage,
  saveReading,
  saveWorks,
} from '../artist/corpus.js';
import { type Work, imagePath, readManifest, workId } from '../artist/manifest.js';
import { deriveElement, deriveProtocolHash, saveDerived } from '../artist/element-derive.js';

const program = new Command();
program.name('corpus').description('the corpus of real works the lineage elements are derived from');

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Append-only, gitignored. What was lost and when, for a run too long to watch. */
const FAILURES = path.join(CORPUS_DIR, 'import-failures.jsonl');

program
  .command('import')
  .description('fetch works with a CC0 licence and an image, and store their provenance')
  .option('-n, --number <n>', 'how many works to end up with', '50')
  .option('--skip <n>', 'how far into the source list to start, so a second import is not the first', '0')
  .option('--type <type>', 'server-side filter, e.g. Textile, Print, Painting, Ceramic')
  .option('--department <name>', 'server-side filter, e.g. "Islamic Art", "Chinese Art"')
  .option('--pause <ms>', 'delay between requests', '500')
  .action(async (opts: { number: string; skip: string; type?: string; department?: string; pause: string }) => {
    const want = Number(opts.number);
    const gap = Number(opts.pause);
    const filters = { type: opts.type ?? '', department: opts.department ?? '' };
    // Cheap to recompute and it is what makes a restart safe: an import that was killed at work
    // 9,000 walks the list pages again (a hundred records a request, seconds) and fetches no image
    // it already has. There is no cursor file to go stale.
    const have = new Set(listWorks().map((w) => w.id));
    let skip = Number(opts.skip);
    let added = 0;
    let failed = 0;
    // The manifest is written whole, sorted, so it is flushed per batch rather than per work — but
    // it *is* flushed per batch, because a run killed after eight hours with everything still in
    // memory is eight hours of somebody else's bandwidth spent for nothing.
    let pending: Work[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      saveWorks(pending);
      pending = [];
    };

    // Overfetch: the licence filter is server-side and reliable, but a record can still turn up with
    // no usable image, and a run that asked for fifty and stopped at forty-one because nine records
    // were thin is a corpus nobody can reason about the size of.
    while (added < want) {
      const batch = await listCandidates(Math.min(100, (want - added) * 2), skip, filters);
      if (batch.length === 0) break;
      skip += batch.length;
      for (const record of batch) {
        if (added >= want) break;
        if (have.has(workId(SOURCE_CORPUS, record.id))) continue;
        try {
          const work = await importWork(record);
          if (!work) continue;
          have.add(work.id);
          pending.push(work);
          added++;
          process.stdout.write(`${String(added).padStart(5)}  ${work.id}  ${work.image?.sha256.slice(0, 12)}  ${work.title.slice(0, 58)}\n`);
        } catch (e) {
          // Written down rather than printed and lost. Over a run of hours the failures are the
          // only part of the output a person will actually want afterwards, and a scrollback is
          // not a record: whether the losses were forty scattered timeouts or four hundred
          // consecutive ones from the moment the museum started refusing us is the whole question,
          // and it is unanswerable from a summary count.
          failed++;
          appendFileSync(
            FAILURES,
            `${JSON.stringify({ at: new Date().toISOString(), objectId: String(record.id), error: (e as Error).message })}\n`,
          );
          process.stdout.write(`       failed ${record.id}: ${(e as Error).message}\n`);
        }
        await pause(gap);
      }
      flush();
    }
    flush();
    const s = corpusSummary();
    process.stdout.write(`\nimported ${added}; corpus now holds ${s.works} works\n`);
    if (failed) process.stdout.write(`${failed} failed; see ${FAILURES}\n`);
  });

program
  .command('images')
  .description('refetch the pixels for works whose images are not on this machine')
  .option('--pause <ms>', 'delay between requests', '500')
  .action(async (opts: { pause: string }) => {
    // corpus/images/ is gitignored, so a fresh clone has every work record and no bytes. This is
    // the command that makes that trade honest: each image comes back from the URL in its own
    // record and has to hash to what the record says, or it is an error.
    const missing = listWorks().filter((w) => !hasImage(w));
    if (missing.length === 0) {
      process.stdout.write(`all ${listWorks().length} works have their images\n`);
      return;
    }
    let got = 0;
    let failed = 0;
    for (const work of missing) {
      try {
        await refetchImage(work);
        got++;
        process.stdout.write(`${String(got).padStart(5)}/${missing.length}  ${work.id}  ${work.image?.sha256.slice(0, 12)}\n`);
      } catch (e) {
        failed++;
        appendFileSync(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), objectId: work.id, error: (e as Error).message })}\n`);
        process.stdout.write(`       failed ${work.id}: ${(e as Error).message}\n`);
      }
      await pause(Number(opts.pause));
    }
    process.stdout.write(`\nrefetched ${got}/${missing.length}${failed ? `; ${failed} failed, see ${FAILURES}` : ''}\n`);
  });

program
  .command('verify')
  .description('check every manifest row against the bytes on disk')
  .option('--quick', 'check only that the files exist, without rehashing them', false)
  .action(async (opts: { quick: boolean }) => {
    // The manifest is the evidence and the images are not, which is only true if the manifest can
    // be *checked* against the images. Existence is the cheap half; the hash is the half that
    // catches a truncated download, a Cloudflare page written as a .jpg, or a museum that requoted
    // its own derivative at a different quality after the reading was made. Both are reported
    // separately because they have different remedies: missing is `corpus images`, mismatched is a
    // decision somebody has to make.
    const { works, faults } = readManifest(MANIFEST);
    const missing: string[] = [];
    const mismatched: string[] = [];
    const pending: string[] = [];
    let checked = 0;

    for (const work of works) {
      const rel = imagePath(work);
      if (!work.image || !rel) {
        pending.push(work.id);
        continue;
      }
      const file = path.join(CORPUS_DIR, rel);
      if (!existsSync(file)) {
        missing.push(work.id);
        continue;
      }
      if (opts.quick) {
        checked++;
        continue;
      }
      const got = await sha256OfFile(file);
      if (got === work.image.sha256) checked++;
      else mismatched.push(`${work.id} — on disk ${got.slice(0, 12)}, manifest says ${work.image.sha256.slice(0, 12)}`);
    }

    const withImages = works.length - pending.length;
    process.stdout.write(`${checked}/${withImages} images present${opts.quick ? '' : ' and hashing to what the manifest claims'}\n`);
    if (pending.length) process.stdout.write(`${pending.length} rows are metadata only (no image fetched yet)\n`);
    if (faults.length) process.stdout.write(`${faults.length} malformed manifest rows, first at line ${faults[0]?.line}: ${faults[0]?.why}\n`);
    for (const id of missing) process.stdout.write(`missing     ${id}\n`);
    for (const m of mismatched) process.stdout.write(`MISMATCH    ${m}\n`);
    if (missing.length) process.stdout.write(`\n${missing.length} missing; \`corpus images\` will refetch them.\n`);
    // A mismatch is not a warning. Something that was read is not what the record says was read.
    if (mismatched.length || faults.length) process.exitCode = 1;
  });

/** Streamed, because the whole corpus is gigabytes and this walks all of it. */
function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

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
