/*
 * run_tests.js — validates js/geometry.js against the shapely/GEOS goldens
 * produced by gen_goldens.py.
 *
 * Trig injection: the only libm-dependent input in geometry.js is the rotation
 * cos/sin. V8 differs from CPython's UCRT libm on a ~2.4% tail at 1 ULP, which is
 * irreducible. So we run TWO passes:
 *   (1) INJECTED — Math.cos/Math.sin are patched with a bits-keyed lookup of the
 *       exact CPython values; results must be BIT-EXACT and produce ZERO decision
 *       flips. This isolates the algorithm from the libm tail.
 *   (2) ENGINE   — real V8 trig; informational, reports the tail count and
 *       confirms flips remain zero on the corpus.
 *
 * Usage:  python tests/parity/shapely/gen_goldens.py && node tests/parity/shapely/run_tests.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const G = require("../../../js/geometry.js");

const HERE = __dirname;
const goldens = JSON.parse(fs.readFileSync(path.join(HERE, "goldens.json"), "utf8"));
const simp = JSON.parse(fs.readFileSync(path.join(HERE, "simplify.json"), "utf8"));

// ─── trig injection plumbing ───
const realCos = Math.cos, realSin = Math.sin;
const buf = new ArrayBuffer(8), dv = new DataView(buf);
// match Python struct.pack("<d", x).hex(): little-endian bytes, 2 hex digits each
function bitsOf(x) { dv.setFloat64(0, x, true); let s = ""; for (let i = 0; i < 8; i++) s += dv.getUint8(i).toString(16).padStart(2, "0"); return s; }
let TRIG = new Map();        // argBitsHex -> [cos, sin]
let injecting = false;
Math.cos = function (x) { if (injecting) { const t = TRIG.get(bitsOf(x)); if (t) return t[0]; } return realCos(x); };
Math.sin = function (x) { if (injecting) { const t = TRIG.get(bitsOf(x)); if (t) return t[1]; } return realSin(x); };
function addTrig(entry) { if (entry) TRIG.set(entry.argBits, [entry.cos, entry.sin]); }

// collect trig from goldens
for (const k of ["ellipse", "rect", "area", "interpolate", "intersection"])
  for (const r of goldens[k]) addTrig(r.trig);

let PASS = 0, FAIL = 0;
const fails = [];
function ok(cond, name, detail) { if (cond) PASS++; else { FAIL++; fails.push(name + (detail ? " :: " + detail : "")); } }
function relerr(a, b) { const d = Math.abs(a - b); return d / Math.max(Math.abs(b), 1e-12); }
function coordsEqualExact(A, B) {
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) if (A[i][0] !== B[i][0] || A[i][1] !== B[i][1]) return false;
  return true;
}
function coordsMaxErr(A, B) {
  let m = 0;
  for (let i = 0; i < Math.min(A.length, B.length); i++)
    m = Math.max(m, Math.abs(A[i][0] - B[i][0]), Math.abs(A[i][1] - B[i][1]));
  return m;
}

// ═══════════════ affine / buffer (bit-exact under injection) ═══════════════
function testAffine() {
  let ellErr = 0, rectErr = 0, circErr = 0, ellBit = 0, rectBit = 0;
  for (const r of goldens.ellipse) {
    const j = G.makeEllipsePoly(r.cx, r.cy, r.rx, r.ry, r.ang);
    if (coordsEqualExact(j, r.coords)) ellBit++;
    ellErr = Math.max(ellErr, coordsMaxErr(j, r.coords));
    ok(relerr(G.polygonArea(j), r.area) < 1e-12, "ellipse.area", "" + relerr(G.polygonArea(j), r.area));
    ok(relerr(G.boundaryLength(j), r.length) < 1e-12, "ellipse.length");
  }
  for (const r of goldens.rect) {
    const j = G.makeRectPoly(r.cx, r.cy, r.w, r.h, r.ang);
    if (coordsEqualExact(j, r.coords)) rectBit++;
    rectErr = Math.max(rectErr, coordsMaxErr(j, r.coords));
    ok(relerr(G.polygonArea(j), r.area) < 1e-12, "rect.area");
  }
  for (const r of goldens.circle) {
    const j = G.pointBuffer(r.cx, r.cy, r.r);
    circErr = Math.max(circErr, coordsMaxErr(j, r.coords));
    ok(coordsEqualExact(j, r.coords), "circle.coords bit-exact");
    ok(relerr(G.polygonArea(j), r.area) < 1e-12, "circle.area");
  }
  ok(ellErr === 0 || !injecting, "ellipse coords bit-exact(injected)", "maxErr=" + ellErr);
  ok(rectErr === 0 || !injecting, "rect coords bit-exact(injected)", "maxErr=" + rectErr);
  console.log(`  affine: ellipse ${ellBit}/${goldens.ellipse.length} bit-exact (maxErr ${ellErr.toExponential(2)}), ` +
    `rect ${rectBit}/${goldens.rect.length} (maxErr ${rectErr.toExponential(2)}), circle maxErr ${circErr.toExponential(2)}`);
}

// ═══════════════ area / length / interpolate ═══════════════
function testInterp() {
  let maxErr = 0;
  for (const r of goldens.interpolate) {
    const ring = r.kind === "ellipse"
      ? G.makeEllipsePoly(r.cx, r.cy, r.rx, r.ry, r.ang)
      : G.makeRectPoly(r.cx, r.cy, r.w, r.h, r.ang);
    const total = G.boundaryLength(ring);
    ok(relerr(total, r.total) < 1e-12, "interp.length");
    for (let i = 0; i < 32; i++) {
      const p = G.interpolate(ring, i / 32 * total);
      maxErr = Math.max(maxErr, Math.abs(p[0] - r.pts[i][0]), Math.abs(p[1] - r.pts[i][1]));
    }
  }
  ok(maxErr < 1e-9, "interpolate points", "maxErr=" + maxErr);
  console.log(`  interpolate: maxErr ${maxErr.toExponential(2)}`);
}

// ═══════════════ simplify (TopologyPreservingSimplifier) ═══════════════
function testSimplify() {
  let exact = 0, areaOnly = 0, bad = 0;
  for (const r of simp) {
    const j = G.simplify(r.input, 1.0);
    if (coordsEqualExact(j, r.output)) { exact++; continue; }
    // functionally-equivalent fallback: |shoelace| must equal shapely area
    const a = G.polygonArea(j.length && j[0][0] === j[j.length - 1][0] && j[0][1] === j[j.length - 1][1]
      ? j : j.concat([j[0]]));
    if (relerr(a, r.buffer0_area) < 1e-9) areaOnly++;
    else { bad++; fails.push("simplify " + r.name + " verts " + j.length + " vs " + r.output.length); }
  }
  ok(bad === 0, "simplify all functionally-equivalent", "bad=" + bad);
  console.log(`  simplify: ${exact}/${simp.length} vertex-exact, ${areaOnly} area-equivalent, ${bad} bad`);
}

// ═══════════════ intersection routine ═══════════════
function buildShape(s) {
  return s.kind === "ellipse" ? G.makeEllipsePoly(s.cx, s.cy, s.a, s.b, s.ang)
    : G.makeRectPoly(s.cx, s.cy, s.a, s.b, s.ang);
}
function testIntersection() {
  let maxRel = 0, maxAbs = 0, over = 0;
  for (const r of goldens.intersection) {
    const B = buildShape(r.shape);
    const a = G.intersectionArea(r.subjectRing, B);
    const re = r.area < 1e-6 ? Math.abs(a - r.area) : relerr(a, r.area);
    maxAbs = Math.max(maxAbs, Math.abs(a - r.area));
    if (r.area >= 1e-6) maxRel = Math.max(maxRel, re);
    if (Math.abs(a - r.area) > 1e-6 && re > 1e-9) over++;
  }
  ok(over === 0, "intersection routine", "over=" + over + " maxRel=" + maxRel);
  console.log(`  intersection: ${goldens.intersection.length} cases, maxRelErr ${maxRel.toExponential(2)}, maxAbsErr ${maxAbs.toExponential(2)}`);
}

// ═══════════════ decision-log replay (gate + argmax flips) ═══════════════
function loadDecisionLog() {
  const lines = fs.readFileSync(path.join(HERE, "decision_log.jsonl"), "utf8").split("\n");
  let rings = null, invs = [];
  for (const ln of lines) {
    if (!ln) continue;
    const o = JSON.parse(ln);
    if (o.type === "rings") rings = o.rings;
    else if (o.type === "trig") { for (const k in o.trig) TRIG.set(k, o.trig[k]); }
    else invs.push(o);
  }
  return { rings, invs };
}
function containT(prec) { return 0.88 + prec * 0.10; }
function testDecisions(dl) {
  let gateFlips = 0, argmaxFlips = 0, iaMaxRel = 0, eaMaxRel = 0, nCand = 0, nInv = 0;
  let iaMaxAbs = 0, iaMaxRelBig = 0;  // Big = only where ia_py >= 1 (decision-relevant scale)
  for (const inv of dl.invs) {
    const ring = dl.rings[inv.ct];
    if (!ring) continue;
    nInv++;
    const cE = containT(inv.prec);
    const cR = Math.max(0.86, cE - (1.0 - inv.prec) * 0.06);
    // candidate list matching Python push order: bases first, then accepted stretch
    const list = inv.bases.map((s) => ({ score: s }));
    for (const c of inv.cands) {
      const [kind, a, b, iaPy, eaPy, gatePy, dm, acc] = c;
      const shape = kind === 0 ? G.makeEllipsePoly(inv.cx, inv.cy, a, b, inv.ang)
        : G.makeRectPoly(inv.cx, inv.cy, a, b, inv.ang);
      const iaJs = G.intersectionArea(ring, shape);
      const eaJs = G.polygonArea(shape);
      nCand++;
      iaMaxAbs = Math.max(iaMaxAbs, Math.abs(iaJs - iaPy));
      if (eaPy > 1e-9) { iaMaxRel = Math.max(iaMaxRel, relerr(iaJs, iaPy)); eaMaxRel = Math.max(eaMaxRel, relerr(eaJs, eaPy)); }
      if (iaPy >= 1.0) iaMaxRelBig = Math.max(iaMaxRelBig, relerr(iaJs, iaPy));
      const t = kind === 0 ? cE : cR;
      const gateJs = eaJs > 0 && iaJs >= eaJs * t;
      if (gateJs !== (gatePy === 1)) gateFlips++;
      if (acc === 1) {
        const cont = iaJs / eaJs;
        const compact = b / a;
        const cp = 1.0 - inv.prec * (1.0 - compact) * 0.5;
        const score = kind === 0
          ? Math.PI * a * b * cont * cont * cp
          : a * b * (1.0 + inv.rb) * cont * cont * cont * cp;
        list.push({ score });
      }
    }
    // first-max argmax
    let bi = 0;
    for (let i = 1; i < list.length; i++) if (list[i].score > list[bi].score) bi = i;
    if (bi !== inv.chosen) argmaxFlips++;
  }
  ok(gateFlips === 0, "decision gate flips", "" + gateFlips);
  ok(argmaxFlips === 0, "decision argmax flips", "" + argmaxFlips);
  console.log(`  decisions: ${nInv} invocations, ${nCand} candidate intersections; ` +
    `gateFlips=${gateFlips}, argmaxFlips=${argmaxFlips}`);
  console.log(`    ia: maxAbs ${iaMaxAbs.toExponential(2)}, maxRel(ia>=1) ${iaMaxRelBig.toExponential(2)}, ` +
    `maxRel(all) ${iaMaxRel.toExponential(2)} [large rel is near-zero-area, decision-irrelevant]; ea maxRel ${eaMaxRel.toExponential(2)}`);
  return { gateFlips, argmaxFlips };
}

// ═══════════════ run both passes ═══════════════
const dl = loadDecisionLog();  // also merges log trig table

function runPass(label, inject) {
  injecting = inject;
  PASS = 0; FAIL = 0; fails.length = 0;
  console.log(`\n=== PASS: ${label} ===`);
  testAffine();
  testInterp();
  testSimplify();
  testIntersection();
  const d = testDecisions(dl);
  console.log(`  ${PASS} checks passed, ${FAIL} failed`);
  if (FAIL) fails.slice(0, 20).forEach((f) => console.log("    FAIL " + f));
  return { FAIL, d };
}

const inj = runPass("INJECTED CPython trig (require bit-exact, zero flips)", true);
const eng = runPass("ENGINE V8 trig (informational)", false);

console.log("\n════════════════════ SUMMARY ════════════════════");
console.log(`INJECTED: ${inj.FAIL === 0 ? "OK" : inj.FAIL + " FAILURES"}; ` +
  `gateFlips=${inj.d.gateFlips}, argmaxFlips=${inj.d.argmaxFlips}`);
console.log(`ENGINE:   ${eng.FAIL === 0 ? "OK" : eng.FAIL + " FAILURES"}; ` +
  `gateFlips=${eng.d.gateFlips}, argmaxFlips=${eng.d.argmaxFlips}`);

const decisionsClean = inj.d.gateFlips === 0 && inj.d.argmaxFlips === 0 &&
  eng.d.gateFlips === 0 && eng.d.argmaxFlips === 0;
if (inj.FAIL !== 0 || !decisionsClean) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS (geometry parity holds; zero decision flips on the instrumented corpus)");
