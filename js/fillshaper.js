/*
 * fillshaper.js — exact port of the fill_shaper.py pieces the fill pipeline
 * uses: the antialiased Circle/Rect/Triangle rasterizers, _shape_opacity
 * (with numpy pairwise summation), and _result_to_shape.
 *
 * Mirrors the numpy float64 vectorized math element-for-element in row-major
 * (y-major) order so sums are bit-identical.
 */
"use strict";

if (typeof PyNum === "undefined" && typeof require !== "undefined") {
  // Node test context
  global.PyNum = require("./pynum.js");
}

const FillShaper = (() => {

  /* CPython math.radians multiplies by a single precomputed constant
   * (degToRad = pi/180 rounded once). x*PI/180 as two operations rounds
   * differently — do NOT "simplify" this. */
  const DEG2RAD = Math.PI / 180;

  function clip01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* Circle.rasterize — returns {ys:Int32Array, xs:Int32Array, alphas:Float64Array} */
  function rasterizeCircle(cx, cy, radiusX, radiusY, angleDeg, width, height) {
    const rx = Math.max(radiusX, 0.5);
    const ry = Math.max(radiusY, 0.5);
    const angle = angleDeg * DEG2RAD;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const extentX = Math.sqrt((rx * cosA) * (rx * cosA) + (ry * sinA) * (ry * sinA)) + 1;
    const extentY = Math.sqrt((rx * sinA) * (rx * sinA) + (ry * cosA) * (ry * cosA)) + 1;
    const x0 = Math.max(Math.floor(cx - extentX), 0);
    const x1 = Math.min(Math.ceil(cx + extentX), width);
    const y0 = Math.max(Math.floor(cy - extentY), 0);
    const y1 = Math.min(Math.ceil(cy + extentY), height);
    if (x0 >= x1 || y0 >= y1) return empty();

    const ys = [], xs = [], alphas = [];
    const edgeScale = Math.max(rx, ry);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const localX = dx * cosA + dy * sinA;
        const localY = -dx * sinA + dy * cosA;
        const norm = (localX / rx) * (localX / rx) + (localY / ry) * (localY / ry);
        const dist = Math.sqrt(Math.max(norm, 0));
        const aa = clip01((1 - dist) * edgeScale + 0.5);
        if (aa > 0) {
          ys.push(y); xs.push(x); alphas.push(aa);
        }
      }
    }
    return pack(ys, xs, alphas);
  }

  /* Rect.rasterize */
  function rasterizeRect(cx, cy, halfWidth, halfHeight, angleDeg, width, height) {
    const hw = Math.max(halfWidth, 0.5);
    const hh = Math.max(halfHeight, 0.5);
    const angle = angleDeg * DEG2RAD;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const extent = Math.sqrt(hw * hw + hh * hh) + 1;
    const x0 = Math.max(Math.floor(cx - extent), 0);
    const x1 = Math.min(Math.ceil(cx + extent), width);
    const y0 = Math.max(Math.floor(cy - extent), 0);
    const y1 = Math.min(Math.ceil(cy + extent), height);
    if (x0 >= x1 || y0 >= y1) return empty();

    const ys = [], xs = [], alphas = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const localX = dx * cosA + dy * sinA;
        const localY = -dx * sinA + dy * cosA;
        const distX = hw + 0.5 - Math.abs(localX);
        const distY = hh + 0.5 - Math.abs(localY);
        const aa = clip01(Math.min(distX, distY));
        if (aa > 0) {
          ys.push(y); xs.push(x); alphas.push(aa);
        }
      }
    }
    return pack(ys, xs, alphas);
  }

  /* Triangle.rasterize */
  function rasterizeTriangle(cx, cy, baseWidth, triHeightIn, angleDeg, width, height) {
    const bw = Math.max(baseWidth, 0.5);
    const th = Math.max(triHeightIn, 0.5);
    // local vertices, then world = local @ R.T + c
    const angle = angleDeg * DEG2RAD;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const local = [
      [0.0, -2.0 * th / 3.0],
      [-bw / 2.0, th / 3.0],
      [bw / 2.0, th / 3.0],
    ];
    /* Python: world_vertices = local @ rotation.T, then += cx/cy.
     * numpy dispatches even this 3x2 @ 2x2 to BLAS, which accumulates the
     * k-dimension with FMA: acc = RN(lx*b0); acc = fma(ly, b1, acc).
     * Plain two-op multiply-add differs in the last ulp — use exact fma. */
    const vx = new Float64Array(3);
    const vy = new Float64Array(3);
    for (let i = 0; i < 3; i++) {
      const lx = local[i][0], ly = local[i][1];
      vx[i] = PyNum.fma(ly, -sinA, lx * cosA) + cx;
      vy[i] = PyNum.fma(ly, cosA, lx * sinA) + cy;
    }

    const minX = Math.min(vx[0], vx[1], vx[2]);
    const maxX = Math.max(vx[0], vx[1], vx[2]);
    const minY = Math.min(vy[0], vy[1], vy[2]);
    const maxY = Math.max(vy[0], vy[1], vy[2]);
    const x0 = Math.max(Math.floor(minX - 1), 0);
    const x1 = Math.min(Math.ceil(maxX + 1), width);
    const y0 = Math.max(Math.floor(minY - 1), 0);
    const y1 = Math.min(Math.ceil(maxY + 1), height);
    if (x0 >= x1 || y0 >= y1) return empty();

    // edges: a = v1-v0, b = v2-v1, c = v0-v2
    const eax = vx[1] - vx[0], eay = vy[1] - vy[0];
    const ebx = vx[2] - vx[1], eby = vy[2] - vy[1];
    const ecx = vx[0] - vx[2], ecy = vy[0] - vy[2];

    const distToSeg = (px, py, ax, ay, bx, by) => {
      const apx = px - ax, apy = py - ay;
      const abx = bx - ax, aby = by - ay;
      const abLenSq = Math.max(abx * abx + aby * aby, 1e-8);
      let t = (apx * abx + apy * aby) / abLenSq;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const closestX = ax + t * abx;
      const closestY = ay + t * aby;
      const ddx = px - closestX, ddy = py - closestY;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    };

    const ys = [], xs = [], alphas = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const c1 = (x - vx[0]) * eay - (y - vy[0]) * eax;
        const c2 = (x - vx[1]) * eby - (y - vy[1]) * ebx;
        const c3 = (x - vx[2]) * ecy - (y - vy[2]) * ecx;
        const sameSide = (c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0);
        if (!sameSide) continue; // aa would be 0
        const d1 = distToSeg(x, y, vx[0], vy[0], vx[1], vy[1]);
        const d2 = distToSeg(x, y, vx[1], vy[1], vx[2], vy[2]);
        const d3 = distToSeg(x, y, vx[2], vy[2], vx[0], vy[0]);
        const dist = Math.min(d1, d2, d3);
        let aa = clip01(0.5 + dist);
        aa = Math.min(aa, 1);
        if (aa > 0) {
          ys.push(y); xs.push(x); alphas.push(aa);
        }
      }
    }
    return pack(ys, xs, alphas);
  }

  function empty() {
    return { ys: new Int32Array(0), xs: new Int32Array(0), alphas: new Float64Array(0) };
  }

  function pack(ys, xs, alphas) {
    return {
      ys: Int32Array.from(ys),
      xs: Int32Array.from(xs),
      alphas: Float64Array.from(alphas),
    };
  }

  /* primitive_backend._result_to_shape → rasterize dispatch */
  function rasterizeResult(result, width, height) {
    const type = String(result.type || "").trim().toLowerCase();
    if (type === "circle") {
      const rx = Number(result.rx !== undefined ? result.rx : 0.5);
      const ry = Number(result.ry !== undefined ? result.ry : (result.rx !== undefined ? result.rx : 0.5));
      return rasterizeCircle(Number(result.cx || 0), Number(result.cy || 0), rx, ry, Number(result.angle || 0), width, height);
    }
    if (type === "rect") {
      const hw = Number(result.hw !== undefined ? result.hw : 0.5);
      const hh = Number(result.hh !== undefined ? result.hh : (result.hw !== undefined ? result.hw : 0.5));
      return rasterizeRect(Number(result.cx || 0), Number(result.cy || 0), hw, hh, Number(result.angle || 0), width, height);
    }
    if (type === "triangle") {
      const w = Number(result.width !== undefined ? result.width : (result.size !== undefined ? result.size : 1.0));
      const h = Number(result.height !== undefined ? result.height : w);
      return rasterizeTriangle(Number(result.cx || 0), Number(result.cy || 0), w, h, Number(result.angle || 0), width, height);
    }
    return null;
  }

  /* fill_shaper._shape_opacity: mean coverage weight over the AA-rasterized
   * shape, with numpy pairwise-summation semantics. weights is Float64Array
   * of length width*height. */
  function shapeOpacity(result, weights, width, height) {
    const raster = rasterizeResult(result, width, height);
    if (raster === null || raster.ys.length === 0) return 0.0;
    const { ys, xs, alphas } = raster;
    const total = PyNum.pairwiseSum(alphas);
    if (total <= 1e-8) return 0.0;
    const products = new Float64Array(alphas.length);
    for (let i = 0; i < alphas.length; i++) {
      products[i] = alphas[i] * weights[ys[i] * width + xs[i]];
    }
    return PyNum.pairwiseSum(products) / total;
  }

  return { rasterizeCircle, rasterizeRect, rasterizeTriangle, rasterizeResult, shapeOpacity };
})();

if (typeof module !== "undefined") module.exports = FillShaper;
