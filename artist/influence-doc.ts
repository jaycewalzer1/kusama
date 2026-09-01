// L5: what this artist has looked at, as a document the artist can read.
//
// Stages 2 and 3 turned a position into 48 real museum works and measured where they sit. Nothing
// carried them into a prompt, so the honest line in every report so far has been "no corpus image
// has ever reached an artist prompt". This file is the carrier.
//
// ## Why this is not in observation.ts
//
// observation.ts hashes its own bytes into `envVersion.observationHash`, so a single word added
// there declares every trajectory ever collected to be from a different environment. An optional
// layer that most runs do not use must not do that. So the block is built here, appended by the
// phases that use it, and identified by its own `influencesHash` which is present only when the
// layer is. A run without influences is byte-identical to the run before this file existed, and a
// test pins that.
//
// This is the same reasoning that put `artistLayers` in field.ts rather than beside `Layers`.
//
// ## Facts, not instructions
//
// The block states what is in the set and what the axes measured. It does not say "work in this
// manner", "take inspiration from these" or anything else in the imperative, and the one line that
// comes close is a prohibition: do not reproduce them. The distinction matters because the thing
// being tested is whether an artist that has *seen* a lineage makes different work — and a prompt
// that says "make it like these" answers that question by assuming it. What arrives is a shelf, not
// a brief.
//
// The axis labels are the strongest case. `calligraphy -> furniture; aic -> met` is a description of
// what a principal axis of this set actually separates, derived with no model. Handed over as a fact
// it is evidence about the set; rewritten as "move along the calligraphy/furniture axis" it would be
// aesthetic direction, which is exactly what `aestheticDirection` exists to keep out of L2.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { contentHash } from '../env/profile.js';
import { loadResolved, type Resolved, type ResolvedWork } from './influences.js';
import type { PolicyImage } from './policy/interface.js';

/**
 * How many works get a picture.
 *
 * Eight because that is roughly where a set stops being a shelf and starts being a slideshow: the
 * whole set is 48, and 48 thumbnails is 48 images of tokens per FIND call for a layer whose effect
 * has not been measured yet. The other 40 are still named in the catalogue, so nothing is hidden —
 * the artist is told the count and told which ones it can see.
 */
export const THUMBNAILS = 8;

export interface InfluenceDoc {
  id: string;
  resolved: Resolved;
  /**
   * The identity of what the artist is shown, which is the hash of the block text itself rather
   * than of the resolved file.
   *
   * Hashing the text covers three things at once with one number: the resolved set, the choice of
   * which works get a thumbnail (their sha256s are on their catalogue lines), and this file's
   * builder. That is deliberate, and it is what `observationHash` does for the rest of the prompt —
   * a change to the wording here is a change to the environment and must not be invisible.
   */
  hash: string;
}

const RULE = '-'.repeat(88);

/** One work, as a catalogue entry. Museum prose, which is what it is. */
function line(w: ResolvedWork, i: number, shown: boolean): string {
  const facts = [w.date, w.classification, w.medium].filter((s) => s && s.trim()).join(' · ');
  return [
    `  ${String(i + 1).padStart(2)}. ${shown ? '[shown]' : '       '} ${w.title}`,
    `      ${facts || 'no catalogue description'} — ${w.museum} ${w.id} · ${w.sha256.slice(0, 12)}`,
  ].join('\n');
}

/**
 * Which works actually get a picture: the heaviest `n` whose file is on this machine.
 *
 * The `existsSync` is the whole point of the function existing. `corpus/images/` is 3 GB and
 * untracked, so on a clone the manifest resolves and no pixel does, and a set that counted works
 * with an `imagePath` would write "the first 8 are attached as images" above a payload of none —
 * the artist told to look at something that is not there. The text and the payload are both built
 * from this list so they cannot say different numbers.
 *
 * The consequence is that the block's text, and so `InfluenceDoc.hash`, depends on which pixels this
 * machine has. That is correct rather than unfortunate: two runs that were shown different numbers
 * of pictures were shown different things, and the hash is the field that is supposed to say so.
 */
export function shownWorks(doc: InfluenceDoc, n = THUMBNAILS): ResolvedWork[] {
  const out: ResolvedWork[] = [];
  for (const w of doc.resolved.works) {
    if (out.length >= n) break;
    if (w.imagePath && existsSync(path.join(ROOT, 'corpus', w.imagePath))) out.push(w);
  }
  return out;
}

/**
 * The block, as the artist reads it.
 *
 * Ordered by weight, which is the order `resolve` already put them in, so the works carrying a
 * picture are the ones at the top of the list and the reader does not have to hunt for the
 * correspondence.
 */
