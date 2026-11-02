# Automatic importance: implementation handoff for Sol

Status: shipped as the Focus detail option (Turbo, on by default) after four
held-out rounds; see `automatic-importance-status.md`. Measured results: `automatic-importance-status.md`.
Goal: improve meaningful detail at 400–1,000 shapes across photographs, illustrations,
animals, objects, text and scenes. Anime faces are not the primary target.

## Constraints and decisions

- Browser-only, GitHub Pages, CPU/WASM. Do not restore GPU code or add a server.
- Use general visual-attention prediction as a soft prior, existing structural
  analysis for fine detail, and the fitter's changing residual for placement.
- Attention prediction is not semantic classification. Do not label its output
  as detected faces, eyes, objects or text. Explicit semantic detectors are a
  later, separately validated extension, not required for this first version.
- Only Turbo changes. Maximum Detail and other engines retain their output.
- No masks, source-alpha reapplication, new primitives, count limits, hidden
  URL-only features or external image uploads. Keep cancellation and parallel jobs.
- Existing working-tree changes are intentional. Do not reset or overwrite them.
- Preserve the current structural-only path exactly when model guidance is off,
  unavailable, constant, invalid or has zero strength.

## Current integration map

Read these narrow areas first; do not reread all research or the whole repository:

| File | Responsibility |
| --- | --- |
| `third_party/primeval/crates/primeval-core/src/rgba/structure.rs` | Existing structural map, weights 1–4 |
| `third_party/primeval/crates/primeval-core/src/rgba/turbo.rs` | `initialize_detail_weights`, proposals, redistribution and reordering |
| `third_party/primeval/crates/primeval-core/src/rgba.rs` | `detail_weights`, weighted RGB loss and cached sums; alpha penalties |
| `js/worker-primeval.js` | Prepares input and invokes browser fitting runtime |
| `js/vendor/primeval/dist/request.js` | Whitelists render fields; new fields otherwise disappear |
| `js/vendor/primeval/dist/browser-runtime.js`, `worker-common.js` | Worker request transport and WASM call |
| `third_party/primeval/binding-wasm/src/lib.rs` | JS-to-Rust boundary and `Execution` setup |
| `third_party/primeval/crates/primeval-render/src/` | Execution options, decoded/resized input and model construction; trace these before editing |
| `js/app.js`, `index.html`, `css/`, `js/locales/` | Queue, controls and all 15 translations |
| `scripts/build-primeval.py`, `scripts/prepare-pages.py` | WASM builds and deployment dependency checks |

The structural map already affects RGB scoring, residual proposals and visible
contribution ranking. Reuse this mechanism rather than adding competing losses.
Changing weights requires rebuilding score and row caches. It must happen before
the first fitted shape, not mid-fit.

## Phase 1 — Freeze comparison and validate a model

Deliverables: reproducible benchmark manifest and a small model validation report
under ignored `reference/automatic-importance/`. No production behavior changes.

1. Save current Turbo outputs and metrics before modifying the fitter. Record
   source hash, working dimensions, count, seed, shape mode, browser, threads,
   device, cold/warm runtime and exact revision/diff. Retain every output.
2. Use all nine supplied images plus fixtures covering a real portrait, animal,
   product, text/signage, landscape, multiple subjects and a distracting texture.
   Use licensed/public-domain additions; keep private images out of Git.
3. Test 400 and 1,000 shapes, Mixed, seeds 42/43/44. Start pilots at 256 pixels;
   acceptance runs at 512 and selected original-size renders. Do not present
   128-pixel crops as evidence of full-resolution detail.
4. First evaluate EML-Net as a general attention reference. Record exact upstream
   revision, checkpoint hashes, model/weight licenses, preprocessing, input/output
   shapes and download size. Export an ONNX version with a pinned offline script.
   Compare PyTorch and ONNX attention maps numerically on fixtures before fitting.
5. Measure ONNX Runtime Web CPU/WASM on the actual laptop, including download,
   session creation, inference, memory and main-thread responsiveness. Try FP32
   first. Quantization is a separate parity/quality experiment, never assumed free.
