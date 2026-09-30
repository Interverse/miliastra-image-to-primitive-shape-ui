/*
 * run_tests.js — Lua export parity suite.
 *
 *   node tests/parity/lua/run_tests.js
 *
 * js/lua-export.js must produce character-for-character what the community
 * converter `primitive_shaper_to_lua.py` (copied here as the oracle) writes
 * for the same Export-JSON payload. Cases:
 *   1. Every fill golden in e2e/goldens (when generated) — real element
 *      streams with mixed colours, alphas, negative offsets, rotations.
 *   2. Hand-written payloads covering triangles, half-way rounding in the
 *      0.1 quantiser, fractional image_scale (%.4f path incl. exact binary
 *      ties, which JS toFixed rounds differently), zero/negative values.
 *   3. Lenient paths the Python script cannot take (numeric rotation,
 *      missing packed_color) resolve to the documented values.
 *   4. Unsupported primitive types throw, as the script raises.
 *
 * Exit code is non-zero on any failure. Python 3 must be on PATH.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const LuaExport = require(path.join(ROOT, "js", "lua-export.js"));
const ORACLE = path.join(__dirname, "primitive_shaper_to_lua.py");
const GOLDENS = path.join(__dirname, "..", "e2e", "goldens");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error(`FAIL ${name}${detail ? "\n  " + detail : ""}`);
}

function pythonCommand() {
  for (const candidate of ["python", "python3", "py"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = pythonCommand();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lua-parity-"));

function oracle(payload, label) {
  const src = path.join(tmpDir, `${label}.json`);
  const out = path.join(tmpDir, `${label}.lua`);
  fs.writeFileSync(src, JSON.stringify(payload), "utf8");
  const run = spawnSync(PYTHON, [ORACLE, src, out], { encoding: "utf8" });
  if (run.status !== 0) return { error: (run.stderr || run.stdout || "").trim() };
  // Path.write_text() is text-mode: on Windows Python emits CRLF, elsewhere
  // LF. The port always writes LF, so compare on LF.
  return { text: fs.readFileSync(out, "utf8").replace(/\r\n/g, "\n") };
}

function firstDiff(a, b) {
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}\n  js: ${JSON.stringify(la[i])}\n  py: ${JSON.stringify(lb[i])}`;
  }
  return "";
}

function compare(label, payload) {
  const js = LuaExport.convertJsonToLuaText(payload);
  if (!PYTHON) { check(`${label} (python missing)`, false, "no python interpreter on PATH"); return; }
  const py = oracle(payload, label);
  if (py.error) { check(label, false, `oracle failed: ${py.error}`); return; }
  check(label, js === py.text, firstDiff(js, py.text));
}

/* ── 1. e2e fill goldens ─────────────────────────────────────────────── */

function payloadFromGolden(golden) {
  const result = golden.result;
  // Mirror app.js buildJsonExportPayload: background first, types normalised,
  // and make every element Python-compatible (object rotation, packed colour).
  const background = [], foreground = [];
  for (const el of result.elements) (el.is_background ? background : foreground).push(el);
  const elements = background.concat(foreground).map((el, index) => ({
    id: el.id != null ? el.id : index,
    type: el.type === "circle" ? "ellipse" : el.type === "rect" ? "rectangle" : el.type,
    center: el.center,
    relative: el.relative,
    size: el.size,
    rotation: (el.rotation && typeof el.rotation === "object") ? el.rotation : { x: 0, y: 0, z: Number(el.rotation || 0) },
    color: el.color,
    alpha: el.alpha,
    packed_color: el.packed_color !== undefined ? el.packed_color : LuaExport.packColor(el.color, el.alpha),
  }));
  return {
    image_name: golden.case,
    group_name: golden.case,
    origin: { x: 0, y: 0 },
    image_size: result.image_size,
    config: golden.config,
    mask: result.mask || null,
    elements,
  };
}

const indexPath = path.join(GOLDENS, "fill_index.json");
if (fs.existsSync(indexPath)) {
  for (const name of JSON.parse(fs.readFileSync(indexPath, "utf8"))) {
    const golden = JSON.parse(fs.readFileSync(path.join(GOLDENS, `${name}.json`), "utf8"));
    compare(`golden ${name}`, payloadFromGolden(golden));
  }
} else {
  console.log("(e2e fill goldens not generated — skipping golden cases)");
}

