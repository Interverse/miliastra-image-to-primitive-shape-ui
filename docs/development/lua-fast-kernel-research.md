# Fast Lua kernel research — 2026-11-10

The user later reported no game FPS improvement and confirmed normal FPS in
Lua-only mode. The instruction results below are not evidence of a game speedup.
The current follow-up is [native UI strategy calibration](native-ui-update-policy.md),
which tests the native update path in-game instead of choosing from mock timings.

This work targets the standalone, one-pool fast player. The user reported that
rolling buffers failed in-game. They are not the recommended path. The fast
player retains the original native setters, control count, fitted geometry,
colors, ordering and display timing. Exported JSON and website files are unchanged.

## Sources and applicability

- [evolved.lua](https://github.com/BlackMATov/evolved.lua), particularly its
  [performance explanation](https://github.com/BlackMATov/evolved.lua#performance),
  stores components in dense columns grouped by component sets and minimizes
  allocation during updates. We adapted that layout to existing changed-field
  command groups; importing an ECS would add unnecessary query/entity machinery.
- [The 2026 ECS comparison repository](https://github.com/uwm-se/ecs) describes a
  SAC 2026 comparison of AoS, SoA and other designs. This is contextual evidence
  for testing layouts, not a benchmark of Lua or this game.
- [Luau's upstream performance guide](https://github.com/luau-lang/site/blob/master/src/content/docs/guides/performance.md#function-inlining-and-loop-unrolling)
  describes specialization, constant bounds and unrolling. The game is not
  assumed to use Luau, and we cannot enable its compiler options. Exported kernels
  are ordinary Lua generated offline, without runtime `load`, JIT or FFI.
- [Lua's opcode definitions](https://github.com/lua/lua/blob/master/lopcodes.h)
  and [VM implementation](https://github.com/lua/lua/blob/master/lvm.c) distinguish
  variable and constant-index accesses. Fixed-index blocks avoid repeatedly
  computing `i + fieldOffset`. No particular game VM version is assumed.
- [xLua's API documentation](https://github.com/Tencent/xLua/blob/master/Assets/XLua/Doc/XLua_API.md)
  discusses generated delegates and boxing at the host boundary. Those are
  engine-integration techniques, not something a standalone script can install.
  This does not establish that Miliastra uses xLua.

These repositories were reviewed as available on the date above. Most applicable
techniques predate 2026; newer repository dates do not establish better performance.
No third-party library code or new runtime dependency was incorporated.

## Experiments

`scripts/benchmark-animation-kernels.cjs` compares layouts with 2,000 records,
all major geometry/color fields changed, and no-op native methods. Timings below
are medians of five samples of 300 passes; they exclude rendering and meaningful
native work. The test uses the available native Lua VM through `texlua`.

| Kernel | Instructions/pass | CPU ms / 300 passes | Generated kernel bytes |
| --- | ---: | ---: | ---: |
| Previous flat records | 60,017 | 96 | 16,367 |
| Dense columns | 48,024 | 76 | 23,693 |
| Table per record | 50,017 | 80 | 18,667 |
| Record `table.unpack` | 52,017 | 113 | 18,601 |
| Columns, naive 8-way unrolling | 48,032 | 86 | 129,629 |
| Hybrid, four-record blocks | 47,050 | 78 | 29,801 |
| Hybrid, eight-record blocks | 46,578 | 74 | 35,985 |
| Hybrid, sixteen-record blocks | 46,384 | 74 | 48,521 |

The selected implementation uses eight-record blocks only for masks 60 and 61:
position, dimensions, rotation and color, with an optional image change. Those
are the dominant groups in the saved GIFs. Other masks use dense columns.
Constant offsets remove address arithmetic; processing a whole block reduces
loop overhead. The final block is handled by a bounded scalar tail, including
an exactly full final block. No records are dropped or padded with UI controls.

Sixteen-record blocks saved less than 0.5% additional kernel instructions while
adding about 12.5 KB of code. Naively unrolling every handler was much larger and
did not reduce instruction count. `table.unpack` was slower despite fewer
instructions than the old layout. Hoisting method upvalues into locals did not
give a consistent instruction-count advantage. These were not selected.

The documented `localRotationZ` setter was also tested. It lowered script-only
instructions further, but the full mock's native-property mapping made the
candidate slower in the short timing comparison. Its native-game cost is not
known, so the shipped player keeps `SetLocalRotation(0, 0, z)` and the other
existing methods. Splitting XY vector updates into individual property writes
would increase host crossings when both components change; this is not the
default either. Lower instruction counts alone do not prove lower total time.

## Actual saved player measurements

The `vm` profile in `scripts/benchmark-lua-player.cjs` counts instructions only
while execution is inside the exported player source. Fake API implementations,
test assertions and the driver are excluded by source-line range. This is
separate from the older whole-mock instruction counter. Every displayed pose is
still checked against independently decoded export data outside the hook.

Three simulated seconds, 180 updates, saved exports with 1,001 fitted controls:

| Export | Transitions | Previous script instructions | New script instructions | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Jahoda | 44 | 1,231,818 | 935,828 | 24.0% |
| Aranara | 29 | 794,370 | 604,481 | 23.9% |

Per-transition averages are 27,995 → 21,268 and 27,392 → 20,844. UI writes are
identical: 180,971 and 116,448 respectively. Each script still owns 1,002 native
controls including its mask. No new controls, native snapshots, frame-time
decoding, interpolation or runtime code generation are introduced.

Longer full-mock timing uses 6,000 updates after warmup and nine rotating-order
trials, with the same payload/settings and exactly equal native submissions:

| Export | Previous median CPU ms | New median CPU ms | Observed change |
| --- | ---: | ---: | ---: |
| Jahoda | 546 | 538 | 1.5% lower |
| Aranara | 342 | 334 | 2.3% lower |

The ranges overlap, so these timings do not establish a robust large wall-time
gain. An earlier shorter test suggested about 10%, which did not hold up in the
longer comparison. Native binding/rendering cost is emulated, not measured.
The reliable result is reduced script instruction work with identical writes;
game FPS still needs validation. The generated fast files are about 14 KB larger
than the previous files; limiting block specialization to two groups avoids the
much larger cost of unrolling every mask. Failed native-cache code is no longer
emitted into the default fast script.

## In-game bottleneck isolation

The fast script includes `PROFILE_LUA_ONLY=false`, disabled by default. Set it to
`true` with `FREEZE_FRAME=0` to retain the real first fitted image while running
the animation kernels on Lua shadow controls. Native setters become no-op
functions and color assignments target plain Lua tables. There are no extra
native controls and no per-record profiling branch. Startup prints one
diagnostic message. The methods add small Lua no-op return costs; this is a
diagnostic comparison, not an exact native timing subtraction.

Compare the same scene and same instances:

| Settings | Work executed |
| --- | --- |
| `FREEZE_FRAME=0`, `PROFILE_LUA_ONLY=false` | Normal animation and native UI writes |
| `FREEZE_FRAME=0`, `PROFILE_LUA_ONLY=true` | Animation update logic, frozen native image |
| `FREEZE_FRAME=1`, `PROFILE_LUA_ONLY=false` | Frozen image, playback updates disabled |

If Lua-only returns to normal FPS while normal playback does not, native binding
or UI-update work is a substantial cost. If Lua-only remains slow while freezing
recovers FPS, the Lua update path remains important. Use both identical and
different clips if evaluating multiple instances. Do not leave the diagnostic
enabled when judging whether the GIF itself animates correctly.

## Reproduction and validation

```powershell
node scripts/benchmark-animation-kernels.cjs reference/kernel-results.json
node scripts/benchmark-lua-player.cjs saved.lua candidate.lua vm
node scripts/benchmark-animation-runtime.cjs reference/timing.json before.lua after.lua
npm test
npm run test:lua-preview
```

Semantic tests cover every reachable mask, both geometry modes, shared and
receiver-bound methods, block sizes 4/8/16, and counts immediately below/at/above
block boundaries. Full-player checks cover 2,000 shapes, alpha/culling, painter
order, loops, short-frame skips, long jumps, FPS caps, startup preview,
cancellation and cleanup. The Lua-only diagnostic advances frames with zero
native writes. Optional historical goldens and Fengari are separate skips.
