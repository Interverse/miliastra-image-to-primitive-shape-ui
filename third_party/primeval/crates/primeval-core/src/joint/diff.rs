//! Differentiable compositing of a drawing's layers: the smooth forward
//! model, reverse-mode gradients through the layer stack and the colour
//! fit. The arithmetic rule of [`super`] applies to everything here.
//!
//! A layer is a triangle, a convex quadrilateral or a rotated rectangle,
//! covered by its exact area in the pixel's filter square: the one edge's
//! box-filtered half-plane where at most one edge cuts the square, and the
//! square clipped to the inside of its cutting edges where two or more do,
//! near a vertex; an axis-aligned rectangle, covered by the product of its
//! four sides' box-filtered half-planes, which for an axis-aligned box is
//! its exact pixel area; a circle or an ellipse, rotated or not, covered
//! by the box-filtered half-plane of its boundary taken as locally
//! straight at each pixel ([`Prepared::conic_coverage_grad`]); or a fixed
//! layer, covered by a [`Mask`] that does not move.
//!
//! Coordinates are the engine's: the centre of pixel `(i, j)` is `(i, j)`,
//! so a vertex `v` is the drawing's `v + 0.5`.

use crate::refine::checkpoint_interval;
use crate::scanline::{Scanline, clamp_line};
use rayon::prelude::*;
use std::ops::{Add, AddAssign, Div, Mul, Neg, Range, Sub};

/// The float the canvas is composited in: `f32` in production, `f64` for
/// the finite-difference checks.
pub(super) trait Real:
    Copy
    + Default
    + Send
    + Sync
    + PartialOrd
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
    + AddAssign
{
    fn of(value: f64) -> Self;
    fn get(self) -> f64;
    /// The square root, which IEEE 754 rounds exactly.
    fn sqrt(self) -> Self;
    fn abs(self) -> Self;
}

impl Real for f32 {
    #[inline]
    fn of(value: f64) -> Self {
        value as f32
    }
    #[inline]
    fn get(self) -> f64 {
        f64::from(self)
    }
    #[inline]
    fn sqrt(self) -> Self {
        f32::sqrt(self)
    }
    #[inline]
    fn abs(self) -> Self {
        f32::abs(self)
    }
}

impl Real for f64 {
    #[inline]
    fn of(value: f64) -> Self {
        value
    }
    #[inline]
    fn get(self) -> f64 {
        self
    }
    #[inline]
    fn sqrt(self) -> Self {
        f64::sqrt(self)
    }
    #[inline]
    fn abs(self) -> Self {
        f64::abs(self)
    }
}

/// The over-relaxation `ω` of [`fit`]'s step, in `(0, 2)`, where the step
/// cannot raise the loss. Chosen against `1.0`, `1.3`, `1.7` and `1.9` on
/// the engine runner's corpus.
pub(super) const OVER_RELAXATION: f64 = 1.5;

/// Geometric parameters per layer, at most: a quadrilateral's vertex
/// coordinates `x0, y0, …, x3, y3`. The other outlines use the first
/// [`Outline::params`].
pub(super) const COORDS: usize = 8;
/// The gradient entry of the opacity, after the geometric parameters.
pub(super) const ALPHA: usize = COORDS;
/// Gradient entries per layer: the geometric parameters, then the opacity.
pub(super) const PARAMS: usize = COORDS + 1;

/// What covers a layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outline {
    /// A triangle through three vertices, parameters `x0, y0, x1, y1, x2,
    /// y2`.
    Triangle,
    /// A convex quadrilateral through four vertices, parameters `x0, y0,
    /// …, x3, y3`.
    Quad,
    /// An axis-aligned rectangle `x0 ≤ x ≤ x1`, `y0 ≤ y ≤ y1`, parameters
    /// `x0, y0, x1, y1`.
    Rect,
    /// A rectangle of centre `c`, half-side vector `u` and half-width `h`
    /// along `u`'s perpendicular, parameters `cx, cy, ux, uy, h`: its
    /// corners are `c ± u ± (h / |u|) · (−u_y, u_x)` ([`Layer::corners`]).
    Rotated,
    /// A circle of centre `c` and radius `r`, parameters `cx, cy, r`.
    Circle,
    /// An axis-aligned ellipse of centre `c` and radii `rx` along `x` and
    /// `ry` along `y`, parameters `cx, cy, rx, ry`.
    Ellipse,
    /// An ellipse of centre `c`, semi-axis vector `a` and other semi-axis
    /// `b` along `a`'s perpendicular, parameters `cx, cy, ax, ay, b`: no
    /// angle, so no trigonometry, as a rotated rectangle's `c, u, h`.
    RotatedEllipse,
    /// A fixed shape: the [`Scene::masks`] entry of this index, which does
    /// not move; only its opacity and colour are optimised.
    Fixed(usize),
}

impl Outline {
    /// The number of edges, `0` for a curved or a fixed layer.
    pub(super) fn sides(self) -> usize {
        match self {
            Self::Triangle => 3,
            Self::Quad | Self::Rect | Self::Rotated => 4,
            Self::Circle | Self::Ellipse | Self::RotatedEllipse | Self::Fixed(_) => 0,
        }
    }

    /// Whether the outline is a circle or an ellipse, rotated or not.
    pub(super) fn curved(self) -> bool {
        matches!(self, Self::Circle | Self::Ellipse | Self::RotatedEllipse)
    }

    /// The number of geometric parameters, `0` for a fixed layer.
    pub(super) fn params(self) -> usize {
        match self {
            Self::Triangle => 6,
            Self::Quad => 8,
            Self::Rect | Self::Ellipse => 4,
            Self::Rotated | Self::RotatedEllipse => 5,
            Self::Circle => 3,
            Self::Fixed(_) => 0,
        }
    }
}

/// One layer's parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Layer {
    pub(super) outline: Outline,
    /// The geometric parameters of the outline ([`Outline`]), in engine
    /// coordinates; the first [`Outline::params`] are used, the others are
    /// zero.
    pub(super) params: [f64; COORDS],
    /// Opacity, `1..=255`.
    pub(super) alpha: f64,
    /// RGB, `0..=255`.
    pub(super) color: [f64; 3],
}

impl Layer {
    /// A triangle through the six coordinates `v`.
    #[cfg(test)]
    pub(super) fn triangle(v: [f64; 6], alpha: f64, color: [f64; 3]) -> Self {
        Self {
            outline: Outline::Triangle,
            params: [v[0], v[1], v[2], v[3], v[4], v[5], 0.0, 0.0],
            alpha,
            color,
        }
    }

    /// The vertex coordinates of the outline, `x0, y0, …`, of which the
    /// first `2 · outline.sides()` are used: a triangle's or a
    /// quadrilateral's parameters; a rectangle's corners `(x0, y0)`,
    /// `(x1, y0)`, `(x1, y1)`, `(x0, y1)`; a rotated rectangle's
    /// `c − u − n`, `c + u − n`, `c + u + n` and `c − u + n`, with
    /// `n = (h / |u|) · (−u_y, u_x)`, by `sqrt` alone. The parameters
    /// themselves for a curved layer, which has no corners, and all zero
    /// for a fixed layer.
    pub(super) fn corners(&self) -> [f64; COORDS] {
        let p = self.params;
        match self.outline {
            Outline::Triangle
            | Outline::Quad
            | Outline::Circle
            | Outline::Ellipse
            | Outline::RotatedEllipse
            | Outline::Fixed(_) => p,
            Outline::Rect => [p[0], p[1], p[2], p[1], p[2], p[3], p[0], p[3]],
            Outline::Rotated => {
                let [cx, cy, ux, uy, h, ..] = p;
                let k = h / (ux * ux + uy * uy).sqrt().max(1e-9);
                let (nx, ny) = (-uy * k, ux * k);
                [
                    cx - ux - nx,
                    cy - uy - ny,
                    cx + ux - nx,
                    cy + uy - ny,
                    cx + ux + nx,
                    cy + uy + ny,
                    cx - ux + nx,
                    cy - uy + ny,
                ]
            }
        }
    }

    /// A curved layer's centre `cx, cy`, semi-axis vector `ax, ay` and other
    /// semi-axis `b`: a circle's `a` is `(r, 0)` and its `b` is `r`, an
    /// axis-aligned ellipse's `a` is `(rx, 0)` and its `b` is `ry`.
    pub(super) fn conic(&self) -> [f64; 5] {
        let p = self.params;
        match self.outline {
            Outline::Circle => [p[0], p[1], p[2], 0.0, p[2]],
            Outline::Ellipse => [p[0], p[1], p[2], 0.0, p[3]],
            Outline::RotatedEllipse => [p[0], p[1], p[2], p[3], p[4]],
            outline => panic!("not a curved outline: {outline:?}"),
        }
    }

    /// The gradient with respect to the parameters, from `grad`, with
    /// respect to the [`Self::corners`] (and the opacity, which passes
    /// through). The same for every outline but a rotated rectangle's,
    /// whose corners depend on `c`, `u` and `h` through `n`:
    /// `∂n/∂h = (−u_y, u_x) / |u|` and
    /// `∂n/∂u = (h / |u|³) · [[u_x u_y, −u_x²], [u_y², −u_x u_y]]`
    /// (rows `n_x`, `n_y`; columns `u_x`, `u_y`).
    ///
    /// A curved layer's coverage has its gradient with respect to the
    /// centre, the length `ra = |a|` of its semi-axis vector, the angle `φ`
    /// of that vector and the other semi-axis `b` ([`Layer::conic`],
    /// [`Prepared::conic_coverage_grad`]): a circle's radius is both `ra`
    /// and `b`, an axis-aligned ellipse's `rx` is `ra` and its `ry` is `b`,
    /// and a rotated ellipse's `a` moves `ra` along `â = a / ra` and `φ`
    /// along `â⊥ / ra`, with `â⊥ = (−â_y, â_x)`.
    fn chain(&self, grad: [f64; PARAMS]) -> [f64; PARAMS] {
        if self.outline.curved() {
            let mut out = [0.0; PARAMS];
            let [centre_x, centre_y, along, turn, across, ..] = grad;
            out[0] = centre_x;
            out[1] = centre_y;
            match self.outline {
                Outline::Circle => out[2] = along + across,
                Outline::Ellipse => {
                    out[2] = sign(self.params[2]) * along;
                    out[3] = across;
                }
                _ => {
                    let [_, _, ax, ay, ..] = self.params;
                    let ra = (ax * ax + ay * ay).sqrt().max(1e-9);
                    let (ux, uy) = (ax / ra, ay / ra);
                    out[2] = ux * along - uy * turn / ra;
                    out[3] = uy * along + ux * turn / ra;
                    out[4] = across;
                }
            }
            out[ALPHA] = grad[ALPHA];
            return out;
        }
        if self.outline != Outline::Rotated {
            return grad;
        }
        let [_, _, ux, uy, h, ..] = self.params;
        let r = (ux * ux + uy * uy).sqrt().max(1e-9);
        let r3 = r * r * r;
        // The corners' signs on `u` and on `n`.
        let (on_u, on_n) = ([-1.0, 1.0, 1.0, -1.0], [-1.0, -1.0, 1.0, 1.0]);
        let (mut centre, mut along_u, mut along_n) = ([0.0; 2], [0.0; 2], [0.0; 2]);
        for corner in 0..4 {
            for axis in 0..2 {
                let g = grad[2 * corner + axis];
                centre[axis] += g;
                along_u[axis] += on_u[corner] * g;
                along_n[axis] += on_n[corner] * g;
            }
        }
        let mut out = [0.0; PARAMS];
        out[0] = centre[0];
        out[1] = centre[1];
        out[2] = along_u[0] + (along_n[0] * ux * uy + along_n[1] * uy * uy) * h / r3;
        out[3] = along_u[1] - (along_n[0] * ux * ux + along_n[1] * ux * uy) * h / r3;
        out[4] = (-along_n[0] * uy + along_n[1] * ux) / r;
        out[ALPHA] = grad[ALPHA];
        out
    }
}

/// The coverage of a fixed layer: one value in `0..=1` per pixel of a box
/// of the canvas, row-major.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Mask<F> {
    pub(super) x0: usize,
    pub(super) x1: usize,
    pub(super) y0: usize,
    pub(super) y1: usize,
    pub(super) coverage: Vec<F>,
}

impl<F: Real> Mask<F> {
    /// The coverage of the engine's scanlines `lines` on a canvas
    /// `width × height`: each pixel of a line at the line's coverage, as
    /// the engine's own compositing weighs it (`alpha / 0xFFFF`), every
    /// other pixel at zero. The box is the lines' bounding box on the
    /// canvas, empty without lines.
    pub(super) fn from_lines(lines: &[Scanline], width: usize, height: usize) -> Self {
        let spans: Vec<(usize, usize, usize, f64)> = lines
            .iter()
            .filter_map(|line| {
                let (x1, x2) = clamp_line(line, width as i32, height as i32)?;
                Some((
                    line.y as usize,
                    x1 as usize,
                    x2 as usize + 1,
                    line.coverage(),
                ))
            })
            .collect();
        if spans.is_empty() {
            return Self::default();
        }
        let x0 = spans.iter().map(|span| span.1).min().unwrap_or(0);
        let x1 = spans.iter().map(|span| span.2).max().unwrap_or(0);
        let y0 = spans.iter().map(|span| span.0).min().unwrap_or(0);
        let y1 = spans.iter().map(|span| span.0).max().unwrap_or(0) + 1;
        let box_width = x1 - x0;
        let mut coverage = vec![F::of(0.0); box_width * (y1 - y0)];
        for (y, start, end, share) in spans {
            let value = F::of(share);
            let row = (y - y0) * box_width;
            for cell in &mut coverage[row + start - x0..row + end - x0] {
                *cell = value;
            }
        }
        Self {
            x0,
            x1,
            y0,
            y1,
            coverage,
        }
    }
}

/// The target and the background a stack of layers is composited on, and
/// the masks of its fixed layers.
pub(super) struct Scene<F> {
    pub(super) width: usize,
    pub(super) height: usize,
    /// RGB per pixel, row-major.
    pub(super) target: Vec<F>,
    pub(super) background: [F; 3],
    /// Width in pixels of the box filter the coverage is convolved with:
    /// `1` is exact pixel-area coverage, and the only width production
    /// uses.
    pub(super) filter: f64,
    /// The coverage of each fixed layer ([`Outline::Fixed`]).
    pub(super) masks: Vec<Mask<F>>,
}

/// One edge's box-filtered half-plane, `F(d)` with `d` the signed distance
/// of a pixel centre from the edge, positive inside.
#[derive(Clone, Copy, Default)]
struct Edge<F> {
    /// `d(x, y) = nx · x + ny · y + c`.
    nx: F,
    ny: F,
    c: F,
    /// The filter square projected on the edge normal is the sum of two
    /// uniforms of widths `wide ≥ narrow`; `F` is the CDF of that sum,
    /// held through `(wide ± narrow) / 2` and the inverses below.
    half_sum: F,
    half_diff: F,
    inv_wide: F,
    /// `1 / (2 · wide · narrow)`, or `0` when `narrow` is `0` (the
    /// quadratic pieces are then empty).
    inv_2ab: F,
    inv_narrow: F,
    /// For the derivatives: the start `P`, the vector `e = Q − P`, `1 / |e|`,
    /// the orientation sign, and `∂wide/∂e`, `∂narrow/∂e`.
    px: F,
    py: F,
    ex: F,
    ey: F,
    inv_l: F,
    sigma: F,
    dwide: [F; 2],
    dnarrow: [F; 2],
}

/// `F(d)` and its partials `∂F/∂d`, `∂F/∂wide`, `∂F/∂narrow`.
#[derive(Clone, Copy)]
struct EdgeValue<F> {
    f: F,
    fd: F,
    fa: F,
    fb: F,
}

/// How a [`Prepared`] layer covers its pixels.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Kind {
    /// A fixed layer's mask.
    #[default]
    Masked,
    /// Three edges.
    Triangle,
    /// Four edges: a quadrilateral or a rotated rectangle.
    Quad,
    /// An axis-aligned rectangle's four sides.
    Box,
    /// A circle or an ellipse, rotated or not.
    Curved,
}

impl Kind {
    /// The number of gradient entries its coverage has: the vertex
    /// coordinates of the edges, a rectangle's four parameters, or a
    /// curved layer's centre, `ra`, `φ` and `b` ([`Layer::chain`]).
    fn coords(self) -> usize {
        match self {
            Self::Masked => 0,
            Self::Triangle => 6,
            Self::Quad => 8,
            Self::Box => 4,
            Self::Curved => 5,
        }
    }
}

/// A curved layer ready to cover pixels ([`Prepared::conic_coverage`]):
/// its centre, the unit vector `â = a / ra` along its semi-axis vector,
/// the inverses of its semi-axes `ra` and `b`, the shorter of the two, the
/// square of the radius of the disc about the centre that covers whole
/// pixels (negative if none does), and the filter width and its reach,
/// `filter · 0.7072`.
#[derive(Clone, Copy, Default)]
struct Conic<F> {
    cx: F,
    cy: F,
    ux: F,
    uy: F,
    ra: F,
    b: F,
    inv_ra: F,
    inv_b: F,
    shorter: F,
    inner2: F,
    filter: F,
    reach: F,
}

/// A layer ready to composite: the edges of a triangle or a quadrilateral
/// (the first three or four), the sides of an axis-aligned rectangle or a
/// fixed layer's mask, its bounding box on the canvas (`x0..x1`, `y0..y1`,
/// empty if it cannot cover any pixel), its opacity as a fraction and its
/// colour.
#[derive(Clone, Copy, Default)]
pub(super) struct Prepared<'a, F> {
    kind: Kind,
    edges: [Edge<F>; 4],
    /// An axis-aligned rectangle's `x0, y0, x1, y1`, then `1 / filter`;
    /// zero for the others.
    rect: [F; 5],
    /// A curved layer's ellipse; zero for the others.
    conic: Conic<F>,
    /// A fixed layer's coverage over the bounding box, row-major; empty
    /// for the others.
    mask: &'a [F],
    /// Half the filter width and `1 / filter²`, for the exact clip of
    /// [`Self::clip`]; zero for an axis-aligned rectangle and a fixed
    /// layer.
    half: F,
    inv_area: F,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    opacity: F,
    color: [F; 3],
}

/// The most vertices a pixel square clipped by a layer's edges can have:
/// the square's four, and one more per edge, at most four.
const CLIP: usize = 8;

/// No edge of the layer: the label of a side of the pixel square.
const SQUARE: u8 = u8::MAX;

/// The filter square of a pixel clipped to the inside of a layer's
/// cutting edges ([`Prepared::clip`]): a convex polygon, its vertices
/// relative to the pixel centre, and for each vertex `i` the edge of the
/// layer the side from vertex `i` to vertex `i + 1` lies on, or
/// [`SQUARE`].
struct Clipped<F> {
    u: [F; CLIP],
    v: [F; CLIP],
    on: [u8; CLIP],
    len: usize,
}

