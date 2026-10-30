//! High-level render facade for `primeval`.
//!
//! This crate handles the full decode -> optimize -> encode path on top of
//! `primeval-core`. It takes encoded image bytes (JPEG, PNG, or WebP), runs the
//! approximation search (greedy steps, then a final stage that revises every
//! shape), and returns SVG or PNG output. Reading files is up to the caller.
//!
//! The Node package and napi binding in this repository build on the same API.
//! If you want the canonical Rust-side defaults and validation behavior, this is
//! the crate to call. `docs/architecture.md` in the repository describes how
//! it fits with the engine, the bindings and the package.
//!
//! # Example
//!
//! ```no_run
//! use primeval_render::{
//!     approximate, ApproximateRequest, ApproximateResult, Execution, OutputFormat,
//!     ProgressInfo, RenderOptions,
//! };
//!
//! let mut render = RenderOptions::default();
//! render.count = 100;
//! render.resize_input = 128;
//! render.output_size = 512;
//!
//! // Each step's shape is the SVG element it adds, in the output's `viewBox`:
//! // a live preview that the final stage can revise.
//! let mut shapes = Vec::new();
//! let mut on_progress = |info: ProgressInfo| shapes.push(info.shape);
//! let result = approximate(
//!     ApproximateRequest {
//!         input: std::fs::read("photo.jpg")?,
//!         output: OutputFormat::Svg,
//!         render,
//!     },
//!     Execution::new().progress(&mut on_progress),
//! )?;
//!
//! match result {
//!     ApproximateResult::Svg { data, .. } => std::fs::write("out.svg", data)?,
//!     _ => unreachable!("requested svg output"),
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#![warn(missing_docs)]

#[cfg(feature = "bench")]
mod benches;
mod error;
mod input;
#[cfg(any(test, feature = "lab"))]
#[doc(hidden)]
pub mod lab;
mod output;
mod pipeline;
mod raster;
mod svg;

use image::{DynamicImage, ImageReader, Limits, RgbImage, RgbaImage};
use input::{average_background, thumbnail};
use output::output_dimensions;
use primeval_core::{Buffer, Drawing, Model, ModelOptions};
use std::io::Cursor;
use std::num::NonZeroU8;
use std::ops::RangeInclusive;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub use error::{ApproximateError, BoxedSource, RenderOption};
pub use output::OutputFormat;
pub use primeval_core::{Alpha, Color, ParseError, ShapeKind};

/// Accepted values of [`RenderOptions::count`]. The full representation range
/// is accepted; the caller controls work and cancellation, without truncation.
pub const COUNT_RANGE: RangeInclusive<u32> = 1..=u32::MAX;

/// Accepted values of [`RenderOptions::resize_input`]. The engine needs at
/// least 2 pixels per side; the cap bounds the working buffers (a 2048 x
/// 2048 canvas is 12 MiB per RGB buffer plus 128 MiB of per-row prefix
/// sums) and the per-step cost.
pub const RESIZE_INPUT_RANGE: RangeInclusive<u32> = 2..=2048;

/// Accepted values of [`RenderOptions::output_size`]. The cap bounds the PNG
/// raster: an 8192 x 8192 output needs 256 MiB of RGBA plus 192 MiB of RGB.
pub const OUTPUT_SIZE_RANGE: RangeInclusive<u32> = 2..=8192;

/// Largest width or height a decoded input may have.
pub const MAX_INPUT_SIDE: u32 = 16_384;

/// Most memory the decoder may allocate for one input, in bytes (512 MiB).
pub const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;

/// The largest integer an `f64` represents exactly together with all smaller
/// ones (JavaScript's `Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Background color strategy for the initial canvas.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BackgroundOption {
    /// Derive the background color from the input image.
    #[default]
    Auto,
    /// Fit premultiplied RGBA on a transparent canvas (site extension).
    Transparent,
    /// RGBA extension initialized by the full opaque pipeline.
    TransparentReference,
    /// Use an explicit opaque color (alpha 255).
    Color(Color),
}

impl FromStr for BackgroundOption {
    type Err = ParseError;

    /// Parses `auto` or an opaque hex color (`RGB` or `RRGGBB`, optional
    /// leading `#`).
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value == "auto" {
            return Ok(Self::Auto);
        }
        if value == "transparent" { return Ok(Self::Transparent); }
        if value == "transparent-reference" { return Ok(Self::TransparentReference); }

        Color::from_hex(value).map(Self::Color).ok_or_else(|| {
            ParseError::new(format!(
                "background {}",
                RenderOption::Background.requirement()
            ))
        })
    }
}

/// Render-time knobs that control optimization and final export.
///
/// Start from [`RenderOptions::default`] and set the fields you need, or
/// apply a [`PartialRenderOptions`] with [`RenderOptions::merge`].
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RenderOptions {
    /// Number of optimization steps, within [`COUNT_RANGE`].
    pub count: u32,
    /// Shape family to search during each step.
    pub shape: ShapeKind,
    /// Alpha handling for new shapes.
    pub alpha: Alpha,
    /// Deterministic RNG seed. `None` chooses a non-deterministic seed.
    pub seed: Option<u64>,
    /// Background fill strategy. An explicit color must be opaque.
    pub background: BackgroundOption,
    /// Working resolution used during optimization, within
    /// [`RESIZE_INPUT_RANGE`].
    pub resize_input: u32,
    /// Length of the output's longer side, within [`OUTPUT_SIZE_RANGE`]; the
    /// other side keeps the working canvas's aspect ratio.
    pub output_size: u32,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            count: 100,
            shape: ShapeKind::Any,
            alpha: Alpha::Auto,
            seed: None,
            background: BackgroundOption::Auto,
            resize_input: 256,
            output_size: 1024,
        }
    }
}

impl RenderOptions {
    /// Applies every field `partial` sets; fields it leaves `None` keep
    /// their value in `self`.
    #[must_use]
    pub fn merge(self, partial: PartialRenderOptions) -> Self {
        let PartialRenderOptions {
            count,
            shape,
            alpha,
            seed,
            background,
            resize_input,
            output_size,
        } = partial;
        Self {
            count: count.unwrap_or(self.count),
            shape: shape.unwrap_or(self.shape),
            alpha: alpha.unwrap_or(self.alpha),
            seed: seed.or(self.seed),
            background: background.unwrap_or(self.background),
            resize_input: resize_input.unwrap_or(self.resize_input),
            output_size: output_size.unwrap_or(self.output_size),
        }
    }
}

/// [`RenderOptions`] where every field is optional, for callers that pass
/// user input through and leave omitted fields to the Rust defaults.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PartialRenderOptions {
    /// [`RenderOptions::count`], if set.
    pub count: Option<u32>,
    /// [`RenderOptions::shape`], if set.
    pub shape: Option<ShapeKind>,
    /// [`RenderOptions::alpha`], if set.
    pub alpha: Option<Alpha>,
    /// [`RenderOptions::seed`], if set. `None` keeps the base value, so a
    /// partial cannot clear a seed.
    pub seed: Option<u64>,
    /// [`RenderOptions::background`], if set.
    pub background: Option<BackgroundOption>,
    /// [`RenderOptions::resize_input`], if set.
    pub resize_input: Option<u32>,
    /// [`RenderOptions::output_size`], if set.
    pub output_size: Option<u32>,
}

