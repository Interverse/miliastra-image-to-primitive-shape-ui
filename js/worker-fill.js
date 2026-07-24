/*
 * worker-fill.js — fill-mode engine.
 *
 * Bit-exact JS port of the fogleman/primitive hill-climbing algorithm
 * (third_party/primitive/primitive/*.go) plus the Python glue from
 * primitive_backend.py, fill_shaper.results_to_elements and
 * shaper_core.process_image_fill.
 *
 * The primitive core is deterministic given (target image, settings, seed):
 * it consumes a per-worker Go math/rand stream (gorand.js) in Go's exact call
 * order, rasterizes ellipses via the freetype port (goraster.js), and uses
 * Go's exact transcendental math (gomath.js). It reproduces, byte-for-byte,
 * what `primitive -j 1` with a fixed RNG seed would produce. See
 * tests/parity/fill/ for the parity harness and README.
 *
 * Input message:  { cmd:"process", jobId, rgba:ArrayBuffer, width, height,
 *                   config:{...same keys as the Flask /submit fill config...} }
 * Progress:       { type:"progress", jobId, step, total }
 * Output:         { type:"done", jobId, result:{...same shape as
 *                   shaper_core.process_image_fill result, with raw pixel
 *                   buffers instead of base64...} }
 */
"use strict";

if (typeof importScripts === "function") {
  importScripts("gorand.js", "gomath.js", "goraster.js", "imaging.js", "pynum.js", "fillshaper.js");
}

/* Module resolution across three load contexts:
 *   - web worker: importScripts sets self.GoRand / self.GoMath / self.GoRaster
 *   - Node require (run_tests.js): require("./x.js") resolves next to this file
 *   - e2e eval (run_fill_e2e.js): pre-injects globals as Gorand/Goraster/Gomath
 * Prefer an already-present global (any spelling), else fall back to require. */
const _G = (typeof self !== "undefined") ? self : (typeof globalThis !== "undefined" ? globalThis : {});
function _dep(names, requireRel) {
  for (const nm of names) { if (_G[nm]) return _G[nm]; }
  if (typeof require === "function") { try { return require(requireRel); } catch (e) { /* fall through */ } }
  return undefined;
}
const _gorandDep = _dep(["GoRand", "Gorand", "gorand"], "./gorand.js");
const GoRand = (_gorandDep && _gorandDep.GoRand) ? _gorandDep.GoRand : _gorandDep;
const GoMath = _dep(["GoMath", "Gomath", "gomath"], "./gomath.js");
const GoRaster = _dep(["GoRaster", "Goraster", "goraster"], "./goraster.js");

/* ═══════════════════════════ primitive core ═══════════════════════════ */

const SHAPE_TRIANGLE = 1;
const SHAPE_ROTATED_RECT = 5;
const SHAPE_ROTATED_ELLIPSE = 7;

