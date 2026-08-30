// `ui` — the studio: start artist runs, watch them work, read what they decided.
//
// The artist writes everything it does to `studio.jsonl` as it goes: every phase, every policy call
// with the model's own reasoning, every render with its program hash, every refused edit. This
// server holds no state that is not already in that file. It starts child processes, tails their
// logs, and serves plates out of the render cache — so a run looked at here and a run read from disk
// afterwards are the same run, and closing the browser loses nothing.
//
// The pictures it shows are PNGs the run already produced in the pinned Chromium under SwiftShader.
// Nothing is rendered in your browser, so unlike the program preview this replaced, what you are
// looking at *is* the medium's pixels.
//
// Adding reinforcement learning here means adding a `RUN_KINDS` entry whose command writes a
// studio.jsonl into a directory. The run list finds runs by looking for that file, the feed
// summarises line kinds it knows and shows the raw JSON for the ones it does not, so a new phase or
// a new line kind appears in the timeline without this file changing.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Command } from 'commander';
import { ROOT } from '../env/browser.js';
import { validateAestheticProgram } from '../aesthetic/check.js';
import {
  aestheticDirection,
  deliverableFacts,
  effectivePosition,
  listDeliverables,
  namesDeliverable,
  practiceOf,
  temperamentOf,
  type Brief,
} from '../artist/field.js';
import { storyOf, summarise } from '../artist/story.js';
import { readLog } from '../artist/studio-log.js';
import { transcriptMarkdown } from '../artist/transcript.js';
import type { AestheticProgram } from '../aesthetic/types.js';

/** Where a run's intermediate plates live, keyed by program hash. Written by artist/canvas.ts. */
const PNG_CACHE = path.join(ROOT, '.cache', 'artist-png');

/** Everything the page itself may load. Runs are served through /api, never from here. */
const SERVED_PREFIXES = ['studio/ui/'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * What can be started from here, and the command each one runs.
 *
 * Both write the same log into a directory, which is the only contract the rest of this file has
 * with them. A trainer that wrote studio.jsonl would slot in beside these two unchanged.
 */
const RUN_KINDS: Record<string, (p: Params, dir: string) => string[]> = {
  run: (p, dir) => [
    'run', p.position!, p.brief!, p.deliverable!, '-o', dir,
    '--seed', String(p.seed), '--steps', String(p.steps), '--sketches', String(p.sketches),
    ...(p.control ? ['--control'] : []),
    ...(p.audience ? [] : ['--no-audience']),
  ],
  grid: (p, dir) => [
    'grid', '-o', dir,
    '--seed', String(p.seed), '--steps', String(p.steps),
    '--positions', p.positions!.join(','), '--briefs', p.briefs!.join(','),
    '--deliverable', p.deliverable!,
    ...(p.control ? [] : ['--no-control']),
  ],
};

interface Params {
  kind: string;
  position?: string;
  brief?: string;
  /** L3, and it is one for a grid as well: the grid crosses positions with briefs, not with objects. */
  deliverable?: string;
  positions?: string[];
  briefs?: string[];
  seed: number;
  steps: number;
  sketches: number;
  control: boolean;
  audience: boolean;
}

// --- what can be asked for ----------------------------------------------------------------------

/**
 * The three layers on disk that vary, and all three are picked at launch. L4 is not here because it
 * varies with nothing and there is nothing to choose.
 */
function catalog(): {
  positions: { id: string; name: string }[];
  briefs: { id: string; title: string }[];
  deliverables: { id: string; name: string }[];
} {
  const read = (dir: string, skipField: boolean) => {
    const abs = path.join(ROOT, 'aesthetic', dir);
    return readdirSync(abs)
      .filter((f) => f.endsWith('.json') && !(skipField && f.endsWith('.field.json')))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(abs, f), 'utf8')) as Record<string, string>);
  };
  return {
    positions: read('positions', false).map((p) => ({ id: p['id']!, name: p['name'] ?? p['id']! })),
    briefs: read('briefs', true).map((b) => ({ id: b['id']!, title: b['title'] ?? b['id']! })),
    deliverables: listDeliverables().map((d) => ({ id: d.id, name: d.name })),
  };
}

