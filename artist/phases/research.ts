// RESEARCH: go and look at art, before deciding what is difficult here.
//
// The two logged runs never did this. The corpus was built, embedded, measured and never once
// reached a decision — "an artist that does not look at art is not the artist the pitch describes".
// This phase is that clause, and it runs before FIND so that the problems the artist finds can be
// problems about material it has actually seen.
//
// ## Three calls, and why it is not one
//
//   1. `research-queries`  the artist asks the corpus questions, along the subject and metadata axes
//   2. `research-followup` having seen what came back, it asks again — and can now ask the formal
//                          axis, "what else looks like this one", which needs a work id it did not
//                          have before the first round
//   3. `research-sheet`    it writes the material sheet from everything it has seen
//
// The second round exists because the appearance axis is unusable without it. CLIP and DINO
// neighbours are image-to-image; at round one the artist holds no work ids, so an interface offering
// only one round offers the formal axis in name and never in fact. Round two is also where a
// surprising hit gets followed, which is the behaviour the brief is asking for when it says the
// connections should be ones a curator would find surprising and defensible.
//
// ## Nothing here enters the hash chain
//
// Every call in this file is logged to `discovery.jsonl`, not `studio.jsonl`. That is the brief's
// rule and it is load-bearing: retrieval must never move a hash. The material sheet reaches the
// trajectory the only way it is allowed to — as part of FIND's observation, which `callPolicy` logs
// in full into the chain like any other observation. So the record still contains everything the
// artist was shown; what it does not contain is the query that found it.
//
// ## The artist is shown pictures, not just catalogue lines
//
// Up to `THUMBNAILS` candidates are attached as images to the sheet call, chosen from the ones whose
// pixels are actually on this machine. `corpus/images/` is 3 GB and untracked, so on a clone the
// manifest resolves and no pixel does; a phase that counted works with an `image_url` would tell the
// artist to look at pictures that were never attached. Same defect, same guard, as `shownWorks`.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import { callPolicy, type Spend } from '../call.js';
import type { DiscoveryLog } from '../discovery-log.js';
import { artistLayers, type Commission } from '../field.js';
import { imagePath, type Work } from '../manifest.js';
import { citationId, coverage, sheetHash, type Coverage, type Material, type MaterialSheet, type ResearchQuery } from '../material-sheet.js';
import { stack } from '../observation.js';
import type { Policy, PolicyImage } from '../policy/interface.js';
import { centuryOf, search, type Candidate, type QuerySpec } from '../research-query.js';

/** How many candidate works the artist is shown as pictures rather than only as catalogue lines. */
export const THUMBNAILS = 10;

/** How many works a query returns. Wide, because the sheet is meant to outrun a week of looking. */
const PER_QUERY = 40;

const RULE = '-'.repeat(88);

const QUERY_SYSTEM = [
  'You are an artist in a collection of 20,000 works from three museums, looking for material you',
  'could actually steal. Not a mood, not a period: a specific thing someone did to a surface.',
  '',
  'You are writing search queries. Two kinds are available and they behave differently:',
  '',
  '  subject   plain words, matched against catalogue text — titles, classifications, media,',
  '            cultures, dates. It matches WORDS, not ideas. It has no notion of what a picture',
  '            depicts beyond what the catalogue happens to say. "five" will return coins called',
  '            Five Guineas. Write queries whose words a cataloguer would plausibly have typed.',
  '  where     a filter on the catalogue columns: culture, department, classification, medium, and a',
  '            century range. Use it to force yourself somewhere you would not otherwise go.',
  '',
  'Spread out deliberately. Queries that all circle one period return one period. The collection is',
  '26% Egyptian Art, so a query that does not push elsewhere will drift there on its own.',
].join('\n');

const FOLLOWUP_SYSTEM = [
  'You have looked at a first set of works. Now ask better questions.',
  '',
  'A third kind of query is available to you now, and was not before:',
  '',
  '  like      a work id you have just seen. Returns works that LOOK like it — measured from the',
  '            pixels by two different vision models, ignoring what the catalogue says. This is how',
  '            you cross a period or a culture on the strength of appearance alone, and it is the',
  '            only way to find a work whose catalogue entry shares no words with anything you know',
  '            to ask for.',
  '',
  'Follow what surprised you. A hit you cannot explain from its catalogue line is the most valuable',
  'thing on the list; a hit that merely confirms what you already expected is the least.',
].join('\n');