function clampInt(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/* Exact integer division truncating toward zero (Go int64 `/`), for operands
 * whose magnitudes are < 2^53. Corrects the ±1 float-division misround that can
 * occur when the true quotient lands astronomically close to an integer. */
function goIntDiv(a, b) {
  let q = Math.trunc(a / b);
  const r = a - q * b; // exact: |q*b| < 2^53
  if (a >= 0) { if (r < 0) q--; else if (r >= b) q++; }
  else { if (r > 0) q++; else if (r <= -b) q--; }
  return q;
}

/* Go image/draw NRGBA→premultiplied-RGBA byte conversion (drawNRGBASrc), also
 * used for the uniform background. sa = A*0x101; premult(c) = (c*sa/0xff) >> 8. */
function premultByte(c, a) {
  const sa = a * 0x101;
  return goIntDiv(c * sa, 0xff) >> 8;
}

/* goFmtF: Go strconv.FormatFloat(x,'f',prec,64) — exact round-half-to-even of
 * the float64 value to `prec` decimals, returned as a string. Replicates the
 * SVG %f round-trip that primitive_backend re-parses with Python float().
 * Validated against Go in tests/parity/fill (gofmt subcommand). */
function goFmtF(x, prec) {
  if (!isFinite(x)) return x > 0 ? "+Inf" : (x < 0 ? "-Inf" : "NaN");
  let neg = false;
  if (x < 0 || Object.is(x, -0)) { neg = true; x = -x; }
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const expField = Number((bits >> 52n) & 0x7ffn);
  const mant = bits & 0xfffffffffffffn;
  let num, den; // x = num/den exactly (den a power of two)
  if (expField === 0) { num = mant; den = 1n << 1074n; }
  else {
    num = mant | (1n << 52n);
    const e = expField - 1075;
    if (e >= 0) { num = num << BigInt(e); den = 1n; }
    else { den = 1n << BigInt(-e); }
  }
  const scale = 10n ** BigInt(prec);
  const N = num * scale;
  let q = N / den;
  const r = N % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  let s = q.toString();
  if (prec > 0) {
    while (s.length <= prec) s = "0" + s;
    s = s.slice(0, s.length - prec) + "." + s.slice(s.length - prec);
  }
  return (neg ? "-" : "") + s;
}
/* The value the Python side ends up with: float(goFmtF(x,6)). */
function goFmtF6num(x) { return parseFloat(goFmtF(x, 6)); }

/* Scanlines: parallel Int32Arrays [y, x1, x2, alpha]. alpha is 0xffff for
 * triangle/rect and per-span for ellipse (freetype antialiased edges). */
class ScanlineBuffer {
  constructor(cap) {
    this.y = new Int32Array(cap);
    this.x1 = new Int32Array(cap);
    this.x2 = new Int32Array(cap);
    this.a = new Int32Array(cap);
    this.n = 0;
  }
  reset() { this.n = 0; }
  push(y, x1, x2, a) {
    if (this.n >= this.y.length) {
      const grow = (arr) => { const b = new Int32Array(arr.length * 2); b.set(arr); return b; };
      this.y = grow(this.y); this.x1 = grow(this.x1); this.x2 = grow(this.x2); this.a = grow(this.a);
    }
    const i = this.n++;
    this.y[i] = y; this.x1[i] = x1; this.x2[i] = x2; this.a[i] = a >>> 0;
  }
}

function cropScanlines(buf, w, h) {
  let out = 0;
  for (let i = 0; i < buf.n; i++) {
    const y = buf.y[i];
    if (y < 0 || y >= h) continue;
    let x1 = buf.x1[i];
    if (x1 >= w) continue;
    let x2 = buf.x2[i];
    if (x2 < 0) continue;
    x1 = clampInt(x1, 0, w - 1);
    x2 = clampInt(x2, 0, w - 1);
    if (x1 > x2) continue;
    buf.y[out] = y; buf.x1[out] = x1; buf.x2[out] = x2; buf.a[out] = buf.a[i];
    out++;
  }
  buf.n = out;
}

/* ---- shapes (RNG consumed in Go's exact order via the shared worker rnd) ---- */

class TriangleShape {
  constructor(rnd, w, h) {
    this.rnd = rnd; this.w = w; this.h = h;
    this.x1 = rnd.intn(w);
    this.y1 = rnd.intn(h);
    this.x2 = this.x1 + rnd.intn(31) - 15;
    this.y2 = this.y1 + rnd.intn(31) - 15;
    this.x3 = this.x1 + rnd.intn(31) - 15;
    this.y3 = this.y1 + rnd.intn(31) - 15;
    this.mutate();
  }
  copy() {
    const t = Object.create(TriangleShape.prototype);
    t.rnd = this.rnd; t.w = this.w; t.h = this.h;
    t.x1 = this.x1; t.y1 = this.y1; t.x2 = this.x2; t.y2 = this.y2; t.x3 = this.x3; t.y3 = this.y3;
    return t;
  }
  valid() {
    const minDegrees = 15;
    let a1, a2;
    {
      let x1 = this.x2 - this.x1, y1 = this.y2 - this.y1;
      let x2 = this.x3 - this.x1, y2 = this.y3 - this.y1;
      const d1 = Math.sqrt(x1 * x1 + y1 * y1), d2 = Math.sqrt(x2 * x2 + y2 * y2);
      x1 /= d1; y1 /= d1; x2 /= d2; y2 /= d2;
      a1 = GoMath.degrees(GoMath.acos(x1 * x2 + y1 * y2));
    }
    {
      let x1 = this.x1 - this.x2, y1 = this.y1 - this.y2;
      let x2 = this.x3 - this.x2, y2 = this.y3 - this.y2;
      const d1 = Math.sqrt(x1 * x1 + y1 * y1), d2 = Math.sqrt(x2 * x2 + y2 * y2);
      x1 /= d1; y1 /= d1; x2 /= d2; y2 /= d2;
      a2 = GoMath.degrees(GoMath.acos(x1 * x2 + y1 * y2));
    }
    const a3 = 180 - a1 - a2;
    return a1 > minDegrees && a2 > minDegrees && a3 > minDegrees;
  }
  mutate() {
    const w = this.w, h = this.h, m = 16, rnd = this.rnd;
    for (;;) {
      switch (rnd.intn(3)) {
        case 0:
          this.x1 = clampInt(this.x1 + Math.trunc(rnd.normFloat64() * 16), -m, w - 1 + m);
          this.y1 = clampInt(this.y1 + Math.trunc(rnd.normFloat64() * 16), -m, h - 1 + m);
          break;
        case 1:
          this.x2 = clampInt(this.x2 + Math.trunc(rnd.normFloat64() * 16), -m, w - 1 + m);
          this.y2 = clampInt(this.y2 + Math.trunc(rnd.normFloat64() * 16), -m, h - 1 + m);
          break;
        default: // case 2
          this.x3 = clampInt(this.x3 + Math.trunc(rnd.normFloat64() * 16), -m, w - 1 + m);
          this.y3 = clampInt(this.y3 + Math.trunc(rnd.normFloat64() * 16), -m, h - 1 + m);
      }
      if (this.valid()) break;
    }
  }
  rasterize(buf) {
    buf.reset();
    let x1 = this.x1, y1 = this.y1, x2 = this.x2, y2 = this.y2, x3 = this.x3, y3 = this.y3;
    if (y1 > y3) { let t = x1; x1 = x3; x3 = t; t = y1; y1 = y3; y3 = t; }
    if (y1 > y2) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
    if (y2 > y3) { let t = x2; x2 = x3; x3 = t; t = y2; y2 = y3; y3 = t; }
    const bottom = (bx1, by1, bx2, by2, bx3, by3) => {
      const s1 = (bx2 - bx1) / (by2 - by1);
      const s2 = (bx3 - bx1) / (by3 - by1);
      let ax = bx1, bxx = bx1;
      for (let y = by1; y <= by2; y++) {
        let a = Math.trunc(ax), b = Math.trunc(bxx);
        ax += s1; bxx += s2;
        if (a > b) { const t = a; a = b; b = t; }
        buf.push(y, a, b, 0xffff);
      }
    };
    const top = (tx1, ty1, tx2, ty2, tx3, ty3) => {
      const s1 = (tx3 - tx1) / (ty3 - ty1);
      const s2 = (tx3 - tx2) / (ty3 - ty2);
      let ax = tx3, bxx = tx3;
      for (let y = ty3; y > ty1; y--) {
        ax -= s1; bxx -= s2;
        let a = Math.trunc(ax), b = Math.trunc(bxx);
        if (a > b) { const t = a; a = b; b = t; }
        buf.push(y, a, b, 0xffff);
      }
    };
    if (y2 === y3) bottom(x1, y1, x2, y2, x3, y3);
    else if (y1 === y2) top(x1, y1, x2, y2, x3, y3);
    else {
      const x4 = x1 + Math.trunc(((y2 - y1) / (y3 - y1)) * (x3 - x1));
      bottom(x1, y1, x2, y2, x4, y2);
      top(x2, y2, x4, y2, x3, y3);
    }
    cropScanlines(buf, this.w, this.h);
  }
  /* primitive_backend._parse_triangle from the "%d,%d ..." polygon SVG.
   * Vertices are exact ints (no %f quantization). The arithmetic is Python-side
   * (folded degrees; Math.atan2 — see README on the libm caveat). */
  toResult(scaleX, scaleY) {
    const pts = [
      [this.x1 * scaleX, this.y1 * scaleY],
      [this.x2 * scaleX, this.y2 * scaleY],
      [this.x3 * scaleX, this.y3 * scaleY],
    ];
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    const xs = [pts[0][0], pts[1][0], pts[2][0]];
    const ys = [pts[0][1], pts[1][1], pts[2][1]];
    const width = Math.max(xs[0], xs[1], xs[2]) - Math.min(xs[0], xs[1], xs[2]);
    const height = Math.max(ys[0], ys[1], ys[2]) - Math.min(ys[0], ys[1], ys[2]);
    const ex = pts[1][0] - pts[0][0], ey = pts[1][1] - pts[0][1];
    const angle = Math.atan2(ey, ex) * (180 / Math.PI) + 90.0; // math.degrees folds 180/pi
    return {
      type: "triangle", cx, cy,
      width: Math.max(width, 1.0), size: Math.max(width, height, 1.0),
      height: Math.max(height, 1.0), angle,
    };
  }
}

class RotatedRectShape {
  constructor(rnd, w, h) {
    this.rnd = rnd; this.w = w; this.h = h;
    this.x = rnd.intn(w);
    this.y = rnd.intn(h);
    this.sx = rnd.intn(32) + 1;
    this.sy = rnd.intn(32) + 1;
    this.angle = rnd.intn(360);
    this.mutate();
  }
  copy() {
    const r = Object.create(RotatedRectShape.prototype);
    r.rnd = this.rnd; r.w = this.w; r.h = this.h;
    r.x = this.x; r.y = this.y; r.sx = this.sx; r.sy = this.sy; r.angle = this.angle;
    return r;
  }
  mutate() {
    const w = this.w, h = this.h, rnd = this.rnd;
    switch (rnd.intn(3)) {
      case 0:
        this.x = clampInt(this.x + Math.trunc(rnd.normFloat64() * 16), 0, w - 1);
        this.y = clampInt(this.y + Math.trunc(rnd.normFloat64() * 16), 0, h - 1);
        break;
      case 1:
        this.sx = clampInt(this.sx + Math.trunc(rnd.normFloat64() * 16), 1, w - 1);
        this.sy = clampInt(this.sy + Math.trunc(rnd.normFloat64() * 16), 1, h - 1);
        break;
      default: // case 2
        this.angle = this.angle + Math.trunc(rnd.normFloat64() * 32);
    }
  }
  rasterize(buf) {
    buf.reset();
    const w = this.w, h = this.h;
    const sx = this.sx, sy = this.sy;
    const angle = GoMath.radians(this.angle);
    const cosA = GoMath.cos(angle), sinA = GoMath.sin(angle);
    const rotx = (px, py) => px * cosA - py * sinA;
    const roty = (px, py) => px * sinA + py * cosA;
    const rx1 = rotx(-sx / 2, -sy / 2), ry1 = roty(-sx / 2, -sy / 2);
    const rx2 = rotx(sx / 2, -sy / 2), ry2 = roty(sx / 2, -sy / 2);
    const rx3 = rotx(sx / 2, sy / 2), ry3 = roty(sx / 2, sy / 2);
    const rx4 = rotx(-sx / 2, sy / 2), ry4 = roty(-sx / 2, sy / 2);
    const x1 = Math.trunc(rx1) + this.x, y1 = Math.trunc(ry1) + this.y;
    const x2 = Math.trunc(rx2) + this.x, y2 = Math.trunc(ry2) + this.y;
    const x3 = Math.trunc(rx3) + this.x, y3 = Math.trunc(ry3) + this.y;
    const x4 = Math.trunc(rx4) + this.x, y4 = Math.trunc(ry4) + this.y;
    const miny = Math.min(y1, y2, y3, y4);
    const maxy = Math.max(y1, y2, y3, y4);
    const nn = maxy - miny + 1;
    const mn = new Int32Array(nn).fill(w);
    const mx = new Int32Array(nn).fill(0); // Go zero-value 0
    const xs = [x1, x2, x3, x4, x1];
    const ys = [y1, y2, y3, y4, y1];
    for (let i = 0; i < 4; i++) {
      const x = xs[i], y = ys[i];
      const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
      const count = Math.trunc(Math.sqrt(dx * dx + dy * dy)) * 2;
      for (let j = 0; j < count; j++) {
        const t = j / (count - 1);
        const xi = Math.trunc(x + dx * t);
        const yi = Math.trunc(y + dy * t) - miny;
        if (mn[yi] > xi) mn[yi] = xi;
        if (mx[yi] < xi) mx[yi] = xi;
      }
    }
    for (let i = 0; i < nn; i++) {
      const y = miny + i;
      if (y < 0 || y >= h) continue;
      const a = Math.max(mn[i], 0);
      const b = Math.min(mx[i], w - 1);
      if (b >= a) buf.push(y, a, b, 0xffff);
    }
  }
  /* primitive_backend._parse_nested_group for a rect child.
   * SVG emits %d ints (no %f quantization). */
  toResult(scaleX, scaleY) {
    return {
      type: "rect",
      cx: this.x * scaleX,
      cy: this.y * scaleY,
      hw: Math.max(this.sx * scaleX / 2.0, 0.5),
      hh: Math.max(this.sy * scaleY / 2.0, 0.5),
      angle: this.angle,
    };
  }
}

class RotatedEllipseShape {
  constructor(rnd, w, h) {
    this.rnd = rnd; this.w = w; this.h = h;
    this.x = rnd.float64() * w;
    this.y = rnd.float64() * h;
    this.rx = rnd.float64() * 32 + 1;
    this.ry = rnd.float64() * 32 + 1;
    this.angle = rnd.float64() * 360;
    this.rasterizer = null; // shared per-model Rasterizer, injected by makeShape
  }
  copy() {
    const e = Object.create(RotatedEllipseShape.prototype);
    e.rnd = this.rnd; e.w = this.w; e.h = this.h;
    e.x = this.x; e.y = this.y; e.rx = this.rx; e.ry = this.ry; e.angle = this.angle;
    e.rasterizer = this.rasterizer;
    return e;
  }
  mutate() {
    const w = this.w, h = this.h, rnd = this.rnd;
    switch (rnd.intn(3)) {
      case 0:
        this.x = clamp(this.x + rnd.normFloat64() * 16, 0, w - 1);
        this.y = clamp(this.y + rnd.normFloat64() * 16, 0, h - 1);
        break;
      case 1:
        this.rx = clamp(this.rx + rnd.normFloat64() * 16, 1, w - 1);
        this.ry = clamp(this.ry + rnd.normFloat64() * 16, 1, w - 1); // Go uses w-1 for both
        break;
      default: // case 2
        this.angle = this.angle + rnd.normFloat64() * 32;
    }
  }
  rasterize(buf) {
    buf.reset();
    const r = this.rasterizer;
    r.clear();
    r.UseNonZeroWinding = true;
    const n = 16;
    const X = this.x, Y = this.y, Rx = this.rx, Ry = this.ry;
    const angRad = GoMath.radians(this.angle);
    const cosT = GoMath.cos(angRad), sinT = GoMath.sin(angRad);
    const gfix = GoRaster.gfix;
    for (let i = 0; i < n; i++) {
      const p1 = (i + 0) / n, p2 = (i + 1) / n;
      const a1 = p1 * 2 * Math.PI, a2 = p2 * 2 * Math.PI;
      let x0 = Rx * GoMath.cos(a1), y0 = Ry * GoMath.sin(a1);
      const x1 = Rx * GoMath.cos(a1 + (a2 - a1) / 2), y1 = Ry * GoMath.sin(a1 + (a2 - a1) / 2);
      let x2 = Rx * GoMath.cos(a2), y2 = Ry * GoMath.sin(a2);
      let cx = 2 * x1 - x0 / 2 - x2 / 2;
      let cy = 2 * y1 - y0 / 2 - y2 / 2;
      const rx0 = x0 * cosT - y0 * sinT, ry0 = x0 * sinT + y0 * cosT;
      const rcx = cx * cosT - cy * sinT, rcy = cx * sinT + cy * cosT;
      const rx2 = x2 * cosT - y2 * sinT, ry2 = x2 * sinT + y2 * cosT;
      if (i === 0) r.start(gfix(rx0 + X), gfix(ry0 + Y));
      r.add2(gfix(rcx + X), gfix(rcy + Y), gfix(rx2 + X), gfix(ry2 + Y));
    }
    r.rasterize(buf);
  }
  /* primitive_backend._parse_nested_group for an ellipse child. SVG emits %f
   * (translate/rotate/scale), re-parsed by Python float() — replicate the
   * 6-decimal quantization exactly. offset_x/y = 0 in parse_primitive_svg. */
  toResult(scaleX, scaleY) {
    const tx = goFmtF6num(this.x);
    const ty = goFmtF6num(this.y);
    const ang = goFmtF6num(this.angle);
    const sx = goFmtF6num(this.rx);
    const sy = goFmtF6num(this.ry);
    return {
      type: "circle",
      cx: tx * scaleX,
      cy: ty * scaleY,
      rx: Math.max(sx * scaleX, 0.5),
      ry: Math.max(sy * scaleY, 0.5),
      angle: ang,
    };
  }
}

/* ---- model / worker (single-threaded, deterministic port of worker.go +
 * model.go + optimize.go + state.go, run with one worker) ---- */

class PrimitiveModel {
  constructor(targetStraightRGBA, w, h, bgR, bgG, bgB, bgA, seed) {
    this.w = w;
    this.h = h;
    const n = w * h;

    // Target: Go image.Decode(PNG) → imageToRGBA (draw.Draw Src) premultiplies
    // NRGBA→RGBA. Store as Uint8Array (Go uint8 wraps mod 256, unlike Clamped).
    this.target = new Uint8Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      const R = targetStraightRGBA[i], G = targetStraightRGBA[i + 1], B = targetStraightRGBA[i + 2], A = targetStraightRGBA[i + 3];
      this.target[i] = premultByte(R, A);
      this.target[i + 1] = premultByte(G, A);
      this.target[i + 2] = premultByte(B, A);
      this.target[i + 3] = A; // pa = (A*0x101)>>8 = A
    }

    // Current: uniformRGBA(background.NRGBA()) — same premultiply.
    this.current = new Uint8Array(n * 4);
    const pr = premultByte(bgR, bgA), pg = premultByte(bgG, bgA), pb = premultByte(bgB, bgA);
    for (let i = 0; i < n; i++) {
      this.current[i * 4] = pr; this.current[i * 4 + 1] = pg; this.current[i * 4 + 2] = pb; this.current[i * 4 + 3] = bgA;
    }

    this.buffer = new Uint8Array(n * 4);
    this.lines = new ScanlineBuffer(4096);
    this.rnd = new GoRand(seed);
    this.rasterizer = new GoRaster.Rasterizer(w, h);
    this.score = this.differenceFull();
    this.shapes = [];
    this.colors = [];
    this.scores = [];
  }

  differenceFull() {
    const t = this.target, c = this.current, n = this.w * this.h;
    let total = 0;
    for (let i = 0; i < n * 4; i += 4) {
      const dr = t[i] - c[i], dg = t[i + 1] - c[i + 1], db = t[i + 2] - c[i + 2], da = t[i + 3] - c[i + 3];
      total += dr * dr + dg * dg + db * db + da * da;
    }
    return Math.sqrt(total / (n * 4)) / 255;
  }

  computeColor(lines, alpha) {
    const t = this.target, c = this.current, w = this.w;
    let rsum = 0, gsum = 0, bsum = 0, count = 0;
    const a = goIntDiv(0x101 * 255, alpha);
    for (let li = 0; li < lines.n; li++) {
      let i = (lines.y[li] * w + lines.x1[li]) * 4;
      for (let x = lines.x1[li]; x <= lines.x2[li]; x++) {
        const tr = t[i], tg = t[i + 1], tb = t[i + 2];
        const cr = c[i], cg = c[i + 1], cb = c[i + 2];
        i += 4;
        rsum += (tr - cr) * a + cr * 0x101;
        gsum += (tg - cg) * a + cg * 0x101;
        bsum += (tb - cb) * a + cb * 0x101;
        count++;
      }
    }
    if (count === 0) return [0, 0, 0, 0]; // Go: return Color{} (alpha discarded)
    const r = clampInt(Math.floor(goIntDiv(rsum, count) / 256), 0, 255);
    const g = clampInt(Math.floor(goIntDiv(gsum, count) / 256), 0, 255);
    const b = clampInt(Math.floor(goIntDiv(bsum, count) / 256), 0, 255);
    return [r, g, b, alpha];
  }

  copyLines(dst, src, lines) {
    const w = this.w;
    for (let li = 0; li < lines.n; li++) {
      const a = (lines.y[li] * w + lines.x1[li]) * 4;
      const b = a + (lines.x2[li] - lines.x1[li] + 1) * 4;
      for (let i = a; i < b; i++) dst[i] = src[i];
    }
  }

  drawLines(im, color, lines) {
    const m = 0xffff;
    const cr = color[0], cg = color[1], cb = color[2], ca = color[3];
    // NRGBA(cr,cg,cb,ca).RGBA(): sr = c*0x101*ca/0xff, sa = ca*0x101
    const sr = goIntDiv(cr * 0x101 * ca, 0xff);
    const sg = goIntDiv(cg * 0x101 * ca, 0xff);
    const sb = goIntDiv(cb * 0x101 * ca, 0xff);
    const sa = ca * 0x101;
    const w = this.w;
    for (let li = 0; li < lines.n; li++) {
      const ma = lines.a[li];
      const a = (m - goIntDiv(sa * ma, m)) * 0x101; // uint32
      let i = (lines.y[li] * w + lines.x1[li]) * 4;
      for (let x = lines.x1[li]; x <= lines.x2[li]; x++) {
        const dr = im[i], dg = im[i + 1], db = im[i + 2], da = im[i + 3];
        // Go: uint8((d*a + s*ma) / m >> 8), all uint32 (may wrap mod 2^32).
        im[i] = goIntDiv((dr * a + sr * ma) >>> 0, m) >> 8;
        im[i + 1] = goIntDiv((dg * a + sg * ma) >>> 0, m) >> 8;
        im[i + 2] = goIntDiv((db * a + sb * ma) >>> 0, m) >> 8;
        im[i + 3] = goIntDiv((da * a + sa * ma) >>> 0, m) >> 8;
        i += 4;
      }
    }
  }

  differencePartial(before, after, score, lines) {
    const t = this.target, w = this.w, h = this.h;
    const N = w * h * 4;
    const s = score * 255;
    let total = Math.trunc(GoMath.pow(s, 2) * N); // uint64(math.Pow(score*255,2)*N)
    for (let li = 0; li < lines.n; li++) {
      let i = (lines.y[li] * w + lines.x1[li]) * 4;
      for (let x = lines.x1[li]; x <= lines.x2[li]; x++) {
        const tr = t[i], tg = t[i + 1], tb = t[i + 2], ta = t[i + 3];
        const br = before[i], bg = before[i + 1], bb = before[i + 2], ba = before[i + 3];
        const ar = after[i], ag = after[i + 1], ab = after[i + 2], aa = after[i + 3];
        i += 4;
        const dr1 = tr - br, dg1 = tg - bg, db1 = tb - bb, da1 = ta - ba;
        const dr2 = tr - ar, dg2 = tg - ag, db2 = tb - ab, da2 = ta - aa;
        total -= dr1 * dr1 + dg1 * dg1 + db1 * db1 + da1 * da1;
        total += dr2 * dr2 + dg2 * dg2 + db2 * db2 + da2 * da2;
      }
    }
    // Go uint64 wraps mod 2^64 on underflow; provably never happens for a
    // selected shape (see tests/parity README). Emulate defensively.
    if (total < 0) total += 18446744073709551616;
    return Math.sqrt(total / N) / 255;
  }

  energy(shape, alpha) {
    const lines = this.lines;
    shape.rasterize(lines);
    const color = this.computeColor(lines, alpha);
    this.copyLines(this.buffer, this.current, lines);
    this.drawLines(this.buffer, color, lines);
    return this.differencePartial(this.current, this.buffer, this.score, lines);
  }

  stateEnergy(state) {
    if (state.score < 0) state.score = this.energy(state.shape, state.alpha);
    return state.score;
  }

  makeShape(type) {
    switch (type) {
      case SHAPE_TRIANGLE: return new TriangleShape(this.rnd, this.w, this.h);
      case SHAPE_ROTATED_RECT: return new RotatedRectShape(this.rnd, this.w, this.h);
      case SHAPE_ROTATED_ELLIPSE: {
        const e = new RotatedEllipseShape(this.rnd, this.w, this.h);
        e.rasterizer = this.rasterizer;
        return e;
      }
      default:
        throw new Error("unsupported shape type: " + type);
    }
  }

  randomState(type, alpha) {
    let t = type;
    if (t !== SHAPE_TRIANGLE && t !== SHAPE_ROTATED_RECT && t !== SHAPE_ROTATED_ELLIPSE) {
      // combo (mode 0): Go recurses with ShapeType(Rnd.Intn(8)+1)
      t = this.rnd.intn(8) + 1;
      return this.randomState(t, alpha);
    }
    const shape = this.makeShape(t);
    let mutateAlpha = false;
    if (alpha === 0) { alpha = 128; mutateAlpha = true; }
    return { shape, alpha, mutateAlpha, score: -1 };
  }

  hillClimb(state, maxAge) {
    let s = { shape: state.shape.copy(), alpha: state.alpha, mutateAlpha: state.mutateAlpha, score: state.score };
    let best = { shape: s.shape.copy(), alpha: s.alpha, mutateAlpha: s.mutateAlpha, score: s.score };
    let bestEnergy = this.stateEnergy(s);
    best.score = bestEnergy;
    for (let age = 0; age < maxAge; age++) {
      const undo = { shape: s.shape.copy(), alpha: s.alpha, score: s.score };
      // DoMove: mutate shape, then (if mutateAlpha) perturb alpha, then score=-1
      s.shape.mutate();
      if (s.mutateAlpha) {
        s.alpha = clampInt(s.alpha + this.rnd.intn(21) - 10, 1, 255);
      }
      s.score = -1;
      const energy = this.stateEnergy(s);
      if (energy >= bestEnergy) {
        s.shape = undo.shape; s.alpha = undo.alpha; s.score = undo.score;
      } else {
        bestEnergy = energy;
        best = { shape: s.shape.copy(), alpha: s.alpha, mutateAlpha: s.mutateAlpha, score: s.score };
        age = -1;
      }
    }
    return best;
  }

  bestRandomState(type, alpha, n) {
    let bestEnergy = 0, best = null;
    for (let i = 0; i < n; i++) {
      const st = this.randomState(type, alpha);
      const e = this.stateEnergy(st);
      if (i === 0 || e < bestEnergy) { bestEnergy = e; best = st; }
    }
    return best;
  }

  bestHillClimbState(type, alpha, n, age, m) {
    let bestEnergy = 0, best = null;
    for (let i = 0; i < m; i++) {
      let st = this.bestRandomState(type, alpha, n);
      st = this.hillClimb(st, age);
      const energy = this.stateEnergy(st);
      if (i === 0 || energy < bestEnergy) { bestEnergy = energy; best = st; }
    }
    return best;
  }

  add(shape, alpha) {
    const lines = this.lines;
    shape.rasterize(lines);
    const color = this.computeColor(lines, alpha);
    this.copyLines(this.buffer, this.current, lines); // before := current (scanline pixels)
    this.drawLines(this.current, color, lines);        // draw onto current
    this.score = this.differencePartial(this.buffer, this.current, this.score, lines);
    this.shapes.push(shape);
    this.colors.push(color);
    this.scores.push(this.score);
    return color;
  }

  /* One Model.Step with one worker: runWorkers(t,a,n,age,m) with wm=m, then Add. */
  step(type, alpha, n, age, m) {
    const state = this.bestHillClimbState(type, alpha, n, age, m);
    const color = this.add(state.shape, state.alpha);
    return { shape: state.shape, alpha: state.alpha, color };
  }
}

