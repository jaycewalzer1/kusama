// `corpus` — fetch real works, read them blind, and say how many the model already knew.
//
//   corpus metadata <cma|met|aic>      pull a whole source's metadata into corpus/pool.jsonl
//   corpus import [-n 50] [--skip 0] [--type T] [--department D]
//                                      fetch works and their rights into corpus/manifest.jsonl
//   corpus select [--target N] [--seed N] [--dry-run]
//                                      stratify the pool into the corpus, and record why
//   corpus images                      refetch pixels for works whose images are missing
//   corpus verify                      every row against the bytes on disk: present, and the right ones
//   corpus read                        one blind reading and one leakage probe per unread work
//   corpus status                      what is on disk, and the canonical count
//
// Both network stages are serial with a pause between requests. Not because anything here is heavy,
// but because a museum's open-access API is a courtesy and hammering it is how the courtesy gets
// withdrawn for everybody. `read` is idempotent: the environment model caches on request content, so
// re-running it costs nothing and returns exactly what the first run got.

import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Command } from 'commander';
import { derivedIds, loadElement } from '../aesthetic/elements/pack.js';
import {
  CORPUS_DIR,
  MANIFEST,
  SOURCE_CORPUS,
  corpusSummary,
  fetchImage,
  hasImage,
  importWork,
  jpegSize,
  POOL,
  SELECTION,
  listCandidates,
  listPage,
  listPool,
  listWorks,
  loadReading,
  metadataFrom as cmaFrom,
  politely,
  readWork,
  readingProtocolHash,
  refetchImage,
  saveReading,
  saveWorks,
} from '../artist/corpus.js';
import { type AicRecord, metadataFrom as aicFrom, searchUrl, walkPublicDomain } from '../artist/aic.js';
import { atlas } from '../artist/atlas.js';
import { atlasPage } from './atlas-page.js';
import { type Source, type Work, imagePath, readManifest, workId } from '../artist/manifest.js';
import { csvRows, metadataFrom as metFrom, resolveImageUrl } from '../artist/met.js';
import { DEFAULT_TARGET, MAX_CLASSIFICATION_SHARE, MAX_SOURCE_SHARE, select } from '../artist/selection.js';
import { deriveElement, deriveProtocolHash, saveDerived } from '../artist/element-derive.js';

const program = new Command();
program.name('corpus').description('the corpus of real works the lineage elements are derived from');

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Append-only, gitignored. What was lost and when, for a run too long to watch. One file for both
 * the importer and the image fetcher, because the question a person asks it is "what did this
 * machine fail to get", and each line already carries the id and the reason.
 */
const FAILURES = path.join(CORPUS_DIR, 'failures.jsonl');

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
  .command('measure')
  .description('read width and height out of the JPEGs already on disk, for rows that lack them')
  .action(() => {
    // Backfill, offline, no network. Every row fetched before dimensions were measured carries
    // `width: null, height: null`; a field that is null on every row of a 20,000-row file is not a
    // schema, it is a leftover. This reads the bytes that are already here and fills them in.
    const works = listWorks();
    const done: Work[] = [];
    let unreadable = 0;
    for (const work of works) {
      const rel = imagePath(work);
      if (!work.image || !rel || work.image.width !== null) continue;
      const file = path.join(CORPUS_DIR, rel);
      if (!existsSync(file)) continue;
      const size = jpegSize(readFileSync(file));
      if (size.width === null) {
        // A JPEG whose frame header cannot be walked is worth knowing about: it hashed, it passed the
        // magic-number check, and it may still be a truncated download.
        unreadable++;
        continue;
      }
      work.image = { ...work.image, ...size };
      done.push(work);
    }
    if (done.length) saveWorks(done, MANIFEST);
    process.stdout.write(
      `measured ${done.length} rows\n` +
        `${unreadable ? `${unreadable} files are JPEGs whose frame header could not be walked — check these\n` : ''}`,
    );
  });

