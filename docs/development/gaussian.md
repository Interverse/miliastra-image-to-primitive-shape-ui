# Gaussian implementation

Gaussian mode always selects blurred circles and hides solid-shape choices.
The current browser adaptation uses source-over blending and game asset 106057.
Its bounded colors, radial falloff and export quantization differ from additive
Gaussian research renderers; research-code output parity is not claimed.

Fitting steps, resolution and count are user controlled. Large step counts are
not silently capped; cancellation remains available. More steps cannot overcome
all representation limits, particularly sharp corners at small shape budgets.
PNG mode supports the existing transparency workflow.

`js/worker-gaussian.js`, `gaussian.js` and `gaussian-seed.js` implement
GaussianImage, the only supported Gaussian fitter. Image-GS and Instant-GI
dispatch, selectors, model files and dedicated inference dependencies have been
removed from the website.

Run `node tests/gaussian/run_tests.js` for fitting, GIA and Lua regressions.
Research, experiments and model-conversion tools remain in ignored `reference/`.
