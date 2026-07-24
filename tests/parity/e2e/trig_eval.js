// Evaluate V8's (fdlibm) sin/cos/atan2 for lists of double bit-patterns.
// Used by gen_outline_goldens.py --fdlibm to run the ORIGINAL Python pipeline
// against the same libm the browser port uses.
// Usage: node trig_eval.js <in.json> <out.json>
const fs = require("fs");
const [, , inPath, outPath] = process.argv;
const req = JSON.parse(fs.readFileSync(inPath, "utf8"));
const toF = (h) => Buffer.from(h, "hex").readDoubleBE(0);
const toB = (x) => { const b = Buffer.alloc(8); b.writeDoubleBE(x, 0); return b.toString("hex"); };
const out = {
  sin: (req.sin || []).map((h) => toB(Math.sin(toF(h)))),
  cos: (req.cos || []).map((h) => toB(Math.cos(toF(h)))),
  atan2: (req.atan2 || []).map(([hy, hx]) => toB(Math.atan2(toF(hy), toF(hx)))),
};
fs.writeFileSync(outPath, JSON.stringify(out));
