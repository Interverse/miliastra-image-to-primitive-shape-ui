//! Checks that `Shape::geometry` covers the pixels the engine rasterizes.
//!
//! Each kind's engine rasterizer and its geometry, drawn with tiny-skia at
//! scale 1, are reduced to masks of covered pixels and compared.

use super::*;
use crate::drawing::{Geometry, Point};
use crate::test_util::make_test_round;
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

const W: u32 = 64;
const H: u32 = 48;

fn engine_mask(shape: &Shape, worker: &mut WorkerCtx<rand_chacha::ChaCha8Rng>) -> Vec<bool> {
    let mut coverage = vec![0u32; (W * H) as usize];
    for line in shape.rasterize(worker) {
        if line.y < 0 || line.y >= H as i32 {
            continue;
        }
        for x in line.x1.max(0)..=line.x2.min(W as i32 - 1) {
            let i = line.y as usize * W as usize + x as usize;
            coverage[i] = coverage[i].max(line.alpha);
        }
    }
    coverage.iter().map(|&a| a >= 0x8000).collect()
}

/// tiny-skia's cap for `cap`, as the PNG writer maps it.
fn skia_cap(cap: LineCap) -> tiny_skia::LineCap {
    match cap {
        LineCap::Butt => tiny_skia::LineCap::Butt,
        LineCap::Round => tiny_skia::LineCap::Round,
        LineCap::Square => tiny_skia::LineCap::Square,
    }
}

fn geometry_mask(geometry: &Geometry) -> Vec<bool> {
    let mut pixmap = Pixmap::new(W, H).expect("pixmap");
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = true;
    let t = Transform::identity();
    let mut pb = PathBuilder::new();
    match geometry {
        Geometry::Rect {
            x,
            y,
            width,
            height,
        } => {
            pb.push_rect(
                tiny_skia::Rect::from_xywh(*x as f32, *y as f32, *width as f32, *height as f32)
                    .expect("rect"),
            );
            pixmap.fill_path(
                &pb.finish().expect("path"),
                &paint,
                FillRule::Winding,
                t,
                None,
            );
        }
        Geometry::Ellipse {
            cx,
            cy,
            rx,
            ry,
            rotation,
        } => {
            pb.push_oval(
                tiny_skia::Rect::from_xywh(
                    (cx - rx) as f32,
                    (cy - ry) as f32,
                    (2.0 * rx) as f32,
                    (2.0 * ry) as f32,
                )
                .expect("oval"),
            );
            let t = Transform::from_rotate_at(*rotation as f32, *cx as f32, *cy as f32);
            pixmap.fill_path(
                &pb.finish().expect("path"),
                &paint,
                FillRule::Winding,
                t,
                None,
            );
        }
        Geometry::Polygon(points) => {
            pb.move_to(points[0].x as f32, points[0].y as f32);
            for p in &points[1..] {
                pb.line_to(p.x as f32, p.y as f32);
            }
            pb.close();
            if let Some(path) = pb.finish() {
                pixmap.fill_path(&path, &paint, FillRule::Winding, t, None);
            }
        }
        Geometry::Quadratic {
            start,
            control,
            end,
            width,
            cap,
        } => {
            pb.move_to(start.x as f32, start.y as f32);
            pb.quad_to(
                control.x as f32,
                control.y as f32,
                end.x as f32,
                end.y as f32,
            );
            let stroke = Stroke {
                width: *width as f32,
                line_cap: skia_cap(*cap),
                ..Stroke::default()
            };
            pixmap.stroke_path(&pb.finish().expect("path"), &paint, &stroke, t, None);
        }
    }
    // Strictly more than half: a pixel cut exactly in half (the signature of
    // a half-pixel offset on an axis-aligned edge) counts as uncovered
    // instead of falling on either side of a tie.
    pixmap.pixels().iter().map(|p| p.alpha() > 128).collect()
}