/* Default seed when config.random_seed is absent: derived from wall-clock,
 * mirroring Go's rand.NewSource(time.Now().UnixNano()) — non-deterministic. */
function deriveSeed() {
  const perf = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
  return (Date.now() >>> 0) ^ (Math.floor(perf * 1000) & 0x7fffffff);
}

/* ═════════════════════ Python-glue: fill pipeline ═════════════════════ */

const PNG_ALPHA_FIT_FLOOR = 0.2;
const PNG_ALPHA_FIT_GAMMA = 1.6;
const MIN_VISIBLE_ALPHA_WEIGHT = 0.05;

const SHAPE_MODE_MAP = { triangle: SHAPE_TRIANGLE, rect: SHAPE_ROTATED_RECT, circle: SHAPE_ROTATED_ELLIPSE };
const SHAPE_ORDER = ["circle", "rect", "triangle"];
const DEFAULT_IMAGE_ASSET_REFS = { circle: 100002, rect: 100001, triangle: 100003 };

function normalizeAllowedShapes(allowed) {
  const requested = (allowed && allowed.length ? allowed : ["circle"]).map(s => String(s).trim().toLowerCase());
  const normalized = [];
  for (const name of SHAPE_ORDER) {
    if (requested.includes(name) && !normalized.includes(name)) normalized.push(name);
  }
  for (const name of requested) {
    if (SHAPE_MODE_MAP[name] !== undefined && !normalized.includes(name)) normalized.push(name);
  }
  return normalized.length ? normalized : ["circle"];
}

