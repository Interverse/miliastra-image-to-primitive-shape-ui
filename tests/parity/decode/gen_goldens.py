"""Generate the PNG parity corpus and cv2 golden RGBA dumps.

For every corpus PNG we record cv2.imdecode(..., IMREAD_UNCHANGED) converted to RGBA
as a raw .bin (width*height*4 bytes) plus a manifest entry. run_tests.js decodes the
same PNGs with js/png-decode.js and asserts byte-identity against these goldens.

cv2 only writes color types 2/6, so the exotic cases (palette, low bit depth,
gray+alpha, tRNS, Adam7 interlace, every filter type) are synthesized by pngwriter.py.
"""
import json
import os
import struct
import numpy as np
import cv2

import pngwriter as P

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus")
GOLDENS = os.path.join(HERE, "goldens")
os.makedirs(CORPUS, exist_ok=True)
os.makedirs(GOLDENS, exist_ok=True)

manifest = []


def cv2_to_rgba(img):
    """Convert whatever cv2.imdecode(IMREAD_UNCHANGED) returned into RGBA uint8.

    For 16-bit inputs cv2 returns uint16; the JS pipeline is uint8, so we compare
    against cv2's HIGH byte (img >> 8) — matching png-decode.js's documented
    16-bit downconversion (a deliberate deviation from the uint16 Python pipeline)."""
    if img.dtype == np.uint16:
        img = (img >> 8).astype(np.uint8)
    if img.ndim == 2:  # grayscale
        h, w = img.shape
        out = np.empty((h, w, 4), np.uint8)
        out[..., 0] = img
        out[..., 1] = img
        out[..., 2] = img
        out[..., 3] = 255
        return out
    h, w, c = img.shape
    out = np.empty((h, w, 4), np.uint8)
    if c == 3:  # BGR
        out[..., 0] = img[..., 2]
        out[..., 1] = img[..., 1]
        out[..., 2] = img[..., 0]
        out[..., 3] = 255
    elif c == 4:  # BGRA
        out[..., 0] = img[..., 2]
        out[..., 1] = img[..., 1]
        out[..., 2] = img[..., 0]
        out[..., 3] = img[..., 3]
    else:
        raise ValueError("unexpected channel count %d" % c)
    return out


def emit(name, png_bytes_path, deviation=False):
    """Read a PNG file, dump its cv2 RGBA golden, add to manifest."""
    data = np.fromfile(png_bytes_path, np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError("cv2 failed to decode %s" % name)
    rgba = cv2_to_rgba(img)
    h, w = rgba.shape[:2]
    golden_path = os.path.join(GOLDENS, name + ".bin")
    rgba.tofile(golden_path)
    manifest.append({
        "name": name,
        "png": os.path.relpath(png_bytes_path, HERE).replace("\\", "/"),
        "golden": os.path.relpath(golden_path, HERE).replace("\\", "/"),
        "width": int(w),
        "height": int(h),
        "deviation": bool(deviation),
    })


def write_and_emit(name, deviation=False, **kw):
    path = os.path.join(CORPUS, name + ".png")
    P.write_png(path, **kw)
    emit(name, path, deviation=deviation)


def rand_rows(w, h, channels, maxval=255, seed=0):
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, maxval + 1, size=(h, w * channels), dtype=np.int64)
    return arr.tolist()


# ── synthesized exotic corpus ─────────────────────────────────────────────
FILTERS = [0, 1, 2, 3, 4, "cycle"]

# gray, bit depths 1/2/4/8, a few filters + interlace
for bd in (1, 2, 4, 8):
    maxv = (1 << bd) - 1
    for ft in (0, "cycle"):
        write_and_emit(f"gray_bd{bd}_f{ft}", pixels=rand_rows(11, 7, 1, maxv, seed=bd),
                       width=11, height=7, bit_depth=bd, color_type=0, filter_type=ft)
    write_and_emit(f"gray_bd{bd}_interlace", pixels=rand_rows(13, 9, 1, maxv, seed=bd + 100),
                   width=13, height=9, bit_depth=bd, color_type=0, interlace=1, filter_type="cycle")

# gray+tRNS (cv2 ignores tRNS for gray -> golden stays opaque; our decoder matches)
write_and_emit("gray_bd8_trns", pixels=[[0, 64, 128, 255]], width=4, height=1,
               bit_depth=8, color_type=0, trns=struct.pack(">H", 128))

# RGB (type 2), 8-bit, every filter type
for ft in FILTERS:
    write_and_emit(f"rgb_f{ft}", pixels=rand_rows(9, 6, 3, 255, seed=hash(ft) & 0xffff),
                   width=9, height=6, bit_depth=8, color_type=2, filter_type=ft)
write_and_emit("rgb_interlace", pixels=rand_rows(15, 10, 3, 255, seed=7),
               width=15, height=10, bit_depth=8, color_type=2, interlace=1, filter_type="cycle")
