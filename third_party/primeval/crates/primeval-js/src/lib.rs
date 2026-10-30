//! The JavaScript-facing request layer shared by the napi and wasm bindings.
//!
//! Each binding converts its own JavaScript values into the binding-neutral
//! types here ([`JsRenderOptions`], [`JsAlpha`], [`JsSeed`]); this crate parses
//! them with the `primeval-render` parsers and merges them onto
//! [`RenderOptions::default`], so an absent field always takes the Rust
//! default. It also owns the JavaScript spelling of option names and error
//! messages. `docs/architecture.md` in the repository describes how it fits
//! with the bindings.
#![warn(missing_docs)]

use primeval_render::{
    Alpha, ApproximateError, ApproximateRequest, BackgroundOption, OutputFormat,
    PartialRenderOptions, RenderOption, RenderOptions, ShapeKind,
};
use std::any::Any;

/// The render options of one JavaScript request. `None` means the field was
/// absent, so Rust chooses its default.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JsRenderOptions {
    /// JavaScript numbers arrive as `f64`; Rust checks they are integers in
    /// range, so nothing wraps or truncates at this boundary.
    pub count: Option<f64>,
    /// A shape name.
    pub shape: Option<String>,
    /// `"auto"` or a number; Rust validates both.
    pub alpha: Option<JsAlpha>,
    /// A safe-integer number or a `bigint` in `0..=2^64 - 1`.
    pub seed: Option<JsSeed>,
    /// `"auto"` or a hex color.
    pub background: Option<String>,
    /// The `resizeInput` option.
    pub resize_input: Option<f64>,
    /// The `outputSize` option.
    pub output_size: Option<f64>,
}

/// A JavaScript `alpha` value: a number or a string.
#[derive(Debug, Clone, PartialEq)]
pub enum JsAlpha {
    /// A JavaScript number.
    Number(f64),
    /// A JavaScript string, such as `"auto"`.
    Text(String),
}

/// A JavaScript `seed` value: a number or a `bigint`.
#[derive(Debug, Clone, PartialEq)]
pub enum JsSeed {
    /// A JavaScript number; it must be a safe non-negative integer.
    Number(f64),
    /// A `bigint` the binding found in `0..=u64::MAX`.
    BigInt(u64),
    /// A `bigint` outside `0..=u64::MAX`, rejected as an invalid seed.
    BigIntOutOfRange,
}

/// Parses the explicit fields and leaves omitted ones to the Rust defaults.
pub fn normalize_request(
    input: Vec<u8>,
    output: &str,
    render: JsRenderOptions,
) -> Result<ApproximateRequest, ApproximateError> {
    let invalid = ApproximateError::invalid_option;
    let output = output
        .parse::<OutputFormat>()
        .map_err(|_| invalid(RenderOption::Output))?;

    let mut partial = PartialRenderOptions::default();
    if let Some(count) = render.count {
        partial.set_number(RenderOption::Count, count)?;
    }
    partial.shape = render
        .shape
        .as_deref()
        .map(str::parse::<ShapeKind>)
        .transpose()
        .map_err(|_| invalid(RenderOption::Shape))?;
    match render.alpha {
        Some(JsAlpha::Number(alpha)) => partial.set_number(RenderOption::Alpha, alpha)?,
        Some(JsAlpha::Text(alpha)) => {
            partial.alpha = Some(
                alpha
                    .parse::<Alpha>()
                    .map_err(|_| invalid(RenderOption::Alpha))?,
            );
        }
        None => {}
    }
    partial.background = render
        .background
        .as_deref()
        .map(str::parse::<BackgroundOption>)
        .transpose()
        .map_err(|_| invalid(RenderOption::Background))?;
    match render.seed {
        Some(JsSeed::Number(seed)) => partial.set_number(RenderOption::Seed, seed)?,
        Some(JsSeed::BigInt(seed)) => partial.seed = Some(seed),
        Some(JsSeed::BigIntOutOfRange) => return Err(invalid(RenderOption::Seed)),
        None => {}
    }
    if let Some(resize_input) = render.resize_input {
        partial.set_number(RenderOption::ResizeInput, resize_input)?;
    }
    if let Some(output_size) = render.output_size {
        partial.set_number(RenderOption::OutputSize, output_size)?;
    }

    Ok(ApproximateRequest {
        input,
        output,
        render: RenderOptions::default().merge(partial),
    })
}

/// The JavaScript spelling of an option name. This is the only place that
/// maps Rust option names to JavaScript ones.
pub fn js_option_name(option: RenderOption) -> &'static str {
    match option {
        RenderOption::ResizeInput => "resizeInput",
        RenderOption::OutputSize => "outputSize",
        other => other.name(),
    }
}

