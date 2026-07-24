# Parity Regression Suite

These tests verify that the static browser port (the repository root) reproduces the
original Python/Go implementation **exactly** — same inputs, same settings,
same outputs — so users can switch to the GitHub Pages port without any
change in generated results.

## Layout

| Directory | Verifies | Oracle |
|---|---|---|
| `pynum/` | CPython `round()` (banker's), `np.rint`, numpy pairwise summation, exact FMA | CPython + numpy |
| `fillshaper/` | `fill_shaper.py` AA rasterizers + `_shape_opacity` (PNG-mode alpha weighting) | fill_shaper.py |
| `cv2/` | OpenCV primitives: ellipse/box rasterization, chamfer distance transform, resize, cvtColor, thresholds, morphology, contours | cv2 |
| `shapely/` | GEOS geometry: buffer polygons, affine transforms, simplify, intersection areas, boundary interpolation | shapely |
| `decode/` | Input decoding: PNG (exact JS decoder), JPEG/EXIF, WebP | cv2.imdecode |
| `fill/` | Go fogleman/primitive engine: math/rand, ziggurat, freetype raster, Go libm ports, full step traces | instrumented Go harness (`harness.exe`, seeded, single-worker) |
| `e2e/` | Full pipelines end-to-end on the fixture corpus: outline (`run_outline_e2e.js`), fill (`run_fill_e2e.js`), GIA bytes incl. error parity (`run_gia_e2e.js`), and `browser_smoke.html` (same cases in real browser workers) | shaper_core / Go+Python / reconstructed GIA writer |

Run any suite with:

```bash
python tests/parity/<suite>/gen_goldens.py
node tests/parity/<suite>/run_tests.js
```

Goldens are regenerated from the reference environment and are not committed
(see each suite's `.gitignore`); commit them if you want CI to skip the
Python step.

## Parity contract

The port targets **bit-exact** equivalence with the original, subject to the
following environment-level clarifications. These are properties of the
*original* software stack, not shortcuts in the port:

1. **Fill mode randomness.** The original `primitive.exe` seeds Go's
   `math/rand` from wall-clock time and races N worker goroutines, so two
   runs of the *original* never produce the same output. The port replicates
   the algorithm exactly under a deterministic contract: **equal to the Go
   binary run with `-j 1` (single worker) and a fixed seed**. The port's
   `config.random_seed` selects the seed; without it, a time-derived seed is
   used (matching the original's behavior of being different each run).
2. **libm tails.** CPython defers `sin/cos/atan2/exp/pow` to the platform C
   library (UCRT on Windows, glibc on the original's Docker deployment),
   while JS engines ship fdlibm derivatives. These implementations disagree
   in the final bit on a small fraction of inputs (measured here: ~2.4% of
   sin/cos calls, ~12.6% of atan2 calls, at exactly 1 ulp) and NONE of them
   is authoritative — UCRT itself is only ~97% correctly rounded (verified
   against mpmath). The original's output near ties depends on this choice:
   perturbation testing shows its `suppress_overlap` ordering flips between
   legitimate libms. So the strict outline golden runs the ORIGINAL pipeline
   pinned to the SAME libm the port uses: `gen_outline_goldens.py` (default)
   monkeypatches `math.sin/cos/atan2` through `fdlibm_inject.py`, which
   resolves values via Node (`trig_eval.js`) to a fixpoint. With that
   pinning, all outline E2E cases are bit-identical. `--platform-libm`
   generates platform-native goldens instead (informational; near-tie cases
   may differ from the port exactly as they differ between UCRT and glibc).
   Unit suites additionally validate in two passes (injected trig must be
   bit-exact; engine trig reported informationally). The Go fill engine has
   no such caveat: Go's `math.*` is pure Go and ported bit-exactly
   (`gomath.js`).
3. **FMA.** numpy dispatches matrix products (even 3×2) to BLAS, which uses
   hardware fused-multiply-add. The port replicates this with an exact
   software FMA (`PyNum.fma`) at the call sites that go through BLAS.
4. **Gaussian kernels.** `scipy.ndimage.gaussian_filter1d` kernel values
   depend on `np.exp` SIMD tails; the two kernels the pipeline uses
   (σ=5.0, σ=2.0) are embedded as exact bit patterns, and the correlation
   loop replicates scipy's symmetric-fold accumulation order.
5. **16-bit PNG inputs** decode to 8-bit in the port (high byte); the
   original propagates uint16 through an 8-bit-assuming pipeline. Documented
   deviation (see `decode/README.md`).

## Reference environment

Goldens were generated with: Python 3.14 (UCRT/Windows), numpy 2.4.6,
cv2 5.0.0, scipy 1.18.0, shapely (GEOS), Go 1.26.5, x86-64 with AVX2/FMA.
Regenerating on a different platform may shift libm-tail cases (see §2).
