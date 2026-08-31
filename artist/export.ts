// Trajectories out, as training data.
//
// One JSONL line per policy call: system, the observation as the user turn, and the action the artist
// actually emitted as the assistant turn. That is the whole format, and the reason it is this thin is
// that the loop was built so it could be. Every decision was already one call with one serialized
// observation and one schema-checked answer, so there is no session to flatten, no scratchpad to
// reconstruct and no tool-call interleaving to invent.
//
// What is deliberately NOT filtered here: failed calls, reverted steps and abandoned trajectories.
// Filtering to successes is a decision about the reward, and the reward is not this file's business.
// Every line carries the scores of the trajectory it came from so a consumer can filter, weight or
// pair as it likes, and can be told exactly what it excluded.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readLog } from './studio-log.js';
import type { Scores, Trajectory } from './types.js';

export type ExportFormat = 'sft' | 'jsonl';

interface CallLine {
  name: string;
  model: string;
  observation: string;
  system: string;
  observationHash: string;
  action?: unknown;
  attempts?: number;
  hasImages?: boolean;
  ok: boolean;
}

export interface SftLine {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  meta: {
    trajectoryId: string;
    positionId: string;
    briefId: string;
    call: string;
    /** Images are not inlined: a chat-format SFT file with base64 PNGs in it is unusable. */
    hadImages: boolean;
    observationHash: string;
    attempts: number;
    outcome: string;
    scores: Scores;
  };
}

/**
 * One trajectory directory to SFT lines. Calls whose answer never validated are dropped, because a
 * line whose assistant turn is absent is not a training example; the count of them is returned so
 * the drop is visible rather than silent.
 */
export function sftLines(dir: string): { lines: SftLine[]; dropped: number } {
  const trajectory = JSON.parse(readFileSync(path.join(dir, 'final.json'), 'utf8')) as Trajectory;
  const calls = readLog(path.join(dir, 'studio.jsonl'))
    .filter((l) => l.kind === 'policy-call')
    .map((l) => l.data as CallLine);

  const lines: SftLine[] = [];
  let dropped = 0;
  for (const call of calls) {
    if (!call.ok || call.action === undefined) {
      dropped++;
      continue;
    }
    lines.push({
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.observation },
        { role: 'assistant', content: JSON.stringify(call.action) },
      ],
      meta: {
        trajectoryId: trajectory.id,
        positionId: trajectory.positionId,
        briefId: trajectory.briefId,
        call: call.name,
        hadImages: Boolean(call.hasImages),
        observationHash: call.observationHash,
        attempts: call.attempts ?? 1,
        outcome: trajectory.outcome,
        scores: trajectory.scores,
      },
    });
  }
  return { lines, dropped };
}

export function toJsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}
