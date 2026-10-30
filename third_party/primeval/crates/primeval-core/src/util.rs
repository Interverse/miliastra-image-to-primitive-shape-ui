use std::sync::OnceLock;

// Portability: geometry uses IEEE arithmetic, sqrt and rounding, with
// rotations computed below instead of platform trigonometry. The engine's
// one transcendental function, the Gaussian sampler's ln, uses libm::log:
// the same pure Rust implementation on native and WebAssembly targets.

/// Rotates point `(x, y)` using pre-computed sine and cosine values.
///
/// Use this when the same angle is applied to many points to avoid
/// redundant trigonometric calls.
#[must_use]
#[inline]
pub(crate) fn rotate_sc(x: f64, y: f64, sin_t: f64, cos_t: f64) -> (f64, f64) {
    (x * cos_t - y * sin_t, x * sin_t + y * cos_t)
}

/// `sin` and `cos` of `x` radians, `0 ≤ x ≤ π/4`, by their Taylor series
/// to the terms in `x¹⁹` and `x¹⁸`, in Horner form: the first omitted
/// terms are below `10⁻¹⁹`, under an ulp of the results.
fn sin_cos_octant(x: f64) -> (f64, f64) {
    let x2 = x * x;
    let (mut sin, mut cos) = (1.0, 1.0);
    for n in (1..=9).rev() {
        let n = f64::from(n);
        sin = 1.0 - x2 / ((2.0 * n) * (2.0 * n + 1.0)) * sin;
        cos = 1.0 - x2 / ((2.0 * n - 1.0) * (2.0 * n)) * cos;
    }
    (x * sin, cos)
}

/// `sin` and `cos` of `degrees`, by `+ − × ÷` and `floor` alone: the
/// angle reduced to a turn and then to `0..=45°` by the symmetries of the
/// circle, then `sin_cos_octant`. Every rotation in the engine takes its
/// sine and cosine from here, never from the platform's `sin_cos`, whose
/// last bit differs between libms: the greedy search's rotated rectangles
/// (from their integer angle) and rotated ellipses (from their continuous
/// one), and the joint optimisation's starting `u` of a rotated rectangle
/// and semi-axis vector of a rotated ellipse; outside the engine, the
/// render crate's PNG writer rotates ellipses with it. So every platform
/// and WebAssembly compute the same shapes and pixels. Within `1e-14` of
/// the platform's.
///
/// Whole degrees reduce exactly, so a whole angle's quadrant is exact
/// (`sin_cos_degrees(90.0) == (1.0, 0.0)`); a continuous angle's reduction
/// rounds once or twice, deterministically.
#[must_use]
pub fn sin_cos_degrees(degrees: f64) -> (f64, f64) {
    let degrees = degrees - 360.0 * (degrees / 360.0).floor();
    // `degrees / 90` can round up to the next whole quadrant, leaving `rest`
    // a rounding below zero, where the octant's series holds as well.
    let quadrant = (degrees / 90.0).floor().clamp(0.0, 3.0);
    let rest = degrees - 90.0 * quadrant;
    let radians = |degrees: f64| degrees * (std::f64::consts::PI / 180.0);
    let (sin, cos) = if rest <= 45.0 {
        sin_cos_octant(radians(rest))
    } else {
        let (sin, cos) = sin_cos_octant(radians(90.0 - rest));
        (cos, sin)
    };
    // `0.0 - value`, not `-value`, keeps zero positive.
    match quadrant as u8 {
        0 => (sin, cos),
        1 => (cos, 0.0 - sin),
        2 => (0.0 - sin, 0.0 - cos),
        _ => (0.0 - cos, sin),
    }
}

/// `atan t` for `0 ≤ t ≤ tan(π/8)`, by its Taylor series to the term in
/// `t⁴⁵`, in Horner form: the first omitted term is below `10⁻¹⁸`.
fn atan_octant(t: f64) -> f64 {
    let t2 = t * t;
    let mut sum = 0.0;
    for n in (0..=22).rev() {
        let n = f64::from(n);
        sum = 1.0 / (2.0 * n + 1.0) - t2 * sum;
    }
    t * sum
}

