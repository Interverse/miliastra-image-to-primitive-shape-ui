# cv2 / NumPy parity tests for `js/imaging.js`

These tests prove that the browser JS imaging layer (`js/imaging.js`) is
**byte-identical** to the OpenCV / NumPy operations used by the Python backend
(`final_shaper.py`, `shaper_core.py`, `primitive_backend.py`), so the static
web port reproduces the server pipeline exactly.

## Run

```bash
python tests/parity/cv2/gen_goldens.py   # regenerate goldens (needs cv2 + numpy)
node   tests/parity/cv2/run_tests.js      # compare JS against goldens, byte-exact
```

`run_tests.js` exits non-zero if any check is not byte-identical.

- **Oracle:** the *installed* `cv2` (OpenCV **5.0.0**, built with Intel IPP) and
  NumPy 2.x — i.e. exactly what the Python pipeline runs at inference time.
- **Goldens:** `goldens/*.json` (base64-packed, ~3.6 MB total, fully
  regenerate-able). Masks for the drawing ops are bit-packed; distance-transform
  outputs are float32; everything else is raw uint8.

## What is covered (all byte-exact)

| # | Check | OpenCV / NumPy op | JS function |
|---|-------|-------------------|-------------|
| 1 | `distanceTransform` | `cv2.distanceTransform(m, DIST_L2, 5)` | `chamferDistanceTransform` |
| 2 | ellipse fill | `cv2.ellipse(...,-1)` | `cvEllipseFill` |
| 3 | rotated-rect fill | `np.intp(cv2.boxPoints(...))` + `cv2.drawContours(...,-1)` | `cvBoxFill` |
| 4 | dilate / close+open | `cv2.dilate` (3×3), `cv2.morphologyEx` CLOSE/OPEN (ellipse SE) | `dilateSquare`, `morphClose`/`morphOpen` |
| 5 | BGR→GRAY | `cv2.cvtColor(BGR2GRAY)` | `bgr2grayFixed` |
| 6 | mask extraction | `final_shaper.extract_mask` (all 3 strategies) | `extractMask` |
| 7 | resize | `cv2.resize` INTER_AREA / INTER_LINEAR (uint8) | `cvResizeU8` |
| 8 | numpy semantics | `np.rint`, `_compress_alpha_for_fitting`, float32/float64 flatten | `rintHalfEven`, `compressAlphaLUT`, `flattenOnWhiteF32`/`flattenOnWhite` |
| 9 | contour order | `cv2.findContours(RETR_TREE, CHAIN_APPROX_NONE)` | `findContours` |

## Key implementation facts (why "equivalent" was not enough)

- **distanceTransform:** the installed cv2 is built **with Intel IPP**, so
  `cv2.distanceTransform(DIST_L2, 5)` runs `ippiDistanceTransform_5x5`, which is a
  **pure float32** 5×5 chamfer (metrics `1.0, 1.4, 2.1969`, foreground init
  `FLT_MAX`) — *not* the fixed-point Borgefors path in OpenCV's C++ source (that
  differs by ~1e-5). `chamferDistanceTransform` ports the float32 chamfer with
  `Math.fround` at every step. If cv2 were ever built without IPP, regenerate the
  goldens (the port would then differ by ≤1e-5).
- **BGR2GRAY:** OpenCV 5.0.0 uses `shift = 15` (`RY=9798, GY=19235, BY=3735`),
  `gray = (R*9798 + G*19235 + B*3735 + (1<<14)) >> 15` — not the older shift-14
  constants.
- **ellipse vs box fill are two different rasterizers:** the filled ellipse goes
  through `FillConvexPoly` (fixed-point `Line2` boundary), the box through
  `fillPoly` → `CollectPolyEdges`/`FillEdgeCollection` (8-connected `LineIterator`
  boundary). `cvRound` is round-**half-to-even** everywhere.
- **NumPy truncation vs rounding:** `.astype(np.uint8)` truncates toward zero
  (`extractMask`'s `dist_u8` uses `Math.floor`, not round); `np.rint` is
  half-to-even; `_compress_alpha_for_fitting` is float32 throughout.
- **findContours order:** the point chains are already identical; OpenCV returns
  them in a pre-order DFS of the contour tree visiting siblings in reverse
  discovery order, which `findContours` reproduces by rebuilding the nesting tree.

## Notes

- `gen_goldens.py` swallows `extract_mask`'s console output (it prints non-ASCII).
- The committed goldens are a regression subset; the ports were validated during
  development on far larger randomized sweeps (tens of thousands of cases per op).
  Bump the loop counts in `gen_goldens.py` to widen coverage.
