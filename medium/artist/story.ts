// studio.jsonl folded into something a person can read in one screen.
//
// A finished trajectory writes 100 to 280 log lines, and the worst of them is a five-thousand
// character wall of ajv errors from one refused edit. Shown as a flat list in arrival order that is
// unreadable, and unreadable in a specific way: the run's real shape is five acts and three to six
// steps, and the log buries that under two hundred lines that are all consequences of one decision.
//
// Every trace viewer solves this the same way and it is worth naming the parts, because the fold
// below is those parts and nothing else:
//   - a span tree, not a line list, collapsed to its top level (LangSmith, OTel, DevTools);
//   - a roll-up on every closed node, so a collapsed act still says what it cost (CI runners);
//   - repeats folded into a count with one example kept (every log aggregator ever written);
//   - failures pulled up through the collapse, so what went wrong is visible while shut;
//   - a score track across the run, indexed to the artifact, so you can scrub (chess analysis).
//
// The one thing that is specific to this loop: a MAKE beat is a *step*, not a call. The act call,
// the edits it got refused, the render, the step verdict and the trigger that fired afterwards are
// one event with one picture at the end of it, and they are only legible together.
//
// This is a fold and only a fold. It computes nothing the run did not write down, reads no files,
// and is a pure function of the lines, so the story a page shows while a run is going and the story
// read off the finished directory are the same story. `summarise` lives here too because a line's
// small form and the fold over small forms are one decision, not two.

/** One log line, small enough to poll: the observation, system prompt and schema are stripped. */
export interface Entry {
  seq: number;
  t: string;
  kind: string;
  summary: Record<string, unknown>;
}

export type Tone = 'plain' | 'good' | 'warn' | 'bad';

/** A repeat folded into a count, with one instance kept verbatim. */
export interface Note {
  text: string;
  count: number;
  tone: Tone;
}

export interface Beat {
  /** The log line the beat opens on. The page fetches the whole record by this. */
  seq: number;
  /** Every line folded into the beat, so "show the log for this" is exact. */
  seqs: number[];
  label: string;
  title: string;
  /** The artist's own words, when it produced any. */
  said: string;
  tone: Tone;
  usd: number;
  ms: number;
  /** How many edits the medium refused inside this beat, before they were folded into families. */
  refused: number;
  /** Program hash of the plate this beat ended on, if it rendered one. */
  plate: string | null;
  scores: { tree: number; render: number; hard: number; soft: number } | null;
  notes: Note[];
}

export interface Act {
  id: string;
  title: string;
  /** The one line that says what happened, readable with the act shut. */
  summary: string;
  tone: Tone;
  usd: number;
  ms: number;
  calls: number;
  beats: Beat[];
}

export interface TrackPoint {
  seq: number;
  plate: string;
  tree: number;
  render: number;
  hard: number;
  label: string;
}

export interface Story {
  acts: Act[];
  track: TrackPoint[];
  totals: { usd: number; ms: number; calls: number; refused: number; steps: number };
}

// --- one line, small ----------------------------------------------------------------------------

/** The reasoning a policy call produced, whatever the phase called it. */
export function said(action: Record<string, unknown> | undefined): string {
  if (!action) return '';
  for (const key of ['think', 'why', 'paragraph', 'approach']) {
    if (typeof action[key] === 'string') return action[key] as string;
  }
  const problems = action['problems'];
  if (Array.isArray(problems)) return problems.map((p: { text?: string }) => `- ${p.text ?? ''}`).join('\n');
  return '';
}

/**
 * One log line, small enough to poll.
 *
 * The observation, the system prompt and the schema are stripped: they are the bulk of the file and
 * the page fetches them per line when asked. Everything the artist *decided* stays. An unknown kind
 * keeps its data, so a line kind added later still reads.
 */
