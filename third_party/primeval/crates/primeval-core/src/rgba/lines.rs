//! Line and curve proposals: candidates aligned with edges of the target.
//!
//! Edges are detected once from the target (multichannel Sobel structure tensor,
//! non-maximum suppression, hysteresis, sub-pixel location), linked into chains
//! and split into straight segments, circular arcs and corners. Each step ranks
//! them by the current residual near them and proposes shapes whose boundary
//! follows the edge: a rectangle or triangle with one side on a straight edge,
//! an ellipse along an arc, a triangle filling a corner. Proposals only add
//! candidates; scoring, colors and the shape count are unchanged.
use super::*;

/// Edge geometry in pixel-centre coordinates (pixel `i` is centred on `i`).
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Primitive {
    Segment { x0: f64, y0: f64, x1: f64, y1: f64 },
    Arc { cx: f64, cy: f64, r: f64, start: f64, sweep: f64 },
    /// Apex, unit bisector into the wedge, half the opening angle, arm length.
    Corner { x: f64, y: f64, bx: f64, by: f64, half: f64, arm: f64 },
}

/// Bit flags of the experimental variant.
pub(super) const SLABS: u32 = 1;
pub(super) const WEDGES: u32 = 2;
pub(super) const ARCS: u32 = 4;
pub(super) const CORNERS: u32 = 8;

const LOW: f64 = 0.025;
const HIGH: f64 = 0.05;

