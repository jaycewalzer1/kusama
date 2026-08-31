// The Node side of rendering: one hermetic Chromium, one fresh page per render.
//
// Determinism protocol (measured, see NOTES R1):
//   * one p5 instance per page and exactly one render per page, because p5.brush keeps a
//     blend-source framebuffer between draws;
//   * software WebGL via SwiftShader, so nothing depends on the host GPU;
//   * capture with gl.readPixels after the addon's postdraw composite has settled.
// The claim is byte-identical output for the same inputs under this exact configuration, and the
// configuration is written into every trace so the claim can be checked.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import type { Browser, Page, Route } from 'playwright';
import type { AssetPack } from './pack.js';
import { resolveProgram } from '../renderer/resolve.js';

/** Repo root: the nearest ancestor holding the package manifest, so `dist/` works too. */
export const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('cannot locate the repo root (package.json not found above this file)');
})();

/** Everything the page is allowed to load. These are URLs, not disk paths — see `servedPath`. */
const SERVED_PREFIXES = ['vendor/', 'renderer/', 'assets/fonts/'];

/**
 * Where a served URL actually lives on disk.
 *
 * The vendored runtime and the assets moved inside `renderer/`, but the URL space did not follow
 * them, and must not: an asset pack stores its faces as `assets/fonts/...` and the pack's declared
 * hash is taken over those strings, so rewriting them would retire `core-v1@6d0d9e8f2ccf` and every
 * trace that names it. The page's own `<script src>`s are the same kind of frozen string. So the URL
 * space is the one the packs were hashed under, and this is the only place that knows it is now one
 * directory down.
 */
function servedPath(rel: string): string {
  const withinRenderer = rel.startsWith('renderer/') ? rel.slice('renderer/'.length) : rel;
  return path.join(ROOT, 'renderer', withinRenderer);
}

const ORIGIN = 'http://medium.invalid';

/**
 * The two faces that existed before packs carried type, kept so core@003e484d9602 still renders.
 * Everything else comes from the pack, which is the only thing whose hash covers the bytes.
 */
export const FONT_FILES: Record<string, string> = {
  grotesque: 'assets/fonts/grotesque.ttf',
  serif: 'assets/fonts/serif.ttf',
};

/** Faces already checked against their declared bytes, keyed by path: hashing 4MB per render is not free. */
const verified = new Set<string>();

/**
 * Turn the face names a program uses into URLs the page may fetch, and refuse a face whose bytes on
 * disk do not match what the pack declares. The pack hash is only a claim about the type until
 * something reads the file, and the render is the last place that claim can still be checked.
 */
async function faceUrls(pack: AssetPack | undefined, fonts: string[]): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const name of fonts) {
    const face = pack?.faces?.[name];
    const rel = face?.file ?? FONT_FILES[name];
    if (!rel) throw new Error(`font "${name}" is in no asset pack and is not one of the built-in faces`);
    if (face && !verified.has(rel)) {
      const actual = await sha256(servedPath(rel));
      if (actual !== face.sha256) {
        throw new Error(`font "${name}" (${rel}) hashes to ${actual}, but pack "${pack?.id}" declares ${face.sha256}`);
      }
      verified.add(rel);
    }
    urls[name] = `/${rel}`;
  }
  return urls;
}

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