function buildShapeConfigs(allowedShapes, numPrimitives) {
  const normalized = normalizeAllowedShapes(allowedShapes);
  const total = Math.max(1, numPrimitives | 0);
  const base = Math.floor(total / normalized.length);
  const rem = total % normalized.length;
  const configs = [];
  normalized.forEach((name, index) => {
    const count = base + (index < rem ? 1 : 0);
    if (count > 0) configs.push([SHAPE_MODE_MAP[name], count]);
  });
  return configs.length ? configs : [[SHAPE_MODE_MAP.circle, total]];
}

function rgbToHex(r, g, b) {
  const h = (v) => Imaging.clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

function packColor(hex, alpha) {
  let v = hex.replace("#", "");
  if (v.length === 3) v = v.split("").map(c => c + c).join("");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  // Python: int(np.clip(round(alpha * 255.0), 0, 255)) — banker's rounding
  const a = Imaging.clamp(PyNum.roundInt(alpha * 255.0), 0, 255);
  // unsigned 32-bit ARGB
  return (((a << 24) >>> 0) | (r << 16) | (g << 8) | b) >>> 0;
}

/* fill_shaper._shape_opacity — bit-exact port lives in fillshaper.js
 * (AA rasterizers + numpy pairwise summation, validated against Python). */
function shapeOpacity(result, weights, w, h) {
  return FillShaper.shapeOpacity(result, weights, w, h);
}

/* fill_shaper.results_to_elements port */
function resultsToElements(results, unitScale, imgCenter, primitivesConfig, outputAlpha) {
  const presetMap = {};
  (primitivesConfig || []).forEach((preset) => {
    if (preset && preset.shape) presetMap[preset.shape] = preset;
  });

  unitScale = Number(unitScale || 1.0);
  const originX = imgCenter[0] * unitScale;
  const originY = -imgCenter[1] * unitScale;
  const elements = [];

  results.forEach((result, index) => {
    const cx = result.cx * unitScale;
    const cy = -result.cy * unitScale;
    let preset, elementType, size;
    if (result.type === "circle") {
      preset = presetMap.circle || {};
      elementType = "ellipse";
      size = {
        rx: PyNum.round(result.rx * unitScale, 4),
        ry: PyNum.round(result.ry * unitScale, 4),
      };
    } else if (result.type === "triangle") {
      preset = presetMap.triangle || {};
      elementType = "triangle";
      const triWidth = (result.width !== undefined ? result.width : (result.size || 1)) * unitScale;
      const triHeight = (result.height !== undefined ? result.height : (result.size || 1) * Math.sqrt(3) / 2) * unitScale;
      size = {
        width: PyNum.round(triWidth, 4),
        height: PyNum.round(triHeight, 4),
      };
    } else {
      preset = presetMap.rect || {};
      elementType = "rectangle";
      size = {
        width: PyNum.round(2 * result.hw * unitScale, 4),
        height: PyNum.round(2 * result.hh * unitScale, 4),
      };
    }

    const colorHex = typeof result.color === "string" ? result.color : "#ffffff";
    let alpha;
    if (outputAlpha !== null && outputAlpha !== undefined) {
      alpha = Imaging.clamp((result.alpha !== undefined ? result.alpha : 1.0) * outputAlpha, 0, 1);
    } else {
      alpha = result.alpha !== undefined ? result.alpha : 1.0;
    }
    const imageAssetRef = Number(
      preset.image_asset_ref || preset.asset_id || result.image_asset_ref ||
      DEFAULT_IMAGE_ASSET_REFS[result.type] || 100002
    );
    const packedColor = packColor(colorHex, alpha);

    const element = {
      id: index,
      type: elementType,
      center: { x: PyNum.round(cx, 4), y: PyNum.round(cy, 4) },
      relative_position: {
        x: PyNum.round(cx - originX, 4),
        y: PyNum.round(cy - originY, 4),
      },
      relative: {
        x: PyNum.round(cx - originX, 4),
        y: PyNum.round(cy - originY, 4),
      },
      size,
      rotation: { x: 0.0, y: 0.0, z: PyNum.round(-(result.angle || 0), 4) },
      color: colorHex,
      alpha: PyNum.round(alpha, 4),
      packed_color: packedColor,
      image_asset_ref: imageAssetRef,
    };

    if (preset.type_id !== undefined && preset.type_id !== null) {
      element.type_id = preset.type_id;
      element.element_type_id = preset.type_id;
    }
    if (preset.rot_z !== undefined && preset.rot_z !== null) {
      element.rotation.z = PyNum.round(element.rotation.z + Number(preset.rot_z), 4);
    }
    if (preset.rot_y_add !== undefined && preset.rot_y_add !== null) {
      element.rotation.y = Number(preset.rot_y_add);
    }

    elements.push(element);
  });

  return elements;
}

/* _compress_alpha_for_fitting */
function compressAlphaForFitting(alphaU8, n) {
  // _compress_alpha_for_fitting — exact float32 LUT (matches primitive_backend).
  const lut = Imaging.compressAlphaLUT(PNG_ALPHA_FIT_FLOOR, PNG_ALPHA_FIT_GAMMA);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) out[i] = lut[alphaU8[i]];
  return out;
}

