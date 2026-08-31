// studio.jsonl: the whole record, append-only, one JSON object per line.
//
// The brief's rule is that a trajectory with a missing log line is a failed trajectory. That is only
// enforceable if a missing line is *detectable*, so every line carries `prev`, the hash of the line
// before it, and `hash`, the hash of itself. Deleting or editing any line breaks the chain at that
// point and `verifyChain` says exactly where. Without this, "complete log" is a hope.
//
// Everything needed to replay a trajectory without a model is here: every policy call is logged with
// its full observation, its schema, its raw response, its failures and its retries; every env call
// with its cache key and whether it hit. `replay` reads this file and nothing else.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, contentHash } from '../env/profile.js';

export type LineKind =
  | 'trajectory-start'
  | 'phase'
  | 'policy-call'
  | 'env-call'
  | 'render'
  | 'edit-refused'
  | 'step'
  | 'replan'
  | 'trigger'
  | 'note'
  | 'trajectory-end';

export interface LogLine {
  seq: number;
  /** Wall clock, ISO. Never read back for logic — replay must not depend on timing. */
  t: string;
  kind: LineKind;
  data: unknown;
  /** Hash of the previous line, or the empty string for the first. */
  prev: string;
  /** Hash of this line with `hash` itself omitted. */
  hash: string;
}

function lineHash(line: Omit<LogLine, 'hash'>): string {
  return contentHash(canonicalJson(line));
}

export class StudioLog {
  private seq = 0;
  private last = '';
  readonly file: string;

  constructor(dir: string, name = 'studio.jsonl') {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, name);
  }

  /**
   * Written with a synchronous append on purpose. An async write can be lost when a run dies, and a
   * log that is missing its last line before a crash is missing exactly the line that explains the
   * crash. Throughput is irrelevant here: a trajectory writes a few hundred lines and spends minutes
   * in a browser.
   */
  append(kind: LineKind, data: unknown): LogLine {
    const partial = { seq: this.seq++, t: new Date().toISOString(), kind, data, prev: this.last };
    const line: LogLine = { ...partial, hash: lineHash(partial) };
    this.last = line.hash;
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    return line;
  }
}

export function readLog(file: string): LogLine[] {
  if (!existsSync(file)) throw new Error(`no studio log at ${file}`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogLine);
}

export interface ChainProblem {
  seq: number;
  problem: string;
}

/**
 * Confirms the log is whole. Three ways it can fail, and each one names a different accident: a
 * broken `prev` means a line was removed or edited, a broken `hash` means a line was rewritten in
 * place, and a gap in `seq` means a write was lost.
 */
export function verifyChain(lines: LogLine[]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let expectedPrev = '';
  for (const [i, line] of lines.entries()) {
    const { hash, ...rest } = line;
    if (lineHash(rest) !== hash) problems.push({ seq: line.seq, problem: 'line does not match its own hash' });
    if (line.prev !== expectedPrev) problems.push({ seq: line.seq, problem: `prev is ${line.prev.slice(0, 12) || '(empty)'}, expected ${expectedPrev.slice(0, 12) || '(empty)'}` });
    if (line.seq !== i) problems.push({ seq: line.seq, problem: `out of order or missing: this is line ${i}` });
    expectedPrev = hash;
  }
  return problems;
}

export function linesOfKind<T = unknown>(lines: LogLine[], kind: LineKind): T[] {
  return lines.filter((l) => l.kind === kind).map((l) => l.data as T);
}
