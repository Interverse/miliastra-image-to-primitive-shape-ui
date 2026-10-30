use crate::drawing::{Geometry, LineCap, Point};
use crate::error::ParseError;
use crate::scanline::Scanline;
use crate::util::{atan2_degrees, rotate_sc, sin_cos_whole_degrees};
use crate::worker::{SearchRound, WorkerCtx};
use rand::{Rng, RngExt};
use std::str::FromStr;

/// The off-canvas position margin shared by moves, adoption and joint optimisation.
pub(crate) const MARGIN: i32 = 16;

const POSITION_SIGMA: f64 = 16.0;
const ANGLE_SIGMA: f64 = 32.0;
/// The `σ` in pixels of a coarse move of a quadratic curve's stroke width,
/// when its bounds let it vary (`WorkerCtx::quadratic_width`).
const WIDTH_SIGMA: f64 = 1.0;

/// The shape family the search draws from.
///
/// [`ShapeKind::Any`] picks a concrete family at random for each candidate.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShapeKind {
    /// A concrete family chosen at random for each candidate.
    Any,
    /// Triangles.
    Triangle,
    /// Axis-aligned rectangles, the long side at most 8 times the short
    /// one.
    Rectangle,
    /// Axis-aligned ellipses.
    Ellipse,
    /// Circles.
    Circle,
    /// Rectangles rotated about their centre, the long side at most 8 times
    /// the short one.
    RotatedRectangle,
    /// Stroked quadratic Bézier curves.
    Quadratic,
    /// Ellipses rotated about their centre.
    RotatedEllipse,
    /// Simple, strictly convex quadrilaterals, every angle strictly above
    /// 15°.
    Polygon,
}

/// The one table of shape names: every [`ShapeKind`] with its public name, in
/// declaration order, so `NAMES[kind as usize]` is `kind`'s row. `as_str`,
/// `FromStr`, [`ShapeKind::REQUIREMENT`] and the concrete-kind list all derive
/// from it.
const NAMES: [(ShapeKind, &str); 9] = [
    (ShapeKind::Any, "any"),
    (ShapeKind::Triangle, "triangle"),
    (ShapeKind::Rectangle, "rectangle"),
    (ShapeKind::Ellipse, "ellipse"),
    (ShapeKind::Circle, "circle"),
    (ShapeKind::RotatedRectangle, "rotated-rectangle"),
    (ShapeKind::Quadratic, "quadratic"),
    (ShapeKind::RotatedEllipse, "rotated-ellipse"),
    (ShapeKind::Polygon, "polygon"),
];

/// The concrete kinds: every row of [`NAMES`] after [`ShapeKind::Any`].
const CONCRETE_KINDS: [ShapeKind; NAMES.len() - 1] = {
    let mut kinds = [ShapeKind::Any; NAMES.len() - 1];
    let mut index = 0;
    while index < kinds.len() {
        kinds[index] = NAMES[index + 1].0;
        index += 1;
    }
    kinds
};

const REQUIREMENT_PREFIX: &str = "must be one of: ";
const REQUIREMENT_SEPARATOR: &str = ", ";

const REQUIREMENT_LEN: usize = {
    let mut len = REQUIREMENT_PREFIX.len() + REQUIREMENT_SEPARATOR.len() * (NAMES.len() - 1);
    let mut index = 0;
    while index < NAMES.len() {
        // The table is in declaration order; `as_str` indexes it by variant.
        assert!(NAMES[index].0 as usize == index);
        len += NAMES[index].1.len();
        index += 1;
    }
    len
};

/// `REQUIREMENT_PREFIX` followed by the names in [`NAMES`], joined by
/// `REQUIREMENT_SEPARATOR`.
const REQUIREMENT_BYTES: [u8; REQUIREMENT_LEN] = {
    const fn append(bytes: &mut [u8; REQUIREMENT_LEN], at: usize, part: &str) -> usize {
        let part = part.as_bytes();
        let mut index = 0;
        while index < part.len() {
            bytes[at + index] = part[index];
            index += 1;
        }
        at + part.len()
    }

    let mut bytes = [0; REQUIREMENT_LEN];
    let mut at = append(&mut bytes, 0, REQUIREMENT_PREFIX);
    let mut index = 0;
    while index < NAMES.len() {
        if index > 0 {
            at = append(&mut bytes, at, REQUIREMENT_SEPARATOR);
        }
        at = append(&mut bytes, at, NAMES[index].1);
        index += 1;
    }
    bytes
};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Shape {
    Triangle(Triangle),
    Rectangle(Rectangle),
    Ellipse(Ellipse),
    Circle(Circle),
    RotatedRectangle(RotatedRectangle),
    Quadratic(Quadratic),
    RotatedEllipse(RotatedEllipse),
    Polygon(Polygon),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Triangle {
    pub(crate) x1: i32,
    pub(crate) y1: i32,
    pub(crate) x2: i32,
    pub(crate) y2: i32,
    pub(crate) x3: i32,
    pub(crate) y3: i32,
}

/// The pixels `x1..=x2` × `y1..=y2`, the corners in either order, its long
/// side at most [`MAX_ASPECT`] (8) times the short one
/// ([`Self::is_valid`]), as a rotated rectangle's, so that it reads as a
/// rectangle and not a line.
///
/// Measured with the engine runner (seed 42, `--refine final` with the
/// refit pass, the RMSE of the PNG at the working size), the cap made the
/// median over the corpus 2.2% worse at 50 steps, 2.0% at 100 and 1.0% at
/// 200 for rectangles, the synthetic shapes 5–9%; for `any` the median
/// changed by −2.3%, −0.5% and −1.4%, but its synthetic shapes got 7%,
/// 35% and 72% worse. The SVG size did not change, nor did the greedy
/// search's time (0.95–0.98×); with the refit pass the time was
/// 1.07–1.14× on one run each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rectangle {
    pub(crate) x1: i32,
    pub(crate) y1: i32,
    pub(crate) x2: i32,
    pub(crate) y2: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ellipse {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) rx: i32,
    pub(crate) ry: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Circle {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) r: i32,
}

/// A rectangle of `sx` × `sy` rotated by `angle` degrees about `(x, y)`,
/// its long side at most [`MAX_ASPECT`] (8) times the short one
/// ([`Self::is_valid`]), so that it reads as a rectangle and not a line.
///
/// The cap costs quality mostly on fine detail. Measured with the engine
/// runner (seed 42, `--refine final`, the RMSE of the PNG at the working
/// size), it made the synthetic-texture rotated-rectangle result 39% worse
/// at 50 steps, 23% at 100 and 6.5% at 200, while the median over the
/// corpus got 0.3%, 1.2% and 0.7% worse. Go's `primitive` caps the ratio
/// at 1:5; an earlier measurement of that cap, without the refit pass,
/// found the synthetic-texture score 44% worse at 100 steps and 20% at 200.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RotatedRectangle {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) sx: i32,
    pub(crate) sy: i32,
    pub(crate) angle: i32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Quadratic {
    pub(crate) x1: f64,
    pub(crate) y1: f64,
    pub(crate) x2: f64,
    pub(crate) y2: f64,
    pub(crate) x3: f64,
    pub(crate) y3: f64,
    pub(crate) width: f64,
    /// How the stroke ends: the worker's `quadratic_cap` when the curve
    /// was drawn, never moved.
    pub(crate) cap: LineCap,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RotatedEllipse {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) rx: f64,
    pub(crate) ry: f64,
    pub(crate) angle: f64,
}

/// A polygon through `(x[i], y[i])` for `i < order`; the search makes
/// quadrilaterals. It is simple and strictly convex with every angle
/// strictly above 15° ([`Self::is_valid`]), so that it reads as a polygon.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Polygon {
    pub(crate) order: usize,
    pub(crate) x: [f64; 4],
    pub(crate) y: [f64; 4],
}

impl Shape {
    #[must_use]
    pub(crate) fn random<R: Rng>(
        kind: ShapeKind,
        worker: &mut WorkerCtx<R>,
        round: &SearchRound<'_>,
    ) -> Self {
        let kind = match kind {
            ShapeKind::Any => {
                ShapeKind::all_kinds()[worker.rng.random_range(0..ShapeKind::all_kinds().len())]
            }
            other => other,
        };

        match kind {
            ShapeKind::Triangle => {
                #[cfg(feature = "asset-triangle")]
                { Self::Polygon(Polygon::random(worker, round, 3)) }
                #[cfg(not(feature = "asset-triangle"))]
                { Self::Triangle(Triangle::random(worker, round)) }
            },
            ShapeKind::Rectangle => Self::Rectangle(Rectangle::random(worker, round)),
            ShapeKind::Ellipse => Self::Ellipse(Ellipse::random(worker, round)),
            ShapeKind::Circle => Self::Circle(Circle::random(worker, round)),
            ShapeKind::RotatedRectangle => {
                Self::RotatedRectangle(RotatedRectangle::random(worker, round))
            }
            ShapeKind::Quadratic => Self::Quadratic(Quadratic::random(worker, round)),
            ShapeKind::RotatedEllipse => {
                Self::RotatedEllipse(RotatedEllipse::random(worker, round))
            }
            ShapeKind::Polygon => Self::Polygon(Polygon::random(worker, round, 4)),
            ShapeKind::Any => unreachable!("ShapeKind::Any is resolved before shape creation"),
        }
    }

    /// Conservative, inclusive pixel bounds, clamped to the canvas. An
    /// inverted interval is empty. This never rasterizes the shape.
    ///
    /// Triangles and polygons stay inside their vertex extrema; one extra
    /// pixel covers integer edge rounding, AA and the coarse triangle's
    /// +0.25 centre offset. Rectangles use their exact inclusive bounds and
    /// the coarse rasterizer's half-open mapping. Binary ellipses/circles
    /// stay inside their radii; the coarse +0.25 centre offset fits within
    /// the extra pixel. Rotated rectangles use the rasterizer's exact
    /// rotated corners, with a pixel for outward rounding.
    ///
    /// Quadratic segments stay in the control points' convex hull. Square
    /// caps extend endpoints by half the stroke width. The stroke grid's
    /// margin comes from the rasterizer, with the cap extension and an
    /// extra pixel for rounding. Rotated ellipses use the rasterizer's axis
    /// bounds, plus one pixel for AA and floating-point rounding.
    /// Coarse continuous coordinates and widths are halved before margins.
    pub(crate) fn candidate_rectangle(
        &self,
        width: i32,
        height: i32,
        coarse: bool,
    ) -> (i32, i32, i32, i32) {
        let scale = if coarse { 0.5 } else { 1.0 };
        let points = |points: &[(f64, f64)], margin: f64| {
            let (mut x1, mut y1, mut x2, mut y2) = (
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            );
            for &(x, y) in points {
                x1 = x1.min(x * scale);
                y1 = y1.min(y * scale);
                x2 = x2.max(x * scale);
                y2 = y2.max(y * scale);
            }
            (
                ((x1 - margin).floor() as i32).max(0),
                ((y1 - margin).floor() as i32).max(0),
                ((x2 + margin).ceil() as i32).min(width - 1),
                ((y2 + margin).ceil() as i32).min(height - 1),
            )
        };
        let ellipse_margin = if coarse { 1.0 } else { 0.0 };
        let ellipse = |x: i32, y: i32, rx: i32, ry: i32| {
            let (x, y, rx, ry) = (f64::from(x), f64::from(y), f64::from(rx), f64::from(ry));
            points(&[(x - rx, y - ry), (x + rx, y + ry)], ellipse_margin)
        };
        match self {
            Self::Triangle(s) => points(
                &[
                    (f64::from(s.x1), f64::from(s.y1)),
                    (f64::from(s.x2), f64::from(s.y2)),
                    (f64::from(s.x3), f64::from(s.y3)),
                ],
                1.0,
            ),
            Self::Rectangle(s) => {
                if coarse {
                    s.coarse_bounds(width, height)
                } else {
                    let (x1, y1, x2, y2) = s.bounds();
                    (x1.max(0), y1.max(0), x2.min(width - 1), y2.min(height - 1))
                }
            }
            Self::Ellipse(s) => ellipse(s.x, s.y, s.rx, s.ry),
            Self::Circle(s) => ellipse(s.x, s.y, s.r, s.r),
            Self::RotatedRectangle(s) => points(&s.corners(), 1.0),
            Self::Quadratic(s) => {
                let half_width = (s.width * scale) / 2.0;
                // Square caps extend the hull by half_width; one extra
                // pixel covers rounding of their extended endpoints.
                points(
                    &[(s.x1, s.y1), (s.x2, s.y2), (s.x3, s.y3)],
                    crate::raster::stroke_grid_margin(half_width) + half_width + 1.0,
                )
            }
            Self::RotatedEllipse(s) => {
                let (sin, cos) = crate::util::sin_cos_degrees(s.angle);
                let (rx, ry) = (s.rx * scale, s.ry * scale);
                let (x1, x2) =
                    crate::raster::rotated_ellipse_axis_bounds(s.x * scale, rx, ry, cos, sin);
                let (y1, y2) =
                    crate::raster::rotated_ellipse_axis_bounds(s.y * scale, rx, ry, sin, cos);
                // The shared bounds include the rasterizer's sampling
                // margin; another pixel covers AA and numerical rounding.
                (
                    (x1 - 1).max(0),
                    (y1 - 1).max(0),
                    (x2 + 1).min(width - 1),
                    (y2 + 1).min(height - 1),
                )
            }
            Self::Polygon(s) => points(
                &std::array::from_fn::<_, 4, _>(|i| (s.x[i], s.y[i]))[..s.order],
                1.0,
            ),
        }
    }

