//! The engine's rule for jointly optimised polygons, the quadrilaterals of
//! the `polygon` kind: simple and strictly convex, every interior angle
//! strictly above 15°, as `Polygon::is_valid`. The arithmetic rule of
//! [`super`] applies: angles are never computed, only compared through
//! their tangents.
//!
//! At each vertex `p`, with `u` and `w` the edges to the next and the
//! previous vertex and `s = ±1` the polygon's orientation, the interior
//! angle `θ_p` is `atan2(t_p, d_p)` with the turn `t_p = s · (u × w)` and
//! `d_p = u · w`. Every constraint is a [`Bound`] on that angle, linear in
//! `(t_p, d_p)`:
//!
//! - `θ_p ≥ τ` is `t_p − tan τ · d_p ≥ 0`;
//! - `θ_p ≤ 180° − δ` is `t_p + tan δ · d_p ≥ 0`.
//!
//! The first alone admits reflex angles up to `180° + τ` (`t_p < 0` with
//! `d_p < 0`), so convexity is the second with a small margin `δ`. Both
//! together imply `t_p > 0` for edges of non-zero length: a strict turn the
//! same way at every vertex, which for four vertices makes the polygon
//! simple and convex. An upper angle bound, such as 165°, would be one more
//! [`Bound::Upper`].
//!
//! - [`project`] moves a quadrilateral into the set by a small change of
//!   its vertices: Gauss–Newton steps of minimal norm in the eight
//!   coordinates on every residual, linearised, until all are
//!   non-negative.
//! - [`snap`] rounds the vertices to a lattice and, if the rounded polygon
//!   breaks the rule, takes the valid lattice polygon of the same
//!   orientation closest to the continuous one instead.

use super::angle::{MAX_STEPS, OVERSHOOT, Projected, TAN_VALID};
use super::diff::COORDS;
use super::lattice::{bound, lattice_candidates, round_to, rounded_centroid};
use crate::shapes::{is_legible_convex, legible_corner};

/// Vertices of a quadrilateral.
const SIDES: usize = 4;

/// `tan 0.5°`: the projection keeps every interior angle at most 179.5°,
/// half a degree inside convexity, as the lower bound sits half a degree
/// above 15°.
const TAN_CONVEX: f64 = 0.008_726_867_790_758_79;

/// Sweeps of the dual coordinate ascent in [`min_norm_step`].
const SWEEPS: usize = 100;

/// Validity checks of [`snap`]'s search per radius, beyond which it keeps
/// the best polygon found so far.
const SEARCH_CAP: usize = 1 << 20;

/// A bound on every interior angle, as a residual `t_p ± tan · d_p` that
/// is non-negative inside.
#[derive(Clone, Copy, Debug)]
enum Bound {
    /// `θ ≥ atan tan`: `t − tan · d ≥ 0`.
    Lower(f64),
    /// `θ ≤ 180° − atan tan`: `t + tan · d ≥ 0`.
    Upper(f64),
}

impl Bound {
    /// The coefficient of `d` in the residual.
    fn slope(self) -> f64 {
        match self {
            Self::Lower(tan) => -tan,
            Self::Upper(tan) => tan,
        }
    }
}

/// The bounds [`project`] enforces: angles of at least `atan tan_tau`, and
/// convexity with [`TAN_CONVEX`]'s margin.
fn projection_bounds(tan_tau: f64) -> [Bound; 2] {
    [Bound::Lower(tan_tau), Bound::Upper(TAN_CONVEX)]
}

/// `1` if the shoelace area of `v` is not negative, `−1` otherwise: the
/// orientation of a simple polygon, and of the larger lobe of a crossed
/// one.
fn orientation(v: &[f64; COORDS]) -> f64 {
    if super::twice_shoelace(v, SIDES) < 0.0 {
        -1.0
    } else {
        1.0
    }
}

