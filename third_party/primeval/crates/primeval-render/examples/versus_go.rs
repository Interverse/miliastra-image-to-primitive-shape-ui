//! Time and quality comparison with the Go `primitive` CLI.
//!
//! Usage:
//!
//! ```text
//! cargo run --release -p primeval-render --example versus_go -- [options]
//!
//!   --primitive PATH    the Go binary (default: `primitive` on PATH, else
//!                       $HOME/go/bin/primitive)
//!   --image PATH        add an input image (repeatable); replaces the
//!                       default corpus, the paintings americangothic.jpg
//!                       and monalisa.jpg in docs/readme/originals/
//!   --shapes LIST       comma-separated shape kinds (default: all nine)
//!   --steps LIST        comma-separated step counts (default: 200,1000)
//!   --reps N            runs per tool and configuration (default: 3)
//! ```
//!
//! Install the Go tool with `go install github.com/fogleman/primitive@latest`.
//! This runner is not part of any gate.
//!
//! A configuration is one image × shape kind × step count. Both tools get
//! the same settings: the shape kind (Go `-m`), the step count (`-n`),
//! alpha 128 (Go's default `-a 128`; primeval `Alpha::Fixed(128)`), working
//! size 256 (`-r 256`; `resize_input` 256), output size 1024 (`-s 1024`;
//! `output_size` 1024) and PNG output. Both default the background to the
//! input's average colour; Go averages its 256-pixel working thumbnail,
//! primeval the full-resolution input, which differ by at most a unit or
//! two per channel. Go also writes the SVG in the same run (`-o` twice);
//! primeval renders the SVG in a second, untimed call with the same seed,
//! which draws the same shapes.
//!
//! Timing, the wall time of each run, with the two tools alternating within
//! each configuration so they share any background load:
//!
//! - Go is timed as a process: start-up, decode, search, render and writing
//!   both files.
//! - primeval is timed in-process through [`approximate`]: reading the
//!   file, decode, search, and the PNG render and encode. The Node CLI adds
//!   its start-up, about 0.1 s, on top.
//!
//! Go seeds its search from the clock, so it runs `--reps` times and its
//! RMSE is the mean of those runs. primeval uses seed 42 and is
//! deterministic; it also runs `--reps` times, for the timing only. Times
//! are medians.
//!
//! Quality: the RGB RMSE, on the 0–255 scale, of each rendered PNG against
//! the original resized to the PNG's size with Lanczos3,
//! `sqrt(Σ Δ² / (w · h · 3))`. The runner computes it from the PNG files for
//! both tools alike, not from the engine's score. Lower is better.
//!
//! Output, a Markdown report on stdout (progress on stderr):
//!
//! - one row per step count × shape kind, over all images: summed median
//!   times, their ratio as the speedup, mean RMSEs, their ratio
//!   (primeval / Go, below 1 when primeval is closer), and mean SVG sizes;
//! - the same columns per configuration;
//! - totals per step count: summed median times, the geometric means over
//!   configurations of the speedup and of the RMSE ratio, and the number of
//!   configurations where primeval's RMSE is lower.
//!
//! Go's files go to a temporary directory that is removed afterwards.

#[allow(
    dead_code,
    reason = "versus_go uses only the seed, the kinds and the header helpers"
)]
mod common;

use common::{ALL_SHAPES, BoxError, SEED, cpu_model, git};
use image::{ImageFormat, RgbImage, imageops};
use primeval_render::{
    Alpha, ApproximateRequest, ApproximateResult, Execution, OutputFormat, RenderOptions,
    ShapeKind, approximate,
};
use std::num::NonZeroU8;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// The fixed alpha of both tools: Go's default.
const ALPHA: u8 = 128;
/// The working size of both tools.
const RESIZE_INPUT: u32 = 256;
/// The output size of both tools.
const OUTPUT_SIZE: u32 = 1024;
/// The default corpus: the two paintings in `docs/readme/originals/`, in
/// file-name order. A fixed list, so adding a gallery image does not change
/// the benchmark.
const DEFAULT_IMAGES: [&str; 2] = ["americangothic.jpg", "monalisa.jpg"];
/// How to install the Go tool, for the error when it is missing.
const INSTALL_HINT: &str = "install it with `go install github.com/fogleman/primitive@latest` \
                            or pass --primitive PATH";

/// The parsed command line.
struct Config {
    primitive: PathBuf,
    images: Vec<PathBuf>,
    shapes: Vec<ShapeKind>,
    steps: Vec<u32>,
    reps: usize,
}

/// One tool's measurements for one configuration.
struct Measured {
    /// The median wall time.
    time: Duration,
    /// The mean RGB RMSE, 0–255.
    rmse: f64,
    /// The mean SVG size in bytes.
    svg_bytes: f64,
}

