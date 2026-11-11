# Primeval GIF/video animation

GIF/video inputs use the existing `processPrimeval` function in
`worker-primeval.js` for every selected frame. Static generation calls that same
function for full fits. An animation-only Rust/WASM refinement entry point reuses
prior drawings between keyframes. The pinned still-image fitting path and static
JSON layout are unchanged.
There is no separate rectangular mosaic fitter or animation quality/count setting.

## Settings and decoding

Animations use the regular Primeval shape family (including Mixed), primitive
count, Turbo/Maximum Detail, resolution, image scale, opacity, transparency,
background, AI upscale, Focus and experimental options. GIF/video batches select
Primeval automatically. The animation panel adds FPS (15 by default), Loop and Reuse previous frame (on by default). Results offer Lua and JSON, without audio.
Focus areas can be marked using the source's first frame;
normalized areas apply throughout the clip. Automatic Focus uses the same UNISAL worker and map-combination code as still
images. Temporal mode refreshes its automatic map periodically and on full fits,
and tracks it between them; manually marked areas still apply to every frame.

The unmodified Mediabunny ESM bundle is named `mediabunny.min.js`, rather than
`.mjs`: Windows Python static servers can serve `.mjs` as `text/plain`, causing
Chrome to reject the module before fitting starts. Both video paths and deployed
imports use the `.js` entry. Browser regressions emulate the incorrect `.mjs`
MIME type; the bundle hash and MPL license remain unchanged.

GIF decoding uses native ImageDecoder with composited disposal/transparency and
original frame timing. Video uses bundled Mediabunny 1.65.2/WebCodecs, iterating
every decoded sample in presentation order. Unsupported codecs fail explicitly.
New animation inputs start at 1,000 primitives, 512 px detail and Focus enabled.
The count stays editable; switching back to still images restores their count.
FPS 0 preserves the source rate. GIF container timing is inspected first: when
all source poses already fit the selected rate, native variable timing is kept.
This avoids aliasing a roughly 15 FPS GIF down to fewer poses at FPS 15. Preview,
generation and Lua follow the same stored timeline, without applying a second
FPS cap. For a lower target, positive FPS selects source images covering
uniform output ticks, combines held poses and preserves the full clip duration.
Unselected frames skip canvas readback, Focus and fitting. GIF/video decoders
still process source samples for disposal and codec dependencies. There is no
shape-count reduction. Reuse fits selected frames sequentially. Independent mode uses up to two
persistent fitting workers when CPU/memory allow, sharing the job's existing
thread budget. Frames commit in source order, with at most two queued tasks per
worker. Each frame still runs the unchanged full Primeval fitter; only scheduling
changes. Single-thread/low-memory jobs retain one worker. Completed frames omit
unneeded source/preview pixels and SVG during worker transport. Pixel identity uses 32-bit comparisons, and source
alpha is scanned once per fitted frame rather than repeatedly via callbacks.

The source canvas previews the FPS selection before generation. GIFs use a
preview worker and a 64 MiB bitmap cache. Videos use a muted native video element
and a canvas sampled at the chosen FPS: a five-minute video is not buffered into
thousands of preview bitmaps. Changing files/FPS releases the old video URL or
worker/cache; leaving Upload pauses playback. The 3 MiB still-image warning does
not apply to GIF/video inputs.

Fitting still decodes video samples incrementally and closes each sample after
use. Retained fitted states have an explicit device-dependent allowance of
256–1,024 MiB (128 MiB per reported GiB of device memory, 512 MiB fallback).
The allowance is shared by parallel sequences. This is a representation limit,
not a duration cap; no counts, FPS selections or frames are silently reduced.
Consecutive byte-identical frames reuse the previous fit and retain their timing.

## Website animation Lua export (current)

Single and ZIP downloads now use the stable one-pool fast player. Its canonical
Lua and generated kernels are packaged in `js/animation-player-runtime.js` by
`node scripts/build-animation-player.cjs`; the generated file is deployed as-is.
There are no runtime build tools or experimental native calibration/cache paths.
Playback uses predecoded native coordinates/colors and precompiled changed-field
commands, with no decoding, native allocations or sibling reordering per frame.

Compression runs in an export worker. Website downloads use the two-pass
channel-Huffman codec with temporal deltas and zero runs, omitting obsolete
sibling-move plans. Predictive arithmetic coding remains readable and available
to tools with `compression: 'maximum'`, but is no longer selected automatically.
Its small byte savings caused a long apparent freeze on the first pose while
decoding the rest of the clip. The unused arithmetic decoder is stripped from
normal downloads. Only bounded startup callbacks decompress data; the first
fitted pose appears while remaining frames load. Runtime Lua
comments and redundant whitespace are removed using a literal-aware lexer;
internal decoder/kernel aliases are shortened without renaming host APIs or settings.

Lossless is the default. The existing Compact checkbox remains an explicit
precision reduction. Static JSON fields/semantics are untouched. The arithmetic
codec reduced already-packed saved Jahoda/Aranara payloads by only 4%/3%; that
saving did not justify its startup cost. Normal files can therefore be slightly
larger than maximum-compression exports. Native-Lua tests verify exact frame data,
visible output/order, load instruction bounds, seeks, loops and cancellation;
they do not measure actual game FPS.

The website also shares the existing offline planner through
`js/animation-order.js`. A spatial dependency graph preserves the order of every
overlapping padded draw bound. Topological scheduling and bounded local swaps
reduce material changes between fixed paint slots. Accepted plans cannot
increase total native submissions, image replacements or material runs. Planning
is limited to 500,000 primitive-frame cells; larger jobs or graphs above the
dependency budget retain the exact original ordering. This limits export work,
not shape/frame counts. Planning operates on private Lua copies after the chosen
precision conversion, never on the saved job or JSON export.

