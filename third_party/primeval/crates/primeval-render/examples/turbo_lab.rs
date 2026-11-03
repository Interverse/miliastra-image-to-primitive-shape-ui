//! Turbo research runner: one native fit, its working target and output PNGs.
//!
//! ```text
//! cargo run --release -p primeval-render --features lab,asset-triangle --example turbo_lab -- \
//!     INPUT COUNT DETAIL SEED OUT_DIR
//! ```
//!
//! Optional environment: `PRIMEVAL_LAB_MAP` (attention map: "width height strength
//! additive refine" then the values), `PRIMEVAL_LAB_LINES` (experimental line
//! proposal variant, 0 = off). Writes `target.png`, `output.png`, `drawing.json`
//! and `run.json` (seconds, score, shape count).

use primeval_render::{ApproximateRequest, Execution, OutputFormat, RenderOptions, ShapeKind};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(args.len() == 5, "usage: INPUT COUNT DETAIL SEED OUT_DIR");
    let input = std::fs::read(&args[0]).expect("read input");
    let (count, detail, seed): (u32, u32, u64) = (args[1].parse().unwrap(), args[2].parse().unwrap(), args[3].parse().unwrap());
    let out = std::path::PathBuf::from(&args[4]);
    std::fs::create_dir_all(&out).unwrap();

    let (width, height, target) = primeval_render::lab::turbo_target(&input, detail).expect("target");
    let mut png = image::RgbaImage::new(width, height);
    for (p, t) in png.pixels_mut().zip(&target) {
        let a = t[3].clamp(0.0, 1.0);
        let straight = |v: f64| if a > 0.0 { (v / a * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 };
        *p = image::Rgba([straight(t[0]), straight(t[1]), straight(t[2]), (a * 255.0).round() as u8]);
    }
    png.save(out.join("target.png")).unwrap();
    if std::env::var("PRIMEVAL_LAB_DUMP").is_ok() {
        let model = primeval_core::rgba::RgbaModel::new(width, height, target.clone(), Some(seed));
        let lines: Vec<String> = model.debug_line_primitives().iter().map(|p| format!("{p:?}")).collect();
        std::fs::write(out.join("primitives.txt"), lines.join("
")).unwrap();
        return;
    }

    let mut render = RenderOptions::default();
    render.shape = ShapeKind::Mixed;
    render.count = count;
    render.resize_input = detail;
    render.seed = Some(seed);
    let mut execution = Execution::new().turbo(true);
    if let Ok(path) = std::env::var("PRIMEVAL_LAB_MAP") {
        let text = std::fs::read_to_string(path).unwrap();
        let mut numbers = text.split_whitespace().map(|v| v.parse::<f64>().unwrap());
        let mut next = || numbers.next().unwrap();
        let (mw, mh, strength, additive, refine) = (next() as usize, next() as usize, next(), next(), next());
        let values: Vec<f32> = numbers.map(|v| v as f32).collect();
        execution = execution.attention_terms(mw, mh, values, strength, additive, refine);
    }
    if let Ok(cap) = std::env::var("PRIMEVAL_LAB_ASPECT") {
        execution = execution.rect_aspect(Some(cap.parse().unwrap()));
    }
    if let Ok(angle) = std::env::var("PRIMEVAL_LAB_TRIANGLE") {
        execution = execution.triangle_angle(Some(angle.parse().unwrap()));
    }
    if let Ok(schedule) = std::env::var("PRIMEVAL_LAB_EXTRA") {
        // "EXTRA:SHARE", e.g. "8:0.25": eight more rounds for the first quarter of steps.
        let (extra, share) = schedule.split_once(':').unwrap();
        execution = execution.extra_rounds(Some((extra.parse().unwrap(), share.parse().unwrap())));
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
    // Weighted search score every 10 steps (before refinement).
    let mut trace = Vec::new();
    let mut progress = |info: primeval_render::ProgressInfo| {
        if info.refinement.is_none() && info.step % 10 == 0 {
            trace.push(info.score);
        }
    };
    let execution = execution.progress(&mut progress);
    let start = Instant::now();
    let drawing = primeval_render::approximate_drawing(ApproximateRequest { input, output: OutputFormat::Png, render }, execution).expect("fit");
    let seconds = start.elapsed().as_secs_f64();
    let rendered = primeval_render::render_drawing(&drawing, width.max(height), OutputFormat::Png).expect("render");
    std::fs::write(out.join("output.png"), rendered.into_bytes()).unwrap();
    std::fs::write(out.join("drawing.json"), format!("{:?}", drawing.shapes)).unwrap();
    // Exported geometry rendered at display sizes (never an enlarged raster).
    if let Ok(sizes) = std::env::var("PRIMEVAL_LAB_DISPLAY") {
        for size in sizes.split(',').map(|v| v.parse::<u32>().unwrap()) {
            let rendered = primeval_render::render_drawing(&drawing, size, OutputFormat::Png).expect("render");
            std::fs::write(out.join(format!("display-{size}.png")), rendered.into_bytes()).unwrap();
        }
    }
    std::fs::write(out.join("run.json"), format!("{{\"seconds\":{seconds},\"shapes\":{},\"width\":{width},\"height\":{height},\"trace\":{trace:?}}}", drawing.shapes.len())).unwrap();
    println!("{seconds:.2}s");
}
