//! Engine evaluation runner: quality at fixed shape counts.
//!
//! Usage:
//!
//! ```text
//! cargo run --release -p primeval-render --features lab --example engine -- [options]
//!
//!   --quick             smoke run: shape kind any, checkpoints 10,20
//!   --image PATH        add an input image (repeatable); replaces the
//!                       default paintings
//!   --no-synthetic      skip the generated images
//!   --shapes LIST       comma-separated shape kinds (default: all, plus any)
//!   --steps LIST        comma-separated checkpoints, in steps
//!                       (default: 50,100,200,500)
//!   --refine SCHEDULE   refit passes (`Model::refine`, default: none):
//!                       `end:P` runs P passes at each checkpoint,
//!                       `every:K` one pass after every K-th step,
//!                       `final` runs `approximate`'s pipeline: its refit
//!                       passes during the search and its final stage at
//!                       each checkpoint, `joint:R` (lab only) R refit passes
//!                       then the joint optimisation of every shape but
//!                       the quadratics, which keep their geometry (the
//!                       ellipses, circles and rotated ellipses too with
//!                       `--joint-curved off`), at
//!                       each checkpoint, whatever `approximate` runs for
//!                       the kind
//!   --iterations K      with `--refine final` or `joint:R`: the joint
//!                       optimisation's iteration count (default:
//!                       `approximate`'s, which grows with the shape
//!                       count: 80 up to 50 shapes, 160 from 500); replaces
//!                       the kind's scaled default, ignored if it has no
//!                       joint stage
//!   --during SCHEDULE   refit passes of the search itself, combined with
//!                       any `--refine` but `every:K`: `none`, `every:K`
//!                       one pass after every K-th step, `spaced:K:C`
//!                       after step K, then each max(K, s / C) steps after
//!                       the pass at step s (default: `approximate`'s for
//!                       the kind with `--refine final`, otherwise none);
//!                       `joint:K:C:I` (lab only) on the schedule of
//!                       `spaced:K:C`, the joint optimisation of I
//!                       iterations (positive) in place of the refit pass,
//!                       its result adopted into the model if the model's
//!                       exact canvas scores lower (`Model::adopt`), and
//!                       `joint-export:K:C:I` the same, adopted if its PNG
//!                       at the working size is closer to the target, the
//!                       final stage's rule
//!   --final-refits R    with `--refine final` or `joint:R`: the final
//!                       stage's refit passes, `R` passes or `until:G:C`,
//!                       passes until one lowers the score by less than G
//!                       ten-thousandths, at most C (default:
//!                       `approximate`'s, or R of `joint:R`)
//!   --joint-scale M     with `--refine final` or `joint:R`: the joint
//!                       optimisation's iterations as M times its default,
//!                       0 for none (default: `approximate`'s, or 1 with
//!                       `joint:R`)
//!   --joint-warmup W    every joint optimisation's steps ramp up over W
//!                       iterations (`joint::Tuning::warmup`, default 5;
//!                       0 gives the steps before that default)
//!   --joint-step X      every joint optimisation's first vertex step, in
//!                       px, positive (`joint::Tuning::step`, default 1)
//!   --joint-step-rel F  every joint optimisation's vertex step capped at F
//!                       times the root of each shape's area, F positive
//!                       (`joint::Tuning::relative_step`, default none)
//!   --joint-curved on|off  whether every joint optimisation, in the search
//!                       and in the final stage, moves the ellipses,
//!                       circles and rotated ellipses too
//!                       (`joint::Settings::curved`, default on; `off`
//!                       keeps their geometry, the behaviour before they
//!                       moved), for every kind
//!   --effort R:C:A      the greedy search's rounds per step, and the
//!                       multiples of each round's random candidates and
//!                       climb age (default: 16 rounds and multiples of 1
//!                       for every kind)
//!   --search KEY=VALUE[,KEY=VALUE...]  the greedy search's settings per
//!                       round (`Model::set_search`), each key left out
//!                       keeping the kind's default: `seeds=K` the best
//!                       random candidates climbed in turn (default 1, 2
//!                       for quadratics), `candidates=N` the random
//!                       candidates (default 500 for circles, rotated
//!                       ellipses and quadratics, 1000 for the others),
//!                       `age=A` the climb age, replacing the kind's age
//!                       outright (default 75 for triangles, polygons and
//!                       circles, 200 for quadratics, 100 for the others);
//!                       only `--effort`'s multiples still multiply the
//!                       candidates and age; all numbers positive
//!   --refine-effort R:A every refit pass's hill climbs per layer and the
//!                       non-improving moves that stop a climb (default:
//!                       the model's, 4 climbs of age 25)
//!   --quadratic-width MIN:MAX  the bounds of every quadratic curve's
//!                       stroke width in working pixels, 1 <= MIN <= MAX
//!                       (`Model::set_quadratic_width`, default: the
//!                       model's 2:6; 2:2 reproduces the earlier fixed
//!                       2 px); for every kind, it only affects
//!                       quadratics, in `quadratic` and `any`
//!   --quadratic-cap CAP how every quadratic curve's stroke ends, `butt`,
//!                       `round` or `square`, in the engine's coverage, the
//!                       SVG and the PNG (`Model::set_quadratic_cap`,
//!                       default: the model's round); it only affects
//!                       quadratics, in `quadratic` and `any`
//!   --save DIR          also write, for every row, the PNG at the default
//!                       output size that `ssim1024` is measured on and the
//!                       SVG whose length is `svg_bytes`, as
//!                       `DIR/<image>-<shape>-<steps>.png` and `.svg`,
//!                       creating DIR if needed (default: none)
//! ```
//!
//! The joint tuning flags (`--joint-warmup`, `--joint-step`, `--joint-step-rel`
//! and `--joint-curved`) require `--refine final`, `joint:R`, or a joint
//! `--during` schedule.
//!
//! For every image × shape kind it runs one greedy search to the largest
//! checkpoint, with seed 42 and default options otherwise. It drives
//! [`primeval_core::Model`] itself through `primeval_render::lab`, which
//! reproduces `approximate`'s search and encoding exactly. `approximate`
//! runs the pipeline of its kind (`lab::pipeline`): refit passes during the
//! search (joint passes for triangles), then its final stage: for triangles,
//! polygons, rectangles, rotated rectangles, ellipses and circles the joint
//! gradient optimisation of every shape, with no refit pass
//! (`primeval_core::joint`), for `any` one refit pass then the joint
//! optimisation, whose result is kept only if its PNG at the working size
//! is closer to the target than its input, for quadratics refit passes
//! until one gains less than 1%, at most four, for rotated ellipses one
//! refit pass. The joint optimisation moves curved shapes by default;
//! quadratics keep their geometry. The rows of
//! `--refine final` are what it returns for that step count; rows without
//! `--refine` are the greedy search alone. At each checkpoint it records
//! one row.
//!
//! With `--refine end:P`, each checkpoint clones the model, runs `P` refit
//! passes on the clone and records the clone, while the search itself goes
//! on greedily: each row is "greedy to n steps, then P passes". With
//! `--refine final`, the search itself runs the pipeline's in-search passes
//! (`lab::after_step`), and each checkpoint runs its final stage on a clone
//! (`lab::final_stage`) and records its drawing, in the same way. With
//! `--refine every:K` the search itself runs one pass after every `K`-th
//! step, so later steps build on the refitted shapes; `--during` gives any
//! other `--refine` such passes too. With `--refine joint:R`, each
//! checkpoint runs `lab::final_stage` on a clone with `R` refit passes (none
//! with `joint:0`), then the joint optimisation. Passes and the final stage
//! get the render's alpha. A schedule of passes during the search depends
//! only on the step number, never on the shape count, so a checkpoint of a
//! longer search is what `approximate` returns for that count.
//!
//! Progress goes to stderr; stdout gets a header with the commit, the
//! machine, the options and the refine schedule, the rows as a Markdown
//! table sorted by image, shape and steps, and two summary tables, so two
//! runs can be compared at a glance: one line per checkpoint over all rows,
//! then one line per shape kind × checkpoint.
//!
//! Corpus: the same as the `quality` runner, the public-domain paintings
//! `docs/readme/originals/monalisa.jpg` and `americangothic.jpg` plus three
//! deterministic 512 × 512 images (`synthetic-gradient`, `synthetic-shapes`,
//! `synthetic-texture`), all in `common/mod.rs`. Inputs are expected to be
//! opaque.
//!
//! Terms used below:
//!
//! - the *working target* is the thumbnail the engine optimises, with the
//!   default `resize_input` of 256 (`lab::working_image`, which shares
//!   `approximate`'s code path). Its longer side is 256 px for every input
//!   of the default corpus; an input already smaller than that is used at
//!   its own size.
//! - *normalised RGB RMSE* between two images of the same size is
//!   `sqrt(Σ Δ² / (w · h · 3)) / 255`, over the RGB channels of every
//!   pixel, as in the `quality` runner. Lower is better.
//! - *SSIM* is mean SSIM (Wang et al. 2004): each RGB channel is scored
//!   separately with an 11 × 11 Gaussian window (σ = 1.5, normalised to
//!   sum 1), `K1 = 0.01`, `K2 = 0.03`, `L = 255`, over the window positions
//!   inside the image; the value is the mean of the three channels' mean
//!   SSIM maps (`lab::ssim`). Higher is better; `1` is identical.
//! - *the PNG at size s* is the PNG `approximate` would return for the
//!   drawing with `output_size` s (`lab::encode`): the vector drawing
//!   rendered anti-aliased with tiny-skia, its longer side s px.
//!
//! Columns:
//!
//! - `search_s`: cumulative wall time of the `Model::step` calls up to this
//!   checkpoint, plus the refit passes: every pass during the search so
//!   far (`every:K` or `--during`, joint passes included), and with `end:P`
//!   this checkpoint's passes, with `final` or `joint:R` this checkpoint's
//!   final stage.
//!   Decoding, the thumbnail, the clone, the
//!   metrics and the encodings are outside the clock, as are all the
//!   columns below.
//! - `refine_s`, only with `--refine`: the part of `search_s` spent in
//!   refit passes or the final stage.
//! - `score`: `Model::score_f64`, the normalised RGB RMSE between the
//!   engine's own canvas and the working target. Most shape kinds draw on
//!   that canvas with binary (not anti-aliased) coverage. With `--refine
//!   final` or `joint:R`, the score `lab::final_stage` returns: after the joint optimisation, its model's RMSE of its exported
//!   drawing (`joint::score`), so `gap` measures how well that model agrees
//!   with the export.
//! - `rmse256`: the normalised RGB RMSE between the PNG at the working
//!   target's longer side, which has exactly the working target's
//!   dimensions (scale 1 against the drawing's view box; the runner
//!   asserts the dimensions), and the working target itself. It is
//!   `score` measured on the exported image instead of the engine's canvas.
//! - `gap`: `rmse256 / score − 1`, signed. Positive means the exported image
//!   is further from the target than the engine believes; negative, closer.
//! - `ssim128`: SSIM between the PNG at size 128 and the input resampled to
//!   the same dimensions with Catmull-Rom, the filter the engine uses for
//!   its working thumbnail: the quality at a placeholder-like size.
//! - `ssim1024`: the same at the default output size, 1024 (the `ssim`
//!   column of earlier runs).
//! - `svg_bytes`: the length in bytes of the SVG output at the default
//!   output size.
//! - `adopted`, for triangles with `--refine final`, or with
//!   `--during joint:K:C:I` or `joint-export:K:C:I`: the
//!   joint passes during the search up to this checkpoint whose result the
//!   model adopted, over those that ran, as `kept/ran`; empty for a
//!   schedule without joint passes. Their time is in `search_s` and
//!   `refine_s`, as every pass's during the search.
//! - `final_joint`, with `--refine final` or `joint:R`: `kept` when the
//!   checkpoint's final stage returned the joint optimisation's result,
//!   `input` when the guard kept the refitted drawing because the joint
//!   result exported no closer to the target (`lab::Chosen`); empty for a
//!   kind without the joint optimisation and for the other `--refine`.
//! - `violations`, in the per-kind summary only: the drawing's shapes that
//!   break the legibility rules, checked independently with `acos` angles:
//!   triangles with an angle of 15° or less; quadrilaterals (polygons
//!   and rotated rectangles) whose diagonals do not cross strictly, that is
//!   not strictly convex, or with an angle of 15° or less; and rectangles,
//!   axis-aligned or rotated, with a side under 1 px or a long side more
//!   than 8 times the short one. With `rotated-rectangle`, a quadrilateral
//!   that is not a rectangle is one too.
//!
//! Summaries. The median of an even number of values is the mean of the two
//! middle ones.
//!
//! - Per checkpoint, over all rows: the number of rows, the mean and median
//!   of `score`, the medians of `rmse256` and `gap`, the means of `ssim128`,
//!   `ssim1024` and `svg_bytes`, and the sum of `search_s` (and of
//!   `refine_s` with `--refine`).
//! - Per shape kind × checkpoint, over that kind's rows (one per image),
//!   kinds in the order `any`, `triangle`, `rectangle`, `ellipse`, `circle`,
//!   `rotated-rectangle`, `quadratic`, `rotated-ellipse`, `polygon`: the
//!   medians of `score`, `rmse256`, `gap` and `ssim128`, the mean of
//!   `svg_bytes`, the sum of `search_s` (and of `refine_s` with
//!   `--refine`), and the sum of `violations`.
//!
//! Times vary between runs. Every other column is deterministic for a given
//! commit and platform, whatever the thread count (the search runs one
//! worker per logical core, but its result does not depend on how many
//! there are).

