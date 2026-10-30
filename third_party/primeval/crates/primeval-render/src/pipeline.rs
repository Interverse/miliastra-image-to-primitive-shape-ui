//! What [`crate::approximate`] runs around its greedy steps, per shape
//! kind: refit or joint passes during the search, and the final stage.
//!
//! `lab` drives the same functions, so the engine runner cannot drift from
//! [`crate::approximate`], and re-exports the types, which are public only
//! in the lab build. Every rule depends only on the request and on
//! deterministic scores, never on elapsed time or on the number of threads.

use crate::{ShapeKind, raster};
use primeval_core::{Alpha, Buffer, Drawing, Model, joint};

/// The stages around the greedy steps of one shape kind: what
/// [`crate::approximate`] runs (`pipeline`), or a variant the lab
/// measures.
#[cfg_attr(not(feature = "lab"), allow(unreachable_pub))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pipeline {
    /// The passes of the model during the search: refit passes, or joint
    /// passes.
    pub during: During,
    /// Refit passes of the model after the last step.
    pub refits: Refits,
    /// After the refit passes, the joint optimisation
    /// ([`joint::optimise`]) with this multiple of its default iteration
    /// count ([`joint::default_iterations`]), or `None` for none.
    pub joint: Option<u32>,
    /// The settings of every joint optimisation, in the search and in the
    /// final stage, whose iterations each sets: the step sizes
    /// ([`joint::Settings::tuning`]) and whether the ellipses, circles and
    /// rotated ellipses move too ([`joint::Settings::curved`]). The
    /// default in every kind's pipeline.
    pub joint_settings: joint::Settings,
}

/// When the search runs a pass over the model itself after a step, and
/// which: a refit pass ([`Model::refine`]), or a joint pass. Later steps
/// build on the revised shapes.
#[cfg_attr(not(feature = "lab"), allow(unreachable_pub))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum During {
    /// Never.
    #[cfg(any(test, feature = "lab"))]
    Never,
    /// After every step whose number (from 1) is a multiple of this.
    #[cfg(any(test, feature = "lab"))]
    Every(u32),
    /// After step `interval`, then each `max(interval, s / divisor)` steps
    /// after the previous pass, at step `s`: every `interval` steps up to
    /// `interval · divisor`, then at geometrically spaced steps. A search
    /// of `N` steps runs about `divisor · ln(N / (interval · divisor))`
    /// passes after that point, which refit about `divisor · N` layers in
    /// all, so the cost grows linearly with `N`.
    Spaced {
        /// The smallest number of steps between two passes; positive.
        interval: u32,
        /// Positive.
        divisor: u32,
    },
    /// The joint optimisation ([`joint::optimise`]) of every shape at once
    /// in place of the refit pass, on [`During::Spaced`]'s schedule, its
    /// result adopted into the model ([`Model::adopt`]) if `guard` keeps
    /// it. Later steps build on the adopted shapes.
    Joint {
        /// As [`During::Spaced`]'s.
        interval: u32,
        /// As [`During::Spaced`]'s.
        divisor: u32,
        /// The Adam iterations of every pass; positive.
        iterations: u32,
        /// What decides whether a pass's result is kept.
        guard: Guard,
    },
}

/// What keeps the result of a joint pass in the search ([`During::Joint`]).
#[cfg_attr(not(feature = "lab"), allow(unreachable_pub))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Guard {
    /// The model's exact canvas, repainted with the adopted shapes, scores
    /// strictly lower ([`Model::adopt`] without `force`), as a refit pass
    /// is checked; otherwise the model is left as it was.
    Canvas,
    /// Lab only: the model's own PNG export at the working size, after
    /// adopting the joint result, is strictly closer to the target than
    /// before (`exports_closer`): it also sees the rounding of the
    /// rectangles that adopting converts. Costs a clone of the model and
    /// two exports per pass, on top of the repaint.
    #[cfg(any(test, feature = "lab"))]
    Export,
}

impl During {
    /// Whether a pass runs after step `step` (from 1).
    pub(crate) fn due(self, step: u32) -> bool {
        match self {
            #[cfg(any(test, feature = "lab"))]
            Self::Never => false,
            #[cfg(any(test, feature = "lab"))]
            Self::Every(every) => step.is_multiple_of(every),
            Self::Spaced { interval, divisor } => spaced_due(interval, divisor, step),
            Self::Joint {
                interval, divisor, ..
            } => spaced_due(interval, divisor, step),
        }
    }
}

/// [`During::Spaced`]'s rule: whether a pass runs after step `step`.
fn spaced_due(interval: u32, divisor: u32, step: u32) -> bool {
    let mut next = u64::from(interval);
    let step = u64::from(step);
    while next < step {
        next += u64::from(interval).max(next / u64::from(divisor));
    }
    next == step
}

/// What `after_step` ran.
#[cfg_attr(not(feature = "lab"), allow(unreachable_pub))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    /// No pass was due.
    Skipped,
    /// A refit pass.
    Refit,
    /// A joint pass, and whether its result was kept.
    Joint {
        /// Whether the model adopted the joint result.
        kept: bool,
    },
}

impl Pass {
    /// Whether a pass ran.
    #[cfg(any(test, feature = "lab"))]
    #[must_use]
    pub fn ran(self) -> bool {
        self != Self::Skipped
    }
}

/// The refit passes of the final stage.
#[cfg_attr(not(feature = "lab"), allow(unreachable_pub))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refits {
    /// This many passes.
    Passes(u32),
    /// Passes until one lowers the model's score ([`Model::score_f64`]) by
    /// less than `min_gain` ten-thousandths of its score before the pass,
    /// at most `cap` passes, stopping before a pass if the score is zero.
    /// A pass that is not kept lowers it by nothing.
    Until {
        /// In ten-thousandths: 50 is 0.5%.
        min_gain: u32,
        /// The most passes.
        cap: u32,
    },
}