/// The terms of the residuals at one vertex: the turn `t`, the dot
/// product `d`, their gradients in the eight coordinates, and
/// `|u|² + |w|²`.
#[derive(Clone, Copy)]
struct Corner {
    turn: f64,
    dot: f64,
    dturn: [f64; COORDS],
    ddot: [f64; COORDS],
    scale: f64,
}

impl Corner {
    fn residual(&self, bound: Bound) -> f64 {
        self.turn + bound.slope() * self.dot
    }

    fn gradient(&self, bound: Bound) -> [f64; COORDS] {
        let slope = bound.slope();
        std::array::from_fn(|i| self.dturn[i] + slope * self.ddot[i])
    }
}

/// The corners of `v` with orientation `s`, or `None` if two consecutive
/// vertices coincide.
fn corners(v: &[f64; COORDS], s: f64) -> Option<[Corner; SIDES]> {
    let mut corners = [Corner {
        turn: 0.0,
        dot: 0.0,
        dturn: [0.0; COORDS],
        ddot: [0.0; COORDS],
        scale: 0.0,
    }; SIDES];
    for (p, corner) in corners.iter_mut().enumerate() {
        let (q, r) = ((p + 1) % SIDES, (p + SIDES - 1) % SIDES);
        let (ux, uy) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
        let (wx, wy) = (v[2 * r] - v[2 * p], v[2 * r + 1] - v[2 * p + 1]);
        if (ux == 0.0 && uy == 0.0) || (wx == 0.0 && wy == 0.0) {
            return None;
        }
        corner.turn = s * (ux * wy - uy * wx);
        corner.dot = ux * wx + uy * wy;
        // ∂(u × w)/∂q = (wy, −wx), ∂/∂r = (−uy, ux), ∂/∂p = −(∂q + ∂r).
        corner.dturn[2 * q] = s * wy;
        corner.dturn[2 * q + 1] = -s * wx;
        corner.dturn[2 * r] = -s * uy;
        corner.dturn[2 * r + 1] = s * ux;
        corner.dturn[2 * p] = s * (uy - wy);
        corner.dturn[2 * p + 1] = s * (wx - ux);
        // ∂d/∂q = w, ∂d/∂r = u, ∂d/∂p = −(u + w).
        corner.ddot[2 * q] = wx;
        corner.ddot[2 * q + 1] = wy;
        corner.ddot[2 * r] = ux;
        corner.ddot[2 * r + 1] = uy;
        corner.ddot[2 * p] = -(ux + wx);
        corner.ddot[2 * p + 1] = -(uy + wy);
        corner.scale = ux * ux + uy * uy + wx * wx + wy * wy;
    }
    Some(corners)
}

/// Whether every corner turns strictly the same way and every residual of
/// `bounds` is not negative.
fn within(corners: &[Corner; SIDES], bounds: &[Bound]) -> bool {
    corners.iter().all(|corner| {
        corner.turn > 0.0 && bounds.iter().all(|&bound| corner.residual(bound) >= 0.0)
    })
}

/// Whether the corner at `p`, between `previous` and `next`, turns
/// strictly the way `s` says with an angle above 15° ([`TAN_VALID`]):
/// greedy's [`legible_corner`] with [`is_valid`]'s bound.
fn corner_valid(previous: (f64, f64), p: (f64, f64), next: (f64, f64), s: f64) -> bool {
    legible_corner(previous, p, next, s, TAN_VALID)
}

/// Whether every corner of `v` passes [`corner_valid`] with orientation
/// `s`.
fn valid_oriented(v: &[f64; COORDS], s: f64) -> bool {
    (0..SIDES).all(|p| {
        let (q, r) = ((p + 1) % SIDES, (p + SIDES - 1) % SIDES);
        corner_valid(
            (v[2 * r], v[2 * r + 1]),
            (v[2 * p], v[2 * p + 1]),
            (v[2 * q], v[2 * q + 1]),
            s,
        )
    })
}

