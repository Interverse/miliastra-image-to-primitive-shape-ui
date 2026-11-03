//! Research: small-feature weighting. A compact, high-contrast mark (a mouth
//! stroke, a glint, a letter detail) loses to broad regions under per-pixel
//! weights because its total error is small, so greedy search reaches it last or
//! never. Each such mark gets a floor on its total weighted contrast, through a
//! capped multiplier on its pixels and their one-pixel surround, optionally gated
//! by salience (`feature_gate`) and limited by a total weight budget
//! (`feature_budget`). Off unless the `feature_cap` lab parameter is set: it failed
//! the fresh blinded review (docs/development/primeval-turbo.md).
use super::*;

/// Separable Gaussian blur over three standard deviations, clamped at borders.
fn blur(values:&[f64],w:usize,h:usize,sigma:f64)->Vec<f64>{
    let radius=(3.0*sigma).ceil()as isize;
    let kernel:Vec<f64>=(-radius..=radius).map(|d|(-(d*d)as f64/(2.0*sigma*sigma)).exp()).collect();
    let total:f64=kernel.iter().sum();
    let pass=|src:&[f64],horizontal:bool|->Vec<f64>{
        let mut out=vec![0.0;src.len()];
        for y in 0..h{for x in 0..w{
            let mut acc=0.0;
            for (k,d) in (-radius..=radius).enumerate(){
                let (xx,yy)=if horizontal{((x as isize+d).clamp(0,w as isize-1)as usize,y)}else{(x,(y as isize+d).clamp(0,h as isize-1)as usize)};
                acc+=kernel[k]*src[yy*w+xx];
            }
            out[y*w+x]=acc/total;
        }}
        out
    };
    pass(&pass(values,true),false)
}

/// Compact marks: 8-connected components of |DoG(1, 3)| > 0.03 on the composite
/// over mid gray, from 3 pixels to 0.5% of the image.
pub(super) fn small_features(w:usize,h:usize,target:&[[f64;4]])->(Vec<f64>,Vec<Vec<usize>>){
    let gray:Vec<f64>=target.iter().map(|p|(p[0]+p[1]+p[2])/3.0+0.5*(1.0-p[3])).collect();
    let (fine,coarse)=(blur(&gray,w,h,1.0),blur(&gray,w,h,3.0));
    let dog:Vec<f64>=fine.iter().zip(&coarse).map(|(a,b)|a-b).collect();
    let strong:Vec<bool>=dog.iter().map(|d|d.abs()>0.03).collect();
    let limit=(w*h/200).max(16);
    let mut seen=vec![false;w*h];let mut components=Vec::new();
    for start in 0..w*h{
        if !strong[start]||seen[start]{continue;}
        let mut stack=vec![start];let mut region=Vec::new();seen[start]=true;
        while let Some(i)=stack.pop(){
            region.push(i);let (x,y)=((i%w)as isize,(i/w)as isize);
            for dy in -1..=1isize{for dx in -1..=1isize{
                let (nx,ny)=(x+dx,y+dy);
                if nx<0||ny<0||nx>=w as isize||ny>=h as isize{continue;}
                let j=ny as usize*w+nx as usize;
                if strong[j]&&!seen[j]{seen[j]=true;stack.push(j);}
            }}
        }
        if (3..=limit).contains(&region.len()){components.push(region);}
    }
    (dog,components)
}

impl RgbaModel {
    pub(super) fn boost_small_features(&mut self){
        if self.lab_param("feature_proposals").is_some(){
            self.feature_regions=small_features(self.width as usize,self.height as usize,&self.target).1;
        }
        let Some(cap)=self.lab_param("feature_cap") else {return;};
        // Floor in units of a 64-pixel mark at DoG contrast 0.1 and weight 1.
        let floor=self.lab_param("feature_floor").unwrap_or(1.0)*64.0*0.01;
        let (w,h)=(self.width as usize,self.height as usize);
        if self.detail_weights.is_empty(){self.detail_weights=vec![1.0;w*h];}
        let (dog,components)=small_features(w,h,&self.target);
        let mut multiplier=vec![1.0f64;w*h];
        let structural=super::structure::analyze(w,h,&self.target);
        let gate=self.lab_param("feature_gate").unwrap_or(0.0)!=0.0;
        for region in &components{
            let mass:f64=region.iter().map(|&i|self.detail_weights[i]*dog[i]*dog[i]).sum();
            let mut m=(floor/mass.max(1e-12)).clamp(1.0,cap);
            if gate{
                // Salience gate: attention when Focus supplies it, otherwise the
                // structural score, averaged over the mark; texture gets little.
                let n=region.len() as f64;
                let salience=if self.attention.is_empty(){region.iter().map(|&i|(structural[i]-1.0)/3.0).sum::<f64>()/n}else{region.iter().map(|&i|self.attention[i]).sum::<f64>()/n};
                m=1.0+(m-1.0)*salience.clamp(0.0,1.0);
            }
            for &i in region{
                let (x,y)=(i%w,i/w);
                for yy in y.saturating_sub(1)..(y+2).min(h){for xx in x.saturating_sub(1)..(x+2).min(w){
                    let j=yy*w+xx;multiplier[j]=multiplier[j].max(m);
                }}
            }
        }
        // Budget: the boost may add at most this share of the total weight; dense
        // detail (photographs, texture) is scaled down uniformly instead of
        // pulling effort from everything else.
        let total:f64=self.detail_weights.iter().sum();
        let added:f64=self.detail_weights.iter().zip(&multiplier).map(|(w,m)|w*(m-1.0)).sum::<f64>()/total.max(1e-12);
        let scale=self.lab_param("feature_budget").map_or(1.0,|b|if added>b{b/added}else{1.0});
        #[cfg(feature="lab")]
        eprintln!("feature boost: {} marks, added weight {:.4}, scale {:.3}",components.len(),added,scale);
        for (weight,m) in self.detail_weights.iter_mut().zip(&multiplier){*weight*=1.0+(m-1.0)*scale;}
        self.score=self.loss(&self.current);
        for y in 0..h{self.update_row(y);}
    }
}

