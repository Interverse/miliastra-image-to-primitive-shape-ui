//! The corpus and run header shared by the `quality` and `engine` runners,
//! whose header helpers `versus_go` uses too.
//!
//! Cargo does not build `examples/common/` as an example of its own; each
//! runner includes it with `mod common;`.

use image::{ImageFormat, Rgb, RgbImage};
use primeval_render::ShapeKind;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) type BoxError = Box<dyn std::error::Error>;

pub(crate) const SEED: u64 = 42;
pub(crate) const ALL_SHAPES: [ShapeKind; 9] = [
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
const DEFAULT_PHOTOS: [&str; 2] = ["monalisa.jpg", "americangothic.jpg"];
const SYNTHETIC_SIZE: u32 = 512;

/// One input image: its name in the table and its encoded bytes.
pub(crate) struct Input {
    pub(crate) name: String,
    pub(crate) bytes: Vec<u8>,
}

/// The paths of [`DEFAULT_PHOTOS`] in `docs/readme/originals/`.
pub(crate) fn default_photos() -> Vec<PathBuf> {
    let originals = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/readme/originals");
    DEFAULT_PHOTOS
        .iter()
        .map(|name| originals.join(name))
        .collect()
}

/// Reads `photos`, adds the generated images if `synthetic` is set, and
/// sorts the inputs by name.
pub(crate) fn load_inputs(photos: &[PathBuf], synthetic: bool) -> Result<Vec<Input>, BoxError> {
    let mut inputs = Vec::new();
    for path in photos {
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or("image path has no file name")?
            .to_owned();
        inputs.push(Input {
            name,
            bytes: std::fs::read(path)?,
        });
    }
    if synthetic {
        inputs.extend(synthetic_inputs()?);
    }
    inputs.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(inputs)
}

/// Normalised RGB RMSE: `sqrt(Σ Δ² / (w · h · 3)) / 255`.
pub(crate) fn rgb_rmse(left: &RgbImage, right: &RgbImage) -> f64 {
    assert_eq!(left.dimensions(), right.dimensions(), "size mismatch");
    let sum: u64 = left
        .as_raw()
        .iter()
        .zip(right.as_raw())
        .map(|(&a, &b)| u64::from(a.abs_diff(b)).pow(2))
        .sum();
    (sum as f64 / left.as_raw().len() as f64).sqrt() / 255.0
}

/// Prints the `- commit:` and `- machine:` header lines.
pub(crate) fn print_commit_and_machine() {
    let commit = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain"]).is_some_and(|status| !status.is_empty());
    let cores = std::thread::available_parallelism().map_or(0, std::num::NonZeroUsize::get);
    println!("- commit: {commit}{}", if dirty { " (dirty)" } else { "" });
    println!(
        "- machine: {} {}, {}, {cores} logical cores",
        std::env::consts::OS,
        std::env::consts::ARCH,
        cpu_model().unwrap_or_else(|| "unknown CPU".into())
    );
}

/// The trimmed output of `git args` in this crate, if it succeeds.
pub(crate) fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// The CPU's model name, if the platform reports one.
pub(crate) fn cpu_model() -> Option<String> {
    if cfg!(target_os = "macos") {
        let output = Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()?;
        let model = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return (!model.is_empty()).then_some(model);
    }
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    cpuinfo
        .lines()
        .find_map(|line| line.strip_prefix("model name")?.split_once(':'))
        .map(|(_, model)| model.trim().to_owned())
}

/// Computes one pixel of a generated image.
type Generator = fn(u32, u32) -> Rgb<u8>;

/// The generated images, encoded as PNG.
fn synthetic_inputs() -> Result<Vec<Input>, BoxError> {
    let generators: [(&str, Generator); 3] = [
        ("synthetic-gradient", gradient),
        ("synthetic-shapes", hard_shapes),
        ("synthetic-texture", texture),
    ];
    generators
        .into_iter()
        .map(|(name, pixel)| {
            let image = RgbImage::from_fn(SYNTHETIC_SIZE, SYNTHETIC_SIZE, pixel);
            let mut bytes = Vec::new();
            image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)?;
            Ok(Input {
                name: name.to_owned(),
                bytes,
            })
        })
        .collect()
}

/// Unit coordinates of a synthetic pixel.
fn unit(x: u32, y: u32) -> (f64, f64) {
    let side = f64::from(SYNTHETIC_SIZE);
    (f64::from(x) / side, f64::from(y) / side)
}

fn channel(value: f64) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// A smooth two-axis colour gradient with a radial term.
fn gradient(x: u32, y: u32) -> Rgb<u8> {
    let (u, v) = unit(x, y);
    let radial = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt();
    Rgb([channel(u), channel(v), channel(1.0 - radial * 1.4)])
}

/// Flat-coloured, hard-edged shapes on a flat background.
fn hard_shapes(x: u32, y: u32) -> Rgb<u8> {
    let (u, v) = unit(x, y);
    if (u - 0.3).powi(2) + (v - 0.3).powi(2) < 0.04 {
        Rgb([200, 30, 40])
    } else if (0.55..0.9).contains(&u) && (0.15..0.45).contains(&v) {
        Rgb([30, 90, 200])
    } else if v > 0.55 && v < 0.95 && (u - 0.5).abs() < (v - 0.55) {
        Rgb([240, 200, 30])
    } else if (0.05..0.25).contains(&u) && v > 0.6 {
        Rgb([20, 20, 20])
    } else {
        Rgb([235, 235, 225])
    }
}

/// High-frequency detail: fine stripes, a checkerboard and hashed noise.
fn texture(x: u32, y: u32) -> Rgb<u8> {
    let (u, v) = unit(x, y);
    let stripes = 0.5 + 0.5 * (u * 90.0 + v * 30.0).sin();
    let checker = if (x / 4 + y / 4).is_multiple_of(2) {
        1.0
    } else {
        0.0
    };
    let mut hash = u64::from(x) << 32 | u64::from(y);
    hash = hash.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    hash ^= hash >> 29;
    let noise = (hash & 0xFF) as f64 / 255.0;
    Rgb([
        channel(stripes),
        channel(0.25 + 0.5 * checker),
        channel(0.3 * noise + 0.7 * v),
    ])
}
