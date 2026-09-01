// The human test: does the position steer the work, or is it decoration?
//
// Every other number in this repo is the environment marking its own homework. `twin` compares two
// arms on what they did; `realization` asks the tree whether the plan is in it. None of that answers
// the question the whole aesthetic layer stands on — whether a person who has never seen the code
// can tell one practice from another by looking at what it made.
//
// So: pairs of finals from the same brief and the same object under different positions, the two
// practice descriptions with every trace of which is which removed, and a sealed key. Show five
// people. If they cannot beat a coin, the positions are decoration and the paper says so.
//
// The two shuffles are independent, and that is the only subtle thing in this file. Shuffling the
// works and the practices together would leave A always matching practice 1, and a pack whose
// answer is "A1 B2" every time measures nothing but whether the reader noticed.
//
// Pure: this builds a plan and copies bytes. It calls no model and renders nothing.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadPosition, practiceOf, type Practice } from './field.js';

export interface PackRun {
  dir: string;
  positionId: string;
  briefId: string;
}

export interface PackWork {
  label: string;
  positionId: string;
  /** Absolute path to the final the run produced. */
  png: string;
}

export interface PackPractice {
  label: string;
  positionId: string;
  practice: Practice;
}

export interface PackPair {
  name: string;
  briefId: string;
  /** The two works, shuffled. */
  works: PackWork[];
  /** The two practices, shuffled again and separately. */
  practices: PackPractice[];
}

export interface Pack {
  seed: number;
  pairs: PackPair[];
  /** Runs that could not go in the pack, and why. Reported, never dropped silently. */
  skipped: { dir: string; why: string }[];
}

/**
 * xorshift32, so a pack is reproducible from its seed alone.
 *
 * A pack whose order came from `Math.random` cannot be regenerated, which matters because the
 * answer key and the folder have to agree and they are written by two different runs of this code
 * as soon as anyone regenerates one of them.
 */
function rng(seed: number): () => number {
  let s = seed | 0 || 0x2545f491;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 0x100000000) / 0x100000000;
  };
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Group the runs into comparable pairs.
 *
 * Same condition. Two works answering different situations are not comparable: a reader shown one
 * of each would be sorting by subject while believing they were sorting by practice, which is the
 * one way this test can quietly produce a positive result that means nothing.
 *
 * One run per position per group, the first by sorted directory. With k seeds per cell there are
 * several, and putting all of them in makes the same practice appear repeatedly in one pack, which
 * turns the test into a memory game.
 */
export function pairsOf(runs: PackRun[], seed: number): Pack {
  const next = rng(seed);
  const skipped: { dir: string; why: string }[] = [];
  const groups = new Map<string, Map<string, PackRun>>();
  for (const run of [...runs].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const png = path.join(run.dir, 'final.png');
    if (!existsSync(png)) {
      skipped.push({ dir: run.dir, why: 'no final.png: the run did not reach a finished piece' });
      continue;
    }
    const key = run.briefId;
    const group = groups.get(key) ?? new Map<string, PackRun>();
    if (group.has(run.positionId)) {
      skipped.push({ dir: run.dir, why: `another run of ${run.positionId} on ${key} is already in the pack` });
      continue;
    }
    group.set(run.positionId, run);
    groups.set(key, group);
  }

  const pairs: PackPair[] = [];
  for (const [key, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const members = [...group.values()];
    if (members.length < 2) {
      for (const m of members) skipped.push({ dir: m.dir, why: `nothing else ran ${key}, so there is no pair` });
      continue;
    }
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const two = [members[i]!, members[j]!];
        let practices: PackPractice[];
        try {
          practices = two.map((r) => ({
            label: '',
            positionId: r.positionId,
            practice: practiceOf(loadPosition(r.positionId)),
          }));
        } catch (e) {
          // A position that has left the catalog takes its pair with it. The finals are still on
          // disk, but a pack without the practice text is half a test.
          skipped.push({ dir: two[0]!.dir, why: e instanceof Error ? e.message : String(e) });
          continue;
        }
        pairs.push({
          name: `pair-${String(pairs.length + 1).padStart(2, '0')}`,
          briefId: two[0]!.briefId,
          works: shuffled(two, next).map((r, n) => ({
            label: ['A', 'B'][n]!,
            positionId: r.positionId,
            png: path.join(r.dir, 'final.png'),
          })),
          practices: shuffled(practices, next).map((p, n) => ({ ...p, label: ['1', '2'][n]! })),
        });
      }
    }
  }
  return { seed, pairs, skipped };
}

