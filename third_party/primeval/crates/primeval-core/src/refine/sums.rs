//! Four-slot refit accumulators and four-pixel group kernels.
//!
//! One generic loop owns six pairs of vector accumulators for the whole
//! call; only the final fold writes scalar slot planes. Tails use RGB SIMD
//! on NEON/SSE2 (scalar RGB on wasm) for one pixel, the low vector half for
//! two, and the first high lane for a third. Missing lanes add +0.0.
use super::{Blend, Layer, Scanline, Sums, clamp_line};

/// Six planes with one lane per slot; see [`Sums`] for the accumulation order.
/// An accumulator is never -0.0: finite additions from +0.0 cannot produce
/// it (exact cancellation gives +0.0, and these products cannot underflow
/// f64). Skipping hidden pixels and missing tail slots is thus identical
/// to adding +0.0, including in the potentially negative numerators.
#[derive(Default)]
pub(super) struct SlotSums {
    pub(super) weights: [f64; 4],
    pub(super) numerators: [[f64; 4]; 3],
    pub(super) errors: [f64; 4],
    pub(super) removed: [f64; 4],
}

impl SlotSums {
    #[inline]
    pub(super) fn add(&mut self, slot: usize, terms: [f64; 6]) {
        let [weights, nr, ng, nb, errors, removed] = terms;
        self.weights[slot] += weights;
        for (plane, term) in self.numerators.iter_mut().zip([nr, ng, nb]) {
            plane[slot] += term;
        }
        self.errors[slot] += errors;
        self.removed[slot] += removed;
    }

    /// Fold each plane in the order specified by [`Sums`].
    pub(super) fn finish(self) -> Sums {
        let sum = |slots: [f64; 4]| slots.into_iter().fold(0.0, |sum, slot| sum + slot);
        Sums {
            weights: sum(self.weights),
            numerators: self.numerators.map(sum),
            errors: sum(self.errors),
            removed: sum(self.removed),
        }
    }
}

/// Scalar reference on every target and fallback on non-SIMD targets.
#[cfg_attr(
    any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    ),
    allow(dead_code)
)]
pub(super) fn scalar_sums(layer: &Layer<'_>, lines: &[Scanline], alpha: u8) -> Sums {
    let mut slots = SlotSums::default();
    layer.visit(lines, alpha, |_, j, g, q, r| {
        slots.add(j % 4, terms(g, q, r))
    });
    slots.finish()
}

/// Six terms after exact f32-to-f64 conversion, in the order of [`Sums`].
#[inline(always)]
pub(super) fn terms(g: f32, q: [f32; 3], r: [f32; 3]) -> [f64; 6] {
    let g = f64::from(g);
    let q = q.map(f64::from);
    let r = r.map(f64::from);
    [
        g * g,
        g * q[0],
        g * q[1],
        g * q[2],
        (q[0] * q[0] + q[1] * q[1]) + q[2] * q[2],
        (r[0] * r[0] + r[1] * r[1]) + r[2] * r[2],
    ]
}

pub(super) fn sums(layer: &Layer<'_>, lines: &[Scanline], alpha: u8) -> Sums {
    #[cfg(any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    ))]
    {
        vector::sums(layer, lines, alpha)
    }
    #[cfg(not(any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )))]
    {
        scalar_sums(layer, lines, alpha)
    }
}

#[cfg(all(
    test,
    any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )
))]
pub(super) use vector::group;
#[cfg(any(
    target_arch = "aarch64",
    target_arch = "x86_64",
    all(target_arch = "wasm32", target_feature = "simd128")
))]
mod vector {
    use super::{Blend, Layer, Scanline, SlotSums, Sums, clamp_line};
    #[cfg(target_arch = "aarch64")]
    use neon::Neon as Native;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    use simd128::Simd128 as Native;
    #[cfg(target_arch = "x86_64")]
    use sse2::Sse2 as Native;

