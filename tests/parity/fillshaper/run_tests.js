// Validate js/fillshaper.js against fill_shaper.py goldens (bit-exact).
const fs = require("fs");
const path = require("path");
const DOCS = path.join(__dirname, "..", "..", "..", "js");
global.PyNum = require(path.join(DOCS, "pynum.js"));
const FillShaper = require(path.join(DOCS, "fillshaper.js"));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "goldens", "fillshaper.json"), "utf8"));

function bitsToF(hex) { return Buffer.from(hex, "hex").readDoubleBE(0); }
function fToBits(x) { const b = Buffer.alloc(8); b.writeDoubleBE(x, 0); return b.toString("hex"); }

const W = golden.W, H = golden.H;
const wbuf = fs.readFileSync(path.join(__dirname, "goldens", "weights.bin"));
const weights = new Float64Array(wbuf.buffer.slice(wbuf.byteOffset, wbuf.byteOffset + wbuf.length));

let failures = 0;

/* Pass 1 — bit-exact with the reference libm's cos/sin injected. Proves all
 * non-transcendental math is identical. */
const realCos = Math.cos, realSin = Math.sin;
const trigMap = new Map();
for (const c of golden.opacity) {
  if (c.trig) {
    trigMap.set(c.trig.rad, { cos: bitsToF(c.trig.cos), sin: bitsToF(c.trig.sin) });
  }
}
Math.cos = (x) => {
  const hit = trigMap.get(fToBits(x));
  return hit ? hit.cos : realCos(x);
};
Math.sin = (x) => {
  const hit = trigMap.get(fToBits(x));
  return hit ? hit.sin : realSin(x);
};

let bad = 0;
for (const c of golden.opacity) {
  const o = FillShaper.shapeOpacity(c.result, weights, W, H);
  if (fToBits(o) !== c.opacity) {
    if (bad < 5) console.log(`opacity FAIL ${JSON.stringify(c.result).slice(0, 90)} js=${o} py=${bitsToF(c.opacity)}`);
    bad++;
  }
}
console.log(bad ? `FAIL opacity(injected trig): ${bad}/${golden.opacity.length}` : `PASS opacity (${golden.opacity.length} cases, bit-exact with injected trig)`);
failures += bad ? 1 : 0;

/* Pass 2 — engine trig (informational): counts libm-tail deviations. */
Math.cos = realCos;
Math.sin = realSin;
let tail = 0;
for (const c of golden.opacity) {
  const o = FillShaper.shapeOpacity(c.result, weights, W, H);
  if (fToBits(o) !== c.opacity) tail++;
}
console.log(`INFO opacity with engine trig: ${tail}/${golden.opacity.length} differ at libm-tail level (expected small, non-blocking)`);

bad = 0;
for (const c of golden.raster) {
  const r = FillShaper.rasterizeResult(c.result, W, H);
  let ok = r.ys.length === c.ys.length;
  if (ok) {
    for (let i = 0; i < r.ys.length; i++) {
      if (r.ys[i] !== c.ys[i] || r.xs[i] !== c.xs[i] || fToBits(r.alphas[i]) !== c.alphas[i]) {
        ok = false;
        if (bad < 3) console.log(`raster mismatch at ${i}: js=(${r.ys[i]},${r.xs[i]},${r.alphas[i]}) py=(${c.ys[i]},${c.xs[i]},${bitsToF(c.alphas[i])})`);
        break;
      }
    }
  } else if (bad < 3) {
    console.log(`raster count mismatch: js=${r.ys.length} py=${c.ys.length} for ${JSON.stringify(c.result)}`);
  }
  if (!ok) bad++;
}
console.log(bad ? `FAIL raster: ${bad}/${golden.raster.length}` : `PASS raster (${golden.raster.length} shapes, bit-exact triples)`);
failures += bad ? 1 : 0;

console.log(failures === 0 ? "ALL PASS" : "FAILURES");
process.exit(failures ? 1 : 0);
