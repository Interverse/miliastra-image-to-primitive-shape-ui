"""Run the ORIGINAL Python outline pipeline (shaper_core.process_image_outline)
on the fixture corpus and dump full golden results for the JS port.

The dumped golden contains everything the JS worker must reproduce exactly:
- every element with all fields (values compared as exact doubles)
- the mask (raw bytes) that drives the display/mask_base64
- image_center / config echo

Also dumps the decoded RGBA of each fixture so the JS side runs on
bit-identical input pixels (decode parity is tested separately in
tests/parity/decode)."""
import json
import math
import os
import struct
import subprocess
import sys
import numpy as np
import cv2

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

# ── fdlibm trig injection (default) ──
# See fdlibm_inject.py: the strict parity golden runs the original pipeline
# against the SAME libm the port uses (V8/fdlibm). Pass --platform-libm for
# platform-native goldens (informational; near-tie cases may legitimately
# differ from the port, just as they differ between UCRT and glibc).
FDLIBM = "--platform-libm" not in sys.argv

sys.path.insert(0, HERE)
if FDLIBM:
    import fdlibm_inject  # noqa: E402  (monkeypatches math.* on import)

import shaper_core  # noqa: E402


def run_pipeline_fixpoint(blob, cfg):
    if not FDLIBM:
        return shaper_core.process_image_outline(blob, dict(cfg))
    return fdlibm_inject.fixpoint(lambda: shaper_core.process_image_outline(blob, dict(cfg)))

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
OUT = os.path.join(os.path.dirname(__file__), "goldens")
os.makedirs(OUT, exist_ok=True)

# (fixture, config) matrix — keep runtimes sane but cover branches
CONFIGS = [
    ("rgba_binary.png", {"primitive_size": 20, "spacing": 0.9, "precision": 0.3,
                          "primitives": [{"shape": "circle", "color": "#ffffff", "type_id": 10005009, "name": "冒险币"}]}),
    ("rgba_binary.png", {"primitive_size": 30, "spacing": 0.8, "precision": 0.8,
                          "primitives": [{"shape": "circle", "color": "#ffffff", "type_id": 20001285, "rot_z": 90, "rot_y_add": 90},
                                          {"shape": "rect", "color": "#ffffff", "type_id": 20001224}]}),
    ("rgba_donut.png",  {"primitive_size": 20, "spacing": 0.9, "precision": 0.3,
                          "primitives": [{"shape": "circle", "color": "#ffffff"}]}),
    ("rgba_strokes.png", {"primitive_size": 15, "spacing": 0.9, "precision": 0.5,
                          "primitives": [{"shape": "circle", "color": "#ffffff"}, {"shape": "rect", "color": "#ffffff"}]}),
    ("rgb_opaque.png",  {"primitive_size": 25, "spacing": 0.9, "precision": 0.3,
                          "primitives": [{"shape": "rect", "color": "#ffffff"}]}),
    ("rgba_tiny.png",   {"primitive_size": 10, "spacing": 0.9, "precision": 0.3,
                          "primitives": [{"shape": "circle", "color": "#ffffff"}]}),
    ("photo.jpg",       {"primitive_size": 22, "spacing": 0.9, "precision": 0.3,
                          "primitives": [{"shape": "circle", "color": "#ffffff"}]}),
    ("../../../../demo/demo.png", {"primitive_size": 20, "spacing": 0.9, "precision": 0.3,
                          "primitives": [{"shape": "circle", "color": "#ffffff", "type_id": 10005009}]}),
]


def decode_rgba_dump(blob):
    """Decoded input pixels as RGBA bytes (what the JS worker receives)."""
    img = cv2.imdecode(np.frombuffer(blob, np.uint8), cv2.IMREAD_UNCHANGED)
    if img.ndim == 2:
        rgba = cv2.cvtColor(img, cv2.COLOR_GRAY2RGBA)
    elif img.shape[2] == 3:
        rgba = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
    else:
        rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
    return rgba


index = []
for i, (fixture, cfg_extra) in enumerate(CONFIGS):
    path = os.path.normpath(os.path.join(FIX, fixture))
    with open(path, "rb") as f:
        blob = f.read()

    cfg = {"mode": "outline", "origin": {"type": "center"}}
    cfg.update(cfg_extra)

    result = run_pipeline_fixpoint(blob, cfg)

    rgba = decode_rgba_dump(blob)
    h, w = rgba.shape[:2]
    case_id = f"case{i:02d}"
    rgba_file = f"{case_id}_input.rgba"
    with open(os.path.join(OUT, rgba_file), "wb") as f:
        f.write(rgba.tobytes())

    mask_file = None
    # re-derive mask exactly as pipeline does for comparison of mask bytes
    # (shaper_core doesn't return the raw mask; decode its png)
    import base64
    mask_png = base64.b64decode(result["mask_base64"])
    mask = cv2.imdecode(np.frombuffer(mask_png, np.uint8), cv2.IMREAD_GRAYSCALE)
    mask_file = f"{case_id}_mask.bin"
    with open(os.path.join(OUT, mask_file), "wb") as f:
        f.write(mask.tobytes())

    golden = {
        "case": case_id,
        "fixture": fixture,
        "config": cfg,
        "width": w,
        "height": h,
        "input_rgba": rgba_file,
        "mask_bin": mask_file,
        "result": {
            "mode": result["mode"],
            "image_center": result["image_center"],
            "image_size": result["image_size"],
            "config": result["config"],
            "elements_count": result["elements_count"],
            "elements": result["elements"],
        },
    }
    with open(os.path.join(OUT, f"{case_id}.json"), "w", encoding="utf-8") as f:
        json.dump(golden, f, ensure_ascii=False)
    index.append(case_id)
    print(f"{case_id}: {fixture} -> {result['elements_count']} elements")

with open(os.path.join(OUT, "outline_index.json"), "w") as f:
    json.dump(index, f)
print("outline goldens done")