impl PartialRenderOptions {
    /// Sets a numeric option from a host-language number, such as a
    /// JavaScript `number`, without wrapping or truncating it.
    ///
    /// `value` must be an integer the option accepts: [`COUNT_RANGE`],
    /// [`RESIZE_INPUT_RANGE`], [`OUTPUT_SIZE_RANGE`], `1..=255` for `alpha`,
    /// or `0..=2^53 - 1` for `seed` (larger seeds lose precision as an `f64`;
    /// set [`seed`](Self::seed) directly instead).
    ///
    /// # Errors
    ///
    /// Returns [`ApproximateError::InvalidOption`] for a fraction, `NaN`, an
    /// infinity, a value out of range, or an option that is not numeric.
    pub fn set_number(&mut self, option: RenderOption, value: f64) -> Result<(), ApproximateError> {
        let invalid = || ApproximateError::invalid_option(option);
        let integer_in = |min: f64, max: f64| {
            (value.fract() == 0.0 && value >= min && value <= max)
                .then_some(value)
                .ok_or_else(invalid)
        };
        let range = |range: &RangeInclusive<u32>| {
            // The value is an integer within a u32 range, so the cast is exact.
            integer_in(f64::from(*range.start()), f64::from(*range.end())).map(|value| value as u32)
        };
        match option {
            RenderOption::Count => self.count = Some(range(&COUNT_RANGE)?),
            RenderOption::ResizeInput => self.resize_input = Some(range(&RESIZE_INPUT_RANGE)?),
            RenderOption::OutputSize => self.output_size = Some(range(&OUTPUT_SIZE_RANGE)?),
            RenderOption::Alpha => {
                // 1..=255 fits in u8 and is never zero.
                let alpha = integer_in(1.0, 255.0)? as u8;
                self.alpha = Some(Alpha::Fixed(NonZeroU8::new(alpha).ok_or_else(invalid)?));
            }
            // Integers up to 2^53 - 1 convert to u64 exactly.
            RenderOption::Seed => self.seed = Some(integer_in(0.0, MAX_SAFE_INTEGER)? as u64),
            RenderOption::Output | RenderOption::Shape | RenderOption::Background => {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

/// Full request for a single rendered output.
#[derive(Clone, Debug, PartialEq)]
pub struct ApproximateRequest {
    /// Encoded image bytes in JPEG, PNG, or WebP format.
    pub input: Vec<u8>,
    /// The format to encode the result in.
    pub output: OutputFormat,
    /// The search and output settings.
    pub render: RenderOptions,
}

/// Per-step progress information emitted during optimization.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct ProgressInfo {
    /// The step just completed, from `1` to `total`.
    pub step: u32,
    /// The number of steps the render runs, [`RenderOptions::count`].
    pub total: u32,
    /// The difference between the canvas and the working-resolution target
    /// after this step and the in-search passes before it: the RMSE over the
    /// RGB channels divided by 255, from `0.0` (identical) to `1.0`.
    /// The final stage can lower it further, so the result can score lower
    /// than the last step.
    pub score: f64,
    /// The shape this step's greedy search committed, formatted exactly as
    /// a shape line of the SVG output, without the newline, whatever the
    /// output format. Its coordinates are in the SVG's `viewBox`, the
    /// working canvas.
    ///
    /// The shapes of every step, in order, draw a live preview. The render
    /// revises shapes it has already reported: after some steps a refit
    /// pass, which re-optimises one shape at a time, can move, resize and
    /// recolour any shape so far, and after the last step a final stage
    /// can revise every shape, so the result's shape lines can differ from
    /// the preview. For triangles the in-search pass instead jointly
    /// optimises every shape at once, kept only when the working canvas
    /// gets closer to the target; previously reported coordinates can
    /// become multiples of a quarter of a working pixel before the final
    /// stage. For triangles, polygons, rectangles, rotated
    /// rectangles, ellipses and circles the final stage is a joint gradient
    /// optimisation of every shape at once, whose coordinates are multiples
    /// of a quarter of a working pixel, and of half a pixel for rectangles,
    /// as are an ellipse's or a circle's centre and radii, while a rotated
    /// rectangle's corners are computed from such values, so the result's
    /// coordinates can be fractional. For [`ShapeKind::Any`] it is one
    /// refit pass, then the same optimisation of every shape but the
    /// quadratics, which keep their geometry, a rotated ellipse's larger
    /// radius and rotation being computed from its optimised axis, so not
    /// on that lattice. The optimisation's result is kept only if
    /// the PNG output at the working size is closer to the target than with
    /// the shapes before it; otherwise the stage keeps those, with
    /// coordinates not rounded to that lattice. For
    /// [`ShapeKind::Quadratic`] it is refit passes until one lowers the
    /// score by less than 1%, at most four. For
    /// [`ShapeKind::RotatedEllipse`] it is one refit pass. The passes and the stage keep the shapes' number, their
    /// order and each shape's kind; an ellipse whose radii a pass makes
    /// equal (or unequal) is written as a `<circle>` (or an `<ellipse>`),
    /// so those two element names can swap.
    pub shape: String,
}

/// A cheap-to-clone handle that cancels a running [`approximate`] call.
///
/// Clones share the same flag. The render checks it before and after
/// decoding, before every step, between the layers of every refit pass,
/// inside in-search and final joint passes (before every iteration and
/// before the snap), and before encoding.
#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    /// A token that is not cancelled.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests cancellation of every render that holds a clone of this token.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether [`cancel`](Self::cancel) was called on this token or a clone.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// How [`approximate`] reports progress and learns about cancellation.
///
/// `Execution::new()` reports nothing and cannot be cancelled.
#[derive(Default)]
pub struct Execution<'a> {
    progress: Option<&'a mut dyn FnMut(ProgressInfo)>,
    cancel: Option<&'a CancellationToken>,
}

impl<'a> Execution<'a> {
    /// No progress reporting and no cancellation.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Calls `progress` after every step.
    #[must_use]
    pub fn progress(mut self, progress: &'a mut dyn FnMut(ProgressInfo)) -> Self {
        self.progress = Some(progress);
        self
    }

    /// Stops the render with [`ApproximateError::Aborted`] once `token` is
    /// cancelled.
    #[must_use]
    pub fn cancellation(mut self, token: &'a CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.is_some_and(CancellationToken::is_cancelled)
    }

    /// [`ApproximateError::Aborted`] once the token is cancelled.
    fn check_cancelled(&self) -> Result<(), ApproximateError> {
        if self.is_cancelled() {
            Err(ApproximateError::Aborted)
        } else {
            Ok(())
        }
    }
}

/// Final encoded render result.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub enum ApproximateResult {
    /// SVG output as UTF-8 text.
    Svg {
        /// The SVG document.
        data: String,
        /// The document's width in pixels.
        width: u32,
        /// The document's height in pixels.
        height: u32,
    },
    /// Encoded PNG output.
    Png {
        /// The PNG file.
        data: Vec<u8>,
        /// The image's width in pixels.
        width: u32,
        /// The image's height in pixels.
        height: u32,
    },
}

impl ApproximateResult {
    /// The format of the encoded output.
    #[must_use]
    pub const fn format(&self) -> OutputFormat {
        match self {
            Self::Svg { .. } => OutputFormat::Svg,
            Self::Png { .. } => OutputFormat::Png,
        }
    }

    /// The output's MIME type; see [`OutputFormat::mime_type`].
    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        self.format().mime_type()
    }

    /// The output's width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        match self {
            Self::Svg { width, .. } | Self::Png { width, .. } => *width,
        }
    }

    /// The output's height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        match self {
            Self::Svg { height, .. } | Self::Png { height, .. } => *height,
        }
    }

    /// The encoded output bytes (UTF-8 text for SVG).
    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Svg { data, .. } => data.into_bytes(),
            Self::Png { data, .. } => data,
        }
    }
}

