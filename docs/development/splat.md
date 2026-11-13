# Splat

Splat is a browser port of [mw_splat](https://github.com/BillGoldenWater/mw_splat)
(MPL-2.0, commit 8c3951a). It fits an image with soft-edged rectangles and
exports only JSON and a client Lua script. There is no GIA, CSS, SVG or PNG
output for this method.

## Files

| File | Purpose |
| --- | --- |
| `js/splat-core.js` | Kernel, initializer, loss, Adam, redistribution, element and JSON conversion |
| `js/splat-gpu.js` | WebGPU fitter: upstream's tiled GPU passes, used when available |
| `js/worker-splat.js` | Job worker: backend choice, downsampling, progress, previews, pause checkpoints, threads |
| `js/worker-splat-band.js` | Helper that computes loss and gradients for a band of rows |
| `js/splat-preview.js` | WebGL2 raster for the editor, with a CPU fallback |
| `js/splat-export.js` | Packed Lua script and JSON fields |
| `js/locales/splat.js` | Strings for all 15 languages |
| `tests/splat/run_tests.js` | Gradient, fitting, JSON and Lua checks (runs the Lua when `lua` or `texlua` exists) |

## Model

Each splat has a position, size, rotation, premultiplied colour and an X/Y
scale. Its shape is a solid core with a soft ramp around it. The ramp is
`min(size / 2, 64 × height / 900) × scale`, which matches the game stretching
image 106057 with fixed-size soft corners on a 900-unit-tall canvas. Splats are
drawn in order with normal "over" blending.

The fitter follows upstream: blue-noise start, mean-shift background for opaque
images, the black/white backdrop loss, Adam without bias correction, and the
same learning rates. Splats are moved from low-loss to high-loss areas every
200 steps. Unlike upstream, no move happens after the last step, so every
splat is fitted before export.

With WebGPU, `splat-gpu.js` runs upstream's passes (tile binning, render,
backward, Adam, redistribution) with three browser changes: immediates become
uniform buffers, f32 atomics become a workgroup reduction plus
compare-exchange, and loss weights sit after the reference so the backward pass
stays within 8 storage buffers. Bin overflow follows upstream: skipped passes,
a doubled bin buffer and replayed iterations. Buffers larger than the device
allows fail with `SPLAT_GPU_LIMIT`; other WebGPU failures fall back to the CPU.
`config.splat_backend` records `webgpu` or `cpu`.

Without WebGPU, each step walks every splat's rotated rectangle row by row,
which gives the same result. The image is split into row bands, one per helper
worker. With cross-origin isolation the bands share memory; without it the
parameters and gradients are copied each step. Helpers start from a blob,
because some embedded browsers block nested workers loaded by URL. If helpers
cannot start, the job runs on one thread.

Speed, 2,000 splats and 3,000 steps on a 231 × 233 image (RTX-class GPU,
16-thread CPU): WebGPU about 6 s for the whole job, the CPU bands about 38 s,
upstream's native build about 7 s. One GPU step matches the CPU fitter to about
1e-5 and moves the same splats when redistributing (`tests/splat/gpu_parity.html`).

Accuracy: the final loss varies several-fold between seeds and between runs, in
upstream too (2e-4 to 1e-3 on that image). Without redistribution the port and
upstream match statistically. With it, from identical starting splats over 8
seeds, the port's median was about 2.5× upstream's in one comparison and 1.6×
in another; the steps themselves and one redistribution match upstream, so the
remaining difference is not yet explained. Upstream's model change to image
106057 itself costs some quality at equal counts. `tests/splat/quality.html`
runs one job through the worker for manual comparisons.

## Animations

GIF/video inputs default to Splat. Animation fits keep scale at 1 so each splat
fits the 8-field animation frame as kind 4; see `animation.md`.

## Editor

The result canvas draws all splats once into a cached raster (WebGL2, one
instanced draw call) and redraws it only when the shapes change. Panning and
zooming copy that one image. The Border toggle strokes every outline as a
single path. Selection, hover, moving, resizing, layer steps, delete and undo
all work; the shape type of a splat cannot be changed.

## Output

- **JSON:** the usual site payload, plus `scale` and `is_background` on each
  element, plus upstream's `aspect_ratio`, `background` and `splats` (uv, y up,
  radians counter-clockwise, premultiplied colour). The file loads in mw_splat
  (`learn --reuse`) and in its `convert.nu` script, and can be pasted back into
  the site.
- **Lua:** same layout as the site's packed scripts. A transparent masked root
  holds a scaling canvas that is 900 units tall. The background (opaque images
  only) is image 100001. Each splat is image 106057 set to Stretch, with size,
  position, rotation, colour and local X/Y scale. Splats keep their fitted
  order. Positions and sizes use 0.1 units, rotation 0.1°, scale 0.001 and
  8-bit colour, packed with the site's Rice/LZ stream.

## Not covered

- In-game loading has not been checked with this exact script. The canvas and
  image settings follow mw_splat's own adapter.
- Focus detail is not offered for Splat. `createFitter` accepts per-pixel loss
  weights if it is added later.
