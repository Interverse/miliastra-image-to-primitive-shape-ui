/*
 * worker-outline.js — outline ("decoration") mode engine.
 *
 * JS port of final_shaper.py (Shaper V6: curvature-guided path walking)
 * plus the outline branch of shaper_core.process_image_outline.
 *
 * Shapely (GEOS) polygon operations are provided by geometry.js (see
 * tests/parity/shapely): the contour ring is simplified with the exact
 * TopologyPreservingSimplifier, and candidate containment is measured by
 * true polygon intersection area against the shapely-exact ellipse/rect/circle
 * rings, so fitting decisions match final_shaper.py to the bit. Coverage /
 * gap detection still rasterizes via imaging.js (as cv2 does in Python).
 */
"use strict";

importScripts("imaging.js", "pynum.js", "geometry.js");

const ELLIPSE = "ellipse";
const RECTANGLE = "rectangle";

/* ─────────────── FittingConfig ─────────────── */

function makeConfig(minSize, maxSize, spacingRatio, precision, allowedTypes) {
  const aspectRatioLimit = 2.5;
  return {
    minSize, maxSize, spacingRatio,
    aspectRatioLimit,
    precision,
    allowedTypes, // array or null
    effectiveAspectLimit: aspectRatioLimit + (1.0 - precision) * 3.0,
    rectBonus: (1.0 - precision) * 1.5,
    minRadiusForStretch: minSize * (0.5 + precision * 0.5),
    curvatureSigma: 5.0,
    straightThresh: 0.012,
    tightThresh: 0.06,
    gapSampleStep: 1.0,
    gapDilatePx: 1,
    gapFillIterations: 5,
    expandGrowthFactors: [1.15, 1.1, 1.05],
    stepTightFactor: 0.55,
    stepStraightFactor: 1.15,
  };
}

/* ─────────────── curvature analysis ─────────────── */

function computeCurvature(ptsX, ptsY, sigma) {
  const N = ptsX.length;
  if (N < 5) return new Float64Array(N);
  const pad = Math.max(Math.trunc(3 * sigma), 3);
  const xArr = new Float64Array(N + 2 * pad);
  const yArr = new Float64Array(N + 2 * pad);
  for (let i = 0; i < pad; i++) {
    xArr[i] = ptsX[N - pad + i];
    yArr[i] = ptsY[N - pad + i];
  }
  for (let i = 0; i < N; i++) {
    xArr[pad + i] = ptsX[i];
    yArr[pad + i] = ptsY[i];
  }
  for (let i = 0; i < pad; i++) {
    xArr[pad + N + i] = ptsX[i];
    yArr[pad + N + i] = ptsY[i];
  }
  const xs = PyNum.scipyGaussianFilter1d(xArr, sigma);
  const ys = PyNum.scipyGaussianFilter1d(yArr, sigma);
  const dx = Imaging.gradient1d(xs), dy = Imaging.gradient1d(ys);
  const ddx = Imaging.gradient1d(dx), ddy = Imaging.gradient1d(dy);
  const k = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const j = pad + i;
    const num = Math.abs(dx[j] * ddy[j] - dy[j] * ddx[j]);
    const den = Math.max(Math.pow(dx[j] * dx[j] + dy[j] * dy[j], 1.5), 1e-10);
    k[i] = num / den;
  }
  return PyNum.scipyGaussianFilter1d(k, sigma * 0.4);
}

function classifyCurvature(k, cfg) {
  const labels = new Int32Array(k.length).fill(1);
  for (let i = 0; i < k.length; i++) {
    if (k[i] < cfg.straightThresh) labels[i] = 0;
    else if (k[i] >= cfg.tightThresh) labels[i] = 2;
  }
  return labels;
}

const SEG_NAMES = { 0: "straight", 1: "curved", 2: "tight" };

function mergeShortRuns(labels, minRun) {
  const N = labels.length;
  if (N === 0) return labels;
  const out = Int32Array.from(labels);
  const runs = [];
  let start = 0;
  for (let i = 1; i < N; i++) {
    if (out[i] !== out[start]) {
      runs.push([start, i, out[start]]);
      start = i;
    }
  }
  runs.push([start, N, out[start]]);
  for (let idx = 1; idx < runs.length; idx++) {
    const [s, e] = runs[idx];
    if (e - s < minRun) {
      const prevT = runs[idx - 1][2];
      for (let i = s; i < e; i++) out[i] = prevT;
    }
  }
  return out;
}

/* ─────────────── geometry tools ─────────────── */

