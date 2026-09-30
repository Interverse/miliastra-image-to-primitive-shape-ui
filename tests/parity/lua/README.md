# Lua export suite

`js/lua-export.js` backs the result page's **Download Client Image → Lua
Script** button. It has two layers, each pinned to a community reference file
kept here verbatim:

| Layer | Reference | Contract |
|---|---|---|
| `convertJsonToLuaText` | `primitive_shaper_to_lua.py` | Character-identical data table for the `Export JSON` payload |
| `buildStandaloneLuaScript` | `PrimitiveImage.lua`, `Example.lua` | One self-contained script: the library embedded verbatim (minus its module `return`), the data table as `local MyImage`, and the example's `OnStart`/`OnDestroy` hooks with the template-index placeholder |

```bash
node tests/parity/lua/run_tests.js
```

The runner needs a Python 3 interpreter on `PATH` for the oracle comparison
and uses the `e2e/` fill goldens when they have been generated. If the
`fengari` Lua VM is resolvable (`npm i fengari` anywhere on `NODE_PATH`) it
also loads the generated script, stubs the game's `game`/`Color`/`Enum`/
`script` globals, and runs `OnStart`/`OnDestroy` for real; otherwise that
step is skipped with a note.

| Group | Checks |
|---|---|
| Goldens | Every `e2e/goldens/fill*.json` result, converted to the Export-JSON payload shape, matches the oracle character for character |
| Synthetic | Triangles, ±0.05 ties in the 0.1 quantiser, fractional `image_scale` through the `%.4f` path including exact binary ties (`1/32` → `0.0312`, half-to-even), zero/missing scale, missing `config`, negative sizes, numeric strings, non-ASCII and `null` names |
| Lenient | Inputs where the script itself raises — a numeric `rotation` (fill background) and a missing/`null` `packed_color` (outline results) — resolve to the GIA writer's values instead of failing |
| Errors | An unsupported primitive type throws in both implementations |
| Standalone | Embedded library equals `PrimitiveImage.lua`; data block embedded unchanged; no `require`; library → data → hooks order; hostile image names cannot break the string literal or the header comment; with fengari: script loads, `OnStart` instantiates root + canvas + one control per primitive with the decoded colour and `extent × 2 / 10` size, `OnDestroy` destroys the root |

Intentional differences from the script: it never escapes the image name
inside the Lua string literal; the port escapes `\`, `"`, CR and LF.
