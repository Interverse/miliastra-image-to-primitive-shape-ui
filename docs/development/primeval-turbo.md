# Experimental Turbo fitting

This is a candidate, not a replacement for Maximum Detail. Select **Turbo** in the Optimization dropdown on upload or
re-process. Turbo is the default for new jobs. It runs
entirely in browser WASM and supports the same three sprite families and Mixed.
The selected form option controls the solver; URL flags no longer override it.
Worker callers can pass `primeval_turbo: true`; returned metadata marks it and
sets `primeval_exact: false`.

## Algorithm and change map

- `primeval-core/src/rgba/turbo.rs`: residual peaks from distinct cells;
  color-consistent local moments at several scales estimate center, covariance
  and orientation. Proposals become allowed ellipse/rectangle/isosceles-triangle
  geometry, compete alongside random exploration, and undergo adaptive mutation.
- `primeval-core/src/rgba.rs`: isolated Turbo proposal hook. Original search,
  RNG and alpha weights remain unchanged when Turbo is off. Turbo uses eight
  searches with 32 random candidates each, structured starts and patience 50.
- `primeval-render/src/turbo.rs`: direct source premultiplied RGBA fitting without
  the complete RGB reference or three-fit Mixed portfolio. Four passes with six
  starts refine using export-exact coverage. The initial canvas is repainted
  exactly before refinement so its acceptance test uses the exported composite.
- Empty-alpha error weight is 32 in Turbo versus 16 in the original fitter.
  Source hidden RGB is ignored. No source mask is applied to exports.
- Existing opaque background controls are preserved; each fitted primitive is
  one asset. Counts are never truncated or cut off by a timer. Cancellation and
  normal export stay available. Failed quality comparisons do not block export.

These are heuristic changes, not bit-identical acceleration. The explicit per-fit
search/refinement effort does not cap the user's requested primitive count.

## Pilot evidence and limitations

All figures below are single development runs, not statistical speed claims.
Some verification/build work overlapped trials, so repeat isolated paired timing
before publishing performance claims. Benchmark inputs were resized to the stated
fitting detail; these are not full-resolution source comparisons. Every trial,
including rejected variants, is retained under ignored `reference/primeval-turbo/`.

| Image / detail / shapes | Maximum PSNR | Fastest PSNR / seconds | retained Turbo PSNR / seconds |
|---|---:|---:|---:|
| Nahida / 128 / 400 | 27.94 | 26.91 / 7.69 | 28.06 / 5.96 |
| Furina / 128 / 400 | 28.94 | 28.37 / 12.67 | 28.64 / 7.53 |
| Furina / 512 / 400 | 25.78 | 25.29 / 29.47 | 25.54 / 27.61 |

The first four-pass 512 trial took 37.96s while other work was active; the final
repeat produced identical quality/geometry in 27.61s. This variability illustrates
why these single trials do not establish a reproducible speedup. The matching 512 Maximum Detail run took 144.80s and scored 25.78 dB. Never combine the 128-input
Maximum results with the 512-input results as a quality comparison.

Nahida overall PSNR improves, but opaque RMSE increases from 11.30 to 11.53 and
spill increases from 0.00002490 to 0.00007395 normalized alpha. Furina's opaque
RMSE improves from 10.69 to 10.24 and spill falls from 0.00017856 to 0.00009021,
but overall error remains worse than Maximum. Thus the quality gate is NOT met
across even these two cases. No universal quality improvement is established.

A first low-effort candidate ran in 3.11s but lost quality. A later 512-detail
two-pass trial ran in 24.24s but scored only 24.75 dB, below Fastest; that schedule
was rejected and the four-pass refinement restored. The final 512 trial approaches Fastest runtime, but repeatable runtime parity
and preserved Maximum Detail quality have not yet been established.

## Reproduction and next work

```sh
node scripts/benchmark-primeval-turbo.cjs input.png 400 128
npm run test:turbo
```

