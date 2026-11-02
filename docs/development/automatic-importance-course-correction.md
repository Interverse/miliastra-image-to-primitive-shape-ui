# Automatic importance: course correction

Review date: 2026-11-01. Supersedes the next-step recommendations in the
status document; historical measurements remain unchanged.

## Diagnosis

Two rounds demonstrate modest region-error gains, not a demonstrated reduction
in the number of shapes needed for recognizable details. More fusion sweeps
are unlikely to answer the missing question. Do not relax gates to ship a model.

The current prior changes RGB scoring, residual proposals and layer ranking at
once. Increasing it therefore confounds better search with accepting a different
error tradeoff. `refine=0` still changes scoring during greedy insertion; it is
not a proposal-only experiment. A broad fixation map also does not specify the
small contours that make an object or letter recognizable.

Concrete fitter concerns to investigate, not established causes:

- `turbo_proposals` takes the maximum-error pixel in each of 64 cells and uses
  eight cells. A tiny peak can displace an extended, reconstructible feature.
- Moment estimates combine target-color similarity and residual magnitude.
  Disconnected, similarly colored details can produce a shape spanning the gap.
- Redistribution ranks layers by weighted visible alpha energy, not the actual
  error caused by removing them. A small essential stroke can rank below a large
  redundant patch. Only eight replacement trials are made, regardless of count.

## Repair experimental validity first

- Region union RMSE weights large boxes more than small details. Report individual
  regions and an equal-region aggregate alongside the existing metric. Neither
  RMSE nor Sobel error establishes readable text or preserved identity.
- Seed averages can hide individual spill failures. Report paired changes,
  absolute errors, intervals and worst-seed outcomes; three seeds do not establish
  that a regression is harmless noise. Keep the original limits visible.
- The evaluator enumerates successful candidates and silently skips missing
  baselines. Missing candidates/seeds and absent annotations can evade gates.
  Require an explicit expected-run manifest and fail incomplete comparisons before
  any further promotion decision.
- Benchmark resume currently accepts any existing results.json at the same path.
  Require matching source, model, preprocessing, WASM and fitting-option hashes.
  A newly written invocation manifest does not prove the provenance of old results.
- Attention cache keys currently contain only the source hash. Include model and
  preprocessing hashes. The runner now explicitly writes all fusion options so
  cached legacy options cannot override requested defaults. Inspection found all
  45 current cache entries used strength 0.5 and no additive/refine fields; this
  particular inheritance bug does not explain the recorded regression pattern.

## Next experiment: identify the bottleneck

Use a small, fixed selection from the existing 25 tuning images at 400 shapes,
512px, paired seeds. Include text, animal, object, scene and transparency. Preserve
all existing outputs. Keep the fresh held-out set untouched.

1. Measure attention overlap with the already annotated details, including missed
   small regions. Inspect full images and native-resolution crops.
2. Compare structural baseline, existing guided scoring, and **proposal-only**
   guidance: generate extra candidate locations using attention, but score and
   accept candidates with unchanged structural/alpha objectives. Preserve all
   baseline search work and count; report added work and wall time explicitly.
3. Compare a deterministic center prior and spatially shuffled attention against
   the real map. This tests whether learned image-specific attention adds value.
4. Add a structural proposal experiment using connected residual components at
   several scales; rank by measured candidate loss reduction, not peak pixels.
   Reuse existing primitives and exact coverage. Treat this as a hypothesis.

Only expand the matrix if a mechanism improves visible details across categories.
If maps miss important details, change the prior; if maps cover them but output
does not improve, focus on candidate geometry and layer replacement. Do not add
hard per-region shape quotas before this diagnosis: quotas can waste controls
and impose segmentation mistakes on generic images.

## Acceptance and integration

Retain current quality gates as screening criteria. Add blinded full-image and
detail comparisons and a count-versus-quality curve before claiming fewer shapes.
Use evaluation annotations only for measurement, never production fitting.
Package inference/UI only after a frozen candidate survives fresh held-out tests.
Maximum Detail, exports, cancellation and parallel jobs remain required regressions.

## Implementation checkpoint

