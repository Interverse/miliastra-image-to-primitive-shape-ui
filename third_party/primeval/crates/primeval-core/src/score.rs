//! Scoring and blending routines for the energy minimization loop.
//!
//! A blend is the exact composite rounded once to the 8-bit grid, in
//! fixed point ([`LineBlend`]): the composite every output writer should
//! reproduce, so the search optimises what is exported. Scoring keeps the
//! Go original's accumulator widths; the colour fit weights pixels by
//! coverage. Buffers are opaque RGB, so every kernel
//! works on the three colour channels only. On aarch64, hot paths use NEON
//! intrinsics to process 8 pixels per iteration; on wasm32 with `simd128`,
//! which the browser builds enable, the energy's blend uses WebAssembly SIMD
//! to process 16; on x86_64 it uses AVX2 to process 32 when the CPU has it,
//! chosen at run time. All give the scalar kernels' results bit for bit.
//!
//! The search scores every candidate against the same target and canvas, so
//! [`fit`] reads each line's sums from the step's [`PrefixSums`] and the
//! energy only blends; [`energy_below`] stops a candidate as soon as it
//! cannot beat the best energy so far.

use crate::buffer::{BYTES_PER_PIXEL, Buffer};
use crate::color::Color;
use crate::prefix::{MAX_CHANNEL_SPAN, PrefixSums, SpanSums};
use crate::scanline::{Scanline, clamp_line};

/// Full coverage: a scanline's `alpha` of a pixel it covers whole, and the
/// denominator of the blend's fixed point.
pub(crate) const M: u32 = 0xFFFF;

/// Converts a raw score, the sum of squared channel differences over every
/// pixel, into the normalised RMSE over the RGB channels:
/// `sqrt(raw / (w · h · 3)) / 255`, from `0.0` (identical) to `1.0`.
#[inline]
pub(crate) fn raw_score_to_normalized(raw: u64, width: u32, height: u32) -> f64 {
    (raw as f64 / channel_count(width, height)).sqrt() / 255.0
}

#[cfg(test)]
#[inline]
fn normalized_to_raw_score(score: f64, width: u32, height: u32) -> u64 {
    let s = score * 255.0;
    (s * s * channel_count(width, height)).round() as u64
}

/// The number of channel values a `width × height` buffer holds.
#[inline]
fn channel_count(width: u32, height: u32) -> f64 {
    f64::from(width) * f64::from(height) * BYTES_PER_PIXEL as f64
}

/// Exclusive upper bound of the values [`div_by_m`] divides exactly:
/// `M * (M + 1) = 0xFFFF_0000`, which fits in `u32`.
const BLEND_BOUND: u32 = M * (M + 1);

/// Returns `value / M` without a division.
///
/// Exact for every `value < M * (M + 1)`. Write `value = q * M + r` with
/// `0 <= r < M` and `q <= M`. Since `M = 2^16 - 1`, `value >> 16` is `q - 1`
/// when `r < q` and `q` otherwise, so `value + 1 + (value >> 16)` is
/// `q * 2^16 + r` or `q * 2^16 + r + 1`, both below `(q + 1) * 2^16`; shifting
/// right by 16 gives `q`. The sum stays below `2^32`, so it cannot overflow.
#[inline]
fn div_by_m(value: u32) -> u32 {
    debug_assert!(value < BLEND_BOUND, "blend value {value} out of range");
    (value + 1 + (value >> 16)) >> 16
}

/// One scanline's blend in fixed point: with `k` the line's
/// [`blend_weight`] and `w = k / M`, channel value `c` becomes
/// `round((1 − w) · c + w · s)`, the exact composite rounded once.
///
/// Scaled by `M`, that is `⌊(c · (M − k) + k · s + (M − 1) / 2) / M⌋`: `M` is
/// odd, so no value is halfway between two levels and the rounding is
/// exact. A line with `k = 0` leaves its pixels unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LineBlend {
    /// `M − k`, the factor of the canvas value.
    keep: u32,
    /// `k · s + (M − 1) / 2` per RGB channel.
    terms: [u32; 3],
}

impl LineBlend {
    /// The blend of `color` along a line of `coverage`.
    #[inline]
    fn new(color: Color, coverage: u32) -> Self {
        let k = blend_weight(i32::from(color.a), coverage);
        let term = |s: u8| k * u32::from(s) + M / 2;
        Self {
            keep: M - k,
            terms: [term(color.r), term(color.g), term(color.b)],
        }
    }
}

/// Exclusive upper bound of every blend value `v` of [`blend_channel_scalar`]:
/// with `k <= M`, `v = c · (M − k) + k · s + (M − 1) / 2
/// <= 255 · M + (M − 1) / 2 < 256 · M`, so `v / M` fits in a byte, and `v`
/// is far below [`BLEND_BOUND`], where [`div_by_m`] is exact.
const BLEND_VALUE_BOUND: u32 = 256 * M;
const _: () = assert!(BLEND_VALUE_BOUND <= BLEND_BOUND);

/// Blends one 8-bit channel, `current`, with its [`LineBlend`] `keep` and
/// channel `term`: `(current · keep + term) / M`, rounded down. The NEON
/// blend computes the same value per lane.
#[inline]
fn blend_channel_scalar(current: u8, term: u32, keep: u32) -> u8 {
    let value = u32::from(current) * keep + term;
    debug_assert!(
        value < BLEND_VALUE_BOUND,
        "blend value {value} out of range"
    );
    div_by_m(value) as u8
}

/// Weighted least-squares fit of a shape's colour, accumulated one scanline
/// at a time.
///
/// Drawing channel value `s` with weight `w` turns `c` into
/// `c · (1 − w) + s · w`, so the `s` that brings the shape's pixels closest
/// to the target `t` minimises `Σ (t − c · (1 − w) − s · w)²`, which gives
/// `s* = Σ w · (t − (1 − w) · c) / Σ w²`. The weight is
/// `w = (alpha / 255) · (coverage / M)`, held in the blend's own fixed
/// point: [`draw_lines`] scales the canvas by `M − k` with
/// `k = (alpha · 0x101) · coverage / M` (rounded down), so `w = k / M`.
/// Multiplying through by `M²` keeps every sum an integer:
/// `s* = (M · Σ k · (t − c) + Σ k² · c) / Σ k²`. Coverage is constant along
/// a scanline, so each line contributes through its per-channel sums of `t`
/// and `c` alone.
///
/// Bounds: `k <= M < 2^16`, so a line of `n` pixels adds less than
/// `2^24 · n` to `Σ k · (t − c)`, `2^40 · n` to `Σ k² · c` and `2^32 · n` to
/// `Σ k²`. Lines are summed in 64-bit batches of fewer than
/// [`Self::BATCH_PIXELS`] pixels, which keeps every batch below `2^62`, and
/// each batch is added to `i128` totals that no pixel count can overflow.
struct ColorFit {
    batch: FitSums<i64, u64>,
    batch_pixels: u64,
    total: FitSums<i128, i128>,
}

/// `Σ k · (t − c)` and `Σ k² · c` per channel, and `Σ k²` over every pixel.
#[derive(Default)]
struct FitSums<S, U> {
    differences: [S; 3],
    currents: [U; 3],
    weights: U,
}

impl ColorFit {
    /// Pixels per 64-bit batch: `2^40 · 2^22 = 2^62`.
    const BATCH_PIXELS: u64 = 1 << 22;

    fn new() -> Self {
        Self {
            batch: FitSums::default(),
            batch_pixels: 0,
            total: FitSums::default(),
        }
    }

    /// The blend's fixed-point weight `k` of a scanline: zero for a line the
    /// blend leaves unchanged, which therefore does not affect the fit.
    #[inline]
    fn weight(alpha: i32, coverage: u32) -> u32 {
        // `alpha * 0x101 <= M` and `coverage <= M`, so the product is below
        // `M * (M + 1)`, where `div_by_m` is exact.
        div_by_m(alpha as u32 * 0x101 * coverage)
    }

    /// Adds a scanline of `pixels` pixels with weight `k` whose RGB channels
    /// sum to `target` in the target and `current` on the canvas.
    #[inline]
    fn add_line(&mut self, k: u32, pixels: usize, target: [u64; 3], current: [u64; 3]) {
        let pixels = pixels as u64;
        if self.batch_pixels + pixels >= Self::BATCH_PIXELS {
            self.flush();
            if pixels >= Self::BATCH_PIXELS {
                self.add_long_line(k, pixels, target, current);
                return;
            }
        }
        self.batch_pixels += pixels;
        let k = u64::from(k);
        let k2 = k * k;
        for channel in 0..3 {
            let difference = target[channel] as i64 - current[channel] as i64;
            self.batch.differences[channel] += k as i64 * difference;
            self.batch.currents[channel] += k2 * current[channel];
        }
        self.batch.weights += k2 * pixels;
    }

    /// [`Self::add_line`] in `i128` for a line too long for a batch.
    #[cold]
    fn add_long_line(&mut self, k: u32, pixels: u64, target: [u64; 3], current: [u64; 3]) {
        let k = i128::from(k);
        for channel in 0..3 {
            let (t, c) = (i128::from(target[channel]), i128::from(current[channel]));
            self.total.differences[channel] += k * (t - c);
            self.total.currents[channel] += k * k * c;
        }
        self.total.weights += k * k * i128::from(pixels);
    }

    /// Moves the batch into the `i128` totals.
    fn flush(&mut self) {
        for channel in 0..3 {
            self.total.differences[channel] += i128::from(self.batch.differences[channel]);
            self.total.currents[channel] += i128::from(self.batch.currents[channel]);
        }
        self.total.weights += i128::from(self.batch.weights);
        self.batch = FitSums::default();
        self.batch_pixels = 0;
    }

    /// The fitted colour, each channel rounded to the nearest integer and
    /// clamped to `0..=255`; the default colour when nothing had weight.
    fn color(mut self, alpha: i32) -> Color {
        self.flush();
        let total = self.total;
        let weights = total.weights;
        if weights == 0 {
            return Color::default();
        }
        let channel = |channel: usize| -> u8 {
            let numerator = i128::from(M) * total.differences[channel] + total.currents[channel];
            if numerator <= 0 {
                return 0;
            }
            // Round to nearest. `i128` division is a library call, so take
            // the exact `i64` path whenever both operands fit, as they do for
            // any shape below about `2^21` pixels.
            let (numerator, denominator) = (2 * numerator + weights, 2 * weights);
            let quotient = match (i64::try_from(numerator), i64::try_from(denominator)) {
                (Ok(numerator), Ok(denominator)) => i128::from(numerator / denominator),
                _ => numerator / denominator,
            };
            quotient.min(255) as u8
        };
        Color::new(channel(0), channel(1), channel(2), alpha as u8)
    }
}

/// Lines shorter than this, the one-pixel anti-aliased edge runs that make
/// up most lines of the polygon, rotated-ellipse and quadratic fills, are
/// summed from their pixels, which the energy reads next anyway; longer
/// lines read the step's [`PrefixSums`]. Measured with the Divan
/// `compute_color` and `energy_from_lines_raw` benches: looking up one-pixel
/// lines is slower, and summing two-pixel lines directly gains nothing.
const SHORT_LINE_PIXELS: usize = 2;

/// The per-scanline kernels behind [`fit`] and the energies, in
/// scalar code ([`Scalar`]), NEON ([`Neon`]), WebAssembly SIMD
/// ([`Simd128`]) or AVX2 ([`Avx2`]).
///
/// # Safety
///
/// For every method, `start + pixels * 3` must not exceed `t_pix.len()` or
/// `c_pix.len()`. An [`Avx2`] method may only be called when the CPU
/// supports AVX2, which the energies' run-time dispatch and the parity
/// tests' guard establish; [`fit_with`] and [`energy_with`] leave that to
/// their callers.
trait LineKernels {
    /// Per-channel RGB sums of `pixels` pixels from byte offset `start` in
    /// the target and in the canvas. Scalar by default; NEON overrides it.
    #[inline]
    unsafe fn line_sums(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
    ) -> ([u64; 3], [u64; 3]) {
        scalar::line_sums(t_pix, c_pix, start, pixels)
    }

    /// The sum of squared channel differences between the target and the
    /// canvas over `pixels` pixels from byte offset `start`.
    #[inline]
    unsafe fn line_error(t_pix: &[u8], c_pix: &[u8], start: usize, pixels: usize) -> u64 {
        let end = start + pixels * BYTES_PER_PIXEL;
        Self::difference_bytes(&t_pix[start..end], &c_pix[start..end])
    }

    /// The sum of squared differences of every pair of bytes, which for two
    /// RGB buffers of the same size is the raw score: every byte is a colour
    /// channel, so the pixel boundaries do not matter. Scalar by default;
    /// NEON overrides it.
    #[inline]
    fn difference_bytes(a_pix: &[u8], b_pix: &[u8]) -> u64 {
        scalar::difference_full_raw_pixels(a_pix, b_pix)
    }

    /// The same sum after blending the canvas with `blend`, as
    /// [`draw_lines`] would.
    unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64;
}

/// The kernels for this target, chosen at compile time: NEON on aarch64,
/// simd128 on wasm32 with that feature, scalar elsewhere. x86_64 keeps the
/// scalar kernels here, since its baseline is SSE2, and [`energy`] and
/// [`energy_below`] switch to the [`Avx2`] kernels at run time when the CPU
/// has AVX2.
#[cfg(target_arch = "aarch64")]
type Native = Neon;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
type Native = Simd128;
#[cfg(not(any(
    target_arch = "aarch64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
type Native = Scalar;

/// Asserts that `sums` were built for buffers of `width` x `height`.
#[inline]
fn assert_sums_match(sums: Option<&PrefixSums>, width: u32, height: u32) {
    if let Some(sums) = sums {
        assert!(
            sums.matches(width, height),
            "prefix sums must match the buffers"
        );
    }
}

/// The blend's fixed-point weight `k` of a scanline of coverage `coverage`
/// drawn at `alpha`: [`draw_lines`] scales the canvas by `M − k`, so the
/// blend weight is `k / M`, and `k = 0` leaves the pixels unchanged.
#[inline]
pub(crate) fn blend_weight(alpha: i32, coverage: u32) -> u32 {
    ColorFit::weight(alpha, coverage)
}

/// A shape's fitted colour and the old error of the pixels it covers,
/// which its energy subtracts; see [`fit`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Fit {
    /// The fitted colour with the requested alpha, or the all-zero
    /// [`Color`] if no covered pixel had weight.
    pub(crate) color: Color,
    /// The squared channel differences between the target and the canvas
    /// over every in-bounds pixel of every line, a pixel counted once per
    /// line that covers it.
    pub(crate) before: u64,
}

