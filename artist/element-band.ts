// Do a lineage element's numeric rules describe the works it names?
//
// An element carries `generativeRules` and `prohibitions` with real numbers in them —
// `inkDensityRange {min: 0.35}`, `symmetryMax {max: 0.7}` — and those numbers were written by hand.
// It also carries, in `aesthetic/influences/<id>.resolved.json`, forty-eight actual corpus works
// retrieved for it. Nothing has ever checked the first against the second.
//
// ## The obstacle, which is the finding
//
// All five render-scope constraint kinds read a `RenderMetrics`, and a `RenderMetrics` requires a
// confident ground — a border that is one colour, so ink can be told from sheet. Museums photograph
// 2D works with their mount or frame inside the border, so **only 0.92% of the corpus is a sheet
// with a measurable ground**. An element's rules are therefore stated in a language its own named
// works largely cannot answer, and this report's first job is to print how badly, per element, as a
// count rather than as a caveat.
//
// What every image can answer is the ground-free family: `tone`, `palette`, `weight` and `grain`.
// So the second job is to ask whether those separate the elements at all — whether the works
// retrieved for a Kuba textile differ measurably from those retrieved for a Constructivist poster.
// If they do not, then "the works this element names" is a set of pictures with no shared surface,
// and no measured range derived from it would mean anything.
//
// ## Why a permutation test and not seven bands read side by side
//
// Seven medians always have a spread. The question is whether *these* seven, grouped this way, are
// further apart than the same works would be if the group labels were shuffled — so the labels are
// shuffled, ten thousand times, and the observed spread is placed in that distribution. A field
// whose spread is ordinary under shuffling has measured nothing, however different its seven numbers
// look printed in a column.
//
// The seed is fixed and the shuffle is the repo's own xorshift, so the chance figure is a fact about
// the corpus and not about the day it was run.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { INFLUENCES_DIR, type Resolved } from './influences.js';
import { imagePath, type Work } from './manifest.js';
import { AXIS_SHARE_CHANCE, axisShare, surfaceOf, type Surface } from './surface.js';

/** Every ground-free family, and nothing that needs a ground. That distinction is the whole point. */
const FIELDS: { label: string; of: (s: Surface) => number }[] = [
  { label: 'grain.anisotropy', of: (s) => s.grain.anisotropy },
  { label: 'grain.axisShare', of: (s) => axisShare(s.grain) },
  { label: 'weight.offset', of: (s) => s.weight.offset },
  { label: 'weight.spread', of: (s) => s.weight.spread },
  { label: 'tone.mean', of: (s) => s.tone.mean },
  { label: 'tone.sd', of: (s) => s.tone.sd },
  { label: 'palette.distinct', of: (s) => s.palette.distinct },
  { label: 'energy.gradient', of: (s) => s.energy.gradient },
];

const TRIALS = 10000;
const SEED = 20260901;
/** Below this a chance figure is called a separation; at or above it the field measured nothing. */
const SEPARATES_BELOW = 0.05;

export interface ElementGroup {
  id: string;
  works: number;
  /** Works with a confident ground — the only ones any render constraint could ever be checked on. */
  withGround: number;
  /** Of those, the ones that are 2D. The band a rendered plate is actually commensurable with. */
  sheets: number;
  surfaces: Surface[];
}

export interface FieldSeparation {
  label: string;
  /** Largest group median minus smallest. */
  spread: number;
  /** Share of shuffles reaching that spread or more, with the observed run counted in. */
  chance: number;
  /** Group medians, in group order. */
  medians: number[];
}

export interface ElementBand {
  groups: ElementGroup[];
  /** Distinct images across all groups. Fewer than the sum when a work was retrieved for two. */
  distinctImages: number;
  /** Images retrieved for more than one element. Shared members make groups LOOK alike. */
  sharedImages: number;
  fields: FieldSeparation[];
  trials: number;
}

/** The repo's xorshift, seeded, so this report is reproducible rather than merely random. */
function shuffler(seed: number): () => number {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function loadResolvedGroups(byId: Map<string, Work>, isTwoD: (w: Work) => boolean | null): ElementGroup[] {
  if (!existsSync(INFLUENCES_DIR)) return [];
  const groups: ElementGroup[] = [];
  for (const f of readdirSync(INFLUENCES_DIR).filter((n) => n.endsWith('.resolved.json')).sort()) {
    const r = JSON.parse(readFileSync(path.join(INFLUENCES_DIR, f), 'utf8')) as Resolved;
    const surfaces: Surface[] = [];
    // Deduped within a group by sha256, matching `surfaces()`: a retrieval that returned a knife and
    // its fork would otherwise weight one photograph twice in this element's own band.
    const seen = new Set<string>();
    for (const w of r.works) {
      const work = byId.get(w.id);
      if (!work?.image || seen.has(work.image.sha256)) continue;
      const rel = imagePath(work);
      if (rel === null) continue;
      const file = path.join(ROOT, 'corpus', rel);
      if (!existsSync(file)) continue;
      seen.add(work.image.sha256);
      try {
        surfaces.push(surfaceOf(file, work, isTwoD(work)));
      } catch {
        // A truncated JPEG. Counted by its absence from `works` below rather than given a reason
        // column: this report is not a census of the corpus and `corpus surface` already is one.
      }
    }
    const withGround = surfaces.filter((s) => s.metrics !== null);
    groups.push({
      id: f.replace(/\.resolved\.json$/, ''),
      works: surfaces.length,
      withGround: withGround.length,
      sheets: withGround.filter((s) => s.subject === 'sheet').length,
      surfaces,
    });
  }
  return groups;
}

export function elementBand(groups: ElementGroup[], trials = TRIALS): ElementBand {
  const counts = new Map<string, number>();
  for (const g of groups) for (const s of g.surfaces) counts.set(s.sha256, (counts.get(s.sha256) ?? 0) + 1);

  const sizes = groups.map((g) => g.surfaces.length);
  const fields: FieldSeparation[] = [];
  for (const field of FIELDS) {
    const medians = groups.map((g) => median(g.surfaces.map(field.of)));
    const spread = Math.max(...medians) - Math.min(...medians);
    const pool = groups.flatMap((g) => g.surfaces.map(field.of));
    // One RNG per field, seeded the same, so a field's chance figure does not depend on how many
    // fields were computed before it or in what order.
    const rnd = shuffler(SEED);
    let atOrAbove = 0;
    for (let t = 0; t < trials; t++) {
      const shuf = [...pool];
      for (let i = shuf.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuf[i], shuf[j]] = [shuf[j]!, shuf[i]!];
      }
      let at = 0;
      const meds: number[] = [];
      for (const n of sizes) {
        meds.push(median(shuf.slice(at, at + n)));
        at += n;
      }
      if (Math.max(...meds) - Math.min(...meds) >= spread) atOrAbove++;
    }
    // The observed grouping counts as one of its own draws, so a chance figure is never 0/N. An
    // impossible-looking 0.0% is a statement about how many shuffles were run, not about the world.
    fields.push({ label: field.label, spread, chance: (atOrAbove + 1) / (trials + 1), medians });
  }

  return {
    groups,
    distinctImages: counts.size,
    sharedImages: [...counts.values()].filter((c) => c > 1).length,
    fields,
    trials,
  };
}