mod common;

use common::{ALL_SHAPES, BoxError, SEED, rgb_rmse};
use image::{ImageFormat, RgbImage, imageops};
use primeval_core::{Buffer, Drawing, Geometry, LineCap, Model, ModelOptions, Search, joint};
use primeval_render::lab::{Chosen, During, Guard, Pass, Pipeline, Refits};
use primeval_render::{OutputFormat, RenderOptions, ShapeKind, lab};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DEFAULT_CHECKPOINTS: [u32; 4] = [50, 100, 200, 500];
const QUICK_CHECKPOINTS: [u32; 2] = [10, 20];
/// Output size of the `ssim128` column.
const SMALL_SIZE: u32 = 128;

struct Config {
    photos: Vec<PathBuf>,
    synthetic: bool,
    shapes: Vec<ShapeKind>,
    checkpoints: Vec<u32>,
    refine: Refine,
    /// The joint optimisation's iteration count with `--refine final`.
    iterations: Option<u32>,
    /// Overrides of the pipeline: `--during`, `--final-refits` and
    /// `--joint-scale`.
    during: Option<During>,
    final_refits: Option<Refits>,
    joint_scale: Option<u32>,
    /// `--joint-warmup`, `--joint-step`, `--joint-step-rel` and
    /// `--joint-curved` applied to the default settings of every joint
    /// optimisation: its step sizes and whether it moves the curved shapes.
    joint_settings: joint::Settings,
    /// `--effort`: rounds, candidate and age multiples.
    effort: Option<(u64, usize, usize)>,
    /// `--search`: the keys given, `None` for the others.
    search: Option<SearchArgs>,
    /// `--refine-effort`: climbs per layer and climb age of every refit
    /// pass.
    refine_effort: Option<(u64, usize)>,
    /// `--quadratic-width`: the bounds of every quadratic curve's stroke
    /// width.
    quadratic_width: Option<(f64, f64)>,
    /// `--quadratic-cap`: how every quadratic curve's stroke ends.
    quadratic_cap: Option<LineCap>,
    /// `--save`: where to write each row's PNG and SVG.
    save: Option<PathBuf>,
}

