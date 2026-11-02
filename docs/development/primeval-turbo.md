# Experimental Turbo fitting

This is a candidate, not a replacement for Maximum Detail. Select **Turbo** in the Optimization dropdown on upload or
re-process. Turbo is the default for new jobs. It runs
entirely in browser WASM and supports the same three sprite families and Mixed.
The selected form option controls the solver; URL flags no longer override it.
Worker callers can pass `primeval_turbo: true`; returned metadata marks it and
sets `primeval_exact: false`.

## Algorithm and change map

- `primeval-core/src/rgba/turbo.rs`: residual peaks from distinct cells;
  color-consistent local moments at several scales estimate center, covariance
  and orientation. Proposals become allowed ellipse/rectangle/isosceles-triangle
  geometry, compete alongside random exploration, and undergo adaptive mutation.
- `primeval-core/src/rgba.rs`: isolated Turbo proposal hook. Original search,
  RNG and alpha weights remain unchanged when Turbo is off. Turbo uses eight
  searches with 32 random candidates each, structured starts and patience 50.
- `primeval-render/src/turbo.rs`: direct source premultiplied RGBA fitting without
  the complete RGB reference or three-fit Mixed portfolio. Four passes with six
  starts refine using export-exact coverage. The initial canvas is repainted
  exactly before refinement so its acceptance test uses the exported composite.
- Empty-alpha error weight is 32 in Turbo versus 16 in the original fitter.
  Source hidden RGB is ignored. No source mask is applied to exports.
- Existing opaque background controls are preserved; each fitted primitive is
  one asset. Counts are never truncated or cut off by a timer. Cancellation and
  normal export stay available. Failed quality comparisons do not block export.

These are heuristic changes, not bit-identical acceleration. The explicit per-fit
search/refinement effort does not cap the user's requested primitive count.

## Pilot evidence and limitations

All figures below are single development runs, not statistical speed claims.
Some verification/build work overlapped trials, so repeat isolated paired timing
before publishing performance claims. Benchmark inputs were resized to the stated
fitting detail; these are not full-resolution source comparisons. Every trial,
including rejected variants, is retained under ignored `reference/primeval-turbo/`.

| Image / detail / shapes | Maximum PSNR | Fastest PSNR / seconds | retained Turbo PSNR / seconds |
|---|---:|---:|---:|
| Nahida / 128 / 400 | 27.94 | 26.91 / 7.69 | 28.06 / 5.96 |
| Furina / 128 / 400 | 28.94 | 28.37 / 12.67 | 28.64 / 7.53 |
| Furina / 512 / 400 | 25.78 | 25.29 / 29.47 | 25.54 / 27.61 |

The first four-pass 512 trial took 37.96s while other work was active; the final
repeat produced identical quality/geometry in 27.61s. This variability illustrates
why these single trials do not establish a reproducible speedup. The matching 512 Maximum Detail run took 144.80s and scored 25.78 dB. Never combine the 128-input
Maximum results with the 512-input results as a quality comparison.

Nahida overall PSNR improves, but opaque RMSE increases from 11.30 to 11.53 and
spill increases from 0.00002490 to 0.00007395 normalized alpha. Furina's opaque
RMSE improves from 10.69 to 10.24 and spill falls from 0.00017856 to 0.00009021,
but overall error remains worse than Maximum. Thus the quality gate is NOT met
across even these two cases. No universal quality improvement is established.

A first low-effort candidate ran in 3.11s but lost quality. A later 512-detail
two-pass trial ran in 24.24s but scored only 24.75 dB, below Fastest; that schedule
was rejected and the four-pass refinement restored. The final 512 trial approaches Fastest runtime, but repeatable runtime parity
and preserved Maximum Detail quality have not yet been established.

## Reproduction and next work

```sh
node scripts/benchmark-primeval-turbo.cjs input.png 400 128
npm run test:turbo
```

`PRIMEVAL_TURBO_PROFILES=turbo` runs only the candidate. The benchmark retains
source, target, PNG, SVG, geometry and metrics for every profile. Compare final
outputs, fixed crops and alpha spill; rendering FPS is not fitting time.

Tests cover shared count, all supported shapes, deterministic native fitting,
cancellation, hidden RGB, empty transparency, backgrounds, native PNG/SVG,
non-square/enlarged output and GIA in threaded and fallback builds. Existing
alpha/frozen-output, browser, hosting and deployment suites remain required.

At 512 detail, retained Turbo has lower opaque RMSE (15.09 vs Maximum 15.32)
and lower empty-area spill (0.00007965 vs 0.00013105), but worse overall
PSNR (25.54 vs 25.78) and alpha MAE (0.01207 vs 0.00942). Runtime approaches
Fastest in this pilot; the partial-alpha quality gap is still unresolved.
The local comparison gallery is `reference/primeval-turbo/index.html`.

Next: profile structured-search coverage and full-resolution RGBA replay without
reducing refinement, calibrate the direct-source loss against fine-detail crops,
and benchmark all nine inputs at 400/1,000 counts with original source sizes.
The experiment does not yet justify enabling Turbo by default.