    pub(crate) fn rasterize<'a, R: Rng>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        match self {
            Self::Triangle(shape) => shape.rasterize(worker),
            Self::Rectangle(shape) => shape.rasterize(worker),
            Self::Ellipse(shape) => shape.rasterize(worker),
            Self::Circle(shape) => shape.rasterize(worker),
            Self::RotatedRectangle(shape) => shape.rasterize(worker),
            Self::Quadratic(shape) => shape.rasterize(worker),
            Self::RotatedEllipse(shape) => shape.rasterize(worker),
            Self::Polygon(shape) => shape.rasterize(worker),
        }
    }

    /// Rasterizes the shape scaled by one half, onto a canvas of the
    /// worker's size, which must be the 2× downsample of the canvas the
    /// shape lives on (see [`crate::coarse`]).
    ///
    /// Every continuous coordinate (see [`Shape::geometry`]) maps to half
    /// its value, and each kind keeps the coverage rule of its own
    /// rasterizer: the binary kinds fill the coarse pixels whose centres the
    /// scaled shape covers, the anti-aliased kinds stay anti-aliased.
    pub(crate) fn rasterize_coarse<'a, R: Rng>(
        &self,
        worker: &'a mut WorkerCtx<R>,
    ) -> &'a [Scanline] {
        let half = |x: f64| x / 2.0;
        let centre = |v: i32| half(f64::from(v) + 0.5);
        let convex = |worker: &'a mut WorkerCtx<R>, vertices: &[(f64, f64)]| {
            worker.lines.clear();
            crate::raster::fill_convex_at_pixel_centres(
                &mut worker.lines,
                vertices,
                worker.width,
                worker.height,
            );
            &worker.lines[..]
        };
        match self {
            Self::Triangle(shape) => convex(
                worker,
                &[
                    (centre(shape.x1), centre(shape.y1)),
                    (centre(shape.x2), centre(shape.y2)),
                    (centre(shape.x3), centre(shape.y3)),
                ],
            ),
            Self::Rectangle(shape) => {
                let (x1, y1, x2, y2) = shape.coarse_bounds(worker.width, worker.height);
                worker.lines.clear();
                if x1 <= x2 {
                    worker.lines.extend((y1..=y2).map(|y| Scanline {
                        y,
                        x1,
                        x2,
                        alpha: 0xFFFF,
                    }));
                }
                &worker.lines
            }
            Self::Ellipse(shape) => {
                let (rx, ry) = (f64::from(shape.rx), f64::from(shape.ry));
                fill_ellipse_at_pixel_centres(
                    worker,
                    centre(shape.x),
                    centre(shape.y),
                    half(rx),
                    half(ry),
                )
            }
            Self::Circle(shape) => {
                let r = half(f64::from(shape.r));
                fill_ellipse_at_pixel_centres(worker, centre(shape.x), centre(shape.y), r, r)
            }
            Self::RotatedRectangle(shape) => {
                convex(worker, &shape.corners().map(|(x, y)| (half(x), half(y))))
            }
            Self::Quadratic(shape) => crate::raster::stroke_quadratic_direct(
                worker,
                half(shape.x1),
                half(shape.y1),
                half(shape.x2),
                half(shape.y2),
                half(shape.x3),
                half(shape.y3),
                half(shape.width) / 2.0,
                shape.cap,
            ),
            Self::RotatedEllipse(shape) => {
                crate::raster::fill_rotated_ellipse_direct(
                    &mut worker.lines,
                    &mut worker.rows,
                    half(shape.x),
                    half(shape.y),
                    half(shape.rx),
                    half(shape.ry),
                    shape.angle,
                    worker.width,
                    worker.height,
                );
                &worker.lines
            }
            Self::Polygon(shape) => {
                let vertices: [(f64, f64); 4] =
                    std::array::from_fn(|i| (half(shape.x[i]), half(shape.y[i])));
                // Halving is exact, so the halved polygon is convex too.
                crate::raster::fill_polygon_direct(
                    &mut worker.lines,
                    &mut worker.rows,
                    &vertices[..shape.order],
                    worker.width,
                    worker.height,
                    true,
                );
                &worker.lines
            }
        }
    }

    /// Moves the shape by a move of size `step`.
    pub(crate) fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        match self {
            Self::Triangle(shape) => shape.mutate(worker, step),
            Self::Rectangle(shape) => shape.mutate(worker, step),
            Self::Ellipse(shape) => shape.mutate(worker, step),
            Self::Circle(shape) => shape.mutate(worker, step),
            Self::RotatedRectangle(shape) => shape.mutate(worker, step),
            Self::Quadratic(shape) => shape.mutate(worker, step),
            Self::RotatedEllipse(shape) => shape.mutate(worker, step),
            Self::Polygon(shape) => shape.mutate(worker, step),
        }
    }

    /// The shape's geometry in continuous canvas coordinates, where pixel
    /// `(i, j)` is the unit square `[i, i + 1) × [j, j + 1)`.
    ///
    /// This is the single place where the engine's pixel convention is
    /// mapped onto output geometry. Each mapping follows the kind's
    /// working-resolution rasterizer, so the geometry covers the pixels the
    /// engine optimised.
    #[must_use]
    pub(crate) fn geometry(&self) -> Geometry {
        match self {
            Self::Triangle(shape) => shape.geometry(),
            Self::Rectangle(shape) => shape.geometry(),
            Self::Ellipse(shape) => ellipse_geometry(shape.x, shape.y, shape.rx, shape.ry),
            Self::Circle(shape) => ellipse_geometry(shape.x, shape.y, shape.r, shape.r),
            Self::RotatedRectangle(shape) => shape.geometry(),
            Self::Quadratic(shape) => shape.geometry(),
            Self::RotatedEllipse(shape) => shape.geometry(),
            Self::Polygon(shape) => shape.geometry(),
        }
    }

    /// This shape moved to `geometry`, a joint optimisation result for it
    /// in [`Self::geometry`]'s coordinates, as the engine's shape of the
    /// same family; `None` if it does not convert into a valid one. See
    /// `Model::adopt`, the only caller, for the rules.
    ///
    /// Computes with `+ − × ÷`, `sqrt`, comparisons and `round` only, the
    /// arithmetic rule of [`crate::joint`], so native and WebAssembly
    /// builds convert alike. A rotated rectangle recovers its centre, sides
    /// and angle from its corners ([`RotatedRectangle::from_corners`]),
    /// rounded. An ellipse or a circle that moved rounds to its integer
    /// centre and radii, a rotated ellipse takes the continuous ones and
    /// the rotation, which the joint optimisation's export computes by
    /// [`atan2_degrees`]; a radius under 1 is `None`. An unmoved quadratic
    /// keeps its geometry.
    pub(crate) fn adopted(
        &self,
        geometry: &Geometry,
        canvas_width: u32,
        canvas_height: u32,
    ) -> Option<Self> {
        let finite = match geometry {
            Geometry::Polygon(points) => points.iter().all(|p| p.x.is_finite() && p.y.is_finite()),
            Geometry::Rect {
                x,
                y,
                width,
                height,
            } => [x, y, width, height].iter().all(|v| v.is_finite()),
            Geometry::Ellipse {
                cx,
                cy,
                rx,
                ry,
                rotation,
            } => [cx, cy, rx, ry, rotation].iter().all(|v| v.is_finite()),
            Geometry::Quadratic {
                start,
                control,
                end,
                width,
                ..
            } => [start.x, start.y, control.x, control.y, end.x, end.y, *width]
                .iter()
                .all(|v| v.is_finite()),
        };
        if !finite {
            return None;
        }
        let shape = match (self, geometry) {
            (Self::Triangle(_), Geometry::Polygon(points)) if points.len() == 3 => {
                Polygon::through(points).map(Self::Polygon)
            }
            (Self::Polygon(polygon), Geometry::Polygon(points))
                if points.len() == polygon.order =>
            {
                Polygon::through(points).map(Self::Polygon)
            }
            (
                Self::Rectangle(_),
                &Geometry::Rect {
                    x,
                    y,
                    width,
                    height,
                },
            ) => {
                // The pixels `x1..=x2` cover `[x1, x2 + 1)`.
                let rectangle = Rectangle {
                    x1: lattice(x)?,
                    y1: lattice(y)?,
                    x2: lattice(x + width)? - 1,
                    y2: lattice(y + height)? - 1,
                };
                (rectangle.x2 >= rectangle.x1
                    && rectangle.y2 >= rectangle.y1
                    && Self::Rectangle(rectangle).in_domain(canvas_width, canvas_height)
                    && rectangle.is_valid())
                .then_some(Self::Rectangle(rectangle))
            }
            (Self::RotatedRectangle(_), Geometry::Polygon(points)) if points.len() == 4 => {
                RotatedRectangle::from_corners(
                    points,
                    f64::from(canvas_width.max(canvas_height)) + f64::from(MARGIN),
                )
                .map(Self::RotatedRectangle)
            }
            // The integer centre is a pixel centre, 0.5 below the
            // geometry's ([`ellipse_geometry`]).
            (
                Self::Ellipse(_),
                &Geometry::Ellipse {
                    cx,
                    cy,
                    rx,
                    ry,
                    rotation: 0.0,
                },
            ) => {
                let ellipse = Ellipse {
                    x: lattice(cx - 0.5)?,
                    y: lattice(cy - 0.5)?,
                    rx: lattice(rx)?,
                    ry: lattice(ry)?,
                };
                (ellipse.rx >= 1 && ellipse.ry >= 1).then_some(Self::Ellipse(ellipse))
            }
            (
                Self::Circle(_),
                &Geometry::Ellipse {
                    cx,
                    cy,
                    rx,
                    ry,
                    rotation,
                },
            ) if rotation == 0.0 && rx == ry => {
                let circle = Circle {
                    x: lattice(cx - 0.5)?,
                    y: lattice(cy - 0.5)?,
                    r: lattice(rx)?,
                };
                (circle.r >= 1).then_some(Self::Circle(circle))
            }
            (
                Self::RotatedEllipse(_),
                &Geometry::Ellipse {
                    cx,
                    cy,
                    rx,
                    ry,
                    rotation,
                },
            ) => (rx >= 1.0 && ry >= 1.0).then_some(Self::RotatedEllipse(RotatedEllipse {
                x: cx,
                y: cy,
                rx,
                ry,
                angle: rotation,
            })),
            (Self::Quadratic(_), geometry) => (*geometry == self.geometry()).then(|| self.clone()),
            _ => None,
        }?;
        shape
            .in_domain(canvas_width, canvas_height)
            .then_some(shape)
    }

    /// Whether the converted shape stays within the canvas's move domain.
    fn in_domain(&self, width: u32, height: u32) -> bool {
        let margin = f64::from(MARGIN);
        let position = |x: f64, y: f64| {
            (-margin..=f64::from(width - 1) + margin).contains(&x)
                && (-margin..=f64::from(height - 1) + margin).contains(&y)
        };
        // Joint positions use pixel-centre coordinates, 0.5 below their
        // exported continuous coordinates. Keep the union with the
        // continuous moves' bounds, which can reach -MARGIN themselves.
        let continuous_position = |x: f64, y: f64| {
            (-margin..=f64::from(width - 1) + margin + 0.5).contains(&x)
                && (-margin..=f64::from(height - 1) + margin + 0.5).contains(&y)
        };
        // Well above any size the moves produce (a random start of at most
        // 33 px, moves clamped to the side), far below what overflows the
        // rasterizers.
        let size =
            |value: f64| (0.0..=4.0 * (f64::from(width.max(height)) + margin)).contains(&value);
        match self {
            Self::Triangle(t) => [(t.x1, t.y1), (t.x2, t.y2), (t.x3, t.y3)]
                .iter()
                .all(|&(x, y)| position(f64::from(x), f64::from(y))),
            Self::Polygon(p) => (0..p.order).all(|i| continuous_position(p.x[i], p.y[i])),
            Self::Rectangle(r) => {
                let (x1, y1, x2, y2) = r.bounds();
                position(f64::from(x1), f64::from(y1))
                    && position(f64::from(x2), f64::from(y2))
                    && size(f64::from(x2 - x1 + 1))
                    && size(f64::from(y2 - y1 + 1))
            }
            Self::RotatedRectangle(r) => {
                position(f64::from(r.x), f64::from(r.y))
                    && size(f64::from(r.sx))
                    && size(f64::from(r.sy))
            }
            Self::Ellipse(e) => {
                position(f64::from(e.x), f64::from(e.y))
                    && size(f64::from(e.rx))
                    && size(f64::from(e.ry))
            }
            Self::Circle(c) => position(f64::from(c.x), f64::from(c.y)) && size(f64::from(c.r)),
            Self::RotatedEllipse(e) => continuous_position(e.x, e.y) && size(e.rx) && size(e.ry),
            Self::Quadratic(q) => {
                [(q.x1, q.y1), (q.x2, q.y2), (q.x3, q.y3)]
                    .iter()
                    .all(|&(x, y)| position(x, y))
                    && size(q.width)
            }
        }
    }
}

/// `value` rounded to the nearest integer, half away from zero, if that is
/// well inside `i32`.
fn lattice(value: f64) -> Option<i32> {
    let rounded = value.round();
    (rounded.abs() < f64::from(1 << 30)).then_some(rounded as i32)
}

impl ShapeKind {
    /// What the `shape` option accepts, phrased to follow the option name:
    /// `"must be one of: any, triangle, ..."`, listing every public name.
    pub const REQUIREMENT: &'static str = match std::str::from_utf8(&REQUIREMENT_BYTES) {
        Ok(requirement) => requirement,
        Err(_) => panic!("shape names are UTF-8"),
    };

    /// The public name: `"any"`, `"triangle"`, `"rotated-rectangle"`, ...
    /// [`FromStr`] parses it back.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        NAMES[self as usize].1
    }

    /// Whether the random phase of a search for this kind ranks its
    /// candidates at half resolution (see [`crate::coarse`]). Rectangles,
    /// rotated rectangles and triangles rasterize so cheaply that it saved
    /// them almost no time and cost quality, and the random phase of
    /// quadratic curves is too small a share of their search to gain;
    /// [`ShapeKind::Any`] ranks candidates of every kind coarsely.
    pub(crate) const fn ranks_coarsely(self) -> bool {
        matches!(
            self,
            Self::Any | Self::Circle | Self::Ellipse | Self::RotatedEllipse | Self::Polygon
        )
    }

    /// Every kind except [`ShapeKind::Any`], in declaration order.
    pub(crate) const fn all_kinds() -> &'static [ShapeKind] {
        &CONCRETE_KINDS
    }
}

