// The run as one document you can take away.
//
// The page folds the log into acts and beats and fetches a whole line only when you click into one.
// That is the right shape for a screen and the wrong shape for everything else — quoting a run,
// putting two of them side by side, reading one after the server has gone. This is the same fold
// with nothing stripped: under every beat, the observation the artist was shown, the answer it
// generated, and what that answer changed in the program.
//
// A fold and only a fold, like story.ts: pure over the log lines, reading no files and computing
// nothing the run did not write down, so the document you download and the page you downloaded it
// from cannot disagree.

import { storyOf, summarise, type Entry } from './story.js';
import type { LogLine } from './studio-log.js';

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const n = (v: unknown, dflt = 0) => (typeof v === 'number' ? v : dflt);
const data = (line: LogLine) => (line.data ?? {}) as Record<string, unknown>;
const block = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');

/**
 * A refused edit's reason, shortened.
 *
 * The one thing in the log that is cut. The checker answers a bad edit with every schema error it
 * found, which runs to thousands of characters, and a single step can be refused a hundred times —
 * kept whole it would be most of the file and none of the meaning. The beat above every one of
 * these already carries the families and their counts, which is the readable form of the same fact.
 */
const why = (reason: string) => {
  const first = s(reason).split('\n')[0] ?? '';
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
};

/** What one log line contributes, as paragraphs. Empty when the fold above it already said it. */
function lineSection(line: LogLine): string[] {
  const d = data(line);
  switch (line.kind) {
    case 'policy-call': {
      const name = s(d['name']);
      const out = [
        `**${name} — what it was shown** · line ${line.seq} · ${s(d['model'])}${d['hasImages'] ? ' · with the plate' : ''}`,
        block('text', s(d['observation']) || '(the observation was not logged)'),
      ];
      if (d['ok'] === false) {
        out.push(`**${name} — the call failed**`, block('text', s(d['error'])));
        return out;
      }
      out.push(`**${name} — what it generated**`, block('json', pretty(d['action'])));
      const failures = Array.isArray(d['failures']) ? (d['failures'] as unknown[]) : [];
      if (failures.length > 0) {
        out.push(`**${n(d['attempts'], 1)} attempts; the answers that did not validate**`, block('text', failures.map(s).join('\n')));
      }
      return out;
    }

    case 'step': {
      const edits = (Array.isArray(d['edits']) ? d['edits'] : []) as { actionId?: string; kind?: string; targets?: unknown }[];
      const applied = new Set((Array.isArray(d['applied']) ? d['applied'] : []).map(s));
      const refused = new Map((Array.isArray(d['refused']) ? d['refused'] : []).map((r) => [s((r as Record<string, unknown>)['actionId']), s((r as Record<string, unknown>)['reason'])]));
      // Absent is not zero. Logs written before the field existed would otherwise report a step that
      // repainted the sheet as having moved nothing.
      const moved = 'pixelsMoved' in d ? `${(n(d['pixelsMoved']) * 100).toFixed(2)}% of the sheet moved` : 'how much moved was not recorded';
      const out = [
        `**what changed** · line ${line.seq} · ${d['accepted'] ? 'kept' : 'reverted'} · ${applied.size} of ${edits.length} edit${edits.length === 1 ? '' : 's'} applied · ${moved}`,
      ];
      const rows = edits.map((e) => {
        const id = s(e.actionId);
        const where = Array.isArray(e.targets) ? e.targets.map(s).join(', ') : s(e.targets);
        const fate = applied.has(id) ? 'applied' : refused.has(id) ? `refused — ${why(refused.get(id)!)}` : 'not applied';
        return `- \`${s(e.kind)}\`${where ? ` on ${where}` : ''} (${id}) — ${fate}`;
      });
      const destroyed = (Array.isArray(d['destroyedNodeIds']) ? d['destroyedNodeIds'] : []).map(s);
      if (destroyed.length > 0) rows.push(`- it destroyed ${destroyed.join(', ')}`);
      if (d['revertedBecause']) rows.push(`- reverted because: ${s(d['revertedBecause'])}`);
      if (rows.length > 0) out.push(rows.join('\n'));
      return out;
    }

    case 'render':
      return [
        `**rendered** \`${s(d['programHash']).slice(0, 12)}\` · tree ${n(d['treeScore']).toFixed(3)} · render ${n(d['renderScore']).toFixed(3)} · ${n(d['hardViolations'])} hard · ${n(d['softViolations'])} soft`,
        ...(d['description'] ? [quote(s(d['description']))] : []),
      ];

    case 'edit-refused':
      return [`- edit \`${s(d['kind'])}\` refused: ${why(s(d['reason']))}`];

    // Said already, in the beat: the fold turns these into its notes and its titles.
    case 'phase':
    case 'trigger':
    case 'note':
    case 'trajectory-start':
    case 'trajectory-end':
      return [];

    default:
      return [`- ${line.kind}: ${block('json', pretty(d))}`];
  }
}

export function transcriptMarkdown(id: string, lines: LogLine[]): string {
  const entries: Entry[] = lines.map((l) => ({ seq: l.seq, t: l.t, kind: l.kind, summary: summarise(l.kind, l.data) }));
  const story = storyOf(entries);
  const bySeq = new Map(lines.map((l) => [l.seq, l]));
  // These two sit in no beat — the fold opens an act on them rather than a beat — so they are the
  // head and the foot of the document rather than something inside it.
  const start = lines.find((l) => l.kind === 'trajectory-start');
  const end = lines.find((l) => l.kind === 'trajectory-end');
  const t = story.totals;
  const head = start ? data(start) : {};

  const out: string[] = [
    `# ${s(head['positionId']) || '?'} x ${s(head['briefId']) || '?'}${head['control'] ? ' (control)' : ''}`,
    [
      `\`${id}\``,
      s(head['deliverableId']),
      `seed ${n(head['seed'])}`,
      `${t.steps} steps`,
      `${t.calls} calls`,
      `$${t.usd.toFixed(2)}`,
      t.ms ? `${Math.round(t.ms / 60000)} min` : '',
      `${lines.length} log lines`,
    ]
      .filter(Boolean)
      .join(' · '),
    'Folded as the studio folds it, with the material the studio leaves on the server: under each beat is the observation the artist was shown, the answer it generated, and what that changed in the program. Only the reasons for refused edits are cut, to their first line.',
  ];

  if (start) out.push('## how it was started', block('json', pretty(start.data)));

  for (const act of story.acts) {
    out.push(`## ${act.title}`, `*${act.summary}*`);
    for (const beat of act.beats) {
      out.push(`### ${beat.label} — ${beat.title}`);
      out.push(
        `*${[beat.usd ? `$${beat.usd.toFixed(3)}` : '', beat.ms > 1000 ? `${Math.round(beat.ms / 1000)}s` : '', `line${beat.seqs.length === 1 ? '' : 's'} ${beat.seqs.join(', ')}`]
          .filter(Boolean)
          .join(' · ')}*`
      );
      if (beat.said) out.push(quote(beat.said));
      if (beat.notes.length > 0) {
        out.push(beat.notes.map((note) => `- ${note.count > 1 ? `${note.count}x ` : ''}${note.text.split('\n')[0]}`).join('\n'));
      }
      for (const seq of beat.seqs) {
        const line = bySeq.get(seq);
        if (line) out.push(...lineSection(line));
      }
    }
  }

  if (end) out.push('## how it ended', block('json', pretty(end.data)));
  return `${out.join('\n\n')}\n`;
}
