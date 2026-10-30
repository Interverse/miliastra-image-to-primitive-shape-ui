//! Divan micro-benchmarks for the engine's hot paths.
//!
//! Compiled only with the `bench` feature, inside the crate so the benchmarks
//! reach crate-private items without widening the public API. The harness in
//! `benches/core.rs` runs them:
//!
//! ```text
//! cargo bench -p primeval-core --features bench --bench core
//! ```
//!
//! Every input is deterministic: a synthetic 256 × 256 target (gradient,
//! hard-edged discs and a striped patch), a flat grey canvas, and shapes drawn
//! from a fixed seed through the engine's own error-biased sampling.

use crate::alpha::Alpha;
use crate::buffer::Buffer;
use crate::color::Color;
use crate::error_grid::ErrorGrid;
use crate::model::{Model, ModelOptions};
use crate::refine::{Above, Layer};
use crate::rng::create_rng;
use crate::scanline::Scanline;
use crate::score;
use crate::shapes::{Shape, ShapeKind};
use crate::worker::{SearchRound, WorkerCtx};
use divan::Bencher;
use divan::counter::ItemsCount;

/// Working size of every benchmark canvas (the default `resize_input`).
const SIZE: u32 = 256;
/// Shapes per kind; one benchmark iteration processes all of them.
const SHAPES: usize = 256;
/// Seed for the shape sampler and the model.
const SEED: u64 = 42;
/// Fixed alpha for the colour and energy kernels (the middle of `1..=255`).
const ALPHA: u8 = 128;
const CANVAS: Color = Color::new(128, 128, 128, 255);

/// The concrete shape kinds, one rasterizer each.
const CONCRETE_KINDS: [ShapeKind; 8] = [
    ShapeKind::Triangle,
    ShapeKind::Rectangle,
    ShapeKind::Ellipse,
    ShapeKind::Circle,
    ShapeKind::RotatedRectangle,
    ShapeKind::Quadratic,
    ShapeKind::RotatedEllipse,
    ShapeKind::Polygon,
];

/// Every kind the search accepts, including the `any` mix.
const ALL_KINDS: [ShapeKind; 9] = [
    ShapeKind::Any,
    ShapeKind::Triangle,
    ShapeKind::Rectangle,
    ShapeKind::Ellipse,
    ShapeKind::Circle,
    ShapeKind::RotatedRectangle,
    ShapeKind::Quadratic,
    ShapeKind::RotatedEllipse,
    ShapeKind::Polygon,
];

/// A deterministic opaque target with smooth, hard-edged and high-frequency
/// regions, so shapes and kernels see a mix of content.
fn synthetic_target() -> Buffer {
    let discs = [
        (64.0, 72.0, 40.0, [220, 40, 40]),
        (180.0, 96.0, 52.0, [30, 160, 70]),
        (120.0, 190.0, 34.0, [40, 60, 200]),
    ];
    let mut pixels = Vec::with_capacity((SIZE * SIZE * 3) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (xf, yf) = (f64::from(x), f64::from(y));
            let mut rgb = [x as u8, y as u8, ((x + y) / 2) as u8];
            for (cx, cy, r, color) in discs {
                if (xf - cx).powi(2) + (yf - cy).powi(2) <= r * r {
                    rgb = color;
                }
            }
            if x >= 192 && y >= 192 && (x / 2 + y / 3) % 2 == 0 {
                rgb = [250, 250, 250];
            }
            pixels.extend_from_slice(&rgb);
        }
    }
    Buffer::from_rgb(SIZE, SIZE, pixels).expect("pixel length matches the size")
}

/// Target, canvas and the error grid of the first search step.
struct Fixture {
    target: Buffer,
    current: Buffer,
    grid: ErrorGrid,
    score: u64,
}

impl Fixture {
    fn new() -> Self {
        let target = synthetic_target();
        let current = Buffer::new_from_color(SIZE, SIZE, CANVAS);
        let defaults = ModelOptions::default();
        let mut grid = ErrorGrid::new(SIZE, SIZE, defaults.grid_cols, defaults.grid_rows);
        grid.compute(&target, &current);
        let score = score::difference_full_raw(&target, &current);
        Self {
            target,
            current,
            grid,
            score,
        }
    }

    fn worker(&self) -> WorkerCtx<rand_chacha::ChaCha8Rng> {
        WorkerCtx::new(SIZE as i32, SIZE as i32, create_rng(SEED))
    }

    /// [`SHAPES`] seeded random shapes of `kind`, sampled as the search does.
    fn shapes(&self, kind: ShapeKind) -> Vec<Shape> {
        let round = SearchRound {
            half_resolution: false,
            target: &self.target,
            current: &self.current,
            error_grid: &self.grid,
            score: self.score,
            coarse: None,
        };
        let mut worker = self.worker();
        (0..SHAPES)
            .map(|_| Shape::random(kind, &mut worker, &round))
            .collect()
    }

