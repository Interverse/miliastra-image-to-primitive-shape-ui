# GaussianImage quality investigation

Investigated 2026-10-26 using the supplied 768 × 768 city photograph and
1080 × 1080 transparent illustration. The browser fitter remains an
independent adaptation, not an exact port of the paper's renderer.

## Paper and implementation

The repository links to [GaussianImage, ECCV 2024](https://arxiv.org/html/2403.08551v5).
Sections 3.1–3.4, the component experiments in section 4.4, and appendix A/C
explain the representation, renderer, differentiation, and training.

- Each Gaussian has a center, anisotropic covariance, and weighted RGB:
  eight parameters. Covariance uses Cholesky or rotation/scale factors.
- Equation 7 sums Gaussian contributions. Weighted RGB is **unrestricted**,
  including negative values; contributions can cancel. This is more
  expressive than ordinary bounded tints overlaid with transparency.
- Training uses L2 pixel error and Adan for 50,000 steps. Their component
  comparisons use 30,000 Gaussians. L2 outperformed their tested SSIM losses.
- Adaptive splitting/cloning is omitted. Compression/quantization follows
  image fitting and does not provide additional geometric detail.
- Appendix C describes a 0.5 addition to covariance-factor parameters.
  This stabilizes small scales; it should not be interpreted as an edge
  sharpening filter or copied as arbitrary extra blur in the asset renderer.

The [rotation/scale source](https://github.com/Xinjie-Q/GaussianImage/blob/main/gaussianimage_rs.py)
confirms raw learnable color coefficients, full-image forward/loss/backward,
clamping of the final image, optimizer choice, and learning-rate scheduling.
The [training script](https://github.com/Xinjie-Q/GaussianImage/blob/main/scripts/gaussianimage_cholesky/kodak.sh)
also tests smaller counts (800–9,000), always for 50,000 iterations.

## Why our output is softer

Our actual output primitive is asset 106057, with RGB in [0,1] and ordinary
source-over transparency. For one layer, `C = a*c + (1-a)*C_previous`.
The paper instead computes `C = sum(c_i * gaussian_i)` and clamps the final
image. Substituting that renderer during fitting would produce a preview
that the exported game controls could not reproduce. Negative tint values
cannot be exported using the current resource and color fields.

Broad source-over Gaussians have visible tails and can obscure smaller
layers. Small primitive budgets must allocate blobs between shading,
silhouettes, and internal detail. Our coarse fitting targets also average
away narrow features before joint optimization. The previous fixed
4,096-pixel minibatch sometimes missed narrow splats at higher resolutions.

Consequently, smaller pixel error does not establish that an output has
preserved recognizable outlines. More optimization steps can refine the
available representation, but cannot guarantee recovery of missing detail.

## Controlled experiments

Both references were tested with seed 1, **800 actual primitives**, 512 px
detail and 1,200 total optimization steps. Metrics use the quantized exported
colors at the original image size. Transparent output is composited on
RGB (240,240,245) for a common comparison.

| Reference | Previous PSNR | Retained sampling change | Edge error change |
|---|---:|---:|---:|
| City | 23.697 dB | 23.917 dB | −3.84% |
| Illustration | 23.581 dB | 23.896 dB | −4.58% |

Edge error here means signed RGB difference error, averaged across horizontal
and vertical differences at distances 1 and 3 on the strongest 15% of target
edges. This is an investigation metric, not a claim of perceptual equivalence.
The measured gains are modest and both outputs remain visibly soft.

To measure a PNG with the current fitter and save its native-size output:

```powershell
node tests/gaussian/benchmark.cjs image.png --count 800 --steps 1200 --detail 512 --out comparison
```

This writes `comparison.png` and `comparison.json`. Keep source, seed,
primitive count, detail, and steps identical when comparing algorithm changes.

Experiments with extra gradient loss, stronger anisotropy, fewer coarse
blobs, structure-tensor orientation, and repeated-circle candidates were
also evaluated. The edge-loss variants produced streaks and reduced overall
PSNR despite improving some edge scores. Repeated-circle candidates did not
change these runs. Those experimental variants are **not enabled**.

Using the original sampling at native city resolution improved PSNR from
23.787 dB at 1,200 steps to 23.984 dB at 6,000 steps. Native resolution alone
slightly worsened illustration PSNR at 1,200 steps. Higher resolution and
longer runs should be treated as options, not promised quality gains.

## Retained changes and next direction

The browser now scales its pixel sample budget with active primitive count
(32 samples per blob, at least 4,096, up to the full fitting image). This
uses more work per iteration to reduce gradient noise for fine features.
Detail defaults to 512 px and accepts larger numeric values. Optimization
steps remain uncapped. Neither change increases the chosen primitive count.

For a larger improvement at a low count, investigate a hybrid representation:
blurred circles for smooth shading and solid rectangles/triangles/ellipses
for edges and flat regions, with a shared total budget. Optimize and validate
the actual mixed source-over composite, rather than sharpening only the
preview. This is a proposed extension; the current blurred-only selection
remains exclusive. Its quality and allocation still need measured prototypes.

Calibrating the approximation against the actual resource texture is also
necessary for accurate in-game appearance. It will improve agreement between
preview and game, without guaranteeing a sharper approximation of the source.
