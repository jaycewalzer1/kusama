// The two importers whose failure modes are silent: the Met's CSV and the Art Institute's search.
//
// Neither of these breaks loudly when it is wrong. A CSV split on commas produces a full row of
// plausible values from the wrong columns; a search walk that hits the result cap returns a clean
// 1,000 rows and stops. Both were actually observed here — the first sampled `Is Timeline Work` and
// called it `Is Public Domain`, the second died a thousand rows into a range — which is why these
// tests assert on the shapes that made them detectable rather than on happy paths.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AicRecord, metadataFrom as aicFrom, searchUrl, walkPublicDomain } from '../aic.js';
import { manifestFaults } from '../manifest.js';
import { csvRows, metadataFrom as metFrom } from '../met.js';

// --- the Met's CSV -------------------------------------------------------------------------------

const HEADER =
  '\uFEFFObject Number,Is Highlight,Is Timeline Work,Is Public Domain,Object ID,Department,Object Name,Title,Culture,Artist Display Name,Object Date,Object Begin Date,Object End Date,Medium,Classification,Link Resource';

function withCsv(body: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'kusama-met-'));
  const file = path.join(dir, 'MetObjects.csv');
  writeFileSync(file, `${HEADER}\n${body}`);
  return fn(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a quoted field containing commas and newlines is one field, not several', async () => {
  // The failure this guards is not a crash. Splitting on `,` shifts every later column, so the row
  // still parses, still validates, and reports a department as its classification.
  await withCsv(
    '"36.1",False,True,True,1001,"Arms and Armor","Sword","Fragment, possibly from a sleeve",Japan,Unknown,"1650",1650,1660,Steel,Swords,https://www.metmuseum.org/art/collection/search/1001\n' +
      '"36.2",False,False,True,1002,Drawings,Drawing,"A title\nthat wraps",France,Ingres,"1820",1820,1820,Graphite,Drawings,https://www.metmuseum.org/art/collection/search/1002\n',
    async (file) => {
      const rows = [];
      for await (const r of csvRows(file)) rows.push(r);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.Title, 'Fragment, possibly from a sleeve');
      assert.equal(rows[0]?.Classification, 'Swords');
      assert.equal(rows[1]?.Title, 'A title\nthat wraps');
      // The BOM is welded to the first column name; if it survives, every `Object Number` lookup
      // silently misses and the accession number comes out null on all 248,472 rows.
      assert.equal(rows[0]?.['Object Number'], '36.1');
    },
  );
});

test('the public-domain filter reads the public-domain column and not its neighbour', async () => {
  // `Is Timeline Work` sits immediately left of `Is Public Domain`. An off-by-one here selects the
  // Met's highlight set and presents it as the collection.
  await withCsv(
    '"1.1",False,True,False,2001,Drawings,Drawing,Timeline but not PD,,,,,,,Drawings,u\n' +
      '"1.2",False,False,True,2002,Drawings,Drawing,PD but not timeline,,,,,,,Drawings,u\n',
    async (file) => {
      const kept = [];
      for await (const r of csvRows(file)) {
        const w = metFrom(r);
        if (w) kept.push(w);
      }
      assert.deepEqual(
        kept.map((w) => w.id),
        ['met-2002'],
      );
    },
  );
});

test('an inverted date band becomes null rather than a band that runs backwards', async () => {
  // 147 real rows do this — met-107853 is `"1800–1875"` with the two columns swapped. A backwards
  // band parses as two integers and would be stratified on.
  await withCsv('"7.1",False,False,True,107853,Drawings,Drawing,Inverted,,,"1800–1875",1875,1800,Graphite,Drawings,u\n', async (file) => {
    for await (const r of csvRows(file)) {
      const w = metFrom(r);
      assert.ok(w);
      assert.equal(w.date_begin, null);
      assert.equal(w.date_end, null);
      // The prose is still kept: the source said something, it just did not parse.
      assert.equal(w.date_display, '1800–1875');
      assert.deepEqual(manifestFaults(w), []);
    }
  });
});

test('a row with no classification takes the Met\'s own object name, and is not dropped', async () => {
  // 32,538 public-domain rows (13%) have an empty Classification. Dropping them would quietly
  // remove an eighth of the Met from a corpus somebody believes they selected from.
  await withCsv('"9.1",False,False,True,3001,Greek and Roman Art,Vase fragment,Fragment,,,"",−500,−400,Terracotta,,u\n', async (file) => {
    for await (const r of csvRows(file)) {
      const w = metFrom(r);
      assert.ok(w);
      assert.equal(w.classification, 'Vase fragment');
    }
  });
});

