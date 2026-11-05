/* Local Real-ESRGAN inference. Called inside the cancellable fitting worker. */
import * as ort from './vendor/onnxruntime/ort.wasm.min.js';
ort.env.wasm.wasmPaths = {
  mjs: new URL('./vendor/onnxruntime/ort-wasm-simd-threaded.js', import.meta.url).href,
  wasm: new URL('./vendor/onnxruntime/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
ort.env.wasm.numThreads = 1;
let session;
export async function upscale(rgba, width, height, progress = () => {}) {
  if (!Number.isSafeInteger(width * height) || width * height > 4194304) {
    throw new Error('AI_UPSCALE_LIMIT');
  }
  const started = performance.now();
  if (rgba.length !== width * height * 4 || width < 1 || height < 1) {
    throw new Error('AI_UPSCALE_INPUT');
  }
  session ??= await ort.InferenceSession.create(new URL('../assets/models/realesr-animevideov3.onnx', import.meta.url).href, {executionProviders: ['wasm']});
  const rgb = new Uint8Array(width * height * 3);
  // Extend visible edge colors through transparent pixels before RGB inference.
  const queue = new Int32Array(width * height), seen = new Uint8Array(width * height);
  let tail = 0;
  for (let i = 0; i < seen.length; i++) {
    rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    if (rgba[i * 4 + 3]) { seen[i] = 1; queue[tail++] = i; }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head], x = i % width;
    for (const j of [x ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
      if (j < 0 || j >= seen.length || seen[j]) continue;
      rgb.set(rgb.subarray(i * 3, i * 3 + 3), j * 3); seen[j] = 1; queue[tail++] = j;
    }
  }
  const result = new OffscreenCanvas(width * 2, height * 2), ctx = result.getContext('2d');
  const tile = 64, halo = 20;
  const total = Math.ceil(width / tile) * Math.ceil(height / tile);
  let step = 0;
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const left = Math.max(0, x - halo), top = Math.max(0, y - halo);
      const right = Math.min(width, x + tile + halo), bottom = Math.min(height, y + tile + halo);
      const w = right - left, h = bottom - top, n = w * h;
      const input = new Float32Array(n * 3);
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const source = ((top + py) * width + left + px) * 3, dest = py * w + px;
        for (let c = 0; c < 3; c++) input[c * n + dest] = rgb[source + c] / 255;
      }
      const tensor = new ort.Tensor('float32', input, [1, 3, h, w]);
      const outputs = await session.run({image: tensor}), output = outputs.output;
      const ow = w * 4, oh = h * 4, pixels = new Uint8ClampedArray(ow * oh * 4);
      for (let i = 0; i < ow * oh; i++) {
        for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.round(output.data[c * ow * oh + i] * 255);
        pixels[i * 4 + 3] = 255;
      }
      const canvas = new OffscreenCanvas(ow, oh);
      canvas.getContext('2d').putImageData(new ImageData(pixels, ow, oh), 0, 0);
      const tw = Math.min(tile, width - x), th = Math.min(tile, height - y);
      ctx.drawImage(canvas, (x - left) * 4, (y - top) * 4, tw * 4, th * 4, x * 2, y * 2, tw * 2, th * 2);
      tensor.dispose(); output.dispose(); progress(++step, total);
    }
  }
  // Alpha is resampled independently. The fitter subsequently reconstructs it.
  const alpha = new OffscreenCanvas(width, height), ac = alpha.getContext('2d');
  const mask = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) mask.set([255, 255, 255, rgba[i * 4 + 3]], i * 4);
  ac.putImageData(new ImageData(mask, width, height), 0, 0);
  ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(alpha, 0, 0, width * 2, height * 2);
  return {rgba: ctx.getImageData(0, 0, width * 2, height * 2).data, width: width * 2, height: height * 2,
    metadata: {model: 'Real-ESRGAN animevideov3', scale: 2, backend: 'wasm', tile, halo, milliseconds: performance.now() - started}};
}