function buildArcLengthIndex(ptsX, ptsY) {
  const N = ptsX.length;
  const cum = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    const dx = ptsX[i] - ptsX[i - 1], dy = ptsY[i] - ptsY[i - 1];
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return { cumArc: cum, totalArc: cum[N - 1] };
}

function cursorToIndex(cursor, cumArc, totalArc) {
  // Python float %: fmod, adjusted to the divisor's sign. A "safe" double
  // mod ((x%d)+d)%d rounds differently and can flip searchsorted at exact
  // vertex arcs — use the single-mod form Python computes.
  const d = Math.max(totalArc, 1e-10);
  let c = cursor % d;
  if (c !== 0 && (c < 0) !== (d < 0)) c += d;
  // binary search: first index with cumArc[idx] >= c (np.searchsorted 'left')
  let lo = 0, hi = cumArc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumArc[mid] < c) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, cumArc.length - 2);
}

function tangentNormalAt(ptsX, ptsY, idx, distMap, w, h) {
  const N = ptsX.length;
  const i0 = (idx - 1 + N) % N;
  const i1 = (idx + 1) % N;
  let tx = ptsX[i1] - ptsX[i0];
  let ty = ptsY[i1] - ptsY[i0];
  const norm = Math.max(Math.sqrt(tx * tx + ty * ty), 1e-10);
  tx /= norm; ty /= norm;
  let nx = -ty, ny = tx;

  const px = ptsX[idx], py = ptsY[idx];
  const ix0 = px | 0, iy0 = py | 0;
  let probe = 2.0;
  if (ix0 >= 0 && ix0 < w && iy0 >= 0 && iy0 < h) {
    probe = Math.max(2.0, distMap[iy0 * w + ix0] * 0.4);
  }
  const t1x = px + nx * probe, t1y = py + ny * probe;
  const t2x = px - nx * probe, t2y = py - ny * probe;
  let v1 = 0, v2 = 0;
  const ix1 = t1x | 0, iy1 = t1y | 0;
  const ix2 = t2x | 0, iy2 = t2y | 0;
  if (ix1 >= 0 && ix1 < w && iy1 >= 0 && iy1 < h) v1 = distMap[iy1 * w + ix1];
  if (ix2 >= 0 && ix2 < w && iy2 >= 0 && iy2 < h) v2 = distMap[iy2 * w + ix2];
  if (v2 > v1) { nx = -nx; ny = -ny; }
  return { tx, ty, nx, ny };
}

function maxInscribedRadius(px, py, nx, ny, distMap, w, h, rmin, rmax) {
  const actualLo = Math.max(1.5, rmin * 0.3);
  let lo = actualLo, hi = rmax;
  let bestR = actualLo;
  let bestCx = px + nx * actualLo, bestCy = py + ny * actualLo;

  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) * 0.5;
    const cx = px + nx * mid, cy = py + ny * mid;
    const ix = cx | 0, iy = cy | 0;
    if (ix >= 0 && ix < w && iy >= 0 && iy < h && distMap[iy * w + ix] >= mid * 0.95) {
      bestR = mid; bestCx = cx; bestCy = cy;
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.3) break;
  }

  const cix = bestCx | 0, ciy = bestCy | 0;
  if (cix >= 0 && cix < w && ciy >= 0 && ciy < h) {
    bestR = Math.min(bestR, distMap[ciy * w + cix]);
  }
  bestR = Math.max(bestR, 1.5);
  return { r: bestR, cx: bestCx, cy: bestCy };
}

/* Build the shapely-exact ring for a candidate shape (closed ring of [x,y]). */
function shapeRing(kind, cx, cy, a, b, angleDeg) {
  return kind === ELLIPSE
    ? Geometry.makeEllipsePoly(cx, cy, a, b, angleDeg)
    : Geometry.makeRectPoly(cx, cy, a, b, angleDeg);
}

/* dist_map_containment_check: 32 boundary points by arc length along the actual
 * shape ring (shapely boundary.interpolate), sampled against the distance map. */
function distMapContainmentCheck(ring, distMap, w, h, sampleN) {
  sampleN = sampleN || 32;
  const totalLen = Geometry.boundaryLength(ring);
  if (totalLen < 1) return 1.0;
  let inside = 0;
  for (let i = 0; i < sampleN; i++) {
    const p = Geometry.interpolate(ring, (i / sampleN) * totalLen);
    const ix = p[0] | 0, iy = p[1] | 0;
    if (ix >= 0 && ix < w && iy >= 0 && iy < h && distMap[iy * w + ix] >= 0.5) inside++;
  }
  return inside / sampleN;
}

/* ─────────────── best primitive at point ─────────────── */