impl Config {
    /// The pipeline of a search of `shape`: `approximate`'s for the kind
    /// with the overrides applied, its final stage used only with
    /// `--refine final` or `joint:R`.
    fn pipeline(&self, shape: ShapeKind) -> Pipeline {
        let mut pipeline = lab::pipeline(shape);
        match self.refine {
            Refine::Final => {}
            Refine::Joint(refits) => {
                pipeline.during = During::Never;
                pipeline.refits = Refits::Passes(refits);
                pipeline.joint = Some(1);
            }
            _ => {
                // No final stage: the pipeline's refits and joint pass go
                // unused, so clear them for the header to show what runs.
                pipeline.during = During::Never;
                pipeline.refits = Refits::Passes(0);
                pipeline.joint = None;
            }
        }
        if let Some(during) = self.during {
            pipeline.during = during;
        }
        if let Some(refits) = self.final_refits {
            pipeline.refits = refits;
        }
        if let Some(scale) = self.joint_scale {
            pipeline.joint = (scale > 0).then_some(scale);
        }
        pipeline.joint_settings = self.joint_settings;
        pipeline
    }
}

fn parse_during(value: &str) -> Result<During, BoxError> {
    let invalid = || {
        format!(
            "--during: expected none, every:K, spaced:K:C, joint:K:C:I or joint-export:K:C:I, \
             got {value}"
        )
    };
    let numbers: Vec<u32> = value
        .split(':')
        .skip(1)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| invalid())?;
    if numbers.contains(&0) {
        return Err(invalid().into());
    }
    match (value.split(':').next(), numbers.as_slice()) {
        (Some("none"), []) => Ok(During::Never),
        (Some("every"), &[every]) => Ok(During::Every(every)),
        (Some("spaced"), &[interval, divisor]) => Ok(During::Spaced { interval, divisor }),
        (Some(name @ ("joint" | "joint-export")), &[interval, divisor, iterations]) => {
            Ok(During::Joint {
                interval,
                divisor,
                iterations,
                guard: if name == "joint" {
                    Guard::Canvas
                } else {
                    Guard::Export
                },
            })
        }
        _ => Err(invalid().into()),
    }
}

fn parse_refits(value: &str) -> Result<Refits, BoxError> {
    let invalid = || format!("--final-refits: expected R or until:G:C, got {value}");
    if let Some(rest) = value.strip_prefix("until:") {
        let (gain, cap) = rest.split_once(':').ok_or_else(invalid)?;
        return Ok(Refits::Until {
            min_gain: gain.parse().map_err(|_| invalid())?,
            cap: cap.parse().map_err(|_| invalid())?,
        });
    }
    Ok(Refits::Passes(value.parse().map_err(|_| invalid())?))
}