write_and_emit("rgb_trns", pixels=[[10, 20, 30, 200, 100, 50, 10, 20, 30]],
               width=3, height=1, bit_depth=8, color_type=2, trns=struct.pack(">HHH", 10, 20, 30))

# Palette (type 3), bit depths 1/2/4/8, with/without tRNS, interlace
PAL = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (128, 128, 128),
       (10, 20, 30), (200, 100, 50), (255, 255, 0), (0, 255, 255)]
for bd in (1, 2, 4, 8):
    n = min(1 << bd, len(PAL))
    pal = PAL[:n]
    maxidx = n - 1
    write_and_emit(f"pal_bd{bd}", pixels=rand_rows(12, 8, 1, maxidx, seed=bd + 20),
                   width=12, height=8, bit_depth=bd, color_type=3, palette=pal, filter_type="cycle")
    # tRNS covering a subset of palette entries
    trns = bytes([0, 128] + [255] * max(0, n - 3))[:max(1, n - 1)]
    write_and_emit(f"pal_bd{bd}_trns", pixels=rand_rows(12, 8, 1, maxidx, seed=bd + 40),
                   width=12, height=8, bit_depth=bd, color_type=3, palette=pal, trns=trns,
                   filter_type="cycle")
write_and_emit("pal_bd8_interlace", pixels=rand_rows(17, 11, 1, 7, seed=55),
               width=17, height=11, bit_depth=8, color_type=3, palette=PAL, interlace=1,
               filter_type="cycle")

# Gray+alpha (type 4), 8-bit
for ft in (0, "cycle"):
    write_and_emit(f"graya_f{ft}", pixels=rand_rows(8, 5, 2, 255, seed=3),
                   width=8, height=5, bit_depth=8, color_type=4, filter_type=ft)
write_and_emit("graya_interlace", pixels=rand_rows(14, 9, 2, 255, seed=9),
               width=14, height=9, bit_depth=8, color_type=4, interlace=1, filter_type="cycle")

# RGBA (type 6), 8-bit, every filter + interlace
for ft in FILTERS:
    write_and_emit(f"rgba_f{ft}", pixels=rand_rows(9, 6, 4, 255, seed=(hash(ft) >> 3) & 0xffff),
                   width=9, height=6, bit_depth=8, color_type=6, filter_type=ft)
write_and_emit("rgba_interlace", pixels=rand_rows(16, 12, 4, 255, seed=11),
               width=16, height=12, bit_depth=8, color_type=6, interlace=1, filter_type="cycle")

# Odd widths 1..17 (RGBA + palette-4bit, exercises sub-byte row padding & bpp edges)
for w in range(1, 18):
    write_and_emit(f"odd_rgba_w{w}", pixels=rand_rows(w, 3, 4, 255, seed=200 + w),
                   width=w, height=3, bit_depth=8, color_type=6, filter_type="cycle")
    write_and_emit(f"odd_pal4_w{w}", pixels=rand_rows(w, 3, 1, 7, seed=300 + w),
                   width=w, height=3, bit_depth=4, color_type=3, palette=PAL, filter_type="cycle")

# Large-ish random images
write_and_emit("big_rgb_300x200", pixels=rand_rows(300, 200, 3, 255, seed=1),
               width=300, height=200, bit_depth=8, color_type=2, filter_type="cycle")
write_and_emit("big_rgba_300x200", pixels=rand_rows(300, 200, 4, 255, seed=2),
               width=300, height=200, bit_depth=8, color_type=6, filter_type="cycle")
write_and_emit("big_rgb_interlace_200x150", pixels=rand_rows(200, 150, 3, 255, seed=4),
               width=200, height=150, bit_depth=8, color_type=2, interlace=1, filter_type="cycle")

# ── cv2-encoded PNGs (real libpng output: types 2 and 6) ───────────────────
rng = np.random.default_rng(99)
img_bgr = rng.integers(0, 256, size=(120, 90, 3), dtype=np.uint8)
p = os.path.join(CORPUS, "cv2_rgb.png")
cv2.imwrite(p, img_bgr)
emit("cv2_rgb", p)

img_bgra = rng.integers(0, 256, size=(120, 90, 4), dtype=np.uint8)
p = os.path.join(CORPUS, "cv2_rgba.png")
cv2.imwrite(p, img_bgra)
emit("cv2_rgba", p)

# ── repo demo images ───────────────────────────────────────────────────────
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
for demo in ("demo.png", "demo2.png"):
    src = os.path.join(REPO, "demo", demo)
    if os.path.exists(src):
        emit("demo_" + demo.replace(".png", ""), src)

# ── 16-bit (documented deviation: high byte only, not byte-exact vs cv2 uint16) ──
write_and_emit("gray16", pixels=[[0, 16384, 32768, 65535]], width=4, height=1,
               bit_depth=16, color_type=0, deviation=True)
write_and_emit("rgb16", pixels=rand_rows(5, 3, 3, 65535, seed=16),
               width=5, height=3, bit_depth=16, color_type=2, deviation=True)

with open(os.path.join(HERE, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)

print("generated %d corpus entries" % len(manifest))
