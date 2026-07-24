// End-to-end outline parity: JS worker vs Python shaper_core goldens.
// Every element field must be EXACTLY equal (doubles compared bit-wise via ===,
// strings/ids equal, ordering identical). Mask bytes must be identical.
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "..", "js");
const GOLD = path.join(__dirname, "goldens");

global.Imaging = require(path.join(DOCS, "imaging.js"));
try { global.Geometry = require(path.join(DOCS, "geometry.js")); } catch (e) { /* not built yet */ }
try { global.PyNum = require(path.join(DOCS, "pynum.js")); } catch (e) { /* */ }
global.importScripts = () => {};
global.self = global;
let messages = [];
global.postMessage = (m) => messages.push(m);
eval(fs.readFileSync(path.join(DOCS, "worker-outline.js"), "utf8"));

function deepCompare(a, b, pathStr, diffs, maxDiffs) {
  if (diffs.length >= maxDiffs) return;
  if (typeof a !== typeof b) {
    diffs.push(`${pathStr}: type ${typeof a} vs ${typeof b}`);
    return;
  }
  if (typeof a === "number") {
    if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) {
      diffs.push(`${pathStr}: ${a} !== ${b} (delta=${a - b})`);
    }
    return;
  }
  if (a === null || b === null || typeof a !== "object") {
    if (a !== b) diffs.push(`${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${pathStr}: array-ness differs`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      diffs.push(`${pathStr}: length ${a.length} vs ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) deepCompare(a[i], b[i], `${pathStr}[${i}]`, diffs, maxDiffs);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const inA = k in a, inB = k in b;
    if (!inA || !inB) {
      // Python omits keys entirely; JS must too (undefined !== omitted for JSON parity)
      const av = inA ? a[k] : undefined;
      const bv = inB ? b[k] : undefined;
      if (av !== undefined || bv !== undefined) {
        diffs.push(`${pathStr}.${k}: presence ${inA} vs ${inB}`);
      }
      continue;
    }
    deepCompare(a[k], b[k], `${pathStr}.${k}`, diffs, maxDiffs);
  }
}

const index = JSON.parse(fs.readFileSync(path.join(GOLD, "outline_index.json"), "utf8"));
let failures = 0;

for (const caseId of index) {
  const golden = JSON.parse(fs.readFileSync(path.join(GOLD, `${caseId}.json`), "utf8"));
  const rgba = new Uint8ClampedArray(fs.readFileSync(path.join(GOLD, golden.input_rgba)).buffer.slice(0));

  messages = [];
  global.postMessage = (m) => messages.push(m);
  self.onmessage({ data: {
    cmd: "process", jobId: caseId,
    rgba: rgba.buffer, width: golden.width, height: golden.height,
    config: golden.config,
  }});
  const done = messages.find((m) => m.type === "done");
  const err = messages.find((m) => m.type === "error");
  if (!done) {
    console.log(`FAIL ${caseId}: worker error: ${err && err.message}`);
    failures++;
    continue;
  }
  const r = done.result;

  const diffs = [];
  // JSON round-trip the JS result so numbers/undefined behave like the golden
  const jsResult = JSON.parse(JSON.stringify({
    mode: r.mode,
    image_center: r.image_center,
    image_size: r.image_size,
    config: r.config,
    elements_count: r.elements_count,
    elements: r.elements,
  }));
  deepCompare(jsResult, golden.result, "result", diffs, 12);

  // mask bytes
  const maskGolden = fs.readFileSync(path.join(GOLD, golden.mask_bin));
  const maskJs = Buffer.from(r.mask_gray);
  if (!maskGolden.equals(maskJs)) {
    let diffPx = 0;
    for (let i = 0; i < Math.min(maskGolden.length, maskJs.length); i++) {
      if (maskGolden[i] !== maskJs[i]) diffPx++;
    }
    diffs.push(`mask bytes differ (${diffPx} px)`);
  }

  if (diffs.length) {
    console.log(`FAIL ${caseId} (${golden.fixture}): ${golden.result.elements_count} golden vs ${r.elements_count} js elements`);
    diffs.forEach((d) => console.log("   " + d));
    failures++;
  } else {
    console.log(`PASS ${caseId} (${golden.fixture}): ${r.elements_count} elements identical`);
  }
}

console.log(failures === 0 ? "ALL PASS" : `${failures}/${index.length} CASES FAILED`);
process.exit(failures ? 1 : 0);