/// Decode, optimize, and encode a single output in one call.
///
/// The search runs [`RenderOptions::count`] greedy steps, each adding the
/// best shape it finds and reporting it through `execution`'s progress
/// callback. After some of the steps it runs a refit pass that
/// re-optimises every shape so far at its own layer, with the others
/// fixed, and keeps the result only if it lowers the score, so later steps
/// build on the revised shapes. For triangles those in-search passes
/// instead jointly optimise every shape at once, kept only when the working
/// canvas gets closer to the target; previously reported coordinates can
/// become multiples of a quarter of a working pixel before the final stage.
/// The passes are spaced so that their cost grows linearly with the count.
/// A final stage then revises every shape
/// and reports no progress. For [`ShapeKind::Triangle`],
/// [`ShapeKind::Polygon`], [`ShapeKind::Rectangle`],
/// [`ShapeKind::RotatedRectangle`], [`ShapeKind::Ellipse`] and
/// [`ShapeKind::Circle`] it is a joint gradient optimisation of the
/// geometry, opacity (with [`Alpha::Auto`]) and colour of every shape at
/// once, against a model of the anti-aliased output, snapped to quarter
/// pixels (half pixels for axis-aligned rectangles) that keep every angle
/// above 15°, every polygon strictly convex, every rectangle within the
/// 1:8 aspect cap and every radius at least 1 px ([`primeval_core::joint`]).
/// For [`ShapeKind::Any`] it is one refit pass, then the same joint
/// optimisation of every shape but the quadratics, which keep their
/// geometry. The
/// joint optimisation's result is kept only if the PNG output at the
/// working size is closer to the target than with the shapes before it;
/// otherwise the stage keeps those, with coordinates not rounded to its
/// lattice. For [`ShapeKind::Quadratic`] it is refit passes until one
/// lowers the score by less than 1%, at most four.
/// For [`ShapeKind::RotatedEllipse`] it is one refit pass. The result keeps the number,
/// order and kind of the shapes, and is encoded from the revised shapes.
///
/// # Errors
///
/// Returns [`ApproximateError::InvalidOption`] for an option outside its
/// documented range, [`ApproximateError::InvalidImage`] for bytes that do not
/// decode within the limits ([`MAX_INPUT_SIDE`], [`MAX_DECODE_ALLOC`]) or
/// decode to fewer than 2 x 2 pixels, [`ApproximateError::Aborted`] when
/// `execution`'s token is cancelled, and [`ApproximateError::Internal`] for
/// allocation and encoding failures.
pub fn approximate(
    request: ApproximateRequest,
    execution: Execution<'_>,
) -> Result<ApproximateResult, ApproximateError> {
    let size = request.render.output_size;
    let output = request.output;
    let drawing = approximate_drawing(request, execution)?;
    render_drawing(&drawing, size, output)
}

/// Fit once and retain final geometry, after every original refinement stage.
pub fn approximate_drawing(
    request: ApproximateRequest,
    mut execution: Execution<'_>,
) -> Result<Drawing, ApproximateError> {
    let ApproximateRequest {
        input,
        output: _,
        render,
    } = request;
    if matches!(render.background,BackgroundOption::Transparent|BackgroundOption::TransparentReference) {
        validate_options(&render)?;
        execution.check_cancelled()?;
        let image=decode_input(&input)?.into_rgba8();
        drop(input);
        execution.check_cancelled()?;
        let reference=if render.background==BackgroundOption::TransparentReference {
            let mut flat=image.clone();flatten_onto(&mut flat,Color::new(240,240,245,255));
            let rgb=DynamicImage::ImageRgba8(flat).into_rgb8();
            let bytes=raster::encode_png(rgb.width(),rgb.height(),rgb.as_raw()).map_err(|_|ApproximateError::internal("reference PNG encoding failed"))?;
            let mut options=render;options.background=BackgroundOption::Auto;
            Some(approximate_drawing(ApproximateRequest{input:bytes,output:OutputFormat::Png,render:options},Execution{progress:execution.progress.take(),cancel:execution.cancel})?)
        }else{None};
        // Resample premultiplied channels: invisible RGB cannot bleed into edges.
        let mut premult=image::Rgba32FImage::new(image.width(),image.height());
        for (out,p) in premult.pixels_mut().zip(image.pixels()) {
            let a=f32::from(p[3])/255.0;
            *out=image::Rgba([f32::from(p[0])/255.0*a,f32::from(p[1])/255.0*a,f32::from(p[2])/255.0*a,a]);
        }
        let longest=image.width().max(image.height());
        let size=render.resize_input.min(longest);
        let w=((u64::from(image.width())*u64::from(size)/u64::from(longest)) as u32).max(2);
        let h=((u64::from(image.height())*u64::from(size)/u64::from(longest)) as u32).max(2);
        drop(image);
        let resized=image::imageops::resize(&premult,w,h,image::imageops::FilterType::CatmullRom);
        drop(premult);
        let reference_pixels=reference.as_ref().map(|drawing|raster::render_rgb(drawing,w,h).ok_or_else(||ApproximateError::internal("reference raster allocation failed"))).transpose()?;
        let target:Vec<[f64;4]>=resized.pixels().enumerate().map(|(i,p)|{
            let a=f64::from(p[3]).clamp(0.0,1.0);
            if a>=254.0/255.0 {if let Some(rgb)=&reference_pixels {return [f64::from(rgb[i*3])/255.0*a,f64::from(rgb[i*3+1])/255.0*a,f64::from(rgb[i*3+2])/255.0*a,a];}}
            [f64::from(p[0]).clamp(0.0,a),f64::from(p[1]).clamp(0.0,a),f64::from(p[2]).clamp(0.0,a),a]
        }).collect();
        let mut model=primeval_core::rgba::RgbaModel::new(w,h,target.clone(),render.seed);
        if let Some(mut drawing)=reference {
            // Reconstruct only the coarse foundation with source alpha, then
            // retain the original later detail layers. Total count is unchanged.
            let base_count=(drawing.shapes.len()/4).clamp(1,16);
            let foundation=Drawing{width:w,height:h,background:drawing.background,shapes:drawing.shapes[..base_count].to_vec()};
            let rgb=raster::render_rgb(&foundation,w,h).ok_or_else(||ApproximateError::internal("foundation raster allocation failed"))?;
            let base_target=target.iter().enumerate().map(|(i,p)|{let a=p[3];[f64::from(rgb[i*3])/255.0*a,f64::from(rgb[i*3+1])/255.0*a,f64::from(rgb[i*3+2])/255.0*a,a]}).collect();
            let mut base=primeval_core::rgba::RgbaModel::new(w,h,base_target,render.seed);
            for _ in 0..base_count {execution.check_cancelled()?;base.step(render.shape);}
            if !base.refine(||execution.is_cancelled()){return Err(ApproximateError::Aborted);}
            let mut replacement=base.drawing().shapes;replacement.extend_from_slice(&drawing.shapes[base_count..]);drawing.shapes=replacement;
            if !model.seed_with_base(&drawing,render.shape,base_count){
                // A reference candidate that cannot be represented must not
                // block export. Retain a complete independent RGBA fit instead.
                for _ in 0..render.count {execution.check_cancelled()?;model.step(render.shape);}
            }
        }else {for step in 0..render.count {
            execution.check_cancelled()?;
            let shape=model.step(render.shape).clone();
            if let Some(progress)=execution.progress.as_mut(){progress(ProgressInfo{step:step+1,total:render.count,score:model.score(),shape:svg::shape_element(&shape.geometry,shape.color)});}
        }}
        execution.check_cancelled()?;
        if !model.refine(||execution.is_cancelled()){return Err(ApproximateError::Aborted);}
        if render.background==BackgroundOption::TransparentReference && !model.recycle_empty(render.shape,||execution.is_cancelled()){return Err(ApproximateError::Aborted);}
        return Ok(model.drawing());
    }
    let (target, background) = working_target(input, &render, || execution.check_cancelled())?;
    let mut options = ModelOptions::default();
    options.seed = render.seed;
    let mut model = Model::new(target, background, options);

    let pipeline = pipeline::pipeline(render.shape);
    for step in 0..render.count {
        execution.check_cancelled()?;

        model.step(render.shape, render.alpha);

        if let Some(progress) = execution.progress.as_mut() {
            let shape = model
                .last_shape()
                .ok_or_else(|| ApproximateError::internal("a step committed no shape"))?;
            progress(ProgressInfo {
                step: step + 1,
                total: render.count,
                score: model.score_f64(),
                shape: svg::shape_element(&shape.geometry, shape.color),
            });
        }

        // A refit pass the pipeline schedules after this step revises the
        // shapes already reported; it stops once cancelled.
        pipeline::after_step(
            &mut model,
            pipeline.during,
            pipeline.joint_settings,
            step + 1,
            render.alpha,
            || execution.is_cancelled(),
        )
        .ok_or(ApproximateError::Aborted)?;
    }

    // The final stage revises the greedy shapes before encoding; it reports
    // no progress and stops once cancelled.
    execution.check_cancelled()?;
    let (drawing, _) = pipeline::final_stage(&mut model, pipeline, render.alpha, None, || {
        execution.is_cancelled()
    })
    .ok_or(ApproximateError::Aborted)?;

    execution.check_cancelled()?;
    Ok(drawing)
}

/// Encode a retained final drawing without repeating fitting or refinement.
pub fn render_drawing(drawing: &Drawing, output_size: u32, output: OutputFormat) -> Result<ApproximateResult, ApproximateError> {
    encode_output(drawing, output_size, output)
}