For the supplied 54-frame, 1,001-control Jahoda files, the arithmetic exports
needed 3,206 mock update callbacks before playback. The corrected lossless and
Compact exports need 320 callbacks. Average steady image replacements fell from
627 per transition to 125/126; total native submissions fell from 4,620/4,612 to
4,111/4,084. All 54 poses, the 1.81-second timeline, original-rate FPS selection,
geometry, colors, opacity, scale and overlapping draw order are preserved. The
independent corner-based order oracle and native-Lua playback mock validate both
saved files. These are work-count measurements, not a predicted engine FPS.

Full keyframes honor the ordinary Primeval options. Upscaling still processes
every distinct frame when selected. Temporal mode changes the optimization
schedule; turning Reuse previous frame off restores independent full fits.

### Playback methods

Exported animation scripts expose `Play()`, `Stop()` and `Restart()` as public
Script methods. Play resumes the current pose, or replays a completed non-looping
clip. Stop holds the current pose and clock. Restart returns to frame one and
plays, resetting cached deadlines as well as the clock. Calls before/during
loading are safe: Stop lets decoding finish, then keeps playback paused. Calls
after destruction return false and do not revive the controls. The diagnostic
FREEZE_FRAME setting still takes precedence.

From another script, after initialization, use the documented Script invocation
API on the control carrying the animation (adjust the extensionless file path):

```lua
local player = animationControl:GetScriptByPath("animation_client")
if player and player.alive then
    player:Invoke("Play") -- or "Stop", "Restart"
end
```

Mock tests cover named invocation, loading, stop/resume, looping, non-looping
completion, restart deadlines, native allocations and destruction. The existing
UI parent/template and mask hierarchy are unchanged.

## Animation JSON downloads

The result panel offers Animation JSON and Frames JSON (ZIP), for GIFs and
videos. Image JSON is unchanged. Each file in the frame ZIP uses the existing
image schema and numbered names such as `clip_frame_0001.json`.

The whole-animation JSON has a normal first-frame image payload, with its
existing fields and meanings, plus an optional `animation` object. That object
contains `version: 1`, `kind: "primeval"`, source width/height, control count,
scaled image unit, FPS, loop, per-frame durations and the integer eight-field
primitive arrays. It preserves original-rate FPS 0 and variable durations.
The selected screen zoom is baked into the unit and the first-frame image
payload. Dropping or pasting it restores a finished, playable animation without
fitting; version, dimensions, counts, colors, painter ranks, timing and the normal
frame-memory allowance are validated before creating a job. Existing static
image/frame JSON never receives the animation extension.

JSON serialization yields periodically, with progress and cancellation. Frame
ZIPs compress one entry at a time with browser DEFLATE when available, falling
back to STORE on older browsers. ZIP32 limits fail explicitly; frames are never
truncated. The existing Download all ZIP continues to include animation Lua;
the optional JSON downloads are separate to avoid unexpectedly expanding large
batch archives.

## Continuity and representation

Primeval uses a stable seed. After fitting, a bounded spatial search matches large
shapes first to nearby shapes of the same family in the preceding frame. This
assigns persistent control slots without changing Primeval's fitted shapes or
painter order. Vacant slots are reused, and the pool never exceeds the maximum
simultaneously needed shape count (including the fitted background).

Each frame stores asset family, position, size, rotation, packed colour and layer
order. Geometry uses the same tenth-unit precision as the static Lua exporter.
The browser preview renders these actual fitted shapes, not source pixels.
Full fits use spatial matching. Warm-started frames retain the native shape
sequence and reuse its slot IDs directly, avoiding family and layer-order churn.
No source alpha is reapplied.

## Native temporal fitting at the default quality settings

The earlier benchmark targeted **2,000 shapes, 512 px detail and automatic Focus on**; new animation sessions now start at **1,000 shapes and 15 FPS**.
The earlier 200-shape/256 px timings below are historical, not a proxy for these
defaults. Higher user-selected counts are retained; tests also cover 5,000-state
representation without truncation. The supplied GIF is 480x271, so 512 px detail
uses its native dimensions, as the still-image fitter does.

The first frame is an unchanged full Primeval fit. Temporal frames predict local
motion using brightness-normalized gradient matching, with colour-aware motion
separation to avoid moving facial features along with neighbouring particles.
Position, scale and rotation are predicted; triangles remain isosceles and
rectangles orthogonal, preserving one game image asset per primitive.

The native refiner snapshots only the local region needed by each shape, rather
than copying the entire canvas for every layer. Checkpoints and region snapshots
have separate 32 MiB budgets. Exact tests compare local-base sums with full-base
sums. Every shape remains present. Up to eight short local passes are followed,
when necessary, by batches of native Primeval residual proposals that recycle
least useful controls. Native identity maps keep the other controls stable.
If Focus error remains high, an additional Focus-priority pass concentrates
repair effort there while still enforcing the global quality budget.

Automatic Focus refreshes every eight frames and on full fits; its map follows
motion between refreshes. Full fits occur on scene changes, failed quality checks,
or after at most 96 frames. Global and attended-region error are checked separately.
Budgets adapt to current-frame gradient complexity, calibrated against the last
full fit, with complexity ratios bounded to 0.85–1.15. Global and Focus error
allow an 8% relative increase or 0.001 absolute increase, whichever is larger. A 0.0005 normalized rounding tolerance prevents sub-pixel numerical
noise from needlessly triggering a full reconstruction. These are heuristic
budgets, not promises of equivalence to independently fitted frames.

A separate detail guard compares premultiplied edges after a 3x3 box filter,
so GIF checkerboard noise does not mask fading facial outlines. Metric images
are bounded to 384 px. Edge error must remain within 1.35 times the reference
plus 0.02, and edge contrast must retain at least 90% of its reference, globally
and in Focus regions. Failed guards run a fresh full fit and refresh automatic
Focus. Before refining, the better of motion-predicted and unmoved shapes is
selected. A looser preflight guard bypasses hopeless warm starts without denying
normal refinement a chance to repair them. Quality protection can increase the
number of full fits; reuse is no longer allowed to accumulate softness merely
because average pixel error passes.