    /// The scanlines of each shape in [`Self::shapes`].
    fn lines(&self, kind: ShapeKind) -> Vec<Vec<Scanline>> {
        let mut worker = self.worker();
        self.shapes(kind)
            .iter()
            .map(|shape| shape.rasterize(&mut worker).to_vec())
            .collect()
    }
}

/// Rasterizes [`SHAPES`] shapes of one kind per iteration.
#[divan::bench(args = CONCRETE_KINDS)]
fn rasterize(bencher: Bencher<'_, '_>, kind: ShapeKind) {
    let fixture = Fixture::new();
    let shapes = fixture.shapes(kind);
    let mut worker = fixture.worker();
    bencher.counter(ItemsCount::new(SHAPES)).bench_local(|| {
        shapes
            .iter()
            .map(|shape| shape.rasterize(&mut worker).len())
            .sum::<usize>()
    });
}

/// Fits the colour of [`SHAPES`] rasterized shapes of one kind per
/// iteration, with the step's prefix sums, as the search does; the fit also
/// sums the old error the energy subtracts.
#[divan::bench(args = CONCRETE_KINDS)]
fn compute_color(bencher: Bencher<'_, '_>, kind: ShapeKind) {
    let fixture = Fixture::new();
    let lines = fixture.lines(kind);
    bencher.counter(ItemsCount::new(SHAPES)).bench_local(|| {
        for shape_lines in &lines {
            divan::black_box(score::fit(
                divan::black_box(&fixture.target),
                &fixture.current,
                Some(fixture.grid.sums()),
                shape_lines,
                i32::from(ALPHA),
            ));
        }
    });
}

/// Scores [`SHAPES`] rasterized shapes of one kind, from their fits, per
/// iteration, in full (without a bound): the blend and new error of every
/// covered pixel.
#[divan::bench(args = CONCRETE_KINDS)]
fn energy_from_lines_raw(bencher: Bencher<'_, '_>, kind: ShapeKind) {
    let fixture = Fixture::new();
    let lines = fixture.lines(kind);
    let fits: Vec<score::Fit> = lines
        .iter()
        .map(|shape_lines| {
            score::fit(
                &fixture.target,
                &fixture.current,
                Some(fixture.grid.sums()),
                shape_lines,
                i32::from(ALPHA),
            )
        })
        .collect();
    bencher.counter(ItemsCount::new(SHAPES)).bench_local(|| {
        for (shape_lines, &fit) in lines.iter().zip(&fits) {
            divan::black_box(score::energy(
                divan::black_box(&fixture.target),
                &fixture.current,
                shape_lines,
                fit,
                fixture.score,
            ));
        }
    });
}

/// Sums for [`SHAPES`] candidates at a layer inside an exact composite.
/// The translucent layers attenuate candidates and add RGB offsets; the
/// opaque patch hides some pixels completely.
#[divan::bench(args = CONCRETE_KINDS)]
fn refine_sums(bencher: Bencher<'_, '_>, kind: ShapeKind) {
    let fixture = Fixture::new();
    let lines = fixture.lines(kind);
    let patch = |x1, x2, y1, y2| {
        (y1..y2)
            .map(|y| Scanline {
                y,
                x1,
                x2,
                alpha: score::M,
            })
            .collect::<Vec<_>>()
    };
    let mut below = fixture.current.clone();
    score::draw_lines(
        &mut below,
        Color::new(45, 180, 95, 137),
        &patch(24, 195, 48, 224),
    );
    score::draw_lines(
        &mut below,
        Color::new(210, 60, 135, 85),
        &patch(110, 250, 16, 150),
    );
    let mut above = Above::new(SIZE, SIZE);
    above.fold(&patch(0, 255, 0, 256), Color::new(60, 90, 180, 45));
    above.fold(&patch(90, 240, 60, 240), Color::new(190, 45, 80, 128));
    above.fold(&patch(16, 112, 32, 180), Color::new(30, 200, 110, 255));
    let layer = Layer {
        target: &fixture.target,
        below: &below,
        above: &above,
    };
    bencher.counter(ItemsCount::new(SHAPES)).bench_local(|| {
        for shape_lines in &lines {
            divan::black_box(divan::black_box(&layer).sums(shape_lines, ALPHA));
        }
    });
}

/// Full-canvas squared difference at the working size.
#[divan::bench]
fn difference_full_raw(bencher: Bencher<'_, '_>) {
    let fixture = Fixture::new();
    bencher.bench_local(|| {
        score::difference_full_raw(divan::black_box(&fixture.target), &fixture.current)
    });
}

/// The first search step of a fresh, seeded model on a one-thread pool.
#[divan::bench(args = ALL_KINDS, sample_count = 20, sample_size = 1)]
fn model_step(bencher: Bencher<'_, '_>, kind: ShapeKind) {
    let target = synthetic_target();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .expect("one-thread pool");
    bencher
        .with_inputs(|| {
            let options = ModelOptions {
                seed: Some(SEED),
                ..ModelOptions::default()
            };
            Model::new(target.clone(), CANVAS, options)
        })
        .bench_local_refs(|model| pool.install(|| model.step(kind, Alpha::Auto)));
}
