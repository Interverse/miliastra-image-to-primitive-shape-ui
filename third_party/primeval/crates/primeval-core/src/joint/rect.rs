//! The rule of rectangles, axis-aligned or rotated, in the joint
//! optimisation: every side at least 1 px, and the long side at most
//! [`MAX_ASPECT`] times the short one, as the greedy search's rectangles.
//! The arithmetic rule of [`super`] applies to everything here.
//!
//! An axis-aligned rectangle has the parameters `x0, y0, x1, y1`, of sides
//! `w = x1 − x0` and `h = y1 − y0`; a rotated one `cx, cy, ux, uy, h`, of
//! sides `2 |u|` and `2 h` (`diff::Outline`). Both rules are the same
//! condition on a pair of lengths `(a, b)` and a least length `m`
//! (`m = 1` for the sides, `m = 1/2` for the half-sides):
//! `a ≥ m`, `b ≥ m`, `a ≤ 8 b` and `b ≤ 8 a`, a convex set of the plane.
//!
//! - [`project_box`] and [`project_rotated`] move the parameters to the
//!   nearest ones that keep the rule, Euclidean in the parameters: the
//!   pair moves to its projection on the set ([`project_sides`]), the
//!   centre stays and, for a rotated rectangle, so does the direction of
//!   `u`.
//! - [`snap_box`] and [`snap_rotated`] round the parameters to a lattice
//!   and, if the rounded rectangle breaks the rule, repair it on the
//!   lattice. The checks on the lattice are exact: lattice values are
//!   small multiples of a power of two, so their sums, products and
//!   squares are exact in `f64`.
//!
//! A rotated rectangle's `u` and a rotated ellipse's semi-axis vector come
//! from the greedy search's angles through
//! [`crate::util::sin_cos_degrees`], the function the greedy search's own
//! corners and coverage use; a rotated ellipse's angle comes back from its
//! semi-axis vector through [`crate::util::atan2_degrees`].

use super::angle::Projected;
use super::diff::COORDS;
use super::lattice::{lengthen_on_lattice, round_to};
use crate::shapes::MAX_ASPECT;

/// Whether the lengths `(a, b)` keep the rule with least length `least`.
fn sides_valid(a: f64, b: f64, least: f64) -> bool {
    let aspect = f64::from(MAX_ASPECT);
    a >= least && b >= least && a <= aspect * b && b <= aspect * a
}

/// The point of the set `a ≥ m`, `b ≥ m`, `a ≤ 8 b`, `b ≤ 8 a` nearest to
/// `(a, b)`, with `m` = `least`.
///
/// The set is convex, and its boundary is the segment from `(m, m)` to
/// `(m, 8m)`, the one from `(m, m)` to `(8m, m)`, and the rays from
/// `(m, 8m)` along `(1, 8)` and from `(8m, m)` along `(8, 1)`. A point
/// outside projects onto the nearest of its projections on those four
/// pieces. On a ray, the point is written as `(t, 8t)` or `(8t, t)`, so it
/// keeps the cap exactly: scaling by 8 is exact.
pub(super) fn project_sides(a: f64, b: f64, least: f64) -> (f64, f64) {
    if sides_valid(a, b, least) {
        return (a, b);
    }
    let m = least;
    let aspect = f64::from(MAX_ASPECT);
    let high = aspect * m;
    let along = |dot: f64| (dot / (1.0 + aspect * aspect)).max(0.0);
    let steep = m + along((a - m) + aspect * (b - high));
    let flat = m + along(aspect * (a - high) + (b - m));
    let candidates = [
        (m, b.clamp(m, high)),
        (a.clamp(m, high), m),
        (steep, aspect * steep),
        (aspect * flat, flat),
    ];
    let distance = |(x, y): (f64, f64)| (x - a) * (x - a) + (y - b) * (y - b);
    let mut best = candidates[0];
    for candidate in &candidates[1..] {
        if distance(*candidate) < distance(best) {
            best = *candidate;
        }
    }
    best
}

