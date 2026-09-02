// RESEARCH, with a policy that can only cite what it was actually shown.
//
// The stub here is not the shared `StubPolicy`: it parses the work ids out of the observation it is
// handed and cites those. That is the point of the test rather than a convenience. The one failure
// this phase exists to prevent is a fabricated provenance — a model asked for museum object ids will
// produce museum object ids whether or not it saw any, and `met:436535` reads as authority whether
// or not it is real. A stub that cited ids baked into the test file would pass while proving that
// the pipeline can carry an invention end to end.
//
// So there are two stubs. The honest one cites what it was shown and must come out clean. The
// dishonest one cites an id that is in no museum record, and `coverage` must catch it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newSpend } from '../call.js';
import { DiscoveryLog, readDiscovery } from '../discovery-log.js';
import { loadCommission } from '../field.js';
import {
  coverage,
  groundedInWorks,
  materialSection,
  sheetHash,
  withMaterials,
  withWorkRefs,
  type MaterialSheet,
} from '../material-sheet.js';
import { find } from '../phases/find.js';
import { research } from '../phases/research.js';
import { FIND_SCHEMA } from '../schemas.js';
import { corpusAvailable, centuryOf, loadResearchIndex, scoreSubject, search } from '../research-query.js';
import { StudioLog } from '../studio-log.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';
import type { Problem } from '../types.js';

const HAVE_CORPUS = corpusAvailable();
const skip = HAVE_CORPUS ? false : 'corpus/manifest.jsonl is not on this machine';

/** Every work id the observation listed, in the order they appear. */
function idsShown(observation: string): string[] {
  return [...observation.matchAll(/^ {2}([a-z]+:[^ |]+) \|/gm)].map((m) => m[1] as string);
}

class ResearchStub implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly requests: PolicyRequest[] = [];

  constructor(private readonly fabricate: string | null = null) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.requests.push(request);
    const action = this.answer(request);
    return {
      action: action as T,
      raw: JSON.stringify(action),
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }

  private answer(request: PolicyRequest): unknown {
    if (request.name === 'research-queries') {
      return {
        queries: [
          { looking_for: 'ruled lines that show through', subject: 'ruled lines manuscript initials column' },
          { looking_for: 'repeated marks over a whole surface', subject: 'repeated pattern surface covering' },
          { looking_for: 'somewhere I would not otherwise go', classification: 'Textile', culture: 'Peru' },
          { looking_for: 'a period I have not read', subject: 'inscription stone carved', centuryFrom: -20, centuryTo: 0 },
        ],
      };
    }
    if (request.name === 'research-followup') {
      const shown = idsShown(request.observation);
      return {
        queries: [
          { looking_for: 'what else looks like the first thing I found', like: shown[0] ?? 'nothing' },
          { looking_for: 'a second opinion on appearance', subject: 'gold ground punchwork halo' },
        ],
      };
    }
    // The sheet. Cites only ids that were in the observation, except when told to fabricate.
    const shown = idsShown(request.observation);
    const works = shown.slice(0, 8);
    return {
      materials: Array.from({ length: 6 }, (_, i) => ({
        id: `m${i + 1}`,
        material: `A concrete thing done to a surface, number ${i + 1}, described at enough length to be looked for.`,
        borrowing: `What taking it would change about a surface I made, number ${i + 1}.`,
        works: i === 0 && this.fabricate ? [...works.slice(0, 2), this.fabricate] : works.slice(i, i + 3),
      })),
    };
  }
}

/**
 * A policy that answers FIND and keeps what it was asked. The assertions are all about the request,
 * so the answer only has to be shaped enough for the draw at the end of `find` to run.
 */
class FindStub implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly requests: PolicyRequest[] = [];

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.requests.push(request);
    const action = {
      questions: [],
      problems: Array.from({ length: 4 }, (_, i) => ({
        id: `p${i + 1}`,
        text: `A difficulty in making this, number ${i + 1}, stated at enough length to be a problem.`,
        tension: { between: 'one thing', and: 'another', claim: 'they do not sit together' },
        fieldRefs: ['a line of the field'],
        probability: 0.25,
      })),
    };
    return {
      action: action as T,
      raw: JSON.stringify(action),
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }
}

