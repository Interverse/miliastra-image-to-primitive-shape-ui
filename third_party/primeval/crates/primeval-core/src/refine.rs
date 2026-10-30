//! Refit passes: coordinate descent over the committed shapes.
//!
//! [`crate::Model::step`] is greedy: it paints one shape against the canvas
//! and never revisits it. A refit pass re-optimises every committed shape
//! at its own layer, with every other shape fixed, top layer first.
//!
//! # The layer model
//!
//! The canvas is opaque RGB, and [`score::draw_lines`] blends each pixel of
//! a scanline exactly and rounds once: with `k` the line's
//! [`score::blend_weight`], `w = k / M` and `s` the shape's channel value,
//! one blend is `x ← round((1 − w) · x + w · s)`. The model drops the
//! rounding, whose error has mean zero, so a blend is the affine map
//! `x ← (1 − w) · x + w · s`. A line with `k = 0` leaves its pixels exactly
//! unchanged.
//!
//! The layers above layer `i` therefore act on every pixel as one affine
//! map, `final = A · X_i + B`, where `X_i` is the canvas just after layer `i`,
//! `A` the product of the `(1 − w)` above it and `B` an RGB offset
//! ([`Above`]). With `d` the exact canvas below layer `i` (`X_{i−1}`), a
//! candidate at layer `i` with weight `w` gives, per pixel and channel,
//! `final = T − q + g · s` with `g = A w` and `q = T − B − A (1 − w) d`,
//! so its error is `(q − g · s)²`, and the error with layer `i` removed is
//! `r² = (T − B − A · d)²`. Over the covered pixels the best colour is
//! `s* = Σ g · q / Σ g²` per channel, rounded and clamped to the stored u8,
//! and the candidate's energy is the removed energy `Σ_all r²` plus
//! `Σ_covered (q − g · s)² − r²` ([`Layer::delta`]). Every candidate at a
//! layer shares the removed energy, so the search compares only the second
//! term, which one pass over the covered pixels gives for any colour
//! ([`Sums`]). At the top layer
//! (`A = 1`, `B = 0`) this is exactly the greedy fit of [`score::fit`]. A
//! pixel with `A = 0` has no influence, and a shape without any
//! (`Σ g² = 0`) keeps its colour.
//!
//! The only error of the model is the rounding of the blends between
//! layer `i` and the top, each within half a level and attenuated by the
//! layers above it; the bound is pinned by
//! `layer_model_matches_the_exact_composite`. `A` and `B` are `f32` planes,
//! the canvas below stays the exact u8 canvas, and the sums are `f64`.
//! The target-independent accumulation order is specified by [`Sums`].
//! Groups use NEON on aarch64, baseline SSE2 on x86_64 and simd128 on
//! wasm32; other targets use scalar code. All keep the same per-pixel
//! `f32` operand order, without fused operations or reassociation.
//!
//! # A pass
//!
//! The pass runs top-down, `i = N − 1 … 0`, so `A` and `B` start at `1` and
//! `0` and are folded in incrementally, layer by layer, after each layer is
//! decided. The canvas below layer `i` is the exact u8 canvas of the old
//! layers: a top-down pass has not refitted any layer below `i` yet. The
//! pass renders checkpoints of it at its start, every `interval` layers,
//! and visits the layers in runs of a segment between two checkpoints,
//! each replayed once from its checkpoint into the canvas below each of
//! its layers ([`Replay`], [`replay_plan`]). A pass thus draws every old
//! layer at most twice, once for the checkpoints and once in its run, or a
//! few more times where the memory budget shortens the runs.
//!
//! At each layer the committed shape, evaluated with its current colour, is
//! the bar. [`ROUNDS`] independent hill climbs ([`climb`]) from the
//! committed shape and alpha then search with the fitted colour, as rayon
//! tasks, each on its own [`refine_rng`] stream and on one of the pass's
//! [`climbers`], which every layer reuses. Their moves start at the
//! greedy search's coarse size and adapt to how often they are kept
//! ([`StepScale`]), down to one- and two-pixel moves that polish the
//! shape; a climb stops after [`AGE`] moves in a row are not kept
//! ([`RefineEffort`] holds both). The best climb wins, ties going to the
//! lowest round, and replaces the committed shape only if it is strictly
//! below the bar. The result does not depend on the number of threads or
//! on scheduling.
//! [`crate::Model::refine`] then verifies the pass on the exact canvas and
//! keeps it only if the exact score improved.

mod sums;

use crate::alpha::Alpha;
use crate::buffer::{BYTES_PER_PIXEL, Buffer};
use crate::color::Color;
use crate::model::CommittedShape;
use crate::optimize::climb;
use crate::rng::refine_rng;
use crate::scanline::{Scanline, clamp_line};
use crate::score;
use crate::shapes::Step;
use crate::state::State;
use crate::worker::WorkerCtx;
use rand::Rng;
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use std::ops::Range;

/// Independent hill climbs per layer of a refit pass.
///
/// [`ROUNDS`] and [`AGE`] were first chosen for coarse moves, by mean score
/// gain per refine second with the engine runner (`--shapes
/// any,triangle,rotated-ellipse --steps 100,200 --refine end:1`, Apple M3).
/// At 100 steps, the mean score gain and the refine time as a share of the
/// greedy time were: `R = 16`, `AGE = 100`: 8.1 %, 0.92; `8, 200`: 8.9 %,
/// 1.11; `8, 100`: 7.4 %, 0.51; `8, 50`: 5.5 %, 0.22; `4, 100`: 6.4 %,
/// 0.31; `4, 50`: 4.6 %, 0.15. The gain per second only grows as the budget
/// shrinks (`4, 25`: 2.9 %, 0.07; `2, 50`: 3.6 %, 0.12), and at equal time
/// two cheap passes match one larger one, so there is no best budget:
/// `4, 50` was the most efficient point of the grid `R ∈ {4, 8, 16}`,
/// `AGE ∈ {50, 100, 200}`. Times are shares of the same run's greedy time,
/// which drifted by up to 1.5× from run to run.
///
/// Adapted moves ([`StepScale`]) make each climb longer: a kept fine move
/// restarts the age. [`AGE`] was then halved to keep the refine time of the
/// coarse `4, 50`; see [`StepScale`].
pub(crate) const ROUNDS: u64 = 4;

/// Consecutive non-improving moves after which a refit climb stops; see
/// [`ROUNDS`].
pub(crate) const AGE: usize = 25;

/// The effort of a refit pass: `rounds` independent climbs per layer, each
/// stopping after `age` moves in a row are not kept.
///
/// Every pass runs [`Self::DEFAULT`], [`ROUNDS`] and [`AGE`]. The struct
/// exists for the lab hook `Model::set_refine_effort`, which overrides it
/// to measure the pass with the engine runner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RefineEffort {
    pub(crate) rounds: u64,
    pub(crate) age: usize,
}

impl RefineEffort {
    /// [`ROUNDS`] climbs of [`AGE`].
    pub(crate) const DEFAULT: Self = Self {
        rounds: ROUNDS,
        age: AGE,
    };
}

/// The factor by which a kept move scales a refit climb's moves up; see
/// [`StepScale`].
pub(crate) const SCALE_UP: f64 = 2.0;

/// The factor by which a rejected move scales a refit climb's moves down,
/// `SCALE_UP^(−1/4)`, so that the scale holds still when one move in five
/// is kept; see [`StepScale`].
pub(crate) const SCALE_DOWN: f64 = 0.840_896_415_253_714_5;

/// The smallest scale of a refit climb's moves: `σ` of 1 px for positions
/// and 2° for angles, against the coarse 16 px and 32°; see [`StepScale`].
pub(crate) const MIN_SCALE: f64 = 1.0 / 16.0;

