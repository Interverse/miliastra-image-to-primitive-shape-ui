// GIA export parity: JS glue (gia-export.js) + JS writer (gia.js) vs the
// Python originals, byte-for-byte, over the E2E golden results.
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "..", "js");
const GOLD = path.join(__dirname, "goldens");
const ROOT = path.join(__dirname, "..", "..", "..");

const GIA = require(path.join(DOCS, "gia.js"));
const GiaExport = require(path.join(DOCS, "gia-export.js"));

const template = new Uint8Array(fs.readFileSync(path.join(ROOT, "assets", "image_template.gia")));

const indexPath = path.join(GOLD, "gia_index.json");
if (!fs.existsSync(indexPath)) {
  console.log("SKIP: run gen_gia_goldens.py first");
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
let failures = 0;

for (const entry of index) {
  const golden = JSON.parse(fs.readFileSync(path.join(GOLD, `${entry.case}.json`), "utf8"));
  const result = golden.result;
  const origin = result.image_center;

  const jsonData = GiaExport.convertResultToGiaJson(result, golden.config, entry.name, origin.x, origin.y);

  if (entry.error) {
    // The original raises here (e.g. packed_color=None from the broken
    // decoration export) — the port must fail identically, not emit bytes.
    let threw = null;
    try {
      GIA.convertJsonToGiaBytes(jsonData, template, GIA.MODE_IMAGE);
    } catch (e) {
      threw = e;
    }
    if (threw instanceof TypeError) {
      console.log(`PASS ${entry.case}: error parity (TypeError, matches original)`);
    } else {
      console.log(`FAIL ${entry.case}: original errors (${entry.error}) but JS ${threw ? "threw " + threw.constructor.name : "produced bytes"}`);
      failures++;
    }
    continue;
  }

  const gia = GIA.convertJsonToGiaBytes(jsonData, template, GIA.MODE_IMAGE);
  const classic = GIA.toClassic(gia);

  const giaGolden = fs.readFileSync(path.join(GOLD, `${entry.case}.gia`));
  const classicGolden = fs.readFileSync(path.join(GOLD, `${entry.case}_classic.gia`));

  const giaOk = giaGolden.equals(Buffer.from(gia));
  const classicOk = classicGolden.equals(Buffer.from(classic));
  if (!giaOk || !classicOk) {
    failures++;
    let firstDiff = -1;
    const a = giaGolden, b = Buffer.from(gia);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) { firstDiff = i; break; }
    }
    console.log(`FAIL ${entry.case}: gia=${giaOk} classic=${classicOk} lenPy=${a.length} lenJs=${b.length} firstDiff@${firstDiff}`);
  } else {
    console.log(`PASS ${entry.case}: ${gia.length} bytes identical (+classic)`);
  }
}

console.log(failures === 0 ? "ALL PASS" : `${failures}/${index.length} CASES FAILED`);
process.exit(failures ? 1 : 0);