program
  .command('met-urls')
  .argument('<file>', 'JSON object mapping Met objectID to [primaryImageSmall, primaryImage]')
  .description("fill in the Met's image URLs from its own published dump instead of its blocked API")
  .option('--write', 'actually change the manifest; without this it only reports')
  .action((file: string, opts: { write?: boolean }) => {
    // The Met's object API is the only route to `primaryImageSmall`, and it throttles on sustained
    // volume: an Imperva challenge after roughly two hundred requests, for our user agent, a
    // browser's, and none at all alike. Ten thousand works cannot be resolved through it, and going
    // slower is not the answer — the run that tripped it was 32x under the documented 80 req/s.
    //
    // The Met also publishes the same fields itself, as a parquet dump, which is a file download and
    // therefore not rate-anything. Taking the URLs from there is not a workaround of a limit — it is
    // the same museum's same answer, obtained the way the museum offers it in bulk.
    //
    // What licenses trusting it is the overlap, and that is why this command reports before it
    // writes. 64 Met works were resolved through the live API before the block came down. Those rows
    // are the control: if the dump's URL for a work disagrees with the URL the API gave for that same
    // work, then the two sources are not interchangeable and none of the other ten thousand should be
    // believed either. `--write` is a separate flag so that check is read by a person, once.
    //
    // The dump carries both of the Met's image columns and this keeps the **first**, which is
    // `primaryImageSmall` — the same one `resolveImageUrl` picks, for the same reason: the second is
    // the print master, tens of megabytes to be downsampled before it ever reaches a model. Taking a
    // different tier here than the live API took would mean the 64 works already on disk were fetched
    // at one size and the other ten thousand at another.
    const published = JSON.parse(readFileSync(file, 'utf8')) as Record<string, [string, string] | null>;
    const smallOf = (id: string): string | null => published[id]?.[0] ?? null;
    const works = listWorks();
    const done: Work[] = [];
    let filled = 0;
    let absent = 0;
    let agreed = 0;
    const disagreed: string[] = [];

    for (const work of works) {
      if (work.source !== 'met') continue;
      const url = smallOf(work.object_id);
      if (work.image_url) {
        // Already resolved live. Never overwritten — the live API is the more direct source, and a
        // row whose pixels are already hashed must keep the URL those pixels came from.
        if (url === work.image_url) agreed++;
        else if (url) disagreed.push(`${work.id}\n    api: ${work.image_url}\n    dump: ${url}`);
        continue;
      }
      if (!url) {
        // Public domain does not imply photographed. A work the Met has no image of is a fact about
        // the work, and it stays null rather than becoming a failure later.
        absent++;
        continue;
      }
      work.image_url = url;
      done.push(work);
      filled++;
    }

    process.stdout.write(
      `cross-check against the ${agreed + disagreed.length} works resolved through the live API:\n` +
        `  ${agreed} agree exactly, ${disagreed.length} disagree\n` +
        `${disagreed.length ? `${disagreed.map((d) => `  ${d}`).join('\n')}\n` : ''}` +
        `\n${filled} rows would gain a URL, ${absent} Met works have no image published\n`,
    );
    if (disagreed.length) {
      process.stdout.write('\nDISAGREEMENT. The two sources are not interchangeable; nothing written.\n');
      process.exitCode = 1;
      return;
    }
    if (!opts.write) {
      process.stdout.write('\nreport only — pass --write to change the manifest\n');
      return;
    }
    if (done.length) saveWorks(done, MANIFEST);
    process.stdout.write(`wrote ${done.length} URLs into the manifest\n`);
  });

/** Per-source politeness. Cleveland's CDN is a CDN; the Met and the AIC answer from their own APIs. */
const PAUSE_MS: Record<Source, number> = { cma: 250, met: 400, aic: 700 };