/// [`fit`] with the kernels `K`.
fn fit_with<K: LineKernels>(
    target: &Buffer,
    current: &Buffer,
    sums: Option<&PrefixSums>,
    lines: &[Scanline],
    alpha: i32,
) -> Fit {
    assert_same_dimensions(target, current);
    assert_sums_match(sums, target.width(), target.height());
    debug_assert!((1..=255).contains(&alpha), "alpha must be 1..=255");
    let w = target.width() as i32;
    let h = target.height() as i32;
    let t_pix = target.pixels();
    let c_pix = current.pixels();
    let mut fit = ColorFit::new();
    let mut before = 0_u64;

    for line in lines {
        let Some((x1, x2)) = clamp_line(line, w, h) else {
            continue;
        };
        let k = ColorFit::weight(alpha, line.alpha);
        let pixels = (x2 - x1 + 1) as usize;
        let start = target.pix_offset(x1, line.y);
        // `clamp_line` keeps `line.y` in `0..h` and `x1..=x2` in `0..w` of
        // `target`, so `start + pixels * 3` is at most `w * h * 3`, the
        // length of `target.pixels()` (the `Buffer` length invariant,
        // asserted by every constructor). `current` has the same dimensions
        // (asserted above), so the same length: every kernel call below
        // meets its contract.
        let span = if pixels < SHORT_LINE_PIXELS {
            // SAFETY: see above.
            Some(unsafe { scalar::span_sums(t_pix, c_pix, start, pixels) })
        } else {
            match sums {
                Some(sums) if pixels <= MAX_CHANNEL_SPAN => Some(sums.span(line.y, x1, x2)),
                _ => None,
            }
        };
        match span {
            Some(span) => {
                before = before.wrapping_add(span.error);
                if k != 0 {
                    fit.add_line(k, pixels, span.target, span.current);
                }
            }
            None => {
                let error = match sums {
                    Some(sums) => sums.error(line.y, x1, x2),
                    // SAFETY: see above.
                    None => unsafe { K::line_error(t_pix, c_pix, start, pixels) },
                };
                before = before.wrapping_add(error);
                if k != 0 {
                    // SAFETY: see above.
                    let (target_sums, current_sums) =
                        unsafe { K::line_sums(t_pix, c_pix, start, pixels) };
                    fit.add_line(k, pixels, target_sums, current_sums);
                }
            }
        }
    }

    Fit {
        color: fit.color(alpha),
        before,
    }
}

/// Whether subtracting `before` already reaches the bounded energy's limit.
/// For canvas errors that fit in i64, this is monotone in `before`: using
/// an upper bound on the old error can only make rejection less likely.
#[inline]
pub(crate) fn before_reaches_limit(score: u64, before: u64, limit: Option<i64>) -> bool {
    limit.is_some_and(|limit| (score as i64).wrapping_sub(before as i64) >= limit)
}

/// The energy of drawing `lines` in `fit.color`: `score` minus
/// `fit.before` plus the new error of every covered pixel, in the wrapping
/// arithmetic of [`energy`].
///
/// With a `limit`, stops and returns `None` as soon as the running total
/// reaches it. Every old error is subtracted first and the new errors are
/// non-negative, so from then on the total only grows, and stopping means
/// the energy is at least `limit`. That holds while no partial total
/// overflows `i64`; see the canvas precondition of [`PrefixSums`].
fn energy_with<K: LineKernels>(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    fit: Fit,
    score: u64,
    limit: Option<i64>,
) -> Option<u64> {
    assert_same_dimensions(target, current);
    let w = target.width() as i32;
    let h = target.height() as i32;
    let t_pix = target.pixels();
    let c_pix = current.pixels();
    let reached = |total: i64| limit.is_some_and(|limit| total >= limit);

    let mut total = (score as i64).wrapping_sub(fit.before as i64);
    if before_reaches_limit(score, fit.before, limit) {
        return None;
    }
    for line in lines {
        let Some((x1, x2)) = clamp_line(line, w, h) else {
            continue;
        };
        let blend = LineBlend::new(fit.color, line.alpha);
        let pixels = (x2 - x1 + 1) as usize;
        let start = target.pix_offset(x1, line.y);
        // SAFETY: as in `fit_with`, the clamped line lies inside `target`,
        // and `current` has the same dimensions.
        let after = unsafe { K::line_after(t_pix, c_pix, start, pixels, blend) };
        total = total.wrapping_add(after as i64);
        if reached(total) {
            return None;
        }
    }

    Some(total as u64)
}

/// The scalar kernels, for targets without NEON or simd128 and x86_64 CPUs
/// without AVX2, and as the reference the SIMD kernels are tested against.
#[cfg_attr(
    any(
        target_arch = "aarch64",
        all(target_arch = "wasm32", target_feature = "simd128")
    ),
    allow(dead_code)
)]
struct Scalar;

impl LineKernels for Scalar {
    #[inline]
    unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        scalar::line_after(t_pix, c_pix, start, pixels, blend)
    }
}

/// The NEON kernels.
#[cfg(target_arch = "aarch64")]
struct Neon;

#[cfg(target_arch = "aarch64")]
impl LineKernels for Neon {
    #[inline]
    unsafe fn line_sums(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
    ) -> ([u64; 3], [u64; 3]) {
        // SAFETY: this method's contract is `neon::line_sums`'s.
        unsafe { neon::line_sums(t_pix, c_pix, start, pixels) }
    }

    #[inline]
    fn difference_bytes(a_pix: &[u8], b_pix: &[u8]) -> u64 {
        neon::difference_bytes(a_pix, b_pix)
    }

    #[inline]
    unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        // SAFETY: this method's contract is `neon::line_after`'s.
        unsafe { neon::line_after(t_pix, c_pix, start, pixels, blend) }
    }
}

/// The WebAssembly SIMD kernels: `line_after`, the energy of every search
/// candidate, in simd128; the default line sums and byte differences in scalar
/// code, since every search and climb fit reads prefix sums, which leaves
/// them only the one fit per committed shape and the full-canvas scores.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
struct Simd128;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
impl LineKernels for Simd128 {
    #[inline]
    unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        // SAFETY: this method's contract is `simd128::line_after`'s.
        unsafe { simd128::line_after(t_pix, c_pix, start, pixels, blend) }
    }
}

/// The AVX2 kernels: `line_after`, the energy of every search candidate, in
/// AVX2; the default line sums and byte differences in scalar code, as in the
/// WebAssembly kernels, since every search and climb fit reads prefix sums.
/// x86_64's baseline is SSE2, so [`Native`] stays [`Scalar`] there and
/// [`energy`] and [`energy_below`] choose these kernels at run time.
///
/// Beyond the trait's contract, `line_after` may only be called when the CPU
/// supports AVX2: the energies' dispatch checks it with
/// `is_x86_feature_detected!`, and so does every test before it calls one.
#[cfg(target_arch = "x86_64")]
struct Avx2;

#[cfg(target_arch = "x86_64")]
impl LineKernels for Avx2 {
    #[inline]
    unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        // SAFETY: this method's contract, the CPU's AVX2 included, is
        // `avx2::line_after`'s.
        unsafe { avx2::line_after(t_pix, c_pix, start, pixels, blend) }
    }
}

// On aarch64 only the reference `Scalar` reads the line kernels.
#[cfg_attr(target_arch = "aarch64", allow(dead_code))]
mod scalar {
    use super::{BYTES_PER_PIXEL, LineBlend, SpanSums, blend_channel_scalar};

    /// The sums of [`SpanSums`] over `pixels` pixels from byte offset
    /// `start`, in one pass over the pixels; for the short lines that are
    /// cheaper to read than to look up.
    ///
    /// # Safety
    ///
    /// `start + pixels * 3` must not exceed `t_pix.len()` or `c_pix.len()`.
    #[inline]
    pub(super) unsafe fn span_sums(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
    ) -> SpanSums {
        let mut span = SpanSums {
            target: [0; 3],
            current: [0; 3],
            error: 0,
        };
        let mut byte = start;
        for _ in 0..pixels {
            let mut error = 0_u32;
            for channel in 0..BYTES_PER_PIXEL {
                // SAFETY: `byte + channel` is below `start + pixels * 3`,
                // within both slices by the caller's contract.
                let (t, c) = unsafe {
                    (
                        *t_pix.get_unchecked(byte + channel),
                        *c_pix.get_unchecked(byte + channel),
                    )
                };
                span.target[channel] += u64::from(t);
                span.current[channel] += u64::from(c);
                let d = u32::from(t.abs_diff(c));
                error += d * d;
            }
            span.error += u64::from(error);
            byte += BYTES_PER_PIXEL;
        }
        span
    }

    /// Per-channel RGB sums of `pixels` pixels from byte offset `start` in
    /// the target and in the canvas.
    #[inline]
    pub(super) fn line_sums(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
    ) -> ([u64; 3], [u64; 3]) {
        let end = start + pixels * BYTES_PER_PIXEL;
        let (t_px3, _) = t_pix[start..end].as_chunks::<3>();
        let (c_px3, _) = c_pix[start..end].as_chunks::<3>();
        let mut target_sums = [0_u64; 3];
        let mut current_sums = [0_u64; 3];
        for (t_px, c_px) in t_px3.iter().zip(c_px3) {
            for channel in 0..3 {
                target_sums[channel] += u64::from(t_px[channel]);
                current_sums[channel] += u64::from(c_px[channel]);
            }
        }
        (target_sums, current_sums)
    }

    /// Sum of squared differences of every byte: every byte of an RGB
    /// buffer is a colour channel, so the pixel boundaries do not matter.
    pub(super) fn difference_full_raw_pixels(a_pix: &[u8], b_pix: &[u8]) -> u64 {
        a_pix
            .iter()
            .zip(b_pix)
            .map(|(&a, &b)| {
                let d = i32::from(a) - i32::from(b);
                (d * d) as u64
            })
            .sum()
    }

    /// The squared channel differences between the target and the canvas
    /// blended with `blend`, over `pixels` pixels from byte offset `start`.
    #[inline]
    pub(super) fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        let end = start + pixels * BYTES_PER_PIXEL;
        let (t_px3, _) = t_pix[start..end].as_chunks::<3>();
        let (c_px3, _) = c_pix[start..end].as_chunks::<3>();
        let mut total = 0_u64;
        for (t_px, c_px) in t_px3.iter().zip(c_px3) {
            let mut after = 0_u32;
            for channel in 0..3 {
                let blended = blend_channel_scalar(c_px[channel], blend.terms[channel], blend.keep);
                let d = u32::from(t_px[channel].abs_diff(blended));
                after += d * d;
            }
            total += u64::from(after);
        }
        total
    }
}

#[cfg(target_arch = "aarch64")]
mod neon {
    use super::{BYTES_PER_PIXEL, LineBlend, blend_channel_scalar, scalar};
    use std::arch::aarch64::*;

    /// Bytes in a chunk of 8 RGB pixels, the unit of every `vld3_u8`.
    const CHUNK_BYTES: usize = 8 * BYTES_PER_PIXEL;

    /// `value / M` per lane, as [`super::div_by_m`], narrowed to 16 bits.
    ///
    /// # Safety
    ///
    /// Requires NEON, which every aarch64 target provides.
    unsafe fn div_by_m_narrow_u32x4(value: uint32x4_t) -> uint16x4_t {
        // SAFETY: register-only NEON intrinsics with no memory access. NEON is a
        // baseline feature of every aarch64 target and this module only compiles
        // for aarch64, so the required target feature is always available.
        unsafe {
            let plus_one = vdupq_n_u32(1);
            let adjusted = vaddq_u32(vaddq_u32(value, plus_one), vshrq_n_u32(value, 16));
            vshrn_n_u32(adjusted, 16)
        }
    }

    /// [`blend_channel_scalar`] on 8 lanes: `(current · keep + term) / M`.
    ///
    /// # Safety
    ///
    /// Requires NEON, which every aarch64 target provides.
    unsafe fn blend_vector_u8x8(current: uint8x8_t, term: u32, keep: u32) -> uint8x8_t {
        // `keep = M − k` fits in 16 bits, so the products are widening
        // 16-bit multiplies accumulated onto the term.
        let keep = keep as u16;
        // SAFETY: register-only NEON intrinsics with no memory access. NEON is a
        // baseline feature of every aarch64 target and this module only compiles
        // for aarch64, so the required target feature is always available.
        unsafe {
            let current16 = vmovl_u8(current);
            let terms = vdupq_n_u32(term);
            let low = vmlal_n_u16(terms, vget_low_u16(current16), keep);
            let high = vmlal_n_u16(terms, vget_high_u16(current16), keep);
            vmovn_u16(vcombine_u16(
                div_by_m_narrow_u32x4(low),
                div_by_m_narrow_u32x4(high),
            ))
        }
    }

    /// [`blend_channel_scalar`] on 8 values with one `term` and `keep`.
    #[cfg(test)]
    pub(super) fn blend_chunk_u8x8(current: [u8; 8], term: u32, keep: u32) -> [u8; 8] {
        let mut out = [0_u8; 8];
        // SAFETY: `vld1_u8` reads and `vst1_u8` writes exactly 8 bytes, and both
        // pointers come from local `[u8; 8]` arrays. The remaining calls are
        // register-only NEON operations; NEON is a baseline aarch64 feature.
        unsafe {
            let current_vec = vld1_u8(current.as_ptr());
            let blended = blend_vector_u8x8(current_vec, term, keep);
            vst1_u8(out.as_mut_ptr(), blended);
        }
        out
    }

    /// # Safety
    ///
    /// Requires NEON, which every aarch64 target provides.
    unsafe fn sum_squared_diff_u8x8(lhs: uint8x8_t, rhs: uint8x8_t) -> u64 {
        // SAFETY: register-only NEON intrinsics with no memory access. NEON is a
        // baseline feature of every aarch64 target and this module only compiles
        // for aarch64, so the required target feature is always available.
        unsafe {
            let lhs16 = vreinterpretq_s16_u16(vmovl_u8(lhs));
            let rhs16 = vreinterpretq_s16_u16(vmovl_u8(rhs));
            let diff = vsubq_s16(lhs16, rhs16);
            let low = vmull_s16(vget_low_s16(diff), vget_low_s16(diff));
            let high = vmull_s16(vget_high_s16(diff), vget_high_s16(diff));
            u64::from(vaddvq_u32(vreinterpretq_u32_s32(low)))
                + u64::from(vaddvq_u32(vreinterpretq_u32_s32(high)))
        }
    }

    /// All ones in the first `pixels` of 8 lanes, zero in the others.
    ///
    /// # Safety
    ///
    /// Requires NEON, which every aarch64 target provides.
    #[inline]
    unsafe fn tail_mask(pixels: usize) -> uint8x8_t {
        debug_assert!(pixels < 8, "a tail is shorter than a chunk");
        const LANES: [u8; 8] = [0, 1, 2, 3, 4, 5, 6, 7];
        // SAFETY: `vld1_u8` reads the 8 bytes of `LANES`; the other calls are
        // register-only. NEON is a baseline aarch64 feature.
        unsafe { vclt_u8(vld1_u8(LANES.as_ptr()), vdup_n_u8(pixels as u8)) }
    }

    /// Blocks of 16 pixels summed pairwise into 16-bit lanes before
    /// widening: each lane gains at most `2 * 255 = 510` per block, and
    /// `510 * 128 = 65_280` fits in `u16`.
    const BLOCKS_PER_FLUSH: usize = 128;