impl RgbaModel {
    /// Research: candidates fitted to the source's small features that still carry
    /// the most weighted residual (`feature_proposals` = how many per step), from
    /// the moments of each feature's pixels, in every allowed family.
    pub(super) fn feature_proposals(&self,kind:ShapeKind,out:&mut Vec<Shape>){
        let Some(top)=self.lab_param("feature_proposals") else {return;};
        let w=self.width as usize;
        let mut ranked:Vec<(f64,usize)>=self.feature_regions.iter().enumerate().map(|(r,region)|(region.iter().map(|&i|{
            let (t,c)=(self.target[i],self.current[i]);
            (0..4).map(|k|(t[k]-c[k]).powi(2)*if k==3{self.alpha_weight(i)}else{self.detail_weight(i)}).sum::<f64>()
        }).sum(),r)).collect();
        ranked.sort_by(|a,b|b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        for &(_,r) in ranked.iter().take(top as usize){
            let region=&self.feature_regions[r];let n=region.len() as f64;
            let (mut sx,mut sy,mut xx,mut yy,mut xy)=(0.0,0.0,0.0,0.0,0.0);
            for &i in region{let (x,y)=((i%w)as f64+0.5,(i/w)as f64+0.5);sx+=x;sy+=y;xx+=x*x;yy+=y*y;xy+=x*y;}
            let (mx,my)=(sx/n,sy/n);let (a,b,d)=(xx/n-mx*mx,xy/n-mx*my,yy/n-my*my);
            let disc=((a-d).powi(2)+4.0*b*b).sqrt();let angle=0.5*(2.0*b).atan2(a-d).to_degrees();
            // A uniform bar of length L has variance L^2/12: 2 sqrt(3 var) spans it.
            let span=|v:f64|(2.0*(3.0*v.max(0.0)).sqrt()).max(1.0);
            let ellipse=Shape::RotatedEllipse(RotatedEllipse{x:mx,y:my,rx:span((a+d+disc)/2.0)/2.0+0.5,ry:span((a+d-disc)/2.0)/2.0+0.5,angle});
            for family in crate::mixed::FAMILIES{
                if kind==ShapeKind::Mixed||kind==family{if let Some(shape)=crate::mixed::replacement(&ellipse,family){out.push(shape);}}
            }
        }
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn a_faint_short_stroke_gains_weight_and_a_flat_image_does_not(){
        // 128x128: the stroke's 24-pixel component is within 0.5% of the image.
        let mut pixels=vec![[0.9,0.8,0.7,1.0];128*128];
        for x in 60..68{pixels[64*128+x]=[0.6,0.45,0.4,1.0];}
        let mut model=RgbaModel::new(128,128,pixels,Some(42));
        model.initialize_detail_weights();let before=model.detail_weights.clone();
        model.set_lab_params(vec![("feature_cap".into(),8.0),("feature_floor".into(),4.0)]);model.boost_small_features();
        assert!(model.detail_weights[64*128+63]>before[64*128+63]*1.5);
        assert_eq!(model.detail_weights[2],before[2]);
        let mut flat=RgbaModel::new(32,32,vec![[0.5,0.5,0.5,1.0];32*32],Some(42));
        flat.initialize_detail_weights();let base=flat.detail_weights.clone();
        flat.set_lab_params(vec![("feature_cap".into(),8.0),("feature_floor".into(),4.0)]);flat.boost_small_features();
        assert_eq!(flat.detail_weights,base);
    }
    #[test]
    fn dense_marks_add_at_most_the_weight_budget(){
        let mut pixels=vec![[0.9,0.9,0.9,1.0];128*128];
        for y in (8..120).step_by(16){for x in (8..120).step_by(16){for (dx,dy) in [(0,0),(1,0),(0,1),(1,1)]{pixels[(y+dy)*128+x+dx]=[0.2,0.2,0.2,1.0];}}}
        let mut model=RgbaModel::new(128,128,pixels,Some(42));
        model.initialize_detail_weights();let before:f64=model.detail_weights.iter().sum();
        model.set_lab_params(vec![("feature_cap".into(),16.0),("feature_floor".into(),8.0),("feature_budget".into(),0.08)]);model.boost_small_features();
        let added=model.detail_weights.iter().sum::<f64>()/before-1.0;
        assert!(added>0.0&&added<=0.08+1e-9,"added {added}");
    }
}