impl FromStr for ShapeKind {
    type Err = ParseError;

    /// Parses a public name (see [`ShapeKind::as_str`]); anything else is an
    /// error whose message is `"shape {REQUIREMENT}"`.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        NAMES
            .iter()
            .find(|(_, name)| *name == value)
            .map(|&(kind, _)| kind)
            .ok_or_else(|| ParseError::new(format!("shape {}", Self::REQUIREMENT)))
    }
}

impl Triangle {
    /// Integer vertices are pixel centres (the rasterizer samples each row at
    /// its integer `y`), so they map to `v + 0.5`.
    fn geometry(&self) -> Geometry {
        Geometry::Polygon(vec![
            pixel_centre(self.x1, self.y1),
            pixel_centre(self.x2, self.y2),
            pixel_centre(self.x3, self.y3),
        ])
    }

    #[cfg_attr(feature = "asset-triangle", allow(dead_code))]
    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x1, y1) = worker.sample_xy(round);
        let x2 = x1 + worker.rng.random_range(0..31) - 15;
        let y2 = y1 + worker.rng.random_range(0..31) - 15;
        let x3 = x1 + worker.rng.random_range(0..31) - 15;
        let y3 = y1 + worker.rng.random_range(0..31) - 15;
        let mut triangle = Self {
            x1,
            y1,
            x2,
            y2,
            x3,
            y3,
        };
        triangle.mutate(worker, Step::Coarse);
        triangle
    }

    /// Whether every angle is strictly above 15° ([`is_legible_convex`]).
    /// The products of integer coordinates are exact, and no lattice
    /// triangle has an angle of exactly 15°.
    #[must_use]
    pub(crate) fn is_valid(&self) -> bool {
        is_legible_convex(
            &[
                (f64::from(self.x1), f64::from(self.y1)),
                (f64::from(self.x2), f64::from(self.y2)),
                (f64::from(self.x3), f64::from(self.y3)),
            ],
            TAN_MIN_ANGLE,
        )
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        worker.lines.clear();
        rasterize_triangle(
            [(self.x1, self.y1), (self.x2, self.y2), (self.x3, self.y3)],
            worker.height,
            &mut worker.lines,
        );
        crate::scanline::crop_scanlines(&mut worker.lines, worker.width, worker.height);
        &worker.lines
    }

    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        loop {
            match worker.rng.random_range(0..3) {
                0 => {
                    let (dx1, dy1) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.x1 = (self.x1 + dx1).clamp(-MARGIN, worker.width - 1 + MARGIN);
                    self.y1 = (self.y1 + dy1).clamp(-MARGIN, worker.height - 1 + MARGIN);
                }
                1 => {
                    let (dx2, dy2) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.x2 = (self.x2 + dx2).clamp(-MARGIN, worker.width - 1 + MARGIN);
                    self.y2 = (self.y2 + dy2).clamp(-MARGIN, worker.height - 1 + MARGIN);
                }
                _ => {
                    let (dx3, dy3) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.x3 = (self.x3 + dx3).clamp(-MARGIN, worker.width - 1 + MARGIN);
                    self.y3 = (self.y3 + dy3).clamp(-MARGIN, worker.height - 1 + MARGIN);
                }
            }
            if self.is_valid() {
                break;
            }
        }
    }
}

impl Rectangle {
    /// Inclusive coarse bounds, clamped to the canvas. Coarse pixel `X`
    /// has its centre at full-resolution `2X + 1`, which lies in
    /// `[x1, x2 + 1)` for `X` in `x1 >> 1..=((x2 + 1) >> 1) - 1`.
    fn coarse_bounds(&self, width: i32, height: i32) -> (i32, i32, i32, i32) {
        let (x1, y1, x2, y2) = self.bounds();
        (
            (x1 >> 1).max(0),
            (y1 >> 1).max(0),
            (((x2 + 1) >> 1) - 1).min(width - 1),
            (((y2 + 1) >> 1) - 1).min(height - 1),
        )
    }

    /// Inclusive pixel bounds `x1..=x2` cover `[x1, x2 + 1)`.
    fn geometry(&self) -> Geometry {
        let (x1, y1, x2, y2) = self.bounds();
        Geometry::Rect {
            x: f64::from(x1),
            y: f64::from(y1),
            width: f64::from(x2 - x1 + 1),
            height: f64::from(y2 - y1 + 1),
        }
    }

    /// A random rectangle from a sampled point, its opposite corner drawn
    /// again until the rectangle keeps the aspect-ratio cap. Offsets of 1
    /// on both axes always keep it, so the loop ends.
    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x1, y1) = worker.sample_xy(round);
        loop {
            let x2 = (x1 + worker.rng.random_range(1..33)).clamp(0, worker.width - 1);
            let y2 = (y1 + worker.rng.random_range(1..33)).clamp(0, worker.height - 1);
            let rect = Self { x1, y1, x2, y2 };
            if rect.is_valid() {
                return rect;
            }
        }
    }

    /// Whether the long side is at most [`MAX_ASPECT`] times the short one,
    /// in pixels.
    #[must_use]
    pub(crate) fn is_valid(&self) -> bool {
        let (x1, y1, x2, y2) = self.bounds();
        let (width, height) = (x2 - x1 + 1, y2 - y1 + 1);
        within_aspect(width, height)
    }

    /// The corners in order: `x1 <= x2` and `y1 <= y2`.
    #[must_use]
    pub(crate) fn bounds(&self) -> (i32, i32, i32, i32) {
        let (mut x1, mut y1, mut x2, mut y2) = (self.x1, self.y1, self.x2, self.y2);
        if x1 > x2 {
            std::mem::swap(&mut x1, &mut x2);
        }
        if y1 > y2 {
            std::mem::swap(&mut y1, &mut y2);
        }
        (x1, y1, x2, y2)
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        let (x1, y1, x2, y2) = self.bounds();
        worker.lines.clear();
        for y in y1..=y2 {
            worker.lines.push(Scanline {
                y,
                x1,
                x2,
                alpha: 0xFFFF,
            });
        }
        &worker.lines
    }

    /// Moves one corner. A move that breaks the aspect-ratio cap
    /// ([`Self::is_valid`]) is undone and a new one drawn, as for a rotated
    /// rectangle. From a valid rectangle, shortening its long side by one
    /// pixel, or moving a corner of a square by one pixel, keeps the cap,
    /// and such a move has a positive probability at every step size, so
    /// the loop ends.
    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        debug_assert!(self.is_valid(), "{self:?}");
        let start = *self;
        loop {
            match worker.rng.random_range(0..2) {
                0 => {
                    let (dx1, dy1) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.x1 = (self.x1 + dx1).clamp(0, worker.width - 1);
                    self.y1 = (self.y1 + dy1).clamp(0, worker.height - 1);
                }
                _ => {
                    let (dx2, dy2) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.x2 = (self.x2 + dx2).clamp(0, worker.width - 1);
                    self.y2 = (self.y2 + dy2).clamp(0, worker.height - 1);
                }
            }
            if self.is_valid() {
                return;
            }
            *self = start;
        }
    }
}

impl Ellipse {
    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x, y) = worker.sample_xy(round);
        Self {
            x,
            y,
            rx: worker.rng.random_range(1..33),
            ry: worker.rng.random_range(1..33),
        }
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        rasterize_ellipse(worker, self.x, self.y, self.rx, self.ry)
    }

    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        match worker.rng.random_range(0..3) {
            0 => {
                let (dx, dy) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                self.x = (self.x + dx).clamp(0, worker.width - 1);
                self.y = (self.y + dy).clamp(0, worker.height - 1);
            }
            1 => {
                self.rx = (self.rx + step.offset(&mut worker.rng, POSITION_SIGMA))
                    .clamp(1, worker.width - 1)
            }
            _ => {
                self.ry = (self.ry + step.offset(&mut worker.rng, POSITION_SIGMA))
                    .clamp(1, worker.height - 1)
            }
        }
    }
}

impl Circle {
    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x, y) = worker.sample_xy(round);
        Self {
            x,
            y,
            r: worker.rng.random_range(1..33),
        }
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        rasterize_ellipse(worker, self.x, self.y, self.r, self.r)
    }

    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        match worker.rng.random_range(0..3) {
            0 => {
                let (dx, dy) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                self.x = (self.x + dx).clamp(0, worker.width - 1);
                self.y = (self.y + dy).clamp(0, worker.height - 1);
            }
            _ => {
                self.r = (self.r + step.offset(&mut worker.rng, POSITION_SIGMA))
                    .clamp(1, worker.width.min(worker.height) - 1)
            }
        }
    }
}

impl RotatedRectangle {
    /// `(x, y)` is a continuous coordinate, and the rasterizer fills the
    /// pixels whose centres lie inside the exact rotated corners.
    fn geometry(&self) -> Geometry {
        Geometry::Polygon(
            self.corners()
                .into_iter()
                .map(|(x, y)| Point::new(x, y))
                .collect(),
        )
    }

    /// The exact corners, rotated by `angle` degrees about `(x, y)`, by
    /// [`sin_cos_whole_degrees`], the table of
    /// [`crate::util::sin_cos_degrees`], so that every target computes the
    /// same ones; whole quarter turns are exact.
    fn corners(&self) -> [(f64, f64); 4] {
        let half_x = f64::from(self.sx) / 2.0;
        let half_y = f64::from(self.sy) / 2.0;
        let (sin_a, cos_a) = sin_cos_whole_degrees(self.angle);
        [
            (-half_x, -half_y),
            (half_x, -half_y),
            (half_x, half_y),
            (-half_x, half_y),
        ]
        .map(|(x, y)| {
            let (rx, ry) = rotate_sc(x, y, sin_a, cos_a);
            (rx + f64::from(self.x), ry + f64::from(self.y))
        })
    }

    /// A random rectangle near a sampled point, its sides drawn from
    /// `1..=32` again until they keep the aspect-ratio cap, then moved once.
    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x, y) = worker.sample_xy(round);
        let (sx, sy) = loop {
            let sx = worker.rng.random_range(1..33);
            let sy = worker.rng.random_range(1..33);
            if within_aspect(sx, sy) {
                break (sx, sy);
            }
        };
        let mut rect = Self {
            x,
            y,
            sx,
            sy,
            angle: worker.rng.random_range(0..360),
        };
        rect.mutate(worker, Step::Coarse);
        rect
    }

    /// Whether the long side is at most [`MAX_ASPECT`] times the short one.
    #[must_use]
    pub(crate) fn is_valid(&self) -> bool {
        within_aspect(self.sx, self.sy)
    }

    /// The rectangle whose corners, in [`Self::corners`]' order, are about
    /// `corners`: the centre is their mean, `sx` the length of the side
    /// from the first to the second, `sy` of the next, and `angle` the
    /// direction of the first side in degrees, in `0..360`, each rounded.
    /// `None` if a side rounds to 0 or the rectangle breaks the
    /// aspect-ratio cap.
    ///
    /// The angle comes from [`atan2_degrees`] and the sides from `sqrt`,
    /// never from the platform's `atan2` or `hypot`, whose last bit can
    /// differ between platforms.
    fn from_corners(corners: &[Point], max_side: f64) -> Option<Self> {
        let [a, b, c, d] = corners else {
            return None;
        };
        let side = |p: &Point, q: &Point| {
            let (dx, dy) = (q.x - p.x, q.y - p.y);
            (dx * dx + dy * dy).sqrt()
        };
        let angle = atan2_degrees(b.y - a.y, b.x - a.x).round();
        let rectangle = Self {
            x: lattice((a.x + b.x + c.x + d.x) / 4.0)?,
            y: lattice((a.y + b.y + c.y + d.y) / 4.0)?,
            sx: lattice(side(a, b))?,
            sy: lattice(side(b, c))?,
            angle: lattice(angle)?.rem_euclid(360),
        };
        (rectangle.sx >= 1
            && rectangle.sy >= 1
            && f64::from(rectangle.sx) <= max_side
            && f64::from(rectangle.sy) <= max_side
            && rectangle.is_valid())
        .then_some(rectangle)
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        worker.lines.clear();
        crate::raster::fill_convex_at_pixel_centres(
            &mut worker.lines,
            &self.corners(),
            worker.width,
            worker.height,
        );
        &worker.lines
    }

    /// Moves the centre, the sides or the angle. A move that breaks the
    /// aspect-ratio cap ([`Self::is_valid`]) is undone and a new one drawn,
    /// so the moves are the unconstrained ones restricted to valid
    /// rectangles. Only a move of the sides can break it, and from a valid
    /// rectangle every other move keeps it, so the loop ends.
    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        debug_assert!(self.is_valid(), "{self:?}");
        let start = *self;
        loop {
            match worker.rng.random_range(0..3) {
                0 => {
                    let (dx, dy) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.x = (self.x + dx).clamp(0, worker.width - 1);
                    self.y = (self.y + dy).clamp(0, worker.height - 1);
                }
                1 => {
                    let (dsx, dsy) = step.offsets(&mut worker.rng, POSITION_SIGMA);
                    self.sx = (self.sx + dsx).clamp(1, worker.width - 1);
                    self.sy = (self.sy + dsy).clamp(1, worker.height - 1);
                }
                _ => self.angle += step.offset(&mut worker.rng, ANGLE_SIGMA),
            }
            if self.is_valid() {
                return;
            }
            *self = start;
        }
    }
}

