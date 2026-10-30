//! Raster writer for a [`Drawing`]: tiny-skia rendering and PNG encoding.
//! The raster calls no platform transcendental function: ellipse rotations
//! take their sine and cosine from [`primeval_core::sin_cos_degrees`].

use image::ImageEncoder;
use primeval_core::{Buffer, Color, Drawing, Geometry};
use tiny_skia::{FillRule, LineCap, Paint, Path, PathBuilder, Pixmap, Rect, Stroke, Transform};

/// Straight RGBA export from the same independently rendered shapes.
pub(crate) fn render_rgba(drawing:&Drawing,width:u32,height:u32)->Option<Vec<u8>> {
    let pixmap=render(drawing,width,height)?;
    Some(pixmap.pixels().iter().flat_map(|p| {
        let a=p.alpha();
        let straight=|c:u8|if a==0{0}else{((u32::from(c)*255+u32::from(a)/2)/u32::from(a)).min(255) as u8};
        [straight(p.red()),straight(p.green()),straight(p.blue()),a]
    }).collect())
}

/// Render `drawing` onto `width` × `height` output pixels as opaque RGB8.
///
/// The canvas is stretched onto the output with `scale(width / canvas width,
/// height / canvas height)`, which matches the SVG writer's `viewBox` up to the
/// rounding of the output size. Returns `None` when the pixmap or the RGB
/// buffer cannot be allocated, including when its size overflows `usize`.
pub(crate) fn render_rgb(drawing: &Drawing, width: u32, height: u32) -> Option<Vec<u8>> {
    let pixmap = render(drawing, width, height)?;
    // The background is opaque and source-over keeps it opaque, so the
    // premultiplied colour channels are the straight ones.
    let len = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?
        .checked_mul(3)?;
    let mut rgb = Vec::new();
    rgb.try_reserve_exact(len).ok()?;
    rgb.extend(
        pixmap
            .pixels()
            .iter()
            .flat_map(|pixel| [pixel.red(), pixel.green(), pixel.blue()]),
    );
    Some(rgb)
}

/// The sum over every pixel and RGB channel of the squared difference
/// between `drawing`, rendered as [`render_rgb`] renders it at `target`'s
/// size, and `target`: the export's error at the working size, before the
/// square root and the normalisation of an RMSE. Returns `None` when the
/// pixmap cannot be allocated.
///
/// It is exact integer arithmetic over the 8-bit pixels, in one thread, so
/// it does not depend on the number of threads.
pub(crate) fn squared_error(drawing: &Drawing, target: &Buffer) -> Option<u64> {
    let pixmap = render(drawing, target.width(), target.height())?;
    Some(
        pixmap
            .pixels()
            .iter()
            .zip(target.pixels().as_chunks::<3>().0)
            .map(|(pixel, expected)| {
                [pixel.red(), pixel.green(), pixel.blue()]
                    .iter()
                    .zip(expected)
                    .map(|(&a, &b)| u64::from(a.abs_diff(b)).pow(2))
                    .sum::<u64>()
            })
            .sum(),
    )
}

