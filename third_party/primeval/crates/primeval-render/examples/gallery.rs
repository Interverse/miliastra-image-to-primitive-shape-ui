//! Regenerates the progression gallery and the README's alpha comparison.
//!
//! Usage:
//!
//! ```text
//! cargo run --release -p primeval-render --example gallery
//! ```
//!
//! For every image in `docs/readme/originals/` (JPEG, PNG or WebP), every
//! shape kind (including `any`) and every step count in [`STEPS`], it runs
//! [`approximate`] with default options and seed 42, and writes:
//!
//! - the SVG to `docs/images/progression/<image>/<shape>-<steps>.svg`;
//! - a JPEG thumbnail, [`THUMB_SIZE`] pixels on its long side, to
//!   `docs/images/thumbs/<image>/<shape>-<steps>.jpg`. The thumbnail comes
//!   from a second, PNG render with the same options; the search is
//!   deterministic, so both renders draw the same shapes, which the tool
//!   checks by comparing their final scores.
//!
//! It then writes `docs/gallery.md`, and the alpha comparison of the README
//! to `docs/readme/comparisons/`: `monalisa.jpg` with shape kind `any`, 200
//! steps, alpha `auto` and alpha 128, and their per-pixel difference with
//! its contrast stretched. The two directories under `docs/images/` and the
//! comparison directory are generated output: the tool deletes them first,
//! so files from an earlier step count or a removed original do not linger.
//!
//! Thumbnails and comparison images are JPEG, at quality [`JPEG_QUALITY`]:
//! overlapping translucent shapes leave little for lossless formats to
//! compress, so PNG and lossless WebP files are four to six times larger.
//! The SVGs the thumbnails link to are the exact output.
//!
//! Only JPEG, PNG and WebP files count as originals; other files in the
//! directory, such as `SOURCES.md` with the credits the gallery links to,
//! are ignored.
//!
//! The gallery title of an image comes from [`TITLES`] or, for other files,
//! from the file name, `mae-jemison.jpg` becoming "Mae Jemison". The
//! output is the same on every run for a given commit and platform, so
//! regenerating changes only the files of new originals unless the engine
//! changed.

use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageFormat, Rgb, RgbImage};
use primeval_render::{
    Alpha, ApproximateRequest, ApproximateResult, Execution, OutputFormat, ProgressInfo,
    RenderOptions, ShapeKind, approximate,
};
use std::fmt::Write as _;
use std::fs;
use std::num::NonZeroU8;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// The seed of every render.
const SEED: u64 = 42;
/// The step counts of the gallery's columns.
const STEPS: [u32; 3] = [50, 200, 1000];
/// The long side of a thumbnail, in pixels: twice the gallery's display
/// width, so thumbnails stay sharp on high-density screens.
const THUMB_SIZE: u32 = 480;
/// The width the gallery displays a thumbnail at, in CSS pixels.
const THUMB_DISPLAY_WIDTH: u32 = 240;
/// The quality of the JPEG thumbnails and comparison images.
const JPEG_QUALITY: u8 = 85;
/// The long side of the alpha comparison images, in pixels.
const COMPARISON_SIZE: u32 = 512;
/// The factor the comparison's difference image multiplies each channel's
/// absolute difference by.
const DIFF_BOOST: u16 = 4;
/// The shape kinds of the gallery's rows, with their labels.
const SHAPES: [(ShapeKind, &str); 9] = [
    (ShapeKind::Any, "Mixed"),
    (ShapeKind::Triangle, "Triangle"),
    (ShapeKind::Rectangle, "Rectangle"),
    (ShapeKind::Ellipse, "Ellipse"),
    (ShapeKind::Circle, "Circle"),
    (ShapeKind::RotatedRectangle, "Rotated Rectangle"),
    (ShapeKind::Quadratic, "Quadratic"),
    (ShapeKind::RotatedEllipse, "Rotated Ellipse"),
    (ShapeKind::Polygon, "Polygon"),
];
/// Gallery titles for file stems that do not spell them out.
const TITLES: [(&str, &str); 2] = [
    ("americangothic", "American Gothic"),
    ("monalisa", "Mona Lisa"),
];
/// The original the alpha comparison uses.
const COMPARISON_IMAGE: &str = "monalisa";

type BoxError = Box<dyn std::error::Error>;

/// One original image.
struct Original {
    path: PathBuf,
    stem: String,
    title: String,
    bytes: Vec<u8>,
}

/// One generated cell of the gallery.
struct Cell {
    shape: ShapeKind,
    label: &'static str,
    steps: u32,
    svg_bytes: usize,
}

