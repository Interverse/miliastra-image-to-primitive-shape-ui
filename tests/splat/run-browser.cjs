/* Splat browser checks: threaded CPU fitting with shared memory (cross-origin
 * isolated) and with copied buffers, compared with one thread; the WebGPU
 * fitter against the CPU fitter (tests/splat/gpu_parity.html) and as a job;
 * and the WebGL editor raster compared pixel by pixel with the CPU renderer.
 * Run: node tests/splat/run-browser.cjs  (PLAYWRIGHT_MODULE / CHROME_PATH as for the other browser tests) */
"use strict";
const fs = require("fs"), http = require("http"), path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = require("../runtime-root.cjs"), testBase = path.resolve(__dirname, "..");

function serve(port, isolated) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
    const file = pathname.startsWith("/tests/") ? path.resolve(testBase, "." + pathname.slice(6)) : path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep) && !file.startsWith(testBase + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      if (isolated) { res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); res.setHeader("Cross-Origin-Embedder-Policy", "require-corp"); }
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function run(page, port, isolated) {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  return page.evaluate(async (isolated) => {
    if (crossOriginIsolated !== isolated) throw Error("unexpected isolation state " + crossOriginIsolated);
    const input = await PNGDecode.decode(new Uint8Array(await (await fetch("/tests/primeval/fixtures/input.png")).arrayBuffer()));
    const fit = (threads, backend = "cpu") => new Promise((resolve, reject) => {
      const worker = new Worker("js/worker-splat.js?test=" + Math.random());
      worker.onmessage = ({ data }) => {
        if (data.type === "done") { worker.terminate(); resolve(data.result); }
        if (data.type === "error") { worker.terminate(); reject(Error(data.message)); }
      };
      worker.postMessage({ cmd: "process", jobId: "t", rgba: input.rgba.slice().buffer, width: input.width, height: input.height,
        config: { num_primitives: 120, splat_iterations: 150, splat_resolution: 64, splat_threads: threads, splat_backend: backend } });
    });
    const one = await fit(1), four = await fit(4), gpu = await fit(1, "auto");
    // WebGL raster versus the CPU renderer at the same size.
    const canvas = SplatPreview.draw(four.elements, four.image_size.width, four.image_size.height, four.config.pixel_per_unit);
    const gl = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const cpu = SplatCore.renderElements(four.elements, four.image_size.width, four.image_size.height, four.config.pixel_per_unit, canvas.width / four.image_size.width).rgba;
    let worst = 0, total = 0;
    for (let i = 0; i < gl.length; i += 4) {
      if (gl[i + 3] < 8 && cpu[i + 3] < 8) continue; // colour of nearly clear pixels is not meaningful
      for (let c = 0; c < 4; c++) { const d = Math.abs(gl[i + c] - cpu[i + c]); worst = Math.max(worst, d); total += d; }
    }
    return { usesWebGL: SplatPreview.usesWebGL, lossOne: one.config.final_loss, lossFour: four.config.final_loss,
      gpuBackend: gpu.config.splat_backend, lossGpu: gpu.config.final_loss, gpuCount: gpu.elements.filter((el) => el.type === "splat").length,
      hasWebGPU: !!navigator.gpu && !!(await navigator.gpu.requestAdapter()),
      count: four.elements.filter((el) => el.type === "splat").length, worst, mean: total / gl.length };
  }, isolated);
}

(async () => {
  const servers = [await serve(8351, true), await serve(8352, false)];
  const launch = { headless: true, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--enable-unsafe-swiftshader"] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else if (!fs.existsSync(chromium.executablePath())) launch.channel = "chrome";
  const browser = await chromium.launch(launch);
  let failed = false;
  try {
    for (const [port, isolated] of [[8351, true], [8352, false]]) {
      const page = await browser.newPage({ serviceWorkers: "block" });
      const logs = [];
      page.on("console", (msg) => { if (/\[splat\]/.test(msg.text())) logs.push(msg.text()); });
      page.on("pageerror", (error) => logs.push("PAGEERROR " + error.message));
      const r = await run(page, port, isolated);
      const label = isolated ? "shared memory" : "copied buffers";
      const checks = [
        [r.count === 120, "keeps every splat"],
        [r.lossFour < 0.05 && Math.abs(r.lossFour - r.lossOne) <= 0.1 * r.lossOne + 1e-6, `threaded loss ${r.lossFour} close to one thread ${r.lossOne}`],
        [!logs.some((line) => /one thread|PAGEERROR/.test(line)), "helpers started: " + logs.join(" | ")],
        [r.worst <= 6 && r.mean < 0.5, `editor raster matches CPU (worst ${r.worst}, mean ${r.mean.toFixed(3)}, WebGL ${r.usesWebGL})`],
        [r.gpuBackend === (r.hasWebGPU ? "webgpu" : "cpu") && r.gpuCount === 120 && r.lossGpu < 0.05,
          `default job uses ${r.gpuBackend} (WebGPU available: ${r.hasWebGPU}), loss ${r.lossGpu}`],
      ];
      for (const [ok, text] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${text}`); if (!ok) failed = true; }
      await page.close();
    }
    // WebGPU fitter versus the CPU fitter from the same start.
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:8351/tests/splat/gpu_parity.html");
    await page.waitForFunction(() => document.body.dataset.result, undefined, { timeout: 300000 });
    const parity = JSON.parse(await page.evaluate(() => document.body.dataset.result));
    if (parity.error) { console.log("FAIL WebGPU parity: " + parity.error); failed = true; }
    else if (parity.gpu === "unavailable") console.log("SKIP WebGPU parity: no adapter");
    else for (const [name, r] of Object.entries(parity)) {
      const ok = r.step < 1e-3 && r.render < 2e-3 && Math.abs(r.lossCpu - r.lossGpu) < 1e-6 && r.redistributeMismatch < 0.01;
      console.log(`${ok ? "PASS" : "FAIL"} WebGPU parity ${name}: step ${r.step.toExponential(1)}, render ${r.render.toExponential(1)}, redistribution mismatch ${r.redistributeMismatch}`);
      if (!ok) failed = true;
    }
    await page.close();
  } finally {
    await browser.close();
    servers.forEach((server) => server.close());
  }
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