/// Whether the axis-aligned rectangle `p` (`x0, y0, x1, y1`) keeps the
/// rule.
pub(super) fn box_valid(p: &[f64; COORDS]) -> bool {
    sides_valid(p[2] - p[0], p[3] - p[1], 1.0)
}

/// `|u|²` and `h` of the rotated rectangle `p`.
fn half_sides(p: &[f64; COORDS]) -> (f64, f64) {
    (p[2] * p[2] + p[3] * p[3], p[4])
}

/// Whether the rotated rectangle `p` (`cx, cy, ux, uy, h`) keeps the rule:
/// `|u| ≥ 1/2`, `h ≥ 1/2` and `max(|u|, h) ≤ 8 · min(|u|, h)`, checked on
/// squares, without a root.
pub(super) fn rotated_valid(p: &[f64; COORDS]) -> bool {
    let (u2, h) = half_sides(p);
    let cap = f64::from(MAX_ASPECT * MAX_ASPECT);
    u2 >= 0.25 && h >= 0.5 && h * h <= cap * u2 && u2 <= cap * h * h
}

/// Projects the axis-aligned rectangle `p` onto the rule: its sides move
/// to their projection ([`project_sides`]) about its centre, the nearest
/// rectangle in `x0, y0, x1, y1`, since a change of `δ` in a side and
/// none in the centre moves each of its two coordinates by `δ / 2`.
pub(super) fn project_box(p: &mut [f64; COORDS]) -> Projected {
    let (w, h) = (p[2] - p[0], p[3] - p[1]);
    let (pw, ph) = project_sides(w, h, 1.0);
    if (pw, ph) == (w, h) {
        return Projected::Unchanged;
    }
    let (mx, my) = ((p[0] + p[2]) / 2.0, (p[1] + p[3]) / 2.0);
    p[0] = mx - pw / 2.0;
    p[2] = mx + pw / 2.0;
    p[1] = my - ph / 2.0;
    p[3] = my + ph / 2.0;
    Projected::Moved
}

/// Projects the rotated rectangle `p` onto the rule: `(|u|, h)` moves to
/// its projection ([`project_sides`]) and `u` keeps its direction, which
/// is the nearest point in `ux, uy, h`, since for any `u'`,
/// `|u − u'| ≥ ||u| − |u'||` with equality along `u`. A zero `u` takes the
/// direction of the `x` axis.
pub(super) fn project_rotated(p: &mut [f64; COORDS]) -> Projected {
    let r = (p[2] * p[2] + p[3] * p[3]).sqrt();
    let (pr, ph) = project_sides(r, p[4], 0.5);
    if (pr, ph) == (r, p[4]) {
        return Projected::Unchanged;
    }
    if r > 0.0 {
        let scale = pr / r;
        p[2] *= scale;
        p[3] *= scale;
    } else {
        p[2] = pr;
        p[3] = 0.0;
    }
    p[4] = ph;
    Projected::Moved
}

/// The axis-aligned rectangle `p` with every parameter rounded to the
/// lattice of `quantum` (`1/4`, `1/2` or `1`), and whether it needed a
/// repair to keep the rule.
///
/// If the rounded rectangle breaks the rule, its corner `(x0, y0)` stays
/// rounded and its sides `(a, b)`, projected onto the rule
/// ([`project_sides`]), are rounded on the lattice towards the inside: the
/// shorter one up and the longer one down. Both stay at least 1, a lattice
/// point; the longer one, rounded down, stays within 8 times the shorter,
/// rounded up; and the shorter one, at most the longer plus a quantum,
/// stays within 8 times the longer, which is at least 1.
pub(super) fn snap_box(p: &[f64; COORDS], quantum: f64) -> ([f64; COORDS], bool) {
    let mut out = [0.0; COORDS];
    for k in 0..4 {
        out[k] = round_to(p[k], quantum);
    }
    if box_valid(&out) {
        return (out, false);
    }
    let (a, b) = project_sides(p[2] - p[0], p[3] - p[1], 1.0);
    let up = |value: f64| (value / quantum).ceil() * quantum;
    let down = |value: f64| (value / quantum).floor() * quantum;
    let (w, h) = if a <= b {
        (up(a), down(b))
    } else {
        (down(a), up(b))
    };
    out[2] = out[0] + w;
    out[3] = out[1] + h;
    debug_assert!(box_valid(&out), "{p:?} -> {out:?}");
    (out, true)
}

