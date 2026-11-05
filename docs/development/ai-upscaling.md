# Local AI upscaling

The Primeval upload and retry controls offer experimental AI upscaling. Enabling it automatically enhances the source before fitting. The default is off while output quality is evaluated.

The browser loads the bundled Real-ESRGAN animevideov3 ONNX model and runs single-thread CPU/WASM inference inside the fitting worker. It uses 64px source tiles with 20px context. The native 4× network output is resampled to 2×. RGB is extended through transparent areas from nearby visible pixels before inference. Alpha is resampled separately before fitting. Final transparency comes from fitted primitives.

The source image, export size, image scale and automatic Focus analysis retain the original source dimensions. The enhanced source feeds fitting at the selected Detail resolution, capped at the enhanced source size. Choosing Detail 512 still fits at 512 even when AI generates a larger input. Result metadata records the model, scale, backend, tile/context sizes and enhancement time. Cancellation terminates the fitting worker during either enhancement or fitting. Separate fitting jobs remain concurrent. Input above 4,194,304 pixels fails explicitly to bound output buffers.

The experimental setting can affect color, texture and fine feature appearance. It does not create verified ground-truth detail. The bundled model is specialized for animation and illustration. Photos require separate evaluation.

## Reproducible measurements

`scripts/export-upscaler.py` exports official weights with a strict state-dict load. The model card and BSD-3-Clause license accompany the runtime asset. Native ONNX CPU parity with PyTorch passed with max absolute channel error 0.000003666 on a seeded 24×24 tensor.

`scripts/test-ai-upscale.cjs` runs enhancement on the user's two WebP splash images and Varka PNG in Chrome CPU/WASM, then fits original and enhanced sources using the existing native research Turbo executable. Images and outputs remain local under ignored `reference/ai-upscale/`. The source images have no established redistribution permission and are excluded from runtime assets.

Measured enhancement times on this machine were about 59.9s, 62.1s and 96.5s, respectively. These are one-run browser measurements. The comparison matrix uses 400/1000/2000 shapes, Detail 512, seed 42, Mixed geometry and four native fitting threads, with Focus off in both variants. A supplemental Varka pair uses 400 shapes and Detail 1024. The results are a development pilot. Native research fitting is not proof of output equivalence to the current browser fitting binary.

All 20 paired fitting outputs completed and passed requested shape/game element count checks. Visual inspection of all three 2000-control comparisons and the Varka 400-control Detail-1024 pair found no consistent improvement. Composition remains similar with changes in local shape placement. Varka's facial features are still lost at 400 controls in both higher-Detail variants. This judgment is an unblinded developer review, not calibrated human preference evidence. The gallery retains every result for inspection. Enhancement adds about one minute for the 1080px sources and 1.6 minutes for Varka, compared with approximately 13–62 seconds per native Detail-512 fit in this run.

`scripts/render-ai-comparisons.cjs` parses and checks the shape counts and game element conversions, then freshly renders SVG geometry at 1024px in Chrome. `scripts/ai-upscale-gallery.py` builds the retained comparison page and settings manifest. Browser SVG renders have not been verified against in-game captures.

## Local review

Serve the repository root over HTTP. The application is available at the root URL. The experiment gallery is `reference/ai-upscale/comparison.html` under the same server. The current local test server uses port 8322.

Use `PLAYWRIGHT_MODULE` to locate the installed Playwright package. Run `node tests/primeval/run-ai-upscale.cjs` against the repository server on port 8322. It verifies real WASM enhancement through the fitting worker, source/export dimensions, enhanced working resolution, exact requested count and explicit input limits.

Relevant regressions include `npm test`, `npm run test:browser`, `npm run test:hosting`, and `python scripts/prepare-pages.py reference/ai-upscale/pages`. Historical golden fixtures and Lua VM execution may be skipped by the existing suite when their optional dependencies are unavailable.
