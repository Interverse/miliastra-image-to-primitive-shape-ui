# Pause and save

For Primeval, Legacy and Gaussian, `Pause & save` is available on a running job and beside its generation preview
after its first exportable checkpoint. It stops that worker immediately and
opens the most recent completed shapes in the normal result editor. JSON, PNG,
SVG, GIA, Lua and batch downloads use those retained shapes.

This ends the current run. Re-process starts a new run using the original
settings. Cancel still discards a running job. Pausing one job leaves the queue
and other fitting workers active.

The label `Paused` and exported metadata identify partial results explicitly:
`partial`, `paused`, `partial_reason`, `requested_num_primitives` and
`completed_primitives`. The original requested count is retained. During
refinement all requested controls may already exist while their optimization is
unfinished. Work is never silently truncated.

Primeval checkpoints retain native drawing geometry from full and incremental
progress updates, including layer replacements during refinement. They are
converted to the existing game assets at the source dimensions. Legacy exports
completed primitives; Gaussian exports the current quantized ellipse parameters
with its existing blur/paint semantics. No source-alpha mask is applied to the
paused render. The pause action does not wait for a stalled worker to answer a
message. It uses the last checkpoint already delivered to the main thread.

Implemented in `js/progress-result.js`, `js/app.js` and fitting worker checkpoint
messages, with labels in all 15 languages. The pause control remains disabled
until completed geometry is available; it cannot recover an unfinished first
primitive.

## Retired experiment

The failed nested-group, learned construction and scaffold experiment has been
removed from runtime selection and native fitting. Original sources, tools,
tests and research notes are preserved under ignored
`reference/retired-construction-experiment-2026-11-04/`, with inventory hashes.
Previously generated research results remain under ignored `reference/`.
The older generated `.pages-site` containing stale style-experiment modules was
also archived; current deployment artifacts are assembled from active sources.

Focus Detail, Upscale, established fitting modes, native vector previews and
ordinary experimental tuning options are preserved. Saved configurations naming
the retired `groups` option ignore it.

## Validation

`npm run test:pause` exercises real threaded and single-thread fallback workers,
Primeval Turbo/Maximum Detail, Legacy and Gaussian, partial metadata, JSON/PNG/
SVG/GIA downloads, desktop/narrow layout, and independence of other queued or
parallel jobs. Optional historical fill goldens and Lua VM execution are skipped
when unavailable by the existing harness.

Run `npm test`, `npm run test:browser`, `npm run test:hosting` and
`npm run test:deployment` for unit/export, pinned fitting, queue/cancellation and
static-host regressions. Logs from this change are retained in
`reference/pause-*-tests.log` and `reference/pause-save/`.
