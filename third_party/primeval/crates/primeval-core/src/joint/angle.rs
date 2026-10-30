//! The engine's minimum-angle rule for jointly optimised triangles: every
//! angle strictly above 15°, as `Triangle::is_valid`. The arithmetic rule
//! of [`super`] applies: angles are never computed, only compared through
//! their tangents.
//!
//! With `D` the signed double area of a triangle, `c = |D|`, and at each
//! vertex `p` the edges `u`, `w` to the next two vertices and `d_p = u · w`,
//! the angle at `p` is `atan2(c, d_p)`. So for `c > 0` and a bound
//! `τ < 90°`, the angle is at least `τ` exactly when the residual
//! `g_p = c − tan τ · d_p` is not negative. `c` is shared, so the smallest
//! residual belongs to the smallest angle.
//!
//! - [`project`] moves a triangle back into the set whose angles are all at
//!   least `τ` by a small change of its vertices: Gauss–Newton steps of
//!   minimal norm in the six coordinates on the violated residuals,
//!   linearised (one or two of them, the KKT choice), until every residual
//!   is non-negative. A triangle already in the set is left as it is.
//! - [`snap`] rounds the vertices to a lattice and, if the rounded triangle
//!   breaks the rule, takes the valid lattice triangle closest to the
//!   continuous one instead.

use super::lattice::{bound, lattice_candidates, round_to, rounded_centroid};

/// `tan 15.000001°`: [`is_valid`]'s bound, a millionth of a degree above
/// the rule's 15° so that an `acos`-based check of the same triangle, whose
/// rounding errors are around `1e-14`°, agrees with it.
pub(super) const TAN_VALID: f64 = 0.267_949_211_137_505_3;

/// `tan 1°`, for the rebuild's base angles of `τ + 1°`.
const TAN_ONE_DEGREE: f64 = 0.017_455_064_928_217_585;

/// Gauss–Newton steps before [`project`] falls back to [`rebuild`].
pub(super) const MAX_STEPS: usize = 32;
/// How far above zero a projection step aims each residual it lifts,
/// relative to `|u|² + |w|²` at that corner (about `1e-9` rad), so that it
/// ends at or above `τ` despite rounding.
pub(super) const OVERSHOOT: f64 = 1e-9;
/// `√3 / 2`, the height of a unit equilateral triangle.
const HALF_SQRT_3: f64 = 0.866_025_403_784_438_6;

/// The terms of the residuals of a triangle `v`: `c = |D|` and its
/// gradient with respect to the six coordinates, and at each vertex `p`
/// the dot product `d_p`, its gradient, and `|u|² + |w|²`.
struct Corners {
    c: f64,
    dc: [f64; 6],
    d: [f64; 3],
    dd: [[f64; 6]; 3],
    scale: [f64; 3],
}

impl Corners {
    /// `None` if two vertices coincide.
    fn new(v: &[f64; 6]) -> Option<Self> {
        let area = super::twice_signed_area_triangle(v);
        let sign = if area < 0.0 { -1.0 } else { 1.0 };
        // ∂|D|/∂(x_i, y_i) = sign · (y_{i+1} − y_{i+2}, x_{i+2} − x_{i+1}).
        let mut dc = [0.0; 6];
        for i in 0..3 {
            let (j, k) = ((i + 1) % 3, (i + 2) % 3);
            dc[2 * i] = sign * (v[2 * j + 1] - v[2 * k + 1]);
            dc[2 * i + 1] = sign * (v[2 * k] - v[2 * j]);
        }
        let mut d = [0.0; 3];
        let mut dd = [[0.0; 6]; 3];
        let mut scale = [0.0; 3];
        for p in 0..3 {
            let (q, r) = ((p + 1) % 3, (p + 2) % 3);
            let (ux, uy) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
            let (wx, wy) = (v[2 * r] - v[2 * p], v[2 * r + 1] - v[2 * p + 1]);
            if (ux == 0.0 && uy == 0.0) || (wx == 0.0 && wy == 0.0) {
                return None;
            }
            d[p] = ux * wx + uy * wy;
            // ∂d/∂q = w, ∂d/∂r = u, ∂d/∂p = −(u + w).
            dd[p][2 * q] = wx;
            dd[p][2 * q + 1] = wy;
            dd[p][2 * r] = ux;
            dd[p][2 * r + 1] = uy;
            dd[p][2 * p] = -(ux + wx);
            dd[p][2 * p + 1] = -(uy + wy);
            scale[p] = ux * ux + uy * uy + wx * wx + wy * wy;
        }
        Some(Self {
            c: sign * area,
            dc,
            d,
            dd,
            scale,
        })
    }