`PRIMEVAL_TURBO_PROFILES=turbo` runs only the candidate. The benchmark retains
source, target, PNG, SVG, geometry and metrics for every profile. Compare final
outputs, fixed crops and alpha spill; rendering FPS is not fitting time.

Tests cover shared count, all supported shapes, deterministic native fitting,
cancellation, hidden RGB, empty transparency, backgrounds, native PNG/SVG,
non-square/enlarged output and GIA in threaded and fallback builds. Existing
alpha/frozen-output, browser, hosting and deployment suites remain required.

At 512 detail, retained Turbo has lower opaque RMSE (15.09 vs Maximum 15.32)
and lower empty-area spill (0.00007965 vs 0.00013105), but worse overall
PSNR (25.54 vs 25.78) and alpha MAE (0.01207 vs 0.00942). Runtime approaches
Fastest in this pilot; the partial-alpha quality gap is still unresolved.
The local comparison gallery is `reference/primeval-turbo/index.html`.

Next: profile structured-search coverage and full-resolution RGBA replay without
reducing refinement, calibrate the direct-source loss against fine-detail crops,
and benchmark all nine inputs at 400/1,000 counts with original source sizes.
The experiment does not yet justify enabling Turbo by default.

## Contribution redistribution (2026-10-31)

After Turbo refinement, rank layers by squared visible alpha contribution using
suffix transmittance. Test the eight weakest layers (or all layers if fewer than
eight), removing one and proposing an exact-coverage residual replacement at the
top of the stack. This bounds additional search effort, never the user's count.
Accept only lower weighted RGBA loss with non-increasing opaque premultiplied
RGB error and empty-area alpha spill. Restore the full incumbent on rejection.
Cancellation is checked between trials and while ranking. Accepted replacements
publish all changed layer indices so the live preview follows the final ordering.

This is a first structural search stage, not coupled group refinement or a global
minimum-shape solution. Alpha MAE is not an acceptance constraint. The first
Nahida comparison at 128 detail / 400 shapes changed PSNR 28.06177 → 28.08673,
opaque RMSE 11.53313 → 11.52590, spill 0.00007395 → 0.00000905, and alpha MAE
0.00525405 → 0.00535793. Runtime 6.29 → 5.90 seconds is a single-run observation,
not a speedup claim. Both runs and all outputs: `reference/redistribution/`.

## Detail priority and structural trials (2026-10-31)

Turbo now uses deterministic target contrast at radii 1, 3 and 7 pixels to weight
RGB error from 1 to 4. The map uses alpha-compatible neighbors, ignores transparent
RGB, and applies consistently to candidate fitting, residual proposals, refinement,
and visibility ranking. The alpha penalty doubles (partial 4→8, empty 32→64)
to compensate for stronger RGB emphasis. Exact/Maximum Detail remains unchanged.
This is local structure detection, not facial recognition: texture can also receive
priority, and a tiny face lost during downsampling cannot be recovered.

Alternate redistribution trials rebuild two adjacent layers together. A separate
stage tests distributed adjacent layer swaps followed by color/opacity refitting.
Every retained structural trial improves weighted loss with non-increasing opaque
error and empty-area spill versus its immediate incumbent. Count stays fixed;
these are effort limits, not control limits. Global quality versus the previous
unweighted optimizer is not guaranteed. Split/merge with explicit region analysis,
full-resolution progressive fitting, and user-designated semantic focus remain open.

Retained 400-control / 128-detail pilots, before → after:
- Nahida PSNR 28.08673→28.39697; opaque RMSE 11.52590→10.57636;
  alpha MAE 0.00535793→0.00557646; spill 0.00000905→0.00002566.
- Furina PSNR 28.63651→28.53227; opaque RMSE 10.24219→10.00255;
  alpha MAE 0.00958826→0.01062754; spill 0.00009021→0.00006858.
