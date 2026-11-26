# Splat

Splat is a browser port of [mw_splat](https://github.com/BillGoldenWater/mw_splat)
(MPL-2.0, commit [0354838](https://github.com/BillGoldenWater/mw_splat/commit/035483844031c93c954ab3be42e30a80eca3d22e)). It fits an image with soft-edged rectangles and
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
image 106057 with fixed-size soft corners on a 900-unit-tall canvas. Like the
game's texture, the kernel is sampled two texels (of 256) off centre: towards
+x and +y in the site's y-down frame (upstream: `vec2(1/256, -1/256)` twice,
y up). The core is therefore about 0.995 opaque, and the kernel is zero outside
the rectangle. Splats are drawn in order with normal "over" blending.

The fitter follows upstream: blue-noise start, mean-shift background for opaque
images, the black/white backdrop loss, Adam without bias correction (β1 0.5,
β2 0.95) and the same learning rates. Fitting steps are split in half, as in
upstream's default 2,000 + 2,000: the main phase moves splats from low-loss to
high-loss areas every 50 steps, and the refine phase does not move splats and
cosine-anneals the learning rate down to 0.1×. Moved splats go on top of the
draw order (both groups keep their order) and restart with zero Adam moments.
Unlike upstream, no move happens after the last main step, so every splat is
fitted before export.

The 0354838 fitter accumulates transmittance in log space and computes alpha
gradients from the full RGBA composite beneath each splat. Geometry receives
a gradient just outside the visible ramp within the splat's tiles. Adam clamps
centres to the canvas, enforces a minimum raw size of twice the ramp cap, and
clears both moments of each clamped parameter. Small splats start at the
desired visible extent using local scale. Redistribution starts after iteration
zero, weights cells by their peak pixel error and jitters destinations around
the hottest pixel. Both backends use the same iteration-derived seed.

With WebGPU, the tiled passes use scaled integer gradient atomics. Each tile
writes its loss into the tail of the gradient buffer. Loss weights share a
buffer with the reference image to keep the backward pass within eight storage
buffers. Browser uniforms carry dispatch parameters and a single workgroup
sorts redistributed splats. Bin overflow follows upstream: skipped passes,
a doubled bin buffer and replayed iterations. Buffers larger than the device
allows fail with `SPLAT_GPU_LIMIT`; other WebGPU failures fall back to the CPU.
`config.splat_backend` records `webgpu` or `cpu`.

Without WebGPU, each step walks the visible rows for rendering and the
intersecting tiles for training. The image is split into row bands, one per helper
worker. With cross-origin isolation the bands share memory; without it the
parameters and gradients are copied each step. Helpers start from a blob,
because some embedded browsers block nested workers loaded by URL. If helpers
cannot start, the job runs on one thread.

On the 64 × 64 test fixture, using the CPU fitter with 150 splats and 300 steps,
the median final loss over seeds 0–2 fell from 0.002047 at b4dd204 to 0.001334
at 0354838. All three seeds had lower loss on this fixture.

Historical benchmark (before 0354838), 2,000 splats and 3,000 steps on a 231 × 233 image (RTX-class GPU,
16-thread CPU): WebGPU about 6 s for the whole job, the CPU bands about 38 s,
upstream's native build about 7 s. One GPU step matches the CPU fitter to about
1e-5 and moves and reorders the same splats when redistributing
(`tests/splat/gpu_parity.html`).

Update to b4dd204 (texel offset, moves on top, new rates, refine phase), same
image, 2,000 splats, 3,000 steps, seeds 0–3 on WebGPU: final loss
4.57/4.31/4.29/4.38e-4 before and 4.01/4.15/4.27/4.31e-4 after, about 6.1 s
both. The native release also changed readback, environment setup, compact IR
files and the tuner. Its Lua converter writes alpha-0 colours as 0 and skips
rounding; the site already writes alpha-0 splats as black, and its packed
Lua keeps 0.1-unit precision.

Accuracy: the final loss varies between seeds and runs, in upstream too. In an earlier comparison
from identical starting splats over 8 seeds, the port's median was
1.6–2.5× upstream's (8c3951a) with redistribution, though single steps and one
redistribution matched; that comparison has not been repeated against 0354838.
Upstream's model change to image 106057 itself costs some quality at equal
counts. `tests/splat/quality.html` runs one job through the worker for manual
comparisons.

## Animations

GIF/video inputs default to Splat. Animation fits allow sizes below the still-image minimum and keep scale at 1 so each splat
fits the 8-field animation frame as kind 4; see `animation.md`. Frames warm
started from the previous frame run both phases without redistribution, so
splats keep their slots.

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
