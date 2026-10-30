/// A horizontal span of pixels at a given Y coordinate.
///
/// Used by shape rasterizers to describe filled regions. The `alpha`
/// field is in the 0..=0xFFFF range, matching Go's `uint32` convention
/// used in the blending math.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Scanline {
    /// The row this scanline occupies.
    pub(crate) y: i32,
    /// The inclusive left column bound.
    pub(crate) x1: i32,
    /// The inclusive right column bound.
    pub(crate) x2: i32,
    /// Per-scanline alpha in the 0..=0xFFFF range.
    pub(crate) alpha: u32,
}

impl Scanline {
    /// The share of each pixel the line covers, `alpha` over full
    /// coverage ([`crate::score::M`]), in `0..=1`.
    #[must_use]
    #[inline]
    pub(crate) fn coverage(&self) -> f64 {
        f64::from(self.alpha) / f64::from(crate::score::M)
    }
}

/// Filters and clamps scanlines in-place so that every remaining line
/// lies within the `[0, w) x [0, h)` pixel grid.
///
/// Lines that fall entirely outside the bounds are removed.
/// Lines that partially overlap have their `x1`/`x2` clamped.
pub(crate) fn crop_scanlines(lines: &mut Vec<Scanline>, w: i32, h: i32) {
    lines.retain_mut(|line| match clamp_line(line, w, h) {
        Some((x1, x2)) => {
            line.x1 = x1;
            line.x2 = x2;
            true
        }
        None => false,
    });
}