- Manually selected face crops (128-pixel target coordinates): Nahida
  (20,30)-(95,75) composite RMSE 10.7514→10.3412; Furina (50,52)-(71,75)
  11.6837→11.9320. Thus face fidelity is NOT consistently improved.

Artifacts, including the rejected weaker-alpha trial and face crops, are under
`reference/detail-priority/`. Timing observations are single runs, not speed claims.

## Automatic structural regions (2026-10-31)

`rgba/structure.rs` replaces independent contrast weighting with connected color
region analysis. Flood fill compares adjacent pixels and the seed color to stop
slow color drift from merging an entire gradient. Only alpha-compatible neighbors
participate. Regions accumulate gradient tensors, contrast boundaries, color means,
area and bounding boxes. Deterministic rules classify smooth regions, oriented
contours, texture, and compact detail; area-weighted color rarity, boundary contrast,
and compactness produce relative importance. Nearby region priorities and multiscale
contrast distribute emphasis over both sides of fine features. Final weights stay
between 1 and 4. No positional/face template, learned model, or mask is used.

The shared weights govern residual proposal ranking, analytical fitting, refinement,
and control-retention importance. Remaining reconstruction error updates proposals
throughout fitting. All regions retain baseline weight 1: allocation is soft, with
no fixed per-region control quota. This is structural classification, not semantic
understanding of faces/expressions. Smooth but semantically important regions may
still rank below distracting structure. This only affects Turbo.

Paired 400-shape / 128-detail trials against the previous contrast-weighted fit:
- Nahida: PSNR 28.39697→28.25743, opaque RMSE 10.57636→10.89604,
  alpha MAE 0.00557646→0.00572342, spill 0.00002566→0.
- Furina: PSNR 28.53227→28.84653, opaque RMSE 10.00255→9.99958,
  alpha MAE 0.01062754→0.00933982, spill 0.00006858→0.00005808.
- Previously selected face crops: Nahida RMSE 10.34120→9.78963 (5.3% lower),
  Furina 11.93205→10.83565 (9.2% lower). These are small manually selected crops
  at 128 detail; the algorithm was not given their coordinates.
- Runtime observations 6.32s and 6.77s are not reproducible speed claims.

All outputs retained in `reference/structure-priority/`. Native tests cover
classification, bounded deterministic importance, distinctive feature preference,
transparent hidden-RGB invariance, weighted fitting math and budget/cancellation.

## Lines and curves (2026-11-02)

Owner question: why are straight lines and simple curves built from several shapes,
and can that be improved? Turbo now holds a **64:1 rectangle aspect cap** and a
**5 degree triangle minimum angle** for every fit (`primeval-render/src/turbo.rs`).
Upstream Primeval caps rectangles at 8:1 and every polygon angle at 15.5 degrees;
the game has neither limit (rectangles scale freely; the isosceles triangle sprite
scales on x and y), so a thin straight line can be one rectangle and a tapering
stroke one triangle. Maximum Detail and Fast are unchanged and Turbo stays
deterministic. Polygon validity and Turbo rectangle projection follow the held
values; holders are counted, so the defaults return when the last fit ends.

Where the error is: 70-99% of the remaining Turbo error lies within one pixel of a
target edge (Sobel > 0.05 on either matte), so edges are the right target.

Native runs (`reference/lines-curves/`, `turbo_lab` example, 300 s per-fit limit,
none failed). Global RMSE of the black/white composites, per-image mean over seeds
42/43/44, candidate versus current Turbo:

| Set | Size / shapes | Median | Improved | Time |
| --- | --- | --- | --- | --- |
| Dev, 21 images (h1-h3 illustrations, text, photos) | 256 / 400 | -2.69% | 18/21 | +0.6% |
| Pilot, 9 owner images | 512 / 400 | -0.93% | 8/9 | -5.5% |
| Held-out-4, Focus detail on | 512 / 400 | -0.69% | 17/21 | +0.8% |
| Held-out-4, Focus detail on | 512 / 1000 | -0.88% | 19/21 | +0.2% |
| Held-out-4, Focus detail off | 512 / 400 | -0.87% | 19/21 | +4.5% |

