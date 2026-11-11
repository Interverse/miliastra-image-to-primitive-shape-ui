# Native UI update experiments

**Retired from normal fast exports after a hitch report.** The live trial could
introduce an expensive tree reactivation when it left direct mode after six
seconds. Its average-FPS selection was not evidence of hitch-free playback.
Normal fast files now omit this policy, its probes and its configuration flags.
They stay on direct updates for their entire lifetime. A 60-second regression
checks repeated loops and verifies zero root activation/visibility/scale writes
after startup.

The policy remains available only through the developer generator's explicit
`buildVariants(source, {nativeTransactions: true})` option. Even those research
exports now default to `AUTO_NATIVE_UPDATES=false`. The remainder of this document
describes the opt-in experiment, not normal playback defaults.

The user measured approximately 48 FPS with normal animation and normal FPS
with `PROFILE_LUA_ONLY=true`. The Lua kernels alone therefore do not reproduce
the slowdown. This implicates the native binding, UI-update or rendering path;
it does not isolate which of those costs dominates.

The opt-in research player tests native edit strategies in the game.
It does not add frame buffers, extra controls, native Tween caches, shared
controllers, interpolation or a different exported JSON layout.

## Strategies

| Mode | How a frame is applied |
| --- | --- |
| 0 | Existing direct edits |
| 1 | Deactivate the generated image root, apply edits, reactivate it |
| 2 | Hide the generated image root, apply edits, show it |
| 3 | Set that root's XY scale to zero, apply edits, restore its original scale |

Only the generated child root is affected. The script's owning control stays
active. All edits and restoration finish within the same callback, without a
yield. The original fitted field values, mask and frame clock remain intact.
Modes 1–3 add two root setter calls per changed frame, rather than reducing
the number of changed primitive fields. Their purpose is to test whether native
invalidation/rebuild work can be deferred while those fields are modified.

One motivation is [Unity uGUI's Graphic implementation](https://github.com/Unity-Technologies/uGUI/blob/main/com.unity.ugui/Runtime/UGUI/UI/Core/Graphic.cs):
its dirty-registration methods return early for inactive graphics. Reactivation
also performs work and may outweigh that saving. Miliastra's underlying native
implementation and visibility inheritance are not confirmed, so this is a
measured experiment, not a claim that those engine optimizations are available.
Mode 2 does not depend on inherited hiding for final-frame correctness; if it
does not suppress work, calibration should find no benefit.

## In-game calibration

Research-policy configuration (not emitted in normal fast files):

```lua
local NATIVE_TRANSACTION_MODE=0
local AUTO_NATIVE_UPDATES=false
local NATIVE_TEST_SECONDS=6
```

When explicitly enabled, the player samples `OnUpdate(deltaTime)` cadence for direct mode
and each compatible candidate, six seconds per mode. It prints observed FPS to
the game console. A candidate must exceed the original baseline by 3%. It then
retests direct mode and the candidate for six seconds each and requires the same
improvement again. This check helps reject changes in scene load or startup
effects masquerading as an optimization.

With all candidates available, calibration takes about 24 seconds if no candidate
improves FPS, or 36 seconds if verification is needed. Keep the scene and running
instances stable until the final message:

```text
GIF native mode 0: 48.0 FPS
...
GIF native: candidate verified; mode 3 selected.
```

The numbers above illustrate the message format, not measured game results.
`mode 0 selected` means direct updates were retained. A frame longer than 250 ms
aborts calibration and restores direct mode, rather than ignoring a possible
candidate-induced stall. Calibration does not restart automatically. Once
finished, its wrapper and score tables are removed from the update path. The
selected strategy stays in memory for that instance until destruction.

To lock a verified result on subsequent runs, set `AUTO_NATIVE_UPDATES=false`
and `NATIVE_TRANSACTION_MODE` to the selected number. For the original behavior,
use false and 0. `PROFILE_LUA_ONLY=true` bypasses all native transactions and
calibration. Static/frozen images also bypass them. Nonlooping clips bypass
calibration because they can finish before a test window; a manual mode can
still be used.

The FPS samples describe client callback cadence. They are not a GPU timer or
an isolated native-function profiler. Multiple instances and other scene work
can affect them; baseline verification reduces that ambiguity but cannot
eliminate it. If all modes are equally slow, this code retains mode 0 and does
not claim an FPS improvement.

## Correctness safeguards

Before a candidate is used, the script changes a real control's geometry and
tests show/hide on up to two controls while the root is suspended. It checks
native getters after restoration: image ID/type, color,
position, dimensions, rotation, unit-quad size, anchors/pivot and mask properties.
The original pose is restored immediately. Unsupported bindings or reset fields
reject that candidate. A rejected probe triggers a bounded repair of every
control in the first pose, including template geometry and anchors; it does not
leave the untested controls in a reset state.

Frame edits use a protected call, always restoring root state before propagating
an error. There are no per-frame closures or getter scans. Cleanup releases the
policy's method references and reinstates the original update callback even if
the instance is destroyed during calibration. A getter pass checks API state;
it does not prove native rendering behavior or performance.

`tests/primeval/run-native-transactions.cjs` covers all three transactions with
shared and receiver-bound methods, exact poses, errors, cleanup, unsupported
getters, reactivation resets and policy selection/verification. Selection tests
inject known frame times to exercise the algorithm; they do not predict FPS.
Existing 2,000-control export and viewer checks remain required.

## Other experiment

`scripts/analyze-animation-occlusion.cjs` tests whether a primitive's padded,
clipped quad is fully contained by a later opaque rectangle with a conservative
interior margin. It certified zero removals in the saved Jahoda and Aranara clips.
No primitives were culled or changed. This particular result does not establish
that more general occlusion analysis could never help other inputs.
