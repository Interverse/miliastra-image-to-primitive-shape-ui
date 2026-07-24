#!/usr/bin/env python
"""Generate byte-exact golden fixtures for the JS imaging parity tests.

Run:  python tests/parity/cv2/gen_goldens.py
Then: node tests/parity/cv2/run_tests.js

Goldens are written to tests/parity/cv2/goldens/*.json (base64-packed, kept
small and fully regenerate-able). The golden oracle is the INSTALLED cv2
(OpenCV 5.0.0, with Intel IPP) + numpy — i.e. exactly what the Python pipeline
(final_shaper / shaper_core / primitive_backend) produces at runtime.
"""
import os, sys, json, base64, io, contextlib
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD = os.path.join(HERE, "goldens")
os.makedirs(GOLD, exist_ok=True)

# Make the repo importable so we can call the real pipeline's extract_mask.
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, REPO)
import final_shaper as fs  # noqa: E402


def extract_mask_quiet(img):
    """final_shaper.extract_mask prints non-ASCII; swallow its stdout."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fs.extract_mask(img)

print("cv2", cv2.__version__, "| numpy", np.__version__, "| IPP", cv2.ipp.useIPP())


def b64(arr):
    a = np.ascontiguousarray(arr)
    return {"b64": base64.b64encode(a.tobytes()).decode(), "dtype": str(a.dtype), "shape": list(a.shape)}


def dump(name, obj):
    p = os.path.join(GOLD, name + ".json")
    with open(p, "w") as f:
        json.dump(obj, f)
    print(f"  wrote {name}.json  ({os.path.getsize(p)//1024} KB)")


# ───────────────────────── 1. distanceTransform ─────────────────────────
def gen_distance_transform():
    rng = np.random.default_rng(12345)
    cases = []
    def add(m):
        d = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        cases.append({"w": int(m.shape[1]), "h": int(m.shape[0]),
                      "mask": b64(m), "out": b64(d)})
    # random density masks
    for _ in range(40):
        h = int(rng.integers(3, 48)); w = int(rng.integers(3, 48))
        m = (rng.random((h, w)) < rng.uniform(0.15, 0.85)).astype(np.uint8) * 255
        add(m)
    # structured: solid blocks, single pixels, all-fg, all-bg, borders
    m = np.zeros((32, 40), np.uint8); m[8:24, 10:30] = 255; add(m)
    m = np.zeros((20, 20), np.uint8); m[10, 10] = 255; add(m)
    m = np.full((16, 24), 255, np.uint8); add(m)                 # all foreground -> FLT_MAX
    m = np.full((16, 24), 255, np.uint8); m[0, 0] = 0; add(m)
    m = np.zeros((16, 24), np.uint8); add(m)                     # all background
    m = np.zeros((30, 30), np.uint8); m[:, 0] = 255; m[:, -1] = 255; m[0, :] = 255; m[-1, :] = 255; add(m)
    m = np.zeros((25, 25), np.uint8); m[12, :] = 255; add(m)     # horizontal line
    m = np.zeros((25, 25), np.uint8); m[:, 12] = 255; add(m)     # vertical line
    dump("distance_transform", {"cases": cases})


# ───────────────────────── 5. BGR2GRAY fixed-point ─────────────────────────
def gen_bgr2gray():
    rng = np.random.default_rng(99)
    bgr = rng.integers(0, 256, size=(1, 8000, 3)).astype(np.uint8)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    dump("bgr2gray", {"bgr": b64(bgr.reshape(-1, 3)), "gray": b64(gray.reshape(-1))})


# ─────────── 6. extract_mask (all strategies) + numpy semantics ───────────
def gen_extract_mask():
    rng = np.random.default_rng(7)
    cases = []
    def add(img):
        m = extract_mask_quiet(img)
        # img handed to JS as RGBA (R=bgr[..,2],G=bgr[..,1],B=bgr[..,0],A=255 or alpha)
        h, w = img.shape[:2]
        if img.ndim == 3 and img.shape[2] == 4:
            rgba = np.dstack([img[:, :, 2], img[:, :, 1], img[:, :, 0], img[:, :, 3]]).astype(np.uint8)
            has_alpha = True
        else:
            if img.ndim == 2:
                bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
            else:
                bgr = img[:, :, :3]
            rgba = np.dstack([bgr[:, :, 2], bgr[:, :, 1], bgr[:, :, 0], np.full((h, w), 255, np.uint8)]).astype(np.uint8)
            has_alpha = False
        cases.append({"w": w, "h": h, "hasAlpha": has_alpha, "rgba": b64(rgba), "mask": b64(m)})

    for _ in range(24):
        h = int(rng.integers(20, 90)); w = int(rng.integers(20, 90))
        typ = rng.integers(0, 4)
        if typ == 0:  # colored blob on solid bg (color-distance + Otsu path)
            bg = rng.integers(0, 256, size=3)
            img = np.tile(bg.astype(np.uint8), (h, w, 1))
            cy, cx = h // 2, w // 2
            fg = rng.integers(0, 256, size=3).astype(np.uint8)
            img[cy - h // 4:cy + h // 4, cx - w // 4:cx + w // 4] = fg
            add(img)
        elif typ == 1:  # RGBA
            img = rng.integers(0, 256, size=(h, w, 4)).astype(np.uint8)
            add(img)
        elif typ == 2:  # grayscale-ish (triggers fallbacks)
            g = rng.integers(200, 256, size=(h, w)).astype(np.uint8)
            g[h // 3:2 * h // 3, w // 3:2 * w // 3] = rng.integers(0, 60)
            add(cv2.cvtColor(g, cv2.COLOR_GRAY2BGR))
        else:  # noisy
            add(rng.integers(0, 256, size=(h, w, 3)).astype(np.uint8))
    # tiny + uniform edge cases
    add(np.full((6, 6, 3), 128, np.uint8))
    add(np.zeros((8, 10, 4), np.uint8))
    add(np.full((8, 10, 4), 255, np.uint8))
    dump("extract_mask", {"cases": cases})


# ───────────── 8. rint / compress-alpha / flatten (f32 & f64) ─────────────
def gen_numpy_semantics():
    # rint half-even samples
    rng = np.random.default_rng(3)
    xs = np.concatenate([
        rng.uniform(-5, 300, size=20000),
        np.arange(-4, 300) + 0.5,  # exact halves
    ])
    rints = np.rint(xs)
    # compress-alpha LUT (default floor/gamma and a couple alternates)
    def comp_lut(floor, gamma):
        arr = np.arange(256, dtype=np.uint8)
        alpha = np.clip(arr.astype(np.float32) / 255.0, 0.0, 1.0)
        fl = float(np.clip(floor, 0.0, 0.95)); gm = float(max(0.1, gamma))
        comp = np.clip((alpha - fl) / max(1e-6, 1.0 - fl), 0.0, 1.0)
        comp = np.power(comp, gm)
        return np.clip(np.rint(comp * 255.0), 0, 255).astype(np.uint8)
    comp = {f"{fl}_{gm}": b64(comp_lut(fl, gm)) for (fl, gm) in [(0.2, 1.6), (0.0, 1.0), (0.5, 2.2), (0.95, 0.1)]}
    # flatten f64 (shaper_core) and f32 (primitive_backend) on random RGBA
    imgs = []
    for _ in range(8):
        h = int(rng.integers(8, 40)); w = int(rng.integers(8, 40))
        rgba = rng.integers(0, 256, size=(h, w, 4)).astype(np.uint8)
        # f64: _flatten_to_bgr
        a64 = rgba[:, :, 3:4].astype(np.float64) / 255.0
        base64_ = rgba[:, :, :3].astype(np.float64)
        f64 = np.clip(np.rint(base64_ * a64 + 255.0 * (1.0 - a64)), 0, 255).astype(np.uint8)
        # f32: _prepare_transparent_target RGB flatten
        a32 = rgba[:, :, 3].astype(np.float32) / 255.0
        flat = rgba[:, :, :3].astype(np.float32)
        flat = flat * a32[:, :, None] + 255.0 * (1.0 - a32[:, :, None])
        f32 = np.clip(np.rint(flat), 0, 255).astype(np.uint8)
        imgs.append({"w": w, "h": h, "rgba": b64(rgba), "f64": b64(f64), "f32": b64(f32)})
    dump("numpy_semantics", {"rint_x": b64(xs), "rint_out": b64(rints),
                             "compress": comp, "flatten": imgs})


# ───────────── 4. dilate square + morphologyEx close/open (cross SE) ─────────────
def gen_morphology():
    rng = np.random.default_rng(21)
    k3 = np.ones((3, 3), np.uint8)
    se = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cases = []
    for _ in range(40):
        h = int(rng.integers(4, 40)); w = int(rng.integers(4, 40))
        m = (rng.random((h, w)) < rng.uniform(0.2, 0.7)).astype(np.uint8) * 255
        dil = cv2.dilate(m, k3, iterations=1)
        closed = cv2.morphologyEx(m, cv2.MORPH_CLOSE, se)
        opened = cv2.morphologyEx(closed, cv2.MORPH_OPEN, se)
        cases.append({"w": w, "h": h, "mask": b64(m), "dilate1": b64(dil), "closeOpen": b64(opened)})
    dump("morphology", {"cases": cases})


# ───────────── 9. findContours order (RETR_TREE, CHAIN_APPROX_NONE) ─────────────
def gen_find_contours():
    rng = np.random.default_rng(55)
    cases = []
    def add(m):
        cnts, _ = cv2.findContours(m, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
        # flatten each contour to [x0,y0,x1,y1,...]
        cl = [np.asarray(c).reshape(-1, 2).astype(np.int32) for c in cnts]
        cases.append({"w": int(m.shape[1]), "h": int(m.shape[0]), "mask": b64(m),
                      "contours": [b64(c) for c in cl]})
    # multiple separate blobs
    m = np.zeros((40, 60), np.uint8)
    m[5:15, 5:20] = 255; m[5:15, 35:55] = 255; m[25:35, 15:45] = 255
    add(m)
    # nested (blob with hole with inner blob)
    m = np.zeros((50, 50), np.uint8)
    m[5:45, 5:45] = 255; m[15:35, 15:35] = 0; m[22:28, 22:28] = 255
    add(m)
    # random blobs
    for _ in range(20):
        h = int(rng.integers(20, 60)); w = int(rng.integers(20, 60))
        m = (rng.random((h, w)) < 0.5).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        add(m)
    dump("find_contours", {"cases": cases})


# ───────────── 2/3. cv2.ellipse fill & boxPoints+drawContours fill ─────────────
def _pack_mask(m):
    return b64(np.packbits(m.reshape(-1) > 0))


def gen_draw():
    rng = np.random.default_rng(2024)
    ell = []
    for _ in range(1000):
        W = int(rng.integers(24, 72)); H = int(rng.integers(24, 72))
        cx = int(rng.integers(-6, W + 6)); cy = int(rng.integers(-6, H + 6))
        ax = int(rng.integers(1, 80)); ay = int(rng.integers(1, 80))
        ang = float(rng.uniform(-720, 720))
        cov = np.zeros((H, W), np.uint8)
        cv2.ellipse(cov, (cx, cy), (ax, ay), ang, 0, 360, 255, -1)
        ell.append({"w": W, "h": H, "cx": cx, "cy": cy, "ax": ax, "ay": ay,
                    "ang": ang, "mask": _pack_mask(cov)})
    box = []
    for _ in range(1000):
        W = int(rng.integers(24, 72)); H = int(rng.integers(24, 72))
        cx = int(rng.integers(-4, W + 4)); cy = int(rng.integers(-4, H + 4))
        rw = float(rng.uniform(1, 90)); rh = float(rng.uniform(1, 90))
        ang = float(rng.uniform(-720, 720))
        cov = np.zeros((H, W), np.uint8)
        rect = ((cx, cy), (max(rw, 1), max(rh, 1)), ang)
        bpts = np.intp(cv2.boxPoints(rect))
        cv2.drawContours(cov, [bpts], 0, 255, -1)
        box.append({"w": W, "h": H, "cx": cx, "cy": cy, "rw": rw, "rh": rh,
                    "ang": ang, "mask": _pack_mask(cov)})
    dump("draw_ellipse", {"cases": ell})
    dump("draw_box", {"cases": box})


# ───────────── 7. cv2.resize (INTER_AREA / INTER_LINEAR, uint8) ─────────────
def gen_resize():
    rng = np.random.default_rng(808)
    cases = []
    def add(img, dw, dh, interp):
        code = cv2.INTER_AREA if interp == "area" else cv2.INTER_LINEAR
        out = cv2.resize(img, (dw, dh), interpolation=code)
        cn = 1 if img.ndim == 2 else img.shape[2]
        cases.append({"sw": int(img.shape[1]), "sh": int(img.shape[0]), "dw": dw, "dh": dh,
                      "cn": cn, "interp": interp, "src": b64(img), "out": b64(out)})
    for cn in (1, 3, 4):
        for _ in range(8):
            sh = int(rng.integers(6, 64)); sw = int(rng.integers(6, 64))
            img = rng.integers(0, 256, size=(sh, sw) if cn == 1 else (sh, sw, cn)).astype(np.uint8)
            # downscale (INTER_AREA) — the pipeline's dst=round(src*ratio)
            r = float(rng.uniform(0.25, 1.0))
            dw = max(1, int(round(sw * r))); dh = max(1, int(round(sh * r)))
            add(img, dw, dh, "area")
            # integer-ratio area downscale
            add(img, max(1, sw // 2), max(1, sh // 2), "area")
            # upscale + equal (INTER_LINEAR)
            add(img, int(sw * 2), int(sh * 2), "linear")
            add(img, max(1, int(sw * r)), max(1, int(sh * r)), "linear")
            add(img, sw, sh, "linear")
    dump("resize", {"cases": cases})


if __name__ == "__main__":
    gen_distance_transform()
    gen_bgr2gray()
    gen_extract_mask()
    gen_numpy_semantics()
    gen_morphology()
    gen_find_contours()
    gen_draw()
    gen_resize()
    total = sum(os.path.getsize(os.path.join(GOLD, f)) for f in os.listdir(GOLD))
    print(f"total goldens: {total/1024/1024:.2f} MB")