Dev sweep (median, improved): 5 degrees / 64:1 -2.69% (18); 3 / 128:1 -2.49% (18);
8 / 32:1 -1.56% (16); triangles only (5 / 8:1) -1.28% (16); rectangles only
(15.5 / 64:1) -0.68% (16). Illustrations gain most (firebird -9%, workbench -10%,
EV car icon -20%). Held-out category medians are all negative at both counts.

**Not met:** the pre-registered spill gate (max increase 0.0001,
`reference/lines-curves/frozen-criteria.json`) failed with Focus detail on, on two
single seeds: wp-bivalves 400 (+0.000147) and Ferris 1000 (+0.000398, a 63-pixel
opaque patch in the transparent gap beside the claw; RMSE 1.29 -> 3.70). The current
Turbo shows the same defect on Ferris seed 42 at 400 shapes. Without Focus detail
the gate passed (max +0.000057). Mean held-out spill with Focus was 0.000005 before
and 0.000010 after. Eight seeds (42-49) on the two affected images, Focus on, runs
with spill above 0.0001 (current -> candidate) and median RMSE change: Ferris 400
4 -> 3, -5.2%; Ferris 1000 1 -> 3, -1.7%; bivalves 400 0 -> 1, +1.1%; bivalves 1000
0 -> 0, +3.5%. The defect (paint over a transparent gap that later shapes do not
remove) is a greedy failure both versions share; the candidate shows it somewhat
more often at 1000 shapes. Revert by setting `RECT_ASPECT`/`TRIANGLE_ANGLE` in
`primeval-render/src/turbo.rs` to 8 and 15.5.

Edge-aligned proposals (research option, off; `rgba/lines.rs`): edges come from a
multichannel Sobel structure tensor with non-maximum suppression, hysteresis and
sub-pixel location; chains split into straight segments (Douglas-Peucker, total
least squares), circle arcs (algebraic fit, RMS < 0.6 px) and corners. Each step
ranks them by the residual within two pixels and proposes rectangles and triangles
with one side on the edge, discs on arcs and corner wedges. Results:

- Alone, pilot 512/400: +0.35% (3/9 improved). With the 64:1 cap: -0.88% versus
  current Turbo, but the cap alone gives -0.42%.
- Hill-climbing the top eight edges in eight extra rounds: -1.39% (9/9) at +33%
  time; eight extra random rounds at the same cost give -1.63% (9/9). The gain is
  search effort, not alignment.
- With the relaxed limits: pilot -0.05% (5/9), dev -1.34% (12/21, worst +9.9%), at
  +7.6% time. Greedy search and refinement already align shape boundaries with the
  edges that matter; aligned candidates add little. Left off.

Search effort is a separate lever: eight extra random rounds per step gave -1.63%
on the pilot at about +28% time before the limits changed. With the relaxed limits
it is weaker (pilot 512/400, 3 seeds, versus the final default): eight extra rounds
for the first quarter of steps -0.44% (5/9) at +11% time, first half -0.32% (8/9)
at +15%, all steps -0.79% (8/9) at +21%. Not adopted; the lab option
`Execution::extra_rounds` remains for research.

### Transparent-gap cleanup (2026-11-02)

The spill failures above are paint over a nearly transparent gap that later shapes
never remove. After refinement, redistribution and reordering, Turbo now runs
`clear_gaps` (`rgba/turbo.rs`). A gap pixel is at most 25% opaque in the source
and at least 50% more opaque in the result; images without four such pixels skip
the pass. First, only the layers covering gap pixels are refined once, with opacity
error within two pixels of the gap weighted 16 times more. Then up to eight trials
each remove the layer painting the most gap opacity and place a fresh search step
on top (a rejected layer is skipped). Every change is kept only if the composite
error over black and white falls; the shape count never changes.

