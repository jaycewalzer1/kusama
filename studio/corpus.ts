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
//   corpus search "<phrase>" [-k N]    find works from words, in CLIP space
//   corpus search --image <file>       find works from a picture, in the same space
//   corpus influences resolve [ids...] a position's background as weights over the corpus
//   corpus influences show <id> | blend <a> <b>
//
// Both network stages are serial with a pause between requests. Not because anything here is heavy,
// but because a museum's open-access API is a courtesy and hammering it is how the courtesy gets
// withdrawn for everybody. `read` is idempotent: the environment model caches on request content, so
// re-running it costs nothing and returns exactly what the first run got.

import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Command } from 'commander';
import { contactSheet, type Image } from '../env/sheet.js';
import { encodePng } from '../env/png.js';
import { decode } from '../artist/pixels.js';
import { derivedIds, elementIds, loadElement } from '../aesthetic/elements/pack.js';
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
import { type Vectors, atlas } from '../artist/atlas.js';
import { atlasPage } from './atlas-page.js';
import { SOURCES, type Source, type Work, imagePath, readManifest, workId } from '../artist/manifest.js';
import { embeddingsAvailable, embeddingsUnavailableMessage } from '../artist/clip-index.js';
import { textAvailable, textUnavailableMessage } from '../artist/clip-text.js';
import { available, embed, unavailableMessage } from '../artist/resemblance.js';
import { searchByText, searchByVector, searchText } from '../artist/search.js';
import {
  DEFAULT_SEED,
  INFLUENCES_DIR,
  blend,
  influencesFile,
  influencesFromElement,
  influencesFromPosition,
  jaccard,
  loadResolved,
  type Resolved,
  resolve,
  resolvedText,
  saveResolved,
} from '../artist/influences.js';
import { loadPosition } from '../artist/field.js';
import { ROOT } from '../env/browser.js';
import { csvRows, metadataFrom as metFrom, resolveImageUrl } from '../artist/met.js';
import { DEFAULT_TARGET, MAX_CLASSIFICATION_SHARE, MAX_SOURCE_SHARE, select } from '../artist/selection.js';
import { deriveElement, deriveProtocolHash, saveDerived } from '../artist/element-derive.js';
import { type AuditPoint, auditFrom, auditText, claimsOf } from '../artist/audit.js';
import { surfaceOf, surfaceText, surfaces } from '../artist/surface.js';
import { type TermField, crosswalk, crosswalkText, dimensionalityOf, dimensionalitySplit, terms } from '../artist/vocabulary.js';

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

const CLIP_MATRIX = path.join(CORPUS_DIR, 'clip.f32');
const CLIP_INDEX = path.join(CORPUS_DIR, 'clip-index.json');
const CLIP_DIM = 512;

/**
 * The image embeddings as a space the atlas can lay out, one row per work that has one.
 *
 * The matrix is one row per *file*, in sorted sha256 order, because a hundred manifest rows share
 * bytes with another row — two catalogued objects photographed together. So the join is by sha256,
 * and works whose pixels have not arrived are dropped rather than given a zero row that would sit
 * at the origin and pull the first axis through itself.
 *
 * A zero row in the matrix is the encoder's recorded failure and is dropped for the same reason.
 */