const SHEET_SYSTEM = [
  'Write down what you found that is worth taking.',
  '',
  'The test for every entry is whether someone else could go to the works you cite and see the thing',
  'you are describing. "Ruled lines that show through the text, and rubricated initials that ignore',
  'the column the text is set in" is material. "Medieval feel" is not material, and neither is',
  '"a sense of accumulated time" — those are moods, and a mood cites nothing because there is',
  'nothing in a picture to point at.',
  '',
  'Cite by work id, and only ids that are on the list you were shown. An id you did not see is a',
  'fabricated provenance and it will be checked against the museum records.',
  '',
  'Say what taking each thing would DO in your own work. Not what it does in the original — what it',
  'would change about a surface you made. If a borrowing has no consequence you can name, it is a',
  'thing you liked rather than a thing you can use, and it does not belong on the sheet.',
].join('\n');

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['queries'],
  properties: {
    queries: {
      type: 'array',
      minItems: 4,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['looking_for'],
        properties: {
          looking_for: { type: 'string', minLength: 10, description: 'What you hope this turns up, in your own words. Not sent to the index.' },
          subject: { type: 'string', description: 'Plain words matched against catalogue text. Omit for a pure metadata query.' },
          culture: { type: 'string', description: 'Substring of the culture column, e.g. "Peru", "Japan".' },
          department: { type: 'string', description: 'Substring of the museum department.' },
          classification: { type: 'string', description: 'Substring of the classification, e.g. "Textile", "Print".' },
          medium: { type: 'string', description: 'Substring of the medium.' },
          centuryFrom: { type: 'integer', description: 'Earliest century, negative for BCE. 12 means the 1100s.' },
          centuryTo: { type: 'integer', description: 'Latest century, inclusive.' },
        },
      },
    },
  },
};

const FOLLOWUP_SCHEMA = {
  ...QUERY_SCHEMA,
  properties: {
    queries: {
      ...QUERY_SCHEMA.properties.queries,
      items: {
        ...QUERY_SCHEMA.properties.queries.items,
        properties: {
          ...QUERY_SCHEMA.properties.queries.items.properties,
          like: { type: 'string', description: 'A work id from the list you were just shown. Returns works that look like it.' },
        },
      },
    },
  },
};

const SHEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['materials'],
  properties: {
    materials: {
      type: 'array',
      minItems: 6,
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'material', 'borrowing', 'works'],
        properties: {
          id: { type: 'string', pattern: '^m[0-9]+$', description: 'm1, m2, m3 …' },
          material: {
            type: 'string',
            minLength: 40,
            description: 'The concrete thing that was done to a surface, described so it could be looked for.',
          },
          borrowing: {
            type: 'string',
            minLength: 30,
            description: 'What taking it would change about a surface you made. Not what it does in the original.',
          },
          works: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: { type: 'string' },
            description: 'Work ids from the list you were shown. Every one is checked against the museum records.',
          },
        },
      },
    },
  },
};

interface ProposedQuery {
  looking_for: string;
  subject?: string;
  like?: string;
  culture?: string;
  department?: string;
  classification?: string;
  medium?: string;
  centuryFrom?: number;
  centuryTo?: number;
}

function toSpec(q: ProposedQuery): QuerySpec {
  const where: QuerySpec['where'] = {};
  if (q.culture) where.culture = q.culture;
  if (q.department) where.department = q.department;
  if (q.classification) where.classification = q.classification;
  if (q.medium) where.medium = q.medium;
  if (q.centuryFrom !== undefined) where.centuryFrom = q.centuryFrom;
  if (q.centuryTo !== undefined) where.centuryTo = q.centuryTo;
  return {
    ...(q.subject ? { subject: q.subject } : {}),
    ...(q.like ? { like: q.like } : {}),
    ...(Object.keys(where).length > 0 ? { where } : {}),
    k: PER_QUERY,
  };
}

/** One candidate, as the artist reads it. The id comes first because the id is what gets cited. */
function candidateLine(c: Candidate): string {
  const w = c.work;
  const century = centuryOf(w);
  const facts = [w.date_display, w.culture, w.classification, w.medium]
    .filter((s) => s && String(s).trim())
    .join(' · ');
  return `  ${citationId(w)} | ${w.title || 'untitled'}\n      ${facts || 'no catalogue description'}${century === null ? '' : ` [century ${century}]`}\n      found by: ${c.why}`;
}

function catalogue(cands: Candidate[]): string {
  return cands.map(candidateLine).join('\n');
}

/** Candidates whose pixels are on this machine, which is not the same as candidates with an image_url. */
function withPixels(cands: Candidate[], n: number): { work: Work; file: string }[] {
  const out: { work: Work; file: string }[] = [];
  for (const c of cands) {
    if (out.length >= n) break;
    const rel = imagePath(c.work);
    if (!rel) continue;
    const file = path.join(ROOT, 'corpus', rel);
    if (existsSync(file)) out.push({ work: c.work, file });
  }
  return out;
}

function briefBlock(commission: Commission): string {
  const l = artistLayers(commission);
  return stack(l.position, l.practice, l.brief);
}

export interface ResearchResult {
  sheet: MaterialSheet;
  coverage: Coverage;
  /** Distinct works the artist actually read a catalogue line for. */
  candidatesSeen: number;
  queries: ResearchQuery[];
}

/**
 * Run the queries, keeping one entry per work and remembering every axis that found it.
 *
 * Deduplication is by work id and not by sha256 on purpose: this is a reading list, and two
 * accession numbers over one set of bytes are two catalogue entries the artist may legitimately want
 * to cite separately. The similarity code deduplicates by sha256 because a cosine between a work and
 * itself is meaningless; a citation is not.
 */
