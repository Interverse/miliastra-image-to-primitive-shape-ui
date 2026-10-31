# Primeval implementation

The website runs Primeval 0.2.2's Rust engine, pinned to commit
`41e3196b41f8a03b2e1d4bea726a9c5bd71db530`, through locally bundled WASM.
Source and modifications are in `third_party/primeval/SITE-PATCHES.md`.

Default settings: Mixed, 2,000 shapes, 512-pixel fitting detail, seed 42 and automatic
shape opacity. Background and game containers are extra controls. Circle uses
rotated ellipses; Rectangle uses rotated rectangles. Triangle is constrained
throughout fitting to local X/Y scale and rotation of one triangle asset.

Draft was previously labeled Fastest. Its stored/API profile remains `fastest`
for saved-job compatibility; it still offers a lower-effort alternative to Turbo.

The Optimization selector contains **Turbo**, **Draft** and
**Maximum Detail**, with
**Turbo** selected by default. The latter runs the accelerated exact
`fast` implementation. The unaccelerated `quality` profile remains an internal
regression oracle; older jobs using it reopen as Maximum Detail and run `fast`
when reprocessed. Upload and re-process share the same options.

The first speed iteration removes the intermediate RGB reference PNG encode/decode
by passing its decoded RGB bytes directly into the unchanged fitting pipeline.
Worker metadata now separates input preparation, fitting/native export (including
startup), output decoding, control conversion and preview/source preparation.
Engine phase markers distinguish RGB preparation/search/final refinement where
available. These are inclusive markers, not additive kernel timings.
`scripts/profile-primeval.cjs input.png triangle 400 512` retains the original
source dimensions, output, hashes and timings under ignored `reference/primeval-profiles/`.
This is profiling groundwork, not a demonstrated major speedup or a new search
algorithm. Structured proposals and direct RGBA search remain future experiments.

Fast and Maximum Detail run the complete pinned RGB search, periodic refits and
final refinement, then the same reference-preserving alpha path described below.
Fast does not reduce candidate counts, patience, passes or fitting resolution.

**Draft** restores the earlier ~20-second Fast algorithm: two RGB rounds with
64 candidates and age 35, two refinement climbs and the original shorter refit
schedule. Rectangles and triangles retain joint optimization. Transparent images
use source RGBA colors, localized residual placement and shorter alpha passes.
Above 256 pixels, the RGB seed starts at 128 pixels (growing with the square root
of the requested control count), while RGBA fitting/output keep the selected
detail. This mode can produce different placements and quality from Fast.
It never cuts the requested control count or stops on a timer. Runtime still
depends on the image, detail, count and browser hardware.

Browser requests use `render.fastest` for the restored profile and
`render.fast` for equivalent full-search acceleration. `transparent-fast`
activates the earlier alpha strategy only with `fastest`; otherwise it retains
the reference-preserving compatibility behavior.

Fast enables allocation reuse for RGBA workers, paths, masks, edge lists and row moments.
The native rasterizer quantizes endpoint overlaps once, emits common spans
directly and checks narrow rows in independent integer SIMD lanes. The ordinary
single-batch RGB color solve avoids unnecessary software i128 arithmetic while
retaining its original rounding and large-image fallback. tiny-skia's optional
coverage-only blitter keeps its original scan conversion and supersampling.
No fast-math, source-alpha mask, requested control-count reduction or timer cutoff is used.
Maximum detail remains an independent RGBA reference without these scratch and
coverage-blitter shortcuts. All raster changes preserve the pinned output.

`npm run test:alpha` compares Fast and Maximum detail drawings, converted control
geometry, SVG text, PNG bytes and preview bytes for all three shape families,
with opaque and semitransparent targets, in threaded and single-thread browsers.
A 320-pixel case also checks that Fast retains the selected fitting resolution.
Fastest is checked against nine frozen original Fast output hashes (geometry,
SVG, PNG and preview), including opaque/transparent and 320-pixel inputs.
These small generated fixtures live in `tests/primeval/fixtures/fastest.json`.
Rust tests also compare coverage against the original tiny-skia pipeline and
native per-pixel oracles. Larger local runs retain frozen pre-change WASM,
full geometry and independently rendered controls under ignored
`reference/primeval-exact-*`; every trial output is retained.

Cold browser measurement on the development laptop: Nahida, source alpha,
2,000 controls, 128-pixel fitting detail, seed 42, 16 workers. Time includes
startup and preview/control rendering. The frozen pre-change Maximum detail
and the optimized output have identical drawings, native pixels and control pixels.

| Shape | Frozen Maximum detail | Exact Fast |
|---|---:|---:|
| Triangle | 73.93 s | 52.52 s |
| Circle / ellipse | 67.95 s | 52.60 s |
| Rectangle | 39.77 s | 25.90 s |

These are single measurements; repeated trials vary with hardware load.
The default 512-pixel detail can take longer.

The 20-second target has not been reached with exact Maximum detail output.
Do not use the old reduced-quality Fast timings as measurements of this path.
Runtime depends on count, detail, source and browser hardware; the full search
and cancellation remain available even when it exceeds 20 seconds.

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
Other inputs use RGB fitting and its RGB(240,240,245) matte unless overridden.
The Maximum detail alpha-aware path first runs the complete pinned opaque pipeline, including
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

SIMD, multithreading, cached scoring and binary optimization improve runtime.
Fast and Maximum detail keep identical search effort, placements and refinement
schedules; Fast changes only equivalent implementation details. `coi-sw.js` enables isolation on static hosts;
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

[Mixed mode](primeval-mixed.md) compares complete single-family fits and then
reconsiders geometry types without adding controls. It is optional, takes longer,
and preserves the best baseline when its exported-pixel guard rejects a candidate.

[Experimental Turbo](primeval-turbo.md) implements direct source-RGBA search with
structured proposals. Select it in the Optimization dropdown. It has not passed the default-detail
Fastest-runtime / Maximum-Detail-quality gate.

Batch scheduling allows multiple Primeval jobs at once, using the same hardware-based
queue concurrency as other engines. Each new batch shares logical CPU threads
across its active slots (at most 16 threads per Primeval fit). Separate pooled
worker URLs key the pool by thread budget so reused WASM instances do not retain
an incompatible pool size. Cancellation and fitting count/detail are unchanged.
