/* Pixel-perfect method: an exact copy of the image as axis-aligned rectangles
 * (image 100001), using as few controls as the heuristics below find.
 *
 * Colours are painted in layers, bottom first. An opaque colour's rectangles
 * may extend over opaque pixels of colours painted later (they are painted
 * over), so large areas become a few big rectangles with details on top.
 * Fully transparent pixels are never covered. Partially transparent pixels
 * are only covered by their own colour and never overlap anything, because
 * stacked translucent layers would blend. Each rectangle is grown from the
 * first unpainted pixel of its colour at the width/height that paints the
 * most unpainted pixels of that colour. Several colour orders and the
 * no-overlap cover are tried; the one with the fewest rectangles is kept.
 * Opacity is not applied: the image is reproduced exactly. */
"use strict";
const PixelPerfect = (() => {
  // Inputs with fewer visible pixels (GIF/video: on average per frame) select this method.
  const THRESHOLD = 1000, ASSET = 100001;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function visiblePixels(rgba) {
    let n = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) n++;
    return n;
  }

  /* Distinct visible colours in first-appearance order, each with its pixels
   * in row-major order, and the colour index of every pixel (-1 = clear).
   * null once there are `maxColors` colours. */
  function palette(rgba, width, height, maxColors = Infinity) {
    const N = width * height, pixel = new Uint32Array(Uint8Array.from(rgba).buffer);
    const index = new Map(), colors = [], colorOf = new Int32Array(N).fill(-1);
    for (let q = 0; q < N; q++) {
      const a = rgba[q * 4 + 3];
      if (!a) continue;
      let c = index.get(pixel[q]);
      if (c === undefined) {
        c = colors.length; index.set(pixel[q], c);
        if (c >= maxColors) return null;
        colors.push({ rgba: [rgba[q * 4], rgba[q * 4 + 1], rgba[q * 4 + 2], a], opaque: a === 255, pixels: [], x0: width, y0: height, x1: 0, y1: 0 });
      }
      const color = colors[c], x = q % width, y = (q - x) / width;
      color.pixels.push(q); colorOf[q] = c;
      color.x0 = Math.min(color.x0, x); color.x1 = Math.max(color.x1, x);
      color.y0 = Math.min(color.y0, y); color.y1 = Math.max(color.y1, y);
    }
    return { colors, colorOf };
  }

  /* Rectangles for colours in `order` (bottom first); with `overlap` false no
   * rectangle covers another colour. Stops after `limit` rectangles; null
   * when scanning exceeds `work` pixel visits. */
  function cover(colors, colorOf, width, height, order, overlap, limit = Infinity, work = Infinity) {
    const rank = new Int32Array(colors.length);
    let visits = 0;
    order.forEach((c, i) => { rank[c] = i; });
    const painted = new Uint8Array(width * height), out = [];
    let sums = new Int32Array(0);
    for (const c of order) {
      // Translucent pixels are covered exactly once; growth past the colour's
      // bounding box would paint nothing more of it.
      const color = colors[c], layered = overlap && color.opaque, own = rank[c];
      const allowed = (q) => {
        const other = colorOf[q];
        if (other === c) return color.opaque || !painted[q];
        return layered && other >= 0 && colors[other].opaque && rank[other] > own;
      };
      /* Best rectangle with top-left (x0, sy) that contains the seed at sx:
       * [painted count, width, height]. */
      const grow = (x0, sx, sy) => {
        let limit = 0;
        while (x0 + limit <= color.x1 && allowed(sy * width + x0 + limit)) limit++;
        // sums[k]: unpainted pixels of this colour in columns x0..x0+k-1 of the rows so far.
        if (sums.length < limit + 1) sums = new Int32Array(limit + 1);
        sums.fill(0, 0, limit + 1);
        let best = 0, bestW = 1, bestH = 1;
        for (let y = sy, span = limit; y <= color.y1; y++) {
          let run = 0;
          while (run < span && allowed(y * width + x0 + run)) run++;
          if (run <= sx - x0) break;
          span = run; visits += span;
          for (let k = 0, row = 0; k < span; k++) {
            const q = y * width + x0 + k;
            if (colorOf[q] === c && !painted[q]) row++;
            sums[k + 1] += row;
          }
          if (sums[span] > best) { best = sums[span]; bestW = span; bestH = y - sy + 1; }
        }
        return [best, bestW, bestH];
      };
      for (const seed of color.pixels) {
        if (painted[seed]) continue;
        if (out.length >= limit) return out;
        const sx = seed % width, sy = (seed - sx) / width;
        // Also try starting as far left as allowed (over pixels painted later).
        let left = sx;
        while (left > color.x0 && allowed(seed - (sx - left) - 1)) left--;
        let x0 = sx, [best, w, h] = grow(sx, sx, sy);
        if (left < sx) { const wide = grow(left, sx, sy); if (wide[0] > best) { x0 = left; [best, w, h] = wide; } }
        if (visits > work) return null;
        for (let y = sy; y < sy + h; y++) for (let x = x0; x < x0 + w; x++) if (colorOf[y * width + x] === c) painted[y * width + x] = 1;
        out.push([x0, sy, w, h, ...color.rgba]);
      }
    }
    return out;
  }

  /* Fewest rectangles found, or null when at least `limit` are needed. */
  function smallest(rgba, width, height, limit = Infinity) {
    const found = palette(rgba, width, height, limit);
    if (!found) return null;
    const { colors, colorOf } = found;
    if (!colors.length) return [];
    const ids = colors.map((_, i) => i), box = (c) => (colors[c].x1 - colors[c].x0 + 1) * (colors[c].y1 - colors[c].y0 + 1);
    const orders = [
      ids.slice().sort((a, b) => colors[b].pixels.length - colors[a].pixels.length || a - b),
      ids.slice().sort((a, b) => box(b) - box(a) || colors[b].pixels.length - colors[a].pixels.length || a - b),
    ];
    // Layered covers can rescan large areas per rectangle (a colour scattered
    // over a photo); one that grows too costly is dropped.
    const work = 64 * width * height + 1e6;
    let best = null;
    for (const [order, overlap] of [[ids, false], [orders[0], true], [orders[1], true]]) {
      const candidate = cover(colors, colorOf, width, height, order, overlap, best ? best.length : limit, overlap ? work : Infinity);
      if (candidate && candidate.length < (best ? best.length : limit)) best = candidate;
    }
    return best;
  }

  /* [x, y, width, height, r, g, b, a] per rectangle in drawing order (bottom
   * first), in pixels with y down. */
  const rectangles = (rgba, width, height) => smallest(rgba, width, height);

  /* Controls the copy needs; at least `limit` means `limit` or more (counting
   * stops there, so large photos are rejected quickly). */
  function controls(rgba, width, height, limit = Infinity) {
    const found = smallest(rgba, width, height, limit);
    return found ? found.length : limit;
  }

  const hex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

  /* Website result for one image. */
  function process(rgba, width, height, config = {}) {
    if (!(width > 0 && height > 0) || rgba.length !== width * height * 4) throw new Error("Invalid image dimensions");
    const unit = clamp(Number(config.image_scale) || 1, 0.1, 100);
    const origin = config.origin || {}, custom = origin.type === "custom";
    const center = { x: origin.type === "top_left" ? 0 : custom ? Number(origin.x) : width / 2,
      y: origin.type === "top_left" ? 0 : custom ? Number(origin.y) : height / 2 };
    let transparent = false;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) { transparent = true; break; }
    const visible = visiblePixels(rgba);
    const elements = rectangles(rgba, width, height).map(([x, y, w, h, r, g, b, a]) => {
      const alpha = a / 255, cx = (x + w / 2) * unit, cy = -(y + h / 2) * unit;
      return { type: "rectangle", shape: "rect", primitive_type: "rect", image_type: "basic", image_asset_ref: ASSET,
        center: { x: cx, y: cy }, relative: { x: cx - center.x * unit, y: cy + center.y * unit },
        size: { width: w * unit, height: h * unit }, rotation: { x: 0, y: 0, z: 0 },
        color: hex([r, g, b]), alpha, packed_color: ((a * 16777216) + (r << 16) + (g << 8) + b) >>> 0 };
    });
    return {
      mode: "fill", image_center: center, image_size: { width, height }, elements_count: elements.length, elements,
      config: { mode: "fill", engine: "pixel-browser", fit_method: "pixel", allowed_shapes: ["rect"],
        pixel_per_unit: 1 / unit, unit_scale: unit, image_scale: unit, num_primitives: elements.length, output_alpha: 1,
        enable_png_mode: transparent, output_has_transparency: transparent, fill_variant: transparent ? "png" : "mask",
        visible_pixels: visible },
      mask: { enabled: false },
    };
  }

  return { THRESHOLD, ASSET, visiblePixels, rectangles, controls, process };
})();
if (typeof module !== "undefined") module.exports = PixelPerfect;
