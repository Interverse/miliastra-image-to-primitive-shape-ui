/* GaussianImage-style 2D splats, adapted to source-over for game UI assets.
 * Shared by the optimizer, Canvas preview and vector/CSS exports. The real
 * texture for resource 106057 is not embedded in GIA; use this explicitly
 * documented, normalized three-sigma Gaussian approximation until calibrated.
 */
"use strict";
const Gaussian = (() => {
  const ASSET = 106057, EDGE = Math.exp(-4.5), NORM = 1 / (1 - EDGE);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function profile(radius) {
    return radius >= 1 ? 0 : (Math.exp(-4.5 * radius * radius) - EDGE) * NORM;
  }
  const stops = Array.from({ length: 33 }, (_, i) => [i / 32, profile(i / 32)]);
  function isGaussian(el) { return el.primitive_type === "blurred_circle"; }
  function draw(ctx, element, ppu) {
    const rx = element.size.rx * ppu, ry = element.size.ry * ppu;
    if (!(rx > 0 && ry > 0)) return;
    ctx.save();
    ctx.scale(rx, ry);
    // A tint-independent alpha mask gives the same falloff to every channel.
    const color = element.color.replace("#", "");
    const rgb = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
    const shaded = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [r, a] of stops) shaded.addColorStop(r, `rgba(${rgb.join(",")},${a})`);
    ctx.globalAlpha *= clamp(Number(element.alpha), 0, 1);
    ctx.fillStyle = shaded;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  return { ASSET, EDGE, NORM, profile, stops, isGaussian, draw };
})();
if (typeof module !== "undefined") module.exports = Gaussian;
