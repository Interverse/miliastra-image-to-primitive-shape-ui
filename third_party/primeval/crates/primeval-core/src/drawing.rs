//! The engine boundary: an ordered list of committed shapes in continuous
//! canvas coordinates.
//!
//! The engine produces a [`Drawing`]; output writers (SVG, raster) consume it.
//! Nothing here depends on how the engine searched for the shapes, so another
//! engine can produce the same type.
//!
//! Coordinates are continuous canvas coordinates at working resolution: pixel
//! `(i, j)` is the unit square `[i, i + 1) × [j, j + 1)`.

use crate::{Color, ParseError};
use std::str::FromStr;

/// A point in continuous canvas coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    /// Horizontal position, growing to the right.
    pub x: f64,
    /// Vertical position, growing downwards.
    pub y: f64,
}

impl Point {
    /// The point `(x, y)`.
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// Engine-independent geometry of one committed shape.
#[derive(Clone, Debug, PartialEq)]
pub enum Geometry {
    /// Axis-aligned filled rectangle.
    Rect {
        /// Left edge.
        x: f64,
        /// Top edge.
        y: f64,
        /// Width.
        width: f64,
        /// Height.
        height: f64,
    },
    /// Filled ellipse centred at `(cx, cy)`, rotated clockwise by `rotation`
    /// degrees (the SVG `rotate()` direction in a y-down canvas).
    Ellipse {
        /// Horizontal position of the centre.
        cx: f64,
        /// Vertical position of the centre.
        cy: f64,
        /// Radius along the ellipse's own x axis, before rotation.
        rx: f64,
        /// Radius along the ellipse's own y axis, before rotation.
        ry: f64,
        /// Clockwise rotation in degrees.
        rotation: f64,
    },
    /// Closed filled polygon through the vertices in order.
    ///
    /// The SVG and PNG writers fill it with the non-zero rule and the engine
    /// rasterises it with the even-odd rule. The engine's polygons have at
    /// most four vertices, so no point is enclosed twice and both rules
    /// give the same fill.
    Polygon(Vec<Point>),
    /// Stroked quadratic Bézier curve, its two ends drawn as `cap`.
    Quadratic {
        /// Where the curve starts.
        start: Point,
        /// The control point, which the curve bends towards.
        control: Point,
        /// Where the curve ends.
        end: Point,
        /// Stroke width.
        width: f64,
        /// How the stroke ends at `start` and `end`. The engine gives every
        /// quadratic of a drawing the same cap.
        cap: LineCap,
    },
}

/// How a stroke ends, as SVG's `stroke-linecap`. The default is the
/// engine's cap, round, with which it draws every quadratic curve; SVG's
/// own default is butt, which the SVG writer expresses by writing no
/// attribute.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineCap {
    /// Flat, across the stroke at its end point: the stroke stops there.
    Butt,
    /// A half-disc of the stroke's width centred on the end point: the
    /// stroke covers every point within half its width of the curve.
    #[default]
    Round,
    /// Flat, half the stroke's width past the end point along the curve's
    /// direction there.
    Square,
}

/// Every [`LineCap`] with its name, in declaration order, so
/// `CAP_NAMES[cap as usize]` is `cap`'s row: [`LineCap::as_str`] and
/// [`FromStr`] both read it.
const CAP_NAMES: [(LineCap, &str); 3] = [
    (LineCap::Butt, "butt"),
    (LineCap::Round, "round"),
    (LineCap::Square, "square"),
];

impl LineCap {
    /// The name, SVG's `stroke-linecap` value: `"butt"`, `"round"` or
    /// `"square"`. [`FromStr`] parses it back.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        CAP_NAMES[self as usize].1
    }
}

impl FromStr for LineCap {
    type Err = ParseError;

    /// Parses a name (see [`LineCap::as_str`]); anything else is an error
    /// whose message lists the names.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        CAP_NAMES
            .iter()
            .find(|(_, name)| *name == value)
            .map(|&(cap, _)| cap)
            .ok_or_else(|| ParseError::new("cap must be one of: butt, round, square"))
    }
}

/// One committed shape: its geometry and its colour. `color.a` is the opacity.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnShape {
    /// Where the shape is painted.
    pub geometry: Geometry,
    /// The shape's colour; `a` is its opacity.
    pub color: Color,
}

/// What the engine hands to output writers.
#[derive(Clone, Debug, PartialEq)]
pub struct Drawing {
    /// Canvas width in working-resolution units.
    pub width: u32,
    /// Canvas height in working-resolution units.
    pub height: u32,
    /// Opaque background colour (alpha 255).
    pub background: Color,
    /// Shapes in paint order.
    pub shapes: Vec<DrawnShape>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every cap's name is SVG's `stroke-linecap` value and parses back;
    /// anything else is refused with the accepted names.
    #[test]
    fn line_cap_names_are_svgs_and_parse_back() {
        let caps = [LineCap::Butt, LineCap::Round, LineCap::Square];
        assert_eq!(caps.map(LineCap::as_str), ["butt", "round", "square"]);
        for cap in caps {
            assert_eq!(cap.as_str().parse(), Ok(cap));
        }
        let refused = "bevel".parse::<LineCap>().expect_err("not a cap");
        assert_eq!(refused.message(), "cap must be one of: butt, round, square");
    }
}
