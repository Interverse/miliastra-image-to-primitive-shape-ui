//! Joint gradient optimisation of a drawing's triangles, convex polygons,
//! rectangles, rotated or not, ellipses, circles and rotated ellipses, with
//! every other layer (the quadratics) fixed in geometry.
//!
//! The greedy search places one shape at a time with the others fixed.
//! [`optimise`] then moves every vertex of every triangle and polygon, every
//! side of every rectangle, the centre, half-side vector and half-width of
//! every rotated rectangle, and every opacity under [`Alpha::Auto`], at
//! once: Adam on the gradient of the squared error between the composite
//! and the target, through a smooth model of the export's anti-aliased
//! rendering, with every colour refitted at each iteration. The step sizes
//! ramp up over the first iterations ([`Tuning::warmup`]), so that Adam's
//! first updates, a full step on every coordinate whatever the gradient,
//! do not wreck small, well-placed shapes. Its result is
//! snapped to a quarter pixel (half a pixel for axis-aligned rectangles)
//! and keeps the engine's rules: every angle of a triangle above 15°, every
//! polygon strictly convex with every angle above 15°, and every rectangle
//! with sides of at least 1 px, the long one at most 8 times the short one.
//!
//! With [`Settings::curved`], on by default, ellipses, circles and rotated
//! ellipses move too: the centre and radii of each, and a rotated
//! ellipse's semi-axis vector, which carries its angle. A circle stays a
//! circle and an axis-aligned ellipse axis-aligned, since they have no
//! parameter to become anything else; their results are snapped to a
//! quarter pixel with radii of at least 1 px, the greedy search's bound.
//! Every other layer (the quadratics, and with `curved` off the curved
//! shapes too) keeps its geometry. Its opacity and colour are optimised
//! with the others', through a coverage mask of the engine's own
//! rasterization of the shape, computed once.
//!
//! The forward model (`diff.rs`) covers each pixel of a triangle, a
//! polygon or a rotated rectangle by its exact area in the pixel square:
//! one edge's half-plane area where only that edge cuts the square, the
//! square clipped to the inside of the cutting edges near a vertex; and of
//! an axis-aligned rectangle by the product of its sides', which is its
//! exact area there; and of a curved layer by the box-filtered half-plane
//! of its boundary taken as locally straight in the pixel; it composites
//! in `f32`. A rotated rectangle is parametrised without
//! trigonometry, by its centre `c`, a half-side vector `u` and its
//! half-width `h`, its corners `c ± u ± (h / |u|) · (−u_y, u_x)` computed
//! with `sqrt` alone. Reverse-mode gradients replay the layer
//! stack from canvas checkpoints, about `√N` of them for `N` layers, capped
//! in memory as the refit pass's are. Every pass runs as one task per fixed
//! band of rows, with one fork and join, and its sums are reduced in band
//! order, so the result does not depend on the number of threads. The
//! colours are refitted together, each by a step towards its closed-form
//! fit that can only lower the loss. The rules are kept by a projection
//! after every step and by the snap (`angle.rs` for triangles, `convex.rs`
//! for polygons, `rect.rs` for rectangles, `ellipse.rs` for the curved
//! layers).
//!
//! # Arithmetic
//!
//! Native and WebAssembly builds must produce bit-identical output, and
//! their math libraries differ. Everything this module computes, the
//! projection and the snap included, may therefore use only:
//!
//! - `+ − × ÷` and `sqrt`, which IEEE 754 rounds exactly;
//! - comparisons, `abs`, `min` and `max`;
//! - `floor`, `ceil`, `round` and `trunc`;
//! - constants written as literals.
//!
//! Never `hypot`, `atan2`, `acos`, `cos`, `sin`, `tan`, `exp`, `ln`,
//! `powi` or `powf`, whose results can differ in the last bit between
//! platforms. Tests may use them. The engine does not use `mul_add`: it is
//! a software call in WebAssembly and on x86 without FMA, so the engine
//! writes the product and the sum, rounding each separately. The crate's
//! `clippy.toml` bans these methods (`disallowed-methods`) in the whole
//! engine, outside tests and benches, so the clippy gate enforces the list.
//! The masks of the fixed layers
//! are not computed here: they are the scanlines of the engine's
//! rasterizers, which the greedy search's own output already depends on,
//! and which the native–wasm tripwire test covers. A rotated rectangle's
//! starting `u` needs the sine and cosine of the greedy search's integer
//! angle: they come from a Taylor polynomial in `+ − × ÷`
//! (`crate::util::sin_cos_degrees`), the one the greedy search's corners
//! come from, not from the platform's `sin_cos`, so B's input is the same
//! on every platform even where the platforms' `sin_cos` differ in the
//! last bit; so does a rotated ellipse's starting semi-axis vector, from
//! its continuous angle, and its exported rotation, the angle of that
//! vector, comes from `crate::util::atan2_degrees`, a polynomial in `+ − × ÷`
//! too. The exported rotated ellipse is then drawn through
//! `sin_cos_degrees` as well, as the greedy search's are.

#[cfg_attr(feature = "asset-triangle", allow(dead_code))]
mod angle;
mod convex;
mod diff;
mod ellipse;
mod lattice;
mod rect;

use crate::model::CommittedShape;
use crate::shapes::Shape;
use crate::util::{atan2_degrees, sin_cos_degrees};
use crate::worker::WorkerCtx;
use crate::{Alpha, Buffer, Color, Drawing, DrawnShape, Geometry, Model, Point};
use diff::{ALPHA, COORDS, Layer, Mask, Outline, PARAMS, Real, Scene, Workspace};
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

/// The default number of Adam iterations for a drawing of `shapes`
/// layers, used when [`Settings::iterations`] is `None`: 80 up to 50
/// layers, linear to 120 at 200 and to 160 at 500, then 160, rounded
/// down.
///
/// Each count is the largest that keeps the optimisation's extra time near
/// 0.5× the greedy search's at 1 thread, measured on the default corpus
/// with triangles; quality keeps improving up to 150 iterations, so the
/// time budget decides. Integer arithmetic keeps native and wasm builds in
/// agreement.
#[must_use]
pub fn default_iterations(shapes: usize) -> u32 {
    let shapes = u32::try_from(shapes).unwrap_or(u32::MAX);
    match shapes {
        0..=50 => 80,
        51..=200 => 80 + (shapes - 50) * 40 / 150,
        201..=500 => 120 + (shapes - 200) * 40 / 300,
        _ => 160,
    }
}

/// `tan 15.5°`: the projection keeps every angle at least 15.5°, half a
/// degree inside the rule, so that the snap rarely needs a repair.
const TAN_PROJECTION: f64 = 0.277_324_544_059_838_4;

/// Twice the signed area of the triangle `v`, `x0, y0, x1, y1, x2, y2`:
/// the cross product `(v1 − v0) × (v2 − v0)`.
fn twice_signed_area_triangle(v: &[f64]) -> f64 {
    (v[2] - v[0]) * (v[5] - v[1]) - (v[3] - v[1]) * (v[4] - v[0])
}

/// Twice the signed area of the polygon through the first `n` vertices of
/// `v`, `x0, y0, x1, y1, …`, by the shoelace formula, summed in vertex
/// order.
fn twice_shoelace(v: &[f64], n: usize) -> f64 {
    (0..n)
        .map(|i| {
            let j = (i + 1) % n;
            v[2 * i] * v[2 * j + 1] - v[2 * j] * v[2 * i + 1]
        })
        .sum()
}

/// Settings of [`optimise`].
///
/// Construct with [`Settings::default`] and set the fields you need. The
/// default moves the curved shapes too ([`Settings::curved`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Adam iterations. Each costs a colour fit and a gradient (a render,
    /// its replay and the reverse pass), which share the layers' coverage.
    /// `Some(0)` only projects, snaps and refits the colours.
    ///
    /// `None`, the default, follows the number of layers: 80 up to 50,
    /// linear to 120 at 200 and to 160 at 500, then 160, rounded down. Each
    /// count is the largest that keeps the optimisation's extra time near
    /// 0.5× the greedy search's at 1 thread on the default corpus of
    /// triangles; quality keeps improving up to 150 iterations, so the time
    /// budget decides.
    pub iterations: Option<u32>,
    /// The step sizes of the Adam iterations. The default,
    /// [`Tuning::default`], is the engine's: a warm-up of 5 iterations, a
    /// first vertex step of 1 px and no step relative to the shapes' sizes.
    pub tuning: Tuning,
    /// Whether the ellipses, circles and rotated ellipses move too: with
    /// `true`, each is a layer of the forward model whose centre and radii
    /// (and a rotated ellipse's angle) are optimised with the other
    /// shapes', its boundary locally straight in each pixel, and its
    /// result stays a shape of its kind; with `false` each keeps its
    /// geometry, as quadratics always do, and only its opacity and colour
    /// are optimised, through the mask of the engine's own rasterization.
    ///
    /// `true` is the default: with B ending the ellipses' and circles'
    /// pipelines, the median RMSE falls by 4–14% for ellipses and 4–13%
    /// for circles at 50 to 500 shapes, and by about 1% for any shape.
    pub curved: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            iterations: None,
            tuning: Tuning::default(),
            curved: true,
        }
    }
}

/// The step sizes of [`optimise`]'s Adam iterations ([`Settings::tuning`]).
///
/// The default gives the engine's steps: a warm-up of 5 iterations, a
/// first vertex step of 1 px, and no step relative to the shapes' sizes.
///
/// Adam's first update is a full step of [`Tuning::step`] on every
/// coordinate whatever the gradient's size, which wrecks small, well-placed
/// shapes before the later, decayed iterations partly recover them; the
/// warm-up keeps them. Against no warm-up, a warm-up of 5 changes the mean
/// of the 100- and 200-shape medians over all images, and the mean over the
/// two paintings at 100 to 500 shapes, by −0.1% / −0.5% for any shape,
/// −0.2% / −0.7% for triangles, +0.2% / −0.4% for rectangles, −1.2% /
/// −3.0% for rotated rectangles and −0.4% / −0.9% for polygons, in the
/// same time (0.98× to 1.00×). Warm-ups of 10 and 20 gain as much on the
/// paintings but lose on triangles (+1.2% and +0.9% over all images); a
/// smaller absolute step (0.5 or 0.25 px) loses on triangles; a step
/// relative to the shape's size is neutral.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tuning {
    /// Iterations over which the step sizes ramp up: at iteration `t`
    /// (from 0) every step, the opacities' included, is scaled by
    /// `min(1, (t + 1) / (warmup + 1))` on top of its decay. The default
    /// is 5: the steps ramp from 1/6 of their size at the first iteration
    /// to their full size at the sixth (see [`Tuning`] for why and the
    /// measurements). 0 scales by the decay alone, the engine's previous
    /// steps.
    pub warmup: u32,
    /// The vertices' step size at the first iteration, in pixels, positive.
    /// The default is 1 px.
    pub step: f64,
    /// With `Some(f)`, `f` positive, each triangle's, polygon's or
    /// rectangle's vertex step is at most `f` times its size, the square
    /// root of its area at the start of the run: `min(step, f · size)`.
    /// The opacities' step is not scaled. The default, `None`, gives every
    /// shape [`Tuning::step`].
    pub relative_step: Option<f64>,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            warmup: 5,
            step: LR_VERTEX,
            relative_step: None,
        }
    }
}

