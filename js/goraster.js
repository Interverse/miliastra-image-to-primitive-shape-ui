/* IIFE-wrapped: exports only via self.* / module.exports (avoids global lexical bindings clashing across importScripts). */
(() => {
/* ─────────────────────────────────────────────────────────────────────────
 * goraster.js — bit-exact port of github.com/golang/freetype/raster
 * (version e2365dfdc4a0, as vendored via third_party/primitive) used by
 * RotatedEllipse.Rasterize through primitive/raster.go fillPath.
 *
 * Ports: fixed.Int26_6 math, Rasterizer.{Start,Add1,Add2,scan,findCell,
 * saveCell,setCell,areaToAlpha,Rasterize}, UseNonZeroWinding=true path, and
 * the painter converting Spans → Scanlines {Y, X1, X2 (=span.X1-1), Alpha}.
 *
 * All arithmetic is integer/fixed-point and deterministic. Go integer division
 * truncates toward zero and `%` takes the sign of the dividend — replicated via
 * idiv/imod. Verified against a Go dump of emitted scanlines (see tests/parity).
 * ───────────────────────────────────────────────────────────────────────── */
"use strict";

// Go integer division (trunc toward zero) and remainder (sign of dividend).
function idiv(a, b) { return Math.trunc(a / b); }
function imod(a, b) { return a - Math.trunc(a / b) * b; }

// Perf: trunc-toward-zero division by 64 for int32-range fixed-point values
// (identical to idiv(a, 64); shifts floor, so negate around the shift).
function idiv64(a) { return a >= 0 ? a >> 6 : -((-a) >> 6); }

// fix: fixed.Int26_6(x * 64) — float64 → int32, truncation toward zero.
function gfix(x) { return Math.trunc(x * 64); }

function maxAbs(a, b) {
  if (a < 0) a = -a;
  if (b < 0) b = -b;
  return a < b ? b : a;
}

class Rasterizer {
  constructor(width, height) {
    this.UseNonZeroWinding = true;
    this.Dx = 0;
    this.Dy = 0;
    // cells: parallel arrays (xi, area, cover, next). Grow by doubling.
    let cap = 256;
    this.cellXi = new Int32Array(cap);
    this.cellArea = new Int32Array(cap);
    this.cellCover = new Int32Array(cap);
    this.cellNext = new Int32Array(cap);
    this.cellLen = 0;
    this.cellIndex = null;
    // Add2 scratch (perf): the Bezier subdivision stacks are fixed-size and
    // value-overwritten on every call — allocate once per rasterizer instead
    // of per call (identical contents/behavior, no GC churn).
    this.a2pxs = new Float64Array(2 * 16 + 3);
    this.a2pys = new Float64Array(2 * 16 + 3);
    this.a2s = new Int32Array(16 + 1);
    this.setBounds(width, height);
  }

  setBounds(width, height) {
    if (width < 0) width = 0;
    if (height < 0) height = 0;
    let ss2 = 32, ss3 = 16;
    if (width > 24 || height > 24) {
      ss2 = 2 * ss2; ss3 = 2 * ss3;
      if (width > 120 || height > 120) { ss2 = 2 * ss2; ss3 = 2 * ss3; }
    }
    this.width = width;
    this.height = height;
    this.splitScale2 = ss2;
    this.splitScale3 = ss3;
    this.cellIndex = new Int32Array(height);
    // Touched-row bounds (perf): only rows findCell ever writes need
    // clearing/emitting. Rows outside stay -1 and emit nothing in Go too,
    // so restricting clear() and rasterize() to [minYi, maxYi] is
    // output-identical. Initialize to "everything dirty" for the first clear.
    this.minYi = 0;
    this.maxYi = height - 1;
    this.clear();
  }

  clear() {
    this.aX = 0; this.aY = 0;
    this.xi = 0; this.yi = 0;
    this.area = 0; this.cover = 0;
    this.cellLen = 0;
    if (this.maxYi >= this.minYi) {
      this.cellIndex.fill(-1, this.minYi, this.maxYi + 1);
    }
    this.minYi = this.height; // empty range until findCell touches rows
    this.maxYi = -1;
  }

  _growCells() {
    const c = this.cellXi.length;
    const nc = 4 * c; // Go grows to 4*c on overflow
    const gx = new Int32Array(nc); gx.set(this.cellXi); this.cellXi = gx;
    const ga = new Int32Array(nc); ga.set(this.cellArea); this.cellArea = ga;
    const gc = new Int32Array(nc); gc.set(this.cellCover); this.cellCover = gc;
    const gn = new Int32Array(nc); gn.set(this.cellNext); this.cellNext = gn;
  }

  findCell() {
    if (this.yi < 0 || this.yi >= this.cellIndex.length) return -1;
    if (this.yi < this.minYi) this.minYi = this.yi;
    if (this.yi > this.maxYi) this.maxYi = this.yi;
    let xi = this.xi;
    if (xi < 0) xi = -1;
    else if (xi > this.width) xi = this.width;
    let i = this.cellIndex[this.yi], prev = -1;
    while (i !== -1 && this.cellXi[i] <= xi) {
      if (this.cellXi[i] === xi) return i;
      prev = i; i = this.cellNext[i];
    }
    const c = this.cellLen;
    if (c === this.cellXi.length) this._growCells();
    this.cellLen = c + 1;
    this.cellXi[c] = xi; this.cellArea[c] = 0; this.cellCover[c] = 0; this.cellNext[c] = i;
    if (prev === -1) this.cellIndex[this.yi] = c;
    else this.cellNext[prev] = c;
    return c;
  }

  saveCell() {
    if (this.area !== 0 || this.cover !== 0) {
      const i = this.findCell();
      if (i !== -1) {
        this.cellArea[i] += this.area;
        this.cellCover[i] += this.cover;
      }
      this.area = 0;
      this.cover = 0;
    }
  }

  setCell(xi, yi) {
    if (this.xi !== xi || this.yi !== yi) {
      this.saveCell();
      this.xi = xi; this.yi = yi;
    }
  }

  scan(yi, x0, y0f, x1, y1f) {
    const x0i = idiv64(x0);
    const x0f = x0 - 64 * x0i;
    const x1i = idiv64(x1);
    const x1f = x1 - 64 * x1i;

    if (y0f === y1f) { this.setCell(x1i, yi); return; }
    const dx = x1 - x0, dy = y1f - y0f;
    if (x0i === x1i) {
      this.area += (x0f + x1f) * dy;
      this.cover += dy;
      return;
    }
    let p, q, edge0, edge1, xiDelta;
    if (dx > 0) {
      p = (64 - x0f) * dy; q = dx;
      edge0 = 0; edge1 = 64; xiDelta = 1;
    } else {
      p = x0f * dy; q = -dx;
      edge0 = 64; edge1 = 0; xiDelta = -1;
    }
    let yDelta = Math.trunc(p / q), yRem = p - yDelta * q;
    if (yRem < 0) { yDelta -= 1; yRem += q; }
    let xi = x0i, y = y0f;
    this.area += (x0f + edge1) * yDelta;
    this.cover += yDelta;
    xi = xi + xiDelta; y = y + yDelta;
    this.setCell(xi, yi);
    if (xi !== x1i) {
      p = 64 * (y1f - y + yDelta);
      let fullDelta = Math.trunc(p / q), fullRem = p - fullDelta * q;
      if (fullRem < 0) { fullDelta -= 1; fullRem += q; }
      yRem -= q;
      while (xi !== x1i) {
        yDelta = fullDelta;
        yRem += fullRem;
        if (yRem >= 0) { yDelta += 1; yRem -= q; }
        this.area += 64 * yDelta;
        this.cover += yDelta;
        xi = xi + xiDelta; y = y + yDelta;
        this.setCell(xi, yi);
      }
    }
    yDelta = y1f - y;
    this.area += (edge0 + x1f) * yDelta;
    this.cover += yDelta;
  }

  start(ax, ay) {
    this.setCell(idiv64(ax), idiv64(ay));
    this.aX = ax; this.aY = ay;
  }

  add1(bx, by) {
    const x0 = this.aX, y0 = this.aY;
    const x1 = bx, y1 = by;
    const dx = x1 - x0, dy = y1 - y0;
    const y0i = idiv64(y0);
    const y0f = y0 - 64 * y0i;
    const y1i = idiv64(y1);
    const y1f = y1 - 64 * y1i;

    if (y0i === y1i) {
      this.scan(y0i, x0, y0f, x1, y1f);
    } else if (dx === 0) {
      let edge0, edge1, yiDelta;
      if (dy > 0) { edge0 = 0; edge1 = 64; yiDelta = 1; }
      else { edge0 = 64; edge1 = 0; yiDelta = -1; }
      const x0i = idiv64(x0);
      let yi = y0i;
      const x0fTimes2 = (x0 - 64 * x0i) * 2;
      let dcover = edge1 - y0f;
      let darea = x0fTimes2 * dcover;
      this.area += darea;
      this.cover += dcover;
      yi += yiDelta;
      this.setCell(x0i, yi);
      dcover = edge1 - edge0;
      darea = x0fTimes2 * dcover;
      while (yi !== y1i) {
        this.area += darea;
        this.cover += dcover;
        yi += yiDelta;
        this.setCell(x0i, yi);
      }
      dcover = y1f - edge0;
      darea = x0fTimes2 * dcover;
      this.area += darea;
      this.cover += dcover;
    } else {
      let p, q, edge0, edge1, yiDelta;
      if (dy > 0) { p = (64 - y0f) * dx; q = dy; edge0 = 0; edge1 = 64; yiDelta = 1; }
      else { p = y0f * dx; q = -dy; edge0 = 64; edge1 = 0; yiDelta = -1; }
      let xDelta = Math.trunc(p / q), xRem = p - xDelta * q;
      if (xRem < 0) { xDelta -= 1; xRem += q; }
      let x = x0, yi = y0i;
      this.scan(yi, x, y0f, x + xDelta, edge1);
      x = x + xDelta; yi = yi + yiDelta;
      this.setCell(idiv64(x), yi);
      if (yi !== y1i) {
        p = 64 * dx;
        let fullDelta = Math.trunc(p / q), fullRem = p - fullDelta * q;
        if (fullRem < 0) { fullDelta -= 1; fullRem += q; }
        xRem -= q;
        while (yi !== y1i) {
          xDelta = fullDelta;
          xRem += fullRem;
          if (xRem >= 0) { xDelta += 1; xRem -= q; }
          this.scan(yi, x, edge0, x + xDelta, edge1);
          x = x + xDelta; yi = yi + yiDelta;
          this.setCell(idiv64(x), yi);
        }
      }
      this.scan(yi, x, edge0, x1, y1f);
    }
    this.aX = bx; this.aY = by;
  }

  add2(bx, by, cx, cy) {
    let dev = idiv(maxAbs(this.aX - 2 * bx + cx, this.aY - 2 * by + cy), this.splitScale2);
    let nsplit = 0;
    while (dev > 0) { dev = idiv(dev, 4); nsplit++; }
    const maxNsplit = 16;
    if (nsplit > maxNsplit) throw new Error("freetype/raster: Add2 nsplit too large: " + nsplit);
    // pStack holds (2*maxNsplit+3) points; sStack holds (maxNsplit+1) ints.
    // Reused per-instance scratch; every slot consumed is written first.
    const pxs = this.a2pxs;
    const pys = this.a2pys;
    const sStack = this.a2s;
    let i = 0;
    sStack[0] = nsplit;
    pxs[0] = cx; pys[0] = cy;
    pxs[1] = bx; pys[1] = by;
    pxs[2] = this.aX; pys[2] = this.aY;
    while (i >= 0) {
      const s = sStack[i];
      const b0 = 2 * i; // base index into p arrays (p := pStack[2*i:])
      if (s > 0) {
        const mx = pxs[b0 + 1];
        pxs[b0 + 4] = pxs[b0 + 2];
        pxs[b0 + 3] = idiv(pxs[b0 + 4] + mx, 2);
        pxs[b0 + 1] = idiv(pxs[b0 + 0] + mx, 2);
        pxs[b0 + 2] = idiv(pxs[b0 + 1] + pxs[b0 + 3], 2);
        const my = pys[b0 + 1];
        pys[b0 + 4] = pys[b0 + 2];
        pys[b0 + 3] = idiv(pys[b0 + 4] + my, 2);
        pys[b0 + 1] = idiv(pys[b0 + 0] + my, 2);
        pys[b0 + 2] = idiv(pys[b0 + 1] + pys[b0 + 3], 2);
        sStack[i] = s - 1;
        sStack[i + 1] = s - 1;
        i++;
      } else {
        const midx = idiv(pxs[b0 + 0] + 2 * pxs[b0 + 1] + pxs[b0 + 2], 4);
        const midy = idiv(pys[b0 + 0] + 2 * pys[b0 + 1] + pys[b0 + 2], 4);
        this.add1(midx, midy);
        this.add1(pxs[b0 + 0], pys[b0 + 0]);
        i--;
      }
    }
  }

  areaToAlpha(area) {
    // Go: a := (area + 1) >> 1 — arithmetic shift (floor), NOT trunc division.
    // `area` may be negative (winding), and floor vs trunc differ for negatives,
    // which changes the 12-bit alpha by 1 (a ×16 error in the 16-bit result).
    // The JS >> matches exactly while the value fits int32 (cell areas/covers
    // are Int32Array-backed and row sums stay far below 2^31); the guarded
    // fallback keeps the general floor for anything larger.
    const t = area + 1;
    let a = (t | 0) === t ? t >> 1 : Math.floor(t / 2);
    if (a < 0) a = -a;
    let alpha = a >>> 0;
    if (this.UseNonZeroWinding) {
      if (alpha > 0x0fff) alpha = 0x0fff;
    } else {
      alpha &= 0x1fff;
      if (alpha > 0x1000) alpha = 0x2000 - alpha;
      else if (alpha === 0x1000) alpha = 0x0fff;
    }
    return ((alpha << 4) | (alpha >> 8)) >>> 0;
  }

  // Rasterize into a scanline sink: sink.push(y, x1, x2, alpha).
  rasterize(sink) {
    this.saveCell();
    const width = this.width;
    // rows outside [minYi, maxYi] have no cells and emit nothing (identical
    // to scanning the full height in the Go original)
    const yiEnd = Math.min(this.maxYi, this.cellIndex.length - 1);
    for (let yi = Math.max(0, this.minYi); yi <= yiEnd; yi++) {
      let xi = 0, cover = 0;
      for (let c = this.cellIndex[yi]; c !== -1; c = this.cellNext[c]) {
        if (cover !== 0 && this.cellXi[c] > xi) {
          const alpha = this.areaToAlpha(cover * 64 * 2);
          if (alpha !== 0) {
            let xi0 = xi, xi1 = this.cellXi[c];
            if (xi0 < 0) xi0 = 0;
            if (xi1 >= width) xi1 = width;
            if (xi0 < xi1) sink.push(yi + this.Dy, xi0 + this.Dx, xi1 + this.Dx - 1, alpha);
          }
        }
        cover += this.cellCover[c];
        const alpha = this.areaToAlpha(cover * 64 * 2 - this.cellArea[c]);
        xi = this.cellXi[c] + 1;
        if (alpha !== 0) {
          let xi0 = this.cellXi[c], xi1 = xi;
          if (xi0 < 0) xi0 = 0;
          if (xi1 >= width) xi1 = width;
          if (xi0 < xi1) sink.push(yi + this.Dy, xi0 + this.Dx, xi1 + this.Dx - 1, alpha);
        }
      }
    }
  }
}

// fillPath: build path (Start + Add2 segments) then rasterize with non-zero
// winding, matching primitive/raster.go fillPath. `segments` is a builder
// callback that receives the rasterizer to issue start/add1/add2 calls.
function fillPath(rasterizer, build, sink) {
  rasterizer.clear();
  rasterizer.UseNonZeroWinding = true;
  build(rasterizer);
  rasterizer.rasterize(sink);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { Rasterizer, gfix, fillPath };
}
if (typeof self !== "undefined") { self.GoRaster = { Rasterizer, gfix, fillPath }; }
})();