impl<F: Real> Edge<F> {
    /// An edge that holds only its ramp, [`Self::cdf`] and
    /// [`Self::cdf_grad`], for the filter square projected on a normal
    /// whose widths are `wide ≥ narrow`, as [`Prepared::new`] computes an
    /// edge's: a `narrow` below `1e-6` counts as `0`.
    #[inline]
    fn ramp(wide: F, narrow: F) -> Self {
        let (zero, one, half) = (F::of(0.0), F::of(1.0), F::of(0.5));
        let narrow = if narrow < F::of(1e-6) { zero } else { narrow };
        let (inv_2ab, inv_narrow) = if narrow > zero {
            (half / (wide * narrow), one / narrow)
        } else {
            (zero, zero)
        };
        Self {
            half_sum: (wide + narrow) * half,
            half_diff: (wide - narrow) * half,
            inv_wide: one / wide,
            inv_2ab,
            inv_narrow,
            ..Self::default()
        }
    }

    #[inline]
    fn distance(&self, x: F, y: F) -> F {
        self.nx * x + self.ny * y + self.c
    }

    /// The ramp test: whether the signed distance `d` is exactly at an
    /// endpoint `±half_sum` of an axis-aligned edge's ramp (`narrow` is 0),
    /// where `F` has a kink. The derivative paths use the mean of its two
    /// one-sided slopes there ([`Self::cdf_grad`]).
    #[inline]
    fn at_ramp_end(&self, d: F) -> bool {
        self.inv_narrow == F::of(0.0) && d.abs() == self.half_sum
    }

    /// The exact-axis test's offset: for an edge along an axis, the signed
    /// offset of `(x, y)` from it, positive inside, from its start alone,
    /// so it is exact where the normalised [`Self::distance`] can lose an
    /// ulp; `None` for an oblique edge.
    #[inline]
    fn axial_offset(&self, x: F, y: F) -> Option<F> {
        let zero = F::of(0.0);
        if self.ex == zero && self.ey != zero {
            Some(if self.nx < zero {
                self.px - x
            } else {
                x - self.px
            })
        } else if self.ey == zero && self.ex != zero {
            Some(if self.ny < zero {
                self.py - y
            } else {
                y - self.py
            })
        } else {
            None
        }
    }

    /// `F(d)`: piecewise quadratic, `C¹` except at the two endpoints
    /// of an axis-aligned linear ramp.
    #[inline]
    fn cdf(&self, d: F) -> F {
        let (h, k) = (self.half_sum, self.half_diff);
        if d <= -h {
            F::of(0.0)
        } else if d >= h {
            F::of(1.0)
        } else if d < -k {
            let u = d + h;
            u * u * self.inv_2ab
        } else if d <= k {
            F::of(0.5) + d * self.inv_wide
        } else {
            let v = h - d;
            F::of(1.0) - v * v * self.inv_2ab
        }
    }

    #[inline]
    fn cdf_grad(&self, d: F) -> EdgeValue<F> {
        let (h, k) = (self.half_sum, self.half_diff);
        let zero = F::of(0.0);
        if self.at_ramp_end(d) {
            // At an axis-aligned ramp's kink use the mean of its two
            // one-sided derivatives, keeping the forward value exact.
            EdgeValue {
                f: if d == -h { zero } else { F::of(1.0) },
                fd: F::of(0.5) * self.inv_wide,
                fa: -F::of(0.5) * d * self.inv_wide * self.inv_wide,
                fb: zero,
            }
        } else if d <= -h {
            EdgeValue {
                f: zero,
                fd: zero,
                fa: zero,
                fb: zero,
            }
        } else if d >= h {
            EdgeValue {
                f: F::of(1.0),
                fd: zero,
                fa: zero,
                fb: zero,
            }
        } else if d < -k {
            let u = d + h;
            let f = u * u * self.inv_2ab;
            let half = u * self.inv_2ab;
            EdgeValue {
                f,
                fd: half + half,
                fa: half - f * self.inv_wide,
                fb: half - f * self.inv_narrow,
            }
        } else if d <= k {
            EdgeValue {
                f: F::of(0.5) + d * self.inv_wide,
                fd: self.inv_wide,
                fa: -d * self.inv_wide * self.inv_wide,
                fb: zero,
            }
        } else {
            let v = h - d;
            let rest = v * v * self.inv_2ab;
            let half = v * self.inv_2ab;
            EdgeValue {
                f: F::of(1.0) - rest,
                fd: half + half,
                fa: rest * self.inv_wide - half,
                fb: rest * self.inv_narrow - half,
            }
        }
    }

    /// `∂F/∂(Px, Py, Qx, Qy)` at the pixel `(x, y)` with distance `d`.
    #[inline]
    fn endpoint_grad(&self, value: EdgeValue<F>, x: F, y: F, d: F) -> [F; 4] {
        let inv_l2 = self.inv_l * self.inv_l;
        let dd_dex = self.sigma * (y - self.py) * self.inv_l - d * self.ex * inv_l2;
        let dd_dey = -self.sigma * (x - self.px) * self.inv_l - d * self.ey * inv_l2;
        let df_dex = value.fd * dd_dex + value.fa * self.dwide[0] + value.fb * self.dnarrow[0];
        let df_dey = value.fd * dd_dey + value.fa * self.dwide[1] + value.fb * self.dnarrow[1];
        let direct_x = value.fd * self.sigma * self.ey * self.inv_l;
        let direct_y = -value.fd * self.sigma * self.ex * self.inv_l;
        [direct_x - df_dex, direct_y - df_dey, df_dex, df_dey]
    }
}

/// The pixels `start..end` of a canvas axis of `size` pixels whose
/// centres lie in `[low, high]`, or `None` if there are none.
fn pixel_span(low: f64, high: f64, size: usize) -> Option<(usize, usize)> {
    let start = low.ceil().max(0.0);
    let end = (high.floor() + 1.0).min(size as f64);
    (start < end).then_some((start as usize, end as usize))
}

/// The pixels `start..end` of a canvas axis of `size` pixels whose
/// centres an axis-aligned rectangle's sides at `low` and `high` cover with
/// a box filter of width `filter`, or `None` if there are none or the
/// rectangle is empty.
fn box_span(low: f64, high: f64, filter: f64, size: usize) -> Option<(usize, usize)> {
    if low >= high {
        return None;
    }
    pixel_span(low - filter / 2.0, high + filter / 2.0, size)
}

/// `1` for a non-negative `value`, `−1` for a negative one: the sign the
/// derivative of `|value|` takes, `+1` at zero.
#[inline]
fn sign(value: f64) -> f64 {
    if value < 0.0 { -1.0 } else { 1.0 }
}

impl<'a, F: Real> Prepared<'a, F> {
    pub(super) fn new(layer: &Layer, scene: &'a Scene<F>) -> Self {
        let opacity = F::of(layer.alpha / 255.0);
        let color = layer.color.map(F::of);
        let sides = layer.outline.sides();
        let kind = match layer.outline {
            Outline::Triangle => Kind::Triangle,
            Outline::Quad | Outline::Rotated => Kind::Quad,
            Outline::Rect => Kind::Box,
            Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse => {
                return Self::curved(layer, scene, opacity, color);
            }
            Outline::Fixed(index) => {
                let mask = &scene.masks[index];
                return Self {
                    kind: Kind::Masked,
                    mask: &mask.coverage,
                    x0: mask.x0,
                    x1: mask.x1,
                    y0: mask.y0,
                    y1: mask.y1,
                    opacity,
                    color,
                    ..Self::default()
                };
            }
        };
        let filter = scene.filter;
        let v = layer.corners();
        if kind == Kind::Box {
            let p = layer.params;
            // A side's ramp is zero from half the filter outside it.
            let (x0, x1, y0, y1) = match (
                box_span(p[0], p[2], filter, scene.width),
                box_span(p[1], p[3], filter, scene.height),
            ) {
                (Some((x0, x1)), Some((y0, y1))) => (x0, x1, y0, y1),
                _ => (0, 0, 0, 0),
            };
            return Self {
                kind,
                rect: [p[0], p[1], p[2], p[3], 1.0 / filter].map(F::of),
                x0,
                x1,
                y0,
                y1,
                opacity,
                color,
                ..Self::default()
            };
        }
        let cross = if sides == 3 {
            super::twice_signed_area_triangle(&v)
        } else {
            super::twice_shoelace(&v, sides)
        };
        let sigma = if cross >= 0.0 { 1.0 } else { -1.0 };
        let mut visible = cross.abs() > 1e-9;
        let edges = std::array::from_fn(|e| {
            if e >= sides {
                return Edge::default();
            }
            let (p, q) = (e, (e + 1) % sides);
            let (px, py) = (v[2 * p], v[2 * p + 1]);
            let (ex, ey) = (v[2 * q] - px, v[2 * q + 1] - py);
            let l = (ex * ex + ey * ey).sqrt();
            if l < 1e-9 {
                visible = false;
            }
            let l = l.max(1e-9);
            let inv_l = 1.0 / l;
            let inv_l3 = inv_l * inv_l * inv_l;
            // Widths of the filter square projected on the normal
            // `σ (−ey, ex) / l`, and their gradients with respect to `e`.
            let u = filter * ey.abs() * inv_l;
            let du = [
                -filter * ey.abs() * ex * inv_l3,
                filter * (sign(ey) * inv_l - ey.abs() * ey * inv_l3),
            ];
            let w = filter * ex.abs() * inv_l;
            let dw = [
                filter * (sign(ex) * inv_l - ex.abs() * ex * inv_l3),
                -filter * ex.abs() * ey * inv_l3,
            ];
            let ((wide, dwide), (mut narrow, dnarrow)) = if u >= w {
                ((u, du), (w, dw))
            } else {
                ((w, dw), (u, du))
            };
            if narrow < 1e-6 {
                narrow = 0.0;
            }
            let (inv_2ab, inv_narrow) = if narrow > 0.0 {
                (0.5 / (wide * narrow), 1.0 / narrow)
            } else {
                (0.0, 0.0)
            };
            Edge {
                nx: F::of(-sigma * ey * inv_l),
                ny: F::of(sigma * ex * inv_l),
                c: F::of(sigma * (ey * px - ex * py) * inv_l),
                half_sum: F::of((wide + narrow) / 2.0),
                half_diff: F::of((wide - narrow) / 2.0),
                inv_wide: F::of(1.0 / wide),
                inv_2ab: F::of(inv_2ab),
                inv_narrow: F::of(inv_narrow),
                px: F::of(px),
                py: F::of(py),
                ex: F::of(ex),
                ey: F::of(ey),
                inv_l: F::of(inv_l),
                sigma: F::of(sigma),
                dwide: dwide.map(F::of),
                dnarrow: dnarrow.map(F::of),
            }
        });
        // A pixel centre further than `filter · √2 / 2` outside an edge is
        // not covered.
        let reach = filter * 0.707_2;
        let span = |offset: usize, size: usize| {
            let values = (1..sides).map(|k| v[2 * k + offset]);
            let low = values.clone().fold(v[offset], f64::min) - reach;
            let high = values.fold(v[offset], f64::max) + reach;
            match pixel_span(low, high, size) {
                Some(span) if visible => span,
                _ => (0, 0),
            }
        };
        let (x0, x1) = span(0, scene.width);
        let (y0, y1) = span(1, scene.height);
        let (x0, x1, y0, y1) = if x0 < x1 && y0 < y1 {
            (x0, x1, y0, y1)
        } else {
            (0, 0, 0, 0)
        };
        Self {
            kind,
            edges,
            half: F::of(filter / 2.0),
            inv_area: F::of(1.0 / (filter * filter)),
            x0,
            x1,
            y0,
            y1,
            opacity,
            color,
            ..Self::default()
        }
    }

    /// A curved layer, ready to composite: its [`Conic`], and its bounding
    /// box, the ellipse's expanded by the reach `filter · 0.7072` beyond
    /// which a pixel centre's filter square cannot meet it, as for the
    /// edges. The ellipse of centre `c`, semi-axis vector `a` and other
    /// semi-axis `b` has half-extents `√(a_x² + (b a_y / |a|)²)` along `x`
    /// and `√(a_y² + (b a_x / |a|)²)` along `y`. A layer with a semi-axis
    /// of `1e-9` or less covers nothing.
    fn curved(layer: &Layer, scene: &'a Scene<F>, opacity: F, color: [F; 3]) -> Self {
        let filter = scene.filter;
        let reach = filter * 0.707_2;
        let [cx, cy, ax, ay, b] = layer.conic();
        let ra = (ax * ax + ay * ay).sqrt();
        let visible = ra > 1e-9 && b > 1e-9;
        let (ra, b) = (ra.max(1e-9), b.max(1e-9));
        let (ux, uy) = (ax / ra, ay / ra);
        let half_x = (ax * ax + (b * uy) * (b * uy)).sqrt();
        let half_y = (ay * ay + (b * ux) * (b * ux)).sqrt();
        let span = |centre: f64, half: f64, size: usize| {
            pixel_span(centre - half - reach, centre + half + reach, size)
        };
        let (x0, x1, y0, y1) = match (
            span(cx, half_x, scene.width),
            span(cy, half_y, scene.height),
        ) {
            (Some((x0, x1)), Some((y0, y1))) if visible => (x0, x1, y0, y1),
            _ => (0, 0, 0, 0),
        };
        let shorter = ra.min(b);
        let inner = shorter - reach;
        Self {
            kind: Kind::Curved,
            conic: Conic {
                cx: F::of(cx),
                cy: F::of(cy),
                ux: F::of(ux),
                uy: F::of(uy),
                ra: F::of(ra),
                b: F::of(b),
                inv_ra: F::of(1.0 / ra),
                inv_b: F::of(1.0 / b),
                shorter: F::of(shorter),
                inner2: F::of(if inner > 0.0 { inner * inner } else { -1.0 }),
                filter: F::of(filter),
                reach: F::of(reach),
            },
            x0,
            x1,
            y0,
            y1,
            opacity,
            color,
            ..Self::default()
        }
    }

    /// The rows of `y0..y1` the bounding box reaches, empty if none.
    fn rows(&self, y0: usize, y1: usize) -> Range<usize> {
        self.y0.max(y0)..self.y1.min(y1).max(self.y0.max(y0))
    }

    /// The number of pixels in the bounding box.
    fn box_pixels(&self) -> usize {
        (self.x1 - self.x0) * (self.y1 - self.y0)
    }

    /// The coverage of the pixel `(x, y)` inside the bounding box, with
    /// `fy` the row as a float, by the layer's [`Cover`].
    #[cfg(test)]
    fn pixel(&self, x: usize, y: usize, fy: F) -> F {
        match self.kind {
            Kind::Masked => Masked::cover(self, x, y, fy),
            Kind::Triangle => Edges::<3>::cover(self, x, y, fy),
            Kind::Quad => Edges::<4>::cover(self, x, y, fy),
            Kind::Box => Boxed::cover(self, x, y, fy),
            Kind::Curved => Curved::cover(self, x, y, fy),
        }
    }

    /// The coverage of the pixel centred at `(x, y)` by the edges or the
    /// sides: the layer's exact area in the pixel's filter square.
    #[cfg(test)]
    fn coverage(&self, x: F, y: F) -> F {
        match self.kind {
            Kind::Triangle => self.edge_coverage::<3>(x, y),
            Kind::Quad => self.edge_coverage::<4>(x, y),
            Kind::Box => self.box_coverage(x, y),
            Kind::Curved => self.conic_coverage(x, y),
            Kind::Masked => panic!("a mask has no edges"),
        }
    }

    /// The coverage of the pixel centred at `(x, y)` by an axis-aligned
    /// rectangle, as [`Self::box_coverage_grad`] computes it.
    #[inline]
    fn box_coverage(&self, x: F, y: F) -> F {
        let [x0, y0, x1, y1, inv] = self.rect;
        let (zero, one, half) = (F::of(0.0), F::of(1.0), F::of(0.5));
        let mut product = one;
        for d in [x - x0, y - y0, x1 - x, y1 - y] {
            let t = half + d * inv;
            if t <= zero {
                return zero;
            }
            if t < one {
                product = product * t;
            }
        }
        product
    }

    /// The coverage of the pixel centred at `(x, y)` by an axis-aligned
    /// rectangle and its gradient with respect to `x0, y0, x1, y1`, or
    /// `None` where the pixel is strictly outside a side's ramp.
    ///
    /// Each side's box-filtered half-plane is a ramp, `clamp(t)` with
    /// `t = 1/2 + d / f`, `d` the signed distance inside the side and `f`
    /// the filter width. The coverage is the product of the four ramps:
    /// the left and right ones give the overlap of the filter square with
    /// `x0..x1` along `x` as long as `x1 − x0 ≥ f`, so that no square
    /// crosses both sides, and likewise along `y`; the box filter is
    /// separable, so the product is the exact area of the rectangle in the
    /// filter square. Rectangles keep their sides at least 1 px, the
    /// export's filter width.
    ///
    /// A ramp's slope is `1 / f` for `0 < t < 1`, and half that at `t = 0`
    /// and `t = 1`, the mean of its one-sided slopes. The greedy search's
    /// rectangles have their sides on pixel boundaries, where the pixels on
    /// both sides sit at those ends: with the slope of either side alone
    /// the side would have no gradient there, or twice its one-sided ones.
    /// So a pixel at `t = 0` of a ramp, which has no coverage, still has a
    /// gradient.
    #[inline]
    fn box_coverage_grad(&self, x: F, y: F) -> Option<(F, [F; COORDS])> {
        let [x0, y0, x1, y1, inv] = self.rect;
        let (zero, one, half) = (F::of(0.0), F::of(1.0), F::of(0.5));
        let ramp = |d: F| {
            let t = half + d * inv;
            if t < zero {
                None
            } else if t > zero && t < one {
                Some((t, inv))
            } else if t == zero {
                Some((zero, half * inv))
            } else if t == one {
                Some((one, half * inv))
            } else {
                Some((one, zero))
            }
        };
        let (left, dleft) = ramp(x - x0)?;
        let (top, dtop) = ramp(y - y0)?;
        let (right, dright) = ramp(x1 - x)?;
        let (bottom, dbottom) = ramp(y1 - y)?;
        let (across, down) = (left * right, top * bottom);
        let mut grad = [zero; COORDS];
        grad[0] = -dleft * right * down;
        grad[1] = -dtop * bottom * across;
        grad[2] = dright * left * down;
        grad[3] = dbottom * top * across;
        Some((across * down, grad))
    }

    /// [`Self::coverage`] of the first `N` edges, three or four.
    #[inline]
    fn edge_coverage<const N: usize>(&self, x: F, y: F) -> F {
        let d: [F; N] = std::array::from_fn(|e| self.edges[e].distance(x, y));
        let Some((cutting, last)) = self.cutting(&d, false) else {
            return F::of(0.0);
        };
        match cutting {
            0 => F::of(1.0),
            1 => self.edges[last].cdf(d[last]),
            _ => self.clip(&d).coverage(self.inv_area),
        }
    }