/// The scale of a refit climb's moves ([`Step::Scaled`]), adapted by the
/// 1/5th success rule: a climb starts at the coarse scale, `1`, which a
/// kept move multiplies by [`SCALE_UP`] and a rejected one by
/// [`SCALE_DOWN`], within `MIN_SCALE..=1`. From a committed shape most
/// coarse moves fail, so the scale falls to [`MIN_SCALE`] within 16
/// rejections and the climb polishes with one- and two-pixel moves; a kept
/// move widens it again.
///
/// Chosen with the engine runner (`--refine end:1 --steps 50,100,200`, the
/// default corpus, Apple M3) against coarse moves at `4, 50`, by the change
/// of the median `rmse256` against greedy at 100 and 200 steps. At about
/// the same refine time, `4, 25` with this rule gave, over all rows,
/// −5.6 % and −5.4 % (coarse: −4.7 %, −3.6 %); for `any`, −10.5 % and
/// −10.6 % (−5.7 %, −5.1 %); for `triangle`, −5.5 % and −6.5 % (−2.8 %,
/// −2.9 %). Every kind gained at least as much as with coarse moves;
/// circle, ellipse and `quadratic` gained least. The rule at `4, 50` cost
/// twice the time; alternating coarse moves with fixed fine ones (`σ` of
/// 1.5 px) gained less at every time; `SCALE_UP = 3` and a smallest `σ` of
/// 2 px gained no more.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct StepScale(f64);

impl StepScale {
    /// The scale a climb starts from: the coarse moves' `σ`.
    pub(crate) const START: Self = Self(1.0);

    /// The size of the next move.
    pub(crate) fn step(self) -> Step {
        Step::Scaled(self.0)
    }

    /// Adapts the scale to whether the last move was `kept`.
    pub(crate) fn update(&mut self, kept: bool) {
        let factor = if kept { SCALE_UP } else { SCALE_DOWN };
        self.0 = (self.0 * factor).clamp(MIN_SCALE, 1.0);
    }
}

/// The memory the canvas checkpoints of a pass, and a refit pass's run
/// canvases ([`replay_plan`]), may take, in bytes.
const CHECKPOINT_BUDGET: usize = 64 << 20;

/// [`score::M`] of the fixed-point blend, as a float.
const M: f32 = score::M as f32;

/// One line's blend in the model: `x ← keep · x + paint · s`.
#[derive(Clone, Copy)]
struct Blend {
    keep: f32,
    paint: f32,
}

impl Blend {
    /// The blend of a line of `coverage` at `alpha`, or `None` if the
    /// integer blend leaves the line's pixels unchanged.
    #[inline]
    fn new(alpha: u8, coverage: u32) -> Option<Self> {
        let k = score::blend_weight(i32::from(alpha), coverage);
        (k != 0).then(|| {
            let w = k as f32 / M;
            Self {
                keep: 1.0 - w,
                paint: w,
            }
        })
    }
}

/// The composite of the layers above a layer: `final = A · x + B` per
/// pixel, with `A` the transmittance and `B` the RGB offset.
pub(crate) struct Above {
    width: i32,
    height: i32,
    /// `A`, one per pixel.
    transmittance: Vec<f32>,
    /// `B`, three channels per pixel.
    offset: Vec<f32>,
}

impl Above {
    /// Nothing above: `A = 1` and `B = 0` everywhere.
    pub(crate) fn new(width: u32, height: u32) -> Self {
        let pixels = width as usize * height as usize;
        Self {
            width: width as i32,
            height: height as i32,
            transmittance: vec![1.0; pixels],
            offset: vec![0.0; pixels * BYTES_PER_PIXEL],
        }
    }

    /// Folds a layer drawn along `lines` in `color` in under the layers
    /// already folded: `B ← B + A · paint · s`, `A ← A · keep`.
    pub(crate) fn fold(&mut self, lines: &[Scanline], color: Color) {
        let s = [color.r, color.g, color.b].map(f32::from);
        // The layer's own lines blend in order, so the last one is the
        // outermost map and folds in first.
        for line in lines.iter().rev() {
            let Some((x1, x2)) = clamp_line(line, self.width, self.height) else {
                continue;
            };
            let Some(blend) = Blend::new(color.a, line.alpha) else {
                continue;
            };
            let paint = s.map(|s| blend.paint * s);
            let row = line.y as usize * self.width as usize;
            for p in row + x1 as usize..=row + x2 as usize {
                let a = self.transmittance[p];
                for (offset, paint) in self.offset[3 * p..3 * p + 3].iter_mut().zip(paint) {
                    *offset += a * paint;
                }
                self.transmittance[p] = a * blend.keep;
            }
        }
    }
}

/// One layer of a pass: the target, the exact canvas below the layer and
/// the composite above it.
pub(crate) struct Layer<'a> {
    pub(crate) target: &'a Buffer,
    pub(crate) below: &'a Buffer,
    pub(crate) above: &'a Above,
}

/// Per-pixel f32 residuals, with the model's fixed operand order.
#[inline(always)]
fn residuals(
    t: [u8; 3],
    d: [u8; 3],
    b: [f32; 3],
    a: f32,
    blend: Blend,
) -> (f32, [f32; 3], [f32; 3]) {
    let mut q = [0.0; 3];
    let mut r = [0.0; 3];
    for c in 0..3 {
        let rest = f32::from(t[c]) - b[c];
        let d = f32::from(d[c]);
        q[c] = rest - a * blend.keep * d;
        r[c] = rest - a * d;
    }
    (a * blend.paint, q, r)
}

impl Layer<'_> {
    /// Calls `visit(p, j, g, q, r)` for every pixel `p` of `lines` that the
    /// shape at `alpha` influences, a pixel once per line that covers it,
    /// with `j` counting all clipped pixels, hidden ones included, `g = A w`,
    /// and `q` and `r` per channel; see the module doc.
    #[inline]
    fn visit(
        &self,
        lines: &[Scanline],
        alpha: u8,
        mut visit: impl FnMut(usize, usize, f32, [f32; 3], [f32; 3]),
    ) {
        let above = self.above;
        let (t, d) = (self.target.pixels(), self.below.pixels());
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
            // Clamp once, then slice all four planes to the same span.
            // Each RGB chunk has three channels, so constant channel
            // indices need no checks in the pixel loop.
            let t = t[3 * start..3 * end].as_chunks::<3>().0;
            let d = d[3 * start..3 * end].as_chunks::<3>().0;
            let b = above.offset[3 * start..3 * end].as_chunks::<3>().0;
            let a = &above.transmittance[start..end];
            for (j, (((t, d), b), &a)) in t.iter().zip(d).zip(b).zip(a).enumerate() {
                if a == 0.0 {
                    continue;
                }
                let (g, q, r) = residuals(*t, *d, *b, a, blend);
                visit(start + j, j, g, q, r);
            }
        }
    }

    /// The model's sums over the pixels of `lines` drawn at `alpha`, in
    /// the target-independent four-slot order specified by [`Sums`].
    pub(crate) fn sums(&self, lines: &[Scanline], alpha: u8) -> Sums {
        sums::sums(self, lines, alpha)
    }

    /// The model's best colour for a shape drawn along `lines` at `alpha`,
    /// or `None` if the shape is invisible (`Σ g² = 0`).
    #[cfg(test)]
    fn fit(&self, lines: &[Scanline], alpha: u8) -> Option<[u8; 3]> {
        self.sums(lines, alpha).fit()
    }

    /// The model's energy of the shape drawn along `lines` at `alpha` in
    /// `rgb`, minus the energy with the layer removed:
    /// `Σ_covered (q − g · s)² − r²`.
    #[cfg(test)]
    fn delta(&self, lines: &[Scanline], alpha: u8, rgb: [u8; 3]) -> f64 {
        self.sums(lines, alpha).delta(rgb)
    }

    /// [`Self::delta`] with the fitted colour, and that colour at `alpha`;
    /// an invisible shape keeps `fallback`, and its delta is zero.
    pub(crate) fn evaluate(
        &self,
        lines: &[Scanline],
        alpha: u8,
        fallback: [u8; 3],
    ) -> (f64, Color) {
        self.sums(lines, alpha).evaluate(alpha, fallback)
    }
}

