# Integration notes — COMPLETE

All items from the parity integration checklist are done and enforced by the
suites (see README.md). Final status:

- worker-fill.js: dual flatten paths (float64 shaper_core / float32
  primitive_backend), Go premultiplied target, original-alpha weighting,
  `random_seed` plumbing, Go-exact core (gorand/gomath/goraster),
  PyNum rounding throughout the glue. → `fill/run_tests.js` +
  `e2e/run_fill_e2e.js` bit-exact.
- worker-outline.js: Shapely-exact geometry (geometry.js), cv2-exact
  rasterization/chamfer DT (imaging.js), scipy-exact gaussian
  (PyNum.scipyGaussianFilter1d), PyNum rounding, exact Python `%` in
  cursorToIndex (a double-mod normalization flipped searchsorted at exact
  vertex arcs — found via case03), sqrt(dx²+dy²) not Math.hypot.
  → `e2e/run_outline_e2e.js` bit-exact (8/8, fdlibm-pinned goldens).
- app.js: exact PNG decode + EXIF neutralization (decode agent);
  gia-export.js replicates server.py glue exactly — including NOT
  forwarding `is_background` and erroring on `packed_color=None`
  (the original's currently-broken decoration export). → `e2e/run_gia_e2e.js`
  byte-identical + error parity.
- Browser environment: `e2e/browser_smoke.html` — same cases in real
  workers, ALL PASS (serve the repo root and open the page; a stale-cache
  reload may be needed after changing worker files).