pub(super) fn detect(w: usize, h: usize, target: &[[f64; 4]]) -> Vec<Primitive> {
    if w < 4 || h < 4 {
        return Vec::new();
    }
    // Structure tensor of the premultiplied RGBA gradient.
    let mut strength = vec![0.0; w * h];
    let mut normal = vec![(0.0, 0.0); w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
            let p = |dx: isize, dy: isize, k: usize| target[(y as isize + dy) as usize * w + (x as isize + dx) as usize][k];
            for k in 0..4 {
                let gx = (p(1, -1, k) + 2.0 * p(1, 0, k) + p(1, 1, k) - p(-1, -1, k) - 2.0 * p(-1, 0, k) - p(-1, 1, k)) / 8.0;
                let gy = (p(-1, 1, k) + 2.0 * p(0, 1, k) + p(1, 1, k) - p(-1, -1, k) - 2.0 * p(0, -1, k) - p(1, -1, k)) / 8.0;
                a += gx * gx;
                b += gx * gy;
                c += gy * gy;
            }
            let lambda = (a + c) / 2.0 + (((a - c) / 2.0).powi(2) + b * b).sqrt();
            let (mut nx, mut ny) = if b.abs() > 1e-15 { (lambda - c, b) } else if a >= c { (1.0, 0.0) } else { (0.0, 1.0) };
            let norm = (nx * nx + ny * ny).sqrt();
            if norm > 0.0 {
                nx /= norm;
                ny /= norm;
            }
            strength[y * w + x] = lambda.sqrt();
            normal[y * w + x] = (nx, ny);
        }
    }
    let sample = |x: f64, y: f64| -> f64 {
        let (xi, yi) = (x.round(), y.round());
        if xi < 0.0 || yi < 0.0 || xi >= w as f64 || yi >= h as f64 {
            return 0.0;
        }
        strength[yi as usize * w + xi as usize]
    };
    // Thin to ridge pixels with a sub-pixel position along the normal.
    let mut point = vec![None; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            let s = strength[i];
            if s < LOW {
                continue;
            }
            let (nx, ny) = normal[i];
            let before = sample(x as f64 - nx, y as f64 - ny);
            let after = sample(x as f64 + nx, y as f64 + ny);
            // Ties keep the earlier pixel so a two-pixel ridge stays one pixel thick.
            if s < before || s <= after {
                continue;
            }
            let curvature = before - 2.0 * s + after;
            let offset = if curvature < 0.0 { ((before - after) / (2.0 * curvature)).clamp(-0.5, 0.5) } else { 0.0 };
            point[i] = Some((x as f64 + offset * nx, y as f64 + offset * ny));
        }
    }
    // Hysteresis: keep 8-connected ridges that reach the high threshold.
    let mut keep = vec![false; w * h];
    let mut stack = Vec::new();
    for i in 0..w * h {
        if point[i].is_some() && strength[i] >= HIGH && !keep[i] {
            keep[i] = true;
            stack.push(i);
            while let Some(j) = stack.pop() {
                for n in neighbours(j, w, h) {
                    if point[n].is_some() && !keep[n] {
                        keep[n] = true;
                        stack.push(n);
                    }
                }
            }
        }
    }
    // Chains: start from endpoints, then whatever remains (closed loops).
    let mut used = vec![false; w * h];
    let mut chains: Vec<Vec<(f64, f64)>> = Vec::new();
    let degree = |i: usize| neighbours(i, w, h).filter(|&n| keep[n]).count();
    let order: Vec<usize> = (0..w * h).filter(|&i| keep[i] && degree(i) == 1).chain((0..w * h).filter(|&i| keep[i])).collect();
    for start in order {
        if used[start] {
            continue;
        }
        let mut chain = vec![point[start].unwrap()];
        used[start] = true;
        let mut at = start;
        loop {
            let (nx, ny) = normal[at];
            // Continue along the edge tangent where possible.
            let next = neighbours(at, w, h).filter(|&n| keep[n] && !used[n]).max_by(|&a, &b| {
                let score = |n: usize| {
                    let (dx, dy) = ((n % w) as f64 - (at % w) as f64, (n / w) as f64 - (at / w) as f64);
                    -((dx * nx + dy * ny).abs()) / (dx * dx + dy * dy).sqrt()
                };
                score(a).total_cmp(&score(b)).then(b.cmp(&a))
            });
            let Some(next) = next else { break };
            used[next] = true;
            chain.push(point[next].unwrap());
            at = next;
        }
        if chain.len() >= 5 {
            chains.push(chain);
        }
    }
    let mut primitives = Vec::new();
    for chain in &chains {
        let mut vertices = vec![0, chain.len() - 1];
        simplify(chain, 0, chain.len() - 1, 0.9, &mut vertices);
        vertices.sort_unstable();
        vertices.dedup();
        let mut lines = Vec::new();
        for pair in vertices.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if b - a + 1 < 4 {
                lines.push(None);
                continue;
            }
            lines.push(fit_line(&chain[a..=b]));
        }
        for line in lines.iter().flatten() {
            primitives.push(line.clone());
        }
        // Corners between consecutive fitted segments.
        for pair in lines.windows(2) {
            if let [Some(Primitive::Segment { x0, y0, x1, y1 }), Some(Primitive::Segment { x0: u0, y0: v0, x1: u1, y1: v1 })] = pair {
                let (ax, ay) = (x0 - x1, y0 - y1);
                let (bx, by) = (u1 - u0, v1 - v0);
                let (la, lb) = ((ax * ax + ay * ay).sqrt(), (bx * bx + by * by).sqrt());
                let cos = (ax * bx + ay * by) / (la * lb);
                let opening = cos.clamp(-1.0, 1.0).acos();
                if !(0.35..=2.6).contains(&opening) {
                    continue;
                }
                let (cx, cy) = ((x1 + u0) / 2.0, (y1 + v0) / 2.0);
                let (mut dx, mut dy) = (ax / la + bx / lb, ay / la + by / lb);
                let norm = (dx * dx + dy * dy).sqrt();
                dx /= norm;
                dy /= norm;
                primitives.push(Primitive::Corner { x: cx, y: cy, bx: dx, by: dy, half: opening / 2.0, arm: la.min(lb) });
            }
        }
        // Arcs: windows of the chain that fit a circle closely.
        for window in [12usize, 24, 48] {
            if chain.len() < window {
                continue;
            }
            let mut start = 0;
            while start + window <= chain.len() {
                if let Some(arc) = fit_arc(&chain[start..start + window]) {
                    primitives.push(arc);
                }
                start += window / 2;
            }
        }
    }
    primitives
}

fn neighbours(i: usize, w: usize, h: usize) -> impl Iterator<Item = usize> {
    let (x, y) = ((i % w) as isize, (i / w) as isize);
    (-1..=1isize).flat_map(move |dy| (-1..=1isize).map(move |dx| (dx, dy))).filter_map(move |(dx, dy)| {
        let (nx, ny) = (x + dx, y + dy);
        ((dx, dy) != (0, 0) && nx >= 0 && ny >= 0 && nx < w as isize && ny < h as isize).then_some(ny as usize * w + nx as usize)
    })
}

