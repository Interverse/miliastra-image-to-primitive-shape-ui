# Primeval Mixed mode

Select **Primeval → Mixed** on upload or re-process. Mixed is the default;
Legacy still allows one family. Circle in Mixed means the same rotated ellipses
as the existing Circle mode. All labels/hints have all 15 translations.

Mixed uses one shared fitted-shape budget. Each selected layer is one existing
circle/rectangle/triangle game asset. Existing background/container overhead is
unchanged; no masks, arbitrary triangles or extra masking controls are introduced.
All computation remains local Rust/WASM and works on GitHub Pages, including the
single-thread fallback. Mixed runs its portfolio/refinement in WASM.

## Selection and refinement

1. Run the unchanged triangle, ellipse and rectangle fitters with the selected
   count, detail, seed and Optimization profile.
2. Independently render each candidate and retain the best complete export.
3. Import its continuous geometry and existing background, then reconsider each
   layer's family while refining position, scale, rotation, color and opacity.
   Alternative starts preserve approximate area and orientation. Two local passes
   use six deterministic starts per layer, including the original geometry.
4. Accept the revised drawing only if its actual exported-pixel loss is lower,
   opaque-region error does not rise, and transparent-area alpha spill does not
   rise. Otherwise return the intact incumbent. Invalid candidates are skipped;
   cancellation still stops the job.

The loss compares premultiplied output against source composited on both black
and white at actual PNG output resolution. This prevents a dark or light matte from hiding
alpha errors. No source-alpha mask is applied to output. Preserving the background
when importing opaque fits is essential: importing onto transparent black would
change the composite before any optimization.

Mixed is a quality mode and takes longer. A larger palette alone does not
necessarily improve a greedy fit: the initial unguarded 400-shape Nahida trial
scored 25.89 dB versus triangles at 26.60 dB. The guarded method can retain a
single-family result when mixed replacements fail its tests. It does not force
bad shapes into an image just to use all three families. Gains include both type
replacement and additional source-aware geometry/color refinement; they are not
an isolated measurement of mixing alone.

## Measured outputs

All trials below use 128-pixel input/output, 128-pixel fitting detail and Fast,
with the same input and shape count per family. PSNR is measured over black/white composites; higher is
better. These are image-specific results, not a universal perceptual guarantee.

| Image | Shapes | Best single PSNR | Mixed PSNR | Result |
|---|---:|---:|---:|---|
| Nahida | 400 | 26.60 | 27.94 | 14.3% lower composite RMSE |
| Furina | 400 | 28.28 | 28.94 | 7.3% lower composite RMSE |
| VoxEdit | 400 | 28.65 | 29.46 | 8.9% lower composite RMSE |
| Nahida | 1,000 | 32.57 | 32.57 | Original triangle fit retained |
| VoxEdit | 1,000 | 34.71 | 36.70 | 20.5% lower composite RMSE |

Opaque error and transparent spill did not increase relative to the selected
best-single incumbent in the accepted results.
The 400-shape Nahida output contains 342 triangles, 35 rectangles and 23 ellipses;
VoxEdit at 1,000 has 933 triangles, 51 rectangles and 16 ellipses. All are visible.
Opaque images retain their pre-existing background control in every comparison.
An additional full-resolution Furina test retains the original 1,080-pixel input
and output, fitting at detail 128 with 400 shapes. Mixed improves the best single
family (ellipses) from 22.43 to 22.68 dB, reduces composite RMSE by 2.9%, and
reduces transparent spill by 25.2%. It selects 255 ellipses, 73 rectangles and 72
triangles. This verifies the guard at export resolution; it does not imply that
128-pixel fitting reproduces all full-resolution detail. Its outputs are in
`reference/primeval-mixed/furina-400-full-output/`.
The local gallery and every source/PNG/SVG/drawing/metric are ignored under
`reference/primeval-mixed/`.

```sh
node scripts/benchmark-primeval-mixed.cjs input.png 400 128
npm run test:mixed
```

The benchmark preserves aspect ratio, resizes input to fitting detail and retains
all four families' outputs. `PRIMEVAL_BENCH_SHAPES=mixed` can run only Mixed.
Runtime varies: local Mixed samples took about 32–43 seconds for 400-shape
transparent images and the 1,000-shape VoxEdit case took about 43 seconds.
This mode does not meet the earlier 20-second target.

## Change map and checks

- `primeval-core/src/mixed.rs`: deterministic family palette and equal-area
  replacement frames; native tests cover local search and sprite constraints.
- `primeval-core/src/rgba.rs`: background-preserving import, Mixed-only type
  starts and local refinement. The old single-family arithmetic stays intact.
- `primeval-render/src/mixed.rs`: portfolio, actual-export quality guard,
  progress/cancellation and fallback. Native tests cover both background modes.
- `js/worker-primeval.js`: Mixed request and exported shape-count metadata.
- `js/app.js`, `index.html`, `js/locales/fitting.js`: selector and re-process UI.

`test:mixed` checks fixed counts, all profiles, Fast/Maximum Detail identity,
hidden RGB, empty transparency, backgrounds, SVG and GIA in both browser builds.
Existing frozen single-family outputs, hosting and project-subpath deployment
checks remain required. There are no count/timer truncations.

Research context: [Geometrize](https://github.com/Tw1ddle/geometrize) supports
multi-family geometric fitting and publishes fixed-count comparisons. The
[Neural Primitive Assembly paper](https://openaccess.thecvf.com/content/ICCV2023/papers/Chen_Editable_Image_Geometric_Abstraction_via_Neural_Primitive_Assembly_ICCV_2023_paper.pdf)
identifies primitive assignment and continuous fitting as distinct optimization
problems. This implementation uses deterministic discrete family replacement and
Primeval's existing numerical optimizer, with no learned model or new dependency.