/** How many times one program may be rendered while waiting for two identical results (NOTES R7). */
const MAX_RENDER_ATTEMPTS = 6;
const WARMUP_PACK = { id: 'warmup', hash: 'warmup', fragments: {}, motifs: {} };
const WARMUP_PROGRAM = {
  version: '0.2',
  profile: 'warmup',
  assetPack: 'warmup',
  canvas: { width: 128, height: 128, ground: '#ffffff', brushScale: 1 },
  seed: 1,
  palette: {},
  root: {
    id: 'warmup',
    type: 'group',
    children: [
      {
        id: 'warmup-wash',
        type: 'op',
        op: 'wash',
        rngKey: 'warmup',
        args: {
          region: { type: 'circle', cx: 64, cy: 64, r: 40 },
          style: { kind: 'wash', color: '#888888', opacity: 120, bleed: 0.1, texture: [0.4, 0.2] },
        },
      },
    ],
  },
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export interface GlInfo {
  /** p5 reports this as a string ("webgl2"), not a number. */
  webglVersion: string;
  renderer: string;
  vendor: string;
  unmaskedRenderer: string | null;
  shadingLanguage: string;
}

export interface RendererManifest {
  p5: { version: string; sha256: string };
  p5brush: { version: string; sha256: string };
  browser: { name: string; version: string; revision: string; launchArgs: string[] };
  gl: GlInfo | null;
  fonts: Record<string, string>;
  node: string;
  os: { platform: string; release: string; arch: string };
  /** How the page decides a frame is finished, rather than how many frames it waits (NOTES R6). */
  settlePolicy: string;
  /** How the renderer decides a render is trustworthy, rather than how many it throws away (R7). */
  renderPolicy: string;
  pagesPerRender: number;
  warmupRenders: number;
}

export interface RenderResult {
  /** Top-down RGBA, 4 bytes per pixel. */
  rgba: Buffer;
  width: number;
  height: number;
  /**
   * `settleFrames` is how many frames the winning attempt needed before two readbacks agreed;
   * `attempts` is how many whole renders it took before two of them agreed (NOTES R7).
   */
  timings: { drawMs: number; readMs: number; settleFrames: number; attempts: number; totalMs: number };
  warnings: string[];
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** Flip readPixels' bottom-up rows into image order. */
function flipRows(raw: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const out = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride;
    out.set(raw.subarray(src, src + stride), y * stride);
  }
  return out;
}

export class Renderer {
  private constructor(
    private readonly browser: Browser,
    public readonly manifest: RendererManifest
  ) {}

  static async launch(): Promise<Renderer> {
    process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= path.join(ROOT, '.browsers');
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ args: LAUNCH_ARGS });
    const exe = chromium.executablePath();
    const fonts: Record<string, string> = {};
    for (const [name, rel] of Object.entries(FONT_FILES)) fonts[name] = await sha256(servedPath(rel));
    const manifest: RendererManifest = {
      p5: { version: '2.2.0', sha256: await sha256(servedPath('vendor/p5.min.js')) },
      p5brush: { version: '2.1.0-beta', sha256: await sha256(servedPath('vendor/p5.brush.js')) },
      browser: {
        name: 'chromium',
        version: browser.version(),
        revision: path.basename(exe.split(`${path.sep}chrome-`)[0] ?? exe),
        launchArgs: LAUNCH_ARGS,
      },
      gl: null,
      fonts,
      node: process.version,
      os: { platform: os.platform(), release: os.release(), arch: os.arch() },
      settlePolicy: 'read until two consecutive frames are identical',
      renderPolicy: 'render until two consecutive renders are identical',
      pagesPerRender: 1,
      warmupRenders: 0,
    };
    const renderer = new Renderer(browser, manifest);
    manifest.warmupRenders = await renderer.warmUp();
    return renderer;
  }

  /**
   * Prove, on a throwaway program, that this process can render the same thing twice, and report how
   * many renders that took. If it cannot, the determinism claim is false on this machine, so this
   * throws rather than rendering anything a caller might believe.
   */
  private async warmUp(): Promise<number> {
    const warmup = resolveProgram(WARMUP_PROGRAM, WARMUP_PACK);
    try {
      return (await this.render(warmup, WARMUP_PACK)).timings.attempts;
    } catch (cause) {
      await this.close();
      throw new Error(`this browser cannot render deterministically: ${(cause as Error).message}`);
    }
  }

  /**
   * Render one resolved program, and keep rendering it until two consecutive renders are
   * byte-identical. `fonts` names must be keys of FONT_FILES; only the fonts a program actually uses
   * are loaded, so an unused face cannot change a render.
   *
   * A single render is not trustworthy even with a fresh page and a settled frame, and this is
   * measured (NOTES R7): rendering a page of text perturbs the *next* render, which comes back with
   * about four pixels of 960,000 off by up to three, differently wrong each time. A cheap throwaway
   * render in between absorbs it, but only if that throwaway is big enough -- 64x64 works and 32x32
   * does not -- and a threshold nobody can explain is exactly the fixed warm-up count of NOTES R4
   * wearing a different hat. So instead of guessing which programs perturb which, this waits for the
   * property callers actually depend on: the same program, rendered twice, giving the same bytes.
   * It costs a second render, and it fails loudly rather than quietly returning a plausible image.
   */
  async render(resolved: unknown, pack: unknown, fonts: string[] = []): Promise<RenderResult> {
    const started = Date.now();
    let previous = '';
    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      const out = await this.renderUnchecked(resolved, pack, fonts);
      const hash = createHash('sha256').update(out.rgba).digest('hex');
      if (hash === previous) {
        return { ...out, timings: { ...out.timings, attempts: attempt, totalMs: Date.now() - started } };
      }
      previous = hash;
    }
    throw new Error(
      `the render never repeated: ${MAX_RENDER_ATTEMPTS} renders of the same program never produced ` +
        'two identical images in a row, so this render cannot be trusted to be deterministic'
    );
  }

  /**
   * One render, with no reproducibility guarantee at all. `render()` is built out of this, and the
   * determinism tests call it directly because a test of whether a single render is trustworthy
   * cannot go through the loop whose whole job is to hide that. Nothing else should use it.
   */
  async renderUnchecked(resolved: unknown, pack: unknown, fonts: string[] = []): Promise<RenderResult> {
    const started = Date.now();
    const page = await this.newPage();
    try {
      const fontUrls = await faceUrls(pack as AssetPack | undefined, fonts);
      const consoleErrors: string[] = [];
      page.on('pageerror', (e) => consoleErrors.push(String(e)));
      const out = await page.evaluate(
        (req) => (window as unknown as { __mediumRender: (r: unknown) => Promise<RawRender> }).__mediumRender(req),
        { resolved, pack, fonts: fontUrls } as unknown as never
      );
      if (!this.manifest.gl) this.manifest.gl = out.gl;
      const raw = Buffer.from(out.pixels, 'base64');
      return {
        rgba: flipRows(raw, out.width, out.height),
        width: out.width,
        height: out.height,
        timings: { ...out.timings, attempts: 1, totalMs: Date.now() - started },
        warnings: consoleErrors,
      };
    } finally {
      await page.close();
    }
  }

  private async newPage(): Promise<Page> {
    const page = await this.browser.newPage({ viewport: { width: 400, height: 400 } });
    await page.route(`${ORIGIN}/**`, (route: Route) => this.serve(route));
    await page.goto(`${ORIGIN}/renderer/page.html`);
    await page.waitForFunction(() => (window as unknown as { __mediumReady?: boolean }).__mediumReady === true);
    return page;
  }

  /** Serve the vendored runtime off disk. No request ever leaves the machine. */
  private async serve(route: Route): Promise<void> {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '');
    const safe = path.normalize(rel);
    if (!SERVED_PREFIXES.some((p) => safe.startsWith(p))) return route.fulfill({ status: 404, body: 'not served' });
    try {
      const body = await readFile(servedPath(safe));
      await route.fulfill({ status: 200, contentType: MIME[path.extname(safe)] ?? 'application/octet-stream', body });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

interface RawRender {
  width: number;
  height: number;
  pixels: string;
  gl: GlInfo;
  timings: { drawMs: number; readMs: number; settleFrames: number };
}