// --- reading and writing what the artist is held to -----------------------------------------------

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DIRS: Record<string, string> = { position: 'positions', brief: 'briefs', deliverable: 'deliverables' };

/** Both documents of a commission, or the one document of a position or a deliverable. */
function readDoc(kind: string, id: string): { doc: unknown; field: unknown } | null {
  if (!NAME.test(id)) return null;
  const dir = path.join(ROOT, 'aesthetic', DIRS[kind] ?? 'briefs');
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (kind !== 'brief') return { doc, field: null };
  const fieldFile = path.join(dir, `${id}.field.json`);
  return { doc, field: existsSync(fieldFile) ? (JSON.parse(readFileSync(fieldFile, 'utf8')) as unknown) : null };
}

/**
 * Everything that has to be true before a document is written into `aesthetic/`, checked with the
 * same code the run uses rather than a copy of it: `validateAestheticProgram` for a position, and
 * for a commission the field the artist cannot run without plus a composition against every
 * position on disk, which is where a constraint id collision shows up.
 *
 * A document that fails here is not written at all. The launcher reads this directory on every
 * request, so a broken file there is a broken studio, not just a bad run.
 */
function documentErrors(kind: string, id: string, doc: Record<string, unknown>, field: Record<string, unknown> | null): string[] {
  const bad: string[] = [];
  if (!NAME.test(id)) bad.push('the name must be lowercase letters, digits and hyphens');
  if (doc?.['id'] !== id) bad.push(`the document says id ${JSON.stringify(doc?.['id'])}, but it is being saved as ${id}`);

  if (kind === 'position') {
    bad.push(...validateAestheticProgram(doc));
    if (bad.length === 0) {
      // L1 is not just the constraints. A position with no practice and no temperament passes the
      // aesthetic schema and is still unusable here, so both are checked with the loader's own code.
      for (const read of [temperamentOf, practiceOf]) {
        try {
          read(doc as unknown as AestheticProgram);
        } catch (e) {
          bad.push(e instanceof Error ? e.message : String(e));
        }
      }
      // The L1/L3 boundary, enforced where the next position is actually written. A position that
      // states what the object does has done L3's job, and the artist then appears to derive from
      // its own vocabulary what it was in fact told. Catching this at `npm test` is too late: the
      // file is on disk by then and runs against it are already confounded.
      const facts = deliverableFacts(doc as unknown as AestheticProgram);
      if (facts.length > 0) {
        bad.push(
          `a position may hold beliefs about a medium but not facts about one, and ${facts.join('; ')}. ` +
            'Cite the object in lineage, where it is a reference, or say it about the medium instead.'
        );
      }
    }
    return bad;
  }

  if (kind === 'deliverable') {
    for (const key of ['name', 'function', 'doesNotDecide']) {
      if (typeof doc?.[key] !== 'string' || !(doc[key] as string).trim()) bad.push(`${key} is required and must say something`);
    }
    const consequences = doc?.['consequences'];
    if (!Array.isArray(consequences) || consequences.length < 3) {
      bad.push('consequences must list at least three things this kind of object has to survive');
    }
    return bad;
  }

  for (const key of [
    'title',
    'client',
    'event',
    'when',
    'where',
    'function',
    'audience',
    'production',
    'quantity',
    'budget',
    'timeline',
    'clientFear',
    'stakes',
  ]) {
    if (typeof doc?.[key] !== 'string' || !(doc[key] as string).trim()) bad.push(`${key} is required and must say something`);
  }
  const mustAppear = doc?.['mustAppear'];
  if (!Array.isArray(mustAppear) || mustAppear.length === 0) {
    bad.push('mustAppear must list the facts that have to be legible; a commission that requires nothing is not one');
  }
  // Without one of these there is nothing in the commission to decline, so an artist that complies
  // and an artist that judges leave the same trace and the run cannot tell them apart.
  const hurts = doc?.['clientWantThatHurtsTheWork'];
  if (!Array.isArray(hurts) || hurts.length === 0) {
    bad.push(
      'clientWantThatHurtsTheWork must name at least one thing the client has asked for that damages the piece; ' +
        'a commission with nothing to resist measures compliance rather than judgment'
    );
  }
  // The kind of object is the third axis, chosen at launch. A commission that names one is wrong in
  // every cell that runs it as something else, and it hands the artist a fact L3 may contradict.
  const named = namesDeliverable(doc as unknown as Brief);
  if (named.length > 0) {
    bad.push(
      `which kind of object this becomes is chosen when the run is launched, not by the client, and ${named.join('; ')}. ` +
        'Say what the job has to achieve instead.'
    );
  }
  // The one editorial rule that is enforced mechanically. A brief carrying style words is not a
  // worse brief, it is a different experiment, and letting one be saved here would silently make
  // every run against it non-comparable with every run against the others.
  const contamination = aestheticDirection(doc as unknown as Brief);
  if (contamination.length > 0) {
    bad.push(
      `the commission tells the artist what it should look like, which is not the client's to decide: ${contamination.join(', ')}`
    );
  }
  if (!Array.isArray(doc?.['hard_constraints'])) bad.push('hard_constraints must be a list, empty if the commission fixes nothing');
  if (!field) bad.push('a commission without a field cannot be run: FIND reads the problem out of the field, and given none it invents one');
  else {
    if (field['briefId'] !== id) bad.push(`the field says briefId ${JSON.stringify(field['briefId'])}, not ${id}`);
    for (const key of ['whenAndWhere', 'stakesLevelWhy']) {
      if (typeof field[key] !== 'string' || !(field[key] as string).trim()) bad.push(`the field's ${key} is required`);
    }
    for (const key of ['inTheAir', 'contested', 'exhausted', 'transplants']) {
      if (!Array.isArray(field[key])) bad.push(`the field's ${key} must be a list`);
    }
    const watching = field['whoIsWatching'] as Record<string, unknown> | undefined;
    if (typeof watching?.['audience'] !== 'string' || typeof watching['adversary'] !== 'string') {
      bad.push('the field needs whoIsWatching.audience and whoIsWatching.adversary');
    }
    const level = field['stakesLevel'];
    if (typeof level !== 'number' || level < 0 || level > 1) bad.push('the field needs stakesLevel, a number from 0 to 1');
  }
  if (bad.length > 0) return bad;

  // The checker never sees a brief; it sees a position with the brief's constraints appended. If
  // that composition throws for any position, the commission cannot be run against that position.
  for (const p of catalog().positions) {
    const position = readDoc('position', p.id)?.doc as AestheticProgram | undefined;
    if (!position) continue;
    try {
      const composed = effectivePosition(position, doc as unknown as Brief);
      // The composed id is `position+brief`, which the schema's id pattern refuses by design; it is
      // never written to disk. Judge the constraints, which is the only thing the brief contributed.
      bad.push(...validateAestheticProgram({ ...composed, id: position.id }).map((e) => `against ${p.id}: ${e}`));
    } catch (e) {
      bad.push(e instanceof Error ? e.message : String(e));
    }
  }
  return bad;
}