/* ── 2. hand-written payloads ────────────────────────────────────────── */

function el(type, x, y, size, z, packed, extra) {
  return Object.assign({
    type, relative: { x, y }, size, rotation: { x: 0, y: 0, z }, packed_color: packed,
  }, extra || {});
}

const synthetic = {
  mixed_shapes: {
    image_name: "mixed",
    image_size: { width: 153, height: 148 },
    config: { image_scale: 1 },
    elements: [
      el("ellipse", -0.5167, 0.8, { rx: 0.0733, ry: 0.0733 }, -153.43, 4294967295),
      el("rectangle", 12.34, -56.78, { width: 3.3, height: 0.7 }, 45, 2164260863),
      el("triangle", 0.05, -0.05, { width: 1.25, height: 2.35 }, -0.05, 0),
      el("triangle", 0.15, -0.15, { width: 0.1, height: 0.3 }, 359.95, 305419896),
    ],
  },
  rounding_ties: {
    // 0.1-unit quantiser: half-away-from-zero on both signs, and values
    // whose *10 product lands just under/over .5 in binary.
    image_name: "ties",
    image_size: { width: 1, height: 1 },
    config: {},
    elements: [
      el("ellipse", 0.25, -0.25, { rx: 0.35, ry: 0.45 }, 0.55, 1),
      el("ellipse", 1.05, -1.05, { rx: 2.15, ry: 2.25 }, -2.35, 1),
      el("ellipse", 0.049999, -0.049999, { rx: 0.050001, ry: 0.15 }, 1e-9, 1),
      el("rectangle", 100000.05, -100000.05, { width: 0.09, height: 0.11 }, -1e-9, 1),
    ],
  },
  fractional_scale: {
    // sourceWidth/Height take the "%.4f" path. 0.03125 = 1/32 and 0.09375
    // = 3/32 are exact binary ties at the 4th decimal: Python rounds them
    // half-to-even ("0.0312", "0.0938"), JS toFixed would give "0.0313".
    image_name: "scale",
    image_size: { width: 1, height: 3 },
    config: { image_scale: 0.03125 },
    elements: [el("ellipse", 0, 0, { rx: 1, ry: 1 }, 0, 1)],
  },
  fractional_scale_2: {
    image_name: "scale2",
    image_size: { width: 153, height: 148 },
    config: { image_scale: 0.3 },
    elements: [el("rectangle", 0, 0, { width: 1, height: 1 }, 0, 1)],
  },
  third_scale: {
    image_name: "third",
    image_size: { width: 153, height: 100 },
    config: { image_scale: 1 / 3 },
    elements: [],
  },
  scale_missing_or_zero: {
    image_name: "noscale",
    image_size: { width: 640, height: 480 },
    config: { image_scale: 0 },
    elements: [el("ellipse", 0, 0, { rx: 2, ry: 2 }, 0, 1)],
  },
  no_config: {
    image_name: "noconfig",
    image_size: { width: 8, height: 8 },
    elements: [el("triangle", -3.99, 3.99, { width: 8, height: 8 }, 180, 4278190080)],
  },
  negative_scale_result: {
    // negative source size exercises the "-" branch of %.4f formatting
    image_name: "neg",
    image_size: { width: 10, height: 10 },
    config: { image_scale: -0.00001 },
    elements: [],
  },
  string_numbers: {
    // JSON produced by hand often carries numbers as strings; float() accepts them
    image_name: "strings",
    image_size: { width: "12", height: "7.5" },
    config: { image_scale: "2" },
    elements: [el("ellipse", "1.25", "-1.25", { rx: "0.5", ry: "0.25" }, "90", "255")],
  },
  unicode_name: {
    image_name: "素材_ü_🙂",
    image_size: { width: 2, height: 2 },
    config: { image_scale: 1 },
    elements: [el("rectangle", 0, 0, { width: 1, height: 1 }, 0, 1)],
  },
  null_name: {
    image_name: null,
    image_size: { width: 2, height: 2 },
    config: { image_scale: 1 },
    elements: [],
  },
};

