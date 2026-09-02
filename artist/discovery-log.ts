// discovery.jsonl: the second record. Preference data, not a policy record.
//
// The brief asks for two records kept apart: the canonical trajectory, which is the hash-chained
// replayable thing `studio.jsonl` already is, and a discovery record holding what was proposed and
// cut — lenses with their reasons, sketches kept and rejected, pairwise choices, material sheets.
// The first is what an RL run would train on. The second is what a preference model would, and the
// brief is explicit that no preference model is to be built yet: the instruction is to build the
// record so the option exists later.
//
// ## Why this is a separate writer rather than `new StudioLog(dir, 'discovery.jsonl')`
//
// StudioLog would have worked and been three fewer lines. It is not used because a hash-chained
// discovery file is a discovery file that *looks* canonical: same fields, same `prev`/`hash`, same
// shape to every reader and every tool. The one property that must never be in doubt is which record
// a line belongs to, and a line with no chain fields cannot be mistaken for one that has them.
//
// It also keeps the promise honest in the direction that matters. Discovery is allowed to be
// nondeterministic, reordered, resumed and thrown away. A chain over it would either break — and a
// broken chain is a real alarm somewhere else in this repo — or tempt someone into making discovery
// deterministic to keep it whole, which the brief forbids in as many words.
//
// Nothing here is read by `replay`. Nothing here moves a hash.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type DiscoveryKind =
  /** A model call made during discovery, written whole by `callPolicy` exactly as studio.jsonl has it. */
  | 'policy-call'
  | 'query'
  | 'material-sheet'
  | 'lens-proposed'
  | 'lens-cut'
  | 'lens-kept'
  | 'sketch'
  | 'pairwise'
  | 'note';

export interface DiscoveryLine {
  seq: number;
  t: string;
  kind: DiscoveryKind;
  data: unknown;
}

export class DiscoveryLog {
  private seq = 0;
  readonly file: string;

  constructor(dir: string, name = 'discovery.jsonl') {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, name);
  }

  /** Synchronous for the same reason StudioLog is: a run that dies should keep its last line. */
  append(kind: DiscoveryKind, data: unknown): DiscoveryLine {
    const line: DiscoveryLine = { seq: this.seq++, t: new Date().toISOString(), kind, data };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    return line;
  }
}

export function readDiscovery(file: string): DiscoveryLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as DiscoveryLine);
}