program
  .command('images')
  .description('fetch the pixels for every manifest row that has not got them, resumably')
  .option('--pause <ms>', 'override the per-source delay between requests')
  .option('--limit <n>', 'stop after this many works, for a smoke test', '0')
  .option('--source <src>', 'fetch only this museum — met, aic or cma')
  .action(async (opts: { pause?: string; limit: string; source?: string }) => {
    // This is the long one — twenty thousand downloads, hours, unattended. Three things follow from
    // that and none of them are optional.
    //
    // **It resumes.** The work list is recomputed from the manifest and the disk every run, and the
    // manifest is checkpointed as it goes, so a kill at work 12,000 costs the current image and
    // nothing else. Content addressing is what makes this free: the file is named by its own hash,
    // so a work fetched twice writes the same path twice and there is no partial state to reconcile.
    //
    // **A failure is data, not a stop.** A 404 on one work out of twenty thousand is a fact about
    // that work. It goes to corpus/failures.jsonl with the reason and the run continues.
    //
    // **Rates are per source.** Three museums are three courtesies, and one of them has blocked us
    // before — which is why `--source` exists. The Met's object API is IP-blocked, and without a way
    // to say "the other two", every run spends itself on nine thousand requests that are known in
    // advance to 403 and does not reach the works that would succeed.
    const pending = listWorks().filter((w) => !hasImage(w) && (!opts.source || w.source === opts.source));
    const cap = Number(opts.limit) || Number.POSITIVE_INFINITY;
    const todo = Number.isFinite(cap) ? pending.slice(0, cap) : pending;
    if (todo.length === 0) {
      process.stdout.write(`nothing left to fetch${opts.source ? ` for ${opts.source}` : ''} (${listWorks().length} rows in the manifest)\n`);
      return;
    }
    process.stdout.write(`${todo.length} works to fetch (of ${listWorks().length} in the manifest)\n`);

    let got = 0;
    let failed = 0;
    let noImage = 0;
    const done: Work[] = [];
    const started = Date.now();
    // Checkpoint rather than write once at the end: `saveWorks` rereads and rewrites the whole
    // sorted file, which is seconds at manifest scale, so doing it per work would dominate the run —
    // and doing it never would throw away every hash if the process is killed.
    const checkpoint = () => {
      if (done.length) saveWorks(done.splice(0), MANIFEST);
    };

    for (const [i, work] of todo.entries()) {
      const gap = opts.pause ? Number(opts.pause) : PAUSE_MS[work.source];
      try {
        if (work.image) {
          // The row already claims a hash: this is a re-fetch into an empty corpus/images/, and the
          // bytes have to come back identical or the evidence and the pixels have parted company.
          await refetchImage(work);
        } else {
          // The Met's CSV carries no image URL at all, so it is resolved here — after selection,
          // for the works that were chosen, rather than before it for the quarter of a million
          // that were not.
          if (!work.image_url && work.source === 'met') work.image_url = await resolveImageUrl(work.object_id);
          if (!work.image_url) {
            // A public-domain object with no published image is common and is not an error. The row
            // stays, metadata-only, and says so.
            noImage++;
            done.push(work);
            continue;
          }
          await fetchImage(work);
        }
        got++;
        done.push(work);
        const rate = got / ((Date.now() - started) / 1000);
        if (got % 25 === 0 || got === 1) {
          process.stdout.write(`${String(i + 1).padStart(6)}/${todo.length}  ${work.id.padEnd(14)} ${work.image?.sha256.slice(0, 12)}  ${rate.toFixed(1)}/s\n`);
        }
      } catch (e) {
        failed++;
        appendFileSync(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), id: work.id, source: work.source, url: work.image_url, error: (e as Error).message })}\n`);
        process.stdout.write(`       failed ${work.id}: ${(e as Error).message}\n`);
      }
      if (done.length >= 200) checkpoint();
      await pause(gap);
    }
    checkpoint();
    process.stdout.write(
      `\nfetched ${got}/${todo.length} in ${Math.round((Date.now() - started) / 1000)}s\n` +
        `${noImage} works publish no image (metadata-only rows, not failures)\n` +
        `${failed ? `${failed} failed; see ${FAILURES}. Re-running this command retries exactly those.\n` : ''}`,
    );
  });

program
  .command('metadata')
  .description('pull a whole source\'s metadata into the manifest, with no images')
  .argument('<source>', 'cma, met or aic')
  .option('--csv <path>', 'for met: the MetObjects.csv to read instead of calling the API')
  .option('--limit <n>', 'stop after this many rows, for a smoke test', '0')
  .option('--pause <ms>', 'delay between requests', '250')
  .action(async (source: string, opts: { csv?: string; limit: string; pause: string }) => {
    // Metadata first, pixels later, deliberately. Cleveland's entire CC0 set is about forty requests
    // and the same set of images is 14.6GB; the Met's whole collection is one file they publish and
    // 485,000 API calls otherwise. Deciding *which* works to keep belongs between those two facts,
    // not after both. So this writes rows with `image: null` and nothing else touches the network.
    const cap = Number(opts.limit) || Number.POSITIVE_INFINITY;
    const gap = Number(opts.pause);
    const rows: Work[] = [];
    const started = Date.now();

    if (source === 'met') {
      const csv = opts.csv;
      if (!csv) throw new Error('met needs --csv <MetObjects.csv>; see corpus/README.md for where to get it');
      let seen = 0;
      for await (const row of csvRows(csv)) {
        seen++;
        const w = metFrom(row);
        if (w) rows.push(w);
        if (seen % 50000 === 0) process.stdout.write(`  read ${seen} rows, kept ${rows.length}\n`);
        if (rows.length >= cap) break;
      }
      process.stdout.write(`  read ${seen} CSV rows, kept ${rows.length} public domain\n`);
    } else if (source === 'cma') {
      // Cleveland has no usable sort, and its result order shifts *while a walk is running*. A
      // straight walk of the 41,511 matching records returns exactly 41,511 rows containing only
      // 40,477 distinct ids — the offsets slide underneath it, so some works are served twice and
      // others never. Repeating the same walk does not help: the second pass added zero, because
      // the records it slides past are largely the same ones.
      //
      // What does work is making each walk short enough that the index cannot move much under it.
      // Department is an exact partition — the 21 departments' totals sum to 41,511 with nothing
      // left over — and the largest is a quarter of the whole. The department names are discovered
      // from the first pass rather than hardcoded, so a twenty-second department does not silently
      // vanish, and each one is re-walked until its distinct count reaches its own reported total.
      const held = new Map<string, Work>();
      const departments = new Set<string>();
      let total = 0;
      // A *set* of rejected ids, not a counter: the same unmappable record is served again on every
      // re-sweep of its department, and a counter would report the museum's 42 broken records as
      // several hundred.
      const rejected = new Set<number>();

      const sweep = async (filters: Record<string, string>, label: string): Promise<number> => {
        let reported = 0;
        for (let skip = 0; held.size < cap; skip += 100) {
          const page = await listPage(100, skip, filters);
          reported = page.total || reported;
          if (page.records.length === 0) break;
          for (const r of page.records) {
            if (r.department) departments.add(r.department);
            const w = cmaFrom(r);
            if (w) held.set(w.id, w);
            else rejected.add(r.id);
          }
          if (skip % 10000 === 0 && !filters.department) process.stdout.write(`  ${label}: ${held.size} distinct (skip ${skip})\n`);
          await pause(gap);
        }
        return reported;
      };

      total = await sweep({}, 'sweep');
      process.stdout.write(`  first sweep: ${held.size} distinct of ${total}, across ${departments.size} departments\n`);

      // Now the shortfall, department by department, only where there is one.
      for (const department of [...departments].sort()) {
        if (held.size >= cap) break;
        const have = () => [...held.values()].filter((w) => w.department === department).length;
        for (let pass = 1; pass <= 3; pass++) {
          const before = have();
          const reported = await sweep({ department }, department);
          const now = have();
          if (pass === 1 && now >= reported) break;
          process.stdout.write(`  ${department}: ${now} of ${reported} (+${now - before} on pass ${pass})\n`);
          if (now >= reported || now === before) break;
        }
      }

      // The gap that is left is printed, not smoothed. Measured: the first sweep reached 40,865 of
      // 41,511, three departments were short, one re-sweep each recovered 319 of the 646 missing,
      // and a second re-sweep of those three recovered **zero** — so the loop stops rather than
      // spending another eight minutes proving the same thing. That leaves 41,446, and 42 of the
      // remaining 65 are records that match `has_image=1` and carry no image object at all, which is
      // the museum's own inconsistency. The other 23 are not accounted for and this line says so.
      process.stdout.write(
        `  ${held.size} distinct of ${total} reported; ${total - held.size} short, of which ` +
          `${rejected.size} are records with no usable image or licence\n`,
      );
      rows.push(...held.values());
    } else if (source === 'aic') {
      const get = async (url: string) => {
        await pause(gap);
        return (await politely(url).then((r) => r.json())) as { data: AicRecord[]; pagination: { total: number } };
      };
      const walk = walkPublicDomain(
        // `limit=1`, not `limit=0`. Only `pagination.total` is read from this response, but the API
        // answers 400 to a zero limit, so the cheapest legal page is one row.
        async (range) => (await get(searchUrl(1, 1, range))).pagination.total,
        async (range, n) => (await get(searchUrl(n, 100, range))).data ?? [],
      );
      for await (const r of walk) {
        const w = aicFrom(r);
        if (w) rows.push(w);
        if (rows.length % 2000 === 0) process.stdout.write(`  ${rows.length} rows\n`);
        if (rows.length >= cap) break;
      }
    } else {
      throw new Error(`unknown source ${source}; expected cma, met or aic`);
    }

    saveWorks(rows, POOL);
    const all = listPool();
    const dated = rows.filter((r) => r.date_begin !== null).length;
    const withUrl = rows.filter((r) => r.image_url !== null).length;
    process.stdout.write(
      `\n${source}: ${rows.length} rows in ${Math.round((Date.now() - started) / 1000)}s\n` +
        `  dated       ${dated}/${rows.length}\n` +
        `  image url   ${withUrl}/${rows.length}${source === 'met' ? '  (the CSV has none; resolved after selection)' : ''}\n` +
        `pool now holds ${all.length} candidates\n`,
    );
  });

program
  .command('select')
  .description('choose a stratified corpus out of the candidate pool, and record why')
  .option('--target <n>', 'how many works to end up with', String(DEFAULT_TARGET))
  .option('--seed <n>', 'the draw. Changing it changes which works, not how many', '20260831')
  .option('--dry-run', 'print the census without writing the manifest or selection.json', false)
  .action((opts: { target: string; seed: string; dryRun: boolean }) => {
    // Runs entirely offline over corpus/pool.jsonl. Nothing is fetched here: this command decides
    // which works the corpus is *about*, and that decision should be re-runnable and arguable
    // without spending anybody's bandwidth on it.
    const pool = listPool();
    if (pool.length === 0) throw new Error(`${POOL} is empty; run \`corpus metadata <source>\` first`);
    const held = new Set(listWorks().map((w) => w.id));
    const rules = {
      seed: Number(opts.seed),
      target: Number(opts.target),
      maxClassificationShare: MAX_CLASSIFICATION_SHARE,
      maxSourceShare: MAX_SOURCE_SHARE,
    };
    const { works, selection } = select(pool, held, rules);

    process.stdout.write(
      `pool ${selection.poolSize}  ->  selected ${selection.selected}  (${selection.carriedOver} carried over from the manifest)\n\n` +
        `by source\n${Object.entries(selection.bySource)
          .map(([k, v]) => `  ${k.padEnd(6)} ${String(v).padStart(6)}`)
          .join('\n')}\n\n` +
        `by period\n${Object.entries(selection.byPeriod)
          .map(([k, v]) => `  ${k.padEnd(10)} ${String(v).padStart(6)}`)
          .join('\n')}\n\n` +
        `classifications, taken of available (top 20 of ${selection.byClassification.length})\n${selection.byClassification
          .slice(0, 20)
          .map((c) => `  ${c.classification.slice(0, 40).padEnd(42)} ${String(c.taken).padStart(5)} of ${c.available}`)
          .join('\n')}\n\n` +
        `${selection.strata.length} strata; ids sha256 ${selection.idsSha256.slice(0, 16)}\n`,
    );

    if (opts.dryRun) {
      process.stdout.write('\n--dry-run: nothing written\n');
      return;
    }
    // Additive by construction — `select` carries every held id through — but written with
    // `saveWorks` rather than `writeManifest` so that a row already carrying fetched image evidence
    // keeps it instead of being replaced by its metadata-only twin from the pool.
    const heldById = new Map(listWorks().map((w) => [w.id, w]));
    saveWorks(
      works.map((w) => heldById.get(w.id) ?? w),
      MANIFEST,
    );
    writeFileSync(SELECTION, `${JSON.stringify({ ...selection, strata: selection.strata.slice(0, 400) }, null, 2)}\n`);
    process.stdout.write(`\nwrote ${works.length} rows to ${MANIFEST}\nwrote ${SELECTION}\n`);
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

