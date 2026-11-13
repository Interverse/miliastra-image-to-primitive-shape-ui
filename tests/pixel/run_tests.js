/* Pixel-perfect checks: rectangles drawn in order reproduce every pixel
 * exactly (transparent pixels untouched, translucent pixels covered once),
 * layered overlap compresses the control count, element geometry/colour,
 * Opacity is ignored, and the visible-pixel count.
 * Run: node tests/pixel/run_tests.js */
"use strict";
const assert = require("assert");
const P = require("../../js/pixel-perfect.js");

function image(width, height, fn) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(fn(x, y), (y * width + x) * 4);
  return rgba;
}
function rebuild(rects, width, height) {
  const out = new Uint8ClampedArray(width * height * 4), cover = new Uint16Array(width * height);
  for (const [x, y, w, h, r, g, b, a] of rects)
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { cover[yy * width + xx]++; out.set([r, g, b, a], (yy * width + xx) * 4); }
  return { out, cover };
}
let seed = 11;
const random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };

const sprite = (x, y) => {
  const d = (x - 12) ** 2 + (y - 12) ** 2;
  if (d > 100) return [0, 0, 0, 0];
  if (d > 80) return [0, 0, 0, 255];
  if ((x - 9) ** 2 + (y - 9) ** 2 < 5) return [255, 255, 255, 255];
  return y > 15 && Math.abs(x - 12) < 4 ? [120, 0, 0, 255] : [255, 200, 0, 255];
};
const cases = {
  noise: [40, 30, () => [random() * 4 | 0, 0, 0, random() < 0.3 ? 0 : random() < 0.5 ? 255 : 128]],
  blocks: [32, 32, (x, y) => [(x >> 3) * 60, (y >> 3) * 60, 90, x < 4 ? 0 : 255]],
  flat: [20, 20, () => [10, 20, 30, 255]],
  alphaRamp: [16, 8, (x) => [200, 100, 50, x * 16]],
  translucentStripes: [20, 20, (x) => (x % 4 ? [255, 0, 0, 255] : [0, 0, 255, 128])],
  frame: [32, 32, (x, y) => (x === 0 || y === 0 || x === 31 || y === 31 ? [0, 0, 0, 255] : [200, 200, 200, 255])],
  dots: [32, 32, (x, y) => (x % 5 === 2 && y % 5 === 2 ? [255, 0, 0, 255] : [20, 40, 60, 255])],
  checker: [16, 16, (x, y) => ((x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255])],
  sprite: [24, 24, sprite],
  empty: [9, 7, () => [1, 2, 3, 0]],
};
const counts = {};
for (const [name, [w, h, fn]] of Object.entries(cases)) {
  const rgba = image(w, h, fn), rects = P.rectangles(rgba, w, h), { out, cover } = rebuild(rects, w, h);
  for (let q = 0; q < w * h; q++) {
    const a = rgba[q * 4 + 3];
    if (a === 0) { assert.strictEqual(cover[q], 0, `${name}: transparent pixel ${q} covered`); continue; }
    if (a < 255) assert.strictEqual(cover[q], 1, `${name}: translucent pixel ${q} covered ${cover[q]} times`);
    for (let c = 0; c < 4; c++) assert.strictEqual(out[q * 4 + c], rgba[q * 4 + c], `${name}: pixel ${q} channel ${c}`);
  }
  assert.ok(rects.length <= P.visiblePixels(rgba), `${name}: no more rectangles than visible pixels`);
  counts[name] = rects.length;
}
console.log("PASS rectangles drawn in order reproduce every pixel exactly");
// Layers: a background or outline is one rectangle under the details.
assert.strictEqual(counts.flat, 1, "a flat image is one rectangle");
assert.strictEqual(counts.blocks, 16, "16 colour blocks, one rectangle each");
assert.strictEqual(counts.frame, 2, "outline over fill: 2 rectangles instead of 92 row runs");
assert.strictEqual(counts.dots, 37, "36 dots over one background");
assert.strictEqual(counts.checker, 129, "checkerboard: one colour over the other");
assert.ok(counts.sprite <= 20, `sprite uses ${counts.sprite} rectangles (75 row runs)`);
assert.strictEqual(counts.translucentStripes, 10, "translucent columns are not overlapped");
console.log(`PASS layered overlap compresses controls (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")})`);

const big = image(600, 400, (x, y) => (x % 50 === 0 && y % 40 === 0 ? [255, 0, 0, 255] : [9, 9, 9, 255]));
let started = Date.now();
assert.strictEqual(P.rectangles(big, 600, 400).length, 121, "large flat image with 120 dots");
const photo = image(300, 200, (x, y) => [(x * 3 + y) & 255, (y * 5) & 255, (x * y) & 255, 255]);
P.rectangles(photo, 300, 200);
assert.ok(Date.now() - started < 5000, "large inputs finish quickly");
console.log(`PASS large inputs in ${Date.now() - started} ms`);

// Bounded control counts select Pixel-perfect automatically.
for (const [name, [w, h, fn]] of Object.entries(cases)) {
  const rgba = image(w, h, fn), full = P.rectangles(rgba, w, h).length;
  assert.strictEqual(P.controls(rgba, w, h), full, `${name}: unbounded count`);
  assert.strictEqual(P.controls(rgba, w, h, full + 1), full, `${name}: count under the limit`);
  if (full) assert.strictEqual(P.controls(rgba, w, h, full), full, `${name}: count at the limit`);
}
assert.strictEqual(P.controls(big, 600, 400, P.THRESHOLD), 121, "240,000 visible pixels but 121 controls");
const photo4k = image(3840, 2160, (x, y) => [(x * 3 + y) & 255, (y * 5 + x) & 255, (x * y) & 255, 255]);
started = Date.now();
assert.strictEqual(P.controls(photo4k, 3840, 2160, P.THRESHOLD), P.THRESHOLD, "a photo reaches the limit");
assert.strictEqual(P.controls(photo, 300, 200, 1000), 1000, "many colours reach the limit");
assert.ok(Date.now() - started < 3000, "photos are rejected quickly");
console.log(`PASS bounded control counts (photo rejected in ${Date.now() - started} ms)`);

const result = P.process(image(4, 2, (x, y) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 255, y ? 0 : 102])), 4, 2, { image_scale: 2, output_alpha: 0.5 });
const [red, blue] = result.elements;
assert.strictEqual(result.elements.length, 2);
assert.deepStrictEqual([red.center, red.size, red.color, red.alpha, red.image_asset_ref], [{ x: 2, y: -2 }, { width: 4, height: 4 }, "#ff0000", 1, 100001]);
assert.deepStrictEqual([blue.center, blue.size, blue.color], [{ x: 6, y: -1 }, { width: 4, height: 2 }, "#0000ff"]);
assert.ok(Math.abs(blue.alpha - 0.4) < 1e-12 && blue.packed_color >>> 24 === 102, "pixel alpha kept, Opacity ignored");
assert.deepStrictEqual(red.relative, { x: 2 - 4, y: -2 + 2 }, "relative to the image centre");
assert.ok(result.config.output_has_transparency && result.config.fit_method === "pixel" && result.config.visible_pixels === 6 && result.config.output_alpha === 1);
console.log("PASS element geometry, colour, ignored Opacity and visible-pixel count");
assert.strictEqual(P.THRESHOLD, 1000);