// --- finding runs -------------------------------------------------------------------------------

/**
 * Every directory under the runs root that holds a studio.jsonl, relative to that root.
 *
 * Runs are found rather than registered, so a trajectory produced by the CLI months ago appears
 * here beside one started five seconds ago, and a grid's cells appear as the runs they are.
 */
function findRuns(absRoot: string, rel = '', depth = 3): string[] {
  const abs = path.join(absRoot, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  if (existsSync(path.join(abs, 'studio.jsonl'))) return [rel];
  if (depth === 0) return [];
  const found: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? 1 : -1))) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) found.push(...findRuns(absRoot, path.join(rel, entry.name), depth - 1));
  }
  return found;
}

/** The first line of a log, which is always `trajectory-start`. Read without loading the file. */
function firstLine(file: string): { t: string; data: Record<string, unknown> } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl < 0) return null;
    return JSON.parse(buf.toString('utf8', 0, nl)) as { t: string; data: Record<string, unknown> };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// --- runs this server started -------------------------------------------------------------------

interface Live {
  /** The directory the child was given. A grid's cells sit underneath it. */
  id: string;
  child: ChildProcess;
  /** Kept so a run that dies before writing a log can still say why on the page. */
  stderr: string[];
  exit: number | null;
}

const live = new Map<string, Live>();

