/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/ (also LICENSES/mw_splat-MPL-2.0.txt).
 * Based on mw_splat by Golden_Water, commit 8c3951a. */
/*
 * splat-preview.js — draws Splat results into a canvas for the editor.
 *
 * All splats go out in one instanced WebGL2 draw call. The fragment shader
 * uses the same soft-rectangle kernel as splat-core.js, and premultiplied
 * "over" blending composites them in order, exactly like the fitter. Without
 * WebGL2 it falls back to the CPU renderer. The editor caches the canvas and
 * only redraws it when the shapes change, so panning and zooming just copy
 * one image.
 */
"use strict";

const SplatPreview = (() => {
  const VERTEX = `#version 300 es
in vec2 a_corner;
in vec2 a_center;
in vec2 a_half;
in vec2 a_scale;
in float a_rot;
in vec4 a_color;
uniform vec2 u_view;
uniform float u_cap;
out vec2 v_local;
flat out vec2 v_core;
flat out vec2 v_iramp;
flat out vec4 v_color;
void main() {
  vec2 ramp = min(a_half, vec2(u_cap)) * a_scale;
  vec2 extent = a_half * a_scale;
  v_core = extent - ramp;
  v_iramp = 1.0 / max(ramp, vec2(1e-6));
  vec2 local = a_corner * (extent + 0.5);
  float c = cos(a_rot), s = sin(a_rot);
  vec2 world = a_center + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  v_local = local;
  v_color = a_color;
  gl_Position = vec4(world.x / u_view.x * 2.0 - 1.0, 1.0 - world.y / u_view.y * 2.0, 0.0, 1.0);
}`;
  const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
flat in vec2 v_core;
flat in vec2 v_iramp;
flat in vec4 v_color;
out vec4 o_color;
void main() {
  vec2 e = max(abs(v_local) - v_core, 0.0) * v_iramp;
  float d = length(e);
  if (d >= 1.0) discard;
  float t = 1.0 - d;
  o_color = v_color * (t * (0.5 + t * (1.5 - t)));
}`;
  const FLOATS = 11;
  let state = null, failed = false;

  function setup() {
    if (state || failed) return state;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL2 unavailable");
      const shader = (type, source) => {
        const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
        return s;
      };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link");
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const corners = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      const corner = gl.getAttribLocation(program, "a_corner");
      gl.enableVertexAttribArray(corner);
      gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
      const instances = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      const attribute = (name, size, offset) => {
        const at = gl.getAttribLocation(program, name);
        gl.enableVertexAttribArray(at);
        gl.vertexAttribPointer(at, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
        gl.vertexAttribDivisor(at, 1);
      };
      attribute("a_center", 2, 0); attribute("a_half", 2, 2); attribute("a_scale", 2, 4);
      attribute("a_rot", 1, 6); attribute("a_color", 4, 7);
      state = { canvas, gl, program, vao, instances, view: gl.getUniformLocation(program, "u_view"), cap: gl.getUniformLocation(program, "u_cap"),
        maxSize: Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], gl.getParameter(gl.MAX_VIEWPORT_DIMS)[1]) };
      canvas.addEventListener("webglcontextlost", () => { state = null; });
    } catch (error) {
      console.warn("[splat preview] using the CPU renderer:", error.message || error);
      failed = true;
      state = null;
    }
    return state;
  }

  /* Raster size for an image: up to 4× for small images (so zooming in stays
   * sharp), at most 4096 px on the long side. */
  function factorFor(width, height) {
    const longest = Math.max(width, height), limit = Math.min(4096, state ? state.maxSize : 4096);
    return Math.max(0.05, Math.min(4, Math.max(1, 2048 / longest), limit / longest));
  }

  function drawGl(params, count, background, w, h, cap, target) {
    const { canvas, gl, program, vao, instances } = state;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const data = new Float32Array(Math.max(1, count) * FLOATS);
    for (let i = 0; i < count; i++) {
      const k = i * SplatCore.STRIDE, o = i * FLOATS;
      data[o] = params[k]; data[o + 1] = params[k + 1];
      data[o + 2] = params[k + 2] * 0.5; data[o + 3] = params[k + 3] * 0.5;
      data[o + 4] = params[k + 9]; data[o + 5] = params[k + 10];
      data[o + 6] = params[k + 4];
      data[o + 7] = params[k + 5]; data[o + 8] = params[k + 6]; data[o + 9] = params[k + 7]; data[o + 10] = params[k + 8];
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(background[0], background[1], background[2], background[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count) {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.uniform2f(state.view, w, h);
      gl.uniform1f(state.cap, cap);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    }
    if (gl.isContextLost()) throw new Error("WebGL context lost");
    const ctx = target.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);
  }

  /* Draws `elements` (image units, `ppu` pixels per unit) into `target`
   * (created when missing) and returns it. */
  function draw(elements, width, height, ppu, target) {
    setup();
    const factor = factorFor(width, height);
    const w = Math.max(1, Math.round(width * factor)), h = Math.max(1, Math.round(height * factor));
    const canvas = target || document.createElement("canvas");
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const { params, count, background } = SplatCore.fromElements(elements, ppu, w / width);
    const cap = SplatCore.rampCap(h);
    if (state) {
      try { drawGl(params, count, background, w, h, cap, canvas); return canvas; }
      catch (error) { console.warn("[splat preview] WebGL draw failed, using the CPU renderer:", error.message || error); failed = true; state = null; }
    }
    const { pixels } = SplatCore.render(params, count, w, h, background, cap);
    canvas.getContext("2d").putImageData(new ImageData(SplatCore.toRGBA8(pixels, w, h), w, h), 0, 0);
    return canvas;
  }

  /* Cheap fingerprint of everything that changes the picture. */
  function signature(elements) {
    let h = elements.length | 0;
    const mix = (v) => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 0x01000193); };
    for (const el of elements) {
      mix(el.center.x); mix(el.center.y);
      mix(el.size.width || 0); mix(el.size.height || 0);
      mix(el.scale ? el.scale.x : 1); mix(el.scale ? el.scale.y : 1);
      mix(Number(el.rotation?.z ?? el.rotation ?? 0)); mix(Number(el.alpha) || 0);
      mix(el.is_background ? 1 : 0);
      const color = String(el.color || "");
      for (let i = 0; i < color.length; i++) h = Math.imul(h ^ color.charCodeAt(i), 0x01000193);
    }
    return h;
  }

  return { draw, signature, get usesWebGL() { setup(); return !!state; } };
})();
