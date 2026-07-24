/*
 * imaging.js — pure-JS ports of the OpenCV / NumPy primitives used by the
 * Python backend (shaper_core.py / final_shaper.py / primitive_backend.py).
 *
 * All images are flat typed arrays. RGBA images are Uint8ClampedArray of
 * length w*h*4 (as produced by ImageData). Masks are Uint8Array (0/255).
 */
"use strict";

const Imaging = (() => {

  /* ---------------- basic helpers ---------------- */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  const FR = Math.fround;

  /* np.rint — round half to EVEN (banker's rounding). Matches numpy exactly. */
  function rintHalfEven(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return (f % 2 === 0) ? f : f + 1;
  }

  /* cvRound — OpenCV rounds half to EVEN (matches C rint under default mode). */
  function cvRound(x) { return rintHalfEven(x); }

  /* cv2.cvtColor(BGR2GRAY) fixed-point, OpenCV 5.0.0 (shift=15).
   * Inputs are the R,G,B components; returns the uint8 gray value.
   * gray = (R*9798 + G*19235 + B*3735 + (1<<14)) >> 15
   * (byte-identical to cv2 over the full 24-bit color space). */
  function bgr2grayFixed(r, g, b) {
    return (r * 9798 + g * 19235 + b * 3735 + 16384) >> 15;
  }

  /* ---------------- Otsu threshold ----------------
   * Matches cv2.threshold(..., THRESH_OTSU): returns threshold t; pixels > t
   * become 255 (binary) — OpenCV uses `src > thresh` for THRESH_BINARY.
   */
  function otsuThreshold(gray, n) {
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxVar = -1, threshold = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = n - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; threshold = t; }
    }
    return threshold;
  }

  /* ---------------- morphology ----------------
   * 3x3 MORPH_ELLIPSE structuring element == cross:
   *   0 1 0
   *   1 1 1
   *   0 1 0
   */
  function erodeCross3(mask, w, h) {
    const out = new Uint8Array(w * h);
    // interior: no bounds checks (identical results; borders handled below)
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        out[i] = (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) ? 255 : 0;
      }
    }
    // borders: original replicate-padded logic (top/bottom rows + side columns)
    const erodeAt = (x, y) => {
      const i = y * w + x;
      const c = mask[i];
      const l = x > 0 ? mask[i - 1] : c;
      const r = x < w - 1 ? mask[i + 1] : c;
      const u = y > 0 ? mask[i - w] : c;
      const d = y < h - 1 ? mask[i + w] : c;
      out[i] = (c && l && r && u && d) ? 255 : 0;
    };
    for (let x = 0; x < w; x++) { erodeAt(x, 0); if (h > 1) erodeAt(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { erodeAt(0, y); if (w > 1) erodeAt(w - 1, y); }
    return out;
  }

  function dilateCross3(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        out[i] = (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) ? 255 : 0;
      }
    }
    const dilateAt = (x, y) => {
      const i = y * w + x;
      const c = mask[i];
      const l = x > 0 ? mask[i - 1] : 0;
      const r = x < w - 1 ? mask[i + 1] : 0;
      const u = y > 0 ? mask[i - w] : 0;
      const d = y < h - 1 ? mask[i + w] : 0;
      out[i] = (c || l || r || u || d) ? 255 : 0;
    };
    for (let x = 0; x < w; x++) { dilateAt(x, 0); if (h > 1) dilateAt(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { dilateAt(0, y); if (w > 1) dilateAt(w - 1, y); }
    return out;
  }

  function morphClose(mask, w, h) { return erodeCross3(dilateCross3(mask, w, h), w, h); }
  function morphOpen(mask, w, h) { return dilateCross3(erodeCross3(mask, w, h), w, h); }

  function dilateSquare(mask, w, h, radius) {
    // Square 3x3 kernel (np.ones), applied `radius` times. The square SE is
    // separable: horizontal 3-max then vertical 3-max covers exactly the
    // same 3x3 window — identical 0/255 output, 6 reads/px instead of 9
    // with no inner bounds checks.
    let cur = mask;
    for (let it = 0; it < radius; it++) {
      const tmp = new Uint8Array(w * h);
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        if (w === 1) {
          tmp[row] = cur[row];
          continue;
        }
        tmp[row] = cur[row] | cur[row + 1];
        for (let x = 1; x < w - 1; x++) {
          const i = row + x;
          tmp[i] = cur[i - 1] | cur[i] | cur[i + 1];
        }
        tmp[row + w - 1] = cur[row + w - 2] | cur[row + w - 1];
      }
      // vertical pass writes the canonical 0/255 values (any nonzero → 255),
      // matching the original for arbitrary byte inputs
      if (h === 1) {
        for (let x = 0; x < w; x++) out[x] = tmp[x] ? 255 : 0;
      } else {
        for (let x = 0; x < w; x++) out[x] = (tmp[x] | tmp[x + w]) ? 255 : 0;
        for (let y = 1; y < h - 1; y++) {
          const row = y * w;
          for (let x = 0; x < w; x++) {
            const i = row + x;
            out[i] = (tmp[i - w] | tmp[i] | tmp[i + w]) ? 255 : 0;
          }
        }
        const last = (h - 1) * w;
        for (let x = 0; x < w; x++) out[last + x] = (tmp[last - w + x] | tmp[last + x]) ? 255 : 0;
      }
      cur = out;
    }
    return cur;
  }

  /* ---------------- distance transform ----------------
   * Byte-identical port of cv2.distanceTransform(mask, DIST_L2, 5) as computed
   * by the installed OpenCV 5.0.0 build. That build ships Intel IPP, so
   * cv2 uses ippiDistanceTransform_5x5, which is a PURE float32 two-pass
   * chamfer (5x5 Borgefors) with metrics HV=1.0, DIAG=1.4, LONG=2.1969 and
   * foreground initialised to FLT_MAX. Every float op is done in float32 via
   * Math.fround so the result matches cv2 with max abs diff 0.
   *
   * NOTE: this deliberately does NOT reproduce the fixed-point Borgefors path
   * used by OpenCV's non-IPP C++ build (which differs by ~1e-5). The golden
   * is the installed cv2 (IPP). See tests/parity/cv2.
   */
  const FLT_MAX = 3.4028234663852886e+38;
  function chamferDistanceTransform(mask, w, h) {
    if (w === 0 || h === 0) return new Float32Array(0);
    const A = FR(1.0), B = FR(1.4), C = FR(2.1969);
    const BW = w + 4;                       // 2-pixel border on each side
    const T = new Float32Array(BW * (h + 4));
    T.fill(FLT_MAX);

    // forward pass
    for (let y = 0; y < h; y++) {
      const srow = y * w, base = (y + 2) * BW + 2;
      for (let x = 0; x < w; x++) {
        if (mask[srow + x] === 0) { T[base + x] = 0; continue; }
        const i = base + x;
        let m = FR(T[i - BW] + A);            // top1[j]
        let t;
        t = FR(T[i - 2 * BW - 1] + C); if (t < m) m = t;  // top2[j-1]
        t = FR(T[i - 2 * BW + 1] + C); if (t < m) m = t;  // top2[j+1]
        t = FR(T[i - BW - 2] + C);     if (t < m) m = t;  // top1[j-2]
        t = FR(T[i - BW - 1] + B);     if (t < m) m = t;  // top1[j-1]
        t = FR(T[i - BW + 1] + B);     if (t < m) m = t;  // top1[j+1]
        t = FR(T[i - BW + 2] + C);     if (t < m) m = t;  // top1[j+2]
        t = FR(T[i - 1] + A);          if (t < m) m = t;  // left
        T[i] = m;
      }
    }
    // backward pass
    for (let y = h - 1; y >= 0; y--) {
      const base = (y + 2) * BW + 2;
      for (let x = w - 1; x >= 0; x--) {
        const i = base + x;
        let m = T[i], t;
        t = FR(T[i + 2 * BW + 1] + C); if (t < m) m = t;  // bot2[j+1]
        t = FR(T[i + 2 * BW - 1] + C); if (t < m) m = t;  // bot2[j-1]
        t = FR(T[i + BW + 2] + C);     if (t < m) m = t;  // bot1[j+2]
        t = FR(T[i + BW + 1] + B);     if (t < m) m = t;  // bot1[j+1]
        t = FR(T[i + BW] + A);         if (t < m) m = t;  // bot1[j]
        t = FR(T[i + BW - 1] + B);     if (t < m) m = t;  // bot1[j-1]
        t = FR(T[i + BW - 2] + C);     if (t < m) m = t;  // bot1[j-2]
        t = FR(T[i + 1] + A);          if (t < m) m = t;  // right
        T[i] = m;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const base = (y + 2) * BW + 2, orow = y * w;
      for (let x = 0; x < w; x++) out[orow + x] = T[base + x];
    }
    return out;
  }
  // Back-compat alias — callers use Imaging.distanceTransform.
  const distanceTransform = chamferDistanceTransform;

  /* ---------------- contour extraction ----------------
   * Suzuki–Abe border following (cv2.findContours with RETR_LIST-like
   * output + CHAIN_APPROX_NONE semantics: every border — outer borders
   * and hole borders — as ordered pixel chains [x0,y0,x1,y1,...]).
   */
  function findContoursRaw(mask, w, h) {
    // Pad by 1 pixel of zeros so border pixels behave per the algorithm.
    const W = w + 2, H = h + 2;
    const img = new Int32Array(W * H);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        img[(y + 1) * W + (x + 1)] = mask[y * w + x] ? 1 : 0;
      }
    }

    // 8-neighborhood, counterclockwise order (x right, y down):
    // 0:E 1:NE 2:N 3:NW 4:W 5:SW 6:S 7:SE
    const dx8 = [1, 1, 0, -1, -1, -1, 0, 1];
    const dy8 = [0, -1, -1, -1, 0, 1, 1, 1];

    function dirFromTo(x0, y0, x1, y1) {
      const dx = x1 - x0, dy = y1 - y0;
      for (let k = 0; k < 8; k++) if (dx8[k] === dx && dy8[k] === dy) return k;
      return 0;
    }

    const contours = [];
    let nbd = 1;

    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const v = img[i];
        if (v === 0) continue;

        let start2x = -1, start2y = -1, isHole = false;
        if (v === 1 && img[i - 1] === 0) {
          // outer border start
          start2x = x - 1; start2y = y;
        } else if (v >= 1 && img[i + 1] === 0) {
          // hole border start
          start2x = x + 1; start2y = y;
          isHole = true;
        } else {
          continue;
        }

        nbd++;
        const points = [];

        // Step 3.1: clockwise search around (x,y) from (start2) for nonzero
        const d0 = dirFromTo(x, y, start2x, start2y);
        let d1 = -1;
        for (let k = 0; k < 8; k++) {
          const dir = (d0 - k + 16) % 8; // clockwise (decreasing CCW index)
          const xx = x + dx8[dir], yy = y + dy8[dir];
          if (img[yy * W + xx] !== 0) { d1 = dir; break; }
        }
        if (d1 === -1) {
          // isolated pixel
          img[i] = -nbd;
          points.push(x - 1, y - 1);
          contours.push({ points, hole: isHole });
          continue;
        }
        const x1 = x + dx8[d1], y1 = y + dy8[d1];

        // Step 3.2
        let x2 = x1, y2 = y1;   // previous neighbor
        let x3 = x, y3 = y;     // current border pixel

        for (;;) {
          // Step 3.3: counterclockwise search around (x3,y3) starting
          // just after (x2,y2), for the first nonzero pixel (x4,y4).
          const dPrev = dirFromTo(x3, y3, x2, y2);
          let d4 = -1, examinedEastZero = false;
          for (let k = 1; k <= 8; k++) {
            const dir = (dPrev + k) % 8; // counterclockwise
            const xx = x3 + dx8[dir], yy = y3 + dy8[dir];
            if (img[yy * W + xx] !== 0) { d4 = dir; break; }
            if (dir === 0) examinedEastZero = true; // east neighbor examined & zero
          }

          // Step 3.4: mark current pixel
          const ci = y3 * W + x3;
          if (examinedEastZero) img[ci] = -nbd;
          else if (img[ci] === 1) img[ci] = nbd;

          points.push(x3 - 1, y3 - 1);

          if (d4 === -1) break; // safety (cannot happen after 3.1 found one)
          const x4 = x3 + dx8[d4], y4 = y3 + dy8[d4];

          // Step 3.5: termination — back at start pixel and about to repeat
          if (x4 === x && y4 === y && x3 === x1 && y3 === y1) break;

          x2 = x3; y2 = y3;
          x3 = x4; y3 = y4;
          if (points.length > 4 * W * H) break; // safety
        }

        contours.push({ points, hole: isHole });
      }
    }
    return contours;
  }

  /* even-odd point-in-polygon (ray cast); poly = flat [x0,y0,...] */
  function pointInPoly(px, py, poly) {
    let inside = false;
    const n = poly.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = poly[2 * i + 1], yj = poly[2 * j + 1];
      if ((yi > py) !== (yj > py)) {
        const xi = poly[2 * i], xj = poly[2 * j];
        if (px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  /* findContours — cv2.findContours(mask, RETR_TREE, CHAIN_APPROX_NONE).
   * The raw Suzuki-Abe follower produces byte-identical point chains in raster
   * discovery order. OpenCV, however, returns them in a specific tree order:
   * a pre-order DFS of the contour tree that visits siblings in REVERSE order
   * of discovery (OpenCV builds the tree by prepending each new child, then
   * flattens with its TreeIterator — see contours_common.{hpp,cpp}). We
   * rebuild the nesting tree geometrically and emit in that exact order so
   * element ids / processing order match the Python pipeline. */
  function findContours(mask, w, h) {
    const cs = findContoursRaw(mask, w, h);
    const N = cs.length;
    if (N <= 1) return cs;

    const fills = new Array(N), reps = new Array(N), areas = new Array(N), bb = new Array(N);
    for (let i = 0; i < N; i++) {
      const pts = cs[i].points;
      const f = rasterizePolygon(pts, w, h);
      fills[i] = f;
      areas[i] = contourArea(pts);
      bb[i] = boundingRect(pts);
      // representative interior pixel = first set pixel of the fill (raster),
      // which lies near the top of the contour's own region (above children).
      let rx = pts[0], ry = pts[1];
      for (let k = 0; k < w * h; k++) { if (f[k]) { rx = k % w; ry = (k / w) | 0; break; } }
      reps[i] = [rx + 0.5, ry + 0.5];
    }

    const parent = new Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const px = reps[i][0], py = reps[i][1];
      let best = -1, bestArea = Infinity;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const r = bb[j];
        if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
        if (areas[j] >= bestArea) continue;
        if (pointInPoly(px, py, cs[j].points)) { bestArea = areas[j]; best = j; }
      }
      // hole/outer alternation: if the innermost enclosing border has the same
      // hole-ness, the parent is *its* parent (matches Suzuki-Abe topology).
      if (best !== -1 && cs[best].hole === cs[i].hole) best = parent[best];
      parent[i] = best;
    }

    const children = Array.from({ length: N }, () => []);
    const roots = [];
    for (let i = 0; i < N; i++) {
      if (parent[i] === -1) roots.push(i); else children[parent[i]].push(i);
    }
    const out = [];
    const emit = (sibs) => {
      for (let k = sibs.length - 1; k >= 0; k--) { out.push(cs[sibs[k]]); emit(children[sibs[k]]); }
    };
    emit(roots);
    return out;
  }

  /* contour helpers (points = flat [x0,y0,x1,y1,...]) */

  function contourArea(points) {
    const n = points.length / 2;
    if (n < 3) return 0;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1];
    }
    return Math.abs(area) / 2;
  }

  function boundingRect(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      if (points[i] < minX) minX = points[i];
      if (points[i] > maxX) maxX = points[i];
      if (points[i + 1] < minY) minY = points[i + 1];
      if (points[i + 1] > maxY) maxY = points[i + 1];
    }
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /* Douglas-Peucker ring simplification (≈ shapely simplify(tol)) */
  function simplifyRing(points, tol) {
    const n = points.length / 2;
    if (n < 5) return points.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = points[2 * a], ay = points[2 * a + 1];
      const bx = points[2 * b], by = points[2 * b + 1];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1e-12;
      let maxD = -1, maxI = -1;
      for (let i = a + 1; i < b; i++) {
        const px = points[2 * i] - ax, py = points[2 * i + 1] - ay;
        const d = Math.abs(px * dy - py * dx) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > tol) {
        keep[maxI] = 1;
        stack.push([a, maxI], [maxI, b]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      if (keep[i]) out.push(points[2 * i], points[2 * i + 1]);
    }
    return out;
  }

  /* rasterize a polygon ring into a bitmap (255 inside), even-odd fill */
  function rasterizePolygon(points, w, h) {
    const out = new Uint8Array(w * h);
    const n = points.length / 2;
    if (n < 3) return out;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = points[2 * i + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const yc = y + 0.5;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ya = points[2 * i + 1], yb = points[2 * j + 1];
        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) {
          const t = (yc - ya) / (yb - ya);
          xs.push(points[2 * i] + t * (points[2 * j] - points[2 * i]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k]));
        const xb = Math.min(w - 1, Math.round(xs[k + 1]));
        for (let x = xa; x <= xb; x++) out[y * w + x] = 255;
      }
    }
    return out;
  }

  /* ---------------- shape rasterization on Uint8 masks ----------------
   * Equivalents of cv2.ellipse(..., -1) and cv2.drawContours(boxPoints)
   * used by render_coverage_mask / render_element_to_mask.
   */
  function fillEllipseMask(out, w, h, cx, cy, rx, ry, angleDeg) {
    rx = Math.max(rx, 1); ry = Math.max(ry, 1);
    const a = angleDeg * Math.PI / 180;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const extX = Math.sqrt(rx * rx * cosA * cosA + ry * ry * sinA * sinA) + 1;
    const extY = Math.sqrt(rx * rx * sinA * sinA + ry * ry * cosA * cosA) + 1;
    const x0 = Math.max(0, Math.floor(cx - extX)), x1 = Math.min(w - 1, Math.ceil(cx + extX));
    const y0 = Math.max(0, Math.floor(cy - extY)), y1 = Math.min(h - 1, Math.ceil(cy + extY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const lx = dx * cosA + dy * sinA;
        const ly = -dx * sinA + dy * cosA;
        if ((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1) out[y * w + x] = 255;
      }
    }
  }

  function fillRotRectMask(out, w, h, cx, cy, rw, rh, angleDeg) {
    rw = Math.max(rw, 1); rh = Math.max(rh, 1);
    const a = angleDeg * Math.PI / 180;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const hw = rw / 2, hh = rh / 2;
    const ext = Math.sqrt(hw * hw + hh * hh) + 1;
    const x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(w - 1, Math.ceil(cx + ext));
    const y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(h - 1, Math.ceil(cy + ext));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const lx = dx * cosA + dy * sinA;
        const ly = -dx * sinA + dy * cosA;
        if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) out[y * w + x] = 255;
      }
    }
  }

  /* count of set pixels & overlap helpers */
  function countNonZero(mask) {
    let c = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
    return c;
  }

  /* ---------------- gaussian_filter1d (scipy, mode='reflect') ---------- */
  function gaussianFilter1d(arr, sigma) {
    const n = arr.length;
    if (n === 0 || sigma <= 0) return Float64Array.from(arr);
    const radius = Math.max(1, Math.round(4 * sigma));
    const kernel = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      kernel[i + radius] = v;
      sum += v;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let idx = i + k;
        // reflect mode: (-1 -> 0, -2 -> 1, n -> n-1, n+1 -> n-2)
        while (idx < 0 || idx >= n) {
          if (idx < 0) idx = -idx - 1;
          if (idx >= n) idx = 2 * n - idx - 1;
        }
        acc += arr[idx] * kernel[k + radius];
      }
      out[i] = acc;
    }
    return out;
  }

  /* np.gradient for 1-D arrays */
  function gradient1d(arr) {
    const n = arr.length;
    const out = new Float64Array(n);
    if (n < 2) return out;
    out[0] = arr[1] - arr[0];
    out[n - 1] = arr[n - 1] - arr[n - 2];
    for (let i = 1; i < n - 1; i++) out[i] = (arr[i + 1] - arr[i - 1]) / 2;
    return out;
  }

  /* ---------------- resize (area-average / bilinear) ----------------
   * Replaces cv2.resize INTER_AREA (downscale) and INTER_LINEAR (upscale)
   * for RGBA buffers.
   */
  function resizeRGBA(src, sw, sh, dw, dh) {
    const dst = new Uint8ClampedArray(dw * dh * 4);
    if (dw === sw && dh === sh) { dst.set(src); return dst; }
    if (dw < sw || dh < sh) {
      // area average
      const xr = sw / dw, yr = sh / dh;
      for (let dy = 0; dy < dh; dy++) {
        const sy0 = dy * yr, sy1 = Math.min(sh, (dy + 1) * yr);
        for (let dx = 0; dx < dw; dx++) {
          const sx0 = dx * xr, sx1 = Math.min(sw, (dx + 1) * xr);
          let r = 0, g = 0, b = 0, a = 0, wsum = 0;
          for (let sy = Math.floor(sy0); sy < sy1; sy++) {
            const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
            for (let sx = Math.floor(sx0); sx < sx1; sx++) {
              const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
              const wgt = wx * wy;
              const i = (sy * sw + sx) * 4;
              r += src[i] * wgt; g += src[i + 1] * wgt;
              b += src[i + 2] * wgt; a += src[i + 3] * wgt;
              wsum += wgt;
            }
          }
          const o = (dy * dw + dx) * 4;
          dst[o] = r / wsum; dst[o + 1] = g / wsum;
          dst[o + 2] = b / wsum; dst[o + 3] = a / wsum;
        }
      }
    } else {
      // bilinear
      const xr = sw / dw, yr = sh / dh;
      for (let dy = 0; dy < dh; dy++) {
        const fy = (dy + 0.5) * yr - 0.5;
        const y0 = clamp(Math.floor(fy), 0, sh - 1);
        const y1 = Math.min(y0 + 1, sh - 1);
        const ty = fy - y0;
        for (let dx = 0; dx < dw; dx++) {
          const fx = (dx + 0.5) * xr - 0.5;
          const x0 = clamp(Math.floor(fx), 0, sw - 1);
          const x1 = Math.min(x0 + 1, sw - 1);
          const tx = fx - x0;
          const o = (dy * dw + dx) * 4;
          for (let c = 0; c < 4; c++) {
            const v00 = src[(y0 * sw + x0) * 4 + c];
            const v01 = src[(y0 * sw + x1) * 4 + c];
            const v10 = src[(y1 * sw + x0) * 4 + c];
            const v11 = src[(y1 * sw + x1) * 4 + c];
            dst[o + c] = v00 * (1 - tx) * (1 - ty) + v01 * tx * (1 - ty) +
                         v10 * (1 - tx) * ty + v11 * tx * ty;
          }
        }
      }
    }
    return dst;
  }

  function resizeGray(src, sw, sh, dw, dh) {
    // bilinear grayscale resize (for alpha maps)
    const dst = new Uint8ClampedArray(dw * dh);
    const xr = sw / dw, yr = sh / dh;
    for (let dy = 0; dy < dh; dy++) {
      const fy = (dy + 0.5) * yr - 0.5;
      const y0 = clamp(Math.floor(fy), 0, sh - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const ty = fy - y0;
      for (let dx = 0; dx < dw; dx++) {
        const fx = (dx + 0.5) * xr - 0.5;
        const x0 = clamp(Math.floor(fx), 0, sw - 1);
        const x1 = Math.min(x0 + 1, sw - 1);
        const tx = fx - x0;
        const v00 = src[y0 * sw + x0], v01 = src[y0 * sw + x1];
        const v10 = src[y1 * sw + x0], v11 = src[y1 * sw + x1];
        dst[dy * dw + dx] = v00 * (1 - tx) * (1 - ty) + v01 * tx * (1 - ty) +
                            v10 * (1 - tx) * ty + v11 * tx * ty;
      }
    }
    return dst;
  }

  /* ---------------- mask extraction (final_shaper.extract_mask) -------- */

  function extractMask(rgba, w, h, hasAlpha) {
    const n = w * h;
    // Strategy 1: alpha channel
    if (hasAlpha) {
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = rgba[i * 4 + 3] > 127 ? 255 : 0;
      return mask;
    }

    // grayscale — OpenCV 5.0.0 BGR2GRAY fixed-point (shift=15).
    const gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      gray[i] = bgr2grayFixed(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }

    // Strategy 2: border sampling + color distance + Otsu
    const margin = Math.max(2, Math.floor(Math.min(h, w) / 50));
    const rs = [], gs = [], bs = [];
    function sample(x, y) {
      const i = (y * w + x) * 4;
      rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2]);
    }
    for (let y = 0; y < margin; y++) for (let x = 0; x < w; x++) sample(x, y);
    for (let y = h - margin; y < h; y++) for (let x = 0; x < w; x++) sample(x, y);
    for (let y = margin; y < h - margin; y++) {
      for (let x = 0; x < margin; x++) sample(x, y);
      for (let x = w - margin; x < w; x++) sample(x, y);
    }
    const med = (arr) => {
      arr.sort((a, b) => a - b);
      const m = arr.length >> 1;
      return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
    };
    const bgR = med(rs), bgG = med(gs), bgB = med(bs);

    const distU8 = new Uint8Array(n);
    let maxDist = 1.0;
    const distArr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const dr = rgba[i * 4] - bgR, dg = rgba[i * 4 + 1] - bgG, db = rgba[i * 4 + 2] - bgB;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      distArr[i] = d;
      if (d > maxDist) maxDist = d;
    }
    // np.clip(color_dist / max_dist * 255, 0, 255).astype(np.uint8) — astype
    // TRUNCATES toward zero (values are >= 0, so this is floor).
    for (let i = 0; i < n; i++) distU8[i] = clamp(Math.floor(distArr[i] / maxDist * 255), 0, 255);

    const t = otsuThreshold(distU8, n);
    const mask = new Uint8Array(n);
    let fg = 0;
    for (let i = 0; i < n; i++) {
      if (distU8[i] > t) { mask[i] = 255; fg++; }
    }
    let fgRatio = fg / n;
    if (fgRatio > 0.01 && fgRatio < 0.95) return mask;

    // Strategy 3: gray Otsu inverted
    const t2 = otsuThreshold(gray, n);
    const mask2 = new Uint8Array(n);
    fg = 0;
    for (let i = 0; i < n; i++) {
      if (gray[i] <= t2) { mask2[i] = 255; fg++; }
    }
    fgRatio = fg / n;
    if (fgRatio > 0.01 && fgRatio < 0.95) return mask2;

    // Last resort: fixed threshold 240 inverted
    const mask3 = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask3[i] = gray[i] <= 240 ? 255 : 0;
    return mask3;
  }

  /* flatten RGBA onto white, FLOAT64 math.
   * Matches shaper_core._flatten_to_bgr / _extract_fill_image_and_mask:
   *   flattened = base*alpha + 255*(1-alpha) ; clip(rint(flattened),0,255) uint8
   * with alpha = A/255 and all arithmetic in float64 (np default). */
  function flattenOnWhite(rgba, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = rgba[i * 4 + 3] / 255;
      const bg = 255 * (1 - a);
      out[i * 4]     = clamp(rintHalfEven(rgba[i * 4]     * a + bg), 0, 255);
      out[i * 4 + 1] = clamp(rintHalfEven(rgba[i * 4 + 1] * a + bg), 0, 255);
      out[i * 4 + 2] = clamp(rintHalfEven(rgba[i * 4 + 2] * a + bg), 0, 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /* flatten RGBA onto white, FLOAT32 math.
   * Matches primitive_backend._extract_image_and_mask (4-ch) /
   * _prepare_transparent_target: same formula but every op in float32. */
  function flattenOnWhiteF32(rgba, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const a = FR(rgba[i * 4 + 3] / 255);
      const bg = FR(255 * FR(1 - a));
      out[i * 4]     = clamp(rintHalfEven(FR(FR(rgba[i * 4]     * a) + bg)), 0, 255);
      out[i * 4 + 1] = clamp(rintHalfEven(FR(FR(rgba[i * 4 + 1] * a) + bg)), 0, 255);
      out[i * 4 + 2] = clamp(rintHalfEven(FR(FR(rgba[i * 4 + 2] * a) + bg)), 0, 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /* _compress_alpha_for_fitting — float32, returns a 256-entry LUT (uint8).
   * Matches primitive_backend._compress_alpha_for_fitting exactly for all 256
   * input alpha values. floor/gamma default to the PNG fit constants. */
  function compressAlphaLUT(floor, gamma) {
    if (floor === undefined) floor = 0.2;
    if (gamma === undefined) gamma = 1.6;
    const flClamped = clamp(floor, 0.0, 0.95);        // python float (f64)
    const gm = Math.max(0.1, gamma);                  // python float (f64)
    const flF = FR(flClamped);                        // float32(floor)
    const denomF = FR(Math.max(1e-6, 1 - flClamped)); // float32(1-floor)
    const gmF = FR(gm);                               // float32(gamma)
    const lut = new Uint8Array(256);
    for (let a = 0; a < 256; a++) {
      let al = FR(a / 255);                 // clip(...,0,1) is a no-op here
      let c = FR(al - flF);
      c = FR(c / denomF);
      if (c < 0) c = 0; else if (c > 1) c = 1;
      c = FR(Math.pow(c, gmF));
      const v = FR(c * 255);
      lut[a] = clamp(rintHalfEven(v), 0, 255);
    }
    return lut;
  }

  /* ═══════════ cv2 drawing (ellipse/box fill) — byte-exact port of
     OpenCV 5.0.0 drawing.cpp. cvEllipseFill matches cv2.ellipse(...,-1) via
     EllipseEx→FillConvexPoly; cvBoxFill matches boxPoints→drawContours(-1)
     via fillPoly (CollectPolyEdges+FillEdgeCollection). See tests/parity. ═══════════ */
  const __cvDraw = (() => {
/*
 * Pure-JavaScript, byte-identical ports of two OpenCV 5.0.0 filled-shape
 * rasterizations:
 *   (1) cvEllipseFill  ~  cv2.ellipse(mask,(cx,cy),(ax,ay),angle,0,360,255,-1)   (LINE_8, shift=0)
 *   (2) cvBoxFill      ~  bpts=np.intp(cv2.boxPoints(((cx,cy),(rw,rh),angle)));
 *                          cv2.drawContours(mask,[bpts],0,255,-1)
 *
 * Ported directly from opencv/modules/imgproc/src/drawing.cpp (5.0.0).
 * All fixed-point math is 16.16 (XY_SHIFT=16). cvRound = round-half-to-even.
 */

const XY_SHIFT = 16;
const XY_ONE = 1 << XY_SHIFT; // 65536
const INT_MAX = 2147483647;

// ---- rounding / fixed-point helpers -------------------------------------

// cvRound: round to nearest, ties to even (matches OpenCV default FPU mode).
function cvRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  // exactly .5 -> round to even
  return (f % 2 === 0) ? f : f + 1;
}

// arithmetic shift right by 16 for arbitrary (possibly negative) integer values
function sar16(x) {
  return Math.floor(x / XY_ONE);
}

// integer division truncating toward zero (C/C++ int64 division)
function idiv(a, b) {
  return Math.trunc(a / b);
}

// ---- SinTable -----------------------------------------------------------
// OpenCV stores 451 float32 constants: round(sin(i deg), 7) for i=0..450.
// Reproduce the exact float32 values.
const SinTable = (function () {
  const t = new Array(451);
  for (let i = 0; i <= 450; i++) {
    const v = Math.sin((i * Math.PI) / 180);
    // round to 7 decimals exactly as the C source literals, then to float32
    t[i] = Math.fround(parseFloat(v.toFixed(7)));
  }
  // guard the exact anchors
  t[0] = 0; t[90] = 1; t[180] = 0; t[270] = -1; t[360] = 0; t[450] = 1;
  return t;
})();

// ---- clipLine (Size2l variant) ------------------------------------------
// Mutates p1,p2 ({x,y}); returns true if any part of the segment is inside.
function clipLine2l(width, height, p1, p2) {
  if (width <= 0 || height <= 0) return false;
  const right = width - 1;
  const bottom = height - 1;
  let x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
  const B = (b) => (b ? 1 : 0);
  let c1 = B(x1 < 0) + B(x1 > right) * 2 + B(y1 < 0) * 4 + B(y1 > bottom) * 8;
  let c2 = B(x2 < 0) + B(x2 > right) * 2 + B(y2 < 0) * 4 + B(y2 > bottom) * 8;

  if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
    let a;
    if (c1 & 12) {
      a = c1 < 8 ? 0 : bottom;
      x1 += Math.trunc(((a - y1) * (x2 - x1)) / (y2 - y1));
      y1 = a;
      c1 = B(x1 < 0) + B(x1 > right) * 2;
    }
    if (c2 & 12) {
      a = c2 < 8 ? 0 : bottom;
      x2 += Math.trunc(((a - y2) * (x2 - x1)) / (y2 - y1));
      y2 = a;
      c2 = B(x2 < 0) + B(x2 > right) * 2;
    }
    if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
      if (c1) {
        a = c1 === 1 ? 0 : right;
        y1 += Math.trunc(((a - x1) * (y2 - y1)) / (x2 - x1));
        x1 = a;
        c1 = 0;
      }
      if (c2) {
        a = c2 === 1 ? 0 : right;
        y2 += Math.trunc(((a - x2) * (y2 - y1)) / (x2 - x1));
        x2 = a;
        c2 = 0;
      }
    }
  }
  p1.x = x1; p1.y = y1; p2.x = x2; p2.y = y2;
  return (c1 | c2) === 0;
}

// ---- Line (8-connected LineIterator, used by box/CollectPolyEdges) -------
// Integer endpoints, connectivity 8, leftToRight=true, full-image rect.
function LineInt(mask, w, h, x1, y1, x2, y2) {
  const p1 = { x: x1, y: y1 }, p2 = { x: x2, y: y2 };
  if ((x1 >>> 0) >= (w >>> 0) || (x2 >>> 0) >= (w >>> 0) ||
      (y1 >>> 0) >= (h >>> 0) || (y2 >>> 0) >= (h >>> 0)) {
    if (!clipLine2l(w, h, p1, p2)) return;
  }
  let px1 = p1.x, py1 = p1.y, px2 = p2.x, py2 = p2.y;
  let delta_x = 1, delta_y = 1;
  let dx = px2 - px1, dy = py2 - py1;
  if (dx < 0) {
    // leftToRight: start from the right endpoint, negate deltas
    dx = -dx; dy = -dy;
    px1 = px2; py1 = py2;
  }
  if (dy < 0) { dy = -dy; delta_y = -1; }
  const vert = dy > dx;
  if (vert) { let t; t = dx; dx = dy; dy = t; t = delta_x; delta_x = delta_y; delta_y = t; }

  const err0 = dx - (dy + dy);
  const plusDelta = dx + dx;
  const minusDelta = -(dy + dy);
  let minusShift = delta_x, plusShift = 0, minusStep = 0, plusStep = delta_y;
  const count = dx + 1;
  if (vert) {
    let t;
    t = plusStep; plusStep = plusShift; plusShift = t;
    t = minusStep; minusStep = minusShift; minusShift = t;
  }
  // plusStep/minusStep are ROW deltas, plusShift/minusShift are COL deltas.
  let err = err0;
  let x = px1, y = py1;
  if (x >= 0 && x < w && y >= 0 && y < h) mask[y * w + x] = 255;
  for (let k = 1; k < count; k++) {
    const m = err < 0 ? -1 : 0;
    err += minusDelta + (m ? plusDelta : 0);
    x += minusShift + (m ? plusShift : 0);
    y += minusStep + (m ? plusStep : 0);
    if (x >= 0 && x < w && y >= 0 && y < h) mask[y * w + x] = 255;
  }
}

// ---- Line2 (fixed-point line, used by FillConvexPoly for the ellipse) ----
function Line2(mask, w, h, pt1, pt2) {
  const p1 = { x: pt1.x, y: pt1.y }, p2 = { x: pt2.x, y: pt2.y };
  if (!clipLine2l(w * XY_ONE, h * XY_ONE, p1, p2)) return;

  let dx = p2.x - p1.x, dy = p2.y - p1.y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  let x_step, y_step, ecount;

  if (ax > ay) {
    if (dx < 0) {
      dy = -dy;
      let t; t = p1.x; p1.x = p2.x; p2.x = t; t = p1.y; p1.y = p2.y; p2.y = t;
    }
    x_step = XY_ONE;
    y_step = idiv(dy * XY_ONE, (ax | 1));
    ecount = sar16(p2.x - p1.x);
  } else {
    if (dy < 0) {
      dx = -dx;
      let t; t = p1.x; p1.x = p2.x; p2.x = t; t = p1.y; p1.y = p2.y; p2.y = t;
    }
    x_step = idiv(dx * XY_ONE, (ay | 1));
    y_step = XY_ONE;
    ecount = sar16(p2.y - p1.y);
  }

  p1.x += XY_ONE >> 1;
  p1.y += XY_ONE >> 1;

  const put = (xx, yy) => {
    if (xx >= 0 && xx < w && yy >= 0 && yy < h) mask[yy * w + xx] = 255;
  };

  // endpoint
  put(sar16(p2.x + (XY_ONE >> 1)), sar16(p2.y + (XY_ONE >> 1)));

  if (ax > ay) {
    let cx = sar16(p1.x); // pixel x
    let fy = p1.y;        // fixed y
    while (ecount >= 0) {
      put(cx, sar16(fy));
      cx += 1;
      fy += y_step;
      ecount--;
    }
  } else {
    let cy = sar16(p1.y); // pixel y
    let fx = p1.x;        // fixed x
    while (ecount >= 0) {
      put(sar16(fx), cy);
      fx += x_step;
      cy += 1;
      ecount--;
    }
  }
}

// horizontal fill span [xl, xr] inclusive on row y (assumes y in-bounds)
function hline(mask, w, y, xl, xr) {
  const base = y * w;
  for (let x = xl; x <= xr; x++) mask[base + x] = 255;
}

// ---- FillConvexPoly (ellipse fill), v = fixed-point (16.16) vertices -----
function FillConvexPoly(mask, w, h, v, line_type) {
  const npts = v.length;
  const shift = XY_SHIFT;
  const delta = (1 << shift) >> 1; // 32768
  let imin = 0;
  let edgesLeft = npts;
  const delta1 = XY_ONE >> 1, delta2 = XY_ONE >> 1; // line_type < LINE_AA

  let p0 = { x: v[npts - 1].x, y: v[npts - 1].y }; // <<= (XY_SHIFT-shift)=0

  let xmin = v[0].x, xmax = v[0].x, ymin = v[0].y, ymax = v[0].y;

  for (let i = 0; i < npts; i++) {
    const p = { x: v[i].x, y: v[i].y };
    if (p.y < ymin) { ymin = p.y; imin = i; }
    if (p.y > ymax) ymax = p.y;
    if (p.x > xmax) xmax = p.x;
    if (p.x < xmin) xmin = p.x;
    // shift != 0 -> Line2
    Line2(mask, w, h, p0, p);
    p0 = p;
  }

  xmin = sar16(xmin + delta);
  xmax = sar16(xmax + delta);
  ymin = sar16(ymin + delta);
  ymax = sar16(ymax + delta);

  if (npts < 3 || xmax < 0 || ymax < 0 || xmin >= w || ymin >= h) return;

  if (ymax > h - 1) ymax = h - 1;

  const edge = [
    { idx: imin, di: 1, x: -XY_ONE, dx: 0, ye: ymin },
    { idx: imin, di: npts - 1, x: -XY_ONE, dx: 0, ye: ymin },
  ];
  let y = ymin;

  do {
    // update active edges
    for (let i = 0; i < 2; i++) {
      if (y >= edge[i].ye) {
        let idx0 = edge[i].idx, di = edge[i].di;
        let idx = idx0 + di; if (idx >= npts) idx -= npts;
        while (edgesLeft-- > 0) {
          const ty = sar16(v[idx].y + delta);
          if (ty > y) {
            const xs = v[idx0].x;
            const xe = v[idx].x;
            edge[i].ye = ty;
            edge[i].dx = idiv((xe - xs) * 2 + (ty - y), 2 * (ty - y));
            edge[i].x = xs;
            edge[i].idx = idx;
            break;
          }
          idx0 = idx; idx += di; if (idx >= npts) idx -= npts;
        }
      }
    }

    if (edgesLeft < 0) break;

    if (y >= 0) {
      let left = 0, right = 1;
      if (edge[0].x > edge[1].x) { left = 1; right = 0; }
      let xx1 = sar16(edge[left].x + delta1);
      let xx2 = sar16(edge[right].x + delta2);
      if (xx2 >= 0 && xx1 < w) {
        if (xx1 < 0) xx1 = 0;
        if (xx2 >= w) xx2 = w - 1;
        hline(mask, w, y, xx1, xx2);
      }
    }

    edge[0].x += edge[0].dx;
    edge[1].x += edge[1].dx;
    y++;
  } while (y <= ymax);
}

// ---- CollectPolyEdges / FillEdgeCollection (box fill) --------------------
function CollectPolyEdges(mask, w, h, v, edges, line_type, shift, offset) {
  const count = v.length;
  const scale = 1 << (XY_SHIFT - shift);      // multiply factor (avoid 32-bit <<)
  const sdiv = 1 << shift;                     // divide factor for >> shift
  const delta = offset.y + ((1 << shift) >> 1);
  // pt0 = v[count-1]
  let pt0x = (v[count - 1].x + offset.x) * scale;
  let pt0y = Math.floor((v[count - 1].y + delta) / sdiv);

  for (let i = 0; i < count; i++) {
    let pt1x = (v[i].x + offset.x) * scale;
    let pt1y = Math.floor((v[i].y + delta) / sdiv);

    let pt0cx = pt0x, pt0cy = pt0y;
    let pt1cx = pt1x, pt1cy = pt1y;

    // line_type < LINE_AA
    const t0y = pt0y, t1y = pt1y;
    const tp = { x: sar16(pt0x + (XY_ONE >> 1)), y: t0y };
    const tq = { x: sar16(pt1x + (XY_ONE >> 1)), y: t1y };
    LineInt(mask, w, h, tp.x, tp.y, tq.x, tq.y);

    // use clipped endpoints to create a more accurate PolyEdge
    if ((tp.x >>> 0) >= (w >>> 0) || (tq.x >>> 0) >= (w >>> 0) ||
        (tp.y >>> 0) >= (h >>> 0) || (tq.y >>> 0) >= (h >>> 0)) {
      clipLine2l(w, h, tp, tq);
      if (tp.y !== tq.y) { pt0cy = tp.y; pt1cy = tq.y; }
    }
    pt0cx = tp.x * XY_ONE;
    pt1cx = tq.x * XY_ONE;

    if (pt0y !== pt1y) {
      const edx = idiv(pt1cx - pt0cx, pt1cy - pt0cy);
      let ey0, ey1, ex;
      if (pt0y < pt1y) {
        ey0 = pt0y; ey1 = pt1y;
        ex = pt0cx + (pt0y - pt0cy) * edx;
      } else {
        ey0 = pt1y; ey1 = pt0y;
        ex = pt1cx + (pt1y - pt1cy) * edx;
      }
      edges.push({ y0: ey0, y1: ey1, x: ex, dx: edx, next: null });
    }

    pt0x = pt1x; pt0y = pt1y;
  }
}

function cmpEdges(a, b) {
  if (a.y0 !== b.y0) return a.y0 < b.y0 ? -1 : 1;
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  if (a.dx !== b.dx) return a.dx < b.dx ? -1 : 1;
  return 0;
}

function FillEdgeCollection(mask, w, h, edges) {
  const total = edges.length;
  const delta = XY_ONE - 1;
  if (total < 2) return;

  let y_max = -Infinity, y_min = Infinity;
  let x_max = -Infinity, x_min = Infinity;
  for (let i = 0; i < total; i++) {
    const e1 = edges[i];
    const x1 = e1.x + (e1.y1 - e1.y0) * e1.dx;
    if (e1.y0 < y_min) y_min = e1.y0;
    if (e1.y1 > y_max) y_max = e1.y1;
    if (e1.x < x_min) x_min = e1.x;
    if (e1.x > x_max) x_max = e1.x;
    if (x1 < x_min) x_min = x1;
    if (x1 > x_max) x_max = x1;
  }

  if (y_max < 0 || y_min >= h || x_max < 0 || x_min >= (w * XY_ONE)) return;

  edges.sort(cmpEdges);

  const tmp = { y0: INT_MAX, y1: 0, x: 0, dx: 0, next: null };
  edges.push(tmp);
  let i = 0;
  tmp.next = null;
  let e = edges[i];
  if (y_max > h) y_max = h;

  for (let y = e.y0; y < y_max; y++) {
    let prelast, last, keep_prelast;
    let draw = 0;
    const clipline = y < 0;

    prelast = tmp;
    last = tmp.next;
    while (last || e.y0 === y) {
      if (last && last.y1 === y) {
        prelast.next = last.next;
        last = last.next;
        continue;
      }
      keep_prelast = prelast;
      if (last && (e.y0 > y || last.x < e.x)) {
        prelast = last;
        last = last.next;
      } else if (i < total) {
        prelast.next = e;
        e.next = last;
        prelast = e;
        e = edges[++i];
      } else {
        break;
      }

      if (draw) {
        if (!clipline) {
          let x1, x2;
          if (keep_prelast.x > prelast.x) {
            x1 = sar16(prelast.x + delta);
            x2 = sar16(keep_prelast.x);
          } else {
            x1 = sar16(keep_prelast.x + delta);
            x2 = sar16(prelast.x);
          }
          if (x1 < w && x2 >= 0) {
            if (x1 < 0) x1 = 0;
            if (x2 >= w) x2 = w - 1;
            hline(mask, w, y, x1, x2);
          }
        }
        keep_prelast.x += keep_prelast.dx;
        prelast.x += prelast.dx;
      }
      draw ^= 1;
    }

    // bubble sort of the active edge list by x
    keep_prelast = null;
    do {
      prelast = tmp;
      last = tmp.next;
      let last_exchange = null;
      while (last !== keep_prelast && last.next !== null) {
        const te = last.next;
        if (last.x > te.x) {
          prelast.next = te;
          last.next = te.next;
          te.next = last;
          prelast = te;
          last_exchange = prelast;
        } else {
          prelast = last;
          last = te;
        }
      }
      if (last_exchange === null) break;
      keep_prelast = last_exchange;
    } while (keep_prelast !== tmp.next && keep_prelast !== tmp);
  }
}

// ---- ellipse2Poly + EllipseEx -------------------------------------------
function sincos(angle) {
  // angle already normalized to [0,360]
  return { cos: SinTable[450 - angle], sin: SinTable[angle] };
}

// returns array of Point2d {x,y}
function ellipse2Poly(cx, cy, aw, ah, angle, delta) {
  // normalize angle
  while (angle < 0) angle += 360;
  while (angle > 360) angle -= 360;
  let arc_start = 0, arc_end = 360;
  const sc = sincos(angle);
  const alpha = sc.cos, beta = sc.sin;
  const pts = [];
  for (let i = arc_start; i < arc_end + delta; i += delta) {
    let a = i;
    if (a > arc_end) a = arc_end;
    if (a < 0) a += 360;
    const x = aw * SinTable[450 - a];
    const y = ah * SinTable[a];
    pts.push({ x: cx + x * alpha - y * beta, y: cy + x * beta + y * alpha });
  }
  if (pts.length === 1) { pts.push({ x: cx, y: cy }); }
  return pts;
}

function EllipseEx(mask, w, h, centerX, centerY, axW, axH, angle) {
  axW = Math.abs(axW); axH = Math.abs(axH);
  let delta = sar16(Math.max(axW, axH) + (XY_ONE >> 1));
  delta = delta < 3 ? 90 : delta < 10 ? 30 : delta < 15 ? 18 : 5;

  const _v = ellipse2Poly(centerX, centerY, axW, axH, angle, delta);

  const v = [];
  let prevX = -1, prevY = -1; // 0xFFFF...FFFF as int64 = -1
  for (let i = 0; i < _v.length; i++) {
    let px = cvRound(_v[i].x / XY_ONE) * XY_ONE;
    let py = cvRound(_v[i].y / XY_ONE) * XY_ONE;
    px += cvRound(_v[i].x - px);
    py += cvRound(_v[i].y - py);
    if (px !== prevX || py !== prevY) {
      v.push({ x: px, y: py });
      prevX = px; prevY = py;
    }
  }
  if (v.length <= 1) {
    v.length = 0;
    v.push({ x: centerX, y: centerY });
    v.push({ x: centerX, y: centerY });
  }

  // full 360 filled -> FillConvexPoly (line_type = LINE_8)
  FillConvexPoly(mask, w, h, v, 8);
}

// ---- public: ellipse fill -----------------------------------------------
function cvEllipseFill(mask, w, h, cx, cy, ax, ay, angle) {
  const _angle = cvRound(angle);
  // center <<= XY_SHIFT-shift (shift=0), axes <<= 16
  const centerX = cx * XY_ONE;
  const centerY = cy * XY_ONE;
  const axW = ax * XY_ONE;
  const axH = ay * XY_ONE;
  EllipseEx(mask, w, h, centerX, centerY, axW, axH, _angle);
  return mask;
}

// ---- boxPoints (RotatedRect::points), byte-exact vs cv2 5.0.0 -----------
function boxPoints(cx, cy, rw, rh, angle) {
  const f = Math.fround;
  cx = f(cx); cy = f(cy); rw = f(rw); rh = f(rh); angle = f(angle);
  const _angle = (angle * Math.PI) / 180; // double
  const b = f(f(Math.cos(_angle)) * 0.5);
  const a = f(f(Math.sin(_angle)) * 0.5);
  const ah = f(a * rh), aw = f(a * rw), bh = f(b * rh), bw = f(b * rw);
  return [
    { x: f(f(cx - ah) - bw), y: f(f(cy + bh) - aw) },
    { x: f(f(cx + ah) - bw), y: f(f(cy - bh) - aw) },
    { x: f(f(cx + ah) + bw), y: f(f(cy - bh) + aw) },
    { x: f(f(cx - ah) + bw), y: f(f(cy + bh) + aw) },
  ];
}

// ---- public: rotated-rect (box) fill ------------------------------------
function cvBoxFill(mask, w, h, cx, cy, rw, rh, angle) {
  const fpts = boxPoints(cx, cy, rw, rh, angle);
  // np.intp truncation toward zero
  const v = fpts.map((p) => ({ x: Math.trunc(p.x), y: Math.trunc(p.y) }));
  const edges = [];
  // drawContours filled -> fillPoly(LINE_8, shift=0, offset=(0,0))
  CollectPolyEdges(mask, w, h, v, edges, 8, 0, { x: 0, y: 0 });
  FillEdgeCollection(mask, w, h, edges);
  return mask;
}

  // general integer-polygon fill (fillPoly, LINE_8, shift 0). pts = flat [x0,y0,...].
  function cvFillPoly(mask, w, h, pts) {
    const v = [];
    for (let i = 0; i < pts.length; i += 2) v.push({ x: pts[i] | 0, y: pts[i + 1] | 0 });
    const edges = [];
    CollectPolyEdges(mask, w, h, v, edges, 8, 0, { x: 0, y: 0 });
    FillEdgeCollection(mask, w, h, edges);
    return mask;
  }
    return { cvEllipseFill, cvBoxFill, cvFillPoly, boxPoints };
  })();
  const cvEllipseFill = __cvDraw.cvEllipseFill;
  const cvBoxFill = __cvDraw.cvBoxFill;
  const cvFillPoly = __cvDraw.cvFillPoly;
  const boxPoints = __cvDraw.boxPoints;

  /* ═══════════ cv2.resize (INTER_AREA / INTER_LINEAR, uint8) — byte-exact
     port of OpenCV 5.0.0 resize.cpp scalar paths (IPP bypassed for these
     cases). Operates per-channel on interleaved Uint8. See tests/parity. ═══════════ */
  const __cvResize = (() => {
// Pure-JS byte-identical port of OpenCV 5.0.0 cv2.resize for uint8 images.
// Supports interp='linear' (cv2.INTER_LINEAR) and interp='area' (cv2.INTER_AREA).
// Reconstructed from opencv/modules/imgproc/src/resize.cpp (5.0.0), C++ scalar
// paths (IPP is bypassed by OpenCV for 8u INTER_LINEAR and for INTER_AREA/ippSuper).

var FR = Math.fround;
var DBL_EPSILON = 2.220446049250313e-16;
var INTER_RESIZE_COEF_SCALE = 2048; // 1<<11

// Round-half-to-even (matches C++ cvRound with default FE_TONEAREST).
function cvRound(x) {
  var f = Math.floor(x);
  var d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return (f % 2 === 0) ? f : f + 1;
}
function satU8(v) {
  var r = cvRound(v);
  return r < 0 ? 0 : (r > 255 ? 255 : r);
}
function satS16(v) {
  var r = cvRound(v);
  return r < -32768 ? -32768 : (r > 32767 ? 32767 : r);
}
// clip(x, 0, len): C++ static clip => x>=a ? (x<b? x : b-1) : a
function clip(x, len) {
  return x >= 0 ? (x < len ? x : len - 1) : 0;
}

// ---------- INTER_AREA fast integer-ratio path (resizeAreaFast_) ----------
function areaFast(src, srcW, srcH, dstW, dstH, cn, out, iscale_x, iscale_y) {
  var area = iscale_x * iscale_y;
  var scale = FR(1.0 / area);       // float scale = 1.f/area
  var srcstep = srcW * cn;
  var dwidth1 = ((srcW / iscale_x) | 0) * cn;
  var dsw = dstW * cn;
  var ssw = srcW * cn;

  var ofs = new Int32Array(area);
  var k = 0;
  for (var sy = 0; sy < iscale_y; sy++)
    for (var sx = 0; sx < iscale_x; sx++)
      ofs[k++] = sy * srcstep + sx * cn;

  var xofs = new Int32Array(dsw);
  for (var dx = 0; dx < dstW; dx++) {
    var j = dx * cn, sxb = iscale_x * j;
    for (var kk = 0; kk < cn; kk++) xofs[j + kk] = sxb + kk;
  }

  var fast = (iscale_x === 2 && iscale_y === 2 && (cn === 1 || cn === 3 || cn === 4));

  for (var dy = 0; dy < dstH; dy++) {
    var Doff = dy * dsw;
    var sy0 = dy * iscale_y;
    var w = (sy0 + iscale_y <= srcH) ? dwidth1 : 0;
    if (sy0 >= srcH) { for (var q = 0; q < dsw; q++) out[Doff + q] = 0; continue; }
    var S0 = sy0 * srcstep;
    var dxi = 0;

    if (fast) {
      var nx = S0 + srcstep;
      if (cn === 1) {
        for (; dxi < w; dxi++) {
          var i1 = dxi * 2;
          out[Doff + dxi] = (src[S0 + i1] + src[S0 + i1 + 1] + src[nx + i1] + src[nx + i1 + 1] + 2) >> 2;
        }
      } else if (cn === 3) {
        for (; dxi < w; dxi += 3) {
          var i3 = dxi * 2;
          out[Doff + dxi]     = (src[S0 + i3]     + src[S0 + i3 + 3] + src[nx + i3]     + src[nx + i3 + 3] + 2) >> 2;
          out[Doff + dxi + 1] = (src[S0 + i3 + 1] + src[S0 + i3 + 4] + src[nx + i3 + 1] + src[nx + i3 + 4] + 2) >> 2;
          out[Doff + dxi + 2] = (src[S0 + i3 + 2] + src[S0 + i3 + 5] + src[nx + i3 + 2] + src[nx + i3 + 5] + 2) >> 2;
        }
      } else { // cn === 4
        for (; dxi < w; dxi += 4) {
          var i4 = dxi * 2;
          out[Doff + dxi]     = (src[S0 + i4]     + src[S0 + i4 + 4] + src[nx + i4]     + src[nx + i4 + 4] + 2) >> 2;
          out[Doff + dxi + 1] = (src[S0 + i4 + 1] + src[S0 + i4 + 5] + src[nx + i4 + 1] + src[nx + i4 + 5] + 2) >> 2;
          out[Doff + dxi + 2] = (src[S0 + i4 + 2] + src[S0 + i4 + 6] + src[nx + i4 + 2] + src[nx + i4 + 6] + 2) >> 2;
          out[Doff + dxi + 3] = (src[S0 + i4 + 3] + src[S0 + i4 + 7] + src[nx + i4 + 3] + src[nx + i4 + 7] + 2) >> 2;
        }
      }
    } else {
      for (; dxi < w; dxi++) {
        var Soff = S0 + xofs[dxi];
        var sum = 0;
        for (var m = 0; m < area; m++) sum += src[Soff + ofs[m]];
        out[Doff + dxi] = satU8(FR(sum * scale));
      }
    }

    for (; dxi < dsw; dxi++) {
      var sum2 = 0, count = 0, sx0 = xofs[dxi];
      for (var sy2 = 0; sy2 < iscale_y; sy2++) {
        if (sy0 + sy2 >= srcH) break;
        var Sb = (sy0 + sy2) * srcstep + sx0;
        for (var sx3 = 0; sx3 < iscale_x * cn; sx3 += cn) {
          if (sx0 + sx3 >= ssw) break;
          sum2 += src[Sb + sx3];
          count++;
        }
      }
      out[Doff + dxi] = count > 0 ? satU8(FR(sum2 / count)) : 0;
    }
  }
}

// ---------- INTER_AREA generic fractional path (resizeArea_, WT=float) ----------
function computeAreaTab(ssize, dsize, cn, scale) {
  var tab = [];
  for (var dx = 0; dx < dsize; dx++) {
    var fsx1 = dx * scale;
    var fsx2 = fsx1 + scale;
    var cellWidth = Math.min(scale, ssize - fsx1);
    var sx1 = Math.ceil(fsx1), sx2 = Math.floor(fsx2);
    sx2 = Math.min(sx2, ssize - 1);
    sx1 = Math.min(sx1, sx2);
    if (sx1 - fsx1 > 1e-3)
      tab.push(dx * cn, (sx1 - 1) * cn, FR((sx1 - fsx1) / cellWidth));
    for (var sx = sx1; sx < sx2; sx++)
      tab.push(dx * cn, sx * cn, FR(1.0 / cellWidth));
    if (fsx2 - sx2 > 1e-3)
      tab.push(dx * cn, sx2 * cn, FR(Math.min(Math.min(fsx2 - sx2, 1.0), cellWidth) / cellWidth));
  }
  return tab; // flat triples [di, si, alpha, ...]
}

function areaGeneric(src, srcW, srcH, dstW, dstH, cn, out, scale_x, scale_y) {
  var dsw = dstW * cn;
  var ssw = srcW * cn;
  var xtab = computeAreaTab(srcW, dstW, cn, scale_x);
  var ytab = computeAreaTab(srcH, dstH, 1, scale_y);
  var buf = new Float32Array(dsw);
  var sum = new Float32Array(dsw);
  var xn = xtab.length, yn = ytab.length;

  var prev_dy = ytab[0];
  for (var j = 0; j < yn; j += 3) {
    var dy = ytab[j];
    var sy = ytab[j + 1];
    var beta = ytab[j + 2];
    var srow = sy * ssw;
    buf.fill(0);
    for (var k = 0; k < xn; k += 3) {
      var dxn = xtab[k];
      var sxn = xtab[k + 1];
      var alpha = xtab[k + 2];
      for (var c = 0; c < cn; c++)
        buf[dxn + c] = FR(buf[dxn + c] + FR(src[srow + sxn + c] * alpha));
    }
    if (dy !== prev_dy) {
      var Po = prev_dy * dsw;
      for (var d = 0; d < dsw; d++) out[Po + d] = satU8(sum[d]);
      for (var d2 = 0; d2 < dsw; d2++) sum[d2] = FR(beta * buf[d2]);
      prev_dy = dy;
    } else {
      for (var d3 = 0; d3 < dsw; d3++) sum[d3] = FR(sum[d3] + FR(beta * buf[d3]));
    }
  }
  var Pf = prev_dy * dsw;
  for (var e = 0; e < dsw; e++) out[Pf + e] = satU8(sum[e]);
}

// ---------- generic bilinear fixed-point path (linear_tab); also INTER_AREA upscale (area_mode) ----------
function genericLinear(src, srcW, srcH, dstW, dstH, cn, out, scale_x, scale_y, inv_scale_x, inv_scale_y, area_mode) {
  var width = dstW * cn;
  var ssw = srcW * cn;
  var xofs = new Int32Array(width);
  var ialpha = new Int32Array(width * 2);
  var yofs = new Int32Array(dstH);
  var ibeta = new Int32Array(dstH * 2);
  var xmin = 0, xmax = dstW;
  var dx, k, fx, sx;

  for (dx = 0; dx < dstW; dx++) {
    if (!area_mode) {
      fx = FR((dx + 0.5) * scale_x - 0.5);
      sx = Math.floor(fx);
      fx = FR(fx - sx);
    } else {
      sx = Math.floor(dx * scale_x);
      fx = FR((dx + 1) - (sx + 1) * inv_scale_x);
      fx = fx <= 0 ? 0 : FR(fx - Math.floor(fx));
    }
    if (sx < 0) { // sx < ksize2-1 (==0)
      xmin = dx + 1;
      fx = 0; sx = 0;
    }
    if (sx + 1 >= srcW) { // sx + ksize2 >= srcW
      xmax = Math.min(xmax, dx);
      if (sx >= srcW - 1) { fx = 0; sx = srcW - 1; }
    }
    var sxc = sx * cn;
    var a0 = satS16(FR(FR(1 - fx) * INTER_RESIZE_COEF_SCALE));
    var a1 = satS16(FR(fx * INTER_RESIZE_COEF_SCALE));
    for (k = 0; k < cn; k++) {
      var fi = dx * cn + k;
      xofs[fi] = sxc + k;
      ialpha[fi * 2] = a0;
      ialpha[fi * 2 + 1] = a1;
    }
  }

  for (var dy = 0; dy < dstH; dy++) {
    var fy, sy;
    if (!area_mode) {
      fy = FR((dy + 0.5) * scale_y - 0.5);
      sy = Math.floor(fy);
      fy = FR(fy - sy);
    } else {
      sy = Math.floor(dy * scale_y);
      fy = FR((dy + 1) - (sy + 1) * inv_scale_y);
      fy = fy <= 0 ? 0 : FR(fy - Math.floor(fy));
    }
    yofs[dy] = sy;
    ibeta[dy * 2] = satS16(FR(FR(1 - fy) * INTER_RESIZE_COEF_SCALE));
    ibeta[dy * 2 + 1] = satS16(FR(fy * INTER_RESIZE_COEF_SCALE));
  }

  var xmaxc = xmax * cn;
  var row0 = new Int32Array(width);
  var row1 = new Int32Array(width);

  function hresize(srow, D) {
    var x = 0;
    for (; x < xmaxc; x++) {
      var s = srow + xofs[x];
      D[x] = src[s] * ialpha[x * 2] + src[s + cn] * ialpha[x * 2 + 1];
    }
    for (; x < width; x++) D[x] = src[srow + xofs[x]] * INTER_RESIZE_COEF_SCALE;
  }

  for (var dyy = 0; dyy < dstH; dyy++) {
    var sy0 = yofs[dyy];
    var r0 = clip(sy0, srcH);
    var r1 = clip(sy0 + 1, srcH);
    hresize(r0 * ssw, row0);
    hresize(r1 * ssw, row1);
    var b0 = ibeta[dyy * 2], b1 = ibeta[dyy * 2 + 1];
    var Do = dyy * width;
    for (var x = 0; x < width; x++) {
      var t = (((b0 * (row0[x] >> 4)) >> 16) + ((b1 * (row1[x] >> 4)) >> 16) + 2) >> 2;
      out[Do + x] = t & 255;
    }
  }
}

function cvResizeU8(src, srcW, srcH, dstW, dstH, cn, interp) {
  var out = new Uint8ClampedArray(dstW * dstH * cn);

  // dsize == ssize => cv::resize short-circuits to a plain copy.
  if (dstW === srcW && dstH === srcH) { out.set(src.subarray(0, dstW * dstH * cn)); return out; }

  var inv_scale_x = dstW / srcW;
  var inv_scale_y = dstH / srcH;
  var scale_x = 1.0 / inv_scale_x;
  var scale_y = 1.0 / inv_scale_y;

  var iscale_x = cvRound(scale_x);
  var iscale_y = cvRound(scale_y);
  var is_area_fast = Math.abs(scale_x - iscale_x) < DBL_EPSILON &&
                     Math.abs(scale_y - iscale_y) < DBL_EPSILON;

  var interpolation = interp;
  // In case scale_x && scale_y == 2, INTER_LINEAR is equal to INTER_AREA.
  if (interpolation === 'linear' && is_area_fast && iscale_x === 2 && iscale_y === 2)
    interpolation = 'area';

  if (interpolation === 'area' && scale_x >= 1 && scale_y >= 1) {
    if (is_area_fast) areaFast(src, srcW, srcH, dstW, dstH, cn, out, iscale_x, iscale_y);
    else areaGeneric(src, srcW, srcH, dstW, dstH, cn, out, scale_x, scale_y);
    return out;
  }

  // INTER_LINEAR, or INTER_AREA emulated by bilinear (area_mode) for upscale/mixed.
  genericLinear(src, srcW, srcH, dstW, dstH, cn, out,
                scale_x, scale_y, inv_scale_x, inv_scale_y, interpolation === 'area');
  return out;
}
    return { cvResizeU8 };
  })();
  const cvResizeU8 = __cvResize.cvResizeU8;


  return {
    clamp, rintHalfEven, cvRound, bgr2grayFixed,
    otsuThreshold,
    erodeCross3, dilateCross3, morphClose, morphOpen, dilateSquare,
    chamferDistanceTransform, distanceTransform,
    findContours, findContoursRaw, pointInPoly, contourArea, boundingRect,
    simplifyRing, rasterizePolygon,
    fillEllipseMask, fillRotRectMask,
    cvEllipseFill, cvBoxFill, cvFillPoly,
    countNonZero,
    gaussianFilter1d, gradient1d,
    cvResizeU8, resizeRGBA, resizeGray,
    extractMask, flattenOnWhite, flattenOnWhiteF32, compressAlphaLUT,
  };
})();

if (typeof module !== "undefined") module.exports = Imaging;