## Contribution redistribution (2026-10-31)

After Turbo refinement, rank layers by squared visible alpha contribution using
suffix transmittance. Test the eight weakest layers (or all layers if fewer than
eight), removing one and proposing an exact-coverage residual replacement at the
top of the stack. This bounds additional search effort, never the user's count.
Accept only lower weighted RGBA loss with non-increasing opaque premultiplied
RGB error and empty-area alpha spill. Restore the full incumbent on rejection.
Cancellation is checked between trials and while ranking. Accepted replacements
publish all changed layer indices so the live preview follows the final ordering.

This is a first structural search stage, not coupled group refinement or a global
minimum-shape solution. Alpha MAE is not an acceptance constraint. The first
Nahida comparison at 128 detail / 400 shapes changed PSNR 28.06177 → 28.08673,
opaque RMSE 11.53313 → 11.52590, spill 0.00007395 → 0.00000905, and alpha MAE
0.00525405 → 0.00535793. Runtime 6.29 → 5.90 seconds is a single-run observation,
not a speedup claim. Both runs and all outputs: `reference/redistribution/`.

## Detail priority and structural trials (2026-10-31)

Turbo now uses deterministic target contrast at radii 1, 3 and 7 pixels to weight
RGB error from 1 to 4. The map uses alpha-compatible neighbors, ignores transparent
RGB, and applies consistently to candidate fitting, residual proposals, refinement,
and visibility ranking. The alpha penalty doubles (partial 4→8, empty 32→64)
to compensate for stronger RGB emphasis. Exact/Maximum Detail remains unchanged.
This is local structure detection, not facial recognition: texture can also receive
priority, and a tiny face lost during downsampling cannot be recovered.

Alternate redistribution trials rebuild two adjacent layers together. A separate
stage tests distributed adjacent layer swaps followed by color/opacity refitting.
Every retained structural trial improves weighted loss with non-increasing opaque
error and empty-area spill versus its immediate incumbent. Count stays fixed;
these are effort limits, not control limits. Global quality versus the previous
unweighted optimizer is not guaranteed. Split/merge with explicit region analysis,
full-resolution progressive fitting, and user-designated semantic focus remain open.

Retained 400-control / 128-detail pilots, before → after:
- Nahida PSNR 28.08673→28.39697; opaque RMSE 11.52590→10.57636;
  alpha MAE 0.00535793→0.00557646; spill 0.00000905→0.00002566.
- Furina PSNR 28.63651→28.53227; opaque RMSE 10.24219→10.00255;
  alpha MAE 0.00958826→0.01062754; spill 0.00009021→0.00006858.
- Manually selected face crops (128-pixel target coordinates): Nahida
  (20,30)-(95,75) composite RMSE 10.7514→10.3412; Furina (50,52)-(71,75)
  11.6837→11.9320. Thus face fidelity is NOT consistently improved.

Artifacts, including the rejected weaker-alpha trial and face crops, are under
`reference/detail-priority/`. Timing observations are single runs, not speed claims.

## Automatic structural regions (2026-10-31)

`rgba/structure.rs` replaces independent contrast weighting with connected color
region analysis. Flood fill compares adjacent pixels and the seed color to stop
slow color drift from merging an entire gradient. Only alpha-compatible neighbors
participate. Regions accumulate gradient tensors, contrast boundaries, color means,
area and bounding boxes. Deterministic rules classify smooth regions, oriented
contours, texture, and compact detail; area-weighted color rarity, boundary contrast,
and compactness produce relative importance. Nearby region priorities and multiscale
contrast distribute emphasis over both sides of fine features. Final weights stay
between 1 and 4. No positional/face template, learned model, or mask is used.

The shared weights govern residual proposal ranking, analytical fitting, refinement,
and control-retention importance. Remaining reconstruction error updates proposals
throughout fitting. All regions retain baseline weight 1: allocation is soft, with
no fixed per-region control quota. This is structural classification, not semantic
understanding of faces/expressions. Smooth but semantically important regions may
still rank below distracting structure. This only affects Turbo.

Paired 400-shape / 128-detail trials against the previous contrast-weighted fit:
- Nahida: PSNR 28.39697→28.25743, opaque RMSE 10.57636→10.89604,
  alpha MAE 0.00557646→0.00572342, spill 0.00002566→0.
- Furina: PSNR 28.53227→28.84653, opaque RMSE 10.00255→9.99958,
  alpha MAE 0.01062754→0.00933982, spill 0.00006858→0.00005808.
- Previously selected face crops: Nahida RMSE 10.34120→9.78963 (5.3% lower),
  Furina 11.93205→10.83565 (9.2% lower). These are small manually selected crops
  at 128 detail; the algorithm was not given their coordinates.
- Runtime observations 6.32s and 6.77s are not reproducible speed claims.

All outputs retained in `reference/structure-priority/`. Native tests cover
classification, bounded deterministic importance, distinctive feature preference,
transparent hidden-RGB invariance, weighted fitting math and budget/cancellation.
