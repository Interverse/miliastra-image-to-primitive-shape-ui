# Website development instructions

Keep explanations short and concrete.

This is a static, browser-only website. `index.html`, `css/`, `js/`, `assets/`
and `coi-sw.js` are runtime files. There is no active Flask backend or deployment
build. Serve the root over HTTP, usually port 8321. GitHub Pages uses
`.github/workflows/pages.yml`.

## Layout

- `js/app.js`: upload, queue, results, editing and export controller; presets are inline.
- `js/worker-primeval.js`, `js/primeval-result.js`: pinned Rust/WASM fitting and asset conversion.
- `js/worker-gaussian.js`, `js/worker-fill.js`, `js/worker-outline.js`: other fitting engines.
- `js/gia.js`, `js/gia-export.js`, `js/lua-export.js`: export and conversion.
- `js/locales/`: all 15 supported languages.
- `docs/development/`: current implementation notes and limitations.
- `tests/`: fitting/export regressions and small reference fixtures.
- `scripts/`, `third_party/primeval/`: offline build tools and pinned Rust source/Cargo.lock.
- `reference/`: ignored research, benchmarks, caches and archived Python/Docker/Windows tools.

## Required practices

1. Update `index.html` and the relevant JS/CSS for frontend changes. The archived
   `server.py` and `web/` are historical and are not the deployed frontend.
2. Localize every UI change in all 15 languages. Keep labels, buttons and hints
   brief and limited to information users need.
3. Use consistent spacing and form components. Check upload, result, decoration
   and GIA conversion pages at desktop and narrow widths. Hidden controls must
   occupy no space.
4. Do not cap or silently truncate user-selected fitting steps or counts. Keep
   cancellation. Representation/resource limits must fail explicitly.
5. Primeval and Legacy allow exactly one solid shape family. Gaussian uses only
   blurred circles. Circle in Primeval means benchmark rotated ellipses.
6. Preserve the pinned fitting output and single-asset triangle constraint.
   Do not fake transparency or quality by reapplying source alpha after fitting.
7. Preserve runtime dependencies, game assets and redistribution licenses.
8. Run relevant unit/export tests (`npm test`) and browser checks
   (`npm run test:browser`, `npm run test:hosting`) when behavior changes.
   Optional historical golden cases may be skipped when not generated; report it.
9. Keep research reports, large generated outputs, toolchains and obsolete
   applications ignored. Keep useful source, build tools, fixtures and docs tracked.
