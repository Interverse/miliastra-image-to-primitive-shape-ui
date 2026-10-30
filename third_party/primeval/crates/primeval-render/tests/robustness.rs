//! Seeded randomized robustness tests: the stable-toolchain stand-in for
//! fuzzing. Each test is deterministic, so a failure reproduces exactly.

use image::{ImageFormat, RgbaImage};
use primeval_render::{
    Alpha, ApproximateError, ApproximateRequest, BackgroundOption, Color, Execution, OutputFormat,
    RenderOptions, ShapeKind, approximate,
};
use rand::{Rng, RngExt, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::io::Cursor;
use std::num::NonZeroU8;
use std::str::FromStr;

const SHAPES: [&str; 9] = [
    "any",
    "triangle",
    "rectangle",
    "ellipse",
    "circle",
    "rotated-rectangle",
    "quadratic",
    "rotated-ellipse",
    "polygon",
];

/// Pieces random strings are built from: valid tokens, near misses, ASCII
/// that the parsers treat specially, multi-byte and control characters.
const PIECES: &[&str] = &[
    "auto",
    "AUTO",
    "Auto",
    "svg",
    "png",
    "SVG",
    "any",
    "triangle",
    "rotated-",
    "rectangle",
    "ellipse",
    "circle",
    "quadratic",
    "polygon",
    "1",
    "25",
    "255",
    "256",
    "0",
    "00",
    "4294967296",
    "#",
    "+",
    "-",
    " ",
    ".",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "A",
    "F",
    "g",
    "x",
    "9",
    "€",
    "é",
    "ı",
    "\u{212A}",
    "\u{1F600}",
    "\u{0}",
    "\n",
    "\t",
    "\u{7f}",
    "\u{feff}",
];

fn random_string(rng: &mut impl Rng) -> String {
    let pieces = rng.random_range(0..=4);
    (0..pieces)
        .map(|_| PIECES[rng.random_range(0..PIECES.len())])
        .collect()
}

fn is_valid_alpha(value: &str) -> bool {
    if value == "auto" {
        return true;
    }
    let digits = value;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let significant = digits.trim_start_matches('0');
    significant.len() <= 3 && (1..=255).contains(&significant.parse::<u16>().unwrap_or(0))
}

fn is_valid_background(value: &str) -> bool {
    if value == "auto" {
        return true;
    }
    let digits = value.strip_prefix('#').unwrap_or(value);
    matches!(digits.len(), 3 | 6) && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Runs `count` random strings through `T::from_str`, asserting it accepts
/// exactly the strings `valid` accepts, and that both outcomes occur.
fn check_parser<T: FromStr>(seed: u64, count: usize, valid: impl Fn(&str) -> bool) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let (mut accepted, mut rejected) = (0, 0);
    for _ in 0..count {
        let value = random_string(&mut rng);
        let parsed = value.parse::<T>().is_ok();
        assert_eq!(parsed, valid(&value), "{value:?}");
        if parsed {
            accepted += 1;
        } else {
            rejected += 1;
        }
    }
    assert!(accepted > 0 && rejected > 0, "{accepted} / {rejected}");
}

#[test]
fn parsers_accept_exactly_the_valid_strings() {
    const COUNT: usize = 20_000;
    check_parser::<ShapeKind>(1, COUNT, |value| SHAPES.contains(&value));
    check_parser::<OutputFormat>(2, COUNT, |value| matches!(value, "svg" | "png"));
    check_parser::<Alpha>(3, COUNT, is_valid_alpha);
    check_parser::<BackgroundOption>(4, COUNT, is_valid_background);
}

fn random_options(rng: &mut impl Rng) -> RenderOptions {
    let mut render = RenderOptions::default();
    render.count = rng.random_range(1..=3);
    render.shape = SHAPES[rng.random_range(0..SHAPES.len())]
        .parse()
        .expect("a valid shape");
    render.alpha = if rng.random_bool(0.5) {
        Alpha::Auto
    } else {
        Alpha::Fixed(NonZeroU8::new(rng.random_range(1..=255)).expect("non-zero"))
    };
    render.seed = Some(rng.random());
    render.background = if rng.random_bool(0.5) {
        BackgroundOption::Auto
    } else {
        BackgroundOption::Color(Color::new(rng.random(), rng.random(), rng.random(), 255))
    };
    render.resize_input = rng.random_range(2..=16);
    render.output_size = rng.random_range(2..=32);
    render
}

fn random_png(rng: &mut impl Rng, width: u32, height: u32) -> Vec<u8> {
    let mut pixels = vec![0; (width * height * 4) as usize];
    rng.fill_bytes(&mut pixels);
    let image = RgbaImage::from_raw(width, height, pixels).expect("pixel buffer size");
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .expect("PNG encoding");
    png
}

fn render(rng: &mut impl Rng, input: Vec<u8>) -> Result<(), ApproximateError> {
    let render = random_options(rng);
    let output = if rng.random_bool(0.5) {
        OutputFormat::Svg
    } else {
        OutputFormat::Png
    };
    let result = approximate(
        ApproximateRequest {
            input,
            output,
            render,
        },
        Execution::new(),
    )?;
    assert_eq!(result.format(), output);
    assert_eq!(result.width().max(result.height()), render.output_size);
    Ok(())
}

#[test]
fn tiny_random_images_render_or_fail_as_invalid_images() {
    let mut rng = ChaCha8Rng::seed_from_u64(5);
    for _ in 0..100 {
        let (width, height) = (rng.random_range(1..=8), rng.random_range(1..=8));
        let png = random_png(&mut rng, width, height);
        let result = render(&mut rng, png);
        if width >= 2 && height >= 2 {
            assert!(result.is_ok(), "{width}x{height}: {result:?}");
        } else {
            assert!(
                matches!(result, Err(ApproximateError::InvalidImage { .. })),
                "{width}x{height}: {result:?}"
            );
        }
    }
}

#[test]
fn garbage_and_truncated_inputs_never_panic() {
    let mut rng = ChaCha8Rng::seed_from_u64(6);
    for case in 0..200 {
        let garbage = case % 2 == 0;
        let input = if garbage {
            let mut bytes = vec![0; rng.random_range(0..64)];
            rng.fill_bytes(&mut bytes);
            bytes
        } else {
            let mut png = random_png(&mut rng, 4, 4);
            png.truncate(rng.random_range(0..png.len()));
            png
        };
        let result = render(&mut rng, input.clone());
        // A PNG cut inside its trailer still decodes.
        assert!(
            matches!(result, Err(ApproximateError::InvalidImage { .. }))
                || (!garbage && result.is_ok()),
            "{input:?}: {result:?}"
        );
    }
}
