# Splat

Splat is a browser port of [mw_splat](https://github.com/BillGoldenWater/mw_splat)
(MPL-2.0, commit 8c3951a). It fits an image with soft-edged rectangles and
exports only JSON and a client Lua script. There is no GIA, CSS, SVG or PNG
output for this method.

## Files

| File | Purpose |
| --- | --- |
| `js/splat-core.js` | Kernel, initializer, loss, Adam, redistribution, element and JSON conversion |
| `js/worker-splat.js` | Job worker: downsampling, progress, previews, pause checkpoints, threads |
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

Upstream runs on the GPU with tile bins. Here each step walks every splat's
rotated rectangle row by row, which gives the same result. The image is split
into row bands, one per helper worker. With cross-origin isolation the bands
share memory; without it the parameters and gradients are copied each step.
Helpers start from a blob, because some embedded browsers block nested workers
loaded by URL. If helpers cannot start, the job runs on one thread.

Rough speed on a 16-thread desktop: 2,000 splats, 3,000 steps, 512 × 256 image
in about 40 seconds. Cost grows with the number of pixels the splats cover, so
large "Detail (px)" values and high counts take longer.

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
