# Shapely (GEOS) geometry parity — `js/geometry.js`

This suite proves that `js/geometry.js` reproduces the Shapely/GEOS
operations used by the outline fitter (`final_shaper.py`) closely enough that
the JS port makes **byte-identical fitting decisions** to the Python original.

## Run

```bash
python tests/parity/shapely/gen_goldens.py   # regenerate goldens from shapely
node   tests/parity/shapely/run_tests.js     # validate geometry.js
```

`run_tests.js` exits non-zero on any failure or any decision flip.

## What is validated

| Operation (geometry.js) | Shapely reference | Result |
|---|---|---|
| `makeEllipsePoly` | `Point(0,0).buffer(1,resolution=32)`→scale→rotate→translate | **bit-exact** under trig injection |
| `pointBuffer` | `Point(cx,cy).buffer(r)` (default `quad_segs=16` → 64-gon) | **bit-exact** (no trig; embedded unit ring) |
| `makeRectPoly` | `box(-w/2,-h/2,w/2,h/2)`→rotate→translate | **bit-exact** under trig injection |
| `polygonArea` | `poly.area` (GEOS `Area::ofRingSigned`) | bit-exact under injection |
| `boundaryLength` / `interpolate` | `LineString.length` / `.interpolate` | bit-exact under injection |
| `intersectionArea` | `poly.intersection(convex).area` (Sutherland–Hodgman) | ≤ 1.5e-9 abs, decision-relevant rel ≤ 3e-10 |
| `simplify` | `Polygon(pts).simplify(1.0, preserve_topology=True)` (JTS `TopologyPreservingSimplifier`) | 70/71 vertex-exact on corpus; 71/71 area-equivalent |

### Key facts encoded here (see `js/geometry.js` header)

- **`buffer(0)` is never reproduced.** A self-touching simplified ring has
  `|shoelace| == buffer(0).area`, and Sutherland–Hodgman clipping of the *raw*
  ring reproduces `buffer(0).intersection(convex).area` (validated to < 3e-10).
  So the invalid-polygon branch collapses to "clip the raw ring" — no overlay/
  noding port needed.
- **`quad_segs` default is 16** (64 segments), not 8 — the base-circle candidate
  `Point(center).buffer(best_r)` is a 64-gon; its `.area` feeds `suppress_overlap`.
- **`simplifyRingEndpoint`** (JTS post-step) removes the ring's arbitrary start
  vertex; without it the simplifier keeps one spurious vertex per ring.

## Trig injection

The only libm-dependent input in `geometry.js` is the rotation `cos`/`sin`.
V8 differs from CPython's UCRT on a ~2.4 % tail at 1 ULP — irreducible in the
browser. So `run_tests.js` runs two passes:

- **INJECTED** — `Math.cos`/`Math.sin` patched with the exact CPython values
  (keyed by IEEE754 argument bits). Requires **bit-exact** output and **zero
  decision flips**. Isolates the algorithm from the libm tail.
- **ENGINE** — real V8 trig. Informational; confirms flips stay zero (the tail
  shows as ≤ 5.7e-14 coordinate error, far below any threshold).

## Decision-flip oracle (`decision_log.jsonl`, ≤ 10 MB)

`gen_goldens.py` runs the **real** Python pipeline over the corpus
(`demo/*.png`) with an instrumented `best_primitive_at`, logging one compact
record per invocation: the shared shape header, every candidate's intersection
inputs (`ia`,`ea`,gate,`dm`), and the chosen (first-max) index. `run_tests.js`
replays each candidate through `geometry.js` — recomputing `ia`/`ea`, the gate
`ia >= ea·contain_t`, the score, and the arg-max — and compares:

- **gate flips**: 0 / 60 186 candidate intersections
- **argmax flips**: 0 / 6 686 invocations

Both passes report `RESULT: PASS`.