/* mask bbox */
function maskBBox(mask, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        any = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!any) return [0, 0, w, h];
  return [minX, minY, maxX + 1, maxY + 1];
}

function resolveOrigin(config, width, height) {
  const origin = (config && config.origin) || {};
  if (origin.type === "custom") {
    const x = origin.x === "" || origin.x === undefined || origin.x === null ? width / 2 : Number(origin.x);
    const y = origin.y === "" || origin.y === undefined || origin.y === null ? height / 2 : Number(origin.y);
    return [x, y];
  }
  if (origin.type === "top_left") return [0, 0];
  return [width / 2, height / 2];
}

/* ═══════════════════════════ job execution ═══════════════════════════ */

let cancelled = false;

function processFill(jobId, rgba, width, height, config) {
  const started = Date.now();
  const n = width * height;

  const imageScale = Math.max(0.1, Number(config.image_scale || 1.0));
  const outputAlpha = config.output_alpha !== undefined ? Number(config.output_alpha) : 1.0;
  const enablePngMode = Boolean(config.enable_png_mode);
  const sourceIsPng = String(config.source_ext || "").toLowerCase() === ".png" ||
    String(config.source_filename || "").toLowerCase().endsWith(".png");
  let hasTransparentAlpha = false;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 255) { hasTransparentAlpha = true; break; }
  }
  const pngWithTransparency = sourceIsPng && hasTransparentAlpha;
  const maskThreshold = Imaging.clamp(Number(config.mask_threshold || 127) | 0, 1, 254);
  const transparentOutput = pngWithTransparency && enablePngMode;
  const needsWhiteBackground = pngWithTransparency && !enablePngMode;
  const imageCenter = resolveOrigin(config, width, height);

  /* --- target image + mask (primitive_backend._extract_image_and_mask) --- */
  let targetImage;       // RGBA to fit against
  let cleanedMask;       // for bbox / mask info
  let browserImage;      // what the result page displays as "original"
  let maskEnabled;

  // primitive_backend._extract_image_and_mask flattens in float32.
  const flattened = Imaging.flattenOnWhiteF32(rgba, width, height);

  if (transparentOutput) {
    // fit variant "png": flatten RGB but keep compressed alpha as target A
    targetImage = new Uint8ClampedArray(flattened);
    const alphaU8 = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) alphaU8[i] = rgba[i * 4 + 3];
    const compressed = compressAlphaForFitting(alphaU8, n);
    for (let i = 0; i < n; i++) targetImage[i * 4 + 3] = compressed[i];
    // coverage for bbox: alpha > 0
    cleanedMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) cleanedMask[i] = rgba[i * 4 + 3] > 0 ? 255 : 0;
    browserImage = rgba; // keep transparency
    maskEnabled = false;
  } else {
    targetImage = flattened;
    let mask;
    if (hasTransparentAlpha) {
      mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = rgba[i * 4 + 3] >= maskThreshold ? 255 : 0;
    } else {
      mask = Imaging.extractMask(flattened, width, height, false);
    }
    cleanedMask = Imaging.morphOpen(Imaging.morphClose(mask, width, height), width, height);
    browserImage = flattened;
    maskEnabled = true;
  }

  /* --- work image scaling (fit_image_with_primitive) --- */
  const numPrimitives = Math.max(1, Number(config.num_primitives || 400) | 0);
  const detailScale = Math.max(0.25, Number(config.detail_scale || 1.0));
  const fullMaxDim = Math.max(width, height);
  // Python round() is banker's rounding — matters when a dimension lands
  // exactly on .5 after scaling
  const canvasLimit = Math.max(16, Math.min(PyNum.roundInt(fullMaxDim * detailScale), fullMaxDim, 2048));
  const resizeRatio = Math.min(1.0, canvasLimit / Math.max(fullMaxDim, 1));
  const workWidth = Math.max(1, PyNum.roundInt(width * resizeRatio));
  const workHeight = Math.max(1, PyNum.roundInt(height * resizeRatio));

  const workImage = (workWidth !== width || workHeight !== height)
    // downscale (resize_ratio <= 1) → cv2.INTER_AREA, 4-channel RGBA
    ? Imaging.cvResizeU8(targetImage, width, height, workWidth, workHeight, 4, "area")
    : targetImage;

  const scaleX = width / workWidth;
  const scaleY = height / workHeight;

  /* --- run the primitive model --- */
  const bgA = transparentOutput ? 0 : 255;
  const seed = (config.random_seed !== undefined && config.random_seed !== null)
    ? Number(config.random_seed)
    : deriveSeed();
  const model = new PrimitiveModel(workImage, workWidth, workHeight, 255, 255, 255, bgA, seed);
  const shapeConfigs = buildShapeConfigs(config.allowed_shapes, numPrimitives);

  // Go search defaults: n=1000 random, age=100 hill-climb, m=16 climbs (one
  // worker → wm=16). Required for bit-exact parity with `primitive -j 1`.
  const SEARCH_N = 1000, SEARCH_AGE = 100, SEARCH_M = 16;

  const results = [];
  let done = 0;
  for (const [mode, count] of shapeConfigs) {
    for (let i = 0; i < count; i++) {
      if (cancelled) return null;
      const { shape, alpha, color } = model.step(mode, 0, SEARCH_N, SEARCH_AGE, SEARCH_M);
      const res = shape.toResult(scaleX, scaleY);
      res.color = rgbToHex(color[0], color[1], color[2]);
      // SVG fill-opacity="%f" (float64(A)/255) re-parsed by Python float().
      res.alpha = goFmtF6num(color[3] / 255);
      res.packed_color = packColor(res.color, res.alpha);
      results.push(res);
      done++;
      if (done % 5 === 0 || done === numPrimitives) {
        postMessage({ type: "progress", jobId, step: done, total: numPrimitives });
      }
    }
  }

  /* --- PNG-mode alpha weighting (_apply_alpha_weights_to_results) --- */
  let alphaMap = null;
  if (transparentOutput) {
    alphaMap = new Float64Array(n);
    for (let i = 0; i < n; i++) alphaMap[i] = rgba[i * 4 + 3] / 255;
    for (const res of results) {
      const opacity = shapeOpacity(res, alphaMap, width, height);
      let alpha;
      if (opacity <= MIN_VISIBLE_ALPHA_WEIGHT) alpha = 0;
      else alpha = Imaging.clamp((res.alpha !== undefined ? res.alpha : 1.0) * opacity, 0, 1);
      res.alpha = alpha;
      res.packed_color = packColor(res.color, alpha);
    }
  }

  /* --- preview rendering (_render_preview) ---
   * Rendered at full size from the model's current canvas (premultiplied
   * RGBA), upscaled like the Python code. */
  // _render_preview upscales with cv2.INTER_LINEAR (4-channel RGBA).
  let preview = Imaging.cvResizeU8(unpremultiply(model.current, workWidth, workHeight), workWidth, workHeight, width, height, 4, "linear");
  if (transparentOutput) {
    // multiply alpha with original alpha map
    for (let i = 0; i < n; i++) {
      // Python: np.rint(alpha * (resized_alpha / 255.0)) — half-to-even
      preview[i * 4 + 3] = PyNum.rint(preview[i * 4 + 3] * (rgba[i * 4 + 3] / 255));
    }
  } else {
    for (let i = 0; i < n; i++) preview[i * 4 + 3] = 255;
  }

  /* --- elements + result object (shaper_core.process_image_fill) --- */
  const elements = resultsToElements(results, imageScale, imageCenter, config.primitives || [], outputAlpha);

  if (needsWhiteBackground) {
    const backgroundBleed = 4.0;
    const bgCenterX = (width / 2) * imageScale;
    const bgCenterY = -(height / 2) * imageScale;
    const originX = imageCenter[0] * imageScale;
    const originY = -imageCenter[1] * imageScale;
    elements.unshift({
      type: "rectangle",
      shape: "rect",
      center: { x: PyNum.round(bgCenterX, 4), y: PyNum.round(bgCenterY, 4) },
      relative: {
        x: PyNum.round(bgCenterX - originX, 4),
        y: PyNum.round(bgCenterY - originY, 4),
      },
      size: {
        width: PyNum.round((width + backgroundBleed * 2) * imageScale, 4),
        height: PyNum.round((height + backgroundBleed * 2) * imageScale, 4),
      },
      rotation: 0.0,
      color: "#ffffff",
      alpha: 1.0,
      packed_color: 0xFFFFFFFF,
      is_background: true,
    });
  }

  const [x0, y0, x1, y1] = maskBBox(cleanedMask, width, height);
  const maskWidth = Math.max(1, x1 - x0);
  const maskHeight = Math.max(1, y1 - y0);
  const maskCenterX = (x0 + x1) / 2;
  const maskCenterY = (y0 + y1) / 2;
  let coverage = 0;
  for (let i = 0; i < n; i++) if (cleanedMask[i]) coverage++;
  coverage /= n;

  const elapsed = (Date.now() - started) / 1000;

  return {
    mode: "fill",
    image_center: { x: imageCenter[0], y: imageCenter[1] },
    image_size: { width, height },
    config: {
      mode: "fill",
      engine: "primitive",
      fill_variant: transparentOutput ? "png" : "mask",
      enable_png_mode: enablePngMode,
      source_is_png: sourceIsPng,
      source_has_transparency: hasTransparentAlpha,
      output_has_transparency: transparentOutput,
      pixel_per_unit: PyNum.round(1.0 / imageScale, 6),
      unit_scale: imageScale,
      num_primitives: numPrimitives,
      mask_threshold: maskThreshold,
      image_scale: imageScale,
      allowed_shapes: config.allowed_shapes || ["circle"],
    },
    mask: {
      enabled: maskEnabled,
      shape_type: "rectangle",
      coverage: PyNum.round(coverage, 4),
      center: {
        x: PyNum.round(maskCenterX * imageScale, 4),
        y: PyNum.round(-maskCenterY * imageScale, 4),
      },
      size: {
        width: PyNum.round(maskWidth * imageScale, 4),
        height: PyNum.round(maskHeight * imageScale, 4),
      },
      bbox_px: { x: x0, y: y0, width: maskWidth, height: maskHeight },
    },
    elements_count: elements.length,
    elements,
    /* raw image buffers — main thread turns these into canvases/blobs */
    image_rgba: browserImage.buffer.slice(0),
    preview_rgba: preview.buffer.slice(0),
    mask_gray: maskEnabled ? cleanedMask.buffer.slice(0) : null,
    elapsed_seconds: PyNum.round(elapsed, 2),
  };
}

