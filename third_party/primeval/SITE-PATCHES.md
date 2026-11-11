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

14. Lines and curves (Turbo only; Maximum Detail and Fast are unchanged). A Turbo fit
    holds a 64:1 rectangle aspect cap and a 5 degree triangle minimum angle
    (`primeval-render/src/turbo.rs`): the game scales its rectangle and isosceles
    triangle sprites freely, so a straight line or a tapering stroke can be one
    shape. `asset_triangle.rs` `TriangleAngle` and `shapes.rs` `RectAspect` are
    process-wide while held; holders are counted and the upstream defaults return
    when the last fit ends. Polygon validity and Turbo rectangle projection follow
    the held values. Default arithmetic is unchanged when nothing is held. Run Rust
    tests with `--test-threads=1`: a Turbo test fit holds the values for the whole
    process. After Turbo refinement, `clear_gaps` (`rgba/turbo.rs`) cleans paint
    left over (nearly) transparent source pixels: one refinement pass of only the
    layers covering it with that opacity error weighted 16 times, then up to eight
    remove-and-replace trials; each change is kept only if the composite error over
    black and white falls, and the count never changes. `mark_faint_holes` gives
    small faint holes inside opaque areas the clear-pixel opacity weight, so early
    shapes do not cover them and leave dark patches. Spill-aware reordering
    (`reorder_spill`) and shape merging (`merge_turbo`) are research options,
    off by default; they gained at most 0.1-0.2%. Edge-aligned proposals
    (`rgba/lines.rs`, `Execution::line_proposals`) are a research option, off by
    default. Small-feature weighting and feature proposals (`rgba/features.rs`)
    are lab-only research options set through `Execution::lab_params`, off by
    default; the weighting failed fresh blinded review. The WASM binding accepts
    `render.experimental` (`lineVariant`, `extraRounds`, `labParams`) so the site's
    Experimental settings can turn these on; `dist/request.js` passes it through.
    Edge detection runs only when an edge proposal kind is chosen. See
    `docs/development/primeval-turbo.md` in the site root.
# Source-aware contour fitting

Turbo now accepts `Execution::contour_smoothing` / browser
`render.contourSmoothing` (finite0..4). The website automatically uses1; the
library default0 preserves the original numerical path and Maximum Detail.
`rgba/contours.rs` uses original premultiplied-RGBA structure tensors to penalize
visible unsupported polygon turns and boundaries misaligned with source edges.
Source corner evidence relaxes the prior. Later-layer transmission suppresses
cost on occluded boundaries. The same geometry/paint families, complete search
rounds, requested counts, cancellation and exported assets remain in use.

Search and conditional refinement use a bounded contour prior; full refinement
passes and Turbo replacement/reordering guards evaluate pixel loss plus visible
contour cost. Pixel-prefix sums and reported reconstruction loss remain in their
original units. Rejected smoothing refinement passes restore progress geometry,
so pause/export checkpoints reflect the accepted construction. See
`docs/development/smooth-contours.md` for measured benefits and regressions.

# Retired construction experiment

2026-11-04: removed the failed nested-group/scaffold construction paths, their
proposal/audit APIs and lab runners. Exact working-tree sources and generated
vendor files were archived in the site's ignored
`reference/retired-construction-experiment-2026-11-04/` before removal.
Ordinary fitting, Focus, native vector progress and pinned Maximum Detail remain.


## Animation warm starts

The WASM `refineFrame` entry point accepts decoded RGBA and a retained Primeval
Drawing. `primeval-render::refine_animation_rgba` and `RgbaModel::seed_temporal`
run short, adaptive local passes while retaining the selected shape count, assets
and painter sequence. Temporal candidate scoring uses covered-pixel sums and
small geometric steps; unweighted error supports the browser's quality guard.
All altered search branches are gated by a temporal flag, false for ordinary
Primeval fitting. `renderRetained` shares its drawing parser with the new API.
Both SIMD single/threaded WASM builds are regenerated with the existing build
script. Static JSON output and still-image optimization semantics are preserved.


The default-quality animation update adds cropped per-layer bases and bounded
checkpoint replay, motion prediction before refinement, attended-region error,
Focus-priority repair and batched residual replacement without changing counts.
Retained native identity maps accompany animation results separately from the
Drawing/JSON schema. Static refinement retains full bases and its original math.
