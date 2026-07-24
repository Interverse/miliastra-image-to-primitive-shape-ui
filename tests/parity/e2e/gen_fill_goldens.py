"""Fill-mode end-to-end goldens.

Runs the ORIGINAL Python fill pipeline (shaper_core.process_image_fill →
primitive_backend.fit_image_with_primitive) with the subprocess redirected to
the instrumented Go harness (tests/parity/fill/harness.exe), which is the
real fogleman/primitive code built with a `-seed` flag and forced -j 1.
This produces deterministic goldens of the complete original pipeline.

Requires: tests/parity/fill/harness.exe (see tests/parity/fill/README.md).
"""
import json
import os
import sys
import numpy as np
import cv2

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

HARNESS = os.path.join(ROOT, "tests", "parity", "fill", "harness.exe")
if not os.path.exists(HARNESS):
    print(f"SKIP: harness not built at {HARNESS} — see tests/parity/fill/README.md")
    sys.exit(2)

import primitive_backend  # noqa: E402
import shaper_core  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
OUT = os.path.join(os.path.dirname(__file__), "goldens")
os.makedirs(OUT, exist_ok=True)

# Redirect the primitive binary to the seeded harness and force -j 1 + -seed.
CURRENT_SEED = [1]
_original_ensure = primitive_backend.ensure_primitive_binary
_original_spawn = primitive_backend._spawn_primitive_subprocess


def _patched_ensure():
    return HARNESS


def _patched_spawn(cmd):
    cmd = list(cmd)
    # force single worker and inject the seed
    for i, arg in enumerate(cmd):
        if arg == "-j":
            cmd[i + 1] = "1"
    cmd.extend(["-seed", str(CURRENT_SEED[0])])
    return _original_spawn(cmd)


primitive_backend.ensure_primitive_binary = _patched_ensure
primitive_backend._spawn_primitive_subprocess = _patched_spawn

CONFIGS = [
    ("rgba_binary.png", 1, {"num_primitives": 40, "image_scale": 1.0, "output_alpha": 1.0,
                             "enable_png_mode": False, "allowed_shapes": ["circle"]}),
    ("rgba_binary.png", 42, {"num_primitives": 30, "image_scale": 2.0, "output_alpha": 0.85,
                              "enable_png_mode": False, "allowed_shapes": ["circle", "rect", "triangle"]}),
    ("rgba_gradient.png", 7, {"num_primitives": 30, "image_scale": 1.0, "output_alpha": 1.0,
                               "enable_png_mode": True, "allowed_shapes": ["circle"]}),
    ("rgba_gradient.png", 7, {"num_primitives": 25, "image_scale": 1.0, "output_alpha": 1.0,
                               "enable_png_mode": False, "allowed_shapes": ["circle"]}),
    ("rgb_opaque.png", 99, {"num_primitives": 35, "image_scale": 1.0, "output_alpha": 1.0,
                             "enable_png_mode": False, "allowed_shapes": ["rect"]}),
    ("photo.jpg", 5, {"num_primitives": 30, "image_scale": 1.0, "output_alpha": 1.0,
                       "enable_png_mode": False, "allowed_shapes": ["circle"],
                       "detail_scale": 0.5}),  # exercises the resize path
]


def decode_rgba(blob):
    img = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_UNCHANGED)
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGBA)
    if img.shape[2] == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
    return cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)


index = []
for i, (fixture, seed, cfg_extra) in enumerate(CONFIGS):
    CURRENT_SEED[0] = seed
    path = os.path.join(FIX, fixture)
    with open(path, "rb") as f:
        blob = f.read()

    cfg = {
        "mode": "fill",
        "source_filename": fixture,
        "source_ext": os.path.splitext(fixture)[1].lower(),
        "origin": {"type": "center"},
        "mask_threshold": 127,
        "detail_scale": 1.0,
        "primitives": [{"shape": s, "color": "#ffffff"} for s in cfg_extra["allowed_shapes"]],
    }
    cfg.update(cfg_extra)

    result = shaper_core.process_image_fill(blob, dict(cfg))

    rgba = decode_rgba(blob)
    h, w = rgba.shape[:2]
    case_id = f"fill{i:02d}"
    with open(os.path.join(OUT, f"{case_id}_input.rgba"), "wb") as f:
        f.write(rgba.tobytes())

    golden = {
        "case": case_id,
        "fixture": fixture,
        "seed": seed,
        "config": cfg,
        "width": w,
        "height": h,
        "input_rgba": f"{case_id}_input.rgba",
        "result": {
            "mode": result["mode"],
            "image_center": result["image_center"],
            "image_size": result["image_size"],
            "config": result["config"],
            "mask": result["mask"],
            "elements_count": result["elements_count"],
            "elements": result["elements"],
        },
    }
    with open(os.path.join(OUT, f"{case_id}.json"), "w", encoding="utf-8") as f:
        json.dump(golden, f, ensure_ascii=False)
    index.append(case_id)
    print(f"{case_id}: {fixture} seed={seed} -> {result['elements_count']} elements")

with open(os.path.join(OUT, "fill_index.json"), "w") as f:
    json.dump(index, f)
print("fill goldens done")
