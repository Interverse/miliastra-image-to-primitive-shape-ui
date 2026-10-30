# Miliastra Wonderland Image Fitter

A static, browser-only tool that fits images with game UI shapes and exports
PNG, SVG, CSS, JSON, Lua and GIA. Images are processed locally.

- **Primeval:** one selected shape family: benchmark ellipses (Circle),
  single-asset isosceles triangles, or rotated rectangles. Rectangle is default.
- **Gaussian:** blurred circles using the existing Gaussian fitters.
- **Legacy:** the original browser fitter, with one selected solid shape family.

## Run

Serve this directory over HTTP; workers cannot run from `file://`:

```sh
python -m http.server 8321
```

Open http://localhost:8321/. GitHub Pages deploys the root directory using
`.github/workflows/pages.yml`. No build or npm installation is needed to serve it.

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `coi-sw.js`, `css/`, `js/`, `assets/` | Deployed website and bundled runtime dependencies |
| `docs/development/` | Implementation notes, limits and build instructions |
| `tests/` | Current fitting/export tests and small fixtures |
| `scripts/` | Offline build tools |
| `third_party/primeval/` | Exact Rust sources and lockfile for the shipped WASM |
| `LICENSE`, `LICENSES/`, vendor license files | Redistribution notices |
| `reference/` | Ignored research, benchmarks, toolchains and legacy applications |

## Develop and verify

```sh
npm test
npm install
npm run test:browser
npm run test:hosting
```

Unit tests need Node and Python; browser checks additionally need Playwright and
Chrome or its installed Chromium. The browser runner supports `CHROME_PATH` and
`PLAYWRIGHT_MODULE`. Optional Lua VM and generated historical golden cases are
reported as skipped when absent.

See [Primeval](docs/development/primeval.md) and
[Gaussian](docs/development/gaussian.md) for fidelity and performance limits.
