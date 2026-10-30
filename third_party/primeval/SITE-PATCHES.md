# Website patches to Primeval 0.2.2

Upstream: https://github.com/domoarigatomrburato/primeval

Pinned commit: `41e3196b41f8a03b2e1d4bea726a9c5bd71db530`. Original MIT license is
retained in `LICENSE`. Rust sources and lockfile are included for rebuilding.

1. Feature `asset-triangle` retains the measured research constraint in
   `shapes.rs`, `joint.rs` and `asset_triangle.rs`. Three-point proposals,
   mutations and final geometry remain isosceles. Original angle bounds remain.
2. `approximate_drawing` exposes the final drawing and `render_drawing` encodes it
   without repeating optimization. The browser binding also returns the final
   structured geometry and SVG alongside PNG. No filesystem sidecar hook is used.
3. Triangle SVG keeps 12 decimal places; the other shape families keep the
   original three-decimal serializer. Triangle PNG export scales uniformly to
   preserve its one-asset geometry. Other PNG writers retain original behavior.
4. The count range covers `u32`; no time/step cutoff or quality gate was added.
5. Projection helpers are inlined to avoid copying intermediate vertex arrays.

For Maximum detail opaque fitting, the original RNG, seed handling, search effort, scoring, opacity/color solves,
periodic refits and final refinement schedules are unchanged. The static-site
adapter rejects mixed or unsupported shapes before calling this binding.

6. `background: "transparent"` selects a separate premultiplied RGBA engine
   (`primeval-core/src/rgba.rs`). Shape generation, mutations and rasterizers
   are reused; a convex constrained source-over color/opacity solve replaces
   RGB-only scoring. It retains 16 independent rounds and per-kind search effort,
   followed by three RGBA color/opacity refit passes over the full stack;
   these replace RGB-only refit/joint stages. PNG becomes RGBA and SVG omits
   the background. Opaque rendering and its golden fixtures are unchanged.

The bundled JS runtime is copied from the same release. A small optional worker
thread-count override supports benchmarking, without changing numerical output.
The WASM URL revision prevents an older cached RGB-only binary loading after
the RGBA adapter update.
Both deployed WASM variants enable SIMD; the threaded one uses the upstream
shared-memory flags and pinned nightly. Binaryen optimization does not enable
fast-math. See `docs/development/primeval.md` for parity evidence and measured runtimes.

7. Source-alpha quality refinement seeds from the complete opaque pipeline and
   replaces only a small coarse foundation. Safe opaque detail layers are frozen
   to original geometry/color/opacity. Boundary/foundation refinement uses export
   antialiasing, byte-rounded repaint guards and subpixel moves. This requires
   tiny-skia in core at runtime; RGB-only engine behavior remains unchanged.

8. Optional `render.fast` selects the site's latency-oriented search profile.
   The website exposes Fast (default) and Maximum detail. Fast changes search
   effort, refinement and placements, retaining every requested control.
   `transparent-fast` fits source RGBA directly after seeding RGB detail; interior
   geometry stays fixed while its color/opacity may improve. No source mask is
   applied. See `docs/development/primeval.md` for the exact profile settings.
9. RGBA scoring caches row moments, solves constrained alpha analytically and
   prunes with a conservative error bound. Exact coverage uses tiny-skia Mask;
   WASM compositing and ellipse/triangle projections use SIMD without fast-math.
   Tests compare masks, moments and solves to scalar/reference implementations.
   Phase timings are returned for profiling. Thread count defaults to at most 16;
   the scalar-hosting fallback runs the same profile and remains available.