/// What the fit and the energy of a candidate need, summed over its
/// covered pixels in one pass: `Σ g · q` per channel, and `Σ g²`, `Σ q²`
/// and `Σ r²` over the channels. Per channel the energy
/// `Σ (q − g · s)²` is the quadratic `Σ q² − 2 s Σ g · q + s² Σ g²`, so no
/// second pass over the pixels is needed for any colour.
///
/// Six planes use four slots, initially +0.0: clipped pixel j of each line
/// goes to j mod 4, counting hidden pixels, with slot 0 restarted per line.
/// Per-pixel f32 formulas keep their operand order; after exact f64
/// conversion, each slot adds g*g, g*q per channel, (qr*qr + qg*qg) + qb*qb,
/// and (rr*rr + rg*rg) + rb*rb. Slots persist across lines, then each plane
/// folds as (((+0.0 + s0) + s1) + s2) + s3. SIMD and scalar give identical
/// bits; hidden pixels and missing tail slots contribute +0.0.
#[derive(Default)]
pub(crate) struct Sums {
    numerators: [f64; 3],
    weights: f64,
    errors: f64,
    removed: f64,
}

impl Sums {
    /// The fitted colour, or `None` without any weight.
    fn fit(&self) -> Option<[u8; 3]> {
        // The energy is a quadratic in each channel with its minimum at
        // the quotient, so the nearest level in range is the best u8.
        (self.weights > 0.0).then(|| {
            self.numerators
                .map(|numerator| (numerator / self.weights).round().clamp(0.0, 255.0) as u8)
        })
    }

    /// [`Layer::evaluate`] from these sums of a shape drawn at `alpha`.
    fn evaluate(&self, alpha: u8, fallback: [u8; 3]) -> (f64, Color) {
        match self.fit() {
            Some(rgb) => {
                let color = Color::new(rgb[0], rgb[1], rgb[2], alpha);
                (self.delta(rgb), color)
            }
            None => {
                let [r, g, b] = fallback;
                (0.0, Color::new(r, g, b, alpha))
            }
        }
    }

    /// `Σ (q − g · s)² − r²` for the colour `rgb`.
    fn delta(&self, rgb: [u8; 3]) -> f64 {
        let colour: f64 = rgb
            .into_iter()
            .zip(self.numerators)
            .map(|(s, numerator)| {
                let s = f64::from(s);
                s * (s * self.weights - 2.0 * numerator)
            })
            .sum();
        self.errors - self.removed + colour
    }
}

/// Layers between the canvas checkpoints of a pass over `layers` layers on
/// a canvas of `canvas_bytes` bytes: `⌈√layers⌉`, which balances the
/// checkpoints kept against the layers redrawn from one, unless the
/// checkpoints would exceed [`CHECKPOINT_BUDGET`]; then the smallest
/// interval whose checkpoints fit, or a single checkpoint for a canvas
/// larger than the budget.
///
/// The joint optimisation's reverse pass keeps `⌈layers / interval⌉`
/// checkpoints; a refit pass plans its own with [`replay_plan`].
pub(crate) fn checkpoint_interval(layers: usize, canvas_bytes: usize) -> usize {
    let affordable = (CHECKPOINT_BUDGET / canvas_bytes.max(1)).max(1);
    ceil_sqrt(layers).max(layers.div_ceil(affordable)).max(1)
}

/// `⌈√n⌉`.
fn ceil_sqrt(n: usize) -> usize {
    let root = n.isqrt();
    if root * root < n { root + 1 } else { root }
}

/// How a refit pass replays the old layers: the exact canvas before every
/// `interval`-th layer ([`Checkpoints`]), and runs of up to `run` layers,
/// each replayed once from its checkpoint into as many canvases, the
/// canvas below each of its layers ([`Self::runs`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Replay {
    pub(crate) interval: usize,
    pub(crate) run: usize,
}

impl Replay {
    /// The runs of a pass over `layers` layers in the order the pass
    /// visits them, top-down, as `(bottom, top)` for the layers
    /// `bottom..top`: each segment of `interval` layers after a checkpoint,
    /// from its top, in runs of `run` layers.
    pub(crate) fn runs(self, layers: usize) -> impl Iterator<Item = (usize, usize)> {
        let Self { interval, run } = self;
        (0..layers.div_ceil(interval))
            .rev()
            .flat_map(move |segment| {
                let start = segment * interval;
                let end = (start + interval).min(layers);
                (0..(end - start).div_ceil(run)).map(move |k| {
                    let top = end - k * run;
                    (top.saturating_sub(run).max(start), top)
                })
            })
    }
}

/// The [`Replay`] of a pass over `layers` layers on a canvas of
/// `canvas_bytes` bytes.
///
/// The pass keeps `⌈layers / interval⌉` checkpoints and `run` canvases.
/// With runs of whole segments that is fewest at
/// `interval = run = ⌈√layers⌉`, the plan whenever it fits in
/// [`CHECKPOINT_BUDGET`]: every layer is then replayed once per pass.
/// Otherwise the budget is split evenly between checkpoints and runs, which
/// minimises the replay of a segment in shorter runs, each from the
/// segment's checkpoint: `⌈interval / run⌉` replays of up to `interval`
/// layers. A canvas too large for two canvases in the budget gets the
/// smallest plan, one checkpoint and runs of one canvas.
///
/// Its other memory does not grow with the layers: the 16 bytes per pixel
/// of [`Above`].
pub(crate) fn replay_plan(layers: usize, canvas_bytes: usize) -> Replay {
    let affordable = (CHECKPOINT_BUDGET / canvas_bytes.max(1)).max(1);
    let root = ceil_sqrt(layers).max(1);
    if layers.div_ceil(root) + root <= affordable {
        return Replay {
            interval: root,
            run: root,
        };
    }
    let run = (affordable / 2).max(1);
    let checkpoints = affordable.saturating_sub(run).max(1);
    let interval = layers.div_ceil(checkpoints).max(1);
    Replay {
        interval,
        run: run.min(interval),
    }
}

/// The exact canvas before every `interval`-th layer.
struct Checkpoints {
    interval: usize,
    canvases: Vec<Buffer>,
}

impl Checkpoints {
    /// Replays `layers` from a canvas of `background`, keeping the canvas
    /// before every `interval`-th layer.
    fn render<R: Rng>(
        background: &Buffer,
        layers: &[CommittedShape],
        interval: usize,
        scratch: &mut WorkerCtx<R>,
    ) -> Self {
        let mut canvas = background.clone();
        let mut canvases = Vec::with_capacity(layers.len().div_ceil(interval));
        for (index, layer) in layers.iter().enumerate() {
            if index % interval == 0 {
                canvases.push(canvas.clone());
            }
            score::draw_lines(&mut canvas, layer.color, layer.shape.rasterize(scratch));
        }
        Self { interval, canvases }
    }

    /// Writes the exact canvas below each layer of the run `run` of
    /// `layers` into `below`, in order, replaying the layers from the run's
    /// checkpoint once; the run must not cross a checkpoint.
    fn replay<R: Rng>(
        &self,
        layers: &[CommittedShape],
        run: Range<usize>,
        below: &mut [Buffer],
        scratch: &mut WorkerCtx<R>,
    ) {
        let segment = run.start / self.interval;
        let below = &mut below[..run.len()];
        let (first, rest) = below.split_first_mut().expect("a run has a layer");
        first
            .pixels_mut()
            .copy_from_slice(self.canvases[segment].pixels());
        for layer in &layers[segment * self.interval..run.start] {
            score::draw_lines(first, layer.color, layer.shape.rasterize(scratch));
        }
        let mut previous = &*first;
        for (canvas, layer) in rest.iter_mut().zip(&layers[run]) {
            canvas.pixels_mut().copy_from_slice(previous.pixels());
            score::draw_lines(canvas, layer.color, layer.shape.rasterize(scratch));
            previous = canvas;
        }
    }
}