/// Ramer-Douglas-Peucker split points of `chain[a..=b]`.
fn simplify(chain: &[(f64, f64)], a: usize, b: usize, tolerance: f64, vertices: &mut Vec<usize>) {
    if b <= a + 1 {
        return;
    }
    let (x0, y0) = chain[a];
    let (x1, y1) = chain[b];
    let (dx, dy) = (x1 - x0, y1 - y0);
    let length = (dx * dx + dy * dy).sqrt();
    let (mut far, mut at) = (0.0, a);
    for (i, &(x, y)) in chain.iter().enumerate().take(b).skip(a + 1) {
        let distance = if length > 1e-9 { ((x - x0) * dy - (y - y0) * dx).abs() / length } else { ((x - x0).powi(2) + (y - y0).powi(2)).sqrt() };
        if distance > far {
            far = distance;
            at = i;
        }
    }
    if far > tolerance {
        vertices.push(at);
        simplify(chain, a, at, tolerance, vertices);
        simplify(chain, at, b, tolerance, vertices);
    }
}

/// Total least squares line through the points, clipped to their extent.
fn fit_line(points: &[(f64, f64)]) -> Option<Primitive> {
    let n = points.len() as f64;
    let (mx, my) = (points.iter().map(|p| p.0).sum::<f64>() / n, points.iter().map(|p| p.1).sum::<f64>() / n);
    let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
    for &(x, y) in points {
        a += (x - mx) * (x - mx);
        b += (x - mx) * (y - my);
        c += (y - my) * (y - my);
    }
    let lambda = (a + c) / 2.0 + (((a - c) / 2.0).powi(2) + b * b).sqrt();
    let (mut ux, mut uy) = if b.abs() > 1e-15 { (lambda - c, b) } else if a >= c { (1.0, 0.0) } else { (0.0, 1.0) };
    let norm = (ux * ux + uy * uy).sqrt();
    ux /= norm;
    uy /= norm;
    let project = |p: &(f64, f64)| (p.0 - mx) * ux + (p.1 - my) * uy;
    let (lo, hi) = points.iter().map(project).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), t| (lo.min(t), hi.max(t)));
    // Edge pixels sit inside the boundary; extend half a pixel at both ends.
    let (lo, hi) = (lo - 0.5, hi + 0.5);
    if hi - lo < 3.0 {
        return None;
    }
    Some(Primitive::Segment { x0: mx + lo * ux, y0: my + lo * uy, x1: mx + hi * ux, y1: my + hi * uy })
}

