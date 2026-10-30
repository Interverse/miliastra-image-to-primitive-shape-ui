// Rasterization functions naturally take many geometric parameters (points, dimensions).
#![allow(clippy::too_many_arguments)]
use crate::drawing::LineCap;
use crate::scanline::Scanline;
use crate::score::M;
use crate::util::sin_cos_degrees;
use crate::worker::WorkerCtx;
use rand::Rng;

/// Reusable storage for [`stroke_quadratic_direct`], kept in each worker so
/// stroking a curve does not allocate.
#[derive(Clone, Default)]
pub(crate) struct StrokeScratch {
    /// The flattened curve.
    points: Vec<(f64, f64)>,
    /// Prepared once per segment, shared by the owner and its neighbours.
    segments: Vec<Segment>,
    /// The coverage of the curve's bounding box, row by row; all zeros
    /// between calls, since emitting a row zeroes it again.
    grid: Vec<u32>,
    /// The leftmost and rightmost covered column of each bounding-box row.
    rows: Vec<(i32, i32)>,
    #[cfg(test)]
    visits: Vec<(i32, i32)>,
}

impl StrokeScratch {
    /// Restores fresh logical scratch while retaining all allocations. The
    /// grid keeps its length: every stroke zeroes the cells it raised, which
    /// lie within the row ranges it emits, so the grid is already all zeros.
    pub(crate) fn reset(&mut self) {
        debug_assert!(self.grid.iter().all(|&cell| cell == 0), "stroke grid");
        self.points.clear();
        self.segments.clear();
        self.rows.clear();
        #[cfg(test)]
        self.visits.clear();
    }
}

/// Rasterises a stroked quadratic Bézier directly into `worker.lines` as
/// anti-aliased scanlines.
///
/// The curve from `(x1,y1)` through control point `(cx,cy)` to `(x2,y2)` is
/// adaptively subdivided via de Casteljau (flatness tolerance 0.25 px) into
/// flat segments. A pixel's coverage is the share of its area within
/// `half_width` of a segment ([`Trapezoid::band`]), so the engine fits the
/// coverage of the anti-aliased stroke the exporter draws. The curve's two
/// ends are `cap`: a butt cap cuts across its segment through pixels, as
/// the exporter's does; a square cap is a butt cap half the width further
/// out, where the end segment, lengthened, ends; a round cap covers a
/// pixel past the end by its share within `half_width` of the end point,
/// across the line through the end point perpendicular to the pixel
/// centre's direction from it ([`End::RoundCap`]). Consecutive segments
/// share half-open major spans at shallow same-axis turns. A centre whose
/// foot passes its owner's end uses the neighbouring finite segment;
/// ordinary interior pixels evaluate only their owner. Sharper turns and
/// major-axis changes overlap round ends to cover the outside wedge.
/// Butt and square cap half-planes clip the curve body and join discs;
/// square caps add rectangles along the curve's true end tangents. A
/// pixel two segments reach keeps the larger coverage, and each row then
/// emits runs of equal coverage, so no pixel appears twice.
pub(crate) fn stroke_quadratic_direct<R: Rng>(
    worker: &mut WorkerCtx<R>,
    x1: f64,
    y1: f64,
    cx: f64,
    cy: f64,
    x2: f64,
    y2: f64,
    half_width: f64,
    cap: LineCap,
) -> &[Scanline] {
    let scratch = &mut worker.stroke;
    scratch.points.clear();
    scratch.points.push((x1, y1));
    flatten_quadratic(&mut scratch.points, x1, y1, cx, cy, x2, y2);
    if scratch.points.len() < 2 {
        worker.lines.clear();
        return &worker.lines;
    }
    let mut caps = (cap != LineCap::Round).then(|| {
        let points = &scratch.points;
        let last = points.len() - 1;
        let next = |point: (f64, f64), fallback: (f64, f64)| {
            if point == (cx, cy) {
                fallback
            } else {
                (cx, cy)
            }
        };
        [
            CapPlane::new(points[0], next(points[0], points[1])),
            CapPlane::new(points[last], next(points[last], points[last - 1])),
        ]
    });
    if cap == LineCap::Square {
        lengthen_ends(
            &mut scratch.points,
            caps.as_mut().expect("square caps"),
            half_width,
        );
    }
    worker.lines.clear();
    stroke_polyline(
        &mut worker.lines,
        scratch,
        half_width,
        cap,
        caps,
        worker.width,
        worker.height,
    );
    &worker.lines
}

/// Adds extensions of `distance` along the curve's end tangents, and
/// moves the cap half-planes there to form square caps.
fn lengthen_ends(points: &mut Vec<(f64, f64)>, caps: &mut [CapPlane; 2], distance: f64) {
    for cap in caps.iter_mut() {
        cap.point = (
            cap.point.0 - distance * cap.inward.0,
            cap.point.1 - distance * cap.inward.1,
        );
    }
    // Keep the original first and last chords: extending those chords
    // would rotate a short end segment away from the true end tangent.
    points.insert(0, caps[0].point);
    points.push(caps[1].point);
}

/// Appends the end points of the flat pieces of a quadratic Bézier to
/// `points`, which already ends at its start `(x1, y1)`. A piece is flat when
/// its control point lies within 0.25 px of its chord, so the curve within
/// 0.125 px. Against tiny-skia's stroke, this matched more closely than
/// 0.5 px, and than 0.125 px, which follows the curve more closely than
/// tiny-skia's own flattening. Points that coincide with the previous one
/// are dropped, so every segment has a direction.
fn flatten_quadratic(
    points: &mut Vec<(f64, f64)>,
    x1: f64,
    y1: f64,
    cx: f64,
    cy: f64,
    x2: f64,
    y2: f64,
) {
    let chord_dx = x2 - x1;
    let chord_dy = y2 - y1;
    let chord_len_sq = chord_dx * chord_dx + chord_dy * chord_dy;
    let flat = if chord_len_sq < 1e-6 {
        true
    } else {
        let t = ((cx - x1) * chord_dx + (cy - y1) * chord_dy) / chord_len_sq;
        let proj_x = x1 + t * chord_dx;
        let proj_y = y1 + t * chord_dy;
        (cx - proj_x) * (cx - proj_x) + (cy - proj_y) * (cy - proj_y) < 0.0625
    };

    if flat {
        let &(last_x, last_y) = points.last().expect("points start at the curve's start");
        let (dx, dy) = (x2 - last_x, y2 - last_y);
        if (dx * dx + dy * dy).sqrt() > 1e-9 {
            points.push((x2, y2));
        }
    } else {
        let mx12 = (x1 + cx) * 0.5;
        let my12 = (y1 + cy) * 0.5;
        let mx23 = (cx + x2) * 0.5;
        let my23 = (cy + y2) * 0.5;
        let mx = (mx12 + mx23) * 0.5;
        let my = (my12 + my23) * 0.5;
        flatten_quadratic(points, x1, y1, mx12, my12, mx, my);
        flatten_quadratic(points, mx, my, mx23, my23, x2, y2);
    }
}

/// The pixels of a stroked polyline's bounding box, clipped to the canvas,
/// and the coverage written into them.
struct CoverageGrid<'a> {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    stride: usize,
    cells: &'a mut [u32],
    rows: &'a mut [(i32, i32)],
    caps: Option<[CapPlane; 2]>,
    #[cfg(test)]
    visits: &'a mut Vec<(i32, i32)>,
}

/// An inward cap half-plane for the curve body and join discs.
struct CapPlane {
    point: (f64, f64),
    inward: (f64, f64),
    filter: Trapezoid,
}

impl CapPlane {
    fn new(point: (f64, f64), next: (f64, f64)) -> Self {
        let (dx, dy) = (next.0 - point.0, next.1 - point.1);
        let length = (dx * dx + dy * dy).sqrt();
        let inward = (dx / length, dy / length);
        Self {
            point,
            inward,
            filter: Trapezoid::across(inward),
        }
    }

    fn coverage(&self, x: i32, y: i32) -> f64 {
        let offset = (f64::from(x) + 0.5 - self.point.0) * self.inward.0
            + (f64::from(y) + 0.5 - self.point.1) * self.inward.1;
        self.filter.inside(offset)
    }
}

impl CoverageGrid<'_> {
    /// Raises the coverage of pixel `(x, y)`, inside the grid, to `alpha`.
    #[inline]
    fn raise(&mut self, x: i32, y: i32, mut alpha: u32, clip: [bool; 2]) {
        #[cfg(test)]
        self.visits.push((x, y));
        if let Some(caps) = &self.caps {
            let mut share = f64::from(alpha);
            for (cap, active) in caps.iter().zip(clip) {
                if active {
                    share *= cap.coverage(x, y);
                }
            }
            alpha = share as u32;
        }
        let index = (y - self.y0) as usize * self.stride + (x - self.x0) as usize;
        let cell = &mut self.cells[index];
        *cell = (*cell).max(alpha);
    }

    /// Records that row `y` has coverage from column `lo` to `hi`.
    #[inline]
    fn extend_row(&mut self, y: i32, lo: i32, hi: i32) {
        let (row_lo, row_hi) = &mut self.rows[(y - self.y0) as usize];
        *row_lo = (*row_lo).min(lo);
        *row_hi = (*row_hi).max(hi);
    }
}

