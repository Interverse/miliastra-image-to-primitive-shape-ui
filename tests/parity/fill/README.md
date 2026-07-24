# Fill-engine parity: JS port ⇄ Go `fogleman/primitive`

This suite proves the browser fill engine (`js/worker-fill.js` + its
`gorand.js` / `gomath.js` / `goraster.js` dependencies) reproduces the
`fogleman/primitive` algorithm **bit-for-bit**.

## Parity contract

The real `primitive` binary is **time-seeded** and **multi-worker**, so its
output is non-deterministic (worker scheduling races over the result channel).
Parity is therefore defined against the deterministic reference:

> Byte-exact equivalence to the Go binary run with **one worker (`-j 1`)** and a
> **fixed RNG seed**. Given `(input image, settings, seed)`, the JS port emits
> exactly what Go would emit under those constraints.

Everything downstream of the shape search is a pure function of the committed
shapes, so this fully determines the pipeline. The instrumented harness
(`harness.exe`, built from the **unmodified** vendored `primitive` package plus
a thin CLI) enforces `-j 1` and injects `-seed`.

### What is bit-exact

* `gorand.js` — Go `math/rand` v1 (`rngSource` lagged-Fibonacci, `Int63/Int31/
  Int31n/Intn/Uint32/Float64`, ziggurat `NormFloat64`). Validated over
  100k-sample sequences for several seeds; `Float64`/`NormFloat64` compared as
  raw float64 bits.
