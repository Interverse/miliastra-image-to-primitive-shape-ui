"""Generate the fixture image corpus for end-to-end parity tests.

Deterministic (seeded). Images cover: RGBA with binary alpha, RGBA with
gradient alpha (PNG-mode path), opaque RGB (border-sampling mask path),
holes/nested contours, thin strokes, tiny image, JPEG input.
"""
import os
import numpy as np
import cv2

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(FIX, exist_ok=True)
rng = np.random.default_rng(777)


def save(name, img):
    path = os.path.join(FIX, name)
    assert cv2.imwrite(path, img)
    print(name, img.shape)


# 1. RGBA, binary alpha: heart-ish blob + rectangle
h, w = 200, 260
img = np.zeros((h, w, 4), np.uint8)
cv2.circle(img, (80, 80), 50, (40, 40, 220, 255), -1)
cv2.circle(img, (130, 80), 50, (40, 40, 220, 255), -1)
pts = np.array([[35, 100], [175, 100], [105, 180]], np.int32)
cv2.fillPoly(img, [pts], (40, 40, 220, 255))
cv2.rectangle(img, (195, 40), (245, 160), (200, 80, 40, 255), -1)
save("rgba_binary.png", img)

# 2. RGBA with gradient alpha (exercises PNG mode + mask threshold)
h, w = 160, 200
img = np.zeros((h, w, 4), np.uint8)
yy, xx = np.mgrid[0:h, 0:w]
d = np.sqrt((xx - 100) ** 2 + (yy - 80) ** 2)
alpha = np.clip(255 - d * 3.2, 0, 255).astype(np.uint8)
img[:, :, 0] = 30
img[:, :, 1] = (xx * 255 / w).astype(np.uint8)
img[:, :, 2] = (yy * 255 / h).astype(np.uint8)
img[:, :, 3] = alpha
save("rgba_gradient.png", img)

# 3. Opaque RGB on light background (border-sampling + Otsu path)
h, w = 180, 240
img = np.full((h, w, 3), (245, 243, 240), np.uint8)
cv2.ellipse(img, (90, 90), (60, 40), 25, 0, 360, (60, 140, 30), -1)
cv2.rectangle(img, (160, 50), (215, 140), (150, 40, 90), -1)
noise = rng.integers(-4, 5, (h, w, 3))
img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
save("rgb_opaque.png", img)

# 4. Donut + nested shapes (hole contours, RETR_TREE ordering)
h, w = 220, 220
img = np.zeros((h, w, 4), np.uint8)
cv2.circle(img, (110, 110), 90, (255, 255, 255, 255), -1)
cv2.circle(img, (110, 110), 55, (0, 0, 0, 0), -1)
cv2.circle(img, (110, 110), 25, (255, 255, 255, 255), -1)
save("rgba_donut.png", img)

# 5. Thin strokes (narrow contours stress the normal probing)
h, w = 150, 300
img = np.zeros((h, w, 4), np.uint8)
cv2.line(img, (10, 130), (140, 15), (255, 200, 0, 255), 5)
cv2.ellipse(img, (210, 75), (70, 45), 0, 0, 360, (0, 200, 255, 255), 6)
save("rgba_strokes.png", img)

# 6. Tiny image
h, w = 48, 40
img = np.zeros((h, w, 4), np.uint8)
cv2.circle(img, (20, 24), 14, (90, 90, 200, 255), -1)
save("rgba_tiny.png", img)

# 7. JPEG (opaque, decoder-path check + gray/border mask path)
h, w = 160, 200
img = np.full((h, w, 3), 250, np.uint8)
cv2.circle(img, (70, 80), 45, (30, 60, 190, 255), -1)
cv2.rectangle(img, (120, 45), (180, 120), (90, 160, 40, 255), -1)
ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
assert ok
with open(os.path.join(FIX, "photo.jpg"), "wb") as f:
    f.write(buf.tobytes())
print("photo.jpg", (h, w))

print("fixtures done")