    /// The coverage of the pixel centred at `(x, y)` by a curved layer, as
    /// [`Self::conic_coverage_grad`] computes it.
    #[inline]
    fn conic_coverage(&self, x: F, y: F) -> F {
        let c = &self.conic;
        let (zero, one) = (F::of(0.0), F::of(1.0));
        let (dx, dy) = (x - c.cx, y - c.cy);
        if dx * dx + dy * dy <= c.inner2 {
            return one;
        }
        let (p1, p2) = (dx * c.ux + dy * c.uy, dy * c.ux - dx * c.uy);
        let (q1, q2) = (p1 * c.inv_ra, p2 * c.inv_b);
        let a = q1 * q1 + q2 * q2;
        let r = a.sqrt();
        if r < F::of(1e-9) {
            return Edge::ramp(c.filter, zero).cdf(c.shorter);
        }
        let (alpha, beta) = (q1 * c.inv_ra, q2 * c.inv_b);
        let g = (alpha * alpha + beta * beta).sqrt();
        let d = (r - a) / g;
        if d <= -c.reach {
            return zero;
        }
        if d >= c.reach {
            return one;
        }
        let inv_g = one / g;
        let (mx, my) = (alpha * c.ux - beta * c.uy, alpha * c.uy + beta * c.ux);
        let (u, w) = (c.filter * mx.abs() * inv_g, c.filter * my.abs() * inv_g);
        let edge = if u >= w {
            Edge::ramp(u, w)
        } else {
            Edge::ramp(w, u)
        };
        edge.cdf(d)
    }

    /// The coverage of the pixel centred at `p = (x, y)` by a curved layer
    /// and its gradient with respect to the centre `c`, the length `ra` of
    /// the semi-axis vector `a`, its angle `φ` and the other semi-axis `b`
    /// (entries `0..5`; [`Layer::chain`] turns them into the outline's
    /// parameters), or `None` where the coverage is zero.
    ///
    /// In the ellipse's frame, `p − c` has the coordinates
    /// `p₁ = (p − c) · â` and `p₂ = (p − c) · â⊥`, with `â = a / ra` and
    /// `â⊥ = (−â_y, â_x)`, and the ellipse is `r ≤ 1` with `q = (p₁ / ra,
    /// p₂ / b)` and `r = |q|`. Its boundary is taken as locally straight:
    /// the signed distance, positive inside, is `d = (1 − r) / |∇r|`, with
    /// `∇r = (α â + β â⊥) / r`, `α = q₁ / ra`, `β = q₂ / b`, so
    /// `|∇r| = G / r` with `G = √(α² + β²)` and `d = (r − r²) / G`, exact
    /// for a circle; the normal is `n = (α â + β â⊥) / G`. The coverage is
    /// the edge ramp `F(d)` ([`Edge::cdf`]) of the filter square projected
    /// on `n`, of widths `filter · |n_x|` and `filter · |n_y|`. At the
    /// centre (`r < 1e-9`), `d` is the shorter semi-axis and `n` is `x`.
    /// Pixels within the shorter semi-axis less the reach `filter · 0.7072`
    /// of the centre are covered whole, with no gradient.
    ///
    /// The gradient is the exact derivative of that coverage,
    /// `∂F/∂d · ∂d + ∂F/∂wide · ∂wide + ∂F/∂narrow · ∂narrow`
    /// ([`Edge::cdf_grad`]), through `p₁`, `p₂` (`∂p₁/∂(p − c) = â`,
    /// `∂p₂/∂(p − c) = â⊥`, `∂p₁/∂φ = p₂`, `∂p₂/∂φ = −p₁`, neither moves
    /// with `ra`), `q`, `α`, `β` and `â`, `â⊥` (`∂â/∂φ = â⊥`,
    /// `∂â⊥/∂φ = −â`), into `d` and the widths through `n`.
    #[inline]
    fn conic_coverage_grad(&self, x: F, y: F) -> Option<(F, [F; COORDS])> {
        let c = &self.conic;
        let (zero, one, two) = (F::of(0.0), F::of(1.0), F::of(2.0));
        let mut grad = [zero; COORDS];
        let (dx, dy) = (x - c.cx, y - c.cy);
        if dx * dx + dy * dy <= c.inner2 {
            return Some((one, grad));
        }
        let (ux, uy) = (c.ux, c.uy);
        let (p1, p2) = (dx * ux + dy * uy, dy * ux - dx * uy);
        let (ira, ib) = (c.inv_ra, c.inv_b);
        let (q1, q2) = (p1 * ira, p2 * ib);
        let a = q1 * q1 + q2 * q2;
        let r = a.sqrt();
        if r < F::of(1e-9) {
            // `d` is the shorter semi-axis, `n` is `x`: the widths do not
            // move.
            let value = Edge::ramp(c.filter, zero).cdf_grad(c.shorter);
            if value.f <= zero {
                return None;
            }
            let shorter = if ira >= ib { 2 } else { 4 };
            grad[shorter] = value.fd;
            return Some((value.f, grad));
        }
        let (alpha, beta) = (q1 * ira, q2 * ib);
        let g = (alpha * alpha + beta * beta).sqrt();
        let d = (r - a) / g;
        if d <= -c.reach {
            return None;
        }
        if d >= c.reach {
            return Some((one, grad));
        }
        let inv_g = one / g;
        let (mx, my) = (alpha * ux - beta * uy, alpha * uy + beta * ux);
        let (u, w) = (c.filter * mx.abs() * inv_g, c.filter * my.abs() * inv_g);
        let edge = if u >= w {
            Edge::ramp(u, w)
        } else {
            Edge::ramp(w, u)
        };
        // On a conic's axes the geometric distance is exactly radius
        // minus offset. The general (r - a) / g can lose an ulp at an
        // exact pixel boundary; recognise that kink from the original
        // radii, only for the derivative, without moving forward coverage.
        let axial_d = if p2 == zero {
            c.ra - p1.abs()
        } else if p1 == zero {
            c.b - p2.abs()
        } else {
            d
        };
        let kink = edge.inv_narrow == zero && axial_d.abs() == F::of(0.5) * c.filter;
        if d < -edge.half_sum && !kink {
            return None;
        }
        if d > edge.half_sum && !kink {
            return Some((one, grad));
        }
        let mut value = edge.cdf_grad(if kink {
            if axial_d < zero {
                -edge.half_sum
            } else {
                edge.half_sum
            }
        } else {
            d
        });
        if kink {
            value.f = edge.cdf(d);
        }
        // The partials of `q₁`, `q₂`, `α` and `β` with respect to
        // `p − c`, `ra`, `φ` and `b`, in that order.
        let (ira2, ib2) = (ira * ira, ib * ib);
        let dq1 = [ux * ira, uy * ira, -q1 * ira, p2 * ira, zero];
        let dq2 = [-uy * ib, ux * ib, zero, -p1 * ib, -q2 * ib];
        let dalpha = [ux * ira2, uy * ira2, -two * alpha * ira, p2 * ira2, zero];
        let dbeta = [-uy * ib2, ux * ib2, zero, -p1 * ib2, -two * beta * ib];
        // `∂d = (1/r − 2) / G · (q₁ ∂q₁ + q₂ ∂q₂) − d / G² · (α ∂α + β ∂β)`.
        let (k_r, k_g) = ((one / r - two) * inv_g, d * inv_g * inv_g);
        // `∂n = (∂m |m|² − m (m · ∂m)) / |m|³` for `m = (mx, my)`, `|m| = G`.
        let inv_g3 = inv_g * inv_g * inv_g;
        let sign = |v: F| if v < zero { -c.filter } else { c.filter };
        let (sx, sy) = (sign(mx), sign(my));
        let wide_is_u = u >= w;
        let narrow_counts = edge.inv_narrow > zero;
        for k in 0..5 {
            let dd =
                k_r * (q1 * dq1[k] + q2 * dq2[k]) - k_g * (alpha * dalpha[k] + beta * dbeta[k]);
            let (mut dmx, mut dmy) = (
                dalpha[k] * ux - dbeta[k] * uy,
                dalpha[k] * uy + dbeta[k] * ux,
            );
            if k == 3 {
                dmx += -alpha * uy - beta * ux;
                dmy += alpha * ux - beta * uy;
            }
            let du = sx * (my * my * dmx - mx * my * dmy) * inv_g3;
            let dw = sy * (mx * mx * dmy - mx * my * dmx) * inv_g3;
            let (dwide, dnarrow) = if wide_is_u { (du, dw) } else { (dw, du) };
            let mut total = value.fd * dd + value.fa * dwide;
            if narrow_counts {
                total += value.fb * dnarrow;
            }
            grad[k] = total;
        }
        grad[0] = -grad[0];
        grad[1] = -grad[1];
        Some((value.f, grad))
    }

    /// The number of the first `N` edges whose reach holds the filter
    /// square of a pixel at the signed distances `d` from them, those with
    /// `−half_sum < d < half_sum`, and the last of them; `None` if the
    /// square is outside an edge. The gradient path includes an aligned
    /// ramp's endpoints: zero coverage there can have a half-slope.
    #[inline]
    fn cutting<const N: usize>(&self, d: &[F; N], gradient: bool) -> Option<(usize, usize)> {
        let (mut cutting, mut last) = (0, 0);
        for (e, &d) in d.iter().enumerate() {
            let reach = self.edges[e].half_sum;
            let kink = gradient && self.edges[e].at_ramp_end(d);
            if d <= -reach && !kink {
                return None;
            }
            if d < reach || kink {
                cutting += 1;
                last = e;
            }
        }
        Some((cutting, last))
    }

    /// The filter square of a pixel at the signed distances `d` from the
    /// first `N` edges, clipped to the inside of each edge whose reach
    /// holds it, in edge order (Sutherland–Hodgman). Every edge outside the
    /// square's reach holds it whole and clips nothing.
    #[inline]
    fn clip<const N: usize>(&self, d: &[F; N]) -> Clipped<F> {
        let (zero, h) = (F::of(0.0), self.half);
        let mut polygon = Clipped::empty();
        for (u, v) in [(-h, -h), (h, -h), (h, h), (-h, h)] {
            polygon.push(u, v, SQUARE);
        }
        for (e, &d) in d.iter().enumerate() {
            let edge = &self.edges[e];
            if d >= edge.half_sum {
                continue;
            }
            let mut inside = [zero; CLIP];
            for (i, inside) in inside.iter_mut().enumerate().take(polygon.len) {
                *inside = edge.nx * polygon.u[i] + edge.ny * polygon.v[i] + d;
            }
            let mut clipped = Clipped::empty();
            for i in 0..polygon.len {
                let j = if i + 1 == polygon.len { 0 } else { i + 1 };
                let (si, sj) = (inside[i], inside[j]);
                let crossing = || {
                    let t = si / (si - sj);
                    (
                        polygon.u[i] + t * (polygon.u[j] - polygon.u[i]),
                        polygon.v[i] + t * (polygon.v[j] - polygon.v[i]),
                    )
                };
                if si >= zero {
                    clipped.push(polygon.u[i], polygon.v[i], polygon.on[i]);
                    if sj < zero {
                        let (u, v) = crossing();
                        clipped.push(u, v, e as u8);
                    }
                } else if sj >= zero {
                    let (u, v) = crossing();
                    clipped.push(u, v, polygon.on[i]);
                }
            }
            polygon = clipped;
            if polygon.len == 0 {
                break;
            }
        }
        polygon
    }

    /// Adds to `grad` the first variation of the coverage by a clipped
    /// boundary of edge `e` of `N` that spans `low..high` along it and moves
    /// by `length` ([`Self::edge_coverage_grad`]): along the outward normal,
    /// `to_q = length · (high + low) / (2 |PQ|)` per unit of its end `Q` and
    /// `length − to_q` per unit of its start `P`.
    #[inline]
    fn move_boundary<const N: usize>(
        &self,
        grad: &mut [F; COORDS],
        e: usize,
        length: F,
        (low, high): (F, F),
    ) {
        let edge = &self.edges[e];
        let to_q = F::of(0.5) * length * (high + low) * edge.inv_l;
        let to_p = length - to_q;
        let (ox, oy) = (-edge.nx * self.inv_area, -edge.ny * self.inv_area);
        let (p, q) = (e, (e + 1) % N);
        grad[2 * p] += ox * to_p;
        grad[2 * p + 1] += oy * to_p;
        grad[2 * q] += ox * to_q;
        grad[2 * q + 1] += oy * to_q;
    }

    /// The coverage of the pixel centred at `(x, y)` by the first `N`
    /// edges, three or four, and its gradient with respect to the
    /// vertex coordinates, or `None` where the coverage is zero.
    ///
    /// The coverage is the exact area of the polygon in the filter square,
    /// over the square's area. Where at most one edge cuts the square, it
    /// is that edge's box-filtered half-plane `F(d)` ([`Edge::cdf`]), with
    /// its derivative. Where two or more do, it is the area of the square
    /// clipped to the inside of each ([`Self::clip`]), by the shoelace
    /// formula, and its derivative is the first variation of that area:
    /// the square's sides do not move, so only the clipped segments of the
    /// edges contribute, each by its outward normal integrated against the
    /// velocity of its points. The two agree where a second edge's reach
    /// ends on the square's corner, in value and in gradient.
    #[inline]
    fn edge_coverage_grad<const N: usize>(&self, x: F, y: F) -> Option<(F, [F; COORDS])> {
        let zero = F::of(0.0);
        let mut geometric_kink = false;
        let d: [F; N] = std::array::from_fn(|e| {
            let edge = &self.edges[e];
            // Normalisation and the expanded line constant can lose an
            // ulp even on an exact axis-aligned boundary (e.g. length 98).
            // Recognise only exact geometric kinks, from the endpoint,
            // and use the ramp's endpoint on the derivative path.
            if let Some(axial) = edge.axial_offset(x, y)
                && axial.abs() == self.half
            {
                geometric_kink = true;
                if axial < zero {
                    -edge.half_sum
                } else {
                    edge.half_sum
                }
            } else {
                edge.distance(x, y)
            }
        });
        let (cutting, last) = self.cutting(&d, true)?;
        let mut grad = [zero; COORDS];
        match cutting {
            0 => Some((F::of(1.0), grad)),
            1 => {
                let edge = &self.edges[last];
                let value = edge.cdf_grad(d[last]);
                let g = edge.endpoint_grad(value, x, y, d[last]);
                let (p, q) = (last, (last + 1) % N);
                grad[2 * p] += g[0];
                grad[2 * p + 1] += g[1];
                grad[2 * q] += g[2];
                grad[2 * q + 1] += g[3];
                Some((
                    if geometric_kink {
                        self.edge_coverage::<N>(x, y)
                    } else {
                        value.f
                    },
                    grad,
                ))
            }
            _ => {
                let polygon = self.clip(&d);
                let kink = d
                    .iter()
                    .enumerate()
                    .any(|(e, &d)| self.edges[e].at_ramp_end(d));
                // Including an endpoint in the derivative's clip can
                // change the last bit of a nearly tangent corner's area.
                // Keep the original forward path's value bit for bit.
                let coverage = if kink {
                    self.edge_coverage::<N>(x, y)
                } else {
                    polygon.coverage(self.inv_area)
                };
                if polygon.len == 0 {
                    return kink.then_some((coverage, grad));
                }
                // Only the clipped segments of the edges move: each moves
                // the boundary along its outward normal `−(nx, ny)` at the
                // velocity `(1 − t) δP + t δQ` of its point at `t` along
                // `PQ`. With `s = t · |PQ|` from `s0` to `s1` on the
                // segment, the area moves by `L ∫ (1 − t) dt =
                // (s1 − s0) − (s1² − s0²) / (2 |PQ|)` per unit of `P` and
                // `(s1² − s0²) / (2 |PQ|)` per unit of `Q`.
                for i in 0..polygon.len {
                    let e = usize::from(polygon.on[i]);
                    if e >= N {
                        continue;
                    }
                    let j = if i + 1 == polygon.len { 0 } else { i + 1 };
                    let edge = &self.edges[e];
                    if edge.at_ramp_end(d[e]) {
                        continue;
                    }
                    let (tx, ty) = (edge.ex * edge.inv_l, edge.ey * edge.inv_l);
                    let centre = (x - edge.px) * tx + (y - edge.py) * ty;
                    let s0 = centre + polygon.u[i] * tx + polygon.v[i] * ty;
                    let s1 = centre + polygon.u[j] * tx + polygon.v[j] * ty;
                    let (low, high) = if s0 <= s1 { (s0, s1) } else { (s1, s0) };
                    let length = high - low;
                    self.move_boundary::<N>(&mut grad, e, length, (low, high));
                }
                // At a kink the clipped boundary may coincide with a
                // filter-square side (or collapse to it). It still moves
                // half as much as the interior boundary. Integrate the
                // portion retained by the other edges, including corners.
                for (e, &distance) in d.iter().enumerate() {
                    let edge = &self.edges[e];
                    if !edge.at_ramp_end(distance) {
                        continue;
                    }
                    let (tx, ty) = (edge.ex * edge.inv_l, edge.ey * edge.inv_l);
                    let centre = (x - edge.px) * tx + (y - edge.py) * ty;
                    let (mut low, mut high) = (F::of(f64::INFINITY), F::of(f64::NEG_INFINITY));
                    for i in 0..polygon.len {
                        if edge.nx * polygon.u[i] + edge.ny * polygon.v[i] + distance == zero {
                            let s = centre + polygon.u[i] * tx + polygon.v[i] * ty;
                            if s < low {
                                low = s;
                            }
                            if s > high {
                                high = s;
                            }
                        }
                    }
                    if high <= low {
                        continue;
                    }
                    let length = F::of(0.5) * (high - low);
                    self.move_boundary::<N>(&mut grad, e, length, (low, high));
                }
                Some((coverage, grad))
            }
        }
    }
}

impl<F: Real> Clipped<F> {
    fn empty() -> Self {
        Self {
            u: [F::of(0.0); CLIP],
            v: [F::of(0.0); CLIP],
            on: [SQUARE; CLIP],
            len: 0,
        }
    }

    /// Appends the vertex `(u, v)`, the side from it to the next lying on
    /// `on`. Clipping a convex polygon by a half-plane adds at most one
    /// vertex, so there is room for every vertex; should rounding ever
    /// make the signs of the vertices alternate more than twice, the
    /// vertices past [`CLIP`] are dropped.
    #[inline]
    fn push(&mut self, u: F, v: F, on: u8) {
        if self.len < CLIP {
            self.u[self.len] = u;
            self.v[self.len] = v;
            self.on[self.len] = on;
            self.len += 1;
        }
    }