6. If EML-Net is too heavy, do not ship it merely because weights exist. Evaluate
   a smaller general fixation model with official weights and verified licenses.
   U²-NetP may be tested as a foreground-prior baseline, but is not an equivalent
   replacement for fixation prediction or within-object detail importance.

Model references (browser readiness remains unverified):
- EML-Net: https://github.com/SenJia/EML-NET-Saliency
- U²-Net/U²-NetP: https://github.com/xuebinqin/U-2-Net
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/

Initial engineering targets, not promised results: warm analysis <=1 second,
cold local session initialization + inference <=3 seconds on the target laptop;
report network download separately. If unavailable, keep structural-only fitting
usable and report the blocker. Do not silently substitute a face-only detector.

## Phase 2 — Small analysis adapter with explicit contracts

Suggested new modules: `js/importance-analysis.js`, `js/worker-importance.js`.
Keep inference and preprocessing out of `app.js` and the fitter.

Proposed internal result:

```js
{
  width, height,
  values: Float32Array, // row-major, finite values in [0, 1]
  modelId, modelHash, preprocessingVersion,
  timings: { loadMs, inferenceMs, postprocessMs }
}
```

- One page-owned analysis service, one inference at a time, reused session.
  Fitting jobs can still run in parallel; do not duplicate a large model per job.
- Lazy-load pinned, locally hosted runtime/model assets only when enabled.
  Check Pages file limits before choosing packaging. Download/export tooling and
  large research checkpoints stay ignored; actual shipped assets must be deployed.
- Cache by decoded-image hash, dimensions, transparency/matte settings, model hash
  and preprocessing version. Bound cache memory with LRU eviction; do not retain
  all source images indefinitely. Use copies when transfer would detach cached data.
- Maintain request IDs; cancellation must not apply stale results to another job.
  If inference cannot abort, discard its result; allow worker termination/restart.
- Preserve aspect ratio using the model's documented preprocessing. Undo padding
  before returning the map. Do not stretch or crop away parts of the source.
- For transparent input, ignore RGB under zero alpha and composite against a
  documented neutral matte for inference. In opaque mode use the selected matte.
  Zero importance outside source coverage; never modify the fitted output's alpha.
- Use robust percentile normalization over visible pixels; constant/all-transparent
  maps return an explicit neutral result. Do not convert a flat map into high weights.
- Model errors fall back visibly to existing structure analysis, with a short reason.
  Export remains available. Missing assets must not block ordinary fitting.

## Phase 3 — Validated map transport and Rust fusion

Add an optional render field, tentatively `importance`, containing map dimensions,
values and strength. Use a typed array across JS workers; read it explicitly at
the WASM boundary. Do not assume existing serde request parsing accepts it.
Inspect the build script for generated JS provenance and update the maintained
source when present, so a rebuild cannot discard the integration.

1. Validate dimensions, checked pixel-count multiplication, exact array length,
   finite values, [0,1] range and strength. Reject malformed programmatic requests.
   The UI service may catch analysis failures and omit the map intentionally.
2. Carry the map through Rust `Execution` to the Turbo model construction point.
   Align it to the actual decoded/resized target dimensions in Rust, using one
   documented bilinear sampler. Test odd/non-square dimensions and letterboxing.
3. Add a focused setter to `RgbaModel`; keep map fusion in a small dedicated module
   or `structure.rs`, not a second optimizer. Freeze weights for the entire fit.
4. Start with this conservative, bounded ablation, not an asserted optimum:

   `weight = 1 + (structuralWeight - 1) * (1 + strength * attention)`

   Structural weights are currently 1–4. At strength 0.5 the bound is 1–5.5.
   Test strengths 0, 0.25 and 0.5. This emphasizes structure inside attended
   regions without allocating an entire smooth face/background large weight.
   If this misses low-contrast meaningful structure, test a separate small additive
   attention term; keep it as an explicit ablation, not an unexplained constant.
5. Do not multiply residual error twice: existing weighted residual proposals
   already respond to reconstruction error. Keep alpha penalties independent.
6. Recompute score and cached sums after installing the fused map. Preserve current
   redistribution/reorder guards. A weighted-loss decrease alone is not proof of
   better appearance. Do not weaken guards just to force benchmark improvements.
7. Build and verify both single-threaded and threaded WASM. Preserve existing
   Maximum Detail identity tests and exact no-map Turbo baseline results.