fn shift(geometry: &Geometry, dx: f64, dy: f64) -> Geometry {
    let p = |p: &Point| Point::new(p.x + dx, p.y + dy);
    match geometry {
        Geometry::Rect {
            x,
            y,
            width,
            height,
        } => Geometry::Rect {
            x: x + dx,
            y: y + dy,
            width: *width,
            height: *height,
        },
        Geometry::Ellipse {
            cx,
            cy,
            rx,
            ry,
            rotation,
        } => Geometry::Ellipse {
            cx: cx + dx,
            cy: cy + dy,
            rx: *rx,
            ry: *ry,
            rotation: *rotation,
        },
        Geometry::Polygon(points) => Geometry::Polygon(points.iter().map(p).collect()),
        Geometry::Quadratic {
            start,
            control,
            end,
            width,
            cap,
        } => Geometry::Quadratic {
            start: p(start),
            control: p(control),
            end: p(end),
            width: *width,
            cap: *cap,
        },
    }
}

fn perimeter(geometry: &Geometry) -> f64 {
    let dist = |a: &Point, b: &Point| ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt();
    match geometry {
        Geometry::Rect { width, height, .. } => 2.0 * (width + height),
        Geometry::Ellipse { rx, ry, .. } => {
            let h = ((rx - ry) / (rx + ry)).powi(2);
            std::f64::consts::PI * (rx + ry) * (1.0 + 3.0 * h / (10.0 + (4.0 - 3.0 * h).sqrt()))
        }
        Geometry::Polygon(points) => (0..points.len())
            .map(|i| dist(&points[i], &points[(i + 1) % points.len()]))
            .sum(),
        Geometry::Quadratic {
            start,
            control,
            end,
            width,
            ..
        } => 2.0 * (dist(start, control) + dist(control, end)) + 2.0 * width,
    }
}

const KINDS: [ShapeKind; 8] = [
    ShapeKind::Triangle,
    ShapeKind::Rectangle,
    ShapeKind::Ellipse,
    ShapeKind::Circle,
    ShapeKind::RotatedRectangle,
    ShapeKind::Quadratic,
    ShapeKind::RotatedEllipse,
    ShapeKind::Polygon,
];

/// Mismatched pixels per unit of perimeter, summed over seeded random shapes
/// of `kind`, with the geometry shifted by `(dx, dy)`.
fn mismatch_per_perimeter(kind: ShapeKind, dx: f64, dy: f64) -> f64 {
    let (mut worker, round) = make_test_round(W, H, 11);
    let (mut mismatched, mut perimeter_total) = (0usize, 0.0);
    for _ in 0..SHAPES_PER_KIND {
        let shape = Shape::random(kind, &mut worker, &round);
        let engine = engine_mask(&shape, &mut worker);
        let geometry = shape.geometry();
        let drawn = geometry_mask(&shift(&geometry, dx, dy));
        mismatched += engine.iter().zip(&drawn).filter(|(a, b)| a != b).count();
        perimeter_total += perimeter(&geometry);
    }
    mismatched as f64 / perimeter_total
}

const SHAPES_PER_KIND: usize = 200;

/// Upper bound on mismatched pixels per unit of perimeter.
///
/// Engine and geometry masks can only disagree along the anti-aliased
/// boundary, so the mismatch count grows with the perimeter, not the area;
/// normalising by the perimeter makes one bound fit small and large shapes.
/// Every rasterizer samples its shape at pixel centres, so a correct mapping
/// stays at or below 0.07 (`Circle`, whose four extreme pixels have their
/// centres on the outline but are just under half covered) and a half-pixel
/// offset costs at least 0.17. Axis-aligned ellipses and circles are also
/// checked exactly, pixel centre by pixel centre, below.
const BOUND: f64 = 0.1;

const HALF_PIXEL_SHIFTS: [(f64, f64); 4] = [(0.5, 0.0), (-0.5, 0.0), (0.0, 0.5), (0.0, -0.5)];