function unpremultiply(premul, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = premul[i * 4 + 3];
    if (a === 0) {
      out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; out[i * 4 + 3] = 0;
    } else {
      out[i * 4] = Math.min(255, Math.round(premul[i * 4] * 255 / a));
      out[i * 4 + 1] = Math.min(255, Math.round(premul[i * 4 + 1] * 255 / a));
      out[i * 4 + 2] = Math.min(255, Math.round(premul[i * 4 + 2] * 255 / a));
      out[i * 4 + 3] = a;
    }
  }
  return out;
}

if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = (event) => {
    const msg = event.data;
    if (msg.cmd === "cancel") { cancelled = true; return; }
    if (msg.cmd !== "process") return;
    cancelled = false;
    try {
      const rgba = new Uint8ClampedArray(msg.rgba);
      const result = processFill(msg.jobId, rgba, msg.width, msg.height, msg.config || {});
      if (result === null) {
        postMessage({ type: "cancelled", jobId: msg.jobId });
      } else {
        const transfers = [result.image_rgba, result.preview_rgba];
        if (result.mask_gray) transfers.push(result.mask_gray);
        postMessage({ type: "done", jobId: msg.jobId, result }, transfers);
      }
    } catch (error) {
      postMessage({ type: "error", jobId: msg.jobId, message: String(error && error.message ? error.message : error) });
    }
  };
}

/* Node: expose the primitive core for the parity test runner. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHAPE_TRIANGLE, SHAPE_ROTATED_RECT, SHAPE_ROTATED_ELLIPSE,
    clampInt, clamp, goIntDiv, premultByte, goFmtF, goFmtF6num,
    ScanlineBuffer, cropScanlines,
    TriangleShape, RotatedRectShape, RotatedEllipseShape,
    PrimitiveModel,
    normalizeAllowedShapes, buildShapeConfigs,
  };
}
