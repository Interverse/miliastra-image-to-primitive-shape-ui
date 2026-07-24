/*
 * png-decode.js — a self-contained, exact PNG decoder for the static Shaper port.
 *
 * PURPOSE
 *   The Python original decodes uploads with cv2.imdecode(..., IMREAD_UNCHANGED):
 *   no EXIF rotation, no alpha premultiplication, exact codec output. The browser's
 *   createImageBitmap + canvas round-trip corrupts input pixels (EXIF orientation and
 *   premultiplied-alpha RGB loss where alpha < 255). This decoder reproduces cv2's
 *   pixel values for 8-bit PNGs, byte-for-byte, delivered as RGBA.
 *
 * OUTPUT
 *   { width, height, rgba: Uint8ClampedArray /* RGBA, R first *\/, bitDepth16: boolean }
 *
 *   The port's pipeline uses RGBA where Python uses BGR(A); that channel swap is
 *   accounted for elsewhere — here we deliver RGBA = [R,G,B,A].
 *
 * cv2 PARITY NOTES (verified empirically against cv2 5.0.0, see tests/parity/decode)
 *   - Color type 0 (gray): single channel. Bit depths 1/2/4 are SCALED to full range
 *     (v * 255 / (2^bd - 1); exact integers for 1/2/4 bit). cv2 IGNORES a tRNS chunk
 *     for grayscale, so we keep alpha = 255 to match (a deliberate deviation from the
 *     PNG spec, documented in the tests README).
 *   - Color type 2 (RGB): with tRNS, alpha = 0 where the pixel exactly equals the
 *     transparent colour, else 255.
 *   - Color type 3 (palette): with tRNS, per-index alpha; indices beyond the tRNS
 *     length are opaque (255).
 *   - Color type 4 (gray+alpha) / 6 (RGBA): straightforward.
 *   - No gamma / colour-space transforms are applied (cv2 applies none for UNCHANGED).
 *
 * 16-BIT
 *   The Python pipeline operates on uint16 for 16-bit PNGs (a behavioural quirk we do
 *   NOT replicate — the JS pipeline is uint8). For 16-bit inputs we set
 *   { bitDepth16: true } and return the HIGH byte of each sample as uint8 RGBA. This
 *   is a known, documented deviation; 8-bit inputs are byte-exact vs cv2.
 */