    /// The residuals `g_p = c − tan · d_p`.
    fn residuals(&self, tan: f64) -> [f64; 3] {
        self.d.map(|d| self.c - tan * d)
    }

    /// Whether every angle is at least `atan tan` (`strict`: above it).
    fn within(&self, tan: f64, strict: bool) -> bool {
        self.c > 0.0
            && self
                .residuals(tan)
                .iter()
                .all(|&g| if strict { g > 0.0 } else { g >= 0.0 })
    }

    /// `∇g_p = ∇c − tan · ∇d_p`.
    fn gradient(&self, p: usize, tan: f64) -> [f64; 6] {
        std::array::from_fn(|i| self.dc[i] - tan * self.dd[p][i])
    }
}

/// Whether every angle of `v` is above 15° (see [`TAN_VALID`]).
pub(super) fn is_valid(v: &[f64; 6]) -> bool {
    Corners::new(v).is_some_and(|corners| corners.within(TAN_VALID, true))
}

/// What [`project`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Projected {
    /// Every angle was already at least `τ`; the triangle is unchanged.
    Unchanged,
    /// Gauss–Newton steps moved it into the set.
    Moved,
    /// It was degenerate, or the steps did not converge: [`rebuild`].
    Rebuilt,
}

fn dot(a: &[f64; 6], b: &[f64; 6]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}

/// Moves `v` into the set whose angles are all at least `τ`, with
/// `tan_tau = tan τ`, leaving it unchanged if it is there. The result
/// keeps the rule if `15° < τ < 60°`.
///
/// Each step solves, on the residuals linearised at `v`, for the change of
/// least Euclidean norm in the six coordinates that lifts the violated
/// ones to zero (a little above, [`OVERSHOOT`]): along the gradient of the
/// smallest alone if that keeps the second smallest at or above zero to
/// first order, otherwise on both (two at most can be negative for
/// `τ ≤ 60°`). Every vertex moves, in proportion to its leverage on the
/// residual: a needle opens by spreading its short edge, a cap by lifting
/// its flat vertex. On the boundary `g_p = 0` the gradient of `g_p` is
/// parallel to that of the angle, so the projection's fixed points are
/// those of the same steps on the angles.
pub(super) fn project(v: &mut [f64; 6], tan_tau: f64) -> Projected {
    debug_assert!(tan_tau > 0.0 && tan_tau < 1.732, "{tan_tau}");
    let start = *v;
    let mut moved = false;
    for _ in 0..MAX_STEPS {
        let Some(corners) = Corners::new(v) else {
            break;
        };
        if corners.within(tan_tau, false) {
            return if moved {
                Projected::Moved
            } else {
                Projected::Unchanged
            };
        }
        let g = corners.residuals(tan_tau);
        let mut order = [0, 1, 2];
        order.sort_by(|&a, &b| g[a].total_cmp(&g[b]));
        let [first, second, _] = order;
        let (g0, g1) = (
            corners.gradient(first, tan_tau),
            corners.gradient(second, tan_tau),
        );
        let (t0, t1) = (
            OVERSHOOT * corners.scale[first],
            OVERSHOOT * corners.scale[second],
        );
        let (n00, n01, n11) = (dot(&g0, &g0), dot(&g0, &g1), dot(&g1, &g1));
        let (r0, r1) = (t0 - g[first], t1 - g[second]);
        let single = r0 / n00;
        let mut step: [f64; 6] = std::array::from_fn(|i| single * g0[i]);
        if g[second] + dot(&g1, &step) < t1 {
            let det = n00 * n11 - n01 * n01;
            if det > 1e-12 * n00 * n11 {
                let l0 = (r0 * n11 - r1 * n01) / det;
                let l1 = (r1 * n00 - r0 * n01) / det;
                step = std::array::from_fn(|i| l0 * g0[i] + l1 * g1[i]);
            }
        }
        if !step.iter().all(|s| s.is_finite()) {
            break;
        }
        for (value, change) in v.iter_mut().zip(step) {
            *value += change;
        }
        moved = true;
    }
    if Corners::new(v).is_some_and(|corners| corners.within(tan_tau, false)) {
        return Projected::Moved;
    }
    *v = start;
    rebuild(v, tan_tau);
    Projected::Rebuilt
}

