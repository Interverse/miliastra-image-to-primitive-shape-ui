/* Browser-native adaptation of GaussianImage's scale/rotation representation
 * and joint gradient optimization (https://github.com/Xinjie-Q/GaussianImage).
 * Original implementation: MIT, Xinjie Zhang, 2024. This independent JS
 * implementation uses analytic gradients + Adam, no Python/CUDA/downloads.
 * Source-over replaces accumulated summation to match exported game controls.
 * Parameter layout: cx, cy, log(sigmaX), log(sigmaY), angle, RGB, opacity.
 */
"use strict";
if (typeof importScripts === "function") importScripts("gaussian.js");
const G = typeof Gaussian !== "undefined" ? Gaussian : require("./gaussian.js");
const STRIDE = 9, TILE = 16;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function prepare(params, width, height) {
  const columns = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles = Array.from({ length: columns * rows }, () => []), splats = [];
  for (let k = 0; k < params.length; k += STRIDE) {
    const sx = Math.exp(params[k + 2]), sy = Math.exp(params[k + 3]);
    const c = Math.cos(params[k + 4]), s = Math.sin(params[k + 4]);
    const bx = 3 * Math.hypot(c * sx, s * sy), by = 3 * Math.hypot(s * sx, c * sy);
    const item = { k, sx, sy, c, s };
    splats.push(item);
    const x0 = Math.max(0, Math.floor((params[k] - bx) / TILE));
    const x1 = Math.min(columns - 1, Math.floor((params[k] + bx) / TILE));
    const y0 = Math.max(0, Math.floor((params[k + 1] - by) / TILE));
    const y1 = Math.min(rows - 1, Math.floor((params[k + 1] + by) / TILE));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles[y * columns + x].push(item);
  }
  return { columns, tiles, splats };
}

/* Exact reverse-mode derivative through ordered, premultiplied RGBA blending.
 * Prefixes are stored only for one sampled pixel, avoiding N×W×H storage.
 * Sampling rotates through pixel classes; loss/gradients use a fixed divisor.
 */
function evaluate(params, width, height, target, transparent, sampleStep = 1, phase = 0, gradients = true) {
  const { columns, tiles, splats } = prepare(params, width, height);
  const grad = gradients ? new Float64Array(params.length) : null;
  const pixels = gradients ? null : new Float32Array(width * height * 4);
  const stack = new Float64Array(params.length / STRIDE * 9);
  let loss = 0, count = 0;
  for (let pixel = phase; pixel < width * height; pixel += sampleStep) {
    const x = pixel % width + 0.5, y = Math.floor(pixel / width) + 0.5;
    const tile = tiles[Math.floor(y / TILE) * columns + Math.floor(x / TILE)];
    let r = transparent ? 0 : 1, g = r, b = r, a = r, used = 0;
    for (const item of tile) {
      const { k, sx, sy, c, s } = item;
      const dx = x - params[k], dy = y - params[k + 1];
      const u = (c * dx + s * dy) / sx, v = (-s * dx + c * dy) / sy;
      const q = u * u + v * v;
      if (q >= 9) continue;
      const e = Math.exp(-0.5 * q), weight = (e - G.EDGE) * G.NORM;
      const alpha = params[k + 8] * weight, at = used * 9;
      if (gradients) {
        stack[at] = k; stack[at + 1] = r; stack[at + 2] = g; stack[at + 3] = b;
        stack[at + 4] = a; stack[at + 5] = u; stack[at + 6] = v;
        stack[at + 7] = e; stack[at + 8] = alpha; used++;
      }
      r += alpha * (params[k + 5] - r);
      g += alpha * (params[k + 6] - g);
      b += alpha * (params[k + 7] - b);
      a += alpha * (1 - a);
    }
    const p = pixel * 4;
    if (pixels) { pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = a; }
    if (!target) continue;
    let dr = r - target[p], dg = g - target[p + 1], db = b - target[p + 2];
    let da = transparent ? a - target[p + 3] : 0;
    loss += dr * dr + dg * dg + db * db + da * da; count++;
    if (!gradients) continue;
    for (let j = used - 1; j >= 0; j--) {
      const at = j * 9, k = stack[at], alpha = stack[at + 8];
      const u = stack[at + 5], v = stack[at + 6], e = stack[at + 7];
      const dAlpha = dr * (params[k + 5] - stack[at + 1]) + dg * (params[k + 6] - stack[at + 2]) +
        db * (params[k + 7] - stack[at + 3]) + da * (1 - stack[at + 4]);
      const common = dAlpha * params[k + 8] * e * G.NORM;
      const { sx, sy, c, s } = splats[k / STRIDE];
      grad[k] += common * (u * c / sx - v * s / sy);
      grad[k + 1] += common * (u * s / sx + v * c / sy);
      grad[k + 2] += common * u * u; grad[k + 3] += common * v * v;
      grad[k + 4] += common * u * v * (sx / sy - sy / sx);
      grad[k + 5] += dr * alpha; grad[k + 6] += dg * alpha; grad[k + 7] += db * alpha;
      grad[k + 8] += dAlpha * (e - G.EDGE) * G.NORM;
      dr *= 1 - alpha; dg *= 1 - alpha; db *= 1 - alpha; da *= 1 - alpha;
    }
  }
  if (grad) for (let i = 0; i < grad.length; i++) grad[i] *= 2 / Math.max(1, count);
  return { loss: loss / Math.max(1, count), grad, pixels };
}

