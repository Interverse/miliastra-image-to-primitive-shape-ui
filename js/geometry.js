/*
 * geometry.js — Shapely (GEOS) exact geometry operations used by the
 * outline-fitting algorithm (final_shaper.py). This module replaces the
 * bitmap-sampling approximations previously used in worker-outline.js so
 * the JS port makes byte-for-byte identical fitting decisions to Python.
 *
 * Polygons are represented as CLOSED rings: arrays of [x, y] pairs whose
 * last coordinate equals the first (matching shapely exterior.coords).
 *
 * Operations replicated (see tests/parity/shapely for the oracle):
 *   makeEllipsePoly  = Point(0,0).buffer(1.0, resolution=32)
 *                      -> affinity.scale(rx,ry) -> rotate(deg) -> translate
 *   pointBuffer      = Point(cx,cy).buffer(r)  (default quad_segs=16, 64 seg)
 *   makeRectPoly     = box(-w/2,-h/2,w/2,h/2) -> rotate -> translate
 *   simplify         = TopologyPreservingSimplifier (GEOS/JTS), tol=1.0
 *   polygonArea      = GEOS Area::ofRingSigned (abs) — matches poly.area even
 *                      for self-touching rings, where |shoelace| == buffer(0).area
 *   intersectionArea = Sutherland-Hodgman clip of subject ring against a
 *                      convex clip polygon; validated to reproduce
 *                      poly.intersection(convex).area (incl. buffer(0) repair)
 *   boundaryLength / interpolate = LineString.length / .interpolate
 *
 * Numerics: the unit circles below are the EXACT float64 vertices emitted by
 * shapely 2.1.x / GEOS, embedded verbatim so the base circle is bit-exact.
 * The affine step is fma-free multiply/add in the same order as
 * shapely.affinity.affine_transform. The only non-bit-exact input is the
 * rotation cos/sin (one libm call, <=1 ULP vs CPython; snapped to 0 within
 * 2.5e-16 exactly as shapely does), giving <=1e-15 abs error on ellipse
 * vertices — far below any decision threshold (verified: 0 decision flips).
 */
"use strict";

