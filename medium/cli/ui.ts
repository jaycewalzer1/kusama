// `ui` — a local page for looking at programs while you edit them.
//
// This is a *convenience*, not an instrument. It renders in whatever browser you point at it, on
// your real GPU, so its pixels are not the medium's pixels and must never be compared to a golden
// or used as evidence of anything. The determinism guarantee is specific to the pinned Chromium in
// `.browsers` under SwiftShader with antialiasing off (NOTES R6); a different GL stack is a
// different renderer. `render` and `golden --check` remain the only things that produce evidence.
//
// It reuses the real modules rather than reimplementing them: the server validates and resolves
// with the same `validateProgram`/`resolve` the CLIs use, and the page draws with the same
// `renderer/page.js`. That way the UI cannot drift into agreeing with a program the medium would
// refuse, or drawing something the medium would draw differently.
//
// One render per page frame, and the frame is reloaded for each render, because p5.brush keeps a
// blend-source framebuffer between draws (NOTES R1). Re-rendering into a live page would be a
// different picture from the first one.
//
// Programs can also be written here, not just looked at. What that produces is a *program*, saved to
// `examples/user/`, which the CLIs then render -- so authoring in the browser and getting the pixels
// that count stay separate, and the preview's GPU never becomes the source of an artefact.

import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { ROOT } from '../env/browser.js';
import { loadPackFor } from '../env/pack.js';
import { loadProfileFor } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';
import { fontsUsed } from '../renderer/resolve.js';

/** Exactly what the headless page may load, plus the UI's own two files. */
const SERVED_PREFIXES = ['vendor/', 'renderer/', 'fonts/', 'assets/fonts/', 'ui/'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** The one directory the UI may write into, so a saved name can never land on a worked example. */
const USER_DIR = 'examples/user';

/** A name, not a path. No separators, no dots, so nothing outside `USER_DIR` is expressible. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The program being edited in the browser, if any.
 *
 * Held in memory and served under the reserved name `draft`, so an unsaved program goes through
 * exactly the same `/api/resolve` path a file on disk does -- the frame cannot tell the difference,
 * and neither can the validator. Passing it through the frame's URL instead would cap how large a
 * program the UI could preview.
 */
let draft: string | null = null;
const DRAFT = 'draft';

/** Programs the UI will offer: the worked examples, the batch variants, then anything saved here. */
function programs(): string[] {
  const found: string[] = [];
  for (const dir of ['examples', 'examples/batch', USER_DIR]) {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs).sort()) {
      if (entry.endsWith('.json')) found.push(`${dir}/${entry}`);
    }
  }
  return found;
}

/** The whole request body as text. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve a program for the page, or explain why it cannot be drawn.
 *
 * `file` arrives from the query string, so it is checked against the list of programs this server
 * offers rather than being joined onto a path -- an allow-list, so no traversal is expressible.
 * The one name that is not a file is `draft`, the program currently in the editor.
 */
function resolveForPage(file: string, profileId: string | undefined) {
  const text =
    file === DRAFT ? draft : programs().includes(file) ? String(readFileSync(path.join(ROOT, file))) : null;
  if (text === null) return { error: `not a program this server offers: ${file}` };
  const raw = JSON.parse(text) as { assetPack?: string };
  const { profile } = loadProfileFor(raw, profileId);
  const pack = loadPackFor(raw, undefined);
  const result = validateProgram(raw, profile, pack);
  if (!result.valid) return { error: 'invalid program', issues: result.issues };
  const resolved = result.resolved!;
  const fonts: Record<string, string> = {};
  for (const name of fontsUsed(resolved)) fonts[name] = `/${pack.faces?.[name]?.file ?? `fonts/${name}.ttf`}`;
  return { resolved, pack, fonts, budget: result.budget, programHash: result.programHash };
}

const cli = new Command()
  .name('ui')
  .description('serve a local page for looking at programs (not an instrument -- see the header)')
  .option('-p, --profile <id|path>', 'override the profile each program names')
  .option('--port <n>', 'port to listen on', '4321');

cli.action((opts: { profile?: string; port: string }) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, type: string, body: string | Buffer) => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/') return send(200, MIME['.html']!, await readFile(path.join(ROOT, 'ui/index.html')));

    if (url.pathname === '/api/programs') return send(200, MIME['.json']!, JSON.stringify(programs()));

    // The program exactly as it is on disk. Same allow-list as /api/resolve, so the query string
    // still cannot name a file this server does not already offer.
    if (url.pathname === '/api/source') {
      const file = url.searchParams.get('file') ?? '';
      if (!programs().includes(file)) return send(400, MIME['.json']!, JSON.stringify({ error: `not a program this server offers: ${file}` }));
      return send(200, 'text/plain; charset=utf-8', await readFile(path.join(ROOT, file)));
    }

    // Hand the editor's contents to the server so the next render can draw them. Whether they are a
    // program at all is not decided here: `/api/resolve` will parse and validate this exactly as it
    // does a file, so an unsaved program is refused for the same reasons and in the same words.
    if (url.pathname === '/api/draft' && req.method === 'POST') {
      draft = await readBody(req);
      return send(200, MIME['.json']!, JSON.stringify({ ok: true }));
    }

    // Write the editor's contents to `examples/user/`, which is the only place this server writes.
    // A saved program is an ordinary file: `render`, `validate` and `diff` take it like any other,
    // and that is the point -- the UI authors programs, the CLIs produce the pixels that count.
    if (url.pathname === '/api/save' && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? '';
      if (!SAFE_NAME.test(name)) {
        return send(400, MIME['.json']!, JSON.stringify({ error: 'name must be lowercase letters, digits and dashes' }));
      }
      const text = await readBody(req);
      try {
        JSON.parse(text);
      } catch (e) {
        return send(400, MIME['.json']!, JSON.stringify({ error: `not JSON, so not saved: ${String(e)}` }));
      }
      mkdirSync(path.join(ROOT, USER_DIR), { recursive: true });
      writeFileSync(path.join(ROOT, USER_DIR, `${name}.json`), text);
      return send(200, MIME['.json']!, JSON.stringify({ file: `${USER_DIR}/${name}.json` }));
    }

    if (url.pathname === '/api/resolve') {
      try {
        const out = resolveForPage(url.searchParams.get('file') ?? '', opts.profile);
        return send('error' in out ? 400 : 200, MIME['.json']!, JSON.stringify(out));
      } catch (e) {
        return send(500, MIME['.json']!, JSON.stringify({ error: String(e) }));
      }
    }

    const rel = path.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!SERVED_PREFIXES.some((p) => rel.startsWith(p))) return send(404, 'text/plain', 'not served');
    try {
      send(200, MIME[path.extname(rel)] ?? 'application/octet-stream', await readFile(path.join(ROOT, rel)));
    } catch {
      send(404, 'text/plain', 'not found');
    }
  });

  server.listen(Number(opts.port), '127.0.0.1', () => {
    console.log(`medium ui  http://127.0.0.1:${opts.port}`);
    console.log('    preview only: your browser, your GPU, so these pixels are not the medium\'s pixels');
    console.log('    for evidence use `npm run render` or `npm run golden -- --check`');
  });
});

await cli.parseAsync();