function downsample(rgba, width, height, fitWidth, fitHeight, transparent) {
  const out = new Float32Array(fitWidth * fitHeight * 4), weights = new Float64Array(fitWidth * fitHeight);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const q = (Math.min(fitHeight - 1, Math.floor(y * fitHeight / height)) * fitWidth + Math.min(fitWidth - 1, Math.floor(x * fitWidth / width)));
    const a = rgba[p + 3] / 255; weights[q]++;
    for (let c = 0; c < 3; c++) out[q * 4 + c] += rgba[p + c] / 255 * a + (transparent ? 0 : 1 - a);
    out[q * 4 + 3] += transparent ? a : 1;
  }
  for (let i = 0; i < weights.length; i++) for (let c = 0; c < 4; c++) out[i * 4 + c] /= Math.max(1, weights[i]);
  return out;
}

function initialize(count, width, height, target, transparent, seed = 1) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const params = new Float64Array(count * STRIDE);
  const sigma = Math.max(0.7, Math.sqrt(width * height / count) * 0.7);
  for (let i = 0; i < count; i++) {
    const k = i * STRIDE;
    let pixel;
    for (let attempt = 0; attempt < 40; attempt++) {
      pixel = Math.floor(random() * width * height);
      if (!transparent || target[pixel * 4 + 3] > random() * 0.8) break;
    }
    params[k] = pixel % width + 0.5; params[k + 1] = Math.floor(pixel / width) + 0.5;
    const scale = i < Math.max(1, count * 0.08) ? Math.max(width, height) / 5 : sigma * (0.6 + random());
    params[k + 2] = Math.log(scale); params[k + 3] = Math.log(scale * (0.7 + random() * 0.6));
    params[k + 4] = random() * Math.PI;
    const a = transparent ? Math.max(0.01, target[pixel * 4 + 3]) : 1;
    for (let c = 0; c < 3; c++) params[k + 5 + c] = clamp(target[pixel * 4 + c] / a, 0, 1);
    params[k + 8] = 0.7;
  }
  return params;
}