Scene cuts use spatial block changes and colour-histogram distance rather than
the old raw threshold of 80. Same-palette jump cuts can now force a fresh fit;
small camera pans and alternating dither should not. All pixels in each coarse
block contribute, avoiding checkerboard sampling aliasing.

Temporal frames skip PNG/SVG serialization and PNG decoding. Static Primeval
optimization and static JSON layouts are unchanged. Turning Reuse previous frame
off still performs independent full fits. Upscaling, when selected, processes
each distinct frame. No source alpha is reapplied after fitting.

## Lua encoding and playback

Animation Lua uses per-property temporal deltas, zero runs and Huffman-coded
magnitude buckets with binary residuals. RGB components are encoded separately
with modular deltas; a 114,522-entry global palette is no longer serialized.
The compact option is shown in the result and batch export controls. It is off by
default; enabling it uses half-pixel geometry, whole-degree rotations and RGB565 colours;
alpha, timing, shape families, counts and painter order are retained. Very small
positive sizes are kept at least half a pixel. Unchecking the option preserves
all original fitted values. Static Lua and JSON are unaffected.

`OnStart` only initializes loader state and enables updates. `OnUpdate` builds
decoding tables, reads at most 4,096 weighted scalar work units per callback,
prepares native colour objects, and creates at most ten image controls per
callback. The transparent square-asset mask parent stays hidden until loading
and the first frame finish. Counts are not truncated to avoid execution limits.
The script's batch constants can be lowered for a stricter host.

Decoded frames are retained directly. This needs fewer numeric table entries
than dense pairs of patch indices/values plus periodic checkpoints for this
clip, and eliminates replaying up to fifteen patches during catch-up. Adjacent
frames visit only affected controls. Skipped frames directly select the target
state, with a bounded full-order fallback. Control and colour objects, frame
states, work tables and sibling move plans are prepared before playback.

Playback now applies each displayed frame completely in one callback; it no
longer exposes a partially updated mixture of two frames. Adjacent frames visit
only affected controls, and the last displayed state is retained by reference
instead of copying eight fields per shape. Up to four skipped painter-order
plans can be composed instead of resetting every sibling. Large jumps use the
exact target snapshot and full-order fallback. Native setter calls only occur
for changed properties. No controls, colours or work tables are allocated during
playback. The exported PLAYBACK_FPS parameter follows the chosen FPS; zero uses
source timing. When it matches ENCODED_FPS, stored timing already enforces the
selection, so it is not capped again. Editing PLAYBACK_FPS lower still reduces
client work. This reduces work by skipping display updates, not by slowing
the clip. The game still needs performance validation with thousands of controls.

### Earlier default run before the detail guards

The supplied 480x271, 62-frame GIF at 1,000 shapes, 512 px detail, automatic
Focus on, Mixed/Turbo, seed 42 and four WASM threads, FPS 15, completed in
**337.99 s (5 min 38 s)**. The selected timeline contains **38 frames**, retaining
all 1,000 fitted shapes plus background per frame, with 3 full fits and 35
refinements. Source duration remains 2.48 s. Lossless Lua is **577,184 bytes**.
This is not a same-settings speed comparison with the older 2,000-shape run.
The remaining cost is native fitting: full fits account for 150.28 s and
refinements for 184.74 s. FPS selection avoids fitting 24 undisplayed frames;
no finer native-core speedup or in-game FPS gain is claimed.

### Supplied Lua timeout regression

The supplied 3,352,525-byte script exceeded the game's execution budget while
its `OnStart` decoded the entire animation. Re-encoding its exact retained 62
frames/2,001 controls produces **1,407,459 bytes compact (58.0% smaller)** or
**1,785,232 bytes losslessly (46.8% smaller)**. The existing template index and
480-unit width are preserved in local replacement scripts. They and source
media remain ignored, rather than being redistributed in the repository.

Native `texlua` regression runs validate every frame and looping in both modes
against the input states, including compact quantization. A synthetic 2,000-
control case is also tracked. `OnStart` creates no native objects. The actual
file takes 673 loading/update callbacks to show its first frame (about 11.2 s at
60 updates/s). The lossless run peaks at about 762,200 Lua VM instructions per
callback; compact peaks at 715,100. The test rejects callbacks reaching one
million instructions and more than ten creations per update. Its sibling-order
stub suspends the instruction hook while simulating the native sibling API;
these numbers exclude native engine cost and do not establish the game's actual
watchdog threshold or frame rate.

The host requires the Lua integer subtype for sibling indices. Signed delta
unpacking uses `math.floor` rather than leaving the result of `/` as a float;
both `SetSiblingIndex` call sites also convert explicitly. The native Lua stub
checks `math.type(index) == "integer"`, including moves, loops and catch-up.

## Historical media benchmarks (earlier Lua encoding)

`node scripts/benchmark-animation-media.cjs input.gif 200 256 baseline off`
and the equivalent `optimized off` retain timings and sample PNGs under ignored
`reference/animation-speed/`. Both process every frame with Mixed, Turbo, seed 42,
four WASM threads, 200 shapes and 256 px detail; automatic Focus is off in this
comparison. The supplied 480x271, 62-frame GIF is not redistributed in fixtures.
Reports include Lua bytes, changed fields and estimated native setter calls.
These estimates are not a measurement of in-game frame rate. Temporal fitting
has a quality/speed tradeoff; inspect the retained images alongside timings.

### Historical lower-budget run on the supplied GIF