/// The angle of the vector `(x, y)` in degrees, in `[−180°, 180°]`, as
/// `y.atan2(x).to_degrees()` but by `+ − × ÷` alone, so that native and
/// WebAssembly builds agree: the vector reduced to the first octant by the
/// symmetries of the plane, `atan` of the ratio of its coordinates there,
/// `t ≤ 1`, reduced again to `t ≤ tan(π/8)` by
/// `atan t = π/4 − atan((1 − t) / (1 + t))`, then [`atan_octant`]. Within
/// `3e-14°` of the platform's in the tests. `(0, 0)` has angle 0.
pub(crate) fn atan2_degrees(y: f64, x: f64) -> f64 {
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};
    let (ax, ay) = (x.abs(), y.abs());
    let (low, high) = if ay <= ax { (ay, ax) } else { (ax, ay) };
    if high == 0.0 {
        return 0.0;
    }
    let t = low / high;
    // `tan(π/8)`.
    let mut angle = if t <= 0.414_213_562_373_095_03 {
        atan_octant(t)
    } else {
        FRAC_PI_4 - atan_octant((1.0 - t) / (1.0 + t))
    };
    if ay > ax {
        angle = FRAC_PI_2 - angle;
    }
    if x < 0.0 {
        angle = PI - angle;
    }
    let degrees = angle * (180.0 / PI);
    if y < 0.0 { 0.0 - degrees } else { degrees }
}

/// `sin` and `cos` of the whole angle `degrees`, as [`sin_cos_degrees`]
/// computes them, from a table of the 360 whole degrees of a turn built on
/// first use. Equal to the direct call bit for bit: a whole angle's
/// reduction to `0..360` is exact (well inside `i32`), so the direct call
/// computes the table's entry for `degrees.rem_euclid(360)`.
#[must_use]
pub(crate) fn sin_cos_whole_degrees(degrees: i32) -> (f64, f64) {
    static TABLE: OnceLock<[(f64, f64); 360]> = OnceLock::new();
    let table = TABLE.get_or_init(|| std::array::from_fn(|k| sin_cos_degrees(k as f64)));
    table[degrees.rem_euclid(360) as usize]
}

