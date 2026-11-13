/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/ (also LICENSES/mw_splat-MPL-2.0.txt).
 * Based on mw_splat by Golden_Water, commit 8c3951a. */
/* Splat fitting worker. Port of mw_splat (MPL-2.0); see splat-core.js.
 * Each fitting step is split into horizontal bands handled by helper
 * workers; with cross-origin isolation they share memory, otherwise the
 * parameters and gradients are copied. One thread runs everything inline. */
"use strict";
if (typeof importScripts === "function") importScripts("splat-core.js?v=3");
const Core = typeof SplatCore !== "undefined" ? SplatCore : require("./splat-core.js");

const DEFAULT_ITERATIONS = 3000, DEFAULT_RESOLUTION = 512, REDISTRIBUTE_EVERY = 200;

function fitSize(width, height, resolution) {
  const ratio = Math.min(1, resolution / Math.max(width, height));
  return { fw: Math.max(1, Math.round(width * ratio)), fh: Math.max(1, Math.round(height * ratio)) };
}

function buildResult(params, count, background, fw, fh, width, height, config, transparent, extra = {}) {
  const scale = Math.max(0.1, Math.min(100, Number(config.image_scale) || 1));
  const elements = Core.toElements(params, count, fw, fh, width, height, scale);
  const bg = Core.backgroundElement(background, width, height, scale);
  if (bg) elements.unshift(bg);
  const origin = config.origin || {}, custom = origin.type === "custom";
  const center = { x: origin.type === "top_left" ? 0 : custom ? Number(origin.x) : width / 2,
    y: origin.type === "top_left" ? 0 : custom ? Number(origin.y) : height / 2 };
  for (const el of elements) el.relative = { x: el.center.x - center.x * scale, y: el.center.y + center.y * scale };
  return {
    mode: "fill", image_center: center, image_size: { width, height }, elements_count: elements.length, elements,
    config: {
      mode: "fill", engine: "splat-browser", fit_method: "splat", allowed_shapes: ["splat"],
      pixel_per_unit: 1 / scale, unit_scale: scale, image_scale: scale,
      num_primitives: count, enable_png_mode: transparent, output_has_transparency: transparent,
      fill_variant: transparent ? "png" : "mask",
      splat_iterations: extra.iterations, splat_resolution: extra.resolution,
      splat_redistribute: REDISTRIBUTE_EVERY, splat_ramp_cap: Core.RAMP_CAP, splat_reference_height: Core.REF_HEIGHT,
      training_size: { width: fw, height: fh },
      ...(extra.finalLoss !== undefined ? { final_loss: extra.finalLoss } : {}),
    },
    mask: { enabled: false },
  };
}

/* Helper workers start from a blob holding splat-core.js and the band script.
 * Some embedded browsers refuse nested workers loaded by URL; blobs work. */
let bandSource = null;
async function bandUrl() {
  if (!bandSource) {
    const [core, band] = await Promise.all(["splat-core.js?v=3", "worker-splat-band.js?v=4"].map(async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error("Could not load " + path);
      return response.text();
    }));
    bandSource = URL.createObjectURL(new Blob([core, "\n", band], { type: "text/javascript" }));
  }
  return bandSource;
}

/* Band helpers. Resolves to a gradient(p) function, or null when fitting
 * should run inline (one thread, or helpers could not start). */
async function createPool(target, width, height, background, cap, n, threads) {
  if (!(threads > 1) || typeof Worker === "undefined" || typeof importScripts !== "function") return null;
  const shared = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
  const size = n * Core.STRIDE;
  let targetBuffer = target.buffer, params = null, grads = null;
  if (shared) {
    targetBuffer = new SharedArrayBuffer(target.byteLength);
    new Float64Array(targetBuffer).set(target);
    params = new Float64Array(new SharedArrayBuffer(size * 8));
    grads = new Float64Array(new SharedArrayBuffer(size * 8 * threads));
  }
  const workers = [];
  try {
    const url = await bandUrl();
    await Promise.all(Array.from({ length: threads }, (_, i) => new Promise((resolve, reject) => {
      const worker = new Worker(url);
      workers.push(worker);
      const timer = setTimeout(() => reject(new Error("Splat helper did not start")), 10000);
      worker.onmessage = ({ data }) => { if (data.ready) { clearTimeout(timer); resolve(); } };
      worker.onerror = (event) => { clearTimeout(timer); event.preventDefault(); reject(new Error(event.message || "Splat helper failed")); };
      worker.postMessage({ cmd: "init", target: shared ? targetBuffer : target.slice().buffer, width, height, background, cap,
        ...(shared ? { params: params.buffer, grads: grads.buffer, index: i } : {}) });
    })));
  } catch (error) {
    console.warn("[splat] fitting on one thread:", error.message || error);
    workers.forEach((worker) => worker.terminate());
    return null;
  }
  const total = new Float64Array(size);
  let id = 0;
  const gradient = (p) => {
    const bands = Core.balanceRows(p, n, width, height, cap, threads), callId = ++id;
    if (shared) params.set(p);
    return Promise.all(workers.map((worker, i) => new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => { if (data.id !== callId) return; if (data.error) reject(new Error(data.error)); else resolve(data); };
      worker.onerror = (event) => reject(new Error(event.message || "Splat helper failed"));
      worker.postMessage(shared ? { cmd: "pass", id: callId, y0: bands[i][0], y1: bands[i][1] }
        : { cmd: "pass", id: callId, y0: bands[i][0], y1: bands[i][1], params: p.slice().buffer });
    }))).then((replies) => {
      total.fill(0);
      let loss = 0;
      replies.forEach((reply, i) => {
        loss += reply.loss;
        const g = shared ? grads.subarray(i * size, (i + 1) * size) : new Float64Array(reply.grad);
        for (let j = 0; j < size; j++) total[j] += g[j];
      });
      return { loss, grad: total };
    });
  };
  gradient.close = () => workers.forEach((worker) => worker.terminate());
  return gradient;
}

