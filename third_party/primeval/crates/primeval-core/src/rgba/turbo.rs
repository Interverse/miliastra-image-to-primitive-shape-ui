//! Experimental residual-component proposals; no new output geometry.
use super::*;

impl RgbaModel {
    /// Direct source fit: bounded work per search, never a bound on user count.
    pub fn step_turbo(&mut self,kind:ShapeKind)->&DrawnShape {
        if self.clear_alpha_weight==16.0 {self.clear_alpha_weight=32.0;for y in 0..self.height as usize {self.update_row(y);}}
        self.turbo=true;self.fast_residual=true;self.exact_coverage=true;
        self.step(kind);
        self.turbo=false;self.fast_residual=false;
        self.shapes.last().unwrap()
    }

    /// Exact export coverage for final refinement, retaining all fitted layers.
    pub fn refine_turbo(&mut self,cancelled:impl FnMut()->bool)->bool {self.refine_turbo_observed(cancelled,|_,_,_,_|{})}
    /// Observe each exact-coverage refinement layer.
    pub fn refine_turbo_observed(&mut self,cancelled:impl FnMut()->bool,observer:impl FnMut(u32,u32,usize,&DrawnShape))->bool {
        self.exact_coverage=true;
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,20));worker.rgba_reuse=true;
        let mut canvas=vec![self.background_pixel();self.target.len()];
        for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
        self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
        self.refine_observed(4,6,cancelled,observer)
    }

    pub(super) fn turbo_proposals(&self,kind:ShapeKind)->Vec<Shape> {
        let w=self.width as usize;let h=self.height as usize;
        // Select residual peaks from distinct cells, not eight copies of one eye.
        let mut cells=vec![(0.0,0usize);64];
        for (i,(t,c)) in self.target.iter().zip(&self.current).enumerate() {
            let error=(0..4).map(|k|(t[k]-c[k]).powi(2)*if k==3{self.alpha_weight(t[3])}else{1.0}).sum::<f64>();
            let cell=(i/w*8/h)*8+(i%w*8/w);
            if error>cells[cell].0{cells[cell]=(error,i);}
        }
        cells.sort_by(|a,b|b.0.total_cmp(&a.0));
        let mut proposals=Vec::new();
        for &(_,i) in cells.iter().take(8) {
            let (x,y)=((i%w)as i32,(i/w)as i32);let anchor=self.target[i];
            for radius in [3,7,15,31,63] {
                let r=(radius*self.width.max(self.height)as i32/128).max(2);
                let mut mass=0.0;let mut sx=0.0;let mut sy=0.0;let mut xx=0.0;let mut yy=0.0;let mut xy=0.0;
                // Sparse moment estimates initialize geometry; full scoring decides.
                let stride=(r/12).max(1)as usize;
                for py in ((y-r).max(0)..=(y+r).min(h as i32-1)).step_by(stride) {
                    for px in ((x-r).max(0)..=(x+r).min(w as i32-1)).step_by(stride) {
                        let at=py as usize*w+px as usize;let t=self.target[at];let c=self.current[at];
                        let similarity=(0..4).map(|k|(t[k]-anchor[k]).powi(2)).sum::<f64>();
                        let error=(0..4).map(|k|(t[k]-c[k]).powi(2)).sum::<f64>();
                        let weight=error*(-16.0*similarity).exp();
                        let (dx,dy)=((px-x)as f64,(py-y)as f64);
                        mass+=weight;sx+=weight*dx;sy+=weight*dy;xx+=weight*dx*dx;yy+=weight*dy*dy;xy+=weight*dx*dy;
                    }
                }
                if mass<1e-12{continue;}
                let (mx,my)=(sx/mass,sy/mass);let (a,b,d)=(xx/mass-mx*mx,xy/mass-mx*my,yy/mass-my*my);
                let disc=((a-d).powi(2)+4.0*b*b).sqrt();let angle=0.5*(2.0*b).atan2(a-d).to_degrees();
                let ellipse=Shape::RotatedEllipse(RotatedEllipse{x:x as f64+mx,y:y as f64+my,rx:(2.0*((a+d+disc)/2.0).max(0.0).sqrt()).max(1.0),ry:(2.0*((a+d-disc)/2.0).max(0.0).sqrt()).max(1.0),angle});
                for family in crate::mixed::FAMILIES {
                    if kind==ShapeKind::Mixed||kind==family {
                        if let Some(shape)=crate::mixed::replacement(&ellipse,family){proposals.push(shape);}
                    }
                }
            }
        }
        proposals
    }
}
