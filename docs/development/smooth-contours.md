# Source-aware contour fitting

Turbo automatically prioritizes smoother contours. Existing shape choices remain
unchanged: Mixed still searches ellipses, rectangles and pinned triangles;
triangle-only fitting still emits only triangles. No selectable combinations,
new primitives, neural model, source-alpha mask or post-render blur were added.
Maximum Detail retains its pinned fitting objective and output.

## Algorithm

`primeval-core/src/rgba/contours.rs` computes a multichannel structure tensor from
the original premultiplied RGBA target. Its coherence and normal direction guide
candidate boundary alignment. Original source corners relax the penalty, so an
actual pointed feature is not treated like an unwanted tooth on a smooth edge.
Corner-chain analysis uses a bounded256px workspace; the direction field and all
fitting steps use the selected full working resolution.

Every allowed family competes under the new ranking. Polygon vertices incur a
cost for unsupported sharp turns. Sampled polygon and ellipse boundaries incur
a cost when their directions disagree with a coherent source boundary. The cost
estimates paint contrast from source samples outside the boundary and uses
later-layer transmission for visibility. Source-flat paint regions and fully
hidden turns have no effective penalty. This is an approximation to visible
boundary quality rather than an exact count of final composite corners. It is a geometric prior,
not semantic recognition of lines, faces or objects.

The prior participates in initial search and conditional geometry/family
refinement. Its local ranking term is capped relative to fitted pixel gain so
useful paint does not lose to invisible paint solely because of the prior.
Whole-pass acceptance and Turbo replacement/reordering use pixel loss plus the
visible contour cost. Pixel-prefix sums, closed-form color fitting and reported
reconstruction loss remain in their original units. A rejected regularized
refinement pass restores progress geometry for pause/export checkpoints.

Configured search rounds, user counts, primitive constraints, cancellation and
parallel jobs are preserved. All requested controls and fitting steps still run.
As in the original solver, refinement can make redundant controls transparent;
the benchmark records these rather than claiming every control is useful.

## Integration

The browser accepts `render.contourSmoothing`, finite0..4. The library default0
retains the original path. The website automatically uses1 in Turbo and0 in
Maximum Detail, recording `primeval_contour_smoothing` in result/retry/partial
metadata. There is no new shape-selection control. The brief automatic-behavior
hint is localized in all15 languages. Single and threaded WASM were rebuilt;
cache versions include `smooth-contours-1`.

## Retained comparisons

Ignored `reference/smooth-contours/` contains every source, setting, Drawing,
native PNG/SVG, exported game-control SVG and256/1024px vector render. Slider
comparisons use those exported vectors. Working resolution is128px except the
explicit512px run. Counts are80/400/1000 and seeds42/43/44. These are development
comparisons, not a held-out human quality study.

| Comparison | Measured result |
|---|---|
| Mixed curves,400 controls, seeds42/43/44 | Matched-edge tangent error lower by31.8–42.3% |
| Mixed transparent loop,400 controls, same seeds | Tangent error lower by39.4–44.2%; alpha spill lower in these samples |
| Triangle-only curves,400 controls, seeds43/44 | Tangent error lower by29.9–41.1% |
| Mixed curves/transparent loop,1000 controls, seed42 | Tangent error lower by23.4%/33.4% |
| Zhongli Mixed,400 controls, seeds42/43/44 | Tangent error changes−0.7%,−4.4%,+0.7%; improvements are not uniform |
| Zhongli Mixed,1000 controls, seed42 | Tangent error lower by14.0%, with lower pixel error and alpha spill |
| Sharp-corner fixture, Mixed400/1000 | Tangent error worsens29.5%/21.7%; points/opening remain present, and measured missing-edge fraction is0 |
| Lettering fixture, Mixed400 | Tangent error lower21.7%; all three annotated-by-threshold openings retain their background interiors |
| Curves,512px working resolution, Mixed400 | Tangent error lower8.2%; pixel error also lower |

Tangent error compares output edge direction with nearby source edges. Missing
and unmatched edges, source error, alpha spill/deficit and source-opening
retention remain separate diagnostics. Fewer edges or triangles are not automatic
quality rewards. The opening check is evaluation-only threshold geometry for
these fixtures, not a general lettering/identity detector. No calibrated beauty
score or universal quality improvement is claimed.

Regressions remain visible: sharp angular artwork can soften, unmatched edges
sometimes increase, and a few seed/image combinations increase spill or lose
alignment. Triangle-only curves remain piecewise straight. Low-count missing
details and the previously retired economical-construction problem are not
solved by this change. Runtime is generally higher: the retained Zhongli400 run
took7.2→10.1s, and1000 took12.2→20.1s on the test machine; timings vary with load.

## Reproduce and verify

Use `scripts/benchmark-smooth-contours.cjs` with a fresh `--out`, explicit
`--counts`, `--seeds`, `--detail`, `--families` and `--strengths 0,1`. Synthetic
source resolution is controlled separately with `--source-size`. Optional
`--image PATH` adds a supplied raster without committing it. Run
`scripts/evaluate-smooth-contours.py RUN` and `scripts/smooth-contour-gallery.py RUN`
for independent exported-boundary diagnostics and a vector slider page.

Runs: `screen-v1` retains the weaker initial corner-only attempt; `screen-v2`,
`validation-v2`, `seeds-v2`, `lettering-v2` and `high-resolution-v2` retain the final
direction-aware implementation. Six zero-strength Drawing/SVG/PNG outputs also
byte-match the original-objective screen. Source/WASM hashes and exact settings
are retained with results.

Checks cover hidden/same-paint/transparent costs, source-corner relaxation,
zero-setting equivalence, original pixel-loss accounting, guarded refinement,
count/family preservation, invalid strengths, both WASM variants, pause/export,
hidden RGB, transparency, browser/narrow layout and GitHub Pages deployment.
Historical fill goldens and Lua VM execution are skipped when absent by the
existing harness. See the retained logs for exact check results.
