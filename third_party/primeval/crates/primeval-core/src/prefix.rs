//! Per-row prefix sums, with fixed target entries and updates on dirty rows.
//!
//! The target and the canvas stay fixed while a step searches, so every
//! candidate would otherwise re-sum the same pixels. [`PrefixSums`] holds,
//! for each row, running sums of the RGB channels of both buffers and of
//! their squared difference, which turn the per-line sums the colour fit and
//! the energy need into two lookups.

use crate::buffer::{BYTES_PER_PIXEL, Buffer};

/// The longest span, in pixels, whose sums [`PrefixSums::span`] can return:
/// the channel prefixes wrap in `u32`, so the difference of two of them is
/// exact while the span's true sum, at most `255` per pixel, stays below
/// `2^32`.
pub(crate) const MAX_CHANNEL_SPAN: usize = (u32::MAX / 255) as usize;

/// Per-row prefix sums of a target and a canvas of the same size.
///
/// Row `y` holds `width + 1` entries; entry `x` sums the pixels `0..x` of
/// that row, so a span `x1..=x2` is entry `x2 + 1` minus entry `x1`.
/// The canvas's maximum RGB error must fit in i64, as the energy kernels
/// require: at most i64::MAX / (3 * 255²) = 47,281,158,717,697 pixels
/// (about 4.7 · 10¹³), far beyond any practical buffer.
#[derive(Clone, Default)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(crate) struct PrefixSums {
    width: u32,
    height: u32,
    entries: Vec<Entry>,
    /// Summed-area error entries.
    area_error: Vec<u64>,
}

/// One prefix entry, 32 bytes and aligned to them so that no entry straddles
/// a cache line: a span reads the channels and the error of its two ends
/// from the same entries.
#[derive(Clone, Copy, Default)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
#[repr(align(32))]
struct Entry {
    /// The RGB channels of the target, then of the canvas, wrapping in `u32`.
    channels: [u32; 6],
    /// The squared channel differences, summed over RGB.
    error: u64,
}

/// The sums over one span: the per-channel RGB sums of the target and of
/// the canvas, and their summed squared difference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SpanSums {
    /// The R, G and B sums of the target.
    pub(crate) target: [u64; 3],
    /// The R, G and B sums of the canvas.
    pub(crate) current: [u64; 3],
    /// The squared channel differences between the target and the canvas,
    /// summed over RGB and the span's pixels.
    pub(crate) error: u64,
}

/// Changes since a derived structure was last updated, with an exclusive
/// row end. Union retains all changes across arbitrarily many skipped steps.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum RowChanges {
    #[default]
    Clean,
    Rows {
        start: u32,
        end: u32,
    },
    All,
}

impl RowChanges {
    pub(crate) fn rows(start: u32, end: u32) -> Self {
        if start < end {
            Self::Rows { start, end }
        } else {
            Self::Clean
        }
    }

    pub(crate) fn include(&mut self, other: Self) {
        *self = match (*self, other) {
            (Self::All, _) | (_, Self::All) => Self::All,
            (Self::Clean, rows) | (rows, Self::Clean) => rows,
            (Self::Rows { start: a, end: b }, Self::Rows { start: c, end: d }) => Self::Rows {
                start: a.min(c),
                end: b.max(d),
            },
        };
    }
}

fn update_current_row(entries: &mut [Entry], target: &[[u8; 3]], current: &[[u8; 3]]) {
    let mut entry = entries[0];
    for ((t, c), dst) in target.iter().zip(current).zip(&mut entries[1..]) {
        let mut pixel_error = 0_u32;
        for channel in 0..3 {
            entry.channels[3 + channel] =
                entry.channels[3 + channel].wrapping_add(u32::from(c[channel]));
            let d = u32::from(t[channel].abs_diff(c[channel]));
            pixel_error += d * d;
            dst.channels[3 + channel] = entry.channels[3 + channel];
        }
        entry.error += u64::from(pixel_error);
        dst.error = entry.error;
    }
}

fn assert_canvas_size(width: u32, height: u32) {
    let max_pixels = i64::MAX as u64 / (3 * 255 * 255);
    assert!(
        u64::from(width) * u64::from(height) <= max_pixels,
        "prefix sums canvas maximum RGB error must fit in i64 (at most {max_pixels} pixels)"
    );
}

