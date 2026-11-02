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

8. Optional `render.fast` enables exact RGBA scratch/coverage acceleration.
   Fast and Maximum detail now retain the same RNG streams, candidate counts,
   working resolution, search/refinement schedules and placements. Optional
   `render.fastest` restores the earlier reduced-effort/multiscale algorithm as
   Fastest, including `transparent-fast` source-alpha fitting. The default is
   Fast. Neither mode cuts requested controls or uses a timer cutoff. Nine
   frozen original Fast fixtures check Fastest geometry, SVG, PNG and previews.
9. RGBA scoring caches row moments, solves constrained alpha analytically and
   prunes with a conservative error bound. Exact coverage uses tiny-skia Mask;
   WASM compositing and ellipse/triangle projections use SIMD without fast-math.
   Tests compare masks, moments and solves to scalar/reference implementations.
   Phase timings are returned for profiling. Thread count defaults to at most 16;
   the scalar-hosting fallback runs the same profile and remains available.

10. Native AA endpoints are quantized once in the original arithmetic order.
    Common-column rows bypass sorting; integer SIMD queries retain the original
    coverage sums. RGB's ordinary single-batch color solve uses bounded i64
    arithmetic with identical rounding, retaining the original large-image path.
11. `vendor/tiny-skia` pins the original 0.12.0 source and BSD-3-Clause license.
    Its optional cleared-mask blitter bypasses generic white-over-black blending
    while preserving scan conversion and byte coverage. Worker, path, mask, scan-edge
    and row-moment allocations are reused only in the accelerated RGBA path.
    See its SITE-PATCHES.md and the Fast/Maximum detail browser equality checks.


12. `mixed` is a new abstract palette; the original `any` palette and every
    original concrete-family RNG stream remain unchanged. The website compares
    complete ellipse/rectangle/asset-triangle fits at the same count, then uses
    equal-area family replacements and local RGBA/color/opacity refinement.
    Actual exported-pixel loss guards both opaque detail and transparent spill.
    Existing background controls are preserved; no source-alpha export mask is
    added. See `docs/development/primeval-mixed.md` at the repo root.

## Experimental Turbo

Direct source-RGBA fitting, residual moment proposals and unified shape-family
competition are isolated in `primeval-core/src/rgba/turbo.rs` and
`primeval-render/src/turbo.rs`. Opt-in only; output differs and quality/runtime
gates remain unmet. See `docs/development/primeval-turbo.md` in the site root.

13. Research options for automatic importance, all off by default, keep the
    default output byte-identical: attention fusion terms (`strength`,
    `additive` up to 4, `refine`, attended transparent-pixel penalty),
    proposal-only and structural proposals, measured redistribution ranking and
    trial count (`rgba.rs`, `rgba/turbo.rs`, `primeval-render/src/turbo.rs`).
    `rectAspect` raises the rectangle aspect cap (default 8, upstream's "reads as a
    rectangle" choice; the game has no aspect limit) through a process-wide value
    held for one Turbo fit (`shapes.rs` `RectAspect`, `mixed.rs` replacement).
    Triangles stay isosceles. See `docs/development/automatic-importance-*.md`.
