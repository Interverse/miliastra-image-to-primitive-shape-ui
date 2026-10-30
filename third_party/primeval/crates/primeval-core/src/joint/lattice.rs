//! The lattice arithmetic the snaps share: rounding to the lattice of a
//! quantum, lengthening a vector on it, and the per-vertex candidates and
//! bounds of the branch and bound that triangles and polygons search when
//! their rounding breaks the rule. The arithmetic rule of [`super`]
//! applies: lattice values are small multiples of a power of two, so the
//! sums, products and squares below are exact in `f64`.

use super::diff::COORDS;

/// A lattice candidate for one vertex: its squared distance from the
/// continuous vertex, then its coordinates.
pub(super) type Candidate = (f64, f64, f64);

/// `value` rounded to the lattice of `quantum`.
pub(super) fn round_to(value: f64, quantum: f64) -> f64 {
    (value / quantum).round() * quantum
}

/// `value` rounded to the lattice of `quantum` away from zero.
fn round_away(value: f64, quantum: f64) -> f64 {
    let steps = (value.abs() / quantum).ceil() * quantum;
    if value < 0.0 { -steps } else { steps }
}

/// Lengthens the vector `(out[2], out[3])`, rounded to the lattice of
/// `quantum`, if its squared length is below `min_sq`: it is rounded away
/// from zero from `p`'s instead, then its larger component (the first on a
/// tie) grows by a quantum, away from zero, while it still is shorter. A
/// zero vector becomes `(quantum, 0)` first.
pub(super) fn lengthen_on_lattice(
    out: &mut [f64; COORDS],
    p: &[f64; COORDS],
    quantum: f64,
    min_sq: f64,
) {
    let short = |out: &[f64; COORDS]| out[2] * out[2] + out[3] * out[3] < min_sq;
    if !short(out) {
        return;
    }
    out[2] = round_away(p[2], quantum);
    out[3] = round_away(p[3], quantum);
    while short(out) {
        let k = if out[2].abs() >= out[3].abs() { 2 } else { 3 };
        out[k] += if out[k] < 0.0 { -quantum } else { quantum };
    }
}

/// For each of the first `vertices` vertices of `v`, the lattice points
/// within `radius` quanta of its rounding in `rounded` along each axis,
/// in order of their squared distance from it; ties keep the order of
/// generation, rows of `j`, then `i`, from `−radius`.
pub(super) fn lattice_candidates(
    v: &[f64],
    rounded: &[f64],
    vertices: usize,
    radius: i32,
    quantum: f64,
) -> Vec<Vec<Candidate>> {
    (0..vertices)
        .map(|vertex| {
            let (x, y) = (v[2 * vertex], v[2 * vertex + 1]);
            let (rx, ry) = (rounded[2 * vertex], rounded[2 * vertex + 1]);
            let mut list: Vec<Candidate> = (-radius..=radius)
                .flat_map(|j| (-radius..=radius).map(move |i| (i, j)))
                .map(|(i, j)| {
                    let (cx, cy) = (rx + f64::from(i) * quantum, ry + f64::from(j) * quantum);
                    let (dx, dy) = (cx - x, cy - y);
                    (dx * dx + dy * dy, cx, cy)
                })
                .collect();
            // Stable: ties keep the generation order.
            list.sort_by(|a, b| a.0.total_cmp(&b.0));
            list
        })
        .collect()
}

/// The cost of the best polygon found so far, or infinity before the
/// first: the bound below which the search's candidates must stay.
pub(super) fn bound<const N: usize>(best: &Option<(f64, [f64; N])>) -> f64 {
    best.map_or(f64::INFINITY, |b| b.0)
}

