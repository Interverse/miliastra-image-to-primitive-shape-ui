/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/ (also LICENSES/mw_splat-MPL-2.0.txt).
 * Based on mw_splat by Golden_Water, commit 8c3951a. */
/*
 * splat-core.js — Splat fitting and rendering.
 *
 * Browser port of mw_splat by Golden_Water
 * (https://github.com/BillGoldenWater/mw_splat, MPL-2.0; see
 * LICENSES/MPL-2.0.txt). The kernel, initializer, loss, Adam update and
 * redistribution follow the upstream WGSL/Rust code. The GPU tile binning is
 * replaced by a per-splat bounding box walk, which gives the same result.
 *
 * Each splat is a soft rectangle: a solid core with a ramp around it. The ramp
 * is capped at 64 units of a 900-unit-tall canvas, which matches how the game
 * stretches image 106057 with fixed-size soft corners.
 *
 * Internal coordinates are image pixels with y pointing down. Exported JSON
 * uses the upstream layout (uv, y up, radians counter-clockwise).
 */
"use strict";

const SplatCore = (() => {
  const REF_HEIGHT = 900, RAMP_CAP = 64;
  const ASSET = 106057, BACKGROUND_ASSET = 100001;
  const STRIDE = 11; // x, y, w, h, rot, r, g, b, a, sx, sy (colour premultiplied)
  const LOGIT_EPS = 1e-4, LN_SIZE_MAX = Math.log(20000);
  const BETA1 = 0.9, BETA2 = 0.999, ADAM_EPS = 1e-8;
  const LR = { position: 0.7246497, size: 0.025369959, rotation: 0.0110587515, color: 0.03130688, alpha: 1.3482634, scale: 0.0034468751 };
  const INVERSE_CDF_SIZE = 1 << 14, BINS = 512;
  const LOSS_WEIGHT_GAMMA = 1.4;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const rampCap = (height) => RAMP_CAP * height / REF_HEIGHT;

  /* ── random numbers ── */
  function rng(seed) {
    let s = (Number(seed) >>> 0) ^ 0x9e3779b9;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(a, b) {
    let h = (Math.imul(a >>> 0, 747796405) ^ Math.imul((b + 1) >>> 0, 2891336453)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    return ((h ^ (h >>> 16)) & 0xffffff) / 16777216;
  }

  /* ── per-splat cache ──
   * 0 sin, 1 cos, 2 coreX, 3 coreY, 4 1/rampX, 5 1/rampY, 6 half extent X,
   * 7 half extent Y, 8 x0, 9 x1, 10 y0, 11 y1 (pixel bounding box). */
  const CACHE = 12;
  function fillCache(p, n, width, height, cap, cache) {
    for (let i = 0; i < n; i++) {
      const k = i * STRIDE, o = i * CACHE;
      const s = Math.sin(p[k + 4]), c = Math.cos(p[k + 4]);
      const halfX = p[k + 2] * 0.5, halfY = p[k + 3] * 0.5, sx = p[k + 9], sy = p[k + 10];
      const rampX = Math.min(halfX, cap) * sx, rampY = Math.min(halfY, cap) * sy;
      const hx = halfX * sx, hy = halfY * sy;
      cache[o] = s; cache[o + 1] = c;
      cache[o + 2] = hx - rampX; cache[o + 3] = hy - rampY;
      cache[o + 4] = 1 / Math.max(rampX, 1e-6); cache[o + 5] = 1 / Math.max(rampY, 1e-6);
      cache[o + 6] = hx; cache[o + 7] = hy;
      const ax = Math.abs(c) * hx + Math.abs(s) * hy, ay = Math.abs(s) * hx + Math.abs(c) * hy;
      const x0 = Math.max(0, Math.floor(p[k] - ax)), x1 = Math.min(width, Math.ceil(p[k] + ax));
      const y0 = Math.max(0, Math.floor(p[k + 1] - ay)), y1 = Math.min(height, Math.ceil(p[k + 1] + ay));
      const valid = x0 < x1 && y0 < y1; // false for NaN as well
      cache[o + 8] = valid ? x0 : 0; cache[o + 9] = valid ? x1 : 0;
      cache[o + 10] = valid ? y0 : 0; cache[o + 11] = valid ? y1 : 0;
    }
  }

  /* Pixel columns [SPAN[0], SPAN[1]) whose centres on row offset `dy` fall
   * inside the rotated rectangle. Outside it the kernel is zero, so skipping
   * them changes nothing; it only avoids empty bounding-box corners. */
  const SPAN = new Float64Array(2);
  function rowSpan(cx, dy, c, s, hx, hy, x0, x1) {
    let lo = -Infinity, hi = Infinity;
    if (Math.abs(c) > 1e-9) {
      const a = (-hx - s * dy) / c, b = (hx - s * dy) / c;
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    } else if (Math.abs(s * dy) > hx) { SPAN[0] = SPAN[1] = 0; return; }
    if (Math.abs(s) > 1e-9) {
      const a = (c * dy - hy) / s, b = (c * dy + hy) / s;
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    } else if (Math.abs(c * dy) > hy) { SPAN[0] = SPAN[1] = 0; return; }
    SPAN[0] = Math.max(x0, Math.ceil(cx + lo - 0.5 - 1e-7));
    SPAN[1] = Math.min(x1, Math.floor(cx + hi - 0.5 + 1e-7) + 1);
  }

  /* Composites splats in order over the background for rows [y0, y1).
   * Writes premultiplied RGBA and transmittance into band-local arrays. */
  function forwardRows(p, n, cache, width, y0, y1, background, pixels, trans) {
    const M = (y1 - y0) * width;
    const br = background[0], bg = background[1], bb = background[2], ba = background[3];
    for (let q = 0; q < M; q++) { const o = q * 4; pixels[o] = br; pixels[o + 1] = bg; pixels[o + 2] = bb; pixels[o + 3] = ba; trans[q] = 1; }
    for (let i = 0; i < n; i++) {
      const o = i * CACHE, x0 = cache[o + 8], x1 = cache[o + 9];
      const ya = Math.max(cache[o + 10], y0), yb = Math.min(cache[o + 11], y1);
      if (x0 >= x1 || ya >= yb) continue;
      const k = i * STRIDE, cx = p[k], cy = p[k + 1], s = cache[o], c = cache[o + 1];
      const coreX = cache[o + 2], coreY = cache[o + 3], irx = cache[o + 4], iry = cache[o + 5];
      const hx = cache[o + 6], hy = cache[o + 7];
      const cr = p[k + 5], cg = p[k + 6], cb = p[k + 7], ca = p[k + 8];
      for (let y = ya; y < yb; y++) {
        const dy = y + 0.5 - cy;
        rowSpan(cx, dy, c, s, hx, hy, x0, x1);
        const xa = SPAN[0], xb = SPAN[1], row = (y - y0) * width;
        for (let x = xa; x < xb; x++) {
          const dx = x + 0.5 - cx;
          const ex = Math.abs(c * dx + s * dy) - coreX, ey = Math.abs(c * dy - s * dx) - coreY;
          const qx = ex > 0 ? ex * irx : 0, qy = ey > 0 ? ey * iry : 0;
          const d2 = qx * qx + qy * qy;
          if (d2 >= 1) continue;
          const t = 1 - Math.sqrt(d2), kern = t * (0.5 + t * (1.5 - t));
          const inv = 1 - kern * ca, q = row + x, at = q * 4;
          pixels[at] = pixels[at] * inv + cr * kern;
          pixels[at + 1] = pixels[at + 1] * inv + cg * kern;
          pixels[at + 2] = pixels[at + 2] * inv + cb * kern;
          pixels[at + 3] = pixels[at + 3] * inv + ca * kern;
          trans[q] *= inv;
        }
      }
    }
  }

  /* Composites splats in order over the background. Returns premultiplied
   * RGBA and transmittance, both row-major with y down. */
  function render(p, n, width, height, background, cap, out) {
    const N = width * height;
    const pixels = out && out.pixels && out.pixels.length === N * 4 ? out.pixels : new Float64Array(N * 4);
    const trans = out && out.trans && out.trans.length === N ? out.trans : new Float64Array(N);
    const cache = out && out.cache && out.cache.length >= n * CACHE ? out.cache : new Float64Array(Math.max(1, n) * CACHE);
    fillCache(p, n, width, height, cap, cache);
    forwardRows(p, n, cache, width, 0, height, background, pixels, trans);
    return { pixels, trans, cache };
  }

  /* Premultiplied float RGBA → straight 8-bit RGBA. */
  function toRGBA8(pixels, width, height) {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < out.length; i += 4) {
      const a = pixels[i + 3];
      out[i] = a > 1e-8 ? pixels[i] / a * 255 : 0;
      out[i + 1] = a > 1e-8 ? pixels[i + 1] / a * 255 : 0;
      out[i + 2] = a > 1e-8 ? pixels[i + 2] / a * 255 : 0;
      out[i + 3] = a * 255;
    }
    return out;
  }

  /* 8-bit straight RGBA → premultiplied float RGBA. */
  function premultiply(rgba) {
    const out = new Float64Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      out[i] = rgba[i] / 255 * a; out[i + 1] = rgba[i + 1] / 255 * a; out[i + 2] = rgba[i + 2] / 255 * a; out[i + 3] = a;
    }
    return out;
  }

  /* Box-filter downsample of premultiplied float RGBA. */
  function downsample(src, width, height, fw, fh) {
    if (fw === width && fh === height) return src.slice();
    const out = new Float64Array(fw * fh * 4), sx = width / fw, sy = height / fh;
    for (let y = 0; y < fh; y++) {
      const ya = y * sy, yb = (y + 1) * sy;
      for (let x = 0; x < fw; x++) {
        const xa = x * sx, xb = (x + 1) * sx;
        let r = 0, g = 0, b = 0, a = 0, wsum = 0;
        for (let yy = Math.floor(ya); yy < Math.min(height, Math.ceil(yb)); yy++) {
          const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
          if (wy <= 0) continue;
          for (let xx = Math.floor(xa); xx < Math.min(width, Math.ceil(xb)); xx++) {
            const wx = Math.min(xb, xx + 1) - Math.max(xa, xx);
            if (wx <= 0) continue;
            const w = wx * wy, i = (yy * width + xx) * 4;
            r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w; a += src[i + 3] * w; wsum += w;
          }
        }
        const o = (y * fw + x) * 4, inv = wsum > 0 ? 1 / wsum : 0;
        out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv; out[o + 3] = a * inv;
      }
    }
    return out;
  }

  /* ── initialization (upstream init.rs) ── */
  const MS_BANDWIDTH = 0.1, MS_EPS = 0.01, MS_MAX_ITERS = 64, MS_MAX_SAMPLES = 4096;
  const FEATHER = 0.5, CANDIDATES = 24, NO_GEN_ALPHA = 0.01;

  function cellOf(c, inv, g) {
    const f = (v) => clamp(Math.floor(v * inv), 0, g - 1);
    return [f(c[0]), f(c[1]), f(c[2])];
  }
  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  function meanShiftBackground(img, width, height) {
    const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / MS_MAX_SAMPLES)));
    const samples = [];
    for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4; samples.push([img[i], img[i + 1], img[i + 2]]);
    }
    const inv = 1 / MS_BANDWIDTH, g = Math.max(1, Math.ceil(inv)) + 1;
    const grid = Array.from({ length: g * g * g }, () => []);
    samples.forEach((c, i) => { const [a, b, d] = cellOf(c, inv, g); grid[(a * g + b) * g + d].push(i); });
    const h2 = MS_BANDWIDTH * MS_BANDWIDTH;
    const modes = samples.map((start) => {
      let x = start;
      for (let it = 0; it < MS_MAX_ITERS; it++) {
        let sx = 0, sy = 0, sz = 0, count = 0;
        const [a, b, d] = cellOf(x, inv, g);
        for (let da = Math.max(0, a - 1); da <= Math.min(g - 1, a + 1); da++)
          for (let db = Math.max(0, b - 1); db <= Math.min(g - 1, b + 1); db++)
            for (let dc = Math.max(0, d - 1); dc <= Math.min(g - 1, d + 1); dc++)
              for (const j of grid[(da * g + db) * g + dc]) {
                const q = samples[j];
                if (dist2(x, q) <= h2) { sx += q[0]; sy += q[1]; sz += q[2]; count++; }
              }
        if (!count) break;
        const m = [sx / count, sy / count, sz / count];
        if (dist2(x, m) <= MS_EPS * MS_EPS) return m;
        x = m;
      }
      return x;
    });
    // Merge nearby modes and average the samples of the largest cluster.
    const merge = MS_BANDWIDTH * 0.5, minv = 1 / Math.max(merge, 1e-4), mg = Math.max(1, Math.ceil(minv)) + 1;
    const mgrid = Array.from({ length: mg * mg * mg }, () => []);
    modes.forEach((m, i) => { const [a, b, d] = cellOf(m, minv, mg); mgrid[(a * mg + b) * mg + d].push(i); });
    const parent = modes.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const r2 = merge * merge;
    modes.forEach((m, i) => {
      const [a, b, d] = cellOf(m, minv, mg);
      for (let da = Math.max(0, a - 1); da <= Math.min(mg - 1, a + 1); da++)
        for (let db = Math.max(0, b - 1); db <= Math.min(mg - 1, b + 1); db++)
          for (let dc = Math.max(0, d - 1); dc <= Math.min(mg - 1, d + 1); dc++)
            for (const j of mgrid[(da * mg + db) * mg + dc]) if (j > i && dist2(m, modes[j]) <= r2) parent[find(i)] = find(j);
    });
    const size = new Map();
    let root = 0, best = -1;
    modes.forEach((_, i) => { const r = find(i), s = (size.get(r) || 0) + 1; size.set(r, s); if (s > best) { best = s; root = r; } });
    const acc = [0, 0, 0]; let count = 0;
    modes.forEach((_, i) => { if (find(i) === root) { acc[0] += samples[i][0]; acc[1] += samples[i][1]; acc[2] += samples[i][2]; count++; } });
    return acc.map((v) => v / Math.max(1, count));
  }

  function backgroundColor(img, width, height) {
    for (let i = 3; i < img.length; i += 4) if (img[i] < 1) return [0, 0, 0, 0];
    const [r, g, b] = meanShiftBackground(img, width, height);
    return [r, g, b, 1];
  }

  function blueNoise(img, width, height, n, random) {
    const allowed = [];
    for (let q = 0; q < width * height; q++) if (img[q * 4 + 3] >= NO_GEN_ALPHA) allowed.push(q);
    if (!allowed.length) for (let q = 0; q < width * height; q++) allowed.push(q);
    const cell = Math.max(1, Math.sqrt(width * height / Math.max(1, n))) * 0.5;
    const gw = Math.ceil(width / cell) + 1, gh = Math.ceil(height / cell) + 1;
    const grid = Array.from({ length: gw * gh }, () => []);
    const points = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      let bx = 0, by = 0, bestDist = -1;
      for (let c = 0; c < CANDIDATES; c++) {
        const idx = allowed[Math.floor(random() * allowed.length)];
        const px = idx % width + random(), py = Math.floor(idx / width) + random();
        const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
        let dist = Infinity;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const gx = cx + dx, gy = cy + dy;
          if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          for (const q of grid[gx + gy * gw]) dist = Math.min(dist, (q[0] - px) ** 2 + (q[1] - py) ** 2);
        }
        if (dist > bestDist) { bestDist = dist; bx = px; by = py; }
      }
      grid[Math.floor(bx / cell) + Math.floor(by / cell) * gw].push([bx, by]);
      points[i * 2] = bx; points[i * 2 + 1] = by;
    }
    return points;
  }

  function featherMean(img, width, height, cx, cy, hs) {
    const ramp = Math.max(2 * FEATHER * hs, 1e-9), rad = Math.ceil(hs);
    const ix = Math.round(cx), iy = Math.round(cy);
    const x0 = Math.max(0, ix - rad), x1 = Math.min(width, ix + rad + 1);
    const y0 = Math.max(0, iy - rad), y1 = Math.min(height, iy + rad + 1);
    const ss = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
    const acc = [0, 0, 0, 0]; let wsum = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const w = ss((hs - Math.abs(x + 0.5 - cx)) / ramp) * ss((hs - Math.abs(y + 0.5 - cy)) / ramp);
      if (w <= 0) continue;
      const i = (y * width + x) * 4;
      acc[0] += w * img[i]; acc[1] += w * img[i + 1]; acc[2] += w * img[i + 2]; acc[3] += w * img[i + 3]; wsum += w;
    }
    return wsum <= 1e-12 ? [0, 0, 0, 0] : acc.map((v) => v / wsum);
  }

  function initialize(img, width, height, n, seed) {
    const size = Math.max(1, Math.sqrt(width * height / Math.max(1, n)));
    const background = backgroundColor(img, width, height);
    const points = blueNoise(img, width, height, n, rng(seed));
    const p = new Float64Array(n * STRIDE);
    for (let i = 0; i < n; i++) {
      const x = points[i * 2], y = points[i * 2 + 1], c = featherMean(img, width, height, x, y, size * 0.5), k = i * STRIDE;
      p[k] = x; p[k + 1] = y; p[k + 2] = size; p[k + 3] = size; p[k + 4] = 0;
      p[k + 5] = c[0]; p[k + 6] = c[1]; p[k + 7] = c[2]; p[k + 8] = c[3]; p[k + 9] = 1; p[k + 10] = 1;
    }
    return { params: p, background };
  }

  /* ── training (upstream learn.rs and shaders) ── */

  /* One horizontal band of rows. pass() renders the band, measures its loss
   * and returns gradients for every splat from the pixels in the band. Bands
   * are independent, so their losses and gradients simply add up. `target`
   * and `weights` cover the whole image. */
  function createBand(target, width, height, weights, background) {
    let pixels = new Float64Array(0), trans = pixels, adjoint = pixels, comp = pixels, before = pixels;
    let cache = new Float64Array(0), grad = new Float64Array(0);
    const norm = 1 / (width * height * 6), bgT = 1 - background[3];

    function ensure(rows, n) {
      const M = rows * width;
      if (trans.length < M) {
        pixels = new Float64Array(M * 4); trans = new Float64Array(M); adjoint = new Float64Array(M * 4);
        comp = new Float64Array(M * 4); before = new Float64Array(M);
      }
      if (cache.length < n * CACHE) cache = new Float64Array(n * CACHE);
      if (grad.length !== n * STRIDE) grad = new Float64Array(n * STRIDE); else grad.fill(0);
    }

    function pass(p, n, cap, y0, y1, out) {
      ensure(y1 - y0, n);
      fillCache(p, n, width, height, cap, cache);
      forwardRows(p, n, cache, width, y0, y1, background, pixels, trans);
      // Loss and its derivative per pixel (black and white backdrop terms).
      let loss = 0;
      const M = (y1 - y0) * width, base = y0 * width;
      for (let q = 0; q < M; q++) {
        const o = q * 4, t = (base + q) * 4, w = weights ? weights[base + q] : 1;
        const br = pixels[o] - target[t], bgg = pixels[o + 1] - target[t + 1], bb = pixels[o + 2] - target[t + 2];
        const da = target[t + 3] - pixels[o + 3];
        const wr = br + da, wg = bgg + da, wb = bb + da;
        loss += (br * br + bgg * bgg + bb * bb + wr * wr + wg * wg + wb * wb) * norm * w;
        const f = 2 * norm * w;
        adjoint[o] = (br + wr) * f; adjoint[o + 1] = (bgg + wg) * f; adjoint[o + 2] = (bb + wb) * f;
        adjoint[o + 3] = -f * (wr + wg + wb);
        comp[o] = background[0]; comp[o + 1] = background[1]; comp[o + 2] = background[2]; comp[o + 3] = background[3];
        before[q] = 1;
      }
      // Replay the composite in order and collect each splat's gradient.
      const g = out || grad;
      for (let i = 0; i < n; i++) {
        const o = i * CACHE, x0 = cache[o + 8], x1 = cache[o + 9];
        const ya = Math.max(cache[o + 10], y0), yb = Math.min(cache[o + 11], y1);
        if (x0 >= x1 || ya >= yb) continue;
        const k = i * STRIDE, cx = p[k], cy = p[k + 1], s = cache[o], c = cache[o + 1];
        const coreX = cache[o + 2], coreY = cache[o + 3], irx = cache[o + 4], iry = cache[o + 5];
        const hx = cache[o + 6], hy = cache[o + 7];
        const halfX = p[k + 2] * 0.5, halfY = p[k + 3] * 0.5, sx = p[k + 9], sy = p[k + 10];
        const rampLenX = Math.min(halfX, cap), rampLenY = Math.min(halfY, cap);
        const limX = halfX < cap ? 1 : 0, limY = halfY < cap ? 1 : 0;
        const cr = p[k + 5], cg = p[k + 6], cb = p[k + 7], ca = p[k + 8];
        const irx2 = irx * irx, iry2 = iry * iry;
        let gx = 0, gy = 0, gw = 0, gh = 0, grot = 0, gr = 0, gg = 0, gb = 0, ga = 0, gsx = 0, gsy = 0;
        for (let y = ya; y < yb; y++) {
          const dy = y + 0.5 - cy;
          rowSpan(cx, dy, c, s, hx, hy, x0, x1);
          const xa = SPAN[0], xb = SPAN[1], row = (y - y0) * width;
          for (let x = xa; x < xb; x++) {
            const dx = x + 0.5 - cx;
            const u = c * dx + s * dy, v = c * dy - s * dx;
            const ex0 = Math.abs(u) - coreX, ey0 = Math.abs(v) - coreY;
            const ex = ex0 > 0 ? ex0 : 0, ey = ey0 > 0 ? ey0 : 0;
            const qx = ex * irx, qy = ey * iry, d2 = qx * qx + qy * qy;
            if (d2 >= 1) continue;
            const dist = Math.sqrt(d2), t = 1 - dist;
            const kern = t * (0.5 + t * (1.5 - t));
            if (kern <= 0) continue;
            const q = row + x, at = q * 4;
            const tb = before[q], inv = 1 - kern * ca, denom = tb * inv;
            const after = denom > 1e-30 ? trans[q] / denom : 0;
            const a0 = adjoint[at] * after, a1 = adjoint[at + 1] * after, a2 = adjoint[at + 2] * after, a3 = adjoint[at + 3] * after;
            const dCov = a3 * bgT * tb - (comp[at] * a0 + comp[at + 1] * a1 + comp[at + 2] * a2);
            const dKernel = a0 * cr + a1 * cg + a2 * cb + dCov * ca;
            gr += a0 * kern; gg += a1 * kern; gb += a2 * kern; ga += dCov * kern;
            if (dist > 1e-6) {
              const slope = 0.5 + 3 * t * (1 - t), sd = slope / dist;
              const dqx = -sd * ex * irx2, dqy = -sd * ey * iry2;
              const dux = u > 0 ? dqx : u < 0 ? -dqx : 0, duy = v > 0 ? dqy : v < 0 ? -dqy : 0;
              const dRampX = sd * ex * ex * irx2 * irx + dqx;
              const dRampY = sd * ey * ey * iry2 * iry + dqy;
              gx -= (c * dux - s * duy) * dKernel;
              gy -= (s * dux + c * duy) * dKernel;
              grot += (dux * v - duy * u) * dKernel;
              gw += 0.5 * sx * (dRampX * limX - dqx) * dKernel;
              gh += 0.5 * sy * (dRampY * limY - dqy) * dKernel;
              gsx += (dRampX * rampLenX - dqx * halfX) * dKernel;
              gsy += (dRampY * rampLenY - dqy * halfY) * dKernel;
            }
            comp[at] = comp[at] * inv + cr * kern;
            comp[at + 1] = comp[at + 1] * inv + cg * kern;
            comp[at + 2] = comp[at + 2] * inv + cb * kern;
            comp[at + 3] = comp[at + 3] * inv + ca * kern;
            before[q] = denom;
          }
        }
        g[k] += gx; g[k + 1] += gy; g[k + 2] += gw; g[k + 3] += gh; g[k + 4] += grot;
        g[k + 5] += gr; g[k + 6] += gg; g[k + 7] += gb; g[k + 8] += ga; g[k + 9] += gsx; g[k + 10] += gsy;
      }
      return { loss, grad: g };
    }

    return { pass, get grad() { return grad; } };
  }

  /* Row ranges for `parts` bands with roughly equal work, estimated from each
   * splat's bounding box area. */
  function balanceRows(p, n, width, height, cap, parts) {
    const cost = new Float64Array(height + 1);
    for (let i = 0; i < n; i++) {
      const k = i * STRIDE, s = Math.abs(Math.sin(p[k + 4])), c = Math.abs(Math.cos(p[k + 4]));
      const hx = p[k + 2] * p[k + 9] * 0.5, hy = p[k + 3] * p[k + 10] * 0.5;
      const ax = c * hx + s * hy, ay = s * hx + c * hy;
      const y0 = Math.max(0, Math.floor(p[k + 1] - ay)), y1 = Math.min(height, Math.ceil(p[k + 1] + ay));
      const w = Math.min(width, Math.max(0, Math.min(width, p[k] + ax) - Math.max(0, p[k] - ax)) + 1);
      if (!(y0 < y1) || !(w > 0)) continue;
      cost[y0] += w; cost[y1] -= w;
    }
    const rows = new Float64Array(height);
    let run = 0, total = 0;
    for (let y = 0; y < height; y++) { run += cost[y]; rows[y] = run + width * 0.25; total += rows[y]; }
    const bounds = [0];
    let acc = 0, next = total / parts;
    for (let y = 0; y < height && bounds.length < parts; y++) {
      acc += rows[y];
      if (acc >= next) { bounds.push(y + 1); next = total * bounds.length / parts; }
    }
    while (bounds.length < parts) bounds.push(height);
    bounds.push(height);
    const out = [];
    for (let i = 0; i < parts; i++) out.push([bounds[i], Math.max(bounds[i], bounds[i + 1])]);
    return out;
  }

  function createFitter(target, width, height, params, background, options = {}) {
    const n = params.length / STRIDE, N = width * height, cap = rampCap(height);
    const p = params, lr = { ...LR, ...(options.lr || {}) };
    const weights = options.weights || null; // Float64Array(N), already shaped
    const m1 = new Float64Array(n * STRIDE), m2 = new Float64Array(n * STRIDE);
    const raw = new Float64Array(STRIDE), rg = new Float64Array(STRIDE);
    const scratch = {};
    const band = createBand(target, width, height, weights, background);
    let lastLoss = NaN;

    function forward() { return render(p, n, width, height, background, cap, scratch).pixels; }
    function localGradient() { return band.pass(p, n, cap, 0, height); }

    const logit = (x) => { const v = clamp(x, LOGIT_EPS, 1 - LOGIT_EPS); return Math.log(v / (1 - v)); };
    const sigmoid = (x) => 1 / (1 + Math.exp(-x));
    const rates = [lr.position, lr.position, lr.size, lr.size, lr.rotation, lr.color, lr.color, lr.color, lr.alpha, lr.scale, lr.scale];
    function adam(grad, lrScale) {
      for (let i = 0; i < n; i++) {
        const k = i * STRIDE, a = p[k + 8];
        const r = a > LOGIT_EPS ? p[k + 5] / a : 0.5, g = a > LOGIT_EPS ? p[k + 6] / a : 0.5, b = a > LOGIT_EPS ? p[k + 7] / a : 0.5;
        rg[0] = grad[k]; rg[1] = grad[k + 1];
        rg[2] = grad[k + 2] * p[k + 2]; rg[3] = grad[k + 3] * p[k + 3];
        rg[4] = grad[k + 4];
        rg[5] = grad[k + 5] * a * r * (1 - r); rg[6] = grad[k + 6] * a * g * (1 - g); rg[7] = grad[k + 7] * a * b * (1 - b);
        rg[8] = (grad[k + 8] + grad[k + 5] * r + grad[k + 6] * g + grad[k + 7] * b) * a * (1 - a);
        rg[9] = grad[k + 9] * p[k + 9]; rg[10] = grad[k + 10] * p[k + 10];
        raw[0] = p[k]; raw[1] = p[k + 1];
        raw[2] = Math.log(Math.max(p[k + 2], LOGIT_EPS)); raw[3] = Math.log(Math.max(p[k + 3], LOGIT_EPS));
        raw[4] = p[k + 4];
        raw[5] = logit(r); raw[6] = logit(g); raw[7] = logit(b); raw[8] = logit(a);
        raw[9] = Math.log(Math.max(p[k + 9], LOGIT_EPS)); raw[10] = Math.log(Math.max(p[k + 10], LOGIT_EPS));
        for (let j = 0; j < STRIDE; j++) {
          const at = k + j, gj = rg[j];
          m1[at] = m1[at] * BETA1 + gj * (1 - BETA1);
          m2[at] = m2[at] * BETA2 + gj * gj * (1 - BETA2);
          raw[j] -= lrScale * rates[j] * m1[at] / (Math.sqrt(m2[at]) + ADAM_EPS);
        }
        raw[2] = Math.min(raw[2], LN_SIZE_MAX); raw[3] = Math.min(raw[3], LN_SIZE_MAX);
        for (let j = 5; j <= 8; j++) raw[j] = clamp(raw[j], -10, 10);
        raw[9] = clamp(raw[9], -10, 10); raw[10] = clamp(raw[10], -10, 10);
        const na = sigmoid(raw[8]);
        p[k] = raw[0]; p[k + 1] = raw[1]; p[k + 2] = Math.exp(raw[2]); p[k + 3] = Math.exp(raw[3]); p[k + 4] = raw[4];
        p[k + 5] = sigmoid(raw[5]) * na; p[k + 6] = sigmoid(raw[6]) * na; p[k + 7] = sigmoid(raw[7]) * na; p[k + 8] = na;
        p[k + 9] = Math.exp(raw[9]); p[k + 10] = Math.exp(raw[10]);
      }
    }

    function lossOf(pixels) {
      const norm = 1 / (N * 6);
      let loss = 0;
      for (let q = 0; q < N; q++) {
        const o = q * 4, w = weights ? weights[q] : 1;
        const br = pixels[o] - target[o], bgg = pixels[o + 1] - target[o + 1], bb = pixels[o + 2] - target[o + 2];
        const da = target[o + 3] - pixels[o + 3], wr = br + da, wg = bgg + da, wb = bb + da;
        loss += (br * br + bgg * bgg + bb * bb + wr * wr + wg * wg + wb * wb) * norm * w;
      }
      return loss;
    }

    function redistribute(cellSize, moveCount, splatSize, seed) {
      const pixels = forward();
      const gw = Math.ceil(width / cellSize), gh = Math.ceil(height / cellSize), cells = gw * gh;
      const cellLoss = new Float64Array(cells), hot = new Int32Array(cells);
      for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
        let sum = 0, peak = -1, hotIdx = 0;
        for (let y = cy * cellSize; y < Math.min(height, (cy + 1) * cellSize); y++)
          for (let x = cx * cellSize; x < Math.min(width, (cx + 1) * cellSize); x++) {
            const q = y * width + x, o = q * 4, w = weights ? weights[q] : 1;
            const br = pixels[o] - target[o], bgg = pixels[o + 1] - target[o + 1], bb = pixels[o + 2] - target[o + 2];
            const da = target[o + 3] - pixels[o + 3], wr = br + da, wg = bgg + da, wb = bb + da;
            const l = (br * br + bgg * bgg + bb * bb + wr * wr + wg * wg + wb * wb) / 6 * w;
            sum += l;
            if (l > peak) { peak = l; hotIdx = q; }
          }
        cellLoss[cx + cy * gw] = sum; hot[cx + cy * gw] = hotIdx;
      }
      // Donor threshold from a loss histogram, then an inverse CDF for destinations.
      let total = 0, peak = 0;
      for (let i = 0; i < cells; i++) { total += cellLoss[i]; peak = Math.max(peak, cellLoss[i]); }
      const binScale = peak > 0 ? (BINS - 1) / peak : 0, hist = new Uint32Array(BINS);
      for (let i = 0; i < cells; i++) hist[Math.min(Math.floor(cellLoss[i] * binScale), BINS - 1)]++;
      let below = 0, bin = 0;
      while (bin + 1 < BINS) { if (below + hist[bin] > moveCount) break; below += hist[bin]; bin++; }
      const frac = clamp((moveCount - below) / Math.max(hist[bin], 1), 0, 1);
      const lo = bin / Math.max(binScale, 1e-20), hi = (bin + 1) / Math.max(binScale, 1e-20);
      const cdf = new Uint32Array(INVERSE_CDF_SIZE);
      let cum = 0, ci = 0;
      for (let slot = 0; slot < INVERSE_CDF_SIZE; slot++) {
        const goal = total * slot / (INVERSE_CDF_SIZE - 1);
        while (ci + 1 < cells) { if (cum + cellLoss[ci] >= goal) break; cum += cellLoss[ci]; ci++; }
        cdf[slot] = ci;
      }
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const k = i * STRIDE, x = p[k], y = p[k + 1];
        let move = !(x >= 0 && y >= 0 && x < width && y < height);
        if (!move) {
          const sxp = Math.floor(clamp(x, 0.5, width - 0.5)), syp = Math.floor(clamp(y, 0.5, height - 0.5));
          const extent = Math.sqrt(p[k + 2] * p[k + 9] * p[k + 3] * p[k + 10]);
          const cover = smoothstep(0.5, 1.5, extent) * smoothstep(0, 0.01, p[k + 8]) * smoothstep(0, 0.05, target[(syp * width + sxp) * 4 + 3]);
          move = hash(i, 7) < 1 - cover;
        }
        if (!move) {
          const l = cellLoss[Math.floor(x / cellSize) + Math.floor(y / cellSize) * gw];
          move = l < lo || (l < hi && hash(i, seed) < frac);
        }
        if (!move) continue;
        const slot = Math.min(Math.floor(hash(i, 101) * (INVERSE_CDF_SIZE - 1)), INVERSE_CDF_SIZE - 1);
        const q = hot[cdf[slot]], dx = clamp(q % width + 0.5, 0.5, width - 0.5), dy = clamp(Math.floor(q / width) + 0.5, 0.5, height - 0.5);
        const d = (Math.floor(dy) * width + Math.floor(dx)) * 4;
        p[k] = dx; p[k + 1] = dy; p[k + 2] = splatSize; p[k + 3] = splatSize; p[k + 4] = 0;
        p[k + 5] = target[d]; p[k + 6] = target[d + 1]; p[k + 7] = target[d + 2]; p[k + 8] = target[d + 3];
        p[k + 9] = 1; p[k + 10] = 1;
        moved++;
      }
      return moved;
    }

    function redistributeArgs(iter, iters) {
      const spacing = Math.sqrt(N / Math.max(1, n)), progress = iter / iters;
      const cellSize = Math.max(1, Math.floor(Math.max(1, spacing * 2 ** (1 - 3 * progress))));
      const cells = Math.ceil(width / cellSize) * Math.ceil(height / cellSize);
      return [cellSize, Math.max(1, Math.floor(0.5 * 2 ** (-3 * progress) * cells)), spacing * 0.9];
    }

    /* Runs `iters` steps like upstream Learner::run. `gradient(p)` may return
     * a promise (threaded bands); `hooks.each(iter)` returning false stops.
     * Unlike upstream, no redistribution happens after the final step, so
     * every moved splat still gets fitted. */
    async function run(iters, lrScale, every, seed, hooks = {}) {
      const random = rng(seed), gradient = hooks.gradient || localGradient;
      for (let iter = 0; iter < iters; iter++) {
        let out = gradient(p);
        if (out && typeof out.then === "function") out = await out;
        lastLoss = out.loss;
        adam(out.grad, lrScale);
        if (every > 0 && iter % every === 0 && iter + 1 < iters) {
          const [cellSize, moveCount, splatSize] = redistributeArgs(iter, iters);
          redistribute(cellSize, moveCount, splatSize, Math.floor(random() * 4294967296));
        }
        if (hooks.each) {
          let keep = hooks.each(iter + 1);
          if (keep && typeof keep.then === "function") keep = await keep;
          if (keep === false) return false;
        }
      }
      return true;
    }

    function step(lrScale = 1) { const out = localGradient(); lastLoss = out.loss; adam(out.grad, lrScale); return lastLoss; }

    return {
      params: p, count: n, width, height, background, cap,
      step, run, redistribute, adam,
      render: forward,
      loss: () => lossOf(forward()),
      _gradient: (index) => localGradient().grad[index],
      get lastLoss() { return lastLoss; },
    };
  }

  /* Upstream loss weights: grey value raised to 1.4. */
  function shapeWeights(values) {
    const out = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = Math.max(0, values[i]) ** LOSS_WEIGHT_GAMMA;
    return out;
  }

  /* ── conversion between fitted parameters, site elements and JSON ── */
  const hex2 = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0");
  function packed(r, g, b, a) {
    const A = Math.min(255, Math.max(0, Math.round(a * 255)));
    return ((A * 16777216) + (Math.round(r * 255) << 16) + (Math.round(g * 255) << 8) + Math.round(b * 255)) >>> 0;
  }

  /* Fitted params (fit pixels) → site elements (image units, y negative down). */
  function toElements(p, n, fw, fh, width, height, unit, alphaScale = 1) {
    const ax = width / fw, ay = height / fh, out = [];
    for (let i = 0; i < n; i++) {
      const k = i * STRIDE, a = p[k + 8];
      const r = a > 1e-8 ? clamp(p[k + 5] / a, 0, 1) : 0, g = a > 1e-8 ? clamp(p[k + 6] / a, 0, 1) : 0, b = a > 1e-8 ? clamp(p[k + 7] / a, 0, 1) : 0;
      const alpha = clamp(a * alphaScale, 0, 1);
      out.push({
        id: i, type: "splat", shape: "splat", primitive_type: "splat", image_type: "Stretch", image_asset_ref: ASSET,
        center: { x: p[k] * ax * unit, y: -p[k + 1] * ay * unit },
        size: { width: p[k + 2] * ax * unit, height: p[k + 3] * ay * unit },
        scale: { x: p[k + 9], y: p[k + 10] },
        rotation: { x: 0, y: 0, z: -p[k + 4] * 180 / Math.PI },
        color: "#" + hex2(r) + hex2(g) + hex2(b), alpha, packed_color: packed(r, g, b, alpha),
      });
    }
    return out;
  }

  function backgroundElement(background, width, height, unit) {
    const a = background[3];
    if (!(a > 0)) return null;
    const r = clamp(background[0] / a, 0, 1), g = clamp(background[1] / a, 0, 1), b = clamp(background[2] / a, 0, 1);
    return {
      type: "rectangle", shape: "rect", primitive_type: "rect", image_asset_ref: BACKGROUND_ASSET, is_background: true,
      center: { x: width / 2 * unit, y: -height / 2 * unit }, size: { width: width * unit, height: height * unit },
      rotation: { x: 0, y: 0, z: 0 }, color: "#" + hex2(r) + hex2(g) + hex2(b), alpha: a, packed_color: packed(r, g, b, a),
    };
  }

  const isSplat = (el) => !!el && el.type === "splat";

  function colorOf(el) {
    const hex = String(el.color || "#000000").replace("#", "");
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const a = clamp(Number(el.alpha), 0, 1) || 0;
    return [parseInt(full.slice(0, 2), 16) / 255 * a, parseInt(full.slice(2, 4), 16) / 255 * a, parseInt(full.slice(4, 6), 16) / 255 * a, a];
  }

  /* Elements → render params in a target raster `factor` × image pixels. The
   * first background element (if any) becomes the background colour. */
  function fromElements(elements, ppu, factor = 1) {
    const splats = elements.filter(isSplat), p = new Float64Array(splats.length * STRIDE);
    const bgEl = elements.find((el) => el.is_background);
    splats.forEach((el, i) => {
      const k = i * STRIDE, c = colorOf(el), f = ppu * factor;
      p[k] = el.center.x * f; p[k + 1] = -el.center.y * f;
      p[k + 2] = el.size.width * f; p[k + 3] = el.size.height * f;
      p[k + 4] = -Number(el.rotation?.z ?? el.rotation ?? 0) * Math.PI / 180;
      p[k + 5] = c[0]; p[k + 6] = c[1]; p[k + 7] = c[2]; p[k + 8] = c[3];
      p[k + 9] = Number(el.scale?.x ?? 1); p[k + 10] = Number(el.scale?.y ?? 1);
    });
    return { params: p, count: splats.length, background: bgEl ? colorOf(bgEl) : [0, 0, 0, 0] };
  }

  function renderElements(elements, width, height, ppu, factor = 1) {
    const w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
    const { params, count, background } = fromElements(elements, ppu, w / width);
    const { pixels } = render(params, count, w, h, background, rampCap(h));
    return { rgba: toRGBA8(pixels, w, h), width: w, height: h };
  }

  /* Upstream splats.json fields (uv, y up, radians CCW, premultiplied colour). */
  function toIr(elements, width, height, ppu) {
    const { params, count, background } = fromElements(elements, ppu, 1);
    const round = (v) => Math.round(v * 1e7) / 1e7;
    const splats = [];
    for (let i = 0; i < count; i++) {
      const k = i * STRIDE;
      splats.push({
        pos: [round(params[k] / width), round(1 - params[k + 1] / height)],
        size: [round(params[k + 2] / width), round(params[k + 3] / height)],
        rot: round(-params[k + 4]),
        color: [round(params[k + 5]), round(params[k + 6]), round(params[k + 7]), round(params[k + 8])],
        scale: [round(params[k + 9]), round(params[k + 10])],
      });
    }
    return { aspect_ratio: width / height, background: background.map(round), splats };
  }

  return {
    REF_HEIGHT, RAMP_CAP, ASSET, BACKGROUND_ASSET, STRIDE, LR,
    rng, rampCap, render, toRGBA8, premultiply, downsample, initialize, createFitter, createBand, balanceRows, shapeWeights,
    toElements, backgroundElement, fromElements, renderElements, toIr, isSplat, colorOf, hash, profile: (t) => { const u = clamp(t, 0, 1); return u * (0.5 + u * (1.5 - u)); },
  };
})();

if (typeof module !== "undefined") module.exports = SplatCore;