/// Optimises the shapes `model` has committed jointly against its target,
/// on its background, and returns the result, or `None` once `cancelled`
/// returns true. `model` is left unchanged.
///
/// See the module documentation for the method.
/// [`Settings::iterations`] Adam iterations, by default a number that
/// grows with the number of shapes, move the triangles, polygons and
/// rectangles, rotated or not, with [`Settings::curved`] (the default) the
/// ellipses, circles and rotated ellipses, and every opacity when `alpha` is
/// [`Alpha::Auto`]; with [`Alpha::Fixed`] every opacity stays at the fixed
/// value. Every colour is refitted at each iteration. Every other shape
/// keeps its geometry exactly.
///
/// The result keeps the number, the order and the kind of the shapes. Its
/// triangle and polygon vertices are multiples of 0.25 px, and so are a
/// rotated rectangle's centre, half-side vector and half-width, from which
/// its corners are computed; an axis-aligned rectangle's corners and sides
/// are multiples of 0.5 px. Every angle of every triangle is above 15°,
/// every polygon is strictly convex with every angle above 15°, every
/// rectangle has sides of at least 1 px and its long side at most 8 times
/// its short one, and the opacities and colours are integers. A moved
/// ellipse, circle or rotated ellipse has its centre and radii on the
/// quarter-pixel lattice, and a rotated ellipse its semi-axis vector, from
/// which its larger radius and its rotation are computed; every radius is
/// at least 1 px.
///
/// `cancelled` is polled before every iteration and before the snap. The
/// result does not depend on the number of threads of the current rayon
/// pool.
#[must_use]
pub fn optimise(
    model: &Model,
    alpha: Alpha,
    settings: Settings,
    cancelled: impl FnMut() -> bool,
) -> Option<Drawing> {
    let (target, background, history) = model.joint_parts();
    optimise_shapes(target, background, history, alpha, settings, cancelled)
}

/// The difference between `drawing`, an [`optimise`] result for `model`,
/// rendered by [`optimise`]'s model, and `model`'s target: the RMSE over
/// the RGB channels divided by 255, as [`Model::score_f64`] measures the
/// engine's canvas. Its triangles, polygons and rectangles, rotated or not,
/// are taken from `drawing`, and the coverage of every other shape from
/// `model`'s. If `drawing` moved an ellipse, a circle or a rotated ellipse,
/// as [`optimise`] does with [`Settings::curved`], every one of them is
/// taken from `drawing` too and covered as [`optimise`] covers them then;
/// otherwise they are covered by the masks of the engine's rasterization,
/// as [`optimise`] covers them without it.
///
/// # Panics
///
/// If `drawing` does not have `model`'s shapes, kinds, background and size,
/// with the geometry of every other shape unchanged, a circle's radii
/// equal and an axis-aligned ellipse's rotation zero.
#[must_use]
pub fn score(model: &Model, drawing: &Drawing) -> f64 {
    let (target, background, history) = model.joint_parts();
    assert_eq!(
        (drawing.width, drawing.height, drawing.background),
        (target.width(), target.height(), background),
        "the drawing is not the model's"
    );
    score_shapes(target, background, history, drawing)
}

/// The lattice the exported vertices, and rotated rectangles' and curved
/// layers' parameters, snap to, in pixels.
const QUANTUM: f64 = 0.25;
/// The lattice the exported axis-aligned rectangles snap to, in pixels.
///
/// Their coordinates are integers in the greedy search's output, so a
/// finer lattice costs them bytes that the other kinds' coordinates
/// already pay. Measured with the engine runner (B alone, at 50 / 100 /
/// 200 rectangles, against 0.25 px): 0.5 px saves about 3.5 bytes a
/// rectangle and costs 0.3 / 0.5 / 0.8 points of greedy's median RMSE,
/// 1 px saves about 3.8 bytes and costs 0.4 / 0.7 / 1.7 points. With
/// 0.25 px the SVG is 6–7% larger than greedy's, with 0.5 px 2–3%.
const RECT_QUANTUM: f64 = 0.5;
/// Adam's step size of the vertices at the first iteration, in pixels.
const LR_VERTEX: f64 = 1.0;
/// Adam's step size of the opacities at the first iteration, in levels of
/// `0..=255`.
const LR_ALPHA: f64 = 10.0;
const BETA1: f64 = 0.9;
const BETA2: f64 = 0.999;
const EPSILON: f64 = 1e-8;
/// How far outside the canvas the vertices may go, as the engine's.
const MARGIN: f64 = crate::shapes::MARGIN as f64;

/// The forward model's scene of a drawing on `target` and `background`,
/// its layers, and the geometry of its fixed layers, in the order of their
/// masks.
struct Parts<F> {
    scene: Scene<F>,
    layers: Vec<Layer>,
    fixed: Vec<Geometry>,
}

impl Layer {
    /// The layer's geometry in drawing coordinates, where pixel centres are
    /// half-integers, from its parameters in engine coordinates, where they
    /// are integers: every position moves by `+0.5`. A rectangle becomes a
    /// [`Geometry::Rect`]; a curved layer a [`Geometry::Ellipse`] with `|a|`
    /// and `b` as its radii and, for a rotated ellipse, the angle of `a` in
    /// degrees ([`atan2_degrees`]) as its rotation; a triangle, a
    /// quadrilateral or a rotated rectangle the polygon of its corners
    /// ([`Layer::corners`]).
    ///
    /// # Panics
    ///
    /// For a fixed layer, which has no geometry of its own: its geometry is
    /// the engine shape's.
    fn to_geometry(self) -> Geometry {
        match self.outline {
            Outline::Fixed(_) => panic!("a fixed layer has no geometry of its own"),
            Outline::Rect => {
                let [x0, y0, x1, y1, ..] = self.params;
                Geometry::Rect {
                    x: x0 + 0.5,
                    y: y0 + 0.5,
                    width: x1 - x0,
                    height: y1 - y0,
                }
            }
            Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse => {
                let [cx, cy, ax, ay, b] = self.conic();
                Geometry::Ellipse {
                    cx: cx + 0.5,
                    cy: cy + 0.5,
                    rx: (ax * ax + ay * ay).sqrt(),
                    ry: b,
                    rotation: if self.outline == Outline::RotatedEllipse {
                        atan2_degrees(ay, ax)
                    } else {
                        0.0
                    },
                }
            }
            outline => {
                let corners = self.corners();
                Geometry::Polygon(
                    (0..outline.sides())
                        .map(|k| Point::new(corners[2 * k] + 0.5, corners[2 * k + 1] + 0.5))
                        .collect(),
                )
            }
        }
    }

    /// The parameters of an `outline` layer at `geometry`, the inverse of
    /// [`Self::to_geometry`]: every position moves by `−0.5`, so a
    /// rectangle's pixels `x1..=x2` span `x1 − 0.5..x2 + 0.5` and an engine
    /// shape's integer vertex or centre, a pixel centre at `x + 0.5` in its
    /// geometry, comes back as `x` exactly. A rotated ellipse's semi-axis
    /// vector `a` is its radius `rx` along its rotation
    /// ([`sin_cos_degrees`]). A rotated rectangle's polygon gives its corners,
    /// the parameters of a [`Outline::Quad`], not its centre, `u` and `h`.
    /// `None` for a geometry of another family, a polygon of another number
    /// of points, a circle whose radii differ or that is rotated, an
    /// axis-aligned ellipse that is rotated, and a fixed outline.
    fn from_geometry(outline: Outline, geometry: &Geometry) -> Option<[f64; COORDS]> {
        let mut params = [0.0; COORDS];
        match (outline, geometry) {
            (
                Outline::Rect,
                &Geometry::Rect {
                    x,
                    y,
                    width,
                    height,
                },
            ) => {
                params[..4].copy_from_slice(&[x - 0.5, y - 0.5, x + width - 0.5, y + height - 0.5]);
            }
            (
                outline @ (Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse),
                &Geometry::Ellipse {
                    cx,
                    cy,
                    rx,
                    ry,
                    rotation,
                },
            ) => {
                let centre = [cx - 0.5, cy - 0.5];
                params[..2].copy_from_slice(&centre);
                match outline {
                    Outline::Circle => {
                        if rx != ry || rotation != 0.0 {
                            return None;
                        }
                        params[2] = rx;
                    }
                    Outline::Ellipse => {
                        if rotation != 0.0 {
                            return None;
                        }
                        params[2] = rx;
                        params[3] = ry;
                    }
                    _ => {
                        let (sin, cos) = sin_cos_degrees(rotation);
                        params[2..5].copy_from_slice(&[rx * cos, rx * sin, ry]);
                    }
                }
            }
            (outline, Geometry::Polygon(points))
                if points.len() == outline.sides()
                    && outline.sides() > 0
                    && outline != Outline::Rect =>
            {
                for (k, point) in points.iter().enumerate() {
                    params[2 * k] = point.x - 0.5;
                    params[2 * k + 1] = point.y - 0.5;
                }
            }
            _ => return None,
        }
        Some(params)
    }
}

/// The [`Parts`] of the committed shapes `history` on `target` and
/// `background`: triangles, quadrilaterals and rectangles, rotated or not,
/// and with `curved` ellipses, circles and rotated ellipses, become layers
/// with their parameters in engine coordinates, every other shape a fixed
/// layer with the mask of the engine's rasterization.
fn parts<F: Real>(
    target: &Buffer,
    background: Color,
    history: &[CommittedShape],
    curved: bool,
) -> Parts<F> {
    let (width, height) = (target.width() as usize, target.height() as usize);
    let mut masks = Vec::new();
    let mut fixed = Vec::new();
    // The rasterizers take a worker; none of them draws from its stream.
    let mut worker = WorkerCtx::new(width as i32, height as i32, ChaCha8Rng::seed_from_u64(0));
    let layers = history
        .iter()
        .map(|committed| {
            let color = committed.color;
            let (alpha, rgb) = (
                f64::from(color.a),
                [color.r, color.g, color.b].map(f64::from),
            );
            let mut params = [0.0; COORDS];
            let outline = match &committed.shape {
                Shape::Triangle(_) => Outline::Triangle,
                Shape::Polygon(polygon) if polygon.order == 3 => Outline::Triangle,
                Shape::Polygon(polygon) if polygon.order == 4 => Outline::Quad,
                Shape::Rectangle(_) => Outline::Rect,
                // Keep the engine's angle-based c, u, h: its geometry is a
                // corner polygon, which cannot recover u and h bit for bit.
                Shape::RotatedRectangle(rectangle) => {
                    let (sin, cos) = sin_cos_degrees(f64::from(rectangle.angle));
                    let half = f64::from(rectangle.sx) / 2.0;
                    params[..5].copy_from_slice(&[
                        f64::from(rectangle.x) - 0.5,
                        f64::from(rectangle.y) - 0.5,
                        half * cos,
                        half * sin,
                        f64::from(rectangle.sy) / 2.0,
                    ]);
                    Outline::Rotated
                }
                Shape::Ellipse(_) if curved => Outline::Ellipse,
                Shape::Circle(_) if curved => Outline::Circle,
                Shape::RotatedEllipse(_) if curved => Outline::RotatedEllipse,
                shape => {
                    masks.push(Mask::from_lines(
                        shape.rasterize(&mut worker),
                        width,
                        height,
                    ));
                    fixed.push(shape.geometry());
                    Outline::Fixed(masks.len() - 1)
                }
            };
            if !matches!(outline, Outline::Rotated | Outline::Fixed(_)) {
                params = Layer::from_geometry(outline, &committed.shape.geometry())
                    .expect("the engine shape matches its outline");
            }
            Layer {
                outline,
                params,
                alpha,
                color: rgb,
            }
        })
        .collect();
    Parts {
        scene: Scene {
            width,
            height,
            target: target
                .pixels()
                .iter()
                .map(|&value| F::of(f64::from(value)))
                .collect(),
            background: [background.r, background.g, background.b].map(|c| F::of(f64::from(c))),
            filter: 1.0,
            masks,
        },
        layers,
        fixed,
    }
}

