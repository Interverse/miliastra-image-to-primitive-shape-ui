//! SVG writer for a [`Drawing`].

use primeval_core::{Color, Drawing, Geometry, LineCap, Point};
use std::fmt::Write;

/// Write `drawing` as an SVG document of `width` × `height` output pixels.
///
/// Shapes stay in canvas coordinates: the `viewBox` is the canvas, scaled onto
/// the output size. The default `preserveAspectRatio` keeps the document from
/// being distorted when a container imposes another aspect ratio; at its own
/// size it differs from the raster writer's per-axis scale by less than one
/// output pixel, which comes only from rounding the output size.
///
/// The cap of the first quadratic curve, or [`LineCap::default`], round,
/// when the drawing has none, is written once on the root element as
/// `stroke-linecap`, which every path inherits: the engine gives every
/// curve of a drawing the same cap. A drawing without curves carries it
/// too, so that a preview that wraps progress shapes in the final
/// document's root draws curves as the document does. Butt, SVG's own
/// default, is expressed by writing no attribute. A curve with another cap
/// than the root's carries its own.
pub(crate) fn write_svg(drawing: &Drawing, width: u32, height: u32) -> String {
    let mut svg = String::with_capacity(128 + drawing.shapes.len() * 96);
    let root_cap = drawing
        .shapes
        .iter()
        .find_map(|shape| match shape.geometry {
            Geometry::Quadratic { cap, .. } => Some(cap),
            _ => None,
        })
        .unwrap_or_default();
    // Writing into a String cannot fail.
    let _ = writeln!(
        svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" \
         viewBox=\"0 0 {} {}\"{}>",
        drawing.width,
        drawing.height,
        linecap(root_cap, LineCap::Butt)
    );
    let _ = writeln!(
        svg,
        "<rect width=\"{}\" height=\"{}\" fill=\"{}\"/>",
        drawing.width,
        drawing.height,
        hex(drawing.background)
    );
    for shape in &drawing.shapes {
        write_shape(&mut svg, &shape.geometry, shape.color, root_cap);
        svg.push('\n');
    }
    svg.push_str("</svg>\n");
    svg
}

/// The SVG element of one shape, exactly as its line in [`write_svg`]'s
/// output, without the newline. A quadratic curve's cap is not written:
/// [`write_svg`] writes it on the root element, so a preview takes its
/// root from the final document.
pub(crate) fn shape_element(geometry: &Geometry, color: Color) -> String {
    let mut element = String::with_capacity(96);
    let cap = match geometry {
        Geometry::Quadratic { cap, .. } => *cap,
        _ => LineCap::Butt,
    };
    write_shape(&mut element, geometry, color, cap);
    element
}

/// Append the element of one shape to `svg`, without a newline; a
/// quadratic curve whose cap is not `root_cap`, the cap its root element
/// gives it, carries its own.
fn write_shape(svg: &mut String, geometry: &Geometry, color: Color, root_cap: LineCap) {
    let precise = cfg!(feature = "asset-triangle") && matches!(geometry, Geometry::Polygon(p) if p.len() == 3);
    let fill = if precise { paint_at("fill", color, true) } else { paint("fill", color) };
    let num = |value| num_at(value, precise);
    let _ = match geometry {
        Geometry::Rect {
            x,
            y,
            width,
            height,
        } => write!(
            svg,
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"{fill}/>",
            num(*x),
            num(*y),
            num(*width),
            num(*height)
        ),
        // A circle looks the same at any rotation.
        Geometry::Ellipse { cx, cy, rx, ry, .. } if rx == ry => write!(
            svg,
            "<circle cx=\"{}\" cy=\"{}\" r=\"{}\"{fill}/>",
            num(*cx),
            num(*cy),
            num(*rx)
        ),
        Geometry::Ellipse {
            cx,
            cy,
            rx,
            ry,
            rotation,
        } => {
            let rotation = rotation.rem_euclid(360.0);
            let transform = if num(rotation) == "0" || num(rotation) == "360" {
                String::new()
            } else {
                format!(
                    " transform=\"rotate({} {} {})\"",
                    num(rotation),
                    num(*cx),
                    num(*cy)
                )
            };
            write!(
                svg,
                "<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\"{transform}{fill}/>",
                num(*cx),
                num(*cy),
                num(*rx),
                num(*ry)
            )
        }
        Geometry::Polygon(points) => {
            let points = points
                .iter()
                .map(|point| format!("{},{}", num(point.x), num(point.y)))
                .collect::<Vec<_>>()
                .join(" ");
            write!(svg, "<polygon points=\"{points}\"{fill}/>")
        }
        Geometry::Quadratic {
            start,
            control,
            end,
            width,
            cap,
        } => write!(
            svg,
            "<path d=\"M{} Q{} {}\" fill=\"none\"{} stroke-width=\"{}\"{}/>",
            pair(*start),
            pair(*control),
            pair(*end),
            paint("stroke", color),
            num(*width),
            linecap(*cap, root_cap)
        ),
    };
}