export function summarise(kind: string, raw: unknown): Record<string, unknown> {
  const d = (raw ?? {}) as Record<string, never>;
  switch (kind) {
    case 'trajectory-start':
      return { position: d['positionId'], brief: d['briefId'], control: d['control'], seed: d['seed'], maxSteps: d['maxSteps'] };
    case 'phase':
      return { phase: d['phase'], trigger: d['trigger'] ?? null, problemId: d['problemId'] ?? null, sketches: d['sketches'] ?? null };
    case 'policy-call':
      return {
        name: d['name'],
        model: d['model'],
        ok: d['ok'],
        attempts: d['attempts'] ?? null,
        usd: (d['usage'] as { usd?: number } | undefined)?.usd ?? null,
        error: d['error'] ?? null,
        text: said(d['action']),
        control: (d['action'] as { control?: string } | undefined)?.control ?? null,
        edits: ((d['action'] as { edits?: unknown[] } | undefined)?.edits ?? []).length,
      };
    case 'render':
      return {
        programHash: d['programHash'],
        pixelHash: d['pixelHash'],
        standing: d['standing'],
        tree: d['treeScore'],
        render: d['renderScore'],
        hard: d['hardViolations'],
        soft: d['softViolations'],
        description: d['description'],
      };
    case 'step':
      return {
        k: d['k'],
        control: d['control'],
        accepted: d['accepted'],
        applied: ((d['applied'] ?? []) as unknown[]).length,
        refused: ((d['refused'] ?? []) as unknown[]).length,
        reverted: d['revertedBecause'],
        risk: d['isRiskMove'],
        programHash: d['programHash'],
        text: d['think'],
      };
    case 'edit-refused':
      return { actionId: d['actionId'], kind: d['kind'], reason: d['reason'] };
    case 'trigger':
      return { trigger: d['trigger'], detail: d['detail'], cached: d['cached'] };
    case 'trajectory-end':
      return { outcome: d['outcome'], finalHash: d['finalHash'], scores: d['scores'], cost: d['cost'] };
    default:
      return d;
  }
}

// --- refusals -----------------------------------------------------------------------------------

/**
 * What a refusal is *about*, so 224 of them can be shown as six.
 *
 * The checker already names its own failures in trailing brackets — `[limit.textLength]`,
 * `[schema.program]` — and one refusal can carry a hundred of them, so the tags are the family when
 * there are any. When there are none the family is the sentence with its numbers and quoted names
 * removed, which turns eleven copies of `index N is past the end of "sheet"` into one row.
 */
export function refusalFamily(reason: string): string {
  const tags = [...new Set([...reason.matchAll(/\[([a-z][\w.-]*)\]/g)].map((m) => m[1]!))];
  if (tags.length) return tags.join(', ');
  return reason
    .replace(/"[^"]*"/g, '"..."')
    .replace(/\d+/g, 'N')
    .slice(0, 120);
}

function fold(reasons: string[], tone: Tone): Note[] {
  const groups = new Map<string, number>();
  for (const r of reasons) groups.set(refusalFamily(r), (groups.get(refusalFamily(r)) ?? 0) + 1);
  return [...groups]
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({ text, count, tone }));
}

// --- the fold -----------------------------------------------------------------------------------

const ACTS: Record<string, string> = {
  find: 'FIND — what is wrong with the obvious poster',
  sketch: 'SKETCH — what the fixes look like',
  choose: 'CHOOSE — one problem, one plan',
  make: 'MAKE — the piece',
  examine: 'EXAMINE — what it turned out to be',
};

/** A policy call that opens a beat rather than joining the one before it, and the tag it wears. */
const OPENS: Record<string, string> = { find: 'find', sketch: 'sketch', choose: 'choose', act: 'step', examine: 'examine' };

/** What the beat is called when the artist said nothing quotable. */
const GISTS: Record<string, string> = {
  find: 'what is wrong with it',
  sketch: 'a fix, drawn',
  choose: 'the problem it picked',
  act: 'an edit',
  examine: 'what it turned out to be',
};

