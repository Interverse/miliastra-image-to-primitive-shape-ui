//! Render an image as SVG.
//!
//! Usage: `cargo run --example render_svg -- <input> [output.svg]`
//!
//! Writes the SVG to the output path, or to stdout when it is omitted.
//! Progress is reported on stderr.

use primeval_render::{
    ApproximateRequest, ApproximateResult, CancellationToken, Execution, OutputFormat,
    ProgressInfo, RenderOptions, approximate,
};
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        eprintln!("usage: render_svg <input> [output.svg]");
        std::process::exit(2);
    };
    let output = args.next();

    let mut render = RenderOptions::default();
    render.count = 100;
    render.resize_input = 128;
    render.output_size = 512;

    let mut on_progress = |info: ProgressInfo| eprintln!("step {}/{}", info.step, info.total);
    // Call `cancel()` on a clone of this token from another thread to abort
    // the render between steps.
    let token = CancellationToken::new();
    let result = approximate(
        ApproximateRequest {
            input: std::fs::read(&input)?,
            output: OutputFormat::Svg,
            render,
        },
        Execution::new()
            .progress(&mut on_progress)
            .cancellation(&token),
    )?;

    let ApproximateResult::Svg { data, .. } = result else {
        unreachable!("requested svg output");
    };
    match output {
        Some(path) => std::fs::write(path, data)?,
        None => std::io::stdout().write_all(data.as_bytes())?,
    }

    Ok(())
}