/// The error of a value of `flag` that is not `expected`.
fn invalid(flag: &str, value: &str, expected: &str) -> BoxError {
    format!("{flag}: expected {expected}, got {value}").into()
}

/// The `N` colon-separated fields of `value`, the value of `flag`, each
/// parsed as a `T`, or [`invalid`] if there are not `N` or one does not
/// parse.
fn parse_fields<T: std::str::FromStr, const N: usize>(
    flag: &str,
    value: &str,
    expected: &str,
) -> Result<[T; N], BoxError> {
    let fields: Vec<T> = value
        .split(':')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| invalid(flag, value, expected))?;
    fields
        .try_into()
        .map_err(|_| invalid(flag, value, expected))
}

fn parse_effort(value: &str) -> Result<(u64, usize, usize), BoxError> {
    let (flag, expected) = ("--effort", "R:C:A, all positive");
    let fields: [usize; 3] = parse_fields(flag, value, expected)?;
    if fields.contains(&0) {
        return Err(invalid(flag, value, expected));
    }
    let [rounds, candidates, age] = fields;
    Ok((rounds as u64, candidates, age))
}

/// The keys of `--search`, each `None` when not given.
#[derive(Clone, Copy, Debug, Default)]
struct SearchArgs {
    seeds: Option<usize>,
    candidates: Option<usize>,
    age: Option<usize>,
}

impl SearchArgs {
    /// The model's setting.
    fn setting(self) -> Search {
        Search {
            seeds: self.seeds,
            candidates: self.candidates,
            age: self.age,
        }
    }

    /// The keys given, as the header spells them.
    fn describe(self) -> String {
        let mut parts = Vec::new();
        for (key, value) in [
            ("seeds", self.seeds),
            ("candidates", self.candidates),
            ("age", self.age),
        ] {
            if let Some(value) = value {
                parts.push(format!("{key} {value}"));
            }
        }
        parts.join(", ")
    }
}

fn parse_search(value: &str) -> Result<SearchArgs, BoxError> {
    let invalid = || {
        format!(
            "--search: expected KEY=VALUE[,KEY=VALUE...] with seeds=K, candidates=N, \
             age=A (positive), got {value}"
        )
    };
    let mut search = SearchArgs::default();
    for pair in value.split(',') {
        let (key, value) = pair.split_once('=').ok_or_else(invalid)?;
        let positive = || match value.parse::<usize>() {
            Ok(number) if number > 0 => Ok(Some(number)),
            _ => Err(invalid()),
        };
        match key {
            "seeds" => search.seeds = positive()?,
            "candidates" => search.candidates = positive()?,
            "age" => search.age = positive()?,
            _ => return Err(invalid().into()),
        }
    }
    Ok(search)
}

fn parse_refine_effort(value: &str) -> Result<(u64, usize), BoxError> {
    let (flag, expected) = ("--refine-effort", "R:A, both positive");
    let fields: [usize; 2] = parse_fields(flag, value, expected)?;
    if fields.contains(&0) {
        return Err(invalid(flag, value, expected));
    }
    let [rounds, age] = fields;
    Ok((rounds as u64, age))
}

fn parse_quadratic_width(value: &str) -> Result<(f64, f64), BoxError> {
    let (flag, expected) = ("--quadratic-width", "MIN:MAX with 1 <= MIN <= MAX");
    let [min, max]: [f64; 2] = parse_fields(flag, value, expected)?;
    if !(min >= 1.0 && min <= max && max.is_finite()) {
        return Err(invalid(flag, value, expected));
    }
    Ok((min, max))
}

fn parse_quadratic_cap(value: &str) -> Result<LineCap, BoxError> {
    value
        .parse()
        .map_err(|_| invalid("--quadratic-cap", value, "butt, round or square"))
}

/// A positive, finite value of `flag`.
fn parse_positive(flag: &str, value: &str) -> Result<f64, BoxError> {
    match value.parse::<f64>() {
        Ok(number) if number.is_finite() && number > 0.0 => Ok(number),
        _ => Err(format!("{flag}: expected a positive number, got {value}").into()),
    }
}

fn describe_pipeline(pipeline: Pipeline, iterations: Option<u32>) -> String {
    let during = match pipeline.during {
        During::Never => "none".to_owned(),
        During::Every(every) => format!("every:{every}"),
        During::Spaced { interval, divisor } => format!("spaced:{interval}:{divisor}"),
        During::Joint {
            interval,
            divisor,
            iterations,
            guard,
        } => {
            let name = match guard {
                Guard::Canvas => "joint",
                Guard::Export => "joint-export",
            };
            format!("{name}:{interval}:{divisor}:{iterations}")
        }
    };
    let refits = match pipeline.refits {
        Refits::Passes(passes) => format!("{passes}"),
        Refits::Until { min_gain, cap } => format!("until:{min_gain}:{cap}"),
    };
    let joint = match (pipeline.joint, iterations) {
        (Some(_), Some(iterations)) => format!("{iterations} iterations"),
        (Some(scale), None) => format!("x{scale}"),
        (None, Some(_)) => "none (--iterations ignored)".to_owned(),
        (None, None) => "none".to_owned(),
    };
    let default = joint::Tuning::default();
    let settings = pipeline.joint_settings;
    let mut tuning = String::new();
    if settings.tuning.warmup != default.warmup {
        tuning += &format!(", warmup {}", settings.tuning.warmup);
    }
    if settings.tuning.step != default.step {
        tuning += &format!(", step {}", settings.tuning.step);
    }
    if let Some(fraction) = settings.tuning.relative_step {
        tuning += &format!(", step-rel {fraction}");
    }
    if !settings.curved {
        tuning += ", fixed curved";
    }
    format!("during {during}, final refits {refits}, joint {joint}{tuning}")
}