program
  .command('atlas')
  .description('lay the corpus out in two dimensions from its metadata alone, and say whether the layout means anything')
  .option('--sample <n>', 'how many works the honesty measure compares', '1500')
  .option('--neighbours <k>', 'neighbourhood size for that measure', '20')
  .action((opts: { sample: string; neighbours: string }) => {
    // Offline and free: this reads the manifest and nothing else. It runs on all 20,000 works,
    // including the ones whose pixels have not arrived, because every column is a field a museum
    // already filled in.
    const works = listWorks();
    if (works.length === 0) {
      process.stdout.write('no manifest — run `corpus metadata` and `corpus select` first\n');
      return;
    }
    const a = atlas(works, Number(opts.sample), Number(opts.neighbours));
    writeFileSync(path.join(CORPUS_DIR, 'atlas.json'), `${JSON.stringify(a, null, 1)}\n`);
    writeFileSync(path.join(CORPUS_DIR, 'atlas.html'), atlasPage(a, new Date().toISOString()));

    const p = a.preservation;
    process.stdout.write(
      `${a.works} works, ${a.columns.length} columns\n` +
        `axis 1 carries ${(a.varianceExplained[0] ?? 0).toFixed(4)} of the variance, axis 2 ${(a.varianceExplained[1] ?? 0).toFixed(4)}\n`,
    );
    // Printed, not merely stored, because an axis nobody reads the loadings of gets called
    // "style" in the next sentence somebody writes about it.
    for (const axis of a.loadings) {
      process.stdout.write(`\naxis ${axis[0]?.axis} is made of:\n`);
      for (const l of axis) process.stdout.write(`  ${l.weight >= 0 ? '+' : '-'}${Math.abs(l.weight).toFixed(2)}  ${l.column}\n`);
    }
    process.stdout.write(`\n${p.k}-neighbourhoods, over ${p.n} works: ${p.preserved.toFixed(4)} preserved against ${p.chance.toFixed(4)} by chance\n`);
    // The whole reason this command exists. A scatter plot that does not beat scattering the same
    // points at random is a decoration, and it says so here rather than in a caption nobody writes.
    process.stdout.write(
      p.informative
        ? `the layout carries ${(p.preserved / p.chance).toFixed(1)}x chance — neighbourhoods on the map are real\n`
        : `NOTHING MEASURED — ${(p.preserved / (p.chance || 1)).toFixed(1)}x chance. Do not read clusters off this plot.\n`,
    );
    process.stdout.write(`\ncorpus/atlas.json\ncorpus/atlas.html  — open this one in a browser\n`);
  });

await program.parseAsync(process.argv);
