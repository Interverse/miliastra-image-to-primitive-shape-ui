//! Turbo trace runner: the shipped Turbo fit with snapshots for failure tracing.
//!
//! ```text
//! cargo run --release -p primeval-render --features lab,asset-triangle --example turbo_trace -- \
//!     INPUT COUNT DETAIL SEED OUT_DIR EVERY [DISPLAY_SIZES]
//! ```
//!
//! Writes `target.png`; per snapshot `snap-<phase>-<steps>.png` (model composite at
//! the working size) and `.json` (every layer: kind, geometry, RGBA); at the end
//! `final.json`, `contributions.json` (loss increase if each final layer alone were
//! deleted) and `display-<size>.png`: the exported geometry rendered by the export
//! renderer at each comma-separated display size (default 1024,2048), never an
//! enlarged raster. Optional `PRIMEVAL_LAB_MAP`, `PRIMEVAL_LAB_LINES` as in `turbo_lab`.

use primeval_core::Geometry;
use primeval_render::{ApproximateRequest, Execution, OutputFormat, RenderOptions, ShapeKind};
use std::fmt::Write as _;

fn layers_json(drawing: &primeval_core::Drawing) -> String {
    let mut out = format!("{{\"width\":{},\"height\":{},\"layers\":[", drawing.width, drawing.height);
    for (i, shape) in drawing.shapes.iter().enumerate() {
        let c = shape.color;
        let geometry = match &shape.geometry {
            Geometry::Ellipse { cx, cy, rx, ry, rotation } => format!("\"kind\":\"ellipse\",\"g\":[{cx},{cy},{rx},{ry},{rotation}]"),
            Geometry::Polygon(points) => {
                let flat: Vec<String> = points.iter().map(|p| format!("{},{}", p.x, p.y)).collect();
                format!("\"kind\":\"polygon\",\"g\":[{}]", flat.join(","))
            }
            other => format!("\"kind\":\"other\",\"debug\":{:?}", format!("{other:?}")),
        };
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{{{geometry},\"rgba\":[{},{},{},{}]}}", c.r, c.g, c.b, c.a);
    }
    out.push_str("]}");
    out
}

fn save_premultiplied(path: &std::path::Path, width: u32, height: u32, pixels: &[[f64; 4]]) {
    let mut png = image::RgbaImage::new(width, height);
    for (p, c) in png.pixels_mut().zip(pixels) {
        let a = c[3].clamp(0.0, 1.0);
        let straight = |v: f64| if a > 0.0 { (v / a * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 };
        *p = image::Rgba([straight(c[0]), straight(c[1]), straight(c[2]), (a * 255.0).round() as u8]);
    }
    png.save(path).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(args.len() >= 6, "usage: INPUT COUNT DETAIL SEED OUT_DIR EVERY [DISPLAY_SIZES]");
    let input = std::fs::read(&args[0]).expect("read input");
    let (count, detail, seed, every): (u32, u32, u64, usize) =
        (args[1].parse().unwrap(), args[2].parse().unwrap(), args[3].parse().unwrap(), args[5].parse().unwrap());
    let out = std::path::PathBuf::from(&args[4]);
    let sizes: Vec<u32> = args.get(6).map_or("1024,2048", String::as_str).split(',').map(|v| v.parse().unwrap()).collect();
    std::fs::create_dir_all(&out).unwrap();
    let (width, height, target) = primeval_render::lab::turbo_target(&input, detail).expect("target");
    save_premultiplied(&out.join("target.png"), width, height, &target);

    let mut render = RenderOptions::default();
    render.shape = ShapeKind::Mixed;
    render.count = count;
    render.resize_input = detail;
    render.seed = Some(seed);
    let mut execution = Execution::new();
    if let Ok(path) = std::env::var("PRIMEVAL_LAB_MAP") {
        let text = std::fs::read_to_string(path).unwrap();
        let numbers: Vec<f64> = text.split_whitespace().map(|v| v.parse().unwrap()).collect();
        let values: Vec<f32> = numbers[5..].iter().map(|v| *v as f32).collect();
        execution = execution.attention_terms(numbers[0] as usize, numbers[1] as usize, values, numbers[2], numbers[3], numbers[4]);
    }
    if let Ok(params) = std::env::var("PRIMEVAL_LAB_PARAMS") {
        // "name=value,name=value"
        let params = params.split(',').filter(|p| !p.is_empty()).map(|p| {
            let (k, v) = p.split_once('=').unwrap();
            (k.to_string(), v.parse().unwrap())
        });
        execution = execution.lab_params(params.collect());
    }
    if let Ok(lines) = std::env::var("PRIMEVAL_LAB_LINES") {
        execution = execution.line_proposals(lines.parse().unwrap());
    }
    let mut contributions = Vec::new();
    let mut observe = |phase: &str, steps: usize, model: &primeval_core::rgba::RgbaModel| {
        let name = format!("snap-{phase}-{steps:05}");
        save_premultiplied(&out.join(format!("{name}.png")), width, height, model.current_pixels());
        std::fs::write(out.join(format!("{name}.json")), layers_json(&model.snapshot())).unwrap();
        if phase == "gaps" {
            contributions = model.lab_removal_costs();
        }
    };
    let start = std::time::Instant::now();
    let drawing = primeval_render::lab::turbo_traced(
        ApproximateRequest { input, output: OutputFormat::Png, render },
        execution,
        every,
        &mut observe,
    )
    .expect("fit");
    let seconds = start.elapsed().as_secs_f64();
    std::fs::write(out.join("final.json"), layers_json(&drawing)).unwrap();
    std::fs::write(out.join("contributions.json"), format!("{contributions:?}")).unwrap();
    let rendered = primeval_render::render_drawing(&drawing, width.max(height), OutputFormat::Png).expect("render");
    std::fs::write(out.join("output.png"), rendered.into_bytes()).unwrap();
    for size in sizes {
        let rendered = primeval_render::render_drawing(&drawing, size, OutputFormat::Png).expect("render");
        std::fs::write(out.join(format!("display-{size}.png")), rendered.into_bytes()).unwrap();
    }
    std::fs::write(out.join("run.json"), format!("{{\"seconds\":{seconds},\"shapes\":{},\"width\":{width},\"height\":{height}}}", drawing.shapes.len())).unwrap();
    println!("{seconds:.2}s");
}