/// Whether `v` is simple and strictly convex with every interior angle
/// above 15° (see [`TAN_VALID`]): greedy's [`is_legible_convex`], with the
/// orientation taken from the first vertex, and a bound a millionth of a
/// degree stricter.
pub(super) fn is_valid(v: &[f64; COORDS]) -> bool {
    is_legible_convex(
        &[(v[0], v[1]), (v[2], v[3]), (v[4], v[5]), (v[6], v[7])],
        TAN_VALID,
    )
}

/// The step of least Euclidean norm `Δ = Σ λ_i a_i`, `λ ≥ 0`, that lifts
/// every linearised residual to its target, `a_i · Δ ≥ b_i`: Hildreth's
/// dual coordinate ascent on `λ`, which needs no independence between the
/// rows and keeps the inactive ones at `λ_i = 0`.
fn min_norm_step<const M: usize>(rows: &[[f64; COORDS]; M], b: &[f64; M]) -> [f64; COORDS] {
    let gram: [[f64; M]; M] = std::array::from_fn(|i| {
        std::array::from_fn(|j| rows[i].iter().zip(&rows[j]).map(|(a, c)| a * c).sum())
    });
    let scale = b.iter().fold(0.0_f64, |max, value| max.max(value.abs()));
    let mut lambda = [0.0; M];
    for _ in 0..SWEEPS {
        let mut change = 0.0_f64;
        for i in 0..M {
            let diagonal = gram[i][i];
            if diagonal <= 0.0 {
                continue;
            }
            let lifted: f64 = (0..M).map(|j| gram[i][j] * lambda[j]).sum();
            let next = (lambda[i] + (b[i] - lifted) / diagonal).max(0.0);
            change = change.max((next - lambda[i]).abs() * diagonal);
            lambda[i] = next;
        }
        if change <= 1e-12 * scale {
            break;
        }
    }
    std::array::from_fn(|k| (0..M).map(|i| lambda[i] * rows[i][k]).sum())
}

/// Moves the quadrilateral `v` into the set whose interior angles are all
/// at least `τ` and at most `180° − 0.5°`, with `tan_tau = tan τ`, keeping
/// its orientation (the sign of its shoelace area) and leaving it
/// unchanged if it is there. The result keeps the rule if
/// `15° < τ < 90°`.
///
/// Each step solves, on the residuals of every [`Bound`] at every vertex
/// linearised at `v`, for the change of least Euclidean norm in the eight
/// coordinates that lifts the violated ones to zero (a little above,
/// [`OVERSHOOT`]) and keeps the others non-negative ([`min_norm_step`]).
/// A polygon that is degenerate, or that the steps do not bring into the
/// set, is [`rebuild`]t.
pub(super) fn project(v: &mut [f64; COORDS], tan_tau: f64) -> Projected {
    debug_assert!(tan_tau > 0.0 && tan_tau < 1.0, "{tan_tau}");
    let bounds = projection_bounds(tan_tau);
    let s = orientation(v);
    let start = *v;
    let mut moved = false;
    for _ in 0..MAX_STEPS {
        let Some(corners) = corners(v, s) else {
            break;
        };
        if within(&corners, &bounds) {
            return if moved {
                Projected::Moved
            } else {
                Projected::Unchanged
            };
        }
        let mut rows = [[0.0; COORDS]; 2 * SIDES];
        let mut targets = [0.0; 2 * SIDES];
        for (p, corner) in corners.iter().enumerate() {
            for (k, &bound) in bounds.iter().enumerate() {
                let i = bounds.len() * p + k;
                rows[i] = corner.gradient(bound);
                targets[i] = OVERSHOOT * corner.scale - corner.residual(bound);
            }
        }
        let step = min_norm_step(&rows, &targets);
        if !step.iter().all(|s| s.is_finite()) {
            break;
        }
        for (value, change) in v.iter_mut().zip(step) {
            *value += change;
        }
        moved = true;
    }
    if corners(v, s).is_some_and(|corners| within(&corners, &bounds)) {
        return Projected::Moved;
    }
    *v = start;
    rebuild(v, s);
    Projected::Rebuilt
}