async function optimize(params, width, height, target, transparent, options = {}) {
  const iterations = clamp(Math.round(Number(options.iterations) || 600), 1, 3000);
  const first = evaluate(params, width, height, target, transparent, 1, 0, false).loss;
  const m = new Float64Array(params.length), v = new Float64Array(params.length);
  let bestLoss = first, best = params.slice();
  const step = Math.max(1, Math.ceil(width * height / 4096));
  for (let t = 1; t <= iterations; t++) {
    if (options.cancelled && options.cancelled()) return null;
    const { grad } = evaluate(params, width, height, target, transparent, step, t % step);
    const decay = 0.15 + 0.85 * (1 - t / iterations);
    const momentScale = 1 / (1 - 0.9 ** t), varianceScale = 1 / (1 - 0.999 ** t);
    for (let i = 0; i < params.length; i++) {
      m[i] = 0.9 * m[i] + 0.1 * grad[i]; v[i] = 0.999 * v[i] + 0.001 * grad[i] * grad[i];
      const p = i % STRIDE;
      const lr = (p < 2 ? 0.3 : p === 4 ? 0.025 : 0.035) * decay;
      params[i] -= lr * m[i] * momentScale / (Math.sqrt(v[i] * varianceScale) + 1e-8);
      if (p === 0) params[i] = clamp(params[i], -width * 0.25, width * 1.25);
      else if (p === 1) params[i] = clamp(params[i], -height * 0.25, height * 1.25);
      else if (p === 2 || p === 3) params[i] = clamp(params[i], Math.log(0.35), Math.log(Math.max(width, height)));
      else if (p >= 5) params[i] = clamp(params[i], p === 8 ? 0.005 : 0, p === 8 ? 0.995 : 1);
    }
    if (t % 20 === 0 || t === iterations) {
      const loss = evaluate(params, width, height, target, transparent, 1, 0, false).loss;
      if (loss < bestLoss) { bestLoss = loss; best = params.slice(); }
      if (options.progress) options.progress(t, iterations);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { params: best, initialLoss: first, loss: bestLoss };
}

function toElements(params, fitWidth, fitHeight, width, height, config) {
  const scale = clamp(Number(config.image_scale) || 1, 0.1, 100);
  const alphaScale = clamp(config.output_alpha == null ? 1 : Number(config.output_alpha), 0, 1);
  const out = [];
  for (let k = 0; k < params.length; k += STRIDE) {
    const rgb = [5, 6, 7].map((c) => Math.round(clamp(params[k + c], 0, 1) * 255));
    const alpha = params[k + 8] * alphaScale;
    // Transform the covariance, rather than the radii, when rounding the
    // fitting resolution produces slightly different X/Y resize factors.
    const sx = Math.exp(params[k + 2]), sy = Math.exp(params[k + 3]);
    const c = Math.cos(params[k + 4]), s = Math.sin(params[k + 4]);
    const ax = width / fitWidth, ay = height / fitHeight;
    const xx = ax * ax * (c*c*sx*sx + s*s*sy*sy), yy = ay * ay * (s*s*sx*sx + c*c*sy*sy);
    const xy = ax * ay * c * s * (sx*sx - sy*sy), delta = Math.hypot(xx - yy, 2 * xy);
    const angle = Math.atan2(2 * xy, xx - yy) / 2;
    out.push({ type: "ellipse", shape: "blurred_circle", primitive_type: "blurred_circle", image_type: "basic",
      image_asset_ref: G.ASSET,
      center: { x: params[k] * width / fitWidth * scale, y: -params[k + 1] * height / fitHeight * scale },
      size: { rx: 3 * Math.sqrt(Math.max(1e-12, (xx + yy + delta) / 2)) * scale,
        ry: 3 * Math.sqrt(Math.max(1e-12, (xx + yy - delta) / 2)) * scale },
      rotation: { z: -angle * 180 / Math.PI },
      color: "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join(""), alpha,
      packed_color: ((Math.round(alpha * 255) << 24) | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0,
    });
  }
  return out;
}

async function processGaussian(rgba, width, height, config = {}, hooks = {}) {
  if (!(width > 0 && height > 0) || rgba.length !== width * height * 4) throw new Error("Invalid Gaussian image dimensions");
  const started = Date.now();
  const count = clamp(Math.round(Number(config.num_primitives) || 400), 1, 3000);
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { hasAlpha = true; break; }
  const transparent = !!config.enable_png_mode && hasAlpha;
  const resolution = clamp(Math.round(Number(config.gaussian_resolution) || 128), 32, 512);
  const ratio = Math.min(1, resolution / Math.max(width, height));
  const fw = Math.max(1, Math.round(width * ratio)), fh = Math.max(1, Math.round(height * ratio));
  const target = downsample(rgba, width, height, fw, fh, transparent);
  const initial = initialize(count, fw, fh, target, transparent, Number(config.seed) || 1);
  const fitted = await optimize(initial, fw, fh, target, transparent, { ...hooks, iterations: config.gaussian_iterations });
  if (!fitted) return null;
  const elements = toElements(fitted.params, fw, fh, width, height, config);
  const origin = config.origin || {}, custom = origin.type === "custom";
  const center = { x: origin.type === "top_left" ? 0 : custom ? Number(origin.x) : width / 2,
    y: origin.type === "top_left" ? 0 : custom ? Number(origin.y) : height / 2 };
  const scale = clamp(Number(config.image_scale) || 1, 0.1, 100);
  for (const el of elements) el.relative = { x: el.center.x - center.x * scale, y: el.center.y + center.y * scale };
  // Render quantized/exported parameters, including global opacity, so the
  // thumbnail matches Canvas/SVG/GIA rather than a higher-precision model.
  const renderParams = new Float64Array(fitted.params.length);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i], k = i * STRIDE;
    renderParams.set([el.center.x / scale, -el.center.y / scale, Math.log(el.size.rx / scale / 3), Math.log(el.size.ry / scale / 3),
      -el.rotation.z * Math.PI / 180, ...[1, 3, 5].map((at) => parseInt(el.color.slice(at, at + 2), 16) / 255), el.alpha], k);
  }
  if (hooks.cancelled && hooks.cancelled()) return null;
  const pixels = evaluate(renderParams, width, height, null, transparent, 1, 0, false).pixels;
  const preview = new Uint8ClampedArray(rgba.length), image = rgba.slice();
  for (let i = 0; i < width * height; i++) {
    const p = i * 4, a = pixels[p + 3];
    for (let c = 0; c < 3; c++) {
      preview[p + c] = Math.round(255 * (a > 1e-8 ? pixels[p + c] / a : 0));
      if (!transparent) image[p + c] = Math.round(rgba[p + c] * rgba[p + 3] / 255 + 255 - rgba[p + 3]);
    }
    preview[p + 3] = Math.round(a * 255);
    if (!transparent) image[p + 3] = 255;
  }
  return { mode: "fill", image_center: center, image_size: { width, height }, elements_count: elements.length, elements,
    config: { mode: "fill", engine: "gaussianimage-browser", gaussian_profile: "normalized-3sigma-approximation", blending: "source-over",
      allowed_shapes: ["blurred_circle"], pixel_per_unit: 1 / scale, unit_scale: scale, image_scale: scale,
      num_primitives: count, enable_png_mode: !!config.enable_png_mode, output_has_transparency: transparent,
      fill_variant: transparent ? "png" : "mask", gaussian_resolution: resolution,
      gaussian_iterations: clamp(Math.round(Number(config.gaussian_iterations) || 600), 1, 3000),
      training_size: { width: fw, height: fh },
      initial_loss: fitted.initialLoss, final_loss: fitted.loss }, mask: { enabled: false },
    image_rgba: image.buffer, preview_rgba: preview.buffer, mask_gray: null, elapsed_seconds: (Date.now() - started) / 1000 };
}

if (typeof self !== "undefined" && typeof importScripts === "function") {
  let cancelled = false;
  self.onmessage = async ({ data: msg }) => {
    if (msg.cmd === "cancel") { cancelled = true; return; }
    if (msg.cmd !== "process") return;
    cancelled = false;
    try {
      const result = await processGaussian(new Uint8ClampedArray(msg.rgba), msg.width, msg.height, msg.config, {
        cancelled: () => cancelled,
        progress: (step, total) => postMessage({ type: "progress", jobId: msg.jobId, step, total }),
      });
      if (!result) postMessage({ type: "cancelled", jobId: msg.jobId });
      else postMessage({ type: "done", jobId: msg.jobId, result }, [result.image_rgba, result.preview_rgba]);
    } catch (error) { postMessage({ type: "error", jobId: msg.jobId, message: String(error.message || error) }); }
  };
}
if (typeof module !== "undefined") module.exports = { evaluate, initialize, optimize, downsample, toElements, processGaussian };
