# Primeval implementation

The website runs Primeval 0.2.2's Rust engine, pinned to commit
`41e3196b41f8a03b2e1d4bea726a9c5bd71db530`, through locally bundled WASM.
Source and modifications are in `third_party/primeval/SITE-PATCHES.md`.

Default settings: 2,000 shapes, 512-pixel fitting detail, seed 42 and automatic
shape opacity. Background and game containers are extra controls. Circle uses
rotated ellipses; Rectangle uses rotated rectangles. Triangle is constrained
throughout fitting to local X/Y scale and rotation of one triangle asset.

Final PNG, SVG and geometry come from one fit. Untouched PNG/SVG exports retain
the native output; edits invalidate that cache and undo restores it. Tests
include frozen native PNG/SVG fixtures, six GIA variants and cancellation.

The six browser modules in `js/vendor/primeval/dist/` are required runtime files
and are explicitly exempted from the generic `dist/` Git ignore. Pages runs
`scripts/prepare-pages.py` to validate and copy only runtime files into
`.pages-site/` before uploading. Missing imports or ignored runtime files fail
the deployment. `npm run test:deployment` fits all three shapes from that
artifact under a GitHub Pages project subpath and checks exact PNG fixtures.

Source transparency is currently flattened onto RGB(240,240,245); this is not
alpha-aware silhouette fitting. Shapes may be placed in originally transparent
regions. Source alpha is not reapplied to the fit. Game rendering/quantization
has not been established as pixel-identical to native PNG.

Measured 2,000-shape browser runs on the development laptop: rectangles about
10 seconds, ellipses about 37 seconds, constrained triangles 38–51 seconds.
Twenty seconds is not guaranteed. Counts and refinement are never cut short to
meet a timer; requests above the old 100K cap are accepted up to the engine's
32-bit representation/resource limits and remain cancellable.

SIMD, multithreading, instance reuse and binary optimization improve runtime
without reducing fitting work. `coi-sw.js` enables isolation on static hosts;
an output-equivalent single-thread fallback works without it, but is slower.

## Rebuild (Windows)

The committed WASM files need no deployment build. To rebuild, use
`scripts/setup-primeval-build.py` and `scripts/build-primeval.py single` / `threaded`.
Tools: Rust 1.99.1, nightly-2026-10-12 with rust-src, wasm32-unknown-unknown targets,
wasm-bindgen 0.2.129, optionally Binaryen 133 without fast-math.

The scripts keep downloaded tools and build outputs under ignored
`reference/research-2026-10/primeval-constrained/`. Install the Rust toolchains
there using matching `CARGO_HOME`/`RUSTUP_HOME` values before building. Set
`PRIMEVAL_STABLE_TOOLCHAIN=1.99.1` if the stable alias points elsewhere.
