# Browser Gaussian fitting

Select **Blurred radial circle** in Image Fitting. It is exclusive: Circle,
Rectangle and Triangle are disabled until it is deselected. Enhanced mode
applies to the original fitter and is disabled for Gaussian fitting. Retry
preserves the selected primitive and optimization steps.

The new engine runs entirely in a Web Worker. It needs no backend, CUDA,
Python, GPU API, model weights, package install or external network requests.
It uses the GaussianImage scale/rotation representation and joint gradient
optimization, adapted for the game's source-over alpha compositing. It is
an independent browser implementation, **not a bit-exact port of the CUDA
research implementation**. Existing solid-shape fitting is unchanged.

## Fitting

Every blob has nine trainable scalars: X/Y position, log X/Y standard
deviation, rotation, RGB and opacity. Analytic reverse-mode differentiation
through the ordered RGBA composite supplies gradients to Adam. All blobs
are optimized together. The renderer uses 16-pixel tiles; prefixes for
backpropagation are stored for only one sampled pixel at a time.

The default fitting detail is **512 px**. The numeric detail field accepts
higher values without a software upper bound, up to the source image's
native size (larger values do not upscale the source). For example, enter
768 for the supplied city photo or 1080 for the supplied illustration.
Fitting progresses through the available 128 → 256 → 512 pyramid levels.
Coarse stages establish the composition; the remaining primitive budget is
placed into the high-resolution residual. The total always matches the
requested count, rather than growing automatically into thousands of blobs.

Placement is error-driven. Each candidate solves RGB and opacity against
the current source-over canvas, then refines its geometry. Edge-weighted
error gives outlines and small contrasting features more influence. The
last stage measures the exact error cost of removing each blob, including
occlusion by later layers. It reuses the weakest 15% of slots in areas with
remaining error, accepting the replacement only when weighted error falls.

Joint Adam refinement uses deterministic stratified 2D pixel samples,
replacing the old vertical-stripe sampling pattern. Sample coverage now
scales with the number of active blobs: a budget of 32 pixels per blob,
at least 4,096 samples, up to the entire image. The stratification grid
determines the actual sample count. This reduces missed updates for narrow
splats, at the cost of more work per step. Full-image error is checked every
20–200 steps, depending on resolution, and each pass retains its best parameters.

The default is 600 optimization steps, divided across pyramid levels and
the final refinement pass. Any positive step count can be requested without
an upper software cap. Placement and optimization both remain cancellable.
The final preview is rendered at input resolution. Equal inputs/settings
and seed produce equal results. `initial_loss` is the unweighted error of
the empty canvas at the final fitting resolution; `final_loss` is the fitted
unweighted error. `weighted_loss` records the edge-weighted objective.

PNG mode fits premultiplied RGB and alpha together, without flattening onto
white. With PNG mode off, fitting uses the source flattened onto white.
Global output opacity scales the fitted blob opacities after optimization.

The browser implementation uses source-over rather than GaussianImage's
accumulated sum because the exported game UI controls use ordinary alpha
blending. Colors are constrained to RGB [0,1] and opacity to [0,0.999].
Quantization/compression from the research codec is outside this feature.

For detailed artwork, try **800 primitives, 512 px, 1,200 steps** as a
starting point. Use 400 for a smaller export or 1,200 for more detail. These
are suggested settings, not new limits. Blurred circles remain exclusive;
mixing solid primitives is not part of this change.

The paper and renderer differences, same-budget measurements, unsuccessful
edge-loss experiments, and next directions are documented in
[the quality investigation](GAUSSIAN-RESEARCH.md). Higher
resolution and more steps do not guarantee sharper results at a small
primitive count. Source-over blurred circles still have limited ability to
represent sharp corners and dense fine detail.

## Gaussian texture approximation

The user supplied GIA references identify resource **106057** but contain
no pixel texture. A Gaussian approximation was explicitly approved:

```
alpha(r) = (exp(-4.5*r*r) - exp(-4.5)) / (1 - exp(-4.5))  for r < 1
alpha(r) = 0                                           otherwise
```

Here `r=1` is the blob's elliptical boundary (three standard deviations).
The fit renderer evaluates this function directly. Canvas, SVG and CSS use
the same 33 gradient stops. Exported X/Y diameters and rotations describe
this same ellipse; nonuniform resize transforms its covariance correctly.
This approximates the actual asset; in-game falloff and edge appearance
remain to be calibrated against the original texture or a game screenshot.
Soft blobs suit shading; thin text and sharp corners need more elements.

## GIA formats and Basic mode

The supplied references are retained verbatim:

| Reference | Primary class | Purpose |
|---|---:|---|
| `assets/blurred_circle_asset_group.gia` | 61 | Asset Group with one blurred image child |
| `assets/blurred_circle_client.gia` | 70 | Client Image Template |
| `assets/blurred_circle_server.gia` | 21 | Server Image Template |

The existing class-61 download is now **Download Asset Group**, retaining
its original filenames. Website Asset Group exports enable a rectangular
mask covering the full source image by default, including batch downloads
and Classic conversion. Client and Server Image masking are unchanged.
**Download Server Image** is a
separate class-21 export, named `<name>_server.gia` (or `_server_classic.gia`).
Client output remains class 70. Batch ZIP includes all three Beyond files.

The new Server writer clones the class-21 reference as an invisible image
parent and adds class-15 image children. Child positions account for the
parent offset exactly once; hierarchy follows the existing server-style
reverse painter order. The single-image Server reference does not establish
multi-child rendering order in-game: this still needs an editor smoke test.

Resource 106057 uses **Basic**, as in the supplied references. Regression
tests compare the generated image/extra payloads to the supplied Basic
references, ignoring only tint and resource ID. No speculative protobuf
image-mode field is added. Lua explicitly sets `Enum.ImageType.Basic` and
uses circle asset 106057; ordinary Lua exports keep their previous output.

API compatibility: `GIA.MODE_IMAGE` and `SERVER_CONTAINER_CLASS` still refer
to the legacy class-61 path. Prefer the new `GIA.MODE_ASSET_GROUP` alias and
`ASSET_GROUP_CLASS`. The distinct mode is `GIA.MODE_SERVER_IMAGE` (class 21).
The structural decoder now reports `asset_group` for class 61 and `server`
for class 21, rather than calling class 61 a Server Image.

## Validation

```
node tests/gaussian/run_tests.js
node tests/parity/gia-client/run_tests.js
node tests/parity/lua/run_tests.js
node tests/parity/e2e/run_gia_e2e.js
node tests/parity/e2e/run_fill_e2e.js
```

Serve the repository and open `tests/gaussian/browser_smoke.html` for an
end-to-end browser test of selection, real workers, retries, opacity-aware
exports, all GIA modes, Lua and batch ZIP. Unit tests independently check
every analytic derivative using finite differences, synthetic convergence,
transparency, zero opacity, reproducibility and GIA payload compatibility.

## Sources

- [GaussianImage](https://github.com/Xinjie-Q/GaussianImage), Xinjie Zhang
  et al., ECCV 2024; MIT license, copyright 2024 Xinjie Zhang.
- [Scale/rotation model and training loop](https://github.com/Xinjie-Q/GaussianImage/blob/main/gaussianimage_rs.py)
- [Upstream license](https://github.com/Xinjie-Q/GaussianImage/blob/main/LICENSE)

The new JavaScript files are written independently. Upstream CUDA, PyTorch
and codec code are not bundled. Reported upstream FPS describes rendering
the fitted representation and is not a browser fitting-speed claim.
