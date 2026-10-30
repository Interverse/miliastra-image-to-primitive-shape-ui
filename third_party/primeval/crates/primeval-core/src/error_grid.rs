//! Spatial error distribution grid for biased shape placement.
//!
//! Divides the image into a grid of cells, measures per-cell error between
//! the target and current approximation, and builds a cumulative distribution
//! function so that random samples concentrate in high-error regions.

use crate::buffer::Buffer;
use crate::prefix::{PrefixSums, RowChanges};
use rand::{Rng, RngExt};

/// The number of cells in a `cols x rows` grid, computed in `u64` so large
/// grid options cannot wrap around in `u32`.
///
/// # Panics
///
/// Panics if the count does not fit in `usize`.
fn cell_count(cols: u32, rows: u32) -> usize {
    usize::try_from(u64::from(cols) * u64::from(rows)).expect("error grid cell count fits in usize")
}

/// The pixel range `start..end` of cell `index` along one axis, where cells
/// are `size` pixels and the last of `count` cells extends to `extent` so
/// that it absorbs the remainder. `start >= end` for cells past the image,
/// which happens when the grid has more cells than the image has pixels.
fn cell_span(index: u32, size: u32, count: u32, extent: u32) -> (u32, u32) {
    let start = index * size;
    let end = if index == count - 1 {
        extent
    } else {
        (start + size).min(extent)
    };
    (start, end)
}

/// A grid that tracks per-cell RGB error between target and current buffers.
///
/// After [`compute`](ErrorGrid::compute) or [`update`](ErrorGrid::update),
/// the internal CDF allows [`sample`](ErrorGrid::sample) and
/// [`sample_float`](ErrorGrid::sample_float) to produce coordinates biased
/// toward high-error cells.
#[derive(Clone)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub(crate) struct ErrorGrid {
    cols: u32,
    rows: u32,
    cell_w: u32,
    cell_h: u32,
    img_w: u32,
    img_h: u32,
    errors: Vec<f64>,
    cdf: Vec<f64>,
    total: f64,
    /// The per-row prefix sums the cell errors are read from, which the
    /// step's candidates score against.
    sums: PrefixSums,
}