    /// Per-channel RGB sums of `pixels` pixels from byte offset `start` in
    /// the target and in the canvas; matches [`scalar::line_sums`].
    ///
    /// # Safety
    ///
    /// `start + pixels * 3` must not exceed `t_pix.len()` or `c_pix.len()`.
    #[inline]
    pub(super) unsafe fn line_sums(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
    ) -> ([u64; 3], [u64; 3]) {
        let mut target_sums = [0_u64; 3];
        let mut current_sums = [0_u64; 3];
        let mut byte_index = start;
        let mut blocks = pixels / 16;

        while blocks > 0 {
            let flush = blocks.min(BLOCKS_PER_FLUSH);
            blocks -= flush;
            // SAFETY: each `vld3q_u8` reads 16 pixels (48 bytes) from
            // `byte_index`. The loops read `pixels / 16` blocks in total from
            // `start`, so the last byte read is below `start + pixels * 3`,
            // which the caller keeps within both slices. The remaining calls
            // are register-only NEON operations; NEON is a baseline aarch64
            // feature.
            unsafe {
                let mut target_acc = [vdupq_n_u16(0); 3];
                let mut current_acc = [vdupq_n_u16(0); 3];
                for _ in 0..flush {
                    let t = vld3q_u8(t_pix.as_ptr().add(byte_index));
                    let c = vld3q_u8(c_pix.as_ptr().add(byte_index));
                    target_acc[0] = vpadalq_u8(target_acc[0], t.0);
                    target_acc[1] = vpadalq_u8(target_acc[1], t.1);
                    target_acc[2] = vpadalq_u8(target_acc[2], t.2);
                    current_acc[0] = vpadalq_u8(current_acc[0], c.0);
                    current_acc[1] = vpadalq_u8(current_acc[1], c.1);
                    current_acc[2] = vpadalq_u8(current_acc[2], c.2);
                    byte_index += 2 * CHUNK_BYTES;
                }
                for channel in 0..3 {
                    target_sums[channel] += u64::from(vaddlvq_u16(target_acc[channel]));
                    current_sums[channel] += u64::from(vaddlvq_u16(current_acc[channel]));
                }
            }
        }

        if pixels % 16 >= 8 {
            // SAFETY: `vld3_u8` reads the next 8 pixels (24 bytes), which
            // are within the line, below `start + pixels * 3`. The remaining
            // calls are register-only NEON operations.
            unsafe {
                let t = vld3_u8(t_pix.as_ptr().add(byte_index));
                let c = vld3_u8(c_pix.as_ptr().add(byte_index));
                for (channel, (t, c)) in
                    [(t.0, c.0), (t.1, c.1), (t.2, c.2)].into_iter().enumerate()
                {
                    target_sums[channel] += u64::from(vaddlv_u8(t));
                    current_sums[channel] += u64::from(vaddlv_u8(c));
                }
            }
            byte_index += CHUNK_BYTES;
        }

        // Three or more tail pixels take one 8-pixel load with the lanes past
        // the line masked out, when the buffers extend that far; shorter
        // tails, common at anti-aliased edges, are cheaper in scalar code.
        let tail = pixels % 8;
        if tail > 2 && byte_index + CHUNK_BYTES <= t_pix.len().min(c_pix.len()) {
            // SAFETY: `vld3_u8` reads 24 bytes from `byte_index`, within both
            // slices by the check above. The remaining calls are
            // register-only NEON operations.
            unsafe {
                let mask = tail_mask(tail);
                let t = vld3_u8(t_pix.as_ptr().add(byte_index));
                let c = vld3_u8(c_pix.as_ptr().add(byte_index));
                for (channel, (t, c)) in
                    [(t.0, c.0), (t.1, c.1), (t.2, c.2)].into_iter().enumerate()
                {
                    target_sums[channel] += u64::from(vaddlv_u8(vand_u8(t, mask)));
                    current_sums[channel] += u64::from(vaddlv_u8(vand_u8(c, mask)));
                }
            }
        } else {
            // SAFETY: the tail reads the last `tail` pixels of the line, which
            // end at `start + pixels * 3`, within both slices by the
            // caller's contract.
            unsafe {
                let (t_ptr, c_ptr) = (t_pix.as_ptr(), c_pix.as_ptr());
                for _ in 0..tail {
                    for channel in 0..3 {
                        target_sums[channel] += u64::from(*t_ptr.add(byte_index + channel));
                        current_sums[channel] += u64::from(*c_ptr.add(byte_index + channel));
                    }
                    byte_index += BYTES_PER_PIXEL;
                }
            }
        }
        (target_sums, current_sums)
    }

    /// Chunks of 16 bytes whose squared differences are summed in 32-bit
    /// lanes before widening: each chunk adds at most `4 * 255²` to a lane,
    /// and `4096 * 4 * 65_025 < 2^32`.
    const SQUARES_PER_BLOCK: usize = 4096;

    /// Sum of squared differences of every pair of bytes; matches
    /// [`scalar::difference_full_raw_pixels`]. Every byte of an RGB buffer
    /// is a colour channel, so plain 16-byte loads need no deinterleaving.
    ///
    /// # Panics
    ///
    /// Panics if the slices have different lengths.
    pub(super) fn difference_bytes(a_pix: &[u8], b_pix: &[u8]) -> u64 {
        assert_eq!(a_pix.len(), b_pix.len(), "byte slices of different lengths");
        let mut chunks = a_pix.len() / 16;
        let chunk_bytes = chunks * 16;
        let mut total = 0_u64;
        let mut byte_index = 0_usize;

        while chunks > 0 {
            let block = chunks.min(SQUARES_PER_BLOCK);
            chunks -= block;
            // SAFETY: each `vld1q_u8` reads 16 bytes from `byte_index`, and
            // the loops read `a_pix.len() / 16` chunks in total from 0, so
            // every read ends at or below `chunk_bytes <= a_pix.len()`, and
            // `b_pix` has the same length (asserted above). The remaining
            // calls are register-only NEON operations; NEON is a baseline
            // aarch64 feature.
            unsafe {
                let mut acc = vdupq_n_u32(0);
                for _ in 0..block {
                    let lhs = vld1q_u8(a_pix.as_ptr().add(byte_index));
                    let rhs = vld1q_u8(b_pix.as_ptr().add(byte_index));
                    let diff = vabdq_u8(lhs, rhs);
                    let low = vmull_u8(vget_low_u8(diff), vget_low_u8(diff));
                    let high = vmull_high_u8(diff, diff);
                    acc = vpadalq_u16(acc, low);
                    acc = vpadalq_u16(acc, high);
                    byte_index += 16;
                }
                total += vaddlvq_u32(acc);
            }
        }

        total + scalar::difference_full_raw_pixels(&a_pix[chunk_bytes..], &b_pix[chunk_bytes..])
    }

    /// The squared channel differences between the target and the canvas
    /// blended with `blend`; matches [`scalar::line_after`].
    ///
    /// # Safety
    ///
    /// `start + pixels * 3` must not exceed `t_pix.len()` or `c_pix.len()`.
    #[inline]
    pub(super) unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        let LineBlend { keep, terms } = blend;
        let [sr, sg, sb] = terms;
        let mut total = 0_u64;
        let mut byte_index = start;

        for _ in 0..pixels / 8 {
            // SAFETY: each `vld3_u8` reads 8 pixels (24 bytes) from
            // `byte_index`; the loop reads `pixels / 8` chunks from `start`,
            // which end at or below `start + pixels * 3`, within both slices
            // by the caller's contract. The remaining calls are
            // register-only NEON operations; NEON is a baseline aarch64
            // feature.
            unsafe {
                let t = vld3_u8(t_pix.as_ptr().add(byte_index));
                let c = vld3_u8(c_pix.as_ptr().add(byte_index));
                total += sum_squared_diff_u8x8(t.0, blend_vector_u8x8(c.0, sr, keep));
                total += sum_squared_diff_u8x8(t.1, blend_vector_u8x8(c.1, sg, keep));
                total += sum_squared_diff_u8x8(t.2, blend_vector_u8x8(c.2, sb, keep));
            }
            byte_index += CHUNK_BYTES;
        }

        // As in `line_sums`: a masked 8-pixel chunk for three or more tail
        // pixels when the buffers extend that far, scalar otherwise.
        let tail = pixels % 8;
        if tail > 2 && byte_index + CHUNK_BYTES <= t_pix.len().min(c_pix.len()) {
            // SAFETY: `vld3_u8` reads 24 bytes from `byte_index`, within
            // both slices by the check above. Lanes past the line take the
            // target's value, so they add nothing. The remaining calls are
            // register-only NEON operations.
            unsafe {
                let mask = tail_mask(tail);
                let t = vld3_u8(t_pix.as_ptr().add(byte_index));
                let c = vld3_u8(c_pix.as_ptr().add(byte_index));
                let after_r = vbsl_u8(mask, blend_vector_u8x8(c.0, sr, keep), t.0);
                let after_g = vbsl_u8(mask, blend_vector_u8x8(c.1, sg, keep), t.1);
                let after_b = vbsl_u8(mask, blend_vector_u8x8(c.2, sb, keep), t.2);
                total += sum_squared_diff_u8x8(t.0, after_r);
                total += sum_squared_diff_u8x8(t.1, after_g);
                total += sum_squared_diff_u8x8(t.2, after_b);
            }
        } else {
            for _ in 0..tail {
                for (channel, &term) in terms.iter().enumerate() {
                    // SAFETY: the tail reads the last `tail` pixels of the
                    // line, which end at `start + pixels * 3`, within both
                    // slices by the caller's contract.
                    let (t, c) = unsafe {
                        (
                            *t_pix.as_ptr().add(byte_index + channel),
                            *c_pix.as_ptr().add(byte_index + channel),
                        )
                    };
                    let d = u32::from(t.abs_diff(blend_channel_scalar(c, term, keep)));
                    total += u64::from(d * d);
                }
                byte_index += BYTES_PER_PIXEL;
            }
        }

        total
    }
}

/// The WebAssembly SIMD kernel [`Simd128`] runs, `line_after`, on 16 pixels
/// (three 16-byte vectors) at a time. WebAssembly has no deinterleaving
/// load, so the kernel keeps the RGB bytes interleaved: a block of 48 bytes starts on a pixel, so the channel
/// of every byte lane is fixed, and the per-channel constants are laid out
/// to match.
///
/// Every operation is exact integer arithmetic; each accumulator's bound is
/// proved where it is declared.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod simd128 {
    use super::{BYTES_PER_PIXEL, LineBlend, scalar};
    use core::arch::wasm32::*;

    /// Bytes in a block of 16 RGB pixels, three vectors.
    const BLOCK_BYTES: usize = 16 * BYTES_PER_PIXEL;

    /// The byte offsets of the lanes of a block's three vectors.
    const BYTE_OFFSETS: [v128; 3] = [
        u8x16(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
        u8x16(
            16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
        ),
        u8x16(
            32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
        ),
    ];

    /// Loads the block of 48 bytes at `ptr`.
    ///
    /// # Safety
    ///
    /// `ptr` must be valid for reads of 48 bytes. `v128_load` has no
    /// alignment requirement.
    #[inline]
    unsafe fn load_block(ptr: *const u8) -> [v128; 3] {
        // SAFETY: the three loads read `ptr..ptr + 48`, valid by the
        // caller's contract.
        unsafe {
            [
                v128_load(ptr.cast()),
                v128_load(ptr.add(16).cast()),
                v128_load(ptr.add(32).cast()),
            ]
        }
    }

    /// All ones in the byte lanes of a block below `bytes`, zero in the
    /// others.
    #[inline]
    fn block_mask(bytes: usize) -> [v128; 3] {
        debug_assert!(bytes < BLOCK_BYTES, "a tail is shorter than a block");
        let limit = u8x16_splat(bytes as u8);
        BYTE_OFFSETS.map(|offsets| u8x16_lt(offsets, limit))
    }

    /// The sum of the four 32-bit lanes of `lanes`, read as unsigned.
    #[inline]
    fn sum_u32x4(lanes: v128) -> u64 {
        u64::from(u32x4_extract_lane::<0>(lanes))
            + u64::from(u32x4_extract_lane::<1>(lanes))
            + u64::from(u32x4_extract_lane::<2>(lanes))
            + u64::from(u32x4_extract_lane::<3>(lanes))
    }

    /// `value / M` per 32-bit lane, as [`super::div_by_m`], exact for every
    /// lane below `M · (M + 1)`.
    #[inline]
    fn div_by_m_u32x4(value: v128) -> v128 {
        let adjusted = u32x4_add(u32x4_add(value, u32x4_splat(1)), u32x4_shr(value, 16));
        u32x4_shr(adjusted, 16)
    }

    /// [`super::blend_channel_scalar`] on the eight 16-bit lanes of `current`, with
    /// `keep` in every 16-bit lane and each lane's term in the 32-bit lanes
    /// of `terms_low` (lanes 0–3) and `terms_high` (lanes 4–7); the blended
    /// values in 16-bit lanes.
    ///
    /// `keep = M − k` fits in 16 bits, so the widening products are exact,
    /// and `current · keep + term < 256 · M` (`BLEND_VALUE_BOUND`), where the
    /// division is exact; the quotients fit in a byte, so the saturating
    /// narrowing from signed 32-bit lanes keeps them unchanged.
    #[inline]
    fn blend_u16x8(current: v128, keep: v128, terms_low: v128, terms_high: v128) -> v128 {
        let low = u32x4_add(u32x4_extmul_low_u16x8(current, keep), terms_low);
        let high = u32x4_add(u32x4_extmul_high_u16x8(current, keep), terms_high);
        u16x8_narrow_i32x4(div_by_m_u32x4(low), div_by_m_u32x4(high))
    }

    /// [`super::blend_channel_scalar`] on 8 values with one `term` and `keep`.
    #[cfg(test)]
    pub(super) fn blend_chunk_u8x8(current: [u8; 8], term: u32, keep: u32) -> [u8; 8] {
        let current = u16x8(
            current[0].into(),
            current[1].into(),
            current[2].into(),
            current[3].into(),
            current[4].into(),
            current[5].into(),
            current[6].into(),
            current[7].into(),
        );
        let terms = u32x4_splat(term);
        let blended = blend_u16x8(current, u16x8_splat(keep as u16), terms, terms);
        let mut out = [0_u16; 8];
        // SAFETY: `v128_store` writes 16 bytes to the local `[u16; 8]`.
        unsafe { v128_store(out.as_mut_ptr().cast(), blended) };
        out.map(|value| value as u8)
    }

    /// Blocks of 16 pixels per flush of the 32-bit lanes of
    /// [`line_after`]: each block adds the squares of 12 channel values,
    /// at most `12 · 255² = 780_300`, to every lane, and the masked tail
    /// adds one block to the last flush, so a flush holds at most 4096
    /// blocks: `4096 · 780_300 < 2^32`.
    const AFTER_BLOCKS_PER_FLUSH: usize = 4096;

    /// The squared differences between the 48 target bytes `t` and the 48
    /// canvas bytes `c` blended with `keep` and `terms`, in 32-bit lanes of
    /// at most `12 · 255²`; lanes outside `mask`, when there is one, add
    /// nothing.
    ///
    /// The 32-bit term lanes follow the bytes in groups of four: group `g`
    /// of the block starts at byte `4g`, whose channel is `4g % 3 = g % 3`,
    /// so it takes `terms[g % 3]`.
    #[inline]
    fn block_after(
        t: [v128; 3],
        c: [v128; 3],
        keep: v128,
        terms: &[v128; 3],
        mask: Option<&[v128; 3]>,
    ) -> v128 {
        let mut lanes = u32x4_splat(0);
        for k in 0..3 {
            let after_low = blend_u16x8(
                u16x8_extend_low_u8x16(c[k]),
                keep,
                terms[(4 * k) % 3],
                terms[(4 * k + 1) % 3],
            );
            let after_high = blend_u16x8(
                u16x8_extend_high_u8x16(c[k]),
                keep,
                terms[(4 * k + 2) % 3],
                terms[(4 * k + 3) % 3],
            );
            let mut low = i16x8_sub(u16x8_extend_low_u8x16(t[k]), after_low);
            let mut high = i16x8_sub(u16x8_extend_high_u8x16(t[k]), after_high);
            if let Some(mask) = mask {
                low = v128_and(low, i16x8_extend_low_i8x16(mask[k]));
                high = v128_and(high, i16x8_extend_high_i8x16(mask[k]));
            }
            lanes = u32x4_add(lanes, i32x4_dot_i16x8(low, low));
            lanes = u32x4_add(lanes, i32x4_dot_i16x8(high, high));
        }
        lanes
    }

    /// The squared channel differences between the target and the canvas
    /// blended with `blend`; matches [`scalar::line_after`].
    ///
    /// # Safety
    ///
    /// `start + pixels * 3` must not exceed `t_pix.len()` or `c_pix.len()`.
    #[inline]
    pub(super) unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        let LineBlend { keep, terms } = blend;
        let [sr, sg, sb] = terms;
        let block_terms = [
            u32x4(sr, sg, sb, sr),
            u32x4(sg, sb, sr, sg),
            u32x4(sb, sr, sg, sb),
        ];
        let keep_lanes = u16x8_splat(keep as u16);
        let mut total = 0_u64;
        let mut lanes = u32x4_splat(0);
        let mut blocks = 0;
        let mut byte_index = start;

        for _ in 0..pixels / 16 {
            // SAFETY: the loop reads `pixels / 16` blocks of 48 bytes from
            // `start`, which end at or below `start + pixels * 3`, within
            // both slices by the caller's contract.
            let (t, c) = unsafe {
                (
                    load_block(t_pix.as_ptr().add(byte_index)),
                    load_block(c_pix.as_ptr().add(byte_index)),
                )
            };
            lanes = u32x4_add(lanes, block_after(t, c, keep_lanes, &block_terms, None));
            byte_index += BLOCK_BYTES;
            blocks += 1;
            if blocks == AFTER_BLOCKS_PER_FLUSH {
                total += sum_u32x4(lanes);
                lanes = u32x4_splat(0);
                blocks = 0;
            }
        }

        // Three or more tail pixels take one block with the bytes past the
        // line masked out, when the buffers extend that far; shorter tails,
        // common at anti-aliased edges, are cheaper in scalar code.
        let tail = pixels % 16;
        if tail > 2 && byte_index + BLOCK_BYTES <= t_pix.len().min(c_pix.len()) {
            let mask = block_mask(tail * BYTES_PER_PIXEL);
            // SAFETY: the block is the 48 bytes from `byte_index`, within
            // both slices by the check above.
            let (t, c) = unsafe {
                (
                    load_block(t_pix.as_ptr().add(byte_index)),
                    load_block(c_pix.as_ptr().add(byte_index)),
                )
            };
            lanes = u32x4_add(
                lanes,
                block_after(t, c, keep_lanes, &block_terms, Some(&mask)),
            );
        } else {
            total += scalar::line_after(t_pix, c_pix, byte_index, tail, blend);
        }

        total + sum_u32x4(lanes)
    }
}

