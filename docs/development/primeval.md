# Primeval implementation

The website runs Primeval 0.2.2's Rust engine, pinned to commit
`41e3196b41f8a03b2e1d4bea726a9c5bd71db530`, through locally bundled WASM.
Source and modifications are in `third_party/primeval/SITE-PATCHES.md`.

Default settings: 2,000 shapes, 512-pixel fitting detail, seed 42 and automatic
shape opacity. Background and game containers are extra controls. Circle uses
rotated ellipses; Rectangle uses rotated rectangles. Triangle is constrained
throughout fitting to local X/Y scale and rotation of one triangle asset.

With PNG mode off, the optional custom-background picker composites transparent
source pixels onto the selected RGB color and uses it as the fitting canvas
background. `background_color` is retained in job/export configuration; PNG,
SVG and background controls share the selected color. PNG mode ignores this
setting. Leaving custom background off preserves the original default output.

Final PNG, SVG and geometry come from one fit. Untouched PNG/SVG exports retain
the native output; edits invalidate that cache and undo restores it. Tests
include frozen native PNG/SVG fixtures, six GIA variants and cancellation.

The six browser modules in `js/vendor/primeval/dist/` are required runtime files
and are explicitly exempted from the generic `dist/` Git ignore. Pages runs
`scripts/prepare-pages.py` to validate and copy only runtime files into
`.pages-site/` before uploading. Missing imports or ignored runtime files fail
the deployment. `npm run test:deployment` fits all three shapes from that
artifact under a GitHub Pages project subpath and checks exact PNG fixtures.

PNG mode now fits source transparency through a site-specific RGBA extension.
It is activated only for inputs with non-opaque alpha and PNG mode enabled.
Other inputs keep the original RGB path and its RGB(240,240,245) matte.
The alpha-aware path first runs the complete pinned opaque pipeline, including
its original joint refinement. Its native render supplies the opaque-color
reference; source alpha supplies the transparency target. A small coarse
foundation is rebuilt with alpha, replacing the same number of original layers.
The later original detail layers remain in order. Layers safely inside opaque
regions (including a one-pixel margin) retain their exact original geometry,
color and opacity. Total painted-control count stays at the requested value. Fully invisible controls
are recycled for residual detail correction after refinement; the count does not
increase. The corrected result receives another guarded refinement pass.

Boundary and foundation layers receive subpixel geometry/color/opacity refits.
Seeded refinement uses the same tiny-skia antialiasing as PNG output, byte-rounded
forward compositing and checkpoint replay bounded by the upstream memory plan.
Passes are accepted only when the repainted loss improves; refinement stops at
convergence or after twelve internal passes. User-selected counts are not capped
or truncated. If reference geometry cannot be adopted, a full RGBA candidate is
still produced rather than blocking export.

This remains a site extension, not upstream RGBA parity. No source-alpha mask is
reapplied to previews or exports. PNG and standalone controls are compared
separately because their renderers differ even for the original algorithm.
Finite primitive counts can still leave edge spill. Game texture rendering has
not been calibrated as pixel-identical. Research comparisons and iteration
outputs remain ignored in `reference/primeval-quality-*`.

Previous opaque 2,000-shape browser runs on the development laptop: rectangles about
10 seconds, ellipses about 37 seconds, constrained triangles 38â€“51 seconds.
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

Measured 256×256 Nahida check (2,000 rectangles): opaque-area PNG RGB MAE
1.49/255 versus original, standalone controls 1.72/255; mean control alpha
in empty source pixels 0.063/255. Smaller 128px stress cases remain more
variable. Keep PNG/control renderer comparisons separate and retain failed
strict diagnostic results. Do not promise pixel-perfect matching or a 20-second
runtime: development cases can take minutes in this quality path.
