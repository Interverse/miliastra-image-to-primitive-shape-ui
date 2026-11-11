//! Experimental residual-component proposals; no new output geometry.
use super::*;

/// Variant flag: each selected edge gets its own search round.
const DEDICATED:u32=1<<16;
/// Variant flag: spill-aware reordering after refinement; bits 20-23 set trials / 8.
const SPILL_REORDER:u32=1<<18;
/// Variant flag: shape merging after refinement; bits 20-23 set trials / 8.
const MERGE:u32=1<<19;

impl RgbaModel {
    /// Direct source fit: bounded work per search, never a bound on user count.
    pub fn step_turbo(&mut self,kind:ShapeKind)->&DrawnShape {
        if self.detail_weights.is_empty(){self.initialize_detail_weights();}
        if self.line_variant&0xff!=0&&self.lines.is_none(){self.lines=Some(super::lines::detect(self.width as usize,self.height as usize,&self.target));}
        if self.shapes.is_empty()&&self.faint_holes.is_empty(){self.mark_faint_holes();}
        if self.shapes.is_empty()&&!self.features_marked{self.features_marked=true;self.boost_small_features();}
        if self.clear_alpha_weight==16.0 {self.clear_alpha_weight=64.0;for y in 0..self.height as usize {self.update_row(y);}}
        self.turbo=true;self.fast_residual=true;self.exact_coverage=true;
        self.step(kind);
        self.turbo=false;self.fast_residual=false;
        self.shapes.last().unwrap()
    }