At the settings above, all 62 frames took **484.88 s independently vs 63.28 s
with temporal fitting (7.66x faster)**. The final run used 5 full fits and 57
native refinements. Lua fell from 375,385 to 250,332 bytes (33.3% smaller), and
mean changed fields fell from 1,455.52 to 977.28 per transition. The generated
runtime's estimated native setter count averaged 680.36 per transition; painter
order was reapplied on only 4 of the 61 transitions. In-game FPS was not measured.

The first fitted frame was byte-identical. Sampled RGB mean absolute error
against decoded source pixels was: frame 0, 16.22 for both; frame 31, 15.17
independent vs 20.22 temporal; frame 61, 13.17 vs 13.99 (out of 255). This
records the remaining quality tradeoff instead of claiming lossless speed gains.
Higher-count/detail settings and other media require their own measurements.
The source GIF and generated pictures stay ignored; no user media is redistributed.


### Default-quality run on the supplied GIF

The final unseeded run processed all **62 frames at 2,000 shapes, 512 px detail,
automatic Focus on**, Mixed/Turbo, seed 42 and four WASM threads in **631.97 s**
(10 min 32 s). It used 3 full fits (245.36 s combined) and 59 native refinements
(382.01 s combined). There were 2,001 fitted controls per frame, including the
background; no frames or user-selected shapes were dropped. Export took another
6.10 s and produced 3,352,518 bytes of Lua. This is intentionally a different
quality budget from the historical 200-shape measurement above.

A complete independent 62-frame baseline at these defaults was not timed.
Independent reference fits at frames 0, 31 and 61 took 242.24 s combined;
projecting that cost to 62 frames gives about 83 minutes, approximately 7.9 times
the measured temporal run. That is an estimate, not a measured full-run speedup.

The first fitted PNG was byte-identical to its independent reference. RGB mean
absolute error on sampled frames (out of 255), independent versus temporal:
frame 2: 4.620 / 5.339; frame 15: 8.173 / 9.471; frame 31: 8.049 / 9.593.
Temporal intermediate frames remain somewhat softer, even though the original
shape budget and Focus checks are retained. The ignored review WebM contains all
62 fitted frames, rather than source imagery substituted into the result.

The generated runtime estimates 8,086 native property/order setters per frame
transition for this demanding clip. Pooling, predecoded deltas and minimal layer
moves avoid allocation and full control reconstruction during playback, but
in-game frame rate and native setter cost have not been measured. Thousands of
controls can still be expensive in the game; no lag-free claim is made.


## Citlali and Jahoda regressions

Both supplied media files and generated diagnostics remain ignored; user media
is not redistributed in tracked fixtures. Tests add synthetic dither/blur/cut
cases and exact serial-versus-parallel packed-shape comparisons.

Citlali is 240x240, 89 source frames, 5.94 s. At FPS 15 its variable GIF timing
now preserves all 89 poses; previously the sampler retained only 60. A source
frame-15 spot check at 1,000 shapes, 512 px detail and automatic Focus compares
the old reused fit with a refreshed frame-14 reference followed by an accepted
native refinement for frame 15. Edge error improved from about 0.493 to 0.319,
and edge contrast retention from 0.850 to 0.954 (unitless diagnostic scores).
The accepted final refinement took 0.54 s after its full reference fit; this is
not a full-clip timing or an in-game FPS measurement.

For five independent Citlali frames (0, 22, 44, 66, 88), full Primeval fits at
1,000 shapes, 512 px detail, Focus on, Mixed/Turbo and seed 42 took 203.07 s
serially versus 175.75 s with two workers sharing the same four-thread budget:
about 13.5% less elapsed time. First/middle/last sampled PNGs were byte-identical.
This is a five-frame comparison, not a timing of all 89 frames. Parallel timing
sums include overlapping work; elapsed processing time is the relevant measure.

Jahoda is 498x498, 54 frames, 1.81 s. Scanning all adjacent source pairs detects
the hard cut at frame 24, without flagging the neighboring pans. Frames 23–25
were regenerated at 1,000 shapes, 512 px detail and automatic Focus to inspect
both sides of the cut; frame 24 starts a fresh fit. Validation targets these cut
frames rather than claiming a complete regenerated 54-frame benchmark. At FPS
15, the source preview selects 28 frames and preserves the 1.81 s duration.


## Live generation and Jahoda 2,000-shape optimization

Generation now streams native shape updates (coalesced every 100 ms), tracks
concurrent active frames and retains every completed frame for scrubbing. A
virtual thumbnail strip bounds DOM/image caches; follow mode selects the current
frame. Completed states are copied for worker transfer without detaching the
final export buffers, then replaced with final states when generation finishes.

Motion prediction uses coarse-to-fine local matching, preserves stationary
background votes and uses fill-colour probes for large moving shapes. Inconsistent
neighbor motion cannot stretch a shape across a motion boundary. The temporal
colour-error budget retains its 1.08 relative factor but allows 0.004 absolute
normalized RMS variation (previously 0.001). Complexity can tighten neither
budget below the reference. This accepts modest colour differences; edge-loss
checks (90% contrast retention), Focus checks and cut resets still apply.
The shape count, fitting detail and static-image fitter are unchanged.

Measured on Jahoda with 2,000 shapes, 512 px detail, automatic Focus, 15 FPS,
reuse enabled, Mixed/Turbo, seed 42 and 16 requested WASM threads: the same first
eight selected source frames (0, 1, 4, 6, 7, 10, 12, 13) took 869.44 s of native
fitting before these changes versus 175.74 s after them, a 79.8% reduction.
The baseline ran eight full fits; the updated run used one full fit (108.69 s)
and seven refinements (67.05 s). Updated total processing, including decoding,
Focus and motion, was 179.18 s. All eight outputs retained 2,000 shapes plus the
background. This is a matched opening-prefix fitter measurement, not a complete
GIF elapsed-time claim. The cut at source frame 24 still requires a full fit.
The updated run's last frame retained 97.7% global / 99.5% Focus edge contrast;
reference retention was 99.1% / 100.7%. This is a quality guard, not proof that
reuse is visually identical to independent fitting. Exported JSON is unchanged.