/// The AVX2 kernel [`Avx2`] runs, `line_after`, on 32 pixels (three 32-byte
/// vectors) at a time. As in the simd128 kernel, the RGB bytes stay
/// interleaved: a block of 96 bytes starts on a pixel, so byte `o` of a
/// block always holds channel `o % 3`, and the per-channel constants are
/// laid out to match.
///
/// A block is processed in six halves of 16 bytes, half `h` holding the
/// block's bytes `16h..16h + 16`, each zero-extended to sixteen 16-bit lanes
/// in byte order: lane `e` of half `h` holds byte `16h + e`.
///
/// Every operation is exact integer arithmetic; each accumulator's bound is
/// proved where it is declared. Every function here is compiled with AVX2
/// and may only run on a CPU that has it, which [`Avx2`]'s callers check.
#[cfg(target_arch = "x86_64")]
mod avx2 {
    use super::{BYTES_PER_PIXEL, LineBlend, scalar};
    use core::arch::x86_64::*;

    /// Bytes in a block of 32 RGB pixels, three vectors.
    const BLOCK_BYTES: usize = 32 * BYTES_PER_PIXEL;

    /// Loads the block of 96 bytes at `ptr`.
    ///
    /// # Safety
    ///
    /// `ptr` must be valid for reads of 96 bytes. `_mm256_loadu_si256` has
    /// no alignment requirement.
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn load_block(ptr: *const u8) -> [__m256i; 3] {
        // SAFETY: the three loads read `ptr..ptr + 96`, valid by the
        // caller's contract.
        unsafe {
            [
                _mm256_loadu_si256(ptr.cast()),
                _mm256_loadu_si256(ptr.add(32).cast()),
                _mm256_loadu_si256(ptr.add(64).cast()),
            ]
        }
    }

    /// The six halves of a block, each zero-extended to sixteen 16-bit
    /// lanes: half `2v` is the low 128 bits of vector `v`, half `2v + 1`
    /// the high 128 bits, so half `h` holds the block's bytes
    /// `16h..16h + 16` in order.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn widen_block(block: [__m256i; 3]) -> [__m256i; 6] {
        let [a, b, c] = block;
        [
            _mm256_cvtepu8_epi16(_mm256_castsi256_si128(a)),
            _mm256_cvtepu8_epi16(_mm256_extracti128_si256::<1>(a)),
            _mm256_cvtepu8_epi16(_mm256_castsi256_si128(b)),
            _mm256_cvtepu8_epi16(_mm256_extracti128_si256::<1>(b)),
            _mm256_cvtepu8_epi16(_mm256_castsi256_si128(c)),
            _mm256_cvtepu8_epi16(_mm256_extracti128_si256::<1>(c)),
        ]
    }

    /// All ones in the 16-bit lanes of the six halves whose byte is below
    /// `bytes`, zero in the others: lane `e` of half `h` holds byte
    /// `16h + e`.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn block_mask(bytes: usize) -> [__m256i; 6] {
        debug_assert!(bytes < BLOCK_BYTES, "a tail is shorter than a block");
        // Byte offsets and `bytes` are below 96, so the signed 16-bit
        // comparison is exact.
        let limit = _mm256_set1_epi16(bytes as i16);
        let offsets = _mm256_setr_epi16(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
        let mut mask = [_mm256_setzero_si256(); 6];
        for (half, lanes) in mask.iter_mut().enumerate() {
            let first = _mm256_set1_epi16(16 * half as i16);
            *lanes = _mm256_cmpgt_epi16(limit, _mm256_add_epi16(offsets, first));
        }
        mask
    }

    /// The sum of the eight 32-bit lanes of `lanes`, read as unsigned.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn sum_u32x8(lanes: __m256i) -> u64 {
        // Zero-extending the lanes to 64 bits reads them as unsigned; each
        // 64-bit sum below is under `8 · 2^32`, far from overflowing.
        let wide = _mm256_add_epi64(
            _mm256_cvtepu32_epi64(_mm256_castsi256_si128(lanes)),
            _mm256_cvtepu32_epi64(_mm256_extracti128_si256::<1>(lanes)),
        );
        let pair = _mm_add_epi64(
            _mm256_castsi256_si128(wide),
            _mm256_extracti128_si256::<1>(wide),
        );
        _mm_cvtsi128_si64(pair) as u64 + _mm_extract_epi64::<1>(pair) as u64
    }

    /// `value / M` per 32-bit lane, as [`super::div_by_m`], exact for every
    /// lane below `M · (M + 1)`; the logical shifts read the lanes as
    /// unsigned, and `value + 1 + (value >> 16)` stays below `2^32`.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn div_by_m_u32x8(value: __m256i) -> __m256i {
        let adjusted = _mm256_add_epi32(
            _mm256_add_epi32(value, _mm256_set1_epi32(1)),
            _mm256_srli_epi32::<16>(value),
        );
        _mm256_srli_epi32::<16>(adjusted)
    }

    /// `keep` laid out for [`blend_u16x16`]: with `keep = 256 · kh + kl`
    /// (`kh, kl <= 255`, since `keep = M − k <= M`), every 32-bit lane holds
    /// the 16-bit pair `(128 · kh, kl)`, low half first.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn keep_lanes(keep: u32) -> __m256i {
        debug_assert!(keep <= super::M, "keep {keep} out of range");
        let (high, low) = (keep >> 8, keep & 0xFF);
        // `128 · kh <= 32_640` and `kl <= 255`: both halves are below
        // `2^15`, so the lane is below `2^31` and the cast keeps it.
        _mm256_set1_epi32(((low << 16) | (high << 7)) as i32)
    }

    /// [`super::blend_channel_scalar`] on the sixteen 16-bit lanes of
    /// `current`, with `keep` laid out by [`keep_lanes`]; the blended values
    /// in 16-bit lanes, in the order of `current`.
    ///
    /// The 32-bit products come from `_mm256_madd_epi16`, which multiplies
    /// signed 16-bit pairs and adds each pair's two products into a 32-bit
    /// lane. With `c = current <= 255` and `keep = 256 · kh + kl`,
    /// `c · keep = (2c) · (128 · kh) + c · kl`, so the pairs `(2c, c)` against
    /// `(128 · kh, kl)` give the product. Every operand fits a signed 16-bit
    /// lane (`2c <= 510`, `128 · kh <= 32_640`, `c <= 255`, `kl <= 255`),
    /// both products are non-negative, and their sum is at most
    /// `255 · 65_535 = 16_711_425 < 2^31`, so the madd is exact; adding the
    /// term keeps it exact, since `c · keep + term < 256 · M`
    /// (`BLEND_VALUE_BOUND`). This beats the plainer `_mm256_mullo_epi16` and
    /// `_mm256_mulhi_epu16` of `c` and `keep`: LLVM turns that `mulhi` of
    /// zero-extended bytes, in the block loop, into 32-bit extensions, two
    /// multiplies, a pack and a lane-crossing permute; the madd costs the
    /// same add, two unpacks and two multiplies and is left as written. Plain
    /// 32-bit lanes and `_mm256_mullo_epi32` would be two micro-ops with
    /// twice the latency on most x86 cores.
    ///
    /// The pairs `(2c, c)` come from unpacking `c + c` with `c`, which
    /// interleaves within each 128-bit lane: `_mm256_unpacklo_epi16` gives
    /// the pairs of lanes 0–3 and 8–11 of `current`, in that order, and
    /// `_mm256_unpackhi_epi16` those of lanes 4–7 and 12–15. So the 32-bit
    /// lanes of `terms_low` hold the terms of lanes 0–3 and 8–11 and those of
    /// `terms_high` the terms of lanes 4–7 and 12–15.
    ///
    /// `_mm256_packus_epi32(low, high)` packs the four low then the four high
    /// quotients of each 128-bit lane, which restores the order 0–15; it
    /// saturates signed 32-bit lanes to unsigned 16 bits, which leaves the
    /// quotients unchanged since every one is below 256.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn blend_u16x16(
        current: __m256i,
        keep: __m256i,
        terms_low: __m256i,
        terms_high: __m256i,
    ) -> __m256i {
        let doubled = _mm256_add_epi16(current, current);
        let low = _mm256_add_epi32(
            _mm256_madd_epi16(_mm256_unpacklo_epi16(doubled, current), keep),
            terms_low,
        );
        let high = _mm256_add_epi32(
            _mm256_madd_epi16(_mm256_unpackhi_epi16(doubled, current), keep),
            terms_high,
        );
        _mm256_packus_epi32(div_by_m_u32x8(low), div_by_m_u32x8(high))
    }

    /// [`super::blend_channel_scalar`] on 8 values with one `term` and
    /// `keep`, through the kernel's blend, which blends them in both 128-bit
    /// lanes.
    ///
    /// # Panics
    ///
    /// Panics if the CPU lacks AVX2, or if the two 128-bit lanes disagree.
    #[cfg(test)]
    pub(super) fn blend_chunk_u8x8(current: [u8; 8], term: u32, keep: u32) -> [u8; 8] {
        assert!(
            std::arch::is_x86_feature_detected!("avx2"),
            "the AVX2 blend needs a CPU with AVX2"
        );
        // SAFETY: the CPU supports AVX2 (asserted above).
        let out = unsafe { blend_chunk_u16x16(current, term, keep) };
        assert_eq!(out[..8], out[8..], "both 128-bit lanes blend alike");
        std::array::from_fn(|lane| out[lane] as u8)
    }

    /// [`blend_u16x16`] on `current` twice, with one `term` and `keep`.
    #[cfg(test)]
    #[target_feature(enable = "avx2")]
    fn blend_chunk_u16x16(current: [u8; 8], term: u32, keep: u32) -> [u16; 16] {
        let [c0, c1, c2, c3, c4, c5, c6, c7] = current.map(i16::from);
        let current = _mm256_setr_epi16(
            c0, c1, c2, c3, c4, c5, c6, c7, c0, c1, c2, c3, c4, c5, c6, c7,
        );
        // `term < 256 · M < 2^31`: the cast keeps the value.
        let terms = _mm256_set1_epi32(term as i32);
        let blended = blend_u16x16(current, keep_lanes(keep), terms, terms);
        let mut out = [0_u16; 16];
        // SAFETY: `_mm256_storeu_si256` writes 32 bytes, unaligned, to the
        // local `[u16; 16]`.
        unsafe { _mm256_storeu_si256(out.as_mut_ptr().cast(), blended) };
        out
    }

    /// Blocks of 32 pixels per flush of the 32-bit lanes of [`line_after`]:
    /// [`block_after`] adds six `_mm256_madd_epi16` results, each the sum of
    /// two squares, to the same eight lanes, so each block adds the squares
    /// of 12 channel values, at most `12 · 255² = 780_300`, to every lane.
    /// The masked tail adds one block to the last flush, so a flush holds at
    /// most 4096 blocks: `4096 · 780_300 = 3_196_108_800 < 2^32`. (The
    /// bound is 5504 blocks: `5504 · 780_300 < 2^32 < 5505 · 780_300`.)
    const AFTER_BLOCKS_PER_FLUSH: usize = 4096;

    /// The squared differences between the 96 target bytes `t` and the 96
    /// canvas bytes `c` blended with `keep` and `terms`, in 32-bit lanes of
    /// at most `12 · 255²`; bytes outside `mask`, when there is one, add
    /// nothing.
    ///
    /// The terms follow the products of [`blend_u16x16`]: in half `h`, the
    /// low products hold lanes 0–3 and 8–11, whose bytes `16h + e` have
    /// channel `(16h + e) % 3 = (h + e) % 3`, since `16 % 3 = 1`. With
    /// `e = 0, 1, 2, 3, 8, 9, 10, 11` that is channel `(h + r) % 3` for
    /// `r = 0, 1, 2, 0, 2, 0, 1, 2`, the lanes of `terms[h % 3]` (see
    /// [`line_after`]). The high products hold lanes `e + 4`, one channel
    /// further on (`4 % 3 = 1`), so they take `terms[(h + 1) % 3]`.
    #[target_feature(enable = "avx2")]
    #[inline]
    fn block_after(
        t: [__m256i; 3],
        c: [__m256i; 3],
        keep: __m256i,
        terms: &[__m256i; 3],
        mask: Option<&[__m256i; 6]>,
    ) -> __m256i {
        let (t, c) = (widen_block(t), widen_block(c));
        let mut lanes = _mm256_setzero_si256();
        for half in 0..6 {
            let after = blend_u16x16(c[half], keep, terms[half % 3], terms[(half + 1) % 3]);
            // Both operands are in `0..=255`, so the 16-bit difference is
            // exact, and `_mm256_madd_epi16` sums the squares of two of them
            // per 32-bit lane: at most `2 · 255² = 130_050`.
            let mut difference = _mm256_sub_epi16(t[half], after);
            if let Some(mask) = mask {
                difference = _mm256_and_si256(difference, mask[half]);
            }
            lanes = _mm256_add_epi32(lanes, _mm256_madd_epi16(difference, difference));
        }
        lanes
    }

    /// The squared channel differences between the target and the canvas
    /// blended with `blend`; matches [`scalar::line_after`].
    ///
    /// # Safety
    ///
    /// `start + pixels * 3` must not exceed `t_pix.len()` or `c_pix.len()`,
    /// and the CPU must support AVX2.
    #[target_feature(enable = "avx2")]
    #[inline]
    pub(super) unsafe fn line_after(
        t_pix: &[u8],
        c_pix: &[u8],
        start: usize,
        pixels: usize,
        blend: LineBlend,
    ) -> u64 {
        // Lines of one or two pixels, common at anti-aliased edges, would
        // take the scalar tail below anyway: skip the vector set-up.
        if pixels < 3 {
            return scalar::line_after(t_pix, c_pix, start, pixels, blend);
        }
        let LineBlend { keep, terms } = blend;
        // Every term is below `256 · M < 2^31`, so the casts keep the value.
        let [r, g, b] = terms.map(|term| term as i32);
        // `terms[j]` holds, lane by lane, the term of channel `(j + r) % 3`
        // for `r = 0, 1, 2, 0, 2, 0, 1, 2` (see `block_after`).
        let block_terms = [
            _mm256_setr_epi32(r, g, b, r, b, r, g, b),
            _mm256_setr_epi32(g, b, r, g, r, g, b, r),
            _mm256_setr_epi32(b, r, g, b, g, b, r, g),
        ];
        let keep = keep_lanes(keep);
        let mut total = 0_u64;
        let mut lanes = _mm256_setzero_si256();
        let mut blocks = 0;
        let mut byte_index = start;

        for _ in 0..pixels / 32 {
            // SAFETY: the loop reads `pixels / 32` blocks of 96 bytes from
            // `start`, which end at or below `start + pixels * 3`, within
            // both slices by the caller's contract.
            let (t, c) = unsafe {
                (
                    load_block(t_pix.as_ptr().add(byte_index)),
                    load_block(c_pix.as_ptr().add(byte_index)),
                )
            };
            lanes = _mm256_add_epi32(lanes, block_after(t, c, keep, &block_terms, None));
            byte_index += BLOCK_BYTES;
            blocks += 1;
            if blocks == AFTER_BLOCKS_PER_FLUSH {
                total += sum_u32x8(lanes);
                lanes = _mm256_setzero_si256();
                blocks = 0;
            }
        }

        // Three or more tail pixels take one block with the bytes past the
        // line masked out, when the buffers extend that far; shorter tails,
        // and tails too close to the end of the buffers, take scalar code.
        let tail = pixels % 32;
        if tail > 2 && byte_index + BLOCK_BYTES <= t_pix.len().min(c_pix.len()) {
            let mask = block_mask(tail * BYTES_PER_PIXEL);
            // SAFETY: the block is the 96 bytes from `byte_index`, within
            // both slices by the check above.
            let (t, c) = unsafe {
                (
                    load_block(t_pix.as_ptr().add(byte_index)),
                    load_block(c_pix.as_ptr().add(byte_index)),
                )
            };
            lanes = _mm256_add_epi32(lanes, block_after(t, c, keep, &block_terms, Some(&mask)));
        } else {
            total += scalar::line_after(t_pix, c_pix, byte_index, tail, blend);
        }

        total + sum_u32x8(lanes)
    }
}