/// The fallback of [`project`] for degenerate triangles: keeps the longest
/// edge and puts the third vertex over its midpoint, on its side, at base
/// angles `τ + 1°`; three coincident vertices become a triangle of side
/// 1 px around them.
fn rebuild(v: &mut [f64; 6], tan_tau: f64) {
    let squared = |p: usize, q: usize| {
        let (dx, dy) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
        dx * dx + dy * dy
    };
    let (p, q, r) = [(0, 1, 2), (1, 2, 0), (2, 0, 1)]
        .into_iter()
        .max_by(|a, b| squared(a.0, a.1).total_cmp(&squared(b.0, b.1)))
        .expect("three edges");
    let base = squared(p, q).sqrt();
    if base < 1e-6 {
        let (cx, cy) = ((v[0] + v[2] + v[4]) / 3.0, (v[1] + v[3] + v[5]) / 3.0);
        let h = HALF_SQRT_3;
        *v = [
            cx - 0.5,
            cy - h / 3.0,
            cx + 0.5,
            cy - h / 3.0,
            cx,
            cy + 2.0 * h / 3.0,
        ];
        return;
    }
    let (ex, ey) = (
        (v[2 * q] - v[2 * p]) / base,
        (v[2 * q + 1] - v[2 * p + 1]) / base,
    );
    let side = ex * (v[2 * r + 1] - v[2 * p + 1]) - ey * (v[2 * r] - v[2 * p]);
    let sign = if side < 0.0 { -1.0 } else { 1.0 };
    // tan(τ + 1°) by the addition formula.
    let tan_base = (tan_tau + TAN_ONE_DEGREE) / (1.0 - tan_tau * TAN_ONE_DEGREE);
    let height = base / 2.0 * tan_base;
    let (mx, my) = (
        (v[2 * p] + v[2 * q]) / 2.0,
        (v[2 * p + 1] + v[2 * q + 1]) / 2.0,
    );
    v[2 * r] = mx - sign * ey * height;
    v[2 * r + 1] = my + sign * ex * height;
}