Eight seeds, Focus on, runs with spill above 0.0001 and mean RMSE (old -> relaxed
-> relaxed plus cleanup): Ferris 400 4/3.078 -> 3/2.824 -> 2/2.702; Ferris 1000
1/1.601 -> 3/2.176 -> 1/1.715; bivalves 400 0/7.360 -> 1/7.402 -> 1/7.370;
bivalves 1000 0/3.330 -> 0/3.325 -> 0/3.315. Across those 32 runs: 5 defect runs
before, 7 with the relaxed limits alone, 4 with the cleanup. On held-out-4 at 400
with Focus, the final default matches the relaxed-only results (median -0.69%,
17/21) and one run (bivalves seed 42) still exceeds the spill gate by 0.000025.

Larger settings, final default versus the old limits (pilot, single runs unless
noted): 512 px / 2000 shapes 8/10 runs improved (p-1 and p-3 with three seeds:
p-1 +6.9%, -1.0%, -2.0%; p-3 +1.6%, -2.9%, -3.4%; others -1.0% to -3.3%); 768 px /
1000 shapes 5/6 improved, median -0.75%. 2000-shape fits at 512 px took 46-213 s
natively under load, so slower devices can approach the 5-minute limit.

Timing: alternating runs under identical load measured the final default at -2% to
+5% of the old Turbo (Layla 23.4-24.1 s versus 24.6-24.9 s; bicycle 29.6-31.2 s
versus 29.4-29.6 s). Batch-to-batch timing differences above (+37%) came from
machine load, not the change.

Not verified here: how the game displays very thin rectangles (up to 64:1) and 5
degree triangles; check a few exports in the game.

### Faint holes and dark patches (2026-11-02)

Owner report (Lumine, 256 px, 400 shapes, Focus on): the mouth was missing and
transparent areas looked darker. Findings:

- **Mouth:** the mouth is a tiny, low-contrast stroke. Across ten seeds (native,
  Focus on) both the previous Turbo and the new limits miss it on two seeds; the
  browser always uses seed 42, which happened to miss it with the new engine and
  not with the old one. It is not a systematic regression. A manual focus area
  over the mouth draws it reliably.
- **Dark patches:** the source has faint holes inside the character (gaps between
  hair strands at 16-25% opacity). Early large opaque shapes cover them, later
  shapes cannot make pixels transparent again, and premultiplied scoring then
  prefers near-black paint there. Both engines did this on some seeds (previous:
  3/10, new limits: 2/10). The exported PNG, the result canvas and the generation
  preview otherwise matched; the preview's dark checkerboard is a display style.

Fix (`mark_faint_holes`, `rgba/turbo.rs`): pixels under 35% opacity with no clear
pixel within two pixels count as clear for opacity error (weight 64 instead of 8),
so a hole is not covered at an eighth of the cost. Silhouette edges (next to clear
pixels), faint regions larger than 2% of the image (glows, bubbles) and images whose
holes cover under 0.05% of the pixels keep the old weights; images without such
holes produce identical output. A first version that weighted every faint pixel
removed all defects but raised median RMSE by 3.5% on 23 transparent images.

| Set (Focus on, 512 detail, 400 shapes) | Runs with dark hole paint (>50 px) | RMSE |
| --- | --- | --- |
| Lumine, 10 seeds: previous / new limits / with fix | 3 / 2 / 0 | 17.44 / 16.69 / 16.65 |
| 23 transparent images x 3 seeds: before / after fix | 12 / 3 | median +0.00%, mean +0.01%; 54/69 runs identical |

Lumine's mouth-region error returns to the previous engine's level (12.8 versus
12.9; 13.5 without the fix). The owner image p-1 trades +3.2% RMSE for 85-90% fewer
dark hole pixels; p-6 improves 4.0%.