## Concurrent temporal sequences and first-eight latency

Jahoda was benchmarked at 2,000 shapes, 512 px detail, automatic Focus, 15 FPS,
Mixed/Turbo and seed 42 on a 16-logical-CPU Ryzen 9 6900HX. Both cases processed
all 28 selected frames from the original 54-frame GIF. Four concurrent temporal
sequences, with four fitting threads each, took **698.33 s** (11:38); eight
sequences with two threads each took **554.14 s** (9:14), **20.65% less wall time**.
The four/eight cases needed 13/15 full starting or fallback fits respectively;
the rest were native refinements. Packed first-fit states at shared starting
source frames 0, 13, 28 and 42 matched exactly across thread counts. The earlier
single-sequence full-GIF run was interrupted after exceeding 1,200 seconds; it
is an incomplete lower bound, not a measured full serial comparison.

After the shared-start, repair and cut-boundary changes, both counts were
retested with the same opening stage: four later-frame sequences took **558.99 s**
(9:19), versus **436.80 s** (7:17) for eight. Eight used **21.86% less wall time**
and remains the default maximum. The opening stage can refine seven predictions
concurrently regardless of the later-sequence benchmark limit; both cases use
the same total 16-thread fitting budget. The four case used six full fits and
22 refinements, but a longer sequence created a slower tail.

The implementation uses up to eight sequences, bounded by the requested total
fitting CPU budget and an estimated memory allowance. Fewer sequences are used
for small CPU/memory budgets or short clips. Low-count/small-detail jobs remain
serial. A timeline prepass preserves source timing and caches at most 64 MiB of
opening-frame pixels; original pixels are fitted by Primeval without a change
to shape count, fitting detail, native full-fit algorithm or static JSON.

To improve preview latency, the opening frames share one full fit. Motion and
Focus-map warps are composed from the selected source frames, then multiple
native refiners work from those predictions. Predictions get a real refinement
before the final quality decision. Parallel sequences also try repair rather
than immediately restarting when the early prediction heuristic rejects a
start. Up to two additional native repair passes are permitted before a full
restart. Timeline thumbnails select sequence boundaries near detected cuts,
avoiding a concentration of expensive fits inside one sequence. The final
global/Focus colour and edge/contrast checks are unchanged. Cuts in the opening
frames use sequential reuse instead. Missing pixel caches also use sequential
reuse. Cached-seed diagnostics exclude the first fit and are not complete job
timings.

The final **unseeded** run processed the complete GIF in **436.80 s** (7:17),
including timeline decoding and automatic Focus. It produced the first eight
frames in **137.58 s**, below the requested 140.8 s (80% of 176 s): 21.8% less
opening-frame wall time. A previous shared-start run measured 129.85 s; timings
vary with host load. The final run used nine full fits and nineteen refinements
across all 28 selected frames, with two additional repair passes. All outputs
retained 2,000 shapes plus the background, represented by 2,001 pooled fitted
logical controls. Lua export was 948,149 bytes. The opening eight frames used one full
fit and seven refinements, without full-refit fallbacks. Native fitting timers
summed across concurrent workers overlap and must not be compared to elapsed
wall time.

Seed state stays in private worker messages. Painter-order identity maps are
composed across repair passes. Sequence-local control IDs are matched once at
boundaries, then retain that mapping in the compressed frame payload.
Opening shared-start frames inherit the same first-fit identities.
The live preview accepts out-of-order completed frames, counts only ready
frames and seeks the nearest available frame. GIF and video share this path.
No new UI labels were introduced; existing localized text is reused.


Fitted outputs can differ from independent full fits. Mean RGB error (0-255)
at source frame 13 was 4.50 for the prior sequential-reuse output versus 4.63
for the shared start. At source frame 18 an independent full fit measured 3.43
versus 4.43 for the repaired reuse. The source-frame-24 cut output matched the
full-fit PNG exactly. These samples and the unchanged final acceptance limits
bound the tradeoff; they do not claim pixel-identical results for all frames.

Global pooled-frame capacity is checked across all child results, retaining the
device-dependent fitted-state limit and propagating localized resource errors. Counts
are never silently truncated. Intermediate high-rate or duplicate timestamps
retain the original worker's timing semantics. Browser regressions exercise
parallel GIF/video output, opacity, image scale, timing, fallback and deliberately
out-of-order live frame delivery. Optional historical fill goldens and Fengari
checks were unavailable; native animation Lua VM checks passed.

## Budgeted Lua playback

The player decodes the existing channel-compressed payload into fixed painter
slots during bounded loading. Child sibling indices are assigned once, after
creation; playback performs no sibling reordering, UI allocation or Color
allocation. Existing fitting data, compact quantization, dimensions, timing and
static JSON remain unchanged. Exactly transparent, zero-size and conservatively
off-mask primitives are omitted from rendered snapshots only.

Two control pools share the original rectangular mask. The back pool is inactive
while changed properties are prepared over multiple game updates. Only complete
frames become visible, using at most two parent activation calls per swap. Each
update scans at most 512 controls and performs at most `MAX_UI_CALLS` native
property writes, including the swap reservation. The default budget is 2,048
from the first prepared frame; there is no automatic frame-time throttling.
This is a call-count budget, not an engine time measurement. Under load the player holds
the last complete pose and skips outdated poses rather than updating a visible
frame partially. Stored frames, fitting counts and requested FPS are retained.

The tradeoff is two resident control pools and longer bounded startup. Only one
pool renders, but rendering thousands of overlapping images and enabling a large
hierarchy can still cost engine time. No runtime texture-upload or UI batching
API has been verified. In-game frame time must be measured before claiming a
lag-free result. Set `FREEZE_FRAME=1` in an exported script to stop updates after
the first pose; remaining scene slowdown then isolates resident/rendering cost.