/// The canvas of `background` with every shape of `layers` drawn on it in
/// order, exactly as the model paints them.
pub(crate) fn render<R: Rng>(
    width: u32,
    height: u32,
    background: Color,
    layers: &[CommittedShape],
    scratch: &mut WorkerCtx<R>,
) -> Buffer {
    let mut canvas = Buffer::new_from_color(width, height, background);
    for layer in layers {
        score::draw_lines(&mut canvas, layer.color, layer.shape.rasterize(scratch));
    }
    canvas
}

/// The random streams of one pass, one per layer and climb, and the effort
/// of the climbs that draw from them.
#[derive(Clone, Copy)]
pub(crate) struct Streams {
    pub(crate) seed: u64,
    pub(crate) pass: u64,
    pub(crate) effort: RefineEffort,
}

/// Runs one refit pass over `layers` against `target`, from a canvas of
/// `background`, and returns the refitted layers if any layer changed,
/// with the number of candidate evaluations made.
///
/// `cancelled` is polled before each layer; once it returns true the pass
/// stops and returns `None`.
pub(crate) fn pass<R: Rng>(
    target: &Buffer,
    background: Color,
    layers: &[CommittedShape],
    alpha: Alpha,
    streams: Streams,
    scratch: &mut WorkerCtx<R>,
    cancelled: &mut impl FnMut() -> bool,
) -> Option<(Option<Vec<CommittedShape>>, u64)> {
    let canvas_bytes = target.width() as usize * target.height() as usize * BYTES_PER_PIXEL;
    let replay = replay_plan(layers.len(), canvas_bytes);
    pass_with(
        replay, target, background, layers, alpha, streams, scratch, cancelled,
    )
}

/// [`pass`] with the checkpoints and runs of `replay`, which do not change
/// its result.
#[allow(clippy::too_many_arguments)]
fn pass_with<R: Rng>(
    replay: Replay,
    target: &Buffer,
    background: Color,
    layers: &[CommittedShape],
    alpha: Alpha,
    streams: Streams,
    scratch: &mut WorkerCtx<R>,
    cancelled: &mut impl FnMut() -> bool,
) -> Option<(Option<Vec<CommittedShape>>, u64)> {
    let (width, height) = (target.width(), target.height());
    let canvas = Buffer::new_from_color(width, height, background);
    let checkpoints = Checkpoints::render(&canvas, layers, replay.interval, scratch);
    let mut below = vec![canvas; replay.run];
    let mut above = Above::new(width, height);
    let mut workers = climbers(scratch, streams.effort);
    let mut refitted = layers.to_vec();
    let mut changed = false;
    let mut evaluations = 0;

    for (bottom, top) in replay.runs(layers.len()) {
        checkpoints.replay(layers, bottom..top, &mut below, scratch);
        for index in (bottom..top).rev() {
            if cancelled() {
                return None;
            }
            let layer = Layer {
                target,
                below: &below[index - bottom],
                above: &above,
            };
            let committed = &layers[index];
            let lines = committed.shape.rasterize(scratch);
            let (refit, count) = refine_layer(
                &layer,
                committed,
                lines,
                index,
                alpha,
                streams,
                &mut workers,
            );
            evaluations += count;
            // The climbs run on their own workers, so an unchanged layer
            // folds in from the lines it was rasterized into for its bar.
            match refit {
                Some(refit) => {
                    above.fold(refit.shape.rasterize(scratch), refit.color);
                    refitted[index] = refit;
                    changed = true;
                }
                None => above.fold(lines, committed.color),
            }
        }
    }

    Some((changed.then_some(refitted), evaluations))
}

/// The workers of a pass's climbs, one per climb of `effort`, like
/// `scratch` ([`WorkerCtx::like`]), which every layer of the pass reuses:
/// each climb resets its worker's random stream, and the rest of a worker
/// is scratch space.
fn climbers<R: Rng>(scratch: &WorkerCtx<R>, effort: RefineEffort) -> Vec<WorkerCtx<ChaCha8Rng>> {
    (0..effort.rounds)
        .map(|_| scratch.like(refine_rng(0, 0, 0, 0)))
        .collect()
}

