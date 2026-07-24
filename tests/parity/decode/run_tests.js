/*
 * run_tests.js — Node parity harness for js/png-decode.js.
 *
 * Decodes every corpus PNG with the browser decoder and asserts byte-identity
 * against the cv2 golden RGBA dumps produced by gen_goldens.py.
 *
 * Run:  node run_tests.js        (after: python gen_goldens.py)
 * Exit code 0 iff every case is byte-exact.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PNGDecode = require(path.join(HERE, "..", "..", "..", "js", "png-decode.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  if (a.length !== b.length) return n;
  return -1;
}

(async () => {
  let pass = 0;
  let fail = 0;
  const failures = [];
  const byGroup = {}; // format-ish prefix -> {pass, fail}

  for (const entry of manifest) {
    const png = fs.readFileSync(path.join(HERE, entry.png));
    const golden = fs.readFileSync(path.join(HERE, entry.golden));
    let result;
    try {
      result = await PNGDecode.decode(new Uint8Array(png));
    } catch (e) {
      fail++;
      failures.push(`${entry.name}: threw ${e.message}`);
      continue;
    }
    const group = entry.name.replace(/_?w?\d+.*$/, "").replace(/_f.*/, "") || entry.name;
    byGroup[group] = byGroup[group] || { pass: 0, fail: 0 };

    const dimsOk = result.width === entry.width && result.height === entry.height;
    const diff = firstDiff(result.rgba, golden);
    if (dimsOk && diff === -1 && result.rgba.length === golden.length) {
      pass++;
      byGroup[group].pass++;
    } else {
      fail++;
      byGroup[group].fail++;
      let msg = `${entry.name}: `;
      if (!dimsOk) msg += `dims ${result.width}x${result.height} != ${entry.width}x${entry.height}; `;
      if (diff !== -1) {
        const px = Math.floor(diff / 4);
        msg += `first diff at byte ${diff} (px ${px % entry.width},${Math.floor(px / entry.width)} ch ${diff % 4}): got ${result.rgba[diff]} want ${golden[diff]}`;
      }
      if (entry.deviation) msg += " [16-bit deviation case]";
      failures.push(msg);
    }
  }

  console.log("PNG decoder parity vs cv2.imdecode(IMREAD_UNCHANGED)\n");
  const groups = Object.keys(byGroup).sort();
  for (const g of groups) {
    const s = byGroup[g];
    console.log(`  ${(s.fail === 0 ? "PASS" : "FAIL").padEnd(4)}  ${g.padEnd(20)} ${s.pass}/${s.pass + s.fail}`);
  }
  console.log(`\n  total: ${pass}/${pass + fail} byte-exact`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
