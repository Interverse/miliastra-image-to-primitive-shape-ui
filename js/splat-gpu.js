/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/ (also LICENSES/mw_splat-MPL-2.0.txt).
 * Based on mw_splat by Golden_Water, commit 8c3951a. */
/* WebGPU Splat fitter: the upstream WGSL passes (bin_count/alloc/fill/sort,
 * splats_cache_fill, render, learn_backward, learn_adam,
 * redistribute_cells/select/move) with three browser changes: immediates are
 * uniform buffers, f32 atomics are a workgroup reduction plus
 * compare-exchange, and `info` is a flat uniform. Bin overflow keeps the
 * upstream protocol: later passes are skipped, the bin buffer doubles and
 * the skipped iterations are replayed. Same parameters, loss, Adam and
 * redistribution schedule as SplatCore.createFitter, which remains the CPU
 * path. Loss weights, when given, sit after the reference in one buffer so
 * the backward pass stays within 8 storage buffers. */
"use strict";
const SplatGpu = (() => {
  const STRIDE = 11, TILE = 16, WG = 256, GRAD_COPIES = 8, CDF = 1 << 14, IN_FLIGHT = 4;
  const SPLAT_BYTES = 48, CACHE_BYTES = 24, INDIRECT = ["fill", "sort", "cache", "render", "backward", "adam"];

  const COMMON = /* wgsl */`
const TILE_SIZE: u32 = 16u;
const WG_SIZE: u32 = 256u;
const WG_SIZE_2D: u32 = 16u;
const LOGIT_EPS: f32 = 1e-4;
const GRAD_COPIES: u32 = 8u;
const GRAD_STRIDE: u32 = 11u;
const INVERSE_CDF_SIZE: u32 = 16384u;
struct Info {
  dims: vec2u, dimsf: vec2f, stride: u32, ramp_cap: f32, background: vec4f, tile_dims: vec2u,
  lr_position: f32, lr_size: f32, lr_rotation: f32, lr_color: f32, lr_alpha: f32, lr_scale: f32,
}
struct Splat { pos: vec2f, size: vec2f, color: vec4f, scale: vec2f, rot: f32 }
struct SplatCache { sin: f32, cos: f32, core: vec2f, ramp: vec2f }
struct BinHeader { base: u32, len: u32 }
struct SamplingCell { loss: f32, hot_px_idx: u32 }
struct RedistributeState { boundary_lo: f32, boundary_hi: f32, boundary_frac: f32 }
fn splat_rot(cache: SplatCache) -> mat2x2f { return mat2x2f(cache.cos, cache.sin, -cache.sin, cache.cos); }
fn profile(t: f32) -> f32 { let u = clamp(t, 0.0, 1.0); return u * (0.5 + u * (1.5 - u)); }
fn d_profile(t: f32) -> f32 { let u = clamp(t, 0.0, 1.0); return 0.5 + 3.0 * u * (1.0 - u); }
fn sample_kernel(splat: Splat, cache: SplatCache, px: vec2f) -> f32 {
  let uv = transpose(splat_rot(cache)) * (px - splat.pos);
  let excess = max(vec2f(0.0), abs(uv) - cache.core);
  return profile(1.0 - length(excess / max(cache.ramp, vec2f(1e-6))));
}
struct Range { valid: bool, t_min: vec2u, t_max: vec2u }
struct XRange { valid: bool, t_min: u32, t_max: u32 }
fn rot_mat(rot: f32) -> mat2x2f { let s = sin(rot); let c = cos(rot); return mat2x2f(c, s, -s, c); }
fn splat_tile_range(splat: Splat, info: Info) -> Range {
  let m = rot_mat(splat.rot);
  let half_size = mat2x2f(abs(m[0]), abs(m[1])) * (splat.size * splat.scale * 0.5);
  let b_min = vec2u(clamp(floor(splat.pos - half_size), vec2f(0.), info.dimsf));
  let b_max = vec2u(clamp(ceil(splat.pos + half_size), vec2f(0.), info.dimsf));
  if b_min.x >= b_max.x || b_min.y >= b_max.y { return Range(false, vec2u(0u), vec2u(0u)); }
  let t_min = clamp(b_min / TILE_SIZE, vec2u(0u), info.tile_dims - 1u);
  let t_max = clamp((b_max - 1u) / TILE_SIZE, vec2u(0u), info.tile_dims - 1u);
  return Range(true, t_min, t_max);
}
fn splat_tile_x_range(splat: Splat, info: Info, tile_y: u32) -> XRange {
  let m = rot_mat(splat.rot);
  let h = splat.size * splat.scale * 0.5;
  let y0 = f32(tile_y * TILE_SIZE);
  let y1 = y0 + f32(TILE_SIZE);
  var corners: array<vec2f, 4>;
  corners[0] = splat.pos + m * vec2f(-h.x, -h.y);
  corners[1] = splat.pos + m * vec2f(h.x, -h.y);
  corners[2] = splat.pos + m * vec2f(h.x, h.y);
  corners[3] = splat.pos + m * vec2f(-h.x, h.y);
  var x_min = 1e30;
  var x_max = -1e30;
  var found = false;
  for (var i = 0u; i < 4u; i++) {
    let p = corners[i];
    if p.y >= y0 && p.y <= y1 { x_min = min(x_min, p.x); x_max = max(x_max, p.x); found = true; }
    let q = corners[(i + 1u) % 4u];
    for (var j = 0u; j < 2u; j++) {
      let yb = select(y0, y1, j == 1u);
      if yb > min(p.y, q.y) && yb < max(p.y, q.y) {
        let x = p.x + (q.x - p.x) * (yb - p.y) / (q.y - p.y);
        x_min = min(x_min, x); x_max = max(x_max, x); found = true;
      }
    }
  }
  if !found { return XRange(false, 0u, 0u); }
  let b_min = clamp(floor(x_min), 0., info.dimsf.x);
  let b_max = clamp(ceil(x_max), 0., info.dimsf.x);
  if b_min >= b_max { return XRange(false, 0u, 0u); }
  return XRange(true, clamp(u32(b_min / f32(TILE_SIZE)), 0u, info.tile_dims.x - 1u),
    clamp(u32((b_max - 1.) / f32(TILE_SIZE)), 0u, info.tile_dims.x - 1u));
}
`;

  const SHADERS = {
    count: `
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
@group(0) @binding(2) var<storage, read_write> bin_counts: array<atomic<u32>>;
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3u, @builtin(num_workgroups) wg_num: vec3u, @builtin(local_invocation_index) l_ii: u32) {
  let idx = wg_id.x + wg_id.y * wg_num.x;
  if idx >= arrayLength(&splats) { return; }
  let range = splat_tile_range(splats[idx], info);
  if !range.valid { return; }
  for (var tile_y = range.t_min.y + l_ii; tile_y <= range.t_max.y; tile_y += WG_SIZE) {
    let x = splat_tile_x_range(splats[idx], info, tile_y);
    if !x.valid { continue; }
    for (var tile_x = x.t_min; tile_x <= x.t_max; tile_x++) { atomicAdd(&bin_counts[tile_y * info.tile_dims.x + tile_x], 1u); }
  }
}`,
    alloc: `
struct BinOverflow { overflow: atomic<u32>, iter_num: u32, indirect_args: array<vec3u> }
struct Imm { iter_num: u32 }
@group(0) @binding(0) var<storage, read> bin_counts: array<u32>;
@group(0) @binding(1) var<storage, read_write> bin_heads: array<BinHeader>;
@group(0) @binding(2) var<storage, read_write> bin_bump: atomic<u32>;
@group(0) @binding(3) var<storage, read_write> bin_overflow: BinOverflow;
@group(0) @binding(4) var<storage, read> bin_data: array<u32>;
@group(0) @binding(5) var<uniform> imm: Imm;
var<workgroup> wg_bin_buf: array<u32, WG_SIZE>;
var<workgroup> wg_bin_base: u32;
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3u, @builtin(local_invocation_index) lii: u32) {
  let bin_idx = wg_id.x * WG_SIZE + lii;
  var bin_count = 0u;
  if bin_idx < arrayLength(&bin_counts) { bin_count = bin_counts[bin_idx]; }
  wg_bin_buf[lii] = bin_count;
  workgroupBarrier();
  for (var depth = 1u; depth < WG_SIZE; depth <<= 1u) {
    var value = 0u;
    if lii >= depth { value = wg_bin_buf[lii - depth]; }
    workgroupBarrier();
    if lii >= depth { wg_bin_buf[lii] += value; }
    workgroupBarrier();
  }
  let wg_total = wg_bin_buf[WG_SIZE - 1u];
  if lii == 0u {
    wg_bin_base = atomicAdd(&bin_bump, wg_total);
    let overflow = u32((wg_bin_base + wg_total) > arrayLength(&bin_data));
    let prev = atomicOr(&bin_overflow.overflow, overflow);
    if prev == 0u && overflow == 1u {
      for (var i = 0u; i < arrayLength(&bin_overflow.indirect_args); i++) { bin_overflow.indirect_args[i] = vec3u(0u); }
      bin_overflow.iter_num = imm.iter_num;
    }
  }
  workgroupBarrier();
  if bin_idx < arrayLength(&bin_counts) {
    let base = wg_bin_base + wg_bin_buf[lii] - bin_count;
    let cap = arrayLength(&bin_data);
    bin_heads[bin_idx] = BinHeader(base, select(0u, min(bin_count, cap - base), base < cap));
  }
}`,
    fill: `
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
@group(0) @binding(2) var<storage, read> bin_heads: array<BinHeader>;
@group(0) @binding(3) var<storage, read_write> bin_cursor: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> bin_data: array<u32>;
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3u, @builtin(num_workgroups) wg_num: vec3u, @builtin(local_invocation_index) l_ii: u32) {
  let idx = wg_id.x + wg_id.y * wg_num.x;
  if idx >= arrayLength(&splats) { return; }
  let range = splat_tile_range(splats[idx], info);
  if !range.valid { return; }
  for (var tile_y = range.t_min.y + l_ii; tile_y <= range.t_max.y; tile_y += WG_SIZE) {
    let x = splat_tile_x_range(splats[idx], info, tile_y);
    if !x.valid { continue; }
    for (var tile_x = x.t_min; tile_x <= x.t_max; tile_x++) {
      let tile_idx = tile_y * info.tile_dims.x + tile_x;
      let head = bin_heads[tile_idx];
      let cursor = atomicAdd(&bin_cursor[tile_idx], 1u);
      if cursor >= head.len { continue; }
      bin_data[head.base + cursor] = idx;
    }
  }
}`,
    sort: `
@group(0) @binding(0) var<storage, read> bin_heads: array<BinHeader>;
@group(0) @binding(1) var<storage, read_write> bin_data: array<u32>;
fn next_pow2(n: u32) -> u32 {
  if n <= 1u { return 1u; }
  if n > (1u << 31u) { return 0u; }
  return 1u << (firstLeadingBit(n - 1u) + 1u);
}
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(workgroup_id) wg_id: vec3u, @builtin(num_workgroups) wg_num: vec3u, @builtin(local_invocation_index) lii: u32) {
  let bin_idx = wg_id.x + wg_id.y * wg_num.x;
  if bin_idx >= arrayLength(&bin_heads) { return; }
  let head = bin_heads[bin_idx];
  if head.len < 2u { return; }
  let n = next_pow2(head.len);
  for (var stage = 2u; stage <= n; stage <<= 1u) {
    let first = stage >> 1u;
    for (var step = first; step > 0u; step >>= 1u) {
      for (var op = lii; op < (n >> 1u); op += WG_SIZE) {
        let r = op & (step - 1u);
        let offset = (op - r) << 1u;
        let left = offset + r;
        let right = select(left + step, offset + stage - 1u - r, step == first);
        if right >= head.len { continue; }
        let a = bin_data[head.base + left];
        let b = bin_data[head.base + right];
        if a > b { bin_data[head.base + left] = b; bin_data[head.base + right] = a; }
      }
      storageBarrier();
    }
  }
}`,
    cache: `
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
@group(0) @binding(2) var<storage, read_write> splat_caches: array<SplatCache>;
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) wg_num: vec3u) {
  let idx = id.x + id.y * WG_SIZE * wg_num.x;
  if idx >= arrayLength(&splats) { return; }
  let splat = splats[idx];
  let raw_half = splat.size * 0.5;
  let ramp = min(raw_half, vec2f(info.ramp_cap)) * splat.scale;
  splat_caches[idx] = SplatCache(sin(splat.rot), cos(splat.rot), raw_half * splat.scale - ramp, ramp);
}`,
    render: `
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
@group(0) @binding(2) var<storage, read> splat_caches: array<SplatCache>;
@group(0) @binding(3) var<storage, read> bin_heads: array<BinHeader>;
@group(0) @binding(4) var<storage, read> bin_data: array<u32>;
@group(0) @binding(5) var<storage, read_write> pixels: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> transmittance: array<f32>;
@compute @workgroup_size(WG_SIZE_2D, WG_SIZE_2D)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= info.dims) { return; }
  let idx = id.x + id.y * info.stride;
  let bin = bin_heads[id.x / TILE_SIZE + id.y / TILE_SIZE * info.tile_dims.x];
  let px = vec2f(id.xy) + 0.5;
  var composite = info.background;
  var trans = 1.0;
  for (var i = bin.base; i < bin.base + bin.len; i++) {
    let splat_index = bin_data[i];
    let splat = splats[splat_index];
    let sample = sample_kernel(splat, splat_caches[splat_index], px);
    let inv = 1.0 - sample * splat.color.a;
    composite = composite * inv + splat.color * sample;
    trans *= inv;
  }
  pixels[idx] = composite;
  transmittance[idx] = trans;
}`,
    // Each 8x8 workgroup owns one tile. Per-splat gradients are reduced in
    // workgroup memory, then 11 lanes add them to one of GRAD_COPIES copies.
    // Gradient order matches SplatCore: x y w h rot r g b a sx sy.
    backward: `
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> reference: array<vec4f>;
@group(0) @binding(2) var<storage, read> splats: array<Splat>;
@group(0) @binding(3) var<storage, read> splat_caches: array<SplatCache>;
@group(0) @binding(4) var<storage, read> bin_heads: array<BinHeader>;
@group(0) @binding(5) var<storage, read> bin_data: array<u32>;
@group(0) @binding(6) var<storage, read> pixels: array<vec4f>;
@group(0) @binding(7) var<storage, read> transmittance: array<f32>;
@group(0) @binding(8) var<storage, read_write> grads: array<atomic<u32>>;
const BWD_BLOCK_SIZE = 2u;
const BWD_BLOCK_LEN = 4u;
const BWD_WG_SIZE = 8u;
const BWD_WG_LEN = 64u;
struct Px { composite: vec4f, adjoint: vec4f, center: vec2f, t_before: f32, transmittance: f32, on: bool }
var<workgroup> wg_loss: array<f32, BWD_WG_LEN>;
var<workgroup> wg_grad: array<f32, 704>;
fn atomic_add_f32(idx: u32, value: f32) {
  var old = atomicLoad(&grads[idx]);
  loop {
    let r = atomicCompareExchangeWeak(&grads[idx], old, bitcast<u32>(bitcast<f32>(old) + value));
    if r.exchanged { break; }
    old = r.old_value;
  }
}
@compute @workgroup_size(BWD_WG_SIZE, BWD_WG_SIZE)
fn main(@builtin(workgroup_id) w_id: vec3u, @builtin(num_workgroups) w_num: vec3u,
    @builtin(local_invocation_id) l_id: vec3u, @builtin(local_invocation_index) l_ii: u32) {
  let tile_idx = w_id.x + w_id.y * w_num.x;
  if tile_idx >= arrayLength(&bin_heads) { return; }
  let block_pos = w_id.xy * TILE_SIZE + l_id.xy * BWD_BLOCK_SIZE;
  let loss_norm = 1.0 / (f32(info.dims.x * info.dims.y) * 6.0);
  let weight_base = info.dims.x * info.dims.y;
  var block_pixels: array<Px, BWD_BLOCK_LEN>;
  var block_loss = 0.;
  for (var b_i = 0u; b_i < BWD_BLOCK_LEN; b_i++) {
    let px_pos = block_pos + vec2u(b_i % BWD_BLOCK_SIZE, b_i / BWD_BLOCK_SIZE);
    let in_canvas = all(px_pos < info.dims);
    block_pixels[b_i].on = in_canvas;
    if !in_canvas { continue; }
    block_pixels[b_i].center = vec2f(px_pos) + 0.5;
    block_pixels[b_i].composite = info.background;
    block_pixels[b_i].t_before = 1.;
    let px_idx = px_pos.x + px_pos.y * info.stride;
    let weight = reference[weight_base + px_idx].x;
    let px = pixels[px_idx];
    let tgt = reference[px_idx];
    let black = px.rgb - tgt.rgb;
    let white = black + vec3f(tgt.a - px.a);
    block_loss += (dot(black, black) + dot(white, white)) * loss_norm * weight;
    block_pixels[b_i].adjoint = vec4f((black + white) * (2.0 * loss_norm * weight), -2.0 * loss_norm * weight * (white.x + white.y + white.z));
    block_pixels[b_i].transmittance = transmittance[px_idx];
  }
  wg_loss[l_ii] = block_loss;
  workgroupBarrier();
  for (var step = BWD_WG_LEN / 2u; step > 0u; step >>= 1u) {
    if l_ii < step { wg_loss[l_ii] += wg_loss[l_ii + step]; }
    workgroupBarrier();
  }
  if l_ii == 0u { atomic_add_f32(GRAD_COPIES * arrayLength(&splats) * GRAD_STRIDE, wg_loss[0]); }
  let head = bin_heads[tile_idx];
  if head.len == 0u { return; }
  let grad_base = arrayLength(&splats) * (tile_idx % GRAD_COPIES);
  let bg_transparency = 1.0 - info.background.a;
  let cap = info.ramp_cap;
  for (var bin_idx = head.base; bin_idx < head.base + head.len; bin_idx++) {
    let splat_idx = bin_data[bin_idx];
    let splat = splats[splat_idx];
    let cache = splat_caches[splat_idx];
    let transform = splat_rot(cache);
    let ramp_safe = max(cache.ramp, vec2f(1e-6));
    let raw_half = splat.size * 0.5;
    let ramp_len = min(raw_half, vec2f(cap));
    let size_limited = select(vec2f(0.0), vec2f(1.0), raw_half < vec2f(cap));
    var g: array<f32, 11>;
    for (var b_i = 0u; b_i < BWD_BLOCK_LEN; b_i++) {
      if !block_pixels[b_i].on { continue; }
      let b = &block_pixels[b_i];
      let uv = transpose(transform) * ((*b).center - splat.pos);
      let excess = max(vec2f(0.0), abs(uv) - cache.core);
      let s = length(excess / ramp_safe);
      let kernel = profile(1.0 - s);
      let inv = 1. - kernel * splat.color.a;
      let denom = (*b).t_before * inv;
      if kernel > 0.0 {
        var t_after = 0.0;
        if denom > 1e-30 { t_after = (*b).transmittance / denom; }
        let adjoint4 = (*b).adjoint * t_after;
        let d_cov = adjoint4.a * bg_transparency * (*b).t_before - dot((*b).composite.rgb, adjoint4.rgb);
        let dk = vec4f(adjoint4.rgb, d_cov);
        let d_kernel = dot(dk, splat.color);
        g[5] += dk.x * kernel; g[6] += dk.y * kernel; g[7] += dk.z * kernel; g[8] += dk.w * kernel;
        if s > 1e-6 && s < 1.0 {
          let slope = d_profile(1.0 - s);
          let dk_dq = -slope * excess / (ramp_safe * ramp_safe * s);
          let dk_duv = dk_dq * sign(uv);
          let dk_dcore = -dk_dq;
          let dk_dramp = slope * excess * excess / (s * ramp_safe * ramp_safe * ramp_safe) - dk_dcore;
          let d_pos = -(transform * dk_duv);
          let d_size = 0.5 * splat.scale * (dk_dcore + dk_dramp * size_limited);
          let d_scale = dk_dcore * raw_half + dk_dramp * ramp_len;
          g[0] += d_pos.x * d_kernel; g[1] += d_pos.y * d_kernel;
          g[2] += d_size.x * d_kernel; g[3] += d_size.y * d_kernel;
          g[4] += (dk_duv.x * uv.y - dk_duv.y * uv.x) * d_kernel;
          g[9] += d_scale.x * d_kernel; g[10] += d_scale.y * d_kernel;
        }
      }
      (*b).composite = (*b).composite * inv + splat.color * kernel;
      (*b).t_before = denom;
    }
    for (var k = 0u; k < GRAD_STRIDE; k++) { wg_grad[l_ii * GRAD_STRIDE + k] = g[k]; }
    workgroupBarrier();
    if l_ii < GRAD_STRIDE {
      var sum = 0.0;
      for (var t = 0u; t < BWD_WG_LEN; t++) { sum += wg_grad[t * GRAD_STRIDE + l_ii]; }
      if sum != 0.0 { atomic_add_f32((grad_base + splat_idx) * GRAD_STRIDE + l_ii, sum); }
    }
    workgroupBarrier();
  }
}`,
    adam: `
struct Imm { lr_scale: f32 }
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read_write> splats: array<Splat>;
@group(0) @binding(2) var<storage, read> grads: array<f32>;
@group(0) @binding(3) var<storage, read_write> moment1: array<Splat>;
@group(0) @binding(4) var<storage, read_write> moment2: array<Splat>;
@group(0) @binding(5) var<uniform> imm: Imm;
const BETA1: f32 = 0.9;
const BETA2: f32 = 0.999;
const ADAM_EPS: f32 = 1e-8;
const LN_SIZE_MAX: f32 = 9.903487552536127;
fn logit4(x: vec4f) -> vec4f { let v = clamp(x, vec4f(LOGIT_EPS), vec4f(1. - LOGIT_EPS)); return log(v / (1. - v)); }
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) wg_num: vec3u) {
  let idx = id.x + id.y * WG_SIZE * wg_num.x;
  let n = arrayLength(&splats);
  if idx >= n { return; }
  var g: array<f32, 11>;
  for (var c = 0u; c < GRAD_COPIES; c++) {
    for (var k = 0u; k < GRAD_STRIDE; k++) { g[k] += grads[(n * c + idx) * GRAD_STRIDE + k]; }
  }
  let splat = splats[idx];
  let a = splat.color.a;
  var rgb = vec3f(0.5);
  if a > LOGIT_EPS { rgb = splat.color.rgb / a; }
  let g_rgb = vec3f(g[5], g[6], g[7]);
  var raw_grad: Splat;
  raw_grad.pos = vec2f(g[0], g[1]);
  raw_grad.size = vec2f(g[2], g[3]) * splat.size;
  raw_grad.rot = g[4];
  raw_grad.color = vec4f(g_rgb * a * rgb * (1. - rgb), (g[8] + dot(g_rgb, rgb)) * a * (1. - a));
  raw_grad.scale = vec2f(g[9], g[10]) * splat.scale;
  var m = moment1[idx];
  var v = moment2[idx];
  m.pos = m.pos * BETA1 + raw_grad.pos * (1.0 - BETA1);
  v.pos = v.pos * BETA2 + raw_grad.pos * raw_grad.pos * (1.0 - BETA2);
  m.size = m.size * BETA1 + raw_grad.size * (1.0 - BETA1);
  v.size = v.size * BETA2 + raw_grad.size * raw_grad.size * (1.0 - BETA2);
  m.rot = m.rot * BETA1 + raw_grad.rot * (1.0 - BETA1);
  v.rot = v.rot * BETA2 + raw_grad.rot * raw_grad.rot * (1.0 - BETA2);
  m.color = m.color * BETA1 + raw_grad.color * (1.0 - BETA1);
  v.color = v.color * BETA2 + raw_grad.color * raw_grad.color * (1.0 - BETA2);
  m.scale = m.scale * BETA1 + raw_grad.scale * (1.0 - BETA1);
  v.scale = v.scale * BETA2 + raw_grad.scale * raw_grad.scale * (1.0 - BETA2);
  let rate = imm.lr_scale;
  let lr_col = vec4f(vec3f(info.lr_color), info.lr_alpha);
  let pos = splat.pos - rate * (info.lr_position * m.pos) / (sqrt(v.pos) + vec2f(ADAM_EPS));
  let size = min(log(max(splat.size, vec2f(LOGIT_EPS))) - rate * (info.lr_size * m.size) / (sqrt(v.size) + vec2f(ADAM_EPS)), vec2f(LN_SIZE_MAX));
  let rot = splat.rot - rate * info.lr_rotation * m.rot / (sqrt(v.rot) + ADAM_EPS);
  let color_raw = clamp(logit4(vec4f(rgb, a)) - rate * (lr_col * m.color) / (sqrt(v.color) + vec4f(ADAM_EPS)), vec4f(-10.), vec4f(10.));
  let scale_raw = clamp(log(max(splat.scale, vec2f(LOGIT_EPS))) - rate * (info.lr_scale * m.scale) / (sqrt(v.scale) + vec2f(ADAM_EPS)), vec2f(-10.), vec2f(10.));
  let color = 1.0 / (1.0 + exp(-color_raw));
  splats[idx] = Splat(pos, exp(size), vec4f(color.rgb * color.a, color.a), exp(scale_raw), rot);
  moment1[idx] = m;
  moment2[idx] = v;
}`,
    cells: `
struct Imm { grid_dims: vec2u, cell_size: u32 }
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> reference: array<vec4f>;
@group(0) @binding(2) var<storage, read> pixels: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> sampling_cells: array<SamplingCell>;
@group(0) @binding(4) var<uniform> imm: Imm;
@compute @workgroup_size(WG_SIZE_2D, WG_SIZE_2D)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= imm.grid_dims) { return; }
  let px_base = id.xy * imm.cell_size;
  let px_max = min(px_base + vec2u(imm.cell_size), info.dims);
  let weight_base = info.dims.x * info.dims.y;
  var loss_sum = 0.0;
  var hot_px_idx = 0u;
  var peak = -1.0;
  for (var y = px_base.y; y < px_max.y; y++) {
    for (var x = px_base.x; x < px_max.x; x++) {
      let px_idx = x + y * info.stride;
      let px = pixels[px_idx];
      let tgt = reference[px_idx];
      let black = px.rgb - tgt.rgb;
      let white = black + vec3f(tgt.a - px.a);
      let loss = (dot(black, black) + dot(white, white)) / 6.0 * reference[weight_base + px_idx].x;
      loss_sum += loss;
      if loss > peak { peak = loss; hot_px_idx = px_idx; }
    }
  }
  sampling_cells[id.x + id.y * imm.grid_dims.x] = SamplingCell(loss_sum, hot_px_idx);
}`,
    select: `
struct Imm { grid_dims: vec2u, move_count: u32 }
@group(0) @binding(0) var<storage, read> sampling_cells: array<SamplingCell>;
@group(0) @binding(1) var<storage, read_write> state: RedistributeState;
@group(0) @binding(2) var<storage, read_write> inverse_cdf: array<u32>;
@group(0) @binding(3) var<uniform> imm: Imm;
const BINS: u32 = 512u;
var<workgroup> hist: array<u32, BINS>;
@compute @workgroup_size(1)
fn main() {
  let cell_count = imm.grid_dims.x * imm.grid_dims.y;
  var total_loss = 0.0;
  var peak_loss = 0.0;
  for (var cell = 0u; cell < cell_count; cell++) {
    total_loss += sampling_cells[cell].loss;
    peak_loss = max(peak_loss, sampling_cells[cell].loss);
  }
  let bin_scale = select(0.0, f32(BINS - 1u) / peak_loss, peak_loss > 0.0);
  for (var cell = 0u; cell < cell_count; cell++) {
    hist[min(u32(sampling_cells[cell].loss * bin_scale), BINS - 1u)] += 1u;
  }
  var cells_below = 0u;
  var bin = 0u;
  while bin + 1u < BINS {
    if cells_below + hist[bin] > imm.move_count { break; }
    cells_below += hist[bin];
    bin += 1u;
  }
  state.boundary_lo = f32(bin) / max(bin_scale, 1e-20);
  state.boundary_hi = f32(bin + 1u) / max(bin_scale, 1e-20);
  state.boundary_frac = clamp(f32(imm.move_count - cells_below) / f32(max(hist[bin], 1u)), 0.0, 1.0);
  var cum_loss = 0.0;
  var cell_idx = 0u;
  for (var slot = 0u; slot < INVERSE_CDF_SIZE; slot++) {
    let target_loss = total_loss * f32(slot) / f32(INVERSE_CDF_SIZE - 1u);
    while cell_idx + 1u < cell_count {
      let cell_loss = sampling_cells[cell_idx].loss;
      if cum_loss + cell_loss >= target_loss { break; }
      cum_loss += cell_loss;
      cell_idx += 1u;
    }
    inverse_cdf[slot] = cell_idx;
  }
}`,
    move: `
struct Imm { grid_dims: vec2u, cell_size: u32, splat_size: f32, seed: u32 }
@group(0) @binding(0) var<uniform> info: Info;
@group(0) @binding(1) var<storage, read> reference: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> splats: array<Splat>;
@group(0) @binding(3) var<storage, read> sampling_cells: array<SamplingCell>;
@group(0) @binding(4) var<storage, read> state: RedistributeState;
@group(0) @binding(5) var<storage, read> inverse_cdf: array<u32>;
@group(0) @binding(6) var<uniform> imm: Imm;
fn redistribute_hash(a: u32, b: u32) -> f32 {
  var h = (a * 747796405u) ^ ((b + 1u) * 2891336453u);
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return f32((h ^ (h >> 16u)) & 0xffffffu) / 16777216.0;
}
fn coverage(splat: Splat) -> f32 {
  let sample_pos = vec2u(clamp(splat.pos, vec2f(0.5), vec2f(info.dims) - 0.5));
  let extent = sqrt(splat.size.x * splat.scale.x * splat.size.y * splat.scale.y);
  return smoothstep(0.5, 1.5, extent) * smoothstep(0.0, 0.01, splat.color.w)
    * smoothstep(0.0, 0.05, reference[sample_pos.y * info.stride + sample_pos.x].a);
}
@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) wg_num: vec3u) {
  let splat_idx = id.x + id.y * WG_SIZE * wg_num.x;
  if splat_idx >= arrayLength(&splats) { return; }
  let splat = splats[splat_idx];
  let off_grid = !(all(splat.pos >= vec2f(0.)) && all(splat.pos < info.dimsf));
  var should_move = off_grid || redistribute_hash(splat_idx, 7u) < 1.0 - coverage(splat);
  if !should_move {
    let cell_coord = vec2u(splat.pos / f32(imm.cell_size));
    let cell_loss = sampling_cells[cell_coord.x + cell_coord.y * imm.grid_dims.x].loss;
    should_move = cell_loss < state.boundary_lo
      || (cell_loss < state.boundary_hi && redistribute_hash(splat_idx, imm.seed) < state.boundary_frac);
  }
  if !should_move { return; }
  let slot = min(u32(redistribute_hash(splat_idx, 101u) * f32(INVERSE_CDF_SIZE - 1u)), INVERSE_CDF_SIZE - 1u);
  let hot = sampling_cells[inverse_cdf[slot]].hot_px_idx;
  let destination = clamp(vec2f(vec2u(hot % info.stride, hot / info.stride)) + 0.5, vec2f(0.5), vec2f(info.dims) - 0.5);
  let color = reference[u32(destination.y) * info.stride + u32(destination.x)];
  splats[splat_idx] = Splat(destination, vec2f(imm.splat_size), color, vec2f(1.0), 0.0);
}`,
  };

  async function device() {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const limits = {};
    for (const key of ["maxStorageBufferBindingSize", "maxBufferSize", "maxComputeWorkgroupsPerDimension"]) limits[key] = adapter.limits[key];
    return adapter.requestDevice({ requiredLimits: limits });
  }

  class Learner {
    constructor(dev, target, width, height, params, background, options) {
      const n = params.length / STRIDE;
      Object.assign(this, { dev, width, height, background, count: n, lost: null });
      this.cap = options.cap;
      dev.lost.then((info) => { this.lost = info; });
      this.tiles = [Math.ceil(width / TILE), Math.ceil(height / TILE)];
      const bins = this.tiles[0] * this.tiles[1], N = width * height;
      const limit = dev.limits.maxStorageBufferBindingSize;
      if (Math.max(N * 32, GRAD_COPIES * n * STRIDE * 4 + 4) > limit) throw new Error("SPLAT_GPU_LIMIT");
      const S = GPUBufferUsage.STORAGE, D = GPUBufferUsage.COPY_DST, C = GPUBufferUsage.COPY_SRC;
      // Exact sizes: shaders use arrayLength() as the element count.
      const buffer = (size, usage = S | D | C) => dev.createBuffer({ size: Math.max(4, Math.ceil(size / 4) * 4), usage });
      const U = GPUBufferUsage.UNIFORM | D;
      this.b = {
        info: buffer(80, U), reference: buffer(N * 32), splats: buffer(n * SPLAT_BYTES),
        caches: buffer(n * CACHE_BYTES), m1: buffer(n * SPLAT_BYTES), m2: buffer(n * SPLAT_BYTES),
        grads: buffer(GRAD_COPIES * n * STRIDE * 4 + 4), pixels: buffer(N * 16), trans: buffer(N * 4),
        counts: buffer(bins * 4), heads: buffer(bins * 8), bump: buffer(4), cursor: buffer(bins * 4),
        overflow: buffer(16 + INDIRECT.length * 16, S | D | C | GPUBufferUsage.INDIRECT), data: buffer(4 << 18),
        cells: buffer(8), state: buffer(16), cdf: buffer(CDF * 4),
        iter: buffer(16, U), rate: buffer(16, U), cellImm: buffer(16, U), selectImm: buffer(16, U), moveImm: buffer(32, U),
      };
      const info = new DataView(new ArrayBuffer(80));
      info.setUint32(0, width, true); info.setUint32(4, height, true); info.setFloat32(8, width, true); info.setFloat32(12, height, true);
      info.setUint32(16, width, true); info.setFloat32(20, this.cap, true);
      background.forEach((v, i) => info.setFloat32(32 + i * 4, v, true));
      info.setUint32(48, this.tiles[0], true); info.setUint32(52, this.tiles[1], true);
      const lr = options.lr;
      [lr.position, lr.size, lr.rotation, lr.color, lr.alpha, lr.scale].forEach((v, i) => info.setFloat32(56 + i * 4, v, true));
      dev.queue.writeBuffer(this.b.info, 0, info.buffer);
      // Reference RGBA, then the loss weight of each pixel in .x of a second block.
      const ref = new Float32Array(N * 8);
      ref.set(target);
      for (let q = 0; q < N; q++) ref[N * 4 + q * 4] = options.weights ? options.weights[q] : 1;
      dev.queue.writeBuffer(this.b.reference, 0, ref);
      this.writeSplats(params);
      this.pipelines = {};
      for (const [name, body] of Object.entries(SHADERS)) {
        const module = dev.createShaderModule({ code: COMMON + body, label: "splat " + name });
        this.pipelines[name] = dev.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" }, label: "splat " + name });
      }
      this.pending = [];
      this.overflowState = { reading: false, iteration: -1 };
      this.overflowRead = buffer(16, GPUBufferUsage.MAP_READ | D);
    }
    async ready() {
      this.dev.pushErrorScope("validation");
      for (const name of Object.keys(this.pipelines)) this.pipelines[name] = await this.pipelines[name];
      const error = await this.dev.popErrorScope();
      if (error) throw new Error("SPLAT_GPU_SHADER: " + error.message);
      this.bind();
      this.resetOverflow();
    }
    writeSplats(p) {
      const out = new Float32Array(this.count * 12);
      for (let i = 0, k = 0; i < out.length; i += 12, k += STRIDE) {
        out[i] = p[k]; out[i + 1] = p[k + 1]; out[i + 2] = p[k + 2]; out[i + 3] = p[k + 3];
        out[i + 4] = p[k + 5]; out[i + 5] = p[k + 6]; out[i + 6] = p[k + 7]; out[i + 7] = p[k + 8];
        out[i + 8] = p[k + 9]; out[i + 9] = p[k + 10]; out[i + 10] = p[k + 4];
      }
      this.dev.queue.writeBuffer(this.b.splats, 0, out);
    }
    group(name, buffers) {
      return this.dev.createBindGroup({ layout: this.pipelines[name].getBindGroupLayout(0),
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    }
    bind() {
      const b = this.b;
      this.groups = {
        count: this.group("count", [b.info, b.splats, b.counts]),
        alloc: this.group("alloc", [b.counts, b.heads, b.bump, b.overflow, b.data, b.iter]),
        fill: this.group("fill", [b.info, b.splats, b.heads, b.cursor, b.data]),
        sort: this.group("sort", [b.heads, b.data]),
        cache: this.group("cache", [b.info, b.splats, b.caches]),
        render: this.group("render", [b.info, b.splats, b.caches, b.heads, b.data, b.pixels, b.trans]),
        backward: this.group("backward", [b.info, b.reference, b.splats, b.caches, b.heads, b.data, b.pixels, b.trans, b.grads]),
        adam: this.group("adam", [b.info, b.splats, b.grads, b.m1, b.m2, b.rate]),
        cells: this.group("cells", [b.info, b.reference, b.pixels, b.cells, b.cellImm]),
        select: this.group("select", [b.cells, b.state, b.cdf, b.selectImm]),
        move: this.group("move", [b.info, b.reference, b.splats, b.cells, b.state, b.cdf, b.moveImm]),
      };
    }
    spread(num) {
      const limit = this.dev.limits.maxComputeWorkgroupsPerDimension;
      if (num <= limit) return [num, 1, 1];
      const y = Math.ceil(num / limit);
      return [Math.ceil(num / y), y, 1];
    }
    resetOverflow() {
      const n = this.count, splatGroups = this.spread(Math.ceil(n / WG));
      const args = { fill: this.spread(n), sort: this.spread(this.tiles[0] * this.tiles[1]), cache: splatGroups,
        render: [Math.ceil(this.width / 16), Math.ceil(this.height / 16), 1], backward: [this.tiles[0], this.tiles[1], 1], adam: splatGroups };
      const data = new Uint32Array(4 + INDIRECT.length * 4);
      INDIRECT.forEach((name, i) => data.set(args[name], 4 + i * 4));
      this.dev.queue.writeBuffer(this.b.overflow, 0, data);
    }
    growBins() {
      const size = this.b.data.size * 2;
      if (size > this.dev.limits.maxStorageBufferBindingSize) throw new Error("SPLAT_GPU_LIMIT");
      this.b.data.destroy();
      this.b.data = this.dev.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      this.bind();
      this.resetOverflow();
    }
    dispatch(pass, name, size) {
      pass.setPipeline(this.pipelines[name]);
      pass.setBindGroup(0, this.groups[name]);
      if (typeof size === "number") pass.dispatchWorkgroupsIndirect(this.b.overflow, 16 + size * 16);
      else pass.dispatchWorkgroups(...size);
    }
    encodeRender(encoder) {
      for (const buffer of [this.b.counts, this.b.bump, this.b.cursor]) encoder.clearBuffer(buffer);
      const pass = encoder.beginComputePass();
      this.dispatch(pass, "count", this.spread(this.count));
      this.dispatch(pass, "alloc", [Math.ceil(this.tiles[0] * this.tiles[1] / WG), 1, 1]);
      ["fill", "sort", "cache", "render"].forEach((name) => this.dispatch(pass, name, INDIRECT.indexOf(name)));
      pass.end();
    }
    watchOverflow(encoder) {
      if (this.overflowState.reading) return null;
      this.overflowState.reading = true;
      encoder.copyBufferToBuffer(this.b.overflow, 0, this.overflowRead, 0, 16);
      return () => this.overflowRead.mapAsync(GPUMapMode.READ).then(() => {
        const [flag, iteration] = new Uint32Array(this.overflowRead.getMappedRange().slice(0));
        this.overflowRead.unmap();
        if (flag && this.overflowState.iteration < 0) this.overflowState.iteration = iteration;
        this.overflowState.reading = false;
      });
    }
    checkLost() { if (this.lost) throw new Error("SPLAT_GPU_LOST: " + (this.lost.message || this.lost.reason)); }
    /* Waits for submitted work and grows bins when needed. Returns the
     * iteration to replay from, or -1. */
    async settle() {
      await this.dev.queue.onSubmittedWorkDone();
      while (this.overflowState.reading) await new Promise((resolve) => setTimeout(resolve, 0));
      const encoder = this.dev.createCommandEncoder(), read = this.watchOverflow(encoder);
      this.dev.queue.submit([encoder.finish()]);
      await read();
      this.checkLost();
      const iteration = this.overflowState.iteration;
      if (iteration < 0) return -1;
      this.overflowState.iteration = -1;
      this.growBins();
      return iteration;
    }
    async step(iteration, lrScale) {
      const q = this.dev.queue;
      q.writeBuffer(this.b.iter, 0, new Uint32Array([iteration]));
      q.writeBuffer(this.b.rate, 0, new Float32Array([lrScale]));
      const encoder = this.dev.createCommandEncoder();
      this.encodeRender(encoder);
      encoder.clearBuffer(this.b.grads);
      const pass = encoder.beginComputePass();
      this.dispatch(pass, "backward", INDIRECT.indexOf("backward"));
      this.dispatch(pass, "adam", INDIRECT.indexOf("adam"));
      pass.end();
      const read = this.watchOverflow(encoder);
      q.submit([encoder.finish()]);
      if (read) read().catch(() => {});
      this.pending.push(q.onSubmittedWorkDone());
      if (this.pending.length >= IN_FLIGHT) while (this.pending.length >= IN_FLIGHT / 2) await this.pending.shift();
      this.checkLost();
    }
    async renderOnly() {
      for (;;) {
        const encoder = this.dev.createCommandEncoder();
        this.encodeRender(encoder);
        this.dev.queue.submit([encoder.finish()]);
        if (await this.settle() < 0) return;
      }
    }
    async redistribute(cellSize, moveCount, splatSize, seed) {
      await this.renderOnly();
      const grid = [Math.ceil(this.width / cellSize), Math.ceil(this.height / cellSize)], cells = grid[0] * grid[1];
      if (this.b.cells.size < cells * 8) {
        this.b.cells.destroy();
        this.b.cells = this.dev.createBuffer({ size: cells * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.bind();
      }
      const q = this.dev.queue;
      q.writeBuffer(this.b.cellImm, 0, new Uint32Array([grid[0], grid[1], cellSize, 0]));
      q.writeBuffer(this.b.selectImm, 0, new Uint32Array([grid[0], grid[1], moveCount, 0]));
      const move = new DataView(new ArrayBuffer(32));
      move.setUint32(0, grid[0], true); move.setUint32(4, grid[1], true); move.setUint32(8, cellSize, true);
      move.setFloat32(12, splatSize, true); move.setUint32(16, seed >>> 0, true);
      q.writeBuffer(this.b.moveImm, 0, move.buffer);
      const encoder = this.dev.createCommandEncoder(), pass = encoder.beginComputePass();
      this.dispatch(pass, "cells", [Math.ceil(grid[0] / 16), Math.ceil(grid[1] / 16), 1]);
      this.dispatch(pass, "select", [1, 1, 1]);
      this.dispatch(pass, "move", this.spread(Math.ceil(this.count / WG)));
      pass.end();
      q.submit([encoder.finish()]);
      this.pending = [];
      await q.onSubmittedWorkDone();
    }
    async read(buffer, size, offset = 0) {
      const staging = this.dev.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = this.dev.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, offset, staging, 0, size);
      this.dev.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = staging.getMappedRange().slice(0);
      staging.destroy();
      return out;
    }
    async pixels() {
      await this.renderOnly();
      return new Float32Array(await this.read(this.b.pixels, this.width * this.height * 16));
    }
    async readParams(out) {
      const raw = new Float32Array(await this.read(this.b.splats, this.count * SPLAT_BYTES));
      for (let i = 0, k = 0; k < out.length; i += 12, k += STRIDE) {
        out[k] = raw[i]; out[k + 1] = raw[i + 1]; out[k + 2] = raw[i + 2]; out[k + 3] = raw[i + 3]; out[k + 4] = raw[i + 10];
        out[k + 5] = raw[i + 4]; out[k + 6] = raw[i + 5]; out[k + 7] = raw[i + 6]; out[k + 8] = raw[i + 7];
        out[k + 9] = raw[i + 8]; out[k + 10] = raw[i + 9];
      }
      return out;
    }
    async lastLoss() {
      return new Float32Array(await this.read(this.b.grads, 4, GRAD_COPIES * this.count * STRIDE * 4))[0];
    }
    destroy() { this.dev.destroy(); }
  }

  /* Same interface as SplatCore.createFitter where the worker needs it, but
   * asynchronous: `params` is a host copy refreshed by sync(), render()
   * resolves to premultiplied pixels. Resolves to null without WebGPU. */
  async function createFitter(target, width, height, params, background, options = {}) {
    const Core = options.core;
    const dev = await device();
    if (!dev) return null;
    const cap = Core.rampCap(height), n = params.length / STRIDE, N = width * height;
    const learner = new Learner(dev, target, width, height, params, background, { cap, weights: options.weights || null, lr: { ...Core.LR, ...(options.lr || {}) } });
    try { await learner.ready(); } catch (error) { learner.destroy(); throw error; }
    const host = Float64Array.from(params);
    let lastLoss = NaN;

    /* SplatCore.createFitter's schedule. */
    function redistributeArgs(iter, iters) {
      const spacing = Math.sqrt(N / Math.max(1, n)), progress = iter / iters;
      const cellSize = Math.max(1, Math.floor(Math.max(1, spacing * 2 ** (1 - 3 * progress))));
      const cells = Math.ceil(width / cellSize) * Math.ceil(height / cellSize);
      return [cellSize, Math.max(1, Math.floor(0.5 * 2 ** (-3 * progress) * cells)), spacing * 0.9];
    }

    /* Learner::run, replaying iterations skipped by a bin overflow. As in the
     * CPU fitter, nothing moves after the final step. */
    async function run(iters, lrScale, every, seed, hooks = {}) {
      const random = Core.rng(seed);
      let iter = 0;
      while (iter < iters) {
        await learner.step(iter, lrScale);
        const due = every > 0 && iter % every === 0 && iter + 1 < iters;
        if (due || iter + 1 === iters || learner.overflowState.iteration >= 0) {
          const replay = await learner.settle();
          if (replay >= 0) { iter = replay; continue; }
        }
        if (due) await learner.redistribute(...redistributeArgs(iter, iters), Math.floor(random() * 4294967296));
        iter++;
        if (hooks.each) {
          let keep = hooks.each(iter);
          if (keep && typeof keep.then === "function") keep = await keep;
          if (keep === false) return false;
        }
      }
      lastLoss = await learner.lastLoss();
      return true;
    }

    return {
      backend: "webgpu", params: host, count: n, width, height, background, cap, run,
      sync: () => learner.readParams(host),
      render: () => learner.pixels(),
      async loss() { await learner.readParams(host); return Core.createFitter(target, width, height, host.slice(), background, { weights: options.weights }).loss(); },
      get lastLoss() { return lastLoss; },
      destroy: () => learner.destroy(),
    };
  }

  return { createFitter, device, SHADERS, COMMON };
})();
if (typeof module !== "undefined") module.exports = SplatGpu;