`scripts/upgrade-animation-player.cjs` replaces the player in recognized saved
exports without fitting again. It parses header literals without executing Lua
and preserves payload, width, compact settings, template and timing. Output is
restricted to the workspace `Lua/` directory and preserves the source file.
Use the same parent control and a plain Image Control template as before.

Native Lua mock checks cover complete frame visibility on every callback,
geometry/color/painter-order parity, looping, delayed updates, FPS, jitter,
fixed budgets, frozen playback and allocation-free transitions. A fully on-screen
2,000-control fixture stays within a configured 128-call budget. The saved
Jahoda export (1,001 controls, 28 frames) preserves its exact decoded compact
data, peaks at 2,048 UI writes per callback and performs zero steady-state
sibling writes. Its two pools plus mask/groups create 2,005 controls. These are
API-mock correctness/work bounds, not measured game FPS or engine frame times.

The initial adaptive limiter had a throughput regression: it compared update
times to the smallest observed delta. Alternating 1/75 s and 1/50 s updates
collapsed its budget to 128 calls, producing only seven Jahoda transitions in
six simulated seconds. Automatic throttling is removed. Preparation prediction
also no longer adds two extra game frames of lookahead, and a just-completed
late frame is presented instead of discarded. Stale buffers that were already
waiting before a clock jump are still skipped. The same saved export now makes
92 transitions in that six-second jitter profile, with its payload unchanged.
A fully on-screen 2,000-control stress fixture makes 72 transitions under jitter
and 57 with periodic doubled update intervals. These simulated-time counts
exclude startup and include no real engine costs. The regressions use positive
time steps throughout playback, without zero-time draining between poses.

## Standalone playback comparison scripts

`node scripts/prepare-animation-variants.cjs <saved.lua> [prefix]` writes two
experiments under `Lua/`, preserving primitive values, screen geometry and timing.
The fast variant may rewrite private draw ranks and compressed channels; the
preloaded variant preserves the original payload/header literals.
Their shared startup loader converts coordinates and cached colors to native
setter arguments once. Website exports and the JSON format are unchanged.

The initial `fast` variant keeps one fixed-painter-order pool. Startup compiles adjacent
frame changes into six flat setter lists containing direct control references
and precomputed arguments. Playback runs those lists without scanning shape
fields, sorting, scaling, color creation or parent activation. Clock jumps use
an exact direct-difference fallback. Changes happen in one callback rather than
across a back buffer. This reduces Lua overhead but can create larger native
setter bursts; it does not eliminate native UI rendering/update costs.

The `preloaded` variant creates a separate transparent parent and complete set
of visible children for every stored frame, all inside the original mask. All
frames finish loading before playback starts. Initialization is batched to
avoid the previous execution-timeout issue. Only the selected frame parent is
active afterward. Each transition disables the previous parent and enables the
new parent: exactly two API calls, with no child updates or sibling changes.
All frame controls remain resident, and engine activation/rendering can still
have costs beyond the script's two calls.

For the saved 1,001-control, 28-frame Jahoda export, the native Lua mock records
1,002 controls for `fast`, versus 2,005 for the buffered player and 28,057 for
`preloaded`. In the six-second jitter simulation, `fast` uses about 75% fewer
Lua VM instructions per transition (82,752 versus 337,502), while native writes
remain similar (4,639 versus 4,693 per transition). Its peak is 4,672 writes in
one callback. Preloading uses two writes per transition. All variants show 92
transitions, with exact geometry/color/painter order. Instruction counts include
the mock API and watchdog instrumentation and are not engine timing results.

`npm test` includes 16 compact/lossless loop, nonloop, frozen and static variant
cases, cancellation during partial startup, and fully visible 2,000-control
cases. Both 2,000-control variants show 85 transitions in six simulated seconds
at retained 70 ms pose timing; the preloaded case creates 6,004 controls for its
three frames. Checks cover cleanup, startup instruction bounds, no steady native
allocation and exact visual field parity. Actual in-game frame time and memory
limits remain unmeasured.

## Further fast-player compute optimization

The updated fast player caches each control's own native method references.
Playback calls each cached method with its original receiver; it never assumes
that a function retrieved from one userdata is safe to reuse on another. Shapes
are grouped by changed-field mask, with statically generated specialized loops
reading the control and its arguments once. Only 33 reachable masks are emitted.
There is no dynamic Lua compilation, steady allocation or painter reordering.
Idle updates return before timeline searching; normal adjacent steps use a
cached deadline, with a binary-search fallback for clock jumps and loop wraps.

With `TRANSFORM_GEOMETRY=true` (default), each child uses a unit-size stretched
quad and represents its dimensions through local scale. The final affine
position, extent and rotation match the previous size-delta representation for
the required plain Image template. The mask size remains unchanged. This removes
playback size-delta writes; the effect on native mesh/layout work is an inference
requiring in-game measurement. Set this parameter false for an engine comparison
using the old geometry representation with the other optimizations retained.

Against the saved Jahoda file in the same instrumented native-Lua mock, the
previous fast player averages 106,295 VM instructions per transition, versus
74,979 for the new player: about 29.5% less. Method lookups fall from 3,638 to zero
per transition. Size-delta writes fall from 999 to zero, replaced by 999 scale
writes. Both retain 4,639 native property writes per transition, 1,002 controls,
92 transitions in six simulated seconds and the exact fitted payload/timing.
The new script is 405,009 bytes versus 397,211 previously. Counts include mock
and watchdog work; they are not engine timings or a predicted FPS gain. The
user's observed 50 FPS fast versus 30 FPS preloaded also suggests native UI
residency/activation costs matter, rather than Lua computation alone.

