//! Experimental source-RGBA solver. No RGB reference or three-fit portfolio.
use crate::*;
pub(super) fn fit(request:ApproximateRequest,mut execution:Execution<'_>)->Result<Drawing,ApproximateError>{
    validate_options(&request.render)?;execution.check_cancelled()?;
    let image=decode_input(&request.input)?;
    let size=request.render.resize_input.min(image.width().max(image.height()));
    let longest=u64::from(image.width().max(image.height()));
    let w=(u64::from(image.width())*u64::from(size)/longest).max(2)as u32;
    let h=(u64::from(image.height())*u64::from(size)/longest).max(2)as u32;
    let pixels=mixed::target(&request.input,w,h)?;
    let background=if pixels.iter().all(|p|p[3]>=1.0){Some(prepare_target(image,request.render.background,request.render.resize_input).1)}else{None};
    let mut model=primeval_core::rgba::RgbaModel::new(w,h,pixels,request.render.seed);
    model.enable_exact_optimizations();
    if let Some(background)=background {model.seed_mixed(&Drawing{width:w,height:h,background,shapes:Vec::new()});}
    execution.mark("turbo-search-start");
    for step in 0..request.render.count {
        execution.check_cancelled()?;
        let shape=model.step_turbo(request.render.shape).clone();
        if let Some(observer)=execution.progress.as_mut(){observer(ProgressInfo{refinement:None,preview_index:Some(step),preview:if step==0 || (step+1)%((request.render.count/40).max(32))==0{preview_svg(&model.snapshot())}else{None},step:step+1,total:request.render.count,score:model.score(),shape:svg::shape_element(&shape.geometry,shape.color)});}
    }
    execution.mark("turbo-search-end");execution.mark("turbo-refine-start");
    let cancel=execution.cancel;
    if !model.refine_turbo_observed(||cancel.is_some_and(CancellationToken::is_cancelled),|done,total,index,shape|refinement_update(&mut execution,request.render.count,done,total,index,shape)){return Err(ApproximateError::Aborted);}
    execution.mark("turbo-refine-end");
    Ok(model.drawing())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn count_palette_determinism_and_cancel() {
        let image=image::RgbaImage::from_fn(32,32,|x,y|image::Rgba([200,80,30,if x>7&&x<25&&y>7&&y<25{255}else{0}]));
        let mut input=std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image).write_to(&mut input,image::ImageFormat::Png).unwrap();
        for kind in [ShapeKind::Mixed,ShapeKind::Triangle,ShapeKind::RotatedEllipse,ShapeKind::RotatedRectangle] {
            let mut render=RenderOptions::default();render.shape=kind;render.count=8;render.resize_input=32;render.seed=Some(42);
            let request=||ApproximateRequest{input:input.get_ref().clone(),output:OutputFormat::Png,render};
            let a=fit(request(),Execution::new()).unwrap();let b=fit(request(),Execution::new()).unwrap();
            assert_eq!(a,b);assert_eq!(a.shapes.len(),8);
            for shape in a.shapes {match shape.geometry {primeval_core::Geometry::Ellipse{..}=>assert!(matches!(kind,ShapeKind::Mixed|ShapeKind::RotatedEllipse)),primeval_core::Geometry::Polygon(p)=>{assert!(p.len()==3||p.len()==4);if kind==ShapeKind::Triangle{assert_eq!(p.len(),3);}if kind==ShapeKind::RotatedRectangle{assert_eq!(p.len(),4);}},_=>panic!("unsupported output")}}
            let token=CancellationToken::new();token.cancel();assert!(matches!(fit(request(),Execution::new().cancellation(&token)),Err(ApproximateError::Aborted)));
        }
    }
}