/// `v` with every coordinate rounded to a multiple of `quantum`; if that
/// breaks the rule ([`is_valid`]), the valid lattice triangle whose
/// vertices are closest to `v`'s (least sum of squared displacements, each
/// coordinate within 2, then 4 quanta of its rounding). Returns it and
/// whether the rounding was replaced.
///
/// A triangle with every angle above 15° always finds one that close (see
/// the tests). Anything else that does not ends as a right isosceles
/// triangle of one quantum at the rounded centroid, which keeps the rule.
pub(super) fn snap(v: &[f64; 6], quantum: f64) -> ([f64; 6], bool) {
    let rounded = v.map(|value| round_to(value, quantum));
    if is_valid(&rounded) {
        return (rounded, false);
    }
    for radius in [2_i32, 4] {
        let candidates = lattice_candidates(v, &rounded, 3, radius, quantum);
        let mut best: Option<(f64, [f64; 6])> = None;
        for a in &candidates[0] {
            if a.0 >= bound(&best) {
                break;
            }
            for b in &candidates[1] {
                if a.0 + b.0 >= bound(&best) {
                    break;
                }
                for c in &candidates[2] {
                    let cost = a.0 + b.0 + c.0;
                    if cost >= bound(&best) {
                        break;
                    }
                    let tri = [a.1, a.2, b.1, b.2, c.1, c.2];
                    if is_valid(&tri) {
                        best = Some((cost, tri));
                        break;
                    }
                }
            }
        }
        if let Some((_, tri)) = best {
            return (tri, true);
        }
    }
    let (cx, cy) = rounded_centroid(v, 3, quantum);
    ([cx, cy, cx + quantum, cy, cx, cy + quantum], true)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use rand::{RngExt, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// The three angles of `v` in degrees, by `acos` as
    /// `Triangle::is_valid` computes them, or `None` if two vertices
    /// coincide.
    pub(in crate::joint) fn acos_angles(v: &[f64; 6]) -> Option<[f64; 3]> {
        let mut angles = [0.0; 3];
        for p in 0..3 {
            let (q, r) = ((p + 1) % 3, (p + 2) % 3);
            let (ax, ay) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
            let (bx, by) = (v[2 * r] - v[2 * p], v[2 * r + 1] - v[2 * p + 1]);
            let da = (ax * ax + ay * ay).sqrt();
            let db = (bx * bx + by * by).sqrt();
            if da == 0.0 || db == 0.0 {
                return None;
            }
            let dot = ((ax / da) * (bx / db) + (ay / da) * (by / db)).clamp(-1.0, 1.0);
            angles[p] = dot.acos().to_degrees();
        }
        Some(angles)
    }

    /// The engine's rule, by `acos`: every angle strictly above 15°.
    pub(in crate::joint) fn acos_valid(v: &[f64; 6]) -> bool {
        acos_angles(v).is_some_and(|angles| angles.iter().all(|&angle| angle > 15.0))
    }

    /// The smallest angle of `v` in radians by `atan2`, 0 if two vertices
    /// coincide.
    fn min_angle(v: &[f64; 6]) -> f64 {
        let area = (v[2] - v[0]) * (v[5] - v[1]) - (v[3] - v[1]) * (v[4] - v[0]);
        (0..3)
            .map(|p| {
                let (q, r) = ((p + 1) % 3, (p + 2) % 3);
                let (ux, uy) = (v[2 * q] - v[2 * p], v[2 * q + 1] - v[2 * p + 1]);
                let (wx, wy) = (v[2 * r] - v[2 * p], v[2 * r + 1] - v[2 * p + 1]);
                if (ux == 0.0 && uy == 0.0) || (wx == 0.0 && wy == 0.0) {
                    0.0
                } else {
                    area.abs().atan2(ux * wx + uy * wy)
                }
            })
            .fold(f64::INFINITY, f64::min)
    }

    /// Random triangles of every shape: generic ones, needles (one small
    /// angle) and caps (one angle near 180°), down to 0.01°, at sizes from
    /// 0.5 to 60 px.
    fn random_triangles(seed: u64, count: usize) -> Vec<[f64; 6]> {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        (0..count)
            .map(|index| {
                let size = 10.0_f64.powf(rng.random_range(-0.3..1.8));
                let (cx, cy) = (rng.random_range(-20.0..80.0), rng.random_range(-20.0..80.0));
                let turn = rng.random_range(0.0..std::f64::consts::TAU);
                let local: [(f64, f64); 3] = match index % 3 {
                    0 => std::array::from_fn(|_| {
                        (rng.random_range(-1.0..1.0), rng.random_range(-1.0..1.0))
                    }),
                    1 => {
                        // A needle: apex at the origin, a small angle.
                        let angle = 10.0_f64.powf(rng.random_range(-2.0..1.4)).to_radians();
                        let (l1, l2) = (rng.random_range(0.3..1.0), rng.random_range(0.3..1.0));
                        [(0.0, 0.0), (l1, 0.0), (l2 * angle.cos(), l2 * angle.sin())]
                    }
                    _ => {
                        // A cap: the third vertex close to the base.
                        let along = rng.random_range(-0.4..0.4);
                        let lift = 10.0_f64.powf(rng.random_range(-3.0..-0.5));
                        [(-0.5, 0.0), (0.5, 0.0), (along, lift)]
                    }
                };
                let mut v = [0.0; 6];
                for (k, (x, y)) in local.iter().enumerate() {
                    v[2 * k] = cx + size * (x * turn.cos() - y * turn.sin());
                    v[2 * k + 1] = cy + size * (x * turn.sin() + y * turn.cos());
                }
                v
            })
            .collect()
    }

    #[test]
    fn the_tangent_literals_are_the_tangents_of_their_angles() {
        for (literal, degrees) in [
            (TAN_VALID, 15.000_001_f64),
            (super::super::TAN_PROJECTION, 15.5),
            (TAN_ONE_DEGREE, 1.0),
        ] {
            let tan = degrees.to_radians().tan();
            // The platform's `tan` may differ from the literal in the last
            // bits (glibc's does), so a few ulps, not bit for bit.
            assert!(
                (literal - tan).abs() <= 4.0 * f64::EPSILON * tan,
                "{literal} vs {tan}"
            );
        }
    }

    #[test]
    fn validity_agrees_with_the_acos_rule() {
        let mut rng = ChaCha8Rng::seed_from_u64(6);
        let (mut valid, mut invalid) = (0, 0);
        // Lattice triangles near the bound, where the two tests could
        // disagree, and random triangles of every shape.
        for _ in 0..20_000 {
            let v: [f64; 6] =
                std::array::from_fn(|_| f64::from(rng.random_range(-40_i32..40)) * 0.25);
            assert_eq!(is_valid(&v), acos_valid(&v), "{v:?}");
            if is_valid(&v) {
                valid += 1;
            } else {
                invalid += 1;
            }
        }
        for v in random_triangles(7, 3000) {
            assert_eq!(is_valid(&v), acos_valid(&v), "{v:?}");
        }
        assert!(valid > 5000 && invalid > 5000, "{valid} {invalid}");
        assert!(!is_valid(&[1.0, 2.0, 1.0, 2.0, 5.0, 0.0]));
        assert!(!is_valid(&[0.0, 0.0, 10.0, 0.0, 4.0, 0.0]));
        // Both orientations.
        assert!(is_valid(&[0.0, 0.0, 4.0, 0.0, 0.0, 4.0]));
        assert!(is_valid(&[0.0, 0.0, 0.0, 4.0, 4.0, 0.0]));
    }

    #[test]
    fn projection_keeps_valid_triangles_and_makes_invalid_ones_valid() {
        let (mut unchanged, mut moved, mut rebuilt) = (0, 0, 0);
        for degrees in [15.0 + 1e-5, 15.5, 16.0] {
            let tau = f64::to_radians(degrees);
            let tan_tau = tau.tan();
            for v in random_triangles(3, 3000) {
                let before = min_angle(&v);
                let mut projected = v;
                match project(&mut projected, tan_tau) {
                    Projected::Unchanged => {
                        assert!(before >= tau - 1e-12, "{v:?}");
                        assert_eq!(projected, v);
                        unchanged += 1;
                    }
                    Projected::Moved => moved += 1,
                    Projected::Rebuilt => rebuilt += 1,
                }
                let after = min_angle(&projected);
                // The residuals are non-negative to rounding: the angle is
                // `τ` up to an error far below any snap.
                assert!(
                    after >= tau - 1e-12,
                    "{v:?} -> {projected:?}: {}",
                    after.to_degrees()
                );
                assert!(after >= before.min(tau) - 1e-12, "{v:?}");
                assert!(acos_valid(&projected), "{v:?} -> {projected:?}");
                if before >= tau + 1e-12 {
                    assert_eq!(projected, v);
                }
            }
        }
        assert!(
            unchanged > 1000 && moved > 3000,
            "{unchanged} {moved} {rebuilt}"
        );
        // Coincident vertices are rebuilt; collinear distinct ones are
        // lifted by the steps. Both end valid.
        let tan_tau = super::super::TAN_PROJECTION;
        for (mut v, expected) in [
            ([3.0, 3.0, 3.0, 3.0, 3.0, 3.0], Projected::Rebuilt),
            ([0.0, 0.0, 10.0, 0.0, 10.0, 0.0], Projected::Rebuilt),
            ([0.0, 0.0, 10.0, 0.0, 4.0, 0.0], Projected::Moved),
        ] {
            assert_eq!(project(&mut v, tan_tau), expected);
            assert!(
                acos_valid(&v) && min_angle(&v) >= f64::to_radians(15.5) - 1e-12,
                "{v:?}"
            );
        }
    }

    /// The projection moves the six coordinates no further than the best
    /// move of a single vertex, found by brute force: a stand-in for
    /// minimal displacement.
    #[test]
    fn projection_moves_no_more_than_the_best_single_vertex_move() {
        let tau = f64::to_radians(15.5);
        let mut compared = 0;
        for v in random_triangles(4, 300) {
            if min_angle(&v) >= tau || min_angle(&v) < 1e-6 {
                continue;
            }
            let mut projected = v;
            if project(&mut projected, tau.tan()) != Projected::Moved {
                continue;
            }
            let moved = v
                .iter()
                .zip(&projected)
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f64>()
                .sqrt();
            // The shortest distance one vertex must move, over 720
            // directions, by bisection on the feasible distance.
            let scale = (0..3)
                .map(|k| (v[2 * k] - v[0]).hypot(v[2 * k + 1] - v[1]))
                .fold(0.0, f64::max)
                * 4.0;
            let mut single = f64::INFINITY;
            for vertex in 0..3 {
                for step in 0..720 {
                    let angle = f64::from(step) * std::f64::consts::TAU / 720.0;
                    let at = |t: f64| {
                        let mut w = v;
                        w[2 * vertex] += t * angle.cos();
                        w[2 * vertex + 1] += t * angle.sin();
                        min_angle(&w) >= tau
                    };
                    if !at(scale) {
                        continue;
                    }
                    let (mut low, mut high) = (0.0, scale);
                    for _ in 0..60 {
                        let middle = (low + high) / 2.0;
                        if at(middle) {
                            high = middle;
                        } else {
                            low = middle;
                        }
                    }
                    single = single.min(high);
                }
            }
            assert!(moved <= single * 1.001, "{v:?}: {moved} against {single}");
            compared += 1;
        }
        assert!(compared > 100, "{compared}");
    }

    #[test]
    fn snapped_triangles_keep_the_rule() {
        let mut repaired = 0;
        for quantum in [0.25, 1.0] {
            for (index, mut v) in random_triangles(5, 6000).into_iter().enumerate() {
                // Every size down to well below one quantum.
                if index % 2 == 0 {
                    let (cx, cy) = (v[0], v[1]);
                    for k in 0..3 {
                        v[2 * k] = cx + (v[2 * k] - cx) * 0.05;
                        v[2 * k + 1] = cy + (v[2 * k + 1] - cy) * 0.05;
                    }
                }
                project(&mut v, super::super::TAN_PROJECTION);
                let (snapped, replaced) = snap(&v, quantum);
                assert!(acos_valid(&snapped), "{v:?} -> {snapped:?}");
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
}