test('BM25 free text scores documents, and the term-id lookup is the one that bites', { skip }, () => {
  const ix = loadResearchIndex();
  // The regression this pins: `postings` and `idf` are keyed by term ID, not by term string, so a
  // string-keyed loop returns an empty result with no error at all rather than throwing.
  assert.ok(ix.termId.size > 0, 'the term-id map is populated');
  assert.equal(ix.termId.size, ix.text.terms.length);
  const hits = scoreSubject(ix, 'ruled lines rubricated initials column');
  assert.ok(hits.length > 0, 'a plain query matches something');
  assert.ok(hits[0]!.score > 0, 'the top hit has a positive score');
  for (let i = 1; i < Math.min(hits.length, 50); i++) {
    assert.ok(hits[i - 1]!.score >= hits[i]!.score, 'the ranking is descending');
  }
  // Every hit says what matched, and what it says is true of the query.
  const asked = new Set(['ruled', 'lines', 'rubricated', 'initials', 'column']);
  for (const h of hits.slice(0, 20)) {
    assert.ok(h.terms.length > 0, 'a hit names the terms that matched it');
    for (const t of h.terms) assert.ok(asked.has(t), `"${t}" was actually in the query`);
  }
});

test('the century guard rejects the manifest row that would widen every period count', { skip }, () => {
  const { works } = loadResearchIndex();
  const bad = works.filter((w) => typeof w.date_begin === 'number' && w.date_begin >= 2100);
  assert.ok(bad.length > 0, 'the corpus still holds at least one impossible date; this test is about it');
  for (const w of bad) assert.equal(centuryOf(w), null, `${w.id} (date_begin ${w.date_begin}) is not a century`);
  const ok = works.find((w) => w.date_begin === 1500);
  if (ok) assert.equal(centuryOf(ok), 15);
});

test('diversification spreads a query and says so when it cannot', { skip }, () => {
  const wide = search({ subject: 'ruled lines showing through the text with rubricated initials', k: 50, capPerFacet: 3 });
  assert.ok(wide.candidates.length >= 40, `expected a full sheet, got ${wide.candidates.length}`);
  assert.ok(wide.cultures >= 3, `the brief wants three cultures, got ${wide.cultures}`);
  assert.equal(wide.shortfall, '', 'a query that was met reports no shortfall');

  // Capping to one per facet on the same query must starve, and must say it starved rather than
  // returning a short sheet that reads like a full one.
  const starved = search({ subject: 'repeated dots covering an entire surface', k: 50, capPerFacet: 1 });
  assert.ok(starved.candidates.length < 50);
  assert.match(starved.shortfall, /asked for 50, found \d+/);

  // Every candidate explains itself. A bare score would make a bad hit look authoritative.
  for (const c of wide.candidates) assert.ok(c.why.length > 0 && !/^\d/.test(c.why));
});

test('an unresolved citation is caught, not carried', { skip }, () => {
  const sheet: MaterialSheet = {
    materials: [
      { id: 'm1', material: 'a real one', borrowing: 'does a thing', works: [loadResearchIndex().works[0]!.id] },
      { id: 'm2', material: 'an invented one', borrowing: 'does a thing', works: ['met:999999999'] },
      { id: 'm3', material: 'cites nothing', borrowing: 'does a thing', works: [] },
    ],
    queries: [],
    hash: '',
  };
  const c = coverage(sheet);
  assert.deepEqual(c.unresolved, ['met:999999999']);
  assert.deepEqual(c.uncited, ['m3']);
  assert.equal(c.works, 1);
  // And the artist is told, in the block it reads, that the citation rests on nothing.
  assert.match(materialSection(sheet), /NOT IN THE CORPUS/);
  assert.match(materialSection(sheet), /is resting on nothing/);
});

test('a run without a sheet is byte-identical to one from before this layer existed', () => {
  assert.equal(withMaterials('OBSERVATION', null), 'OBSERVATION');
});

test('the sheet hash moves when the sheet does', { skip }, () => {
  const id = loadResearchIndex().works[0]!.id;
  const a = sheetHash([{ id: 'm1', material: 'x'.repeat(40), borrowing: 'y'.repeat(30), works: [id] }], []);
  const b = sheetHash([{ id: 'm1', material: 'z'.repeat(40), borrowing: 'y'.repeat(30), works: [id] }], []);
  assert.notEqual(a, b);
});