/// Computes the optimal color for drawing `lines` onto `current` to
/// best approximate `target` at the given `alpha` level, which must be
/// `1..=255`; [`fit`] without prefix sums.
///
/// # Panics
///
/// Panics if `current` and `target` have different dimensions.
#[cfg(test)]
#[must_use]
pub(crate) fn compute_color(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    alpha: i32,
) -> Color {
    fit(target, current, None, lines, alpha).color
}

/// Fits the colour for drawing `lines` onto `current` to best approximate
/// `target` at the given `alpha` level, which must be `1..=255`, and sums
/// the old error of the covered pixels for [`energy`].
///
/// Each pixel is weighted by its scanline's coverage, so anti-aliased edges
/// are fitted as partly covered (see [`ColorFit`]); Go's `primitive` treats
/// them as fully covered, which under-saturates the colour. The colour is
/// a zero [`Color`] if no in-bounds scanline pixel has coverage.
///
/// `sums`, the prefix sums of `target` against `current`, turn each line
/// into two lookups; without them every pixel is read.
///
/// # Panics
///
/// Panics if `current`, `target` and `sums` have different dimensions.
#[must_use]
pub(crate) fn fit(
    target: &Buffer,
    current: &Buffer,
    sums: Option<&PrefixSums>,
    lines: &[Scanline],
    alpha: i32,
) -> Fit {
    fit_with::<Native>(target, current, sums, lines, alpha)
}

/// Asserts the precondition of the SIMD scanline kernels: `current` has
/// `target`'s width and height, so (with the `Buffer` length invariant) any
/// offset inside `target` is inside `current` too.
#[inline]
fn assert_same_dimensions(target: &Buffer, current: &Buffer) {
    assert!(
        target.width() == current.width() && target.height() == current.height(),
        "current must have target's dimensions: target {}x{}, current {}x{}",
        target.width(),
        target.height(),
        current.width(),
        current.height(),
    );
}

/// Copies `src` into `dst` with `c` blended along `lines`, pixel by pixel:
/// the reference the fused [`energy`] is tested against. `dst` must have
/// `src`'s dimensions.
#[cfg(test)]
pub(crate) fn copy_and_draw_lines(dst: &mut Buffer, src: &Buffer, c: Color, lines: &[Scanline]) {
    let w = dst.width() as i32;
    let h = dst.height() as i32;

    // Split borrows: we need immutable access to src and mutable to dst.
    let src_pix = src.pixels();
    let dst_pix = dst.pixels_mut();

    for line in lines {
        let (x1, x2) = match clamp_line(line, w, h) {
            Some(v) => v,
            None => continue,
        };
        let LineBlend { keep, terms } = LineBlend::new(c, line.alpha);
        let mut i = (line.y as usize * w as usize + x1 as usize) * BYTES_PER_PIXEL;
        for _ in x1..=x2 {
            for channel in 0..3 {
                dst_pix[i + channel] =
                    blend_channel_scalar(src_pix[i + channel], terms[channel], keep);
            }
            i += BYTES_PER_PIXEL;
        }
    }
}

/// Blends color `c` onto the existing pixels of `im` along the given scanlines.
pub(crate) fn draw_lines(im: &mut Buffer, c: Color, lines: &[Scanline]) {
    let w = im.width() as i32;
    let h = im.height() as i32;
    let pix = im.pixels_mut();

    for line in lines {
        let (x1, x2) = match clamp_line(line, w, h) {
            Some(v) => v,
            None => continue,
        };
        let LineBlend { keep, terms } = LineBlend::new(c, line.alpha);
        let mut i = (line.y as usize * w as usize + x1 as usize) * BYTES_PER_PIXEL;
        for _ in x1..=x2 {
            for channel in 0..3 {
                pix[i + channel] = blend_channel_scalar(pix[i + channel], terms[channel], keep);
            }
            i += BYTES_PER_PIXEL;
        }
    }
}

/// Computes the sum of squared channel differences between two buffers,
/// the raw form of the score; [`raw_score_to_normalized`] turns it into
/// the RGB RMSE in `[0, 1]`.
///
/// # Panics
///
/// Panics if the two buffers have different dimensions.
#[must_use]
pub(crate) fn difference_full_raw(a: &Buffer, b: &Buffer) -> u64 {
    assert_eq!(a.width(), b.width(), "difference_full: width mismatch");
    assert_eq!(a.height(), b.height(), "difference_full: height mismatch");
    Native::difference_bytes(a.pixels(), b.pixels())
}

/// The normalised RGB RMSE between two buffers, from `0.0` to `1.0`: the
/// [`difference_full_raw`] passed through [`raw_score_to_normalized`].
#[cfg(test)]
#[must_use]
pub(crate) fn difference_full(a: &Buffer, b: &Buffer) -> f64 {
    raw_score_to_normalized(difference_full_raw(a, b), a.width(), a.height())
}

/// The raw score `score` of `before` updated to `after`, which differ only
/// on `lines`: each covered pixel's old error is subtracted and its new
/// error added, per line, in wrapping arithmetic. The pixel-reading
/// reference for [`energy`].
#[cfg(test)]
#[must_use]
pub(crate) fn difference_partial_raw(
    target: &Buffer,
    before: &Buffer,
    after: &Buffer,
    score: u64,
    lines: &[Scanline],
) -> u64 {
    let w = target.width() as i32;
    let h = target.height() as i32;
    let mut total = score;

    let t_pix = target.pixels();
    let b_pix = before.pixels();
    let a_pix = after.pixels();

    for line in lines {
        let (x1, x2) = match clamp_line(line, w, h) {
            Some(v) => v,
            None => continue,
        };
        let start = target.pix_offset(x1, line.y);
        let end = target.pix_offset(x2 + 1, line.y);
        for i in start..end {
            let t = i32::from(t_pix[i]);
            let d1 = t - i32::from(b_pix[i]);
            let d2 = t - i32::from(a_pix[i]);
            total = total.wrapping_sub((d1 * d1) as u64);
            total = total.wrapping_add((d2 * d2) as u64);
        }
    }

    total
}

/// [`difference_partial_raw`] on normalised scores.
#[cfg(test)]
#[must_use]
pub(crate) fn difference_partial(
    target: &Buffer,
    before: &Buffer,
    after: &Buffer,
    score: f64,
    lines: &[Scanline],
) -> f64 {
    let raw = normalized_to_raw_score(score, target.width(), target.height());
    let total = difference_partial_raw(target, before, after, raw, lines);
    raw_score_to_normalized(total, target.width(), target.height())
}

/// The raw score after drawing `lines` with `fit`, which [`fit`] computed
/// for the same buffers and lines.
///
/// It equals `copy_and_draw_lines` followed by `difference_partial_raw`
/// (the test references) without writing any buffer: `score` minus the old
/// error of the covered pixels, from `fit.before`, plus their error after
/// blending, computed on the fly.
///
/// Shape rasterizers emit every pixel at most once, including quadratic
/// strokes, so their covered old error never exceeds the canvas's error.
/// The running total retains wrapping arithmetic for arbitrary scanline
/// sets supplied by internal callers and tests, which may repeat pixels
/// and subtract their old error more than once.
///
/// # Panics
///
/// Panics if `current` and `target` have different dimensions.
#[must_use]
pub(crate) fn energy(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    fit: Fit,
    score: u64,
) -> u64 {
    energy_native(target, current, lines, fit, score, None)
        .expect("an evaluation without a limit runs to the end")
}

/// The [`energy`] if it is below `bound`, `None` otherwise.
///
/// The search only keeps a candidate whose energy is below the best so far,
/// so it passes that energy as the bound, and the evaluation stops as soon
/// as the candidate cannot beat it: once every old error is subtracted, the
/// running total only grows.
///
/// # Panics
///
/// Panics if `current` and `target` have different dimensions.
#[must_use]
pub(crate) fn energy_below(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    fit: Fit,
    score: u64,
    bound: u64,
) -> Option<u64> {
    // A bound beyond `i64::MAX` is never reached by a total that fits in
    // `i64`, so the evaluation runs to the end and the check below decides.
    let limit = i64::try_from(bound).ok();
    energy_native(target, current, lines, fit, score, limit).filter(|&energy| energy < bound)
}

/// [`energy_with`] with this CPU's kernels: [`Native`], or on x86_64 the
/// [`Avx2`] ones when the CPU has AVX2. std caches the detection after the
/// first call: one check per evaluation, outside the loop over its lines.
#[inline]
fn energy_native(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    fit: Fit,
    score: u64,
    limit: Option<i64>,
) -> Option<u64> {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: the runtime check establishes that the CPU supports AVX2.
        return unsafe { energy_avx2(target, current, lines, fit, score, limit) };
    }
    energy_with::<Native>(target, current, lines, fit, score, limit)
}

/// [`energy_with`] with the [`Avx2`] kernels, compiled with AVX2 so that
/// the loop over the lines and `line_after` compile into this one function,
/// with no call per line.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
fn energy_avx2(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    fit: Fit,
    score: u64,
    limit: Option<i64>,
) -> Option<u64> {
    energy_with::<Avx2>(target, current, lines, fit, score, limit)
}

/// [`energy`] for `color` instead of a fit: the old error comes from the
/// pixels.
#[cfg(test)]
#[must_use]
pub(crate) fn energy_from_lines_raw(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    color: Color,
    score: u64,
) -> u64 {
    let before = fit(target, current, None, lines, 255).before;
    energy(target, current, lines, Fit { color, before }, score)
}

/// [`energy_from_lines_raw`] on normalised scores.
#[cfg(test)]
#[must_use]
pub(crate) fn energy_from_lines(
    target: &Buffer,
    current: &Buffer,
    lines: &[Scanline],
    color: Color,
    score: f64,
) -> f64 {
    let raw = normalized_to_raw_score(score, target.width(), target.height());
    let total = energy_from_lines_raw(target, current, lines, color, raw);
    raw_score_to_normalized(total, target.width(), target.height())
}

#[cfg(test)]
mod fixtures {
    use super::M;
    use crate::buffer::Buffer;
    use crate::prefix::PrefixSums;
    use crate::scanline::Scanline;
    use rand::RngExt;
    use rand_chacha::ChaCha8Rng;

    /// Builds prefix sums for `target` against `current`.
    pub(super) fn prefix_sums(target: &Buffer, current: &Buffer) -> PrefixSums {
        let mut sums = PrefixSums::default();
        sums.compute(target, current);
        sums
    }

