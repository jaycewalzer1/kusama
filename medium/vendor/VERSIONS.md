# Vendored runtime

Everything the renderer needs is committed here. The page never fetches a CDN: `env/browser.ts`
serves these files to the browser itself, so a render works with the machine offline.

| file | version | sha256 |
| --- | --- | --- |
| `p5.min.js` | p5.js 2.2.0 | `994ad50423ab4190681ba0f7539fe3f65d22011d065fdba50a5150654747522c` |
| `p5.brush.js` | p5.brush 2.1.0-beta | `05584f6275af53d80ca6b3e8c1daa02c6c899145fd006a31add9d9efb2761190` |

Fonts live in `/fonts` and are hashed into the trace as well:

| file | face | sha256 |
| --- | --- | --- |
| `grotesque.ttf` | PT Sans (OFL) | `9cc831490532009bae2b3ce0d39c62adfc889060beb421593bfd9d2396d0f10a` |
| `serif.ttf` | PT Serif (OFL) | `a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a` |

Licence text for both faces: `/fonts/OFL.txt`.

## Browser

Chromium comes from `playwright@1.55.0`, installed into `medium/.browsers` via
`PLAYWRIGHT_BROWSERS_PATH=$PWD/.browsers npx playwright install chromium`. The revision in use is
recorded in every `trace.json` under `manifest.browser`, together with the launch flags and the
WebGL renderer string, because determinism is only claimed within one such configuration.

Current: Chromium build `chromium-1187`, run with `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader` so rasterisation is CPU-side and does not depend on the host GPU.