impl Quadratic {
    const MUTATE_MARGIN: f64 = MARGIN as f64;
    const MAX_MUTATE_ATTEMPTS: u32 = 6;
    /// The bounds `(min, max)` of the stroke width in working pixels, within
    /// which the search chooses each curve's width: a random curve draws
    /// it uniformly, a move shifts it by a normal step of `σ` 1 px, clamped,
    /// and the refit's climbs scale that step as they scale the positions'.
    ///
    /// The rasterizer covers each pixel by the share of its area under the
    /// stroke, as the exporter draws it, so the colour fit sees the
    /// coverage the output has. The width was first fixed: among the widths
    /// measured with the engine runner (1, 1.5, 2 and 3 px, refit pass
    /// included), wider strokes fit better: 2 px cut the median RMSE of the
    /// working-size PNG by 15% at 100 shapes and 24% at 200 against the
    /// earlier 1 px stroke, 3 px by 26% and 54%. Wider strokes change the
    /// look of the curves more and cost more time, so the width stayed at
    /// 2 px.
    ///
    /// Letting the search choose it between 2 and 6 px cut the median RMSE
    /// against the fixed 2 px (final refit, five images) by 28, 60, 66 and
    /// 49% at 50, 100, 200 and 500 shapes, both paintings by 52% and 50% at
    /// 200 shapes and by 41% and 32% at 500, the texture by 27 to 2%, at
    /// 1.39, 1.32, 1.25 and 1.11 times the time and 3% more SVG bytes. A
    /// fixed 3 px cut 27% at 1.14 times the time; `any` moved by at most 2%.
    ///
    /// The minimum stays at 2 px: tiny-skia draws a stroke at most 1 px
    /// wide as a hairline, thinner than its width on a diagonal, so the PNG
    /// at the working size would disagree with the SVG and every larger
    /// PNG, and a range from 1.5 px gained nothing more; 2 px also keeps
    /// the pixels on the centre line fully covered. The maximum stays at
    /// 6 px: up to 8 px gained 5 to 6 more points on the paintings at 200
    /// shapes for up to 1.52 times the time, and wider strokes change the
    /// look of the curves more.
    pub(crate) const STROKE_WIDTHS: (f64, f64) = (2.0, 6.0);

