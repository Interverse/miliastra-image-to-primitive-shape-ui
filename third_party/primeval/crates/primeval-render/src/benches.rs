//! Divan micro-benchmarks for the output writers.
//!
//! Compiled only with the `bench` feature, inside the crate so the benchmarks
//! reach the crate-private writers without widening the public API. The
//! harness in `benches/render.rs` runs them:
//!
//! ```text
//! cargo bench -p primeval-render --features bench --bench render
//! ```
//!
//! Both writers draw the same fixed drawing: [`SHAPES`] shapes, cycling
//! through every geometry variant, on a 256 × 256 canvas, written at
//! [`OUTPUT`] × [`OUTPUT`] output pixels.

use crate::{raster, svg};
use primeval_core::{Color, Drawing, DrawnShape, Geometry, Point};

/// Canvas side in working-resolution units (the default `resize_input`).
const CANVAS: u32 = 256;
/// Output side in pixels (the default `output_size`).
const OUTPUT: u32 = 1024;
/// Shapes in the drawing.
const SHAPES: usize = 200;

/// A tiny deterministic generator (xorshift64), so the drawing does not depend
/// on the engine or on a random-number crate.
struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// A value in `[low, high)`.
    fn range(&mut self, low: f64, high: f64) -> f64 {
        low + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (high - low)
    }

    fn point(&mut self) -> Point {
        let side = f64::from(CANVAS);
        Point::new(self.range(0.0, side), self.range(0.0, side))
    }

    fn color(&mut self) -> Color {
        let [r, g, b, ..] = self.next().to_le_bytes();
        Color::new(r, g, b, 128)
    }
}

/// The fixed drawing both writers render.
fn drawing() -> Drawing {
    let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
    let shapes = (0..SHAPES)
        .map(|index| {
            let geometry = match index % 4 {
                0 => {
                    let corner = rng.point();
                    Geometry::Rect {
                        x: corner.x,
                        y: corner.y,
                        width: rng.range(2.0, 48.0),
                        height: rng.range(2.0, 48.0),
                    }
                }
                1 => {
                    let centre = rng.point();
                    Geometry::Ellipse {
                        cx: centre.x,
                        cy: centre.y,
                        rx: rng.range(2.0, 32.0),
                        ry: rng.range(2.0, 32.0),
                        rotation: rng.range(0.0, 360.0),
                    }
                }
                2 => Geometry::Polygon((0..4).map(|_| rng.point()).collect()),
                _ => Geometry::Quadratic {
                    start: rng.point(),
                    control: rng.point(),
                    end: rng.point(),
                    width: rng.range(0.5, 4.0),
                    cap: primeval_core::LineCap::Butt,
                },
            };
            DrawnShape {
                geometry,
                color: rng.color(),
            }
        })
        .collect();
    Drawing {
        width: CANVAS,
        height: CANVAS,
        background: Color::new(128, 128, 128, 255),
        shapes,
    }
}

/// The SVG writer.
#[divan::bench]
fn write_svg(bencher: divan::Bencher<'_, '_>) {
    let drawing = drawing();
    bencher.bench_local(|| svg::write_svg(divan::black_box(&drawing), OUTPUT, OUTPUT));
}

/// The PNG writer: tiny-skia rendering plus PNG encoding.
#[divan::bench]
fn write_png(bencher: divan::Bencher<'_, '_>) {
    let drawing = drawing();
    bencher.bench_local(|| {
        let rgb = raster::render_rgb(divan::black_box(&drawing), OUTPUT, OUTPUT)
            .expect("the output raster fits in memory");
        raster::encode_png(OUTPUT, OUTPUT, &rgb).expect("PNG encoding succeeds")
    });
}