    /// Only baseline, lane-wise IEEE operations; no FMA or reassociation.
    /// All register operations are safe on the module's configured target.
    /// Typed loads stay in their arrays: A/lanes=4, B=12, pair B/A=6/2.
    /// B loads at 0/4/8 each read four floats. All lanes are fixed.
    trait Simd {
        type F32: Copy;
        type F64: Copy;
        type Mask: Copy;
        type Tables: Copy;
        fn tables() -> Self::Tables;
        fn splat32(value: f32) -> Self::F32;
        fn lanes32(values: [f32; 4]) -> Self::F32;
        fn sub32(a: Self::F32, b: Self::F32) -> Self::F32;
        fn mul32(a: Self::F32, b: Self::F32) -> Self::F32;
        fn splat64(value: f64) -> Self::F64;
        fn pack64(value: f64) -> Self::F64;
        fn add64(a: Self::F64, b: Self::F64) -> Self::F64;
        fn mul64(a: Self::F64, b: Self::F64) -> Self::F64;
        fn halves(value: Self::F32) -> [Self::F64; 2];
        fn blue(value: Self::F32) -> f32;
        fn lane64<const LANE: usize>(value: Self::F64) -> f64;
        /// Target-specific masks; `masked` turns A == 0 lanes into +0.0.
        fn hidden(a: Self::F32) -> [Self::Mask; 2];
        fn masked(value: Self::F64, hidden: Self::Mask) -> Self::F64;
        /// A bitwise all-zero test may skip +0.0; -0.0 can take the
        /// ordinary masked path, with the same result.
        fn has_visible(a: &[f32; 4]) -> bool;
        fn load_a(a: &[f32; 4]) -> Self::F32;
        fn load_b(b: &[[f32; 3]; 4]) -> [Self::F32; 3];
        #[inline(always)]
        fn pair_b(b: [[f32; 3]; 2]) -> [Self::F32; 3] {
            [0, 1, 2].map(|c| Self::lanes32([b[0][c], b[1][c], 0.0, 0.0]))
        }
        #[inline(always)]
        fn pair_a(a: [f32; 2]) -> Self::F32 {
            Self::lanes32([a[0], a[1], 0.0, 0.0])
        }
        /// # Safety
        /// `pixels` exposes 16 readable bytes; unaligned loads are allowed.
        unsafe fn bytes16(pixels: *const u8, tables: Self::Tables) -> [Self::F32; 3];
        #[inline(always)]
        fn store(halves: [Self::F64; 2]) -> [f64; 4] {
            [
                Self::lane64::<0>(halves[0]),
                Self::lane64::<1>(halves[0]),
                Self::lane64::<0>(halves[1]),
                Self::lane64::<1>(halves[1]),
            ]
        }
        #[inline(always)]
        fn pixel_rgb(rgb: [u8; 3]) -> Self::F32 {
            Self::lanes32([f32::from(rgb[0]), f32::from(rgb[1]), f32::from(rgb[2]), 0.0])
        }
        #[inline(always)]
        fn pixel_terms(t: [u8; 3], d: [u8; 3], b: [f32; 3], a: f32, blend: Blend) -> [f64; 6] {
            let (t, d) = (Self::pixel_rgb(t), Self::pixel_rgb(d));
            let rest = Self::sub32(t, Self::lanes32([b[0], b[1], b[2], 0.0]));
            let q = Self::sub32(rest, Self::mul32(Self::splat32(a * blend.keep), d));
            let r = Self::sub32(rest, Self::mul32(Self::splat32(a), d));
            let ql = Self::halves(q)[0];
            let rl = Self::halves(r)[0];
            let qb = f64::from(Self::blue(q));
            let rb = f64::from(Self::blue(r));
            let g = f64::from(a * blend.paint);
            let numerator = Self::mul64(Self::splat64(g), ql);
            let q2 = Self::mul64(ql, ql);
            let r2 = Self::mul64(rl, rl);
            [
                g * g,
                Self::lane64::<0>(numerator),
                Self::lane64::<1>(numerator),
                g * qb,
                (Self::lane64::<0>(q2) + Self::lane64::<1>(q2)) + qb * qb,
                (Self::lane64::<0>(r2) + Self::lane64::<1>(r2)) + rb * rb,
            ]
        }
    }

    /// # Safety
    /// `pixels` exposes 12 readable bytes, or 16 when `wide` is true.
    #[inline(always)]
    unsafe fn bytes<S: Simd>(pixels: *const u8, wide: bool, tables: S::Tables) -> [S::F32; 3] {
        let mut padded = [0_u8; 16];
        // SAFETY: the caller proves 12 bytes (16 for wide); the local
        // destination is disjoint and has 16. Narrow loads copy only 12.
        let src = if wide {
            pixels
        } else {
            unsafe { core::ptr::copy_nonoverlapping(pixels, padded.as_mut_ptr(), 12) };
            padded.as_ptr()
        };
        // SAFETY: either branch supplies 16 readable bytes, without
        // crossing the caller's row slice or the local padding array.
        unsafe { S::bytes16(src, tables) }
    }

