/*
 * run_tests.js — byte-exact parity tests: js/imaging.js vs OpenCV/NumPy.
 *
 *   python tests/parity/cv2/gen_goldens.py   # regenerate goldens (needs cv2)
 *   node   tests/parity/cv2/run_tests.js      # compare JS against goldens
 *
 * Every check must be byte-identical. Exit code is non-zero on any failure.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const Imaging = require(path.resolve(__dirname, "../../../js/imaging.js"));
const GOLD = path.join(__dirname, "goldens");

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(GOLD, name + ".json"), "utf8"));
}
function decode(o) {
  const buf = Buffer.from(o.b64, "base64");
  switch (o.dtype) {
    case "uint8": return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    case "int32": return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    case "int64": {
      const n = buf.byteLength / 8, out = new Float64Array(n);
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i < n; i++) out[i] = Number(dv.getBigInt64(i * 8, true));
      return out;
    }
    case "float32": return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    case "float64": return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    default: throw new Error("dtype " + o.dtype);
  }
}
function unpackBits(o, n) {
  const bytes = Buffer.from(o.b64, "base64");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0;
  return out;
}

let PASS = 0, FAIL = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) { PASS++; } else { FAIL++; }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function eqArr(a, b) {
  if (a.length !== b.length) return `len ${a.length}!=${b.length}`;
  let n = 0, first = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
  return n === 0 ? null : `${n} diffs, first@${first} js=${a[first]} gold=${b[first]}`;
}

/* 1. distanceTransform (float32 chamfer, must equal cv2 exactly) */
function testDT() {
  const g = load("distance_transform");
  let maxAbs = 0, bad = 0, worst = "";
  for (const c of g.cases) {
    const mask = decode(c.mask), gold = decode(c.out);
    const out = Imaging.chamferDistanceTransform(mask, c.w, c.h);
    for (let i = 0; i < gold.length; i++) {
      const d = Math.abs(out[i] - gold[i]);
      if (d > maxAbs) { maxAbs = d; worst = `${c.w}x${c.h}@${i}`; }
      if (out[i] !== gold[i]) bad++;
    }
  }
  check("distanceTransform (DIST_L2,5) byte-exact", bad === 0, `bad=${bad} maxAbs=${maxAbs} ${worst}`);
}

/* 5. BGR2GRAY */
function testGray() {
  const g = load("bgr2gray");
  const bgr = decode(g.bgr), gray = decode(g.gray);
  let bad = 0, first = -1;
  for (let i = 0; i < gray.length; i++) {
    const B = bgr[i * 3], G = bgr[i * 3 + 1], R = bgr[i * 3 + 2];
    const v = Imaging.bgr2grayFixed(R, G, B);
    if (v !== gray[i]) { bad++; if (first < 0) first = i; }
  }
  check("bgr2grayFixed byte-exact", bad === 0, `bad=${bad}/${gray.length}`);
}

/* 6. extract_mask */
function testExtract() {
  const g = load("extract_mask");
  let bad = 0, worst = "";
  for (const c of g.cases) {
    const rgba = decode(c.rgba), gold = decode(c.mask);
    const out = Imaging.extractMask(rgba, c.w, c.h, c.hasAlpha);
    const e = eqArr(out, gold);
    if (e) { bad++; worst = `${c.w}x${c.h} alpha=${c.hasAlpha} ${e}`; }
  }
  check("extractMask (all strategies) byte-exact", bad === 0, `${bad}/${g.cases.length} bad; ${worst}`);
}

/* 8. rint / compress / flatten */
function testNumpy() {
  const g = load("numpy_semantics");
  const xs = decode(g.rint_x), rr = decode(g.rint_out);
  let bad = 0;
  for (let i = 0; i < xs.length; i++) if (Imaging.rintHalfEven(xs[i]) !== rr[i]) bad++;
  check("rintHalfEven byte-exact", bad === 0, `${bad}/${xs.length}`);

  let cbad = 0, cdet = "";
  for (const key of Object.keys(g.compress)) {
    const [fl, gm] = key.split("_").map(Number);
    const gold = decode(g.compress[key]);
    const lut = Imaging.compressAlphaLUT(fl, gm);
    const e = eqArr(lut, gold);
    if (e) { cbad++; cdet = `floor=${fl} gamma=${gm}: ${e}`; }
  }
  check("compressAlphaLUT (float32) byte-exact", cbad === 0, cdet);

  let f64bad = 0, f32bad = 0, d64 = "", d32 = "";
  for (const im of g.flatten) {
    const rgba = decode(im.rgba);
    const o64 = Imaging.flattenOnWhite(rgba, im.w, im.h);
    const o32 = Imaging.flattenOnWhiteF32(rgba, im.w, im.h);
    const g64 = decode(im.f64), g32 = decode(im.f32);
    // gold f64/f32 are HxWx3 (no alpha); compare RGB channels only
    for (let i = 0; i < im.w * im.h; i++) {
      for (let c = 0; c < 3; c++) {
        if (o64[i * 4 + c] !== g64[i * 3 + c]) { f64bad++; if (!d64) d64 = `@${i},${c} js=${o64[i*4+c]} gold=${g64[i*3+c]}`; }
        if (o32[i * 4 + c] !== g32[i * 3 + c]) { f32bad++; if (!d32) d32 = `@${i},${c} js=${o32[i*4+c]} gold=${g32[i*3+c]}`; }
      }
    }
  }
  check("flattenOnWhite (float64) byte-exact", f64bad === 0, `${f64bad} ${d64}`);
  check("flattenOnWhiteF32 (float32) byte-exact", f32bad === 0, `${f32bad} ${d32}`);
}

