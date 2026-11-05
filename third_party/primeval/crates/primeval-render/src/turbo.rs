//! Experimental source-RGBA solver. No RGB reference or three-fit portfolio.
use crate::*;
pub(super) fn fit(request:ApproximateRequest,execution:Execution<'_>)->Result<Drawing,ApproximateError>{fit_traced(request,execution,None)}

/// Lab trace: the model every `every` search steps and after each refinement phase.
pub(crate) type Trace<'t>=(usize,&'t mut dyn FnMut(&str,usize,&primeval_core::rgba::RgbaModel));

/// The Turbo fit; `trace` (lab only, `None` in the product) observes the model.
pub(crate) fn fit_traced(request:ApproximateRequest,mut execution:Execution<'_>,mut trace:Option<Trace<'_>>)->Result<Drawing,ApproximateError>{
    validate_options(&request.render)?;execution.check_cancelled()?;
    let image=decode_input(&request.input)?;
    let (w,h)=working_size(&image,request.render.resize_input);
    let pixels=mixed::target(&request.input,w,h)?;
    let background=if pixels.iter().all(|p|p[3]>=1.0){Some(prepare_target(image,request.render.background,request.render.resize_input).1)}else{None};
    // Held for the whole fit and restored on return, error or cancellation. The
    // game scales sprites freely: rectangles have no aspect limit and isosceles
    // triangles may be thin, so a straight line or a tapering stroke can be one
    // shape. Turbo lifts Primeval's 8:1 cap and 15.5 degree minimum angle.
    let _aspect=primeval_core::RectAspect::set(execution.rect_aspect.unwrap_or(RECT_ASPECT));
    #[cfg(feature="asset-triangle")]
    let _angle=primeval_core::TriangleAngle::set(execution.triangle_angle.unwrap_or(TRIANGLE_ANGLE));
    #[cfg(not(feature="asset-triangle"))]
    let _=execution.triangle_angle;
    let mut model=primeval_core::rgba::RgbaModel::new(w,h,pixels,request.render.seed);
    model.enable_exact_optimizations();
    model.set_contour_smoothing(execution.contour_smoothing).map_err(ApproximateError::internal)?;
    if let Some((width,height,values,strength,additive,refine,proposal_only))=execution.attention.take(){
        model.set_attention_terms(width,height,&values,strength,additive,refine).map_err(ApproximateError::internal)?;
        match proposal_only {
            Proposals::Scoring=>{},
            Proposals::Attention=>model.attention_proposals_only().map_err(ApproximateError::internal)?,
            Proposals::Structure=>model.structural_proposals_only().map_err(ApproximateError::internal)?,
        }
    }
    if execution.measured_redistribution{model.enable_measured_redistribution();}
    if execution.line_proposals!=0{model.set_line_proposals(execution.line_proposals);}
    if !execution.lab_params.is_empty(){model.set_lab_params(std::mem::take(&mut execution.lab_params));}
    if let Some((extra,share))=execution.extra_rounds{model.set_extra_rounds(extra,(f64::from(request.render.count)*share.clamp(0.0,1.0)).round()as usize);}
    if let Some(trials)=execution.redistribution_trials{model.set_redistribution_trials(trials).map_err(ApproximateError::internal)?;}
    if let Some(background)=background {model.seed_mixed(&Drawing{width:w,height:h,background,shapes:Vec::new()});}
    execution.mark("turbo-search-start");
    for step in 0..request.render.count {
        execution.check_cancelled()?;
        let shape=model.step_turbo(request.render.shape).clone();
        if let Some((every,observe))=trace.as_mut(){if (step as usize+1)%*every==0{observe("search",step as usize+1,&model);}}
        if let Some(observer)=execution.progress.as_mut(){observer(ProgressInfo{refinement:None,preview_index:Some(step),preview:if step==0 || (step+1)%((request.render.count/40).max(32))==0{preview_svg(&model.snapshot())}else{None},step:step+1,total:request.render.count,score:model.score(),shape:svg::shape_element(&shape.geometry,shape.color)});}
    }
    execution.mark("turbo-search-end");execution.mark("turbo-refine-start");
    #[cfg(feature="lab")]
    if let Some((_,observe))=trace.as_mut(){
        let count=request.render.count as usize;
        model.refine_turbo_phases(|name,m|observe(name,count,m));
        return Ok(model.drawing());
    }
    let cancel=execution.cancel;
    if !model.refine_turbo_observed(||cancel.is_some_and(CancellationToken::is_cancelled),|done,total,index,shape|refinement_update(&mut execution,request.render.count,done,total,index,shape)){return Err(ApproximateError::Aborted);}
    execution.mark("turbo-refine-end");
    Ok(model.drawing())
}