    struct Vectors<S: Simd> {
        // weights, R/G/B numerators, error, removed; slots 0/1 and 2/3.
        planes: [[S::F64; 2]; 6],
    }
    impl<S: Simd> Vectors<S> {
        #[inline(always)]
        fn zero() -> Self {
            Self {
                planes: [[S::splat64(0.0); 2]; 6],
            }
        }
        /// Materialize the six scalar planes only after all lines.
        #[inline(always)]
        fn slots(self) -> SlotSums {
            let [weights, nr, ng, nb, errors, removed] = self.planes.map(S::store);
            SlotSums {
                weights,
                numerators: [nr, ng, nb],
                errors,
                removed,
            }
        }
        #[inline(always)]
        fn group(
            self,
            t: [S::F32; 3],
            d: [S::F32; 3],
            b: &[[f32; 3]; 4],
            a: &[f32; 4],
            blend: Blend,
        ) -> Self {
            self.update::<2>(t, d, S::load_b(b), S::load_a(a), blend)
        }
        /// u8 -> f32 and f32 -> f64 conversions are exact; products of
        /// converted f32s in f64 are exact (at most 48 significant bits).
        /// Each lane holds its slot's contribution (see [`Sums`]). Masking
        /// hidden lanes gives +0.0. Missing/hidden additions cannot
        /// alter another lane, and no accumulator is -0.0 (see SlotSums).
        #[inline(always)]
        fn update<const HALVES: usize>(
            mut self,
            t: [S::F32; 3],
            d: [S::F32; 3],
            b: [S::F32; 3],
            a: S::F32,
            blend: Blend,
        ) -> Self {
            let keep = S::mul32(a, S::splat32(blend.keep));
            let g = S::halves(S::mul32(a, S::splat32(blend.paint)));
            let hidden = S::hidden(a);
            let channels = [0, 1, 2].map(|c| {
                let rest = S::sub32(t[c], b[c]);
                (
                    S::halves(S::sub32(rest, S::mul32(keep, d[c]))),
                    S::halves(S::sub32(rest, S::mul32(a, d[c]))),
                )
            });
            for half in 0..HALVES {
                let [qr, qg, qb] = channels.map(|(q, _)| q[half]);
                let [rr, rg, rb] = channels.map(|(_, r)| r[half]);
                let terms = [
                    S::mul64(g[half], g[half]),
                    S::mul64(g[half], qr),
                    S::mul64(g[half], qg),
                    S::mul64(g[half], qb),
                    S::add64(
                        S::add64(S::mul64(qr, qr), S::mul64(qg, qg)),
                        S::mul64(qb, qb),
                    ),
                    S::add64(
                        S::add64(S::mul64(rr, rr), S::mul64(rg, rg)),
                        S::mul64(rb, rb),
                    ),
                ];
                for (plane, term) in self.planes.iter_mut().zip(terms) {
                    plane[half] = S::add64(plane[half], S::masked(term, hidden[half]));
                }
            }
            self
        }
        /// Pair tails update slots 0/1; a third pixel updates slot 2 below.
        #[inline(always)]
        fn pair(
            self,
            t: [[u8; 3]; 2],
            d: [[u8; 3]; 2],
            b: [[f32; 3]; 2],
            a: [f32; 2],
            blend: Blend,
            tables: S::Tables,
        ) -> Self {
            if a[0] == 0.0 && a[1] == 0.0 {
                return self;
            }
            let t = [t[0], t[1], [0; 3], [0; 3]];
            let d = [d[0], d[1], [0; 3], [0; 3]];
            // SAFETY: both local RGB arrays contain exactly 12 bytes;
            // the narrow loader copies those 12 and pads to 16 locally.
            unsafe {
                self.update::<1>(
                    bytes::<S>(t.as_ptr().cast(), false, tables),
                    bytes::<S>(d.as_ptr().cast(), false, tables),
                    S::pair_b(b),
                    S::pair_a(a),
                    blend,
                )
            }
        }
        /// HALF is constant 0 or 1, always updating its first lane with
        /// +0.0 in the unused lane; no dynamic accumulator addressing.
        #[inline(always)]
        fn pixel<const HALF: usize>(
            mut self,
            t: [u8; 3],
            d: [u8; 3],
            b: [f32; 3],
            a: f32,
            blend: Blend,
        ) -> Self {
            if a == 0.0 {
                return self;
            }
            for (plane, term) in self
                .planes
                .iter_mut()
                .zip(S::pixel_terms(t, d, b, a, blend))
            {
                plane[HALF] = S::add64(plane[HALF], S::pack64(term));
            }
            self
        }
    }