    /// The polygon's area times `inv_area`, `1 / filter²`, by the shoelace
    /// formula, in `0..=1`.
    #[inline]
    fn coverage(&self, inv_area: F) -> F {
        let mut twice = F::of(0.0);
        for i in 0..self.len {
            let j = if i + 1 == self.len { 0 } else { i + 1 };
            twice += self.u[i] * self.v[j] - self.u[j] * self.v[i];
        }
        let coverage = F::of(0.5) * twice * inv_area;
        if coverage < F::of(0.0) {
            F::of(0.0)
        } else if coverage > F::of(1.0) {
            F::of(1.0)
        } else {
            coverage
        }
    }
}

/// How a layer covers its pixels. The pixel loops are compiled once per
/// implementation and chosen once per layer ([`Prepared::kind`]), so that
/// no pixel pays for the choice.
trait Cover {
    /// The coverage of the pixel `(x, y)` inside the layer's bounding box,
    /// with `fy` the row as a float.
    fn cover<F: Real>(layer: &Prepared<'_, F>, x: usize, y: usize, fy: F) -> F;

    /// The coverage and its gradient with respect to the vertex
    /// coordinates, an axis-aligned rectangle's parameters or a curved
    /// layer's ([`Kind::coords`] of them; all zero for a fixed layer, which
    /// has none), or `None` where the coverage and its gradient are zero.
    fn cover_grad<F: Real>(
        layer: &Prepared<'_, F>,
        x: usize,
        y: usize,
        fy: F,
    ) -> Option<(F, [F; COORDS])>;
}

/// A fixed layer's mask.
struct Masked;

/// An axis-aligned rectangle's four sides.
struct Boxed;

impl Cover for Boxed {
    #[inline]
    fn cover<F: Real>(layer: &Prepared<'_, F>, x: usize, _y: usize, fy: F) -> F {
        layer.box_coverage(F::of(x as f64), fy)
    }

    #[inline]
    fn cover_grad<F: Real>(
        layer: &Prepared<'_, F>,
        x: usize,
        _y: usize,
        fy: F,
    ) -> Option<(F, [F; COORDS])> {
        layer.box_coverage_grad(F::of(x as f64), fy)
    }
}

/// The exact area of a polygon of `N` edges in the filter square.
struct Edges<const N: usize>;

/// A circle or an ellipse, rotated or not, its boundary locally straight
/// ([`Prepared::conic_coverage_grad`]).
struct Curved;

impl Cover for Curved {
    #[inline]
    fn cover<F: Real>(layer: &Prepared<'_, F>, x: usize, _y: usize, fy: F) -> F {
        layer.conic_coverage(F::of(x as f64), fy)
    }

    #[inline]
    fn cover_grad<F: Real>(
        layer: &Prepared<'_, F>,
        x: usize,
        _y: usize,
        fy: F,
    ) -> Option<(F, [F; COORDS])> {
        layer.conic_coverage_grad(F::of(x as f64), fy)
    }
}

impl Cover for Masked {
    #[inline]
    fn cover<F: Real>(layer: &Prepared<'_, F>, x: usize, y: usize, _fy: F) -> F {
        layer.mask[(y - layer.y0) * (layer.x1 - layer.x0) + x - layer.x0]
    }

    #[inline]
    fn cover_grad<F: Real>(
        layer: &Prepared<'_, F>,
        x: usize,
        y: usize,
        fy: F,
    ) -> Option<(F, [F; COORDS])> {
        let cov = Self::cover(layer, x, y, fy);
        (cov > F::of(0.0)).then_some((cov, [F::default(); COORDS]))
    }
}

impl<const N: usize> Cover for Edges<N> {
    #[inline]
    fn cover<F: Real>(layer: &Prepared<'_, F>, x: usize, _y: usize, fy: F) -> F {
        layer.edge_coverage::<N>(F::of(x as f64), fy)
    }

    #[inline]
    fn cover_grad<F: Real>(
        layer: &Prepared<'_, F>,
        x: usize,
        _y: usize,
        fy: F,
    ) -> Option<(F, [F; COORDS])> {
        layer.edge_coverage_grad::<N>(F::of(x as f64), fy)
    }
}

/// Evaluates `$call` with the type `$cover` standing for the [`Cover`] of
/// `$layer`.
macro_rules! by_cover {
    ($layer:expr, $cover:ident => $call:expr) => {
        match $layer.kind {
            Kind::Masked => {
                type $cover = Masked;
                $call
            }
            Kind::Triangle => {
                type $cover = Edges<3>;
                $call
            }
            Kind::Quad => {
                type $cover = Edges<4>;
                $call
            }
            Kind::Box => {
                type $cover = Boxed;
                $call
            }
            Kind::Curved => {
                type $cover = Curved;
                $call
            }
        }
    };
}

/// Rows per band. Every pass splits the canvas into bands of this many
/// rows, the last one shorter, whatever the number of threads; each band
/// is one task, and the bands' partial sums are reduced in band order, so
/// every result is the same whatever the number of threads.
///
/// Measured against 8 and 32 rows on the engine runner's corpus: 8 runs
/// slightly faster on 8 threads and slower on 1.
const BAND_ROWS: usize = 16;

/// Maximum bytes of coverage values cached across the whole canvas.
/// Layers are admitted in stack order by their clipped bounding-box area;
/// a layer that does not fit is evaluated as before. Band buffers retain
/// their allocations for reuse, like the checkpoint buffers.
///
/// On the engine runner's README originals at the default `resize_input`
/// the cache peaks at about 2.3 MB (1000 triangles on 212 × 256), so every
/// layer fits.
const COVERAGE_BUDGET: usize = 32 << 20;

/// In a fit pass, the entry of a layer's partial sums that holds its
/// weight `Σ g · (1 − T)`; entries `0..3` hold `Σ g · R_c`.
const FIT_WEIGHT: usize = 3;

/// What a pass computes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pass {
    /// The colour fit's sums, from the transmittance alone.
    Fit,
    /// The gradient, which also needs the canvas below each layer.
    Gradient,
}

/// One band's rows of the canvas, its checkpoints, the canvas below each
/// layer of one segment, the residual and the transmittances, and its
/// partial sums per layer and the selected layers' pixel coverage.
#[derive(Default)]
struct Band<F> {
    #[cfg(test)]
    evaluations: Evaluations,
    /// The band's rows, `y0..y1`.
    y0: usize,
    y1: usize,
    /// Selected layers' bounding-box pixels in this band, row-major, in
    /// layer order. Values are exactly those returned by `Cover::cover`.
    coverage: Vec<F>,
    /// A range in `coverage` for each selected layer; `None` for evaluated
    /// layers, including every fixed mask.
    coverage_ranges: Vec<Option<Range<usize>>>,
    canvas: Vec<F>,
    /// The band's canvas before every `interval`-th layer, one after the
    /// other.
    checkpoints: Vec<F>,
    /// The canvas below each layer of the segment being replayed, inside
    /// the layer's bounding box and the band.
    below: Vec<Vec<F>>,
    residual: Vec<F>,
    /// The transmittance of the layers above the current one.
    transmittance: Vec<F>,
    /// The transmittance `T` of the whole stack, `Π (1 − w)` over every
    /// layer; only for a fit.
    uncovered: Vec<F>,
    /// The gradient per layer, or the fit's sums ([`FIT_WEIGHT`]).
    sums: Vec<[f64; PARAMS]>,
    /// `Σ r²` over the band's residual, in `f64`, in order.
    squares: f64,
}

/// Actual coverage calls in one band's pixel loops; absent from production.
#[cfg(test)]
#[derive(Default)]
struct Evaluations {
    cover: std::cell::Cell<usize>,
    gradient: std::cell::Cell<usize>,
}

#[cfg(test)]
impl Evaluations {
    fn cover<F>(&self, layer: &Prepared<'_, F>) {
        if layer.kind != Kind::Masked {
            self.cover.set(self.cover.get() + 1);
        }
    }
    fn gradient<F>(&self, layer: &Prepared<'_, F>) {
        if layer.kind != Kind::Masked {
            self.gradient.set(self.gradient.get() + 1);
        }
    }
    fn reset(&self) {
        self.cover.set(0);
        self.gradient.set(0);
    }
}

/// The exact geometry of the whole stack. Colours, opacities and masks
/// are absent: fixed layers are always evaluated, never cached.
#[derive(Default)]
struct CoverageKey {
    width: usize,
    height: usize,
    filter: u64,
    layers: Vec<(Outline, [u64; COORDS])>,
}

impl CoverageKey {
    fn matches<F>(&self, scene: &Scene<F>, layers: &[Layer]) -> bool {
        self.width == scene.width
            && self.height == scene.height
            && self.filter == scene.filter.to_bits()
            && self.layers.len() == layers.len()
            && self
                .layers
                .iter()
                .zip(layers)
                .all(|((outline, params), layer)| {
                    *outline == layer.outline && *params == layer.params.map(f64::to_bits)
                })
    }

    fn store<F>(&mut self, scene: &Scene<F>, layers: &[Layer]) {
        self.width = scene.width;
        self.height = scene.height;
        self.filter = scene.filter.to_bits();
        self.layers.clear();
        self.layers.extend(
            layers
                .iter()
                .map(|layer| (layer.outline, layer.params.map(f64::to_bits))),
        );
    }
}

/// Reusable buffers of [`fit`], [`gradients`] and [`loss`]: one [`Band`]
/// per band, with an all-or-nothing geometry key and a whole-canvas plan
/// for coverage reuse between fits and gradients. Loss neither reads nor
/// writes coverage or its key.
#[derive(Default)]
pub(super) struct Workspace<F> {
    bands: Vec<Band<F>>,
    coverage_key: Option<CoverageKey>,
    cached: Vec<bool>,
    #[cfg(test)]
    coverage_budget: Option<usize>,
}

impl<F: Real> Workspace<F> {
    #[cfg(test)]
    fn set_coverage_budget(&mut self, budget: usize) {
        self.coverage_budget = Some(budget);
        self.coverage_key = None;
    }

    /// Select whole layers before the fork, independent of bands and
    /// thread count. Oversized layers do not prevent later ones fitting.
    fn plan_coverage(&mut self, layers: &[Prepared<'_, F>]) {
        let mut remaining = COVERAGE_BUDGET;
        #[cfg(test)]
        if let Some(budget) = self.coverage_budget {
            remaining = budget;
        }
        self.cached.clear();
        self.cached.extend(layers.iter().map(|layer| {
            let bytes = layer.box_pixels() * size_of::<F>();
            let cached = layer.kind != Kind::Masked && bytes <= remaining;
            if cached {
                remaining -= bytes;
            }
            cached
        }));
    }

    /// The active bands of a canvas `height` rows high. Keep inactive
    /// bands too, so a loss on another canvas cannot discard valid coverage.
    fn bands(&mut self, height: usize) -> &mut [Band<F>] {
        let count = height.div_ceil(BAND_ROWS);
        if self.bands.len() < count {
            self.bands.resize_with(count, Band::default);
        }
        for (index, band) in self.bands[..count].iter_mut().enumerate() {
            band.y0 = index * BAND_ROWS;
            band.y1 = (band.y0 + BAND_ROWS).min(height);
        }
        &mut self.bands[..count]
    }
}

/// Coverage for one paint: evaluate, evaluate and record, or read exactly
/// the pixels of this layer's bounding box within the band's rows.
enum Coverage<'a, F> {
    Evaluate,
    Record(&'a mut Vec<F>),
    Cached(&'a [F]),
}

/// One layer's pixels in a band. Dispatch is once per layer; all pixel
/// loops are monomorphised, including the readers of cached coverage.
struct Paint<'a, F> {
    width: usize,
    top: usize,
    rows: Range<usize>,
    layer: &'a Prepared<'a, F>,
    #[cfg(test)]
    evaluations: &'a Evaluations,
}

impl<F: Real> Paint<'_, F> {
    /// Composites the layer and folds it into `uncovered` if given.
    fn paint(&self, canvas: &mut [F], uncovered: Option<&mut [F]>, coverage: Coverage<'_, F>) {
        match coverage {
            Coverage::Evaluate => by_cover!(self.layer, C =>
                self.paint_with(canvas, uncovered, |x, y, fy| self.cover::<C>(x, y, fy))),
            Coverage::Record(values) => by_cover!(self.layer, C =>
            self.paint_with(canvas, uncovered, |x, y, fy| {
                let cov = self.cover::<C>(x, y, fy);
                values.push(cov);
                cov
            })),
            Coverage::Cached(values) => {
                let mut pixels = values.iter();
                self.paint_with(canvas, uncovered, |_, _, _| {
                    *pixels.next().expect("cached bounding-box pixel")
                });
            }
        }
    }

    #[inline]
    fn cover<C: Cover>(&self, x: usize, y: usize, fy: F) -> F {
        #[cfg(test)]
        self.evaluations.cover(self.layer);
        C::cover(self.layer, x, y, fy)
    }

    /// The same arithmetic for evaluated, recording and cached coverage.
    fn paint_with(
        &self,
        canvas: &mut [F],
        mut uncovered: Option<&mut [F]>,
        mut cover: impl FnMut(usize, usize, F) -> F,
    ) {
        let layer = self.layer;
        for y in self.rows.clone() {
            let line = &mut canvas[3 * self.width * (y - self.top)..][..3 * self.width];
            let fy = F::of(y as f64);
            for x in layer.x0..layer.x1 {
                let cov = cover(x, y, fy);
                if cov > F::of(0.0) {
                    let w = layer.opacity * cov;
                    for c in 0..3 {
                        let value = &mut line[3 * x + c];
                        *value += w * (layer.color[c] - *value);
                    }
                    if let Some(uncovered) = uncovered.as_deref_mut() {
                        let p = self.width * (y - self.top) + x;
                        uncovered[p] = uncovered[p] * (F::of(1.0) - w);
                    }
                }
            }
        }
    }
}

impl<F: Real> Band<F> {
    /// Composites `layers` from the background into the band's canvas,
    /// keeping the canvas before every `interval`-th layer (none with
    /// `interval` 0) and, with `uncovered`, the transmittance of the whole
    /// stack; then sets the residual to `X − T`. With a cache plan, records
    /// selected coverage on a cold pass and reads it on a warm pass. With
    /// no plan (loss), neither reads nor writes the coverage buffers.
    fn forward(
        &mut self,
        scene: &Scene<F>,
        layers: &[Prepared<'_, F>],
        interval: usize,
        uncovered: bool,
        cache: Option<(&[bool], bool)>,
    ) {
        #[cfg(test)]
        self.evaluations.reset();
        let width = scene.width;
        let (y0, y1) = (self.y0, self.y1);
        if let Some((cached, false)) = cache {
            self.coverage.clear();
            self.coverage_ranges.clear();
            self.coverage_ranges.resize(cached.len(), None);
        }
        self.canvas.clear();
        self.canvas
            .extend((0..width * (y1 - y0)).flat_map(|_| scene.background));
        self.checkpoints.clear();
        self.uncovered.clear();
        if uncovered {
            self.uncovered.resize(width * (y1 - y0), F::of(1.0));
        }
        for (index, layer) in layers.iter().enumerate() {
            if interval > 0 && index % interval == 0 {
                self.checkpoints.extend_from_slice(&self.canvas);
            }
            let rows = layer.rows(y0, y1);
            let uncovered = uncovered.then_some(self.uncovered.as_mut_slice());
            let paint = Paint {
                width,
                top: y0,
                rows,
                layer,
                #[cfg(test)]
                evaluations: &self.evaluations,
            };
            match cache {
                Some((cached, false)) if cached[index] => {
                    let start = self.coverage.len();
                    paint.paint(
                        &mut self.canvas,
                        uncovered,
                        Coverage::Record(&mut self.coverage),
                    );
                    self.coverage_ranges[index] = Some(start..self.coverage.len());
                }
                Some((_, true)) if self.coverage_ranges[index].is_some() => {
                    let range = self.coverage_ranges[index].as_ref().unwrap().clone();
                    paint.paint(
                        &mut self.canvas,
                        uncovered,
                        Coverage::Cached(&self.coverage[range]),
                    );
                }
                _ => paint.paint(&mut self.canvas, uncovered, Coverage::Evaluate),
            }
        }
        let target = &scene.target[3 * width * y0..3 * width * y1];
        self.residual.clear();
        self.residual
            .extend(self.canvas.iter().zip(target).map(|(&x, &t)| x - t));
    }

    /// One band's part of [`fit`] or [`gradients`]: the forward pass, then
    /// the top-down reverse pass, which sets `sums` to the band's partial
    /// sums per layer.
    fn pass(
        &mut self,
        scene: &Scene<F>,
        layers: &[Prepared<'_, F>],
        interval: usize,
        pass: Pass,
        cached: &[bool],
        warm: bool,
    ) {
        let width = scene.width;
        let n = layers.len();
        let (y0, y1) = (self.y0, self.y1);
        let fit = pass == Pass::Fit;
        // The fit needs only the transmittances, which need no canvas below
        // each layer.
        self.forward(
            scene,
            layers,
            if fit { 0 } else { interval },
            fit,
            Some((cached, warm)),
        );
        self.sums.clear();
        self.sums.resize(n, [0.0; PARAMS]);
        self.transmittance.clear();
        self.transmittance.resize(width * (y1 - y0), F::of(1.0));
        if fit {
            for (index, (layer, sums)) in layers.iter().zip(&mut self.sums).enumerate().rev() {
                let rows = layer.rows(y0, y1);
                if !rows.is_empty() {
                    let reverse = Reverse {
                        layer,
                        #[cfg(test)]
                        evaluations: &self.evaluations,
                        width,
                        top: y0,
                        rows,
                    };
                    reverse.fit(
                        &self.residual,
                        &self.uncovered,
                        &mut self.transmittance,
                        sums,
                        self.coverage_ranges[index]
                            .as_ref()
                            .map(|r| &self.coverage[r.clone()]),
                    );
                }
            }
            return;
        }
        let size = self.canvas.len();
        self.below.resize_with(interval, Vec::new);
        for segment in (0..n.div_ceil(interval)).rev() {
            let start = segment * interval;
            let end = (start + interval).min(n);
            // Replay the segment, keeping the canvas below each layer
            // inside its bounding box.
            self.canvas
                .copy_from_slice(&self.checkpoints[segment * size..][..size]);
            for (local, (layer, below)) in
                layers[start..end].iter().zip(&mut self.below).enumerate()
            {
                below.clear();
                let rows = layer.rows(y0, y1);
                for y in rows.clone() {
                    let row = 3 * width * (y - y0);
                    below.extend_from_slice(&self.canvas[row + 3 * layer.x0..row + 3 * layer.x1]);
                }
                let coverage = self.coverage_ranges[start + local]
                    .as_ref()
                    .map_or(Coverage::Evaluate, |r| {
                        Coverage::Cached(&self.coverage[r.clone()])
                    });
                Paint {
                    width,
                    top: y0,
                    rows,
                    layer,
                    #[cfg(test)]
                    evaluations: &self.evaluations,
                }
                .paint(&mut self.canvas, None, coverage);
            }
            for index in (start..end).rev() {
                let layer = &layers[index];
                let rows = layer.rows(y0, y1);
                if !rows.is_empty() {
                    let reverse = Reverse {
                        layer,
                        #[cfg(test)]
                        evaluations: &self.evaluations,
                        width,
                        top: y0,
                        rows,
                    };
                    reverse.gradient(
                        &self.below[index - start],
                        &self.residual,
                        &mut self.transmittance,
                        &mut self.sums[index],
                    );
                }
            }
        }
    }
}

/// The reverse step through `layer` on the rows `rows` of a band whose
/// first row is `top`. Each pixel's `A` is the transmittance of the layers
/// above, `w` the layer's opacity times its coverage, and `g = A · w` the
/// weight of the layer's colour in the final composite.
struct Reverse<'a, F> {
    #[cfg(test)]
    evaluations: &'a Evaluations,
    layer: &'a Prepared<'a, F>,
    width: usize,
    top: usize,
    rows: Range<usize>,
}

impl<F: Real> Reverse<'_, F> {
    /// Accumulates the colour fit's `Σ g · R_c` and `Σ g · (1 − T)` into
    /// `sums` ([`FIT_WEIGHT`]), then folds the layer into the
    /// transmittance (`A ← A · (1 − w)`).
    fn fit(
        &self,
        residual: &[F],
        uncovered: &[F],
        transmittance: &mut [F],
        sums: &mut [f64; PARAMS],
        coverage: Option<&[F]>,
    ) {
        if let Some(values) = coverage {
            let mut pixels = values.iter();
            self.fit_with(residual, uncovered, transmittance, sums, |_, _, _| {
                *pixels.next().expect("cached bounding-box pixel")
            });
        } else {
            by_cover!(self.layer, C => self.fit_with(residual, uncovered, transmittance, sums,
            |x, y, fy| {
                #[cfg(test)]
                self.evaluations.cover(self.layer);
                C::cover(self.layer, x, y, fy)
            }));
        }
    }

