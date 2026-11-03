//! Fixed-budget portfolio + local shape-family reconsideration.
//! No source-alpha mask and no extra masking/background shape is introduced.
use crate::*;
use primeval_core::rgba::RgbaModel;

#[derive(Clone, Copy, Debug)]
struct Score {
    loss: f64,
    opaque: f64,
    spill: f64,
}
fn score(
    drawing: &Drawing,
    target: &[[f32; 4]],
    width: u32,
    height: u32,
) -> Result<Score, ApproximateError> {
    let pixels = raster::render_rgba(drawing, width, height)
        .ok_or_else(|| ApproximateError::internal("mixed score raster allocation failed"))?;
    let mut score = Score {
        loss: 0.0,
        opaque: 0.0,
        spill: 0.0,
    };
    for (t, p) in target.iter().zip(pixels.chunks_exact(4)) {
        let t = t.map(f64::from);
        let a = f64::from(p[3]) / 255.0;
        if t[3] == 0.0 {
            score.spill += a;
        }
        for c in 0..3 {
            let d = t[c] - f64::from(p[c]) / 255.0 * a;
            score.loss += d * d + (d + a - t[3]) * (d + a - t[3]);
            if t[3] >= 254.0 / 255.0 {
                score.opaque += d * d;
            }
        }
    }
    Ok(score)
}
pub(super) fn target(input: &[u8], width: u32, height: u32) -> Result<Vec<[f64; 4]>, ApproximateError> {
    Ok(target_f32(input, width, height)?
        .into_iter()
        .map(|p| p.map(f64::from))
        .collect())
}
// Keep the output-resolution guard in f32 storage, promoting each pixel for
// scoring. This avoids a second full-size f64 image alongside the fit target.
fn target_f32(input: &[u8], width: u32, height: u32) -> Result<Vec<[f32; 4]>, ApproximateError> {
    let source = decode_input(input)?.into_rgba8();
    if source.dimensions() == (width, height) {
        return Ok(source
            .pixels()
            .map(|p| {
                let a = f32::from(p[3]) / 255.0;
                [
                    f32::from(p[0]) / 255.0 * a,
                    f32::from(p[1]) / 255.0 * a,
                    f32::from(p[2]) / 255.0 * a,
                    a,
                ]
            })
            .collect());
    }
    let mut image = image::Rgba32FImage::new(source.width(), source.height());
    for (p, s) in image.pixels_mut().zip(source.pixels()) {
        let a = f32::from(s[3]) / 255.0;
        *p = image::Rgba([
            f32::from(s[0]) / 255.0 * a,
            f32::from(s[1]) / 255.0 * a,
            f32::from(s[2]) / 255.0 * a,
            a,
        ]);
    }
    Ok(image::imageops::resize(
        &image,
        width,
        height,
        image::imageops::FilterType::CatmullRom,
    )
    .pixels()
    .map(|p| {
        let a = p[3].clamp(0.0, 1.0);
        [
            p[0].clamp(0.0, a),
            p[1].clamp(0.0, a),
            p[2].clamp(0.0, a),
            a,
        ]
    })
    .collect())
}
pub(super) fn fit(
    request: ApproximateRequest,
    mut execution: Execution<'_>,
) -> Result<Drawing, ApproximateError> {
    validate_options(&request.render)?;
    execution.check_cancelled()?;
    let cancel = execution.cancel;
    let fast = execution.fast;
    let fastest = execution.fastest;
    let mut best: Option<(Drawing, Score)> = None;
    let mut pixels = Vec::new();
    let mut export_pixels = Vec::new();
    let mut export_size = (0, 0);
    let mut last_error = None;
    // The unmodified single-family outputs are explicit incumbents. Type reconsideration
    // cannot silently degrade their best result.
    for (index, family) in [
        ShapeKind::Triangle,
        ShapeKind::RotatedEllipse,
        ShapeKind::RotatedRectangle,
    ]
    .into_iter()
    .enumerate()
    {
        execution.check_cancelled()?;
        execution.mark("mixed-candidate-start");
        let mut options = request.render;
        options.shape = family;
        let mut progress = |mut info: ProgressInfo| {
            info.step =
                (((index as u64) * u64::from(info.total) + u64::from(info.step)) / 4) as u32;
            if let Some(observer) = execution.progress.as_mut() {
                observer(info);
            }
        };
        let child = Execution {
            attention: None,
            progress: Some(&mut progress),
            cancel,
            phase: None,
            fast,
            fastest,
            turbo: false,
            live_progress:execution.live_progress,
            measured_redistribution: false,
            redistribution_trials: None,
            rect_aspect: None,
            line_proposals: 0,
            triangle_angle: None,
            extra_rounds: None,
            lab_params: Vec::new(),
        };
        let drawing = match approximate_drawing_inner(
            ApproximateRequest {
                input: request.input.clone(),
                output: request.output,
                render: options,
            },
            child,
        ) {
            Ok(drawing) => drawing,
            Err(ApproximateError::Aborted) => return Err(ApproximateError::Aborted),
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        if pixels.is_empty() {
            pixels = target(&request.input, drawing.width, drawing.height)?;
            export_size =
                output_dimensions(drawing.width, drawing.height, request.render.output_size);
            export_pixels = if export_size == (drawing.width, drawing.height) {
                pixels.iter().map(|p| p.map(|v| v as f32)).collect()
            } else {
                target_f32(&request.input, export_size.0, export_size.1)?
            };
        }
        let candidate = match score(&drawing, &export_pixels, export_size.0, export_size.1) {
            Ok(score) => score,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        if best.as_ref().is_none_or(|(_, s)| candidate.loss < s.loss) {
            best = Some((drawing, candidate));
        }
        execution.mark("mixed-candidate-end");
    }
    let (best, before) = best.ok_or_else(|| {
        last_error.unwrap_or_else(|| ApproximateError::internal("no valid mixed candidate"))
    })?;
    execution.check_cancelled()?;
    execution.mark("mixed-retype-start");
    let mut model = RgbaModel::new(best.width, best.height, pixels.clone(), request.render.seed);
    if fast || fastest {
        model.enable_exact_optimizations();
    }
    // Continuous rectangle/triangle geometry is imported without quantization.
    let mut result = best;
    let mut final_score = before.loss;
    if model.seed_mixed(&result) {
        if !model.refine_observed(2,6,|| cancel.is_some_and(CancellationToken::is_cancelled),|done,total,index,shape|refinement_update(&mut execution,request.render.count,done,total,index,shape)) {
            return Err(ApproximateError::Aborted);
        }
        let candidate = model.drawing();
        if let Ok(after) = score(&candidate, &export_pixels, export_size.0, export_size.1) {
            // Strictly better actual export, with no increase in opaque-color error
            // or transparent-area spill. Otherwise retain the complete incumbent.
            if after.loss < before.loss
                && after.opaque <= before.opaque + 1e-12
                && after.spill <= before.spill + 1e-12
            {
                final_score = after.loss;
                result = candidate;
            }
        }
    }
    execution.mark("mixed-retype-end");
    execution.check_cancelled()?;
    if let Some(observer) = execution.progress.as_mut() {
        observer(ProgressInfo {
            refinement:None,preview_index:None,
            preview: preview_svg(&result),
            step: request.render.count,
            total: request.render.count,
            score: final_score,
            shape: result
                .shapes
                .last()
                .map(|s| svg::shape_element(&s.geometry, s.color))
                .unwrap_or_default(),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mixed_portfolio_keeps_count_background_progress_and_best_export() {
        for transparent in [false, true] {
            let image = image::RgbaImage::from_fn(32, 32, |x, y| {
                let circle = (i64::from(x) - 9).pow(2) + (i64::from(y) - 10).pow(2) < 49;
                if circle {
                    image::Rgba([40, 220, 80, 255])
                } else if (20..29).contains(&x) && (4..17).contains(&y) {
                    image::Rgba([230, 50, 70, 255])
                } else {
                    image::Rgba([15, 20, 40, if transparent { 0 } else { 255 }])
                }
            });
            let mut input = Vec::new();
            use image::ImageEncoder;
            image::codecs::png::PngEncoder::new(&mut input)
                .write_image(image.as_raw(), 32, 32, image::ExtendedColorType::Rgba8)
                .unwrap();
            let mut options = RenderOptions::default();
            options.count = 8;
            options.resize_input = 32;
            options.output_size = 64;
            options.seed = Some(42);
            options.background = if transparent {
                BackgroundOption::TransparentFast
            } else {
                BackgroundOption::Auto
            };
            let pixels = target_f32(&input, 64, 64).unwrap();
            let mut minimum = f64::INFINITY;
            for family in [
                ShapeKind::Triangle,
                ShapeKind::RotatedEllipse,
                ShapeKind::RotatedRectangle,
            ] {
                options.shape = family;
                let drawing = approximate_drawing_inner(
                    ApproximateRequest {
                        input: input.clone(),
                        output: OutputFormat::Png,
                        render: options,
                    },
                    Execution::new().fast(true).fastest(true),
                )
                .unwrap();
                minimum = minimum.min(score(&drawing, &pixels, 64, 64).unwrap().loss);
            }
            options.shape = ShapeKind::Mixed;
            let mut steps = Vec::new();
            let mut observer = |p: ProgressInfo| {
                assert_eq!(p.total, 8);
                steps.push(p.step);
            };
            let drawing = approximate_drawing(
                ApproximateRequest {
                    input: input.clone(),
                    output: OutputFormat::Png,
                    render: options,
                },
                Execution::new()
                    .fast(true)
                    .fastest(true)
                    .progress(&mut observer),
            )
            .unwrap();
            assert_eq!(drawing.shapes.len(), 8);
            assert!(score(&drawing, &pixels, 64, 64).unwrap().loss <= minimum + 1e-12);
            assert_eq!(steps.last(), Some(&8));
            assert!(steps.windows(2).all(|w| w[0] <= w[1]));
            assert_eq!(drawing.background.a, if transparent { 0 } else { 255 });
        }
    }
}