/// When the search runs refit passes; see the doc comment.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Refine {
    None,
    /// Passes on a clone at each checkpoint.
    End(u32),
    /// One pass after every this many steps.
    Every(u32),
    /// `approximate`'s passes during the search, and its final stage on a
    /// clone at each checkpoint.
    Final,
    /// This many refit passes, then the joint optimisation, on a clone at
    /// each checkpoint.
    Joint(u32),
}

impl Refine {
    /// Whether each checkpoint runs `approximate`'s final stage.
    fn has_final_stage(self) -> bool {
        matches!(self, Self::Final | Self::Joint(_))
    }

    fn parse(value: &str) -> Result<Self, BoxError> {
        let invalid =
            || format!("--refine: expected end:P, every:K, final or joint:R, got {value}");
        if value == "final" {
            return Ok(Self::Final);
        }
        let (schedule, count) = value.split_once(':').ok_or_else(invalid)?;
        let count: u32 = count.parse().map_err(|_| invalid())?;
        if schedule == "joint" {
            return Ok(Self::Joint(count));
        }
        if count == 0 {
            return Err(invalid().into());
        }
        match schedule {
            "end" => Ok(Self::End(count)),
            "every" => Ok(Self::Every(count)),
            _ => Err(invalid().into()),
        }
    }

    fn describe(self) -> String {
        match self {
            Self::None => "none".to_owned(),
            Self::End(passes) => format!("end:{passes} ({passes} passes at each checkpoint)"),
            Self::Every(steps) => format!("every:{steps} (one pass after every {steps} steps)"),
            Self::Final => {
                "final (approximate's pipeline: its passes during the search, its final \
                            stage at each checkpoint)"
                    .to_owned()
            }
            Self::Joint(refits) => format!(
                "joint:{refits} ({refits} refit passes, then the joint optimisation of the \
                 shapes (curved shapes move by default; quadratics keep their geometry), \
                 at each checkpoint)"
            ),
        }
    }
}

struct Row {
    image: String,
    shape: &'static str,
    steps: u32,
    search: Duration,
    refine: Duration,
    score: f64,
    rmse256: f64,
    gap: f64,
    ssim128: f64,
    ssim1024: f64,
    svg_bytes: usize,
    violations: usize,
    adopted: Option<(u32, u32)>,
    final_joint: Option<Chosen>,
}

fn main() -> Result<(), BoxError> {
    let config = parse_args(std::env::args().skip(1))?;
    let inputs = common::load_inputs(&config.photos, config.synthetic)?;

    let mut rows = Vec::new();
    for input in &inputs {
        let original = image::load_from_memory(&input.bytes)?.to_rgb8();
        let mut small_reference: Option<RgbImage> = None;
        let mut output_reference: Option<RgbImage> = None;
        for &shape in &config.shapes {
            eprintln!("{} {}", input.name, shape.as_str());
            for checkpoint in search(input, shape, &config)? {
                let small_reference =
                    small_reference.get_or_insert_with(|| resampled(&original, &checkpoint.small));
                let output_reference = output_reference
                    .get_or_insert_with(|| resampled(&original, &checkpoint.output));
                rows.push(Row {
                    image: input.name.clone(),
                    shape: shape.as_str(),
                    steps: checkpoint.steps,
                    search: checkpoint.search,
                    refine: checkpoint.refine,
                    score: checkpoint.score,
                    rmse256: checkpoint.rmse256,
                    gap: checkpoint.rmse256 / checkpoint.score - 1.0,
                    ssim128: lab::ssim(&checkpoint.small, small_reference),
                    ssim1024: lab::ssim(&checkpoint.output, output_reference),
                    svg_bytes: checkpoint.svg_bytes,
                    violations: checkpoint.violations,
                    adopted: checkpoint.adopted,
                    final_joint: checkpoint.final_joint,
                });
            }
        }
    }
    rows.sort_by(|left, right| {
        (&left.image, left.shape, left.steps).cmp(&(&right.image, right.shape, right.steps))
    });

    let refined = config.refine != Refine::None;
    print_header(&config);
    let (refine_head, refine_rule) = if refined {
        (" refine_s |", " ---: |")
    } else {
        ("", "")
    };
    println!(
        "| image | shape | steps | search_s |{refine_head} score | rmse256 | gap | ssim128 | \
         ssim1024 | svg_bytes | adopted | final_joint |"
    );
    println!(
        "| --- | --- | ---: | ---: |{refine_rule} ---: | ---: | ---: | ---: | ---: | ---: | ---: | \
         --- |"
    );
    for row in &rows {
        let refine = if refined {
            format!(" {:.3} |", row.refine.as_secs_f64())
        } else {
            String::new()
        };
        let adopted = row
            .adopted
            .map_or_else(String::new, |(kept, ran)| format!("{kept}/{ran}"));
        let final_joint = match row.final_joint {
            Some(Chosen::Joint) => "kept",
            Some(Chosen::Input) => "input",
            Some(Chosen::Refitted) | None => "",
        };
        println!(
            "| {} | {} | {} | {:.3} |{refine} {:.6} | {:.6} | {:+.4} | {:.6} | {:.6} | {} | {adopted} | \
             {final_joint} |",
            row.image,
            row.shape,
            row.steps,
            row.search.as_secs_f64(),
            row.score,
            row.rmse256,
            row.gap,
            row.ssim128,
            row.ssim1024,
            row.svg_bytes
        );
    }
    println!();
    print_summary(&rows, &config.checkpoints, refined);
    println!();
    print_kind_summary(&rows, &config.checkpoints, refined);
    Ok(())
}

