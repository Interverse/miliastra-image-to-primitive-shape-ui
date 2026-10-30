/// An 8-bit-per-channel RGBA color.
///
/// Fields are non-premultiplied (straight alpha), matching Go's `color.NRGBA`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Color {
    /// Red.
    pub r: u8,
    /// Green.
    pub g: u8,
    /// Blue.
    pub b: u8,
    /// Alpha: `0` is transparent, `255` opaque.
    pub a: u8,
}

impl Color {
    /// Creates a new color from individual channel values.
    #[must_use]
    pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    /// Parses an opaque hex color string.
    ///
    /// Accepted formats (the leading `#` is optional):
    /// - `RGB` — 3 hex digits, expanded to `RRGGBB`
    /// - `RRGGBB` — 6 hex digits
    ///
    /// The result always has alpha 255. Returns `None` for any other length,
    /// for non-ASCII input, and for invalid hex digits.
    #[must_use]
    pub fn from_hex(s: &str) -> Option<Self> {
        let digits = s.strip_prefix('#').unwrap_or(s).as_bytes();
        let (r, g, b) = match *digits {
            [r, g, b] => (
                parse_hex_byte_doubled(r)?,
                parse_hex_byte_doubled(g)?,
                parse_hex_byte_doubled(b)?,
            ),
            [r1, r2, g1, g2, b1, b2] => (
                parse_hex_pair(r1, r2)?,
                parse_hex_pair(g1, g2)?,
                parse_hex_pair(b1, b2)?,
            ),
            _ => return None,
        };
        Some(Self { r, g, b, a: 255 })
    }
}

/// Parses a single hex character and doubles it (e.g. `b'A'` -> `0xAA`).
fn parse_hex_byte_doubled(ch: u8) -> Option<u8> {
    let nibble = hex_nibble(ch)?;
    Some(nibble << 4 | nibble)
}

/// Parses two hex digits into a byte.
fn parse_hex_pair(hi: u8, lo: u8) -> Option<u8> {
    Some(hex_nibble(hi)? << 4 | hex_nibble(lo)?)
}

/// Converts a single ASCII hex digit to its numeric value.
fn hex_nibble(ch: u8) -> Option<u8> {
    match ch {
        b'0'..=b'9' => Some(ch - b'0'),
        b'a'..=b'f' => Some(ch - b'a' + 10),
        b'A'..=b'F' => Some(ch - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_all_zeros() {
        let c = Color::default();
        assert_eq!(
            c,
            Color {
                r: 0,
                g: 0,
                b: 0,
                a: 0
            }
        );
    }

    #[test]
    fn from_hex_3_digits() {
        let c = Color::from_hex("#F80").unwrap();
        assert_eq!(
            c,
            Color {
                r: 0xFF,
                g: 0x88,
                b: 0x00,
                a: 0xFF
            }
        );
    }

    #[test]
    fn from_hex_rejects_alpha_forms() {
        assert!(Color::from_hex("#F80A").is_none());
        assert!(Color::from_hex("F80A").is_none());
    }

    #[test]
    fn from_hex_6_digits() {
        let c = Color::from_hex("#FF8800").unwrap();
        assert_eq!(
            c,
            Color {
                r: 0xFF,
                g: 0x88,
                b: 0x00,
                a: 0xFF
            }
        );
    }

    #[test]
    fn from_hex_rejects_8_digit_alpha_form() {
        assert!(Color::from_hex("#FF880040").is_none());
        assert!(Color::from_hex("FF880040").is_none());
    }

    #[test]
    fn from_hex_no_hash() {
        let c = Color::from_hex("FF8800").unwrap();
        assert_eq!(
            c,
            Color {
                r: 0xFF,
                g: 0x88,
                b: 0x00,
                a: 0xFF
            }
        );
    }

    #[test]
    fn from_hex_lowercase() {
        let c = Color::from_hex("#ff8800").unwrap();
        assert_eq!(
            c,
            Color {
                r: 0xFF,
                g: 0x88,
                b: 0x00,
                a: 0xFF
            }
        );
    }

    #[test]
    fn from_hex_invalid_length() {
        assert!(Color::from_hex("#12345").is_none());
    }

    #[test]
    fn from_hex_invalid_chars() {
        assert!(Color::from_hex("#GGHHII").is_none());
    }

    #[test]
    fn from_hex_rejects_multibyte_input_without_panicking() {
        // "a€bc" is 6 bytes long but not 6 ASCII hex digits.
        assert!(Color::from_hex("a€bc").is_none());
        assert!(Color::from_hex("#a€bc").is_none());
        assert!(Color::from_hex("€").is_none());
        assert!(Color::from_hex("ab€").is_none());
        assert!(Color::from_hex("").is_none());
        assert!(Color::from_hex("#").is_none());
    }
}