/** The child responsible for a run id: itself, or the grid it is a cell of. */
function liveFor(id: string): Live | undefined {
  for (const l of live.values()) {
    if (l.exit === null && (l.id === id || id.startsWith(`${l.id}/`))) return l;
  }
  return undefined;
}

// --- tailing a log ------------------------------------------------------------------------------

interface Entry {
  seq: number;
  t: string;
  kind: string;
  /** Byte offset and length of the whole line, so the full record can be fetched without a scan. */
  at: number;
  len: number;
  summary: Record<string, unknown>;
}

interface Feed {
  size: number;
  at: number;
  partial: string;
  decoder: StringDecoder;
  entries: Entry[];
}

const feeds = new Map<string, Feed>();

/**
 * The log so far, summarised, read incrementally.
 *
 * A trajectory's log runs to a megabyte or more because every observation is in it verbatim, so the
 * page polls this while a run is going and re-reading the file each second would be absurd. Only the
 * bytes appended since last time are read. A `StringDecoder` carries any multi-byte character split
 * across that boundary, and a partial last line is held back until its newline arrives.
 */
function tail(file: string, id: string): Entry[] {
  let f = feeds.get(id);
  if (!f) {
    f = { size: 0, at: 0, partial: '', decoder: new StringDecoder('utf8'), entries: [] };
    feeds.set(id, f);
  }
  const size = existsSync(file) ? statSync(file).size : 0;
  if (size < f.size) {
    // The file shrank, so it is not the file we were reading. Start again.
    f = { size: 0, at: 0, partial: '', decoder: new StringDecoder('utf8'), entries: [] };
    feeds.set(id, f);
  }
  if (size > f.size) {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - f.size);
      readSync(fd, buf, 0, buf.length, f.size);
      f.size = size;
      const text = f.partial + f.decoder.write(buf);
      const parts = text.split('\n');
      f.partial = parts.pop() ?? '';
      for (const part of parts) {
        const len = Buffer.byteLength(part) + 1;
        const at = f.at;
        f.at += len;
        if (!part.trim()) continue;
        try {
          const line = JSON.parse(part) as { seq: number; t: string; kind: string; data: unknown };
          f.entries.push({ seq: line.seq, t: line.t, kind: line.kind, at, len, summary: summarise(line.kind, line.data) });
        } catch {
          // A line that will not parse is a line the run is still writing to, or a damaged log.
          // Either way it is not this server's job to repair it, and dropping it keeps the rest.
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  return f.entries;
}

// --- assembling a run ---------------------------------------------------------------------------

interface RunView {
  id: string;
  position: string;
  brief: string;
  control: boolean;
  seed: number;
  started: string;
  status: 'running' | 'finished' | 'stopped';
  scores: Record<string, unknown> | null;
}

function runView(root: string, id: string): RunView | null {
  const first = firstLine(path.join(root, id, 'studio.jsonl'));
  if (!first) return null;
  const done = existsSync(path.join(root, id, 'final.json'));
  const scoresFile = path.join(root, id, 'scores.json');
  return {
    id,
    position: String(first.data['positionId'] ?? '?'),
    brief: String(first.data['briefId'] ?? '?'),
    control: Boolean(first.data['control']),
    seed: Number(first.data['seed'] ?? 0),
    started: first.t,
    status: liveFor(id) ? 'running' : done ? 'finished' : 'stopped',
    scores: existsSync(scoresFile) ? (JSON.parse(readFileSync(scoresFile, 'utf8')) as Record<string, unknown>) : null,
  };
}

/**
 * What a trajectory has actually cost here, so the launcher can price a run instead of quoting a
 * number somebody wrote in a README once.
 *
 * The shape of a trajectory is fixed by the loop, not guessed: one FIND, one CHOOSE, one EXAMINE,
 * `sketches` calls per problem found, and per step an ACT and a REPLAN except after the last.
 * That is `2 + sketches * problems + 2 * steps` calls, which reproduces every finished run here
 * exactly. What it cannot know in advance is how many problems FIND will return (the schema allows
 * three to six) and how many steps the artist will use of the budget it is given, so the page turns
 * this into a range and prices the range at the dollars and minutes a call has really taken.
 */
function observed(root: string): { runs: number; usdPerCall: number; msPerCall: number; leastSteps: number } {
  let calls = 0;
  let usd = 0;
  let ms = 0;
  let runs = 0;
  let leastSteps = Infinity;
  for (const id of findRuns(root)) {
    const file = path.join(root, id, 'final.json');
    if (!existsSync(file)) continue;
    const final = JSON.parse(readFileSync(file, 'utf8')) as { cost?: Record<string, number>; steps?: unknown[] };
    const cost = final.cost;
    // A replay copies the cost of the trajectory it replays but takes no time at all, because it
    // made no calls. Anything averaging under a second a call did not talk to a model; counting it
    // would drag the minutes-per-call rate towards zero.
    if (!cost?.['policyCalls'] || !cost['wallMs'] || cost['wallMs'] / cost['policyCalls'] < 1000) continue;
    runs += 1;
    calls += cost['policyCalls'];
    usd += cost['usd'] ?? 0;
    ms += cost['wallMs'];
    leastSteps = Math.min(leastSteps, final.steps?.length ?? Infinity);
  }
  return {
    runs,
    usdPerCall: calls > 0 ? usd / calls : 0.08,
    msPerCall: calls > 0 ? ms / calls : 55_000,
    leastSteps: Number.isFinite(leastSteps) ? leastSteps : 3,
  };
}

/** A directory name that says what the run was, and sorts by when it started. */
function newRunDir(p: Params): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const what = p.kind === 'grid' ? 'grid' : `${p.position}__${p.brief}${p.control ? '__control' : ''}`;
  return path.join('studio', `${stamp}__${what}`);
}

/**
 * The keys the child needs that this process may not have been started with.
 *
 * The studio is launched from an editor button, which does not read the repo's `.env`, and a run
 * without a key fails on its first policy call after opening a browser. Only keys absent from this
 * process are filled, and only for the child.
 */
function envFile(): Record<string, string> {
  const file = path.join(path.dirname(ROOT), '.env');
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// --- the server ---------------------------------------------------------------------------------

const cli = new Command()
  .name('ui')
  .description('the studio: start artist runs, watch them work, read what they decided')
  .option('--runs <dir>', 'directory the run list is found under', 'out')
  .option('--port <n>', 'port to listen on', '4321');

cli.action((opts: { runs: string; port: string }) => {
  const root = path.resolve(ROOT, opts.runs);
  mkdirSync(root, { recursive: true });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, type: string, body: string | Buffer, cache = 'no-store') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': cache });
      res.end(body);
    };
    const json = (code: number, body: unknown) => send(code, MIME['.json']!, JSON.stringify(body));

    /** `id` always arrives from the query string, so it is matched against the runs that exist. */
    const runId = (): string | null => {
      const id = url.searchParams.get('run') ?? '';
      return findRuns(root).includes(id) ? id : null;
    };

    if (url.pathname === '/') return send(200, MIME['.html']!, await readFile(path.join(ROOT, 'studio/ui/index.html')));

    if (url.pathname === '/api/catalog') {
      return json(200, {
        ...catalog(),
        hasKey: Boolean(process.env['ANTHROPIC_API_KEY'] ?? envFile()['ANTHROPIC_API_KEY']),
        runs: opts.runs,
        observed: observed(root),
      });
    }

    // Any one of the three layers that live on disk, whole, for reading and for starting from.
    if (url.pathname === '/api/doc' && req.method !== 'POST') {
      const asked = url.searchParams.get('kind') ?? '';
      const kind = asked in DIRS ? asked : 'brief';
      const found = readDoc(kind, url.searchParams.get('id') ?? '');
      return found ? json(200, { kind, ...found }) : json(404, { error: 'no such document' });
    }

    // Write one. Refuses to write over a document that exists: these are hand-written and a
    // studio that silently replaced one would be a studio that can lose a position.
    if (url.pathname === '/api/doc' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: { kind?: string; id?: string; doc?: Record<string, unknown>; field?: Record<string, unknown> | null };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(400, { error: 'not JSON' });
      }
      const kind = body.kind && body.kind in DIRS ? body.kind : 'brief';
      const id = String(body.id ?? '');
      if (!NAME.test(id)) return json(400, { errors: ['the name must be lowercase letters, digits and hyphens'] });
      const dir = path.join(ROOT, 'aesthetic', DIRS[kind]!);
      if (existsSync(path.join(dir, `${id}.json`))) return json(409, { errors: [`${id} already exists; give it another name`] });
      const errors = documentErrors(kind, id, body.doc ?? {}, body.field ?? null);
      if (errors.length > 0) return json(400, { errors });
      writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(body.doc, null, 2)}\n`);
      if (kind === 'brief') writeFileSync(path.join(dir, `${id}.field.json`), `${JSON.stringify(body.field, null, 2)}\n`);
      console.log(`wrote aesthetic/${DIRS[kind]!}/${id}.json`);
      return json(200, { kind, id });
    }

    if (url.pathname === '/api/runs') {
      const runs = findRuns(root)
        .map((id) => runView(root, id))
        .filter((r): r is RunView => r !== null);
      // Anything still going, first: it is the thing being watched.
      runs.sort((a, b) => (a.status === b.status ? (a.started < b.started ? 1 : -1) : a.status === 'running' ? -1 : 1));
      return json(200, runs);
    }

    // One log line whole: the observation the model was given, its raw answer, every retry.
    if (url.pathname === '/api/line') {
      const id = runId();
      if (id === null) return json(404, { error: 'no such run' });
      const seq = Number(url.searchParams.get('seq') ?? '-1');
      const entry = tail(path.join(root, id, 'studio.jsonl'), id).find((e) => e.seq === seq);
      if (!entry) return json(404, { error: `no line ${seq}` });
      const fd = openSync(path.join(root, id, 'studio.jsonl'), 'r');
      try {
        const buf = Buffer.alloc(entry.len);
        readSync(fd, buf, 0, buf.length, entry.at);
        return send(200, MIME['.json']!, buf.toString('utf8'));
      } finally {
        closeSync(fd);
      }
    }

    // The run folded into acts and beats: the only view of the log the page has. Whole lines are
    // reached through /api/line, from the beat they belong to.
    if (url.pathname === '/api/story') {
      const id = runId();
      if (id === null) return json(404, { error: 'no such run' });
      const entries = tail(path.join(root, id, 'studio.jsonl'), id);
      const l = liveFor(id);
      return json(200, {
        run: runView(root, id),
        story: storyOf(entries),
        stderr: l ? l.stderr.slice(-6) : [],
      });
    }

    // The same story, as one file to keep. Built here rather than in the page because the page has
    // only the small form of each line: the observations and the raw answers never left this process.
    if (url.pathname === '/api/transcript') {
      const id = runId();
      if (id === null) return json(404, { error: 'no such run' });
      const body = transcriptMarkdown(id, readLog(path.join(root, id, 'studio.jsonl')));
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${id.replace(/[^\w.-]+/g, '-')}.md"`,
      });
      return res.end(body);
    }

    // A plate the run stood on, out of the render cache, by program hash.
    if (url.pathname === '/api/plate') {
      const hash = url.searchParams.get('hash') ?? '';
      if (!/^[0-9a-f]{16,64}$/.test(hash)) return json(400, { error: 'not a program hash' });
      try {
        // A plate is its hash, so it can never change: the strip redraws without refetching.
        return send(200, MIME['.png']!, await readFile(path.join(PNG_CACHE, `${hash}.png`)), 'max-age=31536000, immutable');
      } catch {
        return json(404, { error: 'that plate is not in the render cache' });
      }
    }

    // A file the run wrote: final.png, sketches/*.png. Confined to the run's own directory.
    if (url.pathname === '/api/file') {
      const id = runId();
      if (id === null) return json(404, { error: 'no such run' });
      const dir = path.join(root, id);
      const file = path.resolve(dir, url.searchParams.get('name') ?? '');
      if (!file.startsWith(`${dir}${path.sep}`)) return json(400, { error: 'outside the run' });
      try {
        return send(200, MIME[path.extname(file)] ?? 'application/octet-stream', await readFile(file));
      } catch {
        return json(404, { error: 'not written yet' });
      }
    }

    if (url.pathname === '/api/sketches') {
      const id = runId();
      if (id === null) return json(404, { error: 'no such run' });
      const dir = path.join(root, id, 'sketches');
      return json(200, existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : []);
    }

    // Start a run. Positions and briefs are checked against what is on disk and the numbers are
    // clamped, so the argv handed to the child is built from choices this server offers.
    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let p: Params;
      try {
        p = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Params;
      } catch {
        return json(400, { error: 'not JSON' });
      }
      const { positions, briefs, deliverables } = catalog();
      const knownP = new Set(positions.map((x) => x.id));
      const knownB = new Set(briefs.map((x) => x.id));
      const knownD = new Set(deliverables.map((x) => x.id));
      const int = (v: unknown, lo: number, hi: number, fallback: number) => {
        const n = Math.trunc(Number(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
      };
      const params: Params = {
        kind: p.kind === 'grid' ? 'grid' : 'run',
        position: p.position,
        brief: p.brief,
        deliverable: p.deliverable,
        positions: (p.positions ?? []).filter((x) => knownP.has(x)),
        briefs: (p.briefs ?? []).filter((x) => knownB.has(x)),
        seed: int(p.seed, 0, 1e9, 1),
        steps: int(p.steps, 1, 40, 12),
        sketches: int(p.sketches, 0, 6, 3),
        control: Boolean(p.control),
        audience: p.audience !== false,
      };
      // The kind of object is required for both kinds of run, because nothing else supplies it any
      // more: the brief stopped carrying one when it became the third axis.
      if (!knownD.has(params.deliverable ?? '')) {
        return json(400, { error: 'pick a kind of object that exists' });
      }
      if (params.kind === 'run' && (!knownP.has(params.position ?? '') || !knownB.has(params.brief ?? ''))) {
        return json(400, { error: 'pick a position and a brief that exist' });
      }
      if (params.kind === 'grid' && (params.positions!.length === 0 || params.briefs!.length === 0)) {
        return json(400, { error: 'a grid needs at least one position and one brief' });
      }

      const id = newRunDir(params);
      const dir = path.join(root, id);
      mkdirSync(dir, { recursive: true });
      const args = ['dist/studio/artist.js', ...RUN_KINDS[params.kind]!(params, dir)];
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: { ...envFile(), ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const l: Live = { id, child, stderr: [], exit: null };
      live.set(id, l);
      const keep = (buf: Buffer) => {
        for (const line of buf.toString('utf8').split('\n')) if (line.trim()) l.stderr.push(line);
        if (l.stderr.length > 200) l.stderr.splice(0, l.stderr.length - 200);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.on('exit', (code, signal) => {
        // A killed child reports a null code, which is not an exit code and must not read as success.
        l.exit = code ?? -1;
        console.log(`${id}: ${signal ? `killed by ${signal}` : `exit ${code}`}`);
      });
      console.log(`${id}: ${args.join(' ')}`);
      return json(200, { run: id, command: args.join(' ') });
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const l = liveFor(url.searchParams.get('run') ?? '');
      if (!l) return json(404, { error: 'nothing running for that run' });
      l.child.kill('SIGTERM');
      return json(200, { stopping: l.id });
    }

    const rel = path.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!SERVED_PREFIXES.some((prefix) => rel.startsWith(prefix))) return send(404, 'text/plain', 'not served');
    try {
      send(200, MIME[path.extname(rel)] ?? 'application/octet-stream', await readFile(path.join(ROOT, rel)));
    } catch {
      send(404, 'text/plain', 'not found');
    }
  });

  // A run outlives a page reload but not the server, so say what is still going before leaving.
  process.on('SIGINT', () => {
    for (const l of live.values()) if (l.exit === null) l.child.kill('SIGTERM');
    process.exit(0);
  });

  server.listen(Number(opts.port), '127.0.0.1', () => {
    console.log(`studio  http://127.0.0.1:${opts.port}`);
    console.log(`    runs under ${root}, new ones into ${path.join(root, 'studio')}`);
    console.log('    a trajectory costs real money and takes 20-30 minutes; renders are serial');
  });
});

await cli.parseAsync();
