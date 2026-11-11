# Saved Lua playback testing

The offline mock executes the saved Lua in an installed Lua 5.3+ VM (`lua` or
`texlua` on PATH), with emulated UI controls. It does not run the fitting algorithm
or replace playback with a JavaScript implementation. No deployed website files
are changed. Exported JSON remains unchanged.

Generate a self-contained visual report, then open the HTML file in a browser:

```powershell
node scripts/preview-lua-player.cjs Lua/jahoda_client_fast.lua reference/jahoda/lua-preview-jahoda.html
node tests/primeval/run-lua-preview.cjs
```

The two canvases show the actual Lua control state and independently decoded
reference primitives. Play, step or scrub through exhaustive frame visits,
two loops at 60 Hz and long-stall jumps. The report checks every visible shape's
asset, position, dimensions, rotation, color and painter slot at each captured
sample, and checks destruction of owned controls and native snapshots. Diagnostics
also compare the selected frame against an independent clock/FPS oracle on every
simulated update, so a player stuck on one otherwise correct frame fails. They
include cumulative writes and startup callback count, not estimates of game FPS.
Copy selection repeats captured images; use the separate standalone-instance
benchmark to exercise two independent Lua players.

Exit status is nonzero for mismatches or execution errors. A negative control
deliberately corrupts a shape after updates; this must show a red failure report:

```powershell
node scripts/preview-lua-player.cjs Lua/jahoda_client_fast.lua reference/jahoda/lua-preview-fault.html --inject-fault
```

Only recognized saved animation exports with the supported header/codec and
inspectable `ready`, `current`, `clock` locals are supported. Scripts execute in a
restricted Lua environment without `os`, `io`, `package`, `require`, `load` or
`debug`. Host-side instruction, process-time, output and resource limits fail
explicitly rather than removing shapes or frames. This is a developer tool for
local exports, not a hardened service for untrusted uploads.

## What passing does and does not establish

The tests establish correctness **under the fake API's assumptions**. Canvas
rectangles, ellipses and triangles approximate static textures and clip to the
image dimensions. They do not reproduce the game's texture sampling, masking,
native bridge cost, rendering, scheduling or Tween ownership behavior. They do
not measure client FPS or compare fitted quality against the original GIF.

The native Tween cache passed the old mock but failed in-game: only some shapes
moved. This is an unresolved difference between the model and engine; no specific
cause has been verified. Native results remain explicitly marked as an
experimental model. `NATIVE_BATCH=false` is now the default in saved fast scripts
and the offline variant generator. Direct updates reuse decoded frame data and
do not decode compressed frames during playback.

Game validation remains required before recommending another native optimization:
check all shapes across repeated loops, skipped frames and two standalone instances,
then measure client FPS with animation enabled and frozen. A mock pass alone
must never be described as proof of native compatibility or performance.