    /// The stroke rasterizer measures distances in continuous coordinates,
    /// so the control points map unchanged.
    fn geometry(&self) -> Geometry {
        Geometry::Quadratic {
            start: Point::new(self.x1, self.y1),
            control: Point::new(self.x2, self.y2),
            end: Point::new(self.x3, self.y3),
            width: self.width,
            cap: self.cap,
        }
    }

    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x1, y1) = worker.sample_xy_float(round);
        let x2 = x1 + worker.rng.random::<f64>() * 40.0 - 20.0;
        let y2 = y1 + worker.rng.random::<f64>() * 40.0 - 20.0;
        let x3 = x2 + worker.rng.random::<f64>() * 40.0 - 20.0;
        let y3 = y2 + worker.rng.random::<f64>() * 40.0 - 20.0;
        // A fixed width draws nothing, so equal bounds keep the streams of
        // the earlier fixed width.
        let (min, max) = worker.quadratic_width;
        let width = if min < max {
            worker.rng.random_range(min..=max)
        } else {
            min
        };
        let mut quadratic = Self {
            x1,
            y1,
            x2,
            y2,
            x3,
            y3,
            width,
            cap: worker.quadratic_cap,
        };
        quadratic.mutate(worker, Step::Coarse);
        quadratic
    }

    #[must_use]
    pub(crate) fn is_valid(&self) -> bool {
        let dx12 = self.x1 - self.x2;
        let dy12 = self.y1 - self.y2;
        let dx23 = self.x2 - self.x3;
        let dy23 = self.y2 - self.y3;
        let dx13 = self.x1 - self.x3;
        let dy13 = self.y1 - self.y3;
        let d12 = dx12 * dx12 + dy12 * dy12;
        let d23 = dx23 * dx23 + dy23 * dy23;
        let d13 = dx13 * dx13 + dy13 * dy13;
        d13 > d12 && d13 > d23
    }

    /// Repair an endpoint mutation by binary-lerping between the old and new
    /// endpoint positions while the old shape remains a valid anchor.
    ///
    /// Falls back to control-point repair if the old state was also invalid
    /// (e.g. during `random()` initialization).
    ///
    /// `choice`: 0 = p1, 2 = p3.
    fn repair_endpoint(&mut self, old: &Quadratic, choice: u32, width: i32, height: i32) {
        // If the old state was already invalid, endpoint lerp has no valid
        // anchor — fall back to control-point repair.
        if !old.is_valid() {
            self.repair_control_point(width, height);
            return;
        }

        let min_coord = -Self::MUTATE_MARGIN;
        let max_x = f64::from(width - 1) + Self::MUTATE_MARGIN;
        let max_y = f64::from(height - 1) + Self::MUTATE_MARGIN;

        let (old_x, old_y, new_x, new_y) = match choice {
            0 => (old.x1, old.y1, self.x1, self.y1),
            _ => (old.x3, old.y3, self.x3, self.y3),
        };

        // Binary search: lo=0 is the old position (valid), hi=1 is the new (invalid).
        let mut lo = 0.0_f64;
        let mut hi = 1.0_f64;

        for _ in 0..10 {
            let mid = (lo + hi) * 0.5;
            let test_x = (old_x + (new_x - old_x) * mid).clamp(min_coord, max_x);
            let test_y = (old_y + (new_y - old_y) * mid).clamp(min_coord, max_y);

            let mut test = *self;
            match choice {
                0 => {
                    test.x1 = test_x;
                    test.y1 = test_y;
                }
                _ => {
                    test.x3 = test_x;
                    test.y3 = test_y;
                }
            }

            if test.is_valid() {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        let final_x = (old_x + (new_x - old_x) * lo).clamp(min_coord, max_x);
        let final_y = (old_y + (new_y - old_y) * lo).clamp(min_coord, max_y);
        match choice {
            0 => {
                self.x1 = final_x;
                self.y1 = final_y;
            }
            _ => {
                self.x3 = final_x;
                self.y3 = final_y;
            }
        }

        if !self.is_valid() {
            self.repair_control_point(width, height);
        }
    }

    /// Repair a control-point mutation by projecting the control point back
    /// inside the validity region defined by the current endpoints.
    /// Also ensures the chord is at least 2px long (spreading endpoints if needed).
    fn repair_control_point(&mut self, width: i32, height: i32) {
        let min_coord = -Self::MUTATE_MARGIN;
        let max_x = f64::from(width - 1) + Self::MUTATE_MARGIN;
        let max_y = f64::from(height - 1) + Self::MUTATE_MARGIN;

        let mut dx = self.x3 - self.x1;
        let mut dy = self.y3 - self.y1;
        let mut length = (dx * dx + dy * dy).sqrt();

        // Ensure endpoints are far enough apart for a meaningful chord.
        if length < 2.0 {
            if self.x1 + 2.0 <= max_x {
                self.x3 = self.x1 + 2.0;
                self.y3 = self.y1;
            } else if self.x1 - 2.0 >= min_coord {
                self.x3 = self.x1 - 2.0;
                self.y3 = self.y1;
            } else if self.y1 + 2.0 <= max_y {
                self.x3 = self.x1;
                self.y3 = self.y1 + 2.0;
            } else {
                self.x3 = self.x1;
                self.y3 = self.y1 - 2.0;
            }
            dx = self.x3 - self.x1;
            dy = self.y3 - self.y1;
            length = (dx * dx + dy * dy).sqrt();
        }

        let mid_x = (self.x1 + self.x3) * 0.5;
        let mid_y = (self.y1 + self.y3) * 0.5;

        let ux = dx / length;
        let uy = dy / length;
        let px = -uy;
        let py = ux;
        let rel_x = self.x2 - mid_x;
        let rel_y = self.y2 - mid_y;
        let tangent = rel_x * ux + rel_y * uy;
        let normal = rel_x * px + rel_y * py;
        let tangent_ratio = tangent.abs() / length;
        let normal_ratio = normal.abs() / length;
        let ratio_sq = tangent_ratio * tangent_ratio + normal_ratio * normal_ratio;

        let scale = if ratio_sq > 0.0 {
            let boundary = tangent_ratio * tangent_ratio + 3.0 * ratio_sq;
            ((-tangent_ratio + boundary.sqrt()) / (2.0 * ratio_sq)).min(1.0)
        } else {
            0.0
        };
        self.x2 = (mid_x + tangent * scale * ux + normal * scale * px).clamp(min_coord, max_x);
        self.y2 = (mid_y + tangent * scale * uy + normal * scale * py).clamp(min_coord, max_y);

        if !self.is_valid() {
            self.x2 = mid_x.clamp(min_coord, max_x);
            self.y2 = mid_y.clamp(min_coord, max_y);
        }
        if !self.is_valid() {
            self.force_valid_geometry(width, height);
        }
    }

    fn force_valid_geometry(&mut self, width: i32, height: i32) {
        let min_coord = -Self::MUTATE_MARGIN;
        let max_x = f64::from(width - 1) + Self::MUTATE_MARGIN;
        let max_y = f64::from(height - 1) + Self::MUTATE_MARGIN;

        self.x1 = 0.0_f64.clamp(min_coord, max_x);
        self.y1 = 0.0_f64.clamp(min_coord, max_y);
        self.x3 = (self.x1 + 2.0).clamp(min_coord, max_x);
        self.y3 = self.y1;

        if (self.x3 - self.x1).abs() < 2.0 {
            self.x3 = self.x1;
            self.y3 = (self.y1 + 2.0).clamp(min_coord, max_y);
        }

        self.x2 = ((self.x1 + self.x3) * 0.5).clamp(min_coord, max_x);
        self.y2 = ((self.y1 + self.y3) * 0.5).clamp(min_coord, max_y);
    }

    fn rasterize<'a, R: Rng>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        crate::raster::stroke_quadratic_direct(
            worker,
            self.x1,
            self.y1,
            self.x2,
            self.y2,
            self.x3,
            self.y3,
            self.width / 2.0,
            self.cap,
        )
    }

    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        let min_coord = -Self::MUTATE_MARGIN;
        let max_x = f64::from(worker.width - 1) + Self::MUTATE_MARGIN;
        let max_y = f64::from(worker.height - 1) + Self::MUTATE_MARGIN;
        let old = *self;
        // A fourth move, of the width, only when its bounds let it vary, so
        // that equal bounds keep the three moves and their streams.
        let (min_width, max_width) = worker.quadratic_width;
        let choice = if min_width < max_width {
            worker.rng.random_range(0..4u32)
        } else {
            worker.rng.random_range(0..3u32)
        };
        if choice == 3 {
            self.width = (self.width + step.offset_f64(&mut worker.rng, WIDTH_SIGMA))
                .clamp(min_width, max_width);
            // The width leaves the curve as valid as it was; only a curve
            // that `random` has not repaired yet needs the repair.
            if !self.is_valid() {
                self.repair_control_point(worker.width, worker.height);
            }
            debug_assert!(self.is_valid());
            return;
        }

        for _ in 0..Self::MAX_MUTATE_ATTEMPTS {
            match choice {
                0 => {
                    self.x1 = (self.x1 + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                        .clamp(min_coord, max_x);
                    self.y1 = (self.y1 + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                        .clamp(min_coord, max_y);
                }
                1 => {
                    self.x2 = (self.x2 + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                        .clamp(min_coord, max_x);
                    self.y2 = (self.y2 + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                        .clamp(min_coord, max_y);
                }
                _ => {
                    self.x3 = (self.x3 + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                        .clamp(min_coord, max_x);
                    self.y3 = (self.y3 + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                        .clamp(min_coord, max_y);
                }
            }

            if self.is_valid() {
                return;
            }
        }

        match choice {
            0 | 2 => self.repair_endpoint(&old, choice, worker.width, worker.height),
            _ => self.repair_control_point(worker.width, worker.height),
        }
        debug_assert!(self.is_valid());
    }
}

impl RotatedEllipse {
    /// The rasterizer works in continuous coordinates, so the centre maps
    /// unchanged.
    fn geometry(&self) -> Geometry {
        Geometry::Ellipse {
            cx: self.x,
            cy: self.y,
            rx: self.rx,
            ry: self.ry,
            rotation: self.angle,
        }
    }

    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>) -> Self {
        let (x, y) = worker.sample_xy_float(round);
        Self {
            x,
            y,
            rx: worker.rng.random::<f64>() * 32.0 + 1.0,
            ry: worker.rng.random::<f64>() * 32.0 + 1.0,
            angle: worker.rng.random::<f64>() * 360.0,
        }
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        crate::raster::fill_rotated_ellipse_direct(
            &mut worker.lines,
            &mut worker.rows,
            self.x,
            self.y,
            self.rx,
            self.ry,
            self.angle,
            worker.width,
            worker.height,
        );
        &worker.lines
    }

    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        match worker.rng.random_range(0..3) {
            0 => {
                self.x = (self.x + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                    .clamp(0.0, f64::from(worker.width - 1));
                self.y = (self.y + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                    .clamp(0.0, f64::from(worker.height - 1));
            }
            1 => {
                self.rx = (self.rx + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                    .clamp(1.0, f64::from(worker.width - 1));
                self.ry = (self.ry + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                    .clamp(1.0, f64::from(worker.height - 1));
            }
            _ => self.angle += step.offset_f64(&mut worker.rng, ANGLE_SIGMA),
        }
    }
}

impl Polygon {
    #[inline(always)]
    fn constrain_asset(&mut self) {
        #[cfg(feature = "asset-triangle")]
        if self.order == 3 {
            let mut v = std::array::from_fn(|k| if k % 2 == 0 { self.x[k/2] } else { self.y[k/2] });
            crate::asset_triangle::project(&mut v);
            for i in 0..3 { self.x[i] = v[2*i]; self.y[i] = v[2*i+1]; }
        }
    }
    /// The rasterizer works in continuous coordinates, so vertices map
    /// unchanged.
    fn geometry(&self) -> Geometry {
        Geometry::Polygon(
            (0..self.order)
                .map(|i| Point::new(self.x[i], self.y[i]))
                .collect(),
        )
    }

    /// A random polygon around a sampled vertex, its other vertices drawn
    /// within 20 px of it again until the polygon is valid, then moved
    /// once.
    fn random<R: Rng>(worker: &mut WorkerCtx<R>, round: &SearchRound<'_>, order: usize) -> Self {
        let mut x = [0.0; 4];
        let mut y = [0.0; 4];
        let (x0, y0) = worker.sample_xy_float(round);
        x[0] = x0;
        y[0] = y0;
        let mut polygon = loop {
            for i in 1..order {
                x[i] = x0 + worker.rng.random::<f64>() * 40.0 - 20.0;
                y[i] = y0 + worker.rng.random::<f64>() * 40.0 - 20.0;
            }
            let mut polygon = Self { order, x, y };
            polygon.constrain_asset();
            if polygon.is_valid() {
                break polygon;
            }
        };
        polygon.mutate(worker, Step::Coarse);
        polygon
    }

    /// The polygon through `points`, three or four of them, if it is valid
    /// ([`Self::is_valid`]). The unused vertex of a triangle is the origin.
    fn through(points: &[Point]) -> Option<Self> {
        if !(3..=4).contains(&points.len()) {
            return None;
        }
        let (mut x, mut y) = ([0.0; 4], [0.0; 4]);
        for (i, point) in points.iter().enumerate() {
            (x[i], y[i]) = (point.x, point.y);
        }
        let mut polygon = Self {
            order: points.len(),
            x,
            y,
        };
        polygon.constrain_asset();
        polygon.is_valid().then_some(polygon)
    }

    /// Whether the polygon is simple and strictly convex with every angle
    /// strictly above 15° ([`is_legible_convex`]).
    #[must_use]
    pub(crate) fn is_valid(&self) -> bool {
        let vertices: [(f64, f64); 4] = std::array::from_fn(|i| (self.x[i], self.y[i]));
        is_legible_convex(&vertices[..self.order], TAN_MIN_ANGLE)
    }

    /// The orientation of the polygon, as [`is_legible_convex`] takes it.
    fn orientation(&self) -> f64 {
        let vertices: [(f64, f64); 4] = std::array::from_fn(|i| (self.x[i], self.y[i]));
        orientation(&vertices[..self.order])
    }

    /// From a known-valid quad, moving vertex i changes only i and its two
    /// neighbours. The opposite corner anchors the old orientation, so
    /// these same predicates imply exactly the full validity check. A
    /// triangle has no unaffected corner and retains the full check.
    fn valid_after_move(&self, i: usize, orientation: f64) -> bool {
        if self.order != 4 {
            return self.is_valid();
        }
        let point = |j: usize| (self.x[j], self.y[j]);
        [(i + 3) % 4, i, (i + 1) % 4].into_iter().all(|j| {
            legible_corner(
                point((j + 3) % 4),
                point(j),
                point((j + 1) % 4),
                orientation,
                TAN_MIN_ANGLE,
            )
        })
    }

    fn rasterize<'a, R>(&self, worker: &'a mut WorkerCtx<R>) -> &'a [Scanline] {
        let vertices: [(f64, f64); 4] = [
            (self.x[0], self.y[0]),
            (self.x[1], self.y[1]),
            (self.x[2], self.y[2]),
            (self.x[3], self.y[3]),
        ];
        crate::raster::fill_polygon_direct(
            &mut worker.lines,
            &mut worker.rows,
            &vertices[..self.order],
            worker.width,
            worker.height,
            true,
        );
        &worker.lines
    }

    /// Moves one vertex. A move that breaks the rule ([`Self::is_valid`])
    /// is undone and a new one drawn, so the moves are the unconstrained
    /// ones restricted to valid polygons; small enough moves keep a valid
    /// polygon valid, so the loop ends. There is no vertex-swap move: on a
    /// strictly convex quad, swapping two neighbours always crosses it and
    /// swapping opposite vertices leaves its outline unchanged.
    fn mutate<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) {
        let margin = f64::from(MARGIN);
        debug_assert!(self.is_valid(), "{self:?}");
        let start = *self;
        let orientation = start.orientation();
        loop {
            let i = worker.rng.random_range(0..self.order);
            self.x[i] = (self.x[i] + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                .clamp(-margin, f64::from(worker.width - 1) + margin);
            self.y[i] = (self.y[i] + step.offset_f64(&mut worker.rng, POSITION_SIGMA))
                .clamp(-margin, f64::from(worker.height - 1) + margin);
            self.constrain_asset();
            if self.valid_after_move(i, orientation) {
                return;
            }
            *self = start;
        }
    }
}

/// `tan 15°`, the bound of the minimum-angle rule. The validity checks
/// compare tangents instead of computing angles, so they call no libm
/// function, whose results can differ between platforms: native and wasm
/// output stay identical.
const TAN_MIN_ANGLE: f64 = 0.267_949_192_431_122_7;

/// The longest side of a rectangle, rotated or not, in multiples of its
/// shortest: the greedy search's cap on its integer sides
/// ([`within_aspect`]), and the joint optimisation's on its continuous
/// ones.
pub(crate) const MAX_ASPECT: i32 = 8;

/// Whether the longer of the sides `a` and `b` is at most [`MAX_ASPECT`]
/// times the shorter.
fn within_aspect(a: i32, b: i32) -> bool {
    a.max(b) <= MAX_ASPECT * a.min(b)
}

/// Whether the polygon through `vertices`, three or four of them in either
/// orientation, is simple and strictly convex with every interior angle
/// strictly above `atan tan_min_angle`: with [`TAN_MIN_ANGLE`], 15°, the
/// rule that keeps triangles and polygons reading as their kind.
///
/// At each vertex, with `u` and `w` the edges to the next and the previous
/// vertex, the interior angle `θ` has `sin θ ∝ s · (u × w)` and
/// `cos θ ∝ u · w`, where `s = ±1` is the orientation, taken from the first
/// vertex. A vertex passes ([`legible_corner`]) if `s · (u × w) > 0`, a
/// strict turn the same way as at the first vertex (no straight or reflex
/// angle, no coincident vertices), and
/// `s · (u × w) > tan_min_angle · (u · w)`, so `θ` is above the bound; an
/// angle of 90° or more passes on the first condition alone. With a strict
/// turn the same way at every vertex, every exterior angle is below 180°
/// and they sum to a multiple of 360°, which for at most four vertices can
/// only be 360°: the polygon is simple and convex.
pub(crate) fn is_legible_convex(vertices: &[(f64, f64)], tan_min_angle: f64) -> bool {
    debug_assert!((3..=4).contains(&vertices.len()));
    let n = vertices.len();
    let orientation = orientation(vertices);
    (0..n).all(|i| {
        legible_corner(
            vertices[(i + n - 1) % n],
            vertices[i],
            vertices[(i + 1) % n],
            orientation,
            tan_min_angle,
        )
    })
}

/// The orientation `s = ±1` of the polygon through `vertices`: the sign of
/// the turn at the first vertex, `+1` when it is zero.
fn orientation(vertices: &[(f64, f64)]) -> f64 {
    let n = vertices.len();
    let ((px, py), (nx, ny), (qx, qy)) = (vertices[0], vertices[1], vertices[n - 1]);
    let cross = (nx - px) * (qy - py) - (ny - py) * (qx - px);
    if cross < 0.0 { -1.0 } else { 1.0 }
}

/// Whether the corner at `p`, between `previous` and `next`, turns
/// strictly the way the orientation `s = ±1` says, with an interior angle
/// above `atan tan_min_angle`: `s · (u × w) > 0` and
/// `s · (u × w) > tan_min_angle · (u · w)`, with `u` and `w` the edges to
/// `next` and `previous` ([`is_legible_convex`]).
#[inline]
pub(crate) fn legible_corner(
    previous: (f64, f64),
    p: (f64, f64),
    next: (f64, f64),
    s: f64,
    tan_min_angle: f64,
) -> bool {
    let (ux, uy) = (next.0 - p.0, next.1 - p.1);
    let (wx, wy) = (previous.0 - p.0, previous.1 - p.1);
    let turn = s * (ux * wy - uy * wx);
    turn > 0.0 && turn > tan_min_angle * (ux * wx + uy * wy)
}

fn gaussian_sample<R: Rng>(rng: &mut R, sigma: f64) -> f64 {
    // Marsaglia polar sampling. Discard the second variate so every call
    // consumes a plain stream of uniform draws, with no cached state.
    loop {
        let u = 2.0 * rng.random::<f64>() - 1.0;
        let v = 2.0 * rng.random::<f64>() - 1.0;
        let s = u * u + v * v;
        if s > 0.0 && s < 1.0 {
            return u * (-2.0 * libm::log(s) / s).sqrt() * sigma;
        }
    }
}

/// The size of a move ([`Shape::mutate`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Step {
    /// The greedy search's moves: normal offsets with `σ` of
    /// [`POSITION_SIGMA`] px and [`ANGLE_SIGMA`] degrees, truncated toward
    /// zero on integer coordinates.
    Coarse,
    /// Normal offsets with `σ` scaled by the factor, rounded on integer
    /// coordinates and drawn again while all of a move's integer offsets
    /// round to zero.
    Scaled(f64),
}

impl Step {
    /// The offset of one integer coordinate, with `sigma` at the coarse
    /// scale.
    fn offset<R: Rng>(self, rng: &mut R, sigma: f64) -> i32 {
        match self {
            Self::Coarse => gaussian_sample(rng, sigma) as i32,
            Self::Scaled(scale) => loop {
                let offset = gaussian_sample(rng, sigma * scale).round() as i32;
                if offset != 0 {
                    return offset;
                }
            },
        }
    }

    /// The offsets of two integer coordinates that move together, with
    /// `sigma` at the coarse scale.
    fn offsets<R: Rng>(self, rng: &mut R, sigma: f64) -> (i32, i32) {
        match self {
            Self::Coarse => (
                gaussian_sample(rng, sigma) as i32,
                gaussian_sample(rng, sigma) as i32,
            ),
            Self::Scaled(scale) => loop {
                let x = gaussian_sample(rng, sigma * scale).round() as i32;
                let y = gaussian_sample(rng, sigma * scale).round() as i32;
                if (x, y) != (0, 0) {
                    return (x, y);
                }
            },
        }
    }

    /// The offset of one float coordinate, with `sigma` at the coarse
    /// scale.
    fn offset_f64<R: Rng>(self, rng: &mut R, sigma: f64) -> f64 {
        match self {
            Self::Coarse => gaussian_sample(rng, sigma),
            Self::Scaled(scale) => gaussian_sample(rng, sigma * scale),
        }
    }
}

/// The integer-centred ellipse rasterizer treats `(x, y)` as a pixel centre
/// and keeps the pixels whose centres fall inside the radii.
fn ellipse_geometry(x: i32, y: i32, rx: i32, ry: i32) -> Geometry {
    let centre = pixel_centre(x, y);
    Geometry::Ellipse {
        cx: centre.x,
        cy: centre.y,
        rx: f64::from(rx),
        ry: f64::from(ry),
        rotation: 0.0,
    }
}

/// Maps an integer pixel coordinate to the centre of that pixel.
fn pixel_centre(x: i32, y: i32) -> Point {
    Point::new(f64::from(x) + 0.5, f64::from(y) + 0.5)
}

/// Fills an axis-aligned ellipse centred on pixel `(x, y)`.
///
/// Covers the pixels whose centres lie inside or on the ellipse with radii
/// `rx` and `ry` around that pixel's centre, so the shape is `2·rx + 1`
/// pixels wide and `2·ry + 1` tall, symmetric about its centre row and
/// column.
fn rasterize_ellipse<R>(
    worker: &mut WorkerCtx<R>,
    x: i32,
    y: i32,
    rx: i32,
    ry: i32,
) -> &[Scanline] {
    worker.lines.clear();
    for dy in 0..=ry {
        let y1 = y - dy;
        let y2 = y + dy;
        if (y1 < 0 || y1 >= worker.height) && (y2 < 0 || y2 >= worker.height) {
            continue;
        }
        let span = ellipse_half_span(rx, ry, dy);
        let x1 = (x - span).max(0);
        let x2 = (x + span).min(worker.width - 1);
        if x1 > x2 {
            continue;
        }
        if y1 >= 0 && y1 < worker.height {
            worker.lines.push(Scanline {
                y: y1,
                x1,
                x2,
                alpha: 0xFFFF,
            });
        }
        if y2 >= 0 && y2 < worker.height && dy > 0 {
            worker.lines.push(Scanline {
                y: y2,
                x1,
                x2,
                alpha: 0xFFFF,
            });
        }
    }
    &worker.lines
}

/// Fills the pixels whose centres lie inside or on the axis-aligned ellipse
/// centred on the continuous point `(cx, cy)` with radii `rx` and `ry`, the
/// rule [`rasterize_ellipse`] applies to an ellipse centred on a pixel.
fn fill_ellipse_at_pixel_centres<R>(
    worker: &mut WorkerCtx<R>,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
) -> &[Scanline] {
    worker.lines.clear();
    let y1 = ((cy - ry - 0.5).ceil() as i32).max(0);
    let y2 = ((cy + ry - 0.5).floor() as i32).min(worker.height - 1);
    for y in y1..=y2 {
        let dy = (f64::from(y) + 0.5 - cy) / ry;
        let span = rx * (1.0 - dy * dy).max(0.0).sqrt();
        let x1 = ((cx - span - 0.5).ceil() as i32).max(0);
        let x2 = ((cx + span - 0.5).floor() as i32).min(worker.width - 1);
        if x1 <= x2 {
            worker.lines.push(Scanline {
                y,
                x1,
                x2,
                alpha: 0xFFFF,
            });
        }
    }
    &worker.lines
}

/// The largest `dx` with `(dx / rx)² + (dy / ry)² <= 1`, for `0 <= dy <= ry`.
///
/// Exact integer arithmetic: `dx² · ry² <= rx² · (ry² − dy²)` holds exactly
/// when `dx · ry <= isqrt(rx² · (ry² − dy²))`. The integer square root
/// starts from the hardware `f64` one and is corrected exactly;
/// `i64::isqrt` is several times slower.
fn ellipse_half_span(rx: i32, ry: i32, dy: i32) -> i32 {
    let (rx, ry, dy) = (i64::from(rx), i64::from(ry), i64::from(dy));
    let limit = rx * rx * (ry * ry - dy * dy);
    let mut root = (limit as f64).sqrt() as i64;
    while root * root > limit {
        root -= 1;
    }
    while (root + 1) * (root + 1) <= limit {
        root += 1;
    }
    (root / ry) as i32
}

/// Fills a triangle whose integer vertices are pixel centres.
///
/// Each row is sampled at its pixel centres: row `y` covers the pixels whose
/// centres lie inside the triangle. The edge crossings are exact rationals,
/// so the rounding is exact too. A centre exactly on an edge belongs to the
/// triangle only on its left or top edges (the usual top-left rule), so a
/// pixel cut in half by an edge is counted on one side, not both. Only rows
/// inside `0..height` are emitted; columns are left for the caller to crop.
fn rasterize_triangle(mut vertices: [(i32, i32); 3], height: i32, lines: &mut Vec<Scanline>) {
    vertices.sort_unstable_by_key(|&(_, y)| y);
    let [top, middle, bottom] = vertices;
    let (start, end) = (top.1.max(0), bottom.1.min(height));
    if start >= end {
        // Off the canvas, or collinear vertices on one row (which
        // `Triangle::is_valid` rejects).
        return;
    }
    let mut long = EdgeWalker::new(top, bottom, start);
    let upper = top.1 < middle.1 && start <= middle.1;
    let mut short = if upper {
        EdgeWalker::new(top, middle, start)
    } else {
        EdgeWalker::new(middle, bottom, start)
    };
    for y in start..end {
        if upper && y == middle.1 + 1 {
            short = EdgeWalker::new(middle, bottom, y);
        }
        // Left crossings round up; a centre exactly on the right edge is out.
        let x1 = long.first.min(short.first) as i32;
        let x2 = (long.first.max(short.first) - 1) as i32;
        if x1 <= x2 {
            lines.push(Scanline {
                y,
                x1,
                x2,
                alpha: 0xFFFF,
            });
        }
        long.step();
        short.step();
    }
}

/// Walks the edge from `a` to `b` (with `a.1 < b.1`) row by row, tracking
/// the first column at or right of its crossing exactly: the crossing is
/// `numerator / dy`, and `first · dy - numerator` stays in `0..dy`.
struct EdgeWalker {
    first: i64,
    excess: i64,
    dy: i64,
    step_quotient: i64,
    step_remainder: i64,
}

impl EdgeWalker {
    fn new(a: (i32, i32), b: (i32, i32), y: i32) -> Self {
        let dy = i64::from(b.1 - a.1);
        let dx = i64::from(b.0 - a.0);
        let numerator = i64::from(a.0) * dy + i64::from(y - a.1) * dx;
        // The crossing's ceiling, from an exact floor division.
        let first = -(-numerator).div_euclid(dy);
        Self {
            first,
            excess: first * dy - numerator,
            dy,
            step_quotient: dx.div_euclid(dy),
            step_remainder: dx.rem_euclid(dy),
        }
    }

    /// Moves to the next row, where the numerator grows by `dx`.
    #[inline]
    fn step(&mut self) {
        self.first += self.step_quotient;
        self.excess -= self.step_remainder;
        if self.excess < 0 {
            self.first += 1;
            self.excess += self.dy;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{fnv1a, make_test_round};
    use crate::util::sin_cos_degrees;
    use rand::SeedableRng;
    use rand_chacha::ChaCha8Rng;

    #[test]
    fn moved_polygon_corners_match_full_validity() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xc02e25);
        let mut valid = quad([(0.0, 0.0), (30.0, 0.0), (30.0, 30.0), (0.0, 30.0)]);
        for _ in 0..20000 {
            let i = rng.random_range(0..4);
            let mut moved = valid;
            moved.x[i] += rng.random_range(-40.0..40.0);
            moved.y[i] += rng.random_range(-40.0..40.0);
            let expected = moved.is_valid();
            assert_eq!(
                moved.valid_after_move(i, valid.orientation()),
                expected,
                "{valid:?} -> {moved:?}"
            );
            if expected {
                valid = moved;
            }
        }
        for degrees in [14.999, 15.0, 15.001, 15.1] {
            let start = quad_with_angle(15.1);
            let candidate = quad_with_angle(degrees);
            let mut moved = start;
            moved.x[3] = candidate.x[3];
            moved.y[3] = candidate.y[3];
            assert_eq!(
                moved.valid_after_move(3, start.orientation()),
                moved.is_valid()
            );
            assert_eq!(moved.is_valid(), degrees > 15.0);
            let mut triangle = moved;
            triangle.order = 3;
            assert_eq!(triangle.valid_after_move(1, 1.0), triangle.is_valid());
        }
    }

    #[test]
    fn the_aspect_cap_is_eight_to_one_either_way() {
        assert!(within_aspect(1, 8) && within_aspect(8, 1) && within_aspect(5, 5));
        assert!(within_aspect(4, 32) && within_aspect(32, 4));
        assert!(!within_aspect(1, 9) && !within_aspect(9, 1) && !within_aspect(4, 33));
    }

    fn round(w: u32, h: u32) -> (WorkerCtx<ChaCha8Rng>, SearchRound<'static>) {
        make_test_round(w, h, 7)
    }

    #[test]
    fn shape_kind_round_trips_public_names() {
        let cases = [
            (ShapeKind::Any, "any"),
            (ShapeKind::Triangle, "triangle"),
            (ShapeKind::Rectangle, "rectangle"),
            (ShapeKind::Ellipse, "ellipse"),
            (ShapeKind::Circle, "circle"),
            (ShapeKind::RotatedRectangle, "rotated-rectangle"),
            (ShapeKind::Quadratic, "quadratic"),
            (ShapeKind::RotatedEllipse, "rotated-ellipse"),
            (ShapeKind::Polygon, "polygon"),
        ];

        for (kind, value) in cases {
            assert_eq!(kind.as_str(), value);
            assert_eq!(value.parse::<ShapeKind>().expect("shape kind"), kind);
        }
    }

    #[test]
    fn shape_kind_requirement_lists_every_name_once() {
        assert_eq!(
            ShapeKind::REQUIREMENT,
            "must be one of: any, triangle, rectangle, ellipse, circle, \
             rotated-rectangle, quadratic, rotated-ellipse, polygon"
        );
        let listed: Vec<&str> = ShapeKind::REQUIREMENT
            .strip_prefix("must be one of: ")
            .expect("a list requirement")
            .split(", ")
            .collect();
        let kinds: Vec<ShapeKind> = listed
            .iter()
            .map(|name| name.parse().expect(name))
            .collect();
        assert_eq!(kinds[0], ShapeKind::Any);
        assert_eq!(&kinds[1..], ShapeKind::all_kinds());
    }

    #[test]
    fn shape_kind_rejects_unknown_name() {
        assert_eq!(
            "hexagon".parse::<ShapeKind>(),
            Err(ParseError::new(
                "shape must be one of: any, triangle, rectangle, ellipse, circle, \
                 rotated-rectangle, quadratic, rotated-ellipse, polygon"
            ))
        );
    }

    #[test]
    fn triangle_validity_rejects_collinear_points() {
        let triangle = Triangle {
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 1,
            x3: 2,
            y3: 2,
        };
        assert!(!triangle.is_valid());
    }

    #[test]
    fn the_minimum_angle_literal_is_the_tangent_of_15_degrees() {
        let tan = 15.0_f64.to_radians().tan();
        assert!((TAN_MIN_ANGLE - tan).abs() <= 1e-16 * tan, "{tan}");
    }

    /// `Triangle::is_valid` before it compared tangents: every angle by
    /// `acos`, the third as `180° − a1 − a2`, strictly above 15°.
    fn acos_valid(triangle: &Triangle) -> bool {
        fn angle(ax: i32, ay: i32, bx: i32, by: i32) -> Option<f64> {
            let (ax, ay, bx, by) = (f64::from(ax), f64::from(ay), f64::from(bx), f64::from(by));
            let da = (ax * ax + ay * ay).sqrt();
            let db = (bx * bx + by * by).sqrt();
            if da == 0.0 || db == 0.0 {
                return None;
            }
            let dot = ((ax / da) * (bx / db) + (ay / da) * (by / db)).clamp(-1.0, 1.0);
            Some(dot.acos().to_degrees())
        }
        let t = triangle;
        let Some(a1) = angle(t.x2 - t.x1, t.y2 - t.y1, t.x3 - t.x1, t.y3 - t.y1) else {
            return false;
        };
        let Some(a2) = angle(t.x1 - t.x2, t.y1 - t.y2, t.x3 - t.x2, t.y3 - t.y2) else {
            return false;
        };
        let a3 = 180.0 - a1 - a2;
        a1 > 15.0 && a2 > 15.0 && a3 > 15.0
    }

    /// The tangent comparison agrees with the `acos` rule it replaced on
    /// lattice triangles of every size the search makes: random ones, and
    /// ones built around an angle within half a degree of 15°, where the
    /// two could disagree.
    #[test]
    fn triangle_validity_agrees_with_the_acos_rule() {
        let mut rng = crate::rng::create_rng(0x7a11);
        let (mut valid, mut invalid, mut near) = (0, 0, 0);
        for sample in 0..400_000 {
            let triangle = if sample % 2 == 0 {
                let mut coordinate = || rng.random_range(-16..300);
                Triangle {
                    x1: coordinate(),
                    y1: coordinate(),
                    x2: coordinate(),
                    y2: coordinate(),
                    x3: coordinate(),
                    y3: coordinate(),
                }
            } else {
                let degrees = 15.0 + rng.random_range(-0.5..0.5);
                let turn: f64 = rng.random_range(0.0..360.0);
                let (l1, l2) = (rng.random_range(5.0..300.0), rng.random_range(5.0..300.0));
                let (x1, y1) = (rng.random_range(-16..300), rng.random_range(-16..300));
                let at = |length: f64, angle: f64| {
                    let (sin, cos) = angle.to_radians().sin_cos();
                    ((length * cos).round() as i32, (length * sin).round() as i32)
                };
                let (dx2, dy2) = at(l1, turn);
                let (dx3, dy3) = at(l2, turn + degrees);
                near += 1;
                Triangle {
                    x1,
                    y1,
                    x2: x1 + dx2,
                    y2: y1 + dy2,
                    x3: x1 + dx3,
                    y3: y1 + dy3,
                }
            };
            assert_eq!(triangle.is_valid(), acos_valid(&triangle), "{triangle:?}");
            if triangle.is_valid() {
                valid += 1;
            } else {
                invalid += 1;
            }
        }
        assert!(
            valid > 50_000 && invalid > 50_000 && near > 0,
            "{valid} {invalid}"
        );
    }

    fn quad(points: [(f64, f64); 4]) -> Polygon {
        Polygon {
            order: 4,
            x: points.map(|(x, _)| x),
            y: points.map(|(_, y)| y),
        }
    }

    /// The same quad with its vertices in the opposite order.
    fn reversed(polygon: Polygon) -> Polygon {
        let mut reversed = polygon;
        reversed.x.reverse();
        reversed.y.reverse();
        reversed
    }

    /// A strictly convex quad whose angle at the origin is `degrees`,
    /// between edges of 100 px; its fourth vertex lies on the bisector,
    /// 20 px beyond the chord of the other two.
    fn quad_with_angle(degrees: f64) -> Polygon {
        let (sin, cos) = degrees.to_radians().sin_cos();
        let (half_sin, half_cos) = (degrees / 2.0).to_radians().sin_cos();
        let reach = 100.0 * half_cos + 20.0;
        let polygon = quad([
            (0.0, 0.0),
            (100.0, 0.0),
            (reach * half_cos, reach * half_sin),
            (100.0 * cos, 100.0 * sin),
        ]);
        let turns: Vec<f64> = (0..4)
            .map(|i| {
                let (j, k) = ((i + 1) % 4, (i + 2) % 4);
                (polygon.x[j] - polygon.x[i]) * (polygon.y[k] - polygon.y[j])
                    - (polygon.y[j] - polygon.y[i]) * (polygon.x[k] - polygon.x[j])
            })
            .collect();
        assert!(turns.iter().all(|&turn| turn > 0.0), "{turns:?}");
        polygon
    }

    #[test]
    fn polygon_validity_accepts_strictly_convex_quads_in_either_orientation() {
        let square = quad([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        let kite = quad([(0.0, 0.0), (30.0, -4.0), (40.0, 0.0), (30.0, 4.0)]);
        for polygon in [square, kite, quad_with_angle(15.1)] {
            assert!(polygon.is_valid(), "{polygon:?}");
            assert!(reversed(polygon).is_valid(), "{polygon:?}");
        }
    }

    #[test]
    fn polygon_validity_rejects_crossed_concave_and_degenerate_quads() {
        let crossed = quad([(0.0, 0.0), (10.0, 10.0), (10.0, 0.0), (0.0, 10.0)]);
        let concave = quad([(0.0, 0.0), (10.0, 0.0), (3.0, 3.0), (0.0, 10.0)]);
        // A vertex on its neighbours' edge (an angle of 180°), and a
        // repeated vertex.
        let straight = quad([(0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (5.0, 8.0)]);
        let repeated = quad([(0.0, 0.0), (10.0, 0.0), (10.0, 0.0), (0.0, 10.0)]);
        for polygon in [crossed, concave, straight, repeated] {
            assert!(!polygon.is_valid(), "{polygon:?}");
            assert!(!reversed(polygon).is_valid(), "{polygon:?}");
        }
    }

    #[test]
    fn polygon_validity_rejects_an_angle_of_15_degrees_or_less() {
        for degrees in [14.9, 10.0, 1.0] {
            let polygon = quad_with_angle(degrees);
            assert!(!polygon.is_valid(), "{degrees}");
            assert!(!reversed(polygon).is_valid(), "{degrees}");
        }
    }

    #[test]
    fn rotated_rectangle_validity_caps_the_aspect_ratio_at_8() {
        let rect = |sx, sy| RotatedRectangle {
            x: 8,
            y: 8,
            sx,
            sy,
            angle: 30,
        };
        for (sx, sy) in [(1, 1), (8, 1), (1, 8), (80, 10), (10, 80), (255, 32)] {
            assert!(rect(sx, sy).is_valid(), "{sx} × {sy}");
        }
        for (sx, sy) in [(9, 1), (1, 9), (81, 10), (10, 81), (17, 2), (255, 31)] {
            assert!(!rect(sx, sy).is_valid(), "{sx} × {sy}");
        }
    }

    /// The cap counts pixels: `x1..=x2` is `x2 − x1 + 1` wide, in either
    /// order of the corners.
    #[test]
    fn rectangle_validity_caps_the_aspect_ratio_at_8() {
        let rect = |w: i32, h: i32| Rectangle {
            x1: 3,
            y1: 5,
            x2: 3 + w - 1,
            y2: 5 + h - 1,
        };
        let swapped = |r: Rectangle| Rectangle {
            x1: r.x2,
            y1: r.y2,
            x2: r.x1,
            y2: r.y1,
        };
        for (w, h) in [(1, 1), (8, 1), (1, 8), (80, 10), (10, 80), (255, 32)] {
            assert!(rect(w, h).is_valid(), "{w} × {h}");
            assert!(swapped(rect(w, h)).is_valid(), "{w} × {h}");
        }
        for (w, h) in [(9, 1), (1, 9), (81, 10), (10, 81), (17, 2), (255, 31)] {
            assert!(!rect(w, h).is_valid(), "{w} × {h}");
            assert!(!swapped(rect(w, h)).is_valid(), "{w} × {h}");
        }
    }

    /// The legibility rules hold for every shape the search makes and
    /// moves: random polygons, rectangles and rotated rectangles, and every
    /// greedy and refit move of them, over many seeds and canvas sizes.
    #[test]
    fn random_and_mutate_keep_polygons_and_rectangles_valid() {
        fn assert_valid(shape: &Shape, context: &str) {
            match shape {
                Shape::Polygon(polygon) => assert!(polygon.is_valid(), "{context}: {polygon:?}"),
                Shape::Rectangle(rect) => assert!(rect.is_valid(), "{context}: {rect:?}"),
                Shape::RotatedRectangle(rect) => assert!(rect.is_valid(), "{context}: {rect:?}"),
                _ => {}
            }
        }
        let steps = [
            Step::Coarse,
            Step::Scaled(1.0),
            Step::Scaled(0.3),
            Step::Scaled(crate::refine::MIN_SCALE),
        ];
        let (mut polygons, mut rects, mut aligned) = (0, 0, 0);
        for seed in 0..40 {
            for (width, height) in [(2, 2), (3, 7), (64, 48), (256, 171), (300, 9)] {
                let (mut worker, round) = make_test_round(width, height, 0x1e91 + seed);
                for kind in [
                    ShapeKind::Polygon,
                    ShapeKind::Rectangle,
                    ShapeKind::RotatedRectangle,
                    ShapeKind::Any,
                ] {
                    for sample in 0..10 {
                        let mut shape = Shape::random(kind, &mut worker, &round);
                        let context = format!("{kind:?} {width}×{height} seed {seed} #{sample}");
                        assert_valid(&shape, &context);
                        polygons += usize::from(matches!(shape, Shape::Polygon(_)));
                        rects += usize::from(matches!(shape, Shape::RotatedRectangle(_)));
                        aligned += usize::from(matches!(shape, Shape::Rectangle(_)));
                        for step in steps {
                            for _ in 0..25 {
                                shape.mutate(&mut worker, step);
                                assert_valid(&shape, &format!("{context} {step:?}"));
                            }
                        }
                    }
                }
            }
        }
        assert!(
            polygons > 1000 && rects > 1000 && aligned > 1000,
            "{polygons} {rects} {aligned}"
        );
    }

    #[test]
    fn rectangle_rasterize_matches_bounds() {
        let (mut worker, _) = round(8, 8);
        let shape = Shape::Rectangle(Rectangle {
            x1: 4,
            y1: 3,
            x2: 2,
            y2: 1,
        });
        let lines = shape.rasterize(&mut worker);
        assert_eq!(
            lines,
            &[
                Scanline {
                    y: 1,
                    x1: 2,
                    x2: 4,
                    alpha: 0xFFFF
                },
                Scanline {
                    y: 2,
                    x1: 2,
                    x2: 4,
                    alpha: 0xFFFF
                },
                Scanline {
                    y: 3,
                    x1: 2,
                    x2: 4,
                    alpha: 0xFFFF
                },
            ]
        );
    }

    #[test]
    fn triangle_rasterize_fills_pixel_centres_by_the_top_left_rule() {
        let (mut worker, _) = round(8, 8);
        let shape = Shape::Triangle(Triangle {
            x1: 0,
            y1: 0,
            x2: 4,
            y2: 0,
            x3: 0,
            y3: 4,
        });
        // Centres on the top and left edges are inside, centres on the
        // hypotenuse (`x + y == 4`) are not.
        let line = |y, x2| Scanline {
            y,
            x1: 0,
            x2,
            alpha: 0xFFFF,
        };
        assert_eq!(
            shape.rasterize(&mut worker),
            &[line(0, 3), line(1, 2), line(2, 1), line(3, 0)]
        );
    }

    #[test]
    fn ellipse_rasterize_matches_expected_scanlines() {
        let (mut worker, _) = round(11, 11);
        let shape = Shape::Ellipse(Ellipse {
            x: 5,
            y: 5,
            rx: 3,
            ry: 2,
        });
        let lines = shape.rasterize(&mut worker);
        assert_eq!(
            lines,
            &[
                Scanline {
                    y: 5,
                    x1: 2,
                    x2: 8,
                    alpha: 0xFFFF
                },
                Scanline {
                    y: 4,
                    x1: 3,
                    x2: 7,
                    alpha: 0xFFFF
                },
                Scanline {
                    y: 6,
                    x1: 3,
                    x2: 7,
                    alpha: 0xFFFF
                },
                Scanline {
                    y: 3,
                    x1: 5,
                    x2: 5,
                    alpha: 0xFFFF
                },
                Scanline {
                    y: 7,
                    x1: 5,
                    x2: 5,
                    alpha: 0xFFFF
                },
            ]
        );
    }

    /// Mutations keep the circle's centre on the canvas and its radius in
    /// `1..min(w, h)`, and they do move the radius.
    #[test]
    fn mutate_keeps_circle_radius_equal() {
        let (width, height) = (48, 40);
        let (mut worker, _) = round(width, height);
        let mut shape = Shape::Circle(Circle { x: 10, y: 10, r: 4 });
        let mut radii = std::collections::BTreeSet::new();
        for _ in 0..500 {
            shape.mutate(&mut worker, Step::Coarse);
            let &Shape::Circle(circle) = &shape else {
                panic!("expected circle")
            };
            assert!((0..width as i32).contains(&circle.x), "{circle:?}");
            assert!((0..height as i32).contains(&circle.y), "{circle:?}");
            assert!((1..height as i32).contains(&circle.r), "{circle:?}");
            radii.insert(circle.r);
        }
        assert!(radii.len() > 10, "the radius barely moved: {radii:?}");
    }

    #[test]
    fn quadratic_rasterizes_non_empty() {
        let (mut worker, _) = round(32, 32);
        let shape = Shape::Quadratic(Quadratic {
            x1: 4.0,
            y1: 4.0,
            x2: 10.0,
            y2: 12.0,
            x3: 20.0,
            y3: 6.0,
            width: 2.0,
            cap: LineCap::Butt,
        });
        assert!(!shape.rasterize(&mut worker).is_empty());
    }

    /// The colour fit weights pixels by coverage, but at output size a stroke
    /// is drawn several pixels wide and mostly fully covered. A working-size
    /// stroke that never fully covers a pixel gets saturated colours that
    /// compensate for its partial coverage and look wrong at output size, so
    /// random quadratics must be wide enough to fully cover their centre line
    /// between their ends (past them, a round cap covers pixels partly).
    #[test]
    fn random_quadratics_fully_cover_pixels_on_their_centre_line() {
        let (mut worker, round) = round(64, 48);
        for _ in 0..50 {
            let Shape::Quadratic(random) = Shape::random(ShapeKind::Quadratic, &mut worker, &round)
            else {
                panic!("expected a quadratic");
            };
            let straight = Shape::Quadratic(Quadratic {
                x1: 4.0,
                y1: 20.5,
                x2: 30.0,
                y2: 20.5,
                x3: 56.0,
                y3: 20.5,
                ..random
            });
            let lines = straight.rasterize(&mut worker);
            let centre_row: Vec<_> = lines.iter().filter(|line| line.y == 20).collect();
            assert!(
                (4..56).all(|x| centre_row
                    .iter()
                    .any(|line| (line.x1..=line.x2).contains(&x) && line.alpha == 0xFFFF)),
                "{random:?}: centre row {centre_row:?}"
            );
        }
    }

    #[test]
    fn quadratic_repair_restores_validity() {
        let mut quadratic = Quadratic {
            x1: 4.0,
            y1: 4.0,
            x2: 30.0,
            y2: 30.0,
            x3: 8.0,
            y3: 4.0,
            width: 0.5,
            cap: LineCap::Butt,
        };

        assert!(!quadratic.is_valid());
        quadratic.repair_control_point(32, 32);
        assert!(quadratic.is_valid());
    }

    #[test]
    fn quadratic_mutate_always_yields_valid_shape() {
        // Run many mutations from the same starting state with different seeds.
        // Every call must produce a valid shape, through retries or repair.
        for seed in 0..500_u64 {
            let mut worker = WorkerCtx::new(32, 32, crate::rng::create_rng(seed));
            let mut quadratic = Quadratic {
                x1: 8.0,
                y1: 8.0,
                x2: 16.0,
                y2: 18.0,
                x3: 24.0,
                y3: 8.0,
                width: 0.5,
                cap: LineCap::Butt,
            };

            quadratic.mutate(&mut worker, Step::Coarse);
            assert!(quadratic.is_valid(), "seed {seed} produced invalid shape");
        }
    }

    /// With the width fixed at 2 px, random quadratics and their moves draw
    /// the same random streams and make the same shapes as before the
    /// width became searchable: the digest was recorded before that change,
    /// and again when curves got a cap, round by default, which the trace
    /// spells and their moves keep. Recorded again when Gaussian moves
    /// switched to portable polar sampling with libm::log: the intended
    /// new random stream agrees on aarch64 and x86_64.
    #[test]
    fn fixed_width_quadratics_keep_their_random_streams() {
        let (mut worker, round) = round(64, 48);
        worker.quadratic_width = (2.0, 2.0);
        let mut trace = String::new();
        for _ in 0..50 {
            let Shape::Quadratic(mut quadratic) =
                Shape::random(ShapeKind::Quadratic, &mut worker, &round)
            else {
                panic!("expected a quadratic");
            };
            for step in [Step::Coarse, Step::Scaled(0.5), Step::Coarse] {
                quadratic.mutate(&mut worker, step);
                assert_eq!(quadratic.width, 2.0);
                assert_eq!(quadratic.cap, LineCap::Round);
                trace.push_str(&format!("{quadratic:?}"));
            }
        }
        trace.push_str(&format!("{}", worker.rng.random::<u64>()));
        assert_eq!(fnv1a(trace.bytes()), 12_365_064_046_449_991_623);
    }

    #[test]
    fn random_quadratics_draw_their_width_within_the_bounds() {
        let (mut worker, round) = round(64, 48);
        worker.quadratic_width = (1.5, 6.0);
        let widths: Vec<f64> = (0..200)
            .map(|_| {
                let Shape::Quadratic(quadratic) =
                    Shape::random(ShapeKind::Quadratic, &mut worker, &round)
                else {
                    panic!("expected a quadratic");
                };
                assert!(quadratic.is_valid(), "{quadratic:?}");
                quadratic.width
            })
            .collect();
        assert!(
            widths.iter().all(|width| (1.5..=6.0).contains(width)),
            "{widths:?}"
        );
        assert!(widths.iter().any(|&width| width != widths[0]), "{widths:?}");
    }

    #[test]
    fn quadratic_moves_keep_the_width_within_the_bounds() {
        let mut moved = 0;
        for seed in 0..200_u64 {
            let mut worker = WorkerCtx::new(32, 32, crate::rng::create_rng(seed));
            worker.quadratic_width = (1.5, 6.0);
            let mut quadratic = Quadratic {
                x1: 8.0,
                y1: 8.0,
                x2: 16.0,
                y2: 18.0,
                x3: 24.0,
                y3: 8.0,
                width: 2.0,
                cap: LineCap::Butt,
            };
            quadratic.mutate(&mut worker, Step::Coarse);
            assert!(quadratic.is_valid(), "seed {seed}: {quadratic:?}");
            assert!(
                (1.5..=6.0).contains(&quadratic.width),
                "seed {seed}: {quadratic:?}"
            );
            if quadratic.width != 2.0 {
                moved += 1;
            }
        }
        assert!(moved > 0, "no move changed the width");
    }

    #[test]
    fn quadratic_endpoint_repair_preserves_control_point() {
        // Directly test that repair_endpoint never modifies the control point.
        let old = Quadratic {
            x1: 16.0,
            y1: 16.0,
            x2: 32.0,
            y2: 40.0,
            x3: 48.0,
            y3: 16.0,
            width: 0.5,
            cap: LineCap::Butt,
        };
        assert!(old.is_valid());

        // Test p1 repair: move p1 close to p2 (invalidates shape).
        let mut q = old;
        q.x1 = 31.0;
        q.y1 = 39.0;
        assert!(!q.is_valid());
        q.repair_endpoint(&old, 0, 64, 64);
        assert!(q.is_valid());
        assert_eq!(q.x2, old.x2, "p1 repair must not touch control point x");
        assert_eq!(q.y2, old.y2, "p1 repair must not touch control point y");

        // Test p3 repair: move p3 very close to p2 (invalidates shape).
        let mut q = old;
        q.x3 = 31.0;
        q.y3 = 39.0;
        assert!(!q.is_valid());
        q.repair_endpoint(&old, 2, 64, 64);
        assert!(q.is_valid());
        assert_eq!(q.x2, old.x2, "p3 repair must not touch control point x");
        assert_eq!(q.y2, old.y2, "p3 repair must not touch control point y");
    }

    #[test]
    fn quadratic_repair_endpoint_lerps_back() {
        // An endpoint mutation that breaks validity should lerp the endpoint
        // back toward its old position, not snap it somewhere arbitrary.
        let mut quadratic = Quadratic {
            x1: 16.0,
            y1: 16.0,
            x2: 32.0,
            y2: 40.0,
            x3: 48.0,
            y3: 16.0,
            width: 0.5,
            cap: LineCap::Butt,
        };
        assert!(quadratic.is_valid());

        let old = quadratic;
        // Force an invalid endpoint position: move x1 very close to x2.
        quadratic.x1 = 31.0;
        quadratic.y1 = 39.0;
        assert!(!quadratic.is_valid());

        quadratic.repair_endpoint(&old, 0, 64, 64);
        assert!(quadratic.is_valid());
        // The control point must be unchanged.
        assert_eq!(quadratic.x2, old.x2);
        assert_eq!(quadratic.y2, old.y2);
        // The repaired endpoint should be between old and attempted position.
        assert!(quadratic.x1 >= old.x1.min(31.0) && quadratic.x1 <= old.x1.max(31.0));
        assert!(quadratic.y1 >= old.y1.min(39.0) && quadratic.y1 <= old.y1.max(39.0));
    }

    #[test]
    fn quadratic_control_point_repair_preserves_endpoints() {
        let mut quadratic = Quadratic {
            x1: 16.0,
            y1: 16.0,
            x2: 32.0,
            y2: 40.0,
            x3: 48.0,
            y3: 16.0,
            width: 0.5,
            cap: LineCap::Butt,
        };
        assert!(quadratic.is_valid());

        let old = quadratic;
        quadratic.x2 = 60.0;
        quadratic.y2 = 60.0;
        assert!(!quadratic.is_valid());

        quadratic.repair_control_point(64, 64);
        assert!(quadratic.is_valid());
        assert_eq!(quadratic.x1, old.x1);
        assert_eq!(quadratic.y1, old.y1);
        assert_eq!(quadratic.x3, old.x3);
        assert_eq!(quadratic.y3, old.y3);
    }

    #[test]
    fn quadratic_is_valid_uses_f64_precision() {
        // Sub-pixel differences must not be lost to integer truncation.
        let q = Quadratic {
            x1: 0.0,
            y1: 0.0,
            x2: 0.5,
            y2: 0.0,
            x3: 0.9,
            y3: 0.0,
            width: 0.5,
            cap: LineCap::Butt,
        };
        assert!(
            q.is_valid(),
            "sub-pixel quadratic should be valid with f64 precision"
        );
    }

    /// Checks every rasterizer's output contract on `lines`: each scanline
    /// lies inside the canvas with `x1 <= x2` and alpha `<= 0xFFFF`, and no
    /// pixel is emitted twice (energy, colour and drawing blend each line
    /// once, so a repeated pixel would be weighted twice).
    fn assert_lines_well_formed(lines: &[Scanline], width: i32, height: i32, context: &str) {
        let mut seen = vec![false; (width * height) as usize];
        for line in lines {
            assert!(
                (0..height).contains(&line.y)
                    && 0 <= line.x1
                    && line.x1 <= line.x2
                    && line.x2 < width
                    && line.alpha <= 0xFFFF,
                "{context}: malformed {line:?} on {width}x{height}"
            );
            for x in line.x1..=line.x2 {
                let i = (line.y * width + x) as usize;
                assert!(
                    !seen[i],
                    "{context}: pixel ({x}, {}) emitted twice on {width}x{height}",
                    line.y
                );
                seen[i] = true;
            }
        }
    }

    fn assert_candidate_rasterization(
        shape: &Shape,
        worker: &mut WorkerCtx<rand_chacha::ChaCha8Rng>,
        context: &str,
    ) {
        let full = (worker.width, worker.height);
        for coarse in [false, true] {
            let (width, height) = if coarse {
                ((full.0 + 1) / 2, (full.1 + 1) / 2)
            } else {
                full
            };
            (worker.width, worker.height) = (width, height);
            let (x1, y1, x2, y2) = shape.candidate_rectangle(width, height, coarse);
            let lines = if coarse {
                shape.rasterize_coarse(worker)
            } else {
                shape.rasterize(worker)
            };
            assert_lines_well_formed(lines, width, height, context);
            for line in lines {
                assert!(
                    x1 <= line.x1 && line.x2 <= x2 && y1 <= line.y && line.y <= y2,
                    "{context}: {shape:?} coarse={coarse} rect={:?} line={line:?}",
                    (x1, y1, x2, y2)
                );
            }
        }
        (worker.width, worker.height) = full;
    }

    #[test]
    fn every_rasterizer_emits_each_pixel_at_most_once_and_in_bounds() {
        for (index, width, height) in [
            (0, 2, 2),
            (1, 3, 7),
            (2, 64, 48),
            (2, 65, 49),
            (3, 257, 255),
        ] {
            let (mut worker, round) = make_test_round(width, height, 100 + index as u64);
            for kind in
                std::iter::once(ShapeKind::Any).chain(ShapeKind::all_kinds().iter().copied())
            {
                for sample in 0..150 {
                    worker.quadratic_cap =
                        [LineCap::Butt, LineCap::Round, LineCap::Square][sample % 3];
                    worker.quadratic_width =
                        [(1.0, 1.0), (1.0, 16.0), (1.0, 32.0), (32.0, 32.0)][sample % 4];
                    let mut shape = Shape::random(kind, &mut worker, &round);
                    let steps = [
                        Step::Coarse,
                        Step::Coarse,
                        Step::Coarse,
                        Step::Coarse,
                        Step::Scaled(1.0),
                        Step::Scaled(crate::refine::MIN_SCALE),
                        Step::Scaled(crate::refine::MIN_SCALE),
                    ];
                    for (index, step) in steps.into_iter().enumerate() {
                        let context = format!("{kind:?} sample {sample} step {index}");
                        assert_candidate_rasterization(&shape, &mut worker, &context);
                        shape.mutate(&mut worker, step);
                    }
                    let context = format!("{kind:?} sample {sample} last step");
                    assert_candidate_rasterization(&shape, &mut worker, &context);
                }
            }
        }
    }

    #[test]
    fn curved_rasterizers_are_well_formed_at_every_margin_edge_and_corner() {
        let (width, height) = (24, 18);
        let (mut worker, _) = make_test_round(width, height, 7);
        for x in [-MARGIN, 0, width as i32 - 1, width as i32 - 1 + MARGIN] {
            for y in [-MARGIN, 0, height as i32 - 1, height as i32 - 1 + MARGIN] {
                for radius in [3, 20] {
                    for shape in [
                        Shape::Ellipse(Ellipse {
                            x,
                            y,
                            rx: radius,
                            ry: 3,
                        }),
                        Shape::Circle(Circle { x, y, r: radius }),
                        Shape::RotatedEllipse(RotatedEllipse {
                            x: f64::from(x),
                            y: f64::from(y),
                            rx: f64::from(radius),
                            ry: 3.0,
                            angle: 37.0,
                        }),
                    ] {
                        let context = format!("{shape:?}");
                        assert_lines_well_formed(
                            shape.rasterize(&mut worker),
                            width as i32,
                            height as i32,
                            &context,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn gaussian_samples_have_normal_moments_and_tails() {
        let mut rng = crate::rng::create_rng(0x901a);
        let (mut sum, mut squares, mut tails) = (0.0, 0.0, 0);
        const COUNT: usize = 1_000_000;
        for _ in 0..COUNT {
            let sample = gaussian_sample(&mut rng, 1.0);
            sum += sample;
            squares += sample * sample;
            tails += usize::from(sample.abs() > 3.0);
        }
        let mean = sum / COUNT as f64;
        let variance = squares / COUNT as f64 - mean * mean;
        let tail = tails as f64 / COUNT as f64;
        assert!(mean.abs() < 0.01, "mean {mean}");
        assert!((variance - 1.0).abs() < 0.01, "variance {variance}");
        assert!((tail - 0.0027).abs() < 0.0002, "tails {tail}");
    }

    /// FNV-1a of the little-endian IEEE bits of 1,000 unit-sigma samples
    /// from ChaCha8 seed 0x901a. Pins the polar sampler and uniform stream.
    #[test]
    fn gaussian_samples_are_pinned() {
        let mut rng = crate::rng::create_rng(0x901a);
        let digest =
            fnv1a((0..1000).flat_map(|_| gaussian_sample(&mut rng, 1.0).to_bits().to_le_bytes()));
        assert_eq!(digest, 3_848_654_534_955_378_079);
    }

    /// Scaled integer offsets are rounded and never zero: a single offset
    /// is non-zero, and a pair is not both zero, though one of them can
    /// be. At the refit's smallest scale they are one- and two-pixel
    /// moves, while a coarse offset is often zero.
    #[test]
    fn scaled_integer_offsets_are_never_zero() {
        let mut rng = crate::rng::create_rng(0x0ff5);
        let fine = Step::Scaled(crate::refine::MIN_SCALE);
        let (mut small, mut axis) = (0, 0);
        for _ in 0..2000 {
            let offset = fine.offset(&mut rng, POSITION_SIGMA);
            assert!(offset != 0 && offset.abs() <= 6, "{offset}");
            small += usize::from(offset.abs() <= 2);
            let (x, y) = fine.offsets(&mut rng, POSITION_SIGMA);
            assert!((x, y) != (0, 0) && x.abs() <= 6 && y.abs() <= 6, "{x}, {y}");
            axis += usize::from(x == 0 || y == 0);
            assert_ne!(Step::Scaled(1.0).offset(&mut rng, ANGLE_SIGMA), 0);
        }
        assert!(small > 1800, "{small} of 2000 offsets within 2 px");
        assert!(axis > 500, "{axis} of 2000 pairs move along one axis");
        let zero = (0..2000)
            .filter(|_| Step::Coarse.offset(&mut rng, POSITION_SIGMA) == 0)
            .count();
        assert!(zero > 50, "{zero} of 2000 coarse offsets are zero");
    }

    #[test]
    fn rotated_rectangle_left_of_the_canvas_emits_nothing() {
        let (mut worker, _) = round(16, 16);
        let shape = Shape::RotatedRectangle(RotatedRectangle {
            x: -20,
            y: 8,
            sx: 6,
            sy: 4,
            angle: 30,
        });
        assert_eq!(shape.rasterize(&mut worker), &[]);
    }

    /// The corners rotate by [`sin_cos_degrees`], never the platform's
    /// `sin_cos`, so every target and WebAssembly draw the same rectangles.
    #[test]
    fn rotated_rectangle_corners_rotate_by_the_portable_sine_and_cosine() {
        for angle in 0..360 {
            let shape = RotatedRectangle {
                x: 10,
                y: 12,
                sx: 7,
                sy: 3,
                angle,
            };
            let (sin, cos) = sin_cos_degrees(f64::from(angle));
            let expected = [(-3.5, -1.5), (3.5, -1.5), (3.5, 1.5), (-3.5, 1.5)].map(|(x, y)| {
                let (rx, ry) = rotate_sc(x, y, sin, cos);
                (rx + 10.0, ry + 12.0)
            });
            assert_eq!(shape.corners(), expected, "{angle}°");
        }
    }

    /// Quarter turns are exact: a 6 × 4 rectangle turned by 90° has the
    /// corners of a 4 × 6 one, in the turned order.
    #[test]
    fn quarter_turned_rotated_rectangles_have_exact_corners() {
        let corners = |angle| {
            RotatedRectangle {
                x: 10,
                y: 10,
                sx: 6,
                sy: 4,
                angle,
            }
            .corners()
        };
        assert_eq!(
            corners(0),
            [(7.0, 8.0), (13.0, 8.0), (13.0, 12.0), (7.0, 12.0)]
        );
        assert_eq!(
            corners(90),
            [(12.0, 7.0), (12.0, 13.0), (8.0, 13.0), (8.0, 7.0)]
        );
        assert_eq!(
            corners(180),
            [(13.0, 12.0), (7.0, 12.0), (7.0, 8.0), (13.0, 8.0)]
        );
        assert_eq!(
            corners(270),
            [(8.0, 13.0), (8.0, 7.0), (12.0, 7.0), (12.0, 13.0)]
        );
    }

    #[test]
    fn rotated_ellipse_mutate_clamps_ry_to_the_height() {
        let (mut worker, _) = round(64, 8);
        let mut shape = Shape::RotatedEllipse(RotatedEllipse {
            x: 32.0,
            y: 4.0,
            rx: 10.0,
            ry: 3.0,
            angle: 0.0,
        });
        for _ in 0..200 {
            shape.mutate(&mut worker, Step::Coarse);
            let Shape::RotatedEllipse(ellipse) = &shape else {
                panic!("expected a rotated ellipse");
            };
            assert!(
                (1.0..=63.0).contains(&ellipse.rx) && (1.0..=7.0).contains(&ellipse.ry),
                "{ellipse:?}"
            );
        }
    }
}

#[cfg(test)]
mod geometry_tests;
