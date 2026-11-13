/* Splat core checks: kernel shape, analytic gradients against finite
 * differences, fitting progress, element/JSON round trips and the Lua export.
 * Run: node tests/splat/run_tests.js */
"use strict";
const assert = require("assert");
const path = require("path");
const Core = require(path.join(__dirname, "../../js/splat-core.js"));
const { processSplat } = require(path.join(__dirname, "../../js/worker-splat.js"));
global.LuaExport = require(path.join(__dirname, "../../js/lua-export.js"));
const SplatExport = require(path.join(__dirname, "../../js/splat-export.js"));

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function image(width, height, fn) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(fn(x, y), (y * width + x) * 4);
  return rgba;
}

test("kernel profile is 0 at the edge and 1 at the core", () => {
  assert.strictEqual(Core.profile(0), 0);
  assert.strictEqual(Core.profile(1), 1);
  assert.ok(Math.abs(Core.profile(0.5) - 0.5) < 1e-12);
});

test("single opaque splat fills its core and fades out", () => {
  const p = new Float64Array([16, 16, 20, 10, 0, 1, 0, 0, 1, 1, 1]);
  const { pixels } = Core.render(p, 1, 32, 32, [0, 0, 0, 0], 4);
  const at = (x, y) => pixels[(y * 32 + x) * 4 + 3];
  assert.ok(Math.abs(at(16, 16) - 1) < 1e-9, "centre opaque");
  assert.ok(at(16, 11) > 0 && at(16, 11) < 1, "ramp is soft");
  assert.strictEqual(at(16, 2), 0, "outside is empty");
  assert.strictEqual(at(28, 16), 0, "outside x is empty");
});

test("analytic gradients match finite differences", () => {
  const W = 24, H = 20;
  const target = Core.premultiply(image(W, H, (x, y) => [x * 10, y * 12, 128, 255]));
  const base = new Float64Array([
    11.3, 9.7, 9, 7, 0.4, 0.5 * 0.7, 0.2 * 0.7, 0.6 * 0.7, 0.7, 1.1, 0.9,
    13.1, 10.2, 6, 11, -0.3, 0.1 * 0.5, 0.8 * 0.5, 0.3 * 0.5, 0.5, 0.8, 1.2,
  ]);
  const bg = [0.2, 0.3, 0.4, 1];
  // Loss as a function of the params, via a fresh fitter each time.
  const lossOf = (p) => Core.createFitter(target, W, H, p.slice(), bg).loss();
  // The fitter's Adam step consumes gradients; recover them from one step with a tiny learning rate.
  // Instead, check the loss decreases along the analytic descent direction for each parameter group.
  const f = Core.createFitter(target, W, H, base.slice(), bg);
  const before = f.loss();
  for (let i = 0; i < 30; i++) f.step(0.3);
  // Bands must add up to the full-image gradient.
  const n = 2, whole = Core.createBand(target, W, H, null, bg).pass(base, n, Core.rampCap(H), 0, H);
  const top = Core.createBand(target, W, H, null, bg).pass(base, n, Core.rampCap(H), 0, 7);
  const bottom = Core.createBand(target, W, H, null, bg).pass(base, n, Core.rampCap(H), 7, H);
  assert.ok(Math.abs(top.loss + bottom.loss - whole.loss) < 1e-12, "band losses add up");
  for (let j = 0; j < n * Core.STRIDE; j++) assert.ok(Math.abs(top.grad[j] + bottom.grad[j] - whole.grad[j]) < 1e-9 * Math.max(1, Math.abs(whole.grad[j])), "band gradients add up at " + j);
  const after = f.loss();
  assert.ok(after < before, `loss should drop: ${before} -> ${after}`);
  // Direct finite-difference check of one coordinate's sign via a probe step.
  for (const index of [0, 1, 2, 3, 4, 9, 10, 13]) {
    const h = 1e-4, plus = base.slice(), minus = base.slice();
    plus[index] += h; minus[index] -= h;
    const numeric = (lossOf(plus) - lossOf(minus)) / (2 * h);
    const g = Core.createFitter(target, W, H, base.slice(), bg)._gradient(index);
    const scale = Math.max(1e-9, Math.abs(numeric), Math.abs(g));
    assert.ok(Math.abs(numeric - g) / scale < 2e-3, `param ${index}: numeric ${numeric} analytic ${g}`);
  }
});