/// The stroke grid's padding around its flattened points. A covered
/// centre lies within `half_width + sqrt(2)/2` of a segment; the grid also
/// allows for its minor-axis projection and one pixel of outward rounding.
#[inline]
pub(crate) fn stroke_grid_margin(half_width: f64) -> f64 {
    let reach = half_width + std::f64::consts::FRAC_1_SQRT_2;
    reach * std::f64::consts::SQRT_2 + 1.0
}

/// Strokes the polyline in `scratch.points` with the given half-width into
/// `lines`, with the specified endpoint caps,
/// sampling every pixel of a `w`×`h` canvas at its centre.
fn stroke_polyline(
    lines: &mut Vec<Scanline>,
    scratch: &mut StrokeScratch,
    half_width: f64,
    cap: LineCap,
    caps: Option<[CapPlane; 2]>,
    w: i32,
    h: i32,
) {
    let StrokeScratch {
        points,
        segments,
        grid,
        rows,
        #[cfg(test)]
        visits,
    } = scratch;
    #[cfg(test)]
    visits.clear();
    if points.len() < 2 {
        return;
    }
    // Coverage is positive strictly within `half_width` plus half a
    // pixel's extent across a line, at most `√2 / 2`, of a segment. A
    // covered centre lies at most `reach · √2` from its segment along the
    // minor axis, and at most `reach + √2 / 2` past its end along the major
    // one.
    let margin = stroke_grid_margin(half_width);
    let (x_min, y_min, x_max, y_max) = points.iter().fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |(x0, y0, x1, y1), &(x, y)| (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
    );
    let x0 = ((x_min - margin).floor() as i32).max(0);
    let y0 = ((y_min - margin).floor() as i32).max(0);
    let x1 = ((x_max + margin).ceil() as i32).min(w - 1);
    let y1 = ((y_max + margin).ceil() as i32).min(h - 1);
    if x0 > x1 || y0 > y1 {
        return;
    }
    let stride = (x1 - x0 + 1) as usize;
    let height = (y1 - y0 + 1) as usize;
    if grid.len() < stride * height {
        grid.resize(stride * height, 0);
    }
    rows.clear();
    rows.resize(height, (i32::MAX, i32::MIN));
    let mut coverage = CoverageGrid {
        x0,
        y0,
        x1,
        y1,
        stride,
        cells: grid,
        rows,
        caps,
        #[cfg(test)]
        visits,
    };

    segments.clear();
    segments.extend(points.windows(2).map(|p| Segment::new(p[0], p[1])));
    // A shared major span avoids evaluating the same pixel twice at a
    // shallow turn. Compare tan² of the turn using cross and dot products.
    // The oracle at widths 2–6 px selects 1/8: worst pixel error 0.153558,
    // aggregate 2.0159%, retaining the 0.2 and 2.5% bounds.
    let join = |before: (f64, f64), at: (f64, f64), after: (f64, f64)| {
        let a = (at.0 - before.0, at.1 - before.1);
        let b = (after.0 - at.0, after.1 - at.1);
        let cross = a.0 * b.1 - a.1 * b.0;
        let dot = a.0 * b.0 + a.1 * b.1;
        let same_axis = (a.1.abs() > a.0.abs()) == (b.1.abs() > b.0.abs());
        if same_axis && dot > 0.0 && cross * cross <= 0.125 * dot * dot {
            End::Shared
        } else {
            End::Round
        }
    };
    let last = points.len() - 1;
    let end_cap = if cap == LineCap::Round {
        End::RoundCap
    } else {
        End::Cap
    };
    for index in 0..last {
        let (a, b) = (points[index], points[index + 1]);
        let end_a = if index == 0 {
            end_cap
        } else if cap == LineCap::Round {
            join(points[index - 1], a, b)
        } else {
            End::Round
        };
        let end_b = if index + 1 == last {
            end_cap
        } else if cap == LineCap::Round {
            join(a, b, points[index + 2])
        } else {
            End::Round
        };
        // Square-cap rectangles are separate extensions, and may cross
        // the opposite cap plane on a very short curve. The curve body
        // and every join disc stay clipped by both endpoint planes.
        let band_clip = if cap == LineCap::Square && index == 0 {
            [true, false]
        } else if cap == LineCap::Square && index + 1 == last {
            [false, true]
        } else {
            [true; 2]
        };
        let neighbours = [
            (end_a == End::Shared).then(|| &segments[index - 1]),
            (end_b == End::Shared).then(|| &segments[index + 1]),
        ];
        stroke_segment(
            &mut coverage,
            &segments[index],
            half_width,
            [end_a, end_b],
            band_clip,
            neighbours,
        );
    }

    let CoverageGrid { cells, rows, .. } = coverage;
    for (row, (&(lo, hi), y)) in rows.iter().zip(y0..).enumerate() {
        if lo > hi {
            continue;
        }
        let base = row * stride;
        let cells = &mut cells[base + (lo - x0) as usize..=base + (hi - x0) as usize];
        let mut run_start = lo;
        let mut run_alpha = std::mem::take(&mut cells[0]);
        for (x, cell) in (lo + 1..).zip(&mut cells[1..]) {
            let alpha = std::mem::take(cell);
            if alpha != run_alpha {
                if run_alpha > 0 {
                    lines.push(Scanline {
                        y,
                        x1: run_start,
                        x2: x - 1,
                        alpha: run_alpha,
                    });
                }
                run_start = x;
                run_alpha = alpha;
            }
        }
        if run_alpha > 0 {
            lines.push(Scanline {
                y,
                x1: run_start,
                x2: hi,
                alpha: run_alpha,
            });
        }
    }
}

/// How a unit pixel spreads its area across a line: along the line's unit
/// normal, its sides project to lengths `long` and `short` (the larger and
/// smaller of the normal's two components), so its area spreads as a
/// trapezoid of height `1 / long` on `[-end, end]`, `end = (long + short) / 2`,
/// with ramps `short` wide. The share of a pixel on one side of a line, or
/// within a band around it, is an area under this trapezoid. The functions
/// run for every pixel of a stroke, so the primitive returns on the flat
/// top before computing the ramp.
#[derive(Clone, Copy)]
struct Trapezoid {
    /// `(long - short) / 2`, where the flat top ends.
    top: f64,
    /// `(long + short) / 2`, where the trapezoid ends.
    end: f64,
    inv_long: f64,
    /// `1 / (2 · long · short)`, or 0 when `short` is 0 and the ramps have
    /// no width.
    inv_ramp: f64,
}

impl Trapezoid {
    /// The trapezoid across a line with unit normal (or, equally, unit
    /// direction) `(x, y)`.
    fn across((x, y): (f64, f64)) -> Self {
        let (long, short) = (x.abs().max(y.abs()), x.abs().min(y.abs()));
        Self {
            top: (long - short) * 0.5,
            end: (long + short) * 0.5,
            inv_long: 1.0 / long,
            inv_ramp: if short > 0.0 {
                0.5 / (long * short)
            } else {
                0.0
            },
        }
    }

    /// The area on `[0, x]` for `x ≥ 0`: linear on the flat top, then
    /// `1/2` less the ramp's remaining triangle, which is empty past `end`.
    #[inline]
    fn primitive(self, x: f64) -> f64 {
        if x <= self.top {
            return x * self.inv_long;
        }
        let rest = (self.end - x).max(0.0);
        0.5 - (rest * rest) * self.inv_ramp
    }

    /// The share of a pixel on the positive side of a line its centre is at
    /// signed offset `offset` from.
    #[inline]
    fn inside(self, offset: f64) -> f64 {
        0.5 + self.primitive(offset.abs()).copysign(offset)
    }

    /// The share of a pixel within `half_width` of a line its centre is
    /// `distance ≥ 0` from: the area on `[distance - half_width,
    /// distance + half_width]`, exact for an infinite straight band.
    ///
    /// A band wider than the trapezoid, `half_width > end` (every stroke
    /// width the search draws), has its far term `primitive(half_width +
    /// distance)` past `end`, where the primitive is exactly `1/2`, so it
    /// takes that constant; and where the near end is past `end` too, the
    /// sum is exactly 1. Both are the full expression's values bit for bit.
    #[inline]
    fn band(self, half_width: f64, distance: f64) -> f64 {
        let near = half_width - distance;
        let far = if half_width > self.end {
            if near > self.end {
                return 1.0;
            }
            0.5
        } else {
            self.primitive(half_width + distance)
        };
        (self.primitive(near.abs()).copysign(near) + far).clamp(0.0, 1.0)
    }
}

/// How one end of a flat segment meets the rest of the stroke.
#[derive(Clone, Copy, PartialEq, Eq)]
enum End {
    /// The curve's own end: the band runs on past it, cut by a butt cap
    /// across the segment, as the exporter draws it.
    Cap,
    /// The curve's own end with a round cap: a pixel whose centre is past
    /// the end point gets its share within `half_width` of that point,
    /// across the line through it perpendicular to the centre's direction
    /// from it ([`Trapezoid::band`] along that direction). The disc's
    /// curvature within the pixel is not modelled.
    RoundCap,
    /// A round join: spans overlap, and a pixel whose foot is past this
    /// end uses its distance to the vertex. Taking the larger coverage
    /// of the neighbours covers the union of their finite bands.
    Round,
    /// A shallow same-axis join: neighbours own half-open major spans.
    /// Past its own end, a pixel consults the neighbour's finite band;
    /// past both neighbours it uses the vertex disc.
    Shared,
}

/// A prepared finite segment. Its owner and shared neighbours reuse the
/// same normalisation and box-filtered band.
#[derive(Clone)]
struct Segment {
    point: (f64, f64),
    end: (f64, f64),
    direction: (f64, f64),
    length: f64,
    steep: bool,
    gradient: f64,
    cos_theta: f64,
    filter: Trapezoid,
}

