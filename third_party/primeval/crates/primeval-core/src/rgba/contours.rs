//! Source-supported contour regularization. No output geometry or alpha masks.
use super::*;

impl RgbaModel {
    /// Prefer continuous contours during fitting. Zero keeps the numerical path.
    /// Strength is finite in [0, 4]; install before the first fitted layer.
    pub fn set_contour_smoothing(&mut self, strength:f64)->Result<(), &'static str>{
        if !strength.is_finite()||!(0.0..=4.0).contains(&strength)||!self.layers.is_empty(){return Err("Invalid contour smoothing");}
        self.contour_strength=strength;
        if strength==0.0 {self.contour_field.clear();self.contour_normals.clear();return Ok(());}
        let (w,h)=(self.width as usize,self.height as usize);
        // Coherent multichannel gradients indicate locally smooth boundaries.
        // Incoherent corner/texture gradients do not request rounding.
        let mut tensors=vec![[0.0;3];w*h];
        for y in 1..h.saturating_sub(1){for x in 1..w.saturating_sub(1){
            let i=y*w+x;
            for c in 0..4 {let gx=(self.target[i+1][c]-self.target[i-1][c])*0.5;let gy=(self.target[i+w][c]-self.target[i-w][c])*0.5;tensors[i][0]+=gx*gx;tensors[i][1]+=gx*gy;tensors[i][2]+=gy*gy;}
        }}
        self.contour_field=vec![0.0;w*h];
        self.contour_normals=vec![[0.0;2];w*h];
        for y in 0..h {for x in 0..w {
            let mut t=[0.0;3];let mut n=0.0;
            for yy in y.saturating_sub(2)..=(y+2).min(h-1){for xx in x.saturating_sub(2)..=(x+2).min(w-1){for c in 0..3{t[c]+=tensors[yy*w+xx][c];}n+=1.0;}}
            let trace=t[0]+t[2];let coherence=((t[0]-t[2]).powi(2)+4.0*t[1]*t[1])/(trace*trace+1e-20);
            self.contour_field[y*w+x]=coherence*(trace/(trace+0.003*n));
            let angle=0.5*(2.0*t[1]).atan2(t[0]-t[2]);self.contour_normals[y*w+x]=[angle.cos(),angle.sin()];
        }}
        drop(tensors);
        // Preserve explicit corners detected in original edge chains, including
        // acute wedges whose tensor can otherwise resemble a straight edge.
        // Corner analysis has a bounded workspace; fitting and the directional
        // field still use every pixel at the user's full working resolution.
        let ratio=(256.0/w.max(h)as f64).min(1.0);
        let (cw,ch)=((w as f64*ratio).round().max(2.0)as usize,(h as f64*ratio).round().max(2.0)as usize);
        let reduced;
        let source=if ratio==1.0{&self.target}else{
            reduced=(0..cw*ch).map(|i|{let x=((i%cw)as f64/ratio).round()as usize;let y=((i/cw)as f64/ratio).round()as usize;self.target[y.min(h-1)*w+x.min(w-1)]}).collect::<Vec<_>>();&reduced
        };
        for primitive in super::lines::detect(cw,ch,source){
            if let super::lines::Primitive::Corner{x,y,..}=primitive {
                let (cx,cy)=((x/ratio).round()as isize,(y/ratio).round()as isize);
                for dy in -2..=2 {for dx in -2..=2 {let (xx,yy)=(cx+dx,cy+dy);if xx>=0&&yy>=0&&xx<w as isize&&yy<h as isize {
                    let distance=((dx*dx+dy*dy)as f64).sqrt();self.contour_field[yy as usize*w+xx as usize]*=((distance-1.0)/2.0).clamp(0.0,1.0);
                }}}
            }
        }
        Ok(())
    }

    fn contour_target(&self,x:f64,y:f64)->Option<[f64;4]>{
        if x<0.0||y<0.0||x>f64::from(self.width-1)||y>f64::from(self.height-1){return None;}
        let (ix,iy)=(x.floor()as usize,y.floor()as usize);let (fx,fy)=(x-ix as f64,y-iy as f64);let w=self.width as usize;
        let (jx,jy)=((ix+1).min(w-1),(iy+1).min(self.height as usize-1));
        Some(std::array::from_fn(|c|self.target[iy*w+ix][c]*(1.0-fx)*(1.0-fy)+self.target[iy*w+jx][c]*fx*(1.0-fy)+self.target[jy*w+ix][c]*(1.0-fx)*fy+self.target[jy*w+jx][c]*fx*fy))
    }

    fn contour_contrast(&self,paint:[f64;3],x:f64,y:f64)->f64 {
        self.contour_target(x,y).map_or(0.0,|t|(0..3).map(|c|(paint[c]*t[3]-t[c]).powi(2)).sum::<f64>()+(1.0-t[3]).powi(2))
    }

    fn contour_edge(&self,x:f64,y:f64,nx:f64,ny:f64,paint:[f64;3],transmission:Option<&[f64]>)->f64{
        let field=self.contour_sample(&self.contour_field,x,y);if field<1e-8{return 0.0;}
        let (ix,iy)=(x.round()as usize,y.round()as usize);
        let [sx,sy]=self.contour_normals[iy.min(self.height as usize-1)*self.width as usize+ix.min(self.width as usize-1)];
        let mismatch=(1.0-(nx*sx+ny*sy).powi(2)).max(0.0);
        let visible=transmission.map_or(1.0,|t|self.contour_sample(t,x,y));
        field*mismatch*visible*visible*self.contour_contrast(paint,x+nx*1.5,y+ny*1.5)
    }

    fn contour_sample(&self,values:&[f64],x:f64,y:f64)->f64 {
        if x<0.0||y<0.0||x>f64::from(self.width-1)||y>f64::from(self.height-1){return 0.0;}
        let (ix,iy)=(x.floor()as usize,y.floor()as usize);let (fx,fy)=(x-ix as f64,y-iy as f64);let w=self.width as usize;
        let (jx,jy)=((ix+1).min(w-1),(iy+1).min(self.height as usize-1));
        values[iy*w+ix]*(1.0-fx)*(1.0-fy)+values[iy*w+jx]*fx*(1.0-fy)+values[jy*w+ix]*(1.0-fx)*fy+values[jy*w+jx]*fx*fy
    }

    /// Cost of visible unsupported turns and mismatched edge direction.
    /// Source-flat paint regions and fully occluded boundaries have no cost.
    pub(super) fn contour_cost(&self,shape:&Shape,color:Color,transmission:Option<&[f64]>)->f64 {
        if self.contour_strength==0.0||color.a==0{return 0.0;}
        let alpha=f64::from(color.a)/255.0;
        let paint=[color.r,color.g,color.b].map(|v|f64::from(v)/255.0);
        let geometry=shape.geometry();
        if let Geometry::Ellipse{cx,cy,rx,ry,rotation}=geometry {
            let mut edge=0.0;let (sn,cs)=rotation.to_radians().sin_cos();
            for j in 0..24 {let (s,c)=(j as f64*std::f64::consts::TAU/24.0).sin_cos();let (nx,ny)=(c/rx.max(1e-9),s/ry.max(1e-9));let norm=nx.hypot(ny);let (nx,ny)=((nx*cs-ny*sn)/norm,(nx*sn+ny*cs)/norm);
                edge+=self.contour_edge(cx+rx*c*cs-ry*s*sn,cy+rx*c*sn+ry*s*cs,nx,ny,paint,transmission);
            }
            let perimeter=std::f64::consts::PI*(3.0*(rx+ry)-((3.0*rx+ry)*(rx+3.0*ry)).sqrt());
            return self.contour_strength*alpha*alpha*0.25*perimeter/24.0*edge;
        }
        let Geometry::Polygon(points)=geometry else{return 0.0;};
        if points.len()<3{return 0.0;}
        let mut sum=0.0;
        let center=(points.iter().map(|p|p.x).sum::<f64>()/points.len()as f64,points.iter().map(|p|p.y).sum::<f64>()/points.len()as f64);
        let mut edges=0.0;
        for (i,p) in points.iter().enumerate(){
            let (a,b)=(&points[(i+points.len()-1)%points.len()],&points[(i+1)%points.len()]);
            let (ux,uy,vx,vy)=(a.x-p.x,a.y-p.y,b.x-p.x,b.y-p.y);
            let (un,vn)=(ux.hypot(uy),vx.hypot(vy));if un<1e-9||vn<1e-9{continue;}
            let (mut nx,mut ny)=(-vy/vn,vx/vn);if nx*(p.x-center.0)+ny*(p.y-center.1)<0.0{nx=-nx;ny=-ny;}
            let samples=(vn/3.0).ceil().clamp(2.0,12.0)as usize;
            for j in 0..samples {let t=(j as f64+0.5)/samples as f64;edges+=vn/samples as f64*self.contour_edge(p.x+vx*t,p.y+vy*t,nx,ny,paint,transmission);}
            let angle=((ux*vx+uy*vy)/(un*vn)).clamp(-1.0,1.0).acos();
            let sharp=((std::f64::consts::PI-angle)/std::f64::consts::PI).powi(2);
            let field=self.contour_sample(&self.contour_field,p.x,p.y);if field==0.0{continue;}
            let visible=transmission.map_or(1.0,|t|self.contour_sample(t,p.x,p.y));if visible==0.0{continue;}
            // Sample on the exterior bisector. A corner inside a uniformly
            // painted region should not pay for a boundary that is not visible.
            let (bx,by)=(-(ux/un+vx/vn),-(uy/un+vy/vn));let norm=bx.hypot(by);if norm<1e-9{continue;}
            let contrast=self.contour_contrast(paint,p.x+bx/norm*1.5,p.y+by/norm*1.5);
            sum+=sharp*field*visible*visible*alpha*alpha*contrast;
        }
        // Pixel-loss units; enough to trade tiny raster gains for clean turns.
        self.contour_strength*(6.0*sum+0.25*edges*alpha*alpha)
    }

    pub(super) fn contour_rank(&self,shape:&Shape,score:(f64,Color),transmission:Option<&[f64]>)->(f64,Color){
        if self.contour_strength==0.0{return score;}
        // Do not make a genuinely useful fitted control lose to invisible paint
        // solely because of the prior. Search effort and final counts stay intact.
        let cost=self.contour_cost(shape,score.1,transmission).min((-score.0).max(0.0)*0.75);
        (score.0+cost,score.1)
    }

    pub(super) fn contour_total(&self)->f64 {
        if self.contour_strength==0.0{return 0.0;}
        let mut transmission=vec![1.0;self.target.len()];let mut sum=0.0;
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,27));worker.rgba_reuse=self.optimized;
        for (shape,drawn) in self.layers.iter().zip(&self.shapes).rev(){
            sum+=self.contour_cost(shape,drawn.color,Some(&transmission));
            let a=f64::from(drawn.color.a)/255.0;
            for line in coverage(shape,&mut worker,self.exact_coverage){for x in line.x1..=line.x2{transmission[line.y as usize*self.width as usize+x as usize]*=1.0-a*line.coverage();}}
        }
        sum
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edge()->RgbaModel {
        let target=(0..32*32).map(|i|if i%32<16{[0.0,0.0,0.0,1.0]}else{[1.0;4]}).collect();
        let mut m=RgbaModel::new(32,32,target,Some(42));m.set_contour_smoothing(1.0).unwrap();m
    }
    fn tip()->Shape {Shape::Polygon(Polygon{order:3,x:[15.5,8.0,8.0,0.0],y:[16.0,8.0,24.0,0.0]})}
    #[test]
    fn exposed_unsupported_tip_costs_but_hidden_same_paint_and_transparent_do_not(){
        let m=edge();let s=tip();let black=Color::new(0,0,0,255);
        assert!(m.contour_cost(&s,black,None)>0.01);
        assert_eq!(m.contour_cost(&s,black,Some(&vec![0.0;1024])),0.0);
        assert_eq!(m.contour_cost(&s,Color::new(0,0,0,0),None),0.0);
        let mut flat=RgbaModel::new(32,32,vec![[1.0;4];1024],Some(42));flat.set_contour_smoothing(1.0).unwrap();
        assert_eq!(flat.contour_cost(&s,Color::new(255,255,255,255),None),0.0);
        assert!(m.contour_cost(&s,black,None)>m.contour_cost(&Shape::RotatedEllipse(RotatedEllipse{x:12.0,y:16.0,rx:3.5,ry:8.0,angle:0.0}),black,None));
    }
    #[test]
    fn zero_setting_keeps_numerical_search_and_refinement(){
        let t=edge().target;let mut a=RgbaModel::new(32,32,t.clone(),Some(43));let mut b=RgbaModel::new(32,32,t,Some(43));b.set_contour_smoothing(0.0).unwrap();
        for _ in 0..4 {assert_eq!(a.step_turbo(ShapeKind::Mixed),b.step_turbo(ShapeKind::Mixed));}
        assert!(a.set_contour_smoothing(1.0).is_err());
        assert!(a.refine_turbo(||false)&&b.refine_turbo(||false));assert_eq!(a.score,b.score);assert_eq!(a.drawing(),b.drawing());
    }
    #[test]
    fn invalid_strength_fails_without_mutation(){
        let mut m=edge();let field=m.contour_field.clone();
        for strength in [f64::NAN,f64::INFINITY,-0.1,4.1]{assert!(m.set_contour_smoothing(strength).is_err());assert_eq!(m.contour_field,field);}
    }
    #[test]
    fn source_corners_are_less_regularized_than_a_smooth_source_edge(){
        let straight=edge();
        let target=(0..1024).map(|i|if i%32<16&&i/32<16{[0.0,0.0,0.0,1.0]}else{[1.0;4]}).collect();
        let mut corner=RgbaModel::new(32,32,target,Some(42));corner.set_contour_smoothing(1.0).unwrap();
        assert!(corner.contour_sample(&corner.contour_field,15.5,15.5)<straight.contour_sample(&straight.contour_field,15.5,15.5)*0.75);
    }
    #[test]
    fn regularized_search_preserves_pixel_loss_accounting_and_guarded_refinement(){
        let mut m=edge();
        for _ in 0..10 {m.step_turbo(ShapeKind::Mixed);assert!((m.score-m.loss(&m.current)).abs()<1e-8);}
        let before=m.score+m.contour_total();assert!(m.refine_observed(2,6,||false,|_,_,_,_|{}));
        assert!(m.score+m.contour_total()<=before+1e-8);assert_eq!(m.shapes.len(),10);
    }
}