    /// Exact export coverage for final refinement, retaining all fitted layers.
    pub fn refine_turbo(&mut self,cancelled:impl FnMut()->bool)->bool {self.refine_turbo_observed(cancelled,|_,_,_,_|{})}
    /// Observe each exact-coverage refinement layer.
    pub fn refine_turbo_observed(&mut self,mut cancelled:impl FnMut()->bool,mut observer:impl FnMut(u32,u32,usize,&DrawnShape))->bool {
        self.exact_coverage=true;self.begin_attention_refinement();
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,20));worker.rgba_reuse=true;
        let mut canvas=vec![self.background_pixel();self.target.len()];
        for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
        self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
        if !self.refine_observed(4,6,&mut cancelled,&mut observer){return false;}
        if !self.redistribute_turbo(&mut cancelled,&mut observer){return false;}
        if !self.reorder_turbo(&mut cancelled,&mut observer){return false;}
        if self.line_variant&SPILL_REORDER!=0&&!self.reorder_spill(&mut cancelled,&mut observer){return false;}
        if self.line_variant&MERGE!=0&&!self.merge_turbo(&mut cancelled,&mut observer){return false;}
        if !self.clear_gaps(&mut cancelled,&mut observer) {return false;}
        true
    }

    /// Lab hook: the Turbo refinement sequence with a snapshot after each phase.
    #[cfg(feature="lab")]
    pub fn refine_turbo_phases(&mut self,mut snapshot:impl FnMut(&'static str,&Self)){
        self.exact_coverage=true;self.begin_attention_refinement();
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,20));worker.rgba_reuse=true;
        let mut canvas=vec![self.background_pixel();self.target.len()];
        for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
        self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
        snapshot("repaint",self);
        self.refine_observed(4,6,||false,|_,_,_,_|{});snapshot("refine",self);
        self.redistribute_turbo(&mut ||false,&mut |_,_,_,_|{});snapshot("redistribute",self);
        self.reorder_turbo(&mut ||false,&mut |_,_,_,_|{});snapshot("reorder",self);
        if self.line_variant&SPILL_REORDER!=0{self.reorder_spill(&mut ||false,&mut |_,_,_,_|{});snapshot("spill-reorder",self);}
        if self.line_variant&MERGE!=0{self.merge_turbo(&mut ||false,&mut |_,_,_,_|{});snapshot("merge",self);}
        self.clear_gaps(&mut ||false,&mut |_,_,_,_|{});snapshot("gaps",self);
    }
    /// Lab hook: each layer's loss increase if it alone were deleted (`removal_costs`).
    #[cfg(feature="lab")]
    pub fn lab_removal_costs(&self)->Vec<f64>{
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,21));worker.rgba_reuse=true;
        self.removal_costs(&mut worker,&mut ||false).unwrap_or_default()
    }
    /// Lab hook: the current premultiplied composite.
    #[cfg(feature="lab")]
    pub fn current_pixels(&self)->&[[f64;4]]{&self.current}

    pub(super) fn turbo_proposals(&self,kind:ShapeKind)->Vec<Shape> {
        let mut proposals=self.turbo_proposals_weighted(kind,false);
        if !self.proposal_weights.is_empty(){proposals.extend(self.turbo_proposals_weighted(kind,true));}
        if self.line_variant&DEDICATED==0{if let Some(lines)=&self.lines{for group in self.line_groups(lines,kind){proposals.extend(group);}}}
        self.feature_proposals(kind,&mut proposals);
        proposals
    }
    /// Line proposals that get their own hill-climbed search round, one per edge.
    pub(super) fn dedicated_line_groups(&self,kind:ShapeKind)->Vec<Vec<Shape>>{
        match &self.lines{Some(lines) if self.line_variant&DEDICATED!=0=>self.line_groups(lines,kind),_=>Vec::new()}
    }
    /// Experimental: candidates aligned with target edges (see `lines`). The
    /// variant's low byte selects proposal kinds, the next byte how many edges
    /// with the most residual nearby are used per step (default 8).
    pub fn set_line_proposals(&mut self,variant:u32){self.line_variant=variant;}
    /// Experimental named parameters for research runs (see `lab_param`); empty
    /// in the product.
    pub fn set_lab_params(&mut self,params:Vec<(String,f64)>){self.lab=params;}
    pub(super) fn lab_param(&self,name:&str)->Option<f64>{self.lab.iter().find(|(k,_)|k==name).map(|(_,v)|*v)}
    /// Experimental: `extra` more search rounds for each of the first `steps` steps.
    pub fn set_extra_rounds(&mut self,extra:usize,steps:usize){self.extra_rounds=(extra,steps);}
    /// Lab: detected edge primitives as `[kind, values...]` (0 segment, 1 arc, 2 corner).
    #[cfg(feature="lab")]
    pub fn debug_line_primitives(&self)->Vec<[f64;7]>{
        super::lines::detect(self.width as usize,self.height as usize,&self.target).iter().map(|p|match *p{
            super::lines::Primitive::Segment{x0,y0,x1,y1}=>[0.0,x0,y0,x1,y1,0.0,0.0],
            super::lines::Primitive::Arc{cx,cy,r,start,sweep}=>[1.0,cx,cy,r,start,sweep,0.0],
            super::lines::Primitive::Corner{x,y,bx,by,half,arm}=>[2.0,x,y,bx,by,half,arm],
        }).collect()
    }
    fn line_groups(&self,lines:&[super::lines::Primitive],kind:ShapeKind)->Vec<Vec<Shape>>{
        let (w,h)=(self.width as usize,self.height as usize);
        let error:Vec<f64>=self.target.iter().zip(&self.current).enumerate().map(|(i,(t,c))|(0..4).map(|k|(t[k]-c[k]).powi(2)*if k==3{self.alpha_weight(i)}else{self.detail_weight(i)}).sum()).collect();
        let mut ranked:Vec<(f64,usize)>=lines.iter().enumerate().map(|(i,p)|(p.residual(&error,w,h),i)).collect();
        ranked.sort_by(|a,b|b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        let top=match (self.line_variant>>8)&0xff{0=>8,k=>k as usize};
        ranked.iter().take(top).map(|&(_,i)|{let mut group=Vec::new();lines[i].proposals(kind,self.line_variant&0xff,&mut group);group}).filter(|g|!g.is_empty()).collect()
    }
    fn turbo_proposals_weighted(&self,kind:ShapeKind,guided:bool)->Vec<Shape>{
        let weight_at=|i:usize|if guided{self.proposal_weights[i]}else{self.detail_weight(i)};
        let w=self.width as usize;let h=self.height as usize;
        // Select residual peaks from distinct cells, not eight copies of one eye.
        let mut cells=vec![(0.0,0usize);64];
        for (i,(t,c)) in self.target.iter().zip(&self.current).enumerate() {
            let error=(0..4).map(|k|(t[k]-c[k]).powi(2)*if k==3{self.alpha_weight(i)}else{weight_at(i)}).sum::<f64>();
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
                // Extra proposals fit one connected residual patch, not unrelated
                // similarly coloured marks on opposite sides of the anchor.
                let xs:Vec<_>=((x-r).max(0)..=(x+r).min(w as i32-1)).step_by(stride).collect();
                let ys:Vec<_>=((y-r).max(0)..=(y+r).min(h as i32-1)).step_by(stride).collect();
                let connected=if guided{
                    let residual=self.target[i].iter().zip(&self.current[i]).map(|(t,c)|t-c).collect::<Vec<_>>();
                    let eligible:Vec<bool>=ys.iter().flat_map(|&py|xs.iter().map(move |&px|(px,py))).map(|(px,py)|{
                        let at=py as usize*w+px as usize;
                        let similar=(0..4).map(|k|(self.target[at][k]-anchor[k]).powi(2)).sum::<f64>()<0.06;
                        let aligned=(0..4).map(|k|(self.target[at][k]-self.current[at][k])*residual[k]).sum::<f64>()>0.0;
                        similar&&aligned
                    }).collect();
                    let ax=xs.iter().enumerate().min_by_key(|(_,v)|(**v-x).abs()).unwrap().0;
                    let ay=ys.iter().enumerate().min_by_key(|(_,v)|(**v-y).abs()).unwrap().0;
                    Some(connected_patch(&eligible,xs.len(),ys.len(),ay*xs.len()+ax))
                }else{None};
                for py in ((y-r).max(0)..=(y+r).min(h as i32-1)).step_by(stride) {
                    for px in ((x-r).max(0)..=(x+r).min(w as i32-1)).step_by(stride) {
                        if let Some(mask)=&connected{
                            let gx=(px-xs[0])as usize/stride;let gy=(py-ys[0])as usize/stride;
                            if !mask[gy*xs.len()+gx]{continue;}
                        }
                        let at=py as usize*w+px as usize;let t=self.target[at];let c=self.current[at];
                        let similarity=(0..4).map(|k|(t[k]-anchor[k]).powi(2)).sum::<f64>();
                        let error=(0..4).map(|k|(t[k]-c[k]).powi(2)).sum::<f64>();
                        let weight=weight_at(at)*error*(-16.0*similarity).exp();
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

impl RgbaModel {
    /// Experimental: rank redistribution trials by the measured loss increase of
    /// removing each layer instead of its visible energy. Off by default.
    pub fn enable_measured_redistribution(&mut self){self.measured_redistribution=true;}
    /// Experimental: replacement trials in redistribution (default 8, at most one per layer).
    pub fn set_redistribution_trials(&mut self,trials:usize)->Result<(), &'static str>{
        if trials==0{return Err("Redistribution trials must be positive");}
        self.redistribution_trials=trials;Ok(())
    }
    // Rank by visible energy, then test a bounded number of structural replacements.
    // Every trial uses the exact composite; the requested shape count stays fixed.
    fn redistribute_turbo(&mut self,cancelled:&mut impl FnMut()->bool,observer:&mut impl FnMut(u32,u32,usize,&DrawnShape))->bool {
        let count=self.layers.len();if count==0{return true;}
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,21));worker.rgba_reuse=true;
        let mut importance=Vec::new();
        if self.measured_redistribution{
            let Some(costs)=self.removal_costs(&mut worker,cancelled) else {return false;};
            importance.extend(costs.into_iter().enumerate().map(|(i,cost)|(cost,i)));
        }else{
            let mut transmission=vec![1.0;self.target.len()];
            for i in (0..count).rev(){
                if cancelled(){return false;}
                let mut energy=0.0;let alpha=f64::from(self.shapes[i].color.a)/255.0;
                for line in coverage(&self.layers[i],&mut worker,true){for x in line.x1..=line.x2{
                    let pixel=line.y as usize*self.width as usize+x as usize;let a=alpha*line.coverage();
                    energy+=self.detail_weight(pixel)*(a*transmission[pixel]).powi(2);transmission[pixel]*=1.0-a;
                }}
                importance.push((energy,i));
            }
        }
        importance.sort_by(|a,b|a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let trials=count.min(self.redistribution_trials);let mut removed=Vec::new();
        for (trial,(_,original)) in importance.into_iter().take(trials).enumerate(){
            if cancelled(){return false;}
            if removed.contains(&original){continue;}
            let pair=trial%2==1&&original+1<count&&!removed.contains(&(original+1));
            let index=original-removed.iter().filter(|&&i|i<original).count();
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_canvas=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();
            let old_metrics=self.detail_metrics();
            self.layers.remove(index);self.shapes.remove(index);self.frozen.remove(index);
            if pair{self.layers.remove(index);self.shapes.remove(index);self.frozen.remove(index);}
            let mut canvas=vec![self.background_pixel();self.target.len()];
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            for y in 0..self.height as usize{self.update_row(y);}
            self.step_turbo(self.family);
            if pair{self.step_turbo(self.family);}
            let metrics=self.detail_metrics();
            if self.score+self.contour_total()<old_score+old_contour && metrics.0<=old_metrics.0 && metrics.1<=old_metrics.1 {
                removed.push(original);if pair{removed.push(original+1);}
                for i in index..count{observer((trial+1)as u32,trials as u32,i,&self.shapes[i]);}
            }else{
                self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_canvas;self.score=old_score;
                observer((trial+1)as u32,trials as u32,index,&self.shapes[index]);
            }
            for y in 0..self.height as usize{self.update_row(y);}
        }
        true
    }
    /// Replace a small batch of least useful temporal layers with native Turbo
    /// residual proposals. The total count stays fixed, and exact loss guards
    /// protect both the full image and attended regions.
    pub fn repair_temporal(&mut self,replacements:usize,error_limit:f64,focus_limit:f64)->usize{
        let count=self.layers.len();if count==0||replacements==0{return 0;}
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,29));worker.rgba_reuse=true;
        let Some(terms)=self.removal_terms(&mut worker,&mut ||false)else{return 0;};
        let mut ranked:Vec<_>=terms.into_iter().enumerate().collect();ranked.sort_by(|a,b|a.1.0.total_cmp(&b.1.0).then(a.0.cmp(&b.0)));
        let amount=replacements.min(count);let mut remove=vec![false;count];for (id,_) in ranked.into_iter().take(amount){remove[id]=true;}
        let old_ids=self.temporal_ids.clone();let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_canvas=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();let old_error=self.unweighted_error();let old_focus=self.focus_error();
        self.layers=old_layers.iter().enumerate().filter(|(i,_)|!remove[*i]).map(|(_,s)|s.clone()).collect();
        self.shapes=old_shapes.iter().enumerate().filter(|(i,_)|!remove[*i]).map(|(_,s)|s.clone()).collect();
        self.frozen=old_frozen.iter().enumerate().filter(|(i,_)|!remove[*i]).map(|(_,s)|*s).collect();
        let mut canvas=vec![self.background_pixel();self.target.len()];for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
        self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);for y in 0..self.height as usize{self.update_row(y);}
        self.temporal_ids=old_ids.iter().enumerate().filter(|(i,_)|!remove[*i]).map(|(_,id)|*id).collect();
        for (i,id) in old_ids.iter().enumerate(){if remove[i]{self.step_turbo(self.family);self.temporal_ids.push(*id);}}
        self.refine_observed(2,1,||false,|_,_,_,_|{});
        if self.score+self.contour_total()<=old_score+old_contour+1e-10&&self.unweighted_error()<=old_error.max(error_limit)+1e-8&&self.focus_error()<=old_focus.max(focus_limit)+1e-8{amount}else{
            self.temporal_ids=old_ids;self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_canvas;self.score=old_score;for y in 0..self.height as usize{self.update_row(y);}0
        }
    }

    /// Loss increase from deleting each layer alone, from the current composite.
    /// Deleting layer i changes a pixel by T*a*(c-B): T is the transmission of the
    /// layers above, B the composite below. T is gathered top-down for a chunk of
    /// layers (bounded memory), then B bottom-up; no per-candidate repaint. It
    /// ignores per-layer 8-bit rounding, so it ranks trials; acceptance stays exact.
    fn removal_costs<R:rand::Rng>(&self,worker:&mut WorkerCtx<R>,cancelled:&mut impl FnMut()->bool)->Option<Vec<f64>>{
        Some(self.removal_terms(worker,cancelled)?.into_iter().map(|(cost,_)|cost).collect())
    }
    /// Per layer: the loss change from deleting it (as `removal_costs`) and its
    /// harm, the loss it adds on the pixels where deleting it would help.
    fn removal_terms<R:rand::Rng>(&self,worker:&mut WorkerCtx<R>,cancelled:&mut impl FnMut()->bool)->Option<Vec<(f64,f64)>>{
        const BUDGET:usize=1<<22;
        let count=self.layers.len();let width=self.width as usize;
        let mut costs=vec![(0.0,0.0);count];let mut transmission=vec![1.0f32;self.target.len()];
        let mut hi=count;
        while hi>0{
            // Top-down: transmission above each chunk layer, at its covered pixels.
            let mut above:Vec<Vec<f32>>=Vec::new();let mut stored=0;let mut lo=hi;
            while lo>0&&(above.is_empty()||stored<BUDGET){
                if cancelled(){return None;}
                lo-=1;let alpha=f32::from(self.shapes[lo].color.a)/255.0;let mut values=Vec::new();
                for line in coverage(&self.layers[lo],worker,true){let a=alpha*line.coverage() as f32;for x in line.x1..=line.x2{
                    let pixel=line.y as usize*width+x as usize;values.push(transmission[pixel]);transmission[pixel]*=1.0-a;
                }}
                stored+=values.len();above.push(values);
            }
            above.reverse();
            // Bottom-up: composite below each chunk layer, then the exact loss change.
            let mut canvas=vec![self.background_pixel();self.target.len()];
            for i in 0..hi{
                if cancelled(){return None;}
                let color=self.shapes[i].color;let lines=coverage(&self.layers[i],worker,true);
                if i>=lo{
                    let alpha=f64::from(color.a)/255.0;let paint=[f64::from(color.r)/255.0,f64::from(color.g)/255.0,f64::from(color.b)/255.0,1.0];
                    let mut values=above[i-lo].iter();let (mut cost,mut harm)=(0.0,0.0);
                    for line in lines{let a=alpha*line.coverage();for x in line.x1..=line.x2{
                        let pixel=line.y as usize*width+x as usize;let above=f64::from(*values.next().unwrap());
                        let (t,o,below)=(self.target[pixel],self.current[pixel],canvas[pixel]);let mut delta=0.0;
                        for k in 0..4{
                            let change=above*a*(paint[k]-f64::from(below[k]));let error=t[k]-o[k];
                            delta+=(if k==3{self.alpha_weight(pixel)}else{self.detail_weight(pixel)})*((error+change).powi(2)-error*error);
                        }
                        cost+=delta;if delta<0.0{harm-=delta;}
                    }}
                    costs[i]=(cost,harm);
                }
                Self::paint(&mut canvas,self.width,lines,color);
            }
            hi=lo;
        }
        Some(costs)
    }
    fn detail_metrics(&self)->(f64,f64){
        let mut opaque=0.0;let mut spill=0.0;
        for(t,p)in self.target.iter().zip(&self.current){
            if t[3]>=254.0/255.0{for c in 0..3{opaque+=(t[c]-p[c]).powi(2);}}
            if t[3]==0.0{spill+=p[3];}
        }
        (opaque,spill)
    }
}