#[test]
fn geometry_covers_the_pixels_the_engine_rasterizes() {
    for kind in KINDS {
        let measured = mismatch_per_perimeter(kind, 0.0, 0.0);
        assert!(
            measured <= BOUND,
            "{kind:?}: {measured:.3} mismatched pixels per unit of perimeter, bound {BOUND}"
        );
    }
}

#[test]
fn half_pixel_offsets_exceed_the_bound() {
    for kind in KINDS {
        for (dx, dy) in HALF_PIXEL_SHIFTS {
            let measured = mismatch_per_perimeter(kind, dx, dy);
            assert!(
                measured > BOUND,
                "{kind:?} shifted by ({dx}, {dy}): {measured:.3} is within bound {BOUND}"
            );
        }
    }
}

#[test]
fn quadratic_geometry_keeps_the_working_width() {
    let shape = Shape::Quadratic(Quadratic {
        x1: 1.0,
        y1: 2.0,
        x2: 3.0,
        y2: 4.0,
        x3: 5.0,
        y3: 6.0,
        width: 0.5,
        cap: LineCap::Butt,
    });
    assert_eq!(
        shape.geometry(),
        Geometry::Quadratic {
            start: Point::new(1.0, 2.0),
            control: Point::new(3.0, 4.0),
            end: Point::new(5.0, 6.0),
            width: 0.5,
            cap: LineCap::Butt,
        }
    );
}

#[test]
fn rectangle_geometry_covers_inclusive_pixel_bounds() {
    let shape = Shape::Rectangle(Rectangle {
        x1: 4,
        y1: 3,
        x2: 2,
        y2: 1,
    });
    assert_eq!(
        shape.geometry(),
        Geometry::Rect {
            x: 2.0,
            y: 1.0,
            width: 3.0,
            height: 3.0,
        }
    );
}

#[test]
fn circle_geometry_is_centred_on_the_pixel() {
    let shape = Shape::Circle(Circle { x: 10, y: 20, r: 7 });
    assert_eq!(
        shape.geometry(),
        Geometry::Ellipse {
            cx: 10.5,
            cy: 20.5,
            rx: 7.0,
            ry: 7.0,
            rotation: 0.0,
        }
    );
}

/// Whether the centre of pixel `(px, py)` lies inside or on `geometry`, an
/// axis-aligned ellipse, computed exactly: both centres sit on the
/// half-pixel lattice and the radii are integers.
fn ellipse_contains_pixel_centre(geometry: &Geometry, px: i32, py: i32) -> bool {
    let Geometry::Ellipse {
        cx,
        cy,
        rx,
        ry,
        rotation,
    } = *geometry
    else {
        panic!("expected an ellipse, got {geometry:?}");
    };
    assert_eq!(rotation, 0.0);
    let dx = (f64::from(px) + 0.5 - cx) as i64;
    let dy = (f64::from(py) + 0.5 - cy) as i64;
    let (rx, ry) = (rx as i64, ry as i64);
    dx * dx * ry * ry + dy * dy * rx * rx <= rx * rx * ry * ry
}

#[test]
fn axis_aligned_ellipses_cover_exactly_the_pixel_centres_inside_their_geometry() {
    let (mut worker, round) = make_test_round(W, H, 23);
    for kind in [ShapeKind::Ellipse, ShapeKind::Circle] {
        for _ in 0..SHAPES_PER_KIND {
            let shape = Shape::random(kind, &mut worker, &round);
            let engine = engine_mask(&shape, &mut worker);
            let geometry = shape.geometry();
            for py in 0..H as i32 {
                for px in 0..W as i32 {
                    assert_eq!(
                        engine[py as usize * W as usize + px as usize],
                        ellipse_contains_pixel_centre(&geometry, px, py),
                        "{shape:?} at pixel ({px}, {py})"
                    );
                }
            }
        }
    }
}

