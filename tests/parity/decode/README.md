# Input-decode parity tests

Verifies that the browser port decodes uploads to the same pixels the Python
original gets from `cv2.imdecode(..., IMREAD_UNCHANGED)` — no EXIF rotation, no
alpha premultiplication, exact codec output.

Decoder under test: `js/png-decode.js` (PNG) and the JPEG/WebP branch of
`decodeToRGBA` in `js/app.js`.

## Files

| file | what it does |
|---|---|
| `pngwriter.py` | pure-Python PNG encoder for exotic inputs cv2 can't write (palette, low bit depth, gray+alpha, tRNS, Adam7, every filter) |
| `gen_goldens.py` | builds the PNG corpus + dumps cv2 RGBA goldens (`corpus/`, `goldens/`, `manifest.json`) |
| `run_tests.js` | Node: decodes every corpus PNG with `png-decode.js`, asserts **byte-identity** vs the cv2 goldens |
| `gen_browser_assets.py` | builds JPEG / EXIF-rotated JPEG / alpha-WebP assets + `assets/baseline.json` |
| `browser_check.html` | self-checking page: re-runs PNG parity through the real browser inflate path, plus JPEG/EXIF/WebP checks |

## Run

```bash
# 1. PNG parity (Node, must be byte-exact)
python gen_goldens.py
node run_tests.js            # exit 0 iff every case is byte-exact

# 2. browser-side checks (JPEG / EXIF / WebP + PNG via DecompressionStream)
python gen_browser_assets.py
python -m http.server 8399   # from the REPO ROOT
#   open http://localhost:8399/tests/parity/decode/browser_check.html
```

The oracle is `cv2` 5.0.0 + numpy; results were captured on Chromium 148
(Electron 42). `window.__RESULTS__` on the page holds a machine-readable summary.

## Exact-parity matrix (measured)

| format / case | result vs cv2 |
|---|---|
| PNG gray, bit depth 1/2/4/8 (+ interlace) | **byte-exact** |
| PNG RGB (type 2), all 5 filters, interlace, tRNS | **byte-exact** |
| PNG palette (type 3), bit depth 1/2/4/8, tRNS, interlace | **byte-exact** |
| PNG gray+alpha (type 4), interlace | **byte-exact** |
| PNG RGBA (type 6), all 5 filters, interlace | **byte-exact** |
| PNG odd widths 1..17, 300×200 random, `demo.png`, `demo2.png` | **byte-exact** |
| PNG via real browser `DecompressionStream` inflate | **byte-exact** (83/83) |
| JPEG (Chrome libjpeg-turbo vs cv2 libjpeg-turbo) | **byte-exact** (maxΔ 0 on the test image) |
| JPEG with EXIF Orientation=6 | not rotated; **byte-exact** after neutralization |
| WebP with semi-transparent alpha | ≤ **1 LSB** per channel (see caveat) |
| 16-bit PNG (gray16 / rgb16) | high-byte uint8; matches cv2's high byte (documented deviation) |

Total: **83/83 PNG corpus cases byte-exact**, in both Node and the browser.

## Known deviations & browser caveats

- **Grayscale tRNS (color type 0):** cv2 5.0.0 **ignores** a `tRNS` chunk for
  grayscale images — it returns opaque single-channel gray. `png-decode.js`
  matches cv2 (keeps alpha = 255) rather than the PNG spec's transparency intent.
  tRNS *is* applied for RGB (type 2) and palette (type 3), matching cv2.

- **Low-bit grayscale is scaled:** cv2 expands 1/2/4-bit gray to the full 8-bit
  range (`v * 255 / (2^bd − 1)`; exact integers). The decoder does the same.

- **16-bit PNGs:** the Python pipeline operates on `uint16` (a quirk we do **not**
  replicate — the JS pipeline is `uint8`). `png-decode.js` sets
  `{ bitDepth16: true }` and returns the **high byte** of each 16-bit sample.
  This equals cv2's decoded value >> 8; it is a deliberate, documented deviation
  and is *not* claimed byte-exact against the raw uint16 pipeline.

- **EXIF orientation is not honoured by `imageOrientation:"none"` everywhere.**
  Chromium 148 applies EXIF orientation regardless of the option (verified:
  default / `"none"` / `"from-image"` all rotate). `decodeToRGBA` therefore
  **neutralises the EXIF Orientation tag in the JPEG bytes** (rewrites it to 1)
  before decoding — an engine-independent guarantee. cv2 never applies
  orientation, so this matches. After neutralization the JPEG is byte-identical.

- **JPEG:** both Chrome and cv2 use libjpeg-turbo; the test image decoded
  byte-identically (maxΔ 0). Different libjpeg-turbo builds *can* differ by a few
  LSB from IDCT/upsampling rounding — this does not affect the mask/shape
  pipeline. There is no alpha in JPEG, so premultiplication is moot.

- **WebP with alpha:** the `createImageBitmap` + canvas round-trip showed ≤ 1 LSB
  per-channel difference vs cv2, *identical* to the guaranteed-non-premultiplied
  WebCodecs `ImageDecoder` path — i.e. the residual is libwebp decode rounding,
  **not** premultiplication corruption. Semi-transparent WebP is a rare input and
  the ≤1 LSB residual is negligible for the pipeline; no special-casing is needed.