fn main() -> Result<(), BoxError> {
    if std::env::args().len() > 1 {
        return Err("gallery takes no arguments; see the doc comment".into());
    }
    let docs = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs");
    let originals = read_originals(&docs.join("readme/originals"))?;
    let progression = docs.join("images/progression");
    let thumbs = docs.join("images/thumbs");
    let comparisons = docs.join("readme/comparisons");
    for dir in [&progression, &thumbs, &comparisons] {
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
    }

    let start = Instant::now();
    let mut gallery = Vec::new();
    for original in &originals {
        fs::create_dir_all(progression.join(&original.stem))?;
        fs::create_dir_all(thumbs.join(&original.stem))?;
        let mut cells = Vec::new();
        for (shape, label) in SHAPES {
            for steps in STEPS {
                eprintln!("{} {} {steps}", original.stem, shape.as_str());
                let name = format!("{}-{steps}", shape.as_str());
                let (svg, svg_score) = render(original, shape, steps, Alpha::Auto, None)?;
                let ApproximateResult::Svg { data: svg, .. } = svg else {
                    return Err("requested SVG output".into());
                };
                let (png, png_score) =
                    render(original, shape, steps, Alpha::Auto, Some(THUMB_SIZE))?;
                if svg_score != png_score {
                    return Err(format!(
                        "{} {name}: the SVG and PNG renders differ ({svg_score} vs {png_score})",
                        original.stem
                    )
                    .into());
                }
                fs::write(
                    progression.join(&original.stem).join(format!("{name}.svg")),
                    &svg,
                )?;
                fs::write(
                    thumbs.join(&original.stem).join(format!("{name}.jpg")),
                    jpeg(&decode_png(png)?)?,
                )?;
                cells.push(Cell {
                    shape,
                    label,
                    steps,
                    svg_bytes: svg.len(),
                });
            }
        }
        gallery.push((original, cells));
    }
    fs::write(docs.join("gallery.md"), gallery_markdown(&gallery))?;

    if let Some(original) = originals
        .iter()
        .find(|original| original.stem == COMPARISON_IMAGE)
    {
        write_comparison(original, &comparisons)?;
    }
    eprintln!("done in {:.1} s", start.elapsed().as_secs_f64());
    Ok(())
}

/// The images in `dir`, sorted by file name.
fn read_originals(dir: &Path) -> Result<Vec<Original>, BoxError> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let supported = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png" | "webp"
                )
            });
        if supported {
            paths.push(path);
        }
    }
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .ok_or("image file name is not UTF-8")?
                .to_owned();
            Ok(Original {
                title: title(&stem),
                bytes: fs::read(&path)?,
                stem,
                path,
            })
        })
        .collect()
}