/// Returns the clamped `(x1, x2)` for a scanline within a buffer of size `w x h`,
/// or `None` if no pixel of the line lies inside the buffer: the row is
/// outside `0..h`, the span is entirely left of `0` or right of `w - 1`, the
/// span is empty (`x1 > x2`), or the buffer is empty.
///
/// The buffer is assumed to start at `(0, 0)`.
#[must_use]
#[inline]
pub(crate) fn clamp_line(line: &Scanline, w: i32, h: i32) -> Option<(i32, i32)> {
    if w <= 0 || line.y < 0 || line.y >= h || line.x2 < 0 || line.x1 >= w || line.x1 > line.x2 {
        return None;
    }
    // `x1 <= x2`, `x2 >= 0` and `x1 < w` with `w >= 1`, so the clamped span is
    // non-empty and inside `0..w`.
    Some((line.x1.max(0), line.x2.min(w - 1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_is_alpha_over_full_coverage() {
        let line = |alpha| Scanline {
            y: 0,
            x1: 0,
            x2: 0,
            alpha,
        };
        assert_eq!(line(0).coverage(), 0.0);
        assert_eq!(line(0xFFFF).coverage(), 1.0);
        assert_eq!(line(0x8000).coverage(), 32768.0 / 65535.0);
    }

    fn sl(y: i32, x1: i32, x2: i32) -> Scanline {
        Scanline {
            y,
            x1,
            x2,
            alpha: 0xFFFF,
        }
    }

    #[test]
    fn crop_scanlines_removes_out_of_bounds() {
        let mut lines = vec![
            sl(-1, 0, 5),  // y < 0
            sl(10, 0, 5),  // y >= h (h=10)
            sl(5, 10, 15), // x1 >= w (w=10)
            sl(5, -5, -1), // x2 < 0
            sl(5, 2, 7),   // valid
        ];
        crop_scanlines(&mut lines, 10, 10);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], sl(5, 2, 7));
    }

    #[test]
    fn crop_scanlines_clamps_x_coordinates() {
        let mut lines = vec![sl(3, -5, 15)];
        crop_scanlines(&mut lines, 10, 10);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].x1, 0);
        assert_eq!(lines[0].x2, 9);
    }

    #[test]
    fn crop_scanlines_preserves_alpha() {
        let mut lines = vec![Scanline {
            y: 0,
            x1: 0,
            x2: 5,
            alpha: 42,
        }];
        crop_scanlines(&mut lines, 10, 10);
        assert_eq!(lines[0].alpha, 42);
    }

    #[test]
    fn crop_scanlines_empty_input() {
        let mut lines = Vec::new();
        crop_scanlines(&mut lines, 10, 10);
        assert!(lines.is_empty());
    }

    #[test]
    fn clamp_line_returns_none_for_y_out_of_bounds() {
        assert!(clamp_line(&sl(-1, 0, 5), 10, 10).is_none());
        assert!(clamp_line(&sl(10, 0, 5), 10, 10).is_none());
    }

    #[test]
    fn clamp_line_returns_none_when_x_range_empty_after_clamp() {
        // x1=15, x2=20 both clamp to 9, but original x1 > w-1 so after clamping
        // we still get x1=9, x2=9 which is valid. Let's use a case where it inverts.
        // Actually with both > w-1 they both clamp to w-1, so x1 <= x2.
        // For a truly empty case: x1=5, x2=3 (inverted range with both in bounds).
        assert!(clamp_line(&sl(5, 5, 3), 10, 10).is_none());
    }

    #[test]
    fn clamp_line_clamps_coordinates() {
        let line = sl(5, -3, 15);
        let (x1, x2) = clamp_line(&line, 10, 10).unwrap();
        assert_eq!(x1, 0);
        assert_eq!(x2, 9);
    }

    #[test]
    fn clamp_line_returns_none_for_lines_left_or_right_of_the_image() {
        assert!(clamp_line(&sl(5, -8, -1), 10, 10).is_none());
        assert!(clamp_line(&sl(5, 10, 14), 10, 10).is_none());
        assert!(clamp_line(&sl(5, 12, 12), 10, 10).is_none());
    }

    #[test]
    fn clamp_line_returns_none_for_an_empty_image() {
        assert!(clamp_line(&sl(0, 0, 3), 0, 10).is_none());
        assert!(clamp_line(&sl(0, 0, 3), 10, 0).is_none());
        assert!(clamp_line(&sl(0, 0, 0), 0, 0).is_none());
        assert!(clamp_line(&sl(0, -3, 3), 0, 10).is_none());
    }

    /// The pixels of `line` inside a `w x h` image, as an inclusive column
    /// range, computed pixel by pixel.
    fn visible_columns(line: &Scanline, w: i32, h: i32) -> Option<(i32, i32)> {
        if line.y < 0 || line.y >= h {
            return None;
        }
        let mut columns = (line.x1..=line.x2).filter(|x| (0..w).contains(x));
        let first = columns.next()?;
        Some((first, columns.next_back().unwrap_or(first)))
    }

    #[test]
    fn clamp_line_and_crop_scanlines_keep_exactly_the_visible_pixels() {
        use rand::{RngExt, SeedableRng};
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(0x5ca1);
        for _ in 0..20_000 {
            let w = rng.random_range(0..12);
            let h = rng.random_range(0..12);
            let line = sl(
                rng.random_range(-4..16),
                rng.random_range(-16..20),
                rng.random_range(-16..20),
            );
            let expected = visible_columns(&line, w, h);
            assert_eq!(clamp_line(&line, w, h), expected, "{line:?} in {w}x{h}");

            let mut cropped = vec![line];
            crop_scanlines(&mut cropped, w, h);
            let cropped: Vec<_> = cropped.iter().map(|l| (l.y, l.x1, l.x2)).collect();
            let expected: Vec<_> = expected
                .map(|(x1, x2)| (line.y, x1, x2))
                .into_iter()
                .collect();
            assert_eq!(cropped, expected, "{line:?} in {w}x{h}");
        }
    }

    #[test]
    fn clamp_line_valid_line_unchanged() {
        let line = sl(5, 2, 7);
        let (x1, x2) = clamp_line(&line, 10, 10).unwrap();
        assert_eq!(x1, 2);
        assert_eq!(x2, 7);
    }
}