/// One configuration's results.
struct Row {
    image: String,
    shape: ShapeKind,
    steps: u32,
    go: Measured,
    primeval: Measured,
}

/// A directory removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, BoxError> {
        let path = std::env::temp_dir().join(format!("primeval-versus-go-{}", std::process::id()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn main() -> Result<(), BoxError> {
    let config = parse_args(std::env::args().skip(1))?;
    let temp = TempDir::new()?;
    let mut rows = Vec::new();
    for &steps in &config.steps {
        for path in &config.images {
            let name = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or("image path has no file name")?
                .to_owned();
            let original = image::open(path)?.to_rgb8();
            let mut reference: Option<RgbImage> = None;
            for &shape in &config.shapes {
                eprintln!("{steps} {name} {}", shape.as_str());
                let mut go = Samples::default();
                let mut primeval = Samples::default();
                for rep in 0..config.reps {
                    let go_first = rep % 2 == 0;
                    for go_turn in [go_first, !go_first] {
                        if go_turn {
                            go.push(run_go(&config.primitive, path, &temp.0, shape, steps)?);
                        } else {
                            primeval.push(run_primeval(path, shape, steps)?);
                        }
                    }
                }
                primeval
                    .svg_bytes
                    .push(primeval_svg_bytes(path, shape, steps)?);
                let go = go.measure(&original, &mut reference);
                let primeval = primeval.measure(&original, &mut reference);
                rows.push(Row {
                    image: name.clone(),
                    shape,
                    steps,
                    go,
                    primeval,
                });
            }
        }
    }
    print_report(&config, &rows);
    Ok(())
}

/// The original resized to `rendered`'s size with Lanczos3, cached per image.
fn reference_for<'a>(
    original: &RgbImage,
    cache: &'a mut Option<RgbImage>,
    rendered: &RgbImage,
) -> &'a RgbImage {
    if cache
        .as_ref()
        .is_some_and(|cached| cached.dimensions() != rendered.dimensions())
    {
        *cache = None;
    }
    cache.get_or_insert_with(|| {
        imageops::resize(
            original,
            rendered.width(),
            rendered.height(),
            imageops::FilterType::Lanczos3,
        )
    })
}

/// The runs of one tool for one configuration.
#[derive(Default)]
struct Samples {
    times: Vec<Duration>,
    rendered: Vec<RgbImage>,
    svg_bytes: Vec<usize>,
}

impl Samples {
    fn push(&mut self, run: Run) {
        self.times.push(run.time);
        self.rendered.push(run.rendered);
        if let Some(svg_bytes) = run.svg_bytes {
            self.svg_bytes.push(svg_bytes);
        }
    }

    fn measure(mut self, original: &RgbImage, cache: &mut Option<RgbImage>) -> Measured {
        self.times.sort();
        let time = self.times[self.times.len() / 2];
        let rmse = mean(
            self.rendered
                .iter()
                .map(|rendered| rgb_rmse(rendered, reference_for(original, cache, rendered))),
        );
        let svg_bytes = mean(self.svg_bytes.iter().map(|&bytes| bytes as f64));
        Measured {
            time,
            rmse,
            svg_bytes,
        }
    }
}

/// One timed run.
struct Run {
    time: Duration,
    rendered: RgbImage,
    svg_bytes: Option<usize>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config, BoxError> {
    let mut primitive = None;
    let mut images = Vec::new();
    let mut shapes = None;
    let mut steps = None;
    let mut reps = 3;
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--primitive" => primitive = Some(PathBuf::from(value()?)),
            "--image" => images.push(PathBuf::from(value()?)),
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
            "--reps" => reps = value()?.parse()?,
            other => return Err(format!("unknown argument {other}; see the doc comment").into()),
        }
    }
    if reps == 0 {
        return Err("--reps must be at least 1".into());
    }
    let primitive = match primitive {
        Some(path) if path.is_file() => path,
        Some(_) => return Err(format!("--primitive is not a file; {INSTALL_HINT}").into()),
        None => {
            find_primitive().ok_or_else(|| format!("Go `primitive` not found; {INSTALL_HINT}"))?
        }
    };
    if images.is_empty() {
        images = default_images();
    }
    let shapes = shapes.unwrap_or_else(|| ALL_SHAPES.to_vec());
    for &shape in &shapes {
        go_mode(shape)?;
    }
    Ok(Config {
        primitive,
        images,
        shapes,
        steps: steps.unwrap_or_else(|| vec![200, 1000]),
        reps,
    })
}

/// `primitive` on `PATH`, else `$HOME/go/bin/primitive`.
fn find_primitive() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("primitive"))
            .find(|candidate| candidate.is_file())
    });
    on_path.or_else(|| {
        let home = std::env::var_os("HOME")?;
        let candidate = Path::new(&home).join("go/bin/primitive");
        candidate.is_file().then_some(candidate)
    })
}

