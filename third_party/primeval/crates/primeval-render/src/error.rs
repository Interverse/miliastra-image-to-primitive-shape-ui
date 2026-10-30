//! The render error type and the option identifiers it names.

use primeval_core::ShapeKind;
use std::error::Error;
use std::fmt;

/// Boxed error source carried by [`ApproximateError`].
pub type BoxedSource = Box<dyn Error + Send + Sync + 'static>;

/// Identifies one render option, so every surface can print its own
/// spelling of the name.
///
/// [`name`](Self::name) is the Rust spelling (`resize_input`); other
/// surfaces map the identifier to theirs (the Node binding prints
/// `resizeInput`).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RenderOption {
    /// [`ApproximateRequest::output`](crate::ApproximateRequest::output).
    Output,
    /// [`RenderOptions::count`](crate::RenderOptions::count).
    Count,
    /// [`RenderOptions::shape`](crate::RenderOptions::shape).
    Shape,
    /// [`RenderOptions::alpha`](crate::RenderOptions::alpha).
    Alpha,
    /// [`RenderOptions::seed`](crate::RenderOptions::seed).
    Seed,
    /// [`RenderOptions::background`](crate::RenderOptions::background).
    Background,
    /// [`RenderOptions::resize_input`](crate::RenderOptions::resize_input).
    ResizeInput,
    /// [`RenderOptions::output_size`](crate::RenderOptions::output_size).
    OutputSize,
}

impl RenderOption {
    /// The Rust field name, e.g. `resize_input`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Output => "output",
            Self::Count => "count",
            Self::Shape => "shape",
            Self::Alpha => "alpha",
            Self::Seed => "seed",
            Self::Background => "background",
            Self::ResizeInput => "resize_input",
            Self::OutputSize => "output_size",
        }
    }

    /// What the option accepts, phrased to follow the option name: the
    /// message for an invalid value is `"{name} {requirement}"`.
    #[must_use]
    pub const fn requirement(self) -> &'static str {
        match self {
            Self::Output => "must be one of: svg, png",
            Self::Count => "must be an integer from 1 to 4294967295",
            Self::Shape => ShapeKind::REQUIREMENT,
            Self::Alpha => "must be auto or an integer 1..255",
            Self::Seed => {
                "must be an integer from 0 to 2^64 - 1 \
                 (given as a number, at most 2^53 - 1)"
            }
            Self::Background => "must be auto or an opaque hex color (RGB or RRGGBB)",
            Self::ResizeInput => "must be an integer from 2 to 2048",
            Self::OutputSize => "must be an integer from 2 to 8192",
        }
    }
}

impl fmt::Display for RenderOption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// Render-time failures from validation, decoding, cancellation, or
/// encoding.
///
/// [`code`](Self::code) gives a stable string per variant for callers that
/// cross a language boundary. `Display` does not repeat the
/// [`source`](Error::source) message; walk the chain to show it.
#[non_exhaustive]
#[derive(Debug)]
pub enum ApproximateError {
    /// An option value is outside what the render accepts.
    InvalidOption {
        /// The rejected option; [`RenderOption::requirement`] says what it
        /// accepts.
        option: RenderOption,
    },
    /// The input bytes are not a usable JPEG, PNG or WebP image.
    InvalidImage {
        /// What is wrong with the image.
        reason: String,
        /// The decoder error, when decoding failed.
        source: Option<BoxedSource>,
    },
    /// The render was cancelled through its
    /// [`CancellationToken`](crate::CancellationToken).
    Aborted,
    /// A failure that valid input should not cause: an encoder error, an
    /// allocation failure, or a caught panic.
    Internal {
        /// What failed.
        reason: String,
        /// The underlying error, when there is one.
        source: Option<BoxedSource>,
    },
}

impl ApproximateError {
    /// `"INVALID_OPTION"`, `"INVALID_IMAGE"`, `"ABORTED"`, or `"INTERNAL"`.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidOption { .. } => "INVALID_OPTION",
            Self::InvalidImage { .. } => "INVALID_IMAGE",
            Self::Aborted => "ABORTED",
            Self::Internal { .. } => "INTERNAL",
        }
    }

    /// An internal error without a source.
    #[must_use]
    pub fn internal(reason: impl Into<String>) -> Self {
        Self::Internal {
            reason: reason.into(),
            source: None,
        }
    }

    /// The error for an invalid value of `option`.
    #[must_use]
    pub const fn invalid_option(option: RenderOption) -> Self {
        Self::InvalidOption { option }
    }
}

impl fmt::Display for ApproximateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidOption { option } => write!(f, "{option} {}", option.requirement()),
            Self::InvalidImage { reason, .. } => write!(f, "invalid image data: {reason}"),
            Self::Aborted => f.write_str("render aborted"),
            Self::Internal { reason, .. } => write!(f, "internal render error: {reason}"),
        }
    }
}

impl Error for ApproximateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidImage { source, .. } | Self::Internal { source, .. } => source
                .as_deref()
                .map(|source| source as &(dyn Error + 'static)),
            Self::InvalidOption { .. } | Self::Aborted => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn codes_are_stable() {
        let cases = [
            (
                ApproximateError::invalid_option(RenderOption::Count),
                "INVALID_OPTION",
            ),
            (
                ApproximateError::InvalidImage {
                    reason: "bad".into(),
                    source: None,
                },
                "INVALID_IMAGE",
            ),
            (ApproximateError::Aborted, "ABORTED"),
            (ApproximateError::internal("boom"), "INTERNAL"),
        ];

        for (error, code) in cases {
            assert_eq!(error.code(), code, "{error:?}");
        }
    }

    #[test]
    fn invalid_option_message_is_name_then_requirement() {
        let error = ApproximateError::invalid_option(RenderOption::ResizeInput);

        assert_eq!(
            error.to_string(),
            "resize_input must be an integer from 2 to 2048"
        );
        assert!(error.source().is_none());
    }

    #[test]
    fn sources_are_exposed_and_not_repeated_in_display() {
        let error = ApproximateError::Internal {
            reason: "could not write".into(),
            source: Some(Box::new(io::Error::other("disk full"))),
        };

        assert_eq!(error.to_string(), "internal render error: could not write");
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("disk full")
        );
    }

    #[test]
    fn errors_cross_threads() {
        fn assert_send_sync<T: Send + Sync + 'static>() {}
        assert_send_sync::<ApproximateError>();
    }
}