/// [`render_rgb`]'s pixmap, before its conversion to RGB.
fn render(drawing: &Drawing, width: u32, height: u32) -> Option<Pixmap> {
    let mut pixmap = Pixmap::new(width, height)?;
    pixmap.fill(skia_color(drawing.background));
    #[cfg(not(feature = "asset-triangle"))]
    let transform = Transform::from_scale(
        width as f32 / drawing.width as f32,
        height as f32 / drawing.height as f32,
    );
    // A one-control triangle must not acquire shear from rounded output ratios.
    #[cfg(feature = "asset-triangle")]
    let transform = {
        if drawing.shapes.iter().all(|shape| matches!(&shape.geometry, Geometry::Polygon(p) if p.len() == 3)) {
            let scale = (width as f32 / drawing.width as f32)
                .min(height as f32 / drawing.height as f32);
            Transform::from_row(scale, 0.0, 0.0, scale,
                (width as f32 - drawing.width as f32 * scale)/2.0,
                (height as f32 - drawing.height as f32 * scale)/2.0)
        } else {
            Transform::from_scale(width as f32 / drawing.width as f32, height as f32 / drawing.height as f32)
        }
    };

    for shape in &drawing.shapes {
        let mut paint = Paint::default();
        let color = shape.color;
        paint.set_color_rgba8(color.r, color.g, color.b, color.a);
        paint.anti_alias = true;
        // The low-precision pipeline divides by 255 with `(v + 255) >> 8`,
        // which rounds every blend up: deep stacks drift by about half a
        // level. The high-precision one blends in `f32` and rounds once
        // per layer, the composite the engine optimises.
        paint.force_hq_pipeline = true;

        match &shape.geometry {
            Geometry::Quadratic {
                start,
                control,
                end,
                width,
                cap,
            } => {
                let mut builder = PathBuilder::new();
                builder.move_to(start.x as f32, start.y as f32);
                builder.quad_to(
                    control.x as f32,
                    control.y as f32,
                    end.x as f32,
                    end.y as f32,
                );
                let Some(path) = builder.finish() else {
                    continue;
                };
                let stroke = Stroke {
                    width: *width as f32,
                    line_cap: match cap {
                        primeval_core::LineCap::Butt => LineCap::Butt,
                        primeval_core::LineCap::Round => LineCap::Round,
                        primeval_core::LineCap::Square => LineCap::Square,
                    },
                    ..Stroke::default()
                };
                pixmap.stroke_path(&path, &paint, &stroke, transform, None);
            }
            Geometry::Ellipse {
                cx, cy, rotation, ..
            } => {
                let Some(path) = fill_path(&shape.geometry) else {
                    continue;
                };
                let transform = ellipse_transform(transform, *cx as f32, *cy as f32, *rotation);
                pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);
            }
            Geometry::Rect { .. } | Geometry::Polygon(_) => {
                let Some(path) = fill_path(&shape.geometry) else {
                    continue;
                };
                pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);
            }
        }
    }
    Some(pixmap)
}

/// `base` pre-concatenated with the rotation by `rotation` degrees about
/// `(cx, cy)`, composed as tiny-skia's `Transform::from_rotate_at` composes
/// it but with the sine and cosine of [`primeval_core::sin_cos_degrees`]
/// instead of the platform's `f32::sin` and `f32::cos`, so that native and
/// WebAssembly builds draw the same pixels. A rotation of `0.0` gives
/// tiny-skia's transform bit for bit.
fn ellipse_transform(base: Transform, cx: f32, cy: f32, rotation: f64) -> Transform {
    let (sin, cos) = primeval_core::sin_cos_degrees(rotation);
    let (sin, cos) = (sin as f32, cos as f32);
    let rotate = Transform::from_row(cos, sin, -sin, cos, 0.0, 0.0);
    base.pre_concat(
        Transform::identity()
            .pre_translate(cx, cy)
            .pre_concat(rotate)
            .pre_translate(-cx, -cy),
    )
}

/// The unrotated outline of a filled geometry, in canvas coordinates.
fn fill_path(geometry: &Geometry) -> Option<Path> {
    match geometry {
        Geometry::Rect {
            x,
            y,
            width,
            height,
        } => Rect::from_xywh(*x as f32, *y as f32, *width as f32, *height as f32)
            .map(PathBuilder::from_rect),
        Geometry::Ellipse { cx, cy, rx, ry, .. } => PathBuilder::from_oval(Rect::from_ltrb(
            (cx - rx) as f32,
            (cy - ry) as f32,
            (cx + rx) as f32,
            (cy + ry) as f32,
        )?),
        Geometry::Polygon(points) => {
            let (first, rest) = points.split_first()?;
            let mut builder = PathBuilder::new();
            builder.move_to(first.x as f32, first.y as f32);
            for point in rest {
                builder.line_to(point.x as f32, point.y as f32);
            }
            builder.close();
            builder.finish()
        }
        Geometry::Quadratic { .. } => None,
    }
}

fn skia_color(color: Color) -> tiny_skia::Color {
    tiny_skia::Color::from_rgba8(color.r, color.g, color.b, color.a)
}

