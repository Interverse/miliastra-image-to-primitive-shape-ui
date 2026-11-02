//! Experimental residual-component proposals; no new output geometry.
use super::*;

impl RgbaModel {
    /// Direct source fit: bounded work per search, never a bound on user count.
    pub fn step_turbo(&mut self,kind:ShapeKind)->&DrawnShape {
        if self.detail_weights.is_empty(){self.initialize_detail_weights();}
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
        self.reorder_turbo(&mut cancelled,&mut observer)
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
    }
    /// Lab hook: the current premultiplied composite.
    #[cfg(feature="lab")]
    pub fn current_pixels(&self)->&[[f64;4]]{&self.current}

    pub(super) fn turbo_proposals(&self,kind:ShapeKind)->Vec<Shape> {
        let mut proposals=self.turbo_proposals_weighted(kind,false);
        if !self.proposal_weights.is_empty(){proposals.extend(self.turbo_proposals_weighted(kind,true));}
        proposals
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
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_canvas=self.current.clone();let old_score=self.score;
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
            if self.score<old_score && metrics.0<=old_metrics.0 && metrics.1<=old_metrics.1 {
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
    /// Loss increase from deleting each layer alone, from the current composite.
    /// Deleting layer i changes a pixel by T*a*(c-B): T is the transmission of the
    /// layers above, B the composite below. T is gathered top-down for a chunk of
    /// layers (bounded memory), then B bottom-up; no per-candidate repaint. It
    /// ignores per-layer 8-bit rounding, so it ranks trials; acceptance stays exact.
    fn removal_costs<R:rand::Rng>(&self,worker:&mut WorkerCtx<R>,cancelled:&mut impl FnMut()->bool)->Option<Vec<f64>>{
        const BUDGET:usize=1<<22;
        let count=self.layers.len();let width=self.width as usize;
        let mut costs=vec![0.0;count];let mut transmission=vec![1.0f32;self.target.len()];
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
                    let mut values=above[i-lo].iter();let mut cost=0.0;
                    for line in lines{let a=alpha*line.coverage();for x in line.x1..=line.x2{
                        let pixel=line.y as usize*width+x as usize;let above=f64::from(*values.next().unwrap());
                        let (t,o,below)=(self.target[pixel],self.current[pixel],canvas[pixel]);
                        for k in 0..4{
                            let change=above*a*(paint[k]-f64::from(below[k]));let error=t[k]-o[k];
                            cost+=(if k==3{self.alpha_weight(pixel)}else{self.detail_weight(pixel)})*((error+change).powi(2)-error*error);
                        }
                    }}
                    costs[i]=cost;
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
    fn initialize_detail_weights(&mut self){
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
            let old_layers=self.layers.clone();let old_shapes=self.shapes.clone();let old_frozen=self.frozen.clone();let old_current=self.current.clone();let old_score=self.score;let metrics=self.detail_metrics();
            self.layers.swap(i,i+1);self.shapes.swap(i,i+1);self.frozen.swap(i,i+1);
            // Repaint first: refinement's rollback must refer to the swapped scene.
            let mut worker=WorkerCtx::new(self.width as i32,self.height as i32,crate::rng::round_rng(self.seed,0,22));worker.rgba_reuse=true;
            let mut canvas=vec![self.background_pixel();self.target.len()];
            for (shape,drawn) in self.layers.iter().zip(&self.shapes){Self::paint(&mut canvas,self.width,coverage(shape,&mut worker,true),drawn.color);}
            self.current=canvas.into_iter().map(|p|p.map(f64::from)).collect();self.score=self.loss(&self.current);
            let complete=self.refine_observed(1,0,&mut *cancelled,|_,_,_,_|{});
            let after=self.detail_metrics();
            if complete&&self.score<old_score&&after.0<=metrics.0&&after.1<=metrics.1{
                for index in 0..count{observer((trial+1)as u32,indices.len()as u32,index,&self.shapes[index]);}
            }else{self.layers=old_layers;self.shapes=old_shapes;self.frozen=old_frozen;self.current=old_current;self.score=old_score;observer((trial+1)as u32,indices.len()as u32,i,&self.shapes[i]);}
            for y in 0..self.height as usize{self.update_row(y);}
            if !complete{return false;}
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