/// [`crate::approximate`]'s pipeline for `shape`, chosen with the engine
/// runner on its default corpus by the median RMSE of the export at 100
/// and 200 shapes. Each stage was first extended while the last extension
/// lowered the mean of the two medians by at least 0.5% without raising
/// the mean of the per-image changes; otherwise the cheaper configuration
/// stayed, by a deterministic count of evaluations. The passes during the
/// search of `any`, triangles and ellipses were then thinned to trade
/// some of that quality for time, on the measurements of
/// `docs/algorithm-leap-review-2026-10-07.md`: the mean of the two
/// medians against the previous `approximate` (16 search rounds, then one
/// refit pass) and the time over the same rows, on an Apple M2 Pro.
///
/// - Every kind but triangles runs refit passes during the search, on a
///   [`During::Spaced`] schedule whose cost grows linearly with the shape
///   count. Before any other change they lowered the median RMSE by 0.4%
///   (quadratics) to 7% (`any`, ellipses and rotated ellipses). As first
///   chosen they were 45–70% of the pipeline's time for `any`, triangles,
///   rectangles, ellipses and circles, and the only stage that lost at
///   equal time to the greedy search with more shapes, while the joint
///   optimisation, at 10–15% of the time for most kinds that run it, is
///   the most efficient stage.
/// - Triangles, polygons, rectangles, rotated rectangles, ellipses and
///   circles end with the joint optimisation of every shape, with its
///   default iterations; for the first four
///   kinds, refit passes before it, or more iterations for the other
///   three, gained less than 0.5%. Rotated rectangles refit after steps
///   20 and 40, then each half the step number. Earlier measurements kept
///   twice the final iterations, 2.2% below no in-search passes and the
///   default iterations; doubling alone gained 0.4%. The October 2026
///   budget measurements returned them to the default iterations for
///   speed at an invisible quality cost: 0.77–0.82 times the time at 10
///   threads, +0.39% in the mean of the 100/200-shape median RMSEs, and
///   at worst 0.47 of a level. Passes every 20 steps up to step 100 cost
///   more and gained less.
/// - Rectangles and polygons refit every 20 steps up to step 100, then
///   each fifth of the step number (`Spaced(20, 5)`). On triangles, with
///   the joint optimisation, that schedule was 12.9% below the previous
///   `approximate` at 2.06 times its time, against 14.8% at 3.22 times
///   with passes every 5 steps up to step 50, then each tenth
///   (`Spaced(5, 10)`), and 10.6% at 1.11 times with no passes: it keeps
///   55% of the passes' gain for 45% of their cost.
/// - Triangles, on the same schedule, run the joint optimisation of every
///   shape with 20 iterations in place of the refit pass, its result kept
///   when the exact canvas scores lower ([`During::Joint`],
///   [`Guard::Canvas`]): 1.3% below the refit passes at 0.70 times the
///   pipeline's time, where no passes during the search are 2.6% above at
///   0.55 times. Both paintings improve at 50, 100 and 200 shapes
///   (American Gothic by 1.4–2.4%, Mona Lisa by 1.0–1.6%), while
///   synthetic-shapes, on whose hard edges the guard rejects most joint
///   results, is 6.1% worse at 200. With 40 iterations, or with
///   `Spaced(10, 10)`, the gain is about the same at 0.87–0.90 times.
///   The other kinds keep the refit passes: polygons because on
///   synthetic-shapes the joint result is rejected and they lose 33–41%
///   at 100–500 shapes, about as with no passes; rectangles and rotated
///   rectangles because rounding the joint result to their integer
///   parameters gives back most of its gain; `any` because the joint
///   optimisation does not move its quadratics, while the refit passes
///   serve every layer.
/// - [`ShapeKind::Any`] refits on the rectangles' schedule and ends with
///   one refit pass, then the joint optimisation of every shape but the
///   quadratics, which keep their geometry: with its triangles, polygons
///   and rectangles moving, 3.2% below the refit pass alone; moving its
///   ellipses, circles and rotated ellipses too lowered the median RMSE
///   by a further 0.7–1.1% (the paintings by 1.8–5.7%) at 1.03–1.06
///   times the time. With 16 search rounds the whole pipeline
///   is 6.9% below the previous `approximate` at 1.57 times its time;
///   with 32 rounds and `Spaced(5, 10)` it was 10.8% below at 2.78 times.
///   At equal time and 200 shapes it is now neutral against the previous
///   greedy search with more shapes (a ratio of 1.01), where it was 18%
///   worse.
/// - The joint optimisation's result is kept only if its export is closer
///   to the target than its input ([`better_export`]): on finely fitted
///   polygons it could double the export's error while its own objective
///   reported a gain.
/// - Quadratics end with refit passes until one gains less than 1%, at
///   most four; with 16 search rounds instead of 32 that lowers the
///   median RMSE by 1.8–10.5% at 50–500 shapes against one pass after the
///   greedy search alone, at about 1.4–1.6 times its evaluations.
/// - Ellipses and circles refit every 20 steps up to step 100, then each
///   fifth of the step number (`Spaced(20, 5)`), and end with the joint
///   optimisation, its curved outlines moving them, and no refit pass.
///   Against their previous pipeline, `Spaced(10, 10)` and one final
///   refit pass, the median RMSE falls by 3.9 / 6.0 / 8.4 / 14.4% for
///   ellipses and 11.3 / 4.0 / 8.5 / 13.1% for circles at 50 / 100 / 200
///   / 500 shapes, with every painting row better (American Gothic by
///   11.7% and 20.4% with ellipses at 200 and 500), synthetic-shapes by
///   37–55% and the texture within +1.9 / −3.0%. `Spaced(10, 10)` with
///   the joint optimisation gained 1–2 points more at 1.13–1.22 times the
///   time; the joint optimisation alone, with no passes during the
///   search, 1–3 points less at 0.57–0.66 times; `Spaced(20, 5)` is the
///   middle, at about the previous time.
/// - Rotated ellipses refit every 10 steps up to step 100, then each
///   tenth of the step number, and end with one refit pass, the pipeline
///   ellipses and circles had before: on ellipses, 5.1% below the
///   previous `approximate` at 2.15 times its time, against 7.2% at 3.11
///   times with `Spaced(5, 20)` and 3.3% at 1.60 times with
///   `Spaced(20, 5)` (without the joint optimisation); after the passes
///   during the search, passes until one gained less than 1%, 0.5% or
///   0.2% gained less than 0.5%. The joint optimisation gains them only
///   2–3%, and its guard rejects it on most images, on their thin
///   ellipses, so it is not yet theirs.
///
/// Against the first selection, with the model's search effort retuned
/// alongside, this gives back 2–4 points on `any`, triangles, ellipses
/// and rotated ellipses, and cuts their time from 2.8–3.2 to 1.6–2.2
/// times the previous `approximate`'s.
pub(crate) fn pipeline(shape: ShapeKind) -> Pipeline {
    let spaced = |interval, divisor| During::Spaced { interval, divisor };
    let joint = |interval, divisor, iterations| During::Joint {
        interval,
        divisor,
        iterations,
        guard: Guard::Canvas,
    };
    let (none, one) = (Refits::Passes(0), Refits::Passes(1));
    let (during, refits, joint) = match shape {
        ShapeKind::Any => (spaced(20, 5), one, Some(1)),
        ShapeKind::Triangle => (joint(20, 5, 20), none, Some(1)),
        ShapeKind::Rectangle | ShapeKind::Polygon => (spaced(20, 5), none, Some(1)),
        ShapeKind::RotatedRectangle => (spaced(20, 2), none, Some(1)),
        ShapeKind::Ellipse | ShapeKind::Circle => (spaced(20, 5), none, Some(1)),
        ShapeKind::RotatedEllipse => (spaced(10, 10), one, None),
        ShapeKind::Quadratic => (
            spaced(20, 5),
            Refits::Until {
                min_gain: 100,
                cap: 4,
            },
            None,
        ),
        // `ShapeKind` is non-exhaustive: a kind added later gets the
        // refit passes, which cover every kind.
        _ => (spaced(10, 10), one, None),
    };
    Pipeline {
        during,
        refits,
        joint,
        joint_settings: joint::Settings::default(),
    }
}

/// Runs the pass that `during` schedules after step `step` (from 1), if
/// any, a joint pass with `settings` and its own iterations, and returns
/// what ran. Returns `None` once `cancelled` returns true, with the model
/// as it was before the pass.
pub(crate) fn after_step(
    model: &mut Model,
    during: During,
    settings: joint::Settings,
    step: u32,
    alpha: Alpha,
    mut cancelled: impl FnMut() -> bool,
) -> Option<Pass> {
    if !during.due(step) {
        return Some(Pass::Skipped);
    }
    if let During::Joint {
        iterations, guard, ..
    } = during
    {
        let kept = joint_pass(model, iterations, settings, guard, alpha, cancelled)?;
        return Some(Pass::Joint { kept });
    }
    model.refine_unless(alpha, &mut cancelled)?;
    Some(Pass::Refit)
}

