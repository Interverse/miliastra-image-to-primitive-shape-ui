// End-to-end fill parity: JS worker vs the original Python pipeline driven
// by the seeded Go harness (gen_fill_goldens.py). Exact comparison.
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "..", "js");
const GOLD = path.join(__dirname, "goldens");

global.Imaging = require(path.join(DOCS, "imaging.js"));
global.PyNum = require(path.join(DOCS, "pynum.js"));
global.FillShaper = require(path.join(DOCS, "fillshaper.js"));
for (const optional of ["gorand.js", "goraster.js", "gomath.js"]) {
  try {
    const name = optional.replace(".js", "");
    const exported = require(path.join(DOCS, optional));
    global[name.charAt(0).toUpperCase() + name.slice(1)] = exported;
    global[name] = exported;
  } catch (e) { /* not built yet */ }
}
global.importScripts = () => {};
global.self = global;
let messages = [];
global.postMessage = (m) => messages.push(m);
eval(fs.readFileSync(path.join(DOCS, "worker-fill.js"), "utf8"));

function deepCompare(a, b, pathStr, diffs, maxDiffs) {
  if (diffs.length >= maxDiffs) return;
  if (typeof a !== typeof b) { diffs.push(`${pathStr}: type ${typeof a} vs ${typeof b}`); return; }
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
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      diffs.push(`${pathStr}: array mismatch ${a.length} vs ${b && b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) deepCompare(a[i], b[i], `${pathStr}[${i}]`, diffs, maxDiffs);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = k in a ? a[k] : undefined;
    const bv = k in b ? b[k] : undefined;
    if (av === undefined || bv === undefined) {
      if (av !== bv) diffs.push(`${pathStr}.${k}: presence ${k in a} vs ${k in b}`);
      continue;
    }
    deepCompare(av, bv, `${pathStr}.${k}`, diffs, maxDiffs);
  }
}

const indexPath = path.join(GOLD, "fill_index.json");
if (!fs.existsSync(indexPath)) {
  console.log("SKIP: no fill goldens — run gen_fill_goldens.py (needs the Go harness)");
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
let failures = 0;

for (const caseId of index) {
  const golden = JSON.parse(fs.readFileSync(path.join(GOLD, `${caseId}.json`), "utf8"));
  const rgba = new Uint8ClampedArray(fs.readFileSync(path.join(GOLD, golden.input_rgba)).buffer.slice(0));

  messages = [];
  global.postMessage = (m) => messages.push(m);
  const config = Object.assign({}, golden.config, { random_seed: golden.seed });
  self.onmessage({ data: {
    cmd: "process", jobId: caseId,
    rgba: rgba.buffer, width: golden.width, height: golden.height,
    config,
  }});
  const done = messages.find((m) => m.type === "done");
  const err = messages.find((m) => m.type === "error");
  if (!done) {
    console.log(`FAIL ${caseId}: worker error: ${err && err.message}`);
    failures++;
    continue;
  }
  const r = done.result;
  const jsResult = JSON.parse(JSON.stringify({
    mode: r.mode,
    image_center: r.image_center,
    image_size: r.image_size,
    config: r.config,
    mask: r.mask,
    elements_count: r.elements_count,
    elements: r.elements,
  }));
  const diffs = [];
  deepCompare(jsResult, golden.result, "result", diffs, 12);

  if (diffs.length) {
    console.log(`FAIL ${caseId} (${golden.fixture}, seed=${golden.seed}): golden ${golden.result.elements_count} vs js ${r.elements_count}`);
    diffs.forEach((d) => console.log("   " + d));
    failures++;
  } else {
    console.log(`PASS ${caseId} (${golden.fixture}, seed=${golden.seed}): ${r.elements_count} elements identical`);
  }
}

console.log(failures === 0 ? "ALL PASS" : `${failures}/${index.length} CASES FAILED`);
process.exit(failures ? 1 : 0);
