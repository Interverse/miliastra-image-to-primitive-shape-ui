//! Source-alpha fitting on a transparent canvas. Opaque Model is unchanged.
//! Scores premultiplied RGB plus alpha (weight 4), using the original shape
//! generators, coverage rasterizers and mutations. No source mask is exported.
use crate::{Buffer, Color, Drawing, DrawnShape, ShapeKind, Geometry};
use crate::error_grid::ErrorGrid;
use crate::worker::{WorkerCtx, SearchRound, RoundEffort};
use crate::shapes::{Shape, Step, Polygon, RotatedEllipse};
use crate::scanline::Scanline;
use rayon::prelude::*;
use std::sync::{OnceLock,Mutex};

mod turbo;
mod structure;
mod lines;
mod features;
mod contours;

const N: usize = 11;
const ALPHA_WEIGHT: f64 = 4.0;

type Sums = [f64; N];

fn coverage<'a,R:rand::Rng>(shape:&Shape,worker:&'a mut WorkerCtx<R>,exact:bool)->&'a [Scanline] {
    if !exact{return shape.rasterize(worker);}
    use tiny_skia::{Mask,PathBuilder,Rect,Transform,FillRule,IntSize};
    let (x1,y1,x2,y2)=shape.candidate_rectangle(worker.width,worker.height,false);
    worker.lines.clear();if x2<x1||y2<y1{return &worker.lines;}
    let reuse=worker.rgba_reuse;
    let mut builder=if reuse {worker.rgba_path.take().map(|p|p.clear()).unwrap_or_default()}else{PathBuilder::new()};
    let mut transform=Transform::from_translate(-x1 as f32,-y1 as f32);
    // Seeded polygons already hold precisely these coordinates. Avoid a
    // temporary heap-allocated Geometry::Polygon in the accelerated path.
    let path=if reuse&&matches!(shape,Shape::Polygon(_)) {
        let Shape::Polygon(p)=shape else{unreachable!()};
        builder.move_to(p.x[0] as f32,p.y[0] as f32);
        for i in 1..p.order{builder.line_to(p.x[i] as f32,p.y[i] as f32);}builder.close();builder.finish()
    }else{match shape.geometry() {
        Geometry::Polygon(p)=>{builder.move_to(p[0].x as f32,p[0].y as f32);for q in &p[1..]{builder.line_to(q.x as f32,q.y as f32);}builder.close();builder.finish()},
        Geometry::Rect{x,y,width,height}=>Rect::from_xywh(x as f32,y as f32,width as f32,height as f32).map(PathBuilder::from_rect),
        Geometry::Ellipse{cx,cy,rx,ry,rotation}=>{
            let (sin,cos)=crate::sin_cos_degrees(rotation);let rotate=Transform::from_row(cos as f32,sin as f32,-sin as f32,cos as f32,0.0,0.0);
            transform=transform.pre_concat(Transform::identity().pre_translate(cx as f32,cy as f32).pre_concat(rotate).pre_translate(-cx as f32,-cy as f32));
            Rect::from_ltrb((cx-rx) as f32,(cy-ry) as f32,(cx+rx) as f32,(cy+ry) as f32).and_then(|oval|{builder.push_oval(oval);builder.finish()})
        },
        _=>return shape.rasterize(worker),
    }};
    let Some(mut path)=path else{return &worker.lines;};
    // Mask::fill_path clones a transformed path. Consuming our owned path
    // applies exactly the same transform without allocating another copy.
    if reuse&&!transform.is_identity(){let Some(transformed)=path.transform(transform)else{return &worker.lines;};path=transformed;transform=Transform::identity();}
    let w=(x2-x1+1) as u32;let h=(y2-y1+1) as u32;
    let mask=if reuse {
        let mut bytes=std::mem::take(&mut worker.rgba_mask);bytes.resize(w as usize*h as usize,0);bytes.fill(0);
        Mask::from_vec(bytes,IntSize::from_wh(w,h).unwrap())
    }else{Mask::new(w,h)};
    let Some(mut mask)=mask else{return &worker.lines;};
    if reuse {mask.fill_path_coverage_cached(&path,FillRule::Winding,&mut worker.rgba_raster);}else{mask.fill_path(&path,FillRule::Winding,true,transform);}
    for y in 0..h {let mut x=0;while x<w {
        let alpha=mask.data()[(y*w+x) as usize];let start=x;x+=1;
        while x<w&&mask.data()[(y*w+x) as usize]==alpha{x+=1;}
        if alpha>0{worker.lines.push(Scanline{y:y1+y as i32,x1:x1+start as i32,x2:x1+x as i32-1,alpha:u32::from(alpha)*257});}
    }}
    if reuse {worker.rgba_mask=mask.take();worker.rgba_path=Some(path);}
    &worker.lines
}

#[cfg(test)]
fn coverage_rgba_reference<'a,R:rand::Rng>(shape:&Shape,worker:&'a mut WorkerCtx<R>,exact:bool)->&'a [Scanline] {
    if !exact{return shape.rasterize(worker);}
    use tiny_skia::{Pixmap,PathBuilder,Rect,Paint,Transform,FillRule};
    let (x1,y1,x2,y2)=shape.candidate_rectangle(worker.width,worker.height,false);
    worker.lines.clear();if x2<x1||y2<y1{return &worker.lines;}
    let geometry=shape.geometry();let mut transform=Transform::from_translate(-x1 as f32,-y1 as f32);
    let path=match &geometry {
        Geometry::Polygon(p)=>{let mut b=PathBuilder::new();b.move_to(p[0].x as f32,p[0].y as f32);for q in &p[1..]{b.line_to(q.x as f32,q.y as f32);}b.close();b.finish()},
        Geometry::Rect{x,y,width,height}=>Rect::from_xywh(*x as f32,*y as f32,*width as f32,*height as f32).map(PathBuilder::from_rect),
        Geometry::Ellipse{cx,cy,rx,ry,rotation}=>{
            let (sin,cos)=crate::sin_cos_degrees(*rotation);let rotate=Transform::from_row(cos as f32,sin as f32,-sin as f32,cos as f32,0.0,0.0);
            transform=transform.pre_concat(Transform::identity().pre_translate(*cx as f32,*cy as f32).pre_concat(rotate).pre_translate(-*cx as f32,-*cy as f32));
            Rect::from_ltrb((cx-rx) as f32,(cy-ry) as f32,(cx+rx) as f32,(cy+ry) as f32).and_then(PathBuilder::from_oval)
        },
        _=>return shape.rasterize(worker),
    };
    let Some(path)=path else{return &worker.lines;};
    let w=(x2-x1+1) as u32;let h=(y2-y1+1) as u32;
    let Some(mut mask)=Pixmap::new(w,h)else{return &worker.lines;};
    let mut paint=Paint::default();paint.set_color_rgba8(255,255,255,255);paint.anti_alias=true;paint.force_hq_pipeline=true;
    mask.fill_path(&path,&paint,FillRule::Winding,transform,None);
    for y in 0..h {let mut x=0;while x<w {
        let alpha=mask.pixels()[(y*w+x) as usize].alpha();let start=x;x+=1;
        while x<w&&mask.pixels()[(y*w+x) as usize].alpha()==alpha{x+=1;}
        if alpha>0{worker.lines.push(Scanline{y:y1+y as i32,x1:x1+start as i32,x2:x1+x as i32-1,alpha:u32::from(alpha)*257});}
    }}
    &worker.lines
}

// K, R[3], V[3], W, U, L, D for the source-over quadratic.
// New RGB = C + coverage*(p - a*C), A = A + coverage*a*(1-A).
// p is premultiplied color, constrained to 0 <= p <= a.
fn value(s: &Sums, a: f64) -> (f64, [f64;3]) {
    let mut p=[0.0;3];
    let mut loss=a*a*(s[7]+s[10])+2.0*a*(s[8]-s[9]);
    for c in 0..3 {
        p[c]=((s[1+c]+a*s[4+c])/s[0]).clamp(0.0,a);
        loss+=s[0]*p[c]*p[c]-2.0*p[c]*(s[1+c]+a*s[4+c]);
    }
    (loss,p)
}

fn fit(s: &Sums) -> (f64, Color) {
    if s[0]<1e-12 { return (0.0,Color::new(0,0,0,0)); }
    quantized_fit(s,optimal_alpha(s))
}