#[cfg(test)]
mod redistribution_tests {
    use super::*;
    #[test]
    fn measured_removal_costs_match_repainted_loss_and_keep_budget(){
        let target:Vec<[f64;4]>=(0..24*24).map(|i|{let x=i%24;let y=i/24;if x>3&&x<20&&y>3&&y<20{[x as f64/24.0,0.3,y as f64/24.0,1.0]}else{[0.0;4]}}).collect();
        let mut model=RgbaModel::new(24,24,target.clone(),Some(42));
        for _ in 0..12{model.step_turbo(ShapeKind::Mixed);}
        model.refine_turbo(||false);
        let mut worker=WorkerCtx::new(24,24,crate::rng::round_rng(42,0,21));worker.rgba_reuse=true;
        // Compare against repainted composites so only arithmetic precision differs.
        let mut canvas=vec![model.background_pixel();model.target.len()];
        for (shape,drawn) in model.layers.iter().zip(&model.shapes){RgbaModel::paint(&mut canvas,24,coverage(shape,&mut worker,true),drawn.color);}
        model.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();
        let costs=model.removal_costs(&mut worker,&mut ||false).unwrap();
        assert_eq!(costs.len(),model.layers.len());
        for i in 0..model.layers.len(){
            let mut canvas=vec![model.background_pixel();model.target.len()];
            for (j,(shape,drawn)) in model.layers.iter().zip(&model.shapes).enumerate(){if j!=i{RgbaModel::paint(&mut canvas,24,coverage(shape,&mut worker,true),drawn.color);}}
            let without:Vec<[f64;4]>=canvas.into_iter().map(|p|p.map(f64::from)).collect();
            let exact=model.loss(&without)-model.loss(&model.current);
            // Painting rounds each layer to 8 bits; the linear estimate does not.
            assert!((costs[i]-exact).abs()<=1e-2*exact.abs()+1e-2,"layer {i}: {} vs {exact}",costs[i]);
        }
        let mut measured=RgbaModel::new(24,24,target,Some(42));measured.enable_measured_redistribution();
        for _ in 0..16{measured.step_turbo(ShapeKind::Mixed);}
        measured.refine_observed(1,2,||false,|_,_,_,_|{});
        let score=measured.score;
        assert!(measured.redistribute_turbo(&mut ||false,&mut |_,_,_,_|{}));
        assert_eq!(measured.shapes.len(),16);assert_eq!(measured.layers.len(),16);assert!(measured.score<=score);
        // More trials keep the budget and never raise the loss.
        let mut wide=RgbaModel::new(24,24,(0..24*24).map(|i|{let x=i%24;let y=i/24;if x>3&&x<20&&y>3&&y<20{[x as f64/24.0,0.3,y as f64/24.0,1.0]}else{[0.0;4]}}).collect(),Some(42));
        assert!(wide.set_redistribution_trials(0).is_err());wide.set_redistribution_trials(32).unwrap();
        for _ in 0..16{wide.step_turbo(ShapeKind::Mixed);}
        wide.refine_observed(1,2,||false,|_,_,_,_|{});let score=wide.score;
        assert!(wide.redistribute_turbo(&mut ||false,&mut |_,_,_,_|{}));
        assert_eq!(wide.shapes.len(),16);assert!(wide.score<=score);
        let mut stop=RgbaModel::new(24,24,vec![[0.5,0.5,0.5,1.0];24*24],Some(42));stop.enable_measured_redistribution();
        for _ in 0..4{stop.step_turbo(ShapeKind::Mixed);}
        assert!(!stop.redistribute_turbo(&mut ||true,&mut |_,_,_,_|{}));
    }
    #[test]
    fn gap_cleanup_keeps_the_count_never_raises_composite_error_and_cancels(){
        // Opaque orange with a transparent 6x6 hole: early broad shapes paint over it.
        let target:Vec<[f64;4]>=(0..32*32).map(|i|{let (x,y)=(i%32,i/32);if (13..19).contains(&x)&&(13..19).contains(&y){[0.0;4]}else{[0.9,0.4,0.1,1.0]}}).collect();
        let mut model=RgbaModel::new(32,32,target.clone(),Some(42));
        for _ in 0..3{model.step_turbo(ShapeKind::Mixed);}
        let gap=|m:&RgbaModel|m.target.iter().zip(&m.current).filter(|(t,p)|t[3]<0.25&&p[3]-t[3]>0.5).count();
        assert!(gap(&model)>=4,"the setup must paint over the hole");
        let (before,count,painted)=(model.matte_error(),model.layers.len(),gap(&model));
        assert!(model.clear_gaps(&mut ||false,&mut |_,_,_,_|{}));
        assert_eq!(model.layers.len(),count);assert_eq!(model.shapes.len(),count);assert_eq!(model.frozen.len(),count);
        assert!(model.matte_error()<=before);
        assert!(gap(&model)<=painted);
        let mut stop=RgbaModel::new(32,32,target,Some(42));
        for _ in 0..3{stop.step_turbo(ShapeKind::Mixed);}
        let drawing=stop.snapshot();
        assert!(!stop.clear_gaps(&mut ||true,&mut |_,_,_,_|{}));
        assert_eq!(stop.snapshot().shapes.len(),drawing.shapes.len());
    }
    #[test]
    fn faint_holes_inside_opaque_areas_get_the_clear_weight(){
        // 64x64: clear left margin, faint 1-pixel silhouette edge beside it, a faint
        // 4x4 hole inside the opaque area, and a faint band covering a third of it.
        let target:Vec<[f64;4]>=(0..64*64).map(|i|{let (x,y)=(i%64,i/64);
            if x<4{[0.0;4]}else if x==4{[0.1,0.1,0.1,0.2]}else if (20..24).contains(&x)&&(20..24).contains(&y){[0.1,0.1,0.1,0.2]}else if x>=44{[0.05,0.05,0.05,0.2]}else{[0.6,0.5,0.4,1.0]}}).collect();
        let mut model=RgbaModel::new(64,64,target,Some(42));
        model.step_turbo(ShapeKind::Mixed);
        let hole=21*64+21;let edge=30*64+4;let band=30*64+50;
        assert!(model.faint_holes[hole]&&!model.faint_holes[edge]&&!model.faint_holes[band]);
        assert_eq!(model.alpha_weight(hole),model.clear_alpha_weight);
        assert!(model.alpha_weight(edge)<model.clear_alpha_weight);
        // Without holes the objective is untouched.
        let mut plain=RgbaModel::new(32,24,pixels_with_edge(),Some(42));
        plain.step_turbo(ShapeKind::Mixed);
        assert!(plain.faint_holes.is_empty());
    }
    #[test]
    fn spill_reorder_keeps_the_count_never_raises_loss_and_cancels(){
        // A dark bar over a red disc: broad early shapes spill across the bar.
        let target:Vec<[f64;4]>=(0..40*40).map(|i|{let (x,y)=(i%40,i/40);
            if (18..22).contains(&x){[0.05,0.05,0.05,1.0]}else if (x as f64-20.0).hypot(y as f64-20.0)<14.0{[0.9,0.1,0.1,1.0]}else{[0.2,0.6,0.9,1.0]}}).collect();
        let mut model=RgbaModel::new(40,40,target.clone(),Some(42));
        for _ in 0..12{model.step_turbo(ShapeKind::Mixed);}
        model.refine_observed(1,2,||false,|_,_,_,_|{});
        let (score,metrics,count)=(model.score,model.detail_metrics(),model.layers.len());
        assert!(model.reorder_spill(&mut ||false,&mut |_,_,_,_|{}));
        assert_eq!(model.layers.len(),count);assert_eq!(model.shapes.len(),count);assert_eq!(model.frozen.len(),count);
        assert!(model.score<=score);let after=model.detail_metrics();assert!(after.0<=metrics.0&&after.1<=metrics.1);
        // Harm totals agree with the per-layer harmed pixels: a layer with harm has some.
        let mut worker=WorkerCtx::new(40,40,crate::rng::round_rng(42,0,25));worker.rgba_reuse=true;
        let terms=model.removal_terms(&mut worker,&mut ||false).unwrap();
        for (i,(_,harm)) in terms.iter().enumerate(){assert_eq!(*harm>0.0,!model.harmed_pixels(i,&mut worker).is_empty(),"layer {i}");}
        let mut stop=RgbaModel::new(40,40,target,Some(42));
        for _ in 0..6{stop.step_turbo(ShapeKind::Mixed);}
        let drawing=stop.snapshot();
        assert!(!stop.reorder_spill(&mut ||true,&mut |_,_,_,_|{}));assert_eq!(drawing,stop.snapshot());
    }
    #[test]
    fn merging_keeps_the_count_never_raises_loss_and_cancels(){
        // A wide flat band invites several similar shapes; a small mark elsewhere
        // can use a freed control.
        let target:Vec<[f64;4]>=(0..48*32).map(|i|{let (x,y)=(i%48,i/48);
            if (8..14).contains(&y)&&(4..44).contains(&x){[0.2,0.5,0.8,1.0]}else if (36..40).contains(&x)&&(22..26).contains(&y){[0.9,0.2,0.1,1.0]}else{[0.95,0.95,0.9,1.0]}}).collect();
        let mut model=RgbaModel::new(48,32,target.clone(),Some(42));
        for _ in 0..14{model.step_turbo(ShapeKind::Mixed);}
        model.refine_observed(1,2,||false,|_,_,_,_|{});
        let (score,metrics,count)=(model.score,model.detail_metrics(),model.layers.len());
        assert!(model.merge_turbo(&mut ||false,&mut |_,_,_,_|{}));
        assert_eq!(model.layers.len(),count);assert_eq!(model.shapes.len(),count);assert_eq!(model.frozen.len(),count);
        assert!(model.score<=score);let after=model.detail_metrics();assert!(after.0<=metrics.0&&after.1<=metrics.1);
        let mut stop=RgbaModel::new(48,32,target,Some(42));
        for _ in 0..6{stop.step_turbo(ShapeKind::Mixed);}
        let drawing=stop.snapshot();
        assert!(!stop.merge_turbo(&mut ||true,&mut |_,_,_,_|{}));assert_eq!(drawing,stop.snapshot());
    }
    #[test]
    fn connected_proposal_does_not_bridge_separate_marks(){
        let mask=connected_patch(&[true,true,false,true,true,true,false,true],4,2,0);
        assert_eq!(mask,vec![true,true,false,false,true,true,false,false]);
        assert_eq!(connected_patch(&[false,true],2,1,0),vec![false,false]);
    }
    /// Opaque gray with a dark mark and a transparent left margin.
    fn pixels_with_edge()->Vec<[f64;4]>{(0..32*24).map(|i|if i%32<4{[0.0;4]}else if i==12*32+16{[0.0,0.0,0.0,1.0]}else{[0.7,0.7,0.7,1.0]}).collect()}
    #[test]
    fn attention_validation_neutrality_and_alignment(){
        let mut pixels=vec![[0.7,0.7,0.7,1.0];32*24];pixels[12*32+16]=[0.0,0.0,0.0,1.0];
        let mut baseline=RgbaModel::new(32,24,pixels.clone(),Some(42));
        let mut neutral=RgbaModel::new(32,24,pixels.clone(),Some(42));
        assert!(neutral.set_attention(2,1,&[0.0,f32::NAN],0.5).is_err());
        assert!(neutral.detail_weights.is_empty());
        neutral.set_attention(2,1,&[0.0,1.0],0.0).unwrap();
        baseline.step_turbo(ShapeKind::Mixed);neutral.step_turbo(ShapeKind::Mixed);
        assert_eq!(baseline.snapshot(),neutral.snapshot());
        assert!(neutral.set_attention(2,1,&[0.0,1.0],0.5).is_err());
        let mut guided=RgbaModel::new(32,24,pixels,Some(42));
        guided.set_attention(2,1,&[0.0,1.0],0.5).unwrap();
        assert!(guided.detail_weights.iter().all(|w|*w>=1.0&&*w<=5.5));
        assert!(guided.detail_weights[12*32+16]>baseline.detail_weights[12*32+16]);
        // The additive term reaches flat attended pixels that amplification cannot.
        let mut amplified=RgbaModel::new(32,24,vec![[0.7,0.7,0.7,1.0];32*24],Some(42));
        let mut flat=vec![[0.7,0.7,0.7,1.0];32*24];flat[0]=[0.0,0.0,0.0,1.0];
        let mut additive=RgbaModel::new(32,24,flat.clone(),Some(42));
        assert!(additive.set_attention_terms(2,1,&[0.0,1.0],0.5,4.5,1.0).is_err());
        assert!(additive.set_attention_terms(2,1,&[0.0,1.0],0.0,f64::NAN,1.0).is_err());
        additive.set_attention_terms(2,1,&[0.0,1.0],0.0,0.5,1.0).unwrap();
        assert!(additive.detail_weights[12*32+31]>2.0&&additive.detail_weights.iter().all(|w|*w>=1.0&&*w<=8.5));
        let mut zero=RgbaModel::new(32,24,flat,Some(42));zero.set_attention_terms(2,1,&[0.0,1.0],0.0,0.0,1.0).unwrap();
        assert!(zero.detail_weights.is_empty());
        // Refinement keeps the chosen share of attention emphasis; 1 keeps search weights.
        let mut refined=RgbaModel::new(32,24,pixels_with_edge(),Some(42));
        assert!(refined.set_attention_terms(2,1,&[0.0,1.0],0.5,0.5,1.5).is_err());
        refined.set_attention_terms(2,1,&[0.0,1.0],0.5,0.5,0.5).unwrap();
        let mut kept=RgbaModel::new(32,24,pixels_with_edge(),Some(42));kept.set_attention_terms(2,1,&[0.0,1.0],0.5,0.5,1.0).unwrap();
        let mut structural=RgbaModel::new(32,24,pixels_with_edge(),Some(42));structural.initialize_detail_weights();
        assert_eq!(refined.detail_weights,kept.detail_weights);assert!(kept.refine_weights.is_empty());
        refined.begin_attention_refinement();kept.begin_attention_refinement();
        assert!(refined.detail_weights.iter().zip(&kept.detail_weights).zip(&structural.detail_weights).all(|((r,k),s)|(r-(s+k)/2.0).abs()<1e-12));
        assert!(refined.detail_weights[12*32+31]<kept.detail_weights[12*32+31]&&refined.refine_weights.is_empty());
        amplified.set_attention(2,1,&[0.0,1.0],1.0).unwrap();
        assert!(amplified.detail_weights.iter().all(|w|*w<=1.0+1e-12));
    }
    #[test]
    fn proposal_only_preserves_objective_and_baseline_candidates(){
        let pixels=pixels_with_edge();
        let mut baseline=RgbaModel::new(32,24,pixels.clone(),Some(42));baseline.initialize_detail_weights();
        let mut guided=RgbaModel::new(32,24,pixels,Some(42));
        guided.set_attention_terms(2,1,&[0.0,1.0],0.5,0.5,0.0).unwrap();
        guided.attention_proposals_only().unwrap();
        assert_eq!(baseline.detail_weights,guided.detail_weights);
        assert_eq!(baseline.score,guided.score);
        assert_eq!(baseline.prefix,guided.prefix);
        assert!(guided.refine_weights.is_empty());
        let original=baseline.turbo_proposals(ShapeKind::Mixed);
        let extra=guided.turbo_proposals(ShapeKind::Mixed);
        assert!(extra.len()>original.len());
        for (a,b) in original.iter().zip(&extra){assert_eq!(a.geometry(),b.geometry());}
        guided.step_turbo(ShapeKind::Mixed);
        assert!(guided.attention_proposals_only().is_err());
        // The additive term scales attended opacity error, transparent pixels included.
        let (clear,visible,far)=(12*32+1,12*32+5,12*32+31);
        let mut hole=RgbaModel::new(32,24,pixels_with_edge(),Some(42));hole.set_attention_terms(2,1,&[1.0,0.0],0.5,1.0,0.5).unwrap();
        assert_eq!(hole.alpha_weight(clear),hole.clear_alpha_weight*4.0);assert_eq!(hole.alpha_weight(visible),ALPHA_WEIGHT*2.0*4.0);
        assert_eq!(hole.alpha_weight(far),ALPHA_WEIGHT*2.0);
        hole.begin_attention_refinement();assert_eq!(hole.alpha_weight(clear),hole.clear_alpha_weight*2.5);
        let mut amplify=RgbaModel::new(32,24,pixels_with_edge(),Some(42));amplify.set_attention_terms(2,1,&[1.0,0.0],0.5,0.0,1.0).unwrap();
        assert!(amplify.alpha_gains.is_empty());assert_eq!(amplify.alpha_weight(clear),amplify.clear_alpha_weight);
        let mut proposals=RgbaModel::new(32,24,pixels_with_edge(),Some(42));proposals.set_attention_terms(2,1,&[1.0,0.0],0.5,1.0,1.0).unwrap();
        proposals.attention_proposals_only().unwrap();assert_eq!(proposals.alpha_weight(clear),proposals.clear_alpha_weight);
        // A neutral map stays a no-op; structural proposals are an explicit control.
        let mut neutral=RgbaModel::new(32,24,pixels_with_edge(),Some(42));
        neutral.set_attention_terms(2,1,&[0.5,0.5],0.5,0.5,1.0).unwrap();
        neutral.attention_proposals_only().unwrap();
        assert!(neutral.proposal_weights.is_empty()&&neutral.detail_weights.is_empty());
        neutral.structural_proposals_only().unwrap();
        assert_eq!(baseline.detail_weights,neutral.detail_weights);assert_eq!(neutral.proposal_weights,neutral.detail_weights);
        assert_eq!(baseline.score,neutral.score);assert_eq!(baseline.prefix,neutral.prefix);
        let structural=neutral.turbo_proposals(ShapeKind::Mixed);
        assert!(structural.len()>original.len());
        for (a,b) in original.iter().zip(&structural){assert_eq!(a.geometry(),b.geometry());}
        neutral.step_turbo(ShapeKind::Mixed);
        assert!(neutral.structural_proposals_only().is_err());
    }
    #[test]
    fn detail_priority_preserves_flat_regions_and_emphasizes_features(){
        let mut pixels=vec![[0.7,0.7,0.7,1.0];32*32];pixels[16*32+16]=[0.0,0.0,0.0,1.0];
        let mut model=RgbaModel::new(32,32,pixels,Some(42));model.initialize_detail_weights();
        assert!(model.detail_weights[16*32+16]>model.detail_weights[0]+0.5);
        assert!(model.detail_weights.iter().all(|w|*w>=1.0&&*w<=4.0));
    }
    #[test]
    fn preserves_budget_and_detail_and_cancels(){
        let target=(0..24*24).map(|i|{let x=i%24;let y=i/24;if x>3&&x<20&&y>3&&y<20{[x as f64/24.0,0.3,y as f64/24.0,1.0]}else{[0.0;4]}}).collect();
        let mut model=RgbaModel::new(24,24,target,Some(42));
        for _ in 0..16{model.step_turbo(ShapeKind::Mixed);}
        model.refine_observed(1,2,||false,|_,_,_,_|{});
        let score=model.score;let metrics=model.detail_metrics();
        assert!(model.redistribute_turbo(&mut ||false,&mut |_,_,_,_|{}));
        assert_eq!(model.shapes.len(),16);assert_eq!(model.layers.len(),16);assert_eq!(model.frozen.len(),16);
        assert!(model.score<=score);let after=model.detail_metrics();assert!(after.0<=metrics.0&&after.1<=metrics.1);
        let before_order=model.score;assert!(model.reorder_turbo(&mut ||false,&mut |_,_,_,_|{}));assert!(model.score<=before_order);assert_eq!(model.shapes.len(),16);
        let drawing=model.snapshot();assert!(!model.redistribute_turbo(&mut ||true,&mut |_,_,_,_|{}));assert_eq!(drawing,model.snapshot());
    }
}