test('the Met carries no image url out of the CSV, and that is a state the manifest accepts', async () => {
  await withCsv('"9.2",False,False,True,3002,Drawings,Drawing,Untitled,,,"1900",1900,1900,Ink,Drawings,u\n', async (file) => {
    for await (const r of csvRows(file)) {
      const w = metFrom(r);
      assert.ok(w);
      assert.equal(w.image_url, null);
      assert.equal(w.image, null);
      assert.deepEqual(manifestFaults(w), []);
    }
  });
});

// --- the Art Institute's search ------------------------------------------------------------------

test('every search url filters through bool, including the one with no id range', () => {
  // `query[term]` and `query[range]` as siblings under one `query` is a 400 — Elasticsearch reads
  // the pair as a single malformed `term`. Emitting `bool.filter` even for the one-clause case is
  // what keeps the unranged URL from being a shape that is only ever exercised in a full run.
  for (const url of [searchUrl(1, 1), searchUrl(2, 100, { from: 0, to: 100 })]) {
    assert.ok(url.includes(encodeURIComponent('query[bool][filter][0][term][is_public_domain]')), url);
    assert.ok(!url.includes(encodeURIComponent('query[term]')), url);
  }
  const ranged = searchUrl(2, 100, { from: 5, to: 9 });
  // A filter-only query scores every document identically, so paging it without an explicit sort
  // yields some works twice and others never. Measured on a full unsorted pull: 59,042 rows
  // containing 57,701 distinct works.
  for (const url of [searchUrl(1, 1), ranged]) assert.ok(url.includes(`${encodeURIComponent('sort[0]')}=id`), url);
  assert.ok(ranged.includes(encodeURIComponent('query[bool][filter][1][range][id][gte]')));
  assert.ok(ranged.includes('=5'));
});

test('the walk splits any range over the cap instead of reading its first page and stopping', async () => {
  // The cap is measured at 1,000: page 10 is 200 and page 11 is 403. A walk that ignores it does
  // not fail — it returns the first 1,000 in whatever order the engine felt like, which is the
  // "sample" this partition exists to prevent.
  const asked: { from: number; to: number }[] = [];
  const count = async (r: { from: number; to: number }) => {
    asked.push(r);
    // Everything lives in the low half, so the split has to actually recurse rather than merely
    // halve once.
    return r.from > 50 ? 0 : Math.min(2500, (r.to - r.from + 1) * 25);
  };
  const page = async (r: { from: number; to: number }, n: number): Promise<AicRecord[]> =>
    n > Math.ceil(Math.min(2500, (r.to - r.from + 1) * 25) / 100) ? [] : [{ id: r.from * 1000 + n, is_public_domain: true, image_id: 'x' }];

  const seen: number[] = [];
  for await (const rec of walkPublicDomain(count, page, { from: 0, to: 100 })) seen.push(rec.id);

  // No range that was actually paged held more than the cap.
  for (const r of asked) {
    const total = r.from > 50 ? 0 : Math.min(2500, (r.to - r.from + 1) * 25);
    if (total > 1000) assert.ok(r.to > r.from, `range ${r.from}..${r.to} held ${total} and could not be split`);
  }
  assert.ok(seen.length > 0);
  assert.equal(new Set(seen).size, seen.length, 'the walk yielded the same record twice');
});

test('a single id that cannot be split throws rather than silently truncating', async () => {
  // Unreachable against the real collection. Loud anyway, because the alternative is a run that
  // looks complete and is short by however many rows were over the cap.
  const walk = walkPublicDomain(
    async () => 5000,
    async () => [],
    { from: 7, to: 7 },
  );
  await assert.rejects(() => walk.next(), /cannot be split/);
});

test('an AIC record without an image or without the public-domain flag is refused', () => {
  assert.equal(aicFrom({ id: 1, is_public_domain: false, image_id: 'a' }), null);
  assert.equal(aicFrom({ id: 2, is_public_domain: true, image_id: null }), null);
  const w = aicFrom({ id: 3, is_public_domain: true, image_id: 'abc', title: 'A', date_start: 1900, date_end: 1910 });
  assert.ok(w);
  assert.deepEqual(manifestFaults(w), []);
  assert.equal(w.id, 'aic-3');
  // The width in the IIIF path is a choice and it is part of what was read, so it is asserted.
  assert.equal(w.image_url, 'https://www.artic.edu/iiif/2/abc/full/843,/0/default.jpg');
  // The rights string records the field it came from rather than translating it into a licence
  // name the API does not use.
  assert.match(w.rights, /is_public_domain/);
});