impl Segment {
    fn new(point: (f64, f64), end: (f64, f64)) -> Self {
        let (dx, dy) = (end.0 - point.0, end.1 - point.1);
        let steep = dy.abs() > dx.abs();
        let (major, minor) = if steep { (dy, dx) } else { (dx, dy) };
        let gradient = minor / major;
        let cos_theta = 1.0 / (gradient * gradient + 1.0).sqrt();
        let along_major = cos_theta.copysign(major);
        let along_minor = gradient * along_major;
        let direction = if steep {
            (along_minor, along_major)
        } else {
            (along_major, along_minor)
        };
        Self {
            point,
            end,
            direction,
            length: major.abs() / cos_theta,
            steep,
            gradient,
            cos_theta,
            filter: Trapezoid::across((cos_theta, gradient * cos_theta)),
        }
    }

    fn coverage(&self, x: f64, y: f64, half_width: f64) -> f64 {
        let (dx, dy) = (x - self.point.0, y - self.point.1);
        let along = dx * self.direction.0 + dy * self.direction.1;
        if along <= 0.0 {
            round_cap(half_width, dx, dy)
        } else if along >= self.length {
            round_cap(half_width, x - self.end.0, y - self.end.1)
        } else {
            let across = dy * self.direction.0 - dx * self.direction.1;
            self.filter.band(half_width, across.abs())
        }
    }
}

/// Covers the pixels near one flat segment from `a` to `b` with the share of
/// their area within `half_width` of it ([`Trapezoid::band`]), each end as
/// its [`End`] describes. Pixels off the grid are off the canvas.
fn stroke_segment(
    grid: &mut CoverageGrid<'_>,
    segment: &Segment,
    half_width: f64,
    [end_a, end_b]: [End; 2],
    band_clip: [bool; 2],
    neighbours: [Option<&Segment>; 2],
) {
    let (a, b, steep) = (segment.point, segment.end, segment.steep);
    // Major and minor coordinates, and the grid's bounds along each.
    let (a_major, a_minor, b_major, b_minor) = if steep {
        (a.1, a.0, b.1, b.0)
    } else {
        (a.0, a.1, b.0, b.1)
    };
    let (major_lo, major_hi, minor_lo, minor_hi) = if steep {
        (grid.y0, grid.y1, grid.x0, grid.x1)
    } else {
        (grid.x0, grid.x1, grid.y0, grid.y1)
    };
    let (gradient, cos_theta, trapezoid) = (segment.gradient, segment.cos_theta, segment.filter);
    // Coverage is positive strictly within `reach` of the segment.
    let reach = half_width + trapezoid.end;
    let half_band = reach / cos_theta;
    let length = segment.length;
    let (along_major, along_minor) = if steep {
        (segment.direction.1, segment.direction.0)
    } else {
        segment.direction
    };
    // How far the span runs on past an end, along the major axis: a
    // covered centre past a cap is within `trapezoid.end` of it along the
    // segment and `reach` across it, and one past a round cap within
    // `half_width` plus half a pixel's extent along its direction from the
    // end point, at most `√2 / 2`, of the end point.
    let past = |end: End| match end {
        End::Cap => reach + trapezoid.end,
        End::RoundCap => half_width + std::f64::consts::FRAC_1_SQRT_2,
        End::Round => reach,
        End::Shared => 0.0,
    };
    let (past_lo, past_hi) = if b_major > a_major {
        (past(end_a), past(end_b))
    } else {
        (past(end_b), past(end_a))
    };
    // Major indices `i` whose centre `i + 0.5` is in `[min, max)` of the
    // span.
    let first = ((a_major.min(b_major) - past_lo - 0.5).ceil() as i32).max(major_lo);
    let end = ((a_major.max(b_major) + past_hi - 0.5).ceil() as i32).min(major_hi + 1);
    for i in first..end {
        let centre = f64::from(i) + 0.5;
        let minor = gradient * (centre - a_major) + a_minor;
        // Minor indices whose centre is within `half_band` of the line.
        let lo = ((minor - half_band - 0.5).ceil() as i32).max(minor_lo);
        let hi = ((minor + half_band - 0.5).floor() as i32).min(minor_hi);
        if lo > hi {
            continue;
        }
        // The offset along the segment from `a` of the line's point at this
        // centre. The pixels of the column are within `reach` of it, and
        // where every pixel is at least `trapezoid.end` within both ends,
        // the ends do not matter.
        let column = (centre - a_major) * along_major / (cos_theta * cos_theta);
        let inner = reach + trapezoid.end;
        if column >= inner && column <= length - inner {
            for j in lo..=hi {
                let across = (f64::from(j) + 0.5 - minor) * cos_theta;
                let alpha = (trapezoid.band(half_width, across.abs()) * f64::from(M)) as u32;
                if steep {
                    grid.raise(j, i, alpha, band_clip);
                } else {
                    grid.raise(i, j, alpha, band_clip);
                    grid.extend_row(j, i, i);
                }
            }
            if steep {
                grid.extend_row(i, lo, hi);
            }
            continue;
        }
        for j in lo..=hi {
            let minor_centre = f64::from(j) + 0.5;
            // The pixel centre's offsets across the segment's line and
            // along it from `a`.
            let across = (minor_centre - minor) * cos_theta;
            let along = (centre - a_major) * along_major + (minor_centre - a_minor) * along_minor;
            let neighbour = if along < 0.0 {
                &neighbours[0]
            } else if along > length {
                &neighbours[1]
            } else {
                &None
            };
            let share = if let Some(neighbour) = neighbour {
                let (x, y) = if steep {
                    (minor_centre, centre)
                } else {
                    (centre, minor_centre)
                };
                neighbour.coverage(x, y, half_width)
            } else if along < 0.0 && end_a != End::Cap {
                // A round cap, or a join without a finite neighbour band.
                round_cap(half_width, centre - a_major, minor_centre - a_minor)
            } else if along > length && end_b != End::Cap {
                round_cap(half_width, centre - b_major, minor_centre - b_minor)
            } else {
                trapezoid.band(half_width, across.abs())
            };
            let alpha = (share * f64::from(M)) as u32;
            let clip = if (along < 0.0 && end_a == End::Round)
                || (along > length && end_b == End::Round)
            {
                [true; 2]
            } else {
                band_clip
            };
            if steep {
                grid.raise(j, i, alpha, clip);
            } else {
                grid.raise(i, j, alpha, clip);
                grid.extend_row(j, i, i);
            }
        }
        if steep {
            grid.extend_row(i, lo, hi);
        }
    }
}

/// The share of a pixel within `half_width` of a round cap's end point, its
/// centre at offset `(dx, dy)` from it (in either axis order): the band
/// across the centre's direction from the end point, at its distance.
#[inline]
fn round_cap(half_width: f64, dx: f64, dy: f64) -> f64 {
    let distance = (dx * dx + dy * dy).sqrt();
    if distance == 0.0 {
        return Trapezoid::across((1.0, 0.0)).band(half_width, 0.0);
    }
    Trapezoid::across((dx / distance, dy / distance)).band(half_width, distance)
}

/// The span `(left, right)` of the horizontal line at `y` inside the convex
/// polygon `vertices`, or `None` if the line misses it.
pub(crate) fn convex_row_span(vertices: &[(f64, f64)], y: f64) -> Option<(f64, f64)> {
    let mut left = f64::INFINITY;
    let mut right = f64::NEG_INFINITY;
    for (i, &(x0, y0)) in vertices.iter().enumerate() {
        let (x1, y1) = vertices[(i + 1) % vertices.len()];
        if y < y0.min(y1) || y > y0.max(y1) {
            continue;
        }
        let (a, b) = if y0 == y1 {
            (x0.min(x1), x0.max(x1))
        } else {
            let x = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
            (x, x)
        };
        left = left.min(a);
        right = right.max(b);
    }
    (left <= right).then_some((left, right))
}

/// Fills the pixels of a `w`×`h` canvas whose centres lie inside the convex
/// polygon `vertices`, one fully opaque scanline per row.
pub(crate) fn fill_convex_at_pixel_centres(
    lines: &mut Vec<Scanline>,
    vertices: &[(f64, f64)],
    w: i32,
    h: i32,
) {
    let (y_min, y_max) = vertices
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &(_, y)| {
            (lo.min(y), hi.max(y))
        });
    // Row `iy` is sampled at its centre `iy + 0.5`.
    let iy_min = ((y_min - 0.5).ceil() as i32).max(0);
    let iy_max = ((y_max - 0.5).floor() as i32).min(h - 1);
    for iy in iy_min..=iy_max {
        let Some((left, right)) = convex_row_span(vertices, f64::from(iy) + 0.5) else {
            continue;
        };
        let x1 = ((left - 0.5).ceil() as i32).max(0);
        let x2 = ((right - 0.5).floor() as i32).min(w - 1);
        if x1 <= x2 {
            lines.push(Scanline {
                y: iy,
                x1,
                x2,
                alpha: 0xFFFF,
            });
        }
    }
}

/// Fixed-point scale of one sub-row's horizontal coverage of a pixel: a fully
/// covered sub-row contributes exactly `SUB_ROW_ONE`.
const SUB_ROW_ONE: f64 = 65536.0;

/// The coverage of one sub-row span over one pixel, `overlap` in `0..=1`, in
/// units of [`SUB_ROW_ONE`].
#[inline]
fn sub_row_coverage(overlap: f64) -> u32 {
    (overlap * SUB_ROW_ONE) as u32
}