impl RgbaModel {
    // Contrast across several scales emphasizes small structured details. Alpha
    // agreement prevents the transparent silhouette from dominating this map.
    pub(super) fn initialize_detail_weights(&mut self){
        let h=self.height as usize;
        self.detail_weights=super::structure::analyze(self.width as usize,h,&self.target);
        self.score=self.loss(&self.current);
        for y in 0..h{self.update_row(y);}
    }
}

impl RgbaModel {
    // A layer swap followed by color/opacity refitting can escape a coordinate
    // optimum. Test distributed adjacent pairs; retain only guarded improvements.
    fn reorder_turbo(&mut self,cancelled:&mut impl FnMut()->bool,observer:&mut impl FnMut(u32,u32,usize,&DrawnShape))->bool{
        let count=self.layers.len();if count<2{return true;}
        let stride=((count-1)/12).max(1);let indices:Vec<_>=(0..count-1).step_by(stride).collect();
        for (trial,&i) in indices.iter().enumerate(){
            if cancelled(){return false;}
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_current=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();let metrics=self.detail_metrics();
            self.layers.swap(i,i+1);self.shapes.swap(i,i+1);self.frozen.swap(i,i+1);
            // Repaint first: refinement's rollback must refer to the swapped scene.
            let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,22));worker.rgba_reuse=true;
            let mut canvas=vec![self.background_pixel();self.target.len()];
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            let complete=self.refine_observed(1,0,&mut *cancelled,|_,_,_,_|{});
            let after=self.detail_metrics();
            if complete&&self.score+self.contour_total()<old_score+old_contour&&after.0<=metrics.0&&after.1<=metrics.1{
                for index in 0..count{observer((trial+1)as u32,indices.len()as u32,index,&self.shapes[index]);}
            }else{self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_current;self.score=old_score;observer((trial+1)as u32,indices.len()as u32,i,&self.shapes[i]);}
            for y in 0..self.height as usize{self.update_row(y);}
            if !complete{return false;}
        }
        true
    }
}