function clipSpace(works: Work[]): { works: Work[]; space: Vectors } {
  if (!existsSync(CLIP_MATRIX) || !existsSync(CLIP_INDEX)) {
    throw new Error(`no embeddings at ${CLIP_MATRIX} — see corpus/README.md`);
  }
  const index: string[] = JSON.parse(readFileSync(CLIP_INDEX, 'utf8'));
  const buf = readFileSync(CLIP_MATRIX);
  const rowsInFile = Math.floor(buf.length / (CLIP_DIM * 4));
  if (rowsInFile !== index.length) {
    throw new Error(`${CLIP_MATRIX} holds ${rowsInFile} rows but the index names ${index.length}`);
  }
  const at = new Map(index.map((sha, i) => [sha, i]));

  const kept: Work[] = [];
  const rows: Float64Array[] = [];
  for (const w of works) {
    const i = w.image ? at.get(w.image.sha256) : undefined;
    if (i === undefined) continue;
    const row = new Float64Array(CLIP_DIM);
    for (let j = 0; j < CLIP_DIM; j++) row[j] = buf.readFloatLE((i * CLIP_DIM + j) * 4);
    if (row.every((x) => x === 0)) continue;
    kept.push(w);
    rows.push(row);
  }
  // Named so a loading can still be traced to a column, while being honest that the name is an
  // ordinal and not a fact anyone recorded. That is exactly what `composition` exists to make up for.
  return { works: kept, space: { names: Array.from({ length: CLIP_DIM }, (_, i) => `clip:${i}`), rows } };
}

program
  .command('atlas')
  .description('lay the corpus out in two dimensions and say whether the layout means anything')
  .option('--sample <n>', 'how many works the honesty measure compares', '1500')
  .option('--neighbours <k>', 'neighbourhood size for that measure', '20')
  .option('--clip', 'lay out what the works look like, from corpus/clip.f32, instead of what the museums wrote')
  .option('--umap', 'project with UMAP, which keeps neighbourhoods, instead of PCA, which keeps variance')
  .action((opts: { sample: string; neighbours: string; clip?: boolean; umap?: boolean }) => {
    // The default is offline and free: it reads the manifest and nothing else, runs on all 20,000
    // works including the ones whose pixels have not arrived, because every column is a field a
    // museum already filled in. --clip is also offline, but only over the works that have pixels.
    const all = listWorks();
    if (all.length === 0) {
      process.stdout.write('no manifest — run `corpus metadata` and `corpus select` first\n');
      return;
    }
    const { works, space } = opts.clip ? clipSpace(all) : { works: all, space: undefined };
    const stem = opts.clip ? 'atlas-clip' : 'atlas';
    const a = atlas(works, Number(opts.sample), Number(opts.neighbours), space, opts.umap ? 'umap' : 'pca');
    writeFileSync(path.join(CORPUS_DIR, `${stem}.json`), `${JSON.stringify(a, null, 1)}\n`);
    // The link is only rendered when the other map is on disk. A button that 404s teaches a reader
    // that the buttons on this page do not work, which is a worse outcome than no button.
    const other = opts.clip ? 'atlas' : 'atlas-clip';
    writeFileSync(
      path.join(CORPUS_DIR, `${stem}.html`),
      atlasPage(a, new Date().toISOString(), {
        basis: opts.clip ? 'what they look like &mdash; CLIP over the pixels, which never saw the catalogue' : undefined,
        alsoSee: existsSync(path.join(CORPUS_DIR, `${other}.html`))
          ? { href: `${other}.html`, label: opts.clip ? 'the same works by metadata' : 'the same works by appearance' }
          : undefined,
      }),
    );

    const p = a.preservation;
    process.stdout.write(
      `${a.works} works${opts.clip ? ` of ${all.length} (the rest have no embedding)` : ''}, ${a.columns.length} columns, projected by ${a.projection}\n` +
        `PCA axis 1 carries ${(a.varianceExplained[0] ?? 0).toFixed(4)} of the variance, axis 2 ${(a.varianceExplained[1] ?? 0).toFixed(4)}\n`,
    );
    // Printed, not merely stored, because an axis nobody reads the loadings of gets called
    // "style" in the next sentence somebody writes about it. Under UMAP they describe the principal
    // axes, which are not the ones on the page, so they are not printed at all.
    if (a.projection === 'pca') {
      for (const axis of a.loadings) {
        process.stdout.write(`\naxis ${axis[0]?.axis} is made of:\n`);
        for (const l of axis) process.stdout.write(`  ${l.weight >= 0 ? '+' : '-'}${Math.abs(l.weight).toFixed(2)}  ${l.column}\n`);
      }
    }
    // The question the loadings cannot answer when the columns are ordinals, and the one worth
    // asking even when they aren't: what does this space actually call near?
    process.stdout.write(`\n${a.preservation.k} nearest in the full space, against what chance would give:\n`);
    for (const c of a.composition) {
      const times = c.chance > 0 ? (c.share / c.chance).toFixed(1) : '-';
      process.stdout.write(`  ${c.field.padEnd(13)} ${(100 * c.share).toFixed(1)}%  chance ${(100 * c.chance).toFixed(1)}%  ${times}x\n`);
    }
    process.stdout.write(`\n${p.k}-neighbourhoods, over ${p.n} works: ${p.preserved.toFixed(4)} preserved against ${p.chance.toFixed(4)} by chance\n`);
    // The whole reason this command exists. A scatter plot that does not beat scattering the same
    // points at random is a decoration, and it says so here rather than in a caption nobody writes.
    process.stdout.write(
      p.informative
        ? `the layout carries ${(p.preserved / p.chance).toFixed(1)}x chance — neighbourhoods on the map are real\n`
        : `NOTHING MEASURED — ${(p.preserved / (p.chance || 1)).toFixed(1)}x chance. Do not read clusters off this plot.\n`,
    );
    process.stdout.write(`\ncorpus/${stem}.json\ncorpus/${stem}.html  — open this one in a browser\n`);
  });

