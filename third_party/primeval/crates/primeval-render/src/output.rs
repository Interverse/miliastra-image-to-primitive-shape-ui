use crate::RenderOption;
use primeval_core::ParseError;
use std::str::FromStr;

/// Encoded output format of a render.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputFormat {
    /// An SVG document.
    Svg,
    /// An opaque RGB PNG image.
    Png,
}

impl OutputFormat {
    /// The public name, `"svg"` or `"png"`; [`FromStr`] parses it back.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Svg => "svg",
            Self::Png => "png",
        }
    }

    /// The usual file extension, without the dot.
    #[must_use]
    pub const fn extension(self) -> &'static str {
        self.as_str()
    }

    /// The MIME type: `image/svg+xml` or `image/png`.
    #[must_use]
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Svg => "image/svg+xml",
            Self::Png => "image/png",
        }
    }
}

impl FromStr for OutputFormat {
    type Err = ParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "svg" => Ok(Self::Svg),
            "png" => Ok(Self::Png),
            _ => Err(ParseError::new(format!(
                "output {}",
                RenderOption::Output.requirement()
            ))),
        }
    }
}

/// Output dimensions for a working canvas: the longest side becomes
/// `output_size` and the other side keeps the aspect ratio, rounded and at
/// least 1.
pub(crate) fn output_dimensions(width: u32, height: u32, output_size: u32) -> (u32, u32) {
    let aspect = width as f32 / height as f32;
    if aspect >= 1.0 {
        let other = ((output_size as f32) / aspect).round().max(1.0) as u32;
        (output_size, other)
    } else {
        let other = ((output_size as f32) * aspect).round().max(1.0) as u32;
        (other, output_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_format_round_trips_public_names() {
        let cases = [(OutputFormat::Svg, "svg"), (OutputFormat::Png, "png")];

        for (format, value) in cases {
            assert_eq!(format.as_str(), value);
            assert_eq!(
                value.parse::<OutputFormat>().expect("output format"),
                format
            );
        }
    }

    #[test]
    fn output_format_rejects_unknown_name() {
        for value in ["bmp", "jpg", "jpeg", "gif"] {
            assert_eq!(
                value.parse::<OutputFormat>(),
                Err(ParseError::new("output must be one of: svg, png"))
            );
        }
    }

    #[test]
    fn output_dimensions_scale_the_longest_side() {
        assert_eq!(output_dimensions(8, 5, 16), (16, 10));
        assert_eq!(output_dimensions(5, 8, 16), (10, 16));
        assert_eq!(output_dimensions(7, 7, 100), (100, 100));
        assert_eq!(output_dimensions(3, 2, 100), (100, 67));
    }

    #[test]
    fn output_dimensions_keep_at_least_one_pixel() {
        assert_eq!(output_dimensions(1000, 1, 10), (10, 1));
        assert_eq!(output_dimensions(1, 1000, 10), (1, 10));
    }
}