impl RgbaModel {
    /// Paint over a (nearly) transparent area of the source (a gap that later
    /// shapes never cleared) gets one targeted refinement pass: only the layers
    /// covering it move, with opacity error around the gap weighted 16 times more.
    /// The result is kept only if the composite error over black and white falls;
    /// the shape count never changes. A gap pixel is at most 25% opaque in the
    /// source and at least 50% more opaque in the result.
    fn clear_gaps(&mut self,cancelled:&mut impl FnMut()->bool,observer:&mut impl FnMut(u32,u32,usize,&DrawnShape))->bool{
        let (w,h)=(self.width as usize,self.height as usize);
        let gap=self.gap_pixels();
        if gap.iter().filter(|g|**g).count()<4{return true;}
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,23));worker.rgba_reuse=true;
        let touching:Vec<bool>=self.layers.iter().map(|shape|coverage(shape,&mut worker,true).iter().any(|line|(line.x1..=line.x2).any(|x|gap[line.y as usize*w+x as usize]))).collect();
        let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_current=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();let old_gains=self.alpha_gains.clone();
        let before=self.matte_error();
        // Boost opacity error on gap pixels and their two-pixel neighbourhood.
        let boost=self.lab_param("gap_boost").unwrap_or(16.0);
        let mut gains=if old_gains.is_empty(){vec![1.0;w*h]}else{old_gains.clone()};
        for y in 0..h{for x in 0..w{if gap[y*w+x]{
            for yy in y.saturating_sub(2)..(y+3).min(h){for xx in x.saturating_sub(2)..(x+3).min(w){gains[yy*w+xx]=old_gains.get(yy*w+xx).copied().unwrap_or(1.0)*boost;}}
        }}}
        self.alpha_gains=gains;
        self.frozen=touching.iter().zip(&old_frozen).map(|(t,f)|*f||!t).collect();
        self.score=self.loss(&self.current);
        let complete=self.refine_observed(1,crate::refine::ROUNDS,&mut *cancelled,|_,_,_,_|{});
        self.alpha_gains=old_gains;self.frozen=old_frozen;self.score=self.loss(&self.current);
        if complete&&self.matte_error()<before&&(self.contour_strength==0.0||self.score+self.contour_total()<=old_score+old_contour){
            for i in 0..self.layers.len(){if self.layers[i]!=old_layers[i]||self.shapes[i]!=old_shapes[i]{observer(1,1,i,&self.shapes[i]);}}
        }else{self.layers=old_layers;self.shapes=old_shapes;self.current=old_current;self.score=old_score;}
        for y in 0..h{self.update_row(y);}
        if !complete{return false;}
        self.relocate_gap_layers(cancelled,observer)
    }
    /// Second stage: a layer still painting a gap is removed and replaced by a
    /// fresh search step on top, most gap paint first, at most eight trials. Each
    /// trial is kept only if the composite error over black and white falls; a
    /// rejected layer is skipped until a trial succeeds.
    fn relocate_gap_layers(&mut self,cancelled:&mut impl FnMut()->bool,observer:&mut impl FnMut(u32,u32,usize,&DrawnShape))->bool{
        let w=self.width as usize;
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,24));worker.rgba_reuse=true;
        let mut rejected=Vec::new();
        for trial in 0..8u32{
            if cancelled(){return false;}
            let gap=self.gap_pixels();
            if gap.iter().filter(|g|**g).count()<4{return true;}
            // The layer that paints the most opacity onto gap pixels.
            let Some((index,paint))=self.layers.iter().zip(&self.shapes).enumerate().filter(|(i,_)|!rejected.contains(i)).map(|(i,(shape,drawn))|{
                let alpha=f64::from(drawn.color.a)/255.0;
                (i,coverage(shape,&mut worker,true).iter().map(|line|(line.x1..=line.x2).filter(|&x|gap[line.y as usize*w+x as usize]).count()as f64*line.coverage()*alpha).sum::<f64>())
            }).max_by(|a,b|a.1.total_cmp(&b.1).then(b.0.cmp(&a.0))) else {return true;};
            if paint<=0.0{return true;}
            let before=self.matte_error();
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_current=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();
            self.layers.remove(index);self.shapes.remove(index);self.frozen.remove(index);
            let mut canvas=vec![self.background_pixel();self.target.len()];
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            for y in 0..self.height as usize{self.update_row(y);}
            self.step_turbo(self.family);
            if self.matte_error()<before&&(self.contour_strength==0.0||self.score+self.contour_total()<=old_score+old_contour){
                rejected.clear();
                for i in index..self.layers.len(){observer(trial+1,8,i,&self.shapes[i]);}
            }else{
                self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_current;self.score=old_score;
                for y in 0..self.height as usize{self.update_row(y);}
                rejected.push(index);
            }
        }
        true
    }
    /// Faint pixels (under 35% opaque) with no clear pixel within
    /// two pixels are holes inside an opaque area, such as gaps between hair
    /// strands. Painting over one cannot be undone by later shapes, so its opacity
    /// error gets the clear-pixel weight. Anti-aliased silhouette edges, which
    /// border clear pixels, keep the partial weight; so do faint regions over 2% of
    /// the image, and images whose holes cover under 0.05% of it.
    fn mark_faint_holes(&mut self){
        let (w,h)=(self.width as usize,self.height as usize);
        let clear:Vec<bool>=self.target.iter().map(|t|t[3]==0.0).collect();
        let mut near=vec![false;w*h];
        for y in 0..h{for x in 0..w{if clear[y*w+x]{
            for yy in y.saturating_sub(2)..(y+3).min(h){for xx in x.saturating_sub(2)..(x+3).min(w){near[yy*w+xx]=true;}}
        }}}
        let mut holes:Vec<bool>=self.target.iter().zip(&near).map(|(t,n)|t[3]>0.0&&t[3]<0.35&&!n).collect();
        // Large faint regions (glows, bubbles) are content to paint faintly, not holes.
        let mut seen=vec![false;w*h];
        for start in 0..w*h{
            if !holes[start]||seen[start]{continue;}
            let mut stack=vec![start];let mut region=Vec::new();seen[start]=true;
            while let Some(i)=stack.pop(){
                region.push(i);let (x,y)=(i%w,i/w);
                for j in [(x>0).then(||i-1),(x+1<w).then(||i+1),(y>0).then(||i-w),(y+1<h).then(||i+w)].into_iter().flatten(){
                    if holes[j]&&!seen[j]{seen[j]=true;stack.push(j);}
                }
            }
            if region.len()*50>w*h{for i in region{holes[i]=false;}}
        }
        // A few stray faint pixels do not justify changing the objective.
        if holes.iter().filter(|h|**h).count()*2000<w*h{return;}
        self.faint_holes=holes;self.score=self.loss(&self.current);
        for y in 0..h{self.update_row(y);}
    }
    /// Gap pixels: at most `gap_target` (default 25%) opaque in the source and at
    /// least `gap_excess` (default 50%) more opaque in the result.
    fn gap_pixels(&self)->Vec<bool>{
        let (limit,excess)=(self.lab_param("gap_target").unwrap_or(0.25),self.lab_param("gap_excess").unwrap_or(0.5));
        self.target.iter().zip(&self.current).map(|(t,p)|t[3]<limit&&p[3]-t[3]>excess).collect()
    }
    /// Squared composite error over black and white backgrounds (the benchmark's RMSE).
    fn matte_error(&self)->f64{
        self.target.iter().zip(&self.current).map(|(t,p)|(0..3).map(|c|{let d=t[c]-p[c];let a=p[3]-t[3];d*d+(d+a)*(d+a)}).sum::<f64>()).sum()
    }
}

