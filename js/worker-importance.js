/* Automatic focus: predicts where viewers look (UNISAL, CPU/WASM) and returns a
 * normalized map over the image. One request at a time; the page terminates this
 * worker to cancel a running analysis. */
import {prepareAttention, cropAttention, normalizeAttention} from './importance-analysis.js';
import * as ort from './vendor/onnxruntime/ort.wasm.min.js';

// Explicit file URLs: .js names keep the correct MIME type on any static server.
ort.env.wasm.wasmPaths = {
  mjs: new URL('./vendor/onnxruntime/ort-wasm-simd-threaded.js', import.meta.url).href,
  wasm: new URL('./vendor/onnxruntime/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
ort.env.wasm.numThreads = 1;
const MODEL = new URL('../assets/models/unisal-salicon.onnx', import.meta.url).href;
let session = null;

function visibleAlpha(rgba, width, height, crop) {
  // Alpha at the map's resolution decides which pixels set the normalization range.
  const source = new OffscreenCanvas(width, height);
  source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const canvas = new OffscreenCanvas(crop.width, crop.height), ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, crop.width, crop.height);
  const pixels = ctx.getImageData(0, 0, crop.width, crop.height).data, alpha = new Uint8Array(crop.width * crop.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  return alpha;
}

self.onmessage = async ({data}) => {
  const {id, rgba, width, height} = data;
  try {
    session ??= await ort.InferenceSession.create(MODEL, {executionProviders: ['wasm']});
    const pixels = new Uint8ClampedArray(rgba);
    const input = prepareAttention(pixels, width, height);
    const result = await session.run({image: new ort.Tensor('float32', input.tensor, [1, 3, input.height, input.width])});
    const cropped = cropAttention(result.attention.data, input.crop, input.width);
    const map = normalizeAttention(cropped, input.crop.width, input.crop.height, visibleAlpha(pixels, width, height, input.crop));
    self.postMessage({id, map}, map ? [map.values.buffer] : []);
  } catch (error) {
    self.postMessage({id, error: String(error && error.message || error)});
  }
};
