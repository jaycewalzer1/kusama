// The material sheet: what the artist took from looking, and where each piece of it came from.
//
// This is the thing RESEARCH exists to produce and the only thing that crosses from research into
// the trajectory. The corpus queries that produced the candidates do not cross; they are discovery
// data. What crosses is prose the artist wrote, with citations, handed to FIND as an observation.
//
// ## The bar the brief sets, restated as a check
//
// "Ruled lines that show through the text and rubricated initials that ignore the column, as in
// these six manuscripts" is material. "Medieval feel" is not. The difference is not enforceable by a
// validator — no schema can tell a concrete borrowing from an atmospheric one — so what is enforced
// here is the part that *is* checkable, and it turns out to be most of the way there:
//
//   - every citation must resolve to a real manifest id, and
//   - the sheet is measured for how many works, cultures and periods it actually spans.
//
// A borrowing stated as "medieval feel" cannot cite six manuscripts by accession number without the
// artist having looked at six manuscripts. Making provenance mandatory and checkable is what makes
// vagueness expensive.
//
// ## Unresolved citations are the failure this file is really guarding
//
// A model asked for museum object ids will produce museum object ids whether or not it saw any. An
// invented `met:436535` is indistinguishable from a real one by eye, reads as authority, and would
// put a fabricated provenance chain into the record the whole project is built to trust. So
// `coverage` returns `unresolved` and callers are expected to treat a non-empty list as a defect of
// the run rather than a rounding error. It is the same reasoning as `shownWorks`' existsSync: never
// let the artist be told it looked at something that is not there.
//
// ## Why this is not in observation.ts
//
// observation.ts hashes its own bytes into `envVersion.observationHash`, so putting an optional
// layer's wording there declares every trajectory ever collected to be from a different environment.
// influence-doc.ts made this decision first and this file follows it exactly: the block is built
// here, appended by the phases that use it, and carries its own hash which is present only when the
// layer is. A run without research is byte-identical to a run from before this file existed.

import { contentHash } from '../env/profile.js';
import { centuryOf, loadResearchIndex } from './research-query.js';
import type { Work } from './manifest.js';
import type { Problem } from './types.js';

/** One thing worth stealing, and the works it was seen in. */
export interface Material {
  id: string;
  /** The concrete thing, described so that someone could look for it in the cited works. */
  material: string;
  /** What taking it would do in this artist's own work. Not a description of the source. */
  borrowing: string;
  /** Manifest work ids. Every one is checked; an id that does not resolve is a fabrication. */
  works: string[];
}

/** What was asked of the corpus. Kept for the discovery record; never enters a hash. */
export interface ResearchQuery {
  axis: string;
  query: string;
  returned: number;
  shortfall: string;
}

export interface MaterialSheet {
  materials: Material[];
  queries: ResearchQuery[];
  /** Hash of the rendered block, so two runs shown different sheets are visibly different runs. */
  hash: string;
}

export interface Coverage {
  /** Distinct manifest ids cited that actually resolve. */
  works: number;
  cultures: number;
  /** Distinct centuries, BCE included as negatives. Rows with an unusable date are not counted. */
  centuries: number;
  /** Cited ids that are in no manifest row. Any entry here means a citation was invented. */
  unresolved: string[];
  /** Materials citing nothing at all. */
  uncited: string[];
}

/** Human citation form. The manifest's hyphen id remains accepted for existing sheets. */
export function citationId(work: Work): string {
  return `${work.source}:${work.object_id}`;
}

function workMap(): Map<string, Work> {
  const byId = new Map<string, Work>();
  for (const work of loadResearchIndex().works) {
    byId.set(work.id, work);
    byId.set(citationId(work), work);
  }
  return byId;
}

/**
 * What the sheet actually spans, measured against the manifest rather than against its own claims.
 *
 * The brief's target is 50 works across three cultures or periods. This returns the numbers; it does
 * not decide whether they are enough, because the threshold belongs to the caller that knows whether
 * this is a full run or a test with a stub policy.
 */
export function coverage(sheet: MaterialSheet): Coverage {
  const byId = workMap();
  const resolved: Work[] = [];
  const unresolved: string[] = [];
  const uncited: string[] = [];
  const seen = new Set<string>();
  for (const m of sheet.materials) {
    if (m.works.length === 0) uncited.push(m.id);
    for (const id of m.works) {
      if (seen.has(id)) continue;
      seen.add(id);
      const w = byId.get(id);
      if (w) resolved.push(w);
      else unresolved.push(id);
    }
  }
  return {
    works: resolved.length,
    cultures: new Set(resolved.map((w) => w.culture || '-')).size,
    centuries: new Set(resolved.map(centuryOf).filter((c) => c !== null)).size,
    unresolved,
    uncited,
  };
}