impl RgbaModel {
    /// Spill-aware reordering. The layer whose paint raises the error most, on the
    /// pixels where removing it would help, is moved just below the earlier layer
    /// that covers most of those pixels, so that layer's feature is drawn over it;
    /// then only the moved layer's geometry, colour and opacity are refitted. A
    /// bounded number of trials; each is kept only if the loss falls with no more
    /// opaque error or transparent spill. The shape count never changes.
    fn reorder_spill(&mut self,cancelled:&mut impl FnMut()->bool,observer:&mut impl FnMut(u32,u32,usize,&DrawnShape))->bool{
        let count=self.layers.len();if count<3{return true;}
        let trials=match (self.line_variant>>20)&0xf{0=>16,k=>k as u32*8};
        let w=self.width as usize;
        let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,25));worker.rgba_reuse=true;
        let mut rejected:Vec<DrawnShape>=Vec::new();
        for trial in 0..trials{
            if cancelled(){return false;}
            let Some(terms)=self.removal_terms(&mut worker,cancelled) else {return false;};
            let Some((index,(_,amount)))=terms.into_iter().enumerate().filter(|(i,_)|!rejected.contains(&self.shapes[*i])).max_by(|a,b|a.1.1.total_cmp(&b.1.1).then(b.0.cmp(&a.0))) else {return true;};
            if amount<=0.0{return true;}
            let harmed=self.harmed_pixels(index,&mut worker);
            // The earlier layer covering most harmed pixels draws the feature underneath.
            let mut mask=vec![false;self.target.len()];for &p in &harmed{mask[p]=true;}
            let destination=(0..index).map(|j|(coverage(&self.layers[j],&mut worker,true).iter().map(|line|(line.x1..=line.x2).filter(|&x|mask[line.y as usize*w+x as usize]).count()).sum::<usize>(),j)).max();
            let Some((overlap,destination))=destination else {rejected.push(self.shapes[index].clone());continue;};
            if overlap==0{rejected.push(self.shapes[index].clone());continue;}
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_current=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();let metrics=self.detail_metrics();
            let layer=self.layers.remove(index);let shape=self.shapes.remove(index);let frozen=self.frozen.remove(index);
            self.layers.insert(destination,layer);self.shapes.insert(destination,shape);self.frozen.insert(destination,frozen);
            let mut canvas=vec![self.background_pixel();self.target.len()];
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            let moved_frozen=self.frozen.clone();
            self.frozen=(0..count).map(|i|i!=destination).collect();
            let complete=self.refine_observed(1,crate::refine::ROUNDS,&mut *cancelled,|_,_,_,_|{});
            self.frozen=moved_frozen;
            let after=self.detail_metrics();
            if complete&&self.score+self.contour_total()<old_score+old_contour&&after.0<=metrics.0&&after.1<=metrics.1{
                rejected.clear();
                for i in destination..=index{observer(trial+1,trials,i,&self.shapes[i]);}
            }else{
                let culprit=old_shapes[index].clone();
                self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_current;self.score=old_score;
                rejected.push(culprit);
            }
            for y in 0..self.height as usize{self.update_row(y);}
            if !complete{return false;}
        }
        true
    }
    /// Pixels where deleting layer `index` alone would lower the loss: the
    /// transmission above it is gathered top-down, the composite below repainted.
    fn harmed_pixels<R:rand::Rng>(&self,index:usize,worker:&mut WorkerCtx<R>)->Vec<usize>{
        let width=self.width as usize;let mut transmission=vec![1.0f32;self.target.len()];
        for i in (index+1..self.layers.len()).rev(){
            let alpha=f32::from(self.shapes[i].color.a)/255.0;
            for line in coverage(&self.layers[i],worker,true){let a=alpha*line.coverage() as f32;for x in line.x1..=line.x2{transmission[line.y as usize*width+x as usize]*=1.0-a;}}
        }
        let mut canvas=vec![self.background_pixel();self.target.len()];
        for i in 0..index{Self::paint(&mut canvas,self.width,coverage(&self.layers[i],worker,true),self.shapes[i].color);}
        let color=self.shapes[index].color;let alpha=f64::from(color.a)/255.0;
        let paint=[f64::from(color.r)/255.0,f64::from(color.g)/255.0,f64::from(color.b)/255.0,1.0];
        let mut harmed=Vec::new();
        for line in coverage(&self.layers[index],worker,true){let a=alpha*line.coverage();for x in line.x1..=line.x2{
            let pixel=line.y as usize*width+x as usize;let above=f64::from(transmission[pixel]);
            let (t,o,below)=(self.target[pixel],self.current[pixel],canvas[pixel]);let mut delta=0.0;
            for k in 0..4{
                let change=above*a*(paint[k]-f64::from(below[k]));let error=t[k]-o[k];
                delta+=(if k==3{self.alpha_weight(pixel)}else{self.detail_weight(pixel)})*((error+change).powi(2)-error*error);
            }
            if delta<0.0{harmed.push(pixel);}
        }}
        harmed
    }
}