    pub(in crate::refine) fn sums(layer: &Layer<'_>, lines: &[Scanline], alpha: u8) -> Sums {
        sums_for::<Native>(layer, lines, alpha)
    }
    #[inline(always)]
    fn sums_for<S: Simd>(layer: &Layer<'_>, lines: &[Scanline], alpha: u8) -> Sums {
        let mut vectors = Vectors::<S>::zero();
        let tables = S::tables();
        let above = layer.above;
        let (target, below) = (layer.target.pixels(), layer.below.pixels());
        for line in lines {
            let Some((x1, x2)) = clamp_line(line, above.width, above.height) else {
                continue;
            };
            let Some(blend) = Blend::new(alpha, line.alpha) else {
                continue;
            };
            let row = line.y as usize * above.width as usize;
            let start = row + x1 as usize;
            let end = row + x2 as usize + 1;
            let row_end = row + above.width as usize;
            let t = &target[3 * row..3 * row_end];
            let d = &below[3 * row..3 * row_end];
            let b = &above.offset[3 * start..3 * end];
            let (a, aa) = above.transmittance[start..end].as_chunks::<4>();
            let offset = 3 * x1 as usize;
            let available = above.width as usize - x1 as usize;
            // SAFETY: clipping proves offset is within both sliced RGB rows.
            let (tp, dp) = unsafe { (t.as_ptr().add(offset), d.as_ptr().add(offset)) };
            let bp = b.as_ptr();
            for (j, a) in a.iter().enumerate() {
                // Hidden groups retain their slots while skipping RGB math.
                if !S::has_visible(a) {
                    continue;
                }
                let i = 12 * j;
                let wide = available - 4 * j >= 6;
                // SAFETY: group j has four clipped pixels: 12 RGB bytes and
                // 12 aligned B floats. `wide` proves six row pixels remain,
                // giving >=16 readable RGB bytes without crossing the row.
                let (t, d, b) = unsafe {
                    (
                        bytes::<S>(tp.add(i), wide, tables),
                        bytes::<S>(dp.add(i), wide, tables),
                        &*bp.add(i).cast::<[[f32; 3]; 4]>(),
                    )
                };
                vectors = vectors.group(t, d, b, a, blend);
            }
            let i = 12 * a.len();
            // SAFETY: clipping and the sliced planes give aa.len() tail
            // pixels, with three RGB/B values each. The branches prove
            // two pixels for a pair, one for slot 0, or three for slot 2.
            // Raw tail reads avoid redundant bounds checks across planes.
            unsafe {
                if aa.len() >= 2 {
                    vectors = vectors.pair(
                        *tp.add(i).cast::<[[u8; 3]; 2]>(),
                        *dp.add(i).cast::<[[u8; 3]; 2]>(),
                        *bp.add(i).cast::<[[f32; 3]; 2]>(),
                        [aa[0], aa[1]],
                        blend,
                        tables,
                    );
                } else if aa.len() == 1 {
                    vectors = vectors.pixel::<0>(
                        *tp.add(i).cast::<[u8; 3]>(),
                        *dp.add(i).cast::<[u8; 3]>(),
                        *bp.add(i).cast::<[f32; 3]>(),
                        aa[0],
                        blend,
                    );
                }
                if aa.len() > 2 {
                    let j = i + 6;
                    vectors = vectors.pixel::<1>(
                        *tp.add(j).cast::<[u8; 3]>(),
                        *dp.add(j).cast::<[u8; 3]>(),
                        *bp.add(j).cast::<[f32; 3]>(),
                        aa[2],
                        blend,
                    );
                }
            }
        }
        vectors.slots().finish()
    }