// Eliminate premultiplied RGB analytically. Its clamps change state at at
// most six alpha values; in each interval the objective is one quadratic.
fn optimal_alpha(s:&Sums)->f64 {
    let mut cuts=[1.0;8];cuts[0]=0.0;let mut count=2;
    for c in 0..3 {
        for (num,den) in [(-s[1+c],s[4+c]),(s[1+c],s[0]-s[4+c])] {
            if den.abs()>1e-30 {let a=num/den;if a>0.0&&a<1.0 {cuts[count]=a;count+=1;}}
        }
    }
    cuts[..count].sort_by(f64::total_cmp);
    for interval in cuts[..count].windows(2) {
        let lo=interval[0];let hi=interval[1];let mid=(lo+hi)*0.5;
        let mut a=s[7]+s[10];let mut b=s[8]-s[9];
        for c in 0..3 {
            let r=s[1+c];let v=s[4+c];let p=(r+mid*v)/s[0];
            if p>=mid {a+=s[0]-2.0*v;b-=r;}
            else if p>0.0 {a-=v*v/s[0];b-=r*v/s[0];}
        }
        let root=if a>1e-25 {-b/a}else if b>=0.0{lo}else{hi};
        if root<=lo {return lo;}
        if root<=hi {return root;}
    }
    1.0
}

#[cfg(test)]
fn binary_alpha(s:&Sums)->f64 {
    let (mut lo,mut hi)=(0.0,1.0);
    for _ in 0..24 {
        let a=(lo+hi)*0.5;
        let (_,p)=value(s,a);
        let mut derivative=2.0*a*(s[7]+s[10])+2.0*(s[8]-s[9]);
        for c in 0..3 {
            derivative-=2.0*p[c]*s[4+c];
            if p[c]>=a {derivative+=2.0*(s[0]*a-s[1+c]-a*s[4+c]);}
        }
        if derivative>0.0 {hi=a;} else {lo=a;}
    }
    (lo+hi)*0.5
}

fn quantized_fit(s:&Sums,alpha:f64)->(f64,Color) {
    let base=(alpha*255.0).floor().clamp(0.0,255.0) as u8;
    let mut best=(0.0,Color::new(0,0,0,0));
    for byte in [base,base.saturating_add(1),255] {
        let a=f64::from(byte)/255.0;
        if a==0.0 {continue;}
        let (_,p)=value(s,a);
        let rgb=p.map(|v|(v/a*255.0).round().clamp(0.0,255.0) as u8);
        let mut loss=a*a*(s[7]+s[10])+2.0*a*(s[8]-s[9]);
        for c in 0..3 {
            let pc=a*f64::from(rgb[c])/255.0;
            loss+=s[0]*pc*pc-2.0*pc*(s[1+c]+a*s[4+c]);
        }
        if loss<best.0 {best=(loss,Color::new(rgb[0],rgb[1],rgb[2],byte));}
    }
    best
}

/// Alpha-aware Primeval shape search, with a transparent background.
pub struct RgbaModel {
    width:u32, height:u32, target:Vec<[f64;4]>, current:Vec<[f64;4]>,
    prefix:Vec<Sums>, error_prefix:Vec<f64>, proposal:Buffer, canvas:Buffer, grid:ErrorGrid,
    background:Color,
    optimized:bool, turbo:bool, clear_alpha_weight:f64, detail_weights:Vec<f64>, refine_weights:Vec<f64>, alpha_gains:Vec<f64>, refine_alpha_gains:Vec<f64>, proposal_weights:Vec<f64>, measured_redistribution:bool, redistribution_trials:usize, line_variant:u32, lines:Option<Vec<lines::Primitive>>, extra_rounds:(usize,usize), faint_holes:Vec<bool>, lab:Vec<(String,f64)>, features_marked:bool, feature_regions:Vec<Vec<usize>>, attention:Vec<f64>,
    step_workers:Vec<WorkerCtx<rand_chacha::ChaCha8Rng>>,
    contour_strength:f64, contour_field:Vec<f64>, contour_normals:Vec<[f64;2]>,
    seed:u64, shapes:Vec<DrawnShape>, layers:Vec<Shape>, score:f64,family:ShapeKind,exact_coverage:bool,frozen:Vec<bool>,fast_residual:bool,
}