/** The practice as the reader sees it: no position id, no file name, no scores. */
export function practiceText(p: Practice): string {
  return [
    'WHERE THE VOCABULARY CAME FROM',
    p.origin,
    '',
    'WHAT THE WORK IS DOING',
    p.doing,
    '',
    'PERIOD',
    p.period,
    '',
    'HOW THIS ARTIST SPEAKS',
    p.register,
    '',
    'WHAT THIS ARTIST REFUSES',
    ...p.refusals.map((r) => `- ${r}`),
    '',
  ].join('\n');
}

const README = [
  '# Which work came from which practice?',
  '',
  'Each folder in `pairs/` holds two pictures, `A.png` and `B.png`, and two descriptions of how an',
  'artist works, `practice-1.txt` and `practice-2.txt`. The two pictures answer the same commission.',
  'One was made by the artist described in `practice-1.txt` and the other by the artist described in',
  '`practice-2.txt`.',
  '',
  'For each pair, write down which picture goes with which practice, and one sentence saying what',
  'made you say so. The sentence is the part worth having: an answer with no reason behind it is',
  'a coin flip that happened to land.',
  '',
  'Do not open `key/`. It holds the answers, base64-encoded so that a glance at the folder cannot',
  'spoil it. That is a seal against accident, not a lock — anyone who wants the answers can have',
  'them, which is fine, because the only person this test can be cheated on is the person running it.',
  '',
  'Two pictures per pair, and the practices are shuffled separately from the pictures, so "A goes',
  'with 1" is right about half the time by construction. Guessing scores 50%.',
  '',
].join('\n');

/** Write the pack. Returns the paths written, so a caller can say what it did. */
export function writePack(pack: Pack, outDir: string): string[] {
  mkdirSync(path.join(outDir, 'pairs'), { recursive: true });
  mkdirSync(path.join(outDir, 'key'), { recursive: true });
  const written: string[] = [];
  const put = (p: string, body: string) => {
    writeFileSync(p, body);
    written.push(p);
  };
  put(path.join(outDir, 'README.md'), README);

  for (const pair of pack.pairs) {
    const dir = path.join(outDir, 'pairs', pair.name);
    mkdirSync(dir, { recursive: true });
    for (const w of pair.works) {
      const to = path.join(dir, `${w.label}.png`);
      copyFileSync(w.png, to);
      written.push(to);
    }
    for (const p of pair.practices) {
      put(path.join(dir, `practice-${p.label}.txt`), practiceText(p.practice));
    }
    // The commission, so the reader knows what both artists were asked for. Not the position, and
    // not the id of anything: `briefId` is a slug that would name the answer half the time.
    put(path.join(dir, 'the-commission.txt'), 'Both works answer the same commission.\n');
  }

  const key = {
    seed: pack.seed,
    pairs: pack.pairs.map((p) => ({
      pair: p.name,
      briefId: p.briefId,
      works: Object.fromEntries(p.works.map((w) => [w.label, w.positionId])),
      practices: Object.fromEntries(p.practices.map((x) => [x.label, x.positionId])),
      answer: Object.fromEntries(
        p.works.map((w) => [w.label, p.practices.find((x) => x.positionId === w.positionId)!.label])
      ),
    })),
    skipped: pack.skipped,
  };
  put(path.join(outDir, 'key', 'SEALED-answers.b64'), Buffer.from(JSON.stringify(key, null, 2)).toString('base64') + '\n');
  return written;
}