    #[cfg(test)]
    pub(in crate::refine) fn group(
        slots: &mut SlotSums,
        t: &[[u8; 3]; 4],
        d: &[[u8; 3]; 4],
        b: &[[f32; 3]; 4],
        a: &[f32; 4],
        blend: Blend,
    ) {
        let tables = Native::tables();
        // SAFETY: each RGB input has 12 bytes; narrow loads pad locally.
        let group = unsafe {
            Vectors::<Native>::zero()
                .group(
                    bytes::<Native>(t.as_ptr().cast(), false, tables),
                    bytes::<Native>(d.as_ptr().cast(), false, tables),
                    b,
                    a,
                    blend,
                )
                .slots()
        };
        // 0 + m differs from m only for m = -0.0; x + (+/-0.0) = x
        // unless x = -0.0, which no accumulator can be (see SlotSums).
        // Merging a zero-based group's lanes equals the vector update.
        for slot in 0..4 {
            slots.add(
                slot,
                [
                    group.weights[slot],
                    group.numerators[0][slot],
                    group.numerators[1][slot],
                    group.numerators[2][slot],
                    group.errors[slot],
                    group.removed[slot],
                ],
            );
        }
    }

    #[cfg(target_arch = "aarch64")]
    mod neon {
        use super::Simd;
        use core::arch::aarch64::*;
        pub(super) struct Neon;
        // SAFETY: NEON is baseline; typed accesses obey the shared trait
        // bounds. Local table/RGB loads read their 16-/8-byte arrays.
        // Table byte positions match the u32 bitcast's endianness.
        impl Simd for Neon {
            type F32 = float32x4_t;
            type F64 = float64x2_t;
            type Mask = uint64x2_t;
            type Tables = [uint8x16_t; 3];
            #[inline(always)]
            fn tables() -> Self::Tables {
                unsafe {
                    [0, 1, 2].map(|c| {
                        let mut indices = [255; 16];
                        let low = if cfg!(target_endian = "little") { 0 } else { 3 };
                        for pixel in 0..4 {
                            indices[4 * pixel + low] = c + 3 * pixel as u8;
                        }
                        vld1q_u8(indices.as_ptr())
                    })
                }
            }
            #[inline(always)]
            fn splat32(v: f32) -> Self::F32 {
                unsafe { vdupq_n_f32(v) }
            }
            #[inline(always)]
            fn lanes32(v: [f32; 4]) -> Self::F32 {
                unsafe { vld1q_f32(v.as_ptr()) }
            }
            #[inline(always)]
            fn sub32(a: Self::F32, b: Self::F32) -> Self::F32 {
                unsafe { vsubq_f32(a, b) }
            }
            #[inline(always)]
            fn mul32(a: Self::F32, b: Self::F32) -> Self::F32 {
                unsafe { vmulq_f32(a, b) }
            }
            #[inline(always)]
            fn splat64(v: f64) -> Self::F64 {
                unsafe { vdupq_n_f64(v) }
            }
            #[inline(always)]
            fn pack64(v: f64) -> Self::F64 {
                unsafe { vcombine_f64(vdup_n_f64(v), vdup_n_f64(0.0)) }
            }
            #[inline(always)]
            fn add64(a: Self::F64, b: Self::F64) -> Self::F64 {
                unsafe { vaddq_f64(a, b) }
            }
            #[inline(always)]
            fn mul64(a: Self::F64, b: Self::F64) -> Self::F64 {
                unsafe { vmulq_f64(a, b) }
            }
            #[inline(always)]
            fn halves(v: Self::F32) -> [Self::F64; 2] {
                unsafe {
                    [
                        vcvt_f64_f32(vget_low_f32(v)),
                        vcvt_f64_f32(vget_high_f32(v)),
                    ]
                }
            }
            #[inline(always)]
            fn blue(v: Self::F32) -> f32 {
                unsafe { vgetq_lane_f32::<2>(v) }
            }
            #[inline(always)]
            fn lane64<const LANE: usize>(v: Self::F64) -> f64 {
                unsafe {
                    if LANE == 0 {
                        vgetq_lane_f64::<0>(v)
                    } else {
                        vgetq_lane_f64::<1>(v)
                    }
                }
            }
            #[inline(always)]
            fn hidden(a: Self::F32) -> [Self::Mask; 2] {
                unsafe {
                    let h = vceqq_f32(a, vdupq_n_f32(0.0));
                    [
                        vreinterpretq_u64_s64(vmovl_s32(vreinterpret_s32_u32(vget_low_u32(h)))),
                        vreinterpretq_u64_s64(vmovl_s32(vreinterpret_s32_u32(vget_high_u32(h)))),
                    ]
                }
            }
            #[inline(always)]
            fn masked(v: Self::F64, h: Self::Mask) -> Self::F64 {
                unsafe { vreinterpretq_f64_u64(vbicq_u64(vreinterpretq_u64_f64(v), h)) }
            }
            #[inline(always)]
            fn has_visible(a: &[f32; 4]) -> bool {
                unsafe { vmaxvq_u32(vreinterpretq_u32_f32(vld1q_f32(a.as_ptr()))) != 0 }
            }
            #[inline(always)]
            fn load_a(a: &[f32; 4]) -> Self::F32 {
                unsafe { vld1q_f32(a.as_ptr()) }
            }
            #[inline(always)]
            fn load_b(b: &[[f32; 3]; 4]) -> [Self::F32; 3] {
                unsafe {
                    let b = vld3q_f32(b.as_ptr().cast());
                    [b.0, b.1, b.2]
                }
            }
            #[inline(always)]
            fn pair_b(b: [[f32; 3]; 2]) -> [Self::F32; 3] {
                unsafe {
                    let b = vld3_f32(b.as_ptr().cast());
                    let z = vdup_n_f32(0.0);
                    [
                        vcombine_f32(b.0, z),
                        vcombine_f32(b.1, z),
                        vcombine_f32(b.2, z),
                    ]
                }
            }
            #[inline(always)]
            fn pair_a(a: [f32; 2]) -> Self::F32 {
                unsafe { vcombine_f32(vld1_f32(a.as_ptr()), vdup_n_f32(0.0)) }
            }
            #[inline(always)]
            fn pixel_rgb(rgb: [u8; 3]) -> Self::F32 {
                let bytes = [rgb[0], rgb[1], rgb[2], 0, 0, 0, 0, 0];
                unsafe { vcvtq_f32_u32(vmovl_u16(vget_low_u16(vmovl_u8(vld1_u8(bytes.as_ptr()))))) }
            }
            #[inline(always)]
            unsafe fn bytes16(p: *const u8, tables: Self::Tables) -> [Self::F32; 3] {
                // SAFETY: the shared loader supplies 16 bytes; the table
                // puts each RGB byte in its u32 lane, zeroing other bytes.
                unsafe {
                    let rgb = vld1q_u8(p);
                    tables.map(|i| vcvtq_f32_u32(vreinterpretq_u32_u8(vqtbl1q_u8(rgb, i))))
                }
            }
        }
    }