#[test]
fn circle_of_radius_four_covers_nine_rows_and_nine_columns() {
    let (mut worker, _round) = make_test_round(W, H, 0);
    let shape = Shape::Circle(Circle { x: 20, y: 20, r: 4 });
    let lines = shape.rasterize(&mut worker).to_vec();
    let rows: Vec<i32> = lines.iter().map(|line| line.y).collect();
    assert_eq!(rows.iter().min(), Some(&16));
    assert_eq!(rows.iter().max(), Some(&24));
    assert_eq!(lines.len(), 9, "one span per row: {lines:?}");
    assert_eq!(lines.iter().map(|line| line.x1).min(), Some(16));
    assert_eq!(lines.iter().map(|line| line.x2).max(), Some(24));
    let tips: Vec<(i32, i32)> = lines
        .iter()
        .filter(|line| line.y == 16 || line.y == 24)
        .map(|line| (line.x1, line.x2))
        .collect();
    assert_eq!(tips, vec![(20, 20), (20, 20)]);
}

/// The engine's coverage of every pixel, in `[0, 1]`.
fn engine_coverage(shape: &Shape, worker: &mut WorkerCtx<rand_chacha::ChaCha8Rng>) -> Vec<f64> {
    let mut coverage = vec![0.0; (W * H) as usize];
    for line in shape.rasterize(worker) {
        for x in line.x1..=line.x2 {
            coverage[line.y as usize * W as usize + x as usize] = line.coverage();
        }
    }
    coverage
}

/// The coverage of every pixel by the stroke the PNG writer draws for
/// `geometry` at scale 1, the working size: tiny-skia's anti-aliased stroke
/// with the geometry's caps, on its high-precision pipeline.
fn exported_coverage(geometry: &Geometry) -> Vec<f64> {
    let Geometry::Quadratic {
        start,
        control,
        end,
        width,
        cap,
    } = *geometry
    else {
        panic!("expected a quadratic, got {geometry:?}");
    };
    let mut pixmap = Pixmap::new(W, H).expect("pixmap");
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = true;
    paint.force_hq_pipeline = true;
    let mut pb = PathBuilder::new();
    pb.move_to(start.x as f32, start.y as f32);
    pb.quad_to(
        control.x as f32,
        control.y as f32,
        end.x as f32,
        end.y as f32,
    );
    let stroke = Stroke {
        width: width as f32,
        line_cap: skia_cap(cap),
        ..Stroke::default()
    };
    let path = pb.finish().expect("path");
    pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    pixmap
        .pixels()
        .iter()
        .map(|p| f64::from(p.alpha()) / 255.0)
        .collect()
}

/// `Σ |engine − export|` and `Σ export` over the pixels of `shape`.
fn coverage_difference(
    shape: &Shape,
    worker: &mut WorkerCtx<rand_chacha::ChaCha8Rng>,
) -> (f64, f64) {
    let engine = engine_coverage(shape, worker);
    let exported = exported_coverage(&shape.geometry());
    engine
        .iter()
        .zip(&exported)
        .fold((0.0, 0.0), |(difference, total), (a, b)| {
            (difference + (a - b).abs(), total + b)
        })
}

/// Bound on the coverage the engine and the export disagree on, as a share
/// of the export's.
///
/// tiny-skia samples 4 sub-rows per pixel, so its coverage of a pixel the
/// stroke's edge crosses can be off by up to 1/8 against the exact area:
/// a horizontal stroke, where the engine's area is exact, already differs
/// by 4.9%. The engine stays near that on every curve (5.1% over random
/// curves). The earlier rasterizer, whose coverage `half_width + 0.5 − d`
/// is exact only across axis-aligned strokes, which ended at pixel centres
/// and left gaps on the outside of turns, differed by 9.2% at the same
/// width (9.1% on the arc), and by 23% from the 1 px stroke tiny-skia draws
/// as a hairline.
const COVERAGE_BOUND: f64 = 0.06;