/// Validate `render`, decode `input`, and build the working-resolution
/// target and its resolved background: everything [`approximate`] does
/// before it creates the model. `check_cancelled` runs before and after
/// decoding; `input` is dropped as soon as it is decoded.
///
/// `lab::working_target` calls this too, so the evaluation runner cannot
/// drift from [`approximate`].
fn working_target(
    input: impl AsRef<[u8]>,
    render: &RenderOptions,
    check_cancelled: impl Fn() -> Result<(), ApproximateError>,
) -> Result<(Buffer, Color), ApproximateError> {
    let (working, background) = working_image(input, render, check_cancelled)?;
    let (width, height) = working.dimensions();
    let target = Buffer::from_rgb(width, height, working.into_raw())
        .ok_or_else(|| ApproximateError::internal("working image has an invalid pixel length"))?;
    Ok((target, background))
}

/// [`working_target`]'s steps up to the thumbnail: the working image and
/// its resolved background, before they become the engine's [`Buffer`].
/// `lab::working_image` calls this too.
fn working_image(
    input: impl AsRef<[u8]>,
    render: &RenderOptions,
    check_cancelled: impl Fn() -> Result<(), ApproximateError>,
) -> Result<(RgbImage, Color), ApproximateError> {
    validate_options(render)?;

    check_cancelled()?;
    let image = decode_input(input.as_ref())?;
    drop(input);
    check_cancelled()?;
    Ok(prepare_target(
        image,
        render.background,
        render.resize_input,
    ))
}

fn encode_output(
    drawing: &Drawing,
    output_size: u32,
    output: OutputFormat,
) -> Result<ApproximateResult, ApproximateError> {
    let (width, height) = output_dimensions(drawing.width, drawing.height, output_size);

    match output {
        OutputFormat::Svg => Ok(ApproximateResult::Svg {
            data: svg::write_svg(drawing, width, height),
            width,
            height,
        }),
        OutputFormat::Png => {
            if drawing.background.a<255 {
                let rgba=raster::render_rgba(drawing,width,height).ok_or_else(||ApproximateError::internal("could not allocate the RGBA output raster"))?;
                let mut data=Vec::new();
                use image::ImageEncoder;
                image::codecs::png::PngEncoder::new(&mut data).write_image(&rgba,width,height,image::ExtendedColorType::Rgba8).map_err(|err|ApproximateError::Internal{reason:"RGBA PNG encoding failed".into(),source:Some(Box::new(err))})?;
                return Ok(ApproximateResult::Png{data,width,height});
            }
            let rgb = raster::render_rgb(drawing, width, height).ok_or_else(|| {
                ApproximateError::internal("could not allocate the output raster")
            })?;
            Ok(ApproximateResult::Png {
                data: raster::encode_png(width, height, &rgb).map_err(|err| {
                    ApproximateError::Internal {
                        reason: "PNG encoding failed".into(),
                        source: Some(Box::new(err)),
                    }
                })?,
                width,
                height,
            })
        }
    }
}

fn validate_options(render: &RenderOptions) -> Result<(), ApproximateError> {
    let checks = [
        (COUNT_RANGE.contains(&render.count), RenderOption::Count),
        (
            RESIZE_INPUT_RANGE.contains(&render.resize_input),
            RenderOption::ResizeInput,
        ),
        (
            OUTPUT_SIZE_RANGE.contains(&render.output_size),
            RenderOption::OutputSize,
        ),
        (
            !matches!(render.background, BackgroundOption::Color(color) if color.a != 255),
            RenderOption::Background,
        ),
    ];
    match checks.into_iter().find(|(valid, _)| !valid) {
        Some((_, option)) => Err(ApproximateError::invalid_option(option)),
        None => Ok(()),
    }
}

/// Decode `bytes` within [`MAX_INPUT_SIDE`] and [`MAX_DECODE_ALLOC`], and
/// require at least 2 x 2 pixels.
fn decode_input(bytes: &[u8]) -> Result<DynamicImage, ApproximateError> {
    let undecodable = |err: image::ImageError| ApproximateError::InvalidImage {
        reason: "not a decodable JPEG, PNG or WebP image".into(),
        source: Some(Box::new(err)),
    };
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| undecodable(err.into()))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_SIDE);
    limits.max_image_height = Some(MAX_INPUT_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let image = reader.decode().map_err(undecodable)?;

    let (width, height) = (image.width(), image.height());
    if width < 2 || height < 2 {
        return Err(ApproximateError::InvalidImage {
            reason: format!("the image is {width}x{height} pixels; both sides must be at least 2"),
            source: None,
        });
    }
    Ok(image)
}

/// Resolve the background, flatten the image onto it, and build the
/// working-resolution target.
///
/// The target is always opaque RGB: every pixel is composited onto the
/// opaque background, which leaves already-opaque pixels unchanged. Opaque
/// inputs are read in place; only inputs with alpha that are not 8-bit RGBA
/// are converted at full resolution. The full-resolution image is dropped
/// once the thumbnail exists.
fn prepare_target(
    image: DynamicImage,
    background: BackgroundOption,
    resize_input: u32,
) -> (RgbImage, Color) {
    let background = match background {
        BackgroundOption::Auto => average_background(&image),
        BackgroundOption::Transparent|BackgroundOption::TransparentReference => Color::new(0,0,0,0),
        BackgroundOption::Color(color) => color,
    };
    let image = if image.color().has_alpha() {
        let mut pixels = image.into_rgba8();
        flatten_onto(&mut pixels, background);
        DynamicImage::ImageRgba8(pixels)
    } else {
        image
    };
    (thumbnail(image, resize_input), background)
}