/// Encode opaque RGB8 pixels as a PNG image.
pub(crate) fn encode_png(width: u32, height: u32, rgb: &[u8]) -> image::ImageResult<Vec<u8>> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out).write_image(
        rgb,
        width,
        height,
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use primeval_core::{DrawnShape, LineCap, Point};

    const WHITE: Color = Color::new(255, 255, 255, 255);
    const RED: Color = Color::new(255, 0, 0, 255);

    fn drawing(shapes: Vec<DrawnShape>) -> Drawing {
        Drawing {
            width: 10,
            height: 10,
            background: WHITE,
            shapes,
        }
    }

    fn pixel(rgb: &[u8], width: u32, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * width + x) * 3) as usize;
        [rgb[i], rgb[i + 1], rgb[i + 2]]
    }

    #[test]
    fn output_has_the_requested_dimensions() {
        let rgb = render_rgb(&drawing(Vec::new()), 40, 25).expect("render");
        assert_eq!(rgb.len(), 40 * 25 * 3);
        assert!(rgb.iter().all(|&channel| channel == 255));
    }

    #[test]
    fn rect_covers_its_canvas_square_scaled() {
        // Canvas [2, 5) x [3, 7) at scale 4 is output [8, 20) x [12, 28).
        let rect = DrawnShape {
            geometry: Geometry::Rect {
                x: 2.0,
                y: 3.0,
                width: 3.0,
                height: 4.0,
            },
            color: RED,
        };
        let rgb = render_rgb(&drawing(vec![rect]), 40, 40).expect("render");

        for y in 0..40 {
            for x in 0..40 {
                let inside = (8..20).contains(&x) && (12..28).contains(&y);
                let expected = if inside { [255, 0, 0] } else { [255, 255, 255] };
                assert_eq!(pixel(&rgb, 40, x, y), expected, "({x}, {y})");
            }
        }
    }

    #[test]
    fn non_uniform_scale_stretches_like_the_svg_view_box() {
        // A 10 x 10 canvas onto 20 x 40: x doubles, y quadruples.
        let rect = DrawnShape {
            geometry: Geometry::Rect {
                x: 1.0,
                y: 1.0,
                width: 2.0,
                height: 2.0,
            },
            color: RED,
        };
        let rgb = render_rgb(&drawing(vec![rect]), 20, 40).expect("render");

        assert_eq!(pixel(&rgb, 20, 2, 4), [255, 0, 0]);
        assert_eq!(pixel(&rgb, 20, 5, 11), [255, 0, 0]);
        assert_eq!(pixel(&rgb, 20, 1, 4), [255, 255, 255]);
        assert_eq!(pixel(&rgb, 20, 6, 4), [255, 255, 255]);
        assert_eq!(pixel(&rgb, 20, 2, 3), [255, 255, 255]);
        assert_eq!(pixel(&rgb, 20, 2, 12), [255, 255, 255]);
    }

    #[test]
    fn every_geometry_kind_paints() {
        let shapes = [
            Geometry::Ellipse {
                cx: 5.0,
                cy: 5.0,
                rx: 3.0,
                ry: 1.5,
                rotation: 90.0,
            },
            Geometry::Polygon(vec![
                Point::new(1.0, 1.0),
                Point::new(9.0, 1.0),
                Point::new(5.0, 9.0),
            ]),
            Geometry::Quadratic {
                start: Point::new(1.0, 5.0),
                control: Point::new(5.0, 5.0),
                end: Point::new(9.0, 5.0),
                width: 1.0,
                cap: LineCap::Butt,
            },
        ];
        for geometry in shapes {
            let shape = DrawnShape {
                geometry: geometry.clone(),
                color: RED,
            };
            let rgb = render_rgb(&drawing(vec![shape]), 40, 40).expect("render");
            assert_eq!(pixel(&rgb, 40, 20, 20), [255, 0, 0], "{geometry:?}");
        }
    }

    /// A curve's cap reaches past its ends as tiny-skia strokes it: a
    /// round cap covers the centre line half a width past the start, but
    /// not the corner of the square cap.
    #[test]
    fn quadratic_caps_reach_past_the_ends() {
        let white = [255, 255, 255];
        let red = [255, 0, 0];
        for (cap, centre, corner) in [
            (LineCap::Butt, white, white),
            (LineCap::Round, red, white),
            (LineCap::Square, red, red),
        ] {
            let curve = DrawnShape {
                geometry: Geometry::Quadratic {
                    start: Point::new(3.0, 5.0),
                    control: Point::new(5.0, 5.0),
                    end: Point::new(7.0, 5.0),
                    width: 2.0,
                    cap,
                },
                color: RED,
            };
            let rgb = render_rgb(&drawing(vec![curve]), 40, 40).expect("render");
            // Output pixel (9, 20) is centred at canvas (2.375, 5.125), and
            // (8, 16) at (2.125, 4.125).
            assert_eq!(pixel(&rgb, 40, 9, 20), centre, "{cap:?}");
            assert_eq!(pixel(&rgb, 40, 8, 16), corner, "{cap:?}");
            assert_eq!(pixel(&rgb, 40, 20, 20), red, "{cap:?}");
        }
    }

    #[test]
    fn rotation_turns_the_ellipse_around_its_centre() {
        let ellipse = DrawnShape {
            geometry: Geometry::Ellipse {
                cx: 5.0,
                cy: 5.0,
                rx: 4.0,
                ry: 1.0,
                rotation: 90.0,
            },
            color: RED,
        };
        let rgb = render_rgb(&drawing(vec![ellipse]), 40, 40).expect("render");

        // Rotated by 90 degrees, the long axis is vertical.
        assert_eq!(pixel(&rgb, 40, 20, 6), [255, 0, 0]);
        assert_eq!(pixel(&rgb, 40, 6, 20), [255, 255, 255]);
    }

    #[test]
    fn ellipse_rotation_takes_the_portable_sine_and_cosine() {
        let bits = |t: Transform| [t.sx, t.ky, t.kx, t.sy, t.tx, t.ty].map(f32::to_bits);

        // A rotation of zero, signed or not, is tiny-skia's own, bit for
        // bit, under identity, canvas scaling and a general base transform,
        // with off-origin centres.
        for base in [
            Transform::identity(),
            Transform::from_scale(1.75, 0.625),
            Transform::from_row(1.5, 0.25, -0.5, 2.0, 7.0, -3.0),
        ] {
            for (cx, cy) in [(0.0, 0.0), (4.125, 7.75), (-3.25, 2.5)] {
                for angle in [0.0, -0.0] {
                    assert_eq!(
                        bits(ellipse_transform(base, cx, cy, angle)),
                        bits(base.pre_rotate_at(angle as f32, cx, cy)),
                        "angle {angle}, centre ({cx}, {cy}), base {base:?}"
                    );
                }
            }
        }

        // Any other rotation is built from `primeval_core::sin_cos_degrees`,
        // not the platform's trigonometry.
        for angle in [1.0, 13.125, 45.0, 90.0, 180.0, -47.8125, 428.375, -731.0625] {
            let (sin, cos) = primeval_core::sin_cos_degrees(angle);
            let (sin, cos) = (sin as f32, cos as f32);
            assert_eq!(
                bits(ellipse_transform(Transform::identity(), 0.0, 0.0, angle)),
                bits(Transform::from_row(cos, sin, -sin, cos, 0.0, 0.0)),
                "angle {angle}"
            );
        }
    }

    /// The 64-bit FNV-1a digest of `bytes`, as `primeval_core`'s tests
    /// digest a drawing.
    fn fnv(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        })
    }

    /// Axis-aligned ellipses and circles, rotation `0.0` or `-0.0`, which
    /// render exactly as with tiny-skia's own rotation.
    fn unrotated_drawing() -> Drawing {
        drawing(
            [
                (3.25, 4.5, 2.75, 1.125, 0.0, Color::new(230, 35, 80, 147)),
                (5.0, 5.0, 2.0, 2.0, 0.0, Color::new(20, 190, 75, 91)),
                (6.375, 5.75, 1.375, 3.0, 0.0, Color::new(45, 60, 225, 183)),
                (4.25, 6.5, 1.875, 1.875, 0.0, Color::new(210, 150, 20, 119)),
                (5.5, 3.75, 3.125, 0.875, -0.0, Color::new(75, 15, 180, 163)),
                (6.0, 4.25, 1.625, 1.625, -0.0, Color::new(30, 180, 210, 73)),
            ]
            .into_iter()
            .map(|(cx, cy, rx, ry, rotation, color)| DrawnShape {
                geometry: Geometry::Ellipse {
                    cx,
                    cy,
                    rx,
                    ry,
                    rotation,
                },
                color,
            })
            .collect(),
        )
    }

    #[test]
    fn raster_output_is_pinned() {
        let mut drawing = unrotated_drawing();
        drawing.shapes.extend([
            DrawnShape {
                geometry: Geometry::Rect {
                    x: 0.625,
                    y: 1.375,
                    width: 6.125,
                    height: 3.75,
                },
                color: Color::new(25, 110, 190, 137),
            },
            DrawnShape {
                geometry: Geometry::Polygon(vec![
                    Point::new(1.125, 1.875),
                    Point::new(8.375, 0.625),
                    Point::new(6.75, 4.125),
                    Point::new(9.125, 8.75),
                    Point::new(2.375, 7.625),
                ]),
                color: Color::new(210, 65, 35, 113),
            },
        ]);
        for (i, cap) in [LineCap::Butt, LineCap::Round, LineCap::Square]
            .into_iter()
            .enumerate()
        {
            let y = i as f64 * 2.375;
            drawing.shapes.push(DrawnShape {
                geometry: Geometry::Quadratic {
                    start: Point::new(0.875, 2.125 + y),
                    control: Point::new(4.625, -1.25 + y),
                    end: Point::new(8.75, 3.375 + y),
                    width: 0.625 + i as f64 * 0.25,
                    cap,
                },
                color: Color::new(80, 205, 45, 171),
            });
        }
        for (i, rotation) in [
            0.125, 13.731, 28.5625, 47.8123, 63.375, 89.9997, 112.9375, 145.625, 183.3125, 224.875,
            269.0625, 318.4375, 359.9999, -17.375, -428.125, 731.0625,
        ]
        .into_iter()
        .enumerate()
        {
            drawing.shapes.push(DrawnShape {
                geometry: Geometry::Ellipse {
                    cx: 1.25 + (i % 4) as f64 * 2.375,
                    cy: 1.375 + (i / 4) as f64 * 2.25,
                    rx: 1.875,
                    ry: 0.4375 + (i % 3) as f64 * 0.1875,
                    rotation,
                },
                color: Color::new(30 + i as u8 * 11, 220 - i as u8 * 9, 125, 97 + i as u8 * 7),
            });
        }
        let rgb = render_rgb(&drawing, 173, 149).expect("render");
        let digest = fnv(&rgb);
        // Portable rotation, pinned identically on aarch64 and x86_64.
        assert_eq!(digest, 2_885_471_127_306_215_023);
    }

    /// The exact composite of opaque `background` and the `layers` drawn over
    /// the whole canvas, each blend rounded to the 8-bit grid once:
    /// `round((1 − a) · d + a · s)` with `a = alpha / 255`.
    fn rounded_once(background: Color, layers: &[Color]) -> [f64; 3] {
        let mut canvas = [background.r, background.g, background.b].map(f64::from);
        for layer in layers {
            let a = f64::from(layer.a) / 255.0;
            let source = [layer.r, layer.g, layer.b].map(f64::from);
            for (d, s) in canvas.iter_mut().zip(source) {
                *d = ((1.0 - a) * *d + a * s).round();
            }
        }
        canvas
    }

    /// Deep stacks of translucent full-canvas layers render as the exact
    /// composite rounded once per layer: no edges, so only the blend
    /// arithmetic differs. Measured: an exact match (mean and RMSE 0).
    /// tiny-skia's low-precision pipeline is off by +0.5 levels on average
    /// here, because its `div255` rounds up.
    #[test]
    fn stacked_layers_match_the_composite_rounded_once() {
        // SplitMix64, so the stacks are fixed without a dependency.
        let mut state = 0x5eed_u64;
        let mut next = move || {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        };
        let mut byte = move || (next() >> 56) as u8;

        let (mut sum, mut squares, mut values) = (0.0, 0.0, 0.0);
        for _ in 0..300 {
            let background = Color::new(byte(), byte(), byte(), 255);
            let layers: Vec<Color> = (0..20)
                .map(|_| Color::new(byte(), byte(), byte(), byte().max(1)))
                .collect();
            let shapes = layers
                .iter()
                .map(|&color| DrawnShape {
                    geometry: Geometry::Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 2.0,
                        height: 2.0,
                    },
                    color,
                })
                .collect();
            let drawing = Drawing {
                width: 2,
                height: 2,
                background,
                shapes,
            };
            let rgb = render_rgb(&drawing, 2, 2).expect("render");
            let expected = rounded_once(background, &layers);
            for (&got, want) in rgb[..3].iter().zip(expected) {
                let error = f64::from(got) - want;
                sum += error;
                squares += error * error;
                values += 1.0;
            }
        }
        let (mean, rmse) = (sum / values, (squares / values).sqrt());
        assert!(mean.abs() < 0.1, "mean signed error {mean}");
        assert!(rmse < 0.5, "rmse {rmse}");
    }

    #[test]
    fn png_is_opaque_rgb() {
        let rgb = render_rgb(&drawing(Vec::new()), 4, 3).expect("render");
        let png = encode_png(4, 3, &rgb).expect("png");

        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        let decoded = image::load_from_memory(&png).expect("decode");
        assert_eq!(decoded.color(), image::ColorType::Rgb8);
        assert_eq!((decoded.width(), decoded.height()), (4, 3));
    }
}