/// The gallery title of a file stem.
fn title(stem: &str) -> String {
    if let Some((_, title)) = TITLES.iter().find(|(known, _)| *known == stem) {
        return (*title).to_owned();
    }
    stem.split(['-', '_'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Renders `original` as SVG at the default output size, or as PNG at
/// `png_size`, and returns the result with the final score.
fn render(
    original: &Original,
    shape: ShapeKind,
    steps: u32,
    alpha: Alpha,
    png_size: Option<u32>,
) -> Result<(ApproximateResult, f64), BoxError> {
    let mut render = RenderOptions::default();
    render.count = steps;
    render.shape = shape;
    render.alpha = alpha;
    render.seed = Some(SEED);
    if let Some(size) = png_size {
        render.output_size = size;
    }
    let mut score = None;
    let mut on_progress = |info: ProgressInfo| score = Some(info.score);
    let result = approximate(
        ApproximateRequest {
            input: original.bytes.clone(),
            output: if png_size.is_some() {
                OutputFormat::Png
            } else {
                OutputFormat::Svg
            },
            render,
        },
        Execution::new().progress(&mut on_progress),
    )?;
    Ok((result, score.ok_or("the render reported no steps")?))
}

fn decode_png(result: ApproximateResult) -> Result<RgbImage, BoxError> {
    let ApproximateResult::Png { data, .. } = result else {
        return Err("requested PNG output".into());
    };
    Ok(image::load_from_memory_with_format(&data, ImageFormat::Png)?.to_rgb8())
}

fn jpeg(image: &RgbImage) -> Result<Vec<u8>, BoxError> {
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode(
        image.as_raw(),
        image.width(),
        image.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

/// Writes the alpha `auto` and alpha 128 renders of `original` and their
/// boosted difference.
fn write_comparison(original: &Original, dir: &Path) -> Result<(), BoxError> {
    fs::create_dir_all(dir)?;
    let fixed = Alpha::Fixed(NonZeroU8::new(128).ok_or("alpha 128 is not zero")?);
    let mut renders = Vec::new();
    for (alpha, suffix) in [(Alpha::Auto, "auto"), (fixed, "128")] {
        eprintln!("{} comparison alpha {suffix}", original.stem);
        let (png, _) = render(original, ShapeKind::Any, 200, alpha, Some(COMPARISON_SIZE))?;
        let image = decode_png(png)?;
        fs::write(
            dir.join(format!("{}-any-200-alpha-{suffix}.jpg", original.stem)),
            jpeg(&image)?,
        )?;
        renders.push(image);
    }
    let [auto, fixed] = renders.as_slice() else {
        return Err("expected two renders".into());
    };
    let diff = RgbImage::from_fn(auto.width(), auto.height(), |x, y| {
        let (Rgb(a), Rgb(b)) = (auto.get_pixel(x, y), fixed.get_pixel(x, y));
        Rgb(std::array::from_fn(|channel| {
            let boosted = u16::from(a[channel].abs_diff(b[channel])) * DIFF_BOOST;
            u8::try_from(boosted.min(255)).unwrap_or(u8::MAX)
        }))
    });
    fs::write(
        dir.join(format!("{}-any-200-alpha-diff-boosted.jpg", original.stem)),
        jpeg(&diff)?,
    )?;
    Ok(())
}

/// A file size in KB with one decimal.
fn kilobytes(bytes: usize) -> String {
    format!("{:.1} KB", bytes as f64 / 1024.0)
}

fn gallery_markdown(gallery: &[(&Original, Vec<Cell>)]) -> String {
    let mut out = String::new();
    let steps = STEPS.map(|steps| steps.to_string()).join(", ");
    let _ = writeln!(out, "# Progression Gallery\n");
    let _ = writeln!(out, "<!-- markdownlint-disable MD033 -->\n");
    let _ = writeln!(
        out,
        "Each table below shows one original image, with shape modes in rows and step counts \
         in columns. Every preview is a JPEG thumbnail that links to the generated \
         SVG; the size under it is the SVG's.\n"
    );
    let _ = writeln!(
        out,
        "Generated by `cargo run --release -p primeval-render --example gallery` with default \
         options, seed {SEED} and {steps} steps. Do not edit this file by hand; see \
         `CONTRIBUTING.md`.\n"
    );
    let _ = writeln!(
        out,
        "The originals are in the public domain: \
         [Sources and credits](readme/originals/SOURCES.md).\n"
    );
    for (original, cells) in gallery {
        let stem = &original.stem;
        let file = original
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(stem);
        let extension = original
            .path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_uppercase();
        let _ = writeln!(out, "### {}\n", original.title);
        let _ = writeln!(out, "<p>");
        let _ = writeln!(
            out,
            "  <img src=\"readme/originals/{file}\" alt=\"Original {} source image.\" \
             width=\"300\" /><br />",
            original.title
        );
        let _ = writeln!(
            out,
            "  <sub>Original · {extension} {}</sub>",
            kilobytes(original.bytes.len())
        );
        let _ = writeln!(out, "</p>\n");
        let _ = writeln!(out, "<table>");
        let _ = writeln!(out, "  <tr>");
        let _ = writeln!(out, "    <th align=\"left\">Shape mode</th>");
        for steps in STEPS {
            let _ = writeln!(out, "    <th align=\"center\">{steps} steps</th>");
        }
        let _ = writeln!(out, "  </tr>");
        for row in cells.chunks(STEPS.len()) {
            let _ = writeln!(out, "  <tr>");
            let _ = writeln!(out, "    <td><strong>{}</strong></td>", row[0].label);
            for cell in row {
                let name = format!("{}-{}", cell.shape.as_str(), cell.steps);
                let _ = writeln!(out, "    <td align=\"center\">");
                let _ = writeln!(
                    out,
                    "      <a href=\"images/progression/{stem}/{name}.svg\">"
                );
                let _ = writeln!(
                    out,
                    "        <img src=\"images/thumbs/{stem}/{name}.jpg\" alt=\"{} approximated \
                     with {} after {} steps.\" width=\"{THUMB_DISPLAY_WIDTH}\" />",
                    original.title,
                    cell.label.to_lowercase(),
                    cell.steps
                );
                let _ = writeln!(out, "      </a>");
                let _ = writeln!(out, "      <br />");
                let _ = writeln!(out, "      <sub>SVG {}</sub>", kilobytes(cell.svg_bytes));
                let _ = writeln!(out, "    </td>");
            }
            let _ = writeln!(out, "  </tr>");
        }
        let _ = writeln!(out, "</table>\n");
    }
    let _ = writeln!(out, "<!-- markdownlint-enable MD033 -->");
    out
}
