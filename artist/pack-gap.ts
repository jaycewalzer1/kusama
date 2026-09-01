// The gap between what the element pack CLAIMS and what its works can ANSWER.
//
// `corpus element-band` established the two halves of this separately and never put them in one
// table. This file is that table, and the table is the finding:
//
//   - Every numeric rule in the pack is written on a `RenderMetrics` field, which needs a confident
//     ground. No element has six sheets among its own 48 works. So the pack constrains what its
//     works cannot answer.
//   - Four ground-free fields DO separate the traditions — `grain.axisShare`, `tone.sd`,
//     `palette.distinct`, `energy.gradient` — and no constraint kind reads any of them. So the works
//     answer what the pack does not ask.
//
// Those are the same gap from both ends, and a reader who sees only one of them draws the wrong
// conclusion from it. Seeing only the first suggests deleting the rules; seeing only the second
// suggests adding four kinds. Seeing both says the rules are hand-written claims that happen to be
// unfalsifiable *here*, and that the falsifiable axes are a different set of quantities entirely.
//
// ## This writes nothing, and there is no `--write`
//
// The obvious next move is to re-derive a bound from a measured band and put it in the pack. That
// moves `elementPackHash`, which makes every trajectory ever collected a different experiment, and
// it is a one-way door that should be walked through by a person and not by a flag on a report. So
// the report prints the number a derivation would use and stops. `docs/artist/NEEDS.md` is where
// the decision goes if it is ever taken.
//
// ## Why the corpus band and not the element's own works
//
// The only reference band with enough sheets behind it is the corpus-wide one (183 of 19,791 —
// 0.92%). It is NOT a band for this element's tradition and is never labelled as one. What it can
// support is a weaker and still useful statement: given a bound written by hand, what share of real
// museum sheets would satisfy it. A rule that 99% of all sheets already pass is not constraining
// the artist toward anything, whatever its prose says; one that 0% pass is asking for something
// this corpus has no example of. Both of those are worth knowing and neither is a claim about the
// lineage.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { checkConstraint } from '../aesthetic/kinds.js';
import { elementConstraints } from '../aesthetic/elements/types.js';
import type { LineageElement } from '../aesthetic/elements/types.js';
import { PACK_DIR, checkElementShape } from '../aesthetic/elements/pack.js';
import type { Constraint, RenderMetrics } from '../aesthetic/types.js';
import type { ElementGroup } from './element-band.js';
import { MIN_MEASURED, axisShare, bandOf, type Band, type SurfaceCensus, type Surface } from './surface.js';

export const CENSUS_FILE = path.join(ROOT, 'corpus', 'surface.census.json');

/**
 * The four that cleared the permutation test in `corpus element-band`, and only those.
 *
 * `grain.anisotropy`, `tone.mean`, `weight.offset` and `weight.spread` are deliberately absent: they
 * were measured on the same works at the same time and did not separate the traditions. Including
 * them "for completeness" would put four columns of noise beside four of signal in a table whose
 * whole purpose is to say which is which — the same mistake the pairs report avoids when it ranks
 * on the layers that cleared its sign test and nothing else.
 */
export const SEPARATING_FIELDS: { label: string; of: (s: Surface) => number }[] = [
  { label: 'grain.axisShare', of: (s) => axisShare(s.grain) },
  { label: 'tone.sd', of: (s) => s.tone.sd },
  { label: 'palette.distinct', of: (s) => s.palette.distinct },
  { label: 'energy.gradient', of: (s) => s.energy.gradient },
];

/** The five kinds that read a `RenderMetrics`. Verified against `aesthetic/kinds.ts`. */
export const RENDER_KINDS = [
  'inkDensityRange',
  'coverageRange',
  'symmetryMax',
  'inkOffsetRange',
  'edgeContactRange',
] as const;

export function loadCensus(file = CENSUS_FILE): SurfaceCensus | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as SurfaceCensus;
}

export function censusMissingMessage(): string {
  return [
    `No census at ${path.relative(ROOT, CENSUS_FILE)}.`,
    'It is the corpus-wide sheet band this report scores hand-written bounds against, and it takes',
    'about 25 minutes to build because it decodes every image on disk:',
    '',
    '  npm run corpus -- surface --all --save',
    '',
    'A `--sample` run will be refused: a stride band is not the corpus band.',
  ].join('\n');
}

