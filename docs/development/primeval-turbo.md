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