## Phase 4 — Visible optional UI

Only after the model passes the feasibility gate:

- Add a Turbo-only `Detail priority` selector: `Structure` and `Visual attention`.
  Keep Structure default until the quality gate passes. No anime-specific default.
- Show an `Analyzing image` progress phase. Do not fabricate percent completion
  for an inference call that supplies no incremental progress.
- Briefly identify the initial model download and fallback state; localize every
  label/hint in all 15 languages. Hidden controls occupy no space.
- Snapshot selection in each job's config; switching the current UI must not
  change queued jobs. Persist the choice using existing settings conventions.
- Save model/version, actual mode/fallback reason and analysis timings in result
  metadata. Keep export geometry and Lua/GIA formats unchanged.
- A diagnostic attention-map overlay belongs in the benchmark viewer first; do
  not confuse it with generated geometry or include it in exports.

## Phase 5 — Quality and release gates

Use the frozen structural baseline, identical counts/seeds/resolution/thread budgets.
Evaluate model-only, structure-only and fused variants. Choose parameters on a
tuning subset; report the remaining held-out images without retuning them.

- Measure premultiplied RGB reconstruction on black and white backgrounds,
  opaque-region RMSE, alpha error and clear-area spill; include global and crop views.
- Mark meaningful evaluation regions before seeing candidate outputs: eyes/mouth,
  animal features, lettering, distinctive object boundaries and small scene subjects.
  These annotations are evaluation-only, never passed to the fitter.
- Initial promotion gate: median meaningful-region RMSE improves >=5% across
  held-out cases; no category median worsens; global RMSE regression <=2% per image
  after seed aggregation; clear-area mean-alpha spill increase <=0.0001 absolute.
  These are proposed tolerances, not established guarantees. Report every failure.
- Visually review randomized, equally scaled output pairs. Reject visible loss of
  expressions/letter legibility even when aggregate metrics improve.
- Report full wall-clock costs including analysis, fit and export. Attention is a
  quality feature, not a promised speedup. Target warm total overhead <=10% at the
  same fit settings. Do not regain speed by quietly reducing steps/count/resolution.
- If it fails, keep it opt-in or unshipped, preserve outputs and document why.
  Do not declare universal semantic understanding from a few successful faces.

Required tests:
1. JS preprocessing/alignment, neutral map, hidden RGB, invalid maps, cache key,
   request cancellation, stale response and failure fallback.
2. Rust no-map/zero-strength parity, bounded deterministic weights, cache/scoring
   agreement, unchanged count, cancellation, alpha safety and non-square alignment.
3. Browser cold/warm runs, two queued images, cancellation during analysis,
   unavailable model, single-thread fallback and threaded fitting.
4. `npm test`, `npm run test:turbo`, `npm run test:alpha`, `npm run test:browser`,
   `npm run test:hosting`, `npm run test:deployment`, plus relevant native tests.
   Run browser and hosting suites sequentially because they share a port.
5. Verify project-subpath model/runtime fetches on the assembled Pages directory;
   extend deployment checks for dynamically fetched model/ORT assets. Check
   desktop and narrow layouts. Report optional skipped golden/Fengari checks.

## Sol execution instructions

Work phase by phase. Finish Phase 1 before choosing a production model. Each phase
must end with a short checkpoint: files changed, commands run, measured results,
open blocker and next step. Keep a machine-readable benchmark manifest and a small
status file in `reference/automatic-importance/`; do not paste raw logs into context.
Keep this plan and useful implementation notes tracked, generated reports ignored.

Start prompt:

> Read AGENTS.md and docs/development/automatic-importance-plan.md. Implement the
> plan in dependency order, starting with the frozen baseline and model feasibility
> pilot. Preserve existing uncommitted changes. Do not ship a model before verifying
> its licenses, browser inference and held-out quality. Use CPU/WASM only. Keep
> generic image support, existing exports, count selection and cancellation intact.
> Report measured results honestly; do not treat proposed thresholds as achieved.

Do not add face detectors, object segmentation, neural shape generation or a new
fitting backend in this first iteration. They are separate future experiments if
general attention plus structure demonstrably fails specific categories.