export function loadPack(): LineageElement[] {
  if (!existsSync(PACK_DIR)) return [];
  return readdirSync(PACK_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'conflicts.json')
    .sort()
    .map((f) => checkElementShape(JSON.parse(readFileSync(path.join(PACK_DIR, f), 'utf8'))));
}

export interface ConstraintGap {
  elementId: string;
  constraint: Constraint;
  part: string;
  /** Sheets among this element's own retrieved works. The band a derivation would need. */
  ownSheets: number;
  /** Sheets in the corpus census that satisfy this constraint, and how many were tried. */
  satisfied: number;
  ofSheets: number;
}

/**
 * A render constraint against one museum sheet, using the aesthetic layer's own checker.
 *
 * Reusing `checkConstraint` rather than re-reading the params here is the point: a bound is scored
 * against a real sheet by exactly the code that scores it against a rendered plate, including the
 * defaults `edgeContactRange` applies when `sides` and `minSides` are absent. A second
 * implementation would eventually disagree with the first, and the disagreement would be reported
 * as a fact about museum photography.
 *
 * The tree is `{}` because render-scope checkers never read one. `pixelHash` is restored with a
 * placeholder for the same reason — no render checker reads it either, and the census does not
 * store it.
 */
function satisfies(constraint: Constraint, metrics: Omit<RenderMetrics, 'pixelHash'>): boolean {
  const v = checkConstraint(constraint, {}, { ...metrics, pixelHash: '' });
  return v.status === 'satisfied';
}

export function constraintGaps(pack: LineageElement[], groups: ElementGroup[], census: SurfaceCensus): ConstraintGap[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const sheets = census.subjects.sheet;
  const out: ConstraintGap[] = [];
  for (const e of pack) {
    for (const { constraint, part } of elementConstraints(e)) {
      if (constraint.scope !== 'render') continue;
      out.push({
        elementId: e.id,
        constraint,
        part,
        ownSheets: byId.get(e.id)?.sheets ?? 0,
        satisfied: sheets.filter((m) => satisfies(constraint, m)).length,
        ofSheets: sheets.length,
      });
    }
  }
  return out;
}

export interface FieldGap {
  label: string;
  /** Per element, in `groups` order. Every work answers a ground-free field, so n is the group size. */
  bands: Band[];
  corpus: Band | null;
}

export function fieldGaps(groups: ElementGroup[], census: SurfaceCensus): FieldGap[] {
  return SEPARATING_FIELDS.map((f) => ({
    label: f.label,
    bands: groups.map((g) => bandOf(g.surfaces.map(f.of))),
    corpus: census.open[f.label] ?? null,
  }));
}

export interface PackGap {
  constraints: ConstraintGap[];
  fields: FieldGap[];
  groups: ElementGroup[];
  /** Pack elements with no resolved set, and resolved sets with no pack element. */
  unpaired: { packOnly: string[]; resolvedOnly: string[] };
  census: SurfaceCensus;
}

export function packGap(pack: LineageElement[], groups: ElementGroup[], census: SurfaceCensus): PackGap {
  const packIds = new Set(pack.map((e) => e.id));
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    constraints: constraintGaps(pack, groups, census),
    // Only elements that have both a pack file and a resolved set can appear in the field table:
    // the bands are over the retrieved works, so a pack element with no set has no works to band.
    fields: fieldGaps(groups.filter((g) => packIds.has(g.id)), census),
    groups: groups.filter((g) => packIds.has(g.id)),
    unpaired: {
      packOnly: [...packIds].filter((id) => !groupIds.has(id)).sort(),
      resolvedOnly: [...groupIds].filter((id) => !packIds.has(id)).sort(),
    },
    census,
  };
}

// --- text ---------------------------------------------------------------------------------------

const n4 = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : '   -  ');

/** The metric fields the five render kinds actually read. One row each, in kind order. */
const REFERENCE_FIELDS: [string, (m: Omit<RenderMetrics, 'pixelHash'>) => number][] = [
  ['inkDensity', (m) => m.inkDensity],
  ['coverage', (m) => m.coverage],
  ['symmetry.vertical', (m) => m.symmetry.vertical],
  ['symmetry.horizontal', (m) => m.symmetry.horizontal],
  ['inkOffset', (m) => m.inkOffset],
  ['edgeContact.top', (m) => m.edgeContact.top],
];