impl RgbaModel {
    /// Install a normalized attention prior before fitting. Invalid maps leave the model untouched.
    pub fn set_attention(&mut self, width:usize, height:usize, values:&[f32], strength:f64)->Result<(), &'static str>{
        self.set_attention_terms(width,height,values,strength,0.0,1.0)
    }
    /// `strength` amplifies structural weights inside attended regions; `additive`
    /// (0 to 4) adds up to `3 * additive` weight units by attention alone, reaching
    /// low-contrast detail, and multiplies attended opacity error, including paint
    /// on transparent pixels, by up to `1 + 3 * additive`.
    /// `refine` is the share of that attention emphasis kept after shape search: 1 keeps
    /// it for refinement, 0 refines placed shapes against structural weights only.
    pub fn set_attention_terms(&mut self, width:usize, height:usize, values:&[f32], strength:f64, additive:f64, refine:f64)->Result<(), &'static str>{
        if width==0 || height==0 || width.checked_mul(height)!=Some(values.len()) || [strength,refine].iter().any(|v|!v.is_finite() || !(0.0..=1.0).contains(v)) || !additive.is_finite() || !(0.0..=4.0).contains(&additive) || values.iter().any(|v|!v.is_finite() || !(0.0..=1.0).contains(v)){return Err("Invalid importance map");}
        if !self.shapes.is_empty(){return Err("Importance must be installed before fitting");}
        if (strength==0.0 && additive==0.0) || values.iter().all(|v|*v==values[0]){return Ok(());}
        let w=self.width as usize;let h=self.height as usize;
        let structural=structure::analyze(w,h,&self.target);let mut weights=structural.clone();let mut gains=vec![1.0;w*h];
        for y in 0..h{for x in 0..w{
            let sx=((x as f64+0.5)*width as f64/w as f64-0.5).clamp(0.0,(width-1)as f64);
            let sy=((y as f64+0.5)*height as f64/h as f64-0.5).clamp(0.0,(height-1)as f64);
            let x0=sx.floor()as usize;let y0=sy.floor()as usize;let x1=(x0+1).min(width-1);let y1=(y0+1).min(height-1);
            let fx=sx-x0 as f64;let fy=sy-y0 as f64;
            let top=values[y0*width+x0]as f64*(1.0-fx)+values[y0*width+x1]as f64*fx;
            let bottom=values[y1*width+x0]as f64*(1.0-fx)+values[y1*width+x1]as f64*fx;
            let sampled=top*(1.0-fy)+bottom*fy;
            // The additive term scales opacity error with the colour emphasis: an
            // attended hole (an eye, a gap between letters) cannot be reopened once
            // painted, and partly transparent detail keeps its colour/opacity balance.
            gains[y*w+x]=1.0+3.0*additive*sampled;
            if self.attention.is_empty(){self.attention=vec![0.0;w*h];}
            self.attention[y*w+x]=sampled;
            if self.target[y*w+x][3]==0.0{continue;}
            weights[y*w+x]=1.0+(weights[y*w+x]-1.0)*(1.0+strength*sampled)+3.0*additive*sampled;
        }}
        self.refine_weights=if refine<1.0{structural.iter().zip(&weights).map(|(s,a)|s+refine*(a-s)).collect()}else{Vec::new()};
        let attended=gains.iter().any(|g|*g>1.0);
        self.refine_alpha_gains=if refine<1.0&&attended{gains.iter().map(|g|1.0+refine*(g-1.0)).collect()}else{Vec::new()};
        self.alpha_gains=if attended{gains}else{Vec::new()};
        self.detail_weights=weights;self.score=self.loss(&self.current);for y in 0..h{self.update_row(y);}Ok(())
    }
    /// Use the installed attention weights only for extra candidate proposals.
    /// Scoring, refinement and layer ranking retain structural weights.
    pub fn attention_proposals_only(&mut self)->Result<(), &'static str>{
        if !self.shapes.is_empty(){return Err("Importance must be installed before fitting");}
        if self.detail_weights.is_empty(){return Ok(());}
        self.proposal_weights=std::mem::take(&mut self.detail_weights);
        self.install_structural_scoring();Ok(())
    }
    /// Experimental control: extra connected-patch proposals from structural
    /// weights alone, ignoring any attention map. Scoring is unchanged.
    pub fn structural_proposals_only(&mut self)->Result<(), &'static str>{
        if !self.shapes.is_empty(){return Err("Importance must be installed before fitting");}
        self.proposal_weights=structure::analyze(self.width as usize,self.height as usize,&self.target);
        self.install_structural_scoring();Ok(())
    }
    fn install_structural_scoring(&mut self){
        self.detail_weights=structure::analyze(self.width as usize,self.height as usize,&self.target);
        self.refine_weights.clear();self.alpha_gains.clear();self.refine_alpha_gains.clear();
        self.score=self.loss(&self.current);
        for y in 0..self.height as usize{self.update_row(y);}
    }
    /// Switch to the refinement weights chosen by `set_attention_terms`, if any.
    fn begin_attention_refinement(&mut self){
        if self.refine_weights.is_empty(){return;}
        self.detail_weights=std::mem::take(&mut self.refine_weights);
        if !self.alpha_gains.is_empty(){self.alpha_gains=std::mem::take(&mut self.refine_alpha_gains);}
        for y in 0..self.height as usize{self.update_row(y);}
    }
    fn detail_weight(&self,i:usize)->f64{self.detail_weights.get(i).copied().unwrap_or(1.0)}
    fn alpha_weight(&self,i:usize)->f64 {
        // Faint holes inside opaque areas (see `faint_holes`) count as clear pixels.
        let base=if self.target[i][3]==0.0||self.faint_holes.get(i).copied().unwrap_or(false){self.clear_alpha_weight}else{ALPHA_WEIGHT*if self.detail_weights.is_empty(){1.0}else{2.0}};
        base*self.alpha_gains.get(i).copied().unwrap_or(1.0)
    }
    /// Target pixels are normalized premultiplied RGBA, resampled before entry.
    pub fn new(width:u32,height:u32,target:Vec<[f64;4]>,seed:Option<u64>) -> Self {
        assert!(width>=2 && height>=2 && target.len()==width as usize*height as usize);
        let current=vec![[0.0;4];target.len()];
        // Proposals see alpha as well as color; actual scoring uses all four.
        let proxy=|pixels:&[[f64;4]]| pixels.iter().flat_map(|p|[
            (p[3]*255.0).round() as u8,
            ((p[0]+p[1]+p[2])/3.0*255.0).round() as u8,
            (p[2]*255.0).round() as u8]).collect();
        let proposal=Buffer::from_rgb(width,height,proxy(&target)).unwrap();
        let canvas=Buffer::from_rgb(width,height,proxy(&current)).unwrap();
        let score=target.iter().map(|p|p[0]*p[0]+p[1]*p[1]+p[2]*p[2]+ALPHA_WEIGHT*p[3]*p[3]).sum();
        let mut model=Self{contour_strength:0.0,contour_field:Vec::new(),contour_normals:Vec::new(),background:Color::new(0,0,0,0),optimized:false,turbo:false,clear_alpha_weight:16.0,detail_weights:Vec::new(),refine_weights:Vec::new(),alpha_gains:Vec::new(),refine_alpha_gains:Vec::new(),proposal_weights:Vec::new(),measured_redistribution:false,redistribution_trials:8,line_variant:0,lines:None,extra_rounds:(0,0),faint_holes:Vec::new(),lab:Vec::new(),features_marked:false,feature_regions:Vec::new(),attention:Vec::new(),step_workers:Vec::new(),width,height,target,current,prefix:vec![[0.0;N];(width as usize+1)*height as usize],error_prefix:vec![0.0;(width as usize+1)*height as usize],proposal,canvas,grid:ErrorGrid::new(width,height,16,16),seed:seed.unwrap_or_else(crate::util::entropy_seed),shapes:Vec::new(),layers:Vec::new(),score,family:ShapeKind::Any,exact_coverage:false,frozen:Vec::new(),fast_residual:false};
        for y in 0..height as usize {model.update_row(y);}
        model
    }

    /// Reuse scratch storage without changing candidates, RNG or floating-point math.
    pub fn enable_exact_optimizations(&mut self) {self.optimized=true;}

    /// Start from the complete opaque search/refinement instead of replacing
    /// its allocation of fine detail with a second independent greedy fit.
    pub fn seed_drawing(&mut self,drawing:&Drawing,kind:ShapeKind)->bool {
        self.seed_with_base(drawing,kind,0)
    }

    /// Import the complete incumbent, including its existing background control.
    pub fn seed_mixed(&mut self,drawing:&Drawing)->bool{self.background=drawing.background;self.seed_drawing(drawing,ShapeKind::Mixed)}

    /// Retain a previously alpha-fitted foundation under original detail layers.
    pub fn seed_with_base(&mut self,drawing:&Drawing,kind:ShapeKind,base_count:usize)->bool {
        if drawing.width!=self.width||drawing.height!=self.height{return false;}
        self.grid.compute(&self.proposal,&self.canvas);
        let round=SearchRound{half_resolution:false,target:&self.proposal,current:&self.canvas,error_grid:&self.grid,score:0,coarse:None};
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,18));worker.rgba_reuse=self.optimized;
        let template=Shape::random(kind,&mut worker,&round);
        let Some(layers)=drawing.shapes.iter().map(|s|{
            if matches!(kind,ShapeKind::Triangle|ShapeKind::Mixed) {if let Geometry::Polygon(p)=&s.geometry {if p.len()==3 {
                return Some(Shape::Polygon(Polygon{order:3,x:[p[0].x,p[1].x,p[2].x,0.0],y:[p[0].y,p[1].y,p[2].y,0.0]}));
            }}}
            if matches!(kind,ShapeKind::RotatedEllipse|ShapeKind::Mixed) {if let Geometry::Ellipse{cx,cy,rx,ry,rotation}=&s.geometry {
                if *rx>0.0&&*ry>0.0 {return Some(Shape::RotatedEllipse(RotatedEllipse{x:*cx,y:*cy,rx:*rx,ry:*ry,angle:*rotation}));}
            }}
            if matches!(kind,ShapeKind::RotatedRectangle|ShapeKind::Mixed) {if let Geometry::Polygon(p)=&s.geometry {if p.len()==4 {
                return Some(Shape::Polygon(Polygon{order:4,x:[p[0].x,p[1].x,p[2].x,p[3].x],y:[p[0].y,p[1].y,p[2].y,p[3].y]}));
            }}}
            template.adopted(&s.geometry,self.width,self.height)
        }).collect::<Option<Vec<_>>>() else{return false;};
        let mut canvas=vec![self.background_pixel();self.target.len()];let mut shapes=drawing.shapes.clone();let mut frozen=vec![false;shapes.len()];
        for (index,(shape,drawn)) in layers.iter().zip(&mut shapes).enumerate(){
            let lines=coverage(shape,&mut worker,true);let mut alpha=0.0;let mut area=0.0;let mut safe=true;
            for line in lines {for x in line.x1..=line.x2 {let weight=line.coverage();area+=weight;alpha+=weight*self.target[line.y as usize*self.width as usize+x as usize][3];for dy in -1..=1 {for dx in -1..=1 {let xx=x+dx;let yy=line.y+dy;if xx<0||yy<0||xx>=self.width as i32||yy>=self.height as i32||self.target[yy as usize*self.width as usize+xx as usize][3]<254.0/255.0{safe=false;}}}}}
            // Do not initialize a deep opaque stack outside the silhouette:
            // saturated alpha has no coordinate gradient until every layer
            // covering it is removed. Interior reference layers remain intact;
            // boundary/background layers are free to regrow during RGBA fitting.
            if kind!=ShapeKind::Mixed&&index>=base_count&&area>0.0&&alpha/area<0.995 {drawn.color.a=0;}
            frozen[index]=kind!=ShapeKind::Mixed&&index>=base_count&&area>0.0&&safe;
            Self::paint(&mut canvas,self.width,lines,drawn.color);
        }
        self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
        self.layers=layers;self.shapes=shapes;self.family=kind;self.exact_coverage=true;self.frozen=frozen;
        for y in 0..self.height as usize {self.update_row(y);}
        true
    }

    fn update_row(&mut self,y:usize) {
        let w=self.width as usize;let base=y*(w+1);self.prefix[base]=[0.0;N];self.error_prefix[base]=0.0;
        for x in 0..w {
            let i=y*w+x;let t=self.target[i];let c=self.current[i];
            let mut v=[0.0;N];v[0]=1.0;
            self.error_prefix[base+x+1]=self.error_prefix[base+x]+(0..4).map(|k|(t[k]-c[k]).powi(2)*if k==3{self.alpha_weight(i)}else{self.detail_weight(i)}).sum::<f64>();
            for k in 0..3 {let d=t[k]-c[k];v[1+k]=d;v[4+k]=c[k];v[7]+=c[k]*c[k];v[8]+=c[k]*d;}
            v[9]=self.alpha_weight(i)*(1.0-c[3])*(t[3]-c[3]);v[10]=self.alpha_weight(i)*(1.0-c[3]).powi(2);
            for value in &mut v[..9]{*value*=self.detail_weight(i);}
            for k in 0..N {self.prefix[base+x+1][k]=self.prefix[base+x][k]+v[k];}
            self.canvas.pixels_mut()[i*3]=(c[3]*255.0).round() as u8;
            self.canvas.pixels_mut()[i*3+1]=((c[0]+c[1]+c[2])/3.0*255.0).round() as u8;
            self.canvas.pixels_mut()[i*3+2]=(c[2]*255.0).round() as u8;
        }
    }

    fn evaluate(&self,lines:&[Scanline]) -> (f64,Color) {
        let mut sums=[0.0;N];
        for line in lines {
            let row=line.y as usize*(self.width as usize+1);
            let left=self.prefix[row+line.x1 as usize];let right=self.prefix[row+line.x2 as usize+1];
            let coverage=line.coverage();
            for k in 0..N {
                let weight=if matches!(k,1..=3|8|9){coverage}else{coverage*coverage};
                sums[k]+=(right[k]-left[k])*weight;
            }
        }
        fit(&sums)
    }

    fn evaluate_shape<R:rand::Rng>(&self,shape:&Shape,worker:&mut WorkerCtx<R>,bound:f64)->(f64,Color) {
        if bound<0.0 {
            let (x1,y1,x2,y2)=shape.candidate_rectangle(self.width as i32,self.height as i32,false);
            let mut available=0.0;
            if x2>=x1&&y2>=y1 {for y in y1..=y2 {let at=y as usize*(self.width as usize+1);available+=self.error_prefix[at+x2 as usize+1]-self.error_prefix[at+x1 as usize];}}
            // A nonnegative squared error cannot fall by more than all the
            // existing error inside this conservative bounding rectangle.
            if available+1e-10 < -bound {return (0.0,Color::new(0,0,0,0));}
        }
        let (loss,color)=self.evaluate(coverage(shape,worker,self.exact_coverage));
        self.contour_rank(shape,(loss,color),None)
    }

    /// Add one shape, preserving the original count and geometry constraints.
    pub fn step(&mut self,kind:ShapeKind) -> &DrawnShape {
        self.family=kind;
        self.grid.compute(&self.proposal,&self.canvas);
        let round=SearchRound{half_resolution:false,target:&self.proposal,current:&self.canvas,error_grid:&self.grid,score:0,coarse:None};
        let mut effort=RoundEffort::of(kind);if self.fast_residual{effort.candidates=64;effort.age=35;}let step=self.shapes.len() as u64;
        let base_rounds=if self.turbo{8+(self.line_variant>>24) as usize+if (step as usize)<self.extra_rounds.1{self.extra_rounds.0}else{0}}else{(if self.fast_residual{4}else{16})*if kind==ShapeKind::Mixed{3}else{1}};
        let proposals=if self.turbo{self.turbo_proposals(kind)}else{Vec::new()};
        // Experimental: extra rounds that hill-climb from edge-aligned proposals.
        let dedicated=if self.turbo{self.dedicated_line_groups(kind)}else{Vec::new()};
        let rounds=base_rounds+dedicated.len();
        let mut workers=if self.optimized{std::mem::take(&mut self.step_workers)}else{Vec::new()};
        workers.resize_with(rounds,||{let mut work=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,step,0));work.rgba_reuse=self.optimized;work});
        let search=|(index,worker):(usize,&mut WorkerCtx<_>)| {
            if index>=base_rounds{
                let group=&dedicated[index-base_rounds];
                worker.rng=crate::rng::round_rng(self.seed,step,1000+index as u64);
                let mut shape=group[0].clone();let mut scored=self.evaluate_shape(&shape,worker,0.0);
                for candidate in &group[1..]{let trial=self.evaluate_shape(candidate,worker,scored.0);if trial.0<scored.0{shape=candidate.clone();scored=trial;}}
                let mut age=0;
                while age<50 {
                    let mut candidate=shape.clone();candidate.mutate(worker,Step::Scaled((0.8408964152537145_f64).powi(age as i32).max(1.0/64.0)));
                    Self::project_rectangle(&mut candidate);
                    let score=self.evaluate_shape(&candidate,worker,scored.0);
                    if score.0<scored.0 {shape=candidate;scored=score;age=0;}else{age+=1;}
                }
                return (shape,scored);
            }
            let stream=if kind==ShapeKind::Mixed{index/3}else{index};
            let kind=if kind==ShapeKind::Mixed{crate::mixed::family(index)}else{kind};
            let mut effort=if self.family==ShapeKind::Mixed{RoundEffort::of(kind)}else{effort};if self.fast_residual{effort.candidates=64;effort.age=35;}
            // Research control: `extra_candidates` more random starts per round.
            if self.turbo{effort.candidates=32+self.lab_param("extra_candidates").unwrap_or(0.0)as usize;effort.age=50;}
            let index=index as u64;worker.rng=crate::rng::round_rng(self.seed,step,stream as u64);
            let mut shape=Shape::random(kind,worker,&round);if self.fast_residual{Self::narrow(&mut shape,index,(256.0/f64::from(self.width.max(self.height))).min(1.0));}
            let mut scored=self.evaluate_shape(&shape,worker,0.0);
            for _ in 1..effort.candidates {
                let mut candidate=Shape::random(kind,worker,&round);if self.fast_residual{Self::narrow(&mut candidate,index,(256.0/f64::from(self.width.max(self.height))).min(1.0));}
                if self.turbo {Self::project_rectangle(&mut candidate);}
                let score=self.evaluate_shape(&candidate,worker,scored.0);
                if score.0<scored.0 {shape=candidate;scored=score;}
            }
            if self.turbo {
                for candidate in proposals.iter().skip(index as usize).step_by(base_rounds) {let trial=self.evaluate_shape(candidate,worker,scored.0);if trial.0<scored.0{shape=candidate.clone();scored=trial;}}
            }
            let mut age=0;
            while age<effort.age {
                let mut candidate=shape.clone();candidate.mutate(worker,if self.turbo{Step::Scaled((0.8408964152537145_f64).powi(age as i32).max(1.0/64.0))}else{Step::Coarse});
                if self.turbo {Self::project_rectangle(&mut candidate);}
                let score=self.evaluate_shape(&candidate,worker,scored.0);
                if score.0<scored.0 {shape=candidate;scored=score;age=0;}else{age+=1;}
            }
            (shape,scored)
        };
        let results:Vec<_>=workers.par_iter_mut().enumerate().map(search).collect();
        if self.optimized{self.step_workers=workers;}
        let (shape,(_,color))=results.into_iter().enumerate().min_by(|(ia,a),(ib,b)|a.1.0.total_cmp(&b.1.0).then(ia.cmp(ib))).unwrap().1;
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,step,16));worker.rgba_reuse=self.optimized;
        let lines=coverage(&shape,&mut worker,self.exact_coverage);
        let delta=self.evaluate(lines).0; // Keep cached loss/prefixes purely photometric.
        let a=f64::from(color.a)/255.0;let rgb=[color.r,color.g,color.b].map(|v|f64::from(v)/255.0);
        let mut dirty=vec![false;self.height as usize];
        for line in lines {
            let alpha=a*line.coverage();dirty[line.y as usize]=true;
            for x in line.x1..=line.x2 {
                let p=&mut self.current[line.y as usize*self.width as usize+x as usize];
                for c in 0..3 {p[c]=p[c]*(1.0-alpha)+rgb[c]*alpha;}
                p[3]+=alpha*(1.0-p[3]);
            }
        }
        for (y,changed) in dirty.into_iter().enumerate(){if changed{self.update_row(y);}}
        self.score=(self.score+delta).max(0.0);
        self.shapes.push(DrawnShape{geometry:shape.geometry(),color});
        self.layers.push(shape);self.frozen.push(false);
        self.shapes.last().unwrap()
    }

    /// Coarse alpha foundation with the same bounded proposal effort as Fast
    /// residual placement. The count remains the caller's requested count.
    pub fn step_foundation_fast(&mut self,kind:ShapeKind)->&DrawnShape {
        let previous=self.fast_residual;self.fast_residual=true;
        self.step(kind);self.fast_residual=previous;
        self.shapes.last().expect("a step commits one shape")
    }

    fn narrow(shape:&mut Shape,round:u64,detail_scale:f64) {
        let scale=[0.125,0.25,0.5,1.0][round as usize%4]*detail_scale;
        match shape {
            Shape::RotatedEllipse(s)=>{s.rx=(s.rx*scale).max(1.0);s.ry=(s.ry*scale).max(1.0);},
            Shape::RotatedRectangle(s)=>{s.sx=((s.sx as f64*scale).round() as i32).max(1);s.sy=((s.sy as f64*scale).round() as i32).max(1);},
            Shape::Polygon(s)=>{let n=s.order;let x=s.x[..n].iter().sum::<f64>()/n as f64;let y=s.y[..n].iter().sum::<f64>()/n as f64;for i in 0..n{s.x[i]=x+(s.x[i]-x)*scale;s.y[i]=y+(s.y[i]-y)*scale;}},
            _=>{},
        }
    }

    fn paint(canvas:&mut [[f32;4]],width:u32,lines:&[Scanline],color:Color) {
        if color.a==0{return;}
        let a=f32::from(color.a)/255.0;let rgb=[color.r,color.g,color.b].map(|v|f32::from(v)/255.0);
        for line in lines {let alpha=a*line.coverage() as f32;for x in line.x1..=line.x2 {
            let p=&mut canvas[line.y as usize*width as usize+x as usize];
            #[cfg(all(target_arch="wasm32",target_feature="simd128"))]
            {
                use std::arch::wasm32::*;
                // SAFETY: p is one complete [f32; 4], exactly the 16 bytes
                // loaded/stored here. SIMD loads do not require alignment.
                unsafe {
                    let previous=v128_load(p.as_ptr().cast());
                    let keep=f32x4_splat(1.0-alpha);
                    let color=f32x4(rgb[0],rgb[1],rgb[2],1.0);
                    let next=f32x4_add(f32x4_mul(previous,keep),f32x4_mul(f32x4_splat(alpha),color));
                    let next=f32x4_replace_lane::<3>(next,p[3]+alpha*(1.0-p[3]));
                    let bytes=f32x4_mul(next,f32x4_splat(255.0));
                    let floor=f32x4_floor(bytes);
                    // Preserve Rust round's positive ties-away behavior rather
                    // than SIMD nearest's ties-to-even behavior.
                    let fraction=f32x4_sub(bytes,floor);
                    let increment=v128_and(f32x4_ge(fraction,f32x4_splat(0.5)),f32x4_splat(1.0));
                    let rounded=f32x4_div(f32x4_add(floor,increment),f32x4_splat(255.0));
                    v128_store(p.as_mut_ptr().cast(),rounded);
                }
            }
            #[cfg(not(all(target_arch="wasm32",target_feature="simd128")))]
            {for c in 0..3 {p[c]=((p[c]*(1.0-alpha)+alpha*rgb[c])*255.0).round()/255.0;}p[3]=((p[3]+alpha*(1.0-p[3]))*255.0).round()/255.0;}
        }}
    }

    fn project_rectangle(shape:&mut Shape) {
        if let Shape::Polygon(p)=shape {if p.order==4 {
            let cx=p.x.iter().sum::<f64>()/4.0;let cy=p.y.iter().sum::<f64>()/4.0;
            let ux=(p.x[1]-p.x[0]+p.x[2]-p.x[3])/4.0;let uy=(p.y[1]-p.y[0]+p.y[2]-p.y[3])/4.0;
            let radius=(ux*ux+uy*uy).sqrt().max(1e-8);let dx=ux/radius;let dy=uy/radius;
            let vx=(p.x[3]-p.x[0]+p.x[2]-p.x[1])/4.0;let vy=(p.y[3]-p.y[0]+p.y[2]-p.y[1])/4.0;
            let cap=f64::from(crate::shapes::rect_aspect());let width=radius.max(0.5);let height=(-dy*vx+dx*vy).abs().clamp((width/cap).max(0.5),width*cap);
            for (i,(a,b)) in [(-1.0,-1.0),(1.0,-1.0),(1.0,1.0),(-1.0,1.0)].iter().enumerate(){p.x[i]=cx+a*width*dx-b*height*dy;p.y[i]=cy+a*width*dy+b*height*dx;}
        }}
    }

    fn layer_sums(&self,lines:&[Scanline],base:&[[f32;4]],suffix:&[[f64;4]],transmission:&[f64])->Sums {
        let mut sums=[0.0;N];
        for line in lines {for x in line.x1..=line.x2 {
            let pixel=line.y as usize*self.width as usize+x as usize;
            if transmission[pixel]==0.0 {continue;}
            let b=base[pixel].map(f64::from);
            let coverage=line.coverage()*transmission[pixel];let square=coverage*coverage;let detail=self.detail_weight(pixel);
            sums[0]+=square*detail;
            for c in 0..3 {
                let residual=self.target[pixel][c]-suffix[pixel][c]-transmission[pixel]*b[c];
                sums[1+c]+=detail*coverage*residual;sums[4+c]+=detail*square*b[c];sums[7]+=detail*square*b[c]*b[c];sums[8]+=detail*coverage*b[c]*residual;
            }
            let residual=self.target[pixel][3]-suffix[pixel][3]-transmission[pixel]*b[3];
            let weight=self.alpha_weight(pixel);
            sums[9]+=weight*coverage*(1.0-b[3])*residual;sums[10]+=weight*square*(1.0-b[3]).powi(2);
        }}
        sums
    }

    fn layer_prefix_sums(&self,lines:&[Scanline],base:&[[f32;4]],suffix:&[[f64;4]],transmission:&[f64],rows:&[OnceLock<Vec<Sums>>],spare:Option<&[Mutex<Vec<Sums>>]>)->Sums {
        let mut sums=[0.0;N];let width=self.width as usize;
        for line in lines {
            let row=rows[line.y as usize].get_or_init(||{
                let mut prefix=spare.map(|pool|std::mem::take(&mut *pool[line.y as usize].lock().expect("row scratch is not poisoned"))).unwrap_or_default();
                prefix.resize(width+1,[0.0;N]);prefix[0]=[0.0;N];let offset=line.y as usize*width;
                for x in 0..width {
                    let pixel=offset+x;let t=transmission[pixel];
                    if t==0.0 {prefix[x+1]=prefix[x];continue;}
                    let b=base[pixel].map(f64::from);let square=t*t;
                    let mut v=[0.0;N];v[0]=square;
                    for c in 0..3 {let residual=self.target[pixel][c]-suffix[pixel][c]-t*b[c];v[1+c]=t*residual;v[4+c]=square*b[c];v[7]+=square*b[c]*b[c];v[8]+=t*b[c]*residual;}
                    let residual=self.target[pixel][3]-suffix[pixel][3]-t*b[3];let weight=self.alpha_weight(pixel);
                    v[9]=weight*t*(1.0-b[3])*residual;v[10]=weight*square*(1.0-b[3]).powi(2);
                    for value in &mut v[..9]{*value*=self.detail_weight(pixel);}
                    for k in 0..N {prefix[x+1][k]=prefix[x][k]+v[k];}
                }
                prefix
            });
            let left=&row[line.x1 as usize];let right=&row[line.x2 as usize+1];let a=line.coverage();let a2=a*a;
            for k in 0..N {sums[k]+=(right[k]-left[k])*if matches!(k,1..=3|8|9){a}else{a2};}
        }
        sums
    }

    /// Revisit geometry as well as color/opacity, using Primeval's adaptive
    /// four-climb refinement. Checkpoint/replay bounds activation memory to
    /// the original 64 MiB budget instead of storing a full canvas per layer.
    pub fn refine(&mut self,cancelled:impl FnMut()->bool)->bool {self.refine_passes(12,crate::refine::ROUNDS,cancelled)}
    /// Short alpha refinement for latency-oriented execution.
    pub fn refine_fast(&mut self,cancelled:impl FnMut()->bool)->bool {self.refine_passes(1,2,cancelled)}
    /// Initial boundary adjustment before residual controls are placed.
    pub fn refine_initial_fast(&mut self,cancelled:impl FnMut()->bool)->bool {self.refine_passes(1,2,cancelled)}
    fn background_pixel(&self)->[f32;4]{let a=f32::from(self.background.a)/255.0;[f32::from(self.background.r)/255.0*a,f32::from(self.background.g)/255.0*a,f32::from(self.background.b)/255.0*a,a]}
    /// Reconsider layer families at a fixed control count; callers guard the
    /// exported pixels against the original drawing before accepting the result.
    pub fn refine_mixed(&mut self,cancelled:impl FnMut()->bool)->bool{self.refine_passes(2,6,cancelled)}
    /// Refit colors and opacity with geometry held fixed.
    pub fn polish_colors(&mut self,cancelled:impl FnMut()->bool)->bool {self.refine_passes(1,0,cancelled)}
    fn refine_passes(&mut self,passes:u64,rounds:u64,cancelled:impl FnMut()->bool)->bool {
        self.refine_observed(passes,rounds,cancelled,|_,_,_,_|{})
    }
    /// Observe actual layer work without changing refinement arithmetic or order.
    pub fn refine_observed(&mut self,passes:u64,rounds:u64,mut cancelled:impl FnMut()->bool,mut observer:impl FnMut(u32,u32,usize,&DrawnShape))->bool {
        let n=self.target.len();let count=self.layers.len();if count==0{return true;}
        let plan=crate::refine::replay_plan(count,n*16);
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,17));worker.rgba_reuse=self.optimized;
        let mut lines:Vec<Vec<Scanline>>=self.layers.iter().map(|s|coverage(s,&mut worker,self.exact_coverage).to_vec()).collect();
        let mut refiners:Vec<_>=(0..rounds).map(|_|if self.optimized {let mut work=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::refine_rng(self.seed,0,0,0));work.rgba_reuse=true;Some(work)}else{None}).collect();
        let mut cached_rows:Vec<_>=(0..self.height).map(|_|OnceLock::new()).collect();
        let mut spare_rows:Vec<_>=(0..self.height).map(|_|Mutex::new(Vec::new())).collect();
        for pass in 0..passes {
            let old_shapes=self.shapes.clone();let old_layers=self.layers.clone();let old_score=self.score;let old_contour=self.contour_total();
            let mut forward=vec![self.background_pixel();n];let mut checkpoints=Vec::new();
            for i in 0..count {
                if cancelled(){return false;}
                if i%plan.interval==0 {checkpoints.push(forward.clone());}
                Self::paint(&mut forward,self.width,&lines[i],old_shapes[i].color);
            }
            let mut suffix=vec![[0.0;4];n];let mut transmission=vec![1.0;n];
            for (bottom,top) in plan.runs(count) {
                let segment=bottom/plan.interval;let mut canvas=checkpoints[segment].clone();
                for i in segment*plan.interval..bottom {Self::paint(&mut canvas,self.width,&lines[i],old_shapes[i].color);}
                let mut bases=Vec::with_capacity(top-bottom);
                for i in bottom..top {bases.push(if self.frozen[i]&&rounds==crate::refine::ROUNDS{None}else{Some(canvas.clone())});Self::paint(&mut canvas,self.width,&lines[i],old_shapes[i].color);}
                for i in (bottom..top).rev() {
                    if cancelled(){return false;}
                    if !self.frozen[i]&&rounds>0 {
                    let base=bases[i-bottom].as_ref().expect("active layer has a base canvas");
                    // Reset logical readiness, retaining row allocations. No
                    // climb is running here, so each previous value is owned.
                    let local_rows;
                    let (rows,spare)=if self.optimized {
                        let mut remaining=32*1024*1024;
                        for (row,pool) in cached_rows.iter_mut().zip(&mut spare_rows) {
                            if let Some(data)=row.take(){*pool.get_mut().expect("row scratch is not poisoned")=data;}
                            let data=pool.get_mut().expect("row scratch is not poisoned");
                            let bytes=data.capacity()*std::mem::size_of::<Sums>();
                            if bytes>remaining {*data=Vec::new();}else{remaining-=bytes;}
                        }
                        (&cached_rows[..],Some(&spare_rows[..]))
                    }else{local_rows=(0..self.height).map(|_|OnceLock::new()).collect::<Vec<_>>();(&local_rows[..],None)};
                    // Fast ranks geometry with the native rasterizer. Only the
                    // winning geometry gets export-exact coverage; the repaint
                    // guard below still accepts on that exact composite.
                    let latency=self.family!=ShapeKind::Mixed&&rounds<crate::refine::ROUNDS&&self.width.max(self.height)>256;
                    let exact_proposals=self.exact_coverage&&!latency;
                    let evaluate=|shape:&Shape,work:&mut WorkerCtx<_>|{let (loss,color)=fit(&self.layer_prefix_sums(coverage(shape,work,exact_proposals),base,&suffix,&transmission,rows,spare));self.contour_rank(shape,(loss,color),Some(&transmission))};
                    let initial=if exact_proposals {let (loss,color)=fit(&self.layer_prefix_sums(&lines[i],base,&suffix,&transmission,rows,spare));self.contour_rank(&self.layers[i],(loss,color),Some(&transmission))}
                        else {evaluate(&self.layers[i],&mut worker)};
                    let results:Vec<_>=refiners.par_iter_mut().enumerate().map(|(round,cache)|{
                        let round=round as u64;
                        let mut fresh;
                        let work=if let Some(work)=cache {work.rng=crate::rng::refine_rng(self.seed,pass,i as u64,round);work}else{fresh=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::refine_rng(self.seed,pass,i as u64,round));&mut fresh};
                        let mut best=if self.family==ShapeKind::Mixed&&round>0{crate::mixed::replacement(&self.layers[i],crate::mixed::family((round-1)as usize)).unwrap_or_else(||self.layers[i].clone())}else{self.layers[i].clone()};let changed=best!=self.layers[i];let mut scored=if changed{evaluate(&best,work)}else{initial};let mut age=0;let mut scale=if changed||round==0 {1.0_f64}else if round==1&&rounds>2{1.0/16.0}else{1.0/64.0};
                        let minimum_gain=if latency {1e-6_f64.max(initial.0.abs()*1e-4)}else{1e-12};
                        let patience=if rounds<crate::refine::ROUNDS {if latency {12}else{25}}else{50};
                        while age<patience {
                            let mut candidate=best.clone();let step=if matches!(&candidate,Shape::RotatedRectangle(_)){scale.max(1.0/16.0)}else{scale};candidate.mutate(work,Step::Scaled(step));if matches!(self.family,ShapeKind::RotatedRectangle|ShapeKind::Mixed){Self::project_rectangle(&mut candidate);}let trial=evaluate(&candidate,work);
                            let kept=trial.0<scored.0-minimum_gain;scale=(scale*if kept{2.0}else{0.8408964152537145}).clamp(1.0/256.0,1.0);
                            if kept {best=candidate;scored=trial;age=0;}else{age+=1;}
                        }
                        (best,scored)
                    }).collect();
                    let (shape,(_,color))=results.into_iter().enumerate().min_by(|(ia,a),(ib,b)|a.1.0.total_cmp(&b.1.0).then(ia.cmp(ib))).unwrap().1;
                    if shape!=self.layers[i]{lines[i]=coverage(&shape,&mut worker,self.exact_coverage).to_vec();}
                    self.layers[i]=shape;self.shapes[i]=DrawnShape{geometry:self.layers[i].geometry(),color};
                    }
                    if rounds==0||(self.frozen[i]&&rounds<crate::refine::ROUNDS) {
                        let base=bases[i-bottom].as_ref().expect("color-fit layer has a base canvas");
                        self.shapes[i].color=fit(&self.layer_sums(&lines[i],base,&suffix,&transmission)).1;
                    }
                    observer((pass as usize*count+count-i)as u32,(passes as usize*count)as u32,i,&self.shapes[i]);
                    let color=self.shapes[i].color;
                    let a=f64::from(color.a)/255.0;let rgb=[color.r,color.g,color.b].map(|v|f64::from(v)/255.0);
                    if color.a==0{continue;}
                    for line in &lines[i] {let alpha=a*line.coverage();for x in line.x1..=line.x2 {
                        let p=line.y as usize*self.width as usize+x as usize;
                        if transmission[p]==0.0 {continue;}
                        let weight=transmission[p]*alpha;
                        for c in 0..3{suffix[p][c]+=weight*rgb[c];}suffix[p][3]+=weight;transmission[p]*=1.0-alpha;
                    }}
                }
            }
            let mut actual=vec![self.background_pixel();n];
            for (i,drawn) in self.shapes.iter().enumerate(){Self::paint(&mut actual,self.width,&lines[i],drawn.color);}
            let actual:Vec<[f64;4]>=actual.into_iter().map(|p|p.map(f64::from)).collect();
            let score=self.loss(&actual);
            let contour=self.contour_total();
            if score+contour<=old_score+old_contour+1e-10 {self.current=actual;self.score=score;}
            else {
                let restored:Vec<_>=if self.contour_strength>0.0{self.shapes.iter().zip(&old_shapes).enumerate().filter_map(|(i,(a,b))|(a!=b).then_some(i)).collect()}else{Vec::new()};
                self.layers=old_layers;self.shapes=old_shapes;lines=self.layers.iter().map(|s|coverage(s,&mut worker,self.exact_coverage).to_vec()).collect();
                // Pause/download previews must reflect the accepted construction,
                // including a whole-pass rollback after conditional layer fits.
                for i in restored {observer(((pass+1)as usize*count)as u32,(passes as usize*count)as u32,i,&self.shapes[i]);}
            }
            if pass>=2 && old_score+old_contour-self.score-self.contour_total()<=(old_score+old_contour)*0.0001 {break;}
        }
        for y in 0..self.height as usize {self.update_row(y);}
        true
    }

    fn loss(&self,canvas:&[[f64;4]])->f64 {
        self.target.iter().zip(canvas).enumerate().map(|(i,(t,p))|(0..4).map(|c|(t[c]-p[c]).powi(2)*if c==3{self.alpha_weight(i)}else{self.detail_weight(i)}).sum::<f64>()).sum()
    }

    /// Reuse invisible controls for residual correction without raising the
    /// user's count. Removing alpha-zero layers does not change the composite.
    pub fn recycle_empty(&mut self,kind:ShapeKind,cancelled:impl FnMut()->bool)->bool {self.recycle_impl(kind,false,cancelled,||{})}
    /// Reuse invisible controls with localized residual proposals.
    pub fn recycle_fast(&mut self,kind:ShapeKind,cancelled:impl FnMut()->bool,placed:impl FnMut())->bool {self.recycle_impl(kind,true,cancelled,placed)}
    fn recycle_impl(&mut self,kind:ShapeKind,fast:bool,cancelled:impl FnMut()->bool,placed:impl FnMut())->bool {self.recycle_observed(kind,fast,cancelled,placed,|_,_,_,_|{})}
    /// Observe residual replacement refinement without changing its schedule.
    pub fn recycle_observed(&mut self,kind:ShapeKind,fast:bool,mut cancelled:impl FnMut()->bool,mut placed:impl FnMut(),observer:impl FnMut(u32,u32,usize,&DrawnShape))->bool {
        if self.score<1e-12{return true;}
        let total=self.shapes.len();
        let mut shapes=Vec::new();let mut layers=Vec::new();let mut frozen=Vec::new();
        for i in 0..total {if self.shapes[i].color.a>0 {shapes.push(self.shapes[i].clone());layers.push(self.layers[i].clone());frozen.push(self.frozen[i]);}}
        self.shapes=shapes;self.layers=layers;self.frozen=frozen;
        let vacancies=total-self.shapes.len();
        self.fast_residual=fast;
        // Use the native analytical rasterizer for proposals, then repaint and
        // refine with export-exact coverage. Avoid a tiny-skia path per random
        // proposal; exact alpha/color fitting still decides the final layers.
        let exact=self.exact_coverage;
        if fast&&self.width.max(self.height)>256{self.exact_coverage=false;}
        for _ in 0..vacancies {if cancelled(){self.exact_coverage=exact;self.fast_residual=false;return false;}self.step(kind);}
        self.exact_coverage=exact;
        self.fast_residual=false;
        if vacancies>0 {
            let mut canvas=vec![self.background_pixel();self.target.len()];
            let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,19));worker.rgba_reuse=self.optimized;
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,self.exact_coverage),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            for y in 0..self.height as usize{self.update_row(y);}
        }
        placed();
        if vacancies>0 {let ok=self.refine_observed(if fast{1}else{12},if fast{2}else{crate::refine::ROUNDS},&mut cancelled,observer);if !ok{return false;}}
        true
    }

    /// Normalized RGBA error, including the alpha weight.
    pub fn score(&self)->f64 {(self.score/(self.target.len() as f64*(3.0+ALPHA_WEIGHT))).sqrt()}
    /// Final independent shapes. No source pixels or masks are required.
    /// Intermediate primitive state for a throttled progress preview.
    pub fn snapshot(&self)->Drawing {Drawing{width:self.width,height:self.height,background:self.background,shapes:self.shapes.clone()}}
    pub fn drawing(self)->Drawing {Drawing{width:self.width,height:self.height,background:self.background,shapes:self.shapes}}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_channel_masks_and_pruning_preserve_candidate_results() {
        let target=vec![[0.2,0.4,0.6,1.0];32*32];
        let mut model=RgbaModel::new(32,32,target,Some(42));
        model.grid.compute(&model.proposal,&model.canvas);model.exact_coverage=true;
        let round=SearchRound{half_resolution:false,target:&model.proposal,current:&model.canvas,error_grid:&model.grid,score:0,coarse:None};
        let mut worker=WorkerCtx::new(32,32,crate::rng::create_rng(527));
        let mut other=WorkerCtx::new(32,32,crate::rng::create_rng(526));
        let mut accelerated=WorkerCtx::new(32,32,crate::rng::create_rng(526));accelerated.rgba_reuse=true;
        for kind in [ShapeKind::Triangle,ShapeKind::RotatedEllipse,ShapeKind::RotatedRectangle] {
            for _ in 0..100 {
                let shape=Shape::random(kind,&mut worker,&round);
                let mask=coverage(&shape,&mut worker,true).to_vec();
                assert_eq!(mask,coverage_rgba_reference(&shape,&mut other,true));
                assert_eq!(mask,coverage(&shape,&mut accelerated,true));
                let score=model.evaluate(&mask);
                let bound=-2.0;let pruned=model.evaluate_shape(&shape,&mut worker,bound);
                assert_eq!(score.0<bound,pruned.0<bound);
                if score.0<bound {assert_eq!(score,pruned);}
            }
        }
    }
    #[test]
    fn exact_acceleration_preserves_search_and_refinement() {
        let target:Vec<_>=(0..256).map(|i|if i%16>=3&&i%16<13&&i/16>=3&&i/16<13 {
            let a=if i%16==3 {0.5}else{1.0};[0.7*a,(i%16) as f64/20.0*a,0.2*a,a]
        }else{[0.0;4]}).collect();
        for kind in [ShapeKind::Triangle,ShapeKind::RotatedEllipse,ShapeKind::RotatedRectangle] {
            let mut original=RgbaModel::new(16,16,target.clone(),Some(42));original.exact_coverage=true;
            let mut accelerated=RgbaModel::new(16,16,target.clone(),Some(42));accelerated.exact_coverage=true;accelerated.enable_exact_optimizations();
            for _ in 0..4 {
                assert_eq!(original.step(kind),accelerated.step(kind));
                assert_eq!(original.current,accelerated.current);
            }
            assert!(original.refine(||false));assert!(accelerated.refine(||false));
            assert_eq!(original.shapes,accelerated.shapes,"{kind:?}");
            assert_eq!(original.current,accelerated.current,"{kind:?}");
            assert_eq!(original.score,accelerated.score,"{kind:?}");
        }
    }
    #[test]
    fn cached_sums_and_closed_form_match_reference_math() {
        use rand::RngExt;
        let mut rng=crate::rng::create_rng(84921);
        for _ in 0..1000 {
            let mut pixel=||{let a=rng.random::<f64>();[rng.random::<f64>()*a,rng.random::<f64>()*a,rng.random::<f64>()*a,a]};
            let target:Vec<_>=(0..64).map(|_|pixel()).collect();
            let base:Vec<_>=(0..64).map(|_|pixel().map(|v|v as f32)).collect();
            let suffix:Vec<_>=(0..64).map(|_|pixel()).collect();
            let transmission:Vec<_>=suffix.iter().map(|p|1.0-p[3]).collect();
            let mut model=RgbaModel::new(16,4,target,Some(42));
            if rng.random::<bool>(){model.detail_weights=(0..64).map(|_|rng.random_range(1.0..4.0)).collect();}
            let lines:Vec<_>=(0..4).map(|y|Scanline{y,x1:rng.random_range(0..8),x2:rng.random_range(8..16),alpha:rng.random_range(1..65536)}).collect();
            let rows:Vec<_>=(0..4).map(|_|OnceLock::new()).collect();
            let direct=model.layer_sums(&lines,&base,&suffix,&transmission);
            let cached=model.layer_prefix_sums(&lines,&base,&suffix,&transmission,&rows,None);
            for c in 0..N {assert!((direct[c]-cached[c]).abs()<1e-10);}
            let new=fit(&direct);let old=quantized_fit(&direct,binary_alpha(&direct));
            assert!(new.0<=old.0+1e-9,"closed-form loss {} vs binary {}",new.0,old.0);
            if (new.0-old.0).abs()>1e-10 {assert_eq!(new.1,old.1);}
        }
    }
    #[test]
    fn transparent_target_never_paints_hidden_rgb() {
        let mut model=RgbaModel::new(16,16,vec![[0.0;4];256],Some(42));
        for kind in [ShapeKind::Triangle,ShapeKind::RotatedEllipse,ShapeKind::RotatedRectangle] {assert_eq!(model.step(kind).color.a,0);}
        assert_eq!(model.score(),0.0);
    }
    #[test]
    fn fits_semitransparent_color() {
        let mut model=RgbaModel::new(16,16,vec![[0.4,0.1,0.2,0.5];256],Some(42));
        let before=model.score();for _ in 0..8 {model.step(ShapeKind::RotatedRectangle);}
        assert!(model.score()<before*0.1);
        let exact:f64=model.target.iter().zip(&model.current).map(|(t,p)|(0..4).map(|c|(t[c]-p[c]).powi(2)*if c==3{ALPHA_WEIGHT}else{1.0}).sum::<f64>()).sum();
        assert!((model.score-exact).abs()<1e-10,"prefix score must match the independently recomputed canvas loss");
        let score=model.score();assert!(model.refine(||false));assert!(model.score()<=score+1e-7);
        assert_eq!(model.drawing().background.a,0);
    }
    #[test]
    fn analytic_fit_matches_direct_source_over_delta() {
        let target=[0.3,0.2,0.1,0.5];let current=[0.1,0.05,0.02,0.2];let coverage=0.7;
        let mut s=[0.0;N];s[0]=coverage*coverage;
        for c in 0..3 {let d=target[c]-current[c];s[1+c]=coverage*d;s[4+c]=coverage*coverage*current[c];s[7]+=coverage*coverage*current[c]*current[c];s[8]+=coverage*current[c]*d;}
        s[9]=ALPHA_WEIGHT*coverage*(1.0-current[3])*(target[3]-current[3]);s[10]=ALPHA_WEIGHT*coverage*coverage*(1.0-current[3])*(1.0-current[3]);
        let (delta,color)=fit(&s);let alpha=f64::from(color.a)/255.0*coverage;
        let mut direct=0.0;
        for c in 0..4 {let old=current[c];let new=old*(1.0-alpha)+alpha*if c==3{1.0}else{f64::from([color.r,color.g,color.b][c])/255.0};let weight=if c==3{ALPHA_WEIGHT}else{1.0};direct+=weight*((target[c]-new).powi(2)-(target[c]-old).powi(2));}
        assert!((delta-direct).abs()<1e-12);
    }
    #[test]
    fn seeded_fractional_rectangle_preserves_geometry_and_opaque_color() {
        use crate::Point;
        let color=Color::new(102,51,204,255);
        let drawing=Drawing{width:16,height:16,background:Color::new(240,240,245,255),shapes:vec![DrawnShape{geometry:Geometry::Polygon(vec![Point::new(-0.25,-0.25),Point::new(16.25,-0.25),Point::new(16.25,16.25),Point::new(-0.25,16.25)]),color}]};
        let mut model=RgbaModel::new(16,16,vec![[0.4,0.2,0.8,1.0];256],Some(42));
        assert!(model.seed_drawing(&drawing,ShapeKind::RotatedRectangle));
        assert_eq!(model.shapes[0].geometry,drawing.shapes[0].geometry);
        assert!(model.refine(||false));assert!(model.score()<1e-6);
        let result=model.drawing();assert_eq!(result.shapes.len(),1);assert_eq!(result.background.a,0);
        if let Geometry::Polygon(p)=&result.shapes[0].geometry {let dot=(p[1].x-p[0].x)*(p[2].x-p[1].x)+(p[1].y-p[0].y)*(p[2].y-p[1].y);assert!(dot.abs()<1e-8);}else{panic!("rectangle geometry lost");}
    }
    #[test]
    fn seed_can_remove_opaque_background_spill() {
        use crate::Point;
        let shape=DrawnShape{geometry:Geometry::Polygon(vec![Point::new(0.0,0.0),Point::new(16.0,0.0),Point::new(16.0,16.0),Point::new(0.0,16.0)]),color:Color::new(102,51,204,255)};
        let drawing=Drawing{width:16,height:16,background:Color::new(240,240,245,255),shapes:vec![shape;20]};
        let target=(0..256).map(|i|if i%16>=4&&i%16<12&&i/16>=4&&i/16<12{[0.4,0.2,0.8,1.0]}else{[0.0;4]}).collect();
        let mut model=RgbaModel::new(16,16,target,Some(42));assert!(model.seed_drawing(&drawing,ShapeKind::RotatedRectangle));let score=model.score();assert!(model.refine(||false));
        eprintln!("seed score {score} refined {}",model.score());assert!(model.score()<score*0.5);
    }
    #[test]
    fn opaque_detail_layers_remain_identical_to_reference() {
        use crate::Point;
        let rect=|lo,hi,color|DrawnShape{geometry:Geometry::Polygon(vec![Point::new(lo,lo),Point::new(hi,lo),Point::new(hi,hi),Point::new(lo,hi)]),color};
        let detail=rect(6.0,10.0,Color::new(40,180,220,192));
        let drawing=Drawing{width:16,height:16,background:Color::new(240,240,245,255),shapes:vec![rect(0.0,16.0,Color::new(200,160,80,255)),detail.clone()]};
        let target=(0..256).map(|i|if i%16>=2&&i%16<14&&i/16>=2&&i/16<14{[0.5,0.4,0.2,1.0]}else{[0.0;4]}).collect();
        let mut model=RgbaModel::new(16,16,target,Some(42));assert!(model.seed_with_base(&drawing,ShapeKind::RotatedRectangle,1));assert!(model.frozen[1]);
        assert!(model.refine(||false));assert_eq!(model.shapes[1],detail);
    }
    #[test]
    fn fast_color_polish_keeps_geometry_and_reduces_source_error() {
        use crate::Point;
        let detail=DrawnShape{geometry:Geometry::Polygon(vec![Point::new(4.0,4.0),Point::new(12.0,4.0),Point::new(12.0,12.0),Point::new(4.0,12.0)]),color:Color::new(40,180,220,255)};
        let drawing=Drawing{width:16,height:16,background:Color::new(0,0,0,0),shapes:vec![detail.clone()]};
        let target=(0..256).map(|i|if i%16>=4&&i%16<12&&i/16>=4&&i/16<12{[0.8,0.2,0.4,1.0]}else{[0.0;4]}).collect();
        let mut model=RgbaModel::new(16,16,target,Some(42));
        assert!(model.seed_drawing(&drawing,ShapeKind::RotatedRectangle));
        model.frozen[0]=true;
        let before=model.score();assert!(model.polish_colors(||false));
        assert!(model.score()<before*0.1);
        assert_eq!(model.shapes.len(),1);assert_eq!(model.shapes[0].geometry,detail.geometry);
        assert!(!model.refine_fast(||true),"fast refinement must honor cancellation");
    }
    #[test]
    fn fast_residual_reuses_every_empty_control_and_reduces_exact_loss() {
        use crate::Point;
        let shape=DrawnShape{geometry:Geometry::Polygon(vec![Point::new(0.0,0.0),Point::new(16.0,0.0),Point::new(16.0,16.0),Point::new(0.0,16.0)]),color:Color::new(120,60,180,255)};
        let drawing=Drawing{width:16,height:16,background:Color::new(0,0,0,0),shapes:vec![shape;20]};
        let target=(0..256).map(|i|if i%16>=4&&i%16<12&&i/16>=4&&i/16<12{[0.4,0.2,0.6,1.0]}else{[0.0;4]}).collect();
        let mut model=RgbaModel::new(16,16,target,Some(42));
        assert!(model.seed_drawing(&drawing,ShapeKind::RotatedRectangle));
        assert!(model.shapes.iter().all(|s|s.color.a==0));
        let before=model.score();let mut placed=false;
        assert!(model.recycle_fast(ShapeKind::RotatedRectangle,||false,||placed=true));
        assert!(placed);assert!(model.polish_colors(||false));
        assert!(model.score()<before*0.2,"exact loss before {before}, after {}",model.score());
        assert_eq!(model.drawing().shapes.len(),20);
    }
}