const RULE = '-'.repeat(88);

function cite(id: string, byId: Map<string, Work>): string {
  const w = byId.get(id);
  if (!w) return `${id} (NOT IN THE CORPUS)`;
  const facts = [w.date_display, w.culture, w.medium].filter((s) => s && String(s).trim()).join(' · ');
  return `${id} — ${w.title || 'untitled'}${facts ? ` (${facts})` : ''}`;
}

/**
 * The sheet as the artist reads it back at FIND.
 *
 * Written as a record of what this artist found, not as a brief. The distinction is influence-doc's
 * and it holds here for the same reason: the question being tested is whether an artist that has
 * looked at art makes different work, and a block phrased "use these materials" answers it by
 * assuming it. The one imperative is the prohibition, which is not a direction to work in.
 */
export function materialSection(sheet: MaterialSheet): string {
  const byId = workMap();
  const c = coverage(sheet);
  const body = sheet.materials.map((m) =>
    [
      `  [${m.id}] ${m.material}`,
      `        what it would do here: ${m.borrowing}`,
      ...m.works.map((id) => `        seen in: ${cite(id, byId)}`),
    ].join('\n')
  );
  return [
    RULE,
    'WHAT YOU FOUND WHEN YOU WENT LOOKING',
    RULE,
    'You wrote this yourself, earlier in this session, after reading catalogue entries and pictures',
    'from three museum collections. It is a record of what you found, not a brief and not a target.',
    'Reproducing any of the cited works is the one thing that is forbidden.',
    '',
    `${sheet.materials.length} materials, citing ${c.works} works across ${c.cultures} cultures and ${c.centuries} centuries.`,
    '',
    body.join('\n\n'),
    '',
    c.unresolved.length > 0
      ? `NOTE: ${c.unresolved.length} of the ids you cited are in no museum record: ${c.unresolved.join(', ')}.\nA borrowing resting on one of those is resting on nothing.`
      : '',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/** The sheet appended to an observation built elsewhere. Identical string back when there is none. */
export function withMaterials(observation: string, sheet: MaterialSheet | null): string {
  return sheet ? `${observation}\n${RULE}\n${materialSection(sheet)}` : observation;
}

export function sheetHash(materials: Material[], queries: ResearchQuery[]): string {
  return contentHash(materialSection({ materials, queries, hash: '' }));
}

// ---------------------------------------------------------------------------------------------
// What research lends to FIND.
//
// The brief asks that once the artist has looked at art, a problem may quote a work as well as a
// field line. That needs one extra optional field on the FIND schema, and this is where it is built
// rather than in schemas.ts, for the reason at the top of this file: `OBSERVATION_HASH` is taken
// over schemas.ts' own bytes, so adding a field there would declare every trajectory ever collected
// to be from a different environment — including the ones that never did any research.
//
// `workRefs` is deliberately NOT in `required`. The brief's words are that a problem citing no work
// "is still allowed but should be rarer", and a schema that forced a citation would get one from
// every problem, which is the fabrication failure this layer is otherwise built to avoid.

/** FIND's schema with one optional field added: the works a problem was read out of. */
export function withWorkRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties'] as Record<string, Record<string, unknown>>;
  const problems = properties['problems'] as Record<string, unknown>;
  const items = problems['items'] as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...properties,
      problems: {
        ...problems,
        items: {
          ...items,
          properties: {
            ...(items['properties'] as object),
            workRefs: {
              type: 'array',
              minItems: 0,
              items: { type: 'string' },
              description:
                'Optional. Museum ids, in the source:object_id form the sheet uses, of works this ' +
                'problem came out of. Cite only what you actually looked at; an id you did not see ' +
                'is checked against the collection and reported.',
            },
          },
        },
      },
    },
  };
}

export interface WorkGrounding {
  /** Problems citing at least one work that resolves to a museum record. */
  grounded: number;
  /** Cited ids that are in no manifest row. Same failure as `Coverage.unresolved`, same treatment. */
  unresolved: string[];
}

/** How many problems were read out of a work rather than only out of the field. */
export function groundedInWorks(problems: Problem[]): WorkGrounding {
  const byId = workMap();
  const unresolved = new Set<string>();
  let grounded = 0;
  for (const p of problems) {
    let any = false;
    for (const id of p.workRefs ?? []) {
      if (byId.has(id)) any = true;
      else unresolved.add(id);
    }
    if (any) grounded++;
  }
  return { grounded, unresolved: [...unresolved] };
}