/** `{min: 0.35}` as `>= 0.3500`, which is how the checker actually reads it. */
function boundLabel(c: Constraint): string {
  const p = c.params;
  const parts: string[] = [];
  if (typeof p['min'] === 'number') parts.push(`>= ${(p['min'] as number).toFixed(4)}`);
  if (typeof p['max'] === 'number') parts.push(`<= ${(p['max'] as number).toFixed(4)}`);
  if (typeof p['axis'] === 'string') parts.unshift(`${p['axis']} `);
  if (Array.isArray(p['sides'])) parts.unshift(`${(p['sides'] as string[]).join('/')} `);
  return parts.join(' ') || JSON.stringify(p);
}

export function packGapText(g: PackGap): string {
  const out: string[] = [];
  const sheets = g.census.subjects.sheet.length;

  out.push(
    'WHAT THE PACK CLAIMS, AND WHAT ITS WORKS CAN ANSWER',
    '',
    `  Census: ${g.census.imagesRead} images read, ${g.census.measured} on a confident ground,`,
    `  ${sheets} of those sheets. Generated ${g.census.generated.slice(0, 10)}.`,
    ''
  );

  if (g.unpaired.packOnly.length > 0) {
    out.push(`  Pack elements with no resolved set, so no works to check against: ${g.unpaired.packOnly.join(', ')}`, '');
  }
  if (g.unpaired.resolvedOnly.length > 0) {
    out.push(
      `  Resolved sets with no pack element, so nothing claimed to check: ${g.unpaired.resolvedOnly.join(', ')}`,
      ''
    );
  }

  // --- half one: the claims ---------------------------------------------------------------------

  out.push(
    'ONE. THE NUMERIC RULES, AGAINST THE WORKS THEY NAME',
    '',
    `  \`own\` is sheets among this element's own retrieved works — the only band a derived bound`,
    `  could come from. Under ${MIN_MEASURED} there is no band and the cell reads UNMEASURABLE.`,
    '',
    `  \`sheets pass\` is the share of the corpus's ${sheets} real sheets that satisfy the rule as`,
    '  written, scored by the same checker that scores a rendered plate. It is a fact about museum',
    '  sheets in general and NOT about this lineage. Read it as: how much does this rule ask for.',
    ''
  );

  if (g.constraints.length === 0) {
    out.push('  No render-scope constraints in the pack at all.', '');
  } else {
    out.push(
      `  ${'element'.padEnd(22)} ${'rule'.padEnd(16)} ${'kind'.padEnd(18)} ${'bound'.padEnd(22)} ` +
        `${'own sheets'.padEnd(12)} sheets pass`
    );
    for (const c of g.constraints) {
      // Spelled out rather than abbreviated. An `UNM` in a column of numbers is a thing a reader
      // decodes from a legend, and the legend is what gets skipped.
      const own = c.ownSheets >= MIN_MEASURED ? String(c.ownSheets).padStart(10) : 'UNMEASURABLE';
      const share = c.ofSheets > 0 ? `${((100 * c.satisfied) / c.ofSheets).toFixed(1).padStart(5)}%` : '    -';
      out.push(
        `  ${c.elementId.padEnd(22)} ${c.constraint.id.padEnd(16)} ${c.constraint.kind.padEnd(18)} ` +
          `${boundLabel(c.constraint).padEnd(22)} ${own.padEnd(12)} ${share}  (${c.satisfied}/${c.ofSheets})`
      );
    }
    out.push('');

    const derivable = g.constraints.filter((c) => c.ownSheets >= MIN_MEASURED).length;
    if (derivable === 0) {
      out.push(
        `  NOT ONE of ${g.constraints.length} numeric rules has ${MIN_MEASURED} sheets behind it. Every bound in this table was`,
        '  written by hand and its own named works can neither confirm nor refute it. That is not a',
        '  reason to delete them — it is a reason not to call them derived.',
        ''
      );
    }

    // The band the pass rates are against, printed rather than referred to.
    //
    // Without it "0.0% of real sheets" reads as "this rule is wrong", and the honest reading is
    // narrower: the sheet band is itself SELECTED — an image is only a sheet here if its border is
    // one flat colour, which is a condition a densely worked print meets and a mostly-empty one
    // does not, in a photograph that includes the mount. So the band skews dense by construction
    // and a rule asking for emptiness will read as impossible whether or not it is.
    out.push(
      `  The band those shares are against — the corpus's ${sheets} sheets, which is what a rule is being`,
      '  scored on. It skews dense: a work only reads as a sheet when its border is one flat colour.',
      '',
      `    ${'field'.padEnd(22)}   p10      med      p90`
    );
    for (const [label, of] of REFERENCE_FIELDS) {
      const b = bandOf(g.census.subjects.sheet.map(of));
      out.push(`    ${label.padEnd(22)} ${n4(b.p10)}  ${n4(b.med)}  ${n4(b.p90)}`);
    }
    out.push('');

    const trivial = g.constraints.filter((c) => c.ofSheets > 0 && c.satisfied / c.ofSheets >= 0.95);
    const impossible = g.constraints.filter((c) => c.ofSheets > 0 && c.satisfied / c.ofSheets <= 0.05);
    for (const c of trivial) {
      out.push(
        `  \`${c.elementId}/${c.constraint.id}\` is satisfied by ${((100 * c.satisfied) / c.ofSheets).toFixed(1)}% of real sheets.`,
        '  Whatever its prose says, as a bound it is close to no bound at all.'
      );
    }
    for (const c of impossible) {
      out.push(
        `  \`${c.elementId}/${c.constraint.id}\` is satisfied by ${((100 * c.satisfied) / c.ofSheets).toFixed(1)}% of real sheets.`,
        '  The corpus has almost no example of what it asks for. That may be exactly the point — a',
        '  lineage can ask for something rare — but it is not a bound anything here can vouch for.'
      );
    }
    if (trivial.length > 0 || impossible.length > 0) out.push('');
  }

  // --- half two: what is measurable and unclaimed -------------------------------------------------

  out.push(
    'TWO. THE FIELDS THAT DO SEPARATE THE TRADITIONS, AND WHICH RULE READS THEM',
    '',
    '  These four cleared the permutation test in `corpus element-band`. Every image answers them,',
    '  ground or no ground, so n is the whole retrieved set rather than a handful of sheets.',
    '  NO CONSTRAINT KIND READS ANY OF THEM. `aesthetic/kinds.ts` has five render kinds and all five',
    '  need a ground.',
    ''
  );

  if (g.groups.length === 0) {
    out.push('  No element has both a pack file and a resolved set, so there is nothing to band.', '');
  } else {
    for (const f of g.fields) {
      out.push(`  ${f.label}`, `    ${'element'.padEnd(22)}    n   p10      med      p90`);
      const rows = g.groups
        .map((grp, i) => ({ id: grp.id, b: f.bands[i]! }))
        .sort((a, b) => b.b.med - a.b.med);
      for (const r of rows) {
        out.push(`    ${r.id.padEnd(22)} ${String(r.b.n).padStart(4)}   ${n4(r.b.p10)}  ${n4(r.b.med)}  ${n4(r.b.p90)}`);
      }
      if (f.corpus) {
        out.push(`    ${'(all 19,791 images)'.padEnd(22)} ${String(f.corpus.n).padStart(4)}   ${n4(f.corpus.p10)}  ${n4(f.corpus.med)}  ${n4(f.corpus.p90)}`);
      }
      if (f.label === 'grain.axisShare') {
        out.push(
          '    A directionless image reads 0.3333 and the corpus p10 is above it, so every row here is',
          '    above chance for a reason that belongs to the photograph — the sheet edge, the backdrop',
          '    seam. READ THE ORDER BETWEEN ROWS. The level is not a fact about the art.'
        );
      }
      out.push('');
    }
    out.push(
      '  A kind reading any of these would be the first constraint in the pack that its own named',
      '  works could refute. It would also move `elementPackHash` and make every trajectory ever',
      '  collected a different experiment, so this report stops here and writes nothing.'
    );
  }

  return out.map((s) => `${s}\n`).join('');
}