/// Algebraic circle fit, kept when it is close, curved and spans enough angle.
fn fit_arc(points: &[(f64, f64)]) -> Option<Primitive> {
    let n = points.len() as f64;
    let (mx, my) = (points.iter().map(|p| p.0).sum::<f64>() / n, points.iter().map(|p| p.1).sum::<f64>() / n);
    let (mut suu, mut suv, mut svv, mut suuu, mut svvv, mut suvv, mut svuu) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for &(x, y) in points {
        let (u, v) = (x - mx, y - my);
        suu += u * u;
        suv += u * v;
        svv += v * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    let det = suu * svv - suv * suv;
    if det.abs() < 1e-9 {
        return None;
    }
    let (ru, rv) = ((suuu + suvv) / 2.0, (svvv + svuu) / 2.0);
    let uc = (ru * svv - rv * suv) / det;
    let vc = (rv * suu - ru * suv) / det;
    let r = (uc * uc + vc * vc + (suu + svv) / n).sqrt();
    let (cx, cy) = (mx + uc, my + vc);
    let rms = (points.iter().map(|&(x, y)| (((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - r).powi(2)).sum::<f64>() / n).sqrt();
    let (first, last) = (points[0], points[points.len() - 1]);
    let start = (first.1 - cy).atan2(first.0 - cx);
    let mut sweep = (last.1 - cy).atan2(last.0 - cx) - start;
    if sweep > std::f64::consts::PI {
        sweep -= 2.0 * std::f64::consts::PI;
    } else if sweep < -std::f64::consts::PI {
        sweep += 2.0 * std::f64::consts::PI;
    }
    (rms < 0.6 && r >= 2.0 && sweep.abs() >= 0.5).then_some(Primitive::Arc { cx, cy, r, start, sweep })
}

impl Primitive {
    /// Residual energy in a band of two pixels on both sides of the edge.
    pub(super) fn residual(&self, error: &[f64], w: usize, h: usize) -> f64 {
        let at = |x: f64, y: f64| {
            let (xi, yi) = (x.round(), y.round());
            if xi < 0.0 || yi < 0.0 || xi >= w as f64 || yi >= h as f64 { 0.0 } else { error[yi as usize * w + xi as usize] }
        };
        let mut total = 0.0;
        match *self {
            Primitive::Segment { x0, y0, x1, y1 } => {
                let length = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                let (ux, uy) = ((x1 - x0) / length, (y1 - y0) / length);
                let steps = length.ceil() as usize;
                for s in 0..=steps {
                    let t = s as f64 * length / steps.max(1) as f64;
                    for o in [-1.5, -0.5, 0.5, 1.5] {
                        total += at(x0 + t * ux - o * uy, y0 + t * uy + o * ux);
                    }
                }
            }
            Primitive::Arc { cx, cy, r, start, sweep } => {
                let steps = (sweep.abs() * r).ceil().max(1.0) as usize;
                for s in 0..=steps {
                    let angle = start + sweep * s as f64 / steps as f64;
                    for o in [-1.5, -0.5, 0.5, 1.5] {
                        total += at(cx + (r + o) * angle.cos(), cy + (r + o) * angle.sin());
                    }
                }
            }
            Primitive::Corner { x, y, bx, by, half, arm } => {
                let (s, c) = half.sin_cos();
                let reach = arm.min(12.0).ceil() as usize;
                for side in [-1.0, 1.0] {
                    let (dx, dy) = (bx * c - side * by * s, by * c + side * bx * s);
                    for t in 0..=reach {
                        total += at(x + t as f64 * dx, y + t as f64 * dy);
                    }
                }
            }
        }
        total
    }

    /// Candidate shapes whose boundary follows this edge, in shape coordinates.
    pub(super) fn proposals(&self, kind: ShapeKind, variant: u32, out: &mut Vec<Shape>) {
        let allowed = |family: ShapeKind| kind == family || kind == ShapeKind::Mixed;
        match *self {
            Primitive::Segment { x0, y0, x1, y1 } => {
                let length = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
                let (ux, uy) = ((x1 - x0) / length, (y1 - y0) / length);
                let (nx, ny) = (-uy, ux);
                let (mx, my) = ((x0 + x1) / 2.0 + 0.5, (y0 + y1) / 2.0 + 0.5);
                for side in [-1.0, 1.0] {
                    if variant & SLABS != 0 && allowed(ShapeKind::RotatedRectangle) {
                        let cap = f64::from(crate::shapes::rect_aspect());
                        for depth in [1.0, 2.0, 4.0, length / 8.0, length / 4.0, length / 2.0, length] {
                            let depth = depth.max(1.0);
                            // Respect the aspect cap by shortening along the edge.
                            let along = length.min(depth * cap);
                            out.push(rectangle(mx + side * nx * depth / 2.0, my + side * ny * depth / 2.0, along, depth, ux, uy));
                        }
                    }
                    if variant & WEDGES != 0 && allowed(ShapeKind::Triangle) {
                        for height in [length / 4.0, length / 2.0, length] {
                            out.push(triangle((mx + side * nx * height, my + side * ny * height), (mx - ux * length / 2.0, my - uy * length / 2.0), (mx + ux * length / 2.0, my + uy * length / 2.0)));
                        }
                    }
                }
            }
            Primitive::Arc { cx, cy, r, .. } => {
                if variant & ARCS != 0 && allowed(ShapeKind::RotatedEllipse) {
                    for radius in [r - 0.5, r, r + 0.5] {
                        out.push(Shape::RotatedEllipse(RotatedEllipse { x: cx + 0.5, y: cy + 0.5, rx: radius.max(1.0), ry: radius.max(1.0), angle: 0.0 }));
                    }
                }
            }
            Primitive::Corner { x, y, bx, by, half, arm } => {
                if variant & CORNERS != 0 && allowed(ShapeKind::Triangle) {
                    let (x, y) = (x + 0.5, y + 0.5);
                    let tan = half.tan();
                    for height in [arm * half.cos() / 2.0, arm * half.cos()] {
                        let (qx, qy) = (x + bx * height, y + by * height);
                        let spread = height * tan;
                        out.push(triangle((x, y), (qx - by * spread, qy + bx * spread), (qx + by * spread, qy - bx * spread)));
                    }
                }
            }
        }
    }
}

fn rectangle(cx: f64, cy: f64, along: f64, across: f64, ux: f64, uy: f64) -> Shape {
    let mut p = Polygon { order: 4, x: [0.0; 4], y: [0.0; 4] };
    for (i, (a, b)) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].into_iter().enumerate() {
        p.x[i] = cx + a * ux * along / 2.0 - b * uy * across / 2.0;
        p.y[i] = cy + a * uy * along / 2.0 + b * ux * across / 2.0;
    }
    Shape::Polygon(p)
}

fn triangle(apex: (f64, f64), a: (f64, f64), b: (f64, f64)) -> Shape {
    let mut p = Polygon { order: 3, x: [apex.0, a.0, b.0, 0.0], y: [apex.1, a.1, b.1, 0.0] };
    #[cfg(feature = "asset-triangle")]
    {
        let mut v = [p.x[0], p.y[0], p.x[1], p.y[1], p.x[2], p.y[2]];
        crate::asset_triangle::project(&mut v);
        for i in 0..3 {
            p.x[i] = v[i * 2];
            p.y[i] = v[i * 2 + 1];
        }
    }
    Shape::Polygon(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: usize, h: usize, paint: impl Fn(f64, f64) -> bool) -> Vec<[f64; 4]> {
        (0..w * h).map(|i| if paint((i % w) as f64, (i / w) as f64) { [0.9, 0.2, 0.1, 1.0] } else { [0.1, 0.1, 0.6, 1.0] }).collect()
    }

    #[test]
    fn finds_a_straight_edge_at_the_pixel_boundary() {
        // Columns 0..=19 red, 20.. blue: the boundary is x = 19.5 in centre coordinates.
        let found = detect(48, 32, &image(48, 32, |x, _| x < 20.0));
        let segment = found.iter().find_map(|p| match *p { Primitive::Segment { x0, y0, x1, y1 } if (y1 - y0).abs() > 20.0 => Some((x0, x1)), _ => None }).expect("vertical segment");
        assert!((segment.0 - 19.5).abs() < 0.3 && (segment.1 - 19.5).abs() < 0.3, "{segment:?}");
    }

    #[test]
    fn finds_an_arc_of_a_disc() {
        let found = detect(64, 64, &image(64, 64, |x, y| (x - 32.0).powi(2) + (y - 30.0).powi(2) < 20.0f64.powi(2)));
        let arc = found.iter().find_map(|p| match *p { Primitive::Arc { cx, cy, r, .. } => Some((cx, cy, r)), _ => None }).expect("arc");
        assert!((arc.0 - 32.0).abs() < 1.5 && (arc.1 - 30.0).abs() < 1.5 && (arc.2 - 20.0).abs() < 1.5, "{arc:?}");
    }

    #[test]
    fn proposals_follow_the_edge() {
        let segment = Primitive::Segment { x0: 19.5, y0: 2.0, x1: 19.5, y1: 30.0 };
        let mut shapes = Vec::new();
        segment.proposals(ShapeKind::Mixed, SLABS | WEDGES, &mut shapes);
        assert!(!shapes.is_empty());
        // Every slab has one side on x = 20 in shape coordinates.
        for shape in &shapes {
            if let Shape::Polygon(p) = shape {
                if p.order == 4 {
                    assert!(p.x.iter().any(|x| (x - 20.0).abs() < 1e-9), "{p:?}");
                }
            }
        }
        let mut ellipses = Vec::new();
        segment.proposals(ShapeKind::RotatedEllipse, SLABS | WEDGES, &mut ellipses);
        assert!(ellipses.is_empty());
    }
}
