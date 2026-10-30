//! Core library for the primeval image approximation engine.
//!
//! The engine takes a target [`Buffer`] and a background colour and produces
//! a [`Drawing`]: the committed shapes as engine-independent geometry.
//! Decoding input and writing output live in `primeval-render`.
//!
//! The public surface is the [`Model`] that runs the search, its options
//! ([`ModelOptions`], [`ShapeKind`], [`Alpha`]), the pixel and colour types it
//! takes ([`Buffer`], [`Color`]), the [`Drawing`] it produces, and the joint
//! optimisation of its triangles, polygons and rectangles that can follow
//! it ([`joint`]).
//!
//! `docs/architecture.md` in the repository describes the engine's pipeline,
//! its determinism rules and how the crates fit together.

#![warn(missing_docs)]
// `clippy.toml` bans the methods whose results differ between platforms.
// Tests may use them as references, and the benches module allows the lint
// itself; the library is held to the ban in every clippy pass, the
// `--all-features` one included.
#![cfg_attr(test, allow(clippy::disallowed_methods))]

mod alpha;
#[cfg(feature = "bench")]
#[allow(clippy::disallowed_methods)] // benches may use the banned methods as references
mod benches;
mod buffer;
mod coarse;
mod color;
mod drawing;
mod error;
mod error_grid;
pub mod joint;
mod model;
mod optimize;
mod prefix;
mod raster;
mod refine;
mod rng;
mod scanline;
mod score;
#[cfg_attr(feature = "asset-triangle", allow(dead_code))]
mod shapes;
#[cfg(feature = "asset-triangle")]
mod asset_triangle;
mod state;
mod util;
mod worker;

#[cfg(test)]
mod test_util;

pub use alpha::Alpha;
pub use buffer::Buffer;
pub use color::Color;
pub use drawing::{Drawing, DrawnShape, Geometry, LineCap, Point};
pub use error::ParseError;
#[cfg(feature = "lab")]
pub use model::Search;
pub use model::{Model, ModelOptions};
pub use shapes::ShapeKind;
pub use util::sin_cos_degrees;
