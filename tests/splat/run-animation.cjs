/* Splat animation through the website: a GIF defaults to Splat, every frame
 * is fitted, frames use shape kind 4 (image 106057), the animation JSON
 * restores, and the game Lua plays on a 900-unit canvas (checked with the
 * Lua playback oracle when lua/texlua is installed).
 * Run: node tests/splat/run-animation.cjs
 * Manual: SPLAT_GIF=path SPLAT_COUNT=1000 SPLAT_STEPS=1000 SPLAT_DETAIL=512 for a larger clip;
 * SPLAT_SAVE=file keeps the animation JSON. */
"use strict";
const fs = require("fs"), http = require("http"), path = require("path"), os = require("os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = require("../runtime-root.cjs"), testBase = path.resolve(__dirname, "..");
const { spawnSync } = require("child_process");

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
  const file = pathname.startsWith("/tests/") ? path.resolve(testBase, "." + pathname.slice(6)) : path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep) && !file.startsWith(testBase + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css", ".gif": "image/gif" })[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
});
let failed = false;
const check = (ok, text) => { console.log(`${ok ? "PASS" : "FAIL"} ${text}`); if (!ok) failed = true; };

(async () => {
  await new Promise((resolve) => server.listen(8358, "127.0.0.1", resolve));
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else if (!fs.existsSync(chromium.executablePath())) launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => { errors.push("dialog: " + dialog.message()); dialog.dismiss(); });
    page.on("console", (msg) => { if (msg.type() === "error") errors.push("console: " + msg.text()); });
    await page.goto("http://127.0.0.1:8358/index.html");
    await page.setInputFiles("#fileInput", process.env.SPLAT_GIF || path.join(testBase, "primeval/fixtures/animation/moving.gif"));
    await page.waitForFunction(() => !document.getElementById("animationSettings").hidden);
    // moving.gif averages under 1,000 visible pixels, so Pixel-perfect is chosen first.
    if (!process.env.SPLAT_GIF) {
      await page.waitForFunction(() => document.getElementById("fitMethod").value === "pixel", undefined, { timeout: 20000 });
      await page.selectOption("#fitMethod", "splat");
    }
    check(await page.inputValue("#fitMethod") === "splat", process.env.SPLAT_GIF ? "GIF input defaults to Splat" : "Splat chosen by hand over automatic Pixel-perfect");
    check(await page.evaluate(() => [...document.getElementById("fitMethod").options].filter((o) => !o.disabled).map((o) => o.value).sort().join()) === "pixel,primeval,splat",
      "animation offers Splat, Primeval and Pixel-perfect");
    await page.fill("#numPrimsManual", process.env.SPLAT_COUNT || "150"); await page.dispatchEvent("#numPrimsManual", "change");
    await page.fill("#splatIterations", process.env.SPLAT_STEPS || "200"); await page.fill("#splatResolution", process.env.SPLAT_DETAIL || "64");
    await page.click("#btnSubmit");
    await page.waitForFunction(() => document.querySelector(".job-status.done") || document.querySelector(".job-error"), undefined, { timeout: 300000 });
    const jobError = await page.evaluate(() => document.querySelector(".job-error")?.textContent || "");
    check(!jobError, "animation job finished " + jobError);
    await page.locator(".job-card:has(.job-status.done) .job-actions button").first().click();
    await page.waitForFunction(() => document.getElementById("statMode").textContent.length > 0);
    const painted = await page.evaluate(() => {
      const c = document.getElementById("mainCanvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 61) seen.add(d[i] >> 4 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4) << 8);
      return seen.size;
    });
    check(painted > 4, `result canvas draws the Splat frame (${painted} colour buckets)`);
    fs.mkdirSync(path.join(root, "reference/splat"), { recursive: true });
    await page.screenshot({ path: path.join(root, "reference/splat/animation-result.png") });

    const download = async (id) => { const [file] = await Promise.all([page.waitForEvent("download"), page.click("#" + id)]); return fs.readFileSync(await file.path()); };
    const json = JSON.parse(String(await download("btnExportJSON")));
    if (process.env.SPLAT_SAVE) fs.writeFileSync(process.env.SPLAT_SAVE, JSON.stringify(json));
    const frames = json.animation.frames, kinds = new Set(frames.flatMap((f) => f.filter((_, i) => i % 8 === 0)));
    check(frames.length >= 2 && kinds.has(4) && [...kinds].every((k) => k === 0 || k === 2 || k === 4), `${frames.length} frames use Splat kind 4 (kinds ${[...kinds].join(",")})`);
    check(json.config.fit_method === "splat", "result config records Splat");
    const restored = await page.evaluate((text) => { const r = FinishedImport.parse(text, "json"); return !!r.animation && r.animation.frames.length; }, JSON.stringify(json));
    check(restored === frames.length, "animation JSON with Splat frames imports back");

    await page.fill("#clientLuaTemplateIndex", "7"); await page.dispatchEvent("#clientLuaTemplateIndex", "input");
    const lua = String(await download("btnExportClientLua").catch((error) => { console.log("export errors:", errors.join(" | ")); throw error; }));
    check(lua.startsWith("-- Splat animation") && /local WIDTH,W,H,N=[\d.]+,[\d.]+,900,\d+/.test(lua) && lua.includes("106057"), "Lua plays Splat frames with image 106057 on a 900-unit canvas");
    const luaBin = ["lua", "texlua"].find((c) => { const p = spawnSync(c, ["-v"], { encoding: "utf8" }); return !p.error; });
    if (!luaBin) console.log("SKIP Lua playback oracle (install lua or texlua)");
    else {
      const { capture } = require(path.join(root, "scripts/preview-lua-player.cjs"));
      const report = capture(lua);
      check(report.mismatchCount === 0 && report.timeline.length > 0, `Lua playback oracle: ${report.timeline.length} timeline steps, ${report.mismatchCount} mismatches`);
    }
    check(!errors.length, "no page errors " + errors.join("; "));
  } finally {
    await browser.close(); server.close();
  }
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