Native regressions cover every changed-field combination for persistent shapes,
visibility changes, cached receiver-bound methods, both geometry representations,
compact/lossless output, loop wraps, negative deltas, long stalls, explicit FPS
caps, static/frozen poses, cancellation and 2,000-control stress. The visual
checks compare final transformed geometry as well as image/color/painter order.
The website and JSON exporter are unchanged by these standalone experiments.

## Dependency-aware draw scheduling

The next pass targets native operations, not fitting quality or frame rate.
All primitive fields except private Lua draw rank stay byte-for-byte identical.
The JSON exporter and website are untouched. A plain stretched Image template
with the existing shape assets is required.

1. **Spatial dependency graph.** A uniform spatial hash finds intersecting padded
   shape bounds in original painter order, then stores the precedence edges in
   compressed sparse rows. Padding covers at least two source pixels and two
   output UI units. Only disjoint shapes can commute; no overlapping layer pair
   can reverse. Off-mask/transparent handling matches the existing player.
2. **Cost-aware temporal assignment.** Ready sets use typed bitsets indexed by
   prior draw position, with field-value indices for exact size, angle and color
   matches. The planner minimizes actual property changes with extra weight on
   image-asset changes. It compares identity and material-run seeds, performs up
   to three cyclic relaxation passes, and applies bounded precedence-preserving
   swap search. A candidate must not increase total writes or texture-family
   runs versus the original plan; the original plan is the fallback. Dependency
   graphs exceeding 2,000,000 edges fail explicitly without truncating primitives.
3. **Specialized execution and representation.** Native methods are shared only
   after checking actual function identity on every control. Receiver-bound or
   non-function callable methods retain their per-control cached path. Geometry
   branches are selected outside hot loops. Export-only sibling-order channels
   are removed from the private compressed payload by copying the remaining bit
   ranges exactly, reducing file size and startup decoding.

The independent verifier reconstructs rotated bounds from all four corners,
checks all primitive values/settings, and tests all potentially overlapping
pairs without using the optimizer's spatial graph. For Jahoda it certifies
832,449 overlapping pairs across 28 frames, alongside 13,181,551 disjoint pairs.
Negative tests deliberately reverse overlapping layers or alter geometry and
must be rejected. Stream-stripping tests include a zero-bit payload.

Against the 55-FPS version supplied before this pass, the same six-second Lua
mock measures 642 to 151 image changes per transition (76.5% fewer), 4,639 to
4,123 total property writes (11.1% fewer), and 77,111 to 64,805 VM instructions
(16.0% fewer). Both show 92 transitions with 1,002 native controls and no steady
allocations/reordering. The file shrinks from 405,009 to 385,277 bytes (4.9%).
Peak setter count is essentially unchanged (4,672 to 4,663), so this does not
claim to eliminate hard-cut hitches. Texture-family runs are a scheduling proxy,
not measured GPU draw calls. Actual game FPS and low-end rendering cost remain
unmeasured; retaining 1,000 visible fitted shapes still has a native cost.

## Standalone native frame batches

**Failed in-game; disabled by default.** The user reported that only certain
shapes move with the cached sequences. The fake native API passed this experiment
but did not reproduce the engine's behavior. Its counters below are historical
model results, not evidence of a working optimization. The cause is unresolved.
Saved fast scripts and the variant generator now default to `NATIVE_BATCH=false`.
See [Lua playback testing](lua-playback-testing.md) for the visual mock, its
independent timeline checks and the limits of what it verifies.

The user confirmed that two frozen fitted images return to normal FPS, pointing
to animation updates as the important cost in that test. A shared controller
prototype was set aside at the user's request. Players remain standalone: attach
one script per GIF to the same existing parent/template setup. There is no
shared manager, new layout, peer discovery or intentional phase offset.

With `NATIVE_BATCH=true`, startup builds a native Tween Sequence for each unique
retained pose, reusing the same image controls. Its parallel child Tweens contain
the absolute position, scale/size, Z rotation and cached color targets. Each
transition applies the small image/visibility delta, starts or restarts that
pose's sequence and immediately completes it in the same update. It does not
interpolate between the fitted frames. Full targets also handle skipped display
timestamps and explicit lower playback caps without relying on prior geometry.
Identical retained frame tables share a cached sequence.

Snapshot creation is bounded to 24 controls per loading update. The first pose
is shown while the native cache builds; timed playback starts once it is ready.
No new UI or
Tween objects are requested during playback. Sequences are killed before image
controls during cleanup, including cancellation with a partially built cache.
`NATIVE_CACHE_LIMIT=65536` bounds the estimated cached Tween count. Exceeding this
bound, missing native APIs or setting `NATIVE_BATCH=false` uses the complete
direct player and reports automatic fallback; it never reduces shape/frame count
or detail. A longer startup and additional native cache memory are tradeoffs.

The API reference documents `TweenSequence` construction, Append/Join, Play,
Restart, Complete and Kill, but does not include a confirmed game demo of this
sequence path. The Lua host model checks those documented states, relative
receiver correctness, final geometry/color on every callback, loop reuse,
nonloop/frozen/static behavior, arbitrary seeks, FPS caps, fallback and cleanup.
It cannot establish actual engine throughput or native memory cost.

For Jahoda the model records 153 Lua/native submissions per transition instead
of 4,123, with 28,028 cached child Tweens and 28 sequences. UI count stays 1,002.
Two separate independently attached copies keep 2,004 UI controls; over the
same six seconds, model submissions fall from 741,312 to 26,822, and their peak
per game update falls from 9,326 to 1,330. No controller is involved. An existing
Aranara export also passes full endpoint checks, and a mixed Jahoda/Aranara
two-script test retains 2,004 controls with 82,082 cached Tweens.

These are submission/work-model counts, not measured game FPS. Restart restores
initial fields and Complete applies final fields, so this can perform additional
internal native writes. Reducing Lua crossings is not equivalent to eliminating
engine update work. In-game sequence behavior, memory and FPS still need testing;
the direct path remains available as a one-line comparison in the same script.