/// A non-deterministic seed from the OS entropy source, or from
/// `crypto.getRandomValues` in a browser.
///
/// # Panics
///
/// If the platform has no entropy source.
#[must_use]
pub(crate) fn entropy_seed() -> u64 {
    getrandom::u64().expect("the platform should provide an entropy source")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entropy_seeds_differ() {
        assert_ne!(entropy_seed(), entropy_seed());
    }

    #[test]
    fn rotate_sc_identity() {
        let (sin_t, cos_t) = 0.0_f64.sin_cos();
        let (rx, ry) = rotate_sc(1.0, 0.0, sin_t, cos_t);
        assert!((rx - 1.0).abs() < 1e-12);
        assert!(ry.abs() < 1e-12);
    }

    #[test]
    fn rotate_sc_quarter_turn() {
        let (sin_t, cos_t) = std::f64::consts::FRAC_PI_2.sin_cos();
        let (rx, ry) = rotate_sc(1.0, 0.0, sin_t, cos_t);
        assert!(rx.abs() < 1e-12);
        assert!((ry - 1.0).abs() < 1e-12);
    }

    #[test]
    fn sines_and_cosines_of_whole_degrees_match_the_platform() {
        let mut worst: f64 = 0.0;
        for degrees in -720..=720 {
            let (sin, cos) = sin_cos_degrees(f64::from(degrees));
            let (expected_sin, expected_cos) = f64::from(degrees).to_radians().sin_cos();
            // The platform's argument is `degrees · π / 180` rounded, an ulp
            // of up to 2e-15 at 720°.
            assert!((sin - expected_sin).abs() <= 2e-15, "{degrees}: {sin}");
            assert!((cos - expected_cos).abs() <= 2e-15, "{degrees}: {cos}");
            if (0..=90).contains(&degrees) {
                worst = worst.max((sin - expected_sin).abs().max((cos - expected_cos).abs()));
            }
        }
        // Within an ulp of 1 of the platform's from 0° to 90°.
        assert!(worst <= f64::EPSILON, "{worst}");
        assert_eq!(sin_cos_degrees(0.0), (0.0, 1.0));
        assert_eq!(sin_cos_degrees(90.0), (1.0, 0.0));
        assert_eq!(sin_cos_degrees(180.0), (0.0, -1.0));
        assert_eq!(sin_cos_degrees(-90.0), (-1.0, 0.0));
        assert!(sin_cos_degrees(180.0).0.is_sign_positive());
        assert_eq!(sin_cos_degrees(-270.0), (1.0, 0.0));
        assert_eq!(sin_cos_degrees(360.0), (0.0, 1.0));
    }

    /// The table of whole degrees equals the direct call bit for bit, over
    /// two turns either way and at the ends of `i32`'s range.
    #[test]
    fn sines_and_cosines_of_whole_degrees_come_from_the_table_exactly() {
        let mut angles: Vec<i32> = (-720..=720).collect();
        angles.extend([
            i32::MIN,
            i32::MIN + 1,
            i32::MAX - 1,
            i32::MAX,
            1 << 30,
            -(1 << 30),
        ]);
        for degrees in angles {
            let (sin, cos) = sin_cos_whole_degrees(degrees);
            let (expected_sin, expected_cos) = sin_cos_degrees(f64::from(degrees));
            assert_eq!(sin.to_bits(), expected_sin.to_bits(), "{degrees}");
            assert_eq!(cos.to_bits(), expected_cos.to_bits(), "{degrees}");
        }
    }

    /// The angle of a vector in degrees against the platform's on a sweep
    /// that includes the axes and the octant boundaries, well within
    /// `1e-12°`: measured 2.8e-14°.
    #[test]
    fn angles_of_real_degrees_match_the_platform() {
        use rand::{RngExt, SeedableRng};
        use rand_chacha::ChaCha8Rng;
        let mut angles: Vec<f64> = (-16..=16).map(|k| f64::from(k) * 45.0).collect();
        for k in -16..=16 {
            let boundary = f64::from(k) * 45.0;
            angles.extend([boundary - 1e-9, boundary + 1e-9, boundary + 22.5]);
        }
        angles.extend((0..20_000).map(|k| -720.0 + f64::from(k) * 0.072_003_1));
        let mut rng = ChaCha8Rng::seed_from_u64(45);
        angles.extend((0..5000).map(|_| rng.random_range(-1000.0..1000.0)));
        let mut worst_angle = 0.0_f64;
        for &degrees in &angles {
            let (sin, cos) = degrees.to_radians().sin_cos();
            for radius in [1.0, 0.25, 37.5] {
                let (y, x) = (radius * sin, radius * cos);
                let angle = atan2_degrees(y, x);
                let expected = y.atan2(x).to_degrees();
                // Both in `[−180°, 180°]`; `±180°` may differ in sign at
                // the boundary.
                let turn = (angle - expected).rem_euclid(360.0);
                worst_angle = worst_angle.max(turn.min(360.0 - turn));
                assert!((-180.0..=180.0).contains(&angle), "{y}, {x}: {angle}");
            }
        }
        assert!(worst_angle <= 1e-12, "atan2: {worst_angle}°");
        assert_eq!(atan2_degrees(0.0, 0.0), 0.0);
        assert_eq!(atan2_degrees(0.0, 2.0), 0.0);
        assert_eq!(atan2_degrees(3.0, 0.0), 90.0);
        assert_eq!(atan2_degrees(0.0, -1.0), 180.0);
        assert_eq!(atan2_degrees(-0.5, 0.0), -90.0);
        assert!((atan2_degrees(1.0, 1.0) - 45.0).abs() <= 1e-14);
        assert!((atan2_degrees(-1.0, -1.0) + 135.0).abs() <= 1e-13);
    }

    /// The sine and cosine of real angles in degrees against the
    /// platform's on a sweep that includes the axes and the octant
    /// boundaries, well within `1e-14`: measured 2.1e-15 (the platform's
    /// own argument, `degrees · π / 180`, rounds by up to an ulp of 17 at
    /// 1000°).
    #[test]
    fn sines_and_cosines_of_real_degrees_match_the_platform() {
        use rand::{RngExt, SeedableRng};
        let mut angles: Vec<f64> = (-16..=16).map(|k| f64::from(k) * 45.0).collect();
        for k in -16..=16 {
            let boundary = f64::from(k) * 45.0;
            angles.extend([boundary - 1e-9, boundary + 1e-9, boundary + 22.5]);
        }
        angles.extend((0..20_000).map(|k| -720.0 + f64::from(k) * 0.072_003_1));
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(45);
        angles.extend((0..5000).map(|_| rng.random_range(-1000.0..1000.0)));
        let mut worst = 0.0_f64;
        for &degrees in &angles {
            let (sin, cos) = sin_cos_degrees(degrees);
            let (expected_sin, expected_cos) = degrees.to_radians().sin_cos();
            worst = worst
                .max((sin - expected_sin).abs())
                .max((cos - expected_cos).abs());
        }
        assert!(worst <= 1e-14, "sin, cos: {worst}");
    }
}
