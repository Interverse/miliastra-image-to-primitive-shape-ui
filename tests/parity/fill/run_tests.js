/*
 * run_tests.js — Node parity runner for the fill engine's primitive core.
 *
 * Replays every golden case (produced by `harness.exe trace`, `rng`, `gomath`,
 * `gofmt`, `raster`) through the JS port and asserts BIT-EXACT equality of each
 * step's shape parameters, chosen color, and model score (float64 bits).
 *
 * Usage:
 *   1. build/generate goldens (see README):
 *        go build -o harness.exe .
 *        ./harness.exe rng && ./harness.exe gomath && ./harness.exe gofmt \
 *          && ./harness.exe raster && ./harness.exe trace
 *   2. node run_tests.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const JS = path.join(__dirname, "..", "..", "..", "js");
const { GoRand } = require(path.join(JS, "gorand.js"));
const GoMath = require(path.join(JS, "gomath.js"));
const GoRaster = require(path.join(JS, "goraster.js"));
const wf = require(path.join(JS, "worker-fill.js"));

const dv = new DataView(new ArrayBuffer(8));
function bits(f) { dv.setFloat64(0, f); return dv.getBigUint64(0).toString(); }
function fromBits(s) { dv.setBigUint64(0, BigInt(s)); return dv.getFloat64(0); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); }
function has(p) { return fs.existsSync(path.join(__dirname, p)); }

let totalFail = 0;
function section(name, fn) {
  process.stdout.write(`── ${name} `.padEnd(40, "─") + " ");
  let fails = 0;
  try { fails = fn(); } catch (e) { console.log("ERROR", e.stack || e); totalFail++; return; }
  totalFail += fails;
  console.log(fails === 0 ? "PASS" : `FAIL (${fails})`);
}

/* ---------------- RNG ---------------- */
function testRNG() {
  if (!has("rng_golden.json")) { console.log("(skip: no rng_golden.json)"); return 0; }
  const golden = readJSON(path.join(__dirname, "rng_golden.json"));
  let fail = 0;
  const eq = (n, g, w) => { if (g !== w) { if (fail < 5) console.log(`\n  ${n}: ${g} != ${w}`); fail++; } };
  for (const d of golden) {
    const seed = d.seed;
    let r = new GoRand(seed);
    for (let i = 0; i < d.int63.length; i++) {
      r._next(); const v = ((BigInt(r._hi & 0x7fffffff) << 32n) | BigInt(r._lo >>> 0)).toString();
      eq("int63", v, d.int63[i]);
    }
    r = new GoRand(seed);
    for (let i = 0; i < d.uint32.length; i++) eq("uint32", r.uint32(), d.uint32[i] >>> 0);
    for (const [k, nn] of [["intn21", 21], ["intn3", 3], ["intn31", 31], ["intn32", 32], ["intn360", 360], ["intn8", 8]]) {
      r = new GoRand(seed);
      for (let i = 0; i < d[k].length; i++) eq(k, r.intn(nn), d[k][i]);
    }
    r = new GoRand(seed);
    for (let i = 0; i < d.float64bits.length; i++) eq("float64", bits(r.float64()), d.float64bits[i]);
    r = new GoRand(seed);
    for (let i = 0; i < d.normbits.length; i++) eq("norm", bits(r.normFloat64()), d.normbits[i]);
  }
  return fail;
}

/* ---------------- gomath ---------------- */
function testGoMath() {
  if (!has("gomath_golden.json")) { console.log("(skip)"); return 0; }
  const g = readJSON(path.join(__dirname, "gomath_golden.json"));
  let fail = 0;
  const eq = (n, go, w) => { if (go !== w) { if (fail < 5) console.log(`\n  ${n}: ${go} != ${w}`); fail++; } };
  for (let i = 0; i < g.sin_in.length; i++) {
    const x = fromBits(g.sin_in[i]);
    eq("sin", bits(GoMath.sin(x)), g.sin_out[i]);
    eq("cos", bits(GoMath.cos(x)), g.cos_out[i]);
  }
  for (let i = 0; i < g.acos_in.length; i++) eq("acos", bits(GoMath.acos(fromBits(g.acos_in[i]))), g.acos_out[i]);
  for (let i = 0; i < g.at2_y.length; i++) eq("atan2", bits(GoMath.atan2(fromBits(g.at2_y[i]), fromBits(g.at2_x[i]))), g.at2_out[i]);
  for (let i = 0; i < g.pow_x.length; i++) eq("pow", bits(GoMath.pow(fromBits(g.pow_x[i]), fromBits(g.pow_y[i]))), g.pow_out[i]);
  return fail;
}

/* ---------------- gofmt ---------------- */
function testGoFmt() {
  if (!has("gofmt_golden.json")) { console.log("(skip)"); return 0; }
  const g = readJSON(path.join(__dirname, "gofmt_golden.json"));
  let fail = 0;
  for (let i = 0; i < g.in.length; i++) {
    const got = wf.goFmtF(fromBits(g.in[i]), 6);
    if (got !== g.out[i]) { if (fail < 5) console.log(`\n  gofmt: ${got} != ${g.out[i]}`); fail++; }
  }
  return fail;
}

