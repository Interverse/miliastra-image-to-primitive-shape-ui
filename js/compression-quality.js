/* Pixel-buffer validation. RGB metrics use premultiplied values so invisible
 * RGB never counts as detail. Alpha is checked independently. No dependencies.
 */
"use strict";
const CompressionQuality = (() => {
  const PRESETS = {
    // Starting policies, explicitly configurable; not perceptual guarantees.
    exact: {mae: 0, max_error: 0, ssim: 1, edge_mae: 0, alpha_max: 0, local_mae: 0},
    high: {mae: 0.5, max_error: 4, ssim: 0.995, edge_mae: 0.5, alpha_max: 0, local_mae: 1},
    balanced: {mae: 3, max_error: 24, ssim: 0.98, edge_mae: 3, alpha_max: 2, local_mae: 5},
  };
  function measure(reference, output, width, height, thresholds = PRESETS.high) {
    if (reference.length !== width * height * 4 || output.length !== reference.length) throw Error("Invalid quality image dimensions");
    const total = width * height, heatmap = new Uint8ClampedArray(total * 4);
    const channels = [new Float32Array(total * 3), new Float32Array(total * 3)];
    let error = 0, square = 0, maximum = 0, differing = 0, alphaMax = 0, alphaError = 0;
    for (let i = 0; i < total; i++) {
      const p = i * 4, a = reference[p + 3] / 255, b = output[p + 3] / 255;
      let changed = reference[p + 3] !== output[p + 3], pixelMax = Math.abs(reference[p + 3] - output[p + 3]);
      alphaMax = Math.max(alphaMax, pixelMax); alphaError += pixelMax;
      for (let c = 0; c < 3; c++) {
        const x = reference[p + c] * a, y = output[p + c] * b, d = Math.abs(x - y);
        channels[0][i * 3 + c] = x; channels[1][i * 3 + c] = y;
        error += d; square += d * d; maximum = Math.max(maximum, d); pixelMax = Math.max(pixelMax, d);
        if (d > 1e-7) changed = true;
      }
      if (changed) differing++;
      heatmap[p] = Math.min(255, pixelMax * 8); heatmap[p + 1] = Math.min(255, pixelMax * 2); heatmap[p + 3] = 255;
    }
    let edgeError = 0, edgeCount = 0, edgeMax = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      for (const next of [x + 1 < width ? p + 3 : -1, y + 1 < height ? p + width * 3 : -1]) {
        if (next < 0) continue;
        let strength = 0;
        for (let c = 0; c < 3; c++) strength = Math.max(strength, Math.abs(channels[0][next + c] - channels[0][p + c]));
        if (strength < 12) continue;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs((channels[1][next + c] - channels[1][p + c]) - (channels[0][next + c] - channels[0][p + c]));
          edgeError += d; edgeMax = Math.max(edgeMax, d); edgeCount++;
        }
      }
    }
    // Non-overlapping 8x8 RGB SSIM plus spatial 8x8 errors. Worst local
    // error is a hard gate; an excellent global score cannot hide a lost dot.
    let ssim = 0, windows = 0, worstSSIM = 1, localMax = 0, worst = null;
    for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
      let score = 0, localError = 0, n = Math.min(8, width - x) * Math.min(8, height - y);
      for (let c = 0; c < 3; c++) {
        let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
        for (let j = y; j < Math.min(height, y + 8); j++) for (let i = x; i < Math.min(width, x + 8); i++) {
          const p = (j * width + i) * 3 + c, a = channels[0][p], b = channels[1][p];
          sx += a; sy += b; xx += a * a; yy += b * b; xy += a * b; localError += Math.abs(a - b);
        }
        const mx = sx / n, my = sy / n, vx = Math.max(0, xx / n - mx * mx), vy = Math.max(0, yy / n - my * my), cov = xy / n - mx * my;
        score += ((2 * mx * my + 6.5025) * (2 * cov + 58.5225)) / ((mx * mx + my * my + 6.5025) * (vx + vy + 58.5225));
      }
      score /= 3; ssim += score; windows++; worstSSIM = Math.min(worstSSIM, score);
      const local = localError / (n * 3);
      if (local > localMax) { localMax = local; worst = {x, y, width: Math.min(8, width - x), height: Math.min(8, height - y)}; }
    }
    const mse = square / (total * 3);
    const metrics = {mae: error / (total * 3), max_error: maximum, differing_pixels: differing,
      differing_percent: 100 * differing / total, ssim: ssim / windows, worst_local_ssim: worstSSIM,
      edge_mae: edgeError / Math.max(1, edgeCount), edge_max: edgeMax,
      alpha_mae: alphaError / total, alpha_max: alphaMax, local_mae: localMax, worst_region: worst,
      psnr_db: mse ? 10 * Math.log10(255 * 255 / mse) : null};
    const failed = Object.keys(PRESETS.high).filter(key => key === "ssim" ? metrics[key] < thresholds[key] : metrics[key] > thresholds[key] + 1e-7);
    return {metrics, thresholds: {...thresholds}, failed, classification: differing === 0 ? "pixel-perfect" : failed.length ? "quality-regression" : "near-lossless", heatmap};
  }
  return {PRESETS, measure};
})();
if (typeof module !== "undefined") module.exports = CompressionQuality;
