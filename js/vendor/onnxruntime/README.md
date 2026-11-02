# onnxruntime-web (CPU/WASM build)

Used only by `js/worker-importance.js` for automatic focus.

- Package: `onnxruntime-web` 1.31.1 (npm). Contents copied unmodified from `dist/`;
  the two ES modules are renamed from `.mjs` to `.js` (`ort.wasm.min.js`,
  `ort-wasm-simd-threaded.js`) so static servers send a JavaScript MIME type, and
  the worker passes their URLs through `env.wasm.wasmPaths`.
  `ort-wasm-simd-threaded.wasm` keeps its name.
- Licence: MIT, `LICENSES/onnxruntime-web-LICENSE.txt`; bundled third-party
  notices: `LICENSES/onnxruntime-ThirdPartyNotices.txt` (onnxruntime v1.31.1).
- Runs with the `wasm` execution provider and one thread; no GPU backend.

Model: `assets/models/unisal-salicon.onnx`, UNISAL static SALICON
(https://github.com/rdroste/unisal, revision `7f8ca1a7ecb3dbc1bf7fca837cb6186a85ac27d9`),
Apache-2.0, `LICENSES/UNISAL-LICENSE.txt`. Exported with `scripts/export-attention.py`;
SHA256 `728c58bf9478854f1c4e1c75354fc9a0b4cad8fe4cc900bdbc15428a1bfc9212`.