/* ---------------- raster ---------------- */
function testRaster() {
  if (!has("raster_golden.json")) { console.log("(skip)"); return 0; }
  const golden = readJSON(path.join(__dirname, "raster_golden.json"));
  const rasterizers = {};
  const sink = { lines: [], push(y, x1, x2, a) { this.lines.push([y, x1, x2, a]); } };
  let fail = 0;
  for (const c of golden) {
    const key = c.w + "_" + c.h;
    if (!rasterizers[key]) rasterizers[key] = new GoRaster.Rasterizer(c.w, c.h);
    const r = rasterizers[key];
    r.clear(); r.UseNonZeroWinding = true;
    const [X, Y, Rx, Ry, Ang] = c.params;
    const angRad = GoMath.radians(Ang), cosT = GoMath.cos(angRad), sinT = GoMath.sin(angRad);
    for (let i = 0; i < 16; i++) {
      const p1 = i / 16, p2 = (i + 1) / 16;
      const a1 = p1 * 2 * Math.PI, a2 = p2 * 2 * Math.PI;
      let x0 = Rx * GoMath.cos(a1), y0 = Ry * GoMath.sin(a1);
      const x1 = Rx * GoMath.cos(a1 + (a2 - a1) / 2), y1 = Ry * GoMath.sin(a1 + (a2 - a1) / 2);
      let x2 = Rx * GoMath.cos(a2), y2 = Ry * GoMath.sin(a2);
      let cx = 2 * x1 - x0 / 2 - x2 / 2, cy = 2 * y1 - y0 / 2 - y2 / 2;
      const rx0 = x0 * cosT - y0 * sinT, ry0 = x0 * sinT + y0 * cosT;
      const rcx = cx * cosT - cy * sinT, rcy = cx * sinT + cy * cosT;
      const rx2 = x2 * cosT - y2 * sinT, ry2 = x2 * sinT + y2 * cosT;
      if (i === 0) r.start(GoRaster.gfix(rx0 + X), GoRaster.gfix(ry0 + Y));
      r.add2(GoRaster.gfix(rcx + X), GoRaster.gfix(rcy + Y), GoRaster.gfix(rx2 + X), GoRaster.gfix(ry2 + Y));
    }
    sink.lines = [];
    r.rasterize(sink);
    const want = c.lines;
    let bad = sink.lines.length !== want.length;
    if (!bad) for (let i = 0; i < want.length; i++) {
      const a = sink.lines[i], b = want[i];
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) { bad = true; break; }
    }
    if (bad) { if (fail < 3) console.log(`\n  raster mismatch params=${c.params}`); fail++; }
  }
  return fail;
}

/* ---------------- primitive core traces ---------------- */
function testTrace() {
  if (!has("trace_golden.json")) { console.log("(skip)"); return 0; }
  const cases = readJSON(path.join(__dirname, "trace_golden.json"));
  let fail = 0;
  let stepCount = 0;
  for (const c of cases) {
    const straight = Buffer.from(c.straight, "base64"); // straight NRGBA bytes
    // MakeHexColor("ffffff")->{255,255,255,255}; "ffffff00"->{255,255,255,0}
    const bgA = c.bg.length >= 8 ? parseInt(c.bg.slice(6, 8), 16) : 255;
    const model = new wf.PrimitiveModel(straight, c.w, c.h, 255, 255, 255, bgA, c.seed);
    let si = 0;
    let bad = false;
    for (const [mode, count] of c.configs) {
      for (let i = 0; i < count && !bad; i++) {
        const { shape, color } = model.step(mode, 0, c.n, c.age, c.m);
        const g = c.steps[si++];
        stepCount++;
        const fails = [];
        if (g.shapeType !== mode) fails.push(`type ${mode}!=${g.shapeType}`);
        for (let k = 0; k < 4; k++) if (color[k] !== g.color[k]) fails.push(`color[${k}] ${color[k]}!=${g.color[k]}`);
        if (bits(model.score) !== g.scoreBits) fails.push(`score ${bits(model.score)}!=${g.scoreBits}`);
        if (mode === 1) {
          const t = g.tri, got = [shape.x1, shape.y1, shape.x2, shape.y2, shape.x3, shape.y3];
          for (let k = 0; k < 6; k++) if (got[k] !== t[k]) fails.push(`tri[${k}] ${got[k]}!=${t[k]}`);
        } else if (mode === 5) {
          const t = g.rect, got = [shape.x, shape.y, shape.sx, shape.sy, shape.angle];
          for (let k = 0; k < 5; k++) if (got[k] !== t[k]) fails.push(`rect[${k}] ${got[k]}!=${t[k]}`);
        } else {
          const t = g.ell, got = [shape.x, shape.y, shape.rx, shape.ry, shape.angle];
          for (let k = 0; k < 5; k++) if (bits(got[k]) !== t[k]) fails.push(`ell[${k}] ${bits(got[k])}!=${t[k]}`);
        }
        if (fails.length) {
          if (fail < 6) console.log(`\n  [${c.name} seed=${c.seed} step=${si - 1}] ${fails.slice(0, 4).join("; ")}`);
          fail++;
          bad = true; // first divergence cascades; move to next case
        }
      }
      if (bad) break;
    }
  }
  if (fail === 0) console.log(`(${cases.length} cases, ${stepCount} steps) `);
  return fail;
}

section("gorand", testRNG);
section("gomath", testGoMath);
section("gofmt", testGoFmt);
section("goraster", testRaster);
section("primitive core traces", testTrace);

console.log("");
if (totalFail === 0) { console.log("ALL PARITY TESTS PASS ✓ (bit-exact)"); process.exit(0); }
else { console.log(`PARITY FAILURES: ${totalFail}`); process.exit(1); }
