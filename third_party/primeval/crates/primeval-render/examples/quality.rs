//! End-to-end time and quality runner.
//!
//! Usage:
//!
//! ```text
//! cargo run --release -p primeval-render --example quality -- [options]
//!
//!   --quick             smoke run: 10 steps, shape kind any
//!   --image PATH        add an input image (repeatable); replaces the
//!                       default paintings
//!   --no-synthetic      skip the generated images
//!   --shapes LIST       comma-separated shape kinds (default: all, plus any)
//!   --steps LIST        comma-separated step counts (default: 100,200)
//! ```
//!
//! For every image × shape kind × step count it runs [`approximate`] with
//! default options, seed 42 and PNG output, and prints one row of a Markdown
//! table to stdout, sorted by image, shape and steps. Progress goes to
//! stderr. The header records the commit and the machine.
//!
//! Corpus: the public-domain paintings `docs/readme/originals/monalisa.jpg`
//! and `americangothic.jpg` (`DEFAULT_PHOTOS` in `common/mod.rs`, a fixed
//! list, so adding a gallery image does not change the benchmark), plus
//! three deterministic 512 × 512 images this tool generates
//! (`synthetic-gradient`, `synthetic-shapes`, `synthetic-texture`). Inputs
//! are expected to be opaque.
//!
//! Columns:
//!
//! - `search_s`: wall time from the start of the call to the last step's
//!   progress report (decode, thumbnail, greedy steps and earlier in-search
//!   passes). It excludes the last step's in-search pass and the final stage.
//! - `total_s`: wall time of the whole call, including the PNG render and
//!   encode at the output size, the last in-search pass and the final stage.
//! - `score`: the score at the last greedy step's progress report, before
//!   that step's in-search pass and the final stage: the normalised RMSE
//!   between the canvas and the target at working resolution, over the RGB channels:
//!   `sqrt(Σ Δ² / (w · h · 3)) / 255`, the same definition as `png_rmse`.
//!   Tables from before the engine became RGB-only measured four RGBA
//!   channels, which gives this value times `sqrt(3 / 4)`.
//! - `png_rmse`: the normalised RMSE over the RGB channels between the
//!   rendered PNG at output size and the input resampled to the same size
//!   (Catmull-Rom, the filter the engine uses for its working thumbnail):
//!   `sqrt(Σ Δ² / (w · h · 3)) / 255`.
//!
//! Lower is better for both metrics. Times vary between runs; the metrics
//! are deterministic for a given commit and platform, whatever the core
//! count (the search runs one worker per logical core, but its result does
//! not depend on how many there are).

mod common;

use common::{ALL_SHAPES, BoxError, SEED, rgb_rmse};
use image::{ImageFormat, RgbImage, imageops};
use primeval_render::{
    ApproximateRequest, ApproximateResult, Execution, OutputFormat, ProgressInfo, RenderOptions,
    ShapeKind, approximate,
};
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct Config {
    photos: Vec<PathBuf>,
    synthetic: bool,
    shapes: Vec<ShapeKind>,
    steps: Vec<u32>,
}

struct Row {
    image: String,
    shape: &'static str,
    steps: u32,
    search: Duration,
    total: Duration,
    score: f64,
    png_rmse: f64,
}

fn main() -> Result<(), BoxError> {
    let config = parse_args(std::env::args().skip(1))?;
    let inputs = common::load_inputs(&config.photos, config.synthetic)?;

    let mut rows = Vec::new();
    for input in &inputs {
        let original = image::load_from_memory(&input.bytes)?.to_rgb8();
        let mut reference: Option<RgbImage> = None;
        for &shape in &config.shapes {
            for &steps in &config.steps {
                eprintln!("{} {} {steps}", input.name, shape.as_str());
                let run = run(&input.bytes, shape, steps)?;
                let reference = reference.get_or_insert_with(|| {
                    imageops::resize(
                        &original,
                        run.rendered.width(),
                        run.rendered.height(),
                        imageops::FilterType::CatmullRom,
                    )
                });
                rows.push(Row {
                    image: input.name.clone(),
                    shape: shape.as_str(),
                    steps,
                    search: run.search,
                    total: run.total,
                    score: run.score,
                    png_rmse: rgb_rmse(&run.rendered, reference),
                });
            }
        }
    }
    rows.sort_by(|left, right| {
        (&left.image, left.shape, left.steps).cmp(&(&right.image, right.shape, right.steps))
    });

    print_header();
    println!("| image | shape | steps | search_s | total_s | score | png_rmse |");
    println!("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for row in &rows {
        println!(
            "| {} | {} | {} | {:.3} | {:.3} | {:.6} | {:.6} |",
            row.image,
            row.shape,
            row.steps,
            row.search.as_secs_f64(),
            row.total.as_secs_f64(),
            row.score,
            row.png_rmse
        );
    }
    let total: Duration = rows.iter().map(|row| row.total).sum();
    println!();
    println!(
        "Total: {:.3} s over {} runs",
        total.as_secs_f64(),
        rows.len()
    );
    Ok(())
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config, BoxError> {
    let mut photos = Vec::new();
    let mut synthetic = true;
    let mut quick = false;
    let mut shapes = None;
    let mut steps = None;
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
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
                steps = Some(
                    value()?
                        .split(',')
                        .map(str::parse)
                        .collect::<Result<_, _>>()?,
                );
            }
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
    let steps = steps.unwrap_or_else(|| if quick { vec![10] } else { vec![100, 200] });
    Ok(Config {
        photos,
        synthetic,
        shapes,
        steps,
    })
}

struct Run {
    search: Duration,
    total: Duration,
    score: f64,
    rendered: RgbImage,
}

fn run(input: &[u8], shape: ShapeKind, steps: u32) -> Result<Run, BoxError> {
    let mut render = RenderOptions::default();
    render.count = steps;
    render.shape = shape;
    render.seed = Some(SEED);

    let start = Instant::now();
    let mut last = None;
    let mut on_progress = |info: ProgressInfo| last = Some((start.elapsed(), info.score));
    let result = approximate(
        ApproximateRequest {
            input: input.to_vec(),
            output: OutputFormat::Png,
            render,
        },
        Execution::new().progress(&mut on_progress),
    )?;
    let total = start.elapsed();
    // These columns stop at the last progress report; only `total`
    // includes the last in-search pass, final stage and encoding.
    let (search, score) = last.ok_or("the render reported no steps")?;
    let ApproximateResult::Png { data, .. } = result else {
        return Err("requested PNG output".into());
    };
    let rendered = image::load_from_memory_with_format(&data, ImageFormat::Png)?.to_rgb8();
    Ok(Run {
        search,
        total,
        score,
        rendered,
    })
}

fn print_header() {
    let defaults = RenderOptions::default();
    println!("# primeval quality run");
    println!();
    common::print_commit_and_machine();
    println!(
        "- options: seed {SEED}, resize_input {}, output_size {}, alpha auto, background auto, \
         {} threads",
        defaults.resize_input,
        defaults.output_size,
        rayon::current_num_threads()
    );
    println!();
}