/** The first sentence of what the artist said, short enough to sit on one row. */
function gist(said: string, fallback: string): string {
  const first = said.split('\n').find((l) => l.trim().replace(/^[-*]\s*/, '').length > 0);
  if (!first) return fallback;
  const line = first.trim().replace(/^[-*]\s*/, '');
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

const ms = (a: string, b: string) => Math.max(0, new Date(b).getTime() - new Date(a).getTime());

const n = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export function storyOf(entries: Entry[]): Story {
  const acts: Act[] = [];
  const track: TrackPoint[] = [];
  const totals = { usd: 0, ms: 0, calls: 0, refused: 0, steps: 0 };

  // Held in one object rather than two `let`s so that assigning from inside the helpers below is
  // visible to the reader in one place: the fold has exactly one cursor and it is this.
  const at: { act: Act | null; beat: Beat | null } = { act: null, beat: null };
  let refusals: string[] = [];
  let stepNo = 0;
  const last = entries.at(-1);

  const closeBeat = () => {
    if (at.beat && refusals.length) at.beat.notes.push(...fold(refusals, 'warn'));
    refusals = [];
    at.beat = null;
  };

  const openAct = (id: string, title: string): Act => {
    closeBeat();
    const a: Act = { id, title, summary: '', tone: 'plain', usd: 0, ms: 0, calls: 0, beats: [] };
    at.act = a;
    acts.push(a);
    return a;
  };

  const openBeat = (e: Entry, label: string, title: string): Beat => {
    closeBeat();
    const a = at.act ?? openAct('run', 'the run');
    const b: Beat = { seq: e.seq, seqs: [e.seq], label, title, said: '', tone: 'plain', usd: 0, ms: 0, refused: 0, plate: null, scores: null, notes: [] };
    at.beat = b;
    a.beats.push(b);
    return b;
  };

  /** Whatever beat is open, or an implicit one — the log may say things between beats. */
  const into = (e: Entry, label = 'before', title = ''): Beat => {
    if (!at.beat) return openBeat(e, label, title);
    at.beat.seqs.push(e.seq);
    return at.beat;
  };

  for (const e of entries) {
    const d = e.summary;
    switch (e.kind) {
      case 'trajectory-start':
        openAct('start', `${s(d['position'])} x ${s(d['brief'])}${d['control'] ? ' (control)' : ''}`).summary =
          `seed ${n(d['seed'])} · up to ${n(d['maxSteps'])} steps`;
        break;

      case 'phase': {
        const phase = s(d['phase']);
        // The environment resets — and renders the seed program — before the driver announces MAKE,
        // so `reset` is what actually opens the act. Otherwise the blank sheet and its six hard
        // violations are filed under CHOOSE, where nobody made them.
        if (phase === 'reset') {
          openAct('make', ACTS['make']!);
          stepNo = 0;
          openBeat(e, 'start', 'the sheet it started from');
        } else if (phase in ACTS) {
          if (at.act?.id !== phase) openAct(phase, ACTS[phase]!);
          else into(e, phase, phase);
          if (at.act?.id !== 'make') stepNo = 0;
        } else into(e, phase, phase === 'replan' ? `replan · ${s(d['trigger'])}` : phase);
        break;
      }

      case 'policy-call': {
        const name = s(d['name']);
        totals.calls++;
        const usd = n(d['usd']);
        let b: Beat;
        if (name in OPENS) {
          b = openBeat(e, name === 'act' ? `step ${++stepNo}` : OPENS[name]!, GISTS[name] ?? name);
          b.said = s(d['text']);
          // The row says what this one is about; a column of eighteen rows reading "sketch" is the
          // flat log again, one indent in.
          b.title = gist(b.said, b.title);
        } else {
          b = into(e, name, name);
          // A replan belongs to the step that provoked it, and its words are what changed.
          if (name === 'replan' && s(d['text'])) b.notes.push({ text: `replanned: ${s(d['text'])}`, count: 1, tone: 'warn' });
        }
        if (d['ok'] === false) {
          b.tone = 'bad';
          b.title = `${name} FAILED`;
          b.notes.push({ text: s(d['error']), count: 1, tone: 'bad' });
        }
        b.usd += usd;
        totals.usd += usd;
        const a = at.act!;
        a.calls++;
        a.usd += usd;
        if (n(d['attempts']) > 1) b.notes.push({ text: `${n(d['attempts'])} attempts to answer in schema`, count: 1, tone: 'warn' });
        break;
      }

      case 'edit-refused': {
        into(e, 'refused', 'edits refused').refused++;
        refusals.push(s(d['reason']));
        totals.refused++;
        break;
      }

      case 'render': {
        const b = into(e, 'render', 'rendered');
        const hash = s(d['programHash']);
        b.plate = hash;
        b.scores = { tree: n(d['tree']), render: n(d['render']), hard: n(d['hard']), soft: n(d['soft']) };
        if (track.at(-1)?.plate !== hash) {
          track.push({ seq: e.seq, plate: hash, tree: b.scores.tree, render: b.scores.render, hard: b.scores.hard, label: b.label.startsWith('step') ? b.label : `${at.act?.id ?? ''} ${b.label}` });
        }
        break;
      }

      case 'step': {
        const b = into(e, 'step', `step ${n(d['k'])}`);
        totals.steps++;
        const applied = n(d['applied']);
        const control = s(d['control']);
        b.said ||= s(d['text']);
        // The tag column already says which step this is, so the verdict leads and the artist's own
        // line for the step follows it.
        const verdict = `${d['accepted'] ? 'kept' : 'reverted'} · ${applied} edit${applied === 1 ? '' : 's'}${d['risk'] ? ' · risk' : ''}${control && control !== 'continue' ? ` · ${control}` : ''}`;
        b.title = `${verdict} — ${gist(b.said, GISTS['act']!)}`;
        b.tone = d['accepted'] ? 'good' : 'bad';
        if (d['reverted']) b.notes.push({ text: `reverted: ${s(d['reverted'])}`, count: 1, tone: 'bad' });
        break;
      }

      case 'trigger': {
        const b = into(e, 'trigger', s(d['trigger']));
        b.notes.push({ text: `${s(d['trigger'])}: ${s(d['detail'])}`, count: 1, tone: 'warn' });
        if (b.tone === 'plain') b.tone = 'warn';
        break;
      }

      case 'note': {
        const b = into(e, 'note', 'note');
        const text = Object.entries(d)
          .filter(([k]) => k !== 'phase')
          .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join(' · ');
        if (text) b.notes.push({ text, count: 1, tone: 'plain' });
        break;
      }

      case 'trajectory-end': {
        const sc = (d['scores'] ?? {}) as Record<string, unknown>;
        const cost = (d['cost'] ?? {}) as Record<string, unknown>;
        const a = openAct('end', `${s(d['outcome']).toUpperCase()}`);
        a.summary = `tree ${n(sc['tree']).toFixed(3)} · render ${n(sc['render']).toFixed(3)} · ${n(sc['hardViolations'])} hard · $${n(cost['usd']).toFixed(2)} · ${Math.round(n(cost['wallMs']) / 60000)} min · ${n(cost['policyCalls'])} calls`;
        a.tone = n(sc['hardViolations']) > 0 || s(d['outcome']) !== 'finished' ? 'bad' : 'good';
        break;
      }

      default:
        into(e, e.kind, e.kind);
    }
  }
  closeBeat();

  // Wall clock is only knowable from the line that follows, so it is filled in afterwards, and
  // across the whole run rather than per act: a beat's time runs until the next beat starts, and the
  // next beat is often in the next act.
  const stamp = new Map(entries.map((e) => [e.seq, e.t]));
  const inOrder = acts.flatMap((a) => a.beats.map((b) => ({ a, b })));
  for (const [i, { a, b }] of inOrder.entries()) {
    const next = inOrder[i + 1]?.b.seq ?? Math.max(...b.seqs);
    b.ms = ms(stamp.get(b.seq)!, stamp.get(next)!);
    a.ms += b.ms;
  }
  if (entries.length > 1) totals.ms = ms(entries[0]!.t, last!.t);

  for (const a of acts) if (!a.summary) a.summary = summaryOf(a);
  for (const a of acts) if (a.tone === 'plain') a.tone = a.beats.some((b) => b.tone === 'bad') ? 'bad' : a.beats.some((b) => b.tone === 'warn') ? 'warn' : 'plain';

  return { acts, track, totals };
}

/** What an act says with itself shut: how many beats, what they cost, and what went wrong. */
function summaryOf(a: Act): string {
  const refused = a.beats.reduce((t, b) => t + b.refused, 0);
  const bad = a.beats.filter((b) => b.tone === 'bad').length;
  const scored = a.beats.filter((b) => b.scores).at(-1)?.scores;
  return [
    `${a.beats.length} beat${a.beats.length === 1 ? '' : 's'}`,
    a.calls ? `${a.calls} call${a.calls === 1 ? '' : 's'}` : '',
    a.usd ? `$${a.usd.toFixed(2)}` : '',
    a.ms > 1000 ? `${Math.round(a.ms / 1000)}s` : '',
    scored ? `tree ${scored.tree.toFixed(2)} · ${scored.hard} hard` : '',
    refused ? `${refused} refused` : '',
    bad ? `${bad} reverted or failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The same story as lines of text, for a terminal. */
export function storyText(story: Story): string {
  const out: string[] = [];
  for (const a of story.acts) {
    out.push(`${a.title}`);
    out.push(`  ${a.summary}`);
    for (const b of a.beats) {
      const mark = b.tone === 'bad' ? '!' : b.tone === 'warn' ? '~' : b.tone === 'good' ? '+' : ' ';
      out.push(`  ${mark} ${b.label.padEnd(8)} ${b.title}${b.usd ? ` · $${b.usd.toFixed(3)}` : ''}${b.ms > 1000 ? ` · ${Math.round(b.ms / 1000)}s` : ''}`);
      // The title is already the first line of `said`; repeating it here is the flat log again.
      for (const note of b.notes) out.push(`      ${note.count > 1 ? `${note.count}x ` : ''}${note.text.split('\n')[0]!.slice(0, 110)}`);
    }
    out.push('');
  }
  const t = story.totals;
  out.push(`${t.steps} steps · ${t.calls} calls · ${t.refused} edits refused · $${t.usd.toFixed(2)} · ${Math.round(t.ms / 60000)} min`);
  return out.join('\n');
}
