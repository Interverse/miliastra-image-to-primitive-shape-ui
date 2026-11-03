# Automatic importance implementation status

Current direction: see [course correction](automatic-importance-course-correction.md).
Round 3 (reallocation as the goal): strength 1 + additive 1 met the region target
on photographs in a fresh held-out run but failed on flat illustrations, with one
visible defect; details there. After a transparent-hole fix, a second fresh held-out run
(22 images) was consistent with no defects but gained 2.6–4.4%, below the 5% target. A strengthened setting (additive 3, attention-scaled opacity error) then gained
4.1–5.8% on a fourth fresh set (photos 5–11% by category; flat illustrations shift
detail toward the map's priorities), blind review 6–0.

## Shipped: Focus detail (owner decision, 2026-11-01)

The strengthened setting is integrated as **Focus detail**, a Primeval Turbo
option that is on by default (hidden for Maximum Detail; Draft mode was removed).
A one-click switch in Input Images turns it off for every image.

- Automatic focus: `js/worker-importance.js` (module worker) runs UNISAL static
  SALICON with onnxruntime-web 1.31.1, CPU/WASM, one thread
  (`assets/models/unisal-salicon.onnx`, `js/vendor/onnxruntime/`, licences in
  `LICENSES/`). `js/focus.js` queues one analysis at a time, caches up to 24 maps
  per image file, and cancels a running analysis by terminating its worker.
- Per-image focus: each imported thumbnail shows a labelled "Focus: …" pill
  (Auto, Auto + n, n drawn, None; on small thumbnails the prefix is dropped), and
  a hint under the thumbnails says to select an image. Clicking the image or pill
  opens "Where should detail go?" with three explained modes: **Automatic** (the
  model's choice, previewed by dimming low-attention parts; areas dragged on top
  are added with full weight and shown undimmed), **Only my areas** (detail only
  where rectangles are drawn; the editor asks for at least one) and **Off** (no
  focus for this image; drawn areas are kept but greyed out and drawing is
  disabled). An instruction line follows the mode, a legend separates the
  automatic map from drawn boxes (with their count), and "Clear areas (n)" is
  disabled when there is nothing to clear. The preview analysis is cached and
  reused by the fit.
- Fitting: strength 1, additive 3 (attention also scales opacity error). If the
  model cannot load, the fit continues with structural weights and marked areas;
  the result records `focus_result` (`used`, `flat`, `failed` or `off`, areas,
  model, strength, additive) in the exported JSON config.
- Each imported thumbnail also has a remove button (top right, above the image,
  inside its own stacking context; it never opens the file picker).
- Validation: held-out-4 results below; retry keeps the job's focus settings.

## Research history

Pause fusion sweeps and gate relaxation; audit evaluation completeness and isolate
proposal quality from scoring changes before further model integration.
Round-1 held-out validation improved annotated detail regions but missed the
proposed promotion gates. Round 2 tuned nine fusion variants on 25 images and none
met the gates either (below), so the fresh round-2 held-out set was not spent and
the service/UI phase was not started.

## Implemented

- UNISAL static SALICON ONNX export with tensor parity (`scripts/export-attention.py`).
- Browser CPU/WASM pilot, map dumps for parity (`scripts/benchmark-attention.cjs`).
- Aspect-preserving preprocessing, hidden-RGB-safe matte, crop and visible-pixel
  normalization (`js/importance-analysis.js`).
- Validated Float32 map transport through JS workers/WASM into Turbo, installed
  before the first shape. Fusion terms, all bounded and validated in [0, 1]:

  `weight = 1 + (structure - 1) * (1 + strength * a) + 3 * additive * a`

  `additive` is optional (default 0). The amplify term only emphasizes existing
  structure; the additive term also reaches low-contrast attended detail.
  Optional `refine` (default 1) is the share of the attention emphasis kept after
  shape search: 0 places shapes with attention, then refines, redistributes and
  reorders them against structural weights only. Alpha penalties are unchanged.
  No masks, geometry or count changes.
- Resumable matrices with sets, strengths, map gamma, parallel jobs and per-source
  map cache (`scripts/benchmark-importance.py`). Fitting output is identical across
  thread counts (verified), so parallel jobs only affect timing. A fit over
  `--timeout` (default 300 s) is killed with its browser and recorded as
  `failed.json`; the evaluator lists failed runs and fails every gate, so no run
  is silently dropped.
- Seed-aggregated evaluator with region RMSE, region Sobel-gradient error, spill,
  gates and blind randomized A/B sheets plus region crops (`scripts/evaluate-importance.py`).
- Fixture manifests with licenses, hashes and evaluation-only regions
  (`tests/primeval/importance-heldout.json`, `importance-heldout-2.json`, fetched by
  `scripts/fetch-importance-heldout.py`).
- Real-image PyTorch/browser parity (`scripts/check-attention-parity.py`).

## Evaluation protocol

Mixed, Turbo, seeds 42/43/44, metrics averaged over seeds before comparison.
Round 1 tuning subset: the nine private pilot images, with regions in ignored
`reference/automatic-importance/pilot-regions.json`. Round 1 held-out: 16 images
(11 Kodak suite, 5 CC0 Wikimedia; 4 transparent) covering portrait, animal, text,
multiple subjects, landscape, distracting texture, object and illustration.
Regions were drawn from source previews before any candidate output was viewed
and are never passed to the fitter. Parameters were chosen on the tuning subset
only and frozen before held-out runs.

Seed noise matters: per-seed global RMSE varies ±3–4% and clear-area spill
±0.0002 between seeds. Earlier single-seed results (including Layla's spill
failure at strength 0.5) were within that noise; after three-seed aggregation,
strength 0.5 passes the spill tolerance on all nine pilot images.

## Round 1 tuning subset (400 shapes, 256px, 3 seeds; medians over 9 images)

| Fusion | Global RMSE | Region RMSE | Region gradient | Global >2% | Spill fail |
| --- | --- | --- | --- | --- | --- |
| strength 0.1 | −0.05% | −0.11% | −0.15% | none | none |
| strength 0.5 | +0.15% | −2.28% | −3.08% | none | none |
| strength 1.0 | +0.81% | −3.23% | −3.56% | 2 images | none |
| strength 0.5, additive 0.25 | −0.19% | −3.19% | −3.07% | 1 image | none |
| **strength 0.5, additive 0.5** | +0.91% | −3.34% | −4.66% | none | none |
| strength 0, additive 0.5 | −0.06% | −1.46% | −2.23% | none | none |

Strength 0.1 is too weak to matter. Strength 0.5 + additive 0.5 was frozen as the
candidate (all nine regions improved); strength 0.5 alone was kept for comparison.

## Round 1 held-out results (16 images, 3 seeds per setting)

Candidate: strength 0.5, additive 0.5.

| Shapes / px | Global RMSE | Region RMSE | Region gradient | Global >2% | Spill fail |
| --- | --- | --- | --- | --- | --- |
| 400 / 256 | +0.67% | −4.40% | −3.26% | parrots | none |
| 1000 / 256 | +0.66% | −4.69% | −4.30% | parrots, owl | none |
| 400 / 512 | +0.04% | −4.34% | −3.81% | parrots | none |
| 1000 / 512 | +0.54% | −3.91% | −3.85% | parrots, owl | none |

- Region RMSE improved in 61 of 64 image/setting cases. No category median
  worsened. Strongest: portraits (−5.8% to −12.6%) and lettering (−1.5% to −12.3%).
  Weakest (about +0.8% to −2%): landscape, the pigeon photo, the transparent cup
  and the car illustration; the three regressions are within +0.8%.
- Global failures: parrots +2.2% to +3.1%; owl clipart +3.4% to +6.2% at 1,000
  shapes (visually indistinguishable in blind review).
- Clear-area spill increases stayed ≤0.000036, inside the 0.0001 tolerance.
- Strength 0.5 alone is weaker: region −1.5% to −3.2%, and illustration/object
  region medians worsen at some sizes, failing the category gate.
- Blind A/B review (one reviewer, 11 sheets, 256 and 512px): candidate preferred
  6 (4 slight), baseline preferred 2 (both parrots: cleaner beak silhouette),
  ties 3. Kodak signage lettering is illegible at 400 shapes in both outputs.

Proposed gate status: median region RMSE ≤−5% **not met** (−3.9% to −4.7%);
no worse category **met**; per-image global ≤+2% **not met** (2 images);
spill ≤+0.0001 **met**. Promotion is therefore not approved.

## Round 2: tuning against the round-1 gaps

The round-1 held-out images were diagnosed, so they are tuning data now: 25 images
(9 pilot + 16). A fresh set of 20 (`tests/primeval/importance-heldout-2.json`:
13 unused Kodak, 7 CC0 Commons, 6 transparent) was annotated from source previews
before any fit and is reserved. Its baseline is fitted; no candidate was run on it.

Diagnosis: the parrots regress steadily (+2–3%, seed standard error 0.1–0.4%), a
real cost of moving effort to the heads. The owl's +6.2% was one seed (+13%) of
three; its baseline error is tiny and seeds spread 8%, so its per-image change has
a standard error of 2–5%, as do the cup and one pilot image.

Medians over images, 3 seeds; 400 shapes on 25 images, 1000 shapes on 16, 256px:

| Fusion | Region 400 | Region 1000 | Global >2% (400 / 1000) | Spill |
| --- | --- | --- | --- | --- |
| strength 0.5, additive 0.5 (round 1) | −3.40% | −4.69% | 1 / 2 | met |
| + balance 1 (mean-preserving weights) | −3.48% | −4.40% | 4 / 4 | met |
| + balance 0.5 | −4.32% | −4.65% | 1 / 2 | fails at 1000 |
| + map gamma 2 | −3.98% | −3.92% | 0 / 2 | fails |
| + map gamma 0.5 | −3.32% | −5.01% | 1 / 2 | fails at 400 |
| additive 1 | −3.89% | −5.91% | 6 / 6 | fails at 400 |
| additive 1, refine 0 | −4.12% | −5.92% | 3 / 3 | met |
| additive 0.5, refine 0 | −3.23% | −4.16% | 3 / 1 | met |
| additive 1, refine 0.5 | −4.13% | −6.28% | 7 / 4 | fails at 400 |

- No variant reaches the −5% region median at 400 shapes; the spread between
  variants (about 1 point) is close to seed noise.
- Beyond −5% at 1000 shapes, global regressions above 2% appear on several photos
  with low seed noise, not only on noisy clipart.
- Keeping attention only for search (`refine` 0) roughly halves the global damage
  of strong attention at equal region gain, but not enough.
- Mean-preserving weights (`balance`) made transparent images worse and were
  removed from the engine.
- The +2% per-image gate is noise-dominated for very low-error images (standard
  error 2–5% with three seeds); it is unchanged here, as gates are the owner's call.

## Model and parity

- UNISAL upstream `https://github.com/rdroste/unisal`, revision
  `7f8ca1a7ecb3dbc1bf7fca837cb6186a85ac27d9`, Apache-2.0. Static ONNX 12,796,564
  bytes, SHA256 `728c58bf9478854f1c4e1c75354fc9a0b4cad8fe4cc900bdbc15428a1bfc9212`;
  checkpoint SHA256 `4a9157411f1741d588b15670d15295e998805648b8b6348599fe447298338481`.
  EML-Net has no repository license and was not used.
- Chromium, one WASM thread: session load 674 ms, warm inference 155–159 ms.
- Real-image parity (8 images: Kodak, CC0 transparent, pilot): browser ORT vs
  PyTorch on identical tensors, max relative error ≤1.7e-5. Browser canvas vs
  Python Lanczos letterboxing: normalized-map Pearson 0.982–0.9995 (lowest on a
  large transparent illustration). Our letterbox vs upstream SALICON stretch:
  Pearson 0.88–0.997 (lowest on a 2:3 portrait). Letterboxing is a deliberate
  adapter choice to avoid distortion; it is not upstream's evaluation protocol.
- Attention prediction is a fixation prior, not semantic recognition.

## Engines and verification

Current WASM SHA256 (research options of SITE-PATCHES.md item 13, additive up to 4,
attention-scaled opacity error, opt-in rectangle cap): single
`fada483446e7bc797a8e5533439bcc3a683267a96f69de9d3c169f79aefef877`, threaded
`92d4af05ee18e93831ed93c125495122d31fbe211e5f15784a4bd69141c597a3`. All suites and the
browser contract pass on this build.
No-map Turbo output and scoring-guided output are byte-identical to the stored
runs; v2 model-prior proposal output is byte-identical across the last two builds.
Passed: 17 native RGBA tests (`cargo +stable test -p primeval-core --features
asset-triangle rgba`); browser attention contract (zero terms, default refine,
exact count, invalid-map rejection); `npm test` (68 passed; optional e2e goldens
and Fengari skipped); `test:turbo`, `test:alpha`, `test:browser` (250 checks at
1440 and 390), `test:hosting`, `test:deployment`; evaluator completeness test.
On the current build one 390px run failed "scale gizmo changes exported geometry"
once; two reruns passed all 250 checks (UI files unchanged). Known, pre-existing: without
`asset-triangle` (not shipped), three heavy RGBA tests do not terminate, with or
without the attention changes.
Baseline fit times (4 parallel jobs × 4 threads, so contended): median 24 s
(400/256), 41 s (400/512), 44 s (1000/256), 68 s (1000/512). Not isolated speed data.

## Remaining work

Shipped items (worker, cache, 15-language UI, result metadata, packaged model and
runtime with licences, Pages checks) are done; see above.

1. Test inference time and memory on other browsers and devices (Safari, Firefox,
   phones); only this desktop Chromium has been timed.
2. Transparent illustrations with Focus detail can still leave paint over a small
   transparent gap (Ferris, some seeds); see the lines and curves section of
   [Turbo](primeval-turbo.md) for the gap cleanup work.
3. Optional: a noise-aware per-image global gate (more seeds) if further
   strengthening is attempted; tuning alone did not close the earlier gap.
4. Small marks (a mouth stroke at 400 shapes) can still be missed without a
   manual focus area. Automatic small-feature weighting raised feature metrics
   but lost a fresh blinded display review; see "Low-count detail program" in
   [Turbo](primeval-turbo.md).

## Reproduction

```powershell
python scripts/fetch-importance-heldout.py
python scripts/benchmark-importance.py --run --counts 400 --seeds 42 43 44 --jobs 4 --threads 4
python scripts/benchmark-importance.py --run --guided --strength 0.5 --additive 0.5 --out guided-s0.5-a0.5 --counts 400 --seeds 42 43 44 --jobs 4 --threads 4
python scripts/evaluate-importance.py guided-s0.5-a0.5 --set pilot
python scripts/benchmark-importance.py --run --set heldout --detail 512 --counts 400 1000 --jobs 4 --threads 4
python scripts/benchmark-importance.py --run --set heldout --guided --strength 0.5 --additive 0.5 --out heldout-s0.5-a0.5 --detail 512 --counts 400 1000 --jobs 4 --threads 4
python scripts/evaluate-importance.py heldout-s0.5-a0.5 --set heldout --review
python scripts/benchmark-importance.py --run --guided --strength 0.5 --additive 1 --refine 0 --out dev-s0.5-a1-r0 --counts 400 --jobs 4 --threads 4
python reference/automatic-importance/dev-summary.py s0.5-a1-r0
python scripts/benchmark-importance.py --run --set heldout2 --detail 512 --counts 400 1000 --jobs 4 --threads 4
node scripts/benchmark-attention.cjs --dump <image> reference/automatic-importance/parity/<name>
python scripts/check-attention-parity.py reference/automatic-importance/parity/*
node scripts/benchmark-attention.cjs --contract
```

Set `PLAYWRIGHT_MODULE` to a local Playwright install. Python needs torch, numpy,
Pillow, onnx and onnxruntime; the ORT web package is expected under
`reference/automatic-importance/package/`. All outputs stay in ignored `reference/`.
