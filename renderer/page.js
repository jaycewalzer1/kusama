// The page's only entry point. Browser only.
//
// `env/browser.ts` navigates a fresh page here, then calls `window.__mediumRender(request)` exactly
// once. One render per page is deliberate: p5.brush keeps a blend-source framebuffer between draws,
// so render N in a page depends on render N-1 (NOTES R1).

import { drawResolved } from './draw.js';

/** Frames to let pass before even looking, so the addon's postdraw composite has had a chance. */
const MIN_SETTLE_FRAMES = 3;
/** How long to keep waiting for two consecutive readbacks to agree before calling it a failure. */
const MAX_SETTLE_FRAMES = 90;

function afterFrames(n) {
  return new Promise((resolve) => {
    let left = n;
    const tick = () => {
      if (left-- <= 0) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Raw RGBA straight off the drawing buffer. Rows come back bottom-up; Node flips them. */
function readback(p) {
  const gl = p.drawingContext;
  const w = p.canvas.width;
  const h = p.canvas.height;
  const buf = new Uint8Array(w * h * 4);
  gl.finish();
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
}

function sameBytes(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Wait a few frames, then keep reading the drawing buffer once a frame until two consecutive reads
 * agree, and return the agreed image.
 *
 * A fixed frame count is not enough, and this is measured, not theoretical: with a flat five-frame
 * wait an 800x1200 render read back a partially composited frame whenever the machine was busy --
 * three other Chromium processes rendering at the same time was enough -- so the same program gave
 * different pixels depending on what else the computer happened to be doing. That is the same
 * mistake as a fixed warm-up count (NOTES R4) and it gets the same fix: wait for the property you
 * actually depend on. The minimum wait is kept so that two identical reads of a stalled compositor
 * cannot be mistaken for a settled frame.
 */
async function settledReadback(p) {
  await afterFrames(MIN_SETTLE_FRAMES);
  let previous = readback(p);
  for (let frames = MIN_SETTLE_FRAMES + 1; frames <= MAX_SETTLE_FRAMES; frames++) {
    await afterFrames(1);
    const next = readback(p);
    if (sameBytes(previous, next)) return { pixels: next, settleFrames: frames };
    previous = next;
  }
  throw new Error(
    `the frame never settled: ${MAX_SETTLE_FRAMES} readbacks and no two consecutive frames agreed, ` +
      'so this render cannot be trusted to be deterministic'
  );
}

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function glInfo(p) {
  const gl = p.drawingContext;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webglVersion: p.webglVersion,
    renderer: gl.getParameter(gl.RENDERER),
    vendor: gl.getParameter(gl.VENDOR),
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
  };
}

/**
 * @param {{resolved: object, pack: object, fonts: Record<string,string>}} request
 *   `fonts` maps a profile font name to a URL the page can fetch.
 * @returns {Promise<{width, height, pixels: string, gl: object, timings: object}>}
 */
window.__mediumRender = (request) =>
  new Promise((resolve, reject) => {
    const { resolved, pack, fonts } = request;
    const { width, height, brushScale } = resolved.canvas;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(e && e.stack ? e.stack : String(e)));
    };

    const sketch = (p) => {
      brush.instance(p);
      const loaded = {};
      p.setup = async () => {
        try {
          p.createCanvas(width, height, p.WEBGL);
          p.setAttributes('antialias', false);
          p.pixelDensity(1);
          p.noLoop();
          p.angleMode(p.DEGREES);
          // brush.load() must run after createCanvas: brush.fill() dereferences the renderer it
          // caches here and throws otherwise (NOTES L2).
          brush.load();
          // Cumulative across calls, so exactly once per page (NOTES L3).
          if (brushScale !== 1) brush.scaleBrushes(brushScale);
          for (const [name, url] of Object.entries(fonts ?? {})) loaded[name] = await p.loadFont(url);
        } catch (e) {
          fail(e);
        }
      };
      p.draw = () => {
        if (settled) return;
        try {
          const t0 = performance.now();
          drawResolved(p, brush, resolved, pack, loaded);
          const drawMs = performance.now() - t0;
          const t1 = performance.now();
          settledReadback(p)
            .then((read) => {
              if (settled) return;
              settled = true;
              resolve({
                width: p.canvas.width,
                height: p.canvas.height,
                pixels: toBase64(read.pixels),
                gl: glInfo(p),
                timings: {
                  drawMs: Math.round(drawMs),
                  readMs: Math.round(performance.now() - t1),
                  settleFrames: read.settleFrames,
                },
              });
            })
            .catch(fail);
        } catch (e) {
          fail(e);
        }
      };
    };

    try {
      new p5(sketch, document.body);
    } catch (e) {
      fail(e);
    }
  });

window.__mediumReady = true;