### Spill-aware reordering (2026-11-02, research option, off)

Owner question: can a reorder post-process with readjustment remove spill of shapes
onto other features? The existing `reorder_turbo` tests about 12 adjacent swaps with
a colour/opacity refit. `reorder_spill` (`rgba/turbo.rs`, variant bit 18) ranks
layers by harm, the loss each adds on pixels where deleting it alone would help
(`removal_terms`, chunked like `removal_costs`), moves the most harmful layer just
below the earlier layer covering most of those pixels, refits only that layer's
geometry, colour and opacity, and keeps the move only if the loss falls with no
more opaque error or spill.

Pilot, 512 / 400, seeds 42-44, Focus on, versus the default: 16 trials median
-0.01% (7/9, best -0.17%) at +22% time; 32 trials -0.01% (9/9) at +33%. Spill
onto neighbouring features is mostly what the loss prefers at this shape count;
moving a layer under a feature loses what it was drawing elsewhere. Not adopted.

### Shape merging (2026-11-02, research option, off)

Owner question: can combining shapes free controls for detail elsewhere?
`merge_turbo` (`rgba/turbo.rs`, variant bit 19) picks two layers at most 16 apart
in the stack with similar colour and opacity (squared RGBA distance under 0.01)
whose bounding boxes touch, replaces them with one shape fitted to the moments of
their combined coverage (each allowed family tried), refits it in place, and spends
the freed control on a fresh search step on top. 16 trials.

Pilot, 512 / 400, seeds 42-44, Focus on, versus the default: median +0.00%
(4/9 changed, best -0.19%) at +33% time; 512 / 2000 (4 images): no change at +67%.
Logged trials show why: merging two layers raises the loss by a few to a few hundred
units and the freed step usually wins slightly more back, but the freed shape
typically adds a little paint at a transparent edge, which the strict "no more
opaque error or spill" guard rejects. Accepting on the composite error over black
and white instead (variant bit 21) gave mean -0.10% (median 0) at +42% time. Greedy
search and refinement leave little redundancy to recover by merging; not adopted.

## Low-count detail program (2026-11-02, research options, off)

Task: recognizable small detail at 400/1000/2000 shapes across all content, judged
at display size rather than from enlarged working-size PNGs. Tools, runs, metrics
and review sheets are in ignored `reference/lowcount/` (`README` lines at the top of
each script). Nothing here changes the default fit; the shipped WASM was rebuilt
from this source and the native default output is byte-identical to the retained
baseline runs.

**Measurement.** `turbo_trace` (lab example) writes snapshots every N steps, after
each refinement phase, per-layer removal costs, and renders of the exported
geometry at display sizes (`render_drawing`, not enlarged pixels). `metrics.py`
adds to the global RMSE: small-feature retention (components of |DoG(1,3)| > 0.03
from 3 px to 0.5% of the image, high-pass projection kept >= 50%), box retention,
edge precision/recall within 1 px, and opacity excess/deficit with defect
components. Synthetic fixtures (`fixtures.py`: strokes, curves, holes) have known
geometry.

**Tracing.** Fischl at 400, seeds 42-49: the mouth is either drawn late (after
step 375) or never; refinement, redistribution, reordering, gap cleanup and export
never removed it. The failure is allocation, not destruction, so multiscale
fitting, local joint repair and contour/display-stable terms were not pursued:
nothing they protect is being lost.

**Ablations** (development set: 12 images incl. Fischl, Layla, parrots, text,
texture, landscape, object, portrait; 400 and 1000; seeds 42-44; Focus maps on).
Relative RMSE and the change in the share of retained small features:

| Option (lab parameter) | RMSE median | Features | Fischl mouth at 400 |
| --- | --- | --- | --- |
| Weighting, cap 8 floor 4 | +3.3% | +0.16 | 0.67 -> 0.94 |
| Weighting, cap 16 floor 8 | +6.4% | +0.25 | - |
| + salience gate (`feature_gate`) | +1.35% | +0.076 | 0.95 |
| + 8% weight budget (`feature_budget`) | +0.08% | +0.033 | 0.95 |
| Feature-fitted proposals, 8/step | +0.00% | +0.005 | - |
| Equal-effort control: 3 more random candidates | +0.02% | +0.001 | - |

Weighting gives each compact mark a floor on its total weighted contrast (capped
multiplier on the mark and a one-pixel surround); the gate scales it by Focus
attention (or the structural score without Focus); the budget limits the added
weight to a share of the total, which mostly scales down photographs and texture
(hundreds of marks, 0.2-0.6 added weight before the budget). Proposals were no
better than the equal-effort control. Synthetic fixtures were already fitted
almost perfectly at 400 (all features retained, RMSE 0.3-1.6) and did not
discriminate.

**Fresh validation, not adopted.** Acceptance thresholds were frozen first
(`reference/lowcount/acceptance.txt`). Sixteen category-balanced images not used in
development (portraits, animals, text, scenes, landscapes, texture, objects, two
transparent illustrations), 400/1000/2000, seeds 42-44, 144 paired fits, no
failures: RMSE median +0.74% (27/144 better), retained features +0.033 (120/144
better), opacity unchanged, time +4.4%. The apple illustration at 400 rose 5.1%
(2.09 -> 2.18 absolute), failing the +3% group limit. Blinded display-size review
(1024 px, random sides, judged before reading the key): base preferred on 6 sheets,
candidate on 1, one tie. On the development set the same review had favoured the
candidate 5 of 6. The metric gain is real but it does not read as better at display
size on new images, so the option stays off.

**Opacity repair.** Wider gap thresholds (target 0.95 or 0.6, excess 0.15 or 0.25,
alpha boost 32) on six transparent images: RMSE within +/-0.1%, a few fewer tiny
excess specks on one image. The remaining opacity defects at these counts are
scattered edge pixels; the existing gap cleanup already handles real gaps. Defaults
unchanged.

**Blurred circles.** All-soft (the shipped Gaussian engine) versus all-hard Turbo,
seven images at 400 and 1000, scored at the Turbo working size: soft loses global
RMSE in 14/14 (median +22.7%) and sharp regions (within 2 px of an edge) 14/14
(+26.7%), but wins smooth regions in 8/14 (median -5.5%), all photographs and
animals. A hybrid could help smooth photographic areas. It was not implemented:
the blurred-circle asset (106057) has no calibration of its in-game falloff, and
the comparison also differs in optimizer, so parity with the game cannot be
claimed. Calibrate the asset in the game first.

**Not verified:** in-game rendering of any output from this program.

### Experimental settings (UI)

Turbo's settings and the retry panel have an "Experimental" dropdown with eight
research options in any combination, all off by default. The choice is stored in
the job config as `primeval_experiments` and mapped in `js/worker-primeval.js`
(`EXPERIMENTS`) to the engine's `render.experimental` (`lineVariant`,
`extraRounds`, `labParams`) or `redistribution`:

| Option | Engine setting |
| --- | --- |
| Small-feature weighting | `feature_cap=16,feature_floor=8,feature_gate=1,feature_budget=0.08` |
| Small-feature proposals | `feature_proposals=8` |
| Edge-aligned proposals | line variant 15 (all edge kinds) |
| Extra search rounds | 8 more rounds on every step |
| Spill-aware reordering | variant bit 18 |
| Shape merging | variant bits 19 and 21 (composite-error acceptance) |
| Wider gap cleanup | `gap_target=0.95,gap_excess=0.15` |
| Measured redistribution | `redistribution: "measured"` |

The shape count and cancellation are unchanged; most options make fits slower
(all eight on a 96 px test image at 60 shapes: 5.1 s versus 2.25 s). Measurements
for each are in the sections above; none is a default.