/// Composite every pixel onto an opaque background color.
fn flatten_onto(image: &mut RgbaImage, background: Color) {
    let bg = [background.r, background.g, background.b];
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        if alpha == 255 {
            continue;
        }
        for (channel, bg) in pixel.0.iter_mut().zip(bg) {
            let blended = (u32::from(*channel) * alpha + u32::from(bg) * (255 - alpha) + 127) / 255;
            // A weighted mean of two u8 values fits in u8.
            *channel = blended as u8;
        }
        pixel[3] = 255;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, Rgba, RgbaImage};
    use std::error::Error as _;

    fn fixture_image() -> DynamicImage {
        let image = RgbaImage::from_fn(12, 8, |x, y| {
            let r = (x * 16) as u8;
            let g = (y * 24) as u8;
            let b = ((x + y) * 12) as u8;
            Rgba([r, g, b, 255])
        });
        DynamicImage::ImageRgba8(image)
    }

    fn fixture_bytes() -> Vec<u8> {
        let image = fixture_image();
        let mut out = Cursor::new(Vec::new());
        image
            .write_to(&mut out, ImageFormat::Png)
            .expect("fixture png");
        out.into_inner()
    }

    fn fixed_alpha(alpha: u8) -> Alpha {
        Alpha::Fixed(NonZeroU8::new(alpha).expect("non-zero alpha"))
    }

    fn render_options() -> RenderOptions {
        RenderOptions {
            count: 3,
            shape: ShapeKind::Triangle,
            alpha: fixed_alpha(128),
            seed: Some(7),
            background: BackgroundOption::Auto,
            resize_input: 8,
            output_size: 16,
        }
    }

    fn request(input: Vec<u8>, output: OutputFormat) -> ApproximateRequest {
        ApproximateRequest {
            input,
            output,
            render: render_options(),
        }
    }

    #[test]
    fn background_parses_auto_and_hex_colors() {
        assert_eq!("auto".parse(), Ok(BackgroundOption::Auto));
        assert_eq!(
            "#112233".parse(),
            Ok(BackgroundOption::Color(Color::new(0x11, 0x22, 0x33, 0xFF)))
        );
        for value in ["AUTO", "Auto", "not-a-color"] {
            assert_eq!(
                value.parse::<BackgroundOption>(),
                Err(ParseError::new(
                    "background must be auto or an opaque hex color (RGB or RRGGBB)"
                )),
                "{value:?}"
            );
        }
    }

    #[test]
    fn merge_keeps_defaults_for_omitted_fields() {
        assert_eq!(
            RenderOptions::default().merge(PartialRenderOptions::default()),
            RenderOptions::default()
        );
    }

    #[test]
    fn merge_applies_every_set_field() {
        let partial = PartialRenderOptions {
            count: Some(3),
            shape: Some(ShapeKind::Triangle),
            alpha: Some(fixed_alpha(128)),
            seed: Some(7),
            background: Some(BackgroundOption::Auto),
            resize_input: Some(8),
            output_size: Some(16),
        };

        assert_eq!(RenderOptions::default().merge(partial), render_options());
    }

    #[test]
    fn merge_overrides_only_the_set_fields() {
        let partial = PartialRenderOptions {
            count: Some(5),
            alpha: Some(Alpha::Auto),
            ..PartialRenderOptions::default()
        };

        let merged = render_options().merge(partial);

        let mut expected = render_options();
        expected.count = 5;
        expected.alpha = Alpha::Auto;
        assert_eq!(merged, expected);
    }

    #[test]
    fn cancellation_token_clones_share_the_flag() {
        let token = CancellationToken::new();
        let clone = token.clone();
        assert!(!token.is_cancelled());

        clone.cancel();

        assert!(token.is_cancelled());
        assert!(clone.is_cancelled());
    }

    #[test]
    fn same_seed_renders_are_deterministic() {
        let first = approximate(
            request(fixture_bytes(), OutputFormat::Svg),
            Execution::new(),
        )
        .expect("first render");
        let second = approximate(
            request(fixture_bytes(), OutputFormat::Svg),
            Execution::new(),
        )
        .expect("second render");

        assert_eq!(first, second);
    }

    /// Renders the fixture as SVG with `seed` inside a dedicated pool of
    /// `threads` threads.
    fn svg_on_threads(seed: u64, threads: usize) -> Vec<u8> {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("test thread pool");
        let mut request = request(fixture_bytes(), OutputFormat::Svg);
        request.render.shape = ShapeKind::Any;
        request.render.alpha = Alpha::Auto;
        request.render.count = 4;
        request.render.seed = Some(seed);
        pool.install(|| approximate(request, Execution::new()))
            .expect("render")
            .into_bytes()
    }

    #[test]
    fn same_seed_svg_is_identical_across_thread_counts() {
        let reference = svg_on_threads(42, 1);
        for threads in [2, 3, 8] {
            assert!(
                svg_on_threads(42, threads) == reference,
                "{threads} threads changed the SVG"
            );
        }
    }

    /// Renders a 100 × 80 gradient as SVG with `shape` inside a dedicated
    /// pool of `threads` threads: several bands of the joint optimisation's
    /// passes.
    fn joint_svg_on_threads(shape: ShapeKind, threads: usize) -> String {
        let image = RgbaImage::from_fn(100, 80, |x, y| {
            let ring = (x as i32 - 40).pow(2) + (y as i32 - 35).pow(2) < 600;
            Rgba([
                (x * 2) as u8,
                if ring { 240 } else { (y * 3) as u8 },
                ((x + y) % 50 * 5) as u8,
                255,
            ])
        });
        let mut input = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut input, ImageFormat::Png)
            .expect("fixture png");
        let mut request = request(input.into_inner(), OutputFormat::Svg);
        request.render.shape = shape;
        request.render.alpha = Alpha::Auto;
        request.render.count = 8;
        request.render.resize_input = 100;
        request.render.output_size = 100;
        request.render.seed = Some(42);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("test thread pool");
        match pool.install(|| approximate(request, Execution::new())) {
            Ok(ApproximateResult::Svg { data, .. }) => data,
            other => panic!("expected an SVG, got {other:?}"),
        }
    }

    /// The joint optimisation of `shape`, whose shapes are polygons of
    /// `vertices` points, gives the same SVG whatever the number of
    /// threads, and writes quarter-pixel coordinates.
    fn assert_joint_svg_is_identical_across_thread_counts(shape: ShapeKind, vertices: usize) {
        let reference = joint_svg_on_threads(shape, 1);
        for threads in [2, 4, 8] {
            assert!(
                joint_svg_on_threads(shape, threads) == reference,
                "{threads} threads changed the SVG"
            );
        }
        let coordinates: Vec<f64> = svg_shape_lines(&reference)
            .iter()
            .map(|line| {
                let points = line
                    .split("points=\"")
                    .nth(1)
                    .and_then(|rest| rest.split('"').next())
                    .unwrap_or_else(|| panic!("not a polygon: {line}"));
                points
                    .split([' ', ','])
                    .map(|value| value.parse::<f64>().expect("a number"))
                    .collect::<Vec<_>>()
            })
            .inspect(|points| assert_eq!(points.len(), 2 * vertices))
            .flatten()
            .collect();
        assert!(coordinates.iter().all(|value| (value * 4.0).fract() == 0.0));
        assert!(
            coordinates.iter().any(|value| (value * 2.0).fract() != 0.0),
            "no quarter-pixel coordinate"
        );
    }

    #[test]
    fn same_seed_triangle_svg_is_identical_across_thread_counts() {
        assert_joint_svg_is_identical_across_thread_counts(ShapeKind::Triangle, 3);
    }

    #[test]
    fn same_seed_polygon_svg_is_identical_across_thread_counts() {
        assert_joint_svg_is_identical_across_thread_counts(ShapeKind::Polygon, 4);
    }

    /// The joint optimisation of rectangles, rotated or not, gives the
    /// same SVG whatever the number of threads. Axis-aligned rectangles
    /// stay `<rect>` elements on the half-pixel lattice, some of them off
    /// whole pixels; rotated rectangles stay polygons of four points.
    #[test]
    fn same_seed_rectangle_svgs_are_identical_across_thread_counts() {
        for shape in [ShapeKind::Rectangle, ShapeKind::RotatedRectangle] {
            let reference = joint_svg_on_threads(shape, 1);
            for threads in [2, 4, 8] {
                assert!(
                    joint_svg_on_threads(shape, threads) == reference,
                    "{shape:?}: {threads} threads changed the SVG"
                );
            }
            for line in svg_shape_lines(&reference) {
                match shape {
                    ShapeKind::Rectangle => assert!(line.starts_with("<rect x="), "{line}"),
                    _ => {
                        let points = line
                            .split("points=\"")
                            .nth(1)
                            .and_then(|rest| rest.split('"').next())
                            .unwrap_or_else(|| panic!("not a polygon: {line}"));
                        assert_eq!(points.split([' ', ',']).count(), 8, "{line}");
                    }
                }
            }
        }
        let reference = joint_svg_on_threads(ShapeKind::Rectangle, 1);
        let values: Vec<f64> = svg_shape_lines(&reference)
            .iter()
            .flat_map(|line| {
                ["x", "y", "width", "height"].map(|name| {
                    line.split(&format!(" {name}=\""))
                        .nth(1)
                        .and_then(|rest| rest.split('"').next())
                        .and_then(|value| value.parse::<f64>().ok())
                        .unwrap_or_else(|| panic!("no {name}: {line}"))
                })
            })
            .collect();
        assert!(values.iter().all(|value| (value * 2.0).fract() == 0.0));
        assert!(
            values.iter().any(|value| value.fract() != 0.0),
            "no half-pixel coordinate"
        );
    }

    /// The final stage polls `cancelled` during the joint optimisation of
    /// triangles, rectangles and rotated rectangles; once it returns true
    /// the stage returns `None`, which `approximate` turns into
    /// [`ApproximateError::Aborted`].
    #[test]
    fn cancellation_during_the_final_stage_stops_it() {
        for shape in [
            render_options().shape,
            ShapeKind::Rectangle,
            ShapeKind::RotatedRectangle,
        ] {
            let render = RenderOptions {
                shape,
                ..render_options()
            };
            let (target, background) =
                working_target(fixture_bytes(), &render, || Ok(())).expect("target");
            let mut options = ModelOptions::default();
            options.seed = render.seed;
            let mut model = Model::new(target, background, options);
            for _ in 0..render.count {
                model.step(render.shape, render.alpha);
            }
            let stages = pipeline::pipeline(render.shape);
            assert!(stages.joint.is_some(), "{shape:?}");
            let mut polls = 0;
            let finished =
                pipeline::final_stage(&mut model.clone(), stages, render.alpha, None, || {
                    polls += 1;
                    false
                });
            assert!(finished.is_some());
            // 3 shapes run 80 iterations, each polled before it starts.
            assert!(polls > 80, "{shape:?}: {polls} polls");
            for cancel_at in [1, polls / 2, polls] {
                let mut count = 0;
                let stopped =
                    pipeline::final_stage(&mut model.clone(), stages, render.alpha, None, || {
                        count += 1;
                        count >= cancel_at
                    });
                assert_eq!(stopped, None, "{shape:?}: cancelled at poll {cancel_at}");
            }
        }
    }

    #[test]
    fn different_seeds_render_different_svgs() {
        assert_ne!(svg_on_threads(1, 2), svg_on_threads(2, 2));
    }

    #[test]
    fn the_largest_seed_renders() {
        assert!(!svg_on_threads(u64::MAX, 3).is_empty());
    }

    fn encoded_fixture(format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(fixture_image().to_rgb8());
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, format).expect("encode fixture");
        out.into_inner()
    }

    fn assert_renders_svg(bytes: Vec<u8>) {
        let result = approximate(request(bytes, OutputFormat::Svg), Execution::new())
            .expect("render should succeed");

        match result {
            ApproximateResult::Svg { width, height, .. } => {
                assert_eq!((width, height), (16, 10));
            }
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn webp_input_renders() {
        let bytes = encoded_fixture(ImageFormat::WebP);
        assert!(bytes.starts_with(b"RIFF"));
        assert_eq!(&bytes[8..12], b"WEBP");

        assert_renders_svg(bytes);
    }

    #[test]
    fn jpeg_input_renders() {
        let bytes = encoded_fixture(ImageFormat::Jpeg);
        assert!(bytes.starts_with(&[0xFF, 0xD8]));

        assert_renders_svg(bytes);
    }

    #[test]
    fn gif_input_is_rejected_as_invalid_image_data() {
        // Minimal valid 1x1 GIF89a.
        const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\
            !\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;";

        let result = approximate(request(GIF.to_vec(), OutputFormat::Svg), Execution::new());

        match result {
            Err(error @ ApproximateError::InvalidImage { .. }) => {
                assert!(error.source().is_some(), "{error:?}");
            }
            other => panic!("expected invalid image error, got {other:?}"),
        }
    }

    #[test]
    fn invalid_bytes_return_validation_error() {
        let invalid = approximate(
            request(vec![0, 1, 2, 3], OutputFormat::Svg),
            Execution::new(),
        );
        assert!(matches!(
            invalid,
            Err(ApproximateError::InvalidImage {
                source: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn invalid_options_are_rejected() {
        let mut options = render_options();
        options.count = 0;

        let result = approximate(
            ApproximateRequest {
                input: fixture_bytes(),
                output: OutputFormat::Svg,
                render: options,
            },
            Execution::new(),
        );
        assert!(matches!(
            result,
            Err(ApproximateError::InvalidOption {
                option: RenderOption::Count
            })
        ));
    }

    #[test]
    fn resize_input_zero_is_rejected() {
        let mut options = render_options();
        options.resize_input = 0;

        let result = approximate(
            ApproximateRequest {
                input: fixture_bytes(),
                output: OutputFormat::Svg,
                render: options,
            },
            Execution::new(),
        );

        assert!(matches!(
            result,
            Err(ApproximateError::InvalidOption {
                option: RenderOption::ResizeInput
            })
        ));
    }

    #[test]
    fn progress_fires_once_per_step_and_steps_increase() {
        let mut steps = Vec::new();
        let mut on_progress = |info: ProgressInfo| steps.push((info.step, info.total));

        let result = approximate(
            request(fixture_bytes(), OutputFormat::Svg),
            Execution::new().progress(&mut on_progress),
        );

        assert!(result.is_ok());
        assert_eq!(steps, [(1, 3), (2, 3), (3, 3)]);
    }

    /// The shape lines of an SVG document: every line between the
    /// background `<rect>` and the closing `</svg>`.
    fn svg_shape_lines(svg: &str) -> Vec<&str> {
        let lines: Vec<&str> = svg.lines().collect();
        assert!(lines[1].starts_with("<rect width="), "{svg}");
        assert_eq!(lines.last(), Some(&"</svg>"));
        lines[2..lines.len() - 1].to_vec()
    }

    /// The SVG element name of a shape line. A circle is written as an
    /// ellipse whose radii are equal, so the two are one element kind here.
    fn element_name(line: &str) -> &str {
        let name = line
            .strip_prefix('<')
            .and_then(|rest| rest.split([' ', '/', '>']).next())
            .unwrap_or_else(|| panic!("not an element: {line}"));
        if name == "circle" { "ellipse" } else { name }
    }

    #[test]
    fn progress_shapes_preview_the_final_svg_shape_lines() {
        let kinds = [
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
        let mut elements = std::collections::BTreeSet::new();
        let mut revised = 0;
        for shape in kinds {
            let mut options = render_options();
            options.count = 6;
            options.shape = shape;
            options.resize_input = 24;
            let mut shapes = Vec::new();
            let mut on_progress = |info: ProgressInfo| shapes.push(info.shape);

            let result = approximate(
                ApproximateRequest {
                    input: fixture_bytes(),
                    output: OutputFormat::Svg,
                    render: options,
                },
                Execution::new().progress(&mut on_progress),
            );

            let Ok(ApproximateResult::Svg { data, .. }) = result else {
                panic!("{shape:?}: expected an SVG result, got {result:?}");
            };
            let lines = svg_shape_lines(&data);
            assert_eq!(shapes.len(), 6, "{shape:?}: one shape per step");
            assert!(shapes.iter().all(|line| !line.contains('\n')), "{shape:?}");
            assert_eq!(lines.len(), shapes.len(), "{shape:?}");
            let preview: Vec<&str> = shapes.iter().map(|line| element_name(line)).collect();
            let result: Vec<&str> = lines.iter().map(|line| element_name(line)).collect();
            assert_eq!(preview, result, "{shape:?}: element kinds in order");
            revised += usize::from(shapes != lines);
            for line in shapes.iter().map(String::as_str).chain(lines) {
                if line.starts_with("<path ") {
                    elements.insert("path");
                } else if line.starts_with("<ellipse ") && line.contains(" transform=\"rotate(") {
                    elements.insert("rotated ellipse");
                }
            }
        }
        // The stroke and the rotation are the formatting most likely to drift.
        assert_eq!(
            elements.into_iter().collect::<Vec<_>>(),
            ["path", "rotated ellipse"]
        );
        // The final refit pass ran: it revised the preview for most kinds.
        assert!(revised >= 5, "the refit pass revised only {revised} of 9");
    }

    #[test]
    fn cancellation_between_steps_returns_abort_error() {
        let token = CancellationToken::new();
        let canceller = token.clone();
        let mut fired = Vec::new();
        let mut on_progress = |info: ProgressInfo| {
            fired.push(info.step);
            if info.step == 1 {
                canceller.cancel();
            }
        };

        let result = approximate(
            request(fixture_bytes(), OutputFormat::Svg),
            Execution::new()
                .progress(&mut on_progress)
                .cancellation(&token),
        );

        assert!(matches!(result, Err(ApproximateError::Aborted)));
        assert_eq!(fired, [1]);
    }

    /// A token cancelled at a step after which the pipeline runs a refit
    /// pass stops the render with [`ApproximateError::Aborted`]: the pass
    /// polls the token before its first layer (see
    /// `pipeline::tests::cancellation_during_a_refit_in_the_search_stops_it`)
    /// and no later step runs.
    #[test]
    fn cancellation_during_a_refit_in_the_search_returns_abort_error() {
        let mut request = request(fixture_bytes(), OutputFormat::Svg);
        // Past the triangles' first pass, at step 20, with steps after it.
        request.render.count = 24;
        let during = pipeline::pipeline(request.render.shape).during;
        let due = (1..=request.render.count)
            .find(|&step| during.due(step))
            .expect("a pass within the count");
        let token = CancellationToken::new();
        let canceller = token.clone();
        let mut fired = Vec::new();
        let mut on_progress = |info: ProgressInfo| {
            fired.push(info.step);
            if info.step == due {
                canceller.cancel();
            }
        };

        let result = approximate(
            request,
            Execution::new()
                .progress(&mut on_progress)
                .cancellation(&token),
        );

        assert!(matches!(result, Err(ApproximateError::Aborted)));
        assert_eq!(fired, (1..=due).collect::<Vec<_>>());
    }

    #[test]
    fn cancelled_token_aborts_before_the_first_step() {
        let token = CancellationToken::new();
        token.cancel();
        let mut fired = Vec::new();
        let mut on_progress = |info: ProgressInfo| fired.push(info.step);

        let result = approximate(
            request(fixture_bytes(), OutputFormat::Svg),
            Execution::new()
                .progress(&mut on_progress)
                .cancellation(&token),
        );

        assert!(matches!(result, Err(ApproximateError::Aborted)));
        assert!(fired.is_empty());
    }

    #[test]
    fn cancelled_token_aborts_before_decoding() {
        let token = CancellationToken::new();
        token.cancel();

        let result = approximate(
            request(vec![0, 1, 2, 3], OutputFormat::Svg),
            Execution::new().cancellation(&token),
        );

        assert!(matches!(result, Err(ApproximateError::Aborted)));
    }

    #[test]
    fn cancellation_after_the_last_step_aborts_before_encoding() {
        let token = CancellationToken::new();
        let canceller = token.clone();
        let mut on_progress = |info: ProgressInfo| {
            if info.step == info.total {
                canceller.cancel();
            }
        };

        let result = approximate(
            request(fixture_bytes(), OutputFormat::Png),
            Execution::new()
                .progress(&mut on_progress)
                .cancellation(&token),
        );

        assert!(matches!(result, Err(ApproximateError::Aborted)));
    }

    #[test]
    fn raster_outputs_report_rendered_dimensions() {
        let result = approximate(
            request(fixture_bytes(), OutputFormat::Png),
            Execution::new(),
        )
        .expect("png render");

        match result {
            ApproximateResult::Png {
                ref data,
                width,
                height,
            } => {
                assert_eq!(result.format(), OutputFormat::Png);
                assert_eq!(result.mime_type(), "image/png");
                assert!(data.starts_with(b"\x89PNG"));
                assert!(width > 0);
                assert!(height > 0);
            }
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn svg_and_png_map_the_same_canvas_onto_the_same_size() {
        let svg = approximate(
            request(fixture_bytes(), OutputFormat::Svg),
            Execution::new(),
        )
        .expect("svg render");
        let png = approximate(
            request(fixture_bytes(), OutputFormat::Png),
            Execution::new(),
        )
        .expect("png render");

        // The 12 x 8 fixture works at 8 x 5 and exports at 16 x 10.
        let ApproximateResult::Svg { data, .. } = &svg else {
            panic!("expected svg output");
        };
        assert!(data.starts_with(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"10\" \
             viewBox=\"0 0 8 5\" stroke-linecap=\"round\">"
        ));
        let ApproximateResult::Png { data, .. } = &png else {
            panic!("expected png output");
        };
        let decoded = image::load_from_memory(data).expect("decode png");
        assert_eq!(decoded.color(), image::ColorType::Rgb8);
        assert_eq!((decoded.width(), decoded.height()), (16, 10));
        assert_eq!((svg.width(), svg.height()), (16, 10));
        assert_eq!((png.width(), png.height()), (16, 10));
    }

    #[test]
    fn any_shape_render_does_not_panic_in_debug() {
        let render = RenderOptions {
            count: 1,
            seed: Some(1),
            resize_input: 32,
            output_size: 32,
            ..RenderOptions::default()
        };

        let result = approximate(
            ApproximateRequest {
                input: fixture_bytes(),
                output: OutputFormat::Svg,
                render,
            },
            Execution::new(),
        );

        assert!(
            result.is_ok(),
            "any-shape render should succeed: {result:?}"
        );
    }

    #[test]
    fn parse_background_rejects_alpha_forms() {
        for value in ["#1234", "1234", "#11223344", "11223344"] {
            assert_eq!(
                value.parse::<BackgroundOption>(),
                Err(ParseError::new(
                    "background must be auto or an opaque hex color (RGB or RRGGBB)"
                )),
                "{value}"
            );
        }
        assert_eq!(
            "#abc".parse(),
            Ok(BackgroundOption::Color(Color::new(0xAA, 0xBB, 0xCC, 0xFF)))
        );
    }

    #[test]
    fn parse_background_rejects_multibyte_input_without_panicking() {
        for value in ["a€bc", "#a€bc", "€", "aé"] {
            assert!(value.parse::<BackgroundOption>().is_err(), "{value}");
        }
    }

    #[test]
    fn translucent_explicit_background_is_rejected() {
        let mut options = render_options();
        options.background = BackgroundOption::Color(Color::new(10, 20, 30, 128));

        let result = approximate(
            ApproximateRequest {
                input: fixture_bytes(),
                output: OutputFormat::Svg,
                render: options,
            },
            Execution::new(),
        );

        assert!(matches!(
            result,
            Err(ApproximateError::InvalidOption {
                option: RenderOption::Background
            })
        ));
    }

    fn png_bytes(image: RgbaImage) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut out, ImageFormat::Png)
            .expect("encode png");
        out.into_inner()
    }

    #[test]
    fn opaque_input_target_and_background_are_unchanged() {
        // Larger than resize_input so the resampling path runs too.
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(40, 24, |x, y| {
            image::Rgb([(x * 6) as u8, (y * 10) as u8, ((x * y) % 256) as u8])
        }));
        let expected_target = thumbnail(image.clone(), 16);
        let pixels = image.to_rgba8();
        let pixel_count = u64::from(pixels.width()) * u64::from(pixels.height());
        let (mut r_sum, mut g_sum, mut b_sum) = (0u64, 0u64, 0u64);
        for pixel in pixels.pixels() {
            r_sum += u64::from(pixel[0]);
            g_sum += u64::from(pixel[1]);
            b_sum += u64::from(pixel[2]);
        }
        let expected_background = Color::new(
            (r_sum / pixel_count) as u8,
            (g_sum / pixel_count) as u8,
            (b_sum / pixel_count) as u8,
            255,
        );

        let (target, background) = prepare_target(image, BackgroundOption::Auto, 16);

        assert_eq!(target, expected_target);
        assert_eq!(background, expected_background);
    }

    #[test]
    fn transparent_input_is_flattened_onto_explicit_background() {
        let image = RgbaImage::from_fn(2, 1, |x, _| {
            if x == 0 {
                Rgba([200, 100, 0, 0])
            } else {
                Rgba([200, 100, 0, 128])
            }
        });
        let background = Color::new(0, 50, 255, 255);

        let (target, resolved) = prepare_target(
            DynamicImage::ImageRgba8(image),
            BackgroundOption::Color(background),
            16,
        );

        assert_eq!(resolved, background);
        assert_eq!(target.get_pixel(0, 0), &Rgb([0, 50, 255]));
        // (c*a + bg*(255-a) + 127) / 255 with a = 128.
        assert_eq!(target.get_pixel(1, 0), &Rgb([100, 75, 127]));
    }

    #[test]
    fn auto_background_is_alpha_weighted_mean() {
        // Half-transparent red next to fully transparent green.
        let image = RgbaImage::from_fn(2, 2, |x, _| {
            if x == 0 {
                Rgba([255, 0, 0, 128])
            } else {
                Rgba([0, 255, 0, 0])
            }
        });

        let (target, background) =
            prepare_target(DynamicImage::ImageRgba8(image), BackgroundOption::Auto, 16);

        assert_eq!(background, Color::new(255, 0, 0, 255));
        assert!(target.pixels().all(|pixel| pixel == &Rgb([255, 0, 0])));
    }

    #[test]
    fn fully_transparent_input_uses_white_auto_background() {
        let image = RgbaImage::from_pixel(3, 3, Rgba([10, 20, 30, 0]));

        let (target, background) =
            prepare_target(DynamicImage::ImageRgba8(image), BackgroundOption::Auto, 16);

        assert_eq!(background, Color::new(255, 255, 255, 255));
        assert!(target.pixels().all(|pixel| pixel == &Rgb([255, 255, 255])));
    }

    #[test]
    fn transparent_input_with_explicit_background_renders_opaque_png() {
        let input = png_bytes(RgbaImage::from_fn(12, 8, |x, y| {
            Rgba([(x * 20) as u8, (y * 30) as u8, 90, ((x + y) * 12) as u8])
        }));
        let mut options = render_options();
        options.background = "#336699".parse().expect("background");

        let result = approximate(
            ApproximateRequest {
                input,
                output: OutputFormat::Png,
                render: options,
            },
            Execution::new(),
        )
        .expect("png render");

        let ApproximateResult::Png { data, .. } = result else {
            panic!("expected png output");
        };
        let decoded = image::load_from_memory(&data)
            .expect("decode png")
            .to_rgba8();
        assert!(decoded.pixels().all(|pixel| pixel[3] == 255));
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        png_bytes(RgbaImage::from_pixel(
            width,
            height,
            Rgba([40, 90, 200, 255]),
        ))
    }

    fn render_bytes(input: Vec<u8>) -> Result<ApproximateResult, ApproximateError> {
        approximate(request(input, OutputFormat::Svg), Execution::new())
    }

    #[test]
    fn inputs_below_two_by_two_are_rejected_as_invalid_images() {
        for (width, height) in [(1, 1), (1000, 1), (1, 1000)] {
            match render_bytes(solid_png(width, height)) {
                Err(error @ ApproximateError::InvalidImage { source: None, .. }) => {
                    assert_eq!(
                        error.to_string(),
                        format!(
                            "invalid image data: the image is {width}x{height} pixels; \
                             both sides must be at least 2"
                        )
                    );
                }
                other => panic!("{width}x{height}: expected invalid image, got {other:?}"),
            }
        }
    }

    #[test]
    fn tiny_and_extreme_aspect_inputs_render() {
        let mut render = render_options();
        render.shape = ShapeKind::Any;
        render.resize_input = 256;
        for (width, height, view_box) in [
            (2, 2, "0 0 2 2"),
            (2000, 5, "0 0 256 2"),
            (5, 2000, "0 0 2 256"),
        ] {
            let result = approximate(
                ApproximateRequest {
                    input: solid_png(width, height),
                    output: OutputFormat::Svg,
                    render,
                },
                Execution::new(),
            )
            .unwrap_or_else(|error| panic!("{width}x{height}: {error}"));

            let ApproximateResult::Svg { data, .. } = result else {
                panic!("expected svg output");
            };
            assert!(
                data.contains(&format!("viewBox=\"{view_box}\"")),
                "{width}x{height}: {data}"
            );
        }
    }

    #[test]
    fn inputs_wider_than_the_decode_limit_are_rejected() {
        let input = solid_png(MAX_INPUT_SIDE + 1, 2);

        let result = render_bytes(input);

        match result {
            Err(error @ ApproximateError::InvalidImage { .. }) => {
                assert!(error.source().is_some(), "{error:?}");
            }
            other => panic!("expected invalid image, got {other:?}"),
        }
    }

    #[test]
    fn option_bounds_are_enforced() {
        type Setter = fn(&mut RenderOptions, u32);
        let cases: [(Setter, RenderOption, RangeInclusive<u32>); 3] = [
            (|r, v| r.count = v, RenderOption::Count, COUNT_RANGE),
            (
                |r, v| r.resize_input = v,
                RenderOption::ResizeInput,
                RESIZE_INPUT_RANGE,
            ),
            (
                |r, v| r.output_size = v,
                RenderOption::OutputSize,
                OUTPUT_SIZE_RANGE,
            ),
        ];
        for (set, option, range) in cases {
            for value in [*range.start(), *range.end()] {
                let mut render = render_options();
                set(&mut render, value);
                assert!(validate_options(&render).is_ok(), "{option} = {value}");
            }
            for value in [range.start() - 1, range.end() + 1, u32::MAX] {
                let mut render = render_options();
                set(&mut render, value);
                assert!(
                    matches!(
                        validate_options(&render),
                        Err(ApproximateError::InvalidOption { option: rejected }) if rejected == option
                    ),
                    "{option} = {value}"
                );
            }
        }
    }

    #[test]
    fn requirements_name_the_accepted_values() {
        // Every listed name parses back to the value that prints it.
        let listed = |option: RenderOption| {
            option
                .requirement()
                .strip_prefix("must be one of: ")
                .expect("a list requirement")
                .split(", ")
                .collect::<Vec<_>>()
        };
        for name in listed(RenderOption::Shape) {
            assert_eq!(name.parse::<ShapeKind>().expect(name).as_str(), name);
        }
        assert_eq!(listed(RenderOption::Shape).len(), 9);
        for name in listed(RenderOption::Output) {
            assert_eq!(name.parse::<OutputFormat>().expect(name).as_str(), name);
        }
        assert_eq!(listed(RenderOption::Output).len(), 2);
        for (option, range) in [
            (RenderOption::Count, COUNT_RANGE),
            (RenderOption::ResizeInput, RESIZE_INPUT_RANGE),
            (RenderOption::OutputSize, OUTPUT_SIZE_RANGE),
        ] {
            assert_eq!(
                option.requirement(),
                format!(
                    "must be an integer from {} to {}",
                    range.start(),
                    range.end()
                )
            );
        }
    }

    #[test]
    fn parse_errors_match_the_invalid_option_messages() {
        let cases = [
            (
                "hexagon".parse::<ShapeKind>().unwrap_err(),
                RenderOption::Shape,
            ),
            ("half".parse::<Alpha>().unwrap_err(), RenderOption::Alpha),
            (
                "#1234".parse::<BackgroundOption>().unwrap_err(),
                RenderOption::Background,
            ),
            (
                "gif".parse::<OutputFormat>().unwrap_err(),
                RenderOption::Output,
            ),
        ];
        for (parse_error, option) in cases {
            assert_eq!(
                parse_error.to_string(),
                ApproximateError::invalid_option(option).to_string()
            );
        }
    }

    #[test]
    fn set_number_accepts_exact_integers_in_range() {
        let mut partial = PartialRenderOptions::default();
        partial.set_number(RenderOption::Count, 100_000.0).unwrap();
        partial.set_number(RenderOption::ResizeInput, 2.0).unwrap();
        partial
            .set_number(RenderOption::OutputSize, 8192.0)
            .unwrap();
        partial.set_number(RenderOption::Alpha, 255.0).unwrap();
        partial
            .set_number(RenderOption::Seed, MAX_SAFE_INTEGER)
            .unwrap();

        assert_eq!(partial.count, Some(100_000));
        assert_eq!(partial.resize_input, Some(2));
        assert_eq!(partial.output_size, Some(8192));
        assert_eq!(partial.alpha, Some(fixed_alpha(255)));
        assert_eq!(partial.seed, Some(9_007_199_254_740_991));
    }

    #[test]
    fn set_number_rejects_values_that_would_wrap_or_truncate() {
        let wrapping = 2_f64.powi(32) + 1.0;
        let cases = [
            (RenderOption::Count, wrapping),
            (RenderOption::Count, 1e20),
            (RenderOption::Count, -1.0),
            (RenderOption::Count, 1.5),
            (RenderOption::Count, f64::NAN),
            (RenderOption::Count, f64::INFINITY),
            (RenderOption::Count, 0.0),
            (RenderOption::ResizeInput, 1.0),
            (RenderOption::ResizeInput, wrapping + 15.0),
            (RenderOption::OutputSize, 2_f64.powi(32) + 16.0),
            (RenderOption::Alpha, 0.0),
            (RenderOption::Alpha, 256.0),
            (RenderOption::Alpha, wrapping + 127.0),
            (RenderOption::Seed, -1.0),
            (RenderOption::Seed, 0.5),
            (RenderOption::Seed, MAX_SAFE_INTEGER + 1.0),
            (RenderOption::Seed, 1e20),
            (RenderOption::Shape, 1.0),
        ];
        for (option, value) in cases {
            let mut partial = PartialRenderOptions::default();
            let result = partial.set_number(option, value);
            assert!(
                matches!(
                    result,
                    Err(ApproximateError::InvalidOption { option: rejected }) if rejected == option
                ),
                "{option} = {value}: {result:?}"
            );
            assert_eq!(
                partial,
                PartialRenderOptions::default(),
                "{option} = {value}"
            );
        }
    }
}
