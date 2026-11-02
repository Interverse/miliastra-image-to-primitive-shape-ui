//! Deterministic nonsemantic region analysis for Turbo's detail budget.
//! Regions compete by distinctiveness and structure, never by absolute position.

#[derive(Clone, Copy, Debug, PartialEq)]
enum Class { Smooth, Contour, Texture, CompactDetail }

#[derive(Default)]
struct Region {
    size: usize, color: [f64;3], energy: f64, xx:f64, yy:f64, xy:f64,
    boundary:usize, contrast:f64, min_x:usize, min_y:usize, max_x:usize, max_y:usize,
}

fn distance(a:&[f64;4],b:&[f64;4])->f64 {
    (0..3).map(|c|(a[c]-b[c]).powi(2)).sum::<f64>()
}

fn classify(r:&Region,area:usize)->Class {
    let e=r.energy/r.size.max(1)as f64;
    let coherence=((r.xx-r.yy).powi(2)+4.0*r.xy*r.xy).sqrt()/(r.xx+r.yy+1e-12);
    if e<0.0005 {Class::Smooth}
    else if coherence>0.55 {Class::Contour}
    else if r.size<area/16 && r.contrast/r.boundary.max(1)as f64>0.12 {Class::CompactDetail}
    else {Class::Texture}
}

pub(super) fn analyze(w:usize,h:usize,pixels:&[[f64;4]])->Vec<f64>{
    let n=w*h;
    let mut labels=vec![usize::MAX;n];let mut regions=Vec::new();let mut stack=Vec::new();
    // Connected color regions: compare to both neighbor and seed to prevent
    // chains of small color changes from swallowing an entire gradient.
    for seed in 0..n {
        if labels[seed]!=usize::MAX||pixels[seed][3]<0.5 {continue;}
        let id=regions.len();labels[seed]=id;stack.push(seed);
        let mut r=Region{min_x:w,min_y:h,..Region::default()};
        while let Some(i)=stack.pop(){
            let x=i%w;let y=i/w;let p=pixels[i];r.size+=1;
            r.min_x=r.min_x.min(x);r.max_x=r.max_x.max(x);r.min_y=r.min_y.min(y);r.max_y=r.max_y.max(y);
            for c in 0..3{r.color[c]+=p[c];}
            let left=pixels[y*w+x.saturating_sub(1)];let right=pixels[y*w+(x+1).min(w-1)];
            let up=pixels[y.saturating_sub(1)*w+x];let down=pixels[(y+1).min(h-1)*w+x];
            // Only compare alpha-compatible colors: silhouettes retain their
            // separate alpha objective instead of becoming false RGB details.
            if [left,right,up,down].iter().all(|q|(q[3]-p[3]).abs()<0.1){
                for c in 0..3{let gx=(right[c]-left[c])*0.5;let gy=(down[c]-up[c])*0.5;
                    r.xx+=gx*gx;r.yy+=gy*gy;r.xy+=gx*gy;r.energy+=gx*gx+gy*gy;}
            }
            for (xx,yy) in [(x.saturating_sub(1),y),((x+1).min(w-1),y),(x,y.saturating_sub(1)),(x,(y+1).min(h-1))]{
                let j=yy*w+xx;let q=pixels[j];
                if (q[3]-p[3]).abs()>0.1{continue;}
                let d=distance(&p,&q);
                if d>0.012 {r.boundary+=1;r.contrast+=d.sqrt();}
                if labels[j]==usize::MAX && q[3]>=0.5 && d<0.012 && distance(&pixels[seed],&q)<0.045 {
                    labels[j]=id;stack.push(j);
                }
            }
        }
        for c in 0..3{r.color[c]/=r.size as f64;}regions.push(r);
    }
    // Histogram rarity is area-weighted; a small distinctive region need not
    // beat a large background by total pixel count to receive useful attention.
    let bin=|color:[f64;3]|->usize{let q=color.map(|v|(v.clamp(0.0,1.0)*7.0).round()as usize);q[0]*64+q[1]*8+q[2]};
    let mut histogram=[0usize;512];let mut occupied=0;
    for r in &regions{histogram[bin(r.color)]+=r.size;occupied+=r.size;}
    let mut scores=Vec::with_capacity(regions.len());
    for r in &regions{
        let class=classify(r,occupied);
        let rarity=(1.0-histogram[bin(r.color)]as f64/occupied.max(1)as f64).sqrt();
        let boundary=r.contrast/r.boundary.max(1)as f64;
        let bbox=((r.max_x-r.min_x+1)*(r.max_y-r.min_y+1))as f64;
        let compact=(r.size as f64/bbox).sqrt();
        let factor=match class{Class::Smooth=>0.25,Class::Contour=>0.8,Class::Texture=>0.35,Class::CompactDetail=>1.0};
        scores.push((factor*(0.3+0.7*rarity)*(boundary/0.35).min(1.0)*(0.6+0.4*compact)).clamp(0.0,1.0));
    }
    let mut weights=vec![1.0;n];
    for i in 0..n{
        let label=labels[i];if label==usize::MAX{continue;}
        // Include the importance of adjoining regions so both sides of a thin
        // feature influence fitting, rather than preserving just its interior.
        let x=i%w;let y=i/w;let mut score=scores[label];
        for radius in [1usize,3,7]{
            let mut mean=[0.0;3];let mut mass=0.0;
            for (dx,dy) in [(-1isize,0isize),(1,0),(0,-1),(0,1)]{
                let xx=(x as isize+dx*radius as isize).clamp(0,w as isize-1)as usize;
                let yy=(y as isize+dy*radius as isize).clamp(0,h as isize-1)as usize;let j=yy*w+xx;
                if (pixels[j][3]-pixels[i][3]).abs()>0.1{continue;}
                for c in 0..3{mean[c]+=pixels[j][c];}mass+=1.0;
                if labels[j]!=usize::MAX{score=score.max(scores[labels[j]]*0.65);}
            }
            if mass>0.0{let contrast=(0..3).map(|c|(pixels[i][c]-mean[c]/mass).powi(2)).sum::<f64>().sqrt();
                score=score.max((contrast/0.3).min(1.0)*(0.3+0.7*scores[label]));}
        }
        weights[i]=1.0+3.0*score;
    }
    weights
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn distinctive_feature_beats_flat_background(){
        let mut p=vec![[0.8,0.8,0.8,1.0];64*64];
        for y in 29..34{for x in 25..38{p[y*64+x]=[0.0,0.0,0.0,1.0];}}
        let a=analyze(64,64,&p);assert!(a[31*64+30]>a[0]+0.5);assert_eq!(a,analyze(64,64,&p));
        assert!(a.iter().all(|v|*v>=1.0&&*v<=4.0));
    }
    #[test]
    fn transparent_hidden_color_is_irrelevant(){
        let a=analyze(8,8,&vec![[0.0;4];64]);let b=analyze(8,8,&vec![[1.0,0.2,0.7,0.0];64]);assert_eq!(a,b);
    }
    #[test]
    fn classes_use_structure_not_location(){
        let flat=Region{size:20,..Region::default()};assert_eq!(classify(&flat,1000),Class::Smooth);
        let edge=Region{size:20,energy:2.0,xx:2.0,..Region::default()};assert_eq!(classify(&edge,1000),Class::Contour);
        let detail=Region{size:20,energy:2.0,xx:1.0,yy:1.0,boundary:10,contrast:3.0,..Region::default()};assert_eq!(classify(&detail,1000),Class::CompactDetail);
    }
}