for (const [label, payload] of Object.entries(synthetic)) compare(`synthetic ${label}`, payload);

/* ── 3. lenient paths (Python would raise) ───────────────────────────── */

{
  const lenient = {
    image_name: "lenient",
    image_size: { width: 2, height: 2 },
    config: {},
    elements: [
      // fill background rectangle: numeric rotation, packed colour present
      { type: "rectangle", relative: { x: 0, y: 0 }, size: { width: 2, height: 2 }, rotation: 0.0, packed_color: 4294967295, is_background: true },
      // outline element: no packed_color → derived from colour + alpha
      { type: "ellipse", relative: { x: 1, y: 1 }, size: { rx: 1, ry: 1 }, rotation: { z: 10 }, color: "#f59e0b", alpha: 0.5 },
      // outline element without alpha → default 0x80 alpha
      { type: "rect", relative: { x: 1, y: 1 }, size: { width: 1, height: 1 }, rotation: { z: 10 }, color: "#abc" },
      // null packed_color with colour
      { type: "circle", relative: { x: 1, y: 1 }, size: { rx: 1, ry: 1 }, rotation: { z: 10 }, color: "#ffffff", alpha: 1, packed_color: null },
    ],
  };
  const text = LuaExport.convertJsonToLuaText(lenient);
  const lines = text.split("\n");
  check("lenient numeric rotation", lines[14] === "        {2,0,0,10,10,0,4294967295},", lines[14]);
  // alpha 0.5*255 = 127.5 → half-to-even 128 = 0x80
  check("lenient derived packed colour", lines[15] === "        {1,10,10,10,10,100,2163580427},", lines[15]);
  // 0x80 default alpha + "#abc" expanded to aabbcc
  check("lenient default alpha + short hex", lines[16] === "        {2,10,10,5,5,100,2158672844},", lines[16]);
  check("lenient null packed colour", lines[17] === "        {1,10,10,10,10,100,4294967295},", lines[17]);
  check("lenient counts", lines[9] === "    primitiveCount = 4," && lines[10] === "    ellipseCount = 2," && lines[11] === "    rectangleCount = 2,", lines.slice(9, 13).join(" | "));
}

/* ── 4. error parity ─────────────────────────────────────────────────── */

{
  const bad = { image_name: "bad", image_size: { width: 1, height: 1 }, config: {}, elements: [{ type: "hexagon", relative: { x: 0, y: 0 }, size: {}, rotation: { z: 0 }, packed_color: 0 }] };
  let threw = false;
  try { LuaExport.convertJsonToLuaText(bad); } catch (e) { threw = /Unsupported primitive type: hexagon/.test(String(e.message)); }
  check("unsupported type throws", threw);
  if (PYTHON) {
    const py = oracle(bad, "bad");
    check("oracle raises on unsupported type", Boolean(py.error) && /Unsupported primitive type: hexagon/.test(py.error), py.error || "no error");
  }
}

/* ── 5. standalone script (library + data + hooks) ───────────────────── */

