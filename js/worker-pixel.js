/* Pixel-perfect job worker: exact rectangles, no fitting (see pixel-perfect.js).
 * It also counts the controls a copy would need, which selects Pixel-perfect
 * automatically (cmd "count"). */
"use strict";
importScripts("pixel-perfect.js?v=3");

/* Average controls per GIF frame, or Infinity once it cannot stay under the
 * threshold. One frame needing 10x the threshold also stops the count, so large
 * photo-like frames are rejected quickly. */
async function gifControls(data, type) {
  if (typeof ImageDecoder === "undefined") return Infinity;
  const decoder = new ImageDecoder({ data, type: type || "image/gif", preferAnimation: true });
  try {
    await decoder.tracks.ready; await decoder.completed;
    const count = decoder.tracks.selectedTrack.frameCount, budget = PixelPerfect.THRESHOLD * count;
    let total = 0, canvas = null, context = null;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      let rgba, width, height;
      try {
        width = image.displayWidth; height = image.displayHeight;
        if (!canvas || canvas.width !== width || canvas.height !== height) {
          canvas = new OffscreenCanvas(width, height); context = canvas.getContext("2d", { willReadFrequently: true });
        }
        context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0);
        rgba = context.getImageData(0, 0, width, height).data;
      } finally { image.close(); }
      const limit = Math.min(budget - total, 10 * PixelPerfect.THRESHOLD), controls = PixelPerfect.controls(rgba, width, height, limit);
      if (controls >= limit) return Infinity;
      total += controls;
    }
    return total / Math.max(1, count);
  } finally { decoder.close(); }
}

self.onmessage = async ({ data: msg }) => {
  if (msg.cmd === "count") {
    let controls = Infinity;
    try {
      controls = msg.gif ? await gifControls(msg.gif, msg.type)
        : PixelPerfect.controls(new Uint8ClampedArray(msg.rgba), msg.width, msg.height, PixelPerfect.THRESHOLD);
    } catch { controls = Infinity; }
    postMessage({ type: "count", id: msg.id, controls });
    return;
  }
  if (msg.cmd !== "process") return;
  const started = Date.now();
  try {
    const rgba = new Uint8ClampedArray(msg.rgba), result = PixelPerfect.process(rgba, msg.width, msg.height, msg.config || {});
    // The rectangles reproduce the source exactly; Opacity does not apply.
    const preview = rgba.slice(), image = rgba.slice();
    postMessage({ type: "progress", jobId: msg.jobId, step: 1, total: 1, phase: "" });
    postMessage({ type: "done", jobId: msg.jobId, result: { ...result, image_rgba: image.buffer, preview_rgba: preview.buffer, mask_gray: null,
      elapsed_seconds: (Date.now() - started) / 1000 } }, [image.buffer, preview.buffer]);
  } catch (error) {
    postMessage({ type: "error", jobId: msg.jobId, message: String(error.message || error), detail: String(error.stack || "") });
  }
};