/// `original` resampled with Catmull-Rom to the dimensions of `rendered`.
fn resampled(original: &RgbImage, rendered: &RgbImage) -> RgbImage {
    imageops::resize(
        original,
        rendered.width(),
        rendered.height(),
        imageops::FilterType::CatmullRom,
    )
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config, BoxError> {
    let mut photos = Vec::new();
    let mut synthetic = true;
    let mut quick = false;
    let mut shapes = None;
    let mut checkpoints: Option<Vec<u32>> = None;
    let mut refine = Refine::None;
    let mut iterations = None;
    let mut during = None;
    let mut final_refits = None;
    let mut joint_scale = None;
    let mut effort = None;
    let mut search = None;
    let mut refine_effort = None;
    let mut quadratic_width = None;
    let mut quadratic_cap = None;
    let mut save = None;
    let mut joint_settings = joint::Settings::default();
    let mut joint_option = None;
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        if matches!(
            arg.as_str(),
            "--joint-warmup" | "--joint-step" | "--joint-step-rel" | "--joint-curved"
        ) {
            joint_option = Some(arg.clone());
        }
        match arg.as_str() {
            "--quick" => quick = true,
            "--no-synthetic" => synthetic = false,
            "--image" => photos.push(PathBuf::from(value()?)),
            "--shapes" => {
                shapes = Some(
                    value()?
                        .split(',')
                        .map(str::parse)
                        .collect::<Result<_, _>>()?,
                );
            }
            "--steps" => {
                checkpoints = Some(
                    value()?
                        .split(',')
                        .map(str::parse)
                        .collect::<Result<_, _>>()?,
                );
            }
            "--refine" => refine = Refine::parse(&value()?)?,
            "--iterations" => iterations = Some(value()?.parse()?),
            "--during" => during = Some(parse_during(&value()?)?),
            "--final-refits" => final_refits = Some(parse_refits(&value()?)?),
            "--joint-scale" => joint_scale = Some(value()?.parse()?),
            "--joint-warmup" => joint_settings.tuning.warmup = value()?.parse()?,
            "--joint-step" => joint_settings.tuning.step = parse_positive(&arg, &value()?)?,
            "--joint-step-rel" => {
                joint_settings.tuning.relative_step = Some(parse_positive(&arg, &value()?)?);
            }
            "--joint-curved" => {
                joint_settings.curved = match value()?.as_str() {
                    "on" => true,
                    "off" => false,
                    other => {
                        return Err(format!("--joint-curved takes on or off, not {other}").into());
                    }
                };
            }
            "--effort" => effort = Some(parse_effort(&value()?)?),
            "--search" => search = Some(parse_search(&value()?)?),
            "--refine-effort" => refine_effort = Some(parse_refine_effort(&value()?)?),
            "--quadratic-width" => quadratic_width = Some(parse_quadratic_width(&value()?)?),
            "--quadratic-cap" => quadratic_cap = Some(parse_quadratic_cap(&value()?)?),
            "--save" => save = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown argument {other}; see the doc comment").into()),
        }
    }
    if photos.is_empty() {
        photos = common::default_photos();
    }
    let shapes = shapes.unwrap_or_else(|| {
        if quick {
            vec![ShapeKind::Any]
        } else {
            ALL_SHAPES.to_vec()
        }
    });
    let mut checkpoints = checkpoints.unwrap_or_else(|| {
        if quick {
            QUICK_CHECKPOINTS.to_vec()
        } else {
            DEFAULT_CHECKPOINTS.to_vec()
        }
    });
    checkpoints.sort_unstable();
    checkpoints.dedup();
    if checkpoints.first() == Some(&0) {
        return Err("--steps: checkpoints must be positive".into());
    }
    if iterations.is_some() && !refine.has_final_stage() {
        return Err("--iterations needs --refine final or joint:R".into());
    }
    if (final_refits.is_some() || joint_scale.is_some()) && !refine.has_final_stage() {
        return Err("--final-refits and --joint-scale need --refine final or joint:R".into());
    }
    if let Some(option) = joint_option
        && !refine.has_final_stage()
        && !matches!(during, Some(During::Joint { .. }))
    {
        return Err(format!(
            "{option} needs --refine final or joint:R or --during joint:K:C:I or joint-export:K:C:I"
        )
        .into());
    }
    if during.is_some() && matches!(refine, Refine::Every(_)) {
        return Err("--during cannot be combined with --refine every:K".into());
    }
    Ok(Config {
        photos,
        synthetic,
        shapes,
        checkpoints,
        refine,
        iterations,
        during,
        final_refits,
        joint_scale,
        joint_settings,
        effort,
        search,
        refine_effort,
        quadratic_width,
        quadratic_cap,
        save,
    })
}

/// The state of one search at one checkpoint.
struct Checkpoint {
    steps: u32,
    search: Duration,
    refine: Duration,
    score: f64,
    rmse256: f64,
    /// The PNG at [`SMALL_SIZE`].
    small: RgbImage,
    /// The PNG at the default output size.
    output: RgbImage,
    svg_bytes: usize,
    violations: usize,
    /// The joint passes during the search so far, kept and run, if the
    /// schedule has any.
    adopted: Option<(u32, u32)>,
    /// Which drawing the final stage returned, with `--refine final` or
    /// `joint:R`.
    final_joint: Option<Chosen>,
}

