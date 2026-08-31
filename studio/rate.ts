// The rating loop: one keypress per plate, resumable, and usable without a keyboard.
//
// This is the terminal half of `artist/ratings.ts`. Everything that decides anything lives there and
// is tested there; this file shows a plate, waits for a key, and appends a line. It is separate
// because a raw-mode TTY loop cannot be unit-tested without becoming a test of node's readline, and
// mixing it into the module that holds the correlation gate would make that gate untestable too.
//
// Two ways in, on purpose:
//
//   the loop      `artist rate --runs out` — 1..5, `s` to skip, `q` to stop. Resumes where it left
//                 off, because a pool meant to be grown over weeks is a pool that gets interrupted.
//   one at a time `artist rate --set <plate> <tier>` — the same append, no TTY.
//
// The second is not a convenience. This repo's own notes record that the user's desktop build has no
// shell or PTY at all, so a rating tool that is only a keyboard loop is a rating tool that person
// cannot use, and the pool is the artifact everything else here is validated against.

import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import {
  POOL_FILE,
  TIERS,
  appendRating,
  plates,
  poolText,
  readPool,
  tierForKey,
  type Plate,
  type Tier,
} from '../artist/ratings.js';

export interface RateOptions {
  runs: string;
  pool: string;
  rater: string;
  /** Re-rate plates that already have a rating, instead of resuming past them. */
  again: boolean;
  /** Hand the plate to the desktop's image viewer. Off by default: it spawns a process. */
  open: boolean;
}

/** Plates still owed a rating: unrated, or rated against pixels that have since changed. */
export function pending(all: Plate[], pool: ReturnType<typeof readPool>, again: boolean): Plate[] {
  if (again) return all;
  const rated = new Map(pool.ratings.map((r) => [r.plate, r.pixelHash]));
  return all.filter((p) => rated.get(p.name) !== p.pixelHash);
}

/** Ratings whose plate has been re-rendered since. Reported, never quietly reused. */
export function stalePlates(all: Plate[], pool: ReturnType<typeof readPool>): string[] {
  const byName = new Map(all.map((p) => [p.name, p.pixelHash]));
  return pool.ratings.filter((r) => byName.has(r.plate) && byName.get(r.plate) !== r.pixelHash).map((r) => r.plate);
}

export function summary(o: Pick<RateOptions, 'runs' | 'pool'>): string {
  const all = plates(o.runs);
  const pool = readPool(o.pool);
  return poolText(
    pool,
    pending(all, pool, false).map((p) => p.name),
    stalePlates(all, pool)
  );
}

/** Append one rating without a terminal. Throws on an unknown plate rather than inventing one. */
export function setRating(plate: string, tier: Tier, o: Pick<RateOptions, 'runs' | 'pool' | 'rater'>): string {
  const found = plates(o.runs).find((p) => p.name === plate);
  if (!found) throw new Error(`no plate "${plate}" under ${o.runs} (a plate is a run directory with a final.png)`);
  appendRating({ plate, pixelHash: found.pixelHash, tier, rater: o.rater, at: new Date().toISOString() }, o.pool);
  return `${plate} -> ${tier}`;
}

const legend = TIERS.map((t) => `  ${t.key}  ${t.name.padEnd(8)} ${t.gloss}`).join('\n');

export async function rateInteractive(o: RateOptions): Promise<void> {
  const all = plates(o.runs);
  const pool = readPool(o.pool);
  const queue = pending(all, pool, o.again);

  console.log(summary(o));
  if (queue.length === 0) {
    console.log('\nnothing left to rate. `--again` to go back over them.');
    return;
  }
  if (!process.stdin.isTTY) {
    console.log(`\n${queue.length} plate(s) to rate, but this is not a terminal.`);
    console.log(`Use: artist rate --set <plate> <${TIERS.map((t) => t.name).join('|')}>`);
    console.log(`First up: ${queue[0]!.name}  ${queue[0]!.png}`);
    return;
  }

  console.log(`\n${queue.length} plate(s) to rate. ${o.pool}\n${legend}\n  s  skip   q  stop (everything so far is saved)\n`);

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    for (const [i, plate] of queue.entries()) {
      console.log(`\n[${i + 1}/${queue.length}] ${plate.name}\n  ${plate.png}`);
      if (o.open) spawn('open', [plate.png], { stdio: 'ignore', detached: true }).unref();
      const key = await nextKey();
      if (key === 'q' || key === '\u0003') {
        console.log('\nstopped. the pool is a file; pick it up whenever.');
        break;
      }
      const tier = tierForKey(key);
      if (!tier) {
        console.log('  skipped');
        continue;
      }
      appendRating(
        { plate: plate.name, pixelHash: plate.pixelHash, tier, rater: o.rater, at: new Date().toISOString() },
        o.pool
      );
      console.log(`  ${tier}`);
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  console.log(`\n${summary(o)}`);
}

function nextKey(): Promise<string> {
  return new Promise((resolve) => {
    const on = (str: string) => {
      process.stdin.off('data', on);
      resolve(String(str));
    };
    process.stdin.on('data', on);
  });
}

export const DEFAULT_POOL = POOL_FILE;