The evaluator now requires `--expected-manifest PATH`, checks every expected
result/target/output and annotation, rejects mismatched targets and exits 2 for
incomplete comparisons. Historical reproduction commands need this extra argument.
It reports absolute global errors, per-seed region changes, equal-region averages
and worst-seed spill/global changes alongside existing gates.

The benchmark now records per-run provenance, refuses to resume legacy or changed
runs in place, and keys maps by source plus model/preprocessing implementation.
Use a new output folder for historical reruns; do not fabricate legacy provenance.

`--proposal-only --guided` preserves structural scoring and adds candidates from
the attention weights. `--prior center` and `--prior shifted` provide controls.
The first version (existing moment geometry) failed a five-image tuning pilot:
400 shapes, 512px, seeds 42/43/44; median region error +0.21%, global +0.22%.
Signage improved -2.50%, multiple subjects -0.91%; parrots +0.21%, cup +1.99%,
car +1.03%. No global or mean-spill gate failed. This is exploratory tuning,
not fresh held-out validation. Artifacts: `proposal-pilot-v1/` and
`proposal-pilot-v1-evaluation.json` under ignored reference.

A second geometry experiment (v2) restricts extra proposal moment estimates to a
connected patch with aligned residual direction. Controls: the v1 center prior
matched the real map (region +0.14% vs +0.21%), so v1 showed no map value.
`--prior structure` (engine `structuralProposals`, valid only with `proposalOnly`)
adds the same v2 proposals from structural weights and ignores the map; a neutral
map in proposal-only mode remains a no-op.

v2, same five-image pilot, 400 shapes, 512px, seeds 42/43/44 (region / global):
model map −2.15% / +0.57% (all five images improved), shifted −1.79% / +0.61%,
center −0.39% / +1.01%, structure only −1.15% / +0.35%. No gate failures.

Expanded to all 16 images with 512px baselines (same settings, 48 runs each):

| v2 proposals | Region median | Images improved | Seeds improved | Global median | Global >2% |
| --- | --- | --- | --- | --- | --- |
| model map | −1.04% | 11/16 | 27/48 | +0.28% | kodim19 (+2.2%) |
| structure only | +0.33% | 6/16 | 24/48 | +0.54% | none |
| shifted map | +0.21% | 7/16 | 27/48 | +0.61% | kodim19 (+2.3%) |

- The five-image pilot overstated the effect; on 16 images it halves and only
  27 of 48 paired seeds improve. Lettering is the only clear category (−5.2%),
  and the shifted map reaches −4.4% there too.
- The real map beats structure-only proposals on 13 of 16 images, but beats the
  shifted map on only 9 of 16: no evidence yet that image-specific placement
  matters for proposals.
- Proposal-only guidance is much weaker than scoring guidance (round 1: about
  −4.3% at 400/512) and is not a promotion candidate.
- Extra proposals with unchanged scoring raise unweighted global error slightly
  in every variant (+0.3% to +1.0%): the structural objective accepts them.
- Wall-time ratios were measured under different parallel load and are not
  speed evidence.

## Layer replacement experiment

Opt-in render options, off by default (default output byte-identical, checked
against stored runs; browser contract covers both):

- `redistribution: "measured"` ranks redistribution trials by the loss increase
  of deleting each layer, computed for every layer in two compositing passes
  (transmission above, composite below; chunked to bounded memory). It ignores
  per-layer 8-bit rounding (native test: within 1% of repainted loss), so it only
  ranks; acceptance is unchanged and exact.
- `redistributionTrials: n` sets the trial count (engine default 8, at most one
  per layer).

Five-image pilot, 400 shapes, 512px, seeds 42/43/44 (region / global vs baseline):

| Variant | Region | Global | Seeds with lower global |
| --- | --- | --- | --- |
| measured ranking, 8 trials | −0.00% | −0.09% | 12/15 |
| energy ranking, 40 trials | −0.01% | −0.01% | 11/15 |
| measured ranking, 40 trials | +0.04% | −0.09% | 13/15 |
| attention scoring + measured, vs attention scoring alone | −0.05% | −0.04% | 10/15 |