impl PrefixSums {
    /// Rebuilds the sums from `target` and `current`, which must have the
    /// same dimensions.
    pub(crate) fn compute(&mut self, target: &Buffer, current: &Buffer) {
        assert!(
            target.width() == current.width() && target.height() == current.height(),
            "prefix sums need buffers of the same size"
        );
        let (width, height) = (target.width(), target.height());
        assert_canvas_size(width, height);
        self.width = width;
        self.height = height;
        self.entries.clear();
        self.entries.reserve((width as usize + 1) * height as usize);

        let row_bytes = width as usize * BYTES_PER_PIXEL;
        let rows = target
            .pixels()
            .chunks_exact(row_bytes)
            .zip(current.pixels().chunks_exact(row_bytes));
        for (t_row, c_row) in rows {
            let mut entry = Entry::default();
            self.entries.push(entry);
            let (t_px3, _) = t_row.as_chunks::<3>();
            let (c_px3, _) = c_row.as_chunks::<3>();
            for (t_px, c_px) in t_px3.iter().zip(c_px3) {
                let mut pixel_error = 0_u32;
                for channel in 0..3 {
                    let (t, c) = (t_px[channel], c_px[channel]);
                    entry.channels[channel] = entry.channels[channel].wrapping_add(u32::from(t));
                    entry.channels[3 + channel] =
                        entry.channels[3 + channel].wrapping_add(u32::from(c));
                    let d = u32::from(t.abs_diff(c));
                    pixel_error += d * d;
                }
                entry.error += u64::from(pixel_error);
                self.entries.push(entry);
            }
        }
        self.area_error.clear();
        self.area_error
            .resize((width as usize + 1) * (height as usize + 1), 0);
        self.update_area(0);
    }

    /// Recomputes only canvas channels and error on these rows. Target
    /// entries are retained, including their wrapping u32 arithmetic.
    pub(crate) fn update_rows(
        &mut self,
        target: &Buffer,
        current: &Buffer,
        rows: std::ops::Range<u32>,
    ) {
        assert!(
            self.matches(target.width(), target.height())
                && self.matches(current.width(), current.height())
        );
        let width = self.width as usize;
        let bytes = width * BYTES_PER_PIXEL;
        let first = rows.start;
        let changed = !rows.is_empty();
        for y in rows {
            let y = y as usize;
            let t = target.pixels()[y * bytes..(y + 1) * bytes]
                .as_chunks::<3>()
                .0;
            let c = current.pixels()[y * bytes..(y + 1) * bytes]
                .as_chunks::<3>()
                .0;
            let entries = &mut self.entries[y * (width + 1)..(y + 1) * (width + 1)];
            // Production rows begin from zero. The helper also supports a
            // nonzero seed so tests can exercise wrapping cheaply.
            entries[0] = Entry::default();
            update_current_row(entries, t, c);
        }
        if changed {
            self.update_area(first);
        }
    }

    /// Updates cumulative columns from the first changed row down, using
    /// the row error prefixes. Each entry sums one canvas rectangle.
    fn update_area(&mut self, first: u32) {
        let stride = self.width as usize + 1;
        for y in first as usize..self.height as usize {
            for x in 1..stride {
                self.area_error[(y + 1) * stride + x] =
                    self.area_error[y * stride + x] + self.entries[y * stride + x].error;
            }
        }
    }

    /// The old RGB error over an inclusive pixel rectangle, in four
    /// lookups. Empty rectangles have zero error.
    #[inline]
    pub(crate) fn rectangle_error(&self, (x1, y1, x2, y2): (i32, i32, i32, i32)) -> u64 {
        if x1 > x2 || y1 > y2 {
            return 0;
        }
        debug_assert!(x1 >= 0 && y1 >= 0 && x2 < self.width as i32 && y2 < self.height as i32);
        let stride = self.width as usize + 1;
        let at = |x: i32, y: i32| self.area_error[y as usize * stride + x as usize];
        // Subtract vertical spans separately so intermediate values cannot
        // underflow or overflow even at the table's maximum total error.
        (at(x2 + 1, y2 + 1) - at(x2 + 1, y1)) - (at(x1, y2 + 1) - at(x1, y1))
    }

    /// Whether the sums were built for a buffer of `width` x `height`.
    #[inline]
    pub(crate) fn matches(&self, width: u32, height: u32) -> bool {
        self.width == width && self.height == height
    }

    /// The entries before and after the pixels `x1..=x2` of row `y`.
    #[inline]
    fn ends(&self, y: i32, x1: i32, x2: i32) -> (&Entry, &Entry) {
        debug_assert!(
            (0..self.height as i32).contains(&y) && 0 <= x1 && x1 <= x2 && x2 < self.width as i32,
            "span {x1}..={x2} of row {y} outside {}x{}",
            self.width,
            self.height
        );
        let start = y as usize * (self.width as usize + 1) + x1 as usize;
        let end = start + (x2 - x1) as usize + 1;
        (&self.entries[start], &self.entries[end])
    }

    /// The sums over the pixels `x1..=x2` of row `y`, which must lie inside
    /// the buffers and span at most [`MAX_CHANNEL_SPAN`] pixels.
    #[inline]
    pub(crate) fn span(&self, y: i32, x1: i32, x2: i32) -> SpanSums {
        debug_assert!(((x2 - x1) as usize) < MAX_CHANNEL_SPAN);
        let (start, end) = self.ends(y, x1, x2);
        let sum =
            |channel: usize| u64::from(end.channels[channel].wrapping_sub(start.channels[channel]));
        SpanSums {
            target: [sum(0), sum(1), sum(2)],
            current: [sum(3), sum(4), sum(5)],
            error: end.error - start.error,
        }
    }

