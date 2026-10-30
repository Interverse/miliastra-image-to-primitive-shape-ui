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

The original RNG, seed handling, search effort, scoring, opacity/color solves,
periodic refits and final refinement schedules are unchanged. The static-site
adapter rejects mixed or unsupported shapes before calling this binding.

The bundled JS runtime is copied from the same release. A small optional worker
thread-count override supports benchmarking, without changing numerical output.
Both deployed WASM variants enable SIMD; the threaded one uses the upstream
shared-memory flags and pinned nightly. Binaryen optimization does not enable
fast-math. See `docs/development/primeval.md` for parity evidence and measured runtimes.
