//! Opacity strategy for new shapes.

use crate::error::ParseError;
use std::num::NonZeroU8;
use std::str::FromStr;

/// The one message for every rejected alpha value.
const INVALID_ALPHA: &str = "alpha must be auto or an integer 1..255";

/// Opacity of the shapes the engine adds.
///
/// A fixed alpha is never zero: a fully transparent shape cannot change the
/// canvas, and the colour solver divides by the alpha.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Alpha {
    /// The search chooses each shape's alpha.
    #[default]
    Auto,
    /// Every shape uses this alpha.
    Fixed(NonZeroU8),
}

impl TryFrom<u32> for Alpha {
    type Error = ParseError;

    /// Converts an integer `1..=255` into a fixed alpha.
    fn try_from(value: u32) -> Result<Self, Self::Error> {
        u8::try_from(value)
            .ok()
            .and_then(NonZeroU8::new)
            .map(Self::Fixed)
            .ok_or_else(|| ParseError::new(INVALID_ALPHA))
    }
}

impl FromStr for Alpha {
    type Err = ParseError;

    /// Parses `auto` or a decimal integer `1..=255` (ASCII digits only, no
    /// sign), matching what the CLI and the TypeScript types accept.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value == "auto" {
            return Ok(Self::Auto);
        }
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ParseError::new(INVALID_ALPHA));
        }
        let parsed: u32 = value.parse().map_err(|_| ParseError::new(INVALID_ALPHA))?;
        Self::try_from(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed(value: u8) -> Alpha {
        Alpha::Fixed(NonZeroU8::new(value).expect("non-zero"))
    }

    #[test]
    fn parses_auto_and_fixed_values() {
        assert_eq!("auto".parse::<Alpha>(), Ok(Alpha::Auto));
        assert_eq!("0012".parse::<Alpha>(), Ok(fixed(12)));
        assert_eq!("1".parse::<Alpha>(), Ok(fixed(1)));
        assert_eq!("128".parse::<Alpha>(), Ok(fixed(128)));
        assert_eq!("255".parse::<Alpha>(), Ok(fixed(255)));
    }

    #[test]
    fn rejects_zero_out_of_range_and_non_integers() {
        for value in [
            "0", "256", "-1", "1.5", "", "half", "+0", "+12", "AUTO", "Auto", " 12",
        ] {
            assert_eq!(
                value.parse::<Alpha>(),
                Err(ParseError::new(INVALID_ALPHA)),
                "{value:?}"
            );
        }
    }

    #[test]
    fn converts_integers_in_range() {
        assert_eq!(Alpha::try_from(1), Ok(fixed(1)));
        assert_eq!(Alpha::try_from(255), Ok(fixed(255)));
        for value in [0, 256, u32::MAX] {
            assert_eq!(
                Alpha::try_from(value),
                Err(ParseError::new(INVALID_ALPHA)),
                "{value}"
            );
        }
    }

    #[test]
    fn default_is_auto() {
        assert_eq!(Alpha::default(), Alpha::Auto);
    }
}