/// [`optimise`] on its parts.
fn optimise_shapes(
    target: &Buffer,
    background: Color,
    history: &[CommittedShape],
    alpha: Alpha,
    settings: Settings,
    mut cancelled: impl FnMut() -> bool,
) -> Option<Drawing> {
    let Parts {
        scene,
        mut layers,
        fixed,
    } = parts::<f32>(target, background, history, settings.curved);
    let auto_alpha = alpha == Alpha::Auto;
    let iterations = settings
        .iterations
        .unwrap_or_else(|| default_iterations(layers.len())) as usize;
    run(
        &scene,
        &mut layers,
        iterations,
        auto_alpha,
        settings.tuning,
        &mut cancelled,
    )?;
    if cancelled() {
        return None;
    }
    Some(export(&scene, &layers, &fixed, background))
}

/// [`score`] on its parts.
fn score_shapes(
    target: &Buffer,
    background: Color,
    history: &[CommittedShape],
    drawing: &Drawing,
) -> f64 {
    // The drawing moved a curved shape only if it came from the curved
    // outlines, whose model then covers every curved shape.
    let curved = history
        .iter()
        .zip(&drawing.shapes)
        .any(|(committed, shape)| {
            matches!(
                committed.shape,
                Shape::Ellipse(_) | Shape::Circle(_) | Shape::RotatedEllipse(_)
            ) && committed.shape.geometry() != shape.geometry
        });
    let Parts {
        scene,
        mut layers,
        fixed,
    } = parts::<f32>(target, background, history, curved);
    assert_eq!(
        drawing.shapes.len(),
        layers.len(),
        "the drawing is not the model's"
    );
    for (layer, shape) in layers.iter_mut().zip(&drawing.shapes) {
        let color = shape.color;
        layer.alpha = f64::from(color.a);
        layer.color = [color.r, color.g, color.b].map(f64::from);
        if let Outline::Fixed(index) = layer.outline {
            assert_eq!(shape.geometry, fixed[index], "a fixed shape moved");
            continue;
        }
        // A rotated rectangle's coverage is its corners' as a
        // quadrilateral's.
        if layer.outline == Outline::Rotated {
            layer.outline = Outline::Quad;
        }
        layer.params = Layer::from_geometry(layer.outline, &shape.geometry)
            .unwrap_or_else(|| panic!("not the model's shape: {:?}", shape.geometry));
    }
    let loss = diff::loss(&scene, &layers, &mut Workspace::default());
    (loss / (3 * scene.width * scene.height) as f64).sqrt() / 255.0
}

/// The step-size factor at iteration `t` of `iterations`: the smoothstep
/// `1 − (3p² − 2p³)` of the progress `p`, from 1 to 0 with zero slope at
/// both ends, the shape of a half cosine without the cosine.
fn decay(t: usize, iterations: usize) -> f64 {
    let p = t as f64 / iterations.max(1) as f64;
    1.0 - p * p * (3.0 - 2.0 * p)
}

/// The step-size factor at iteration `t` of `iterations` with a warm-up
/// of `warmup` iterations ([`Tuning::warmup`]): `min(1, (t + 1) /
/// (warmup + 1))` times [`decay`]. With no warm-up the ramp is exactly 1,
/// so the factor is the decay bit for bit.
fn step_factor(t: usize, iterations: usize, warmup: u32) -> f64 {
    let ramp = ((t + 1) as f64 / (f64::from(warmup) + 1.0)).min(1.0);
    ramp * decay(t, iterations)
}

/// The vertex step size of `layer` under `tuning`, in pixels, or `None`
/// for a fixed layer, which has no vertices to move: [`Tuning::step`],
/// capped with [`Tuning::relative_step`] `Some(f)` at `f` times the square
/// root of the layer's area. The area is a triangle's or a
/// quadrilateral's by the shoelace formula, a rotated rectangle's
/// `4 |u| h`, an axis-aligned rectangle's `(x1 − x0)(y1 − y0)`, a curved
/// layer's `π |a| b`, with `+ − × ÷`, `abs` and `sqrt` alone.
fn vertex_step(layer: &Layer, tuning: Tuning) -> Option<f64> {
    let p = &layer.params;
    let area = match layer.outline {
        Outline::Fixed(_) => return None,
        Outline::Triangle | Outline::Quad => twice_shoelace(p, layer.outline.sides()).abs() / 2.0,
        Outline::Rotated => 4.0 * (p[2] * p[2] + p[3] * p[3]).sqrt() * p[4].abs(),
        Outline::Rect => ((p[2] - p[0]) * (p[3] - p[1])).abs(),
        Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse => {
            let [_, _, ax, ay, b] = layer.conic();
            std::f64::consts::PI * (ax * ax + ay * ay).sqrt() * b.abs()
        }
    };
    Some(match tuning.relative_step {
        Some(fraction) => tuning.step.min(fraction * area.sqrt()),
        None => tuning.step,
    })
}

/// Projects `layer` onto its rule, with angles of at least 15.5°
/// ([`TAN_PROJECTION`]): a triangle by [`angle::project`], a polygon by
/// [`convex::project`], a rectangle by [`rect::project_box`] and a rotated
/// one by [`rect::project_rotated`], a curved layer by
/// [`ellipse::project`]; a fixed layer has no parameters. Returns the
/// displacement of the parameters, or `None` if the layer was already
/// inside.
fn project(layer: &mut Layer) -> Option<[f64; COORDS]> {
    let before = layer.params;
    let projected = match layer.outline {
        Outline::Triangle => {
            let mut v: [f64; 6] = std::array::from_fn(|k| layer.params[k]);
            #[cfg(not(feature = "asset-triangle"))]
            let projected = angle::project(&mut v, TAN_PROJECTION);
            #[cfg(feature = "asset-triangle")]
            let projected = if crate::asset_triangle::project(&mut v) { angle::Projected::Moved } else { angle::Projected::Unchanged };
            layer.params[..6].copy_from_slice(&v);
            projected
        }
        Outline::Quad => convex::project(&mut layer.params, TAN_PROJECTION),
        Outline::Rect => rect::project_box(&mut layer.params),
        Outline::Rotated => rect::project_rotated(&mut layer.params),
        outline @ (Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse) => {
            ellipse::project(outline, &mut layer.params)
        }
        Outline::Fixed(_) => return None,
    };
    match projected {
        angle::Projected::Unchanged => None,
        angle::Projected::Moved | angle::Projected::Rebuilt => {
            Some(std::array::from_fn(|k| layer.params[k] - before[k]))
        }
    }
}

/// Runs `iterations` Adam steps on the parameters and opacities of
/// `layers` (opacities only with `auto_alpha`, and no parameters for fixed
/// layers), each on the [`diff::gradients`] taken after one [`diff::fit`]
/// of every colour on the same geometry, so the gradient reuses the
/// fit's pixel coverage; then one more fit refits the colours of the final
/// geometry. `cancelled` is polled before every step; `None` once it
/// returns true. Positions stay within [`MARGIN`] of the canvas, and a
/// rotated rectangle's `u` and `h`, and a curved layer's radii and
/// semi-axis vector, within the canvas's longer side plus twice the
/// margin, unless a projection moves them out ([`bounds`]).
///
/// Every layer that is not fixed is projected onto its rule ([`project`])
/// before the first step and after every step, after the clamp to the
/// margin. A projected layer loses the component of its first moment
/// along the projection's displacement when that component pushes back
/// out of the set, and its second moments rise to keep every step within
/// the step size ([`redirect_momentum`]): the momentum keeps sliding along
/// the boundary but stops pressing into it.
///
/// `tuning` sets the step sizes: each layer's vertex step
/// ([`vertex_step`]), computed once after the first projection, and the
/// warm-up of every step ([`step_factor`]). A tuning with `warmup: 0` and
/// the default step reproduces the engine's previous steps (before the
/// default warm-up of 5) bit for bit: its factor is exactly `1.0` times
/// the decay and its vertex step exactly [`LR_VERTEX`], so no rounding
/// changes.
fn run<F: Real>(
    scene: &Scene<F>,
    layers: &mut [Layer],
    iterations: usize,
    auto_alpha: bool,
    tuning: Tuning,
    cancelled: &mut impl FnMut() -> bool,
) -> Option<()> {
    for layer in layers.iter_mut() {
        project(layer);
    }
    let steps: Vec<f64> = layers
        .iter()
        .map(|layer| vertex_step(layer, tuning).unwrap_or(0.0))
        .collect();
    let mut work = Workspace::default();
    let mut first = vec![[0.0; PARAMS]; layers.len()];
    let mut second = vec![[0.0; PARAMS]; layers.len()];
    let bounds = bounds(scene.width, scene.height);
    // `β^t`, as running products.
    let (mut power1, mut power2) = (1.0, 1.0);
    for t in 0..iterations {
        if cancelled() {
            return None;
        }
        diff::fit(scene, layers, &mut work);
        let gradients = diff::gradients(scene, layers, &mut work);
        let factor = step_factor(t, iterations, tuning.warmup);
        power1 *= BETA1;
        power2 *= BETA2;
        let (correction1, correction2) = (1.0 - power1, 1.0 - power2);
        for (index, layer) in layers.iter_mut().enumerate() {
            let grad = gradients[index];
            let coords = layer.outline.params();
            for k in (0..coords).chain((auto_alpha).then_some(ALPHA)) {
                let m = &mut first[index][k];
                let v = &mut second[index][k];
                *m = BETA1 * *m + (1.0 - BETA1) * grad[k];
                *v = BETA2 * *v + (1.0 - BETA2) * grad[k] * grad[k];
                let update = adam_update(*m, *v, (correction1, correction2));
                let (value, rate, (low, high)) = match k {
                    ALPHA => (&mut layer.alpha, LR_ALPHA, (1.0, 255.0)),
                    k => (&mut layer.params[k], steps[index], bounds(layer.outline, k)),
                };
                *value = (*value - rate * factor * update).clamp(low, high);
            }
            if let Some(displacement) = project(layer) {
                redirect_momentum(
                    &mut first[index],
                    &mut second[index],
                    &displacement[..coords],
                    (correction1, correction2),
                );
            }
        }
    }
    diff::fit(scene, layers, &mut work);
    Some(())
}