/// Runs one search of `shape` to the last of the checkpoints (sorted,
/// unique and positive) exactly as `approximate` would, with the refit
/// passes, pipeline and effort of `config`, and records each checkpoint,
/// writing its PNG and SVG with `--save`.
fn search(
    input: &common::Input,
    shape: ShapeKind,
    config: &Config,
) -> Result<Vec<Checkpoint>, BoxError> {
    let (name, input) = (&input.name, &input.bytes[..]);
    let (checkpoints, refine, iterations) = (&config.checkpoints, config.refine, config.iterations);
    let pipeline = config.pipeline(shape);
    let last = *checkpoints.last().ok_or("--steps: no checkpoints")?;
    let mut render = RenderOptions::default();
    render.count = last;
    render.shape = shape;
    render.seed = Some(SEED);

    let (working, background) = lab::working_image(input, &render)?;
    let target = Buffer::from_rgb(working.width(), working.height(), working.as_raw().clone())
        .ok_or("the working image has an invalid pixel length")?;
    let working_size = working.width().max(working.height());
    let mut options = ModelOptions::default();
    options.seed = render.seed;
    let mut model = Model::new(target, background, options);
    if let Some((rounds, candidates, age)) = config.effort {
        model.set_search_effort(rounds, candidates, age);
    }
    if let Some(search) = config.search {
        model.set_search(search.setting());
    }
    if let Some((rounds, age)) = config.refine_effort {
        model.set_refine_effort(rounds, age);
    }
    if let Some((min, max)) = config.quadratic_width {
        model.set_quadratic_width(min, max);
    }
    if let Some(cap) = config.quadratic_cap {
        model.set_quadratic_cap(cap);
    }
    if let Some(dir) = &config.save {
        std::fs::create_dir_all(dir)?;
    }

    let mut search = Duration::ZERO;
    let mut refined = Duration::ZERO;
    let mut adopted = matches!(pipeline.during, During::Joint { .. }).then_some((0, 0));
    let mut recorded = Vec::with_capacity(checkpoints.len());
    let mut next = checkpoints.iter().copied().peekable();
    for step in 1..=last {
        let start = Instant::now();
        model.step(render.shape, render.alpha);
        search += start.elapsed();
        if let Refine::Every(every) = refine
            && step % every == 0
        {
            let start = Instant::now();
            model.refine(render.alpha);
            let elapsed = start.elapsed();
            search += elapsed;
            refined += elapsed;
        }
        let start = Instant::now();
        let pass = lab::after_step(&mut model, pipeline, step, render.alpha);
        if pass.ran() {
            let elapsed = start.elapsed();
            search += elapsed;
            refined += elapsed;
        }
        if let (Pass::Joint { kept }, Some((adopted, ran))) = (pass, adopted.as_mut()) {
            *adopted += u32::from(kept);
            *ran += 1;
        }

        if next.next_if_eq(&step).is_none() {
            continue;
        }
        let mut final_joint = None;
        let (drawing, score, search, refined) = match refine {
            Refine::End(passes) => {
                let mut clone = model.clone();
                let start = Instant::now();
                for _ in 0..passes {
                    clone.refine(render.alpha);
                }
                let elapsed = start.elapsed();
                (
                    clone.drawing(),
                    clone.score_f64(),
                    search + elapsed,
                    refined + elapsed,
                )
            }
            Refine::Final | Refine::Joint(_) => {
                let mut clone = model.clone();
                let start = Instant::now();
                let (drawing, score, chosen) =
                    lab::final_stage(&mut clone, &render, pipeline, iterations);
                let elapsed = start.elapsed();
                final_joint = Some(chosen);
                (drawing, score, search + elapsed, refined + elapsed)
            }
            Refine::None | Refine::Every(_) => {
                (model.drawing(), model.score_f64(), search, refined)
            }
        };
        let exported = png(&drawing, working_size)?;
        assert_eq!(
            exported.dimensions(),
            working.dimensions(),
            "the PNG at the working size must have the working target's dimensions"
        );
        let svg = lab::encode(&drawing, render.output_size, OutputFormat::Svg)?.into_bytes();
        let output_png = lab::encode(&drawing, render.output_size, OutputFormat::Png)?.into_bytes();
        if let Some(dir) = &config.save {
            save(
                dir,
                &format!("{name}-{}-{step}", shape.as_str()),
                &output_png,
                &svg,
            )?;
        }
        recorded.push(Checkpoint {
            steps: step,
            search,
            refine: refined,
            score,
            rmse256: rgb_rmse(&exported, &working),
            small: png(&drawing, SMALL_SIZE)?,
            output: image::load_from_memory_with_format(&output_png, ImageFormat::Png)?.to_rgb8(),
            svg_bytes: svg.len(),
            violations: violations(&drawing, render.shape),
            adopted,
            final_joint,
        });
    }
    Ok(recorded)
}

/// The shapes of `drawing`, a drawing of `kind`, that break the
/// legibility rules: triangles with an angle of 15° or less;
/// quadrilaterals that are not strictly convex (their diagonals do not
/// cross strictly inside both) or have an angle of 15° or less; rectangles
/// with a side under 1 px or a long side more than 8 times the short one,
/// up to a relative `1e-9`, the rounding of computed corners. The
/// quadrilaterals of `rotated-rectangle` must be rectangles, every angle
/// within `1e-6`° of 90°, and so are taken those of `any` that are.
/// Angles by `acos`, independently of the engine's checks.
fn violations(drawing: &Drawing, kind: ShapeKind) -> usize {
    let bad_sides = |a: f64, b: f64| {
        let (long, short) = (a.max(b), a.min(b));
        short < 1.0 - 1e-9 || long > 8.0 * short * (1.0 + 1e-9)
    };
    drawing
        .shapes
        .iter()
        .filter(|shape| {
            let points = match &shape.geometry {
                Geometry::Polygon(points) => points,
                &Geometry::Rect { width, height, .. } => return bad_sides(width, height),
                _ => return false,
            };
            let n = points.len();
            let angles: Vec<f64> = (0..n)
                .map(|p| {
                    let (a, b, c) = (points[(p + n - 1) % n], points[p], points[(p + 1) % n]);
                    let (ux, uy, wx, wy) = (c.x - b.x, c.y - b.y, a.x - b.x, a.y - b.y);
                    let lengths = ux.hypot(uy) * wx.hypot(wy);
                    if lengths == 0.0 {
                        0.0
                    } else {
                        ((ux * wx + uy * wy) / lengths)
                            .clamp(-1.0, 1.0)
                            .acos()
                            .to_degrees()
                    }
                })
                .collect();
            let sharp = angles.iter().any(|&angle| angle <= 15.0);
            let right = n == 4 && angles.iter().all(|angle| (angle - 90.0).abs() <= 1e-6);
            let rectangle = right && {
                let side = |p: usize, q: usize| {
                    (points[q].x - points[p].x).hypot(points[q].y - points[p].y)
                };
                !bad_sides(side(0, 1), side(1, 2))
            };
            if kind == ShapeKind::RotatedRectangle && !rectangle {
                return true;
            }
            if right && !rectangle {
                return true;
            }
            let convex = n != 4 || {
                let (p, r) = (
                    points[0],
                    (points[2].x - points[0].x, points[2].y - points[0].y),
                );
                let (q, s) = (
                    points[1],
                    (points[3].x - points[1].x, points[3].y - points[1].y),
                );
                let denominator = r.0 * s.1 - r.1 * s.0;
                denominator != 0.0 && {
                    let t = ((q.x - p.x) * s.1 - (q.y - p.y) * s.0) / denominator;
                    let u = ((q.x - p.x) * r.1 - (q.y - p.y) * r.0) / denominator;
                    t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0
                }
            };
            sharp || !convex
        })
        .count()
}