/** '2d'/'object' as the boolean `surfaces` wants, with 'unknown' kept as null rather than guessed. */
const twoD = (w: Work): boolean | null => {
  const d = dimensionalityOf(w);
  return d === 'unknown' ? null : d === '2d';
};

program
  .command('surface')
  .description('measure the corpus images, in the units the aesthetic layer measures a rendered plate in')
  .option('--sample <n>', 'stride-sample this many images rather than decoding all of them', '1500')
  .option('--all', 'decode every image on disk. Slow, and the bands barely move', false)
  .action((opts: { sample: string; all: boolean }) => {
    const works = listWorks();
    if (works.length === 0) {
      process.stdout.write('no manifest — run `corpus metadata` and `corpus select` first\n');
      return;
    }
    process.stdout.write(surfaceText(surfaces(works, twoD, opts.all ? undefined : Number(opts.sample))));
  });

program
  .command('search')
  .description('find corpus works from a phrase, or from an image, in CLIP space')
  .argument('[query]', 'the phrase to look for')
  .option('--image <file>', 'search with a picture instead of a phrase (png or jpeg)')
  .option('-k, --k <n>', 'how many works to return', '12')
  .option('--museum <s>', 'restrict to one of cma | met | aic')
  .option('--json', 'machine-readable output', false)
  .action(
    async (
      query: string | undefined,
      opts: { image?: string; k: string; museum?: string; json: boolean },
    ) => {
      if (!embeddingsAvailable()) {
        process.stdout.write(embeddingsUnavailableMessage() + '\n');
        process.exitCode = 1;
        return;
      }
      const filter = opts.museum ? (opts.museum as Source) : null;
      if (filter !== null && !SOURCES.includes(filter)) {
        process.stdout.write(`--museum must be one of ${SOURCES.join(' | ')}\n`);
        process.exitCode = 1;
        return;
      }

      let result;
      if (opts.image) {
        if (!available()) {
          process.stdout.write(unavailableMessage() + '\n');
          process.exitCode = 1;
          return;
        }
        const file = path.resolve(opts.image);
        if (!existsSync(file)) {
          process.stdout.write(`no such image: ${file}\n`);
          process.exitCode = 1;
          return;
        }
        result = searchByVector(await embed(file), opts.image, Number(opts.k), filter);
      } else {
        if (!query) {
          process.stdout.write('give a phrase, or --image <file>\n');
          process.exitCode = 1;
          return;
        }
        if (!textAvailable()) {
          process.stdout.write(textUnavailableMessage() + '\n');
          process.exitCode = 1;
          return;
        }
        result = await searchByText(query, Number(opts.k), filter);
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              query: result.query,
              kind: result.kind,
              searched: result.searched,
              distribution: { mean: result.mean, sd: result.sd, min: result.min, max: result.max },
              crossing: result.crossing,
              hits: result.hits.map((h) => ({
                id: h.entry.work.id,
                source: h.entry.work.source,
                title: h.entry.work.title,
                classification: h.entry.work.classification,
                url: h.entry.work.url,
                image: imagePath(h.entry.work),
                sha256: h.entry.sha256,
                aliases: h.entry.aliases,
                score: h.score,
                z: h.z,
                percentile: h.percentile,
              })),
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      process.stdout.write(searchText(result));
    },
  );

program
  .command('vocabulary')
  .description('what the three museums call things, and where they call the same thing different names')
  .option('--field <f>', 'title | medium | classification | all', 'all')
  .option('--top <n>', 'how many terms to print', '30')
  .option('--min-documents <n>', 'ignore terms in fewer works than this; below it the ranking is noise')
  .action((opts: { field: string; top: string; minDocuments?: string }) => {
    const works = listWorks();
    if (works.length === 0) {
      process.stdout.write('no manifest — run `corpus metadata` and `corpus select` first\n');
      return;
    }
    const field = opts.field as TermField;

    // Printed first because it is the number that decides whether any pixel measurement below is
    // about pictures or about photographs of things, and it is not a majority.
    const split = dimensionalitySplit(works);
    process.stdout.write(`${split.works} works, by what the catalogue says they physically are:\n`);
    for (const [k, n] of Object.entries(split.counts)) {
      process.stdout.write(`  ${k.padEnd(8)} ${String(n).padStart(6)}  ${(100 * n / split.works).toFixed(1)}%\n`);
    }
    process.stdout.write('\nand per museum, because the mix is a fact about collecting, not about art:\n');
    for (const [src, row] of Object.entries(split.bySource)) {
      const n = row['2d'] + row.object + row.unknown;
      process.stdout.write(`  ${src.padEnd(8)} ${String(n).padStart(6)}  2d ${(100 * row['2d'] / n).toFixed(1)}%  object ${(100 * row.object / n).toFixed(1)}%  unknown ${(100 * row.unknown / n).toFixed(1)}%\n`);
    }

    const t = terms(works, field, opts.minDocuments ? Number(opts.minDocuments) : undefined);
    process.stdout.write(`\nthe most distinctive terms in \`${field}\` (${t.length} cleared the floor):\n`);
    for (const term of t.slice(0, Number(opts.top))) {
      process.stdout.write(`  ${term.term.padEnd(24)} tfidf ${term.tfidf.toFixed(3)}  in ${term.documents} works, ${term.count} times\n`);
    }

    process.stdout.write(`\n${crosswalkText(crosswalk(works))}`);
  });

program
  .command('audit')
  .description("test the blind readings' spatial claims against the pixels they were written without")
  .option('--permutations <n>', 'shuffles of the labels, which is what `chance` is measured against', '10000')
  .option('--seed <n>', 'the shuffle. A finding that moves with this is not a finding', '1')
  .action((opts: { permutations: string; seed: string }) => {
    const points: AuditPoint[] = [];
    for (const w of listWorks()) {
      const r = loadReading(w.id);
      if (r === null) continue;
      const rel = imagePath(w);
      // NaN, never 0. A missing or unreadable file is a work with no measurement, and `auditFrom`
      // lists it as such; read as 0 it would be the most centred work in the corpus and would drag
      // a median it has no right to.
      let offset = NaN;
      if (rel !== null) {
        try {
          offset = surfaceOf(path.join(CORPUS_DIR, rel), w, twoD(w)).weight.offset;
        } catch {
          offset = NaN;
        }
      }
      points.push({
        id: w.id,
        families: [...new Set(claimsOf(r.reading).map((c) => c.family))],
        offset,
        // `canonical`, not `claimedCanonical`: the split is about what the model actually knew, and
        // a confident wrong guess is evidence the work was NOT memorised.
        recognised: r.canonical,
      });
    }
    if (points.length === 0) {
      process.stdout.write('no readings on disk — run `corpus read` first\n');
      return;
    }
    process.stdout.write(auditText(auditFrom(points, Number(opts.permutations), Number(opts.seed))));
  });

// --- influences -----------------------------------------------------------------------------------

const influences = program
  .command('influences')
  .description("an artist's background as weights over the corpus, resolved offline");

/**
 * Every position on disk, and every element in the pack. Counted, never hard-coded.
 *
 * Both the authored pack and the derived set, because both are lineage a run can be given.
 * `derivedIds()` is empty on a machine that has never had model credit, so a run of this that
 * reports four elements is reporting the authored pack alone.
 */
function influenceSubjects(): { id: string; kind: 'position' | 'element' }[] {
  const out: { id: string; kind: 'position' | 'element' }[] = [];
  const posDir = path.join(ROOT, 'aesthetic', 'positions');
  if (existsSync(posDir)) {
    for (const f of readdirSync(posDir).sort()) {
      if (f.endsWith('.json')) out.push({ id: f.replace(/\.json$/, ''), kind: 'position' });
    }
  }
  for (const id of [...elementIds(), ...derivedIds()].sort()) out.push({ id, kind: 'element' });
  return out;
}

function influencesFor(id: string, kind: 'position' | 'element', seed: number) {
  return kind === 'position'
    ? influencesFromPosition(loadPosition(id), seed)
    : influencesFromElement(loadElement(id) as never, seed);
}

const SHEET_DIR = path.join(ROOT, 'docs', 'demo', 'influences');

/**
 * A resolved set as a picture and a page, both self-contained.
 *
 * No browser. `contactSheet` is pure integer arithmetic over decoded pixels, and the HTML inlines
 * the sheet as a data URI, so the page opens off a filesystem with no server, no network and no
 * Playwright — which is the whole point of it existing as a Thursday demo asset.
 *
 * A work whose file is missing or undecodable leaves a hole rather than shifting everything after it
 * by one cell: the caption grid under the sheet is read against the sheet, and a silent shift would
 * put every caption against the wrong image.
 */
function writeInfluenceSheet(r: Resolved, pngPath: string, cell: number): string[] {
  const cols = 8;
  const blank: Image = { rgba: Buffer.alloc(4, 0), width: 1, height: 1 };
  const failed: string[] = [];
  const images = r.works.map((w) => {
    if (!w.imagePath) {
      failed.push(`${w.id} (no image path in the manifest)`);
      return blank;
    }
    // `imagePath` is `images/<sha256>.jpg`, relative to `corpus/` and not to the repo root.
    const file = path.join(CORPUS_DIR, w.imagePath);
    try {
      const rgb = decode(file);
      const rgba = Buffer.allocUnsafe(rgb.width * rgb.height * 4);
      for (let p = 0, i = 0; p < rgb.width * rgb.height; p++, i += 3) {
        rgba[4 * p] = rgb.data[i]!;
        rgba[4 * p + 1] = rgb.data[i + 1]!;
        rgba[4 * p + 2] = rgb.data[i + 2]!;
        rgba[4 * p + 3] = 0xff;
      }
      return { rgba, width: rgb.width, height: rgb.height };
    } catch (e) {
      failed.push(`${w.id} (${(e as Error).message})`);
      return blank;
    }
  });

  const sheet = contactSheet(images, { cols, cell, gap: 8, background: [0x18, 0x18, 0x18] });
  const png = encodePng(sheet.rgba, sheet.width, sheet.height);
  mkdirSync(path.dirname(path.resolve(pngPath)), { recursive: true });
  writeFileSync(pngPath, png);

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cells = r.works
    .map(
      (w, i) =>
        `<figure><b>${i + 1}</b> <code>${esc(w.id)}</code><br>${esc(w.title || '(untitled)')}` +
        `<br><i>${esc(w.classification || '?')}</i> · ${esc(w.date || '?')} · ${esc(w.museum)}` +
        `<br>weight ${w.weight.toFixed(3)} · cos ${w.cosine.toFixed(4)}<br>via “${esc(w.via)}”</figure>`,
    )
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>influences — ${esc(r.positionId)}</title>
<style>
 body{background:#111;color:#ddd;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:28px 32px}
 h1{font-size:19px;margin:0 0 4px} h2{font-size:14px;margin:26px 0 8px;color:#9ad}
 .warn{color:#e88} img{max-width:100%;border:1px solid #333;display:block;margin:10px 0}
 pre{white-space:pre-wrap;color:#bbb;background:#0b0b0b;padding:14px;border:1px solid #262626;overflow-x:auto}
 .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
 figure{margin:0;padding:8px;border:1px solid #262626;background:#171717;font-size:11px;line-height:1.45}
 code{color:#9ad} i{color:#8a8}
</style>
<h1>influences — ${esc(r.positionId)}</h1>
<div>${r.works.length} works · influencesHash <code>${esc(r.influencesHash)}</code> · seed ${r.seed}</div>
<p class="warn">This is RETRIEVAL, not reading. Nothing here has looked at any of these works. Each is
here because its photograph is near a phrase taken verbatim out of the position file.</p>
${failed.length ? `<p class="warn">${failed.length} of ${r.works.length} images could not be drawn and are blank cells: ${esc(failed.join(', '))}</p>` : ''}
<img src="data:image/png;base64,${png.toString('base64')}" alt="contact sheet, ${cols} columns, in weight order">
<h2>the works, in the same order</h2>
<div class="grid">${cells}</div>
<h2>the numbers, against their chance baselines</h2>
<pre>${esc(resolvedText(r))}</pre>
`;
  const htmlPath = pngPath.replace(/\.png$/, '') + '.html';
  writeFileSync(htmlPath, html);
  return [
    `${path.relative(ROOT, pngPath)}  ${sheet.width}x${sheet.height}  ${r.works.length} works, ${failed.length} blank`,
    `${path.relative(ROOT, htmlPath)}  ${(html.length / 1024).toFixed(0)}KB, self-contained — open it with a browser, no server`,
  ];
}

influences
  .command('resolve')
  .description('derive queries from a position or element, run them, and write the resolved set')
  .argument('[ids...]', 'position or element ids; default is everything on disk')
  .option('--seed <n>', 'seed for the entropy chance bands', String(DEFAULT_SEED))
  .option('--dry-run', 'print the resolution without writing either file', false)
  .action(async (ids: string[], opts: { seed: string; dryRun: boolean }) => {
    if (!embeddingsAvailable() || !textAvailable()) {
      process.stdout.write(`${embeddingsUnavailableMessage()}\n${textUnavailableMessage()}\n`);
      process.exitCode = 1;
      return;
    }
    const all = influenceSubjects();
    const wanted = ids.length ? all.filter((s) => ids.includes(s.id)) : all;
    const missing = ids.filter((i) => !all.some((s) => s.id === i));
    if (missing.length) {
      process.stdout.write(`no position or element named: ${missing.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }

    const resolvedAll = [];
    for (const s of wanted) {
      const inf = influencesFor(s.id, s.kind, Number(opts.seed));
      const r = await resolve(inf);
      resolvedAll.push(r);
      if (!opts.dryRun) {
        mkdirSync(INFLUENCES_DIR, { recursive: true });
        writeFileSync(influencesFile(s.id), JSON.stringify(inf, null, 2) + '\n');
        saveResolved(r);
      }
      process.stdout.write(`\n${'='.repeat(96)}\n${resolvedText(r)}`);
    }

    if (resolvedAll.length > 1) {
      // The check that the whole derivation is worth anything. If two positions with different
      // lineages land on the same works, the queries are not carrying the position.
      process.stdout.write('\noverlap between resolved sets (Jaccard over sha256):\n');
      for (let i = 0; i < resolvedAll.length; i++) {
        for (let j = i + 1; j < resolvedAll.length; j++) {
          const v = jaccard(resolvedAll[i]!, resolvedAll[j]!);
          const verdict = v > 0.5 ? '  <-- these two are not being distinguished' : '';
          process.stdout.write(
            `  ${resolvedAll[i]!.positionId.padEnd(22)} x ${resolvedAll[j]!.positionId.padEnd(22)} ${v.toFixed(3)}${verdict}\n`,
          );
        }
      }
    }
    if (!opts.dryRun) process.stdout.write(`\nwritten to ${path.relative(ROOT, INFLUENCES_DIR)}/\n`);
  });

influences
  .command('show')
  .description('print a resolved set that is already on disk')
  .argument('<id>')
  .option('--json', 'the resolved file itself', false)
  .option('--sheet [file]', 'write a contact sheet of the works, and an HTML page beside it')
  .option('--cell <px>', 'the box each image is fitted into on the sheet', '220')
  .action((id: string, opts: { json: boolean; sheet?: string | boolean; cell: string }) => {
    const r = loadResolved(id);
    if (!r) {
      process.stdout.write(`no resolved influences for ${id} — run \`corpus influences resolve ${id}\`\n`);
      process.exitCode = 1;
      return;
    }
    if (opts.sheet) {
      const png = typeof opts.sheet === 'string' ? opts.sheet : path.join(SHEET_DIR, `${id}.png`);
      for (const line of writeInfluenceSheet(r, png, Number(opts.cell))) process.stdout.write(`${line}\n`);
      return;
    }
    process.stdout.write(opts.json ? JSON.stringify(r, null, 2) + '\n' : resolvedText(r));
  });

influences
  .command('blend')
  .description('what sits between two resolved sets, and what sits between them but in neither')
  .argument('<a>')
  .argument('<b>')
  .option('-k, --k <n>', 'how many works per row', '12')
  .action((aId: string, bId: string, opts: { k: string }) => {
    const a = loadResolved(aId);
    const b = loadResolved(bId);
    if (!a || !b) {
      process.stdout.write(`resolve both first: ${!a ? aId : ''} ${!b ? bId : ''}\n`);
      process.exitCode = 1;
      return;
    }
    const bl = blend(a, b, Number(opts.k));
    process.stdout.write(`blend ${bl.a} x ${bl.b} — centroids sit at cosine ${bl.centroidCosine.toFixed(4)}\n`);
    process.stdout.write(
      bl.centroidCosine > 0.95
        ? '  the two centroids are nearly the same point, so this blend has almost nothing to blend\n'
        : '',
    );
    process.stdout.write('\nnearest the midpoint (excluding both sets):\n');
    for (const w of bl.midpoint) {
      process.stdout.write(`  ${w.cosine.toFixed(4)}  ${w.id.padEnd(12)} ${(w.classification || '?').slice(0, 20).padEnd(20)} | ${(w.title || '').slice(0, 40)}\n`);
    }
    process.stdout.write(
      `\nnear the midpoint but outside BOTH sets' own spreads (a<${a.spread.toFixed(3)}, b<${b.spread.toFixed(3)}) — ` +
        `the only part of a blend neither set could have reached alone:\n`,
    );
    if (bl.surprises.length === 0) {
      process.stdout.write('  NOTHING FOUND. Every work near the midpoint is already inside one of the two sets.\n');
    }
    for (const w of bl.surprises) {
      process.stdout.write(
        `  ${w.cosine.toFixed(4)} (a ${w.toA.toFixed(3)} b ${w.toB.toFixed(3)})  ${w.id.padEnd(12)} ${(w.title || '').slice(0, 40)}\n`,
      );
    }
  });

await program.parseAsync(process.argv);