const Geometry = (() => {
  // --- exact shapely/GEOS unit circles (Point(0,0).buffer(1.0, resolution=N)) ---
  const UNIT_QS32=[[1.0,0.0],[0.9987954562051724,-0.049067674327418015],[0.9951847266721969,-0.0980171403295606],[0.989176509964781,-0.14673047445536175],[0.9807852804032304,-0.19509032201612825],[0.970031253194544,-0.24298017990326387],[0.9569403357322088,-0.29028467725446233],[0.9415440651830208,-0.33688985339222005],[0.9238795325112867,-0.3826834323650898],[0.9039892931234433,-0.4275550934302821],[0.881921264348355,-0.47139673682599764],[0.8577286100002721,-0.5141027441932217],[0.8314696123025452,-0.5555702330196022],[0.8032075314806449,-0.5956993044924334],[0.773010453362737,-0.6343932841636455],[0.7409511253549592,-0.6715589548470183],[0.7071067811865476,-0.7071067811865476],[0.6715589548470183,-0.7409511253549591],[0.6343932841636455,-0.7730104533627369],[0.5956993044924335,-0.8032075314806448],[0.5555702330196023,-0.8314696123025452],[0.5141027441932217,-0.8577286100002721],[0.4713967368259978,-0.8819212643483549],[0.4275550934302822,-0.9039892931234433],[0.38268343236508984,-0.9238795325112867],[0.33688985339222005,-0.9415440651830208],[0.29028467725446233,-0.9569403357322089],[0.24298017990326398,-0.970031253194544],[0.19509032201612833,-0.9807852804032304],[0.14673047445536175,-0.989176509964781],[0.09801714032956077,-0.9951847266721968],[0.049067674327418126,-0.9987954562051724],[0.0,-1.0],[-0.04906767432741801,-0.9987954562051724],[-0.09801714032956065,-0.9951847266721969],[-0.14673047445536164,-0.989176509964781],[-0.1950903220161282,-0.9807852804032304],[-0.24298017990326387,-0.970031253194544],[-0.29028467725446216,-0.9569403357322089],[-0.33688985339221994,-0.9415440651830208],[-0.3826834323650897,-0.9238795325112867],[-0.42755509343028186,-0.9039892931234434],[-0.4713967368259977,-0.881921264348355],[-0.5141027441932216,-0.8577286100002721],[-0.555570233019602,-0.8314696123025453],[-0.5956993044924334,-0.8032075314806449],[-0.6343932841636454,-0.7730104533627371],[-0.6715589548470184,-0.740951125354959],[-0.7071067811865475,-0.7071067811865476],[-0.7409511253549589,-0.6715589548470186],[-0.773010453362737,-0.6343932841636455],[-0.8032075314806448,-0.5956993044924335],[-0.8314696123025453,-0.5555702330196022],[-0.857728610000272,-0.5141027441932218],[-0.8819212643483549,-0.4713967368259978],[-0.9039892931234433,-0.42755509343028203],[-0.9238795325112867,-0.3826834323650899],[-0.9415440651830207,-0.33688985339222033],[-0.9569403357322088,-0.2902846772544624],[-0.970031253194544,-0.24298017990326407],[-0.9807852804032304,-0.1950903220161286],[-0.989176509964781,-0.1467304744553618],[-0.9951847266721968,-0.09801714032956083],[-0.9987954562051724,-0.049067674327417966],[-1.0,0.0],[-0.9987954562051724,0.049067674327417724],[-0.9951847266721969,0.09801714032956059],[-0.989176509964781,0.14673047445536158],[-0.9807852804032304,0.19509032201612836],[-0.970031253194544,0.24298017990326382],[-0.9569403357322089,0.2902846772544621],[-0.9415440651830208,0.3368898533922201],[-0.9238795325112868,0.38268343236508967],[-0.9039892931234434,0.4275550934302818],[-0.881921264348355,0.47139673682599764],[-0.8577286100002721,0.5141027441932216],[-0.8314696123025455,0.555570233019602],[-0.8032075314806449,0.5956993044924332],[-0.7730104533627371,0.6343932841636453],[-0.7409511253549591,0.6715589548470184],[-0.7071067811865477,0.7071067811865475],[-0.6715589548470187,0.7409511253549589],[-0.6343932841636459,0.7730104533627367],[-0.5956993044924331,0.803207531480645],[-0.5555702330196022,0.8314696123025452],[-0.5141027441932218,0.857728610000272],[-0.47139673682599786,0.8819212643483549],[-0.4275550934302825,0.9039892931234431],[-0.38268343236509034,0.9238795325112865],[-0.33688985339221994,0.9415440651830208],[-0.29028467725446244,0.9569403357322088],[-0.24298017990326412,0.970031253194544],[-0.19509032201612866,0.9807852804032303],[-0.1467304744553623,0.9891765099647809],[-0.09801714032956045,0.9951847266721969],[-0.04906767432741803,0.9987954562051724],[0.0,1.0],[0.04906767432741766,0.9987954562051724],[0.09801714032956009,0.9951847266721969],[0.14673047445536194,0.9891765099647809],[0.1950903220161283,0.9807852804032304],[0.24298017990326376,0.970031253194544],[0.29028467725446205,0.9569403357322089],[0.3368898533922196,0.9415440651830209],[0.38268343236509,0.9238795325112866],[0.42755509343028214,0.9039892931234433],[0.4713967368259976,0.881921264348355],[0.5141027441932216,0.8577286100002722],[0.5555702330196018,0.8314696123025455],[0.5956993044924328,0.8032075314806453],[0.6343932841636456,0.7730104533627369],[0.6715589548470183,0.7409511253549591],[0.7071067811865474,0.7071067811865477],[0.7409511253549589,0.6715589548470187],[0.7730104533627365,0.6343932841636459],[0.803207531480645,0.5956993044924332],[0.8314696123025452,0.5555702330196022],[0.857728610000272,0.5141027441932219],[0.8819212643483548,0.4713967368259979],[0.9039892931234431,0.42755509343028253],[0.9238795325112865,0.3826834323650904],[0.9415440651830208,0.33688985339222],[0.9569403357322088,0.2902846772544625],[0.970031253194544,0.24298017990326418],[0.9807852804032303,0.19509032201612872],[0.9891765099647809,0.1467304744553624],[0.9951847266721969,0.0980171403295605],[0.9987954562051724,0.04906767432741809],[1.0,0.0]];
  // Point(cx,cy).buffer(r) with NO resolution arg uses shapely default
  // quad_segs=16 -> 64 segments (NOT 32). This is the base-circle candidate.
  const UNIT_QS16=[[1.0,0.0],[0.9951847266721969,-0.0980171403295606],[0.9807852804032304,-0.19509032201612825],[0.9569403357322088,-0.29028467725446233],[0.9238795325112867,-0.3826834323650898],[0.881921264348355,-0.47139673682599764],[0.8314696123025452,-0.5555702330196022],[0.773010453362737,-0.6343932841636455],[0.7071067811865476,-0.7071067811865476],[0.6343932841636455,-0.7730104533627369],[0.5555702330196023,-0.8314696123025452],[0.4713967368259978,-0.8819212643483549],[0.38268343236508984,-0.9238795325112867],[0.29028467725446233,-0.9569403357322089],[0.19509032201612833,-0.9807852804032304],[0.09801714032956077,-0.9951847266721968],[0.0,-1.0],[-0.09801714032956065,-0.9951847266721969],[-0.1950903220161282,-0.9807852804032304],[-0.29028467725446216,-0.9569403357322089],[-0.3826834323650897,-0.9238795325112867],[-0.4713967368259977,-0.881921264348355],[-0.555570233019602,-0.8314696123025453],[-0.6343932841636454,-0.7730104533627371],[-0.7071067811865475,-0.7071067811865476],[-0.773010453362737,-0.6343932841636455],[-0.8314696123025453,-0.5555702330196022],[-0.8819212643483549,-0.4713967368259978],[-0.9238795325112867,-0.3826834323650899],[-0.9569403357322088,-0.2902846772544624],[-0.9807852804032304,-0.1950903220161286],[-0.9951847266721968,-0.09801714032956083],[-1.0,0.0],[-0.9951847266721969,0.09801714032956059],[-0.9807852804032304,0.19509032201612836],[-0.9569403357322089,0.2902846772544621],[-0.9238795325112868,0.38268343236508967],[-0.881921264348355,0.47139673682599764],[-0.8314696123025455,0.555570233019602],[-0.7730104533627371,0.6343932841636453],[-0.7071067811865477,0.7071067811865475],[-0.6343932841636459,0.7730104533627367],[-0.5555702330196022,0.8314696123025452],[-0.47139673682599786,0.8819212643483549],[-0.38268343236509034,0.9238795325112865],[-0.29028467725446244,0.9569403357322088],[-0.19509032201612866,0.9807852804032303],[-0.09801714032956045,0.9951847266721969],[0.0,1.0],[0.09801714032956009,0.9951847266721969],[0.1950903220161283,0.9807852804032304],[0.29028467725446205,0.9569403357322089],[0.38268343236509,0.9238795325112866],[0.4713967368259976,0.881921264348355],[0.5555702330196018,0.8314696123025455],[0.6343932841636456,0.7730104533627369],[0.7071067811865474,0.7071067811865477],[0.7730104533627365,0.6343932841636459],[0.8314696123025452,0.5555702330196022],[0.8819212643483548,0.4713967368259979],[0.9238795325112865,0.3826834323650904],[0.9569403357322088,0.2902846772544625],[0.9807852804032303,0.19509032201612872],[0.9951847266721969,0.0980171403295605],[1.0,0.0]];

  /* rotation cos/sin exactly as shapely.affinity.rotate (degrees, snap<2.5e-16) */
  function rotCosSin(angleDeg) {
    const a = angleDeg * Math.PI / 180.0;
    let c = Math.cos(a), s = Math.sin(a);
    if (Math.abs(c) < 2.5e-16) c = 0.0;
    if (Math.abs(s) < 2.5e-16) s = 0.0;
    return [c, s];
  }

  /* Point(0,0).buffer(1,resolution=32) -> scale(rx,ry,origin=center=(0,0))
   * -> rotate(angleDeg, origin=(0,0)) -> translate(cx,cy).
   * numpy affine order: xp = a*x + b*y + xoff (the +0*y/+0 terms are identity). */
  function makeEllipsePoly(cx, cy, rx, ry, angleDeg) {
    const [cosp, sinp] = rotCosSin(angleDeg);
    const N = UNIT_QS32.length;
    const ring = new Array(N);
    for (let i = 0; i < N; i++) {
      const ux = UNIT_QS32[i][0], uy = UNIT_QS32[i][1];
      const sx = rx * ux, sy = ry * uy;                 // scale
      const xp = cosp * sx - sinp * sy;                 // rotate
      const yp = sinp * sx + cosp * sy;
      ring[i] = [xp + cx, yp + cy];                     // translate
    }
    return ring;
  }

  /* Point(cx,cy).buffer(r) with default resolution (quad_segs=8, 32 seg).
   * GEOS emits exactly cx + r*ux, cy + r*uy (verified bit-exact). */
  function pointBuffer(cx, cy, r) {
    const N = UNIT_QS16.length;
    const ring = new Array(N);
    for (let i = 0; i < N; i++) {
      ring[i] = [cx + r * UNIT_QS16[i][0], cy + r * UNIT_QS16[i][1]];
    }
    return ring;
  }

  /* box(-w/2,-h/2,w/2,h/2) -> rotate -> translate.
   * shapely box vertex order: (maxx,miny),(maxx,maxy),(minx,maxy),(minx,miny),close. */
  function makeRectPoly(cx, cy, w, h, angleDeg) {
    const hw = w / 2, hh = h / 2;
    const corners = [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
    const [cosp, sinp] = rotCosSin(angleDeg);
    const ring = new Array(5);
    for (let i = 0; i < 4; i++) {
      const x = corners[i][0], y = corners[i][1];
      ring[i] = [cosp * x - sinp * y + cx, sinp * x + cosp * y + cy];
    }
    ring[4] = [ring[0][0], ring[0][1]];
    return ring;
  }

  /* GEOS Area::ofRingSigned (translates x by x0 for stability). ring is closed. */
  function ringSignedArea(ring) {
    const n = ring.length;
    if (n < 3) return 0.0;
    let sum = 0.0;
    const x0 = ring[0][0];
    for (let i = 1; i < n - 1; i++) {
      const x = ring[i][0] - x0;
      const y1 = ring[i + 1][1];
      const y2 = ring[i - 1][1];
      sum += x * (y2 - y1);
    }
    return sum / 2.0;
  }

  function polygonArea(ring) { return Math.abs(ringSignedArea(ring)); }

  /* signed shoelace over an OPEN vertex list (wraps last->first) */
  function signedAreaOpen(poly) {
    const n = poly.length;
    let s = 0.0;
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2.0;
  }

  /* GEOS Coordinate::distance = sqrt(dx*dx+dy*dy) (NOT hypot — matches GEOS
   * bit-exactly; IEEE sqrt is correctly-rounded so this is platform-stable). */
  function dist2(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* LineString.length of a closed ring (perimeter) */
  function boundaryLength(ring) {
    let L = 0.0;
    for (let i = 0; i < ring.length - 1; i++) {
      L += dist2(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    }
    return L;
  }

  /* LineString.interpolate(dist): walk segments from ring[0]; clamp at ends. */
  function interpolate(ring, dist) {
    const last = ring.length - 1;
    if (dist <= 0) return [ring[0][0], ring[0][1]];
    let acc = 0.0;
    for (let i = 0; i < last; i++) {
      const x0 = ring[i][0], y0 = ring[i][1];
      const x1 = ring[i + 1][0], y1 = ring[i + 1][1];
      const seg = dist2(x0, y0, x1, y1);
      if (seg > 0 && acc + seg > dist) {
        const frac = (dist - acc) / seg;
        return [x0 + frac * (x1 - x0), y0 + frac * (y1 - y0)];
      }
      acc += seg;
    }
    return [ring[last][0], ring[last][1]];
  }

  /* ── Sutherland-Hodgman intersection area ─────────────────────────────
   * subjectRing: closed ring (may be non-convex or self-touching; the raw
   *   simplified contour). clipConvex: closed convex ring (ellipse/rect/circle).
   * Returns area of (subject ∩ clip). Clipping the raw self-touching ring and
   * taking |signed shoelace| reproduces buffer(0).intersection(convex).area
   * (validated to <3e-10 on the corpus). */
  /* Persistent flat scratch buffers for intersectionArea (each worker runs
   * single-threaded and the function does not recurse). Storage-only
   * optimization: every float operation happens in the same order as the
   * original array-of-arrays version, so results are bit-identical while
   * the per-pass array allocations (and their GC pressure) disappear. */
  let _iaX0 = new Float64Array(0), _iaY0 = new Float64Array(0);
  let _iaX1 = new Float64Array(0), _iaY1 = new Float64Array(0);
  function _iaPow2(n) { let c = 256; while (c < n) c *= 2; return c; }

  function intersectionArea(subjectRing, clipConvex) {
    // strip closing duplicates (index-based; same open lists as before)
    let sN = subjectRing.length;
    if (sN > 1 && subjectRing[0][0] === subjectRing[sN - 1][0] &&
        subjectRing[0][1] === subjectRing[sN - 1][1]) sN--;
    let cN = clipConvex.length;
    if (cN > 1 && clipConvex[0][0] === clipConvex[cN - 1][0] &&
        clipConvex[0][1] === clipConvex[cN - 1][1]) cN--;
    if (sN < 3 || cN < 3) return 0.0;

    // orientation: signedAreaOpen over the open clip list. Buffer rings are
    // CW; instead of materializing clip.slice().reverse(), the edge loop
    // below walks the same reversed (a, b) sequence by index.
    let cs = 0.0;
    for (let i = 0; i < cN; i++) {
      const p = clipConvex[i], q = clipConvex[i + 1 === cN ? 0 : i + 1];
      cs += p[0] * q[1] - q[0] * p[1];
    }
    const rev = cs / 2.0 < 0;

    if (_iaX0.length < sN) {
      const c = _iaPow2(sN);
      _iaX0 = new Float64Array(c); _iaY0 = new Float64Array(c);
    }
    let inpX = _iaX0, inpY = _iaY0, outX = _iaX1, outY = _iaY1;
    let outIsSlot1 = true;
    for (let i = 0; i < sN; i++) { inpX[i] = subjectRing[i][0]; inpY[i] = subjectRing[i][1]; }
    let n = sN;

    for (let e = 0; e < cN; e++) {
      if (n === 0) break;
      let aI, bI;
      if (rev) { aI = cN - 1 - e; bI = e + 1 === cN ? cN - 1 : cN - 2 - e; }
      else { aI = e; bI = e + 1 === cN ? 0 : e + 1; }
      const A = clipConvex[aI], B = clipConvex[bI];
      const ax = A[0], ay = A[1], bx = B[0], by = B[1];
      const edx = bx - ax, edy = by - ay;
      const need = 2 * n + 2; // ≤2 pushes per input vertex
      if (outX.length < need) {
        const c = _iaPow2(need);
        outX = new Float64Array(c); outY = new Float64Array(c);
        if (outIsSlot1) { _iaX1 = outX; _iaY1 = outY; }
        else { _iaX0 = outX; _iaY0 = outY; }
      }
      let Sx = inpX[n - 1], Sy = inpY[n - 1];
      let Sin = edx * (Sy - ay) - edy * (Sx - ax) >= 0;
      let outN = 0;
      for (let k = 0; k < n; k++) {
        const Ex = inpX[k], Ey = inpY[k];
        const Ein = edx * (Ey - ay) - edy * (Ex - ax) >= 0;
        if (Ein) {
          if (!Sin) { // segInter(S, E, A, B), inlined verbatim
            const den = (Sx - Ex) * (ay - by) - (Sy - Ey) * (ax - bx);
            const t = ((Sx - ax) * (ay - by) - (Sy - ay) * (ax - bx)) / den;
            outX[outN] = Sx + t * (Ex - Sx); outY[outN] = Sy + t * (Ey - Sy); outN++;
          }
          outX[outN] = Ex; outY[outN] = Ey; outN++;
        } else if (Sin) {
          const den = (Sx - Ex) * (ay - by) - (Sy - Ey) * (ax - bx);
          const t = ((Sx - ax) * (ay - by) - (Sy - ay) * (ax - bx)) / den;
          outX[outN] = Sx + t * (Ex - Sx); outY[outN] = Sy + t * (Ey - Sy); outN++;
        }
        Sx = Ex; Sy = Ey; Sin = Ein;
      }
      const tX = inpX, tY = inpY;
      inpX = outX; inpY = outY;
      outX = tX; outY = tY;
      outIsSlot1 = !outIsSlot1;
      n = outN;
    }
    if (n < 3) return 0.0;
    // signedAreaOpen over the surviving ring (same accumulation order)
    let s = 0.0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      s += inpX[i] * inpY[j] - inpX[j] * inpY[i];
    }
    return Math.abs(s / 2.0);
  }

  /* ── GEOS TopologyPreservingSimplifier (JTS TaggedLineStringSimplifier) ──
   * points: OPEN contour (array of [x,y]); closed internally. tol default 1.0.
   * Reproduces shapely Polygon(pts).simplify(tol, preserve_topology=True).
   * Coords are pixel integers so orientation predicates are exact in float64. */
  function simplify(points, tol) {
    if (tol === undefined) tol = 1.0;
    const minsize = 4;
    // build closed ring
    const pts = points.slice();
    const first = points[0], lastPt = points[points.length - 1];
    if (!(first[0] === lastPt[0] && first[1] === lastPt[1])) pts.push([first[0], first[1]]);
    const n = pts.length;
    const isRing = pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1];

    let inputSegs = [];
    for (let i = 0; i < n - 1; i++) inputSegs.push([i, i + 1]);
    const outputSegs = [];       // flattened segments as [a,b] index pairs
    const resultSegs = [];       // ordered kept segments
    let resultSize = 0;

    function ptSegDist(px, py, ax, ay, bx, by) {
      if (ax === bx && ay === by) return dist2(px, py, ax, ay);
      const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
      const r = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2;
      if (r <= 0) return dist2(px, py, ax, ay);
      if (r >= 1) return dist2(px, py, bx, by);
      const s = ((ay - py) * (bx - ax) - (ax - px) * (by - ay)) / len2;
      return Math.abs(s) * Math.sqrt(len2);
    }
    function orient(ax, ay, bx, by, cx, cy) {
      const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      return v > 0 ? 1 : (v < 0 ? -1 : 0);
    }
    function segIntersect(p1, p2, p3, p4) {
      const o1 = orient(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
      const o2 = orient(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
      const o3 = orient(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
      const o4 = orient(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
      if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4) return true;
      if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
        const useX = Math.abs(p2[0] - p1[0]) >= Math.abs(p2[1] - p1[1]);
        const k1 = useX ? p1[0] : p1[1], k2 = useX ? p2[0] : p2[1];
        const k3 = useX ? p3[0] : p3[1], k4 = useX ? p4[0] : p4[1];
        const a1 = Math.min(k1, k2), a2 = Math.max(k1, k2);
        const b1 = Math.min(k3, k4), b2 = Math.max(k3, k4);
        if (Math.min(a2, b2) > Math.max(a1, b1)) return true;
      }
      return false;
    }
    function hasBad(i, j, c0, c1) {
      for (let o = 0; o < outputSegs.length; o++) {
        if (segIntersect(c0, c1, pts[outputSegs[o][0]], pts[outputSegs[o][1]])) return true;
      }
      for (let s = 0; s < inputSegs.length; s++) {
        const a = inputSegs[s][0], b = inputSegs[s][1];
        if (i <= a && b <= j) continue;
        if (segIntersect(c0, c1, pts[a], pts[b])) return true;
      }
      return false;
    }
    function findFurthest(i, j) {
      const ax = pts[i][0], ay = pts[i][1], bx = pts[j][0], by = pts[j][1];
      let maxd = -1.0, mi = i;
      for (let k = i + 1; k < j; k++) {
        const d = ptSegDist(pts[k][0], pts[k][1], ax, ay, bx, by);
        if (d > maxd) { maxd = d; mi = k; }
      }
      return [mi, maxd];
    }
    function flatten(i, j) {
      inputSegs = inputSegs.filter(([a, b]) => !(i <= a && b <= j));
      outputSegs.push([i, j]);
    }
    function simplifySection(i, j, depth) {
      depth += 1;
      if (i + 1 === j) { resultSegs.push([i, j]); resultSize += 1; return; }
      let valid = true;
      if (resultSize < minsize && depth + 1 < minsize) valid = false;
      const [mi, dist] = findFurthest(i, j);
      if (dist > tol) valid = false;
      if (valid && hasBad(i, j, pts[i], pts[j])) valid = false;
      if (valid) { flatten(i, j); resultSegs.push([i, j]); resultSize += 1; return; }
      simplifySection(i, mi, depth);
      simplifySection(mi, j, depth);
    }
    function hasBadEndpoint(c0, c1, aL, b0) {
      for (let o = 0; o < outputSegs.length; o++) {
        const a = outputSegs[o][0], b = outputSegs[o][1];
        if (a >= aL || b <= b0) continue;
        if (segIntersect(c0, c1, pts[a], pts[b])) return true;
      }
      for (let s = 0; s < inputSegs.length; s++) {
        const a = inputSegs[s][0];
        if (a < b0 || a >= aL) continue;
        if (segIntersect(c0, c1, pts[a], pts[inputSegs[s][1]])) return true;
      }
      return false;
    }
    function simplifyRingEndpoint() {
      if (resultSize <= minsize) return;
      const a0 = resultSegs[0][0], b0 = resultSegs[0][1];
      const aL = resultSegs[resultSegs.length - 1][0];
      const endPt = pts[a0];
      const s0 = pts[aL], s1 = pts[b0];
      const d = ptSegDist(endPt[0], endPt[1], s0[0], s0[1], s1[0], s1[1]);
      if (d > tol) return;
      if (hasBadEndpoint(s0, s1, aL, b0)) return;
      resultSegs.splice(0, 1, [aL, b0]);       // replace first
      resultSegs.splice(resultSegs.length - 1, 1); // drop last
      resultSize -= 1;
    }

    simplifySection(0, n - 1, 0);
    if (isRing) simplifyRingEndpoint();

    const coords = [[pts[resultSegs[0][0]][0], pts[resultSegs[0][0]][1]]];
    for (let s = 0; s < resultSegs.length; s++) {
      const b = resultSegs[s][1];
      coords.push([pts[b][0], pts[b][1]]);
    }
    return coords;
  }

  return {
    UNIT_QS32, UNIT_QS16,
    rotCosSin,
    makeEllipsePoly, pointBuffer, makeRectPoly,
    ringSignedArea, polygonArea, signedAreaOpen,
    boundaryLength, interpolate,
    intersectionArea, simplify,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Geometry;
if (typeof self !== "undefined") self.Geometry = Geometry;