test('RESEARCH cites real works, and writes to discovery.jsonl and nowhere else', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-'));
  const discovery = new DiscoveryLog(dir);
  const policy = new ResearchStub();
  const spend = newSpend();
  const result = await research(policy, discovery, spend, loadCommission('interference', 'fifty-year-embargo'));

  assert.deepEqual(
    policy.requests.map((r) => r.name),
    ['research-queries', 'research-followup', 'research-sheet']
  );
  assert.equal(spend.policyCalls, 3);

  // The formal axis was reachable in round two and not in round one, which is why there are two.
  const queries = readDiscovery(discovery.file).filter((l) => l.kind === 'query');
  const round2 = queries.filter((l) => (l.data as { round: number }).round === 2);
  assert.ok(round2.some((l) => 'like' in ((l.data as { spec: object }).spec as object)), 'round two used the appearance axis');

  assert.deepEqual(result.coverage.unresolved, [], 'every cited id resolves to a museum record');
  assert.ok(result.candidatesSeen > 50, `the artist read ${result.candidatesSeen} catalogue entries`);
  assert.ok(result.coverage.cultures >= 3, `cited ${result.coverage.cultures} cultures`);

  // The record is plain: no chain fields, so a discovery line can never be mistaken for a canonical
  // one. And the whole model call is in it, exactly as studio.jsonl would have written it.
  const lines = readDiscovery(discovery.file);
  for (const l of lines) {
    assert.ok(!('hash' in l) && !('prev' in l), 'discovery lines carry no chain');
  }
  const calls = lines.filter((l) => l.kind === 'policy-call');
  assert.equal(calls.length, 3);
  assert.ok((calls[0]!.data as { observation: string }).observation.length > 0, 'the observation is logged whole');

  // Nothing was written beside it. studio.jsonl is the chain and RESEARCH must not have touched it.
  assert.throws(() => readFileSync(path.join(dir, 'studio.jsonl'), 'utf8'));
});

test('the FIND schema gains workRefs without making it required, and FIND_SCHEMA is untouched', () => {
  const before = JSON.stringify(FIND_SCHEMA);
  const widened = withWorkRefs(FIND_SCHEMA) as {
    properties: { problems: { items: { required: string[]; properties: Record<string, unknown> } } };
  };
  const items = widened.properties.problems.items;
  assert.ok('workRefs' in items.properties, 'a problem may now cite a work');
  assert.ok(!items.required.includes('workRefs'), 'a problem that cites no work is still legal');
  // Everything the original schema asked for still stands, and the original object was not mutated.
  for (const key of ['id', 'text', 'tension', 'fieldRefs', 'probability']) {
    assert.ok(key in items.properties, `${key} survived widening`);
  }
  assert.equal(JSON.stringify(FIND_SCHEMA), before, 'FIND_SCHEMA is copied, never edited in place');
});

test('a problem citing a work is grounded in it, and an invented id is reported', { skip }, () => {
  const real = loadResearchIndex().works[0]!.id;
  const problem = (id: string, workRefs?: string[]): Problem => ({
    id,
    text: 'x'.repeat(45),
    tension: { between: 'a', and: 'b', claim: 'c' },
    fieldRefs: ['a line'],
    ...(workRefs ? { workRefs } : {}),
  });
  const g = groundedInWorks([
    problem('p1', [real]),
    problem('p2', ['met:999999999']),
    problem('p3'),
    problem('p4', []),
  ]);
  assert.equal(g.grounded, 1, 'only the one that cited a real work counts');
  assert.deepEqual(g.unresolved, ['met:999999999']);
});

test('FIND without a sheet is the call it was before this layer existed', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'find-plain-'));
  const policy = new FindStub();
  await find(policy, new StudioLog(dir), newSpend(), loadCommission('interference', 'fifty-year-embargo'), 7);
  const request = policy.requests[0]!;
  // Object identity, not deep equality: the widened schema is a copy, so this is the strongest
  // available statement that an unresearched run is asking for exactly the old shape.
  assert.equal(request.schema, FIND_SCHEMA);
  assert.doesNotMatch(request.system, /looking at art/);
  assert.doesNotMatch(request.observation, /WHAT YOU FOUND WHEN YOU WENT LOOKING/);
});

test('FIND with a sheet reads it, and may quote it', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'find-sheet-'));
  const id = loadResearchIndex().works[0]!.id;
  const materials = [{ id: 'm1', material: 'x'.repeat(40), borrowing: 'y'.repeat(30), works: [id] }];
  const sheet: MaterialSheet = { materials, queries: [], hash: sheetHash(materials, []) };
  const policy = new FindStub();
  await find(policy, new StudioLog(dir), newSpend(), loadCommission('interference', 'fifty-year-embargo'), 7, null, sheet);
  const request = policy.requests[0]!;
  assert.match(request.observation, /WHAT YOU FOUND WHEN YOU WENT LOOKING/);
  assert.match(request.system, /looking at art/);
  assert.notEqual(request.schema, FIND_SCHEMA);
  const items = (request.schema as { properties: { problems: { items: { properties: object } } } }).properties.problems
    .items;
  assert.ok('workRefs' in items.properties);
});

test('RESEARCH reports a fabricated citation instead of passing it on', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-bad-'));
  const result = await research(
    new ResearchStub('met:999999999'),
    new DiscoveryLog(dir),
    newSpend(),
    loadCommission('interference', 'fifty-year-embargo')
  );
  assert.deepEqual(result.coverage.unresolved, ['met:999999999']);
});