/// The fallback of [`project`]: the bounding box of `v`, at least 1 px on
/// each side, as a rectangle of orientation `s` whose corners go to the
/// vertices in the cyclic order that moves them least.
fn rebuild(v: &mut [f64; COORDS], s: f64) {
    let xs = [v[0], v[2], v[4], v[6]];
    let ys = [v[1], v[3], v[5], v[7]];
    let span = |values: [f64; SIDES]| {
        let low = values.iter().copied().fold(f64::INFINITY, f64::min);
        let high = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let centre = (low + high) / 2.0;
        let half = ((high - low) / 2.0).max(0.5);
        (centre - half, centre + half)
    };
    let ((x0, x1), (y0, y1)) = (span(xs), span(ys));
    // Positive shoelace area in this order.
    let mut box_corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    if s < 0.0 {
        box_corners.reverse();
    }
    let cost = |shift: usize| -> f64 {
        (0..SIDES)
            .map(|i| {
                let (x, y) = box_corners[(i + shift) % SIDES];
                (x - v[2 * i]) * (x - v[2 * i]) + (y - v[2 * i + 1]) * (y - v[2 * i + 1])
            })
            .sum()
    };
    let shift = (0..SIDES)
        .min_by(|&a, &b| cost(a).total_cmp(&cost(b)))
        .expect("four shifts");
    for i in 0..SIDES {
        let (x, y) = box_corners[(i + shift) % SIDES];
        v[2 * i] = x;
        v[2 * i + 1] = y;
    }
}

