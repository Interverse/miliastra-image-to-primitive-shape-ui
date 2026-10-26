# Static Site (Global Version)

The repository root IS the deployable website: a fully static, browser-only
port of the Miliastra Wonderland image-fitting toolkit. It reproduces the
original Flask application's behavior with no backend — all image
processing, GIA generation and GIA mode conversion run client-side, and the
output is bit-exact to the original (see `tests/parity/README.md`).

## Deploying

**Option A — branch deploy (simplest):** repository *Settings → Pages →
Source → Deploy from a branch*, branch `main`, folder `/ (root)`.

**Option B — GitHub Actions:** `.github/workflows/pages.yml` uploads the
checkout on every push to `main`; set *Pages → Source* to **GitHub
Actions**.

No build step is required either way.

## Local development

Any static file server works (Workers require http://, not file://):

```bash
python -m http.server 8321
```

## Site layout

| Path | Role |
|------|------|
| `index.html` | Single-page app: upload/batch view, result view, GIA mode-conversion view |
| `css/style.css` | Material Design 3 styling |
| `js/app.js` | UI controller, batch job queue (one Web Worker per job, pooled by CPU count), result canvas + JSON/CSS/SVG/PNG/GIA exports |
| `js/worker-fill.js` | Fill mode — bit-exact port of the fogleman/primitive fitter (`js/gorand.js`, `js/gomath.js`, `js/goraster.js`) |
| `js/worker-gaussian.js`, `js/gaussian.js` | Browser Gaussian optimization and shared blurred radial falloff; see `GAUSSIAN.md` |
| `js/worker-outline.js` | Outline (decoration) mode — bit-exact port of `final_shaper.py` (`js/geometry.js` = Shapely/GEOS port) |
| `js/imaging.js` | cv2/NumPy-exact primitives (validated byte-identical) |
| `js/pynum.js`, `js/fillshaper.js` | CPython/NumPy-exact rounding & rasterizers |
| `js/gia.js`, `js/gia-export.js` | GIA writers (Asset Group, Server Image and Client Image templates) + overlimit/classic converters; the Asset Group path is byte-identical to the original |
| `js/png-decode.js` | Exact PNG decoder (byte-identical to cv2.imdecode) |
| `js/zip.js` | Minimal ZIP writer for batch downloads |
| `js/i18n.js`, `js/locales/*.js` | The 15 languages officially supported by Genshin Impact |
| `assets/*.gia` | Binary templates (`image_template.gia` = Asset Group; `blurred_circle_server.gia` = Server Image; `client_mask_off_template.gia` = Client generation template); other supplied GIA files are reference fixtures |
| `tools/gia-diff.js` | Structural dump/diff for `.gia` files (Node CLI); `window.GiaDebug` is the in-page twin |
| `docs/client-gia-format.md` | Client Control Template format survey |

Non-site directories: the legacy Python backend (`*.py`, `gia/`, `win/`,
`third_party/`), `demo/`, and `tests/parity/` (regression suites proving
port/original equivalence).

## Adding a language

1. Copy `js/locales/en.js` to `js/locales/<code>.js`, translate the values
   (never the `{placeholders}`), and set `window.LOCALES["<code>"]`.
2. Add a `<script>` tag for it in `index.html`.
3. Add the language to `LANGUAGES` in `js/i18n.js`.

Missing keys automatically fall back to English.