/// Converts the summed [`sub_row_coverage`] of one pixel over `sub_rows`
/// sub-rows into a scanline alpha in `0..=0xFFFF`.
///
/// The sum is scaled once, so a pixel covered in every sub-row gets exactly
/// `0xFFFF`. (Scaling each sub-row to `0xFFFF / 4` first summed to 65532.)
#[inline]
fn coverage_to_alpha(covered: u32, sub_rows: usize) -> u32 {
    let full = sub_rows as u64 * SUB_ROW_ONE as u64;
    ((u64::from(covered) * 0xFFFF / full) as u32).min(0xFFFF)
}

/// Reusable per-row storage for the anti-aliased fills, kept in each worker
/// so that rasterizing a row neither allocates nor zeroes a fixed array.
#[derive(Clone, Default)]
pub(crate) struct RowScratch {
    /// A polygon row's edge crossings: their x and their sub-row.
    hits: Vec<(f64, usize)>,
    /// A row's spans `(left, right)`, one or more per covered sub-row.
    spans: Vec<(f64, f64)>,
    /// The sorted, distinct columns of the pixels that hold a span end.
    edges: Vec<i32>,
    /// A polygon's sides, prepared once per fill.
    sides: Vec<PolygonSide>,
}

impl RowScratch {
    pub(crate) fn reset(&mut self) {
        self.hits.clear();
        self.spans.clear();
        self.edges.clear();
        self.sides.clear();
    }
}

/// A polygon side from `(x0, y0)` to `(x0 + dx, y0 + dy)`, with the
/// half-open range `y_lo..y_hi` of the sub-rows it crosses.
#[derive(Clone, Copy)]
struct PolygonSide {
    x0: f64,
    y0: f64,
    dx: f64,
    dy: f64,
    y_lo: f64,
    y_hi: f64,
}

/// The alpha of pixel column `px` under the sub-row `spans`: the summed
/// horizontal overlap of each span with the pixel.
#[inline]
fn pixel_alpha(spans: &[(f64, f64)], px: i32, sub_rows: usize) -> u32 {
    let px_left = f64::from(px);
    let px_right = px_left + 1.0;
    let mut covered = 0;
    for &(left, right) in spans {
        let overlap_l = left.max(px_left);
        let overlap_r = right.min(px_right);
        if overlap_r > overlap_l {
            covered += sub_row_coverage(overlap_r - overlap_l);
        }
    }
    coverage_to_alpha(covered, sub_rows)
}

/// Builds one row's scanlines as maximal runs of equal non-zero alpha.
struct RowRuns<'a> {
    lines: &'a mut Vec<Scanline>,
    y: i32,
    start: i32,
    alpha: u32,
}

impl RowRuns<'_> {
    /// Gives the pixels from `x` up to the next call the coverage `alpha`.
    #[inline]
    fn set(&mut self, x: i32, alpha: u32) {
        if alpha != self.alpha {
            self.finish(x - 1);
            self.start = x;
            self.alpha = alpha;
        }
    }

    /// Emits the open run, which ends at column `x2`.
    #[inline]
    fn finish(&mut self, x2: i32) {
        if self.alpha > 0 {
            self.lines.push(Scanline {
                y: self.y,
                x1: self.start,
                x2,
                alpha: self.alpha,
            });
        }
    }
}

/// Emits row `y` of an anti-aliased fill over columns `ix_min..=ix_max`
/// from the row's sub-row `spans`, as maximal runs of equal non-zero alpha.
///
/// Only a pixel that holds a span end (the column `floor` of the end) can be
/// partly overlapped by that span; every other pixel lies wholly inside or
/// wholly outside each span. Between two such edge pixels the set of spans
/// covering a pixel therefore cannot change, so each gap is evaluated once
/// and emitted as one run, and the interior of a shape costs nothing per
/// pixel. The output equals evaluating [`pixel_alpha`] for every pixel.
fn emit_row(
    lines: &mut Vec<Scanline>,
    edges: &mut Vec<i32>,
    spans: &[(f64, f64)],
    y: i32,
    ix_min: i32,
    ix_max: i32,
    sub_rows: usize,
) {
    edges.clear();
    for &(left, right) in spans {
        edges.push(left.floor() as i32);
        edges.push(right.floor() as i32);
    }
    edges.sort_unstable();
    edges.dedup();

    let mut runs = RowRuns {
        lines,
        y,
        start: ix_min,
        alpha: 0,
    };
    let mut px = ix_min;
    for &edge in edges.iter() {
        if edge < px {
            continue;
        }
        if edge > ix_max {
            break;
        }
        if px < edge {
            runs.set(px, pixel_alpha(spans, px, sub_rows));
        }
        runs.set(edge, pixel_alpha(spans, edge, sub_rows));
        px = edge + 1;
    }
    if px <= ix_max {
        runs.set(px, pixel_alpha(spans, px, sub_rows));
    }
    runs.finish(ix_max);
}

/// Fills a closed polygon directly into `lines` as anti-aliased scanlines.
///
/// Uses scanline intersection with 4× sub-pixel vertical antialiasing.
/// Each polygon edge is intersected at 4 sub-rows per pixel row, the sorted
/// crossings of each sub-row are paired into spans (even-odd rule), and the
/// coverage of each pixel is the summed horizontal overlap of those spans
/// with it.
///
/// With `convex`, the caller vouches that `vertices` are a strictly convex
/// triangle or quad (`is_legible_convex(vertices, 0.0)`, which every
/// [`crate::shapes::Polygon`] passes, halved or not): a sub-row then
/// crosses at most two sides, so its scan stops at the second crossing and
/// the pair needs no sort, only an order. The result is the same as without
/// `convex`, which fills any outline.
pub(crate) fn fill_polygon_direct(
    lines: &mut Vec<Scanline>,
    scratch: &mut RowScratch,
    vertices: &[(f64, f64)],
    w: i32,
    h: i32,
    convex: bool,
) {
    lines.clear();

    let n = vertices.len();
    if n < 3 {
        return;
    }
    debug_assert!(
        !convex || ((3..=4).contains(&n) && crate::shapes::is_legible_convex(vertices, 0.0)),
        "not a strictly convex triangle or quad: {vertices:?}"
    );

    // Find y range.
    let mut y_min = f64::MAX;
    let mut y_max = f64::MIN;
    for &(_, y) in vertices {
        y_min = y_min.min(y);
        y_max = y_max.max(y);
    }
    let iy_min = (y_min.floor() as i32).max(0);
    let iy_max = (y_max.ceil() as i32).min(h);

    const NUM_AA: usize = 4;
    let RowScratch {
        hits,
        spans,
        edges,
        sides,
    } = scratch;
    sides.clear();
    for i in 0..n {
        let (x0, y0) = vertices[i];
        let (x1, y1) = vertices[(i + 1) % n];
        let (y_lo, y_hi) = if y0 < y1 { (y0, y1) } else { (y1, y0) };
        sides.push(PolygonSide {
            x0,
            y0,
            dx: x1 - x0,
            dy: y1 - y0,
            y_lo,
            y_hi,
        });
    }

    for iy in iy_min..iy_max {
        // Collect the x crossings of every sub-row, tagged with the sub-row.
        hits.clear();
        for s in 0..NUM_AA {
            let sub_start = hits.len();
            let y_sub = iy as f64 + (s as f64 + 0.5) / NUM_AA as f64;

            for side in sides.iter() {
                if y_sub < side.y_lo || y_sub >= side.y_hi {
                    continue;
                }
                let t = (y_sub - side.y0) / side.dy;
                let x = side.x0 + t * side.dx;
                hits.push((x, s));
                if convex && hits.len() == sub_start + 2 {
                    break;
                }
            }
        }

        if hits.is_empty() {
            continue;
        }

        // Determine the pixel x range touched by any intersection.
        let mut x_min_f = f64::MAX;
        let mut x_max_f = f64::MIN;
        for &(x, _) in hits.iter() {
            x_min_f = x_min_f.min(x);
            x_max_f = x_max_f.max(x);
        }
        let ix_min = (x_min_f.floor() as i32).max(0);
        let ix_max = ((x_max_f.ceil() as i32) - 1).min(w - 1);
        if ix_min > ix_max {
            continue;
        }

        // Sort the crossings by sub-row, then by x, and pair consecutive
        // crossings of each sub-row into spans.
        if !convex {
            hits.sort_unstable_by(|a, b| a.1.cmp(&b.1).then(a.0.total_cmp(&b.0)));
        }
        spans.clear();
        for sub_row in hits.chunk_by(|a, b| a.1 == b.1) {
            for [left, right] in sub_row.as_chunks::<2>().0 {
                // Convex hits are already grouped by sub-row, with just
                // two per group. Preserve total_cmp, including signed zero.
                let (left, right) = if convex && left.0.total_cmp(&right.0).is_gt() {
                    (right, left)
                } else {
                    (left, right)
                };
                spans.push((left.0, right.0));
            }
        }

        emit_row(lines, edges, spans, iy, ix_min, ix_max, NUM_AA);
    }
}