/// The default corpus, [`DEFAULT_IMAGES`] in `docs/readme/originals/`.
fn default_images() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/readme/originals");
    DEFAULT_IMAGES.iter().map(|name| dir.join(name)).collect()
}

/// Go's `-m` value for a shape kind.
fn go_mode(shape: ShapeKind) -> Result<u8, BoxError> {
    Ok(match shape {
        ShapeKind::Any => 0,
        ShapeKind::Triangle => 1,
        ShapeKind::Rectangle => 2,
        ShapeKind::Ellipse => 3,
        ShapeKind::Circle => 4,
        ShapeKind::RotatedRectangle => 5,
        ShapeKind::Quadratic => 6,
        ShapeKind::RotatedEllipse => 7,
        ShapeKind::Polygon => 8,
        other => return Err(format!("Go primitive has no shape kind {}", other.as_str()).into()),
    })
}

fn run_go(
    primitive: &Path,
    input: &Path,
    temp: &Path,
    shape: ShapeKind,
    steps: u32,
) -> Result<Run, BoxError> {
    let png = temp.join("go.png");
    let svg = temp.join("go.svg");
    let start = Instant::now();
    let output = Command::new(primitive)
        .arg("-i")
        .arg(input)
        .arg("-o")
        .arg(&png)
        .arg("-o")
        .arg(&svg)
        .args(["-n", &steps.to_string()])
        .args(["-m", &go_mode(shape)?.to_string()])
        .args(["-a", &ALPHA.to_string()])
        .args(["-r", &RESIZE_INPUT.to_string()])
        .args(["-s", &OUTPUT_SIZE.to_string()])
        .output()?;
    let time = start.elapsed();
    if !output.status.success() {
        return Err(format!(
            "primitive failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let rendered = image::open(&png)?.to_rgb8();
    let svg_bytes = usize::try_from(std::fs::metadata(&svg)?.len())?;
    std::fs::remove_file(&png)?;
    std::fs::remove_file(&svg)?;
    Ok(Run {
        time,
        rendered,
        svg_bytes: Some(svg_bytes),
    })
}

fn primeval_options(shape: ShapeKind, steps: u32) -> RenderOptions {
    let mut render = RenderOptions::default();
    render.count = steps;
    render.shape = shape;
    render.alpha = Alpha::Fixed(NonZeroU8::new(ALPHA).expect("alpha is non-zero"));
    render.seed = Some(SEED);
    render.resize_input = RESIZE_INPUT;
    render.output_size = OUTPUT_SIZE;
    render
}

fn run_primeval(input: &Path, shape: ShapeKind, steps: u32) -> Result<Run, BoxError> {
    let start = Instant::now();
    let result = approximate(
        ApproximateRequest {
            input: std::fs::read(input)?,
            output: OutputFormat::Png,
            render: primeval_options(shape, steps),
        },
        Execution::new(),
    )?;
    let time = start.elapsed();
    let ApproximateResult::Png { data, .. } = result else {
        return Err("requested PNG output".into());
    };
    let rendered = image::load_from_memory_with_format(&data, ImageFormat::Png)?.to_rgb8();
    Ok(Run {
        time,
        rendered,
        svg_bytes: None,
    })
}

/// The size of primeval's SVG for the same options; untimed.
fn primeval_svg_bytes(input: &Path, shape: ShapeKind, steps: u32) -> Result<usize, BoxError> {
    let result = approximate(
        ApproximateRequest {
            input: std::fs::read(input)?,
            output: OutputFormat::Svg,
            render: primeval_options(shape, steps),
        },
        Execution::new(),
    )?;
    Ok(result.into_bytes().len())
}

/// RGB RMSE on the 0–255 scale: `sqrt(Σ Δ² / (w · h · 3))`.
fn rgb_rmse(left: &RgbImage, right: &RgbImage) -> f64 {
    let sum: u64 = left
        .as_raw()
        .iter()
        .zip(right.as_raw())
        .map(|(&a, &b)| u64::from(a.abs_diff(b)).pow(2))
        .sum();
    (sum as f64 / left.as_raw().len() as f64).sqrt()
}

fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let (sum, count) = values.fold((0.0, 0_u32), |(sum, count), value| (sum + value, count + 1));
    sum / f64::from(count)
}

fn geometric_mean(values: impl Iterator<Item = f64>) -> f64 {
    mean(values.map(f64::ln)).exp()
}

fn print_report(config: &Config, rows: &[Row]) {
    print_header(config);
    println!("## By shape kind, over all images");
    println!();
    println!("{TABLE_HEAD}");
    println!("{TABLE_RULE}");
    for &steps in &config.steps {
        for &shape in &config.shapes {
            let group: Vec<&Row> = rows
                .iter()
                .filter(|row| row.steps == steps && row.shape == shape)
                .collect();
            let go = combine(group.iter().map(|row| &row.go));
            let primeval = combine(group.iter().map(|row| &row.primeval));
            println!(
                "| {steps} | {} | {} |",
                shape.as_str(),
                cells(&go, &primeval)
            );
        }
    }
    println!();
    println!("## By configuration");
    println!();
    println!("| image {TABLE_HEAD}");
    println!("| --- {TABLE_RULE}");
    for row in rows {
        println!(
            "| {} | {} | {} | {} |",
            row.image,
            row.steps,
            row.shape.as_str(),
            cells(&row.go, &row.primeval)
        );
    }
    println!();
    println!("## Totals");
    println!();
    for &steps in &config.steps {
        let group: Vec<&Row> = rows.iter().filter(|row| row.steps == steps).collect();
        let go: Duration = group.iter().map(|row| row.go.time).sum();
        let primeval: Duration = group.iter().map(|row| row.primeval.time).sum();
        let speedup = geometric_mean(
            group
                .iter()
                .map(|row| row.go.time.as_secs_f64() / row.primeval.time.as_secs_f64()),
        );
        let ratio = geometric_mean(group.iter().map(|row| row.primeval.rmse / row.go.rmse));
        let better = group
            .iter()
            .filter(|row| row.primeval.rmse < row.go.rmse)
            .count();
        println!(
            "- {steps} steps: Go {:.1} s, primeval {:.1} s; geometric-mean speedup {speedup:.2}×, \
             RMSE ratio {ratio:.3}; primeval's RMSE lower in {better} of {} configurations",
            go.as_secs_f64(),
            primeval.as_secs_f64(),
            group.len()
        );
    }
}

/// The shared columns after the leading `|` of the image column, if any.
const TABLE_HEAD: &str = "| steps | shape | Go time | primeval time | speedup | Go RMSE | \
                          primeval RMSE | RMSE ratio | Go SVG KB | primeval SVG KB |";
const TABLE_RULE: &str = "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

/// Summed times, mean RMSEs and mean SVG sizes over several configurations.
fn combine<'a>(measured: impl Iterator<Item = &'a Measured> + Clone) -> Measured {
    Measured {
        time: measured.clone().map(|m| m.time).sum(),
        rmse: mean(measured.clone().map(|m| m.rmse)),
        svg_bytes: mean(measured.map(|m| m.svg_bytes)),
    }
}

fn cells(go: &Measured, primeval: &Measured) -> String {
    format!(
        "{:.2} s | {:.2} s | {:.2}× | {:.2} | {:.2} | {:.3} | {:.0} | {:.0}",
        go.time.as_secs_f64(),
        primeval.time.as_secs_f64(),
        go.time.as_secs_f64() / primeval.time.as_secs_f64(),
        go.rmse,
        primeval.rmse,
        primeval.rmse / go.rmse,
        go.svg_bytes / 1024.0,
        primeval.svg_bytes / 1024.0
    )
}

fn print_header(config: &Config) {
    let commit = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain"]).is_some_and(|status| !status.is_empty());
    let cores = std::thread::available_parallelism().map_or(0, std::num::NonZeroUsize::get);
    println!("# primeval versus Go primitive");
    println!();
    println!("- commit: {commit}{}", if dirty { " (dirty)" } else { "" });
    println!(
        "- primitive: {}",
        primitive_version(&config.primitive).unwrap_or_else(|| "unknown version".into())
    );
    println!(
        "- machine: {} {}, {}, {cores} logical cores",
        std::env::consts::OS,
        std::env::consts::ARCH,
        cpu_model().unwrap_or_else(|| "unknown CPU".into())
    );
    println!(
        "- options: alpha {ALPHA}, working size {RESIZE_INPUT}, output size {OUTPUT_SIZE}, \
         background average; primeval seed {SEED}; {} runs per tool and configuration",
        config.reps
    );
    println!(
        "- timing: Go as a process, primeval in-process (the Node CLI adds about 0.1 s); \
         median times, Go RMSE is the mean of its runs"
    );
    println!();
}

/// The module version `go version -m` reports for the binary, if Go is
/// installed.
fn primitive_version(primitive: &Path) -> Option<String> {
    let output = Command::new("go")
        .args(["version", "-m"])
        .arg(primitive)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let go = text.lines().next()?.rsplit_once(": ")?.1.trim().to_owned();
    let module = text.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        (fields.next() == Some("mod")).then(|| fields.take(2).collect::<Vec<_>>().join(" "))
    })?;
    Some(format!("{module}, built with {go}"))
}