/** `MIN_MEASURED` in surface.ts. Restated as the floor a band must clear to be printed at all. */
const MIN_MEASURED = 6;

export function elementBandText(b: ElementBand): string {
  const out: string[] = [];
  const total = b.groups.reduce((s, g) => s + g.surfaces.length, 0);

  out.push(
    'CAN AN ELEMENT\'S RENDER RULES BE CHECKED AGAINST THE WORKS IT NAMES',
    '',
    '  All five render-scope constraint kinds read a RenderMetrics, which needs a confident ground.',
    `  A band under n=${MIN_MEASURED} is not printed anywhere else in this repo and is not a basis here either.`,
    '',
    `  ${'element'.padEnd(24)} works  ground  sheets`
  );
  for (const g of b.groups) {
    out.push(
      `  ${g.id.padEnd(24)} ${String(g.works).padStart(5)}  ${String(g.withGround).padStart(6)}  ${String(g.sheets).padStart(6)}` +
        `${g.sheets >= MIN_MEASURED ? '' : '   <- too few sheets to derive a range from'}`
    );
  }
  out.push('');

  const derivable = b.groups.filter((g) => g.sheets >= MIN_MEASURED).length;
  if (derivable === 0) {
    out.push(
      `  NOT ONE of ${b.groups.length} elements has ${MIN_MEASURED} sheets among its own works. Every inkDensityRange,`,
      '  coverageRange, symmetryMax, inkOffsetRange and edgeContactRange in the pack is therefore a',
      '  hand-written number that its own named works cannot confirm or refute. That is not a reason',
      '  to delete them — it is a reason not to call them derived.',
      ''
    );
  }

  out.push(
    'WHAT THE WORKS CAN ANSWER: DO THE ELEMENTS DIFFER AT ALL',
    '',
    `  ${total} works, ${b.distinctImages} distinct images, ${b.sharedImages} of them retrieved for more than one element.`,
    '  Shared members pull the groups TOGETHER, so they make a separation harder to find and a null',
    '  easier — the bias runs against the interesting answer, which is the safe direction.',
    '',
    `  Spread of the ${b.groups.length} medians, against ${b.trials.toLocaleString()} shuffles of the same works into the same group sizes.`,
    ''
  );
  for (const f of [...b.fields].sort((a, c) => a.chance - c.chance)) {
    const verdict = f.chance < SEPARATES_BELOW ? 'separates' : 'NOTHING MEASURED';
    out.push(
      `  ${f.label.padEnd(18)} spread ${f.spread.toFixed(4).padStart(9)}   chance ${(100 * f.chance).toFixed(1).padStart(5)}%   ${verdict}`
    );
  }
  out.push('');

  const separating = b.fields.filter((f) => f.chance < SEPARATES_BELOW);
  if (separating.length === 0) {
    out.push(
      '  No field separates the elements. The works retrieved for one tradition have no surface in',
      '  common that the works retrieved for another do not also have, so no range derived from them',
      '  would be a fact about the tradition.'
    );
  } else {
    for (const f of separating) {
      const ranked = b.groups.map((g, i) => ({ id: g.id, m: f.medians[i]! })).sort((a, c) => c.m - a.m);
      out.push(`  ${f.label}, highest first:`);
      for (const r of ranked) out.push(`    ${r.m.toFixed(4).padStart(9)}  ${r.id}`);
      if (f.label === 'grain.axisShare') {
        out.push(
          `    (a directionless image reads ${AXIS_SHARE_CHANCE.toFixed(4)}, so every element sits above chance —`,
          '     the reading is the ORDER, not the level, and the level is mostly the frame of the photograph.)'
        );
      }
      out.push('');
    }
    out.push(
      '  These are the only fields a corpus-derived range could honestly be built on, and they are',
      '  ground-free, so no constraint kind currently reads them. Adding one is a separate decision:',
      '  putting a derived number into a pack moves elementPackHash and makes every existing',
      '  trajectory a different experiment.'
    );
  }
  return out.map((s) => `${s}\n`).join('');
}