/// Inclusive grid bounds along one axis of a rotated ellipse, with the
/// rasterizer's one-pixel sampling margin. `axis_rx` and `axis_ry` are the
/// projections of the two radius axes (sin/cos for y, cos/sin for x).
#[inline]
pub(crate) fn rotated_ellipse_axis_bounds(
    centre: f64,
    rx: f64,
    ry: f64,
    axis_rx: f64,
    axis_ry: f64,
) -> (i32, i32) {
    let half_extent = ((rx * axis_rx) * (rx * axis_rx) + (ry * axis_ry) * (ry * axis_ry)).sqrt();
    (
        (centre - half_extent - 1.0).floor() as i32,
        (centre + half_extent + 1.0).ceil() as i32,
    )
}

/// Fills a rotated ellipse directly into `lines` using 4x vertical antialiasing.
///
/// The ellipse is centered at `(cx, cy)` with radii `rx` and `ry`, rotated by
/// `degrees`, whose sine and cosine come from [`sin_cos_degrees`] so that
/// every target computes the same coverage. Each row is intersected at 4
/// sub-row sample positions, then the exact horizontal overlap of each sub-row
/// span with each pixel is summed into a 16-bit alpha value.
pub(crate) fn fill_rotated_ellipse_direct(
    lines: &mut Vec<Scanline>,
    scratch: &mut RowScratch,
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    degrees: f64,
    w: i32,
    h: i32,
) {
    lines.clear();
    if rx <= 0.0 || ry <= 0.0 || w <= 0 || h <= 0 {
        return;
    }

    const NUM_AA: usize = 4;
    let (sin_t, cos_t) = sin_cos_degrees(degrees);
    let inv_rx2 = 1.0 / (rx * rx);
    let inv_ry2 = 1.0 / (ry * ry);
    let coeff_a = cos_t * cos_t * inv_rx2 + sin_t * sin_t * inv_ry2;
    let coeff_b = 2.0 * cos_t * sin_t * (inv_rx2 - inv_ry2);
    let coeff_c = sin_t * sin_t * inv_rx2 + cos_t * cos_t * inv_ry2;

    let (iy_min, iy_max) = rotated_ellipse_axis_bounds(cy, rx, ry, sin_t, cos_t);
    let iy_min = iy_min.max(0);
    let iy_max = iy_max.min(h - 1);
    let RowScratch { spans, edges, .. } = scratch;

    for iy in iy_min..=iy_max {
        spans.clear();
        let mut row_x_min = f64::MAX;
        let mut row_x_max = f64::MIN;

        for sub in 0..NUM_AA {
            let y_sub = iy as f64 + (sub as f64 + 0.5) / NUM_AA as f64;
            let dy = y_sub - cy;
            let quadratic_b = coeff_b * dy;
            let quadratic_c = coeff_c * dy * dy - 1.0;
            let discriminant = quadratic_b * quadratic_b - 4.0 * coeff_a * quadratic_c;
            if discriminant < 0.0 {
                continue;
            }

            let root = discriminant.sqrt();
            let x1 = cx + (-quadratic_b - root) / (2.0 * coeff_a);
            let x2 = cx + (-quadratic_b + root) / (2.0 * coeff_a);
            let left = x1.min(x2);
            let right = x1.max(x2);
            spans.push((left, right));
            row_x_min = row_x_min.min(left);
            row_x_max = row_x_max.max(right);
        }

        if spans.is_empty() {
            continue;
        }

        let ix_min = (row_x_min.floor() as i32).max(0);
        let ix_max = ((row_x_max.ceil() as i32) - 1).min(w - 1);
        if ix_min > ix_max {
            continue;
        }

        emit_row(lines, edges, spans, iy, ix_min, ix_max, NUM_AA);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::Buffer;
    use crate::color::Color;
    use crate::score;
    use crate::shapes::{Ellipse, Shape, is_legible_convex};
    use crate::worker::WorkerCtx;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The convex fill, which stops at a sub-row's second crossing and
    /// orders the pair without a sort, equals the general even-odd fill on
    /// strictly convex triangles and quads, among them quads whose sides
    /// lie on pixel and sub-row boundaries.
    #[test]
    fn convex_crossings_match_reference() {
        let mut rng = ChaCha8Rng::seed_from_u64(0xc2055);
        let (mut actual, mut expected) = (Vec::new(), Vec::new());
        let (mut scratch, mut reference_scratch) = (RowScratch::default(), RowScratch::default());
        let mut convex = 0;
        for sample in 0..3000 {
            let vertices: Vec<_> = if sample < 16 {
                let offset = sample as f64 / 8.0 - 0.5;
                vec![
                    (-3.0 + offset, -2.0 + offset),
                    (35.0, -2.0 + offset),
                    (35.0, 34.0),
                    (-3.0 + offset, 34.0),
                ]
            } else {
                let points = [(0.0, 0.0), (24.0, 0.0), (24.0, 24.0), (0.0, 24.0)];
                points
                    .into_iter()
                    .map(|(x, y)| {
                        (
                            x + rng.random_range(-9.0..9.0),
                            y + rng.random_range(-9.0..9.0),
                        )
                    })
                    .collect()
            };
            if !is_legible_convex(&vertices, 0.0) {
                continue;
            }
            convex += 1;
            fill_polygon_direct(&mut actual, &mut scratch, &vertices, 32, 32, true);
            fill_polygon_direct(
                &mut expected,
                &mut reference_scratch,
                &vertices,
                32,
                32,
                false,
            );
            assert_eq!(actual, expected, "{vertices:?}");
        }
        assert!(convex > 2900, "{convex} convex samples");
    }

    /// [`Trapezoid::band`] as both its terms computed in full: the
    /// reference for its shortcuts.
    fn two_term_band(trapezoid: Trapezoid, half_width: f64, distance: f64) -> f64 {
        let near = half_width - distance;
        (trapezoid.primitive(near.abs()).copysign(near)
            + trapezoid.primitive(half_width + distance))
        .clamp(0.0, 1.0)
    }

    /// The band equals its two terms computed in full, bit for bit, for
    /// every stroke width the search draws (the quadratics' 2–6 px) and the
    /// lab's 1 px, across the directions of segments and round caps, on a
    /// grid of distances and at the trapezoid's breakpoints.
    #[test]
    fn bands_match_their_two_terms_computed_in_full() {
        let (min, max) = crate::shapes::Quadratic::STROKE_WIDTHS;
        let mut widths: Vec<f64> = vec![1.0];
        widths.extend((0..=64).map(|k| min + (max - min) * f64::from(k) / 64.0));
        let mut rng = ChaCha8Rng::seed_from_u64(12);
        widths.extend((0..32).map(|_| rng.random_range(min..=max)));
        // Segments' unit directions, as `stroke_segment` computes them,
        // then round caps' arbitrary ones.
        let mut directions: Vec<(f64, f64)> = (0..=64)
            .map(|k| {
                let gradient = f64::from(k) / 64.0;
                let cos_theta = 1.0 / (gradient * gradient + 1.0).sqrt();
                (cos_theta, gradient * cos_theta)
            })
            .collect();
        directions.extend((0..64).map(|_| {
            let (dx, dy): (f64, f64) = (rng.random_range(-5.0..5.0), rng.random_range(-5.0..5.0));
            let distance: f64 = (dx * dx + dy * dy).sqrt();
            (dx / distance, dy / distance)
        }));
        let mut checked = 0;
        for &direction in &directions {
            let trapezoid = Trapezoid::across(direction);
            for &width in &widths {
                let half_width: f64 = width / 2.0;
                let mut distances: Vec<f64> = (0..=640).map(|k| f64::from(k) / 128.0).collect();
                for edge in [trapezoid.top, trapezoid.end] {
                    for base in [half_width - edge, half_width + edge] {
                        for offset in [-1e-12, 0.0, 1e-12] {
                            distances.push((base + offset).max(0.0));
                        }
                    }
                }
                distances.extend((0..64).map(|_| rng.random_range(0.0..half_width + 1.0)));
                for &distance in &distances {
                    let (band, reference) = (
                        trapezoid.band(half_width, distance),
                        two_term_band(trapezoid, half_width, distance),
                    );
                    assert_eq!(
                        band.to_bits(),
                        reference.to_bits(),
                        "{direction:?}, {half_width}, {distance}: {band} against {reference}"
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 1_000_000, "{checked}");
    }

    fn render_mask(lines: &[Scanline], width: u32, height: u32) -> Buffer {
        let mut buffer = Buffer::new(width, height);
        score::draw_lines(&mut buffer, Color::new(255, 255, 255, 255), lines);
        buffer
    }

    #[test]
    fn stroke_quadratic_direct_produces_scanlines() {
        let mut worker = WorkerCtx::new(64, 64, ChaCha8Rng::seed_from_u64(3));
        // A clear, shallow arc across the middle of the image.
        let lines = stroke_quadratic_direct(
            &mut worker,
            5.0,
            32.0,
            32.0,
            10.0,
            59.0,
            32.0,
            0.25,
            LineCap::Butt,
        );
        assert!(
            !lines.is_empty(),
            "a quadratic bezier across the image should produce scanlines"
        );
    }

    #[test]
    fn stroke_quadratic_direct_stays_in_bounds() {
        let mut worker = WorkerCtx::new(64, 64, ChaCha8Rng::seed_from_u64(4));
        // Control points that extend well outside the image.
        let lines = stroke_quadratic_direct(
            &mut worker,
            -20.0,
            -20.0,
            32.0,
            100.0,
            100.0,
            100.0,
            0.25,
            LineCap::Butt,
        );
        assert!(
            lines
                .iter()
                .all(|l| l.x1 >= 0 && l.x2 < 64 && l.y >= 0 && l.y < 64),
            "stroke scanlines escaped image bounds: {lines:?}"
        );
    }

    #[test]
    fn stroke_quadratic_direct_merges_equal_coverage_into_runs() {
        let mut worker = WorkerCtx::new(64, 64, ChaCha8Rng::seed_from_u64(5));
        // A straight horizontal stroke 3 px wide centred on row 10's centres:
        // rows 9 to 11 are fully covered between the butt caps at x = 5 and
        // x = 55, and rows 8 and 12 sit exactly at the coverage reach.
        let lines = stroke_quadratic_direct(
            &mut worker,
            5.0,
            10.5,
            30.0,
            10.5,
            55.0,
            10.5,
            1.5,
            LineCap::Butt,
        );
        let row = |y| Scanline {
            y,
            x1: 5,
            x2: 54,
            alpha: 0xFFFF,
        };
        assert_eq!(lines, &[row(9), row(10), row(11)]);
    }

    #[test]
    fn stroke_quadratic_direct_covers_the_area_of_a_thin_stroke() {
        let mut worker = WorkerCtx::new(16, 16, ChaCha8Rng::seed_from_u64(6));
        // A vertical stroke along x = 4.5 from y = 2 to y = 12, 0.5 px wide:
        // it covers half of each pixel of column 4 between its caps, and
        // none of columns 3 and 5 or of rows 1 and 12.
        let lines = stroke_quadratic_direct(
            &mut worker,
            4.5,
            2.0,
            4.5,
            7.0,
            4.5,
            12.0,
            0.25,
            LineCap::Butt,
        );
        let expected: Vec<_> = (2..12)
            .map(|y| Scanline {
                y,
                x1: 4,
                x2: 4,
                alpha: 0x7FFF,
            })
            .collect();
        assert_eq!(lines, expected);
    }

    #[test]
    fn stroke_quadratic_direct_cuts_butt_caps_through_pixels() {
        let mut worker = WorkerCtx::new(32, 32, ChaCha8Rng::seed_from_u64(7));
        // A horizontal stroke 1 px wide on row 10 from x = 5.25 to 20.75:
        // its caps cover three quarters of pixels 5 and 20.
        let lines = stroke_quadratic_direct(
            &mut worker,
            5.25,
            10.5,
            13.0,
            10.5,
            20.75,
            10.5,
            0.5,
            LineCap::Butt,
        );
        let run = |x1, x2, alpha| Scanline {
            y: 10,
            x1,
            x2,
            alpha,
        };
        let three_quarters = (0.75 * f64::from(M)) as u32;
        assert_eq!(
            lines,
            &[
                run(5, 5, three_quarters),
                run(6, 19, 0xFFFF),
                run(20, 20, three_quarters)
            ]
        );
    }

    /// A curve `[x1, y1, cx, cy, x2, y2]` and a half-width of the cap
    /// tests: straight along each axis and the diagonal, shallow, steep and
    /// arched, with the stroke widths 2, 4 and 6 px of the search.
    const CAP_CURVES: [([f64; 6], f64); 7] = [
        ([6.3, 20.5, 20.0, 20.5, 33.7, 20.5], 1.0),
        ([12.5, 6.25, 12.5, 18.0, 12.5, 31.6], 2.0),
        ([6.2, 5.7, 18.0, 17.5, 29.9, 29.4], 1.0),
        ([5.0, 10.2, 20.0, 15.7, 41.6, 22.1], 3.0),
        ([20.4, 4.0, 24.0, 18.0, 27.3, 33.0], 1.0),
        ([8.0, 30.0, 22.0, 2.0, 38.0, 30.0], 2.0),
        ([7.5, 25.0, 30.0, 10.0, 36.0, 32.0], 3.0),
    ];
    const CAP_W: i32 = 48;
    const CAP_H: i32 = 40;

    /// The share of each pixel of the `CAP_W`×`CAP_H` canvas inside the
    /// stroke of the quadratic `curve` with half-width `half_width` and
    /// `cap`, sampled at 16 × 16 points per pixel: the union of the
    /// rectangles across the 64 chords of the curve at equal steps of its
    /// parameter, with discs at the joins between them, cut by the lines
    /// across the curve's two ends, and the cap at each end along the
    /// curve's tangent there, a disc for a round cap and a rectangle half
    /// the width long for a square one. Round strokes keep the entire
    /// union; butt and square bodies are clipped by the end half-planes.
    fn supersampled_stroke(curve: [f64; 6], half_width: f64, cap: LineCap) -> Vec<f64> {
        const CHORDS: usize = 64;
        const SAMPLES: usize = 16;
        let [x1, y1, cx, cy, x2, y2] = curve;
        let points: Vec<(f64, f64)> = (0..=CHORDS)
            .map(|k| {
                let t = k as f64 / CHORDS as f64;
                let (s, u) = (1.0 - t, t);
                (
                    s * s * x1 + 2.0 * s * u * cx + u * u * x2,
                    s * s * y1 + 2.0 * s * u * cy + u * u * y2,
                )
            })
            .collect();
        let unit = |(x, y): (f64, f64)| {
            let length = x.hypot(y);
            (x / length, y / length)
        };
        // The outward tangents at the start and at the end, and the ends.
        let caps = [
            ((x1, y1), unit((x1 - cx, y1 - cy))),
            ((x2, y2), unit((x2 - cx, y2 - cy))),
        ];
        let hw2 = half_width * half_width;
        let inside = |px: f64, py: f64| {
            let before_ends = caps
                .iter()
                .all(|&((ex, ey), (tx, ty))| (px - ex) * tx + (py - ey) * ty <= 0.0);
            let body = (cap == LineCap::Round || before_ends)
                && (points.windows(2).any(|chord| {
                    let ((ax, ay), (bx, by)) = (chord[0], chord[1]);
                    let (dx, dy) = (bx - ax, by - ay);
                    let length2 = dx * dx + dy * dy;
                    let along = (px - ax) * dx + (py - ay) * dy;
                    let across = (px - ax) * dy - (py - ay) * dx;
                    (0.0..=length2).contains(&along) && across * across <= hw2 * length2
                }) || points[1..CHORDS]
                    .iter()
                    .any(|&(vx, vy)| (px - vx) * (px - vx) + (py - vy) * (py - vy) <= hw2));
            body || caps.iter().any(|&((ex, ey), (tx, ty))| {
                let (dx, dy) = (px - ex, py - ey);
                match cap {
                    LineCap::Butt => false,
                    LineCap::Round => dx * dx + dy * dy <= hw2,
                    LineCap::Square => {
                        let along = dx * tx + dy * ty;
                        let across = dx * ty - dy * tx;
                        (0.0..=half_width).contains(&along) && across.abs() <= half_width
                    }
                }
            })
        };
        let (x_lo, x_hi, y_lo, y_hi) = points.iter().fold(
            (
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
            ),
            |(a, b, c, d), &(x, y)| (a.min(x), b.max(x), c.min(y), d.max(y)),
        );
        let margin = 2.0 * half_width + 2.0;
        (0..CAP_H)
            .flat_map(|y| (0..CAP_W).map(move |x| (x, y)))
            .map(|(x, y)| {
                let (x, y) = (f64::from(x), f64::from(y));
                if x + 1.0 < x_lo - margin
                    || x > x_hi + margin
                    || y + 1.0 < y_lo - margin
                    || y > y_hi + margin
                {
                    return 0.0;
                }
                let hits = (0..SAMPLES * SAMPLES)
                    .filter(|&s| {
                        let sx = x + ((s % SAMPLES) as f64 + 0.5) / SAMPLES as f64;
                        let sy = y + ((s / SAMPLES) as f64 + 0.5) / SAMPLES as f64;
                        inside(sx, sy)
                    })
                    .count();
                hits as f64 / (SAMPLES * SAMPLES) as f64
            })
            .collect()
    }

    /// The engine's coverage of each pixel of the `CAP_W`×`CAP_H` canvas
    /// by the stroke of `curve`.
    fn engine_stroke(curve: [f64; 6], half_width: f64, cap: LineCap) -> Vec<f64> {
        let mut worker = WorkerCtx::new(CAP_W, CAP_H, ChaCha8Rng::seed_from_u64(8));
        let [x1, y1, cx, cy, x2, y2] = curve;
        let mut coverage = vec![0.0; (CAP_W * CAP_H) as usize];
        for line in stroke_quadratic_direct(&mut worker, x1, y1, cx, cy, x2, y2, half_width, cap) {
            for x in line.x1..=line.x2 {
                let cell = &mut coverage[(line.y * CAP_W + x) as usize];
                assert_eq!(*cell, 0.0, "pixel ({x}, {}) emitted twice", line.y);
                *cell = line.coverage();
            }
        }
        coverage
    }

    /// The largest difference of one pixel's coverage between the engine
    /// and [`supersampled_stroke`] over [`CAP_CURVES`], among the pixels
    /// whose centre is within `half_width + 2` of an end of the curve, and
    /// the sum of the differences over every pixel as a share of the
    /// reference's.
    fn cap_errors(cap: LineCap) -> (f64, f64) {
        let (mut worst, mut difference, mut total) = (0.0_f64, 0.0, 0.0);
        for (curve, half_width) in CAP_CURVES {
            let engine = engine_stroke(curve, half_width, cap);
            let reference = supersampled_stroke(curve, half_width, cap);
            let near_an_end = |index: usize| {
                let x = f64::from(index as i32 % CAP_W) + 0.5;
                let y = f64::from(index as i32 / CAP_W) + 0.5;
                [(curve[0], curve[1]), (curve[4], curve[5])]
                    .iter()
                    .any(|&(ex, ey)| (x - ex).hypot(y - ey) <= half_width + 2.0)
            };
            for (index, (a, b)) in engine.iter().zip(&reference).enumerate() {
                if near_an_end(index) {
                    worst = worst.max((a - b).abs());
                }
                difference += (a - b).abs();
                total += b;
            }
        }
        (worst, difference / total)
    }

    /// Shallow same-axis joins own disjoint major spans. Round endpoint
    /// caps are outside the interior interval inspected here.
    #[test]
    fn quadratic_shallow_joins_evaluate_each_interior_pixel_once() {
        for steep in [false, true] {
            let mut worker = WorkerCtx::new(128, 128, ChaCha8Rng::seed_from_u64(5));
            let (x1, y1, cx, cy, x2, y2) = if steep {
                (40.0, 4.0, 44.0, 64.0, 40.0, 124.0)
            } else {
                (4.0, 40.0, 64.0, 44.0, 124.0, 40.0)
            };
            stroke_quadratic_direct(&mut worker, x1, y1, cx, cy, x2, y2, 1.5, LineCap::Round);
            assert!(worker.stroke.points.len() > 2);
            let mut visits = std::collections::HashMap::new();
            for &(x, y) in &worker.stroke.visits {
                let major = if steep { y } else { x };
                if (30..95).contains(&major) {
                    *visits.entry((x, y)).or_insert(0) += 1;
                }
            }
            assert!(!visits.is_empty());
            for (pixel, count) in visits {
                assert_eq!(count, 1, "steep {steep}, pixel {pixel:?}");
            }
        }
    }

    /// Every pixel on valid random curves at widths spanning 2–6 px,
    /// including the reported same-axis turn. The exact inner band is
    /// retained; the total bound is tighter than the export comparison.
    #[test]
    fn quadratic_same_axis_joins_match_supersampled_strokes() {
        let mut rng = ChaCha8Rng::seed_from_u64(300);
        let mut curves = vec![[13.83, 35.75, 17.33, 31.03, 28.72, 42.81]];
        while curves.len() < 21 {
            let curve = std::array::from_fn(|_| rng.random_range(6.0..34.0));
            let [x1, y1, x2, y2, x3, y3] = curve;
            if (crate::shapes::Quadratic {
                x1,
                y1,
                x2,
                y2,
                x3,
                y3,
                width: 2.0,
                cap: LineCap::Round,
            })
            .is_valid()
            {
                curves.push(curve);
            }
        }
        let (mut worst, mut difference, mut total) = (0.0_f64, 0.0, 0.0);
        let mut worst_pixel = String::new();
        for curve in curves {
            for half_width in [1.0, 1.5, 2.0, 2.5, 2.777, 3.0] {
                let engine = engine_stroke(curve, half_width, LineCap::Round);
                let reference = supersampled_stroke(curve, half_width, LineCap::Round);
                for (index, (a, b)) in engine.iter().zip(&reference).enumerate() {
                    let error = (a - b).abs();
                    if error > worst {
                        worst = error;
                        worst_pixel = format!(
                            "{curve:?}, half width {half_width}, pixel ({}, {}): {a:.4} against {b:.4}",
                            index as i32 % CAP_W,
                            index as i32 / CAP_W
                        );
                    }
                    difference += error;
                    total += b;
                }
            }
        }
        eprintln!(
            "join oracle: worst {worst:.6}, aggregate {:.6}",
            difference / total
        );
        assert!(worst <= 0.2, "{worst_pixel}; error {worst:.6}");
        assert!(
            difference / total < 0.025,
            "worst {worst:.4}, aggregate {:.5}",
            difference / total
        );
    }

    #[test]
    fn quadratic_short_end_segments_respect_butt_and_square_caps() {
        for (curve, half_width, cap, pixel) in [
            (
                [26.58, 14.07, 26.83, 15.6, 30.58, 15.29],
                2.429,
                LineCap::Butt,
                (26, 13),
            ),
            (
                [12.44, 29.48, 13.95, 27.97, 12.81, 26.96],
                2.8,
                LineCap::Square,
                (9, 27),
            ),
            (
                [20.0, 20.0, 20.25, 20.4, 20.5, 20.0],
                3.0,
                LineCap::Square,
                (21, 16),
            ),
        ] {
            let engine = engine_stroke(curve, half_width, cap);
            let reference = supersampled_stroke(curve, half_width, cap);
            let index = (pixel.1 * CAP_W + pixel.0) as usize;
            assert!(
                (engine[index] - reference[index]).abs() < 0.15,
                "{cap:?} pixel {pixel:?}: {} against {}",
                engine[index],
                reference[index]
            );
            let difference: f64 = engine
                .iter()
                .zip(&reference)
                .map(|(a, b)| (a - b).abs())
                .sum();
            let total: f64 = reference.iter().sum();
            assert!(
                difference / total < 0.05,
                "{cap:?}: aggregate {}",
                difference / total
            );
        }
    }

    /// Retain the original worst-pixel and aggregate cap bounds after
    /// fixing joins and clipping by the curve's true endpoint tangents.
    #[test]
    fn stroke_quadratic_direct_covers_round_and_square_caps() {
        for (cap, worst_bound, total_bound) in [
            (LineCap::Butt, 0.19, 0.0185),
            (LineCap::Round, 0.125, 0.0165),
            (LineCap::Square, 0.145, 0.0175),
        ] {
            let (worst, total) = cap_errors(cap);
            assert!(
                worst <= worst_bound && total <= total_bound,
                "{cap:?}: worst pixel {worst:.4}, total {total:.5}"
            );
        }
    }

    /// The share of the unit pixel centred on the origin whose points `p`
    /// have `lo ≤ normal · p ≤ hi`: across 1000 strips along the normal's
    /// smaller component, each clipped exactly along the larger one.
    fn pixel_share(normal: (f64, f64), lo: f64, hi: f64) -> f64 {
        const STRIPS: usize = 1000;
        let (major, minor) = if normal.0.abs() >= normal.1.abs() {
            normal
        } else {
            (normal.1, normal.0)
        };
        (0..STRIPS)
            .map(|strip| {
                let t = (strip as f64 + 0.5) / STRIPS as f64 - 0.5;
                let (a, b) = ((lo - minor * t) / major, (hi - minor * t) / major);
                (a.max(b).min(0.5) - a.min(b).max(-0.5)).max(0.0)
            })
            .sum::<f64>()
            / STRIPS as f64
    }

    /// The trapezoid's closed forms against the areas they stand for, over
    /// directions from axis-aligned to diagonal and beyond, both signs of
    /// the offset and bands narrower and wider than a pixel.
    #[test]
    fn trapezoid_matches_integrated_pixel_areas() {
        for degrees in [0.0, 7.0, 22.5, 30.0, 45.0, 60.0, 90.0, 123.0, 200.0] {
            let angle = f64::to_radians(degrees);
            let normal = (angle.cos(), angle.sin());
            let trapezoid = Trapezoid::across(normal);
            for step in -12..=12 {
                let signed = f64::from(step) * 0.0625;
                let expected = pixel_share(normal, -signed, f64::INFINITY);
                let actual = trapezoid.inside(signed);
                assert!(
                    (actual - expected).abs() < 1e-4,
                    "{degrees}° at offset {signed}: {actual} against {expected}"
                );
            }
            for half_width in [0.25, 0.5, 0.75, 1.0, 1.5] {
                for step in 0..=40 {
                    let distance = f64::from(step) * 0.0625;
                    let expected =
                        pixel_share(normal, -distance - half_width, half_width - distance);
                    let actual = trapezoid.band(half_width, distance);
                    assert!(
                        (actual - expected).abs() < 1e-4,
                        "{degrees}°, half-width {half_width} at {distance}: \
                         {actual} against {expected}"
                    );
                }
            }
        }
    }

    #[test]
    fn fill_rotated_ellipse_direct_zero_rotation_matches_ellipse() {
        let mut expected_worker = WorkerCtx::new(64, 64, ChaCha8Rng::seed_from_u64(11));
        let expected = Shape::Ellipse(Ellipse {
            x: 32,
            y: 32,
            rx: 12,
            ry: 8,
        })
        .rasterize(&mut expected_worker)
        .to_vec();

        let mut actual = Vec::new();
        fill_rotated_ellipse_direct(
            &mut actual,
            &mut RowScratch::default(),
            32.0,
            32.0,
            12.0,
            8.0,
            0.0,
            64,
            64,
        );

        let expected_mask = render_mask(&expected, 64, 64);
        let actual_mask = render_mask(&actual, 64, 64);
        let diff = score::difference_full(&expected_mask, &actual_mask);
        let center = expected_mask.pix_offset(32, 32);

        assert_eq!(
            actual_mask.pixels()[center..center + 3],
            expected_mask.pixels()[center..center + 3]
        );
        assert!(diff < 0.08, "diff={diff}");
    }

    #[test]
    fn fill_rotated_ellipse_direct_90deg_swaps_axes() {
        let mut vertical = Vec::new();
        let mut swapped = Vec::new();

        fill_rotated_ellipse_direct(
            &mut vertical,
            &mut RowScratch::default(),
            24.0,
            24.0,
            10.0,
            6.0,
            90.0,
            48,
            48,
        );
        fill_rotated_ellipse_direct(
            &mut swapped,
            &mut RowScratch::default(),
            24.0,
            24.0,
            6.0,
            10.0,
            0.0,
            48,
            48,
        );

        let vertical_mask = render_mask(&vertical, 48, 48);
        let swapped_mask = render_mask(&swapped, 48, 48);

        assert_eq!(vertical_mask.pixels(), swapped_mask.pixels());
    }

    /// The alpha of the span covering `(x, y)`, if any.
    fn alpha_at(lines: &[Scanline], x: i32, y: i32) -> Option<u32> {
        lines
            .iter()
            .find(|line| line.y == y && line.x1 <= x && x <= line.x2)
            .map(|line| line.alpha)
    }

    #[test]
    fn fill_polygon_direct_gives_fully_covered_pixels_full_alpha() {
        let mut lines = Vec::new();
        let square = [(2.0, 2.0), (12.0, 2.0), (12.0, 12.0), (2.0, 12.0)];
        fill_polygon_direct(
            &mut lines,
            &mut RowScratch::default(),
            &square,
            16,
            16,
            true,
        );

        assert_eq!(alpha_at(&lines, 7, 7), Some(0xFFFF));
        assert_eq!(alpha_at(&lines, 2, 2), Some(0xFFFF));
        assert_eq!(alpha_at(&lines, 11, 11), Some(0xFFFF));
        assert_eq!(alpha_at(&lines, 12, 7), None);
    }

    #[test]
    fn fill_polygon_direct_gives_partial_pixels_proportional_alpha() {
        let mut lines = Vec::new();
        // Columns 2 and 11 are half covered; rows are fully covered.
        let rect = [(2.5, 2.0), (11.5, 2.0), (11.5, 12.0), (2.5, 12.0)];
        fill_polygon_direct(&mut lines, &mut RowScratch::default(), &rect, 16, 16, true);

        assert_eq!(alpha_at(&lines, 2, 7), Some(0xFFFF / 2));
        assert_eq!(alpha_at(&lines, 7, 7), Some(0xFFFF));
        assert_eq!(alpha_at(&lines, 11, 7), Some(0xFFFF / 2));
    }

    #[test]
    fn fill_rotated_ellipse_direct_gives_fully_covered_pixels_full_alpha() {
        let mut lines = Vec::new();
        fill_rotated_ellipse_direct(
            &mut lines,
            &mut RowScratch::default(),
            16.0,
            16.0,
            10.0,
            6.0,
            40.0,
            32,
            32,
        );

        assert_eq!(alpha_at(&lines, 16, 16), Some(0xFFFF));
    }

    /// The anti-aliased fill of a `w`×`h` canvas computed pixel by pixel:
    /// every pixel sums the overlap of each sub-row span returned by
    /// `sub_row_spans(y_sub)`, and each row is emitted as maximal runs of
    /// equal non-zero alpha. The reference the fast rasterizers must match.
    fn reference_fill(
        w: i32,
        h: i32,
        sub_row_spans: impl Fn(f64) -> Vec<(f64, f64)>,
    ) -> Vec<Scanline> {
        const NUM_AA: usize = 4;
        let mut lines = Vec::new();
        for y in 0..h {
            let spans: Vec<_> = (0..NUM_AA)
                .flat_map(|s| sub_row_spans(f64::from(y) + (s as f64 + 0.5) / NUM_AA as f64))
                .collect();
            let alphas: Vec<u32> = (0..w)
                .map(|x| {
                    let (left, right) = (f64::from(x), f64::from(x) + 1.0);
                    let covered = spans
                        .iter()
                        .map(|&(l, r)| {
                            let (lo, hi) = (l.max(left), r.min(right));
                            if hi > lo {
                                sub_row_coverage(hi - lo)
                            } else {
                                0
                            }
                        })
                        .sum();
                    coverage_to_alpha(covered, NUM_AA)
                })
                .collect();
            let mut x = 0;
            while x < w {
                let alpha = alphas[x as usize];
                let mut end = x;
                while end + 1 < w && alphas[(end + 1) as usize] == alpha {
                    end += 1;
                }
                if alpha > 0 {
                    lines.push(Scanline {
                        y,
                        x1: x,
                        x2: end,
                        alpha,
                    });
                }
                x = end + 1;
            }
        }
        lines
    }

    /// The even-odd spans of the horizontal line at `y_sub` inside the
    /// polygon `vertices`, intersected as [`fill_polygon_direct`] does.
    fn polygon_sub_row_spans(vertices: &[(f64, f64)], y_sub: f64) -> Vec<(f64, f64)> {
        let n = vertices.len();
        let mut hits: Vec<f64> = (0..n)
            .filter_map(|i| {
                let (x0, y0) = vertices[i];
                let (x1, y1) = vertices[(i + 1) % n];
                let (y_lo, y_hi) = if y0 < y1 { (y0, y1) } else { (y1, y0) };
                (y_sub >= y_lo && y_sub < y_hi).then(|| x0 + (y_sub - y0) / (y1 - y0) * (x1 - x0))
            })
            .collect();
        hits.sort_unstable_by(f64::total_cmp);
        hits.as_chunks::<2>()
            .0
            .iter()
            .map(|&[left, right]| (left, right))
            .collect()
    }

    /// The span of the horizontal line at `y_sub` inside a rotated ellipse,
    /// its angle in degrees, solved as [`fill_rotated_ellipse_direct`] does,
    /// with the portable sine and cosine.
    fn ellipse_sub_row_spans(
        (cx, cy, rx, ry, degrees): (f64, f64, f64, f64, f64),
        y_sub: f64,
    ) -> Vec<(f64, f64)> {
        let (sin_t, cos_t) = crate::util::sin_cos_degrees(degrees);
        let inv_rx2 = 1.0 / (rx * rx);
        let inv_ry2 = 1.0 / (ry * ry);
        let a = cos_t * cos_t * inv_rx2 + sin_t * sin_t * inv_ry2;
        let b = 2.0 * cos_t * sin_t * (inv_rx2 - inv_ry2) * (y_sub - cy);
        let c =
            (sin_t * sin_t * inv_rx2 + cos_t * cos_t * inv_ry2) * (y_sub - cy) * (y_sub - cy) - 1.0;
        let discriminant = b * b - 4.0 * a * c;
        if discriminant < 0.0 {
            return Vec::new();
        }
        let root = discriminant.sqrt();
        let x1 = cx + (-b - root) / (2.0 * a);
        let x2 = cx + (-b + root) / (2.0 * a);
        vec![(x1.min(x2), x1.max(x2))]
    }

    /// A coordinate in `lo..hi`, snapped to a whole or half pixel a third of
    /// the time so that span ends land exactly on pixel boundaries.
    fn coordinate(rng: &mut ChaCha8Rng, lo: f64, hi: f64) -> f64 {
        let value = rng.random_range(lo..hi);
        if rng.random_range(0..3) == 0 {
            (value * 2.0).round() / 2.0
        } else {
            value
        }
    }

    #[test]
    fn fill_polygon_direct_matches_per_pixel_coverage() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x5EED_0005);
        let mut scratch = RowScratch::default();
        let mut lines = Vec::new();
        let (w, h) = (40, 32);
        for case in 0..400 {
            let order = rng.random_range(3..=4);
            let vertices: Vec<_> = (0..order)
                .map(|_| {
                    (
                        coordinate(&mut rng, -8.0, 48.0),
                        coordinate(&mut rng, -8.0, 40.0),
                    )
                })
                .collect();
            let expected = reference_fill(w, h, |y| polygon_sub_row_spans(&vertices, y));
            for convex in [false, is_legible_convex(&vertices, 0.0)] {
                fill_polygon_direct(&mut lines, &mut scratch, &vertices, w, h, convex);
                assert_eq!(
                    lines, expected,
                    "case {case}, convex {convex}: {vertices:?}"
                );
            }
        }
    }

    #[test]
    fn fill_rotated_ellipse_direct_matches_per_pixel_coverage() {
        let mut rng = ChaCha8Rng::seed_from_u64(0x5EED_0006);
        let mut scratch = RowScratch::default();
        let mut lines = Vec::new();
        let (w, h) = (40, 32);
        for case in 0..400 {
            let ellipse = (
                coordinate(&mut rng, -8.0, 48.0),
                coordinate(&mut rng, -8.0, 40.0),
                coordinate(&mut rng, 0.5, 30.0),
                coordinate(&mut rng, 0.5, 30.0),
                match rng.random_range(0..4) {
                    0 => 0.0,
                    1 => f64::from(rng.random_range(0..4)) * 90.0,
                    _ => rng.random_range(0.0..360.0),
                },
            );
            let (cx, cy, rx, ry, degrees) = ellipse;
            fill_rotated_ellipse_direct(&mut lines, &mut scratch, cx, cy, rx, ry, degrees, w, h);
            let expected = reference_fill(w, h, |y| ellipse_sub_row_spans(ellipse, y));
            assert_eq!(lines, expected, "case {case}: {ellipse:?}");
        }
    }

    #[test]
    fn fill_rotated_ellipse_direct_bounds_checking() {
        let mut lines = Vec::new();
        fill_rotated_ellipse_direct(
            &mut lines,
            &mut RowScratch::default(),
            -4.0,
            3.0,
            9.0,
            5.0,
            23.0,
            16,
            12,
        );

        assert!(!lines.is_empty());
        assert!(lines.iter().all(|line| line.y >= 0 && line.y < 12));
        assert!(lines.iter().all(|line| line.x1 >= 0 && line.x1 <= line.x2));
        assert!(lines.iter().all(|line| line.x2 < 16));
        assert!(lines.iter().all(|line| line.alpha <= 0xFFFF));
    }
}