    #[cfg(target_arch = "x86_64")]
    mod sse2 {
        use super::Simd;
        use core::arch::x86_64::*;
        pub(super) struct Sse2;
        #[inline(always)]
        fn rgb_channels(v0: __m128, v1: __m128, v2: __m128) -> [__m128; 3] {
            // SAFETY: register-only SSE/SSE2, baseline on x86_64. Shuffles
            // select r=[0,3,6,9], g=[1,4,7,10], b=[2,5,8,11].
            unsafe {
                let r01 = _mm_shuffle_ps::<0b10_10_11_00>(v0, v1);
                let r23 = _mm_shuffle_ps::<0b01_01_10_10>(v1, v2);
                let g01 = _mm_shuffle_ps::<0b00_00_01_01>(v0, v1);
                let g23 = _mm_shuffle_ps::<0b10_10_11_11>(v1, v2);
                let b01 = _mm_shuffle_ps::<0b01_01_10_10>(v0, v1);
                [
                    _mm_shuffle_ps::<0b10_00_01_00>(r01, r23),
                    _mm_shuffle_ps::<0b10_00_10_00>(g01, g23),
                    _mm_shuffle_ps::<0b11_00_10_00>(b01, v2),
                ]
            }
        }

        // SAFETY: SSE2 is baseline on x86_64; unaligned typed accesses
        // and fixed lanes obey the shared trait bounds.
        impl Simd for Sse2 {
            type F32 = __m128;
            type F64 = __m128d;
            type Mask = __m128d;
            type Tables = [u8; 0];
            #[inline(always)]
            fn tables() -> Self::Tables {
                []
            }
            #[inline(always)]
            fn splat32(v: f32) -> Self::F32 {
                unsafe { _mm_set1_ps(v) }
            }
            #[inline(always)]
            fn lanes32(v: [f32; 4]) -> Self::F32 {
                unsafe { _mm_set_ps(v[3], v[2], v[1], v[0]) }
            }
            #[inline(always)]
            fn sub32(a: Self::F32, b: Self::F32) -> Self::F32 {
                unsafe { _mm_sub_ps(a, b) }
            }
            #[inline(always)]
            fn mul32(a: Self::F32, b: Self::F32) -> Self::F32 {
                unsafe { _mm_mul_ps(a, b) }
            }
            #[inline(always)]
            fn splat64(v: f64) -> Self::F64 {
                unsafe { _mm_set1_pd(v) }
            }
            #[inline(always)]
            fn pack64(v: f64) -> Self::F64 {
                unsafe { _mm_set_sd(v) }
            }
            #[inline(always)]
            fn add64(a: Self::F64, b: Self::F64) -> Self::F64 {
                unsafe { _mm_add_pd(a, b) }
            }
            #[inline(always)]
            fn mul64(a: Self::F64, b: Self::F64) -> Self::F64 {
                unsafe { _mm_mul_pd(a, b) }
            }
            #[inline(always)]
            fn halves(v: Self::F32) -> [Self::F64; 2] {
                unsafe { [_mm_cvtps_pd(v), _mm_cvtps_pd(_mm_movehl_ps(v, v))] }
            }
            #[inline(always)]
            fn blue(v: Self::F32) -> f32 {
                unsafe { _mm_cvtss_f32(_mm_movehl_ps(v, v)) }
            }
            #[inline(always)]
            fn lane64<const LANE: usize>(v: Self::F64) -> f64 {
                unsafe { _mm_cvtsd_f64(if LANE == 0 { v } else { _mm_unpackhi_pd(v, v) }) }
            }
            #[inline(always)]
            fn hidden(a: Self::F32) -> [Self::Mask; 2] {
                unsafe {
                    let visible = _mm_castps_si128(_mm_cmpneq_ps(a, _mm_setzero_ps()));
                    [
                        _mm_castsi128_pd(_mm_unpacklo_epi32(visible, visible)),
                        _mm_castsi128_pd(_mm_unpackhi_epi32(visible, visible)),
                    ]
                }
            }
            #[inline(always)]
            fn masked(v: Self::F64, h: Self::Mask) -> Self::F64 {
                unsafe { _mm_and_pd(v, h) }
            }
            #[inline(always)]
            fn has_visible(a: &[f32; 4]) -> bool {
                unsafe {
                    _mm_movemask_ps(_mm_cmpeq_ps(_mm_loadu_ps(a.as_ptr()), _mm_setzero_ps())) != 15
                }
            }
            #[inline(always)]
            fn load_a(a: &[f32; 4]) -> Self::F32 {
                unsafe { _mm_loadu_ps(a.as_ptr()) }
            }
            #[inline(always)]
            fn load_b(b: &[[f32; 3]; 4]) -> [Self::F32; 3] {
                unsafe {
                    let p = b.as_ptr().cast::<f32>();
                    rgb_channels(
                        _mm_loadu_ps(p),
                        _mm_loadu_ps(p.add(4)),
                        _mm_loadu_ps(p.add(8)),
                    )
                }
            }
            #[inline(always)]
            fn pixel_rgb(rgb: [u8; 3]) -> Self::F32 {
                let p = i32::from(rgb[0]) | (i32::from(rgb[1]) << 8) | (i32::from(rgb[2]) << 16);
                unsafe {
                    let z = _mm_setzero_si128();
                    _mm_cvtepi32_ps(_mm_unpacklo_epi16(
                        _mm_unpacklo_epi8(_mm_cvtsi32_si128(p), z),
                        z,
                    ))
                }
            }
            #[inline(always)]
            unsafe fn bytes16(p: *const u8, _tables: Self::Tables) -> [Self::F32; 3] {
                // SAFETY: the shared loader supplies 16 bytes. Widening
                // zero-extends u8 -> u16 -> i32 before conversion/shuffles.
                unsafe {
                    let rgb = _mm_loadu_si128(p.cast());
                    let z = _mm_setzero_si128();
                    let lo = _mm_unpacklo_epi8(rgb, z);
                    let hi = _mm_unpackhi_epi8(rgb, z);
                    rgb_channels(
                        _mm_cvtepi32_ps(_mm_unpacklo_epi16(lo, z)),
                        _mm_cvtepi32_ps(_mm_unpackhi_epi16(lo, z)),
                        _mm_cvtepi32_ps(_mm_unpacklo_epi16(hi, z)),
                    )
                }
            }
        }
    }

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    mod simd128 {
        use super::{Blend, Simd};
        use crate::refine::{residuals, sums::terms};
        use core::arch::wasm32::*;
        pub(super) struct Simd128;
        // SAFETY: simd128 is enabled by cfg; unaligned typed accesses
        // and fixed lanes obey the shared trait bounds.
        impl Simd for Simd128 {
            type F32 = v128;
            type F64 = v128;
            type Mask = v128;
            type Tables = [v128; 3];
            #[inline(always)]
            fn tables() -> Self::Tables {
                [0, 1, 2].map(|c| {
                    u8x16(
                        c,
                        c + 3,
                        c + 6,
                        c + 9,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                        255,
                    )
                })
            }
            #[inline(always)]
            fn splat32(v: f32) -> Self::F32 {
                f32x4_splat(v)
            }
            #[inline(always)]
            fn lanes32(v: [f32; 4]) -> Self::F32 {
                f32x4(v[0], v[1], v[2], v[3])
            }
            #[inline(always)]
            fn sub32(a: Self::F32, b: Self::F32) -> Self::F32 {
                f32x4_sub(a, b)
            }
            #[inline(always)]
            fn mul32(a: Self::F32, b: Self::F32) -> Self::F32 {
                f32x4_mul(a, b)
            }
            #[inline(always)]
            fn splat64(v: f64) -> Self::F64 {
                f64x2_splat(v)
            }
            #[inline(always)]
            fn pack64(v: f64) -> Self::F64 {
                f64x2(v, 0.0)
            }
            #[inline(always)]
            fn add64(a: Self::F64, b: Self::F64) -> Self::F64 {
                f64x2_add(a, b)
            }
            #[inline(always)]
            fn mul64(a: Self::F64, b: Self::F64) -> Self::F64 {
                f64x2_mul(a, b)
            }
            #[inline(always)]
            fn halves(v: Self::F32) -> [Self::F64; 2] {
                [
                    f64x2_promote_low_f32x4(v),
                    f64x2_promote_low_f32x4(i32x4_shuffle::<2, 3, 2, 3>(v, v)),
                ]
            }
            #[inline(always)]
            fn blue(v: Self::F32) -> f32 {
                f32x4_extract_lane::<2>(v)
            }
            #[inline(always)]
            fn lane64<const LANE: usize>(v: Self::F64) -> f64 {
                f64x2_extract_lane::<LANE>(v)
            }
            #[inline(always)]
            fn hidden(a: Self::F32) -> [Self::Mask; 2] {
                let v = f32x4_ne(a, f32x4_splat(0.0));
                [
                    i32x4_shuffle::<0, 0, 1, 1>(v, v),
                    i32x4_shuffle::<2, 2, 3, 3>(v, v),
                ]
            }
            #[inline(always)]
            fn masked(v: Self::F64, h: Self::Mask) -> Self::F64 {
                v128_and(v, h)
            }
            #[inline(always)]
            fn has_visible(a: &[f32; 4]) -> bool {
                unsafe { v128_any_true(v128_load(a.as_ptr().cast())) }
            }
            #[inline(always)]
            fn load_a(a: &[f32; 4]) -> Self::F32 {
                unsafe { v128_load(a.as_ptr().cast()) }
            }
            #[inline(always)]
            fn load_b(b: &[[f32; 3]; 4]) -> [Self::F32; 3] {
                unsafe {
                    let p = b.as_ptr().cast::<f32>();
                    let b0 = v128_load(p.cast());
                    let b1 = v128_load(p.add(4).cast());
                    let b2 = v128_load(p.add(8).cast());
                    [
                        i32x4_shuffle::<0, 1, 2, 5>(i32x4_shuffle::<0, 3, 6, 6>(b0, b1), b2),
                        i32x4_shuffle::<0, 1, 2, 6>(i32x4_shuffle::<1, 4, 7, 7>(b0, b1), b2),
                        i32x4_shuffle::<0, 1, 4, 7>(i32x4_shuffle::<2, 5, 5, 5>(b0, b1), b2),
                    ]
                }
            }
            #[inline(always)]
            fn pixel_terms(t: [u8; 3], d: [u8; 3], b: [f32; 3], a: f32, blend: Blend) -> [f64; 6] {
                // Preserve the measured faster scalar RGB singleton on wasm.
                let (g, q, r) = residuals(t, d, b, a, blend);
                terms(g, q, r)
            }
            #[inline(always)]
            unsafe fn bytes16(p: *const u8, tables: Self::Tables) -> [Self::F32; 3] {
                // SAFETY: the shared loader supplies 16 bytes. Swizzling
                // extracts RGB, then widening zero-extends each byte.
                unsafe {
                    let rgb = v128_load(p.cast());
                    tables.map(|i| {
                        f32x4_convert_u32x4(u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(
                            u8x16_swizzle(rgb, i),
                        )))
                    })
                }
            }
        }
    }
}