Replacements are accepted (measured runs change most shapes after the color
refit that follows), but quality moves by at most about 0.1%. At 400 shapes the
redistribution phase has little leverage; quality is set by greedy search. This
does not support the layer-replacement hypothesis, and no larger matrix was run.

## Round 3: reallocation as the stated goal

Owner direction (2026-11-01): the goal is to reallocate a fixed shape budget to
automatically selected important detail; extra error elsewhere is acceptable.
Revised criteria, frozen in ignored `round3-freeze.json` before any held-out fit:
region median ≤−5% per setting, no category median worse, real map must beat a
shifted map, spill tolerance reported, global error reported with >10% flagged for
visual review, blind review. The per-image global ≤+2% gate is reported only.

Tuning set (25 images at 400/256, 16 at 1000/256, seeds 42/43/44, scoring guidance):

| Fusion | Region 400 / 1000 | Global 400 / 1000 | Spill fails |
| --- | --- | --- | --- |
| strength 0.5, additive 1 | −3.89% / −5.91% | +1.09% / +0.90% | workbench |
| same, shifted map | +1.28% / +1.50% | +0.00% / +0.26% | — |
| **strength 1, additive 1** | **−5.66% / −8.14%** | +1.40% / +1.30% | Layla, workbench |
| same, shifted map | +0.70% / +1.23% | +0.39% / +0.75% | workbench |
| strength 1, additive 1, refine 0 | −4.45% / −6.94% | +1.49% / +1.47% | workbench at 1000 |

With scoring guidance the map's placement matters: the real map beats the shifted
map on 24/25 images at 400 and 15/16 at 1000, and the shifted map makes regions
worse. Strength 1 + additive 1 (the top of the validated range) was frozen.
Its spill increases (≤0.0004 mean alpha) look like the baseline's at 50× gain.

Fresh held-out (`importance-heldout-2.json`, 20 images, first and only candidate
run), seeds 42/43/44:

| Shapes / px | Region | Images improved | Global | Global >10% | Spill fails |
| --- | --- | --- | --- | --- | --- |
| 400 / 256 | −5.72% | 17/20 | +1.29% | none | none |
| 1000 / 256 | −7.07% | 17/20 | +1.70% | none | none |
| 400 / 512 | −4.18% | 16/20 | +1.57% | emblem, hornet, Tux | hornet, Tux |
| 1000 / 512 | −6.60% | 16/20 | +1.63% | hornet (+38.7%) | hornet |

- Photographs improve consistently: portrait −5.9% to −9.3%, multiple subjects
  −6% to −11%, texture −7% to −8.5%, object −3.5% to −5.5%, landscape −3% to −5%.
- Flat illustrations fail the category gate (+5.5% at 400/256, +19% at 400/512):
  the alien and Tux regions worsen. Text is mixed (sail numbers −8% to −12%; the
  emblem worsens, +13.8% at 400/512).
- One visible candidate-only defect: Tux, 400 shapes, 512px, seed 43, right eye
  covered by a dark shape (region +533%, global +93%, spill +0.0068). The hornet
  seed 43 global outliers (+27%, +90%) carry clear-area spill, not obvious at
  sheet scale. The baseline has no comparable visible defect on those images.
- Blind review (400/512, seed 42, important detail first): candidate preferred 4
  (boat lettering clearly; statue face, sail numbers, alien wheel slightly),
  baseline 1 (window shutters), ties 15.

Verdict: not approved. The mechanism works on photographs and the automatic
selection is real, but flat transparent illustrations are unstable under strong
weights at 512px. Next: find why strong weights let a shape cover the attended
eye (search acceptance, color refit, redistribution or reorder), fix it without
weakening the photo result, tune on the 25-image set plus held-out-2 (now spent),
and validate on a new held-out set.

## Fix: attended transparent holes

Diagnosis (lab replay, `--features lab`, `lab_replay_phases`, from the run's
`target.png`, which is the exact engine input; native output matched the browser
to a mean of 0.04/255): Tux's eye whites are transparent holes. Painting a clear
pixel costs a fixed 64 and filling an opaque black pixel gains 8, so a dark shape
covering eight times more head than hole is accepted, and additive paint can never
reopen the hole. The map zeroed attention on transparent pixels and the engine
ignored it there, so attended holes got no protection. The defect formed within
the first 50 shapes; refinement, redistribution and reorder could not undo it.

