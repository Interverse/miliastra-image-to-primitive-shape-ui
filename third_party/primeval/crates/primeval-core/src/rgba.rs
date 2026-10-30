//! Source-alpha fitting on a transparent canvas. Opaque Model is unchanged.
//! Scores premultiplied RGB plus alpha (weight 4), using the original shape
//! generators, coverage rasterizers and mutations. No source mask is exported.
use crate::{Buffer, Color, Drawing, DrawnShape, ShapeKind, Geometry};
use crate::error_grid::ErrorGrid;
use crate::worker::{WorkerCtx, SearchRound, RoundEffort};
use crate::shapes::{Shape, Step, Polygon, RotatedEllipse};
use crate::scanline::Scanline;
use rayon::prelude::*;

const N: usize = 11;
const ALPHA_WEIGHT: f64 = 4.0;
fn alpha_weight(alpha:f64)->f64 {if alpha==0.0 {16.0}else{ALPHA_WEIGHT}}
type Sums = [f64; N];

fn coverage<'a,R:rand::Rng>(shape:&Shape,worker:&'a mut WorkerCtx<R>,exact:bool)->&'a [Scanline] {
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
    // The eliminated quadratic is convex; locate its minimum, then score the
    // adjacent byte opacities with quantized straight RGB, as exported.
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
    let base=((lo+hi)*127.5).floor() as u8;
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
    prefix:Vec<Sums>, proposal:Buffer, canvas:Buffer, grid:ErrorGrid,
    seed:u64, shapes:Vec<DrawnShape>, layers:Vec<Shape>, score:f64,family:ShapeKind,exact_coverage:bool,frozen:Vec<bool>,
}