    /// The same arithmetic for evaluated and cached coverage.
    fn fit_with(
        &self,
        residual: &[F],
        uncovered: &[F],
        transmittance: &mut [F],
        sums: &mut [f64; PARAMS],
        mut cover: impl FnMut(usize, usize, F) -> F,
    ) {
        let layer = self.layer;
        for y in self.rows.clone() {
            let fy = F::of(y as f64);
            for x in layer.x0..layer.x1 {
                let cov = cover(x, y, fy);
                if cov <= F::of(0.0) {
                    continue;
                }
                let p = self.width * (y - self.top) + x;
                let transmitted = transmittance[p];
                let w = layer.opacity * cov;
                let g = (transmitted * w).get();
                for c in 0..3 {
                    sums[c] += g * residual[3 * p + c].get();
                }
                sums[FIT_WEIGHT] += g * (F::of(1.0) - uncovered[p]).get();
                transmittance[p] = transmitted * (F::of(1.0) - w);
            }
        }
    }

    /// Accumulates the gradient `∂L/∂w = 2 A Σ_c R_c (s_c − X_{i−1,c})`
    /// into the coverage's coordinates ([`Kind::coords`]) and the alpha in
    /// `sums`, with `below` the canvas below the layer inside its bounding
    /// box and the band, then folds the layer into the transmittance. A
    /// fixed layer has the alpha's alone.
    fn gradient(
        &self,
        below: &[F],
        residual: &[F],
        transmittance: &mut [F],
        sums: &mut [f64; PARAMS],
    ) {
        by_cover!(
            self.layer,
            C => self.gradient_with::<C>(below, residual, transmittance, sums)
        );
    }

    /// [`Self::gradient`] with the layer's [`Cover`] `C`.
    fn gradient_with<C: Cover>(
        &self,
        below: &[F],
        residual: &[F],
        transmittance: &mut [F],
        sums: &mut [f64; PARAMS],
    ) {
        let layer = self.layer;
        let box_width = layer.x1 - layer.x0;
        let coords = layer.kind.coords();
        let opacity = layer.opacity.get();
        for (local, y) in self.rows.clone().enumerate() {
            let fy = F::of(y as f64);
            for x in layer.x0..layer.x1 {
                #[cfg(test)]
                self.evaluations.gradient(layer);
                let Some((cov, cov_grad)) = C::cover_grad(layer, x, y, fy) else {
                    continue;
                };
                let p = self.width * (y - self.top) + x;
                let transmitted = transmittance[p];
                let w = layer.opacity * cov;
                let pixel = &residual[3 * p..3 * p + 3];
                let x_below = &below[3 * (local * box_width + x - layer.x0)..][..3];
                let mut dot = F::of(0.0);
                for c in 0..3 {
                    dot += pixel[c] * (layer.color[c] - x_below[c]);
                }
                let dl_dw = (F::of(2.0) * transmitted * dot).get();
                if dl_dw != 0.0 {
                    for (sum, d) in sums[..coords].iter_mut().zip(cov_grad) {
                        *sum += dl_dw * opacity * d.get();
                    }
                    sums[ALPHA] += dl_dw * cov.get() / 255.0;
                }
                transmittance[p] = transmitted * (F::of(1.0) - w);
            }
        }
    }
}

/// `layers`, ready to composite.
fn prepare<'a, F: Real>(scene: &'a Scene<F>, layers: &[Layer]) -> Vec<Prepared<'a, F>> {
    layers
        .iter()
        .map(|layer| Prepared::new(layer, scene))
        .collect()
}

/// `Σ (X − T)²` over every pixel and channel of the composite of
/// `layers`, in `f64`: in order within each band, then over the bands in
/// order.
pub(super) fn loss<F: Real>(scene: &Scene<F>, layers: &[Layer], work: &mut Workspace<F>) -> f64 {
    let layers = prepare(scene, layers);
    let bands = work.bands(scene.height);
    bands.par_iter_mut().for_each(|band| {
        band.forward(scene, &layers, 0, false, None);
        band.squares = band.residual.iter().map(|r| r.get() * r.get()).sum();
    });
    bands.iter().map(|band| band.squares).sum()
}

/// Runs `pass` over `layers` as one task per band of [`BAND_ROWS`] rows,
/// with a single fork and join, and returns the bands' partial sums per
/// layer reduced in band order.
///
/// Before the fork, the whole-canvas budget selects non-fixed layers in
/// stack order. On new geometry each band records their exact coverage in
/// its forward pass; replay and reverse fit read it, as do subsequent
/// passes with the same geometry key. Unselected layers and masks are
/// evaluated as before. Reverse gradients always evaluate `cover_grad`,
/// even at pixels whose cached coverage is zero.
///
/// Each band composites every layer that reaches it, then runs the
/// top-down reverse pass over its own rows. The reverse pass needs, at
/// layer `i`, the transmittance `A_i` of the layers above
/// (`final = A_i · X_i + B_i`), folded in as it goes down, the final
/// residual `R`, and, for the gradient, the canvas `X_{i−1}` below the
/// layer. The latter comes from each band's canvas checkpoints every
/// `interval` layers ([`checkpoint_interval`]: `⌈√N⌉` unless memory caps
/// them; the bands' checkpoints together hold as many canvases as one set
/// of whole-canvas checkpoints would), replayed one segment at a time and
/// kept only inside each layer's bounding box.
fn run<F: Real>(
    scene: &Scene<F>,
    layers: &[Layer],
    pass: Pass,
    work: &mut Workspace<F>,
) -> Vec<[f64; PARAMS]> {
    let n = layers.len();
    let warm = work
        .coverage_key
        .as_ref()
        .is_some_and(|key| key.matches(scene, layers));
    let prepared = prepare(scene, layers);
    if !warm {
        work.plan_coverage(&prepared);
        work.bands.truncate(scene.height.div_ceil(BAND_ROWS));
    }
    let interval = checkpoint_interval(n, 3 * scene.width * scene.height * size_of::<F>());
    work.bands(scene.height);
    let bands = &mut work.bands[..scene.height.div_ceil(BAND_ROWS)];
    bands
        .par_iter_mut()
        .for_each(|band| band.pass(scene, &prepared, interval, pass, &work.cached, warm));
    let mut totals = vec![[0.0; PARAMS]; n];
    for band in bands.iter() {
        for (total, sums) in totals.iter_mut().zip(&band.sums) {
            for (total, value) in total.iter_mut().zip(sums) {
                *total += value;
            }
        }
    }
    if !warm {
        work.coverage_key
            .get_or_insert_with(CoverageKey::default)
            .store(scene, layers);
    }
    totals
}

/// The gradient of the loss `Σ (X − T)²` per layer of `layers` with
/// respect to its parameters ([`Outline`]) and its opacity, the colours
/// held constant: zero for the parameters a layer does not use, every one
/// of a fixed layer's among them. A rotated rectangle's comes from its
/// corners', a curved layer's from its centre, `ra`, `φ` and `b`
/// ([`Layer::chain`]).
pub(super) fn gradients<F: Real>(
    scene: &Scene<F>,
    layers: &[Layer],
    work: &mut Workspace<F>,
) -> Vec<[f64; PARAMS]> {
    let totals = run(scene, layers, Pass::Gradient, work);
    layers
        .iter()
        .zip(totals)
        .map(|(layer, grad)| layer.chain(grad))
        .collect()
}