/// The range Adam's steps keep parameter `k` of an outline in, on a canvas
/// `width × height`: positions within [`MARGIN`] of the canvas, and a
/// rotated rectangle's `ux`, `uy` and `h`, and a curved layer's radii and
/// semi-axis vector, within the canvas's longer side plus twice the
/// margin, of either sign.
fn bounds(width: usize, height: usize) -> impl Fn(Outline, usize) -> (f64, f64) {
    let (max_x, max_y) = ((width - 1) as f64 + MARGIN, (height - 1) as f64 + MARGIN);
    let size = width.max(height) as f64 + 2.0 * MARGIN;
    move |outline, k| match (outline, k) {
        (Outline::Rotated | Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse, 2..) => {
            (-size, size)
        }
        (_, k) if k % 2 == 0 => (-MARGIN, max_x),
        _ => (-MARGIN, max_y),
    }
}

/// Adam's update of one parameter, in units of its step size: the
/// first moment `m` over the root of the second moment `v`, each divided
/// by its bias correction `1 − β^t` in `corrections`.
fn adam_update(m: f64, v: f64, corrections: (f64, f64)) -> f64 {
    (m / corrections.0) / ((v / corrections.1).sqrt() + EPSILON)
}

/// The momentum correction of [`run`] after a projection moved a layer's
/// vertex coordinates by `displacement`, on the moments `first` and
/// `second` of its parameters, with Adam's bias `corrections` at this
/// step.
///
/// If the first moment `m` of the vertices pushes back out of the set
/// (`m·d > 0`, the update being `−m`), its component along `d` is removed:
/// `m ← m − (m·d / d·d) d`. That moves first moment into every coordinate
/// the projection moved, including ones whose gradients were near zero,
/// and Adam's step on such a coordinate, `m̂ / (√v̂ + ε)`, would then be
/// about `m̂ / ε`. So each coordinate's second moment is raised, if
/// needed, to the square of its new first moment (`v̂ ≥ m̂²`), as if that
/// momentum had come from gradients of its size: its step is then at most
/// the step size.
fn redirect_momentum(
    first: &mut [f64; PARAMS],
    second: &mut [f64; PARAMS],
    displacement: &[f64],
    (correction1, correction2): (f64, f64),
) {
    let coords = displacement.len();
    let md: f64 = (0..coords).map(|k| first[k] * displacement[k]).sum();
    let dd: f64 = displacement.iter().map(|d| d * d).sum();
    if md > 0.0 && dd > 0.0 {
        for k in 0..coords {
            first[k] -= md / dd * displacement[k];
            let m = first[k] / correction1;
            second[k] = second[k].max(correction2 * m * m);
        }
    }
}