    /// The sum of squared RGB differences between the target and the canvas
    /// over the pixels `x1..=x2` of row `y`, which must lie inside the
    /// buffers; unlike [`Self::span`], for any length.
    #[inline]
    pub(crate) fn error(&self, y: i32, x1: i32, x2: i32) -> u64 {
        let (start, end) = self.ends(y, x1, x2);
        end.error - start.error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    #[test]
    #[should_panic(expected = "maximum RGB error must fit in i64")]
    fn canvas_size_rejects_error_above_i64_limit() {
        assert_canvas_size(u32::MAX, u32::MAX);
    }

    #[test]
    fn rectangle_error_matches_rows_on_fresh_tables() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x5a7);
        for (w, h) in [(2, 2), (3, 7), (83, 37)] {
            let target = random_buffer(&mut rng, w, h);
            let current = random_buffer(&mut rng, w, h);
            let mut sums = PrefixSums::default();
            sums.compute(&target, &current);
            for _ in 0..100 {
                let x1 = rng.random_range(0..w) as i32;
                let x2 = rng.random_range(x1..w as i32);
                let y1 = rng.random_range(0..h) as i32;
                let y2 = rng.random_range(y1..h as i32);
                let expected = (y1..=y2).map(|y| sums.error(y, x1, x2)).sum();
                assert_eq!(sums.rectangle_error((x1, y1, x2, y2)), expected);
            }
            assert_eq!(sums.rectangle_error((1, 1, 0, 0)), 0);
        }
    }

    #[test]
    fn dirty_prefix_rows_match_full_reference() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xd127);
        for (w, h) in [(2, 2), (3, 7), (83, 37)] {
            let target = random_buffer(&mut rng, w, h);
            let mut current = random_buffer(&mut rng, w, h);
            let mut actual = PrefixSums::default();
            actual.compute(&target, &current);
            for _ in 0..300 {
                let start = rng.random_range(0..h);
                let end = rng.random_range(start..=h);
                rng.fill(
                    &mut current.pixels_mut()
                        [start as usize * w as usize * 3..end as usize * w as usize * 3],
                );
                actual.update_rows(&target, &current, start..end);
                let mut expected = PrefixSums::default();
                expected.compute(&target, &current);
                assert_eq!(actual, expected);
            }
        }
        // Exercise wrapping without allocating a 16-million-pixel row.
        let mut row = [Entry::default(); 3];
        row[0].channels[3..].fill(u32::MAX - 10);
        update_current_row(&mut row, &[[255, 255, 255]; 2], &[[255, 255, 255]; 2]);
        assert_eq!(row[1].channels[3], 244);
        assert_eq!(row[2].channels[3], 499);
    }

    fn random_buffer(rng: &mut ChaCha8Rng, width: u32, height: u32) -> Buffer {
        let mut buffer = Buffer::new(width, height);
        rng.fill(buffer.pixels_mut());
        buffer
    }

    #[test]
    fn sums_match_the_pixels_of_every_span() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x9f1);
        let mut sums = PrefixSums::default();
        for (width, height) in [(1, 1), (2, 3), (9, 4), (31, 2)] {
            let target = random_buffer(&mut rng, width, height);
            let current = random_buffer(&mut rng, width, height);
            // Reused across sizes, as the error grid reuses it across steps.
            sums.compute(&target, &current);
            assert!(sums.matches(width, height));
            assert!(!sums.matches(width + 1, height));
            for y in 0..height as i32 {
                for x1 in 0..width as i32 {
                    for x2 in x1..width as i32 {
                        let start = target.pix_offset(x1, y);
                        let end = target.pix_offset(x2 + 1, y);
                        let (t, c) = (&target.pixels()[start..end], &current.pixels()[start..end]);
                        let mut expected = ([0_u64; 3], [0_u64; 3]);
                        let mut error = 0_u64;
                        for i in 0..t.len() {
                            expected.0[i % 3] += u64::from(t[i]);
                            expected.1[i % 3] += u64::from(c[i]);
                            let d = i64::from(t[i]) - i64::from(c[i]);
                            error += (d * d) as u64;
                        }
                        let span = SpanSums {
                            target: expected.0,
                            current: expected.1,
                            error,
                        };
                        assert_eq!(sums.span(y, x1, x2), span, "{y} {x1}..={x2}");
                        assert_eq!(sums.error(y, x1, x2), error, "{y} {x1}..={x2}");
                    }
                }
            }
        }
    }

    /// White against black is the largest sum a pixel adds.
    #[test]
    fn sums_are_exact_at_the_largest_channel_and_error_values() {
        let (width, height) = (1_001, 2);
        let white = Buffer::new_from_color(width, height, crate::Color::new(255, 255, 255, 255));
        let black = Buffer::new(width, height);
        let mut sums = PrefixSums::default();
        sums.compute(&white, &black);
        let n = u64::from(width);
        let span = SpanSums {
            target: [255 * n; 3],
            current: [0; 3],
            error: 3 * 255 * 255 * n,
        };
        assert_eq!(sums.span(1, 0, width as i32 - 1), span);
        assert_eq!(sums.error(1, 0, width as i32 - 1), span.error);
        assert_eq!(sums.error(0, 5, 5), 3 * 255 * 255);
    }
}