impl RgbaModel {
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
        let mut model=Self{width,height,target,current,prefix:vec![[0.0;N];(width as usize+1)*height as usize],proposal,canvas,grid:ErrorGrid::new(width,height,16,16),seed:seed.unwrap_or_else(crate::util::entropy_seed),shapes:Vec::new(),layers:Vec::new(),score,family:ShapeKind::Any,exact_coverage:false,frozen:Vec::new()};
        for y in 0..height as usize {model.update_row(y);}
        model
    }

    /// Start from the complete opaque search/refinement instead of replacing
    /// its allocation of fine detail with a second independent greedy fit.
    pub fn seed_drawing(&mut self,drawing:&Drawing,kind:ShapeKind)->bool {
        self.seed_with_base(drawing,kind,0)
    }

    /// Retain a previously alpha-fitted foundation under original detail layers.
    pub fn seed_with_base(&mut self,drawing:&Drawing,kind:ShapeKind,base_count:usize)->bool {
        if drawing.width!=self.width||drawing.height!=self.height{return false;}
        self.grid.compute(&self.proposal,&self.canvas);
        let round=SearchRound{half_resolution:false,target:&self.proposal,current:&self.canvas,error_grid:&self.grid,score:0,coarse:None};
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,18));
        let template=Shape::random(kind,&mut worker,&round);
        let Some(layers)=drawing.shapes.iter().map(|s|{
            if kind==ShapeKind::Triangle {if let Geometry::Polygon(p)=&s.geometry {if p.len()==3 {
                return Some(Shape::Polygon(Polygon{order:3,x:[p[0].x,p[1].x,p[2].x,0.0],y:[p[0].y,p[1].y,p[2].y,0.0]}));
            }}}
            if kind==ShapeKind::RotatedEllipse {if let Geometry::Ellipse{cx,cy,rx,ry,rotation}=&s.geometry {
                if *rx>0.0&&*ry>0.0 {return Some(Shape::RotatedEllipse(RotatedEllipse{x:*cx,y:*cy,rx:*rx,ry:*ry,angle:*rotation}));}
            }}
            if kind==ShapeKind::RotatedRectangle {if let Geometry::Polygon(p)=&s.geometry {if p.len()==4 {
                return Some(Shape::Polygon(Polygon{order:4,x:[p[0].x,p[1].x,p[2].x,p[3].x],y:[p[0].y,p[1].y,p[2].y,p[3].y]}));
            }}}
            template.adopted(&s.geometry,self.width,self.height)
        }).collect::<Option<Vec<_>>>() else{return false;};
        let mut canvas=vec![[0.0_f32;4];self.target.len()];let mut shapes=drawing.shapes.clone();let mut frozen=vec![false;shapes.len()];
        for (index,(shape,drawn)) in layers.iter().zip(&mut shapes).enumerate(){
            let lines=coverage(shape,&mut worker,true);let mut alpha=0.0;let mut area=0.0;let mut safe=true;
            for line in lines {for x in line.x1..=line.x2 {let weight=line.coverage();area+=weight;alpha+=weight*self.target[line.y as usize*self.width as usize+x as usize][3];for dy in -1..=1 {for dx in -1..=1 {let xx=x+dx;let yy=line.y+dy;if xx<0||yy<0||xx>=self.width as i32||yy>=self.height as i32||self.target[yy as usize*self.width as usize+xx as usize][3]<254.0/255.0{safe=false;}}}}}
            // Do not initialize a deep opaque stack outside the silhouette:
            // saturated alpha has no coordinate gradient until every layer
            // covering it is removed. Interior reference layers remain intact;
            // boundary/background layers are free to regrow during RGBA fitting.
            if index>=base_count&&area>0.0&&alpha/area<0.995 {drawn.color.a=0;}
            frozen[index]=index>=base_count&&area>0.0&&safe;
            Self::paint(&mut canvas,self.width,lines,drawn.color);
        }
        self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
        self.layers=layers;self.shapes=shapes;self.family=kind;self.exact_coverage=true;self.frozen=frozen;
        for y in 0..self.height as usize {self.update_row(y);}
        true
    }

    fn update_row(&mut self,y:usize) {
        let w=self.width as usize;let base=y*(w+1);self.prefix[base]=[0.0;N];
        for x in 0..w {
            let i=y*w+x;let t=self.target[i];let c=self.current[i];
            let mut v=[0.0;N];v[0]=1.0;
            for k in 0..3 {let d=t[k]-c[k];v[1+k]=d;v[4+k]=c[k];v[7]+=c[k]*c[k];v[8]+=c[k]*d;}
            v[9]=alpha_weight(t[3])*(1.0-c[3])*(t[3]-c[3]);v[10]=alpha_weight(t[3])*(1.0-c[3]).powi(2);
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

    /// Add one shape, preserving the original count and geometry constraints.
    pub fn step(&mut self,kind:ShapeKind) -> &DrawnShape {
        self.family=kind;
        self.grid.compute(&self.proposal,&self.canvas);
        let round=SearchRound{half_resolution:false,target:&self.proposal,current:&self.canvas,error_grid:&self.grid,score:0,coarse:None};
        let effort=RoundEffort::of(kind);let step=self.shapes.len() as u64;
        let search=|index:u64| {
            let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,step,index));
            let mut shape=Shape::random(kind,&mut worker,&round);
            let mut scored=self.evaluate(coverage(&shape,&mut worker,self.exact_coverage));
            for _ in 1..effort.candidates {
                let candidate=Shape::random(kind,&mut worker,&round);
                let score=self.evaluate(coverage(&candidate,&mut worker,self.exact_coverage));
                if score.0<scored.0 {shape=candidate;scored=score;}
            }
            let mut age=0;
            while age<effort.age {
                let mut candidate=shape.clone();candidate.mutate(&mut worker,Step::Coarse);
                let score=self.evaluate(coverage(&candidate,&mut worker,self.exact_coverage));
                if score.0<scored.0 {shape=candidate;scored=score;age=0;}else{age+=1;}
            }
            (shape,scored)
        };
        let results:Vec<_>=(0..16_u64).into_par_iter().map(search).collect();
        let (shape,(delta,color))=results.into_iter().enumerate().min_by(|(ia,a),(ib,b)|a.1.0.total_cmp(&b.1.0).then(ia.cmp(ib))).unwrap().1;
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,step,16));
        let lines=coverage(&shape,&mut worker,self.exact_coverage);
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

    fn paint(canvas:&mut [[f32;4]],width:u32,lines:&[Scanline],color:Color) {
        let a=f32::from(color.a)/255.0;let rgb=[color.r,color.g,color.b].map(|v|f32::from(v)/255.0);
        for line in lines {let alpha=a*line.coverage() as f32;for x in line.x1..=line.x2 {
            let p=&mut canvas[line.y as usize*width as usize+x as usize];
            for c in 0..3 {p[c]=((p[c]*(1.0-alpha)+alpha*rgb[c])*255.0).round()/255.0;}p[3]=((p[3]+alpha*(1.0-p[3]))*255.0).round()/255.0;
        }}
    }

    fn project_rectangle(shape:&mut Shape) {
        if let Shape::Polygon(p)=shape {if p.order==4 {
            let cx=p.x.iter().sum::<f64>()/4.0;let cy=p.y.iter().sum::<f64>()/4.0;
            let ux=(p.x[1]-p.x[0]+p.x[2]-p.x[3])/4.0;let uy=(p.y[1]-p.y[0]+p.y[2]-p.y[3])/4.0;
            let radius=(ux*ux+uy*uy).sqrt().max(1e-8);let dx=ux/radius;let dy=uy/radius;
            let vx=(p.x[3]-p.x[0]+p.x[2]-p.x[1])/4.0;let vy=(p.y[3]-p.y[0]+p.y[2]-p.y[1])/4.0;
            let width=radius.max(0.5);let height=(-dy*vx+dx*vy).abs().clamp((width/8.0).max(0.5),width*8.0);
            for (i,(a,b)) in [(-1.0,-1.0),(1.0,-1.0),(1.0,1.0),(-1.0,1.0)].iter().enumerate(){p.x[i]=cx+a*width*dx-b*height*dy;p.y[i]=cy+a*width*dy+b*height*dx;}
        }}
    }

    fn layer_sums(&self,lines:&[Scanline],base:&[[f32;4]],suffix:&[[f64;4]],transmission:&[f64])->Sums {
        let mut sums=[0.0;N];
        for line in lines {for x in line.x1..=line.x2 {
            let pixel=line.y as usize*self.width as usize+x as usize;let b=base[pixel].map(f64::from);
            let coverage=line.coverage()*transmission[pixel];let square=coverage*coverage;
            sums[0]+=square;
            for c in 0..3 {
                let residual=self.target[pixel][c]-suffix[pixel][c]-transmission[pixel]*b[c];
                sums[1+c]+=coverage*residual;sums[4+c]+=square*b[c];sums[7]+=square*b[c]*b[c];sums[8]+=coverage*b[c]*residual;
            }
            let residual=self.target[pixel][3]-suffix[pixel][3]-transmission[pixel]*b[3];
            let weight=alpha_weight(self.target[pixel][3]);
            sums[9]+=weight*coverage*(1.0-b[3])*residual;sums[10]+=weight*square*(1.0-b[3]).powi(2);
        }}
        sums
    }

    /// Revisit geometry as well as color/opacity, using Primeval's adaptive
    /// four-climb refinement. Checkpoint/replay bounds activation memory to
    /// the original 64 MiB budget instead of storing a full canvas per layer.
    pub fn refine(&mut self,mut cancelled:impl FnMut()->bool)->bool {
        let n=self.target.len();let count=self.layers.len();if count==0{return true;}
        let plan=crate::refine::replay_plan(count,n*16);
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,17));
        for pass in 0..12 {
            let old_shapes=self.shapes.clone();let old_layers=self.layers.clone();let old_score=self.score;
            let lines:Vec<Vec<Scanline>>=self.layers.iter().map(|s|coverage(s,&mut worker,self.exact_coverage).to_vec()).collect();
            let mut forward=vec![[0.0_f32;4];n];let mut checkpoints=Vec::new();
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
                for i in bottom..top {bases.push(canvas.clone());Self::paint(&mut canvas,self.width,&lines[i],old_shapes[i].color);}
                for i in (bottom..top).rev() {
                    if cancelled(){return false;}
                    let base=&bases[i-bottom];
                    let evaluate=|shape:&Shape,work:&mut WorkerCtx<_>|fit(&self.layer_sums(coverage(shape,work,self.exact_coverage),base,&suffix,&transmission));
                    if !self.frozen[i] {
                    let initial=evaluate(&self.layers[i],&mut worker);
                    let results:Vec<_>=(0..crate::refine::ROUNDS).into_par_iter().map(|round|{
                        let mut work=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::refine_rng(self.seed,pass,i as u64,round));
                        let mut best=self.layers[i].clone();let mut scored=initial;let mut age=0;let mut scale=if round==0 {1.0_f64}else if round==1{1.0/16.0}else{1.0/64.0};
                        while age<50 {
                            let mut candidate=best.clone();let step=if matches!(&candidate,Shape::RotatedRectangle(_)){scale.max(1.0/16.0)}else{scale};candidate.mutate(&mut work,Step::Scaled(step));if self.family==ShapeKind::RotatedRectangle{Self::project_rectangle(&mut candidate);}let trial=evaluate(&candidate,&mut work);
                            let kept=trial.0<scored.0;scale=(scale*if kept{2.0}else{0.8408964152537145}).clamp(1.0/256.0,1.0);
                            if kept {best=candidate;scored=trial;age=0;}else{age+=1;}
                        }
                        (best,scored)
                    }).collect();
                    let (shape,(_,color))=results.into_iter().enumerate().min_by(|(ia,a),(ib,b)|a.1.0.total_cmp(&b.1.0).then(ia.cmp(ib))).unwrap().1;
                    self.layers[i]=shape;self.shapes[i]=DrawnShape{geometry:self.layers[i].geometry(),color};
                    }
                    let color=self.shapes[i].color;
                    let a=f64::from(color.a)/255.0;let rgb=[color.r,color.g,color.b].map(|v|f64::from(v)/255.0);
                    for line in coverage(&self.layers[i],&mut worker,self.exact_coverage) {let alpha=a*line.coverage();for x in line.x1..=line.x2 {
                        let p=line.y as usize*self.width as usize+x as usize;let weight=transmission[p]*alpha;
                        for c in 0..3{suffix[p][c]+=weight*rgb[c];}suffix[p][3]+=weight;transmission[p]*=1.0-alpha;
                    }}
                }
            }
            let mut actual=vec![[0.0_f32;4];n];
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut actual,self.width,coverage(shape,&mut worker,self.exact_coverage),drawn.color);}
            let actual:Vec<[f64;4]>=actual.into_iter().map(|p|p.map(f64::from)).collect();
            let score=self.loss(&actual);
            if score<=old_score+1e-10 {self.current=actual;self.score=score;}
            else {self.layers=old_layers;self.shapes=old_shapes;}
            if pass>=2 && old_score-self.score<=old_score*0.0001 {break;}
        }
        for y in 0..self.height as usize {self.update_row(y);}
        true
    }

    fn loss(&self,canvas:&[[f64;4]])->f64 {
        self.target.iter().zip(canvas).map(|(t,p)|(0..4).map(|c|(t[c]-p[c]).powi(2)*if c==3{alpha_weight(t[3])}else{1.0}).sum::<f64>()).sum()
    }

    /// Reuse invisible controls for residual correction without raising the
    /// user's count. Removing alpha-zero layers does not change the composite.
    pub fn recycle_empty(&mut self,kind:ShapeKind,mut cancelled:impl FnMut()->bool)->bool {
        if self.score<1e-12{return true;}
        let total=self.shapes.len();
        let mut shapes=Vec::new();let mut layers=Vec::new();let mut frozen=Vec::new();
        for i in 0..total {if self.shapes[i].color.a>0 {shapes.push(self.shapes[i].clone());layers.push(self.layers[i].clone());frozen.push(self.frozen[i]);}}
        self.shapes=shapes;self.layers=layers;self.frozen=frozen;
        let vacancies=total-self.shapes.len();
        for _ in 0..vacancies {if cancelled(){return false;}self.step(kind);}
        if vacancies>0 {
            let mut canvas=vec![[0.0_f32;4];self.target.len()];
            let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,19));
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,self.exact_coverage),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            for y in 0..self.height as usize{self.update_row(y);}
        }
        if vacancies>0&&!self.refine(&mut cancelled){return false;}
        true
    }

    /// Normalized RGBA error, including the alpha weight.
    pub fn score(&self)->f64 {(self.score/(self.target.len() as f64*(3.0+ALPHA_WEIGHT))).sqrt()}
    /// Final independent shapes. No source pixels or masks are required.
    pub fn drawing(self)->Drawing {Drawing{width:self.width,height:self.height,background:Color::new(0,0,0,0),shapes:self.shapes}}
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