/// The mean of the first `vertices` vertices of `v`, each coordinate
/// summed in vertex order, then rounded to the lattice of `quantum`.
pub(super) fn rounded_centroid(v: &[f64], vertices: usize, quantum: f64) -> (f64, f64) {
    let (mut x, mut y) = (v[0], v[1]);
    for vertex in 1..vertices {
        x += v[2 * vertex];
        y += v[2 * vertex + 1];
    }
    let count = vertices as f64;
    (round_to(x / count, quantum), round_to(y / count, quantum))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_to_the_nearest_lattice_point_half_away_from_zero() {
        assert_eq!(round_to(1.1, 0.25), 1.0);
        assert_eq!(round_to(1.125, 0.25), 1.25);
        assert_eq!(round_to(-1.125, 0.25), -1.25);
        assert_eq!(round_to(2.6, 1.0), 3.0);
        assert_eq!(round_away(0.1, 0.5), 0.5);
        assert_eq!(round_away(-0.1, 0.5), -0.5);
        assert_eq!(round_away(1.0, 0.5), 1.0);
        assert_eq!(round_away(0.0, 0.5), 0.0);
    }

    /// A short vector ends at least `min_sq` long, on the lattice, with
    /// each component's sign; a long one is left alone.
    #[test]
    fn lengthening_reaches_the_least_length_on_the_lattice() {
        for quantum in [0.25, 0.5, 1.0] {
            for min_sq in [0.25, 1.0] {
                for (x, y) in [(0.0, 0.0), (0.1, -0.05), (-0.3, 0.2), (0.0, -0.4)] {
                    let mut p = [0.0; COORDS];
                    (p[2], p[3]) = (x, y);
                    let mut out = p.map(|value| round_to(value, quantum));
                    lengthen_on_lattice(&mut out, &p, quantum, min_sq);
                    assert!(out[2] * out[2] + out[3] * out[3] >= min_sq, "{out:?}");
                    for k in [2, 3] {
                        assert_eq!((out[k] / quantum).fract(), 0.0, "{out:?}");
                        assert!(out[k] * p[k] >= 0.0, "{p:?} -> {out:?}");
                    }
                }
                let mut p = [0.0; COORDS];
                (p[2], p[3]) = (1.5, -2.0);
                let mut out = p;
                lengthen_on_lattice(&mut out, &p, quantum, min_sq);
                assert_eq!(out, p);
            }
        }
        let (mut out, p) = ([0.0; COORDS], [0.0; COORDS]);
        lengthen_on_lattice(&mut out, &p, 0.5, 1.0);
        assert_eq!((out[2], out[3]), (1.0, 0.0));
    }

    /// Each vertex has the `(2r + 1)²` lattice points around its rounding,
    /// sorted by their exact squared distance, the rounding first.
    #[test]
    fn candidates_are_the_lattice_points_around_each_vertex_by_distance() {
        let v = [0.3, 0.1, 2.2, -1.4, 5.0, 5.0];
        let rounded = v.map(|value| round_to(value, 0.5));
        let candidates = lattice_candidates(&v, &rounded, 3, 2, 0.5);
        assert_eq!(candidates.len(), 3);
        for (vertex, list) in candidates.iter().enumerate() {
            assert_eq!(list.len(), 25);
            assert_eq!(
                (list[0].1, list[0].2),
                (rounded[2 * vertex], rounded[2 * vertex + 1])
            );
            for pair in list.windows(2) {
                assert!(pair[0].0 <= pair[1].0, "{list:?}");
            }
            for &(cost, x, y) in list {
                let (dx, dy) = (x - v[2 * vertex], y - v[2 * vertex + 1]);
                assert_eq!(cost, dx * dx + dy * dy);
                assert!((x - rounded[2 * vertex]).abs() <= 1.0);
                assert!((y - rounded[2 * vertex + 1]).abs() <= 1.0);
            }
        }
        // `(5, 5)` is on the lattice: its four neighbours at one quantum tie,
        // in the order `(5, 4.5)`, `(4.5, 5)`, `(5.5, 5)`, `(5, 5.5)`.
        let ties: Vec<(f64, f64)> = candidates[2][1..5].iter().map(|c| (c.1, c.2)).collect();
        assert_eq!(ties, [(5.0, 4.5), (4.5, 5.0), (5.5, 5.0), (5.0, 5.5)]);
    }

    #[test]
    fn the_bound_is_the_best_cost_or_infinity() {
        assert_eq!(bound::<6>(&None), f64::INFINITY);
        assert_eq!(bound(&Some((2.5, [0.0; 6]))), 2.5);
    }

    #[test]
    fn the_centroid_is_rounded_to_the_lattice() {
        let v = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
        assert_eq!(rounded_centroid(&v, 3, 0.25), (0.25, 0.25));
        assert_eq!(rounded_centroid(&v, 4, 0.25), (0.5, 0.5));
        assert_eq!(rounded_centroid(&v, 4, 1.0), (1.0, 1.0));
    }
}
