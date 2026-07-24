"""Generate assets + baselines for browser_check.html (JPEG / EXIF / WebP).

Outputs under tests/parity/decode/assets/:
  base.jpg          cv2-encoded JPEG (24x16, asymmetric so rotation is detectable)
  exif_or6.jpg      same JPEG with a spliced EXIF Orientation=6 (rotate 90deg) tag
  alpha.webp        semi-transparent WebP (if cv2 can encode alpha), for premultiply test
  baseline.json     cv2.imdecode RGBA of each asset + expected dimensions

The browser page decodes the SAME bytes and compares against these cv2 baselines.
"""
import json
import os
import struct
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
os.makedirs(ASSETS, exist_ok=True)

W, H = 24, 16

# Asymmetric test image: top-left quadrant bright red, plus a gradient + noise
# so JPEG chroma-subsampling / IDCT differences between decoders show up.
rng = np.random.default_rng(42)
bgr = np.zeros((H, W, 3), np.uint8)
xx = np.linspace(0, 255, W, dtype=np.uint8)
bgr[:, :, 0] = xx[None, :]                      # blue gradient L->R
bgr[:, :, 1] = np.linspace(0, 255, H, dtype=np.uint8)[:, None]  # green gradient T->B
bgr[:, :, 2] = 40
bgr[: H // 2, : W // 2, 2] = 240                 # bright-red top-left quadrant
bgr = np.clip(bgr.astype(np.int16) + rng.integers(-8, 9, bgr.shape), 0, 255).astype(np.uint8)


def rgba_of(png_or_jpg_bytes):
    img = cv2.imdecode(np.frombuffer(png_or_jpg_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if img.ndim == 2:
        h, w = img.shape
        out = np.dstack([img, img, img, np.full((h, w), 255, np.uint8)])
    elif img.shape[2] == 3:
        out = np.dstack([img[..., 2], img[..., 1], img[..., 0], np.full(img.shape[:2], 255, np.uint8)])
    else:
        out = np.dstack([img[..., 2], img[..., 1], img[..., 0], img[..., 3]])
    return out.astype(np.uint8)


baseline = {}

# ── base.jpg ──────────────────────────────────────────────────────────────
ok, enc = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
jpg = enc.tobytes()
with open(os.path.join(ASSETS, "base.jpg"), "wb") as f:
    f.write(jpg)
rgba = rgba_of(jpg)
baseline["base.jpg"] = {
    "width": W, "height": H,
    "rgba": rgba.flatten().tolist(),
    "note": "cv2 decode of base.jpg; browser decode compared for max channel delta",
}

# ── exif_or6.jpg : splice an EXIF APP1 with Orientation=6 into base.jpg ─────
def make_exif_app1(orientation):
    # big-endian TIFF with a single IFD0 entry: Orientation (0x0112) SHORT = value
    tiff = b"MM" + b"\x00\x2a" + struct.pack(">I", 8)
    ifd = struct.pack(">H", 1)
    ifd += struct.pack(">HHI", 0x0112, 3, 1) + struct.pack(">H", orientation) + b"\x00\x00"
    ifd += struct.pack(">I", 0)
    tiff += ifd
    exif = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif

assert jpg[:2] == b"\xff\xd8"
exif_jpg = jpg[:2] + make_exif_app1(6) + jpg[2:]
with open(os.path.join(ASSETS, "exif_or6.jpg"), "wb") as f:
    f.write(exif_jpg)
# cv2 does NOT apply EXIF orientation with IMREAD_UNCHANGED either -> same pixels/dims
rgba_exif = rgba_of(exif_jpg)
baseline["exif_or6.jpg"] = {
    "width": W, "height": H,          # if orientation were applied, dims would be H x W
    "rotated_width": H, "rotated_height": W,
    "rgba": rgba_exif.flatten().tolist(),
    "note": "orientation=6; correct (cv2-matching) decode keeps dims 24x16, no rotation",
}

# ── alpha.webp : semi-transparent, for premultiply investigation ───────────
bgra = np.zeros((H, W, 4), np.uint8)
bgra[..., 0] = 200   # B
bgra[..., 1] = 60    # G
bgra[..., 2] = 30    # R
bgra[:, : W // 2, 3] = 128   # left half 50% alpha, right half opaque
bgra[:, W // 2:, 3] = 255
alpha_ok = False
try:
    ok, wenc = cv2.imencode(".webp", bgra)
    if ok:
        wbytes = wenc.tobytes()
        dec = cv2.imdecode(np.frombuffer(wbytes, np.uint8), cv2.IMREAD_UNCHANGED)
        if dec is not None and dec.ndim == 3 and dec.shape[2] == 4:
            with open(os.path.join(ASSETS, "alpha.webp"), "wb") as f:
                f.write(wbytes)
            rgba_w = rgba_of(wbytes)
            baseline["alpha.webp"] = {
                "width": W, "height": H,
                "rgba": rgba_w.flatten().tolist(),
                "note": "semi-transparent WebP; tests whether browser premultiplies alpha",
            }
            alpha_ok = True
except Exception as e:
    print("webp alpha encode failed:", e)
if not alpha_ok:
    print("NOTE: cv2 could not produce an alpha WebP; browser_check will skip that case")

with open(os.path.join(ASSETS, "baseline.json"), "w") as f:
    json.dump(baseline, f)

print("wrote assets:", sorted(os.listdir(ASSETS)))