Fix: `normalizeAttention` keeps clamped values on transparent pixels (range still
from visible pixels), and the additive term multiplies the clear-pixel penalty by
`1 + 3 * additive * a` (refine and proposal-only follow the colour terms). No
masking or output alpha change. Replay: eye-region error 56 → 4.9, both eyes open.

Strength 1 + additive 1 with the fix (held-out-2 is tuning data now):

| Set, shapes / px | Region before → after | Illustration before → after | Global >10% / spill fails after |
| --- | --- | --- | --- |
| held-out-2 400 / 256 | −5.72% → −5.72% | +5.5% → +4.9% | brownie / none |
| held-out-2 1000 / 256 | −7.07% → −7.07% | −3.1% → +1.3% | hornet / hornet |
| held-out-2 400 / 512 | −4.18% → −4.59% | +19.1% → +1.7% | emblem / none |
| held-out-2 1000 / 512 | −6.60% → −6.60% | +3.3% → +0.7% | none / none |
| 25 tuning, 400 / 256 | −5.66% → −5.66% | — | owl / none (was 2) |
| 16 tuning, 1000 / 256 | −8.14% → −7.42% | — | none / none (was 1) |

Worst single-seed region change at 400/512 fell from +533% to +43%. Remaining
outliers are relative changes on very low-error clipart (brownie, owl baseline
RMSE 0.7–1.5; hornet seed 43, 3.8 → 5.9, slivers between wings, no visible
defect at sheet scale). Remaining region losses come from map priorities, not the
fitter: the alien's wheel (8.5 → 13.4) and the emblem's "1947 KOREA" (13 → 15.5)
lose detail to the face and upper lettering the map ranks higher.

Status: the frozen-candidate held-out result above predates the fix; a fresh
held-out set is required before any promotion claim.

## Held-out-3 validation of the fixed candidate

Frozen in ignored `round3-fix-freeze.json` (strength 1, additive 1, refine 1,
WASM `b5b1be80…` / `02b69471…`) before any new image was chosen. Held-out-3
(`tests/primeval/importance-heldout-3.json`): 22 CC0 Commons images, 1024px
thumbnails (17 photographs: portrait, animal, text, multiple subjects, landscape,
texture, object; 5 illustrations, 4 transparent), regions drawn from sources
before any fit. Run once, seeds 42/43/44, no failed or missing runs:

| Shapes / px | Region | Images improved | Seeds improved | Global | Global >10% | Spill fails |
| --- | --- | --- | --- | --- | --- | --- |
| 400 / 256 | −3.66% | 20/22 | 59/66 | +1.10% | none | none |
| 1000 / 256 | −4.44% | 20/22 | 58/66 | +1.40% | robot with wheels | none |
| 400 / 512 | −3.39% | 22/22 | 58/66 | +1.17% | none | none |
| 1000 / 512 | −2.57% | 22/22 | 58/66 | +1.55% | car icon | none |

- No category median worsened at any setting (illustrations −1.5% to −7.5%).
  Portraits −3.7% to −8.2%, animals −4.4% to −8.3%, objects −4.1% to −5.8%.
- The only clear regression: robot with wheels at 1000/256, the transparent gap
  between its legs (+43.7%) on a very low-error image (global 0.71 → 0.81); its
  eyes still improved. Worst single seed elsewhere ≤ +13%.
- Blind review (400/512, seed 42, important detail first): candidate preferred 6
  (fishmonger's face, Kidston and market lettering clearly; bearded man, Hals,
  car slightly), baseline 1 (cat, slightly), ties 15.

Verdict against the frozen criteria: category, spill, specificity (tuning) and
review criteria met; the region criterion (≤−5%) not met at any setting. The
fixed candidate is consistent and free of the earlier defects, but its gain on
genuinely unseen images is about 3–4%, smaller than on held-out-2 (−4.6% to
−7.1%). Whether that is enough for an opt-in option is an owner decision.

## Strengthening round

Owner direction: strengthen before integrating. Owner-stated game constraints:
rectangles have no aspect limit in game; triangles must stay isosceles.