/// Refits every colour of `layers` together, from the residual of the stack
/// as it is (one Jacobi step), so that the pass needs no barrier per layer.
///
/// The loss is quadratic in the colours, with Hessian `2 Gᵀ G` where
/// `G[p][i] = g_i(p)`, per channel. Every `g` is non-negative and, at each
/// pixel, the weights of all layers add up to `1 − T`, with `T` the
/// transmittance of the whole stack, so the diagonal
/// `D_i = Σ_p g_i · (1 − T)` (each row's sum) majorises the Hessian. Each
/// channel then moves to `s − ω Σ g · R / D_i`, clamped to `0..=255`, with
/// `ω` the [`OVER_RELAXATION`]: for `ω < 2` this projected step on a
/// majorised quadratic never raises the loss, however much the layers
/// overlap, where a plain Jacobi step (`Σ g²` for `D`) can diverge.
pub(super) fn fit<F: Real>(scene: &Scene<F>, layers: &mut [Layer], work: &mut Workspace<F>) {
    let totals = run(scene, layers, Pass::Fit, work);
    for (layer, total) in layers.iter_mut().zip(&totals) {
        let weight = total[FIT_WEIGHT];
        if weight > 0.0 {
            for (c, color) in layer.color.iter_mut().enumerate() {
                *color = (*color - OVER_RELAXATION * total[c] / weight).clamp(0.0, 255.0);
            }
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The pixels whose integer centres lie in `[low, high]`, clipped to
    /// the axis, ends included.
    #[test]
    fn pixel_spans_take_the_centres_inside_the_closed_range() {
        assert_eq!(pixel_span(1.0, 3.0, 10), Some((1, 4)));
        assert_eq!(pixel_span(0.5, 3.5, 10), Some((1, 4)));
        assert_eq!(pixel_span(-4.0, 2.2, 10), Some((0, 3)));
        assert_eq!(pixel_span(7.1, 30.0, 10), Some((8, 10)));
        assert_eq!(pixel_span(2.1, 2.9, 10), None);
        assert_eq!(pixel_span(-3.0, -0.5, 10), None);
        assert_eq!(pixel_span(10.0, 12.0, 10), None);
        assert_eq!(box_span(1.0, 3.0, 1.0, 10), Some((1, 4)));
        assert_eq!(box_span(3.0, 3.0, 1.0, 10), None);
    }

    pub(in crate::joint) fn random_scene<F: Real>(
        rng: &mut ChaCha8Rng,
        width: usize,
        height: usize,
    ) -> Scene<F> {
        Scene {
            width,
            height,
            target: (0..3 * width * height)
                .map(|_| F::of(rng.random_range(0.0..255.0)))
                .collect(),
            background: [F::of(40.0), F::of(120.0), F::of(200.0)],
            filter: 1.0,
            masks: Vec::new(),
        }
    }

    /// A scene without a target, for the coverage alone.
    fn blank_scene(width: usize, height: usize) -> Scene<f64> {
        Scene {
            width,
            height,
            target: vec![0.0; 3 * width * height],
            background: [0.0; 3],
            filter: 1.0,
            masks: Vec::new(),
        }
    }

    fn random_tris(rng: &mut ChaCha8Rng, count: usize, size: f64) -> Vec<Layer> {
        (0..count)
            .map(|_| {
                let vertices = std::array::from_fn(|_| rng.random_range(-3.0..size + 3.0));
                let alpha = rng.random_range(40.0..250.0);
                Layer::triangle(
                    vertices,
                    alpha,
                    std::array::from_fn(|_| rng.random_range(0.0..255.0)),
                )
            })
            .collect()
    }

    /// The direction at `degrees` from `x`, turned by `turn` radians.
    fn direction(degrees: f64, turn: f64) -> (f64, f64) {
        let (sin, cos) = (degrees.to_radians() + turn).sin_cos();
        (cos, sin)
    }

    /// Triangles with a vertex of 20° and one of 155° (whose other two
    /// angles are acute too), each in both orientations, at random places
    /// and turns in a canvas of `size`: every vertex lies inside a pixel,
    /// where two edges cut its square.
    fn sharp_tris(rng: &mut ChaCha8Rng, size: f64) -> Vec<Layer> {
        let mut layers = Vec::new();
        for angle in [20.0, 155.0] {
            let (ax, ay) = (
                rng.random_range(size / 4.0..3.0 * size / 4.0),
                rng.random_range(size / 4.0..3.0 * size / 4.0),
            );
            let turn = rng.random_range(0.0..std::f64::consts::TAU);
            let (r1, r2) = (rng.random_range(4.0..10.0), rng.random_range(4.0..10.0));
            let (b, c) = (direction(0.0, turn), direction(angle, turn));
            let v = [
                ax,
                ay,
                ax + r1 * b.0,
                ay + r1 * b.1,
                ax + r2 * c.0,
                ay + r2 * c.1,
            ];
            let reversed = [v[4], v[5], v[2], v[3], v[0], v[1]];
            for v in [v, reversed] {
                let alpha = rng.random_range(40.0..250.0);
                let color = std::array::from_fn(|_| rng.random_range(0.0..255.0));
                layers.push(Layer::triangle(v, alpha, color));
            }
        }
        layers
    }

    /// Convex quadrilaterals `A, B, C, D` with a vertex `A` of 165° or of
    /// 25°, `C` on the diagonal from `A` through the middle of `BD`, at or
    /// beyond the parallelogram's fourth vertex, so that each has an angle
    /// of at least 150° and one of at most 30°, each in both orientations,
    /// at random places and turns in a canvas of `size`.
    fn sharp_quads(rng: &mut ChaCha8Rng, size: f64) -> Vec<Layer> {
        let mut layers = Vec::new();
        for angle in [165.0, 25.0] {
            let (ax, ay) = (
                rng.random_range(size / 4.0..3.0 * size / 4.0),
                rng.random_range(size / 4.0..3.0 * size / 4.0),
            );
            let turn = rng.random_range(0.0..std::f64::consts::TAU);
            let (r1, r2) = (rng.random_range(4.0..10.0), rng.random_range(4.0..10.0));
            let (b, d) = (direction(0.0, turn), direction(angle, turn));
            let (b, d) = ((r1 * b.0, r1 * b.1), (r2 * d.0, r2 * d.1));
            let s = rng.random_range(1.0..1.3);
            let v = [
                ax,
                ay,
                ax + b.0,
                ay + b.1,
                ax + s * (b.0 + d.0),
                ay + s * (b.1 + d.1),
                ax + d.0,
                ay + d.1,
            ];
            let angles: [f64; 4] = std::array::from_fn(|k| {
                let (o, p, q) = (k, (k + 3) % 4, (k + 1) % 4);
                let (ux, uy) = (v[2 * p] - v[2 * o], v[2 * p + 1] - v[2 * o + 1]);
                let (wx, wy) = (v[2 * q] - v[2 * o], v[2 * q + 1] - v[2 * o + 1]);
                ((ux * wx + uy * wy) / (ux.hypot(uy) * wx.hypot(wy)))
                    .acos()
                    .to_degrees()
            });
            assert!(
                (angles.iter().sum::<f64>() - 360.0).abs() < 1e-6,
                "{angles:?}"
            );
            assert!(angles.iter().any(|&a| a >= 150.0), "{angles:?}");
            assert!(angles.iter().any(|&a| a <= 30.0), "{angles:?}");
            let reversed = [v[6], v[7], v[4], v[5], v[2], v[3], v[0], v[1]];
            for params in [v, reversed] {
                layers.push(Layer {
                    outline: Outline::Quad,
                    params,
                    alpha: rng.random_range(40.0..250.0),
                    color: std::array::from_fn(|_| rng.random_range(0.0..255.0)),
                });
            }
        }
        layers
    }

    /// The vertices of a random strictly convex quadrilateral around
    /// `centre`, with radii up to `size`: four points on an ellipse whose
    /// angles are at least 20° apart, in a random orientation.
    pub(in crate::joint) fn random_convex(
        rng: &mut ChaCha8Rng,
        centre: (f64, f64),
        size: f64,
    ) -> [f64; COORDS] {
        let at: [f64; 4] = loop {
            let mut at: [f64; 4] = std::array::from_fn(|_| rng.random_range(0.0..360.0));
            at.sort_by(f64::total_cmp);
            let gaps = [
                at[1] - at[0],
                at[2] - at[1],
                at[3] - at[2],
                360.0 + at[0] - at[3],
            ];
            if gaps.iter().all(|&gap| (20.0..=160.0).contains(&gap)) {
                break at;
            }
        };
        let (rx, ry) = (
            rng.random_range(0.3..1.0) * size,
            rng.random_range(0.3..1.0) * size,
        );
        let turn = rng.random_range(0.0..std::f64::consts::TAU);
        let reverse = rng.random_bool(0.5);
        let mut v = [0.0; COORDS];
        for k in 0..4 {
            let (sin, cos) = at[if reverse { 3 - k } else { k }].to_radians().sin_cos();
            let (x, y) = (rx * cos, ry * sin);
            v[2 * k] = centre.0 + x * turn.cos() - y * turn.sin();
            v[2 * k + 1] = centre.1 + x * turn.sin() + y * turn.cos();
        }
        v
    }

    fn random_quads(rng: &mut ChaCha8Rng, count: usize, size: f64) -> Vec<Layer> {
        (0..count)
            .map(|_| {
                let centre = (rng.random_range(0.0..size), rng.random_range(0.0..size));
                Layer {
                    outline: Outline::Quad,
                    params: random_convex(rng, centre, size / 2.0),
                    alpha: rng.random_range(40.0..250.0),
                    color: std::array::from_fn(|_| rng.random_range(0.0..255.0)),
                }
            })
            .collect()
    }

    /// Random axis-aligned rectangles in a canvas of `size`, keeping the
    /// rule: sides at least 1 px and at most 8 times each other.
    pub(in crate::joint) fn random_boxes(
        rng: &mut ChaCha8Rng,
        count: usize,
        size: f64,
    ) -> Vec<Layer> {
        (0..count)
            .map(|_| {
                let (w, h) = loop {
                    let (w, h) = (
                        rng.random_range(1.0..size / 2.0),
                        rng.random_range(1.0..size / 2.0),
                    );
                    if w <= 8.0 * h && h <= 8.0 * w {
                        break (w, h);
                    }
                };
                let (x, y) = (
                    rng.random_range(-3.0..size - 2.0),
                    rng.random_range(-3.0..size - 2.0),
                );
                let mut params = [0.0; COORDS];
                params[..4].copy_from_slice(&[x, y, x + w, y + h]);
                Layer {
                    outline: Outline::Rect,
                    params,
                    alpha: rng.random_range(40.0..250.0),
                    color: std::array::from_fn(|_| rng.random_range(0.0..255.0)),
                }
            })
            .collect()
    }

    /// Random rotated rectangles in a canvas of `size`, keeping the rule:
    /// `|u|` and `h` at least 1/2 and at most 8 times each other.
    pub(in crate::joint) fn random_rotated(
        rng: &mut ChaCha8Rng,
        count: usize,
        size: f64,
    ) -> Vec<Layer> {
        (0..count)
            .map(|_| {
                let (r, h) = loop {
                    let (r, h) = (
                        rng.random_range(0.5..size / 3.0),
                        rng.random_range(0.5..size / 3.0),
                    );
                    if r <= 8.0 * h && h <= 8.0 * r {
                        break (r, h);
                    }
                };
                let turn = rng.random_range(0.0..std::f64::consts::TAU);
                let mut params = [0.0; COORDS];
                params[..5].copy_from_slice(&[
                    rng.random_range(0.0..size),
                    rng.random_range(0.0..size),
                    r * turn.cos(),
                    r * turn.sin(),
                    h,
                ]);
                Layer {
                    outline: Outline::Rotated,
                    params,
                    alpha: rng.random_range(40.0..250.0),
                    color: std::array::from_fn(|_| rng.random_range(0.0..255.0)),
                }
            })
            .collect()
    }

    /// Random circles, axis-aligned and rotated ellipses in a canvas of
    /// `size`, `count` of each, with radii in `radii`, either the longer,
    /// at random angles.
    pub(in crate::joint) fn random_conics(
        rng: &mut ChaCha8Rng,
        count: usize,
        size: f64,
        radii: std::ops::Range<f64>,
    ) -> Vec<Layer> {
        let mut layers = Vec::new();
        for outline in [Outline::Circle, Outline::Ellipse, Outline::RotatedEllipse] {
            for _ in 0..count {
                let centre = (rng.random_range(0.0..size), rng.random_range(0.0..size));
                let r = (
                    rng.random_range(radii.clone()),
                    rng.random_range(radii.clone()),
                );
                let mut layer = tests::conic(outline, centre, r, rng.random_range(-180.0..180.0));
                layer.alpha = rng.random_range(40.0..250.0);
                layer.color = std::array::from_fn(|_| rng.random_range(0.0..255.0));
                layers.push(layer);
            }
        }
        layers
    }

    /// A random mask on a `width × height` canvas: a box partly off the
    /// canvas clipped to it, with pixels uncovered, covered and partly
    /// covered.
    fn random_mask<F: Real>(rng: &mut ChaCha8Rng, width: usize, height: usize) -> Mask<F> {
        let x0 = rng.random_range(0..width - 4);
        let y0 = rng.random_range(0..height - 4);
        let x1 = rng.random_range(x0 + 2..=width);
        let y1 = rng.random_range(y0 + 2..=height);
        let coverage = (0..(x1 - x0) * (y1 - y0))
            .map(|_| match rng.random_range(0..4) {
                0 => F::of(0.0),
                1 => F::of(rng.random_range(0.0..1.0)),
                _ => F::of(1.0),
            })
            .collect();
        Mask {
            x0,
            x1,
            y0,
            y1,
            coverage,
        }
    }

    /// A scene `width × height` with `masks` random fixed layers, and its
    /// layers: triangles, quads and the fixed layers, interleaved.
    fn mixed_scene(
        rng: &mut ChaCha8Rng,
        width: usize,
        height: usize,
        counts: (usize, usize, usize),
    ) -> (Scene<f64>, Vec<Layer>) {
        let mut scene = random_scene::<f64>(rng, width, height);
        let size = width.min(height) as f64;
        let mut tris = random_tris(rng, counts.0, size).into_iter();
        let mut quads = random_quads(rng, counts.1, size).into_iter();
        let mut layers = Vec::new();
        for index in 0..counts.2.max(counts.0).max(counts.1) {
            layers.extend(tris.next());
            if index < counts.2 {
                scene.masks.push(random_mask(rng, width, height));
                layers.push(Layer {
                    outline: Outline::Fixed(index),
                    params: [0.0; COORDS],
                    alpha: rng.random_range(40.0..250.0),
                    color: std::array::from_fn(|_| rng.random_range(0.0..255.0)),
                });
            }
            layers.extend(quads.next());
        }
        (scene, layers)
    }

    fn fresh_loss(scene: &Scene<f64>, layers: &[Layer]) -> f64 {
        loss(scene, layers, &mut Workspace::default())
    }

    /// The analytic gradients of vertices and alphas of `layers` on
    /// `scene` against central differences. Returns the largest relative
    /// error over the components whose magnitude is at least 1% of the
    /// largest one, the overall relative error, and how many components
    /// were checked. The components a layer does not use, every vertex
    /// coordinate of a fixed layer among them, must be exactly zero.
    fn gradient_check(scene: &Scene<f64>, layers: &[Layer]) -> (f64, f64, usize) {
        let analytic = gradients(scene, layers, &mut Workspace::default());
        let mut numeric = vec![[0.0; PARAMS]; layers.len()];
        for (index, grads) in numeric.iter_mut().enumerate() {
            let coords = layers[index].outline.params();
            for (k, grad) in grads.iter_mut().enumerate() {
                if k < ALPHA && k >= coords {
                    assert_eq!(analytic[index][k], 0.0, "layer {index}, {k}");
                    continue;
                }
                let h = if k == ALPHA { 1e-3 } else { 1e-5 };
                let shifted = |sign: f64| {
                    let mut moved = layers.to_vec();
                    if k == ALPHA {
                        moved[index].alpha += sign * h;
                    } else {
                        moved[index].params[k] += sign * h;
                    }
                    fresh_loss(scene, &moved)
                };
                *grad = (shifted(1.0) - shifted(-1.0)) / (2.0 * h);
            }
        }
        let scale = numeric
            .iter()
            .flatten()
            .fold(0.0_f64, |max, value| max.max(value.abs()));
        let mut worst = 0.0_f64;
        let mut checked = 0;
        let mut squared = (0.0, 0.0);
        for (a, f) in analytic.iter().flatten().zip(numeric.iter().flatten()) {
            squared.0 += (a - f) * (a - f);
            squared.1 += f * f;
            if f.abs() >= 0.01 * scale {
                checked += 1;
                worst = worst.max((a - f).abs() / f.abs());
            }
        }
        let overall = (squared.0 / squared.1).sqrt();
        (worst, overall, checked)
    }

    /// On 32 × 32 random targets with random triangles, and triangles
    /// with acute and obtuse vertices ([`sharp_tris`]), at the export's
    /// filter width and at wider ones.
    #[test]
    fn analytic_gradients_match_finite_differences() {
        for (seed, count, filter) in [
            (1, 3, 1.0),
            (2, 5, 1.0),
            (3, 7, 1.0),
            (4, 5, 1.6),
            (5, 7, 2.0),
        ] {
            let mut rng = ChaCha8Rng::seed_from_u64(seed);
            let mut scene = random_scene::<f64>(&mut rng, 32, 32);
            scene.filter = filter;
            let mut tris = random_tris(&mut rng, count, 32.0);
            tris.extend(sharp_tris(&mut rng, 32.0));
            let (worst, overall, checked) = gradient_check(&scene, &tris);
            assert!(checked >= count * 4, "seed {seed}: {checked} checked");
            assert!(worst < 1e-3, "seed {seed}: worst {worst}");
            assert!(overall < 1e-4, "seed {seed}: overall {overall}");
        }
    }

    /// The same with random convex quadrilaterals, and quadrilaterals with
    /// acute and obtuse vertices ([`sharp_quads`]).
    #[test]
    fn analytic_gradients_of_polygons_match_finite_differences() {
        for (seed, count, filter) in [
            (11, 3, 1.0),
            (12, 5, 1.0),
            (13, 7, 1.0),
            (14, 5, 1.6),
            (15, 7, 2.0),
        ] {
            let mut rng = ChaCha8Rng::seed_from_u64(seed);
            let mut scene = random_scene::<f64>(&mut rng, 32, 32);
            scene.filter = filter;
            let mut quads = random_quads(&mut rng, count, 32.0);
            quads.extend(sharp_quads(&mut rng, 32.0));
            let (worst, overall, checked) = gradient_check(&scene, &quads);
            assert!(checked >= count * 6, "seed {seed}: {checked} checked");
            assert!(worst < 1e-3, "seed {seed}: worst {worst}");
            assert!(overall < 1e-4, "seed {seed}: overall {overall}");
        }
    }

    /// Half-slopes at pixel boundaries, including corners, for both edge
    /// directions and both sides of the shapes. Forward coverage stays exact.
    #[test]
    fn analytic_gradients_at_axis_aligned_edge_kinks_match_finite_differences() {
        let mut rng = ChaCha8Rng::seed_from_u64(73);
        let scene = random_scene::<f64>(&mut rng, 32, 32);
        let mut layers = vec![
            Layer::triangle([5.5, 6.5, 24.5, 6.5, 5.5, 25.5], 180.0, [60.0, 210.0, 90.0]),
            Layer::triangle(
                [24.5, 25.5, 5.5, 25.5, 24.5, 6.5],
                180.0,
                [60.0, 210.0, 90.0],
            ),
            Layer {
                outline: Outline::Quad,
                params: [5.5, 6.5, 24.5, 6.5, 24.5, 25.5, 5.5, 25.5],
                alpha: 180.0,
                color: [60.0, 210.0, 90.0],
            },
        ];
        for (ux, uy, h) in [
            (5.0, 0.0, 3.0),
            (0.0, 5.0, 3.0),
            (49.0, 0.0, 7.0),
            (0.0, 49.0, 7.0),
        ] {
            layers.push(Layer {
                outline: Outline::Rotated,
                params: [15.5, 15.5, ux, uy, h, 0.0, 0.0, 0.0],
                alpha: 180.0,
                color: [60.0, 210.0, 90.0],
            });
        }
        for radius in [1.5, 2.5, 3.5, 4.5, 5.5, 6.5] {
            layers.push(conic(Outline::Circle, (15.0, 15.0), (radius, radius), 0.0));
            layers.push(conic(Outline::Ellipse, (15.0, 15.0), (radius, 1.5), 0.0));
        }
        for layer in layers {
            if layer.outline.sides() >= 3 {
                compare_coverage(&layer);
            } else {
                let prepared = Prepared::new(&layer, &scene);
                for y in 0..scene.height {
                    for x in 0..scene.width {
                        let (x, y) = (x as f64, y as f64);
                        assert_eq!(
                            prepared.conic_coverage_grad(x, y).map_or(0.0, |(f, _)| f),
                            prepared.conic_coverage(x, y)
                        );
                    }
                }
            }
            let (worst, overall, _) = gradient_check(&scene, &[layer]);
            assert!(worst < 1e-3, "{layer:?}: worst {worst}");
            assert!(overall < 1e-4, "{layer:?}: overall {overall}");
        }
    }

    /// The same with axis-aligned and rotated rectangles, among them
    /// rectangles on the rule's boundary: sides of exactly 1 px, half-sides
    /// of exactly 1/2, and long sides of exactly 8 times the short ones.
    #[test]
    fn analytic_gradients_of_rectangles_match_finite_differences() {
        for (seed, count, filter) in [
            (31, 3, 1.0),
            (32, 5, 1.0),
            (33, 7, 1.0),
            (34, 5, 1.6),
            (35, 7, 2.0),
        ] {
            let mut rng = ChaCha8Rng::seed_from_u64(seed);
            let mut scene = random_scene::<f64>(&mut rng, 32, 32);
            scene.filter = filter;
            let mut layers = random_boxes(&mut rng, count, 32.0);
            layers.extend(random_rotated(&mut rng, count, 32.0));
            // On the boundary of the rule.
            layers[0].params[2] = layers[0].params[0] + 1.0;
            layers[1].params[3] =
                layers[1].params[1] + 8.0 * (layers[1].params[2] - layers[1].params[0]);
            let [_, _, ux, uy, ..] = layers[count].params;
            let r = ux.hypot(uy);
            layers[count].params[2] = 0.5 * ux / r;
            layers[count].params[3] = 0.5 * uy / r;
            layers[count].params[4] = 4.0;
            layers[count + 1].params[4] =
                layers[count + 1].params[2].hypot(layers[count + 1].params[3]) / 8.0;
            // On pixel boundaries, as the greedy search's: central
            // differences there are the mean of the one-sided slopes.
            layers[2].params[..4].copy_from_slice(&[3.5, 4.5, 12.5, 20.5]);
            let (worst, overall, checked) = gradient_check(&scene, &layers);
            let aligned = gradients(&scene, &layers, &mut Workspace::default())[2];
            assert!(aligned[..4].iter().all(|&g| g != 0.0), "{aligned:?}");
            assert!(checked >= count * 6, "seed {seed}: {checked} checked");
            assert!(worst < 1e-3, "seed {seed}: worst {worst}");
            assert!(overall < 1e-4, "seed {seed}: overall {overall}");
        }
    }

    /// The same with circles, axis-aligned and rotated ellipses of radii
    /// from 2 to 20 px, either the longer, at random angles: the gradient
    /// is the exact derivative of the local-straight coverage
    /// ([`Prepared::conic_coverage_grad`]), the widths' terms included.
    /// Measured: a worst relative error of 2.8e-7 and an overall one of
    /// 7.4e-9; without the widths' terms, 1.2% and 0.3%.
    #[test]
    fn analytic_gradients_of_curved_outlines_match_finite_differences() {
        for (seed, count, filter) in [
            (41, 2, 1.0),
            (42, 3, 1.0),
            (43, 4, 1.0),
            (44, 3, 1.6),
            (45, 4, 2.0),
        ] {
            let mut rng = ChaCha8Rng::seed_from_u64(seed);
            let mut scene = random_scene::<f64>(&mut rng, 32, 32);
            scene.filter = filter;
            let layers = random_conics(&mut rng, count, 32.0, 2.0..20.0);
            let (worst, overall, checked) = gradient_check(&scene, &layers);
            assert!(checked >= count * 9, "seed {seed}: {checked} checked");
            assert!(worst < 1e-3, "seed {seed}: worst {worst}");
            assert!(overall < 1e-4, "seed {seed}: overall {overall}");
        }
    }

    /// The same with triangles, quadrilaterals and fixed layers
    /// interleaved: the fixed layers have an opacity gradient and no
    /// vertex gradient.
    #[test]
    fn analytic_gradients_of_a_mixed_scene_match_finite_differences() {
        for (seed, counts) in [(21, (2, 2, 2)), (22, (3, 2, 4)), (23, (1, 3, 5))] {
            let mut rng = ChaCha8Rng::seed_from_u64(seed);
            let (scene, layers) = mixed_scene(&mut rng, 32, 32, counts);
            let (worst, overall, checked) = gradient_check(&scene, &layers);
            assert!(
                checked >= layers.len() * 3,
                "seed {seed}: {checked} checked"
            );
            assert!(worst < 1e-3, "seed {seed}: worst {worst}");
            assert!(overall < 1e-4, "seed {seed}: overall {overall}");
            let analytic = gradients(&scene, &layers, &mut Workspace::default());
            for (layer, grad) in layers.iter().zip(&analytic) {
                if let Outline::Fixed(_) = layer.outline {
                    assert!(grad[..ALPHA].iter().all(|&g| g == 0.0), "{grad:?}");
                    assert_ne!(grad[ALPHA], 0.0);
                }
            }
        }
    }

    /// The edge model is the exact area of the pixel square on the inside
    /// of the edge's line, against a 1024 × 1024 supersampling.
    #[test]
    fn edge_coverage_is_the_pixel_area_of_the_half_plane() {
        let mut rng = ChaCha8Rng::seed_from_u64(9);
        for _ in 0..40 {
            let tri = Layer::triangle(
                std::array::from_fn(|_| rng.random_range(-20.0..20.0)),
                255.0,
                [0.0; 3],
            );
            let scene = blank_scene(64, 64);
            let prepared = Prepared::<f64>::new(&tri, &scene);
            let edge = prepared.edges[0];
            let d = rng.random_range(-0.8..0.8);
            // A pixel centre at signed distance `d`: the origin shifted
            // along the normal.
            let (cx, cy) = (
                d * edge.nx - edge.c * edge.nx,
                d * edge.ny - edge.c * edge.ny,
            );
            assert!((edge.distance(cx, cy) - d).abs() < 1e-9);
            let n = 1024;
            let inside = (0..n * n)
                .filter(|i| {
                    let sx = cx - 0.5 + ((i % n) as f64 + 0.5) / n as f64;
                    let sy = cy - 0.5 + ((i / n) as f64 + 0.5) / n as f64;
                    edge.distance(sx, sy) >= 0.0
                })
                .count();
            let area = inside as f64 / (n * n) as f64;
            let model = edge.cdf(d);
            assert!((model - area).abs() < 2e-3, "{model} vs {area} at {d}");
        }
    }

    /// A quadrilateral whose vertex at the centre of a pixel has an
    /// interior angle of 175°: its two edges nearly coincide there, each
    /// covering about half the pixel, and the wedge between them covers
    /// `1/2 − tan(2.5°) / 4` of it, about 0.489, in either orientation.
    #[test]
    fn a_vertex_of_175_degrees_covers_about_half_its_pixel() {
        let scene = blank_scene(32, 32);
        let t = 2.5_f64.to_radians().tan();
        let v = [
            10.0,
            10.0,
            16.0,
            10.0 + 6.0 * t,
            10.0,
            20.0,
            4.0,
            10.0 + 6.0 * t,
        ];
        let reversed = [v[6], v[7], v[4], v[5], v[2], v[3], v[0], v[1]];
        let expected = 0.5 - t / 4.0;
        for params in [v, reversed] {
            let layer = Layer {
                outline: Outline::Quad,
                params,
                alpha: 255.0,
                color: [255.0; 3],
            };
            let prepared = Prepared::<f64>::new(&layer, &scene);
            let cover = prepared.coverage(10.0, 10.0);
            assert!((cover - expected).abs() < 1e-12, "{cover} vs {expected}");
            let (value, _) = prepared
                .edge_coverage_grad::<4>(10.0, 10.0)
                .expect("covered");
            assert!((value - expected).abs() < 1e-12, "{value} vs {expected}");
        }
    }

    /// A triangle whose vertex at the centre of a pixel has an angle of
    /// 20°, its bisector along `x`: the wedge `|y − 10| ≤ (x − 10) ·
    /// tan(10°)` for `10 ≤ x ≤ 10.5` stays inside the pixel, so it covers
    /// `∫₀^½ 2 u tan(10°) du = tan(10°) / 4`, about 0.044, in either
    /// orientation, where each edge alone covers half the pixel.
    #[test]
    fn a_vertex_of_20_degrees_covers_its_wedge() {
        let scene = blank_scene(32, 32);
        let t = 10.0_f64.to_radians().tan();
        let v = [10.0, 10.0, 16.0, 10.0 - 6.0 * t, 16.0, 10.0 + 6.0 * t];
        let reversed = [v[4], v[5], v[2], v[3], v[0], v[1]];
        let expected = t / 4.0;
        for v in [v, reversed] {
            let layer = Layer::triangle(v, 255.0, [255.0; 3]);
            let prepared = Prepared::<f64>::new(&layer, &scene);
            let cover = prepared.coverage(10.0, 10.0);
            assert!((cover - expected).abs() < 1e-12, "{cover} vs {expected}");
            let (value, _) = prepared
                .edge_coverage_grad::<3>(10.0, 10.0)
                .expect("covered");
            assert!((value - expected).abs() < 1e-12, "{value} vs {expected}");
        }
    }

    /// The area of the part of the convex polygon `v` (engine coordinates,
    /// `x0, y0, x1, y1, …`) inside the pixel square centred at `(x, y)`:
    /// the polygon clipped to the square's four sides (Sutherland–Hodgman),
    /// then the shoelace formula.
    fn exact_coverage(v: &[f64], x: f64, y: f64) -> f64 {
        let mut polygon: Vec<(f64, f64)> =
            v.as_chunks::<2>().0.iter().map(|p| (p[0], p[1])).collect();
        // Each side as `inside(p) = s · (p[axis] − bound) ≥ 0`.
        for (axis, bound, s) in [
            (0, x - 0.5, 1.0),
            (0, x + 0.5, -1.0),
            (1, y - 0.5, 1.0),
            (1, y + 0.5, -1.0),
        ] {
            let side = |p: (f64, f64)| s * (if axis == 0 { p.0 } else { p.1 } - bound);
            let mut clipped = Vec::with_capacity(polygon.len() + 1);
            for (i, &p) in polygon.iter().enumerate() {
                let q = polygon[(i + 1) % polygon.len()];
                let (sp, sq) = (side(p), side(q));
                if sp >= 0.0 {
                    clipped.push(p);
                }
                if (sp >= 0.0) != (sq >= 0.0) {
                    let t = sp / (sp - sq);
                    clipped.push((p.0 + t * (q.0 - p.0), p.1 + t * (q.1 - p.1)));
                }
            }
            polygon = clipped;
            if polygon.is_empty() {
                return 0.0;
            }
        }
        let twice: f64 = (0..polygon.len())
            .map(|i| {
                let (p, q) = (polygon[i], polygon[(i + 1) % polygon.len()]);
                p.0 * q.1 - q.0 * p.1
            })
            .sum();
        twice.abs() / 2.0
    }

    /// The forward model's coverage of `layer` against the exact area of
    /// the polygon inside each pixel of a `SIZE × SIZE` canvas, computed
    /// independently by clipping the polygon to the pixel
    /// ([`exact_coverage`]): every pixel within `1e-9`, inside the layer's
    /// bounding box wherever it is covered, and the same coverage from the
    /// gradient's path. Returns the model's and the exact total area.
    fn compare_coverage(layer: &Layer) -> (f64, f64) {
        const SIZE: usize = 64;
        let scene = blank_scene(SIZE, SIZE);
        let corners = layer.corners();
        let v = &corners[..2 * layer.outline.sides()];
        let prepared = Prepared::<f64>::new(layer, &scene);
        let (mut model_area, mut exact_area) = (0.0, 0.0);
        for y in 0..SIZE {
            for x in 0..SIZE {
                let (fx, fy) = (x as f64, y as f64);
                let exact = exact_coverage(v, fx, fy);
                let in_box = (prepared.x0..prepared.x1).contains(&x)
                    && (prepared.y0..prepared.y1).contains(&y);
                let model = prepared.coverage(fx, fy);
                assert!(in_box || exact == 0.0, "{v:?}: ({x}, {y}) outside the box");
                assert!(
                    (model - exact).abs() < 1e-9,
                    "{v:?} at ({x}, {y}): {model} vs {exact}"
                );
                let with_grad = match layer.outline.sides() {
                    3 => prepared.edge_coverage_grad::<3>(fx, fy),
                    _ => prepared.edge_coverage_grad::<4>(fx, fy),
                };
                assert_eq!(
                    with_grad.map_or(0.0, |(cover, _)| cover),
                    model,
                    "{layer:?} at ({x}, {y})"
                );
                model_area += model;
                exact_area += exact;
            }
        }
        assert!(
            (model_area - exact_area).abs() < 1e-9 * exact_area.max(1.0),
            "{v:?}: area {model_area} vs {exact_area}"
        );
        (model_area, exact_area)
    }

    /// Random triangles from 2 to 48 px are covered by their exact area in
    /// every pixel, those around their vertices included. (The product of
    /// the edges' half-planes, which the model used before, over-covered
    /// near acute vertices: a mean error of 0.035 per edge pixel and a
    /// median excess area of +45% at 2 px.)
    #[test]
    fn coverage_matches_the_exact_pixel_area_of_the_triangle() {
        let mut rng = ChaCha8Rng::seed_from_u64(7);
        for size in [2.0, 6.0, 12.0, 24.0, 48.0_f64] {
            for _ in 0..20 {
                let centre = 32.0;
                let v: [f64; 6] = loop {
                    let v =
                        std::array::from_fn(|_| centre + rng.random_range(-size / 2.0..size / 2.0));
                    let cross = (v[2] - v[0]) * (v[5] - v[1]) - (v[3] - v[1]) * (v[4] - v[0]);
                    if cross.abs() > size * size / 8.0 {
                        break v;
                    }
                };
                compare_coverage(&Layer::triangle(v, 255.0, [255.0; 3]));
            }
        }
    }

    /// The same for convex quadrilaterals.
    #[test]
    fn coverage_matches_the_exact_pixel_area_of_a_convex_polygon() {
        let mut rng = ChaCha8Rng::seed_from_u64(8);
        for size in [2.0, 6.0, 12.0, 24.0, 48.0_f64] {
            for _ in 0..20 {
                let layer = Layer {
                    outline: Outline::Quad,
                    params: random_convex(&mut rng, (32.0, 32.0), size / 2.0),
                    alpha: 255.0,
                    color: [255.0; 3],
                };
                compare_coverage(&layer);
            }
        }
    }

    /// An axis-aligned rectangle with sides of at least 1 px covers each
    /// pixel by exactly its area there.
    #[test]
    fn coverage_of_an_axis_aligned_rectangle_is_exact() {
        let mut rng = ChaCha8Rng::seed_from_u64(10);
        let scene = blank_scene(64, 64);
        let mut partial = 0;
        for layer in random_boxes(&mut rng, 200, 64.0) {
            let prepared = Prepared::<f64>::new(&layer, &scene);
            let corners = layer.corners();
            let mut total = 0.0;
            for y in 0..64 {
                for x in 0..64 {
                    let (fx, fy) = (x as f64, y as f64);
                    let exact = exact_coverage(&corners, fx, fy);
                    let in_box = (prepared.x0..prepared.x1).contains(&x)
                        && (prepared.y0..prepared.y1).contains(&y);
                    assert!(
                        in_box || exact == 0.0,
                        "{layer:?}: ({x}, {y}) outside the box"
                    );
                    let model = if in_box {
                        prepared.pixel(x, y, fy)
                    } else {
                        0.0
                    };
                    assert!(
                        (model - exact).abs() < 1e-12,
                        "{layer:?} at ({x}, {y}): {model} vs {exact}"
                    );
                    partial += usize::from(exact > 0.0 && exact < 1.0);
                    total += model;
                }
            }
            let [x0, y0, x1, y1, ..] = layer.params;
            let visible = (x1.min(63.5) - x0.max(-0.5)) * (y1.min(63.5) - y0.max(-0.5));
            assert!(
                (total - visible).abs() < 1e-9,
                "{layer:?}: {total} vs {visible}"
            );
        }
        assert!(partial > 5000, "{partial} partly covered pixels");
    }

    /// The same for rotated rectangles, whose exact area is `4 |u| h`.
    #[test]
    fn coverage_matches_the_exact_pixel_area_of_a_rotated_rectangle() {
        let mut rng = ChaCha8Rng::seed_from_u64(11);
        for size in [2.0, 6.0, 12.0, 24.0, 48.0_f64] {
            for mut layer in random_rotated(&mut rng, 20, size) {
                // Centred within a pixel of the canvas's centre, inside it.
                layer.params[0] = 31.0 + 2.0 * layer.params[0] / size;
                layer.params[1] = 31.0 + 2.0 * layer.params[1] / size;
                let (_, exact_area) = compare_coverage(&layer);
                let [_, _, ux, uy, h, ..] = layer.params;
                let area = 4.0 * ux.hypot(uy) * h;
                assert!(
                    (exact_area - area).abs() < 1e-9 * area.max(1.0),
                    "{layer:?}"
                );
            }
        }
    }

    /// A circle, an axis-aligned ellipse or a rotated ellipse (`outline`)
    /// of centre `centre` and radii `rx` along the direction at `degrees`
    /// and `ry` across it, built with the platform's trigonometry; a
    /// circle takes `rx`, an axis-aligned ellipse ignores `degrees`.
    pub(in crate::joint) fn conic(
        outline: Outline,
        centre: (f64, f64),
        (rx, ry): (f64, f64),
        degrees: f64,
    ) -> Layer {
        let mut params = [0.0; COORDS];
        params[0] = centre.0;
        params[1] = centre.1;
        match outline {
            Outline::Circle => params[2] = rx,
            Outline::Ellipse => {
                params[2] = rx;
                params[3] = ry;
            }
            Outline::RotatedEllipse => {
                let (sin, cos) = degrees.to_radians().sin_cos();
                params[2] = rx * cos;
                params[3] = rx * sin;
                params[4] = ry;
            }
            _ => panic!("not a curved outline: {outline:?}"),
        }
        Layer {
            outline,
            params,
            alpha: 255.0,
            color: [255.0; 3],
        }
    }

    /// The centre, the semi-axis vector `a` and the other semi-axis `b` of
    /// a curved layer, read independently of the model.
    fn conic_axes(layer: &Layer) -> ((f64, f64), (f64, f64), f64) {
        let p = layer.params;
        let centre = (p[0], p[1]);
        match layer.outline {
            Outline::Circle => (centre, (p[2], 0.0), p[2]),
            Outline::Ellipse => (centre, (p[2], 0.0), p[3]),
            Outline::RotatedEllipse => (centre, (p[2], p[3]), p[4]),
            outline => panic!("not a curved outline: {outline:?}"),
        }
    }

    /// Where the pixel square centred at `(x, y)` lies against the ellipse
    /// of `layer`, and how much of it the ellipse covers: `Some(1.0)` if
    /// the square is wholly inside, `Some(0.0)` if wholly outside, both
    /// exact; `None` for a pixel the boundary crosses.
    ///
    /// The ellipse becomes the unit disc in its own frame, rotated by the
    /// platform's `atan2`, `sin` and `cos` and scaled by its radii, and the
    /// square a parallelogram: inside if its four corners are in the disc,
    /// outside if the origin is outside it and further than 1 from each of
    /// its sides.
    fn conic_class(layer: &Layer, x: f64, y: f64) -> Option<f64> {
        let frame = conic_frame(layer);
        let corners =
            [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)].map(|(u, v)| frame(x + u, y + v));
        if corners.iter().all(|&(u, v)| u * u + v * v <= 1.0) {
            return Some(1.0);
        }
        let cross = |p: (f64, f64), q: (f64, f64)| p.0 * q.1 - p.1 * q.0;
        let sides: [f64; 4] = std::array::from_fn(|k| {
            let (p, q) = (corners[k], corners[(k + 1) % 4]);
            cross((q.0 - p.0, q.1 - p.1), (-p.0, -p.1))
        });
        let contains = sides.iter().all(|&s| s >= 0.0) || sides.iter().all(|&s| s <= 0.0);
        let far = (0..4).all(|k| {
            let (p, q) = (corners[k], corners[(k + 1) % 4]);
            let (ex, ey) = (q.0 - p.0, q.1 - p.1);
            let t = (-(p.0 * ex + p.1 * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
            (p.0 + t * ex).hypot(p.1 + t * ey) > 1.0
        });
        (!contains && far).then_some(0.0)
    }

    /// The map of the canvas to the frame of `layer`'s ellipse, where it is
    /// the unit disc, with the platform's trigonometry.
    fn conic_frame(layer: &Layer) -> impl Fn(f64, f64) -> (f64, f64) {
        let (centre, a, b) = conic_axes(layer);
        let (ra, angle) = (a.0.hypot(a.1), a.1.atan2(a.0));
        let (sin, cos) = angle.sin_cos();
        move |x, y| {
            let (dx, dy) = (x - centre.0, y - centre.1);
            ((dx * cos + dy * sin) / ra, (dy * cos - dx * sin) / b)
        }
    }

    /// The fraction of `n × n` points evenly spread over the pixel square
    /// centred at `(x, y)` that lie in `layer`'s ellipse.
    fn conic_supersampled(layer: &Layer, x: f64, y: f64, n: usize) -> f64 {
        let frame = conic_frame(layer);
        let inside = (0..n * n)
            .filter(|i| {
                let sx = x - 0.5 + ((i % n) as f64 + 0.5) / n as f64;
                let sy = y - 0.5 + ((i / n) as f64 + 0.5) / n as f64;
                let (u, v) = frame(sx, sy);
                u * u + v * v <= 1.0
            })
            .count();
        inside as f64 / (n * n) as f64
    }

    /// The forward model's coverage of a curved `layer` against the
    /// reference on a `SIZE × SIZE` canvas: the pixels wholly inside or
    /// outside ([`conic_class`]) within `1e-6`, every covered pixel inside
    /// the layer's bounding box, and the same coverage from the gradient's
    /// path. Returns the mean absolute error over the pixels the boundary
    /// crosses, against a 64 × 64 supersampling, and the model's and the
    /// reference's total area.
    fn compare_conic(layer: &Layer) -> (f64, f64, f64, [f64; 2]) {
        const SIZE: usize = 64;
        let scene = blank_scene(SIZE, SIZE);
        let prepared = Prepared::<f64>::new(layer, &scene);
        let (mut error, mut boundary) = (0.0, 0);
        let mut exact_error = [0.0_f64; 2];
        let (mut model_area, mut reference_area) = (0.0, 0.0);
        for y in 0..SIZE {
            for x in 0..SIZE {
                let (fx, fy) = (x as f64, y as f64);
                let in_box = (prepared.x0..prepared.x1).contains(&x)
                    && (prepared.y0..prepared.y1).contains(&y);
                let model = if in_box {
                    prepared.pixel(x, y, fy)
                } else {
                    0.0
                };
                if in_box {
                    let with_grad = Curved::cover_grad(&prepared, x, y, fy);
                    assert_eq!(
                        with_grad.map_or(0.0, |(cover, _)| cover),
                        model,
                        "{layer:?} at ({x}, {y})"
                    );
                }
                let reference = match conic_class(layer, fx, fy) {
                    Some(exact) => {
                        let side = usize::from(exact == 1.0);
                        exact_error[side] = exact_error[side].max((model - exact).abs());
                        exact
                    }
                    None => {
                        assert!(in_box, "{layer:?}: ({x}, {y}) outside the box");
                        let reference = conic_supersampled(layer, fx, fy, 64);
                        error += (model - reference).abs();
                        boundary += 1;
                        reference
                    }
                };
                model_area += model;
                reference_area += reference;
            }
        }
        (
            error / boundary.max(1) as f64,
            model_area,
            reference_area,
            exact_error,
        )
    }

    /// Circles, axis-aligned and rotated ellipses at random centres of a
    /// 64 × 64 canvas, with radii from 1 to 32 px and random angles, are
    /// covered as the reference covers them, within the error of the
    /// local-straight approximation, which falls with the radius of
    /// curvature (the square of the shorter radius over the longer). By
    /// the shorter radius, under 2 px / from 2 to 8 px / from 8 px,
    /// measured:
    ///
    /// - pixels wholly inside: exact (no error above `1e-6`), as the
    ///   tangent half-plane at the nearest boundary point holds the
    ///   ellipse;
    /// - pixels wholly outside: up to 0.219 / 0.078 / 0.0012 (circles alone
    ///   0.0037 / 0.0021 / 0.0012): the tangent half-plane reaches beyond
    ///   the curve, most near the tips of thin ellipses;
    /// - the mean absolute error over the pixels the boundary crosses,
    ///   worst per shape: 0.047 / 0.018 / 0.0044;
    /// - the total area from 4 px: within 0.63% of the reference.
    #[test]
    fn coverage_of_curved_outlines_matches_their_pixel_area() {
        let mut rng = ChaCha8Rng::seed_from_u64(12);
        // The worst mean absolute error over an ellipse's boundary pixels
        // with its shorter radius in `[1, 2)`, `[2, 8)` and from 8 px, and
        // the worst relative error of the total area from 4 px.
        let (mut worst, mut worst_area) = ([0.0_f64; 3], 0.0_f64);
        let mut worst_exact = [[0.0_f64; 2]; 3];
        for outline in [Outline::Circle, Outline::Ellipse, Outline::RotatedEllipse] {
            for short in [1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0] {
                for _ in 0..8 {
                    let long = if outline == Outline::Circle {
                        short
                    } else {
                        rng.random_range(short..=32.0)
                    };
                    let radii = if rng.random_bool(0.5) {
                        (short, long)
                    } else {
                        (long, short)
                    };
                    let centre = (rng.random_range(0.0..64.0), rng.random_range(0.0..64.0));
                    let layer = conic(outline, centre, radii, rng.random_range(-180.0..180.0));
                    let (mae, model, reference, exact) = compare_conic(&layer);
                    let class = match short {
                        s if s < 2.0 => 0,
                        s if s < 8.0 => 1,
                        _ => 2,
                    };
                    worst[class] = worst[class].max(mae);
                    for side in 0..2 {
                        worst_exact[class][side] = worst_exact[class][side].max(exact[side]);
                    }
                    if short >= 4.0 {
                        worst_area = worst_area.max((model - reference).abs() / reference);
                    }
                }
            }
        }
        for (class, bound) in [0.048, 0.019, 0.0045].into_iter().enumerate() {
            assert!(worst[class] <= bound, "{worst:?}");
        }
        for (class, bound) in [0.22, 0.08, 0.0013].into_iter().enumerate() {
            assert!(worst_exact[class][0] <= bound, "outside: {worst_exact:?}");
            assert!(worst_exact[class][1] < 1e-6, "inside: {worst_exact:?}");
        }
        assert!(worst_area <= 0.0065, "{worst_area}");
    }

    /// Every layer's colour after one Jacobi step from `tris`, computed
    /// pixel by pixel from [`Prepared::coverage`] alone: each layer moves
    /// against the residual of the stack as it is, with every other layer
    /// at its colour, to `s − ω Σ g R / D` clamped to `0..=255`, with
    /// `g = A · opacity · coverage`. `D` is `Σ g Σ_j g_j` (the sum over
    /// every layer `j` at the pixel) with `majorised`, and `Σ g²` (the
    /// closed-form fit of the layer alone) without.
    fn jacobi_colours(
        scene: &Scene<f64>,
        tris: &[Layer],
        majorised: bool,
        omega: f64,
    ) -> Vec<Layer> {
        let layers: Vec<Prepared<f64>> = tris.iter().map(|tri| Prepared::new(tri, scene)).collect();
        let mut sums = vec![[0.0; 4]; tris.len()];
        for y in 0..scene.height {
            for x in 0..scene.width {
                let fy = y as f64;
                // The model composites each layer inside its bounding box
                // only.
                let weights: Vec<f64> = layers
                    .iter()
                    .map(|layer| {
                        let inside =
                            (layer.x0..layer.x1).contains(&x) && (layer.y0..layer.y1).contains(&y);
                        if inside {
                            layer.opacity * layer.pixel(x, y, fy)
                        } else {
                            0.0
                        }
                    })
                    .collect();
                let mut canvas = scene.background;
                for (layer, w) in layers.iter().zip(&weights) {
                    for (value, color) in canvas.iter_mut().zip(layer.color) {
                        *value += w * (color - *value);
                    }
                }
                let p = 3 * (y * scene.width + x);
                let residual: [f64; 3] = std::array::from_fn(|c| canvas[c] - scene.target[p + c]);
                let mut g = vec![0.0; layers.len()];
                let mut above = 1.0;
                for (g, w) in g.iter_mut().zip(&weights).rev() {
                    *g = above * w;
                    above *= 1.0 - w;
                }
                let all: f64 = g.iter().sum();
                for (sum, g) in sums.iter_mut().zip(&g) {
                    for c in 0..3 {
                        sum[c] += g * residual[c];
                    }
                    sum[3] += g * if majorised { all } else { *g };
                }
            }
        }
        tris.iter()
            .zip(sums)
            .map(|(tri, sum)| Layer {
                color: std::array::from_fn(|c| {
                    let old = tri.color[c];
                    if sum[3] > 0.0 {
                        (old - omega * sum[c] / sum[3]).clamp(0.0, 255.0)
                    } else {
                        old
                    }
                }),
                ..*tri
            })
            .collect()
    }

    /// A fit refits every colour together from the residual of the stack
    /// as it is (one Jacobi step), with the majorised weights, fixed layers
    /// included. The scene's 40 rows are not a multiple of the band height.
    #[test]
    fn colours_are_refitted_together_from_the_same_residual() {
        let mut rng = ChaCha8Rng::seed_from_u64(21);
        let (scene, tris) = mixed_scene(&mut rng, 48, 40, (4, 3, 3));
        let expected = jacobi_colours(&scene, &tris, true, OVER_RELAXATION);
        let mut fitted = tris.clone();
        fit(&scene, &mut fitted, &mut Workspace::default());
        for (index, (tri, expected)) in fitted.iter().zip(&expected).enumerate() {
            for c in 0..3 {
                assert!(
                    (tri.color[c] - expected.color[c]).abs() <= 1e-9,
                    "layer {index}: {:?} vs {:?}",
                    tri.color,
                    expected.color
                );
            }
        }
        assert_ne!(fitted, tris);
        assert_eq!(
            fitted
                .iter()
                .map(|tri| (tri.params, tri.alpha))
                .collect::<Vec<_>>(),
            tris.iter()
                .map(|tri| (tri.params, tri.alpha))
                .collect::<Vec<_>>()
        );
    }

    /// On a deep stack of large translucent layers, where a plain Jacobi
    /// step raises the loss, every fit lowers it.
    #[test]
    fn colour_fits_lower_the_loss_where_plain_jacobi_raises_it() {
        let mut rng = ChaCha8Rng::seed_from_u64(23);
        let scene = random_scene::<f64>(&mut rng, 48, 40);
        let mut tris: Vec<Layer> = (0..30)
            .map(|_| {
                let vertices = std::array::from_fn(|k| {
                    let size = if k % 2 == 0 { 48.0 } else { 40.0 };
                    rng.random_range(-0.5 * size..1.5 * size)
                });
                Layer::triangle(vertices, rng.random_range(60.0..200.0), [128.0; 3])
            })
            .collect();
        let start = fresh_loss(&scene, &tris);
        let plain = fresh_loss(&scene, &jacobi_colours(&scene, &tris, false, 1.0));
        assert!(plain > start, "plain Jacobi: {start} -> {plain}");
        let mut work = Workspace::default();
        let mut previous = start;
        for _ in 0..5 {
            fit(&scene, &mut tris, &mut work);
            let fresh = fresh_loss(&scene, &tris);
            assert!(fresh <= previous * (1.0 + 1e-12), "{fresh} vs {previous}");
            previous = fresh;
        }
        assert!(previous < start, "{start} -> {previous}");
    }

    /// `f32` compositing agrees with `f64`, curved layers included.
    #[test]
    fn single_precision_agrees_with_double() {
        let mut rng = ChaCha8Rng::seed_from_u64(21);
        let (scene, mut tris) = mixed_scene(&mut rng, 48, 40, (5, 4, 3));
        tris.extend(random_conics(&mut rng, 2, 40.0, 1.0..24.0));
        fit(&scene, &mut tris, &mut Workspace::default());
        let single = to_single(&scene);
        let wide = gradients(&scene, &tris, &mut Workspace::default());
        let narrow = gradients(&single, &tris, &mut Workspace::default());
        let (wide_loss, narrow_loss) = (
            fresh_loss(&scene, &tris),
            loss(&single, &tris, &mut Workspace::default()),
        );
        assert!((wide_loss - narrow_loss).abs() < 1e-5 * wide_loss);
        for (a, b) in wide.iter().flatten().zip(narrow.iter().flatten()) {
            assert!((a - b).abs() < 1e-3 * a.abs().max(1e3), "{a} vs {b}");
        }
    }

    fn to_single(scene: &Scene<f64>) -> Scene<f32> {
        Scene {
            width: scene.width,
            height: scene.height,
            target: scene.target.iter().map(|&v| v as f32).collect(),
            background: scene.background.map(|v| v as f32),
            filter: scene.filter,
            masks: scene
                .masks
                .iter()
                .map(|mask| Mask {
                    x0: mask.x0,
                    x1: mask.x1,
                    y0: mask.y0,
                    y1: mask.y1,
                    coverage: mask.coverage.iter().map(|&v| v as f32).collect(),
                })
                .collect(),
        }
    }

    fn coverage_scene() -> (Scene<f64>, Vec<Layer>) {
        let mut rng = ChaCha8Rng::seed_from_u64(71);
        let (scene, mut layers) = mixed_scene(&mut rng, 48, 40, (3, 3, 2));
        layers.extend(random_rotated(&mut rng, 2, 40.0));
        layers.extend(random_boxes(&mut rng, 2, 40.0));
        layers.extend(random_conics(&mut rng, 2, 40.0, 1.0..24.0));
        // A zero-coverage pixel on an axis-aligned kink still has a gradient.
        layers.push(Layer {
            outline: Outline::Rect,
            params: [10.5, 8.5, 20.5, 18.5, 0.0, 0.0, 0.0, 0.0],
            alpha: 128.0,
            color: [80.0, 160.0, 220.0],
        });
        (scene, layers)
    }

    fn evaluations<F>(work: &Workspace<F>) -> (usize, usize) {
        work.bands.iter().fold((0, 0), |(c, g), b| {
            (
                c + b.evaluations.cover.get(),
                g + b.evaluations.gradient.get(),
            )
        })
    }

    fn moving_pixels<F: Real>(scene: &Scene<F>, layers: &[Layer]) -> usize {
        prepare(scene, layers)
            .iter()
            .filter(|p| p.kind != Kind::Masked)
            .map(Prepared::box_pixels)
            .sum()
    }

    #[test]
    fn coverage_is_evaluated_once_then_reused() {
        let (scene, mut layers) = coverage_scene();
        let mut work = Workspace::default();
        let pixels = moving_pixels(&scene, &layers);
        fit(&scene, &mut layers, &mut work);
        assert_eq!(evaluations(&work), (pixels, 0), "cold fit");
        gradients(&scene, &layers, &mut work);
        assert_eq!(evaluations(&work), (0, pixels), "warm gradient");
        layers[0].params[0] = layers[0].params[0].next_up();
        let pixels = moving_pixels(&scene, &layers);
        gradients(&scene, &layers, &mut work);
        assert_eq!(
            evaluations(&work),
            (pixels, pixels),
            "one ulp invalidates the stack"
        );
    }

    #[test]
    fn coverage_budget_selects_whole_layers_in_stack_order() {
        let mut rng = ChaCha8Rng::seed_from_u64(71);
        let (scene, fixed) = mixed_scene(&mut rng, 48, 40, (0, 0, 1));
        let rect = |size: f64| Layer {
            outline: Outline::Rect,
            params: [1.0, 1.0, size, size, 0.0, 0.0, 0.0, 0.0],
            alpha: 128.0,
            color: [80.0, 160.0, 220.0],
        };
        // With a two-small-layer budget, skip a large layer and still
        // admit the small layer after it; a mask consumes no budget.
        let mut layers = vec![rect(3.0), fixed[0], rect(30.0), rect(3.0), rect(3.0)];
        let small = Prepared::new(&layers[0], &scene);
        let small_pixels = small.box_pixels();
        let budget = 2 * small_pixels * size_of::<f64>();
        let expected = vec![true, false, false, true, false];
        let cached_pixels = 2 * small_pixels;
        let pixels = moving_pixels(&scene, &layers);
        let mut work = Workspace::default();
        work.set_coverage_budget(budget);
        fit(&scene, &mut layers, &mut work);
        assert_eq!(work.cached, expected);
        assert_eq!(
            evaluations(&work),
            (cached_pixels + 2 * (pixels - cached_pixels), 0)
        );
        assert_eq!(
            work.bands
                .iter()
                .map(|b| b.coverage.len() * size_of::<f64>())
                .sum::<usize>(),
            budget
        );
        for band in &work.bands {
            for (range, &cached) in band.coverage_ranges.iter().zip(&expected) {
                assert_eq!(range.is_some(), cached);
            }
        }
        gradients(&scene, &layers, &mut work);
        assert_eq!(evaluations(&work), (2 * (pixels - cached_pixels), pixels));
    }

    #[test]
    fn coverage_key_tracks_exact_geometry_and_ignores_masks() {
        let (mut scene, mut layers) = coverage_scene();
        let mut work = Workspace::default();
        fit(&scene, &mut layers, &mut work);
        for change in 0..8 {
            match change {
                0 => scene.filter = scene.filter.next_up(),
                1 => scene.width += 1,
                2 => scene.height -= 17,
                3 => scene.height += 17,
                4 => layers.last_mut().unwrap().outline = Outline::Ellipse,
                5 => layers.swap(0, 2),
                6 => layers.push(layers[0]),
                _ => {
                    layers.pop();
                }
            }
            scene.target.resize(3 * scene.width * scene.height, 0.0);
            let actual = gradients(&scene, &layers, &mut work);
            assert_eq!(
                evaluations(&work),
                (
                    moving_pixels(&scene, &layers),
                    moving_pixels(&scene, &layers)
                )
            );
            let expected = gradients(&scene, &layers, &mut Workspace::default());
            assert_gradient_bits(&actual, &expected, format_args!("change {change}"));
        }
        // A loss on a shorter canvas must not discard the old cache's bands.
        scene.height -= 17;
        loss(&scene, &layers, &mut work);
        scene.height += 17;
        scene.masks[0].coverage.fill(0.375);
        let actual = gradients(&scene, &layers, &mut work);
        assert_eq!(evaluations(&work), (0, moving_pixels(&scene, &layers)));
        let expected = gradients(&scene, &layers, &mut Workspace::default());
        assert_gradient_bits(&actual, &expected, "a loss on a shorter canvas");
        // The key uses f64 bits even for geometry prepared in f32, and
        // includes unused parameters and the distinction between ±0.
        let single = to_single(&scene);
        let mut narrow = Workspace::default();
        gradients(&single, &layers, &mut narrow);
        let previous = layers[0].params[0];
        layers[0].params[0] = previous.next_up();
        assert_eq!(layers[0].params[0] as f32, previous as f32);
        gradients(&single, &layers, &mut narrow);
        assert_eq!(evaluations(&narrow).0, moving_pixels(&single, &layers));
        let fixed = layers
            .iter_mut()
            .find(|l| matches!(l.outline, Outline::Fixed(_)))
            .unwrap();
        fixed.params[COORDS - 1] = -0.0;
        gradients(&single, &layers, &mut narrow);
        assert_eq!(evaluations(&narrow).0, moving_pixels(&single, &layers));
    }

    #[track_caller]
    fn assert_gradient_bits(
        actual: &[[f64; PARAMS]],
        expected: &[[f64; PARAMS]],
        context: impl std::fmt::Display,
    ) {
        let bits = |gradients: &[[f64; PARAMS]]| {
            gradients
                .iter()
                .map(|g| g.map(f64::to_bits))
                .collect::<Vec<_>>()
        };
        assert_eq!(bits(actual), bits(expected), "{context}");
    }

    fn assert_layer_bits(a: &[Layer], b: &[Layer]) {
        assert_eq!(a.len(), b.len());
        for (a, b) in a.iter().zip(b) {
            assert_eq!(a.outline, b.outline);
            assert_eq!(a.params.map(f64::to_bits), b.params.map(f64::to_bits));
            assert_eq!(a.alpha.to_bits(), b.alpha.to_bits());
            assert_eq!(a.color.map(f64::to_bits), b.color.map(f64::to_bits));
        }
    }

    fn reused_passes<F: Real>(scene: &Scene<F>, initial: &[Layer], budget: usize) {
        let mut work = Workspace::default();
        work.set_coverage_budget(budget);
        let mut layers = initial.to_vec();
        let mut reference = initial.to_vec();
        for iteration in 0..6 {
            fit(scene, &mut layers, &mut work);
            if iteration == 0 && budget > 0 && budget < usize::MAX {
                assert!(work.cached.iter().any(|&v| v));
                assert!(
                    layers
                        .iter()
                        .zip(&work.cached)
                        .any(|(l, &v)| !matches!(l.outline, Outline::Fixed(_)) && !v)
                );
            }
            fit(scene, &mut reference, &mut Workspace::default());
            assert_layer_bits(&layers, &reference);
            let actual = gradients(scene, &layers, &mut work);
            let expected = gradients(scene, &reference, &mut Workspace::default());
            assert_gradient_bits(&actual, &expected, format_args!("iteration {iteration}"));
            assert_eq!(
                loss(scene, &layers, &mut work).to_bits(),
                loss(scene, &reference, &mut Workspace::default()).to_bits()
            );
            // Loss must leave the warm cache usable.
            fit(scene, &mut layers, &mut work);
            fit(scene, &mut reference, &mut Workspace::default());
            assert_layer_bits(&layers, &reference);
            for (index, layer) in layers.iter_mut().enumerate() {
                if matches!(layer.outline, Outline::Fixed(_)) {
                    continue;
                }
                if iteration % 3 == 0 {
                    if index == 0 {
                        layer.params[0] = layer.params[0].next_up();
                    } else if index % 3 == 0 {
                        layer.params[0] += 0.001;
                    }
                } else if iteration % 3 == 1 {
                    layer.alpha += 0.01;
                } else {
                    layer.color[0] += 0.01;
                }
            }
            reference.clone_from(&layers);
        }
    }

    #[test]
    fn reused_coverage_is_bit_identical_to_fresh_passes() {
        let (scene, layers) = coverage_scene();
        let kink = Prepared::new(layers.last().unwrap(), &scene);
        assert_eq!(Boxed::cover(&kink, 10, 10, 10.0), 0.0);
        let (cov, grad) = Boxed::cover_grad(&kink, 10, 10, 10.0).expect("kink gradient");
        assert_eq!(cov, 0.0);
        assert!(grad.iter().any(|&v| v != 0.0));
        // Enough for the first moving layer, but not the whole stack.
        let first = Prepared::new(&layers[0], &scene);
        let pixels = first.box_pixels();
        for budget in [0, pixels * size_of::<f64>(), usize::MAX] {
            reused_passes(&scene, &layers, budget);
        }
        let single = to_single(&scene);
        for budget in [0, pixels * size_of::<f32>(), usize::MAX] {
            reused_passes(&single, &layers, budget);
        }
    }

    /// The loss, the gradients and the fit do not depend on the number of
    /// threads, with curved layers that cross every band among the others.
    #[test]
    fn passes_do_not_depend_on_the_thread_count() {
        let run = |threads: usize| {
            let mut rng = ChaCha8Rng::seed_from_u64(33);
            let (scene, mut tris) = mixed_scene(&mut rng, 120, 100, (3, 3, 3));
            tris.extend(random_conics(&mut rng, 2, 100.0, 10.0..60.0));
            let scene = to_single(&scene);
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("pool");
            pool.install(|| {
                let mut work = Workspace::default();
                fit(&scene, &mut tris, &mut work);
                let gradients = gradients(&scene, &tris, &mut work);
                fit(&scene, &mut tris, &mut work);
                let loss = loss(&scene, &tris, &mut work);
                (loss, gradients, tris)
            })
        };
        let one = run(1);
        assert!(one.1.iter().any(|g| g.iter().any(|&v| v != 0.0)));
        for threads in [2, 4, 8] {
            let other = run(threads);
            assert_eq!(one.0.to_bits(), other.0.to_bits(), "{threads} threads");
            assert_gradient_bits(&one.1, &other.1, format_args!("{threads} threads"));
            assert_layer_bits(&one.2, &other.2);
        }
    }
}