## Direct skip tapes and rolling preparation

The user subsequently confirmed that Lua-only profiling restores normal FPS.
Native strategy calibration was tried, then removed from normal fast exports
after a hitch report. Normal files now keep direct updates and omit all live
trials and probes; see [native UI update policy](native-ui-update-policy.md).

**Rolling preparation failed in-game and is not recommended.** Its measurements
below are historical mock results. Current work targets the one-pool fast player;
see [fast-kernel research](lua-fast-kernel-research.md) for the tested changes
and their limits.

The saved one-pool fast player now compiles exact two-step transitions across
unusually short frames. These bypass the per-shape comparison scan when a game
update skips a short frame (notably Jahoda's 10 ms final frame). Uniform clips
do not allocate a second complete set of transition tapes. Other jumps retain
the exact comparison fallback. No native Tween cache is enabled.

`scripts/prepare-animation-pipeline.cjs` builds a separate rolling-pool experiment:

```powershell
node scripts/prepare-animation-pipeline.cjs "saved-animation.lua" example
```

This writes `Lua/example_client_pipeline.lua`. Attach it to the same UI parent,
using the original plain Image Control template. It creates one transparent
square mask and three transparent child groups, each with N fitted shapes.
Only one group is visible. Frozen/static clips allocate one group.

Two future poses prepare on hidden controls, with work divided by remaining
native writes and presentation deadlines. Three pools handle short frames that
leave insufficient preparation time for a two-pool pipeline. The command tapes
use deltas from the previous occupant of each pool, rather than full assignments.
Completed records update per-slot shadow references so arbitrary catch-up can
compare against the actual partially prepared state. Visibility switches happen
only after the target pose is complete. Parent `SetVisible` avoids requesting
the OnEnable/OnDisable lifecycle changes associated with `SetActive`.

The player allocates its job tables, tapes, UI controls and colors during loading;
normal playback reuses them. No controller, shared runtime, frame interpolation,
detail reduction or new website/exported JSON layout is involved. Exact
catch-up remains synchronous after a sufficiently long stall, so its cost can
still exceed the ordinary preparation budget.

Steady 60 Hz mock measurements, same saved 1,001-shape/28-frame Jahoda export,
same 92 transitions during six simulated seconds:

| Player | Peak Lua instructions/update | Peak UI writes/update | UI controls |
| --- | ---: | ---: | ---: |
| Previous direct | 114,200 | 4,663 | 1,002 |
| Direct with short-frame skip tapes | 72,700 | 4,663 | 1,002 |
| Three rolling pools | 31,200 | 1,830 | 3,007 |

Rolling preparation reduces spikes, **not total work**: Jahoda averages 73,127
mock Lua instructions and 4,371 UI writes per transition, versus 64,357 and
4,123 for the updated direct player. Three-frame deltas can change more fields
than adjacent-frame deltas; preparation of a subsequently skipped pose can also
be wasted. Two independent Jahoda scripts peak at 3,830 writes/update with
rolling preparation, versus 9,326 with direct updates, but total writes rise
from 741,312 to 793,310 over six seconds. This is a memory/throughput tradeoff
for more even update work, not proof of faster native execution.

The 2,000-shape regression fixture reduces peak writes from 8,000 to 2,982 and
peak mock instructions from 124,600 to 49,400. Aranara's rolling-player steady
peak is 784 writes/update. All measurements use emulated native calls. Native
visibility inheritance, hidden update cost, memory pressure and game FPS still
require in-game comparison; retain the one-pool version for that comparison.

`npm test` includes rolling-pool parity checks for compact/lossless data, odd/even
clip lengths, painter order, all fields, short frames, jumps, receiver-bound
methods, FPS caps, freezing, nonloop playback, cancellation and two independent
instances. `npm run test:lua-preview` checks the standalone visual report.

## Faster standalone startup

Saved direct and rolling-pool scripts now show their first fitted pose before
decoding the remainder of the clip. This uses the real first control pool, not
a separate preview image or duplicate controls. Its painter order is established
before the mask becomes visible. Playback still starts after decoding and command
preparation complete, so frame timing and catch-up behavior are unchanged.

Startup scheduling now permits 128 controls per update (previously 20), 256
sibling assignments (previously 32), 2,048 command records (previously 128), and
6,144 weighted decoder units (previously 2,048). Thus 2,000 controls require 16
spawn callbacks instead of 100. The decoder caps new native colors at 512 per
callback, plus at most the separate transparent mask color. This preserves the
previous theoretical color-constructor bound despite the larger decoding budget.

The decoder also replaces thousands of tiny Huffman-entry tables with flat node
and length arrays, consumes a matched prefix without calculating discarded bits,
caches powers used by value reads and runs, and removes the unnecessary initial
zero-filled frame. Unused short-frame command candidates are traversed in a
bounded pass instead of yielding after every omitted candidate.

Measured actual saved Lua under the mock, counting startup updates rather than
claiming native wall-clock timings:

| Saved export/player | Previously ready | First pose now visible | Fully ready now |
| --- | ---: | ---: | ---: |
| Jahoda direct | 650 | 17 | 156 |
| Jahoda rolling pools | 784 | 18 | 181 |
| Aranara direct | 1,172 | 17 | 288 |
| Aranara rolling pools | 1,286 | 18 | 314 |

These saved exports have 1,001 controls per pose. The separate 2,000-control,
eight-frame fixture compares the same optimized codec with old scheduling/late
visibility: 467 updates until ready becomes 108, with the first pose visible at
34. The rolling version needs 158 updates with first visibility at 35. The test
checks exact preview geometry during ongoing loading, full playback parity,
cancellation, constructor bounds and the existing one-million-mock-instruction
limit per callback. All frames and selected shapes are retained. Native engine
startup cost still requires in-game validation; batch sizes remain configurable
near the top of each saved script.