/// The rotated rectangle `p` with every parameter rounded to the lattice of
/// `quantum` (`1/4`, `1/2` or `1`), and whether it needed a repair to keep
/// the rule. Its corners, computed from the rounded parameters, form an
/// exact rectangle up to the rounding of that computation.
///
/// If the rounded rectangle breaks the rule, `u` is rounded away from zero
/// instead, which cannot shorten it below the projection's `|u| ≥ 1/2`,
/// and lengthened on the lattice if it still is shorter (a zero `u`
/// becomes `(1/2, 0)`). Then `h` moves on the lattice into
/// `[max(1/2, |u| / 8), 8 |u|]`, which is longer than a quantum since
/// `|u| ≥ 1/2`.
pub(super) fn snap_rotated(p: &[f64; COORDS], quantum: f64) -> ([f64; COORDS], bool) {
    let mut out = [0.0; COORDS];
    for k in 0..5 {
        out[k] = round_to(p[k], quantum);
    }
    if rotated_valid(&out) {
        return (out, false);
    }
    lengthen_on_lattice(&mut out, p, quantum, 0.25);
    let cap = f64::from(MAX_ASPECT * MAX_ASPECT);
    let u2 = half_sides(&out).0;
    while out[4] < 0.5 || u2 > cap * out[4] * out[4] {
        out[4] += quantum;
    }
    while out[4] * out[4] > cap * u2 {
        out[4] -= quantum;
    }
    debug_assert!(rotated_valid(&out), "{p:?} -> {out:?}");
    (out, true)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The corners of `p`, a rotated rectangle, as the forward model
    /// computes them.
    fn rotated_corners(p: &[f64; COORDS]) -> [f64; COORDS] {
        super::super::diff::Layer {
            outline: super::super::diff::Outline::Rotated,
            params: *p,
            alpha: 255.0,
            color: [0.0; 3],
        }
        .corners()
    }

    /// An independent check of a rotated rectangle's corners `v`: every
    /// angle within `tolerance` of 90° by `acos`, opposite sides equal, and
    /// the sides at least 1 px and at most 8 times each other, up to a
    /// relative `tolerance`.
    pub(in crate::joint) fn acos_rectangle(v: &[f64; COORDS], tolerance: f64) -> bool {
        let side = |p: usize, q: usize| (v[2 * q] - v[2 * p]).hypot(v[2 * q + 1] - v[2 * p + 1]);
        let lengths = [side(0, 1), side(1, 2), side(2, 3), side(3, 0)];
        let right = (0..4).all(|p| {
            let (a, b, c) = ((p + 3) % 4, p, (p + 1) % 4);
            let (ux, uy) = (v[2 * c] - v[2 * b], v[2 * c + 1] - v[2 * b + 1]);
            let (wx, wy) = (v[2 * a] - v[2 * b], v[2 * a + 1] - v[2 * b + 1]);
            let cos = (ux * wx + uy * wy) / (ux.hypot(uy) * wx.hypot(wy));
            (cos.clamp(-1.0, 1.0).acos().to_degrees() - 90.0).abs() <= tolerance
        });
        let (long, short) = (lengths[0].max(lengths[1]), lengths[0].min(lengths[1]));
        right
            && (lengths[0] - lengths[2]).abs() <= tolerance * long
            && (lengths[1] - lengths[3]).abs() <= tolerance * long
            && short >= 1.0 - tolerance
            && long <= 8.0 * short * (1.0 + tolerance)
    }

    /// The projection lands on the set, leaves points inside alone, and
    /// no point of the set on a fine grid around it is nearer.
    #[test]
    fn side_projection_is_the_nearest_point_of_the_set() {
        let mut rng = ChaCha8Rng::seed_from_u64(41);
        for least in [0.5, 1.0] {
            for _ in 0..2000 {
                let (a, b) = (rng.random_range(-4.0..30.0), rng.random_range(-4.0..30.0));
                let (pa, pb) = project_sides(a, b, least);
                assert!(sides_valid(pa, pb, least), "({a}, {b}) -> ({pa}, {pb})");
                if sides_valid(a, b, least) {
                    assert_eq!((pa, pb), (a, b));
                    continue;
                }
                let distance = (pa - a).hypot(pb - b);
                for _ in 0..200 {
                    let (qa, qb) = (
                        pa + rng.random_range(-1.0..1.0),
                        pb + rng.random_range(-1.0..1.0),
                    );
                    if sides_valid(qa, qb, least) {
                        assert!(
                            (qa - a).hypot(qb - b) >= distance - 1e-12,
                            "({a}, {b}): ({qa}, {qb}) nearer than ({pa}, {pb})"
                        );
                    }
                }
            }
        }
    }

    fn random_box(rng: &mut ChaCha8Rng) -> [f64; COORDS] {
        let (x, y) = (rng.random_range(-10.0..50.0), rng.random_range(-10.0..50.0));
        let mut p = [0.0; COORDS];
        p[..4].copy_from_slice(&[
            x,
            y,
            x + rng.random_range(-3.0..40.0),
            y + rng.random_range(-3.0..40.0),
        ]);
        p
    }

    fn random_rotated(rng: &mut ChaCha8Rng) -> [f64; COORDS] {
        let mut p = [0.0; COORDS];
        p[..5].copy_from_slice(&[
            rng.random_range(-10.0..50.0),
            rng.random_range(-10.0..50.0),
            rng.random_range(-20.0..20.0) * rng.random_range(0.0..1.0_f64).powi(3),
            rng.random_range(-20.0..20.0) * rng.random_range(0.0..1.0_f64).powi(3),
            rng.random_range(-1.0..20.0),
        ]);
        p
    }

    /// Projected rectangles keep the rule, keep their centre, and a
    /// rotated one its direction; valid ones do not move.
    #[test]
    fn projections_keep_the_rule_the_centre_and_the_direction() {
        let mut rng = ChaCha8Rng::seed_from_u64(42);
        let (mut moved_boxes, mut moved_rotated) = (0, 0);
        for _ in 0..3000 {
            let start = random_box(&mut rng);
            let mut p = start;
            match project_box(&mut p) {
                Projected::Unchanged => {
                    assert!(box_valid(&start));
                    assert_eq!(p, start);
                }
                _ => {
                    moved_boxes += 1;
                    let (w, h) = (p[2] - p[0], p[3] - p[1]);
                    assert!(sides_valid(w + 1e-12, h + 1e-12, 1.0), "{p:?}");
                    assert!(w <= 8.0 * h + 1e-12 && h <= 8.0 * w + 1e-12, "{p:?}");
                    assert!((p[0] + p[2] - start[0] - start[2]).abs() < 1e-12);
                    assert!((p[1] + p[3] - start[1] - start[3]).abs() < 1e-12);
                }
            }

            let start = random_rotated(&mut rng);
            let mut p = start;
            match project_rotated(&mut p) {
                Projected::Unchanged => assert!(rotated_valid(&start)),
                _ => {
                    moved_rotated += 1;
                    let r = p[2].hypot(p[3]);
                    let h = p[4];
                    assert!(r >= 0.5 - 1e-12 && h >= 0.5 - 1e-12, "{p:?}");
                    assert!(r <= 8.0 * h * (1.0 + 1e-12) && h <= 8.0 * r * (1.0 + 1e-12));
                    assert_eq!((p[0], p[1]), (start[0], start[1]));
                    if start[2] != 0.0 || start[3] != 0.0 {
                        let cross = p[2] * start[3] - p[3] * start[2];
                        let dot = p[2] * start[2] + p[3] * start[3];
                        assert!(cross.abs() <= 1e-9 * dot && dot > 0.0, "{start:?} -> {p:?}");
                    }
                }
            }
        }
        assert!(
            moved_boxes > 300 && moved_rotated > 300,
            "{moved_boxes} {moved_rotated}"
        );
    }

    /// Snapped rectangles sit on the lattice and keep the rule, by the
    /// exact check and by independent ones: an axis-aligned rectangle's
    /// sides, a rotated rectangle's `acos` angles and side lengths from its
    /// corners. Rectangles on the rule's boundary need repairs.
    #[test]
    fn snapped_rectangles_keep_the_rule() {
        let mut rng = ChaCha8Rng::seed_from_u64(43);
        let (mut box_repairs, mut rotated_repairs) = (0, 0);
        for quantum in [0.25, 0.5, 1.0] {
            for _ in 0..3000 {
                let mut p = random_box(&mut rng);
                project_box(&mut p);
                let (s, repaired) = snap_box(&p, quantum);
                box_repairs += usize::from(repaired);
                assert!(box_valid(&s), "{p:?} -> {s:?}");
                let (w, h) = (s[2] - s[0], s[3] - s[1]);
                assert!(
                    w >= 1.0 && h >= 1.0 && w <= 8.0 * h && h <= 8.0 * w,
                    "{s:?}"
                );
                for k in 0..4 {
                    assert_eq!((s[k] / quantum).fract(), 0.0, "{s:?}");
                    assert!(
                        (s[k] - p[k]).abs() <= 1.5 * quantum + 1e-9,
                        "{p:?} -> {s:?}"
                    );
                }

                let mut p = random_rotated(&mut rng);
                project_rotated(&mut p);
                let (s, repaired) = snap_rotated(&p, quantum);
                rotated_repairs += usize::from(repaired);
                assert!(rotated_valid(&s), "{p:?} -> {s:?}");
                for k in 0..5 {
                    assert_eq!((s[k] / quantum).fract(), 0.0, "{s:?}");
                }
                assert!(acos_rectangle(&rotated_corners(&s), 1e-9), "{s:?}");
            }
        }
        assert!(
            box_repairs > 50 && rotated_repairs > 50,
            "{box_repairs} {rotated_repairs}"
        );
    }

    /// The corners of a snapped rotated rectangle meet at right angles up
    /// to the rounding of their computation: the dot product of adjacent
    /// sides is within a few ulps of the products of their lengths.
    #[test]
    fn snapped_rotated_rectangles_have_right_angles() {
        let mut rng = ChaCha8Rng::seed_from_u64(44);
        for _ in 0..3000 {
            let mut p = random_rotated(&mut rng);
            project_rotated(&mut p);
            let v = rotated_corners(&snap_rotated(&p, 0.25).0);
            for corner in 0..4 {
                let (a, b, c) = ((corner + 3) % 4, corner, (corner + 1) % 4);
                let (ux, uy) = (v[2 * c] - v[2 * b], v[2 * c + 1] - v[2 * b + 1]);
                let (wx, wy) = (v[2 * a] - v[2 * b], v[2 * a + 1] - v[2 * b + 1]);
                let scale = (ux.abs() + uy.abs()) * (wx.abs() + wy.abs());
                let dot = ux * wx + uy * wy;
                assert!(dot.abs() <= 1e-13 * scale.max(1.0), "{v:?}: {dot}");
            }
        }
    }
}