export function influenceSection(doc: InfluenceDoc, thumbnails = THUMBNAILS): string {
  const r = doc.resolved;
  const attached = new Set(shownWorks(doc, thumbnails).map((w) => w.sha256));
  const shown = attached.size;
  const axes = r.axes.map(
    (a) => `  axis ${a.index} (${(100 * a.explained).toFixed(1)}% of the set's variance): ${a.label}`
  );
  const body = [
    `${r.works.length} works you have looked at. They are real objects in three museum collections and`,
    'you did not choose them: they were found by matching what you have written about your own',
    'practice against the pictures, which is why some of them will look wrong to you.',
    '',
    'These are not a brief, not a target, and not a style to work in. They are what is on the shelf.',
    'The one thing that is forbidden is reproducing one of them.',
    '',
    shown > 0
      ? `THE SET (${r.works.length} works; ${shown} of them are attached to this message as images, marked [shown])`
      : `THE SET (${r.works.length} works, as catalogue entries. No pictures are attached to this message.)`,
    r.works.map((w, i) => line(w, i, attached.has(w.sha256))).join('\n'),
    '',
    'WHAT THE SET SEPARATES ON. These are principal axes of the set measured from the pictures, with',
    'labels made only from what the catalogue columns differ on between the two ends. They are a',
    'description of this shelf, not a direction to move in.',
    axes.length > 0 ? axes.join('\n') : '  (no axis carried enough variance to label)',
    '',
    'WHAT THE SET IS NOT',
    `  Members resemble each other at mean cosine ${r.stats.intraMean.toFixed(4)}, and two works drawn at`,
    '  random from the whole corpus sit at 0.6428. A set at or below that number is a set that shares a',
    '  subject rather than a look.',
    `  ${(100 * r.stats.sameMuseum).toFixed(1)}% of pairs in it come from one museum, against ${(100 * r.stats.sameMuseumChance).toFixed(1)}% for a random draw.`,
    `  ${(100 * r.stats.dimensionality.twoDShare).toFixed(1)}% of it is flat work, against ${(100 * r.stats.dimensionality.corpusTwoDShare).toFixed(1)}% of the corpus.`,
  ].join('\n');
  return `${RULE}\nWHAT YOU HAVE LOOKED AT\n${RULE}\n${body.trim()}\n`;
}

/**
 * The block, appended to an observation some other module built.
 *
 * Appended rather than interleaved, and appended *here* rather than inside the serializer, because
 * the serializer's bytes are `observationHash`. A phase that wants the layer calls this on the string
 * `observation.ts` gave it; a phase that does not, or a run without the layer, gets the identical
 * string back and the identical bytes go to the provider.
 *
 * `thumbnails` must be the number of pictures the *caller* is going to attach, and 0 when it is
 * attaching none. It is not a display preference: the block's first line names the count and says
 * the pictures are attached to this message, so a phase that passes 8 and then attaches nothing
 * tells the artist to look at something that is not there. That is the same defect `framesOf`
 * throws on in act.ts, and it is why the count is a parameter rather than a constant.
 */
export function withInfluences(observation: string, doc: InfluenceDoc | null, thumbnails = THUMBNAILS): string {
  return doc ? `${observation}\n${RULE}\n${influenceSection(doc, thumbnails)}` : observation;
}

/**
 * The pictures for exactly the works the block marked `[shown]`.
 *
 * JPEG, because that is what the museums serve and re-encoding to PNG to satisfy a type would make
 * the bytes this run saw differ from the bytes on disk for no reason.
 */
export function influenceImages(doc: InfluenceDoc, n = THUMBNAILS): PolicyImage[] {
  return shownWorks(doc, n).map((w) => ({
    mediaType: 'image/jpeg' as const,
    base64: readFileSync(path.join(ROOT, 'corpus', w.imagePath!)).toString('base64'),
  }));
}

/**
 * A resolved set by position id, or by path if given one.
 *
 * Missing is an error rather than an empty document. An artist told it has looked at nothing is a
 * different experiment from an artist not told anything, and silently becoming the second when the
 * file is absent would make a typo in `--influences` indistinguishable from the layer being off.
 */
export function loadInfluenceDoc(idOrPath: string): InfluenceDoc {
  const id = idOrPath.endsWith('.json') ? path.basename(idOrPath).replace(/\.resolved\.json$/, '') : idOrPath;
  const resolved = idOrPath.endsWith('.json')
    ? (JSON.parse(readFileSync(idOrPath, 'utf8')) as Resolved)
    : loadResolved(idOrPath);
  if (!resolved) {
    throw new Error(
      `no resolved influence set for "${idOrPath}"; run \`corpus influences resolve ${idOrPath}\` first`
    );
  }
  if (resolved.works.length === 0) {
    throw new Error(`influence set "${id}" resolved to zero works; it cannot be shown to anyone`);
  }
  const doc: InfluenceDoc = { id, resolved, hash: '' };
  return { ...doc, hash: contentHash(influenceSection(doc)) };
}