/// `v` with every coordinate rounded to a multiple of `quantum`; if that
/// breaks the rule ([`is_valid`]), the valid lattice polygon of `v`'s
/// orientation whose vertices are closest to `v`'s (least sum of squared
/// displacements, each coordinate within 2, then 4 quanta of its
/// rounding). Returns it and whether the rounding was replaced.
///
/// The search is a branch and bound over the vertices' candidates in
/// order of cost, and checks the corner at the second vertex as soon as
/// the third is chosen. Anything that finds no valid polygon ends as a
/// square of one quantum at the rounded centroid, which keeps the rule.
pub(super) fn snap(v: &[f64; COORDS], quantum: f64) -> ([f64; COORDS], bool) {
    let rounded = v.map(|value| round_to(value, quantum));
    if is_valid(&rounded) {
        return (rounded, false);
    }
    let s = orientation(v);
    for radius in [2_i32, 4] {
        let candidates = lattice_candidates(v, &rounded, SIDES, radius, quantum);
        let mut best: Option<(f64, [f64; COORDS])> = None;
        let mut checks = 0;
        'search: for a in &candidates[0] {
            if a.0 >= bound(&best) {
                break;
            }
            for b in &candidates[1] {
                if a.0 + b.0 >= bound(&best) {
                    break;
                }
                for c in &candidates[2] {
                    if a.0 + b.0 + c.0 >= bound(&best) {
                        break;
                    }
                    checks += 1;
                    if checks > SEARCH_CAP {
                        break 'search;
                    }
                    if !corner_valid((a.1, a.2), (b.1, b.2), (c.1, c.2), s) {
                        continue;
                    }
                    for d in &candidates[3] {
                        let cost = a.0 + b.0 + c.0 + d.0;
                        if cost >= bound(&best) {
                            break;
                        }
                        checks += 1;
                        let quad = [a.1, a.2, b.1, b.2, c.1, c.2, d.1, d.2];
                        if valid_oriented(&quad, s) {
                            best = Some((cost, quad));
                            break;
                        }
                    }
                }
            }
        }
        if let Some((_, quad)) = best {
            debug_assert!(is_valid(&quad), "{quad:?}");
            return (quad, true);
        }
    }
    let (cx, cy) = rounded_centroid(v, SIDES, quantum);
    let mut square = [
        cx,
        cy,
        cx + quantum,
        cy,
        cx + quantum,
        cy + quantum,
        cx,
        cy + quantum,
    ];
    if s < 0.0 {
        square = [
            cx,
            cy,
            cx,
            cy + quantum,
            cx + quantum,
            cy + quantum,
            cx + quantum,
            cy,
        ];
    }
    (square, true)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The four interior angles of `v` in degrees by `acos`, as
    /// `Triangle::is_valid` once computed them, or `None` if two
    /// consecutive vertices coincide. `acos` cannot tell a reflex angle
    /// from its complement to 360°, so this is no convexity check.
    pub(in crate::joint) fn acos_angles(v: &[f64; COORDS]) -> Option<[f64; SIDES]> {
        let mut angles = [0.0; SIDES];
        for p in 0..SIDES {
            let (q, r) = ((p + 1) % SIDES, (p + SIDES - 1) % SIDES);
            let (ax, ay) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
            let (bx, by) = (v[2 * r] - v[2 * p], v[2 * r + 1] - v[2 * p + 1]);
            let (la, lb) = (ax.hypot(ay), bx.hypot(by));
            if la == 0.0 || lb == 0.0 {
                return None;
            }
            let cos = ((ax * bx + ay * by) / (la * lb)).clamp(-1.0, 1.0);
            angles[p] = cos.acos().to_degrees();
        }
        Some(angles)
    }

    /// Whether the diagonals `v0 v2` and `v1 v3` cross strictly inside
    /// both, which a quadrilateral's do exactly when it is simple and
    /// strictly convex.
    pub(in crate::joint) fn diagonals_cross(v: &[f64; COORDS]) -> bool {
        let (px, py) = (v[0], v[1]);
        let (rx, ry) = (v[4] - v[0], v[5] - v[1]);
        let (qx, qy) = (v[2], v[3]);
        let (sx, sy) = (v[6] - v[2], v[7] - v[3]);
        let denominator = rx * sy - ry * sx;
        if denominator == 0.0 {
            return false;
        }
        let t = ((qx - px) * sy - (qy - py) * sx) / denominator;
        let u = ((qx - px) * ry - (qy - py) * rx) / denominator;
        t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0
    }

    /// The rule, checked independently: strictly convex by the diagonals,
    /// and every `acos` angle strictly above 15°.
    pub(in crate::joint) fn acos_valid(v: &[f64; COORDS]) -> bool {
        diagonals_cross(v)
            && acos_angles(v).is_some_and(|angles| angles.iter().all(|&angle| angle > 15.0))
    }

    /// The smallest and largest interior angle of a convex `v` in degrees,
    /// by `atan2` of the turn and the dot product with `v`'s orientation.
    fn angle_range(v: &[f64; COORDS]) -> (f64, f64) {
        let s = orientation(v);
        (0..SIDES)
            .map(|p| {
                let (q, r) = ((p + 1) % SIDES, (p + SIDES - 1) % SIDES);
                let (ux, uy) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
                let (wx, wy) = (v[2 * r] - v[2 * p], v[2 * r + 1] - v[2 * p + 1]);
                (s * (ux * wy - uy * wx))
                    .atan2(ux * wx + uy * wy)
                    .to_degrees()
            })
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), angle| {
                (low.min(angle), high.max(angle))
            })
    }

    /// A quadrilateral whose vertices sit on an ellipse at the given
    /// angles (degrees, increasing), around `(cx, cy)`, rotated by `turn`.
    fn on_ellipse(centre: (f64, f64), radii: (f64, f64), turn: f64, at: [f64; 4]) -> [f64; 8] {
        let mut v = [0.0; COORDS];
        let (sin_turn, cos_turn) = turn.to_radians().sin_cos();
        for (k, degrees) in at.iter().enumerate() {
            let (sin, cos) = degrees.to_radians().sin_cos();
            let (x, y) = (radii.0 * cos, radii.1 * sin);
            v[2 * k] = centre.0 + x * cos_turn - y * sin_turn;
            v[2 * k + 1] = centre.1 + x * sin_turn + y * cos_turn;
        }
        v
    }

    /// Random quadrilaterals of every kind: convex ones of every aspect
    /// (some with angles under 15° or near 180°), concave ones, crossed
    /// ones and nearly crossed ones, in both orientations, at sizes from
    /// 0.5 to 60 px.
    pub(in crate::joint) fn random_quads(seed: u64, count: usize) -> Vec<[f64; COORDS]> {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        (0..count)
            .map(|index| {
                let size = 10.0_f64.powf(rng.random_range(-0.3..1.8));
                let centre = (rng.random_range(-20.0..80.0), rng.random_range(-20.0..80.0));
                let turn = rng.random_range(0.0..360.0);
                let mut v = match index % 4 {
                    0 => {
                        // Convex: sorted angles on an ellipse.
                        let mut at: [f64; 4] =
                            std::array::from_fn(|_| rng.random_range(0.0..360.0));
                        at.sort_by(f64::total_cmp);
                        let aspect = 10.0_f64.powf(rng.random_range(-1.3..0.0));
                        on_ellipse(centre, (size, size * aspect), turn, at)
                    }
                    1 => std::array::from_fn(|k| {
                        let c = if k % 2 == 0 { centre.0 } else { centre.1 };
                        c + rng.random_range(-size..size)
                    }),
                    2 => {
                        // A convex quad with one vertex pulled past the
                        // diagonal of its neighbours: concave, or crossed.
                        let at =
                            [0.0, 90.0, 180.0, 270.0].map(|a| a + rng.random_range(-30.0..30.0));
                        let mut v = on_ellipse(centre, (size, size), turn, at);
                        let pull = rng.random_range(0.5..2.5);
                        for axis in 0..2 {
                            let mid = (v[axis] + v[4 + axis]) / 2.0;
                            v[2 + axis] += pull * (mid - v[2 + axis]);
                        }
                        v
                    }
                    _ => {
                        // Nearly crossed: two vertices almost on the
                        // segment between the other two.
                        let along = rng.random_range(0.2..0.8);
                        let lift = 10.0_f64.powf(rng.random_range(-3.0..-0.5));
                        let local = [(-0.5, 0.0), (along - 0.5, lift), (0.5, 0.0), (0.0, -lift)];
                        let (sin_turn, cos_turn) = turn.to_radians().sin_cos();
                        let mut v = [0.0; COORDS];
                        for (k, (x, y)) in local.iter().enumerate() {
                            v[2 * k] = centre.0 + size * (x * cos_turn - y * sin_turn);
                            v[2 * k + 1] = centre.1 + size * (x * sin_turn + y * cos_turn);
                        }
                        v
                    }
                };
                if rng.random_bool(0.5) {
                    // The other orientation.
                    v = [v[6], v[7], v[4], v[5], v[2], v[3], v[0], v[1]];
                }
                v
            })
            .collect()
    }

    fn greedy_valid(v: &[f64; COORDS]) -> bool {
        crate::shapes::Polygon {
            order: 4,
            x: [v[0], v[2], v[4], v[6]],
            y: [v[1], v[3], v[5], v[7]],
        }
        .is_valid()
    }

    #[test]
    fn the_convexity_margin_is_the_tangent_of_half_a_degree() {
        let tan = 0.5_f64.to_radians().tan();
        assert!(
            (TAN_CONVEX - tan).abs() <= 1e-16 * tan,
            "{TAN_CONVEX} vs {tan}"
        );
    }

    /// The check agrees with the independent one (diagonals and `acos`)
    /// and passes nothing greedy's rule rejects.
    #[test]
    fn validity_agrees_with_the_independent_rule_and_greedy() {
        let mut rng = ChaCha8Rng::seed_from_u64(6);
        let (mut valid, mut invalid) = (0, 0);
        for _ in 0..40_000 {
            let v: [f64; COORDS] =
                std::array::from_fn(|_| f64::from(rng.random_range(-24_i32..24)) * 0.25);
            assert_eq!(is_valid(&v), acos_valid(&v), "{v:?}");
            if is_valid(&v) {
                assert!(greedy_valid(&v), "{v:?}");
                valid += 1;
            } else {
                invalid += 1;
            }
        }
        for v in random_quads(7, 4000) {
            assert_eq!(is_valid(&v), acos_valid(&v), "{v:?}");
            assert!(!is_valid(&v) || greedy_valid(&v), "{v:?}");
        }
        assert!(valid > 2000 && invalid > 2000, "{valid} {invalid}");
        // A square either way round, a concave dart, a crossed bow tie, a
        // straight angle and a 15° corner.
        assert!(is_valid(&[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0]));
        assert!(is_valid(&[0.0, 0.0, 0.0, 4.0, 4.0, 4.0, 4.0, 0.0]));
        assert!(!is_valid(&[0.0, 0.0, 4.0, 1.0, 8.0, 0.0, 4.0, 6.0]));
        assert!(!is_valid(&[0.0, 0.0, 4.0, 4.0, 4.0, 0.0, 0.0, 4.0]));
        assert!(!is_valid(&[0.0, 0.0, 2.0, 0.0, 4.0, 0.0, 2.0, 3.0]));
        let tan15 = 15.0_f64.to_radians().tan();
        assert!(!is_valid(&[
            0.0,
            0.0,
            20.0,
            0.0,
            21.0,
            3.0,
            20.0,
            20.0 * tan15
        ]));
        assert!(is_valid(&[
            0.0,
            0.0,
            20.0,
            0.0,
            21.0,
            3.0,
            20.0,
            20.0 * tan15 + 0.01
        ]));
    }

    /// Valid quads with some margin are left alone; every other one,
    /// with angles under the bound, concave, crossed or nearly crossed,
    /// ends inside the projection's set and passes the rule.
    #[test]
    fn projection_keeps_valid_quads_and_makes_invalid_ones_valid() {
        let (mut unchanged, mut moved, mut rebuilt) = (0, 0, 0);
        let mut concave_or_crossed = 0;
        for degrees in [15.0 + 1e-5, 15.5, 16.0_f64] {
            let tan_tau = degrees.to_radians().tan();
            for v in random_quads(3, 4000) {
                let mut projected = v;
                match project(&mut projected, tan_tau) {
                    Projected::Unchanged => {
                        assert_eq!(projected, v);
                        unchanged += 1;
                    }
                    Projected::Moved => moved += 1,
                    Projected::Rebuilt => rebuilt += 1,
                }
                if !diagonals_cross(&v) {
                    concave_or_crossed += 1;
                }
                assert!(acos_valid(&projected), "{v:?} -> {projected:?}");
                let (low, high) = angle_range(&projected);
                assert!(low >= degrees - 1e-9, "{v:?} -> {projected:?}: {low}");
                assert!(high <= 179.5 + 1e-9, "{v:?} -> {projected:?}: {high}");
                let (low, high) = angle_range(&v);
                if diagonals_cross(&v) && low >= degrees + 1e-9 && high <= 179.5 - 1e-9 {
                    assert_eq!(projected, v);
                }
            }
        }
        assert!(
            unchanged > 1000 && moved > 6000 && rebuilt < 300,
            "{unchanged} {moved} {rebuilt}"
        );
        assert!(concave_or_crossed > 3000, "{concave_or_crossed}");
    }

    /// The cases the brief names, one by one: a needle corner, a concave
    /// dart, a quad crossed by a hair, one degenerate to a segment.
    #[test]
    fn projection_repairs_each_kind_of_violation() {
        let tan_tau = super::super::TAN_PROJECTION;
        let needle = [0.0, 0.0, 20.0, 0.0, 20.0, 2.0, 10.0, 2.2];
        let dart = [0.0, 0.0, 10.0, 2.0, 20.0, 0.0, 10.0, 12.0];
        let crossed = [0.0, 0.0, 10.0, 0.2, 20.0, 0.0, 10.0, -0.1];
        let segment = [0.0, 0.0, 5.0, 0.0, 10.0, 0.0, 15.0, 0.0];
        for v in [needle, dart, crossed, segment] {
            assert!(!is_valid(&v), "{v:?}");
            let mut projected = v;
            assert_ne!(project(&mut projected, tan_tau), Projected::Unchanged);
            assert!(acos_valid(&projected), "{v:?} -> {projected:?}");
            assert!(angle_range(&projected).0 >= 15.5 - 1e-9, "{projected:?}");
            assert_eq!(orientation(&projected), orientation(&v), "{projected:?}");
        }
        // The needle and the dart need only small moves.
        for v in [needle, dart] {
            let mut projected = v;
            assert_eq!(project(&mut projected, tan_tau), Projected::Moved);
            let moved = v
                .iter()
                .zip(&projected)
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f64>()
                .sqrt();
            assert!(moved < 3.0, "{v:?} -> {projected:?}: {moved}");
        }
    }

    #[test]
    fn snapped_quads_keep_the_rule() {
        let mut repaired = 0;
        for quantum in [0.25, 1.0] {
            for (index, mut v) in random_quads(5, 6000).into_iter().enumerate() {
                // Every size down to well below one quantum.
                if index % 2 == 0 {
                    let (cx, cy) = (v[0], v[1]);
                    for k in 0..SIDES {
                        v[2 * k] = cx + (v[2 * k] - cx) * 0.05;
                        v[2 * k + 1] = cy + (v[2 * k + 1] - cy) * 0.05;
                    }
                }
                project(&mut v, super::super::TAN_PROJECTION);
                let (snapped, replaced) = snap(&v, quantum);
                assert!(acos_valid(&snapped), "{v:?} -> {snapped:?}");
                assert!(greedy_valid(&snapped), "{v:?} -> {snapped:?}");
                for (s, c) in snapped.iter().zip(&v) {
                    assert_eq!((s / quantum).fract(), 0.0);
                    assert!((s - c).abs() <= 4.5 * quantum, "{v:?} -> {snapped:?}");
                }
                let rounded = v.map(|value| (value / quantum).round() * quantum);
                if replaced {
                    assert!(!acos_valid(&rounded));
                    repaired += 1;
                } else {
                    assert_eq!(snapped, rounded);
                }
            }
        }
        assert!(repaired > 100, "{repaired}");
    }

    /// The repair takes the nearest valid lattice quad: on a quad whose
    /// rounding is concave, no valid lattice quad within the search
    /// radius is closer, by brute force over one vertex at a time.
    #[test]
    fn the_repair_is_no_further_than_any_single_vertex_fix() {
        let quantum = 0.25;
        let mut compared = 0;
        for mut v in random_quads(11, 3000) {
            let (cx, cy) = (v[0], v[1]);
            for k in 0..SIDES {
                v[2 * k] = cx + (v[2 * k] - cx) * 0.1;
                v[2 * k + 1] = cy + (v[2 * k + 1] - cy) * 0.1;
            }
            project(&mut v, super::super::TAN_PROJECTION);
            let (snapped, replaced) = snap(&v, quantum);
            if !replaced {
                continue;
            }
            let cost = |quad: &[f64; COORDS]| -> f64 {
                quad.iter().zip(&v).map(|(a, b)| (a - b) * (a - b)).sum()
            };
            let rounded = v.map(|value| (value / quantum).round() * quantum);
            for vertex in 0..SIDES {
                for j in -2..=2 {
                    for i in -2..=2 {
                        let mut quad = rounded;
                        quad[2 * vertex] += f64::from(i) * quantum;
                        quad[2 * vertex + 1] += f64::from(j) * quantum;
                        if is_valid(&quad) && orientation(&quad) == orientation(&v) {
                            assert!(
                                cost(&snapped) <= cost(&quad),
                                "{v:?}: {snapped:?} vs {quad:?}"
                            );
                        }
                    }
                }
            }
            compared += 1;
        }
        assert!(compared > 100, "{compared}");
    }
}