{
  const libRef = fs.readFileSync(path.join(__dirname, "PrimitiveImage.lua"), "utf8").replace(/\r\n/g, "\n");
  check("embedded PrimitiveImage library is verbatim", LuaExport.PRIMITIVE_IMAGE_LIBRARY === libRef,
    firstDiff(LuaExport.PRIMITIVE_IMAGE_LIBRARY, libRef));

  const payload = synthetic.mixed_shapes;
  const script = LuaExport.buildStandaloneLuaScript(payload);
  const dataTable = LuaExport.convertJsonToLuaText(payload);
  const dataBlock = `local ${LuaExport.DATA_VARIABLE} = {\n` + dataTable.slice("return {\n".length);

  check("standalone embeds the data table unchanged", script.includes(dataBlock), "data block not found verbatim");
  check("standalone has no require()", !/require\s*\(/.test(script));
  check("standalone drops the library's module return", !/\nreturn PrimitiveImage\n/.test(script));
  check("standalone keeps library body", script.includes("function PrimitiveImage.Create(parent, art, props)") && script.includes("local PrimitiveImage = {}"));
  check("standalone defines hooks", /\nfunction OnStart\(\)\n/.test(script) && /\nfunction OnDestroy\(\)\n/.test(script));
  check("standalone wires data into Create", script.includes(`PrimitiveImage.Configure(IMAGE_TEMPLATE_INDEX)`) && script.includes(`        ${LuaExport.DATA_VARIABLE},`));
  check("standalone template placeholder", script.includes(`local IMAGE_TEMPLATE_INDEX = ${LuaExport.IMAGE_TEMPLATE_PLACEHOLDER}`));
  check("standalone order: library, data, hooks",
    script.indexOf("local PrimitiveImage = {}") < script.indexOf(`local ${LuaExport.DATA_VARIABLE} = {`) &&
    script.indexOf(`local ${LuaExport.DATA_VARIABLE} = {`) < script.indexOf("function OnStart()"));
  check("standalone ends with newline", script.endsWith("end\n"));

  // Image Control Template index: filled in when provided, TODO placeholder otherwise.
  const filled = LuaExport.buildStandaloneLuaScript(payload, { imageTemplateIndex: "  4242  " });
  check("template index fills the constant", filled.includes("\nlocal IMAGE_TEMPLATE_INDEX = 4242 -- Image Control Template index\n") && !filled.includes("TODO") && filled.includes("IMAGE_TEMPLATE_INDEX is set to 4242"));
  check("template index accepts a number", LuaExport.buildStandaloneLuaScript(payload, { imageTemplateIndex: 7 }).includes("\nlocal IMAGE_TEMPLATE_INDEX = 7 --"));
  for (const bad of ["", "   ", "12a", "-1", "1.5", "1e3", null, undefined, "99999999999999999"]) {
    const out = LuaExport.buildStandaloneLuaScript(payload, { imageTemplateIndex: bad });
    check(`invalid template index ${JSON.stringify(bad)} keeps placeholder`,
      out.includes(`\nlocal IMAGE_TEMPLATE_INDEX = ${LuaExport.IMAGE_TEMPLATE_PLACEHOLDER} -- TODO: replace with your Image Control Template index\n`));
  }
  check("no options keeps placeholder", LuaExport.buildStandaloneLuaScript(payload) === LuaExport.buildStandaloneLuaScript(payload, { imageTemplateIndex: "" }));
  check("parseTemplateIndex", LuaExport.parseTemplateIndex("0") === 0 && LuaExport.parseTemplateIndex(" 1234567890 ") === 1234567890 &&
    LuaExport.parseTemplateIndex("x") === null && LuaExport.parseTemplateIndex("+5") === null && LuaExport.parseTemplateIndex(12) === 12);

  // A name that would break a `--` comment or a string literal must not.
  const hostile = Object.assign({}, payload, { image_name: 'a"b\\c[[d\ne' });
  const hostileScript = LuaExport.buildStandaloneLuaScript(hostile);
  check("hostile name escaped in string", hostileScript.includes('name = "a\\"b\\\\c[[d\\ne",'));
  check("hostile name neutralised in header comment", hostileScript.split("\n")[0] === "-- a\"b\\c[ [d e — primitive image as a client UI script");

  /* Run it for real when the fengari Lua VM is resolvable (npm i fengari,
   * or NODE_PATH to a folder that has it). Game APIs are stubbed in Lua. */
  let fengari = null;
  try { fengari = require("fengari"); } catch (e) { /* optional */ }
  if (!fengari) {
    console.log("(fengari not installed — skipping Lua VM execution)");
  } else {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const stubs = `
      __instantiated = 0
      __destroyed = 0
      __colors = {}
      __rects = {}
      local Control = {}
      Control.__index = Control
      local function newControl() return setmetatable({ alive = true }, Control) end
      for _, m in ipairs({ "SetAnchorMin", "SetAnchorMax", "SetPivot", "SetAnchoredPosition",
        "SetLocalRotation", "SetActive", "SetVisible", "SetImage", "SetSiblingIndex", "SetLocalScale" }) do
        Control[m] = function() end
      end
      function Control:SetSizeDelta(w, h) __rects[#__rects + 1] = { w, h } end
      game = {
        InstantiateClientUIControl = function(idx, parent)
          assert(idx == 1234567890, "template index passed through")
          assert(parent ~= nil, "parent passed through")
          __instantiated = __instantiated + 1
          return newControl()
        end,
        DestroyClientUIControl = function(c) __destroyed = __destroyed + 1 end,
      }
      Color = { FromRGBA = function(r, g, b, a) __colors[#__colors + 1] = { r, g, b, a }; return { r, g, b, a } end }
      Enum = { ImageSource = { StaticReference = 1 }, ImageType = { Stretch = 1 } }
      script = { object = newControl() }
    `;
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const run = (code, label) => {
      const status = lauxlib.luaL_dostring(L, to_luastring(code));
      if (status !== lua.LUA_OK) {
        const msg = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        check(label, false, msg);
        return false;
      }
      return true;
    };
    const call = (fn) => {
      lua.lua_getglobal(L, to_luastring(fn));
      const status = lua.lua_pcall(L, 0, 0, 0);
      if (status !== lua.LUA_OK) {
        const msg = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        check(`Lua VM ${fn}()`, false, msg);
        return false;
      }
      return true;
    };
    const globalNumber = (name) => {
      lua.lua_getglobal(L, to_luastring(name));
      const v = lua.lua_tonumber(L, -1);
      lua.lua_pop(L, 1);
      return v;
    };
    if (run(stubs, "Lua VM stubs") && run(script, "Lua VM loads standalone script") && call("OnStart")) {
      const n = payload.elements.length;
      check("Lua VM instantiates root + canvas + primitives", globalNumber("__instantiated") === n + 2,
        `instantiated ${globalNumber("__instantiated")}, want ${n + 2}`);
      // primitive 1: rx=ry=0.0733 → quantised 1 → size 0.2×0.2; colour 0xFFFFFFFF → 255,255,255,255
      lua.lua_getglobal(L, to_luastring("__colors"));
      lua.lua_rawgeti(L, -1, 2); // [1] is the transparent root colour
      lua.lua_rawgeti(L, -1, 4);
      const alpha = lua.lua_tonumber(L, -1);
      lua.lua_pop(L, 3);
      check("Lua VM decodes packed colour alpha", alpha === 255, `alpha ${alpha}`);
      lua.lua_getglobal(L, to_luastring("__rects"));
      lua.lua_rawgeti(L, -1, 3); // root, canvas, then first primitive
      lua.lua_rawgeti(L, -1, 1);
      const w = lua.lua_tonumber(L, -1);
      lua.lua_pop(L, 3);
      check("Lua VM primitive size = extent*2/10", Math.abs(w - 0.2) < 1e-9, `width ${w}`);
      if (call("OnDestroy")) check("Lua VM destroys root", globalNumber("__destroyed") === 1);
    }
  }
}

/* ── formatNumber unit checks (independent of the oracle) ────────────── */

const fmt = [
  [153, "153"], [-0, "0"], [1e16, "10000000000000000"], [45.9, "45.9"],
  // 2.00005 is stored as 2.0000499999… → "2"; 2.00015 as 2.000150000000000094… → "2.0002"
  [0.03125, "0.0312"], [0.09375, "0.0938"], [2.00005, "2"], [2.00015, "2.0002"], [-0.00001, "-0"],
  [1 / 3, "0.3333"], [2 / 3, "0.6667"], [0.00004, "0"], [0.00005, "0.0001"], [1234.56789, "1234.5679"],
];
for (const [value, expected] of fmt) {
  const got = LuaExport.formatNumber(value);
  check(`formatNumber(${value})`, got === expected, `got ${got}, want ${expected}`);
}
const q = [[0.25, 3], [-0.25, -3], [0.05, 1], [-0.05, -1], [1.05, 11], [2.35, 24], [0.049999, 0], [0, 0]];
for (const [value, expected] of q) {
  const got = LuaExport.quantizeToTenths(value);
  check(`quantizeToTenths(${value})`, got === expected, `got ${got}, want ${expected}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