async function processSplat(rgba, width, height, config = {}, hooks = {}) {
  if (!(width > 0 && height > 0) || rgba.length !== width * height * 4) throw new Error("Invalid image dimensions");
  const started = Date.now();
  const count = Number(config.num_primitives ?? 2000);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Primitive count must be a positive integer");
  const iterations = Math.max(1, Math.round(Number(config.splat_iterations) || DEFAULT_ITERATIONS));
  const resolution = Math.max(32, Math.round(Number(config.splat_resolution) || DEFAULT_RESOLUTION));
  const seed = Number.isFinite(Number(config.splat_seed)) ? Number(config.splat_seed) : 0;
  let transparent = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { transparent = true; break; }

  const { fw, fh } = fitSize(width, height, resolution);
  const full = Core.premultiply(rgba);
  const target = Core.downsample(full, width, height, fw, fh);
  if (hooks.progress) hooks.progress(0, iterations, "init");
  const init = Core.initialize(target, fw, fh, count, seed);
  const fitter = Core.createFitter(target, fw, fh, init.params, init.background);
  const pool = await createPool(target, fw, fh, init.background, fitter.cap, count, Math.floor(Number(config.splat_threads) || 1));
  const meta = { iterations, resolution };
  let finished;
  try {
    finished = await fitter.run(iterations, 1, REDISTRIBUTE_EVERY, seed, {
      gradient: pool || undefined,
      each: (iter) => {
        if (hooks.cancelled && hooks.cancelled()) return false;
        if (hooks.progress && (iter % 10 === 0 || iter === iterations)) hooks.progress(iter, iterations, "");
        if (hooks.preview) hooks.preview(fitter, iter);
        if (hooks.checkpoint) hooks.checkpoint(() => buildResult(fitter.params, count, fitter.background, fw, fh, width, height, config, transparent, meta), iter);
        return true;
      },
    });
  } finally {
    if (pool) pool.close();
  }
  if (!finished) return null;
  const finalLoss = fitter.loss();
  const result = buildResult(fitter.params, count, fitter.background, fw, fh, width, height, config, transparent, { ...meta, finalLoss });
  // Full-size preview drawn from the exported elements, so it matches the editor.
  const preview = Core.renderElements(result.elements, width, height, result.config.pixel_per_unit, 1).rgba;
  const image = rgba.slice();
  if (!transparent) for (let i = 0; i < image.length; i += 4) image[i + 3] = 255;
  return { ...result, image_rgba: image.buffer, preview_rgba: preview.buffer, mask_gray: null, elapsed_seconds: (Date.now() - started) / 1000 };
}

if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = async ({ data: msg }) => {
    if (msg.cmd !== "process") return;
    let lastPreview = 0, lastCheckpoint = 0;
    const total = Math.max(1, Math.round(Number(msg.config.splat_iterations) || DEFAULT_ITERATIONS));
    try {
      const result = await processSplat(new Uint8ClampedArray(msg.rgba), msg.width, msg.height, msg.config, {
        progress: (step, all, phase) => postMessage({ type: "progress", jobId: msg.jobId, step, total: all, phase }),
        preview: (fitter, iter) => {
          const now = Date.now();
          if (now - lastPreview < 600 && iter !== 1) return;
          lastPreview = now;
          const rgba = Core.toRGBA8(fitter.render(), fitter.width, fitter.height);
          postMessage({ type: "progress", jobId: msg.jobId, step: iter, total, previewOnly: true,
            previewRGBA: rgba.buffer, previewWidth: fitter.width, previewHeight: fitter.height }, [rgba.buffer]);
        },
        // Pause & save keeps the last checkpoint; send one every few seconds.
        checkpoint: (build, iter) => {
          const now = Date.now();
          if (iter > 1 && now - lastCheckpoint < 3000) return;
          lastCheckpoint = now;
          postMessage({ type: "progress", jobId: msg.jobId, step: iter, total, previewOnly: true, checkpoint: build() });
        },
      });
      if (!result) postMessage({ type: "cancelled", jobId: msg.jobId });
      else postMessage({ type: "done", jobId: msg.jobId, result }, [result.image_rgba, result.preview_rgba]);
    } catch (error) {
      postMessage({ type: "error", jobId: msg.jobId, message: String(error.message || error), detail: String(error.stack || "") });
    }
  };
}
if (typeof module !== "undefined") module.exports = { processSplat, buildResult, fitSize };