/// The message JavaScript callers see: option names in JavaScript spelling,
/// followed by the chain of error sources.
pub fn js_message(error: &ApproximateError) -> String {
    let mut message = match error {
        ApproximateError::InvalidOption { option } => {
            format!("{} {}", js_option_name(*option), option.requirement())
        }
        other => other.to_string(),
    };
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// The properties of the JavaScript `Error` a binding throws for an
/// [`ApproximateError`]; each binding builds the object itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsErrorFields {
    /// The stable error code, [`ApproximateError::code`].
    pub code: &'static str,
    /// The message, [`js_message`].
    pub message: String,
    /// The option of an [`ApproximateError::InvalidOption`].
    pub invalid_option: Option<JsInvalidOption>,
}

/// The `option` and `requirement` properties of an invalid-option error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsInvalidOption {
    /// The option's JavaScript name, [`js_option_name`].
    pub option: &'static str,
    /// What the option accepts, [`RenderOption::requirement`].
    pub requirement: &'static str,
}

/// The JavaScript error properties for `error`.
pub fn js_error_fields(error: &ApproximateError) -> JsErrorFields {
    JsErrorFields {
        code: error.code(),
        message: js_message(error),
        invalid_option: match error {
            ApproximateError::InvalidOption { option } => Some(JsInvalidOption {
                option: js_option_name(*option),
                requirement: option.requirement(),
            }),
            _ => None,
        },
    }
}