* `gomath.js` — Go `math.Sin/Cos/Acos/Atan2/Pow` (pure-Go implementations; amd64
  has no assembly for these, so V8's `Math.*` are **not** bit-identical). Used
  everywhere the Go core calls `math.*`. Validated bit-exact (float64 bits).
* `goraster.js` — `github.com/golang/freetype/raster` fixed-point rasterizer
  used by `RotatedEllipse` (16-segment quadratic path, non-zero winding,
  antialiased span alphas). Validated exactly against Go-emitted scanlines.
* `worker-fill.js goFmtF` — Go `strconv.FormatFloat(x,'f',6,64)` (round-half-to-
  even), the SVG `%f` quantization Python re-parses. Validated string-exact.
* The **primitive core** — shape RNG consumption order, rasterization, colour
  computation, premultiplied compositing, scoring, mutation, and hill-climb —
  validated by replaying committed step traces (shape params + colour + score
  bits) for many `(image, seed, config)` cases. A committed shape is the output
  of a full ≥16 000-evaluation search, so an exact match transitively pins every
  RNG draw, rasterize, energy eval, and score.

## Build & run

Go 1.26.x must be on PATH. In PowerShell:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
cd tests/parity/fill
go mod download            # pulls freetype + x/image + gg + nfnt/resize into the module cache
go build -o harness.exe .

# generate goldens
./harness.exe rng          # rng_golden.json
./harness.exe gomath       # gomath_golden.json
./harness.exe gofmt        # gofmt_golden.json
./harness.exe raster       # raster_golden.json
./harness.exe trace        # trace_golden.json  (~7 s: runs the Go search)

# validate the JS port
node run_tests.js
```

Expected:

```
── gorand ────────────────────────────── PASS
── gomath ────────────────────────────── PASS
── gofmt ─────────────────────────────── PASS
── goraster ──────────────────────────── PASS
── primitive core traces ─────────────── (18 cases, 142 steps)  PASS

ALL PARITY TESTS PASS ✓ (bit-exact)
```

The vendored source is at `../../../third_party/primitive` (module
`github.com/fogleman/primitive`); the harness `go.mod` `replace`s the module to
that path, so the golden generator and the JS port are built from the same
source.

### `harness.exe` as a `primitive` drop-in (e2e)

With no leading subcommand, `harness.exe` runs a **deterministic `primitive`
CLI**: it mirrors `third_party/primitive/main.go`'s flags and SVG/PNG writers
exactly, but **ignores `-j`** (always one worker) and honours `-seed <int64>`
(absent → time-seeded like the real binary). This is what
`tests/parity/e2e/gen_fill_goldens.py` monkeypatches over
`primitive_backend._spawn_primitive_subprocess` to produce full-pipeline
goldens, which `tests/parity/e2e/run_fill_e2e.js` replays through
`worker-fill.js processFill`.

## Divergences found & fixed (vs. the pre-existing JS port)

The original `worker-fill.js` was a *quality-equivalent* approximation, not a
bit-exact port. Fixes:

1. **RNG** — replaced `Math.random()`/Box-Muller with the ported Go `rngSource`
   + ziggurat `NormFloat64`, consumed in Go's exact call order.
2. **`int(...)` truncation** — mutation deltas use `int(rnd.NormFloat64()*k)`
   (truncate toward zero), not `Math.round`.
3. **RotatedEllipse rasterization** — was an analytic scanline solve; replaced
   with the freetype 16-segment quadratic path so antialiased span alphas match.
4. **`areaToAlpha`** (goraster) — `(area+1)>>1` is an **arithmetic** shift
   (floor), not truncating division; the difference for negative winding areas
   shifted the 12-bit coverage by 1 (a ×16 error in 16-bit alpha).
5. **`drawLines`** — (a) source alpha is `sa = A*0x101` (was wrongly
   `A*0x101*A/0xff`); (b) the composite is Go `uint32` arithmetic that **wraps
   mod 2^32** at low-alpha antialiased edges over bright destinations —
   reproduced with `>>> 0`; (c) pixel buffers are `Uint8Array` (Go `uint8`
   wraps), not `Uint8ClampedArray`.
6. **`RotatedRectangle` rasterize** — `max[]` initial value is Go's zero (`0`),
   not `INT_MIN`; the latter dropped a scanline for rects entirely left of x=0.
7. **`computeColor`** — empty coverage returns `Color{}` = `[0,0,0,0]` (alpha
   discarded), not `[0,0,0,alpha]`.
8. **Target premultiplication** — the target is now premultiplied with Go's
   exact `image/draw drawNRGBASrc` byte math (`sa=A*0x101; premult=(c*sa/0xff)>>8`),
   matching `imageToRGBA`; the background uses the same conversion.
9. **`differencePartial` start** — `uint64(math.Pow(score*255,2)*N)` truncates
   toward zero (`Math.trunc`), and uses the ported `pow` (`==x*x`); the previous
   code kept a non-truncated float and clamped negatives to 0.
10. **Integer division** — all Go `int64`/`uint32` divisions go through
    `goIntDiv` (exact trunc-toward-zero) to avoid float-division misround at
    integer boundaries.
11. **Search params** — restored to Go defaults `n=1000, age=100, m=16`.
12. **SVG round-trip** — `RotatedEllipse` cx/cy/rx/ry/angle and every shape's
    `fill-opacity` are quantized with `goFmtF(·,6)` before entering the results,
    matching the Python `float("%f" % v)` re-parse.
13. **Seeding** — `config.random_seed` (int) seeds deterministically; when
    absent, a wall-clock-derived seed is used (mirrors Go's time seeding).

## Remaining approximations

* **`uint64` underflow wrap** — Go's `differencePartial` accumulates in `uint64`
  and would wrap mod 2^64 on a transient underflow. This provably never happens
  for a *committed* shape: the starting total equals the previous full error, so
  after subtracting a shape's old per-pixel errors the running total stays ≥ the
  (non-negative) error of the untouched pixels. The JS emulates the wrap
  defensively (`+2^64`); the trace suite passing bit-exactly confirms no
  committed score ever takes that path.
* **Triangle result `angle`** — computed Python-side as
  `math.degrees(math.atan2(ey,ex)) + 90`. `math.degrees` is reproduced exactly
  (folded `180/π`), but `atan2` is the host libm: V8's fdlibm may differ from the
  golden interpreter's libm by ≤1 ulp on a minority of inputs. This is washed out
  by the downstream 4-decimal (`PyNum.round(...,4)`) rounding of `rotation.z`.
* **Preview rendering** is display-only (the model's scanline canvas vs. the Go
  `gg` anti-aliased PNG) and is not part of the bit-exact contract.