/// `layers` as a drawing on `background`: triangle and polygon vertices
/// and rotated rectangle and curved layer parameters snapped to
/// [`QUANTUM`], and rectangle parameters to [`RECT_QUANTUM`], keeping
/// their rules ([`angle::snap`], [`convex::snap`], [`rect::snap_rotated`],
/// [`rect::snap_box`], [`ellipse::snap`]), opacities rounded, colours
/// refitted once to the snapped geometry and rounded. A rectangle becomes
/// a [`Geometry::Rect`], a rotated rectangle the polygon of its corners
/// ([`Layer::corners`]), a curved layer a [`Geometry::Ellipse`]: a circle's
/// radii both `r`, an axis-aligned ellipse's `rx` and `ry`, both with no
/// rotation, and a rotated ellipse's `|a|` and `b`, rotated by the angle of
/// `a` in degrees ([`atan2_degrees`]), not rounded further. A fixed
/// layer keeps its geometry, from `fixed`.
fn export<F: Real>(
    scene: &Scene<F>,
    layers: &[Layer],
    fixed: &[Geometry],
    background: Color,
) -> Drawing {
    let mut snapped: Vec<Layer> = layers
        .iter()
        .map(|layer| {
            let mut params = layer.params;
            match layer.outline {
                Outline::Triangle => {
                    let v: [f64; 6] = std::array::from_fn(|k| params[k]);
                    params[..6].copy_from_slice(&angle::snap(&v, QUANTUM).0);
                    #[cfg(feature = "asset-triangle")]
                    {
                        let mut v = std::array::from_fn(|k| params[k]);
                        crate::asset_triangle::project(&mut v);
                        params[..6].copy_from_slice(&v);
                    }
                }
                Outline::Quad => params = convex::snap(&params, QUANTUM).0,
                Outline::Rect => params = rect::snap_box(&params, RECT_QUANTUM).0,
                Outline::Rotated => params = rect::snap_rotated(&params, QUANTUM).0,
                outline @ (Outline::Circle | Outline::Ellipse | Outline::RotatedEllipse) => {
                    params = ellipse::snap(outline, &params, QUANTUM);
                }
                Outline::Fixed(_) => {}
            }
            Layer {
                params,
                alpha: layer.alpha.round().clamp(1.0, 255.0),
                ..*layer
            }
        })
        .collect();
    diff::fit(scene, &mut snapped, &mut Workspace::default());
    Drawing {
        width: scene.width as u32,
        height: scene.height as u32,
        background,
        shapes: snapped
            .iter()
            .map(|layer| {
                let geometry = match layer.outline {
                    Outline::Fixed(index) => fixed[index].clone(),
                    _ => layer.to_geometry(),
                };
                let [r, g, b] = layer.color.map(|c| c.round().clamp(0.0, 255.0) as u8);
                DrawnShape {
                    geometry,
                    color: Color::new(r, g, b, layer.alpha as u8),
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::angle::tests::acos_valid;
    use super::*;
    use crate::{ModelOptions, ShapeKind};
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    #[test]
    fn layers_round_trip_through_their_geometry() {
        for (outline, params) in [
            (
                Outline::Triangle,
                [0.25, -1.5, 6.75, 2.0, -2.25, 8.5, 0.0, 0.0],
            ),
            (
                Outline::Quad,
                [-2.25, -1.5, 6.75, -1.5, 6.75, 8.5, -2.25, 8.5],
            ),
            (Outline::Rect, [-2.5, -1.0, 6.5, 8.0, 0.0, 0.0, 0.0, 0.0]),
            (Outline::Rotated, [6.25, -1.5, 3.0, 4.0, 2.5, 0.0, 0.0, 0.0]),
            (Outline::Circle, [6.25, -1.5, 2.75, 0.0, 0.0, 0.0, 0.0, 0.0]),
            (
                Outline::Ellipse,
                [6.25, -1.5, 2.75, 4.5, 0.0, 0.0, 0.0, 0.0],
            ),
            (
                Outline::RotatedEllipse,
                [6.25, -1.5, 2.75, -1.25, 4.5, 0.0, 0.0, 0.0],
            ),
        ] {
            let quantum = if outline == Outline::Rect {
                RECT_QUANTUM
            } else {
                QUANTUM
            };
            assert!(params.iter().all(|p| (p / quantum).fract() == 0.0));
            let layer = Layer {
                outline,
                params,
                alpha: 128.0,
                color: [128.0; 3],
            };
            let recovered = Layer::from_geometry(
                if outline == Outline::Rotated {
                    Outline::Quad
                } else {
                    outline
                },
                &layer.to_geometry(),
            )
            .expect("matching geometry");
            if outline == Outline::RotatedEllipse {
                for (actual, expected) in recovered.into_iter().zip(params) {
                    assert!((actual - expected).abs() <= 1e-12, "{actual} != {expected}");
                }
            } else {
                let expected = if outline == Outline::Rotated {
                    layer.corners()
                } else {
                    params
                };
                assert_eq!(
                    recovered.map(f64::to_bits),
                    expected.map(f64::to_bits),
                    "{outline:?}"
                );
            }
        }
    }

    #[test]
    fn from_geometry_refuses_other_families() {
        let rectangle = Geometry::Rect {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        let ellipse = |rx, ry, rotation| Geometry::Ellipse {
            cx: 1.0,
            cy: 2.0,
            rx,
            ry,
            rotation,
        };
        let quadratic = Geometry::Quadratic {
            start: Point::new(0.0, 0.0),
            control: Point::new(1.0, 2.0),
            end: Point::new(3.0, 4.0),
            width: 2.0,
            cap: crate::LineCap::Round,
        };
        for outline in [
            Outline::Triangle,
            Outline::Quad,
            Outline::Rect,
            Outline::Rotated,
            Outline::Circle,
            Outline::Ellipse,
            Outline::RotatedEllipse,
            Outline::Fixed(0),
        ] {
            assert_eq!(Layer::from_geometry(outline, &quadratic), None);
            if outline != Outline::Rect {
                assert_eq!(Layer::from_geometry(outline, &rectangle), None);
            }
            if !outline.curved() {
                assert_eq!(Layer::from_geometry(outline, &ellipse(3.0, 3.0, 0.0)), None);
            }
            for count in 0..=5 {
                let polygon = Geometry::Polygon(vec![Point::new(1.0, 2.0); count]);
                if count != outline.sides() || count == 0 || outline == Outline::Rect {
                    assert_eq!(
                        Layer::from_geometry(outline, &polygon),
                        None,
                        "{outline:?}, {count}"
                    );
                }
            }
        }
        assert_eq!(
            Layer::from_geometry(Outline::Circle, &ellipse(3.0, 4.0, 0.0)),
            None
        );
        assert_eq!(
            Layer::from_geometry(Outline::Circle, &ellipse(3.0, 3.0, 15.0)),
            None
        );
        assert_eq!(
            Layer::from_geometry(Outline::Ellipse, &ellipse(3.0, 4.0, 15.0)),
            None
        );
    }

    /// Both areas are signed by orientation, and the shoelace of a
    /// triangle is its cross product's area.
    #[test]
    fn twice_the_areas_are_signed() {
        let triangle = [1.0, 1.0, 5.0, 1.0, 1.0, 4.0];
        assert_eq!(twice_signed_area_triangle(&triangle), 12.0);
        assert_eq!(twice_shoelace(&triangle, 3), 12.0);
        let reversed = [1.0, 1.0, 1.0, 4.0, 5.0, 1.0];
        assert_eq!(twice_signed_area_triangle(&reversed), -12.0);
        assert_eq!(twice_shoelace(&reversed, 3), -12.0);
        let square = [0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0];
        assert_eq!(twice_shoelace(&square, 4), 8.0);
        let crossed = [0.0, 0.0, 2.0, 2.0, 2.0, 0.0, 0.0, 2.0];
        assert_eq!(twice_shoelace(&crossed, 4), 0.0);
    }

    /// A smooth target with a few hard edges, `width × height`.
    fn target(width: u32, height: u32) -> Buffer {
        let mut pixels = Vec::with_capacity((3 * width * height) as usize);
        for y in 0..height {
            for x in 0..width {
                let inside = (x as i32 - 20).pow(2) + (y as i32 - 14).pow(2) < 90;
                let stripe = (x + 2 * y) % 23 < 7;
                pixels.extend([
                    (x * 255 / width) as u8,
                    if inside {
                        230
                    } else {
                        (y * 200 / height) as u8
                    },
                    if stripe { 20 } else { 160 },
                ]);
            }
        }
        Buffer::from_rgb(width, height, pixels).expect("target")
    }

    fn greedy_kind(target: &Buffer, steps: usize, kind: ShapeKind, alpha: Alpha) -> Model {
        let options = ModelOptions {
            seed: Some(5),
            ..ModelOptions::default()
        };
        let mut model = Model::new(target.clone(), Color::new(90, 60, 30, 255), options);
        for _ in 0..steps {
            model.step(kind, alpha);
        }
        model
    }

    /// Pins every moving kind and the fixed masks in `Any`: eight greedy
    /// layers and four Adam iterations, otherwise default settings. Recorded
    /// before coverage caching, with identical pins on aarch64 and x86_64.
    /// Triangle (both alphas), polygon, circle and rotated ellipse again
    /// when their greedy inputs changed with the measured speed budgets:
    /// ages 75 for triangle, polygon and circle, and 500 candidates for
    /// circle and rotated ellipse. The new pins agree on aarch64 and
    /// x86_64; rectangle, rotated rectangle, ellipse and any kept theirs.
    #[test]
    fn joint_output_is_pinned() {
        let target = target(32, 28);
        let settings = Settings {
            iterations: Some(4),
            ..Settings::default()
        };
        let cases = [
            (ShapeKind::Triangle, Alpha::Auto, 0xa8bb659d54e6c88e),
            (ShapeKind::Polygon, Alpha::Auto, 0x7990cb6d65cb99f3),
            (ShapeKind::Rectangle, Alpha::Auto, 0xace7ef4d487f4e01),
            (ShapeKind::RotatedRectangle, Alpha::Auto, 0xf4eedfaad9e22c2e),
            (ShapeKind::Ellipse, Alpha::Auto, 0xf5b465a25a28cbc3),
            (ShapeKind::Circle, Alpha::Auto, 0x730692129b9235b6),
            (ShapeKind::RotatedEllipse, Alpha::Auto, 0x7cac0bd5f2510ae8),
            (ShapeKind::Any, Alpha::Auto, 0x16289607d90d817a),
            (
                ShapeKind::Triangle,
                Alpha::Fixed(std::num::NonZeroU8::new(128).unwrap()),
                0x75d1a7f24e0474ae,
            ),
        ];
        let actual: Vec<_> = cases
            .iter()
            .map(|&(kind, alpha, _)| {
                let model = greedy_kind(&target, 8, kind, alpha);
                if kind == ShapeKind::Any {
                    let (_, background, history) = model.joint_parts();
                    assert!(
                        !parts::<f32>(&target, background, history, settings.curved)
                            .fixed
                            .is_empty(),
                        "Any must exercise fixed masks"
                    );
                }
                let drawing = optimise(&model, alpha, settings, || false).expect("not cancelled");
                (kind, alpha, crate::model::digest(&drawing))
            })
            .collect();
        assert_eq!(actual, cases);
    }

    fn greedy(target: &Buffer, steps: usize, alpha: Alpha) -> Model {
        greedy_kind(target, steps, ShapeKind::Triangle, alpha)
    }

    fn vertices(drawing: &Drawing) -> Vec<[f64; 6]> {
        drawing
            .shapes
            .iter()
            .map(|shape| {
                let Geometry::Polygon(points) = &shape.geometry else {
                    panic!("not a triangle: {shape:?}");
                };
                let [a, b, c] = points.as_slice() else {
                    panic!("not a triangle: {shape:?}");
                };
                [a.x, a.y, b.x, b.y, c.x, c.y]
            })
            .collect()
    }

    fn settings(iterations: u32) -> Settings {
        Settings {
            iterations: Some(iterations),
            ..Settings::default()
        }
    }

    /// By default the iteration count follows the number of triangles: 80
    /// up to 50, linear to 120 at 200 and to 160 at 500, then 160, rounded
    /// down.
    #[test]
    fn the_default_iterations_follow_the_shape_count() {
        assert_eq!(Settings::default().iterations, None);
        for (shapes, iterations) in [
            (0, 80),
            (1, 80),
            (50, 80),
            (51, 80),
            (100, 93),
            (200, 120),
            (201, 120),
            (350, 140),
            (500, 160),
            (501, 160),
            (100_000, 160),
        ] {
            assert_eq!(default_iterations(shapes), iterations, "{shapes} shapes");
        }
    }

    /// B lowers its own model's error against the greedy drawing, keeps
    /// the triangles' number and order, and exports quarter pixels,
    /// integer colours and valid angles.
    #[test]
    fn optimising_lowers_the_model_rmse_of_the_greedy_drawing() {
        let target = target(48, 40);
        let model = greedy(&target, 20, Alpha::Auto);
        let start = model.drawing();
        let optimised =
            optimise(&model, Alpha::Auto, settings(30), || false).expect("not cancelled");
        let (before, after) = (score(&model, &start), score(&model, &optimised));
        assert!(after < 0.95 * before, "{before} -> {after}");
        assert_eq!(optimised.shapes.len(), start.shapes.len());
        assert_eq!(
            (optimised.width, optimised.height, optimised.background),
            (start.width, start.height, start.background)
        );
        for v in vertices(&optimised) {
            assert!(acos_valid(&v), "{v:?}");
            for value in v {
                assert_eq!((value * 4.0).fract(), 0.0, "{value}");
            }
        }
        // The triangles moved, and most stayed near where greedy put them:
        // the order of the layers is the greedy one.
        let near = vertices(&start)
            .iter()
            .zip(vertices(&optimised))
            .filter(|(a, b)| a.iter().zip(b).all(|(a, b)| (a - b).abs() < 8.0))
            .count();
        assert!(near >= 10, "{near} of 20 stayed near");
        assert_ne!(vertices(&start), vertices(&optimised));
    }

    #[test]
    fn a_fixed_alpha_stays_fixed() {
        let target = target(40, 32);
        let alpha = crate::test_util::fixed_alpha(128);
        let start = greedy(&target, 10, alpha);
        let optimised = optimise(&start, alpha, settings(10), || false).expect("not cancelled");
        assert!(optimised.shapes.iter().all(|shape| shape.color.a == 128));
        let auto = optimise(&start, Alpha::Auto, settings(10), || false).expect("not cancelled");
        assert!(auto.shapes.iter().any(|shape| shape.color.a != 128));
    }

    /// From valid triangles near the bound, as greedy's are, B exports
    /// none that breaks the rule, by an `acos` check. Triangles projected
    /// just above 15° need the snap's repair, and export none either.
    #[test]
    fn exported_triangles_keep_the_minimum_angle() {
        let mut rng = ChaCha8Rng::seed_from_u64(77);
        let (width, height) = (40, 32);
        let scene = diff::tests::random_scene::<f32>(&mut rng, width, height);
        let mut start = Vec::new();
        while start.len() < 24 {
            let vertices: [f64; 6] = std::array::from_fn(|_| rng.random_range(-2.0..42.0));
            let near_bound = super::angle::tests::acos_angles(&vertices)
                .is_some_and(|angles| angles.iter().any(|&angle| angle < 25.0));
            if acos_valid(&vertices) && near_bound {
                start.push(Layer::triangle(
                    vertices,
                    rng.random_range(60.0..250.0),
                    [128.0; 3],
                ));
            }
        }
        let background = Color::new(40, 120, 200, 255);
        let mut tris = start.clone();
        run(&scene, &mut tris, 40, true, Tuning::default(), &mut || {
            false
        })
        .expect("not cancelled");
        for v in vertices(&export(&scene, &tris, &[], background)) {
            assert!(acos_valid(&v), "{v:?}");
        }

        // Slivers projected onto 15° + 1e-9°: they sit on the rule's
        // boundary, so most roundings break it.
        let tan_tau = (15.0 + 1e-9_f64).to_radians().tan();
        let mut boundary = start;
        boundary.retain_mut(|tri| {
            let mut v: [f64; 6] = std::array::from_fn(|k| tri.params[k]);
            let cy = (v[1] + v[3] + v[5]) / 3.0;
            for k in 0..3 {
                v[2 * k + 1] = cy + 0.1 * (v[2 * k + 1] - cy);
            }
            let projected = angle::project(&mut v, tan_tau);
            tri.params[..6].copy_from_slice(&v);
            projected != angle::Projected::Unchanged
        });
        assert!(boundary.len() >= 12, "{} projected", boundary.len());
        let repaired = boundary
            .iter()
            .filter(|tri| angle::snap(&std::array::from_fn(|k| tri.params[k]), QUANTUM).1)
            .count();
        assert!(repaired >= 6, "{repaired} repaired");
        for v in vertices(&export(&scene, &boundary, &[], background)) {
            assert!(acos_valid(&v), "{v:?}");
        }
    }

    /// Adam's moments after `steps` steps of the constant gradient
    /// `grad`, and their bias corrections.
    fn moments(grad: &[f64; PARAMS], steps: i32) -> ([f64; PARAMS], [f64; PARAMS], (f64, f64)) {
        let (mut first, mut second) = ([0.0; PARAMS], [0.0; PARAMS]);
        for _ in 0..steps {
            for k in 0..PARAMS {
                first[k] = BETA1 * first[k] + (1.0 - BETA1) * grad[k];
                second[k] = BETA2 * second[k] + (1.0 - BETA2) * grad[k] * grad[k];
            }
        }
        (
            first,
            second,
            (1.0 - BETA1.powi(steps), 1.0 - BETA2.powi(steps)),
        )
    }

    /// A projection spreads its displacement over every vertex, so the
    /// momentum correction moves first moment into coordinates whose
    /// gradients were zero. Their second moments must follow, or Adam's
    /// next step on them is the first moment over `ε`.
    #[test]
    fn the_momentum_correction_never_steps_beyond_the_learning_rate() {
        // A sliver under the bound, flattened by a gradient on its apex's
        // `y` alone.
        let start = [0.0, 0.0, 20.0, 0.0, 10.0, 2.0];
        let mut projected = start;
        assert_eq!(
            angle::project(&mut projected, TAN_PROJECTION),
            angle::Projected::Moved
        );
        let displacement: [f64; 6] = std::array::from_fn(|k| projected[k] - start[k]);
        let (mut first, mut second, corrections) =
            moments(&[0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 10);
        assert!(
            first[5] * displacement[5] > 0.0,
            "the momentum presses into the bound"
        );
        redirect_momentum(&mut first, &mut second, &displacement, corrections);
        for k in 0..PARAMS {
            let update = adam_update(first[k], second[k], corrections);
            assert!(update.abs() <= 1.0 + 1e-12, "coordinate {k}: {update}");
        }
        // The first moment no longer presses into the bound.
        let pressing: f64 = (0..6).map(|k| first[k] * displacement[k]).sum();
        assert!(pressing <= 1e-12, "{pressing}");

        // Random slivers and moments, some coordinates without gradients:
        // no step grows beyond the larger of its own and the step size.
        let mut rng = ChaCha8Rng::seed_from_u64(3);
        let mut corrected = 0;
        for _ in 0..500 {
            let start: [f64; 6] = std::array::from_fn(|_| rng.random_range(0.0..30.0));
            let mut projected = start;
            if angle::project(&mut projected, TAN_PROJECTION) == angle::Projected::Unchanged {
                continue;
            }
            let displacement: [f64; 6] = std::array::from_fn(|k| projected[k] - start[k]);
            let grad: [f64; PARAMS] = std::array::from_fn(|_| {
                if rng.random_bool(0.3) {
                    0.0
                } else {
                    rng.random_range(-5.0..5.0)
                }
            });
            let (mut first, mut second, corrections) = moments(&grad, rng.random_range(1..150));
            let before = first;
            let steps: [f64; PARAMS] =
                std::array::from_fn(|k| adam_update(first[k], second[k], corrections));
            redirect_momentum(&mut first, &mut second, &displacement, corrections);
            if first != before {
                corrected += 1;
            }
            for k in 0..PARAMS {
                let update = adam_update(first[k], second[k], corrections).abs();
                assert!(update <= steps[k].abs().max(1.0) + 1e-12, "{k}: {update}");
            }
            let pressing: f64 = (0..6).map(|k| first[k] * displacement[k]).sum();
            let scale: f64 = (0..6).map(|k| (before[k] * displacement[k]).abs()).sum();
            assert!(pressing <= 1e-12 * scale, "{pressing}");
        }
        assert!(corrected >= 50, "{corrected} corrected");
    }

    #[test]
    fn the_result_does_not_depend_on_the_thread_count() {
        // One large triangle, which crosses every band.
        let target = target(120, 100);
        let model = greedy(&target, 6, Alpha::Auto);
        let (_, background, history) = model.joint_parts();
        let mut history = history.to_vec();
        history[0].shape = Shape::Triangle(crate::shapes::Triangle {
            x1: -10,
            y1: -10,
            x2: 130,
            y2: 5,
            x3: 40,
            y3: 110,
        });
        let run = |threads: usize| {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("pool");
            pool.install(|| {
                optimise_shapes(
                    &target,
                    background,
                    &history,
                    Alpha::Auto,
                    settings(8),
                    || false,
                )
            })
            .expect("not cancelled")
        };
        let one = run(1);
        for threads in [2, 4, 8] {
            assert_eq!(run(threads), one, "{threads} threads");
        }
    }

    /// `cancelled` is polled before every iteration and before the snap;
    /// at any of those polls, cancelling returns `None` and leaves the
    /// input untouched.
    #[test]
    fn cancellation_returns_none_and_leaves_the_input_untouched() {
        let target = target(40, 32);
        let start = greedy(&target, 8, Alpha::Auto);
        let copy = start.drawing();
        let iterations = 6;
        let mut polls = 0;
        let finished = optimise(&start, Alpha::Auto, settings(iterations), || {
            polls += 1;
            false
        });
        assert!(finished.is_some());
        assert!(polls > iterations as usize, "{polls} polls");
        for cancel_at in 1..=polls {
            let mut count = 0;
            let result = optimise(&start, Alpha::Auto, settings(iterations), || {
                count += 1;
                count >= cancel_at
            });
            assert_eq!(result, None, "cancelled at poll {cancel_at}");
            assert_eq!(start.drawing(), copy);
        }
    }

    /// The quadrilaterals of `drawing`, as `x0, y0, …, x3, y3`.
    fn quads(drawing: &Drawing) -> Vec<[f64; COORDS]> {
        drawing
            .shapes
            .iter()
            .filter_map(|shape| match &shape.geometry {
                Geometry::Polygon(points) if points.len() == 4 => Some(std::array::from_fn(|k| {
                    let point = points[k / 2];
                    if k % 2 == 0 { point.x } else { point.y }
                })),
                _ => None,
            })
            .collect()
    }

    /// The exported polygons keep the rule, checked independently (the
    /// diagonals cross, every `acos` angle above 15°) and by greedy's
    /// check, sit on the quarter-pixel lattice, and lower the model's
    /// error.
    #[test]
    fn exported_polygons_keep_the_rule() {
        let target = target(48, 40);
        let model = greedy_kind(&target, 20, ShapeKind::Polygon, Alpha::Auto);
        let optimised =
            optimise(&model, Alpha::Auto, settings(30), || false).expect("not cancelled");
        let (before, after) = (score(&model, &model.drawing()), score(&model, &optimised));
        assert!(after < 0.95 * before, "{before} -> {after}");
        let exported = quads(&optimised);
        assert_eq!(exported.len(), 20);
        assert_ne!(exported, quads(&model.drawing()));
        for v in exported {
            assert!(convex::tests::acos_valid(&v), "{v:?}");
            let polygon = crate::shapes::Polygon {
                order: 4,
                x: [v[0], v[2], v[4], v[6]],
                y: [v[1], v[3], v[5], v[7]],
            };
            assert!(polygon.is_valid(), "{v:?}");
            for value in v {
                assert_eq!((value * 4.0).fract(), 0.0, "{value}");
            }
        }

        // Random quads near the bound and near 180°, run and exported.
        let mut rng = ChaCha8Rng::seed_from_u64(78);
        let scene = diff::tests::random_scene::<f32>(&mut rng, 40, 32);
        let mut layers: Vec<Layer> = convex::tests::random_quads(9, 200)
            .into_iter()
            .filter(|v| convex::is_valid(v) && v.iter().all(|c| (-10.0..50.0).contains(c)))
            .map(|vertices| Layer {
                outline: Outline::Quad,
                params: vertices,
                alpha: 128.0,
                color: [128.0; 3],
            })
            .collect();
        assert!(layers.len() >= 10, "{}", layers.len());
        run(
            &scene,
            &mut layers,
            20,
            true,
            Tuning::default(),
            &mut || false,
        )
        .expect("not cancelled");
        for v in quads(&export(&scene, &layers, &[], Color::new(0, 0, 0, 255))) {
            assert!(convex::tests::acos_valid(&v), "{v:?}");
        }
    }

    /// The axis-aligned rectangles of `drawing`, as `x, y, width, height`.
    fn rects(drawing: &Drawing) -> Vec<[f64; 4]> {
        drawing
            .shapes
            .iter()
            .filter_map(|shape| match shape.geometry {
                Geometry::Rect {
                    x,
                    y,
                    width,
                    height,
                } => Some([x, y, width, height]),
                _ => None,
            })
            .collect()
    }

    /// Even sides place every axis-aligned edge on a pixel boundary;
    /// wrong colours must still produce geometry moves through those kinks.
    #[test]
    fn optimise_moves_even_axis_aligned_rotated_rectangles() {
        let target = target(48, 40);
        for angle in [0, 90] {
            let mut model = greedy_kind(&target, 1, ShapeKind::RotatedRectangle, Alpha::Auto);
            let mut drawing = model.drawing();
            drawing.shapes[0].geometry = Shape::RotatedRectangle(crate::shapes::RotatedRectangle {
                x: 20,
                y: 16,
                sx: 10,
                sy: 6,
                angle,
            })
            .geometry();
            drawing.shapes[0].color = Color::new(210, 20, 80, 180);
            assert_eq!(model.adopt(&drawing, true), Some(true));
            let before = model.drawing();
            let after =
                optimise(&model, Alpha::Auto, settings(30), || false).expect("not cancelled");
            assert_ne!(
                before.shapes[0].geometry, after.shapes[0].geometry,
                "angle {angle}"
            );
            assert!(
                score(&model, &after) < score(&model, &before),
                "angle {angle}"
            );
        }
    }

    /// Exported axis-aligned rectangles keep the rule, checked
    /// independently on their sides, sit on their lattice, and lower the
    /// model's error; so do rotated rectangles, checked by `acos` angles
    /// and side lengths from their corners. Rectangles on the rule's
    /// boundary, run and exported, keep it too.
    #[test]
    fn exported_rectangles_keep_the_rule() {
        let target = target(48, 40);
        let check_box = |r: [f64; 4]| {
            let [x, y, w, h] = r;
            assert!(
                w >= 1.0 && h >= 1.0 && w <= 8.0 * h && h <= 8.0 * w,
                "{r:?}"
            );
            let params = Layer::from_geometry(
                Outline::Rect,
                &Geometry::Rect {
                    x,
                    y,
                    width: w,
                    height: h,
                },
            )
            .expect("a rectangle");
            for value in [params[0], params[1], w, h] {
                assert_eq!((value / RECT_QUANTUM).fract(), 0.0, "{r:?}");
            }
        };
        let model = greedy_kind(&target, 20, ShapeKind::Rectangle, Alpha::Auto);
        let optimised =
            optimise(&model, Alpha::Auto, settings(30), || false).expect("not cancelled");
        let (before, after) = (score(&model, &model.drawing()), score(&model, &optimised));
        assert!(after < 0.95 * before, "{before} -> {after}");
        let exported = rects(&optimised);
        assert_eq!(exported.len(), 20);
        assert_ne!(exported, rects(&model.drawing()));
        exported.into_iter().for_each(check_box);

        let model = greedy_kind(&target, 20, ShapeKind::RotatedRectangle, Alpha::Auto);
        let optimised =
            optimise(&model, Alpha::Auto, settings(30), || false).expect("not cancelled");
        let (before, after) = (score(&model, &model.drawing()), score(&model, &optimised));
        assert!(after < 0.95 * before, "{before} -> {after}");
        let exported = quads(&optimised);
        assert_eq!(exported.len(), 20);
        assert_ne!(exported, quads(&model.drawing()));
        for v in exported {
            assert!(rect::tests::acos_rectangle(&v, 1e-9), "{v:?}");
        }

        // Random rectangles on the rule's boundary, run and exported.
        let mut rng = ChaCha8Rng::seed_from_u64(79);
        let scene = diff::tests::random_scene::<f32>(&mut rng, 40, 32);
        let mut layers = diff::tests::random_boxes(&mut rng, 30, 32.0);
        layers.extend(diff::tests::random_rotated(&mut rng, 30, 32.0));
        for (index, layer) in layers.iter_mut().enumerate() {
            let p = &mut layer.params;
            match (layer.outline, index % 3) {
                (Outline::Rect, 0) => p[2] = p[0] + 1.0,
                (Outline::Rect, 1) => p[3] = p[1] + 8.0 * (p[2] - p[0]),
                (Outline::Rotated, 0) => p[4] = 0.5,
                (Outline::Rotated, 1) => p[4] = 8.0 * p[2].hypot(p[3]),
                _ => {}
            }
        }
        run(
            &scene,
            &mut layers,
            20,
            true,
            Tuning::default(),
            &mut || false,
        )
        .expect("not cancelled");
        let drawing = export(&scene, &layers, &[], Color::new(0, 0, 0, 255));
        let exported = rects(&drawing);
        assert_eq!(exported.len(), 30);
        exported.into_iter().for_each(check_box);
        let exported = quads(&drawing);
        assert_eq!(exported.len(), 30);
        for v in exported {
            assert!(rect::tests::acos_rectangle(&v, 1e-9), "{v:?}");
        }
    }

    /// In a drawing of every kind with the curved outlines switched off,
    /// the triangles, polygons and rectangles, rotated or not, move and
    /// every other shape keeps its geometry exactly, while the colours and
    /// opacities of all of them are optimised.
    #[test]
    fn fixed_shapes_keep_their_geometry() {
        let target = target(64, 48);
        let model = greedy_kind(&target, 40, ShapeKind::Any, Alpha::Auto);
        let start = model.drawing();
        let off = Settings {
            curved: false,
            ..settings(20)
        };
        let optimised = optimise(&model, Alpha::Auto, off, || false).expect("not cancelled");
        assert_eq!(optimised.shapes.len(), start.shapes.len());
        let (_, _, history) = model.joint_parts();
        let (mut fixed, mut recoloured, mut moved) = (0, 0, 0);
        for ((before, after), committed) in start.shapes.iter().zip(&optimised.shapes).zip(history)
        {
            match committed.shape {
                Shape::Triangle(_)
                | Shape::Polygon(_)
                | Shape::Rectangle(_)
                | Shape::RotatedRectangle(_) => {
                    if before.geometry != after.geometry {
                        moved += 1;
                    }
                }
                _ => {
                    assert_eq!(before.geometry, after.geometry, "{committed:?}");
                    fixed += 1;
                    if before.color != after.color {
                        recoloured += 1;
                    }
                }
            }
        }
        assert!(fixed >= 8 && moved >= 10, "{fixed} fixed, {moved} moved");
        assert!(
            recoloured * 2 >= fixed,
            "{recoloured} of {fixed} recoloured"
        );
        let (before, after) = (score(&model, &start), score(&model, &optimised));
        assert!(after < before, "{before} -> {after}");
    }

    /// A fixed layer's mask is the engine's coverage: a drawing of fixed
    /// layers alone composites in the model as on the engine's canvas, up
    /// to the engine's rounding of each blend.
    #[test]
    fn fixed_layers_composite_as_the_engine_draws_them() {
        let target = target(64, 48);
        let mut model = Model::new(
            target,
            Color::new(90, 60, 30, 255),
            ModelOptions {
                seed: Some(9),
                ..ModelOptions::default()
            },
        );
        for kind in [
            ShapeKind::Ellipse,
            ShapeKind::Circle,
            ShapeKind::Quadratic,
            ShapeKind::RotatedEllipse,
        ]
        .into_iter()
        .cycle()
        .take(18)
        {
            model.step(kind, Alpha::Auto);
        }
        let (engine, joint) = (model.score_f64(), score(&model, &model.drawing()));
        assert!((engine - joint).abs() < 0.002, "{engine} vs {joint}");
    }

    /// A drawing of every kind, with a large triangle, polygon, rectangle
    /// and rotated rectangle that cross every band, gives the same result
    /// at 1, 2, 4 and 8 threads.
    #[test]
    fn a_mixed_result_does_not_depend_on_the_thread_count() {
        let target = target(120, 100);
        let model = greedy_kind(&target, 16, ShapeKind::Any, Alpha::Auto);
        let (_, background, history) = model.joint_parts();
        let mut history = history.to_vec();
        history[0].shape = Shape::Triangle(crate::shapes::Triangle {
            x1: -10,
            y1: -10,
            x2: 130,
            y2: 5,
            x3: 40,
            y3: 110,
        });
        history[1].shape = Shape::Polygon(crate::shapes::Polygon {
            order: 4,
            x: [5.0, 110.0, 100.0, 10.0],
            y: [-5.0, 10.0, 105.0, 90.0],
        });
        history[2].shape = Shape::Rectangle(crate::shapes::Rectangle {
            x1: 2,
            y1: 0,
            x2: 30,
            y2: 99,
        });
        history[3].shape = Shape::RotatedRectangle(crate::shapes::RotatedRectangle {
            x: 60,
            y: 50,
            sx: 40,
            sy: 110,
            angle: 20,
        });
        assert!(
            history
                .iter()
                .any(|c| !matches!(c.shape, Shape::Triangle(_) | Shape::Polygon(_)))
        );
        let run = |threads: usize| {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("pool");
            pool.install(|| {
                optimise_shapes(
                    &target,
                    background,
                    &history,
                    Alpha::Auto,
                    settings(8),
                    || false,
                )
            })
            .expect("not cancelled")
        };
        let one = run(1);
        for threads in [2, 4, 8] {
            assert_eq!(run(threads), one, "{threads} threads");
        }
    }

    /// Cancelling at any poll of a mixed drawing, with triangles, polygons,
    /// rectangles, rotated rectangles and fixed shapes, returns `None`.
    #[test]
    fn cancelling_a_mixed_drawing_returns_none() {
        let target = target(40, 32);
        let model = greedy_kind(&target, 12, ShapeKind::Any, Alpha::Auto);
        let copy = model.drawing();
        let (_, background, history) = model.joint_parts();
        let mut history = history.to_vec();
        history[0].shape = Shape::Rectangle(crate::shapes::Rectangle {
            x1: 3,
            y1: 4,
            x2: 20,
            y2: 12,
        });
        history[1].shape = Shape::RotatedRectangle(crate::shapes::RotatedRectangle {
            x: 20,
            y: 16,
            sx: 12,
            sy: 5,
            angle: 33,
        });
        history[2].shape = Shape::Triangle(crate::shapes::Triangle {
            x1: 2,
            y1: 30,
            x2: 38,
            y2: 25,
            x3: 15,
            y3: 3,
        });
        history[3].shape = Shape::Polygon(crate::shapes::Polygon {
            order: 4,
            x: [5.0, 30.0, 35.0, 8.0],
            y: [2.0, 4.0, 28.0, 25.0],
        });
        assert!(history.iter().any(|c| matches!(
            c.shape,
            Shape::Ellipse(_) | Shape::Circle(_) | Shape::Quadratic(_) | Shape::RotatedEllipse(_)
        )));
        let iterations = 4;
        let optimise = |cancelled: &mut dyn FnMut() -> bool| {
            optimise_shapes(
                &target,
                background,
                &history,
                Alpha::Auto,
                settings(iterations),
                cancelled,
            )
        };
        let mut polls = 0;
        assert!(
            optimise(&mut || {
                polls += 1;
                false
            })
            .is_some()
        );
        assert_eq!(polls, iterations as usize + 1);
        for cancel_at in 1..=polls {
            let mut count = 0;
            let result = optimise(&mut || {
                count += 1;
                count >= cancel_at
            });
            assert_eq!(result, None, "cancelled at poll {cancel_at}");
        }
        assert_eq!(model.drawing(), copy);
    }

    /// [`Settings`] with `iterations` and the curved outlines switched on.
    fn curved(iterations: u32) -> Settings {
        Settings {
            curved: true,
            ..settings(iterations)
        }
    }

    /// A curved layer of `outline` with the parameters `params`.
    fn curved_layer(outline: Outline, params: &[f64]) -> Layer {
        let mut p = [0.0; COORDS];
        p[..params.len()].copy_from_slice(params);
        Layer {
            outline,
            params: p,
            alpha: 128.0,
            color: [128.0; 3],
        }
    }

    /// The projection raises every radius below 1 px to 1, a rotated
    /// ellipse's semi-axis vector along its direction (the `x` axis if it
    /// is zero), and leaves valid layers alone; Adam's steps keep the
    /// centre within the margin of the canvas.
    #[test]
    fn curved_projection_raises_the_radii_and_keeps_the_centre_near_the_canvas() {
        for (outline, before, after) in [
            (Outline::Circle, vec![3.0, 4.0, 0.25], vec![3.0, 4.0, 1.0]),
            (
                Outline::Ellipse,
                vec![3.0, 4.0, 0.5, 6.0],
                vec![3.0, 4.0, 1.0, 6.0],
            ),
            (
                Outline::Ellipse,
                vec![3.0, 4.0, 6.0, -2.0],
                vec![3.0, 4.0, 6.0, 1.0],
            ),
            (
                Outline::RotatedEllipse,
                vec![3.0, 4.0, 0.3, -0.4, 0.5],
                vec![3.0, 4.0, 0.6, -0.8, 1.0],
            ),
            (
                Outline::RotatedEllipse,
                vec![3.0, 4.0, 0.0, 0.0, 7.0],
                vec![3.0, 4.0, 1.0, 0.0, 7.0],
            ),
        ] {
            let mut layer = curved_layer(outline, &before);
            let displacement = project(&mut layer).expect("projected");
            let (start, expected) = (
                curved_layer(outline, &before),
                curved_layer(outline, &after),
            );
            for (k, moved) in displacement.into_iter().enumerate() {
                assert!(
                    (layer.params[k] - expected.params[k]).abs() < 1e-15,
                    "{before:?}: {:?}",
                    layer.params
                );
                assert_eq!(moved, layer.params[k] - start.params[k]);
            }
            assert_eq!(project(&mut layer), None, "{after:?}");
        }
        for (outline, params) in [
            (Outline::Circle, vec![-40.0, 90.0, 0.5]),
            (Outline::Ellipse, vec![80.0, -30.0, 0.5, 0.5]),
            (Outline::RotatedEllipse, vec![-50.0, -50.0, 0.25, 0.25, 0.5]),
        ] {
            let mut rng = ChaCha8Rng::seed_from_u64(80);
            let scene = diff::tests::random_scene::<f32>(&mut rng, 40, 32);
            let mut layers = vec![curved_layer(outline, &params)];
            run(&scene, &mut layers, 1, true, Tuning::default(), &mut || {
                false
            })
            .expect("not cancelled");
            let p = layers[0].params;
            assert!((-MARGIN..=39.0 + MARGIN).contains(&p[0]), "{p:?}");
            assert!((-MARGIN..=31.0 + MARGIN).contains(&p[1]), "{p:?}");
            let [_, _, ax, ay, b] = layers[0].conic();
            assert!(ax.hypot(ay) >= 1.0 - 1e-12 && b >= 1.0, "{p:?}");
        }
    }

    /// The parameters of an exported ellipse: its centre in engine
    /// coordinates, its radii and its rotation in degrees.
    fn ellipse_parameters(geometry: &Geometry) -> [f64; 5] {
        let &Geometry::Ellipse {
            rx, ry, rotation, ..
        } = geometry
        else {
            panic!("not an ellipse: {geometry:?}");
        };
        let params = Layer::from_geometry(Outline::RotatedEllipse, geometry).expect("an ellipse");
        [params[0], params[1], rx, ry, rotation]
    }

    /// Checks an exported curved shape of `outline`: its centre and radii
    /// on the quarter-pixel lattice and at least 1 px, a circle's radii
    /// equal and an axis-aligned ellipse's rotation zero; a rotated
    /// ellipse's semi-axis vector, recovered with the platform's `sin` and
    /// `cos`, on the lattice, and its rotation the platform's `atan2` of
    /// that vector within `1e-6°`.
    fn check_curved(outline: Outline, geometry: &Geometry) {
        let [x, y, rx, ry, rotation] = ellipse_parameters(geometry);
        let on_lattice = |value: f64, tolerance: f64| {
            let steps = value / QUANTUM;
            (steps - steps.round()).abs() <= tolerance
        };
        for value in [x, y, ry] {
            assert!(on_lattice(value, 0.0), "{geometry:?}");
        }
        assert!(rx >= 1.0 && ry >= 1.0, "{geometry:?}");
        match outline {
            Outline::Circle => assert!(rx == ry && rotation == 0.0, "{geometry:?}"),
            Outline::Ellipse => assert!(on_lattice(rx, 0.0) && rotation == 0.0, "{geometry:?}"),
            _ => {
                let (sin, cos) = rotation.to_radians().sin_cos();
                let (ax, ay) = (rx * cos, rx * sin);
                assert!(on_lattice(ax, 1e-9) && on_lattice(ay, 1e-9), "{geometry:?}");
                let (ax, ay) = (
                    (ax / QUANTUM).round() * QUANTUM,
                    (ay / QUANTUM).round() * QUANTUM,
                );
                let expected = ay.atan2(ax).to_degrees();
                let turn = (rotation - expected).rem_euclid(360.0);
                assert!(turn.min(360.0 - turn) <= 1e-6, "{geometry:?}: {expected}");
                assert!((ax.hypot(ay) - rx).abs() <= 1e-12 * rx, "{geometry:?}");
            }
        }
    }

    /// Exported curved shapes, run from random ones and from ones at the
    /// least radius, sit on the quarter-pixel lattice with radii of at
    /// least 1 px ([`check_curved`]); a rotated ellipse's semi-axis vector
    /// that rounds shorter than 1 px is lengthened on the lattice.
    #[test]
    fn exported_curved_shapes_keep_the_rule() {
        let mut rng = ChaCha8Rng::seed_from_u64(81);
        let scene = diff::tests::random_scene::<f32>(&mut rng, 40, 32);
        let mut layers = diff::tests::random_conics(&mut rng, 20, 40.0, 1.0..12.0);
        for (index, layer) in layers.iter_mut().enumerate() {
            if index % 3 == 0 {
                let p = &mut layer.params;
                match layer.outline {
                    Outline::Circle => p[2] = 1.0,
                    Outline::Ellipse => p[3] = 1.0,
                    // `|a| = 1` at an angle that rounds shorter.
                    _ => (p[2], p[3]) = (0.6, -0.8),
                }
            }
        }
        let mut snapped = layers.clone();
        for layer in &mut snapped {
            project(layer);
        }
        let short = snapped
            .iter()
            .filter(|layer| layer.outline == Outline::RotatedEllipse)
            .filter(|layer| {
                let round = |v: f64| (v / QUANTUM).round() * QUANTUM;
                round(layer.params[2]).hypot(round(layer.params[3])) < 1.0
            })
            .count();
        assert!(
            short >= 5,
            "{short} rotated ellipses round shorter than 1 px"
        );
        let drawing = export(&scene, &snapped, &[], Color::new(0, 0, 0, 255));
        for (layer, shape) in snapped.iter().zip(&drawing.shapes) {
            check_curved(layer.outline, &shape.geometry);
        }
        run(
            &scene,
            &mut layers,
            20,
            true,
            Tuning::default(),
            &mut || false,
        )
        .expect("not cancelled");
        let drawing = export(&scene, &layers, &[], Color::new(0, 0, 0, 255));
        for (layer, shape) in layers.iter().zip(&drawing.shapes) {
            check_curved(layer.outline, &shape.geometry);
        }
    }

    /// By default B moves the greedy search's ellipses, circles and rotated
    /// ellipses, keeps each a shape of its kind ([`check_curved`]: a circle
    /// stays a circle and an axis-aligned ellipse axis-aligned), and lowers
    /// its model's error; [`score`] takes the moved shapes back. With the
    /// curved outlines switched off, the behaviour before they were the
    /// default, every shape keeps its geometry bit for bit.
    #[test]
    fn curved_shapes_move_only_with_the_switch() {
        let target = target(48, 40);
        assert!(Settings::default().curved);
        let off = Settings {
            curved: false,
            ..settings(20)
        };
        for (kind, outline) in [
            (ShapeKind::Ellipse, Outline::Ellipse),
            (ShapeKind::Circle, Outline::Circle),
            (ShapeKind::RotatedEllipse, Outline::RotatedEllipse),
        ] {
            let model = greedy_kind(&target, 12, kind, Alpha::Auto);
            let start = model.drawing();
            let moved =
                optimise(&model, Alpha::Auto, settings(20), || false).expect("not cancelled");
            assert_eq!(
                optimise(&model, Alpha::Auto, curved(20), || false).expect("not cancelled"),
                moved
            );
            assert_eq!(moved.shapes.len(), start.shapes.len());
            let changed = start
                .shapes
                .iter()
                .zip(&moved.shapes)
                .filter(|(before, after)| before.geometry != after.geometry)
                .count();
            assert!(changed >= 6, "{kind:?}: {changed} moved");
            for shape in &moved.shapes {
                check_curved(outline, &shape.geometry);
            }
            let (before, after) = (score(&model, &start), score(&model, &moved));
            assert!(before.is_finite() && after.is_finite());
            assert!(after < before, "{kind:?}: {before} -> {after}");

            let fixed = optimise(&model, Alpha::Auto, off, || false).expect("not cancelled");
            for (before, after) in start.shapes.iter().zip(&fixed.shapes) {
                assert_eq!(before.geometry, after.geometry, "{kind:?}");
            }
            assert!(score(&model, &fixed).is_finite());
        }
    }

    /// A drawing of every kind with the curved outlines switched on gives
    /// the same result at 1, 2, 4 and 8 threads, and moves its curved
    /// shapes; quadratics keep their geometry.
    #[test]
    fn a_curved_result_does_not_depend_on_the_thread_count() {
        let target = target(120, 100);
        let model = greedy_kind(&target, 16, ShapeKind::Any, Alpha::Auto);
        let (_, background, history) = model.joint_parts();
        let mut history = history.to_vec();
        history[0].shape = Shape::Ellipse(crate::shapes::Ellipse {
            x: 60,
            y: 50,
            rx: 70,
            ry: 45,
        });
        history[1].shape = Shape::RotatedEllipse(crate::shapes::RotatedEllipse {
            x: 50.5,
            y: 40.25,
            rx: 60.0,
            ry: 20.0,
            angle: 70.3,
        });
        history[2].shape = Shape::Circle(crate::shapes::Circle {
            x: 30,
            y: 70,
            r: 55,
        });
        let run = |threads: usize| {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("pool");
            pool.install(|| {
                optimise_shapes(
                    &target,
                    background,
                    &history,
                    Alpha::Auto,
                    curved(8),
                    || false,
                )
            })
            .expect("not cancelled")
        };
        let one = run(1);
        for threads in [2, 4, 8] {
            assert_eq!(run(threads), one, "{threads} threads");
        }
        let start = model.drawing();
        for (index, committed) in history.iter().enumerate() {
            let (before, after) = (&committed.shape.geometry(), &one.shapes[index].geometry);
            match committed.shape {
                Shape::Quadratic(_) => assert_eq!(before, after),
                Shape::Ellipse(_) | Shape::Circle(_) | Shape::RotatedEllipse(_) if index < 3 => {
                    assert_ne!(before, after, "layer {index}");
                }
                _ => {}
            }
        }
        assert_eq!(start.shapes.len(), one.shapes.len());
    }

    /// Without shapes, the score is the background's RMSE against the
    /// target, normalised as the engine's.
    #[test]
    fn the_score_is_the_normalised_rmse() {
        let target = target(30, 20);
        let background = Color::new(90, 60, 30, 255);
        let model = Model::new(target.clone(), background, ModelOptions::default());
        let squares: f64 = target
            .pixels()
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|pixel| {
                [background.r, background.g, background.b]
                    .into_iter()
                    .zip(pixel)
                    .map(|(b, &t)| (f64::from(b) - f64::from(t)).powi(2))
            })
            .sum();
        let expected = (squares / (3.0 * 600.0)).sqrt() / 255.0;
        assert!((score(&model, &model.drawing()) - expected).abs() < 1e-12);
    }

    /// The warm-up scales the step from `1 / (warmup + 1)` at the first
    /// iteration to 1 at iteration `warmup`, on top of the decay; the
    /// default ramps over 5 iterations, and with no warm-up the factor is
    /// the decay itself, bit for bit.
    #[test]
    fn the_warm_up_ramps_the_step_factor() {
        assert_eq!(Tuning::default().warmup, 5);
        let iterations = 80;
        for t in 0..iterations {
            assert_eq!(
                step_factor(t, iterations, 0).to_bits(),
                decay(t, iterations).to_bits(),
                "t = {t}"
            );
        }
        for t in 0..=5 {
            let expected = (t + 1) as f64 / 6.0 * decay(t, iterations);
            assert!(
                (step_factor(t, iterations, 5) - expected).abs() < 1e-15,
                "t = {t}"
            );
        }
        for t in 5..iterations {
            assert_eq!(step_factor(t, iterations, 5), decay(t, iterations));
        }
    }

    /// A relative step caps each movable layer's vertex step at a fraction
    /// of the square root of its area; fixed layers have no vertex step.
    #[test]
    fn the_relative_step_follows_each_layers_area() {
        let layer = |outline, params: &[f64]| {
            let mut p = [0.0; COORDS];
            p[..params.len()].copy_from_slice(params);
            Layer {
                outline,
                params: p,
                alpha: 128.0,
                color: [0.0; 3],
            }
        };
        let relative = |f| Tuning {
            relative_step: Some(f),
            ..Tuning::default()
        };
        // Area 16 px², size 4 px.
        let triangle = layer(Outline::Triangle, &[0.0, 0.0, 8.0, 0.0, 0.0, 4.0]);
        assert_eq!(vertex_step(&triangle, Tuning::default()), Some(1.0));
        assert_eq!(vertex_step(&triangle, relative(0.125)), Some(0.5));
        assert_eq!(vertex_step(&triangle, relative(1.0)), Some(1.0));
        let small = Tuning {
            step: 0.25,
            ..relative(1.0)
        };
        assert_eq!(vertex_step(&triangle, small), Some(0.25));
        // A 4 × 4 square, area 16.
        let quad = layer(Outline::Quad, &[1.0, 1.0, 5.0, 1.0, 5.0, 5.0, 1.0, 5.0]);
        assert_eq!(vertex_step(&quad, relative(0.125)), Some(0.5));
        // Area 4 |u| h = 4 · 2 · 2 = 16.
        let rotated = layer(Outline::Rotated, &[10.0, 10.0, 0.0, 2.0, 2.0]);
        assert_eq!(vertex_step(&rotated, relative(0.125)), Some(0.5));
        // Area 4 · 9 = 36, size 6.
        let rect = layer(Outline::Rect, &[2.0, 3.0, 6.0, 12.0]);
        assert_eq!(vertex_step(&rect, relative(0.0625)), Some(0.375));
        assert_eq!(vertex_step(&rect, Tuning::default()), Some(1.0));
        let fixed = layer(Outline::Fixed(0), &[]);
        assert_eq!(vertex_step(&fixed, relative(0.125)), None);
        assert_eq!(vertex_step(&fixed, Tuning::default()), None);
    }

    /// The default tuning, implicit or explicit (a warm-up of 5), gives
    /// the same drawing bit for bit; no warm-up, which reproduces the
    /// engine's previous steps, a longer warm-up or a relative step changes
    /// it on small shapes, here the late triangles of 60 on a 48 × 40
    /// target.
    #[test]
    fn a_non_default_tuning_changes_the_result() {
        let target = target(48, 40);
        let model = greedy(&target, 60, Alpha::Auto);
        let run = |tuning| {
            let settings = Settings {
                tuning,
                ..settings(20)
            };
            optimise(&model, Alpha::Auto, settings, || false).expect("not cancelled")
        };
        let implicit =
            optimise(&model, Alpha::Auto, settings(20), || false).expect("not cancelled");
        let explicit = run(Tuning {
            warmup: 5,
            step: 1.0,
            relative_step: None,
        });
        assert_eq!(implicit, explicit);
        let previous = run(Tuning {
            warmup: 0,
            ..Tuning::default()
        });
        assert_ne!(previous, implicit);
        let longer = run(Tuning {
            warmup: 10,
            ..Tuning::default()
        });
        assert_ne!(longer, implicit);
        let relative = run(Tuning {
            relative_step: Some(0.125),
            ..Tuning::default()
        });
        assert_ne!(relative, implicit);
    }
}