/// A joint pass of `iterations` iterations with `settings` on `model`, its
/// result adopted if `guard` keeps it; returns whether it was kept. With
/// [`Guard::Canvas`] the model's exact canvas decides ([`Model::adopt`]
/// without `force`); with the lab's `Guard::Export` the result is adopted
/// by force into the model, whose own export after adopting must then be
/// strictly closer to the target than its export before
/// ([`exports_closer`]), or a clone taken before restores it. A result the model cannot adopt
/// ([`Model::adopt`] returns `None`) is not kept, and a pass not kept
/// leaves the model as it was. `cancelled` is polled as [`joint::optimise`]
/// polls it, then once more before the guard; once it returns true,
/// `None`, with the model unchanged.
fn joint_pass(
    model: &mut Model,
    iterations: u32,
    mut settings: joint::Settings,
    guard: Guard,
    alpha: Alpha,
    mut cancelled: impl FnMut() -> bool,
) -> Option<bool> {
    settings.iterations = Some(iterations);
    let optimised = joint::optimise(model, alpha, settings, &mut cancelled)?;
    if cancelled() {
        return None;
    }
    let kept = match guard {
        Guard::Canvas => model.adopt(&optimised, false) == Some(true),
        #[cfg(any(test, feature = "lab"))]
        Guard::Export => {
            let before = model.drawing();
            let backup = model.clone();
            let closer = model.adopt(&optimised, true) == Some(true)
                && exports_closer(backup.target(), &before, &model.drawing());
            if !closer {
                *model = backup;
            }
            closer
        }
    };
    Some(kept)
}

/// Which drawing `final_stage` returned.
#[cfg_attr(not(feature = "lab"), allow(unreachable_pub))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chosen {
    /// The refitted model's: the pipeline has no joint optimisation.
    Refitted,
    /// The joint optimisation's result, which exports closer to the target
    /// than its input.
    Joint,
    /// The refitted model's, the joint optimisation's input: its result
    /// exports no closer to the target (`better_export`).
    Input,
}

/// The final stage of `pipeline` on `model`, after its last step: the
/// refit passes, which change `model`, then the joint optimisation, which
/// does not, with `iterations`, if set, in place of its scaled default.
/// The joint result is kept only if it exports closer to the target than
/// the refitted model's drawing ([`better_export`]). Returns the drawing to
/// encode and which it is, or `None` once `cancelled` returns true.
pub(crate) fn final_stage(
    model: &mut Model,
    pipeline: Pipeline,
    alpha: Alpha,
    iterations: Option<u32>,
    mut cancelled: impl FnMut() -> bool,
) -> Option<(Drawing, Chosen)> {
    match pipeline.refits {
        Refits::Passes(passes) => {
            for _ in 0..passes {
                model.refine_unless(alpha, &mut cancelled)?;
            }
        }
        Refits::Until { min_gain, cap } => {
            for _ in 0..cap {
                let before = model.score_f64();
                if before == 0.0 {
                    break;
                }
                model.refine_unless(alpha, &mut cancelled)?;
                let gain = before - model.score_f64();
                if gain * 10_000.0 < before * f64::from(min_gain) {
                    break;
                }
            }
        }
    }
    let Some(scale) = pipeline.joint else {
        return Some((model.drawing(), Chosen::Refitted));
    };
    let mut settings = pipeline.joint_settings;
    settings.iterations = Some(iterations.unwrap_or_else(|| {
        joint::default_iterations(model.drawing().shapes.len()).saturating_mul(scale)
    }));
    let optimised = joint::optimise(model, alpha, settings, cancelled)?;
    Some(better_export(model.target(), model.drawing(), optimised))
}

/// `joint` if its PNG export at the working size is strictly closer to
/// `target` than `input`'s ([`raster::squared_error`]), otherwise `input`:
/// a tie, or a drawing that cannot be rendered, keeps `input`. Returns the
/// drawing and which it is.
///
/// The joint optimisation lowers its own objective, a smooth model of the
/// anti-aliased export whose coverage is each shape's exact area in every
/// pixel, but that model can still disagree with the export: the snap to
/// its lattice moves every vertex after the last iteration, and it
/// composites in `f32` where the export renders the drawing itself. On
/// finely fitted stacks the export can then be much worse than the joint
/// optimisation's input while its objective reports a gain, so the guard
/// measures the export itself.
///
/// The comparison is exact integer arithmetic over the PNG writer's
/// raster, in one thread, so it does not depend on the number of threads.
/// That raster (tiny-skia's high-precision pipeline) computes in `f32`
/// with `+ − × ÷` and `sqrt`, converts to fixed point with `as`, and
/// rounds to nearest even, alike on NEON, SSE2 and WebAssembly's scalar
/// path, so native and WebAssembly builds agree. The raster calls no platform
/// transcendental function: an ellipse's rotation takes its sine and cosine
/// from [`primeval_core::sin_cos_degrees`].
fn better_export(target: &Buffer, input: Drawing, joint: Drawing) -> (Drawing, Chosen) {
    if exports_closer(target, &input, &joint) {
        (joint, Chosen::Joint)
    } else {
        (input, Chosen::Input)
    }
}

