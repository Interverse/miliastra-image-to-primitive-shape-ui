// Validate js/pynum.js against CPython/NumPy goldens (bit-exact).
const fs = require("fs");
const path = require("path");
const PyNum = require(path.join(__dirname, "..", "..", "..", "js", "pynum.js"));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "goldens", "pynum.json"), "utf8"));

function bitsToF(hex) {
  const buf = Buffer.from(hex, "hex");
  return buf.readDoubleBE(0);
}
function fToBits(x) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(x, 0);
  return buf.toString("hex");
}

let failures = 0;

let bad = 0;
for (const c of golden.round) {
  const x = bitsToF(c.x);
  const r = PyNum.round(x, c.nd);
  if (fToBits(r) !== c.r) {
    if (bad < 5) console.log(`round FAIL x=${x} nd=${c.nd} js=${r} py=${bitsToF(c.r)}`);
    bad++;
  }
}
console.log(bad ? `FAIL round: ${bad}/${golden.round.length}` : `PASS round (${golden.round.length} cases)`);
failures += bad ? 1 : 0;

bad = 0;
for (const c of golden.roundInt) {
  const r = PyNum.roundInt(bitsToF(c.x));
  if (r !== c.r) {
    if (bad < 5) console.log(`roundInt FAIL x=${bitsToF(c.x)} js=${r} py=${c.r}`);
    bad++;
  }
}
console.log(bad ? `FAIL roundInt: ${bad}/${golden.roundInt.length}` : `PASS roundInt (${golden.roundInt.length} cases)`);
failures += bad ? 1 : 0;

bad = 0;
for (const c of golden.rint) {
  const r = PyNum.rint(bitsToF(c.x));
  if (fToBits(r) !== c.r) {
    if (bad < 5) console.log(`rint FAIL x=${bitsToF(c.x)} js=${r} py=${bitsToF(c.r)}`);
    bad++;
  }
}
console.log(bad ? `FAIL rint: ${bad}/${golden.rint.length}` : `PASS rint (${golden.rint.length} cases)`);
failures += bad ? 1 : 0;

bad = 0;
for (const c of golden.pairwiseSum) {
  const arr = Float64Array.from(c.arr.map(bitsToF));
  const r = PyNum.pairwiseSum(arr);
  if (fToBits(r) !== c.r) {
    if (bad < 5) console.log(`pairwiseSum FAIL n=${arr.length} js=${r} py=${bitsToF(c.r)} delta=${r - bitsToF(c.r)}`);
    bad++;
  }
}
console.log(bad ? `FAIL pairwiseSum: ${bad}/${golden.pairwiseSum.length}` : `PASS pairwiseSum (${golden.pairwiseSum.length} lengths)`);
failures += bad ? 1 : 0;

console.log(failures === 0 ? "ALL PASS" : `${failures} GROUPS FAILED`);
process.exit(failures ? 1 : 0);