/// Refits layer `index`, `committed`, whose shape rasterizes to `lines`,
/// under `layer`: the replacement if one is strictly below the committed
/// shape in its current colour, and the number of evaluations. Climb
/// `round` runs on `workers[round]` ([`climbers`]).
fn refine_layer(
    layer: &Layer<'_>,
    committed: &CommittedShape,
    lines: &[Scanline],
    index: usize,
    alpha: Alpha,
    streams: Streams,
    workers: &mut [WorkerCtx<ChaCha8Rng>],
) -> (Option<CommittedShape>, u64) {
    let color = committed.color;
    let rgb = [color.r, color.g, color.b];
    // One sum over the committed shape's pixels gives both the bar, in its
    // current colour, and the climbs' start, in its fitted colour.
    let sums = layer.sums(lines, color.a);
    let bar = sums.delta(rgb);
    let start = sums.evaluate(color.a, rgb);
    let state = State::committed(committed.shape.clone(), alpha, color.a);

    let (seed, pass, index) = (streams.seed, streams.pass, index as u64);
    let RefineEffort { rounds, age } = streams.effort;
    debug_assert_eq!(workers.len() as u64, rounds, "one worker per climb");
    let results: Vec<((State, f64, Color), u64)> = workers
        .par_iter_mut()
        .enumerate()
        .map(|(round, worker)| {
            worker.rng = refine_rng(seed, pass, index, round as u64);
            worker.counted(|worker| {
                climb(state.clone(), start, worker, age, |state, worker| {
                    worker.evaluations += 1;
                    let lines = state.shape.rasterize(worker);
                    layer.evaluate(lines, state.alpha, rgb)
                })
            })
        })
        .collect();

    // The bar and the fitted start.
    let mut evaluations = 2;
    let mut best: Option<(State, f64, Color)> = None;
    // `collect` keeps round order, and only a strictly lower energy
    // replaces the best, so ties go to the lowest round.
    for ((state, energy, color), count) in results {
        evaluations += count;
        if best.as_ref().is_none_or(|(_, best, _)| energy < *best) {
            best = Some((state, energy, color));
        }
    }
    let refit = best
        .filter(|(_, energy, _)| *energy < bar)
        .map(|(state, _, color)| CommittedShape {
            shape: state.shape,
            color,
        });
    (refit, evaluations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::create_rng;
    use crate::shapes::{Rectangle, Shape, ShapeKind};
    use crate::test_util::make_test_round;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The largest error of the layer model against the exact composite,
    /// in levels per channel, and the largest mean absolute error of one
    /// predicted image of at least [`Errors::MEAN_VALUES`] values; see
    /// `layer_model_matches_the_exact_composite`. The model is the exact
    /// composite without the per-layer rounding, so both come from the
    /// rounding of the layers above the predicted one. Measured: 1.94 and
    /// 0.35, with and without a candidate, and a mean signed error of
    /// −0.004. The maximum is from quadratic stacks, and rose from 1.70
    /// when their strokes became wider and anti-aliased by area: more of
    /// their pixels are partly covered, and each such layer rounds.
    const MAX_ERROR: f32 = 2.0;
    const MEAN_ERROR: f64 = 0.4;

    /// The largest difference between the model's energy of a top-layer
    /// shape and its exact energy, per covered channel value. Measured:
    /// 39.0 on noise targets, where the errors the model is off by are
    /// largest.
    const TOP_ENERGY_ERROR: f64 = 42.0;

    pub(super) fn noise(rng: &mut ChaCha8Rng, width: u32, height: u32) -> Buffer {
        let mut pixels = vec![0_u8; (width * height * 3) as usize];
        rng.fill(&mut pixels[..]);
        Buffer::from_rgb(width, height, pixels).expect("valid length")
    }

    fn opaque(rng: &mut ChaCha8Rng) -> Color {
        Color::new(rng.random(), rng.random(), rng.random(), 255)
    }

    fn random_layer(
        rng: &mut ChaCha8Rng,
        kind: ShapeKind,
        worker: &mut WorkerCtx<ChaCha8Rng>,
        round: &crate::worker::SearchRound<'_>,
    ) -> CommittedShape {
        let shape = Shape::random(kind, worker, round);
        let alpha = rng.random_range(1..=255);
        let color = Color::new(rng.random(), rng.random(), rng.random(), alpha);
        CommittedShape { shape, color }
    }

    fn random_layers(
        rng: &mut ChaCha8Rng,
        kind: ShapeKind,
        count: usize,
        (width, height): (u32, u32),
    ) -> Vec<CommittedShape> {
        let (mut worker, round) = make_test_round(width, height, rng.random());
        (0..count)
            .map(|_| random_layer(rng, kind, &mut worker, &round))
            .collect()
    }

    /// The exact canvas below layer `index` and the model of the layers
    /// above it.
    fn layer_context(
        target: &Buffer,
        background: Color,
        layers: &[CommittedShape],
        index: usize,
        worker: &mut WorkerCtx<ChaCha8Rng>,
    ) -> (Buffer, Above) {
        let (width, height) = (target.width(), target.height());
        let below = render(width, height, background, &layers[..index], worker);
        let mut above = Above::new(width, height);
        for layer in layers[index + 1..].iter().rev() {
            above.fold(layer.shape.rasterize(worker), layer.color);
        }
        (below, above)
    }

    impl Layer<'_> {
        /// The predicted final image, without the layer or with `candidate`
        /// drawn along `lines` at the layer.
        fn predict(&self, candidate: Option<(&[Scanline], Color)>) -> Vec<f32> {
            let (t, d) = (self.target.pixels(), self.below.pixels());
            let (a, b) = (&self.above.transmittance, &self.above.offset);
            let mut image: Vec<f32> = (0..t.len())
                .map(|i| a[i / 3] * f32::from(d[i]) + b[i])
                .collect();
            if let Some((lines, color)) = candidate {
                let s = [color.r, color.g, color.b].map(f32::from);
                self.visit(lines, color.a, |p, _, g, q, _| {
                    for c in 0..3 {
                        image[3 * p + c] = f32::from(t[3 * p + c]) - q[c] + g * s[c];
                    }
                });
            }
            image
        }

        /// `Σ_all r²`, the model's energy with the layer removed.
        fn removed(&self) -> f64 {
            let t = self.target.pixels();
            self.predict(None)
                .iter()
                .zip(t)
                .map(|(&f, &t)| f64::from(f32::from(t) - f).powi(2))
                .sum()
        }
    }

    /// The largest and the mean absolute error of predictions.
    #[derive(Default, Debug)]
    struct Errors {
        max: f32,
        worst_mean: f64,
        signed: f64,
        values: usize,
    }

    impl Errors {
        /// Images with fewer channel values than this count towards the
        /// largest error only. A 2 × 2 image under shapes that cover all of
        /// it holds 3 independent values, one per channel, so its mean is a
        /// sample of three rounding errors rather than an average.
        const MEAN_VALUES: usize = 300;

        fn add(&mut self, exact: &Buffer, predicted: &[f32]) {
            let mut sum = 0.0;
            for (&e, &p) in exact.pixels().iter().zip(predicted) {
                let error = p - f32::from(e);
                assert!(error.is_finite(), "a prediction is not finite");
                self.max = self.max.max(error.abs());
                sum += f64::from(error.abs());
                self.signed += f64::from(error);
            }
            self.values += predicted.len();
            if predicted.len() >= Self::MEAN_VALUES {
                self.worst_mean = self.worst_mean.max(sum / predicted.len() as f64);
            }
        }
    }

    /// For random stacks of every kind at random alphas, the model's final
    /// image without layer `i` and with a random candidate at layer `i`
    /// stays within the pinned bound of the exact integer composite.
    #[test]
    fn layer_model_matches_the_exact_composite() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x1a7e);
        let (mut without, mut with) = (Errors::default(), Errors::default());
        for &kind in ShapeKind::all_kinds() {
            for (width, height, count) in [(2, 2, 6), (23, 17, 40), (48, 40, 120)] {
                let target = noise(&mut rng, width, height);
                let background = opaque(&mut rng);
                let layers = random_layers(&mut rng, kind, count, (width, height));
                let (mut worker, round) = make_test_round(width, height, rng.random());
                for index in [0, count / 2, count - 1] {
                    let (below, above) =
                        layer_context(&target, background, &layers, index, &mut worker);
                    let layer = Layer {
                        target: &target,
                        below: &below,
                        above: &above,
                    };

                    let mut others = layers.clone();
                    others.remove(index);
                    let exact = render(width, height, background, &others, &mut worker);
                    without.add(&exact, &layer.predict(None));

                    let candidate = random_layer(&mut rng, kind, &mut worker, &round);
                    let mut replaced = layers.clone();
                    replaced[index] = candidate.clone();
                    let exact = render(width, height, background, &replaced, &mut worker);
                    let lines = candidate.shape.rasterize(&mut worker).to_vec();
                    with.add(&exact, &layer.predict(Some((&lines, candidate.color))));
                }
            }
        }
        for (name, errors) in [("without", without), ("with", with)] {
            assert!(
                errors.max <= MAX_ERROR && errors.worst_mean <= MEAN_ERROR,
                "{name}: {errors:?}"
            );
        }
    }

    /// At the top layer the model is the greedy fit: the same colour within
    /// one level, and the exact energy of drawing it within the pinned
    /// bound. The model's `f32` planes can round a channel the other way
    /// where the exact energy is flat; there its colour must be exactly as
    /// good.
    #[test]
    fn top_layer_matches_the_greedy_fit() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x70b);
        let mut fitted = 0;
        for &kind in ShapeKind::all_kinds() {
            for (width, height) in [(2, 2), (23, 17), (40, 33)] {
                let target = noise(&mut rng, width, height);
                let layers = random_layers(&mut rng, kind, 8, (width, height));
                let (mut worker, round) = make_test_round(width, height, rng.random());
                let current = render(width, height, opaque(&mut rng), &layers, &mut worker);
                let score = score::difference_full_raw(&target, &current);
                let above = Above::new(width, height);
                let layer = Layer {
                    target: &target,
                    below: &current,
                    above: &above,
                };
                for _ in 0..10 {
                    let candidate = random_layer(&mut rng, kind, &mut worker, &round);
                    let alpha = candidate.color.a;
                    let lines = candidate.shape.rasterize(&mut worker).to_vec();
                    let greedy =
                        score::fit(&target, &current, None, &lines, i32::from(alpha)).color;
                    let Some(rgb) = layer.fit(&lines, alpha) else {
                        assert_eq!(greedy, Color::default(), "{kind:?}: invisible");
                        continue;
                    };
                    fitted += 1;
                    let color = Color::new(rgb[0], rgb[1], rgb[2], alpha);
                    let exact =
                        score::energy_from_lines_raw(&target, &current, &lines, color, score);
                    let close = rgb
                        .into_iter()
                        .zip([greedy.r, greedy.g, greedy.b])
                        .all(|(model, greedy)| model.abs_diff(greedy) <= 1);
                    let greedy_exact =
                        score::energy_from_lines_raw(&target, &current, &lines, greedy, score);
                    assert!(
                        close || exact <= greedy_exact,
                        "{kind:?}: {rgb:?} against {greedy:?}"
                    );

                    let model = layer.removed() + layer.delta(&lines, alpha, rgb);
                    let pixels = lines
                        .iter()
                        .filter_map(|line| clamp_line(line, width as i32, height as i32))
                        .map(|(x1, x2)| f64::from(x2 - x1 + 1))
                        .sum::<f64>();
                    let error = (model - exact as f64).abs() / (3.0 * pixels.max(1.0));
                    assert!(
                        error <= TOP_ENERGY_ERROR,
                        "{kind:?}: {model} against {exact}"
                    );
                }
            }
        }
        assert!(fitted > 100, "only {fitted} shapes had weight");
    }

    /// Moving the fitted colour one level in any channel never lowers the
    /// model energy: the discrete counterpart of a zero derivative.
    #[test]
    fn fitted_colour_is_a_discrete_minimum() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xd15c);
        let mut checked = 0;
        for &kind in ShapeKind::all_kinds() {
            let (width, height) = (31, 26);
            let target = noise(&mut rng, width, height);
            let background = opaque(&mut rng);
            let layers = random_layers(&mut rng, kind, 30, (width, height));
            let (mut worker, round) = make_test_round(width, height, rng.random());
            for index in [3, 15, 29] {
                let (below, above) =
                    layer_context(&target, background, &layers, index, &mut worker);
                let layer = Layer {
                    target: &target,
                    below: &below,
                    above: &above,
                };
                for _ in 0..10 {
                    let candidate = random_layer(&mut rng, kind, &mut worker, &round);
                    let alpha = candidate.color.a;
                    let lines = candidate.shape.rasterize(&mut worker).to_vec();
                    let Some(rgb) = layer.fit(&lines, alpha) else {
                        continue;
                    };
                    let best = layer.delta(&lines, alpha, rgb);
                    for channel in 0..3 {
                        for step in [-1, 1] {
                            let Some(moved) = rgb[channel].checked_add_signed(step) else {
                                continue;
                            };
                            let mut other = rgb;
                            other[channel] = moved;
                            let energy = layer.delta(&lines, alpha, other);
                            assert!(energy >= best, "{kind:?}: {other:?} beats {rgb:?}");
                            checked += 1;
                        }
                    }
                }
            }
        }
        assert!(checked > 500, "only {checked} moves checked");
    }

    /// Under an opaque full-canvas layer nothing below has any influence:
    /// every shape is invisible, with a zero delta and nothing not finite.
    #[test]
    fn a_fully_covered_layer_is_invisible() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x0cc);
        let (width, height) = (19, 14);
        let target = noise(&mut rng, width, height);
        let below = noise(&mut rng, width, height);
        let (mut worker, round) = make_test_round(width, height, 9);
        let mut above = Above::new(width, height);
        let cover = Shape::Rectangle(Rectangle {
            x1: 0,
            y1: 0,
            x2: width as i32 - 1,
            y2: height as i32 - 1,
        });
        above.fold(cover.rasterize(&mut worker), Color::new(30, 60, 90, 255));
        let layer = Layer {
            target: &target,
            below: &below,
            above: &above,
        };
        for &kind in ShapeKind::all_kinds() {
            let candidate = random_layer(&mut rng, kind, &mut worker, &round);
            let lines = candidate.shape.rasterize(&mut worker).to_vec();
            let alpha = candidate.color.a;
            assert_eq!(layer.fit(&lines, alpha), None, "{kind:?}");
            assert_eq!(layer.delta(&lines, alpha, [1, 2, 3]), 0.0, "{kind:?}");
            assert_eq!(
                layer.evaluate(&lines, alpha, [1, 2, 3]),
                (0.0, Color::new(1, 2, 3, alpha)),
                "{kind:?}"
            );
        }
    }

    /// The 1/5th success rule: a kept move scales up by [`SCALE_UP`], a
    /// rejected one down by [`SCALE_DOWN`], within `MIN_SCALE..=1`, and one
    /// kept move in five holds the scale still.
    #[test]
    fn step_scale_follows_the_one_fifth_rule() {
        let mut scale = StepScale::START;
        assert_eq!(scale.step(), Step::Scaled(1.0));
        scale.update(true);
        assert_eq!(scale, StepScale(1.0), "clamped at the coarse scale");
        scale.update(false);
        assert_eq!(scale, StepScale(SCALE_DOWN));

        let mut rejections = 1;
        while scale != StepScale(MIN_SCALE) && rejections < 100 {
            scale.update(false);
            rejections += 1;
        }
        assert_eq!(rejections, 16, "2^(-1/4) per rejection reaches 1/16");
        scale.update(false);
        assert_eq!(scale, StepScale(MIN_SCALE), "clamped at the smallest");
        scale.update(true);
        assert_eq!(scale, StepScale(2.0 * MIN_SCALE));

        let before = scale.0;
        for kept in [true, false, false, false, false] {
            scale.update(kept);
        }
        assert!((scale.0 / before - 1.0).abs() < 1e-12, "{scale:?}");
    }

    /// Every refit pass runs the default effort, so changing it changes
    /// `approximate`'s output and must be deliberate.
    #[test]
    fn the_default_refine_effort_is_four_climbs_of_age_25() {
        assert_eq!(RefineEffort::DEFAULT, RefineEffort { rounds: 4, age: 25 });
    }

    /// More climbs per layer extend the default ones: the first [`ROUNDS`]
    /// climbs draw the same streams and ties go to the lowest round, so a
    /// layer's refit is the default's or has a strictly lower model energy,
    /// and the extra climbs add at least [`AGE`] evaluations each.
    #[test]
    fn more_climbs_per_layer_extend_the_default_climbs() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xe4f);
        let more = RefineEffort {
            rounds: 2 * ROUNDS,
            age: AGE,
        };
        let (mut refitted, mut lowered) = (0, 0);
        for &kind in ShapeKind::all_kinds() {
            let (width, height) = (31, 26);
            let target = noise(&mut rng, width, height);
            let background = opaque(&mut rng);
            let layers = random_layers(&mut rng, kind, 12, (width, height));
            let (mut worker, _) = make_test_round(width, height, rng.random());
            for index in [0, 6, 11] {
                let (below, above) =
                    layer_context(&target, background, &layers, index, &mut worker);
                let layer = Layer {
                    target: &target,
                    below: &below,
                    above: &above,
                };
                let mut refit = |effort| {
                    let streams = Streams {
                        seed: 7,
                        pass: 3,
                        effort,
                    };
                    let committed = &layers[index];
                    let mut workers = climbers(&worker, effort);
                    let lines = committed.shape.rasterize(&mut worker);
                    refine_layer(
                        &layer,
                        committed,
                        lines,
                        index,
                        Alpha::Auto,
                        streams,
                        &mut workers,
                    )
                };
                let (default, default_count) = refit(RefineEffort::DEFAULT);
                let (extended, extended_count) = refit(more);
                let context = format!("{kind:?}, layer {index}");
                assert!(
                    extended_count >= default_count + (more.rounds - ROUNDS) * AGE as u64,
                    "{context}: {extended_count} against {default_count}"
                );
                let Some(default) = default else {
                    continue;
                };
                let extended = extended.expect("the default climbs found a refit");
                refitted += 1;
                if extended != default {
                    let mut energy = |refit: &CommittedShape| {
                        let color = refit.color;
                        let lines = refit.shape.rasterize(&mut worker).to_vec();
                        layer.delta(&lines, color.a, [color.r, color.g, color.b])
                    };
                    assert!(energy(&extended) < energy(&default), "{context}");
                    lowered += 1;
                }
            }
        }
        assert!(refitted > 10, "only {refitted} layers were refitted");
        assert!(lowered > 0, "the extra climbs never found a lower energy");
    }

    #[test]
    fn checkpoint_interval_is_the_square_root_unless_memory_caps_it() {
        let small = 256 * 256 * 3;
        assert_eq!(checkpoint_interval(1, small), 1);
        assert_eq!(checkpoint_interval(2, small), 2);
        assert_eq!(checkpoint_interval(100, small), 10);
        assert_eq!(checkpoint_interval(500, small), 23);
        // A 2048 x 2048 canvas: five checkpoints fit in the budget.
        let large = 2048 * 2048 * 3;
        assert_eq!(CHECKPOINT_BUDGET / large, 5);
        assert_eq!(checkpoint_interval(16, large), 4);
        assert_eq!(checkpoint_interval(500, large), 100);
        for layers in [1, 7, 499, 500, 501, 5000] {
            for bytes in [12, small, large, CHECKPOINT_BUDGET, 2 * CHECKPOINT_BUDGET] {
                let interval = checkpoint_interval(layers, bytes);
                let kept = layers.div_ceil(interval);
                assert!(
                    kept == 1 || kept * bytes <= CHECKPOINT_BUDGET,
                    "{layers} layers of {bytes} bytes"
                );
            }
        }
    }

    /// A refit pass as a naive implementation runs it: top-down, the canvas
    /// below every layer rendered from scratch.
    fn naive_pass(
        target: &Buffer,
        background: Color,
        layers: &[CommittedShape],
        alpha: Alpha,
        streams: Streams,
        worker: &mut WorkerCtx<ChaCha8Rng>,
    ) -> (Option<Vec<CommittedShape>>, u64) {
        let (width, height) = (target.width(), target.height());
        let mut above = Above::new(width, height);
        let mut refitted = layers.to_vec();
        let (mut changed, mut evaluations) = (false, 0);
        for index in (0..layers.len()).rev() {
            let below = render(width, height, background, &layers[..index], worker);
            let layer = Layer {
                target,
                below: &below,
                above: &above,
            };
            // Fresh workers for every layer's climbs.
            let mut workers = climbers(worker, streams.effort);
            let committed = &layers[index];
            let lines = committed.shape.rasterize(worker);
            let (refit, count) = refine_layer(
                &layer,
                committed,
                lines,
                index,
                alpha,
                streams,
                &mut workers,
            );
            evaluations += count;
            if let Some(refit) = refit {
                refitted[index] = refit;
                changed = true;
            }
            let decided = &refitted[index];
            above.fold(decided.shape.rasterize(worker), decided.color);
        }
        (changed.then_some(refitted), evaluations)
    }

    /// A pass returns exactly the layers and the evaluations of the naive
    /// pass, whatever its checkpoints and runs, across segment and run
    /// boundaries.
    #[test]
    fn a_pass_refits_every_layer_against_the_exact_canvas_below_it() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x5e9);
        let (width, height) = (24, 19);
        let canvas_bytes = (width * height * 3) as usize;
        let streams = Streams {
            seed: 11,
            pass: 2,
            effort: RefineEffort::DEFAULT,
        };
        let mut changed = 0;
        for count in [1, 7, 16, 17, 50] {
            let target = noise(&mut rng, width, height);
            let background = opaque(&mut rng);
            let layers = random_layers(&mut rng, ShapeKind::Any, count, (width, height));
            let mut worker = WorkerCtx::new(width as i32, height as i32, create_rng(3));
            let naive = naive_pass(
                &target,
                background,
                &layers,
                Alpha::Auto,
                streams,
                &mut worker,
            );
            changed += usize::from(naive.0.is_some());
            let plans = [
                replay_plan(count, canvas_bytes),
                Replay {
                    interval: 1,
                    run: 1,
                },
                Replay {
                    interval: 4,
                    run: 4,
                },
                Replay {
                    interval: 7,
                    run: 3,
                },
                Replay {
                    interval: count,
                    run: count.min(2),
                },
            ];
            for replay in plans {
                let pass = pass_with(
                    replay,
                    &target,
                    background,
                    &layers,
                    Alpha::Auto,
                    streams,
                    &mut worker,
                    &mut || false,
                );
                assert_eq!(pass, Some(naive.clone()), "{count} layers, {replay:?}");
            }
        }
        assert!(changed >= 4, "only {changed} passes changed a layer");
    }

    /// A pass keeps `⌈layers / interval⌉` checkpoints and a run of `run`
    /// canvases. Where they fit in the budget at `⌈√layers⌉`, which
    /// minimises them, both are `⌈√layers⌉`; otherwise the budget is split
    /// between checkpoints and runs, and only the smallest plan, one
    /// checkpoint and runs of one canvas, may exceed it.
    #[test]
    fn replay_plan_is_the_square_root_unless_memory_caps_it() {
        let plan = |interval, run| Replay { interval, run };
        let small = 256 * 256 * 3;
        assert_eq!(replay_plan(1, small), plan(1, 1));
        assert_eq!(replay_plan(2, small), plan(2, 2));
        assert_eq!(replay_plan(100, small), plan(10, 10));
        assert_eq!(replay_plan(500, small), plan(23, 23));
        // A 2048 x 2048 canvas: five canvases fit in the budget, against the
        // eight of four checkpoints and a run of four for 16 layers. Three
        // checkpoints and a run of two fill it.
        let large = 2048 * 2048 * 3;
        assert_eq!(CHECKPOINT_BUDGET / large, 5);
        assert_eq!(replay_plan(16, large), plan(6, 2));
        assert_eq!(replay_plan(500, large), plan(167, 2));
        // A canvas larger than the budget: the smallest plan.
        assert_eq!(replay_plan(500, 2 * CHECKPOINT_BUDGET), plan(500, 1));
        for layers in [1, 7, 16, 17, 499, 500, 501, 5000] {
            for bytes in [12, small, large, CHECKPOINT_BUDGET, 2 * CHECKPOINT_BUDGET] {
                let Replay { interval, run } = replay_plan(layers, bytes);
                let context = format!("{layers} layers of {bytes} bytes");
                assert!(1 <= run && run <= interval, "{context}");
                let kept = layers.div_ceil(interval) + run;
                let smallest = layers.div_ceil(interval) == 1 && run == 1;
                assert!(
                    smallest || kept * bytes <= CHECKPOINT_BUDGET,
                    "{context}: {kept} canvases"
                );
            }
        }
    }

    #[test]
    fn checkpoints_give_the_exact_canvas_below_every_layer() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xc4e);
        let (width, height) = (21, 18);
        let layers = random_layers(&mut rng, ShapeKind::Any, 37, (width, height));
        let background = opaque(&mut rng);
        let mut worker = WorkerCtx::new(width as i32, height as i32, create_rng(1));
        let canvas = Buffer::new_from_color(width, height, background);
        let exact: Vec<Buffer> = (0..layers.len())
            .map(|index| render(width, height, background, &layers[..index], &mut worker))
            .collect();
        // Whole segments, runs that end at a checkpoint, runs that do not,
        // runs of one layer, and one segment of every layer.
        for (interval, run) in [(7, 7), (7, 3), (7, 1), (6, 4), (1, 1), (37, 5), (37, 37)] {
            let replay = Replay { interval, run };
            let checkpoints = Checkpoints::render(&canvas, &layers, interval, &mut worker);
            assert_eq!(checkpoints.canvases.len(), layers.len().div_ceil(interval));
            let mut below = vec![Buffer::new(width, height); run];
            let mut visited = Vec::new();
            for (bottom, top) in replay.runs(layers.len()) {
                assert!(0 < top - bottom && top - bottom <= run, "{bottom}..{top}");
                assert_eq!(bottom / interval, (top - 1) / interval, "{bottom}..{top}");
                checkpoints.replay(&layers, bottom..top, &mut below, &mut worker);
                for index in (bottom..top).rev() {
                    let replayed = below[index - bottom].pixels();
                    let context = format!("{replay:?}, layer {index}");
                    assert_eq!(replayed, exact[index].pixels(), "{context}");
                    visited.push(index);
                }
            }
            let top_down: Vec<usize> = (0..layers.len()).rev().collect();
            assert_eq!(visited, top_down, "{replay:?}");
        }
    }
}