impl ErrorGrid {
    /// Creates a new error grid for an image of size `img_w x img_h`
    /// divided into `cols` columns and `rows` rows.
    ///
    /// Cell dimensions are floored to at least 1 pixel.
    #[must_use]
    pub(crate) fn new(img_w: u32, img_h: u32, cols: u32, rows: u32) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let cell_w = (img_w / cols).max(1);
        let cell_h = (img_h / rows).max(1);
        let n = cell_count(cols, rows);
        Self {
            cols,
            rows,
            cell_w,
            cell_h,
            img_w,
            img_h,
            errors: vec![0.0; n],
            cdf: vec![0.0; n],
            total: 0.0,
            sums: PrefixSums::default(),
        }
    }

    /// Returns the accumulated total error across all cells.
    ///
    /// This value is meaningful only after [`compute`](ErrorGrid::compute) or
    /// [`update`](ErrorGrid::update).
    #[cfg(test)]
    #[must_use]
    #[inline]
    pub(crate) fn total(&self) -> f64 {
        self.total
    }

    /// Recomputes the prefix sums, the per-cell errors and the CDF from the
    /// given target/current pair.
    ///
    /// Each cell accumulates the sum of squared RGB channel differences for
    /// every pixel it covers, read row by row from the prefix sums. The last
    /// column and last row extend to the image boundary so that no pixels
    /// are missed.
    pub(crate) fn compute(&mut self, target: &Buffer, current: &Buffer) {
        self.sums.compute(target, current);
        self.errors.fill(0.0);
        self.resum_cells(0..self.img_h);
        self.rebuild_cdf();
    }

    /// [`compute`](ErrorGrid::compute) for a fixed target whose canvas
    /// changed only on `changes`: the prefix sums of those rows are
    /// recomputed, and the cells they cross resummed from their first row
    /// in the original order, never adjusted by floating deltas. The CDF
    /// likewise retains its original accumulation order.
    pub(crate) fn update(&mut self, target: &Buffer, current: &Buffer, changes: RowChanges) {
        if !self.sums.matches(target.width(), target.height()) {
            self.compute(target, current);
            return;
        }
        let rows = match changes {
            RowChanges::Clean => return,
            RowChanges::All => 0..self.img_h,
            RowChanges::Rows { start, end } => start..end,
        };
        self.sums.update_rows(target, current, rows.clone());
        self.resum_cells(rows);
        self.rebuild_cdf();
    }

    /// Resums, from the prefix sums, every cell whose pixel rows meet
    /// `rows`. Each cell accumulates its rows top to bottom, each row's
    /// part summed exactly in integers and converted once.
    fn resum_cells(&mut self, rows: std::ops::Range<u32>) {
        for row_idx in 0..self.rows {
            let (y_start, y_end) = cell_span(row_idx, self.cell_h, self.rows, self.img_h);
            if y_start >= self.img_h {
                break;
            }
            if y_end <= rows.start || y_start >= rows.end {
                continue;
            }
            let base = (row_idx * self.cols) as usize;
            self.errors[base..base + self.cols as usize].fill(0.0);
            for y in y_start..y_end {
                for col_idx in 0..self.cols {
                    let (x_start, x_end) = cell_span(col_idx, self.cell_w, self.cols, self.img_w);
                    if x_start >= self.img_w {
                        break;
                    }
                    let row_error = self.sums.error(y as i32, x_start as i32, x_end as i32 - 1);
                    self.errors[base + col_idx as usize] += row_error as f64;
                }
            }
        }
    }

    /// Rebuilds the CDF and the total from the cell errors, in cell order.
    fn rebuild_cdf(&mut self) {
        self.total = 0.0;
        for (i, &error) in self.errors.iter().enumerate() {
            self.total += error;
            self.cdf[i] = self.total;
        }
    }

    /// The prefix sums of the last [`compute`](ErrorGrid::compute) or
    /// [`update`](ErrorGrid::update).
    #[inline]
    pub(crate) fn sums(&self) -> &PrefixSums {
        &self.sums
    }

    /// Samples an integer pixel coordinate biased toward high-error cells.
    ///
    /// The returned `(x, y)` is guaranteed to be within `[0, img_w) x [0, img_h)`.
    #[must_use]
    pub(crate) fn sample<R: Rng>(&self, rng: &mut R) -> (i32, i32) {
        if self.total <= 0.0 {
            if self.img_w == 0 || self.img_h == 0 {
                return (0, 0);
            }
            return (
                rng.random_range(0..self.img_w) as i32,
                rng.random_range(0..self.img_h) as i32,
            );
        }

        let ((x_start, x_end), (y_start, y_end)) = self.sample_cell(rng);
        let x = rng.random_range(x_start..x_end);
        let y = rng.random_range(y_start..y_end);
        (x as i32, y as i32)
    }

    /// Samples a floating-point coordinate biased toward high-error cells.
    ///
    /// The returned `(x, y)` is guaranteed to be within
    /// `[0.0, img_w as f64) x [0.0, img_h as f64)`.
    #[must_use]
    pub(crate) fn sample_float<R: Rng>(&self, rng: &mut R) -> (f64, f64) {
        if self.total <= 0.0 {
            if self.img_w == 0 || self.img_h == 0 {
                return (0.0, 0.0);
            }
            return (
                rng.random::<f64>() * self.img_w as f64,
                rng.random::<f64>() * self.img_h as f64,
            );
        }

        let ((x_start, x_end), (y_start, y_end)) = self.sample_cell(rng);
        let within = |rng: &mut R, start: u32, end: u32| {
            let (start, end) = (f64::from(start), f64::from(end));
            // Rounding can carry `start + r * (end - start)` up to `end`.
            (start + rng.random::<f64>() * (end - start)).min(end.next_down())
        };
        let x = within(rng, x_start, x_end);
        let y = within(rng, y_start, y_end);
        (x, y)
    }

    /// Picks a cell with probability proportional to its error and returns
    /// its real pixel bounds `(x_start..x_end, y_start..y_end)`, including
    /// the remainder that the last column and row absorb. Requires a
    /// positive total.
    ///
    /// The chosen cell always has pixels: `partition_point` returns the
    /// first cell whose cumulative error reaches `r`, which for `r > 0` has
    /// positive error (so lies on the image) and for `r == 0` is cell 0.
    fn sample_cell<R: Rng>(&self, rng: &mut R) -> ((u32, u32), (u32, u32)) {
        let r = rng.random::<f64>() * self.total;
        let idx = self.cdf.partition_point(|&v| v < r).min(self.cdf.len() - 1);
        let row = (idx / self.cols as usize) as u32;
        let col = (idx % self.cols as usize) as u32;
        let (x_start, x_end) = cell_span(col, self.cell_w, self.cols, self.img_w);
        let (y_start, y_end) = cell_span(row, self.cell_h, self.rows, self.img_h);
        debug_assert!(x_start < x_end && y_start < y_end, "cell {idx} is empty");
        // Clamp the start so an empty cell still yields an on-image pixel.
        let x_start = x_start.min(self.img_w - 1);
        let y_start = y_start.min(self.img_h - 1);
        (
            (x_start, x_end.max(x_start + 1)),
            (y_start, y_end.max(y_start + 1)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Color;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    #[test]
    fn dirty_grid_matches_full_reference() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xd15c);
        for (w, h, cols, rows) in [(83, 37, 7, 6), (5, 3, 9, 8), (37, 35, 1, 1)] {
            let mut target = Buffer::new(w, h);
            rng.fill(target.pixels_mut());
            let mut current = Buffer::new(w, h);
            rng.fill(current.pixels_mut());
            let mut actual = ErrorGrid::new(w, h, cols, rows);
            actual.update(&target, &current, RowChanges::All);
            for _ in 0..100 {
                let start = rng.random_range(0..h);
                let end = rng.random_range(start..=h);
                rng.fill(
                    &mut current.pixels_mut()[(start * w * 3) as usize..(end * w * 3) as usize],
                );
                actual.update(&target, &current, RowChanges::rows(start, end));
                let mut expected = ErrorGrid::new(w, h, cols, rows);
                expected.compute(&target, &current);
                assert_eq!(actual, expected);
                actual.update(&target, &current, RowChanges::All);
                assert_eq!(actual, expected);
            }
        }
    }

    fn test_rng() -> ChaCha8Rng {
        ChaCha8Rng::seed_from_u64(42)
    }

    #[test]
    fn cell_count_does_not_wrap_in_u32() {
        assert_eq!(cell_count(16, 16), 256);
        assert_eq!(cell_count(1, 1), 1);
        // 65536 * 65536 is 0 in wrapping u32 arithmetic. Only a 64-bit
        // `usize` holds it; the wasm32 kernel tests compile this module too.
        #[cfg(target_pointer_width = "64")]
        assert_eq!(cell_count(65_536, 65_536), 1_usize << 32);
    }

    #[test]
    fn new_computes_cell_dimensions() {
        let g = ErrorGrid::new(100, 80, 5, 4);
        assert_eq!(g.cell_w, 20);
        assert_eq!(g.cell_h, 20);
        assert_eq!(g.cols, 5);
        assert_eq!(g.rows, 4);
        assert_eq!(g.errors.len(), 20);
        assert_eq!(g.cdf.len(), 20);
    }

    #[test]
    fn new_clamps_cell_size_to_minimum_one() {
        // Image smaller than grid count — cell size floors to 1.
        let g = ErrorGrid::new(2, 3, 10, 10);
        assert_eq!(g.cell_w, 1);
        assert_eq!(g.cell_h, 1);
    }

    #[test]
    fn compute_handles_grids_larger_than_image() {
        let target = Buffer::new_from_color(2, 2, Color::new(255, 255, 255, 255));
        let current = Buffer::new_from_color(2, 2, Color::new(0, 0, 0, 255));
        let mut g = ErrorGrid::new(2, 2, 10, 10);

        g.compute(&target, &current);

        assert!(g.total() > 0.0);
    }

    #[test]
    fn compute_uniform_buffers_gives_zero_total() {
        let c = Color::new(128, 64, 32, 255);
        let target = Buffer::new_from_color(20, 20, c);
        let current = Buffer::new_from_color(20, 20, c);
        let mut g = ErrorGrid::new(20, 20, 4, 4);
        g.compute(&target, &current);
        assert_eq!(g.total(), 0.0);
        assert!(g.errors.iter().all(|&e| e == 0.0));
    }

    #[test]
    fn new_clamps_zero_grid_dimensions() {
        let g = ErrorGrid::new(20, 20, 0, 0);
        assert_eq!(g.cols, 1);
        assert_eq!(g.rows, 1);
        assert_eq!(g.errors.len(), 1);
        assert_eq!(g.cdf.len(), 1);
    }

    #[test]
    fn compute_sums_each_cells_rgb_error_exactly() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x5EED_0010);
        for _ in 0..40 {
            let (w, h) = (rng.random_range(2..40), rng.random_range(2..40));
            let (cols, rows) = (rng.random_range(1..12), rng.random_range(1..12));
            let mut random_buffer = || {
                let pixels = (0..w * h * 3).map(|_| rng.random::<u8>()).collect();
                Buffer::from_rgb(w, h, pixels).expect("valid buffer")
            };
            let (target, current) = (random_buffer(), random_buffer());
            let mut g = ErrorGrid::new(w, h, cols, rows);
            g.compute(&target, &current);

            // Each pixel's error, added to the cell `cell_span` assigns it.
            let mut expected = vec![0.0; g.errors.len()];
            for row in 0..g.rows {
                let (y0, y1) = cell_span(row, g.cell_h, g.rows, h);
                for col in 0..g.cols {
                    let (x0, x1) = cell_span(col, g.cell_w, g.cols, w);
                    for (y, x) in (y0..y1).flat_map(|y| (x0..x1).map(move |x| (y, x))) {
                        let i = target.pix_offset(x as i32, y as i32);
                        let error: i32 = (0..3)
                            .map(|c| {
                                i32::from(target.pixels()[i + c])
                                    - i32::from(current.pixels()[i + c])
                            })
                            .map(|d| d * d)
                            .sum();
                        expected[(row * g.cols + col) as usize] += f64::from(error);
                    }
                }
            }
            assert_eq!(g.errors, expected, "{w}x{h} image, {cols}x{rows} grid");
            assert_eq!(g.total(), expected.iter().sum::<f64>());
        }
    }

    #[test]
    fn compute_known_different_buffers_gives_expected_errors() {
        // 4x4 image, 2x2 grid => each cell is 2x2 pixels.
        // Target: all white (255,255,255,255)
        // Current: all black (0,0,0,255) — alpha matches, so only RGB differs.
        let target = Buffer::new_from_color(4, 4, Color::new(255, 255, 255, 255));
        let current = Buffer::new_from_color(4, 4, Color::new(0, 0, 0, 255));

        let mut g = ErrorGrid::new(4, 4, 2, 2);
        g.compute(&target, &current);

        // Per pixel: dr=255, dg=255, db=255 => 255^2 * 3 = 195_075
        // Each cell has 2*2 = 4 pixels => 4 * 195_075 = 780_300
        let expected_per_cell = 4.0 * 195_075.0;
        for &e in &g.errors {
            assert!(
                (e - expected_per_cell).abs() < 1e-6,
                "expected {expected_per_cell}, got {e}"
            );
        }

        let expected_total = 4.0 * expected_per_cell;
        assert!(
            (g.total() - expected_total).abs() < 1e-6,
            "expected total {expected_total}, got {}",
            g.total()
        );
    }

    #[test]
    fn sample_returns_coordinates_within_bounds() {
        let target = Buffer::new_from_color(50, 30, Color::new(255, 0, 0, 255));
        let current = Buffer::new_from_color(50, 30, Color::new(0, 0, 0, 255));
        let mut g = ErrorGrid::new(50, 30, 5, 3);
        g.compute(&target, &current);

        let mut rng = test_rng();
        for _ in 0..1000 {
            let (x, y) = g.sample(&mut rng);
            assert!((0..50).contains(&x), "x={x} out of bounds");
            assert!((0..30).contains(&y), "y={y} out of bounds");
        }
    }

    /// Every pixel of a canvas whose size the grid does not divide (the
    /// last row and column absorb the remainder) is reachable through the
    /// biased path, for integer and float samples (ENG-10).
    #[test]
    fn biased_sampling_reaches_every_pixel_of_a_non_divisible_canvas() {
        let (width, height) = (257_u32, 255_u32);
        let target = Buffer::new_from_color(width, height, Color::new(255, 255, 255, 255));
        let current = Buffer::new_from_color(width, height, Color::new(0, 0, 0, 255));
        let mut g = ErrorGrid::new(width, height, 16, 16);
        g.compute(&target, &current);

        let pixel_count = (width * height) as usize;
        let mut rng = test_rng();
        let mut hit = vec![false; pixel_count];
        let mut hit_float = vec![false; pixel_count];
        let (mut missing, mut missing_float) = (pixel_count, pixel_count);
        // Uniform error makes every pixel equally likely: about
        // `n · ln n ≈ 0.73 M` samples cover all `n = 65_535` of them.
        for _ in 0..4_000_000 {
            let (x, y) = g.sample(&mut rng);
            let index = (y as u32 * width + x as u32) as usize;
            if !std::mem::replace(&mut hit[index], true) {
                missing -= 1;
            }
            let (fx, fy) = g.sample_float(&mut rng);
            let index = (fy as u32 * width + fx as u32) as usize;
            if !std::mem::replace(&mut hit_float[index], true) {
                missing_float -= 1;
            }
            if missing == 0 && missing_float == 0 {
                break;
            }
        }
        assert_eq!(missing, 0, "pixels never sampled as integers");
        assert_eq!(missing_float, 0, "pixels never sampled as floats");
    }

    /// Biased samples stay on the canvas for odd, tiny and non-divisible
    /// sizes, grids finer than the image, and random error distributions.
    #[test]
    fn biased_samples_stay_in_bounds_for_random_sizes() {
        let mut rng = test_rng();
        for _ in 0..200 {
            let width = rng.random_range(1..70_u32);
            let height = rng.random_range(1..70_u32);
            let mut target = Buffer::new(width, height);
            rng.fill(target.pixels_mut());
            let current = Buffer::new(width, height);
            let mut g = ErrorGrid::new(
                width,
                height,
                rng.random_range(0..20),
                rng.random_range(0..20),
            );
            g.compute(&target, &current);
            for _ in 0..200 {
                let (x, y) = g.sample(&mut rng);
                assert!((0..width as i32).contains(&x), "x={x} on {width}x{height}");
                assert!((0..height as i32).contains(&y), "y={y} on {width}x{height}");
                let (fx, fy) = g.sample_float(&mut rng);
                assert!(
                    (0.0..f64::from(width)).contains(&fx),
                    "x={fx} on {width}x{height}"
                );
                assert!(
                    (0.0..f64::from(height)).contains(&fy),
                    "y={fy} on {width}x{height}"
                );
            }
        }
    }

    #[test]
    fn sample_float_returns_coordinates_within_bounds() {
        let target = Buffer::new_from_color(50, 30, Color::new(255, 0, 0, 255));
        let current = Buffer::new_from_color(50, 30, Color::new(0, 0, 0, 255));
        let mut g = ErrorGrid::new(50, 30, 5, 3);
        g.compute(&target, &current);

        let mut rng = test_rng();
        for _ in 0..1000 {
            let (x, y) = g.sample_float(&mut rng);
            assert!((0.0..50.0).contains(&x), "x={x} out of bounds");
            assert!((0.0..30.0).contains(&y), "y={y} out of bounds");
        }
    }

    #[test]
    fn zero_total_sampling_stays_in_bounds_and_does_not_collapse() {
        let c = Color::new(128, 64, 32, 255);
        let target = Buffer::new_from_color(20, 20, c);
        let current = Buffer::new_from_color(20, 20, c);
        let mut g = ErrorGrid::new(20, 20, 4, 4);
        g.compute(&target, &current);

        let mut rng = test_rng();
        let mut sampled_cells = std::collections::BTreeSet::new();
        let mut sampled_float_cells = std::collections::BTreeSet::new();
        for _ in 0..128 {
            let (x, y) = g.sample(&mut rng);
            assert!((0..20).contains(&x), "x={x} out of bounds");
            assert!((0..20).contains(&y), "y={y} out of bounds");
            sampled_cells.insert((x / 5, y / 5));

            let (fx, fy) = g.sample_float(&mut rng);
            assert!((0.0..20.0).contains(&fx), "x={fx} out of bounds");
            assert!((0.0..20.0).contains(&fy), "y={fy} out of bounds");
            sampled_float_cells.insert(((fx / 5.0) as i32, (fy / 5.0) as i32));
        }

        assert!(
            sampled_cells.len() > 1,
            "integer sampling collapsed to one cell"
        );
        assert!(
            sampled_float_cells.len() > 1,
            "float sampling collapsed to one cell"
        );
    }

    #[test]
    fn zero_dimension_grid_sampling_stays_in_bounds() {
        let target = Buffer::new_from_color(12, 9, Color::new(255, 255, 255, 255));
        let current = Buffer::new_from_color(12, 9, Color::new(0, 0, 0, 255));
        let mut g = ErrorGrid::new(12, 9, 0, 0);
        g.compute(&target, &current);

        let mut rng = test_rng();
        for _ in 0..128 {
            let (x, y) = g.sample(&mut rng);
            assert!((0..12).contains(&x), "x={x} out of bounds");
            assert!((0..9).contains(&y), "y={y} out of bounds");
        }
    }

    #[test]
    fn biased_sampling_concentrates_on_high_error_cell() {
        // 10x10 image, 2x1 grid (2 columns, 1 row).
        // Left half: target red, current red (zero error).
        // Right half: target white, current black (high error).
        let mut target = Buffer::new_from_color(10, 10, Color::new(255, 0, 0, 255));
        let mut current = Buffer::new_from_color(10, 10, Color::new(255, 0, 0, 255));

        // Make right half different: target white, current black.
        for y in 0..10u32 {
            for x in 5..10u32 {
                let off = (y as usize * 10 + x as usize) * 3;
                let tp = target.pixels_mut();
                tp[off] = 255;
                tp[off + 1] = 255;
                tp[off + 2] = 255;
                let cp = current.pixels_mut();
                cp[off] = 0;
                cp[off + 1] = 0;
                cp[off + 2] = 0;
            }
        }

        let mut g = ErrorGrid::new(10, 10, 2, 1);
        g.compute(&target, &current);

        // Left cell should have zero error, right cell should have all error.
        assert_eq!(g.errors[0], 0.0);
        assert!(g.errors[1] > 0.0);

        let mut rng = test_rng();
        let mut right_count = 0u32;
        let total_samples = 1000;
        for _ in 0..total_samples {
            let (x, _) = g.sample(&mut rng);
            if x >= 5 {
                right_count += 1;
            }
        }

        // All samples should land in the right half since left has zero error.
        assert_eq!(
            right_count, total_samples,
            "expected all {total_samples} samples in right half, got {right_count}"
        );
    }
}