#[test]
fn quadratic_coverage_matches_the_exported_stroke() {
    let (mut worker, round) = make_test_round(W, H, 31);
    let width = Quadratic::STROKE_WIDTHS.0;
    let curve = |x1, y1, x2, y2, x3, y3| {
        Shape::Quadratic(Quadratic {
            x1,
            y1,
            x2,
            y2,
            x3,
            y3,
            width,
            cap: LineCap::Butt,
        })
    };
    let curves = [
        ("horizontal", curve(6.0, 20.3, 30.0, 20.3, 54.0, 20.3)),
        ("diagonal", curve(6.0, 4.0, 26.0, 24.0, 46.0, 44.0)),
        ("shallow", curve(4.0, 10.2, 30.0, 19.7, 58.0, 30.1)),
        ("steep", curve(20.4, 2.0, 27.0, 22.0, 33.3, 45.0)),
        ("arc", curve(6.0, 40.0, 30.0, -10.0, 58.0, 40.0)),
    ];
    for (name, shape) in &curves {
        let (difference, total) = coverage_difference(shape, &mut worker);
        assert!(
            difference <= COVERAGE_BOUND * total,
            "{name}: differs by {:.3} of the exported coverage",
            difference / total
        );
    }
    let (mut difference, mut total) = (0.0, 0.0);
    for _ in 0..SHAPES_PER_KIND {
        let shape = Shape::random(ShapeKind::Quadratic, &mut worker, &round);
        let (d, t) = coverage_difference(&shape, &mut worker);
        difference += d;
        total += t;
    }
    assert!(
        difference <= COVERAGE_BOUND * total,
        "random quadratics: differ by {:.3} of the exported coverage",
        difference / total
    );
}

/// The share of the exported coverage that the engine's differs by, for
/// the named curves of [`quadratic_coverage_matches_the_exported_stroke`]
/// at 2 and 6 px, and for random curves of the default widths, all with
/// `cap`.
fn cap_coverage_differences(cap: LineCap) -> (f64, f64) {
    let (mut worker, round) = make_test_round(W, H, 37);
    worker.quadratic_cap = cap;
    let curve = |x1, y1, x2, y2, x3, y3, width| {
        Shape::Quadratic(Quadratic {
            x1,
            y1,
            x2,
            y2,
            x3,
            y3,
            width,
            cap,
        })
    };
    let mut named = 0.0_f64;
    for width in [2.0, 6.0] {
        for shape in [
            curve(8.0, 20.3, 30.0, 20.3, 52.0, 20.3, width),
            curve(9.0, 7.0, 26.0, 24.0, 43.0, 41.0, width),
            curve(8.0, 10.2, 30.0, 19.7, 54.0, 30.1, width),
            curve(20.4, 6.0, 27.0, 22.0, 33.3, 41.0, width),
            curve(9.0, 38.0, 30.0, -6.0, 55.0, 38.0, width),
        ] {
            let (difference, total) = coverage_difference(&shape, &mut worker);
            named = named.max(difference / total);
        }
    }
    let (mut difference, mut total) = (0.0, 0.0);
    for _ in 0..SHAPES_PER_KIND {
        let shape = Shape::random(ShapeKind::Quadratic, &mut worker, &round);
        let (d, t) = coverage_difference(&shape, &mut worker);
        difference += d;
        total += t;
    }
    (named, difference / total)
}

/// Round and square caps agree with tiny-skia's as well as butt caps do.
/// Measured: the worst named curve differs by 4.9% of the exported
/// coverage with every cap, the random curves by 3.53% with butt caps,
/// 2.92% with round ones and 3.20% with square ones.
#[test]
fn quadratic_caps_match_the_exported_stroke() {
    let (butt_named, butt_random) = cap_coverage_differences(LineCap::Butt);
    assert!(
        butt_named <= 0.05 && butt_random <= 0.036,
        "butt: {butt_named:.4}, {butt_random:.4}"
    );
    for (cap, random_bound) in [(LineCap::Round, 0.03), (LineCap::Square, 0.033)] {
        let (named, random) = cap_coverage_differences(cap);
        assert!(
            named <= 0.05 && random <= random_bound && random <= butt_random,
            "{cap:?}: the worst named curve differs by {named:.4}, random ones by {random:.4}"
        );
    }
}