(function (global) {
  "use strict";

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  // channels per PNG colour type
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  // Adam7 interlace passes: [xStart, yStart, xStep, yStep]
  const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];

  function isPNG(bytes) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
    return true;
  }

  /* ── zlib inflate: DecompressionStream in the browser, zlib in Node ── */
  async function inflate(data) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      // Node (tests): use zlib synchronously.
      const zlib = require("zlib");
      const buf = zlib.inflateSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    // Browser: 'deflate' == zlib-wrapped deflate (RFC 1950), which is the PNG IDAT format.
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  /* Reconstruct (unfilter) one scanline in place. `line` is the filtered data bytes
     (without the leading filter-type byte); `prev` is the previously reconstructed
     line (or null for the first row). bpp = filter byte-distance. */
  function unfilter(ftype, line, prev, bpp) {
    const n = line.length;
    if (ftype === 0) return;
    if (ftype === 1) {
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
    } else if (ftype === 2) {
      if (prev) for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
    } else if (ftype === 3) {
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      }
    } else if (ftype === 4) {
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        line[i] = (line[i] + paeth(a, b, c)) & 0xff;
      }
    } else {
      throw new Error("png-decode: bad filter type " + ftype);
    }
  }

  /* Expand one reconstructed scanline into an array of raw integer samples
     (length passW*channels). Handles 1/2/4/8/16 bit depths. */
  function expandRow(bytes, passW, channels, bitDepth) {
    const count = passW * channels;
    const out = new Array(count);
    if (bitDepth === 8) {
      for (let i = 0; i < count; i++) out[i] = bytes[i];
    } else if (bitDepth === 16) {
      for (let i = 0; i < count; i++) out[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    } else {
      // sub-byte (1/2/4); only occurs for gray/palette (channels === 1)
      const mask = (1 << bitDepth) - 1;
      let bitPos = 0;
      for (let i = 0; i < count; i++) {
        const byteIndex = bitPos >> 3;
        const shift = 8 - bitDepth - (bitPos & 7);
        out[i] = (bytes[byteIndex] >> shift) & mask;
        bitPos += bitDepth;
      }
    }
    return out;
  }

  function grayTo8(v, bitDepth) {
    if (bitDepth === 16) return v >> 8;
    if (bitDepth === 8) return v;
    // 1/2/4-bit: scale to full 8-bit range (exact integer multiples for 1/2/4).
    return Math.round((v * 255) / ((1 << bitDepth) - 1));
  }

  /* Emit one pixel (channel samples s[b..] -> RGBA) into rgba at byte offset di. */
  function emitPixel(rgba, di, s, b, ctx) {
    const { colorType, bitDepth, palette, trns, is16 } = ctx;
    switch (colorType) {
      case 0: {
        const g = grayTo8(s[b], bitDepth);
        rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g; rgba[di + 3] = 255;
        break;
      }
      case 2: {
        rgba[di] = is16 ? s[b] >> 8 : s[b];
        rgba[di + 1] = is16 ? s[b + 1] >> 8 : s[b + 1];
        rgba[di + 2] = is16 ? s[b + 2] >> 8 : s[b + 2];
        rgba[di + 3] =
          trns && s[b] === trns[0] && s[b + 1] === trns[1] && s[b + 2] === trns[2] ? 0 : 255;
        break;
      }
      case 3: {
        const idx = s[b];
        const p = idx * 3;
        rgba[di] = palette[p]; rgba[di + 1] = palette[p + 1]; rgba[di + 2] = palette[p + 2];
        rgba[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
        break;
      }
      case 4: {
        const g = grayTo8(s[b], bitDepth);
        rgba[di] = g; rgba[di + 1] = g; rgba[di + 2] = g;
        rgba[di + 3] = is16 ? s[b + 1] >> 8 : s[b + 1];
        break;
      }
      case 6: {
        rgba[di] = is16 ? s[b] >> 8 : s[b];
        rgba[di + 1] = is16 ? s[b + 1] >> 8 : s[b + 1];
        rgba[di + 2] = is16 ? s[b + 2] >> 8 : s[b + 2];
        rgba[di + 3] = is16 ? s[b + 3] >> 8 : s[b + 3];
        break;
      }
      default:
        throw new Error("png-decode: unsupported colour type " + colorType);
    }
  }

  /* Decode one reduced image (a whole non-interlaced image, or one Adam7 pass),
     scattering pixels into the final rgba buffer via (mapX, mapY). */
  function decodePass(raw, offset, passW, passH, imgW, ctx, rgba, mapX, mapY) {
    const { channels, bitDepth } = ctx;
    const bitsPerPixel = channels * bitDepth;
    const bytesPerRow = Math.ceil((passW * bitsPerPixel) / 8);
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

    let prev = null;
    let off = offset;
    for (let row = 0; row < passH; row++) {
      const ftype = raw[off];
      const line = raw.subarray(off + 1, off + 1 + bytesPerRow);
      off += 1 + bytesPerRow;
      unfilter(ftype, line, prev, bpp);
      const samples = expandRow(line, passW, channels, bitDepth);
      const imgY = mapY(row);
      for (let col = 0; col < passW; col++) {
        const imgX = mapX(col);
        const di = (imgY * imgW + imgX) * 4;
        emitPixel(rgba, di, samples, col * channels, ctx);
      }
      prev = line;
    }
    return off;
  }

  async function decode(input) {
    const bytes =
      input instanceof Uint8Array
        ? input
        : new Uint8Array(input.buffer ? input.buffer : input, input.byteOffset || 0, input.byteLength);

    if (!isPNG(bytes)) throw new Error("png-decode: not a PNG (bad signature)");

    let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    let palette = null;
    let trns = null;
    const idatParts = [];

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    for (;;) {
      if (pos + 8 > bytes.length) break;
      const len = dv.getUint32(pos);
      const type =
        String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const dataStart = pos + 8;
      if (type === "IHDR") {
        width = dv.getUint32(dataStart);
        height = dv.getUint32(dataStart + 4);
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        interlace = bytes[dataStart + 12];
      } else if (type === "PLTE") {
        palette = bytes.subarray(dataStart, dataStart + len);
      } else if (type === "tRNS") {
        trns = bytes.subarray(dataStart, dataStart + len);
      } else if (type === "IDAT") {
        idatParts.push(bytes.subarray(dataStart, dataStart + len));
      } else if (type === "IEND") {
        break;
      }
      pos = dataStart + len + 4; // skip data + CRC
    }

    if (!(width > 0 && height > 0)) throw new Error("png-decode: missing/invalid IHDR");
    if (!(colorType in CHANNELS)) throw new Error("png-decode: unsupported colour type " + colorType);

    // Concatenate IDAT payloads, then inflate.
    let idatLen = 0;
    for (const p of idatParts) idatLen += p.length;
    const idat = new Uint8Array(idatLen);
    { let o = 0; for (const p of idatParts) { idat.set(p, o); o += p.length; } }
    const raw = await inflate(idat);

    // Parse tRNS for RGB (type 2): three 16-bit values -> low byte (8-bit images).
    let trnsRGB = null;
    if (trns && colorType === 2 && trns.length >= 6) {
      const tv = new DataView(trns.buffer, trns.byteOffset, trns.byteLength);
      trnsRGB = [tv.getUint16(0) & 0xff, tv.getUint16(2) & 0xff, tv.getUint16(4) & 0xff];
      if (bitDepth === 16) trnsRGB = [tv.getUint16(0), tv.getUint16(2), tv.getUint16(4)];
    }
    // For 16-bit RGB, samples are full 16-bit; compare full-width in emitPixel.
    const trnsForCtx = colorType === 2 ? trnsRGB : colorType === 3 ? trns : null;

    const channels = CHANNELS[colorType];
    const is16 = bitDepth === 16;
    const ctx = {
      colorType,
      bitDepth,
      channels,
      palette: colorType === 3 ? palette : null,
      trns: trnsForCtx,
      is16,
    };

    const rgba = new Uint8ClampedArray(width * height * 4);

    if (interlace === 0) {
      decodePass(raw, 0, width, height, width, ctx, rgba, (c) => c, (r) => r);
    } else if (interlace === 1) {
      let off = 0;
      for (const [xs, ys, xstep, ystep] of ADAM7) {
        const passW = Math.ceil((width - xs) / xstep);
        const passH = Math.ceil((height - ys) / ystep);
        if (passW <= 0 || passH <= 0) continue;
        off = decodePass(
          raw, off, passW, passH, width, ctx, rgba,
          (c) => xs + c * xstep,
          (r) => ys + r * ystep
        );
      }
    } else {
      throw new Error("png-decode: unsupported interlace method " + interlace);
    }

    return { width, height, rgba, bitDepth16: is16 };
  }

  const api = { decode, isPNG };
  global.PNGDecode = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