Engine options (default output byte-identical; SITE-PATCHES.md item 13):
`additive` now accepts 0 to 4, and `rectAspect` lifts the rectangle cap of 8
(process-wide value held for one Turbo fit and restored). After the round below,
the attention gain `1 + 3 * additive * a` multiplies all opacity error, not only
paint on transparent pixels, which removed a dome-streak defect on the alien.

Tuning on held-out-2 + held-out-3 (42 images, now tuning data), 400 shapes, 512px,
seeds 42/43/44 (region / global / images improved):

| Variant | Region | Global | Improved | Notes |
| --- | --- | --- | --- | --- |
| strength 1, additive 1 (validated) | −3.86% | +1.22% | 38/42 | reference |
| additive 2 | −4.51% | +2.12% | 37/42 | |
| additive 3 | −5.19% | +2.71% | 37/42 | alien dome streaks |
| additive 3, shifted map | +3.99% | +1.21% | 5/42 | real map better on 38/42 |
| additive 4 | −5.45% | +3.28% | 33/42 | illustrations +1.7% (worse) |
| rectangle cap 64, no attention | −0.15% | +0.05% | 23/42 | ~7% of rectangles exceed 8:1 |
| additive 1 + rectangle cap 64 | −3.85% | +1.03% | 38/42 | no gain over cap 8 |
| **additive 3 + opacity gain** | −5.07% | +2.80% | 36/42 | alien +49.9% → +3.7% |

- Lifting the rectangle cap alone does not change quality at 400 shapes: the
  search uses long rectangles but greedy placement does not turn them into
  better detail. Line-aligned proposals would be needed; not pursued here.
- Additive 4 starts harming illustrations; additive 3 + opacity gain was frozen
  (`round4-freeze.json`, WASM `fada4834…` / `92d4af05…`) and validated once on
  `importance-heldout-4.json` (21 CC0 images: 17 photos, 4 transparent illustrations).

Held-out-4, run once, seeds 42/43/44, no failed or missing runs:

| Shapes / px | Region | Images improved | Seeds improved | Global | Global >10% | Spill fails | Illustration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 400 / 256 | −5.28% | 18/21 | 53/63 | +2.62% | none | none | +2.2% |
| 1000 / 256 | −5.81% | 18/21 | 54/63 | +3.48% | Ferris | none | +3.6% |
| 400 / 512 | −4.54% | 18/21 | 54/63 | +2.86% | none | none | +1.1% |
| 1000 / 512 | −4.08% | 20/21 | 60/63 | +2.79% | none | none | −1.8% |

- Photographs: portraits −6.2% to −9.3%, text −6.6% to −10.5%, animals −7.9% to
  −11.0%, objects −5.2% to −8.4%, landscape −3.3% to −5.9%, texture −3.3% to −5.2%.
- Illustration medians worsen at three settings, but per region the map's
  priorities win: the dragon's eye, mouth and flower improve 10–29% while its
  feet lose (+9% to +27%); Ferris's eyes improve while mouth and spikes lose;
  the bivalve logo's lettering and hand improve while the shell stripes lose.
  Baseline errors there are low (global 0.9–9).
- Blind review (400/512, seed 42, important detail first): candidate preferred 6
  (woman selling, licence plates, musicians' faces, mosaic stars clearly; woman
  from San Juan, "Restaurant" lettering slightly), baseline 0, ties 15.

Against the frozen criteria: region ≤−5% met at 256px, not at 512px (−4.1% to
−4.5%); category gate not met at three settings (illustrations, as above); spill
and review met. Compared with the validated additive-1 candidate on held-out-3
(−2.6% to −4.4%, review 6–1), detail gains on unseen photographs roughly double,
at about +1.5 points more global error.

## Where this leaves the goal

Across scoring guidance, proposal-only guidance (v1, v2, controls) and layer
replacement, only scoring guidance produces region gains of a few percent, and
it trades global error. No tested mechanism reduces the shapes needed for
recognizable detail by a demonstrated margin. Further work would need a different
search (for example a count-versus-quality curve to measure shape savings
directly, or larger changes to greedy candidate generation) and should be
weighed against stopping here. The fresh held-out set remains untouched.