function bestPrimitiveAt(px, py, tangent, distMap, w, h, polyRing, cfg, kappa, segLabel) {
  const rmin = cfg.minSize / 2;
  const rmax = cfg.maxSize / 2;
  const { r: bestR, cx, cy } = maxInscribedRadius(px, py, tangent.nx, tangent.ny, distMap, w, h, rmin, rmax);
  const ang = Math.atan2(tangent.ty, tangent.tx) * (180 / Math.PI);  // math.degrees(atan2(..))
  const containT = 0.88 + cfg.precision * 0.10;

  const allowEllipse = cfg.allowedTypes === null || cfg.allowedTypes.includes(ELLIPSE);
  const allowRect = cfg.allowedTypes === null || cfg.allowedTypes.includes(RECTANGLE);

  const candidates = [];

  // ---- base candidate: circle (Point(center).buffer(bestR)) ----
  if (allowEllipse) {
    candidates.push({
      type: ELLIPSE, cx, cy, size: [bestR, bestR], rot: ang,
      score: Math.PI * bestR * bestR, tr: bestR, sr: bestR,
      poly: Geometry.pointBuffer(cx, cy, bestR),
    });
  }

  // ---- base candidate: square (box -> rotate -> translate) ----
  if (allowRect) {
    const bs = bestR * 1.6;
    candidates.push({
      type: RECTANGLE, cx, cy, size: [bs, bs], rot: ang,
      score: bs * bs * 0.9, tr: bs / 2, sr: bs / 2,
      poly: Geometry.makeRectPoly(cx, cy, bs, bs, ang),
    });
  }

  if (bestR >= cfg.minRadiusForStretch) {
    const seg = SEG_NAMES[segLabel] || "curved";
    const kf = Math.max(0.0, 1.0 - kappa * 30);
    let maxStretch, rectBonus;
    if (seg === "straight") {
      maxStretch = cfg.effectiveAspectLimit + kf * 2;
      rectBonus = cfg.rectBonus + 1.5;
    } else if (seg === "curved") {
      maxStretch = cfg.effectiveAspectLimit + kf * 0.5;
      rectBonus = cfg.rectBonus * 0.5;
    } else {
      maxStretch = Math.min(cfg.effectiveAspectLimit, 2.0);
      rectBonus = 0.0;
    }

    for (const asp of [1.3, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0, maxStretch]) {
      if (asp > maxStretch) continue;
      const mr = bestR * asp;

      if (allowEllipse) {
        const ep = Geometry.makeEllipsePoly(cx, cy, mr, bestR, ang);
        const ia = Geometry.intersectionArea(polyRing, ep);
        const ea = Geometry.polygonArea(ep);
        if (ea > 0 && ia >= ea * containT) {
          const dmRatio = distMapContainmentCheck(ep, distMap, w, h);
          const dmThresh = Math.max(0.70, 0.88 - asp * 0.03);
          if (dmRatio >= dmThresh) {
            const containment = ia / ea;
            const compactness = bestR / mr;
            const cpFactor = 1.0 - cfg.precision * (1.0 - compactness) * 0.5;
            const score = Math.PI * mr * bestR * containment * containment * cpFactor;
            candidates.push({
              type: ELLIPSE, cx, cy, size: [mr, bestR], rot: ang,
              score, tr: mr, sr: bestR, poly: ep,
            });
          }
        }
      }

      if (allowRect) {
        const rectContainT = Math.max(0.86, containT - (1.0 - cfg.precision) * 0.06);
        const rw = mr * 2, rh = bestR * 2;
        const rp = Geometry.makeRectPoly(cx, cy, rw, rh, ang);
        const ia = Geometry.intersectionArea(polyRing, rp);
        const ra = Geometry.polygonArea(rp);
        if (ra > 0 && ia >= ra * rectContainT) {
          const dmRatio = distMapContainmentCheck(rp, distMap, w, h);
          const dmThresh = Math.max(0.65, 0.85 - asp * 0.04);
          if (dmRatio >= dmThresh) {
            const containment = ia / ra;
            const compactness = rh / rw;
            const cpFactor = 1.0 - cfg.precision * (1.0 - compactness) * 0.5;
            const score = rw * rh * (1.0 + rectBonus) * Math.pow(containment, 3) * cpFactor;
            candidates.push({
              type: RECTANGLE, cx, cy, size: [rw, rh], rot: ang,
              score, tr: rw / 2, sr: rh / 2, poly: rp,
            });
          }
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates) if (c.score > best.score) best = c;  // first-max tie-break
  return best;
}

/* ─────────────── main bead laying ─────────────── */

function elementFromBest(best, cidx, id, imgCenter, cursor) {
  const elem = {
    id: `${cidx}_${id}`,
    type: best.type,
    center: { x: PyNum.round(best.cx, 2), y: PyNum.round(best.cy, 2) },
    relative_position: {
      x: PyNum.round(best.cx - imgCenter[0], 2),
      y: PyNum.round(best.cy - imgCenter[1], 2),
    },
    rotation: PyNum.round(best.rot, 2),
    _tr: best.tr,
    _cursor: cursor,
    _poly: best.poly,
  };
  if (best.type === ELLIPSE) {
    elem.size = { rx: PyNum.round(best.size[0], 2), ry: PyNum.round(best.size[1], 2) };
  } else {
    elem.size = { width: PyNum.round(best.size[0], 2), height: PyNum.round(best.size[1], 2) };
  }
  return elem;
}

function fitBeads(cidx, ptsX, ptsY, distMap, w, h, polyRing, cfg, imgCenter) {
  const N = ptsX.length;
  if (N < 3) return [];

  // poly = Polygon(pts).simplify(1.0, True) [+ buffer(0) repair]; gate on area.
  // buffer(0) is area-preserving and the raw ring reproduces its intersection,
  // so is_valid is always effectively satisfied here (see geometry.js notes).
  if (Geometry.polygonArea(polyRing) < cfg.minSize * cfg.minSize) return [];

  const kappa = computeCurvature(ptsX, ptsY, cfg.curvatureSigma);
  let labels = classifyCurvature(kappa, cfg);
  labels = mergeShortRuns(labels, 5);

  const { cumArc, totalArc } = buildArcLengthIndex(ptsX, ptsY);

  const elements = [];
  let cursor = 0.0;
  const maxIter = Math.trunc(totalArc / (cfg.minSize * 0.3)) + 300;
  let it = 0;

  while (cursor < totalArc && it < maxIter) {
    it++;
    const idx = cursorToIndex(cursor, cumArc, totalArc);
    const px = ptsX[idx], py = ptsY[idx];
    const tangent = tangentNormalAt(ptsX, ptsY, idx, distMap, w, h);
    const k = kappa[idx];
    const lb = labels[idx];

    const best = bestPrimitiveAt(px, py, tangent, distMap, w, h, polyRing, cfg, k, lb);

    if (best === null) {
      cursor += cfg.minSize * 0.5;
      continue;
    }

    elements.push(elementFromBest(best, cidx, elements.length, imgCenter, cursor));

    const sr = best.sr !== undefined ? best.sr : best.tr;
    const tr = best.tr;
    const lookaheadEnd = Math.min(idx + 20, N - 1);
    let kAhead = 0.03;
    if (lookaheadEnd > idx + 2) {
      let sum = 0;
      for (let i = idx; i < lookaheadEnd; i++) sum += kappa[i];
      kAhead = sum / (lookaheadEnd - idx);
    }
    let baseStep;
    if (kAhead < cfg.straightThresh) {
      baseStep = tr * 2 * cfg.spacingRatio * cfg.stepStraightFactor;
    } else if (kAhead >= cfg.tightThresh) {
      baseStep = Math.min(tr, sr * 2.0) * 2 * cfg.spacingRatio * cfg.stepTightFactor;
    } else {
      baseStep = Math.min(tr, sr * 2.5) * 2 * cfg.spacingRatio;
    }
    cursor += Math.max(baseStep, cfg.minSize * 0.4);
  }

  return elements;
}

/* ─────────────── coverage / gap detection ─────────────── */

function renderElementToMask(elem, w, h) {
  const single = new Uint8Array(w * h);
  const cx = elem.center.x | 0, cy = elem.center.y | 0;
  const ang = elem.rotation;
  if (elem.type === ELLIPSE) {
    Imaging.cvEllipseFill(single, w, h, cx, cy, Math.max(elem.size.rx | 0, 1), Math.max(elem.size.ry | 0, 1), ang);
  } else {
    Imaging.cvBoxFill(single, w, h, cx, cy, Math.max(elem.size.width, 1), Math.max(elem.size.height, 1), ang);
  }
  return single;
}

function renderCoverageMask(elements, w, h) {
  const cov = new Uint8Array(w * h);
  for (const elem of elements) {
    const cx = elem.center.x | 0, cy = elem.center.y | 0;
    if (elem.type === ELLIPSE) {
      Imaging.cvEllipseFill(cov, w, h, cx, cy, Math.max(elem.size.rx | 0, 1), Math.max(elem.size.ry | 0, 1), elem.rotation);
    } else {
      Imaging.cvBoxFill(cov, w, h, cx, cy, Math.max(elem.size.width, 1), Math.max(elem.size.height, 1), elem.rotation);
    }
  }
  return cov;
}

function detectGaps(elements, ptsX, ptsY, cumArc, w, h, cfg) {
  let covMask = renderCoverageMask(elements, w, h);
  if (cfg.gapDilatePx > 0) {
    covMask = Imaging.dilateSquare(covMask, w, h, cfg.gapDilatePx);
  }
  const N = ptsX.length;
  const step = Math.max(Math.trunc(cfg.gapSampleStep), 1);
  const sampleIdx = [];
  for (let i = 0; i < N; i += step) sampleIdx.push(i);
  const covered = new Uint8Array(sampleIdx.length);
  for (let si = 0; si < sampleIdx.length; si++) {
    const x = ptsX[sampleIdx[si]] | 0, y = ptsY[sampleIdx[si]] | 0;
    if (x >= 0 && x < w && y >= 0 && y < h) covered[si] = covMask[y * w + x] ? 1 : 0;
  }
  const minGapSamples = Math.max(Math.trunc(cfg.minSize * 0.5 / Math.max(cfg.gapSampleStep, 0.5)), 2);
  const gaps = [];
  let i = 0;
  const n = covered.length;
  while (i < n) {
    if (!covered[i]) {
      let j = i;
      while (j < n && !covered[j]) j++;
      if (j - i >= minGapSamples) {
        const sArc = cumArc[sampleIdx[i]];
        const eArc = cumArc[sampleIdx[Math.min(j - 1, n - 1)]];
        gaps.push([sArc, eArc, eArc - sArc]);
      }
      i = j;
    } else {
      i++;
    }
  }
  return gaps;
}

/* ─────────────── gap filling ─────────────── */

function fillGaps(elements, cidx, ptsX, ptsY, cumArc, totalArc, polyRing, distMap, w, h, cfg, imgCenter) {
  let current = elements.slice();

  const kappa = computeCurvature(ptsX, ptsY, cfg.curvatureSigma);
  let labels = classifyCurvature(kappa, cfg);
  labels = mergeShortRuns(labels, 5);
  const NPts = ptsX.length;

  for (let iteration = 0; iteration < cfg.gapFillIterations; iteration++) {
    const gaps = detectGaps(current, ptsX, ptsY, cumArc, w, h, cfg);

    if (current.length) {
      const sorted = current.slice().sort((a, b) => (a._cursor || 0) - (b._cursor || 0));
      for (let i = 1; i < sorted.length; i++) {
        const e1 = sorted[i - 1], e2 = sorted[i];
        const ddx = e1.center.x - e2.center.x, ddy = e1.center.y - e2.center.y;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        const tr1 = e1._tr !== undefined ? e1._tr : cfg.minSize / 2;
        const tr2 = e2._tr !== undefined ? e2._tr : cfg.minSize / 2;
        const expected = Math.min(tr1, tr2) * 2 * cfg.spacingRatio;
        if (d > expected * 1.5) {
          const sArc = e1._cursor || 0;
          const eArc = e2._cursor || 0;
          const gLen = eArc - sArc;
          if (gLen > cfg.minSize * 0.3) {
            const already = gaps.some(g => Math.abs(g[0] - sArc) < cfg.minSize);
            if (!already) gaps.push([sArc, eArc, gLen]);
          }
        }
      }
    }

    if (!gaps.length) break;

    let covMask = renderCoverageMask(current, w, h);
    let added = 0;

    for (const [gStart, , gLenRaw] of gaps.map(g => [g[0], g[1], g[2]])) {
      const gLen = gLenRaw;
      if (gLen < cfg.minSize * 0.3) continue;
      const nFillers = Math.max(1, Math.trunc(gLen / cfg.minSize));
      for (let fi = 0; fi < nFillers; fi++) {
        const frac = (fi + 0.5) / nFillers;
        const fillArc = gStart + frac * gLen;
        const idx = cursorToIndex(fillArc, cumArc, totalArc);
        const px = ptsX[idx], py = ptsY[idx];
        const tangent = tangentNormalAt(ptsX, ptsY, idx, distMap, w, h);

        const kVal = idx < NPts ? kappa[idx] : 0.03;
        const lbVal = idx < NPts ? labels[idx] : 1;

        const best = bestPrimitiveAt(px, py, tangent, distMap, w, h, polyRing, cfg, kVal, lbVal);
        if (best === null) continue;

        const elem = elementFromBest(best, cidx, `gf${iteration}_${added}`, imgCenter, fillArc);
        elem.id = `${cidx}_gf${iteration}_${added}`;

        const single = renderElementToMask(elem, w, h);
        let elemPx = 0, coveredPx = 0;
        for (let i = 0; i < w * h; i++) {
          if (single[i]) {
            elemPx++;
            if (covMask[i]) coveredPx++;
          }
        }
        if (elemPx > 0 && coveredPx / elemPx > 0.7) continue;
        for (let i = 0; i < w * h; i++) if (single[i] > covMask[i]) covMask[i] = single[i];

        current.push(elem);
        added++;
      }
    }

    if (added === 0) break;
  }

  return current;
}

/* ─────────────── expansion ─────────────── */

function expandElements(elements, polyRing, cfg, distMap, w, h) {
  const containT = 0.88 + cfg.precision * 0.10;

  for (const elem of elements) {
    if (elem._poly == null) continue;
    const cx = elem.center.x, cy = elem.center.y;
    const ang = elem.rotation;

    if (elem.type === ELLIPSE) {
      let rx = elem.size.rx, ry = elem.size.ry;
      for (const g of cfg.expandGrowthFactors) {           // long axis
        const newRx = rx * g;
        const ep = Geometry.makeEllipsePoly(cx, cy, newRx, ry, ang);
        const ia = Geometry.intersectionArea(polyRing, ep);
        const ea = Geometry.polygonArea(ep);
        if (ea > 0 && ia >= ea * containT &&
            distMapContainmentCheck(ep, distMap, w, h) >= 0.92) {
          elem.size.rx = PyNum.round(newRx, 2);
          elem._poly = ep;
          elem._tr = newRx;
          rx = newRx;
          break;
        }
      }
      for (const g of cfg.expandGrowthFactors) {           // short axis
        const newRy = ry * g;
        const ep = Geometry.makeEllipsePoly(cx, cy, rx, newRy, ang);
        const ia = Geometry.intersectionArea(polyRing, ep);
        const ea = Geometry.polygonArea(ep);
        if (ea > 0 && ia >= ea * containT &&
            distMapContainmentCheck(ep, distMap, w, h) >= 0.92) {
          elem.size.ry = PyNum.round(newRy, 2);
          elem._poly = ep;
          ry = newRy;
          break;
        }
      }
    } else if (elem.type === RECTANGLE) {
      let rw = elem.size.width, rh = elem.size.height;
      for (const g of cfg.expandGrowthFactors) {           // long edge
        const newW = rw * g;
        const rp = Geometry.makeRectPoly(cx, cy, newW, rh, ang);
        const ia = Geometry.intersectionArea(polyRing, rp);
        const ra = Geometry.polygonArea(rp);
        if (ra > 0 && ia >= ra * containT &&
            distMapContainmentCheck(rp, distMap, w, h) >= 0.92) {
          elem.size.width = PyNum.round(newW, 2);
          elem._poly = rp;
          elem._tr = newW / 2;
          rw = newW;
          break;
        }
      }
      for (const g of cfg.expandGrowthFactors) {           // short edge
        const newH = rh * g;
        const rp = Geometry.makeRectPoly(cx, cy, rw, newH, ang);
        const ia = Geometry.intersectionArea(polyRing, rp);
        const ra = Geometry.polygonArea(rp);
        if (ra > 0 && ia >= ra * containT &&
            distMapContainmentCheck(rp, distMap, w, h) >= 0.92) {
          elem.size.height = PyNum.round(newH, 2);
          elem._poly = rp;
          rh = newH;
          break;
        }
      }
    }
  }
  return elements;
}

/* ─────────────── overlap suppression ─────────────── */

function elemArea(e) {
  // suppress_overlap orders by the stored shapely polygon area (NOT analytic)
  if (e._poly != null) return Geometry.polygonArea(e._poly);
  return 0;
}

function suppressOverlap(elements, w, h, coverageThresh) {
  coverageThresh = coverageThresh || 0.85;
  if (elements.length <= 1) return elements;

  const indexed = elements.map((e, i) => [i, e]);
  indexed.sort((a, b) => elemArea(b[1]) - elemArea(a[1]));

  const acceptedIdx = new Set();
  const cumulative = new Uint8Array(w * h);

  for (const [origIdx, elem] of indexed) {
    const single = renderElementToMask(elem, w, h);
    let elemPx = 0, coveredPx = 0;
    for (let i = 0; i < w * h; i++) {
      if (single[i]) {
        elemPx++;
        if (cumulative[i]) coveredPx++;
      }
    }
    if (elemPx < 1) { acceptedIdx.add(origIdx); continue; }
    if (coveredPx / elemPx >= coverageThresh) continue;
    acceptedIdx.add(origIdx);
    for (let i = 0; i < w * h; i++) if (single[i] > cumulative[i]) cumulative[i] = single[i];
  }

  return elements.filter((_, i) => acceptedIdx.has(i));
}

/* ─────────────── outline pipeline (shaper_core.process_image_outline) ── */

function processOutline(jobId, rgba, width, height, config) {
  const started = Date.now();
  const n = width * height;
  const imageCenter = (() => {
    const origin = (config && config.origin) || {};
    if (origin.type === "custom") {
      const x = origin.x === "" || origin.x == null ? width / 2 : Number(origin.x);
      const y = origin.y === "" || origin.y == null ? height / 2 : Number(origin.y);
      return [x, y];
    }
    if (origin.type === "top_left") return [0, 0];
    return [width / 2, height / 2];
  })();

  const primitiveSize = Math.max(3, Math.min(200, Number(config.primitive_size || 15)));
  const minSize = Math.max(2, Math.trunc(primitiveSize * 0.4));
  const maxSize = Math.max(minSize + 2, Math.trunc(primitiveSize * 2.0));

  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 255) { hasAlpha = true; break; }
  }

  postMessage({ type: "progress", jobId, step: 0, total: 100, phase: "mask" });

  let mask = Imaging.extractMask(rgba, width, height, hasAlpha);
  mask = Imaging.morphOpen(Imaging.morphClose(mask, width, height), width, height);

  const distMap = Imaging.distanceTransform(mask, width, height);
  const contours = Imaging.findContours(mask, width, height);

  postMessage({ type: "progress", jobId, step: 10, total: 100, phase: "contours" });

  /* primitives config → allowed types / colors / presets */
  let allowedTypes = null;
  const typeColors = {};
  const primitivePresets = {};
  let shapeList = config.primitives || [];
  if (!shapeList.length && config.allowed_shapes) {
    shapeList = config.allowed_shapes.map(s => ({ shape: s, color: "#ffffff" }));
  }
  if (shapeList.length) {
    const picked = new Set();
    for (const primitive of shapeList) {
      const shape = primitive.shape;
      const color = primitive.color;
      if (shape === "circle") {
        picked.add(ELLIPSE);
        if (color) typeColors[ELLIPSE] = color;
        primitivePresets[ELLIPSE] = primitive;
      } else if (shape === "rect") {
        picked.add(RECTANGLE);
        if (color) typeColors[RECTANGLE] = color;
        primitivePresets[RECTANGLE] = primitive;
      }
    }
    allowedTypes = picked.size ? Array.from(picked) : [];
  }

  const cfg = makeConfig(
    minSize, maxSize,
    Number(config.spacing !== undefined ? config.spacing : 0.9),
    Math.max(0, Math.min(1, Number(config.precision !== undefined ? config.precision : 0.3))),
    allowedTypes
  );

  let allElements = [];
  const imageArea = width * height;
  const minContourArea = Math.max(100, imageArea * 0.00005);

  const bigContours = contours.filter((c) => {
    const area = Imaging.contourArea(c.points);
    if (area < minContourArea) return false;
    const rect = Imaging.boundingRect(c.points);
    if (rect.w > width * 0.95 && rect.h > height * 0.95) return false;
    const margin = 5;
    if (rect.x + rect.w < margin || rect.x > width - margin ||
        rect.y + rect.h < margin || rect.y > height - margin) return false;
    return true;
  });

  bigContours.forEach((contour, ci) => {
    const npts = contour.points.length / 2;
    const ptsX = new Float64Array(npts);
    const ptsY = new Float64Array(npts);
    for (let i = 0; i < npts; i++) {
      ptsX[i] = contour.points[2 * i];
      ptsY[i] = contour.points[2 * i + 1];
    }

    // poly = Polygon(pts).simplify(1.0, preserve_topology=True); the raw
    // (possibly self-touching) ring reproduces buffer(0)'s area & intersections.
    const points = new Array(npts);
    for (let i = 0; i < npts; i++) points[i] = [ptsX[i], ptsY[i]];
    const polyRing = Geometry.simplify(points, 1.0);
    const polyArea = Geometry.polygonArea(polyRing);

    let elements = fitBeads(ci, ptsX, ptsY, distMap, width, height, polyRing, cfg, imageCenter);

    if (npts >= 3 && polyArea >= cfg.minSize * cfg.minSize) {
      const { cumArc, totalArc } = buildArcLengthIndex(ptsX, ptsY);
      elements = fillGaps(elements, ci, ptsX, ptsY, cumArc, totalArc, polyRing, distMap, width, height, cfg, imageCenter);
      elements = expandElements(elements, polyRing, cfg, distMap, width, height);
    }
    allElements = allElements.concat(elements);
    postMessage({
      type: "progress", jobId,
      step: 10 + Math.round(80 * (ci + 1) / bigContours.length), total: 100,
      phase: "beads",
    });
  });

  allElements = suppressOverlap(allElements, width, height);
  for (const element of allElements) {
    if (typeColors[element.type]) element.color = typeColors[element.type];
  }

  postMessage({ type: "progress", jobId, step: 95, total: 100, phase: "export" });

  /* export transform (unit conversion, rect pivot shift) */
  const originUnits = { x: imageCenter[0] / primitiveSize, y: -imageCenter[1] / primitiveSize };
  const exportedElements = [];
  for (const element of allElements) {
    const item = {};
    for (const key of Object.keys(element)) {
      if (!key.startsWith("_")) item[key] = JSON.parse(JSON.stringify(element[key]));
    }
    let cx = item.center.x / primitiveSize;
    let cy = -item.center.y / primitiveSize;

    if (item.size) {
      for (const key of Object.keys(item.size)) {
        item.size[key] = PyNum.round(item.size[key] / primitiveSize, 4);
      }
    }

    const rotZ = -Number(item.rotation || 0);
    if (item.type === RECTANGLE && item.size) {
      const rectH = Number(item.size.height || 0);
      const theta = rotZ * (Math.PI / 180); // math.radians: single constant multiply
      cx += (rectH * 0.5) * Math.sin(theta);
      cy += -(rectH * 0.5) * Math.cos(theta);
    }

    item.center.x = PyNum.round(cx, 4);
    item.center.y = PyNum.round(cy, 4);
    item.relative_position = {
      x: PyNum.round(cx - originUnits.x, 4),
      y: PyNum.round(cy - originUnits.y, 4),
    };
    item.rotation = { x: 0, y: 0, z: PyNum.round(rotZ, 4) };

    let preset = {};
    if (item.type === ELLIPSE) {
      item.shape = "circle";
      preset = primitivePresets[ELLIPSE] || {};
    } else if (item.type === RECTANGLE) {
      item.shape = "rect";
      preset = primitivePresets[RECTANGLE] || {};
    }

    if (Object.keys(preset).length) {
      if (preset.image_asset_ref) item.image_asset_ref = Number(preset.image_asset_ref);
      const typeId = preset.type_id;
      const elementTypeId = preset.element_type_id;
      if (typeId !== undefined && typeId !== null) item.type_id = Number(typeId);
      if (elementTypeId !== undefined && elementTypeId !== null) item.element_type_id = Number(elementTypeId);
      else if (typeId !== undefined && typeId !== null) item.element_type_id = Number(typeId);
      if (preset.rot_z !== undefined && preset.rot_z !== null) {
        item.rotation.z = PyNum.round(item.rotation.z + Number(preset.rot_z), 4);
      }
      if (preset.rot_y_add !== undefined && preset.rot_y_add !== null) {
        item.rotation.y = Number(preset.rot_y_add);
        item.rot_y_add = Number(preset.rot_y_add);
      }
      if (preset.name) item.name = String(preset.name);
    }

    exportedElements.push(item);
  }

  /* browser image: flattened on white if alpha */
  const browserImage = hasAlpha ? Imaging.flattenOnWhite(rgba, width, height) : rgba;

  const elapsed = (Date.now() - started) / 1000;
  return {
    mode: "outline",
    image_center: { x: imageCenter[0], y: imageCenter[1] },
    image_size: { width, height },
    config: {
      mode: "outline",
      primitive_size: primitiveSize,
      pixel_per_unit: primitiveSize,
      spacing: cfg.spacingRatio,
      precision: cfg.precision,
    },
    elements_count: exportedElements.length,
    elements: exportedElements,
    image_rgba: browserImage.buffer.slice(0),
    mask_gray: mask.buffer.slice(0),
    preview_rgba: null,
    elapsed_seconds: PyNum.round(elapsed, 2),
  };
}

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.cmd !== "process") return;
  try {
    const rgba = new Uint8ClampedArray(msg.rgba);
    const result = processOutline(msg.jobId, rgba, msg.width, msg.height, msg.config || {});
    const transfers = [result.image_rgba, result.mask_gray];
    postMessage({ type: "done", jobId: msg.jobId, result }, transfers);
  } catch (error) {
    postMessage({ type: "error", jobId: msg.jobId, message: String(error && error.message ? error.message : error) });
  }
};