/// Whether `candidate`'s PNG export at the working size is strictly closer
/// to `target` than `input`'s ([`raster::squared_error`]): [`better_export`]'s
/// rule. A drawing that cannot be rendered is as far as can be, so a tie,
/// or a `candidate` that cannot be rendered, is not closer.
fn exports_closer(target: &Buffer, input: &Drawing, candidate: &Drawing) -> bool {
    let error = |drawing: &Drawing| raster::squared_error(drawing, target).unwrap_or(u64::MAX);
    error(candidate) < error(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "lab")]
    use primeval_core::LineCap;
    use primeval_core::{Color, ModelOptions};

    /// A 48 × 40 model of `shape` after `steps` greedy steps.
    fn model(shape: ShapeKind, steps: u32) -> Model {
        sized_model(shape, steps, 48, 40)
    }

    /// A `width` × `height` model of `shape` after `steps` greedy steps.
    fn sized_model(shape: ShapeKind, steps: u32, width: u32, height: u32) -> Model {
        let pixels = (0..width * height)
            .flat_map(|i| {
                let (x, y) = (i % width, i / width);
                let ring = (x as i32 - 20).pow(2) + (y as i32 - 18).pow(2) < 150;
                [
                    (x * 5) as u8,
                    if ring { 230 } else { (y * 6) as u8 },
                    ((x + 2 * y) % 30 * 8) as u8,
                ]
            })
            .collect();
        let target = Buffer::from_rgb(width, height, pixels).expect("target");
        let mut options = ModelOptions::default();
        options.seed = Some(5);
        let mut model = Model::new(target, Color::new(128, 128, 128, 255), options);
        for _ in 0..steps {
            model.step(shape, Alpha::Auto);
        }
        model
    }

    /// The pixels of a `side` × `side` point-sampled version of the engine
    /// runner's `synthetic-shapes` image: flat shapes with hard edges.
    fn hard_shapes(side: u32) -> Vec<u8> {
        (0..side * side)
            .flat_map(|i| {
                let (u, v) = (
                    f64::from(i % side) / f64::from(side),
                    f64::from(i / side) / f64::from(side),
                );
                if (u - 0.3).powi(2) + (v - 0.3).powi(2) < 0.04 {
                    [200, 30, 40]
                } else if (0.55..0.9).contains(&u) && (0.15..0.45).contains(&v) {
                    [30, 90, 200]
                } else if v > 0.55 && v < 0.95 && (u - 0.5).abs() < (v - 0.55) {
                    [240, 200, 30]
                } else if (0.05..0.25).contains(&u) && v > 0.6 {
                    [20, 20, 20]
                } else {
                    [235, 235, 225]
                }
            })
            .collect()
    }

    /// A 24 × 24 model of [`hard_shapes`] after `steps` greedy steps of
    /// `shape` with `seed`, and a refit pass after every fifth.
    fn hard_shapes_model(shape: ShapeKind, seed: u64, steps: u32) -> Model {
        let target = Buffer::from_rgb(24, 24, hard_shapes(24)).expect("target");
        let mut options = ModelOptions::default();
        options.seed = Some(seed);
        let mut model = Model::new(target, Color::new(128, 128, 128, 255), options);
        for step in 1..=steps {
            model.step(shape, Alpha::Auto);
            after_step(
                &mut model,
                During::Every(5),
                curves_fixed(),
                step,
                Alpha::Auto,
                || false,
            )
            .expect("not cancelled");
        }
        model
    }

    /// The sum of the squared differences between `drawing`, rendered by
    /// the PNG writer at its own size, and `target`.
    fn png_error(drawing: &Drawing, target: &[u8]) -> u64 {
        crate::raster::render_rgb(drawing, drawing.width, drawing.height)
            .expect("raster")
            .iter()
            .zip(target)
            .map(|(&a, &b)| u64::from(a.abs_diff(b)).pow(2))
            .sum()
    }

    /// The joint optimisation's own result for `model`, at `scale` times
    /// its default iterations, as the final stage runs it.
    fn joint_result(model: &Model, scale: u32) -> Drawing {
        let mut settings = joint::Settings::default();
        settings.iterations = Some(joint::default_iterations(model.drawing().shapes.len()) * scale);
        joint::optimise(model, Alpha::Auto, settings, || false).expect("not cancelled")
    }

    /// Every shape kind, `any` included.
    const KINDS: [ShapeKind; 9] = [
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

    fn stages(refits: Refits, joint: Option<u32>) -> Pipeline {
        Pipeline {
            during: During::Never,
            refits,
            joint,
            joint_settings: joint::Settings::default(),
        }
    }

    /// The default joint settings with `tuning` and the curved shapes kept
    /// fixed.
    fn curves_fixed_with(tuning: joint::Tuning) -> joint::Settings {
        let mut settings = joint::Settings::default();
        settings.tuning = tuning;
        settings.curved = false;
        settings
    }

    /// The default joint settings with the curved shapes kept fixed.
    fn curves_fixed() -> joint::Settings {
        curves_fixed_with(joint::Tuning::default())
    }

    fn due_steps(during: During, last: u32) -> Vec<u32> {
        (1..=last).filter(|&step| during.due(step)).collect()
    }

    #[test]
    fn every_runs_a_pass_after_each_multiple_of_its_interval() {
        assert_eq!(due_steps(During::Every(20), 70), [20, 40, 60]);
        assert_eq!(due_steps(During::Never, 70), [] as [u32; 0]);
    }

    /// Every 10 steps up to 50, then each step / 5 steps after the
    /// previous pass, rounded down.
    #[test]
    fn spaced_passes_follow_the_interval_then_spread_out() {
        let spaced = During::Spaced {
            interval: 10,
            divisor: 5,
        };
        assert_eq!(
            due_steps(spaced, 220),
            [10, 20, 30, 40, 50, 60, 72, 86, 103, 123, 147, 176, 211]
        );
    }

    /// The passes of a spaced schedule refit about `divisor` layers per
    /// step, at most `(divisor + 1) · N + interval · divisor · (divisor +
    /// 1) / 2` in all up to step `N`, so their cost grows linearly with
    /// the shape count; every 10 steps would refit `N² / 20`.
    #[test]
    fn spaced_passes_refit_linearly_many_layers() {
        for (interval, divisor) in [(10, 5), (10, 10), (5, 20), (20, 2), (20, 5)] {
            let spaced = During::Spaced { interval, divisor };
            for last in [500, 2000, 100_000] {
                let layers: u64 = due_steps(spaced, last).iter().map(|&s| u64::from(s)).sum();
                let bound = u64::from(divisor + 1) * u64::from(last)
                    + u64::from(interval * divisor * (divisor + 1) / 2);
                assert!(layers <= bound, "{interval}:{divisor} to {last}: {layers}");
            }
        }
    }

    /// The passes during the search are the pipeline's most expensive
    /// stage and the only one that loses at equal time
    /// (`docs/algorithm-leap-review-2026-10-07.md`): up to 200 steps they
    /// refit, or jointly optimise, at most 5 layers per step for the kinds
    /// that end with the joint optimisation, which gains more for less,
    /// and at most 10 for the others.
    #[test]
    fn passes_during_the_search_stay_cheap() {
        for shape in KINDS {
            let stages = pipeline(shape);
            let layers: u32 = due_steps(stages.during, 200).iter().sum();
            let most = if stages.joint.is_some() { 5 } else { 10 };
            assert!(layers <= most * 200, "{shape:?}: {layers} layers");
        }
    }

    /// Every kind's path through the pipeline, its greedy steps at its
    /// search effort, a refit pass in the search and its final stage, gives
    /// the same drawing at 1, 2, 4 and 8 threads. The schedule's steps
    /// depend only on the step number (above), and the lab identity test
    /// runs the whole of `approximate`'s path.
    #[test]
    fn every_kind_path_is_identical_across_thread_counts() {
        for shape in KINDS {
            let stages = pipeline(shape);
            let on_threads = |threads| {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()
                    .expect("test thread pool");
                pool.install(|| {
                    let mut model = sized_model(shape, 3, 24, 18);
                    after_step(
                        &mut model,
                        During::Every(3),
                        curves_fixed(),
                        3,
                        Alpha::Auto,
                        || false,
                    )
                    .expect("not cancelled");
                    final_stage(&mut model, stages, Alpha::Auto, None, || false)
                        .expect("not cancelled")
                })
            };
            let reference = on_threads(1);
            for threads in [2, 4, 8] {
                assert!(
                    on_threads(threads) == reference,
                    "{shape:?}: {threads} threads changed the drawing"
                );
            }
        }
    }

    /// On a finely fitted stack of polygons, aggressive joint steps
    /// (`warmup: 0`, `step: 2`) export worse than the input after the
    /// refit passes, so the final stage returns that input. The 2 px step
    /// keeps exercising this guard after the portable sampler changed the
    /// seeded stack; the default pipeline still uses its gentler tuning.
    /// The guard needs only a worse export: with polygons' age 75 the
    /// error grows 1.8 times, where it had more than doubled before.
    #[test]
    fn the_final_stage_keeps_its_input_when_the_joint_result_exports_worse() {
        let target = hard_shapes(24);
        let model = hard_shapes_model(ShapeKind::Polygon, 2, 25);
        let input = model.drawing();
        let tuning = joint::Tuning {
            warmup: 0,
            step: 2.0,
            ..joint::Tuning::default()
        };
        let joint = tuned_joint_result(&model, tuning);
        assert!(
            png_error(&joint, &target) > png_error(&input, &target),
            "the joint optimisation no longer worsens this case: {} -> {}",
            png_error(&input, &target),
            png_error(&joint, &target)
        );
        let mut pipeline = stages(Refits::Passes(0), Some(1));
        pipeline.joint_settings.tuning = tuning;
        let kept = final_stage(&mut model.clone(), pipeline, Alpha::Auto, None, || false);
        assert_eq!(kept, Some((input, Chosen::Input)));
    }

    /// Where the joint result exports closer to the target, the final
    /// stage returns it.
    #[test]
    fn the_final_stage_keeps_the_joint_result_when_it_exports_better() {
        let target = hard_shapes(24);
        let model = hard_shapes_model(ShapeKind::Triangle, 2, 20);
        let input = model.drawing();
        let joint = joint_result(&model, 1);
        assert!(
            png_error(&joint, &target) < png_error(&input, &target),
            "the joint optimisation no longer improves this case"
        );
        let kept = final_stage(
            &mut model.clone(),
            stages(Refits::Passes(0), Some(1)),
            Alpha::Auto,
            None,
            || false,
        );
        assert_eq!(kept, Some((joint, Chosen::Joint)));
    }

    /// Two drawings that export to the same pixels tie, and a tie keeps
    /// the input; the joint result must be strictly closer.
    #[test]
    fn a_tie_keeps_the_input() {
        let target = Buffer::from_rgb(4, 4, vec![90; 48]).expect("target");
        let drawing = |x| Drawing {
            width: 4,
            height: 4,
            background: Color::new(90, 90, 90, 255),
            shapes: vec![primeval_core::DrawnShape {
                geometry: primeval_core::Geometry::Rect {
                    x,
                    y: 0.0,
                    width: 2.0,
                    height: 2.0,
                },
                color: Color::new(255, 0, 0, 0),
            }],
        };
        let (input, joint) = (drawing(0.0), drawing(2.0));
        assert_eq!(
            better_export(&target, input.clone(), joint.clone()),
            (input.clone(), Chosen::Input)
        );
        assert_eq!(
            better_export(&target, joint.clone(), input),
            (joint, Chosen::Input)
        );
    }

    #[test]
    fn refits_until_run_no_passes_at_zero_score() {
        let color = Color::new(23, 45, 67, 255);
        let target = Buffer::from_rgb(8, 8, [23, 45, 67].repeat(64)).expect("target");
        let mut options = ModelOptions::default();
        options.seed = Some(3);
        let mut model = Model::new(target, color, options);
        model.step(ShapeKind::Ellipse, Alpha::Auto);
        assert_eq!(model.score_f64(), 0.0);
        for min_gain in [0, 100] {
            let mut polls = 0;
            let result = final_stage(
                &mut model,
                stages(Refits::Until { min_gain, cap: 20 }, None),
                Alpha::Auto,
                None,
                || {
                    polls += 1;
                    false
                },
            );
            assert!(result.is_some());
            assert_eq!(polls, 0, "no refit pass should run at zero score");
        }
    }

    /// `Until` runs passes until the first whose relative gain in the
    /// model's score is below the threshold, that pass included, or the
    /// cap: the same drawing as that many plain passes.
    #[test]
    fn refits_until_stop_at_the_first_pass_below_the_gain() {
        let greedy = model(ShapeKind::Ellipse, 12);
        let mut plain = greedy.clone();
        let mut scores = vec![plain.score_f64()];
        for _ in 0..6 {
            plain.refine(Alpha::Auto);
            scores.push(plain.score_f64());
        }
        let mut counts = Vec::new();
        for min_gain in [0, 20, 50, 100, 400, 10_000] {
            let expected = (1..=6)
                .find(|&p| {
                    (scores[p - 1] - scores[p]) * 10_000.0 < scores[p - 1] * f64::from(min_gain)
                })
                .unwrap_or(6);
            counts.push(expected);
            let until = final_stage(
                &mut greedy.clone(),
                stages(Refits::Until { min_gain, cap: 6 }, None),
                Alpha::Auto,
                None,
                || false,
            );
            let passes = final_stage(
                &mut greedy.clone(),
                stages(Refits::Passes(expected as u32), None),
                Alpha::Auto,
                None,
                || false,
            );
            assert_eq!(until, passes, "min_gain {min_gain}");
            assert_eq!(until.map(|(_, chosen)| chosen), Some(Chosen::Refitted));
        }
        counts.dedup();
        assert!(counts.len() >= 3, "the thresholds stop alike: {counts:?}");
        assert_eq!(counts.first(), Some(&6));
        assert_eq!(counts.last(), Some(&1));
    }

    /// The stop rule reads only deterministic scores: the stage gives the
    /// same drawing whatever the number of threads.
    #[test]
    fn refits_until_do_not_depend_on_the_thread_count() {
        let greedy = model(ShapeKind::RotatedEllipse, 12);
        let on_threads = |threads| {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("test thread pool");
            pool.install(|| {
                final_stage(
                    &mut greedy.clone(),
                    stages(
                        Refits::Until {
                            min_gain: 50,
                            cap: 16,
                        },
                        None,
                    ),
                    Alpha::Auto,
                    None,
                    || false,
                )
            })
        };
        let reference = on_threads(1);
        assert!(reference.is_some());
        for threads in [2, 4, 8] {
            assert_eq!(on_threads(threads), reference, "{threads} threads");
        }
    }

    /// A refit pass in the search polls `cancelled` before each layer;
    /// once it returns true the pass stops and leaves the model as it
    /// was, which `approximate` turns into
    /// [`crate::ApproximateError::Aborted`]. A step with no pass due
    /// polls nothing.
    #[test]
    fn cancellation_during_a_refit_in_the_search_stops_it() {
        let greedy = model(ShapeKind::Ellipse, 10);
        let during = During::Every(10);
        let mut polls = 0;
        let mut refitted = greedy.clone();
        let finished = after_step(
            &mut refitted,
            during,
            curves_fixed(),
            10,
            Alpha::Auto,
            || {
                polls += 1;
                false
            },
        );
        assert_eq!(finished, Some(Pass::Refit));
        assert_ne!(
            refitted.drawing(),
            greedy.drawing(),
            "the pass changed nothing"
        );
        assert!(polls > 10, "{polls} polls");
        for cancel_at in [1, polls / 2, polls] {
            let mut model = greedy.clone();
            let mut count = 0;
            let stopped = after_step(&mut model, during, curves_fixed(), 10, Alpha::Auto, || {
                count += 1;
                count >= cancel_at
            });
            assert_eq!(stopped, None, "cancelled at poll {cancel_at}");
            assert_eq!(model.drawing(), greedy.drawing());
        }
        let mut model = greedy.clone();
        assert_eq!(
            after_step(
                &mut model,
                during,
                curves_fixed(),
                9,
                Alpha::Auto,
                || panic!("polled")
            ),
            Some(Pass::Skipped)
        );
    }

    /// Every loop of the final stage polls `cancelled`: the fixed refit
    /// passes, the passes until the gain falls, and the joint
    /// optimisation after them.
    #[test]
    fn cancellation_stops_every_loop_of_the_final_stage() {
        for (shape, pipeline) in [
            (ShapeKind::Ellipse, stages(Refits::Passes(3), None)),
            (
                ShapeKind::Ellipse,
                stages(
                    Refits::Until {
                        min_gain: 0,
                        cap: 3,
                    },
                    None,
                ),
            ),
            (ShapeKind::Triangle, stages(Refits::Passes(2), Some(1))),
            (
                ShapeKind::Triangle,
                stages(
                    Refits::Until {
                        min_gain: 0,
                        cap: 2,
                    },
                    Some(2),
                ),
            ),
        ] {
            let greedy = model(shape, 6);
            let mut polls = 0;
            let finished = final_stage(&mut greedy.clone(), pipeline, Alpha::Auto, None, || {
                polls += 1;
                false
            });
            assert!(finished.is_some());
            for cancel_at in [1, polls / 3, 2 * polls / 3, polls] {
                let mut count = 0;
                let stopped = final_stage(&mut greedy.clone(), pipeline, Alpha::Auto, None, || {
                    count += 1;
                    count >= cancel_at
                });
                assert_eq!(stopped, None, "{pipeline:?}: cancelled at poll {cancel_at}");
            }
        }
    }

    /// A joint pass in the search, every `interval` steps up to
    /// `interval · divisor`, then spaced, of `iterations` iterations.
    fn joint(interval: u32, divisor: u32, iterations: u32, guard: Guard) -> During {
        During::Joint {
            interval,
            divisor,
            iterations,
            guard,
        }
    }

    /// The kinds the joint optimisation moves, `any` included.
    const JOINT_KINDS: [ShapeKind; 5] = [
        ShapeKind::Any,
        ShapeKind::Triangle,
        ShapeKind::Rectangle,
        ShapeKind::RotatedRectangle,
        ShapeKind::Polygon,
    ];

    #[test]
    fn joint_passes_are_due_at_the_spaced_steps() {
        for (interval, divisor) in [(10, 5), (20, 5), (5, 2), (20, 2), (3, 1)] {
            let spaced = due_steps(During::Spaced { interval, divisor }, 600);
            for guard in [Guard::Canvas, Guard::Export] {
                let joint = joint(interval, divisor, 7, guard);
                assert_eq!(due_steps(joint, 600), spaced, "{interval}:{divisor}");
            }
        }
    }

    /// Triangles run the joint optimisation during the search, kept by the
    /// exact canvas; every other kind runs refit passes, so a change to
    /// another kind's schedule is deliberate.
    #[test]
    fn only_triangles_run_joint_passes_during_the_search() {
        for shape in KINDS {
            let during = pipeline(shape).during;
            if shape == ShapeKind::Triangle {
                assert_eq!(during, joint(20, 5, 20, Guard::Canvas));
            } else {
                assert!(
                    matches!(during, During::Spaced { .. }),
                    "{shape:?}: {during:?}"
                );
            }
        }
    }

    /// Rotated rectangles keep their refit schedule and use the measured
    /// cheaper final joint budget.
    #[test]
    fn rotated_rectangles_end_with_one_joint_iteration_multiple() {
        let stages = pipeline(ShapeKind::RotatedRectangle);
        assert_eq!(stages.joint, Some(1));
        assert_eq!(stages.refits, Refits::Passes(0));
        assert_eq!(
            stages.during,
            During::Spaced {
                interval: 20,
                divisor: 2,
            }
        );
    }

    /// Ellipses and circles refit every 20 steps up to step 100, then each
    /// fifth of the step number, and end with the joint optimisation and no
    /// refit pass; rotated ellipses keep their refit passes, and they and
    /// quadratics end without it.
    #[test]
    fn ellipses_and_circles_end_with_the_joint_optimisation() {
        for shape in [ShapeKind::Ellipse, ShapeKind::Circle] {
            let stages = pipeline(shape);
            assert_eq!(
                stages.during,
                During::Spaced {
                    interval: 20,
                    divisor: 5
                },
                "{shape:?}"
            );
            assert_eq!(stages.refits, Refits::Passes(0), "{shape:?}");
            assert_eq!(stages.joint, Some(1), "{shape:?}");
        }
        let rotated = pipeline(ShapeKind::RotatedEllipse);
        assert_eq!(
            rotated.during,
            During::Spaced {
                interval: 10,
                divisor: 10
            }
        );
        assert_eq!(rotated.refits, Refits::Passes(1));
        for shape in [ShapeKind::RotatedEllipse, ShapeKind::Quadratic] {
            assert_eq!(pipeline(shape).joint, None, "{shape:?}");
        }
    }

    /// A model of `shape` after `steps` greedy steps, each followed by the
    /// pass `during` schedules, and what each pass did.
    fn joint_model(shape: ShapeKind, during: During, steps: u32) -> (Model, Vec<Pass>) {
        let mut model = model(shape, 0);
        let passes = (1..=steps)
            .map(|step| {
                model.step(shape, Alpha::Auto);
                after_step(
                    &mut model,
                    during,
                    curves_fixed(),
                    step,
                    Alpha::Auto,
                    || false,
                )
                .expect("not cancelled")
            })
            .collect();
        (model, passes)
    }

    /// With the canvas guard a joint pass is kept only if the model's
    /// exact canvas scores strictly lower, and otherwise leaves the model
    /// as it was.
    #[test]
    fn a_joint_pass_with_the_canvas_guard_never_raises_the_score() {
        let during = joint(3, 2, 10, Guard::Canvas);
        let mut kept = 0;
        for shape in JOINT_KINDS {
            let mut model = model(shape, 0);
            for step in 1..=12 {
                model.step(shape, Alpha::Auto);
                let before = model.clone();
                let pass = after_step(
                    &mut model,
                    during,
                    curves_fixed(),
                    step,
                    Alpha::Auto,
                    || false,
                )
                .expect("not cancelled");
                let context = format!("{shape:?}, step {step}");
                match pass {
                    Pass::Joint { kept: true } => {
                        kept += usize::from(shape != ShapeKind::Any);
                        assert!(model.score_f64() < before.score_f64(), "{context}");
                    }
                    Pass::Joint { kept: false } => {
                        assert_eq!(model.drawing(), before.drawing(), "{context}");
                        assert_eq!(model.score_f64(), before.score_f64(), "{context}");
                    }
                    Pass::Skipped => assert!(!during.due(step), "{context}"),
                    Pass::Refit => panic!("{context}: a refit pass"),
                }
            }
        }
        // Count the four concrete kinds' passes: at least 9 of their 12
        // must improve enough to be adopted. `any` adopts too, but its
        // mixture is not part of this fixture's lower bound.
        assert!(kept >= 9, "only {kept} passes kept");
    }

    /// With the export guard a joint pass is kept only if the model's own
    /// PNG export at the working size, after adopting, is strictly closer
    /// to the target, so it never moves further from the target, also for
    /// the rectangles that adopting rounds; otherwise the model is left as
    /// it was.
    #[test]
    fn a_joint_pass_with_the_export_guard_never_raises_the_export_error() {
        let during = joint(3, 2, 10, Guard::Export);
        let mut kept = 0;
        for shape in JOINT_KINDS {
            let mut model = model(shape, 0);
            let error = |model: &Model| {
                raster::squared_error(&model.drawing(), model.target()).expect("raster")
            };
            for step in 1..=12 {
                model.step(shape, Alpha::Auto);
                let before = model.clone();
                let pass = after_step(
                    &mut model,
                    during,
                    curves_fixed(),
                    step,
                    Alpha::Auto,
                    || false,
                )
                .expect("not cancelled");
                let context = format!("{shape:?}, step {step}");
                match pass {
                    Pass::Joint { kept: true } => {
                        kept += usize::from(shape != ShapeKind::Any);
                        assert!(error(&model) < error(&before), "{context}");
                    }
                    Pass::Joint { kept: false } => {
                        assert_eq!(model.drawing(), before.drawing(), "{context}");
                        assert_eq!(model.score_f64(), before.score_f64(), "{context}");
                    }
                    Pass::Skipped => assert!(!during.due(step), "{context}"),
                    Pass::Refit => panic!("{context}: a refit pass"),
                }
            }
        }
        // Count the four concrete kinds' passes: at least 9 of their 12
        // must improve enough to be adopted. `any` adopts too, but its
        // mixture is not part of this fixture's lower bound.
        assert!(kept >= 9, "only {kept} passes kept");
    }

    /// A joint pass in the search polls `cancelled` before every iteration,
    /// before the snap and once more before adopting; a cancel at any of
    /// those polls stops it with the model as it was.
    #[test]
    fn cancellation_during_a_joint_pass_in_the_search_stops_it() {
        for guard in [Guard::Canvas, Guard::Export] {
            let greedy = model(ShapeKind::Triangle, 10);
            let during = joint(10, 1, 5, guard);
            let mut polls = 0;
            let mut adopted = greedy.clone();
            let finished = after_step(
                &mut adopted,
                during,
                curves_fixed(),
                10,
                Alpha::Auto,
                || {
                    polls += 1;
                    false
                },
            );
            assert_eq!(finished, Some(Pass::Joint { kept: true }), "{guard:?}");
            assert_ne!(adopted.drawing(), greedy.drawing(), "{guard:?}");
            // Five iterations, the snap and the adoption.
            assert_eq!(polls, 7, "{guard:?}");
            for cancel_at in 1..=polls {
                let mut model = greedy.clone();
                let mut count = 0;
                let stopped =
                    after_step(&mut model, during, curves_fixed(), 10, Alpha::Auto, || {
                        count += 1;
                        count >= cancel_at
                    });
                assert_eq!(stopped, None, "{guard:?}: cancelled at poll {cancel_at}");
                assert_eq!(model.drawing(), greedy.drawing(), "{guard:?}");
                assert_eq!(model.score_f64(), greedy.score_f64(), "{guard:?}");
            }
        }
    }

    /// The search with joint passes gives the same drawing at 1, 2, 4 and
    /// 8 threads, with the canvas guard for every kind the joint
    /// optimisation moves and with the export guard for two of them; the
    /// final stage after it does too
    /// (`every_kind_path_is_identical_across_thread_counts`).
    #[test]
    fn joint_passes_are_identical_across_thread_counts() {
        let export = [ShapeKind::Triangle, ShapeKind::Any].map(|shape| (shape, Guard::Export));
        let mut kept = 0;
        for (shape, guard) in JOINT_KINDS
            .map(|shape| (shape, Guard::Canvas))
            .into_iter()
            .chain(export)
        {
            let on_threads = |threads| {
                let pool = rayon::ThreadPoolBuilder::new()
                    .num_threads(threads)
                    .build()
                    .expect("test thread pool");
                pool.install(|| {
                    let mut model = sized_model(shape, 0, 24, 18);
                    let mut passes = Vec::new();
                    for step in 1..=4 {
                        model.step(shape, Alpha::Auto);
                        // Passes after steps 1, 2 and 4.
                        let during = joint(1, 1, 6, guard);
                        passes.push(
                            after_step(
                                &mut model,
                                during,
                                curves_fixed(),
                                step,
                                Alpha::Auto,
                                || false,
                            )
                            .expect("not cancelled"),
                        );
                    }
                    (model.drawing(), passes)
                })
            };
            let reference = on_threads(1);
            kept += reference
                .1
                .iter()
                .filter(|&&pass| pass == Pass::Joint { kept: true })
                .count();
            for threads in [2, 4, 8] {
                assert!(
                    on_threads(threads) == reference,
                    "{shape:?} {guard:?}: {threads} threads changed the drawing"
                );
            }
        }
        assert!(kept >= 7, "only {kept} passes kept");
    }

    /// Greedy steps build on an adopted joint result, whose triangles are
    /// now polygons: every step still lowers the score or keeps it.
    #[test]
    fn greedy_steps_continue_after_an_adopted_joint_pass() {
        // Triangles become continuous polygons, and polygons adopt
        // exactly; later greedy steps must build on both.
        for shape in [ShapeKind::Triangle, ShapeKind::Polygon] {
            let (mut model, passes) = joint_model(shape, joint(5, 1, 10, Guard::Canvas), 5);
            assert_eq!(
                passes.last(),
                Some(&Pass::Joint { kept: true }),
                "{shape:?}"
            );
            for _ in 0..5 {
                let before = model.score_f64();
                model.step(shape, Alpha::Auto);
                assert!(model.score_f64() <= before, "{shape:?}");
            }
            assert_eq!(model.drawing().shapes.len(), 10, "{shape:?}");
        }
    }

    /// The joint optimisation's own result for `model` with `tuning`, at
    /// its default iterations, as the final stage runs it.
    fn tuned_joint_result(model: &Model, tuning: joint::Tuning) -> Drawing {
        let mut settings = joint::Settings::default();
        settings.iterations = Some(joint::default_iterations(model.drawing().shapes.len()));
        settings.tuning = tuning;
        joint::optimise(model, Alpha::Auto, settings, || false).expect("not cancelled")
    }

    /// Every kind's pipeline has the default tuning, and a pipeline's
    /// tuning reaches both the final stage's joint optimisation and the
    /// joint passes of the search.
    #[test]
    fn the_pipeline_carries_its_tuning_to_both_joint_stages() {
        for shape in KINDS {
            assert_eq!(
                pipeline(shape).joint_settings.tuning,
                joint::Tuning::default(),
                "{shape:?}"
            );
        }
        let tuning = joint::Tuning {
            warmup: 10,
            ..joint::Tuning::default()
        };
        let hard = hard_shapes_model(ShapeKind::Triangle, 2, 20);
        let tuned = tuned_joint_result(&hard, tuning);
        assert_ne!(tuned, joint_result(&hard, 1));
        let expected = better_export(hard.target(), hard.drawing(), tuned.clone());
        let mut tuned_stages = stages(Refits::Passes(0), Some(1));
        tuned_stages.joint_settings.tuning = tuning;
        let kept = final_stage(&mut hard.clone(), tuned_stages, Alpha::Auto, None, || false);
        assert_eq!(kept, Some(expected));

        let model = model(ShapeKind::Triangle, 10);
        let during = joint(5, 1, 10, Guard::Canvas);
        let mut settings = joint::Settings::default();
        settings.iterations = Some(10);
        settings.tuning = tuning;
        let mut expected = model.clone();
        let optimised =
            joint::optimise(&expected, Alpha::Auto, settings, || false).expect("not cancelled");
        let adopted = expected.adopt(&optimised, false) == Some(true);
        let mut passed = model.clone();
        let pass = after_step(
            &mut passed,
            during,
            curves_fixed_with(tuning),
            5,
            Alpha::Auto,
            || false,
        );
        assert_eq!(pass, Some(Pass::Joint { kept: adopted }));
        assert_eq!(passed.drawing(), expected.drawing());
        let mut untuned = model.clone();
        after_step(&mut untuned, during, curves_fixed(), 5, Alpha::Auto, || {
            false
        })
        .expect("not cancelled");
        assert!(adopted, "the tuned pass is not kept, so it shows nothing");
        assert_ne!(passed.drawing(), untuned.drawing());
    }

    /// Every kind's pipeline moves the curved shapes, and a pipeline's
    /// switch, on or off, reaches both the final stage's joint
    /// optimisation and the joint passes of the search.
    #[test]
    fn the_pipeline_carries_its_curved_switch_to_both_joint_stages() {
        for shape in KINDS {
            assert!(pipeline(shape).joint_settings.curved, "{shape:?}");
        }
        let curved = |iterations| {
            let mut settings = joint::Settings::default();
            settings.iterations = Some(iterations);
            settings.curved = true;
            settings
        };
        let hard = hard_shapes_model(ShapeKind::Ellipse, 2, 20);
        let iterations = joint::default_iterations(hard.drawing().shapes.len());
        let moved = joint::optimise(&hard, Alpha::Auto, curved(iterations), || false)
            .expect("not cancelled");
        let mut off = curved(iterations);
        off.curved = false;
        let fixed = joint::optimise(&hard, Alpha::Auto, off, || false).expect("not cancelled");
        assert_ne!(moved, fixed);
        for (switch, optimised) in [(true, moved), (false, fixed)] {
            let expected = better_export(hard.target(), hard.drawing(), optimised);
            let mut switched_stages = stages(Refits::Passes(0), Some(1));
            switched_stages.joint_settings.curved = switch;
            let kept = final_stage(
                &mut hard.clone(),
                switched_stages,
                Alpha::Auto,
                None,
                || false,
            );
            assert_eq!(kept, Some(expected), "curved: {switch}");
        }

        let model = model(ShapeKind::Circle, 10);
        let during = joint(5, 1, 10, Guard::Canvas);
        let mut expected = model.clone();
        let optimised =
            joint::optimise(&expected, Alpha::Auto, curved(10), || false).expect("not cancelled");
        let adopted = expected.adopt(&optimised, false) == Some(true);
        let mut passed = model.clone();
        let pass = after_step(
            &mut passed,
            during,
            joint::Settings::default(),
            5,
            Alpha::Auto,
            || false,
        );
        assert_eq!(pass, Some(Pass::Joint { kept: adopted }));
        assert_eq!(passed.drawing(), expected.drawing());
        let mut unmoved = model.clone();
        let fixed_pass = after_step(&mut unmoved, during, curves_fixed(), 5, Alpha::Auto, || {
            false
        });
        assert_ne!(
            (pass, passed.drawing()),
            (fixed_pass, unmoved.drawing()),
            "the switch changed nothing"
        );
    }

    /// B's first steps on the guard's case: the ratio of the joint result's
    /// PNG error to its input's, with the default tuning (a warm-up of 5
    /// iterations) and, each alone on the previous steps (no warm-up), with
    /// a warm-up of 10, a relative step of 1/8 and a first step of 0.25 px.
    /// The default lowers the ratio below the previous steps', and so does
    /// at least one of the three.
    #[test]
    fn a_gentler_start_lowers_the_export_error_on_small_shapes() {
        let target = hard_shapes(24);
        let model = hard_shapes_model(ShapeKind::Polygon, 2, 25);
        let input = png_error(&model.drawing(), &target) as f64;
        let ratio = |tuning| png_error(&tuned_joint_result(&model, tuning), &target) as f64 / input;
        let default = ratio(joint::Tuning::default());
        let previous = joint::Tuning {
            warmup: 0,
            ..joint::Tuning::default()
        };
        let baseline = ratio(previous);
        let variants = [
            (
                "warmup 10",
                joint::Tuning {
                    warmup: 10,
                    ..previous
                },
            ),
            (
                "step-rel 0.125",
                joint::Tuning {
                    relative_step: Some(0.125),
                    ..previous
                },
            ),
            (
                "step 0.25",
                joint::Tuning {
                    step: 0.25,
                    ..previous
                },
            ),
        ]
        .map(|(name, tuning)| (name, ratio(tuning)));
        let report =
            format!("default (warm-up 5) {default:.3}, warm-up 0 {baseline:.3}, {variants:.3?}");
        assert!(
            default < baseline,
            "the default does not lower the ratio: {report}"
        );
        assert!(
            variants.iter().any(|&(_, r)| r < baseline),
            "no tuning lowers the ratio: {report}"
        );
        eprintln!("export error ratios: {report}");
    }

    /// The export's RMSE against the target over the engine's: the gap of
    /// the engine runner, `rmse256 / score − 1`, of `model`'s drawing.
    #[cfg(feature = "lab")]
    fn gap(model: &Model) -> f64 {
        let target = model.target();
        let error = raster::squared_error(&model.drawing(), target).expect("raster");
        let values = f64::from(target.width() * target.height() * 3);
        (error as f64 / values).sqrt() / 255.0 / model.score_f64() - 1.0
    }

    /// Every cap meets its original engine/export gap bound. These are
    /// different fitted drawings, so their errors need not be ordered:
    /// clipping joins by true butt-cap tangents made butt's gap smaller
    /// than round's on this seed, while both still meet their bounds.
    /// The search keeps the quadratic round the bounds were measured
    /// with (900 candidates, age 200, two seeds): the gap of 16 curves on
    /// one seed follows the drawing the search finds, and the default's
    /// 500 candidates put butt at +1.29% and round at +1.15%, while the
    /// corpus medians of the gap did not grow.
    #[cfg(feature = "lab")]
    #[test]
    fn capped_quadratics_export_as_the_engine_covers_them() {
        let gap_of = |cap| {
            let mut model = sized_model(ShapeKind::Quadratic, 0, 48, 40);
            model.set_search(primeval_core::Search {
                seeds: Some(2),
                candidates: Some(900),
                age: Some(200),
            });
            model.set_quadratic_cap(cap);
            for _ in 0..16 {
                model.step(ShapeKind::Quadratic, Alpha::Auto);
            }
            gap(&model)
        };
        let butt = gap_of(LineCap::Butt);
        assert!(butt.abs() <= 0.011, "butt: {butt:+.5}");
        for (cap, bound) in [(LineCap::Round, 0.005), (LineCap::Square, 0.0055)] {
            let gap = gap_of(cap);
            assert!(
                gap.abs() <= bound,
                "{cap:?}: {gap:+.5} against butt's {butt:+.5}"
            );
        }
    }
}