/// ` stroke-linecap="…"` for `cap`, or nothing when the element inherits
/// it: when it is `inherited`.
fn linecap(cap: LineCap, inherited: LineCap) -> String {
    if cap == inherited {
        String::new()
    } else {
        format!(" stroke-linecap=\"{}\"", cap.as_str())
    }
}

/// ` {attribute}="#rrggbb"`, plus ` {attribute}-opacity` unless opaque.
fn paint(attribute: &str, color: Color) -> String {
    paint_at(attribute, color, false)
}

fn paint_at(attribute: &str, color: Color, precise: bool) -> String {
    if color.a == 255 {
        format!(" {attribute}=\"{}\"", hex(color))
    } else {
        format!(
            " {attribute}=\"{}\" {attribute}-opacity=\"{}\"",
            hex(color),
            num_at(f64::from(color.a) / 255.0, precise)
        )
    }
}

fn hex(color: Color) -> String {
    format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b)
}

fn pair(point: Point) -> String {
    format!("{} {}", num(point.x), num(point.y))
}

/// Format a number with at most 3 decimals, without trailing zeros or a
/// trailing dot: `12`, `12.5`, `0.125`.
fn num(value: f64) -> String {
    num_at(value, false)
}

fn num_at(value: f64, precise: bool) -> String {
    let mut text = if precise { format!("{value:.12}") } else { format!("{value:.3}") };
    if text.contains('.') {
        let trimmed = text.trim_end_matches('0').trim_end_matches('.').len();
        text.truncate(trimmed);
    }
    if text == "-0" {
        text.remove(0);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use primeval_core::{DrawnShape, LineCap};

    /// Every channel value survives `hex` and `Color::from_hex`, in both
    /// letter cases; the SVG writer drops alpha, which `from_hex` sets to 255.
    #[test]
    fn hex_colours_round_trip_through_from_hex() {
        for value in 0..=255_u8 {
            let color = Color::new(value, value.wrapping_mul(7), 255 - value, value);
            let opaque = Color { a: 255, ..color };
            let text = hex(color);
            assert_eq!(Color::from_hex(&text), Some(opaque), "{text}");
            assert_eq!(
                Color::from_hex(&text.to_uppercase()),
                Some(opaque),
                "{text}"
            );
            assert_eq!(
                Color::from_hex(text.trim_start_matches('#')),
                Some(opaque),
                "{text}"
            );
        }
    }

    fn drawing(shapes: Vec<DrawnShape>) -> Drawing {
        Drawing {
            width: 40,
            height: 30,
            background: Color::new(0x12, 0x34, 0x56, 255),
            shapes,
        }
    }

    fn shape(geometry: Geometry) -> DrawnShape {
        DrawnShape {
            geometry,
            color: Color::new(255, 0, 128, 128),
        }
    }

    /// The SVG line for a single shape.
    fn element(geometry: Geometry) -> String {
        let svg = write_svg(&drawing(vec![shape(geometry)]), 400, 300);
        svg.lines().nth(2).expect("shape line").to_string()
    }

    #[test]
    fn num_trims_to_three_decimals() {
        assert_eq!(num(12.0), "12");
        assert_eq!(num(12.5), "12.5");
        assert_eq!(num(0.125), "0.125");
        assert_eq!(num(0.12345), "0.123");
        assert_eq!(num(1.9999), "2");
        assert_eq!(num(-0.0001), "0");
        assert_eq!(num(-3.25), "-3.25");
        assert_eq!(num(100.0), "100");
    }

    #[test]
    fn document_maps_the_canvas_onto_the_output_size() {
        let svg = write_svg(&drawing(Vec::new()), 400, 300);
        assert_eq!(
            svg,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"300\" \
             viewBox=\"0 0 40 30\" stroke-linecap=\"round\">\n\
             <rect width=\"40\" height=\"30\" fill=\"#123456\"/>\n\
             </svg>\n"
        );
    }

    /// A drawing without curves has the engine's default cap, round, on its
    /// root all the same, so that a preview wrapping progress shapes in
    /// that root draws later curves as the final document does.
    #[test]
    fn a_drawing_without_curves_has_round_caps_on_its_root() {
        let svg = write_svg(
            &drawing(vec![shape(Geometry::Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            })]),
            400,
            300,
        );
        assert_eq!(
            svg.lines().next(),
            Some(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"300\" \
                 viewBox=\"0 0 40 30\" stroke-linecap=\"round\">"
            )
        );
        assert_eq!(svg.matches("stroke-linecap").count(), 1);
    }

    #[test]
    fn rect_element() {
        assert_eq!(
            element(Geometry::Rect {
                x: 2.0,
                y: 3.0,
                width: 3.0,
                height: 4.0,
            }),
            "<rect x=\"2\" y=\"3\" width=\"3\" height=\"4\" fill=\"#ff0080\" fill-opacity=\"0.502\"/>"
        );
    }

    #[test]
    fn equal_radii_become_a_circle() {
        assert_eq!(
            element(Geometry::Ellipse {
                cx: 10.5,
                cy: 20.5,
                rx: 7.0,
                ry: 7.0,
                rotation: 30.0,
            }),
            "<circle cx=\"10.5\" cy=\"20.5\" r=\"7\" fill=\"#ff0080\" fill-opacity=\"0.502\"/>"
        );
    }

    #[test]
    fn unrotated_ellipse_has_no_transform() {
        assert_eq!(
            element(Geometry::Ellipse {
                cx: 10.5,
                cy: 20.5,
                rx: 7.0,
                ry: 3.0,
                rotation: 720.0,
            }),
            "<ellipse cx=\"10.5\" cy=\"20.5\" rx=\"7\" ry=\"3\" fill=\"#ff0080\" fill-opacity=\"0.502\"/>"
        );
    }

    #[test]
    fn rotated_ellipse_rotates_around_its_centre() {
        assert_eq!(
            element(Geometry::Ellipse {
                cx: 10.25,
                cy: 20.0,
                rx: 7.5,
                ry: 3.125,
                rotation: -30.0,
            }),
            "<ellipse cx=\"10.25\" cy=\"20\" rx=\"7.5\" ry=\"3.125\" \
             transform=\"rotate(330 10.25 20)\" fill=\"#ff0080\" fill-opacity=\"0.502\"/>"
        );
    }

    #[test]
    fn polygon_element() {
        assert_eq!(
            element(Geometry::Polygon(vec![
                Point::new(1.5, 2.5),
                Point::new(10.0, 0.125),
                Point::new(-3.0, 7.0),
            ])),
            "<polygon points=\"1.5,2.5 10,0.125 -3,7\" fill=\"#ff0080\" fill-opacity=\"0.502\"/>"
        );
    }

    #[test]
    fn quadratic_is_a_stroked_path() {
        assert_eq!(
            element(Geometry::Quadratic {
                start: Point::new(1.0, 2.0),
                control: Point::new(3.5, 4.0),
                end: Point::new(5.0, 6.25),
                width: 0.5,
                cap: LineCap::Butt,
            }),
            "<path d=\"M1 2 Q3.5 4 5 6.25\" fill=\"none\" stroke=\"#ff0080\" \
             stroke-opacity=\"0.502\" stroke-width=\"0.5\"/>"
        );
    }

    fn curve(cap: LineCap) -> DrawnShape {
        shape(Geometry::Quadratic {
            start: Point::new(1.0, 2.0),
            control: Point::new(3.5, 4.0),
            end: Point::new(5.0, 6.25),
            width: 2.0,
            cap,
        })
    }

    /// A drawing whose curves have round or square caps says so once, on
    /// the root element, which every path inherits; butt caps, SVG's
    /// default, are not written.
    #[test]
    fn quadratic_caps_are_written_once_on_the_root() {
        let path = "<path d=\"M1 2 Q3.5 4 5 6.25\" fill=\"none\" stroke=\"#ff0080\" \
                    stroke-opacity=\"0.502\" stroke-width=\"2\"/>";
        for (cap, attribute) in [
            (LineCap::Butt, ""),
            (LineCap::Round, " stroke-linecap=\"round\""),
            (LineCap::Square, " stroke-linecap=\"square\""),
        ] {
            let svg = write_svg(&drawing(vec![curve(cap), curve(cap)]), 400, 300);
            let lines: Vec<&str> = svg.lines().collect();
            assert_eq!(
                lines[0],
                format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"300\" \
                     viewBox=\"0 0 40 30\"{attribute}>"
                ),
                "{cap:?}"
            );
            assert_eq!(lines[2..4], [path, path], "{cap:?}");
            assert_eq!(
                svg.matches("stroke-linecap").count(),
                usize::from(cap != LineCap::Butt)
            );
        }
    }

    /// A curve whose cap is not the root's, which the engine never draws,
    /// carries its own.
    #[test]
    fn a_curve_with_another_cap_than_the_first_carries_its_own() {
        let svg = write_svg(
            &drawing(vec![
                curve(LineCap::Round),
                curve(LineCap::Butt),
                curve(LineCap::Square),
            ]),
            400,
            300,
        );
        let lines: Vec<&str> = svg.lines().collect();
        assert!(
            lines[0].ends_with(" stroke-linecap=\"round\">"),
            "{}",
            lines[0]
        );
        assert!(!lines[2].contains("stroke-linecap"), "{}", lines[2]);
        assert!(
            lines[3].ends_with(" stroke-linecap=\"butt\"/>"),
            "{}",
            lines[3]
        );
        assert!(
            lines[4].ends_with(" stroke-linecap=\"square\"/>"),
            "{}",
            lines[4]
        );
    }

    #[test]
    fn opaque_shapes_omit_the_opacity() {
        let svg = write_svg(
            &drawing(vec![DrawnShape {
                geometry: Geometry::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                color: Color::new(1, 2, 3, 255),
            }]),
            40,
            30,
        );
        assert!(svg.contains("<rect x=\"0\" y=\"0\" width=\"1\" height=\"1\" fill=\"#010203\"/>"));
    }
}
