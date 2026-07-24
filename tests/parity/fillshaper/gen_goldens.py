"""Goldens for fill_shaper AA rasterizers + _shape_opacity (used by PNG-mode
alpha weighting via primitive_backend._apply_alpha_weights_to_results)."""
import json
import os
import struct
import sys
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
import fill_shaper  # noqa: E402
import primitive_backend  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "goldens")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(4242)


def f2bits(x):
    return struct.pack(">d", float(x)).hex()


W, H = 120, 90
weights = np.clip(rng.random((H, W)), 0.0, 1.0)
with open(os.path.join(OUT, "weights.bin"), "wb") as f:
    f.write(weights.astype("<f8").tobytes())

cases = []
raster_cases = []

def add_case(result):
    shape = primitive_backend._result_to_shape(result)
    opacity = fill_shaper._shape_opacity(shape, weights, width=W, height=H)
    # Reference trig bits so the JS test can inject them and prove all
    # non-libm math is bit-exact (Math.cos/sin tails differ from the C
    # library on ~2% of inputs; see tests/parity/README.md).
    import math
    rad = math.radians(float(result.get("angle", 0.0)))
    cases.append({
        "result": result,
        "opacity": f2bits(opacity),
        "trig": {"rad": f2bits(rad), "cos": f2bits(math.cos(rad)), "sin": f2bits(math.sin(rad))},
    })

for i in range(120):
    kind = ["circle", "rect", "triangle"][i % 3]
    cx = float(rng.uniform(-15, W + 15))
    cy = float(rng.uniform(-15, H + 15))
    angle = float(rng.uniform(-360, 360))
    if kind == "circle":
        add_case({"type": "circle", "cx": cx, "cy": cy,
                  "rx": float(rng.uniform(0.3, 45)), "ry": float(rng.uniform(0.3, 45)),
                  "angle": angle})
    elif kind == "rect":
        add_case({"type": "rect", "cx": cx, "cy": cy,
                  "hw": float(rng.uniform(0.3, 40)), "hh": float(rng.uniform(0.3, 40)),
                  "angle": angle})
    else:
        add_case({"type": "triangle", "cx": cx, "cy": cy,
                  "width": float(rng.uniform(0.6, 55)), "size": float(rng.uniform(0.6, 55)),
                  "height": float(rng.uniform(0.6, 55)), "angle": angle})

# a few triangles exercising the size-fallback path (no width/height keys)
for i in range(6):
    add_case({"type": "triangle", "cx": float(rng.uniform(10, W - 10)),
              "cy": float(rng.uniform(10, H - 10)),
              "size": float(rng.uniform(4, 30)), "angle": float(rng.uniform(0, 360))})

# full raster triples for a handful of shapes (ys/xs/alpha bits)
for result in [
    {"type": "circle", "cx": 30.25, "cy": 40.5, "rx": 12.3, "ry": 7.8, "angle": 33.3},
    {"type": "rect", "cx": 60.6, "cy": 20.2, "hw": 14.4, "hh": 6.6, "angle": -71.0},
    {"type": "triangle", "cx": 80.0, "cy": 55.5, "width": 25.0, "height": 18.0, "angle": 123.4},
]:
    shape = primitive_backend._result_to_shape(result)
    ys, xs, alphas = shape.rasterize(W, H)
    raster_cases.append({
        "result": result,
        "ys": [int(v) for v in ys],
        "xs": [int(v) for v in xs],
        "alphas": [f2bits(v) for v in alphas],
    })

with open(os.path.join(OUT, "fillshaper.json"), "w") as f:
    json.dump({"W": W, "H": H, "opacity": cases, "raster": raster_cases}, f)
print(f"opacity cases={len(cases)} raster cases={len(raster_cases)}")