function runQueries(
  proposed: ProposedQuery[],
  discovery: DiscoveryLog,
  round: number
): { candidates: Candidate[]; queries: ResearchQuery[] } {
  const byId = new Map<string, Candidate>();
  const queries: ResearchQuery[] = [];
  for (const q of proposed) {
    const spec = toSpec(q);
    let sheet;
    try {
      sheet = search(spec);
    } catch (e) {
      // A query that throws is a query the artist wrote badly, not a run that should die. It is
      // recorded as having returned nothing so the sheet call can see that it did.
      const why = e instanceof Error ? e.message : String(e);
      queries.push({ axis: `round${round}`, query: JSON.stringify(spec), returned: 0, shortfall: why });
      discovery.append('query', { round, spec, lookingFor: q.looking_for, returned: 0, error: why });
      continue;
    }
    for (const c of sheet.candidates) if (!byId.has(c.work.id)) byId.set(c.work.id, c);
    queries.push({
      axis: `round${round}`,
      query: JSON.stringify(spec),
      returned: sheet.candidates.length,
      shortfall: sheet.shortfall,
    });
    discovery.append('query', {
      round,
      spec,
      lookingFor: q.looking_for,
      returned: sheet.candidates.length,
      cultures: sheet.cultures,
      departments: sheet.departments,
      centuries: sheet.centuries,
      shortfall: sheet.shortfall,
      ids: sheet.candidates.map((c) => c.work.id),
    });
  }
  return { candidates: [...byId.values()], queries };
}

export async function research(
  policy: Policy,
  discovery: DiscoveryLog,
  spend: Spend,
  commission: Commission
): Promise<ResearchResult> {
  const brief = briefBlock(commission);

  const first = await callPolicy<{ queries: ProposedQuery[] }>(policy, discovery, spend, {
    name: 'research-queries',
    system: QUERY_SYSTEM,
    observation: [
      brief,
      RULE,
      'WHAT YOU ARE ABOUT TO DO',
      'Ask the collection for material. You get two rounds; this is the first, and in the second you',
      'will be able to ask for works that LOOK like ones you have found, which you cannot do yet.',
      `Each query returns up to ${PER_QUERY} works, spread across departments and cultures so that one`,
      'well-stocked corner cannot answer everything.',
    ].join('\n'),
    schema: QUERY_SCHEMA,
    maxTokens: 4000,
  });

  const round1 = runQueries(first.action.queries, discovery, 1);

  const second = await callPolicy<{ queries: ProposedQuery[] }>(policy, discovery, spend, {
    name: 'research-followup',
    system: FOLLOWUP_SYSTEM,
    observation: [
      brief,
      RULE,
      `WHAT CAME BACK (${round1.candidates.length} works)`,
      catalogue(round1.candidates),
      RULE,
      'WHAT YOU ASKED, AND WHAT IT COST YOU',
      round1.queries
        .map((q) => `  ${q.query} -> ${q.returned} works${q.shortfall ? ` (${q.shortfall})` : ''}`)
        .join('\n'),
      RULE,
      'ASK AGAIN. This is the last round.',
    ].join('\n'),
    schema: FOLLOWUP_SCHEMA,
    maxTokens: 4000,
  });

  const round2 = runQueries(second.action.queries, discovery, 2);

  const byId = new Map<string, Candidate>();
  for (const c of [...round1.candidates, ...round2.candidates]) if (!byId.has(c.work.id)) byId.set(c.work.id, c);
  const all = [...byId.values()];
  const shown = withPixels(all, THUMBNAILS);
  const images: PolicyImage[] = shown.map((s) => ({
    mediaType: 'image/jpeg' as const,
    base64: readFileSync(s.file).toString('base64'),
  }));

  const sheetCall = await callPolicy<{ materials: Material[] }>(policy, discovery, spend, {
    name: 'research-sheet',
    system: SHEET_SYSTEM,
    observation: [
      brief,
      RULE,
      `EVERYTHING YOU LOOKED AT (${all.length} works)`,
      shown.length > 0
        ? `The ${shown.length} marked [shown] are attached to this message as pictures. The rest you have as\ncatalogue entries only, which is a real limit on what you can claim about them.`
        : 'No pictures are attached: the image files are not on this machine. You have catalogue entries\nonly, and you should not claim to have seen how any of these look.',
      '',
      catalogue(all.map((c) => (shown.some((s) => s.work.id === c.work.id) ? { ...c, why: `[shown] ${c.why}` } : c))),
      RULE,
      'WRITE THE SHEET.',
    ].join('\n'),
    schema: SHEET_SCHEMA,
    images,
    maxTokens: 16000,
  });

  const queries = [...round1.queries, ...round2.queries];
  const materials = sheetCall.action.materials;
  const sheet: MaterialSheet = { materials, queries, hash: sheetHash(materials, queries) };
  const cov = coverage(sheet);
  discovery.append('material-sheet', { sheet, coverage: cov, candidatesSeen: all.length, shown: shown.length });
  return { sheet, coverage: cov, candidatesSeen: all.length, queries };
}