/// Turbo's rectangle aspect cap and triangle minimum angle (degrees), chosen on
/// the development images (docs/development/primeval-turbo.md, lines and curves).
const RECT_ASPECT:u32=64;
const TRIANGLE_ANGLE:f64=5.0;

/// Working size: the longer side becomes `detail`, never enlarged.
fn working_size(image:&DynamicImage,detail:u32)->(u32,u32){
    let size=detail.min(image.width().max(image.height()));
    let longest=u64::from(image.width().max(image.height()));
    ((u64::from(image.width())*u64::from(size)/longest).max(2)as u32,(u64::from(image.height())*u64::from(size)/longest).max(2)as u32)
}

/// Lab: the premultiplied working target Turbo fits for `input` at `detail`.
#[cfg(any(test,feature="lab"))]
pub(crate) fn working_target(input:&[u8],detail:u32)->Result<(u32,u32,Vec<[f64;4]>),ApproximateError>{
    let (w,h)=working_size(&decode_input(input)?,detail);
    Ok((w,h,mixed::target(input,w,h)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Lab replay of one benchmark fit with per-phase snapshots. Inputs come from
    /// PRIMEVAL_DEBUG_* variables; run with --features lab -- --ignored --nocapture.
    #[cfg(feature="lab")]
    #[test]
    #[ignore]
    fn lab_replay_phases(){
        let var=|k:&str|std::env::var(format!("PRIMEVAL_DEBUG_{k}")).unwrap();
        let input=std::fs::read(var("SOURCE")).unwrap();let out=std::path::PathBuf::from(var("OUT"));
        let (count,detail,seed):(usize,u32,u64)=(var("COUNT").parse().unwrap(),var("DETAIL").parse().unwrap(),var("SEED").parse().unwrap());
        // Map file: "width height strength additive refine" then all values.
        let map=std::fs::read_to_string(var("MAP")).unwrap();let mut numbers=map.split_whitespace().map(|v|v.parse::<f64>().unwrap());
        let (mw,mh,strength,additive,refine)=(numbers.next().unwrap() as usize,numbers.next().unwrap() as usize,numbers.next().unwrap(),numbers.next().unwrap(),numbers.next().unwrap());
        let values:Vec<f32>=numbers.map(|v|v as f32).collect();
        let region:Vec<f64>=var("REGION").split(',').map(|v|v.parse().unwrap()).collect();
        let image=decode_input(&input).unwrap();
        let size=detail.min(image.width().max(image.height()));let longest=u64::from(image.width().max(image.height()));
        let w=(u64::from(image.width())*u64::from(size)/longest).max(2)as u32;let h=(u64::from(image.height())*u64::from(size)/longest).max(2)as u32;
        let pixels=mixed::target(&input,w,h).unwrap();let target=pixels.clone();
        let mut model=primeval_core::rgba::RgbaModel::new(w,h,pixels,Some(seed));model.enable_exact_optimizations();
        if strength>0.0||additive>0.0{model.set_attention_terms(mw,mh,&values,strength,additive,refine).unwrap();}
        let report=|name:&str,model:&primeval_core::rgba::RgbaModel|{
            let current=model.current_pixels();let (x0,y0,x1,y1)=((region[0]*w as f64)as usize,(region[1]*h as f64)as usize,(region[2]*w as f64).ceil()as usize,(region[3]*h as f64).ceil()as usize);
            let mut error=0.0;let mut n=0.0;
            for y in y0..y1.min(h as usize){for x in x0..x1.min(w as usize){let i=y*w as usize+x;for bg in [0.0,1.0]{for k in 0..3{
                let t=target[i][k]+bg*(1.0-target[i][3]);let c=current[i][k]+bg*(1.0-current[i][3]);error+=(t-c).powi(2);n+=1.0;}}}}
            let mut png=image::RgbaImage::new(w,h);
            for (p,c) in png.pixels_mut().zip(current){let a=c[3].clamp(0.0,1.0);let un=|v:f64|if a>0.0{(v/a*255.0).round().clamp(0.0,255.0)as u8}else{0};*p=image::Rgba([un(c[0]),un(c[1]),un(c[2]),(a*255.0).round()as u8]);}
            png.save(out.join(format!("{name}.png"))).unwrap();
            println!("{name}: region rmse {:.3} score {:.6} shapes {}",255.0*(error/n).sqrt(),model.score(),model.snapshot().shapes.len());
        };
        for step in 0..count{
            model.step_turbo(ShapeKind::Mixed);
            if (step+1)%50==0{report(&format!("search-{:04}",step+1),&model);}
        }
        model.refine_turbo_phases(|name,model|report(name,model));
    }
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