    /// Canvas sizes around the 8-, 16- and 32-pixel chunks of the SIMD
    /// kernels.
    #[cfg(any(
        target_arch = "aarch64",
        all(target_arch = "wasm32", target_feature = "simd128"),
        target_arch = "x86_64"
    ))]
    pub(super) fn sizes() -> impl Iterator<Item = (u32, u32)> {
        [
            (1, 1),
            (2, 2),
            (7, 3),
            (8, 2),
            (9, 5),
            (15, 4),
            (16, 3),
            (17, 6),
        ]
        .into_iter()
        .chain([
            (23, 7),
            (31, 2),
            (32, 2),
            (33, 9),
            (63, 2),
            (64, 3),
            (65, 4),
        ])
        .chain([(95, 2), (96, 3), (97, 2)])
    }

    pub(super) fn random_buffer(rng: &mut ChaCha8Rng, width: u32, height: u32) -> Buffer {
        let mut buffer = Buffer::new(width, height);
        rng.fill(buffer.pixels_mut());
        buffer
    }

    /// Scanlines of every kind the kernels must handle: full rows touching
    /// both edges, lines sticking out on either side or off the canvas,
    /// lengths around the 8-pixel chunk size, and every coverage extreme.
    pub(super) fn random_lines(rng: &mut ChaCha8Rng, width: i32, height: i32) -> Vec<Scanline> {
        let alpha = |rng: &mut ChaCha8Rng| match rng.random_range(0..4) {
            0 => 0,
            1 => M,
            _ => rng.random_range(0..=M),
        };
        let mut lines = Vec::new();
        for y in -1..=height {
            lines.push(Scanline {
                y,
                x1: -rng.random_range(0..3),
                x2: width - 1 + rng.random_range(0..3),
                alpha: alpha(rng),
            });
        }
        for _ in 0..64 {
            let x1 = rng.random_range(-10..width + 2);
            let len = rng.random_range(0..2 * width + 20);
            lines.push(Scanline {
                y: rng.random_range(-1..=height),
                x1,
                x2: x1 + len - rng.random_range(0..2),
                alpha: alpha(rng),
            });
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::prefix_sums;
    use super::*;
    use crate::buffer::Buffer;
    use crate::color::Color;
    use crate::scanline::Scanline;

    #[test]
    fn before_error_rejection_is_monotone_and_matches_first_energy_exit() {
        for score in [0, 1, 195075, i64::MAX as u64] {
            for before in [0, score / 2, score] {
                for upper in [before, before + (score - before) / 2, score] {
                    for bound in [0, 1, score, i64::MAX as u64, i64::MAX as u64 + 1, u64::MAX] {
                        let limit = i64::try_from(bound).ok();
                        let expected = limit.is_some_and(|limit| {
                            (score as i64).wrapping_sub(before as i64) >= limit
                        });
                        assert_eq!(before_reaches_limit(score, before, limit), expected);
                        if before_reaches_limit(score, upper, limit) {
                            assert!(before_reaches_limit(score, before, limit));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn div_by_m_equivalence() {
        let cases = [
            0,
            1,
            2,
            0xFFFE,
            0xFFFF,
            0x1_0000,
            0x1_0001,
            0x00FF_0000,
            0x00FF_FFFE,
            0x00FF_FFFF,
            0x0100_0000,
            0x7FFF_0000,
            0xFFFD_FFFF,
            0xFFFE_0000,
            0xFFFE_0001,
        ];

        for value in cases {
            assert_eq!(div_by_m(value), value / 0xFFFF, "value={value}");
        }
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn simd_blend_matches_scalar() {
        let mut current = [0_u8; 8];
        for (index, value) in current.iter_mut().enumerate() {
            *value = (index as u8).wrapping_mul(31).wrapping_add(7);
        }

        for source in 0_u8..=255 {
            for alpha in [1_u8, 127, 128, 192, 255] {
                let blend = LineBlend::new(Color::new(source, 0, 0, alpha), M);
                let (term, keep) = (blend.terms[0], blend.keep);

                let simd = neon::blend_chunk_u8x8(current, term, keep);
                for lane in 0..8 {
                    let scalar = blend_channel_scalar(current[lane], term, keep);
                    assert_eq!(simd[lane], scalar, "src={source} alpha={alpha} lane={lane}");
                }
            }
        }
    }

    #[test]
    fn difference_full_identical_is_zero() {
        let buf = Buffer::new(2, 2);
        assert_eq!(difference_full(&buf, &buf), 0.0);
    }

    #[test]
    fn difference_full_identical_nonzero_pixels() {
        let c = Color::new(100, 150, 200, 255);
        let buf = Buffer::new_from_color(4, 4, c);
        assert_eq!(difference_full(&buf, &buf), 0.0);
    }

    #[test]
    fn difference_full_known_value() {
        // 1x1 buffer: a = (255, 0, 0), b = (0, 0, 0)
        let mut a = Buffer::new(1, 1);
        let b = Buffer::new(1, 1);
        a.pixels_mut()[0] = 255;

        // dr=255, dg=0, db=0 => total = 255*255 = 65025
        // sqrt(65025 / 3) / 255 = 1 / sqrt(3)
        let diff = difference_full(&a, &b);
        assert!((diff - 3_f64.sqrt().recip()).abs() < 1e-9, "got {diff}");
    }

    #[test]
    fn difference_full_raw_matches_normalized() {
        let mut a = Buffer::new(2, 1);
        let mut b = Buffer::new(2, 1);

        a.pixels_mut().copy_from_slice(&[255, 32, 0, 10, 20, 30]);
        b.pixels_mut().copy_from_slice(&[0, 16, 64, 40, 50, 60]);

        let raw = difference_full_raw(&a, &b);
        let normalized = difference_full(&a, &b);
        let expected = (raw as f64 / (a.width() as f64 * a.height() as f64 * 3.0)).sqrt() / 255.0;

        assert_eq!(raw, 65025 + 256 + 4096 + 900 + 900 + 900);
        assert!((normalized - expected).abs() < 1e-12);
    }

    /// The normalised score is the RMSE over the three colour channels,
    /// computed here from scratch per pixel; black against white is `1.0`.
    #[test]
    fn normalized_score_is_the_rgb_rmse() {
        use rand::{RngExt, SeedableRng};
        use rand_chacha::ChaCha8Rng;

        let black = Buffer::new_from_color(5, 3, Color::new(0, 0, 0, 255));
        let white = Buffer::new_from_color(5, 3, Color::new(255, 255, 255, 255));
        assert_eq!(difference_full(&black, &white), 1.0);

        let mut rng = ChaCha8Rng::seed_from_u64(0x4b5e);
        for (width, height) in [(2, 2), (7, 5), (33, 9)] {
            let mut a = Buffer::new(width, height);
            let mut b = Buffer::new(width, height);
            rng.fill(a.pixels_mut());
            rng.fill(b.pixels_mut());
            let mut squares = 0.0;
            for y in 0..height as i32 {
                for x in 0..width as i32 {
                    let i = a.pix_offset(x, y);
                    for channel in 0..3 {
                        let d =
                            f64::from(a.pixels()[i + channel]) - f64::from(b.pixels()[i + channel]);
                        squares += d * d;
                    }
                }
            }
            let expected = (squares / f64::from(width * height * 3)).sqrt() / 255.0;
            let actual = difference_full(&a, &b);
            assert!(
                (actual - expected).abs() < 1e-12,
                "{width}x{height}: {actual} vs {expected}"
            );
        }
    }

    #[test]
    fn compute_color_empty_scanlines() {
        let target = Buffer::new(1, 1);
        let current = Buffer::new(1, 1);
        let got = compute_color(&target, &current, &[], 128);
        assert_eq!(got, Color::default());
    }

    #[test]
    fn compute_color_known_values() {
        // target pixel (0,0) = (255, 0, 0), current = (0, 0, 0)
        let mut target = Buffer::new(1, 1);
        target.pixels_mut()[0] = 255;

        let current = Buffer::new(1, 1);
        let lines = [Scanline {
            y: 0,
            x1: 0,
            x2: 0,
            alpha: 0xFFFF,
        }];

        // At alpha 255 and full coverage the weight is 1, so the fit is the
        // target itself.
        let c = compute_color(&target, &current, &lines, 255);
        assert_eq!(c.r, 255);
        assert_eq!(c.g, 0);
        assert_eq!(c.b, 0);
        assert_eq!(c.a, 255);
    }

    /// Every blend is the exact composite rounded once to the 8-bit grid:
    /// `round((1 − w) · c + w · s)` with `w = k / M` the line's
    /// [`blend_weight`], which is `alpha / 255` at full coverage. Checked
    /// for every canvas value at a spread of colours, alphas and coverages.
    #[test]
    fn draw_lines_rounds_the_exact_blend_once() {
        let canvas: Vec<u8> = (0..=255).flat_map(|c| [c, c, c]).collect();
        let coverages = [0, 1, 0x7FFF, 0x8000, 0xA5A5, 0xFFFE, M];
        for alpha in (1..=255).step_by(2) {
            for s in [0_u8, 1, 37, 128, 200, 254, 255] {
                let color = Color::new(s, 255 - s, s / 2, alpha);
                for coverage in coverages {
                    let mut im = Buffer::from_rgb(128, 2, canvas.clone()).expect("buffer");
                    let lines = [0, 1].map(|y| Scanline {
                        y,
                        x1: 0,
                        x2: 127,
                        alpha: coverage,
                    });
                    draw_lines(&mut im, color, &lines);
                    let w = f64::from(blend_weight(i32::from(alpha), coverage)) / f64::from(M);
                    for (x, pixel) in im.pixels().as_chunks::<3>().0.iter().enumerate() {
                        let c = x as f64;
                        for (got, s) in pixel.iter().zip([color.r, color.g, color.b]) {
                            let expected = ((1.0 - w) * c + w * f64::from(s)).round();
                            assert_eq!(
                                f64::from(*got),
                                expected,
                                "c={c} s={s} alpha={alpha} coverage={coverage}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn draw_lines_blends_correctly() {
        // Start with a 4x4 black buffer with opaque alpha
        let mut im = Buffer::new_from_color(4, 4, Color::new(0, 0, 0, 255));
        let c = Color::new(0, 255, 0, 128);
        let lines = [Scanline {
            y: 2,
            x1: 1,
            x2: 2,
            alpha: 0xFFFF,
        }];

        draw_lines(&mut im, c, &lines);

        // Verify the pixels at (1,2) and (2,2) have been blended
        let i1 = im.pix_offset(1, 2);
        let i2 = im.pix_offset(2, 2);

        // Green channel should be non-zero after blending green over black
        assert!(
            im.pixels()[i1 + 1] > 0,
            "green channel at (1,2) should be non-zero"
        );
        assert!(
            im.pixels()[i2 + 1] > 0,
            "green channel at (2,2) should be non-zero"
        );

        // Pixels outside scanline (e.g. (0,0) and (3,2)) should be unchanged
        assert_eq!(im.pixels()[..3], [0, 0, 0]);
        let i3 = im.pix_offset(3, 2);
        assert_eq!(im.pixels()[i3..i3 + 3], [0, 0, 0]);
    }

    #[test]
    fn copy_and_draw_lines_matches_draw_lines() {
        // Replicate the Go test: set up a source buffer, apply both methods,
        // verify they produce identical results.
        let mut src = Buffer::new_from_color(4, 4, Color::new(0, 0, 0, 0));

        // Set specific pixels at (1,2) and (2,2)
        let i1 = src.pix_offset(1, 2);
        let sp = src.pixels_mut();
        sp[i1] = 200;
        sp[i1 + 1] = 100;
        sp[i1 + 2] = 50;
        let i2 = (2 * 4 + 2) * 3; // pix_offset(2, 2) for w=4
        sp[i2] = 10;
        sp[i2 + 1] = 20;
        sp[i2 + 2] = 30;

        let c = Color::new(0, 255, 0, 128);
        let lines = [Scanline {
            y: 2,
            x1: 1,
            x2: 2,
            alpha: 0xFFFF,
        }];

        // Reference: draw_lines on a copy of src
        let mut reference = src.clone();
        draw_lines(&mut reference, c, &lines);

        // Got: copy_and_draw_lines into fresh buffer
        let mut got = Buffer::new(4, 4);
        copy_and_draw_lines(&mut got, &src, c, &lines);

        // Compare the scanline pixels
        for x in 1..=2 {
            let i = got.pix_offset(x, 2);
            assert_eq!(
                &got.pixels()[i..i + 3],
                &reference.pixels()[i..i + 3],
                "pixel ({x}, 2) mismatch"
            );
        }
    }

    #[test]
    fn difference_partial_matches_full_after_drawing() {
        // Port of the Go TestDifferencePartialMatchesFullAfterDrawingLines
        let mut target = Buffer::new(2, 2);
        let current = Buffer::new(2, 2);

        // target pixel (0,0) = bright red
        target.pixels_mut()[0] = 255;

        let before = current.clone();
        let lines = [Scanline {
            y: 0,
            x1: 0,
            x2: 0,
            alpha: 0xFFFF,
        }];

        let color = compute_color(&target, &current, &lines, 255);
        let mut after = current.clone();
        draw_lines(&mut after, color, &lines);

        let base_score = difference_full(&target, &before);
        let partial = difference_partial(&target, &before, &after, base_score, &lines);
        let full = difference_full(&target, &after);

        assert!(
            (partial - full).abs() < 1e-9,
            "partial={partial} full={full}"
        );
    }

    #[test]
    fn difference_partial_no_lines() {
        let target = Buffer::new(2, 2);
        let before = Buffer::new(2, 2);
        let after = Buffer::new(2, 2);
        let score = difference_full(&target, &before);
        let partial = difference_partial(&target, &before, &after, score, &[]);
        assert!((partial - score).abs() < 1e-9);
    }

    #[test]
    fn difference_partial_raw_matches_normalized() {
        let mut target = Buffer::new(2, 2);
        let mut before = Buffer::new(2, 2);
        let tp = target.pixels_mut();
        tp[..6].copy_from_slice(&[255, 0, 0, 20, 40, 60]);
        let bp = before.pixels_mut();
        bp[..6].copy_from_slice(&[0, 0, 0, 80, 60, 40]);

        let lines = [Scanline {
            y: 0,
            x1: 0,
            x2: 1,
            alpha: 0xFFFF,
        }];
        let color = compute_color(&target, &before, &lines, 192);
        let mut after = before.clone();
        draw_lines(&mut after, color, &lines);

        let base_raw = difference_full_raw(&target, &before);
        let partial_raw = difference_partial_raw(&target, &before, &after, base_raw, &lines);
        let partial = difference_partial(
            &target,
            &before,
            &after,
            difference_full(&target, &before),
            &lines,
        );
        let expected =
            (partial_raw as f64 / (target.width() as f64 * target.height() as f64 * 3.0)).sqrt()
                / 255.0;

        assert_eq!(partial_raw, difference_full_raw(&target, &after));
        assert!((partial - expected).abs() < 1e-12);
    }

    /// With full coverage every pixel has the same weight `w = alpha / 255`,
    /// so the fit is the plain least-squares colour
    /// `s = 255 · Σ(t − c) / (alpha · n) + Σc / n`, rounded and clamped.
    #[test]
    fn compute_color_full_coverage_is_the_unweighted_fit() {
        let mut target = Buffer::new(2, 1);
        target
            .pixels_mut()
            .copy_from_slice(&[200, 100, 50, 120, 180, 90]);
        let current = Buffer::new_from_color(2, 1, Color::new(40, 40, 40, 255));
        let lines = [full_row(0, 2)];

        // r: 255 · 240 / 384 + 40 = 199.375; g: 255 · 200 / 384 + 40 = 172.81;
        // b: 255 · 60 / 384 + 40 = 79.84.
        let c = compute_color(&target, &current, &lines, 192);
        assert_eq!(c, Color::new(199, 173, 80, 192));

        // r: 255 · 240 / 256 + 40 = 279.06 is clamped to 255; g: 255 · 200 /
        // 256 + 40 = 239.22; b: 255 · 60 / 256 + 40 = 99.77.
        let c = compute_color(&target, &current, &lines, 128);
        assert_eq!(c, Color::new(255, 239, 100, 128));
    }

    /// Batches that reach `BATCH_PIXELS` flush to the `i128` totals, and a
    /// line longer than a batch goes straight to them; either way the fit
    /// equals the formula evaluated in `i128` throughout.
    #[test]
    fn color_fit_batches_match_the_exact_formula() {
        use rand::{RngExt, SeedableRng};
        use rand_chacha::ChaCha8Rng;

        let mut rng = ChaCha8Rng::seed_from_u64(0xba7c);
        for case in 0..200 {
            let mut fit = ColorFit::new();
            let mut differences = [0_i128; 3];
            let mut currents = [0_i128; 3];
            let mut weights = 0_i128;
            for _ in 0..rng.random_range(1..12) {
                let pixels: u64 = match rng.random_range(0..4) {
                    0 => rng.random_range(1..=16),
                    1 => ColorFit::BATCH_PIXELS - rng.random_range(1..=2),
                    2 => ColorFit::BATCH_PIXELS + rng.random_range(0..=2),
                    _ => rng.random_range(1..=u64::from(u32::MAX)),
                };
                let k = rng.random_range(1..=M);
                let target: [u64; 3] = std::array::from_fn(|_| rng.random_range(0..=255 * pixels));
                let current: [u64; 3] = std::array::from_fn(|_| rng.random_range(0..=255 * pixels));
                fit.add_line(k, pixels as usize, target, current);
                let k = i128::from(k);
                for channel in 0..3 {
                    let (t, c) = (i128::from(target[channel]), i128::from(current[channel]));
                    differences[channel] += k * (t - c);
                    currents[channel] += k * k * c;
                }
                weights += k * k * i128::from(pixels);
            }
            let expected = std::array::from_fn::<u8, 3, _>(|channel| {
                let numerator = i128::from(M) * differences[channel] + currents[channel];
                ((2 * numerator + weights) / (2 * weights)).clamp(0, 255) as u8
            });
            let color = fit.color(77);
            assert_eq!([color.r, color.g, color.b], expected, "case {case}");
            assert_eq!(color.a, 77);
        }
    }

    /// A pixel covered by half draws half the colour, so matching the
    /// target needs twice the difference: the fit must not treat the
    /// anti-aliased pixel as fully covered (ENG-6).
    #[test]
    fn compute_color_compensates_partial_coverage() {
        let target = Buffer::new_from_color(1, 1, Color::new(100, 60, 20, 255));
        let current = Buffer::new_from_color(1, 1, Color::new(0, 0, 0, 255));
        let lines = [Scanline {
            y: 0,
            x1: 0,
            x2: 0,
            alpha: 0x8000,
        }];

        let c = compute_color(&target, &current, &lines, 255);
        assert_eq!(c, Color::new(200, 120, 40, 255));
    }

    /// Scanlines with zero coverage do not change the canvas, so they must
    /// not pull the fit either; with no weight at all there is nothing to fit.
    #[test]
    fn compute_color_ignores_uncovered_scanlines() {
        let mut target = Buffer::new(2, 1);
        target
            .pixels_mut()
            .copy_from_slice(&[100, 60, 20, 0, 255, 0]);
        let current = Buffer::new_from_color(2, 1, Color::new(0, 0, 0, 255));
        let covered = Scanline {
            y: 0,
            x1: 0,
            x2: 0,
            alpha: 0xFFFF,
        };
        let uncovered = Scanline {
            y: 0,
            x1: 1,
            x2: 1,
            alpha: 0,
        };

        let c = compute_color(&target, &current, &[covered, uncovered], 255);
        assert_eq!(c, Color::new(100, 60, 20, 255));
        let c = compute_color(&target, &current, &[uncovered], 255);
        assert_eq!(c, Color::default());
    }

    /// The fitted channel minimises the squared error of the blend model
    /// `c · (1 − w) + s · w`, `w = (alpha / 255) · (coverage / M)`, over
    /// the 8-bit values: neither neighbour of `s` does better. The test
    /// computes the error in `f64` from scratch, per pixel.
    #[test]
    fn compute_color_minimises_the_weighted_error() {
        use rand::{RngExt, SeedableRng};
        use rand_chacha::ChaCha8Rng;

        let mut rng = ChaCha8Rng::seed_from_u64(0xf17);
        for case in 0..400 {
            let (width, height) = (rng.random_range(1..40), rng.random_range(1..6));
            let mut target = Buffer::new(width, height);
            let mut current = Buffer::new(width, height);
            rng.fill(target.pixels_mut());
            rng.fill(current.pixels_mut());
            let alpha = rng.random_range(1..=255);
            let lines: Vec<Scanline> = (0..rng.random_range(1..8))
                .map(|_| {
                    let x1 = rng.random_range(-2..width as i32);
                    Scanline {
                        y: rng.random_range(-1..=height as i32),
                        x1,
                        x2: x1 + rng.random_range(0..width as i32 + 2),
                        alpha: match rng.random_range(0..4) {
                            0 => M,
                            _ => rng.random_range(0..=M),
                        },
                    }
                })
                .collect();

            let color = compute_color(&target, &current, &lines, alpha);
            // A line has weight when its fixed-point `k` (below) is positive:
            // a tiny coverage at a low alpha rounds to zero and draws nothing.
            let covered = lines.iter().any(|line| {
                alpha as u32 * 0x101 * line.alpha / M > 0
                    && clamp_line(line, width as i32, height as i32).is_some()
            });
            if !covered {
                assert_eq!(color, Color::default(), "case {case}");
                continue;
            }
            assert_eq!(color.a, alpha as u8, "case {case}");
            let fitted = [color.r, color.g, color.b];
            for (channel, &s) in fitted.iter().enumerate() {
                let error = |s: f64| {
                    let mut sum = 0.0;
                    for line in &lines {
                        let Some((x1, x2)) = clamp_line(line, width as i32, height as i32) else {
                            continue;
                        };
                        // `(alpha / 255) · (coverage / M)` in the blend's fixed point.
                        let k = alpha as u32 * 0x101 * line.alpha / M;
                        let w = f64::from(k) / f64::from(M);
                        for x in x1..=x2 {
                            let i = target.pix_offset(x, line.y) + channel;
                            let t = f64::from(target.pixels()[i]);
                            let c = f64::from(current.pixels()[i]);
                            sum += (t - c * (1.0 - w) - s * w).powi(2);
                        }
                    }
                    sum
                };
                let best = error(f64::from(s));
                let tolerance = 1e-9 * (1.0 + best);
                if s > 0 {
                    assert!(best <= error(f64::from(s) - 1.0) + tolerance, "case {case}");
                }
                if s < 255 {
                    assert!(best <= error(f64::from(s) + 1.0) + tolerance, "case {case}");
                }
            }
        }
    }

    #[test]
    fn energy_from_lines_matches_two_pass() {
        // Verify that energy_from_lines produces the same score as
        // copy_and_draw_lines + difference_partial.
        let mut target = Buffer::new(4, 4);
        target.pixels_mut()[..6].copy_from_slice(&[200, 100, 50, 10, 20, 30]);

        let mut current = Buffer::new(4, 4);
        current.pixels_mut()[..3].copy_from_slice(&[50, 60, 70]);

        let lines = [
            Scanline {
                y: 0,
                x1: 0,
                x2: 1,
                alpha: 0xFFFF,
            },
            Scanline {
                y: 1,
                x1: 0,
                x2: 2,
                alpha: 32768,
            },
        ];

        let color = compute_color(&target, &current, &lines, 128);
        let base_score = difference_full(&target, &current);

        // Two-pass reference:
        let mut scratch = Buffer::new(4, 4);
        copy_and_draw_lines(&mut scratch, &current, color, &lines);
        let two_pass = difference_partial(&target, &current, &scratch, base_score, &lines);

        // Fused single-pass:
        let fused = energy_from_lines(&target, &current, &lines, color, base_score);

        assert!(
            (two_pass - fused).abs() < 1e-12,
            "two_pass={two_pass} fused={fused}"
        );
    }

    #[test]
    fn energy_from_lines_raw_matches_normalized() {
        let mut target = Buffer::new(3, 2);
        let mut current = Buffer::new(3, 2);
        let tp = target.pixels_mut();
        tp[..9].copy_from_slice(&[200, 100, 50, 10, 20, 30, 90, 80, 70]);
        let cp = current.pixels_mut();
        cp[..9].copy_from_slice(&[50, 60, 70, 80, 70, 60, 0, 0, 0]);

        let lines = [
            Scanline {
                y: 0,
                x1: 0,
                x2: 2,
                alpha: 0xFFFF,
            },
            Scanline {
                y: 1,
                x1: 1,
                x2: 2,
                alpha: 32768,
            },
        ];

        let color = compute_color(&target, &current, &lines, 160);
        let base_raw = difference_full_raw(&target, &current);
        let raw = energy_from_lines_raw(&target, &current, &lines, color, base_raw);
        let normalized = energy_from_lines(
            &target,
            &current,
            &lines,
            color,
            difference_full(&target, &current),
        );
        let expected =
            (raw as f64 / (target.width() as f64 * target.height() as f64 * 3.0)).sqrt() / 255.0;

        assert_eq!(
            raw,
            difference_full_raw(&target, &{
                let mut after = current.clone();
                draw_lines(&mut after, color, &lines);
                after
            })
        );
        assert!((normalized - expected).abs() < 1e-12);
    }

    /// The fused energy computed pixel by pixel and line by line, as the
    /// kernels did before prefix sums: each line subtracts the old error of
    /// its pixels and adds their error after blending that line alone.
    fn reference_energy(
        target: &Buffer,
        current: &Buffer,
        lines: &[Scanline],
        color: Color,
        score: u64,
    ) -> u64 {
        let (w, h) = (target.width() as i32, target.height() as i32);
        let mut total = score;
        for line in lines {
            let Some((x1, x2)) = clamp_line(line, w, h) else {
                continue;
            };
            let blend = LineBlend::new(color, line.alpha);
            for x in x1..=x2 {
                let i = target.pix_offset(x, line.y);
                for (channel, term) in blend.terms.into_iter().enumerate() {
                    let t = i64::from(target.pixels()[i + channel]);
                    let c = current.pixels()[i + channel];
                    let d1 = t - i64::from(c);
                    let d2 = t - i64::from(blend_channel_scalar(c, term, blend.keep));
                    total = total.wrapping_sub((d1 * d1) as u64);
                    total = total.wrapping_add((d2 * d2) as u64);
                }
            }
        }
        total
    }

    /// The prefix-sum colour fit and energy equal the per-pixel ones, and
    /// the bounded energy is the energy exactly when it is below the bound,
    /// on random buffers and scanlines that stick out, overlap and repeat.
    #[test]
    fn scoring_with_prefix_sums_matches_the_per_pixel_path() {
        use super::fixtures::{random_buffer, random_lines};
        use rand::{RngExt, SeedableRng};
        use rand_chacha::ChaCha8Rng;

        let mut rng = ChaCha8Rng::seed_from_u64(0x9e5);
        for (width, height) in [(1, 1), (2, 2), (9, 5), (17, 6), (33, 9), (65, 4)] {
            let target = random_buffer(&mut rng, width, height);
            let current = random_buffer(&mut rng, width, height);
            let sums = prefix_sums(&target, &current);
            let score = difference_full_raw(&target, &current);
            for alpha in [1, 37, 128, 200, 255] {
                let lines = random_lines(&mut rng, width as i32, height as i32);
                let color = compute_color(&target, &current, &lines, alpha);
                let fit_pixels = fit(&target, &current, None, &lines, alpha);
                let fit_sums = fit(&target, &current, Some(&sums), &lines, alpha);
                assert_eq!(fit_pixels.color, color);
                assert_eq!(fit_sums, fit_pixels);

                let expected = reference_energy(&target, &current, &lines, color, score);
                assert_eq!(
                    energy_from_lines_raw(&target, &current, &lines, color, score),
                    expected
                );
                assert_eq!(energy(&target, &current, &lines, fit_sums, score), expected);
                let bounds = [
                    0,
                    1,
                    expected.wrapping_sub(1),
                    expected,
                    expected.wrapping_add(1),
                    score,
                    u64::MAX,
                    rng.random_range(0..=score),
                ];
                for bound in bounds {
                    assert_eq!(
                        energy_below(&target, &current, &lines, fit_sums, score, bound),
                        (expected < bound).then_some(expected),
                        "{width}x{height} alpha={alpha} bound={bound} energy={expected}"
                    );
                }
            }
        }
    }

    /// A line listed twice subtracts its old error twice, so the running
    /// total dips below zero before the new errors come back in. The bounded
    /// energy must neither stop at the dip nor misread the wrapped result.
    #[test]
    fn energy_below_is_exact_when_repeated_lines_dip_below_zero() {
        let target = Buffer::new_from_color(2, 2, Color::new(255, 255, 255, 255));
        let current = Buffer::new(2, 2);
        let sums = prefix_sums(&target, &current);
        let score = difference_full_raw(&target, &current);
        let line = full_row(0, 2);
        let lines = [line, line, line];
        let shape_fit = fit(&target, &current, Some(&sums), &lines, 255);
        assert_eq!(shape_fit.color, Color::new(255, 255, 255, 255));
        let expected = energy(&target, &current, &lines, shape_fit, score);
        // The row's error is half the score, subtracted three times, and
        // the opaque white shape matches the target, so nothing comes back.
        assert_eq!(expected, (score as i64 - 3 * (score as i64 / 2)) as u64);
        for bound in [0, 1, score, u64::MAX - 1, u64::MAX] {
            assert_eq!(
                energy_below(&target, &current, &lines, shape_fit, score, bound),
                (expected < bound).then_some(expected),
                "bound={bound}"
            );
        }
    }

    #[test]
    #[should_panic(expected = "prefix sums must match the buffers")]
    fn fit_rejects_prefix_sums_of_another_size() {
        let target = Buffer::new(16, 4);
        let sums = prefix_sums(&Buffer::new(16, 5), &Buffer::new(16, 5));
        let _ = fit(&target, &target, Some(&sums), &[full_row(3, 16)], 128);
    }

    fn full_row(y: i32, width: i32) -> Scanline {
        Scanline {
            y,
            x1: 0,
            x2: width - 1,
            alpha: 0xFFFF,
        }
    }

    // A wider `current` keeps every read in bounds even before the check, so
    // these tests never run the out-of-bounds read they guard against.
    #[test]
    #[should_panic(expected = "current must have target's dimensions")]
    fn compute_color_rejects_current_with_other_dimensions() {
        let target = Buffer::new(16, 4);
        let current = Buffer::new(17, 4);
        let _ = compute_color(&target, &current, &[full_row(3, 16)], 128);
    }

    #[test]
    #[should_panic(expected = "current must have target's dimensions")]
    fn energy_from_lines_raw_rejects_current_with_other_dimensions() {
        let target = Buffer::new(16, 4);
        let current = Buffer::new(16, 5);
        let color = Color::new(10, 20, 30, 128);
        let _ = energy_from_lines_raw(&target, &current, &[full_row(3, 16)], color, 0);
    }

    /// The blend computes `v = current · keep + term`, largest for
    /// `current = 255` and a white colour; check the documented bound
    /// `v < 256 · M`, so `v / M` fits in a byte, for every colour alpha and
    /// every coverage.
    #[test]
    fn blend_value_stays_below_the_overflow_bound() {
        for alpha in 1_u8..=255 {
            for coverage in 0..=M {
                let blend = LineBlend::new(Color::new(255, 255, 255, alpha), coverage);
                let value = 255 * u64::from(blend.keep) + u64::from(blend.terms[0]);
                assert!(
                    value < u64::from(BLEND_VALUE_BOUND),
                    "alpha={alpha} coverage={coverage} value={value}"
                );
            }
        }
    }

    /// `div_by_m(v) == v / M` for every `v < M * (M + 1)`: checked at both
    /// ends of every quotient's range, where an off-by-one would show.
    #[test]
    fn div_by_m_is_exact_below_the_bound() {
        for q in 0..=M {
            for r in [0, 1, q.saturating_sub(1), q.min(M - 1), M - 2, M - 1] {
                let value = q * M + r;
                assert_eq!(div_by_m(value), q, "q={q} r={r}");
            }
        }
    }
}

/// A wasm32 test build without SIMD would compile neither the simd128
/// kernels nor [`simd_parity`], and pass without testing them.
#[cfg(all(test, target_arch = "wasm32"))]
#[test]
#[allow(
    clippy::assertions_on_constants,
    reason = "the constant is the build's target feature, which this test checks"
)]
fn wasm32_builds_enable_simd128() {
    assert!(
        cfg!(target_feature = "simd128"),
        "build wasm32 with -C target-feature=+simd128 (scripts/build-wasm.mjs)"
    );
}

/// The target's SIMD kernels and SIMD module must agree with the scalar ones
/// bit for bit, since release builds run only the SIMD ones: the [`Native`]
/// kernels on aarch64 and wasm32, and on x86_64 the AVX2 kernels, which the
/// energies choose at run time. CI runs these tests with NEON on the macOS
/// arm64 leg and with AVX2 on the ubuntu x86_64 leg, which sets
/// `PRIMEVAL_REQUIRE_AVX2` so that a runner without AVX2 fails instead of
/// skipping them; `node scripts/build-wasm.mjs test-kernels` runs them with
/// simd128 on wasm32-wasip1 under Node. On x86_64, colour fitting and
/// byte-difference tests are omitted because those kernels stay scalar.
#[cfg(all(
    test,
    any(
        target_arch = "aarch64",
        all(target_arch = "wasm32", target_feature = "simd128"),
        target_arch = "x86_64"
    )
))]
mod simd_parity {
    #[cfg(not(target_arch = "x86_64"))]
    use super::fixtures::prefix_sums;
    use super::fixtures::{random_buffer, random_lines, sizes};
    use super::{
        Fit, LineBlend, LineKernels, M, Scalar, blend_channel_scalar, energy, energy_below,
        energy_with, fit_with,
    };
    use crate::buffer::Buffer;
    use crate::color::Color;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    #[cfg(target_arch = "x86_64")]
    use super::avx2 as simd;
    #[cfg(target_arch = "aarch64")]
    use super::neon as simd;
    #[cfg(target_arch = "wasm32")]
    use super::simd128 as simd;

    /// The kernels under test.
    #[cfg(not(target_arch = "x86_64"))]
    type Simd = super::Native;
    #[cfg(target_arch = "x86_64")]
    type Simd = super::Avx2;

    /// Whether the CPU runs [`Simd`]; every test returns early without it.
    /// NEON is baseline on aarch64, and the wasm32 build enables simd128.
    #[cfg(not(target_arch = "x86_64"))]
    fn simd_available() -> bool {
        true
    }

    /// Whether the CPU runs [`Simd`], the AVX2 kernels, whose methods may
    /// only be called when it does; every test returns early without it.
    ///
    /// # Panics
    ///
    /// Panics if the CPU lacks AVX2 and `PRIMEVAL_REQUIRE_AVX2` is set and
    /// not empty, as on CI's x86_64 leg, so that the tests fail there
    /// instead of skipping.
    #[cfg(target_arch = "x86_64")]
    fn simd_available() -> bool {
        if std::arch::is_x86_feature_detected!("avx2") {
            return true;
        }
        let required =
            std::env::var_os("PRIMEVAL_REQUIRE_AVX2").is_some_and(|value| !value.is_empty());
        assert!(
            !required,
            "PRIMEVAL_REQUIRE_AVX2 is set, but this CPU lacks AVX2, so the AVX2 kernels cannot be tested"
        );
        eprintln!(
            "note: this CPU lacks AVX2, so the AVX2 kernel test is skipped \
             (set PRIMEVAL_REQUIRE_AVX2=1 to make that a failure)"
        );
        false
    }

    #[cfg(not(target_arch = "x86_64"))]
    #[test]
    fn compute_color_matches_scalar_for_every_alpha() {
        if !simd_available() {
            return;
        }
        let mut rng = ChaCha8Rng::seed_from_u64(0xc010);
        for (width, height) in sizes() {
            let target = random_buffer(&mut rng, width, height);
            let current = random_buffer(&mut rng, width, height);
            let sums = prefix_sums(&target, &current);
            for alpha in 1..=255 {
                let lines = random_lines(&mut rng, width as i32, height as i32);
                for sums in [None, Some(&sums)] {
                    let expected = fit_with::<Scalar>(&target, &current, sums, &lines, alpha);
                    let actual = fit_with::<Simd>(&target, &current, sums, &lines, alpha);
                    assert_eq!(actual, expected, "{width}x{height} alpha={alpha}");
                }
            }
        }
    }

    /// Lines longer than 128 blocks of 16 pixels, so the NEON line sums
    /// flush their 16-bit lanes at least once mid-line; bright buffers push
    /// every lane towards its overflow bound.
    #[cfg(not(target_arch = "x86_64"))]
    #[test]
    fn compute_color_matches_scalar_on_long_lines() {
        if !simd_available() {
            return;
        }
        let mut rng = ChaCha8Rng::seed_from_u64(0x1086);
        let (width, height) = (2 * 8 * 256 + 13, 3);
        let mut target = Buffer::new_from_color(width, height, Color::new(255, 255, 255, 255));
        let current = random_buffer(&mut rng, width, height);
        rng.fill(&mut target.pixels_mut()[..64]);
        let sums = prefix_sums(&target, &current);
        for alpha in [1, 128, 255] {
            let lines = random_lines(&mut rng, width as i32, height as i32);
            for sums in [None, Some(&sums)] {
                let expected = fit_with::<Scalar>(&target, &current, sums, &lines, alpha);
                let actual = fit_with::<Simd>(&target, &current, sums, &lines, alpha);
                assert_eq!(actual, expected, "alpha={alpha}");
            }
        }
    }

    #[test]
    fn energy_matches_scalar_for_every_alpha() {
        if !simd_available() {
            return;
        }
        let mut rng = ChaCha8Rng::seed_from_u64(0xe4e7);
        for (width, height) in sizes() {
            let target = random_buffer(&mut rng, width, height);
            let current = random_buffer(&mut rng, width, height);
            let score = Scalar::difference_bytes(target.pixels(), current.pixels());
            for alpha in 1..=255 {
                let lines = random_lines(&mut rng, width as i32, height as i32);
                let color = Color::new(rng.random(), rng.random(), rng.random(), alpha);
                let before = fit_with::<Scalar>(&target, &current, None, &lines, 255).before;
                let fit = Fit { color, before };
                let limit = Some(rng.random_range(0..=score as i64));
                for limit in [None, limit] {
                    let expected =
                        energy_with::<Scalar>(&target, &current, &lines, fit, score, limit);
                    let actual = energy_with::<Simd>(&target, &current, &lines, fit, score, limit);
                    assert_eq!(actual, expected, "{width}x{height} {color:?} {limit:?}");
                }
                if [1, 2, 64, 128, 254, 255].contains(&alpha) {
                    let expected =
                        energy_with::<Scalar>(&target, &current, &lines, fit, score, None)
                            .expect("an evaluation without a limit runs to the end");
                    assert_eq!(energy(&target, &current, &lines, fit, score), expected);
                    let random = rng.random_range(0..=2 * score);
                    for bound in [0, expected, expected.saturating_add(1), random, u64::MAX] {
                        let expected = energy_with::<Scalar>(
                            &target,
                            &current,
                            &lines,
                            fit,
                            score,
                            i64::try_from(bound).ok(),
                        )
                        .filter(|&e| e < bound);
                        assert_eq!(
                            energy_below(&target, &current, &lines, fit, score, bound),
                            expected,
                            "{width}x{height} {color:?} {bound}"
                        );
                    }
                }
            }
        }
    }

    /// Every line kernel on every start and length of a few buffers (only
    /// `line_after` on x86_64, where the other kernels are scalar). One
    /// 70-pixel row covers every tail after one and two 32-pixel blocks,
    /// including tails at the buffer end that fall back to scalar code.
    #[test]
    fn line_kernels_match_scalar_on_every_span() {
        if !simd_available() {
            return;
        }
        let mut rng = ChaCha8Rng::seed_from_u64(0x11e5);
        for (width, height) in [(1, 1), (9, 2), (23, 3), (70, 1)] {
            let target = random_buffer(&mut rng, width, height);
            let current = random_buffer(&mut rng, width, height);
            let (t_pix, c_pix) = (target.pixels(), current.pixels());
            let total = (width * height) as usize;
            for first in 0..total {
                for pixels in 0..=total - first {
                    let start = first * 3;
                    let color = Color::new(rng.random(), rng.random(), rng.random(), rng.random());
                    let coverage = rng.random_range(0..=M);
                    let blend = LineBlend::new(color, coverage);
                    // SAFETY: `start + pixels * 3` is at most `total * 3`,
                    // the length of both buffers, and `simd_available`
                    // returned true.
                    unsafe {
                        #[cfg(not(target_arch = "x86_64"))]
                        assert_eq!(
                            Simd::line_sums(t_pix, c_pix, start, pixels),
                            Scalar::line_sums(t_pix, c_pix, start, pixels),
                            "{first} {pixels}"
                        );
                        #[cfg(not(target_arch = "x86_64"))]
                        assert_eq!(
                            Simd::line_error(t_pix, c_pix, start, pixels),
                            Scalar::line_error(t_pix, c_pix, start, pixels),
                            "{first} {pixels}"
                        );
                        assert_eq!(
                            Simd::line_after(t_pix, c_pix, start, pixels, blend),
                            Scalar::line_after(t_pix, c_pix, start, pixels, blend),
                            "{first} {pixels} {color:?} {coverage}"
                        );
                    }
                }
            }
        }
    }

    /// Lines of `2 · 4096 + 1` blocks and a 5-pixel tail, with the blocks of
    /// the `line_after` under test (32 pixels in AVX2, 16 in simd128): both
    /// flush their 32-bit lanes every 4096 blocks, mid-line, and a constant
    /// above their bound (5504 blocks, each adding 12 squares to every lane)
    /// would overflow them within the line; the NEON line sums flush their
    /// 16-bit lanes every 128 blocks of 16 pixels, many times. A white target
    /// over a black canvas, with an opaque black blend, puts every lane at
    /// its overflow bound; [`compute_color_matches_scalar_on_long_lines`]
    /// cannot show a wrong line sum there, since the fitted colour clamps to
    /// white.
    #[test]
    fn line_kernels_match_scalar_past_the_flushes() {
        if !simd_available() {
            return;
        }
        const BLOCK: u32 = if cfg!(target_arch = "x86_64") { 32 } else { 16 };
        let (width, height) = (2 * BLOCK * 4096 + BLOCK + 5, 2);
        let target = Buffer::new_from_color(width, height, Color::new(255, 255, 255, 255));
        let mut current = Buffer::new_from_color(width, height, Color::new(0, 0, 0, 255));
        let (t_pix, c_pix) = (target.pixels(), current.pixels());
        let pixels = width as usize;
        let black = LineBlend::new(Color::new(0, 0, 0, 255), M);
        // SAFETY: the line is the first row of both buffers, and
        // `simd_available` returned true.
        unsafe {
            let white = 255 * u64::from(width);
            assert_eq!(
                Simd::line_sums(t_pix, c_pix, 0, pixels),
                ([white; 3], [0; 3])
            );
            assert_eq!(
                Simd::line_sums(c_pix, t_pix, 0, pixels),
                ([0; 3], [white; 3])
            );
            assert_eq!(
                Simd::line_after(t_pix, c_pix, 0, pixels, black),
                u64::from(width) * 3 * 255 * 255
            );
        }

        let mut rng = ChaCha8Rng::seed_from_u64(0xaf7e);
        rng.fill(current.pixels_mut());
        let c_pix = current.pixels();
        let color = Color::new(rng.random(), rng.random(), rng.random(), rng.random());
        let blend = LineBlend::new(color, rng.random_range(0..=M));
        for (start, pixels) in [(0, pixels), (3, pixels), (0, 2 * pixels)] {
            // SAFETY: `start + pixels * 3` is within the two rows, and
            // `simd_available` returned true.
            unsafe {
                assert_eq!(
                    Simd::line_sums(t_pix, c_pix, start, pixels),
                    Scalar::line_sums(t_pix, c_pix, start, pixels),
                    "{start} {pixels}"
                );
                assert_eq!(
                    Simd::line_after(t_pix, c_pix, start, pixels, blend),
                    Scalar::line_after(t_pix, c_pix, start, pixels, blend),
                    "{start} {pixels} {color:?}"
                );
            }
        }
    }

    #[cfg(not(target_arch = "x86_64"))]
    #[test]
    fn difference_bytes_matches_scalar() {
        if !simd_available() {
            return;
        }
        let mut rng = ChaCha8Rng::seed_from_u64(0xd1ff);
        for (width, height) in sizes() {
            let a = random_buffer(&mut rng, width, height);
            let b = random_buffer(&mut rng, width, height);
            let expected = Scalar::difference_bytes(a.pixels(), b.pixels());
            let actual = Simd::difference_bytes(a.pixels(), b.pixels());
            assert_eq!(actual, expected, "{width}x{height}");
        }
    }

    /// Buffers longer than 4096 16-byte chunks, so the NEON sum flushes its
    /// 32-bit lanes mid-buffer; black against white puts every lane at its
    /// overflow bound.
    #[cfg(not(target_arch = "x86_64"))]
    #[test]
    fn difference_bytes_matches_scalar_on_large_extreme_buffers() {
        if !simd_available() {
            return;
        }
        let (width, height) = (7_301, 9);
        let mut black = Buffer::new_from_color(width, height, Color::new(0, 0, 0, 255));
        let white = Buffer::new_from_color(width, height, Color::new(255, 255, 255, 255));
        let actual = Simd::difference_bytes(black.pixels(), white.pixels());
        assert_eq!(actual, u64::from(width * height) * 3 * 255 * 255);

        let mut rng = ChaCha8Rng::seed_from_u64(0xb16);
        rng.fill(&mut black.pixels_mut()[..4096]);
        let expected = Scalar::difference_bytes(black.pixels(), white.pixels());
        let actual = Simd::difference_bytes(black.pixels(), white.pixels());
        assert_eq!(actual, expected);
    }

    #[test]
    fn blend_matches_scalar_for_every_alpha_and_channel_value() {
        if !simd_available() {
            return;
        }
        let mut rng = ChaCha8Rng::seed_from_u64(0xb1e4);
        for alpha in 1..=255 {
            let color = Color::new(rng.random(), rng.random(), rng.random(), alpha);
            for coverage in [0, 1, M / 2, M - 1, M, rng.random_range(0..=M)] {
                let blend = LineBlend::new(color, coverage);
                let (term, keep) = (blend.terms[0], blend.keep);
                for chunk in 0_u8..32 {
                    let current: [u8; 8] = std::array::from_fn(|lane| chunk * 8 + lane as u8);
                    let simd = simd::blend_chunk_u8x8(current, term, keep);
                    for lane in 0..8 {
                        let expected = blend_channel_scalar(current[lane], term, keep);
                        assert_eq!(
                            simd[lane], expected,
                            "alpha={alpha} coverage={coverage} lane={lane}"
                        );
                    }
                }
            }
        }
    }
}