/// Writes `png` and `svg` as `dir/<stem>.png` and `dir/<stem>.svg`.
fn save(dir: &Path, stem: &str, png: &[u8], svg: &[u8]) -> Result<(), BoxError> {
    std::fs::write(dir.join(format!("{stem}.png")), png)?;
    std::fs::write(dir.join(format!("{stem}.svg")), svg)?;
    Ok(())
}

/// `drawing` encoded as a PNG at `output_size` and decoded again.
fn png(drawing: &Drawing, output_size: u32) -> Result<RgbImage, BoxError> {
    let bytes = lab::encode(drawing, output_size, OutputFormat::Png)?.into_bytes();
    Ok(image::load_from_memory_with_format(&bytes, ImageFormat::Png)?.to_rgb8())
}

fn print_header(config: &Config) {
    let (checkpoints, refine, iterations) = (&config.checkpoints, config.refine, config.iterations);
    let defaults = RenderOptions::default();
    println!("# primeval engine run");
    println!();
    common::print_commit_and_machine();
    println!(
        "- options: seed {SEED}, resize_input {}, output_size {} (ssim128 at {SMALL_SIZE}), \
         alpha auto, background auto, {} threads",
        defaults.resize_input,
        defaults.output_size,
        rayon::current_num_threads()
    );
    let checkpoints: Vec<String> = checkpoints.iter().map(u32::to_string).collect();
    println!("- checkpoints: {} steps", checkpoints.join(", "));
    if refine != Refine::None {
        println!("- refine: {}", refine.describe());
    }
    for &shape in &config.shapes {
        println!(
            "- pipeline of {}: {}",
            shape.as_str(),
            describe_pipeline(config.pipeline(shape), iterations)
        );
    }
    if let Some((rounds, candidates, age)) = config.effort {
        println!("- search effort: {rounds} rounds, candidates x{candidates}, climb age x{age}");
    }
    if let Some(search) = config.search {
        println!("- search: {}", search.describe());
    }
    if let Some((rounds, age)) = config.refine_effort {
        println!("- refine effort: {rounds} climbs per layer, climb age {age}");
    }
    if let Some((min, max)) = config.quadratic_width {
        println!("- quadratic width: {min} to {max} px");
    }
    if let Some(cap) = config.quadratic_cap {
        println!("- quadratic cap: {}", cap.as_str());
    }
    println!();
}

fn print_summary(rows: &[Row], checkpoints: &[u32], refined: bool) {
    println!("Summary per checkpoint, over all rows:");
    println!();
    let (refine_head, refine_rule) = if refined {
        (" total refine_s |", " ---: |")
    } else {
        ("", "")
    };
    println!(
        "| steps | rows | mean score | median score | median rmse256 | median gap | mean ssim128 \
         | mean ssim1024 | mean svg_bytes | total search_s |{refine_head}"
    );
    println!(
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |{refine_rule}"
    );
    for &steps in checkpoints {
        let group: Vec<&Row> = rows.iter().filter(|row| row.steps == steps).collect();
        if group.is_empty() {
            continue;
        }
        let search: Duration = group.iter().map(|row| row.search).sum();
        let refine = if refined {
            let refine: Duration = group.iter().map(|row| row.refine).sum();
            format!(" {:.3} |", refine.as_secs_f64())
        } else {
            String::new()
        };
        println!(
            "| {steps} | {} | {:.6} | {:.6} | {:.6} | {:+.4} | {:.6} | {:.6} | {:.1} | {:.3} |{refine}",
            group.len(),
            mean(&group, |row| row.score),
            median(&group, |row| row.score),
            median(&group, |row| row.rmse256),
            median(&group, |row| row.gap),
            mean(&group, |row| row.ssim128),
            mean(&group, |row| row.ssim1024),
            mean(&group, |row| row.svg_bytes as f64),
            search.as_secs_f64(),
        );
    }
}

fn print_kind_summary(rows: &[Row], checkpoints: &[u32], refined: bool) {
    println!("Summary per shape kind and checkpoint:");
    println!();
    let (refine_head, refine_rule) = if refined {
        (" total refine_s |", " ---: |")
    } else {
        ("", "")
    };
    println!(
        "| shape | steps | median score | median rmse256 | median gap | median ssim128 \
         | mean svg_bytes | total search_s |{refine_head} violations |"
    );
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |{refine_rule} ---: |");
    for shape in ALL_SHAPES.map(ShapeKind::as_str) {
        for &steps in checkpoints {
            let group: Vec<&Row> = rows
                .iter()
                .filter(|row| row.shape == shape && row.steps == steps)
                .collect();
            if group.is_empty() {
                continue;
            }
            let search: Duration = group.iter().map(|row| row.search).sum();
            let refine = if refined {
                let refine: Duration = group.iter().map(|row| row.refine).sum();
                format!(" {:.3} |", refine.as_secs_f64())
            } else {
                String::new()
            };
            println!(
                "| {shape} | {steps} | {:.6} | {:.6} | {:+.4} | {:.6} | {:.1} | {:.3} |{refine} {} |",
                median(&group, |row| row.score),
                median(&group, |row| row.rmse256),
                median(&group, |row| row.gap),
                median(&group, |row| row.ssim128),
                mean(&group, |row| row.svg_bytes as f64),
                search.as_secs_f64(),
                group.iter().map(|row| row.violations).sum::<usize>(),
            );
        }
    }
}

/// The mean of `metric` over `group`, which is not empty.
fn mean(group: &[&Row], metric: fn(&Row) -> f64) -> f64 {
    group.iter().map(|row| metric(row)).sum::<f64>() / group.len() as f64
}

/// The median of `metric` over `group`, which is not empty: the middle
/// value, or the mean of the two middle values for an even count.
fn median(group: &[&Row], metric: fn(&Row) -> f64) -> f64 {
    let mut values: Vec<f64> = group.iter().map(|row| metric(row)).collect();
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        values[middle]
    } else {
        (values[middle - 1] + values[middle]) / 2.0
    }
}