/* 4. morphology */
function testMorph() {
  const g = load("morphology");
  let db = 0, cb = 0, dd = "", cd = "";
  for (const c of g.cases) {
    const m = decode(c.mask);
    const dil = Imaging.dilateSquare(m, c.w, c.h, 1);
    const e1 = eqArr(dil, decode(c.dilate1));
    if (e1) { db++; dd = `${c.w}x${c.h} ${e1}`; }
    const co = Imaging.morphOpen(Imaging.morphClose(m, c.w, c.h), c.w, c.h);
    const e2 = eqArr(co, decode(c.closeOpen));
    if (e2) { cb++; cd = `${c.w}x${c.h} ${e2}`; }
  }
  check("dilateSquare(3x3,iter=1) byte-exact", db === 0, `${db} ${dd}`);
  check("morphClose+morphOpen (cross SE) byte-exact", cb === 0, `${cb} ${cd}`);
}

/* 9. findContours order */
function testContours() {
  const g = load("find_contours");
  let bad = 0, det = "";
  for (const c of g.cases) {
    const m = decode(c.mask);
    const js = Imaging.findContours(m, c.w, c.h);
    const gold = c.contours.map(o => decode(o)); // each int32 flat [x0,y0,...]
    if (js.length !== gold.length) { bad++; det = `${c.w}x${c.h} count ${js.length}!=${gold.length}`; continue; }
    for (let i = 0; i < gold.length; i++) {
      const e = eqArr(Int32Array.from(js[i].points), gold[i]);
      if (e) { bad++; det = `${c.w}x${c.h} contour#${i} ${e}`; break; }
    }
  }
  check("findContours order+points (RETR_TREE) byte-exact", bad === 0, `${bad} ${det}`);
}

/* 2/3. ellipse & box fills */
function testDraw() {
  for (const [name, label, fn] of [
    ["draw_ellipse", "cvEllipseFill (cv2.ellipse -1)", (m, c) => Imaging.cvEllipseFill(m, c.w, c.h, c.cx, c.cy, c.ax, c.ay, c.ang)],
    ["draw_box", "cvBoxFill (boxPoints+drawContours -1)", (m, c) => Imaging.cvBoxFill(m, c.w, c.h, c.cx, c.cy, c.rw, c.rh, c.ang)],
  ]) {
    let g;
    try { g = load(name); } catch { check(label, false, "golden missing"); continue; }
    let bad = 0, det = "", err = "";
    for (const c of g.cases) {
      const m = new Uint8Array(c.w * c.h);
      try { fn(m, c); } catch (e) { err = e.message; break; }
      const gold = unpackBits(c.mask, c.w * c.h);
      let diff = 0, first = -1;
      for (let i = 0; i < m.length; i++) if ((m[i] ? 1 : 0) !== (gold[i] ? 1 : 0)) { diff++; if (first < 0) first = i; }
      if (diff) { bad++; if (!det) det = `${c.w}x${c.h} cx=${c.cx} cy=${c.cy} ang=${c.ang.toFixed(2)} ${diff}px first@${first}`; }
    }
    check(label + " byte-exact", bad === 0 && !err, err ? "ERR " + err : `${bad}/${g.cases.length} masks differ; ${det}`);
  }
}

/* 7. resize */
function testResize() {
  let g;
  try { g = load("resize"); } catch { check("cvResizeU8", false, "golden missing"); return; }
  const byKey = {};
  let err = "";
  for (const c of g.cases) {
    const src = decode(c.src), gold = decode(c.out);
    let out;
    try { out = Imaging.cvResizeU8(src, c.sw, c.sh, c.dw, c.dh, c.cn, c.interp); } catch (e) { err = e.message; break; }
    const key = `${c.interp} cn=${c.cn}`;
    byKey[key] = byKey[key] || { bad: 0, tot: 0, det: "" };
    byKey[key].tot++;
    const e = eqArr(out, gold);
    if (e) { byKey[key].bad++; if (!byKey[key].det) byKey[key].det = `${c.sw}x${c.sh}->${c.dw}x${c.dh} ${e}`; }
  }
  if (err) { check("cvResizeU8 byte-exact", false, "ERR " + err); return; }
  let bad = 0, det = "";
  for (const k of Object.keys(byKey)) { if (byKey[k].bad) { bad += byKey[k].bad; if (!det) det = `${k}: ${byKey[k].det}`; } }
  check("cvResizeU8 (INTER_AREA/LINEAR) byte-exact", bad === 0, det || `all ${Object.keys(byKey).length} groups ok`);
}

console.log("=== imaging.js parity vs OpenCV 5.0.0 / NumPy ===\n");
for (const t of [testDT, testGray, testExtract, testNumpy, testMorph, testContours, testDraw, testResize]) {
  try { t(); } catch (e) { check(t.name, false, "THREW " + e.message); }
}
console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