impl RgbaModel {
    /// Shape merging. Two layers close in the stack, of similar colour and opacity,
    /// whose areas touch, are replaced by one shape fitted to both (each allowed
    /// family, from the moments of their combined coverage), refitted in place;
    /// the freed control becomes a fresh search step on top. A bounded number of
    /// trials; each is kept only if the loss falls with no more opaque error or
    /// transparent spill. The shape count never changes.
    fn merge_turbo(&mut self,cancelled:&mut impl FnMut()->bool,observer:&mut impl FnMut(u32,u32,usize,&DrawnShape))->bool{
        const WINDOW:usize=16;const SIMILAR:f64=0.01;
        let count=self.layers.len();if count<4{return true;}
        let trials=match (self.line_variant>>20)&0xf{0=>16,k=>k as u32*8};
        let (w,h)=(self.width as i32,self.height as i32);
        let mut worker=WorkerCtx::new(w,h,crate::rng::round_rng(self.seed,0,26));worker.rgba_reuse=true;
        let mut tried:Vec<(DrawnShape,DrawnShape)>=Vec::new();
        for trial in 0..trials{
            if cancelled(){return false;}
            let boxes:Vec<_>=self.layers.iter().map(|s|s.candidate_rectangle(w,h,false)).collect();
            let colour=|i:usize|{let c=self.shapes[i].color;[c.r,c.g,c.b,c.a].map(|v|f64::from(v)/255.0)};
            let mut best:Option<(f64,usize,usize)>=None;
            for i in 0..count{for j in i+1..count.min(i+1+WINDOW){
                let (a,b)=(boxes[i],boxes[j]);
                if a.0>b.2+1||b.0>a.2+1||a.1>b.3+1||b.1>a.3+1{continue;}
                let (ca,cb)=(colour(i),colour(j));let d:f64=(0..4).map(|k|(ca[k]-cb[k]).powi(2)).sum();
                if d>=SIMILAR||tried.iter().any(|(x,y)|*x==self.shapes[i]&&*y==self.shapes[j]){continue;}
                if best.is_none_or(|(e,_,_)|d<e){best=Some((d,i,j));}
            }}
            let Some((_,i,j))=best else {return true;};
            tried.push((self.shapes[i].clone(),self.shapes[j].clone()));
            // Moments of the combined coverage give the merged shape.
            let (mut mass,mut sx,mut sy,mut xx,mut yy,mut xy)=(0.0,0.0,0.0,0.0,0.0,0.0);
            for k in [i,j]{for line in coverage(&self.layers[k],&mut worker,true){let c=line.coverage();for x in line.x1..=line.x2{
                let (px,py)=(f64::from(x)+0.5,f64::from(line.y)+0.5);mass+=c;sx+=c*px;sy+=c*py;xx+=c*px*px;yy+=c*py*py;xy+=c*px*py;
            }}}
            if mass<1.0{continue;}
            let (mx,my)=(sx/mass,sy/mass);let (a,b,d)=(xx/mass-mx*mx,xy/mass-mx*my,yy/mass-my*my);
            let disc=((a-d).powi(2)+4.0*b*b).sqrt();let angle=0.5*(2.0*b).atan2(a-d).to_degrees();
            let ellipse=Shape::RotatedEllipse(RotatedEllipse{x:mx,y:my,rx:(2.0*((a+d+disc)/2.0).max(0.0).sqrt()).max(1.0),ry:(2.0*((a+d-disc)/2.0).max(0.0).sqrt()).max(1.0),angle});
            let candidates:Vec<Shape>=crate::mixed::FAMILIES.iter().filter(|f|self.family==ShapeKind::Mixed||self.family==**f).filter_map(|f|crate::mixed::replacement(&ellipse,*f)).collect();
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_current=self.current.clone();let old_score=self.score;let old_contour=self.contour_total();let metrics=self.detail_metrics();
            let old_matte=self.matte_error();
            let mut winner:Option<(f64,Vec<Shape>,Vec<DrawnShape>,Vec<bool>,Vec<[f64;4]>)>=None;
            for merged in candidates{
                if cancelled(){return false;}
                self.layers=old_layers.clone();self.shapes=old_shapes.clone();self.frozen=old_frozen.clone();
                // Replace the pair by the merged shape at the upper layer's place.
                let colour=self.shapes[j].color;
                self.layers.remove(j);self.shapes.remove(j);self.frozen.remove(j);
                self.layers.remove(i);self.shapes.remove(i);self.frozen.remove(i);
                let at=j-1;self.shapes.insert(at,DrawnShape{geometry:merged.geometry(),color:colour});self.layers.insert(at,merged);self.frozen.insert(at,false);
                let mut canvas=vec![self.background_pixel();self.target.len()];
                for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
                self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
                let kept=self.frozen.clone();self.frozen=(0..self.layers.len()).map(|k|k!=at).collect();
                let complete=self.refine_observed(1,crate::refine::ROUNDS,&mut *cancelled,|_,_,_,_|{});
                self.frozen=kept;
                if !complete{self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_current;self.score=old_score;return false;}
                for y in 0..self.height as usize{self.update_row(y);}
                self.step_turbo(self.family);
                let after=self.detail_metrics();
                // Bit 21: accept on the composite error over black and white (which
                // counts spill) instead of requiring no opaque or spill increase at all.
                let guarded=if self.line_variant&(1<<21)!=0{self.matte_error()<old_matte}else{after.0<=metrics.0&&after.1<=metrics.1};
                if self.score+self.contour_total()<old_score+old_contour&&guarded&&winner.as_ref().is_none_or(|w|self.score<w.0){
                    winner=Some((self.score,self.layers.clone(),self.shapes.clone(),self.frozen.clone(),self.current.clone()));
                }
            }
            if let Some((score,layers,shapes,frozen,current))=winner{
                self.layers=layers;self.shapes=shapes;self.frozen=frozen;self.current=current;self.score=score;
                for k in i..count{observer(trial+1,trials,k,&self.shapes[k]);}
            }else{self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_current;self.score=old_score;}
            for y in 0..self.height as usize{self.update_row(y);}
        }
        true
    }
}

// Connectivity is used only to initialize an extra candidate. It never masks
// source pixels, coverage, scoring or exported shapes.
fn connected_patch(eligible:&[bool],w:usize,h:usize,seed:usize)->Vec<bool>{
    let mut visited=vec![false;eligible.len()];
    if !eligible[seed]{return visited;}
    let mut stack=vec![seed];visited[seed]=true;
    while let Some(i)=stack.pop(){
        let x=i%w;let y=i/w;
        for j in [if x>0{i-1}else{i},if x+1<w{i+1}else{i},if y>0{i-w}else{i},if y+1<h{i+w}else{i}]{
            if eligible[j]&&!visited[j]{visited[j]=true;stack.push(j);}
        }
    }
    visited
}
