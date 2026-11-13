/* Pixel-perfect in the website: images under 1,000 visible pixels select it
 * automatically, the result is an exact copy (checked through Export JSON),
 * GIA export works, a larger input restores the previous method, and a small
 * GIF becomes rectangle frames that the Lua playback oracle accepts.
 * Run: node tests/pixel/run-browser.cjs */
"use strict";
const fs = require("fs"), http = require("http"), path = require("path"), os = require("os"), zlib = require("zlib");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { spawnSync } = require("child_process");
const root = require("../runtime-root.cjs"), testBase = path.resolve(__dirname, "..");

const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = (bytes) => { let c = ~0; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// 24 x 24 sprite: outlined disc with an eye, a mouth and a half-transparent shadow row.
const W = 24, H = 24, sprite = new Uint8ClampedArray(W * H * 4);
let visible = 0, runs = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const d = (x - 12) ** 2 + (y - 11) ** 2;
  const rgba = y === 22 && Math.abs(x - 12) < 7 ? [0, 0, 0, 96] : d > 100 ? null : d > 80 ? [20, 20, 40, 255]
    : (x - 9) ** 2 + (y - 8) ** 2 < 5 ? [255, 255, 255, 255] : y > 14 && Math.abs(x - 12) < 4 ? [140, 0, 20, 255] : [255, 200, 0, 255];
  if (!rgba) continue;
  sprite.set(rgba, (y * W + x) * 4); visible++;
  if (!x || sprite.subarray((y * W + x - 1) * 4, (y * W + x) * 4).join() !== rgba.join()) runs++;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-")), spritePath = path.join(dir, "sprite.png");
fs.writeFileSync(spritePath, png(W, H, sprite));

/* Minimal GIF89a writer: one 256-colour palette, uncompressed LZW (9-bit codes
 * with a clear code every 250 pixels). */
function gif(width, height, palette, frames) {
  const out = [...Buffer.from("GIF89a"), width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0];
  for (let i = 0; i < 256; i++) out.push(...(palette[i] || [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  for (const indices of frames) {
    out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 8);
    const bytes = []; let acc = 0, bits = 0;
    const put = (code) => { acc |= code << bits; bits += 9; while (bits >= 8) { bytes.push(acc & 255); acc >>>= 8; bits -= 8; } };
    indices.forEach((v, i) => { if (i % 250 === 0) put(256); put(v); });
    put(257); if (bits) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) { const block = bytes.slice(i, i + 255); out.push(block.length, ...block); }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}
// 64 x 64 still and 64 x 48 GIF: thousands of visible pixels, but a flat
// background with small details needs only a few controls.
const flat = new Uint8ClampedArray(64 * 64 * 4);
for (let q = 0; q < 64 * 64; q++) { const x = q % 64, y = q >> 6; flat.set(x > 20 && x < 30 && y > 40 && y < 50 ? [200, 40, 40, 255] : (x * 7 + y * 3) % 61 === 0 ? [255, 255, 255, 255] : [30, 90, 160, 255], q * 4); }
const flatPath = path.join(dir, "flat.png"), flatGifPath = path.join(dir, "flat.gif");
fs.writeFileSync(flatPath, png(64, 64, flat));
fs.writeFileSync(flatGifPath, gif(64, 48, [[30, 90, 160], [255, 220, 0], [255, 255, 255]], [0, 8, 16, 24].map((offset) =>
  Array.from({ length: 64 * 48 }, (_, q) => { const x = q % 64, y = Math.floor(q / 64); return x >= offset + 10 && x < offset + 18 && y >= 20 && y < 28 ? 1 : x % 16 === 3 && y % 12 === 5 ? 2 : 0; }))));

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
  const file = pathname.startsWith("/tests/") ? path.resolve(testBase, "." + pathname.slice(6)) : path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep) && !file.startsWith(testBase + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css", ".gif": "image/gif", ".wasm": "application/wasm", ".gia": "application/octet-stream" })[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
});
let failed = false;
const check = (ok, text) => { console.log(`${ok ? "PASS" : "FAIL"} ${text}`); if (!ok) failed = true; };

(async () => {
  await new Promise((resolve) => server.listen(8364, "127.0.0.1", resolve));
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else if (!fs.existsSync(chromium.executablePath())) launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => { errors.push("dialog: " + dialog.message()); dialog.dismiss(); });
    const download = async (id) => { const [file] = await Promise.all([page.waitForEvent("download"), page.click("#" + id)]); return fs.readFileSync(await file.path()); };
    const doneCount = () => page.evaluate(() => document.querySelectorAll(".job-status.done").length);
    await page.goto("http://127.0.0.1:8364/index.html");
    check(await page.inputValue("#fitMethod") === "primeval", "page starts on Primeval");

    await page.setInputFiles("#fileInput", spritePath);
    await page.waitForFunction(() => document.getElementById("fitMethod").value === "pixel", undefined, { timeout: 20000 });
    const layout = await page.evaluate(() => ({ count: document.getElementById("numPrimsManual").closest(".param-item").getBoundingClientRect().height,
      shapes: document.getElementById("legacyShapeChecks").getBoundingClientRect().height, opacity: document.getElementById("outputAlphaSettings").getBoundingClientRect().height,
      hint: document.getElementById("pixelHint").getBoundingClientRect().height }));
    check(layout.count === 0 && layout.shapes === 0 && layout.opacity === 0 && layout.hint > 0, `an image with ${visible} visible pixels selects Pixel-perfect; count, shapes and Opacity take no space`);
    await page.click("#btnSubmit");
    await page.waitForFunction(() => document.querySelector(".job-status.done") || document.querySelector(".job-error"), undefined, { timeout: 60000 });
    await page.locator(".job-card:has(.job-status.done) .job-actions button").first().click();
    await page.waitForFunction(() => document.getElementById("statMode").textContent.length > 0);
    check(await page.textContent("#statMode") === "Pixel-perfect", "result is labelled Pixel-perfect");
    const json = JSON.parse(String(await download("btnExportJSON")));
    // Elements are drawn in order; later rectangles cover earlier ones.
    const unit = json.config.image_scale || 1, out = new Uint8ClampedArray(W * H * 4);
    for (const el of json.elements) {
      const w = el.size.width / unit, h = el.size.height / unit, x0 = Math.round(el.center.x / unit - w / 2), y0 = Math.round(-el.center.y / unit - h / 2);
      const rgb = [1, 3, 5].map((i) => parseInt(el.color.slice(i, i + 2), 16)), a = Math.round(el.alpha * 255);
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.set([...rgb, a], (y * W + x) * 4);
    }
    check(out.every((v, i) => v === sprite[i]), `${json.elements.length} rectangles rebuild all ${visible} visible pixels exactly`);
    check(json.elements.length * 3 <= runs, `layers compress ${runs} row runs to ${json.elements.length} rectangles`);
    const gia = await download("btnExportGIAOverlimit");
    check(gia.length > 100, "Asset Group GIA exports");

    await page.click("#btnBack").catch(() => {});
    await page.evaluate(() => document.getElementById("homeLink")?.click());
    check(await page.inputValue("#fitMethod") === "pixel", "method stays Pixel-perfect after the job");
    await page.setInputFiles("#fileInput", path.join(testBase, "primeval/fixtures/input.png"));
    await page.waitForFunction(() => document.getElementById("fitMethod").value === "primeval", undefined, { timeout: 20000 });
    check(true, "a 4,096-pixel image restores the previous method");

    const gifPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    gifPage.on("pageerror", (error) => errors.push(error.message));
    await gifPage.goto("http://127.0.0.1:8364/index.html");
    for (const [file, text] of [[flatPath, "a 64 x 64 image with 4,096 visible pixels but few controls"], [flatGifPath, "a 64 x 48 GIF with 3,072 visible pixels per frame but few controls"]]) {
      const flatPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      flatPage.on("pageerror", (error) => errors.push(error.message));
      await flatPage.goto("http://127.0.0.1:8364/index.html");
      await flatPage.setInputFiles("#fileInput", file);
      const selected = await flatPage.waitForFunction(() => document.getElementById("fitMethod").value === "pixel", undefined, { timeout: 20000 }).then(() => true, () => false);
      check(selected, `${text} selects Pixel-perfect`);
      await flatPage.close();
    }
    await gifPage.setInputFiles("#fileInput", path.join(testBase, "primeval/fixtures/animation/moving.gif"));
    await gifPage.waitForFunction(() => document.getElementById("fitMethod").value === "pixel", undefined, { timeout: 20000 });
    check(true, "a 32 x 16 GIF selects Pixel-perfect");
    await gifPage.click("#btnSubmit");
    await gifPage.waitForFunction(() => document.querySelector(".job-status.done") || document.querySelector(".job-error"), undefined, { timeout: 120000 });
    await gifPage.locator(".job-card:has(.job-status.done) .job-actions button").first().click();
    await gifPage.waitForFunction(() => document.getElementById("statMode").textContent.length > 0);
    const gifDownload = async (id) => { const [file] = await Promise.all([gifPage.waitForEvent("download"), gifPage.click("#" + id)]); return fs.readFileSync(await file.path()); };
    const anim = JSON.parse(String(await gifDownload("btnExportJSON")));
    const kinds = new Set(anim.animation.frames.flatMap((f) => f.filter((_, i) => i % 8 === 0)));
    check(anim.config.fit_method === "pixel" && [...kinds].every((k) => k === 0 || k === 2), `${anim.animation.frames.length} GIF frames are rectangles (kinds ${[...kinds].join(",")})`);
    await gifPage.fill("#clientLuaTemplateIndex", "7"); await gifPage.dispatchEvent("#clientLuaTemplateIndex", "input");
    const luaFields = await gifPage.evaluate(() => ({ speed: document.getElementById("clientAnimationLoadSpeedField").getBoundingClientRect().height,
      compact: document.getElementById("clientAnimationCompactField").getBoundingClientRect().height }));
    check(luaFields.speed > 0 && luaFields.compact === 0, "Pixel-perfect animation Lua shows Load speed instead of Compact");
    const lua = String(await gifDownload("btnExportClientLua"));
    check(/^local LOAD_SPEED=10 /m.test(lua), "Lua script loads at speed 10 by default");
    const luaBin = ["lua", "texlua"].find((c) => !spawnSync(c, ["-v"], { encoding: "utf8" }).error);
    if (!luaBin) console.log("SKIP Lua playback oracle (install lua or texlua)");
    else {
      const report = require(path.join(root, "scripts/preview-lua-player.cjs")).capture(lua);
      check(report.mismatchCount === 0 && report.timeline.length > 0, `Lua playback oracle: ${report.mismatchCount} mismatches`);
    }
    check(!errors.length, "no page errors " + errors.join("; "));
  } finally {
    await browser.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