/// Thread-free refit-sums tests, also selected by the WASI kernel runner.
#[cfg(all(
    test,
    any(
        target_arch = "aarch64",
        target_arch = "x86_64",
        all(target_arch = "wasm32", target_feature = "simd128")
    )
))]
mod simd_parity {
    use super::tests::noise;
    use super::*;
    use crate::rng::create_rng;
    use rand::RngExt;

    fn sum_bits(sums: Sums) -> [u64; 6] {
        let [r, g, b] = sums.numerators;
        [r, g, b, sums.weights, sums.errors, sums.removed].map(f64::to_bits)
    }

    const SUMS_WIDTHS: [u32; 3] = [2, 17, 257];

    /// Visit single lines at each alpha, random lines, then the overlapping
    /// set at each alpha, preserving the random stream across widths.
    fn for_each_sums_case(mut check: impl FnMut(u32, &Layer<'_>, &[Scanline], u8)) {
        let mut rng = create_rng(0x5a45);
        for width in SUMS_WIDTHS {
            let height = 5;
            let target = noise(&mut rng, width, height);
            let below = noise(&mut rng, width, height);
            let mut above = Above::new(width, height);
            for _ in 0..24 {
                let lines: Vec<_> = (0..12)
                    .map(|_| Scanline {
                        y: rng.random_range(-1..=height as i32),
                        x1: rng.random_range(-10..width as i32),
                        x2: rng.random_range(0..width as i32 + 10),
                        alpha: rng.random_range(0..=score::M),
                    })
                    .collect();
                above.fold(
                    &lines,
                    Color::new(rng.random(), rng.random(), rng.random(), rng.random()),
                );
            }
            above.fold(
                &[Scanline {
                    y: 1,
                    x1: 1,
                    x2: width as i32 / 2,
                    alpha: score::M,
                }],
                Color::new(30, 60, 90, 255),
            );
            assert!(above.transmittance.contains(&0.0));
            let layer = Layer {
                target: &target,
                below: &below,
                above: &above,
            };
            let mut lines = Vec::new();
            for length in (0..=13).chain([width as i32, width as i32 + 20]) {
                for x1 in [-9, 0, 1, width as i32 - 3, width as i32, width as i32 + 3] {
                    for y in [-1, 0, 1, 4, 5] {
                        for coverage in [0, 1, 255, 256, 32768, score::M - 1, score::M] {
                            let line = Scanline {
                                y,
                                x1,
                                x2: x1 + length - 1,
                                alpha: coverage,
                            };
                            for alpha in [0, 1, 128, 255] {
                                check(width, &layer, &[line], alpha);
                            }
                            lines.push(line);
                        }
                    }
                }
            }
            for _ in 0..128 {
                let line = Scanline {
                    y: rng.random_range(-1..=height as i32),
                    x1: rng.random_range(-20..width as i32 + 20),
                    x2: rng.random_range(-20..width as i32 + 20),
                    alpha: rng.random_range(0..=score::M),
                };
                let alpha = rng.random();
                check(width, &layer, &[line], alpha);
                lines.push(line);
            }
            for alpha in [0, 1, 128, 255] {
                check(width, &layer, &lines, alpha);
            }
        }
    }

    /// The SIMD sums equal the scalar sums on random folded layers, all
    /// short lengths and tails, long lines, clipping, overlap, coverage/alpha
    /// extremes and hidden pixels.
    #[test]
    fn simd_sums_match_scalar_sums() {
        for_each_sums_case(|width, layer, lines, alpha| {
            assert_eq!(
                sum_bits(layer.sums(lines, alpha)),
                sum_bits(sums::scalar_sums(layer, lines, alpha)),
                "width {width}, {} lines, first {:?}, alpha {alpha}",
                lines.len(),
                lines.first(),
            );
        });
    }

    /// Pin the normative order of [`Sums`] across targets. A moved digest
    /// means the refit's output changed; treat it like the model pins.
    #[test]
    fn sums_are_pinned() {
        let mut bytes: [Vec<u8>; 3] = std::array::from_fn(|_| Vec::new());
        for_each_sums_case(|width, layer, lines, alpha| {
            let index = SUMS_WIDTHS.iter().position(|&w| w == width).unwrap();
            bytes[index].extend(
                sum_bits(layer.sums(lines, alpha))
                    .into_iter()
                    .flat_map(u64::to_le_bytes),
            );
        });
        let digests = bytes.map(crate::test_util::fnv1a);
        assert_eq!(
            digests,
            [0x83c3afcdb649359f, 0x51b5242c2230da0b, 0xfc67125b9380be68],
            "widths {SUMS_WIDTHS:?}"
        );
    }

    fn slot_bits(sums: &sums::SlotSums) -> [[u64; 4]; 6] {
        [
            sums.weights,
            sums.numerators[0],
            sums.numerators[1],
            sums.numerators[2],
            sums.errors,
            sums.removed,
        ]
        .map(|s| s.map(f64::to_bits))
    }

    #[test]
    fn groups_match_scalar_slots_for_real_blends() {
        let mut rng = create_rng(0x51_07);
        let mut expected = sums::SlotSums::default();
        let mut actual = sums::SlotSums::default();
        // A strided blend sample plus the extremes catches arithmetic/lane
        // mistakes; the kernel and reference receive the same Blend. Cover
        // each shape alpha's coverage extremes to exercise integer rounding.
        for (alpha, coverage) in (1..=score::M)
            .step_by(251)
            .chain([2, score::M - 1, score::M])
            .map(|k| (255, k))
            .chain((1..=255).flat_map(|alpha| {
                [0, 1, 255, 256, 32768, score::M - 1, score::M].map(|coverage| (alpha, coverage))
            }))
        {
            let Some(blend) = Blend::new(alpha, coverage) else {
                continue;
            };
            let t = std::array::from_fn(|_| std::array::from_fn(|_| rng.random()));
            let d = std::array::from_fn(|_| std::array::from_fn(|_| rng.random()));
            let a = std::array::from_fn(|slot| match (coverage as usize + slot) % 8 {
                0 | 1 => 0.0,
                2 => 1.0,
                _ => rng.random_range(0.0..=1.0),
            });
            // Real folded offsets are bounded by 255 times the opacity
            // k = 1 - A. Include arbitrary f32 planes inside that bound.
            let b = std::array::from_fn(|slot| {
                std::array::from_fn(|_| rng.random_range(0.0..=255.0 * (1.0 - a[slot])))
            });
            for slot in 0..4 {
                if a[slot] != 0.0 {
                    let (g, q, r) = residuals(t[slot], d[slot], b[slot], a[slot], blend);
                    expected.add(slot, sums::terms(g, q, r));
                }
            }
            sums::group(&mut actual, &t, &d, &b, &a, blend);
            assert_eq!(
                slot_bits(&actual),
                slot_bits(&expected),
                "alpha {alpha}, coverage {coverage}, A {a:?}"
            );
        }
        // Exercise every hidden-lane mask, including an entirely hidden
        // group, exact byte and offset extremes, and signed-zero residuals.
        for mask in 0..16 {
            let a = std::array::from_fn(|slot| if mask & (1 << slot) == 0 { 0.0 } else { 1.0 });
            let t = [[0, 255, 0], [255, 0, 255], [1, 128, 254], [255; 3]];
            let d = [[255, 0, 255], [0, 255, 0], [254, 128, 1], [255; 3]];
            let b = std::array::from_fn(|slot| [255.0 * (1.0 - a[slot]); 3]);
            let blend = Blend::new(255, score::M).unwrap();
            for slot in 0..4 {
                if a[slot] != 0.0 {
                    let (g, q, r) = residuals(t[slot], d[slot], b[slot], a[slot], blend);
                    expected.add(slot, sums::terms(g, q, r));
                }
            }
            sums::group(&mut actual, &t, &d, &b, &a, blend);
            assert_eq!(
                slot_bits(&actual),
                slot_bits(&expected),
                "hidden mask {mask}"
            );
        }
        assert_eq!(sum_bits(actual.finish()), sum_bits(expected.finish()));
    }
}
