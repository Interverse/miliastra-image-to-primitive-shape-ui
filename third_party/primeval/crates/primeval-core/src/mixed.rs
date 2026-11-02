//! Equal-budget family competition; exactly one winner is committed per step.
use crate::ShapeKind;
pub(crate) const FAMILIES: [ShapeKind; 3] = [
    ShapeKind::Triangle,
    ShapeKind::RotatedEllipse,
    ShapeKind::RotatedRectangle,
];
pub(crate) fn family(round: usize) -> ShapeKind {
    FAMILIES[round % FAMILIES.len()]
}

/// A local, equal-area initializer in another allowed family. Type changes
/// replace a layer; they never create another control or a masking primitive.
pub(crate) fn replacement(
    shape: &crate::shapes::Shape,
    family: ShapeKind,
) -> Option<crate::shapes::Shape> {
    use crate::Geometry;
    use crate::shapes::{Polygon, RotatedEllipse, Shape};
    let (cx, cy, mut w, mut h, angle, area) = match shape.geometry() {
        Geometry::Ellipse {
            cx,
            cy,
            rx,
            ry,
            rotation,
        } => (
            cx,
            cy,
            rx * 2.0,
            ry * 2.0,
            rotation,
            std::f64::consts::PI / 4.0,
        ),
        Geometry::Polygon(p) if p.len() == 4 => {
            let dx = p[1].x - p[0].x;
            let dy = p[1].y - p[0].y;
            let hx = p[2].x - p[1].x;
            let hy = p[2].y - p[1].y;
            (
                p.iter().map(|p| p.x).sum::<f64>() / 4.0,
                p.iter().map(|p| p.y).sum::<f64>() / 4.0,
                (dx * dx + dy * dy).sqrt(),
                (hx * hx + hy * hy).sqrt(),
                crate::util::atan2_degrees(dy, dx),
                1.0,
            )
        }
        Geometry::Polygon(p) if p.len() == 3 => {
            let mut best = None;
            for apex in 0..3 {
                let a = &p[(apex + 1) % 3];
                let b = &p[(apex + 2) % 3];
                let tip = &p[apex];
                let qx = (a.x + b.x) / 2.0;
                let qy = (a.y + b.y) / 2.0;
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let hx = tip.x - qx;
                let hy = tip.y - qy;
                let width = (dx * dx + dy * dy).sqrt();
                let height = (hx * hx + hy * hy).sqrt();
                if width < 1e-12 || height < 1e-12 {
                    continue;
                }
                let error = (dx * hx + dy * hy).abs() / (width * height);
                let (mut ux, mut uy) = (dx / width, dy / width);
                if (qx - tip.x) * (-uy) + (qy - tip.y) * ux < 0.0 {
                    ux = -ux;
                    uy = -uy;
                }
                let frame = (
                    (qx + tip.x) / 2.0,
                    (qy + tip.y) / 2.0,
                    width,
                    height,
                    crate::util::atan2_degrees(uy, ux),
                    0.5,
                );
                if best.as_ref().is_none_or(|(e, _)| error < *e) {
                    best = Some((error, frame));
                }
            }
            best?.1
        }
        _ => return None,
    };
    let target_area = match family {
        ShapeKind::Triangle => 0.5,
        ShapeKind::RotatedEllipse => std::f64::consts::PI / 4.0,
        ShapeKind::RotatedRectangle => 1.0,
        _ => return None,
    };
    let scale = (area / target_area).sqrt();
    w = (w * scale).max(1.0);
    h = (h * scale).max(1.0);
    if family == ShapeKind::RotatedEllipse {
        return Some(Shape::RotatedEllipse(RotatedEllipse {
            x: cx,
            y: cy,
            rx: (w / 2.0).max(1.0),
            ry: (h / 2.0).max(1.0),
            angle,
        }));
    }
    #[cfg(not(feature = "asset-triangle"))]
    if family == ShapeKind::Triangle {
        let half = w / 2.0;
        let t = 0.2773245440598384_f64;
        h = h.clamp(half * t, half * (1.0 + (1.0 + t * t).sqrt()) / t);
    }
    let (sin, cos) = crate::sin_cos_degrees(angle);
    let mut p = Polygon {
        order: if family == ShapeKind::Triangle { 3 } else { 4 },
        x: [0.0; 4],
        y: [0.0; 4],
    };
    let vertices = if family == ShapeKind::Triangle {
        [
            (0.0, -h / 2.0),
            (-w / 2.0, h / 2.0),
            (w / 2.0, h / 2.0),
            (0.0, 0.0),
        ]
    } else {
        let cap = f64::from(crate::shapes::rect_aspect());
        w = w.min(h * cap);
        h = h.min(w * cap);
        [
            (-w / 2.0, -h / 2.0),
            (w / 2.0, -h / 2.0),
            (w / 2.0, h / 2.0),
            (-w / 2.0, h / 2.0),
        ]
    };
    for (i, (x, y)) in vertices.into_iter().enumerate() {
        p.x[i] = cx + x * cos - y * sin;
        p.y[i] = cy + x * sin + y * cos;
    }
    #[cfg(feature = "asset-triangle")]
    if p.order == 3 {
        let mut vertices =
            std::array::from_fn(|i| if i % 2 == 0 { p.x[i / 2] } else { p.y[i / 2] });
        crate::asset_triangle::project(&mut vertices);
        for i in 0..3 {
            p.x[i] = vertices[i * 2];
            p.y[i] = vertices[i * 2 + 1];
        }
    }
    Some(Shape::Polygon(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{RotatedEllipse, Shape};
    use crate::{Alpha, Buffer, Color, Geometry, Model, ModelOptions};
    #[test]
    fn mixed_greedy_step_competes_with_each_complete_single_family_search() {
        let target = Buffer::from_rgb(
            32,
            32,
            (0..32 * 32)
                .flat_map(|i| {
                    [
                        (i % 32 * 7) as u8,
                        (i / 32 * 7) as u8,
                        ((i * 13) % 256) as u8,
                    ]
                })
                .collect(),
        )
        .unwrap();
        let mut options = ModelOptions::default();
        options.seed = Some(42);
        let mut mixed = Model::new(target, Color::new(20, 30, 40, 255), options);
        for step in 1..=3 {
            let best = FAMILIES
                .into_iter()
                .map(|family| {
                    let mut single = mixed.clone();
                    single.step(family, Alpha::Auto);
                    single.score_f64()
                })
                .fold(f64::INFINITY, f64::min);
            mixed.step(ShapeKind::Mixed, Alpha::Auto);
            assert!(
                mixed.score_f64() <= best + 1e-12,
                "mixed {} > best {}",
                mixed.score_f64(),
                best
            );
            assert_eq!(mixed.drawing().shapes.len(), step);
        }
    }
    #[test]
    fn replacements_keep_one_asset_geometry() {
        for angle in [0.0, 17.7, 90.0, 212.4] {
            let seed = Shape::RotatedEllipse(RotatedEllipse {
                x: 23.7,
                y: 18.3,
                rx: 8.2,
                ry: 4.7,
                angle,
            });
            for first in FAMILIES {
                let shape = replacement(&seed, first).unwrap();
                for second in FAMILIES {
                    let shape = replacement(&shape, second).unwrap();
                    match shape.geometry() {
                        Geometry::Polygon(p) if p.len() == 3 => {
                            let d = |a: usize, b: usize| {
                                (p[a].x - p[b].x).powi(2) + (p[a].y - p[b].y).powi(2)
                            };
                            let e = [d(0, 1), d(1, 2), d(2, 0)];
                            assert!(
                                (e[0] - e[1])
                                    .abs()
                                    .min((e[1] - e[2]).abs())
                                    .min((e[2] - e[0]).abs())
                                    < 1e-8
                            );
                        }
                        Geometry::Polygon(p) if p.len() == 4 => {
                            let a = (p[1].x - p[0].x, p[1].y - p[0].y);
                            let b = (p[2].x - p[1].x, p[2].y - p[1].y);
                            assert!((a.0 * b.0 + a.1 * b.1).abs() < 1e-8);
                        }
                        Geometry::Ellipse { rx, ry, .. } => assert!(rx > 0.0 && ry > 0.0),
                        _ => panic!("unsupported mixed primitive"),
                    }
                }
            }
        }
    }
}