test("fitting a small image lowers the loss and keeps the splat count", async () => {
  const W = 64, H = 48;
  const rgba = image(W, H, (x, y) => (x - 32) ** 2 + (y - 24) ** 2 < 200 ? [230, 60, 40, 255] : [30, 90, 200, 255]);
  const result = await processSplat(rgba, W, H, { num_primitives: 120, splat_iterations: 300, splat_resolution: 64 });
  const splats = result.elements.filter(Core.isSplat);
  assert.strictEqual(splats.length, 120);
  assert.ok(result.elements[0].is_background, "opaque image gets a background element");
  assert.ok(result.config.final_loss < 0.01, "final loss " + result.config.final_loss);
  const preview = new Uint8ClampedArray(result.preview_rgba);
  const px = (x, y) => Array.from(preview.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
  assert.ok(px(32, 24)[0] > 150, "red centre " + px(32, 24));
  assert.ok(px(3, 3)[2] > 150, "blue corner " + px(3, 3));
});

test("transparent images get no background and keep alpha", async () => {
  const W = 40, H = 40;
  const rgba = image(W, H, (x, y) => Math.abs(x - 20) < 10 && Math.abs(y - 20) < 10 ? [250, 250, 0, 255] : [0, 0, 0, 0]);
  const result = await processSplat(rgba, W, H, { num_primitives: 60, splat_iterations: 200, splat_resolution: 40 });
  assert.ok(!result.elements.some((el) => el.is_background));
  assert.ok(result.config.output_has_transparency);
  const preview = new Uint8ClampedArray(result.preview_rgba);
  assert.ok(preview[(2 * W + 2) * 4 + 3] < 40, "corner stays transparent");
  assert.ok(preview[(20 * W + 20) * 4 + 3] > 200, "centre is opaque");
});

test("elements round trip to upstream JSON fields", () => {
  const p = new Float64Array([30, 10, 8, 4, 0.5, 0.2, 0.3, 0.4, 0.5, 1.5, 0.75]);
  const els = Core.toElements(p, 1, 100, 50, 200, 100, 1);
  const el = els[0];
  assert.deepStrictEqual(el.center, { x: 60, y: -20 });
  assert.ok(Math.abs(el.rotation.z + 0.5 * 180 / Math.PI) < 1e-9);
  const ir = Core.toIr([Core.backgroundElement([0.1, 0.2, 0.3, 1], 200, 100, 1), el], 200, 100, 1);
  assert.strictEqual(ir.aspect_ratio, 2);
  assert.deepStrictEqual(ir.splats[0].pos, [0.3, 0.8]);
  assert.deepStrictEqual(ir.splats[0].size, [0.08, 0.08]);
  // +0.5 rad with y down turns clockwise on screen, which is −0.5 rad counter-clockwise with y up.
  assert.ok(Math.abs(ir.splats[0].rot + 0.5) < 1e-6, "y-up rotation is counter-clockwise");
  assert.ok(Math.abs(el.rotation.z - ir.splats[0].rot * 180 / Math.PI) < 1e-4, "element rotation matches the game's Z angle");
  assert.deepStrictEqual(ir.splats[0].scale, [1.5, 0.75]);
  assert.ok(Math.abs(ir.splats[0].color[3] - 0.5) < 1e-9);
  assert.ok(Math.abs(ir.background[3] - 1) < 1e-9);
});

test("Lua export packs every splat and decodes losslessly", async () => {
  const W = 64, H = 48;
  const rgba = image(W, H, (x, y) => [x * 4, y * 5, 100, 255]);
  const result = await processSplat(rgba, W, H, { num_primitives: 50, splat_iterations: 40, splat_resolution: 64 });
  const payload = { image_name: "test", origin: { x: W / 2, y: -H / 2 }, image_size: result.image_size, config: result.config, elements: result.elements };
  const lua = SplatExport.buildLuaScript(payload, { imageTemplateIndex: "7" });
  assert.ok(lua.includes("local IMAGE_TEMPLATE_INDEX=7"));
  assert.ok(lua.includes("Enum.ImageType.Stretch"));
  assert.ok(lua.includes("106057"));
  const rows = SplatExport.rows(payload);
  assert.strictEqual(rows.count, 50);
  const decoded = SplatExport.decodeForTest(lua);
  assert.strictEqual(decoded.length, 50);
  assert.deepStrictEqual(decoded, rows.values);
  const placeholder = SplatExport.buildLuaScript(payload, {});
  assert.ok(placeholder.includes("local IMAGE_TEMPLATE_INDEX=1234567890"));
});

// Runs the exported script in a real Lua VM against a recording mock of the
// game's UI API and checks every control. Skipped when no Lua is installed.
const { spawnSync } = require("child_process");
const nativeLua = ["lua", "texlua"].find((command) => {
  const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
});
test("Lua script runs and places every splat" + (nativeLua ? "" : " (skipped: no Lua)"), async () => {
  if (!nativeLua) return;
  const fs = require("fs"), os = require("os");
  const W = 96, H = 64;
  for (const kind of ["opaque", "transparent", "repeated"]) {
    const opaque = kind !== "transparent";
    const rgba = image(W, H, (x, y) => opaque ? [x * 2, y * 3, 90, 255] : (x > 20 && x < 70 ? [200, 40, 40, 255] : [0, 0, 0, 0]));
    const result = await processSplat(rgba, W, H, { num_primitives: 300, splat_iterations: 30, splat_resolution: 96 });
    const payload = { image_name: "t", origin: { x: 10, y: -12 }, image_size: result.image_size, config: result.config, elements: result.elements };
    if (kind === "repeated") {
      // A repeating pattern makes the packer choose its LZ stream.
      const base = result.elements.filter(Core.isSplat).slice(0, 7);
      payload.elements = [result.elements[0], ...Array.from({ length: 2100 }, (_, i) => structuredClone(base[i % 7]))];
    }
    const lua = SplatExport.buildLuaScript(payload, { imageTemplateIndex: "5" });
    if (kind === "repeated") assert.ok(lua.includes("symbol()"), "LZ reader used");
    const decoded = SplatExport.decodeForTest(lua), expectedRows = SplatExport.rows(payload).values;
    const firstBad = decoded.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(expectedRows[i]));
    assert.ok(decoded.length === expectedRows.length && firstBad < 0, `${kind}: row ${firstBad} ${JSON.stringify(decoded[firstBad])} vs ${JSON.stringify(expectedRows[firstBad])}`);
    const harness = `
local made={}
local function control()
  local c={alive=true,scale={1,1}}
  function c:SetAnchorMin() end function c:SetAnchorMax() end function c:SetPivot() end
  function c:SetActive() end function c:SetVisible() end
  function c:SetImage(source,asset) self.asset=asset end
  function c:SetSizeDelta(w,h) self.w=w self.h=h end
  function c:SetAnchoredPosition(x,y) self.x=x self.y=y end
  function c:SetLocalRotation(a,b,z) self.rot=z end
  function c:SetLocalScale(x,y) self.scale={x,y} end
  function c:SetSiblingIndex(i) self.sibling=i end
  return c
end
game={InstantiateClientUIControl=function(index,parent) assert(index==5,"template index") local c=control() c.parent=parent made[#made+1]=c return c end,
  DestroyClientUIControl=function(c) c.alive=false end}
Color={FromRGBA=function(r,g,b,a) return string.format("%d,%d,%d,%d",r,g,b,a) end}
Enum={ImageSource={StaticReference=1},ImageType={Stretch=1,Basic=2}}
script={object=control()}
${lua}
OnStart()
local root,canvas=made[1],made[2]
assert(root.parent==script.object and canvas.parent==root,"hierarchy")
assert(root.enableMask==true,"mask")
for i=3,#made do
  local c=made[i]
  assert(c.parent==canvas,"splat parent")
  assert(c.imageType==Enum.ImageType.Stretch,"stretch")
  print(string.format("%s|%d|%.4f|%.4f|%.4f|%.4f|%.4f|%.4f|%.4f|%s|%d",tostring(c.asset),c.sibling or -1,c.x,c.y,c.w,c.h,c.rot or 0,c.scale[1],c.scale[2],c.imageColor,i))
end
OnDestroy()
assert(root.alive==false,"cleanup")
`;
    const file = path.join(os.tmpdir(), `splat-lua-${process.pid}-${kind}.lua`);
    fs.writeFileSync(file, harness);
    const run = spawnSync(nativeLua, [file], { encoding: "utf8" });
    fs.unlinkSync(file);
    assert.strictEqual(run.status, 0, run.stderr || run.stdout);
    const lines = run.stdout.trim().split(/\r?\n/).map((line) => line.split("|"));
    const rows = SplatExport.rows(payload);
    const offset = opaque ? 1 : 0;
    assert.strictEqual(lines.length, rows.count + offset, "one control per splat plus background");
    if (opaque) assert.strictEqual(lines[0][0], "100001", "background first");
    rows.values.forEach((row, i) => {
      const got = lines[i + offset];
      assert.strictEqual(got[0], "106057");
      assert.strictEqual(Number(got[1]), i + offset, "sibling order");
      [row[0] / 10, row[1] / 10, row[2] / 10, row[3] / 10, row[4] / 10, row[5] / 1000, row[6] / 1000].forEach((want, j) => {
        assert.ok(Math.abs(Number(got[j + 2]) - want) < 1e-3, `splat ${i} field ${j}: ${got[j + 2]} vs ${want}`);
      });
      const r = row[7], g = r + row[8], b = g + row[9];
      assert.strictEqual(got[9], `${r},${g},${b},${row[10]}`);
    });
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("ok   " + name); }
    catch (error) { console.error("FAIL " + name + "\n" + (error.stack || error)); process.exitCode = 1; }
  }
  console.log(`${passed}/${tests.length} splat checks passed`);
})();