/// The message of a panic payload, or a placeholder for a non-string one.
pub fn panic_message(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

/// The internal error a binding reports for a caught or hooked panic, with
/// the panic message: `render panicked: <message>`.
pub fn panic_error(payload: &(dyn Any + Send)) -> ApproximateError {
    ApproximateError::internal(format!("render panicked: {}", panic_message(payload)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU8;

    fn render_options(shape: &str) -> JsRenderOptions {
        JsRenderOptions {
            count: Some(1.0),
            shape: Some(shape.to_string()),
            alpha: Some(JsAlpha::Number(128.0)),
            seed: Some(JsSeed::Number(7.0)),
            background: Some("auto".to_string()),
            resize_input: Some(32.0),
            output_size: Some(32.0),
        }
    }

    fn normalize(render: JsRenderOptions) -> Result<ApproximateRequest, String> {
        normalize_request(vec![0_u8; 4], "svg", render)
            .map_err(|error| format!("{}: {}", error.code(), js_message(&error)))
    }

    #[test]
    fn normalize_request_uses_shared_shape_and_output_parsers() {
        let request = normalize_request(vec![0_u8; 4], "png", render_options("rotated-rectangle"))
            .expect("request should normalize");

        assert_eq!(request.output, OutputFormat::Png);
        assert_eq!(request.render.shape, ShapeKind::RotatedRectangle);
    }

    #[test]
    fn normalize_request_rejects_removed_output_formats() {
        for output in ["jpeg", "jpg", "gif"] {
            let error = normalize_request(vec![0_u8; 4], output, render_options("triangle"))
                .expect_err("removed output format should fail");

            assert_eq!(
                js_message(&error),
                "output must be one of: svg, png",
                "{output}"
            );
        }
    }

    #[test]
    fn normalize_request_rejects_unknown_shape() {
        let error = normalize(render_options("hexagon")).expect_err("shape should fail");

        assert_eq!(
            error,
            "INVALID_OPTION: shape must be one of: any, triangle, rectangle, ellipse, circle, \
             rotated-rectangle, quadratic, rotated-ellipse, polygon"
        );
    }

    #[test]
    fn normalize_request_uses_rust_defaults_for_omitted_render_fields() {
        let request = normalize(JsRenderOptions::default()).expect("request should normalize");

        assert_eq!(request.render, RenderOptions::default());
    }

    fn normalize_alpha(alpha: JsAlpha) -> Result<ApproximateRequest, String> {
        normalize(JsRenderOptions {
            alpha: Some(alpha),
            ..render_options("any")
        })
    }

    #[test]
    fn normalize_request_accepts_auto_alpha_string() {
        let request = normalize_alpha(JsAlpha::Text("auto".to_string())).expect("auto alpha");

        assert_eq!(request.render.alpha, Alpha::Auto);
    }

    #[test]
    fn normalize_request_accepts_integer_alpha() {
        let request = normalize_alpha(JsAlpha::Number(200.0)).expect("integer alpha");

        assert_eq!(
            request.render.alpha,
            Alpha::Fixed(NonZeroU8::new(200).expect("non-zero"))
        );
    }

    #[test]
    fn normalize_request_rejects_zero_and_out_of_range_alpha() {
        for alpha in [
            JsAlpha::Number(0.0),
            JsAlpha::Number(256.0),
            JsAlpha::Number(2_f64.powi(32) + 128.0),
            JsAlpha::Number(1.5),
            JsAlpha::Text("0".to_string()),
            JsAlpha::Text("half".to_string()),
        ] {
            let error = normalize_alpha(alpha).expect_err("alpha should fail");

            assert_eq!(
                error,
                "INVALID_OPTION: alpha must be auto or an integer 1..255"
            );
        }
    }

    #[test]
    fn numeric_options_do_not_wrap_and_use_js_names() {
        let wrapping = 2_f64.powi(32) + 1.0;
        type Setter = fn(&mut JsRenderOptions, f64);
        let cases: [(Setter, &str); 3] = [
            (|r, v| r.count = Some(v), "count"),
            (|r, v| r.resize_input = Some(v), "resizeInput"),
            (|r, v| r.output_size = Some(v), "outputSize"),
        ];
        for (set, name) in cases {
            for value in [wrapping, 1e20, -1.0, 1.5, f64::NAN] {
                let mut render = render_options("any");
                set(&mut render, value);

                let error = normalize(render).expect_err("value should fail");

                assert!(
                    error.starts_with(&format!("INVALID_OPTION: {name} must be an integer from ")),
                    "{name} = {value}: {error}"
                );
            }
        }
    }

    #[test]
    fn number_seeds_must_be_safe_non_negative_integers() {
        for seed in [-1.0, 1.5, f64::NAN, 2_f64.powi(53), 1e20] {
            let error = normalize(JsRenderOptions {
                seed: Some(JsSeed::Number(seed)),
                ..render_options("any")
            })
            .expect_err("seed should fail");

            assert!(
                error.starts_with("INVALID_OPTION: seed must be an integer from 0 to 2^64 - 1"),
                "{seed}: {error}"
            );
        }

        let request = normalize(JsRenderOptions {
            seed: Some(JsSeed::Number(2_f64.powi(53) - 1.0)),
            ..render_options("any")
        })
        .expect("max safe integer seed");
        assert_eq!(request.render.seed, Some(9_007_199_254_740_991));
    }

    #[test]
    fn bigint_seeds_cover_the_full_u64_range() {
        for value in [0, 7, u64::MAX] {
            let request = normalize(JsRenderOptions {
                seed: Some(JsSeed::BigInt(value)),
                ..render_options("any")
            })
            .expect("bigint seed");
            assert_eq!(request.render.seed, Some(value));
        }

        let error = normalize(JsRenderOptions {
            seed: Some(JsSeed::BigIntOutOfRange),
            ..render_options("any")
        })
        .expect_err("out-of-range bigint seed should fail");
        assert!(
            error.starts_with("INVALID_OPTION: seed must be an integer from 0 to 2^64 - 1"),
            "{error}"
        );
    }

    #[test]
    fn normalize_request_rejects_invalid_background() {
        let error = normalize(JsRenderOptions {
            background: Some("#1234".to_string()),
            ..render_options("any")
        })
        .expect_err("background should fail");

        assert_eq!(
            error,
            "INVALID_OPTION: background must be auto or an opaque hex color (RGB or RRGGBB)"
        );
    }

    #[test]
    fn js_message_appends_the_source_chain() {
        let error = ApproximateError::Internal {
            reason: "PNG encoding failed".into(),
            source: Some(Box::new(std::io::Error::other("disk full"))),
        };

        assert_eq!(
            js_message(&error),
            "internal render error: PNG encoding failed: disk full"
        );
    }

    #[test]
    fn js_error_fields_carry_the_code_message_and_invalid_option() {
        assert_eq!(
            js_error_fields(&ApproximateError::invalid_option(RenderOption::ResizeInput)),
            JsErrorFields {
                code: "INVALID_OPTION",
                message: format!("resizeInput {}", RenderOption::ResizeInput.requirement()),
                invalid_option: Some(JsInvalidOption {
                    option: "resizeInput",
                    requirement: RenderOption::ResizeInput.requirement(),
                }),
            }
        );

        let internal = ApproximateError::internal("boom");
        assert_eq!(
            js_error_fields(&internal),
            JsErrorFields {
                code: "INTERNAL",
                message: js_message(&internal),
                invalid_option: None,
            }
        );
    }

    #[test]
    fn panic_message_reads_static_and_formatted_payloads() {
        assert_eq!(panic_message(&"static"), "static");
        assert_eq!(panic_message(&String::from("formatted")), "formatted");
        assert_eq!(panic_message(&42_u8), "non-string panic payload");
    }

    #[test]
    fn panic_error_is_an_internal_error_with_the_panic_message() {
        let error = panic_error(&String::from("boom 7"));

        assert_eq!(error.code(), "INTERNAL");
        assert_eq!(
            js_message(&error),
            "internal render error: render panicked: boom 7"
        );
    }
}
