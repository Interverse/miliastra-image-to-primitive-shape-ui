//! Research constraint: one upright triangle sprite, local X/Y scale and rotation.
//! Project every proposal and gradient update, rather than post-distorting a fit.
#[inline(always)]
pub(crate) fn project(v: &mut [f64; 6]) -> bool {
    let original = *v;
    let cx = (v[0] + v[2] + v[4]) / 3.0;
    let cy = (v[1] + v[3] + v[5]) / 3.0;
    let mut best = original;
    let mut best_error = f64::INFINITY;
    #[cfg(all(target_arch="wasm32",target_feature="simd128"))]
    let frames=frames_simd(v);
    for apex in 0..3 {
        let i = (apex + 1) % 3;
        let j = (apex + 2) % 3;
        #[cfg(all(target_arch="wasm32",target_feature="simd128"))]
        let (ux,uy,nx,ny,half,height)=frames[apex];
        #[cfg(not(all(target_arch="wasm32",target_feature="simd128")))]
        let (ux,uy,nx,ny,half,height)={
        let ax = (v[2*j] - v[2*i]) / 2.0;
        let ay = (v[2*j+1] - v[2*i+1]) / 2.0;
        let bx = v[2*apex] - (v[2*i] + v[2*j]) / 2.0;
        let by = v[2*apex+1] - (v[2*i+1] + v[2*j+1]) / 2.0;
        // Principal eigenvector of 2aa' + (2/3)(Jb)(Jb)'.
        let xx = 2.0*ax*ax + (2.0/3.0)*by*by;
        let yy = 2.0*ay*ay + (2.0/3.0)*bx*bx;
        let xy = 2.0*ax*ay - (2.0/3.0)*by*bx;
        let lambda = (xx + yy + ((xx-yy)*(xx-yy)+4.0*xy*xy).sqrt())/2.0;
        let (mut ux, mut uy) = if xy.abs() < 1e-15 {
            if xx >= yy { (1.0, 0.0) } else { (0.0, 1.0) }
        } else { (xy, lambda-xx) };
        let norm = (ux*ux+uy*uy).sqrt();
        ux /= norm; uy /= norm;
        if ax*ux+ay*uy < 0.0 { ux = -ux; uy = -uy; }
        let (mut nx, mut ny) = (-uy, ux);
        if bx*nx+by*ny < 0.0 { nx = -nx; ny = -ny; }
        let half = (ax*ux+ay*uy).abs().max(0.5);
        // Preserve Primeval's >15 degree minimum interior angle.
        let tangent = 0.2773245440598384_f64; // tan 15.5 degrees
        let height = (bx*nx+by*ny).abs().clamp(
            half*tangent, half*(1.0+(1.0+tangent*tangent).sqrt())/tangent);
            (ux,uy,nx,ny,half,height)
        };
        let mut candidate = [0.0; 6];
        candidate[2*i] = cx-height*nx/3.0-half*ux;
        candidate[2*i+1] = cy-height*ny/3.0-half*uy;
        candidate[2*j] = cx-height*nx/3.0+half*ux;
        candidate[2*j+1] = cy-height*ny/3.0+half*uy;
        candidate[2*apex] = cx+2.0*height*nx/3.0;
        candidate[2*apex+1] = cy+2.0*height*ny/3.0;
        let error: f64 = candidate.iter().zip(original).map(|(a,b)| (a-b)*(a-b)).sum();
        if error < best_error { best_error = error; best = candidate; }
    }
    *v = best;
    best_error > 1e-20
}


// Independent apex projections occupy separate lanes; every multiply/add,
// square root and divide retains the scalar operation order (no FMA).
#[cfg(all(target_arch="wasm32",target_feature="simd128"))]
#[inline]
fn frames_simd(v:&[f64;6])->[(f64,f64,f64,f64,f64,f64);3] {
    use std::arch::wasm32::*;
    let mut out=[(0.0,0.0,0.0,0.0,0.0,0.0);3];
    for start in [0usize,2] {
        let apex=[start,(start+1).min(2)];let mut a=[[0.0;4];2];
        for lane in 0..2 {let k=apex[lane];let i=(k+1)%3;let j=(k+2)%3;a[lane]=[(v[2*j]-v[2*i])/2.0,(v[2*j+1]-v[2*i+1])/2.0,v[2*k]-(v[2*i]+v[2*j])/2.0,v[2*k+1]-(v[2*i+1]+v[2*j+1])/2.0];}
        let ax=f64x2(a[0][0],a[1][0]);let ay=f64x2(a[0][1],a[1][1]);let bx=f64x2(a[0][2],a[1][2]);let by=f64x2(a[0][3],a[1][3]);
        let two=f64x2_splat(2.0);let third=f64x2_splat(2.0/3.0);
        let xx=f64x2_add(f64x2_mul(f64x2_mul(two,ax),ax),f64x2_mul(f64x2_mul(third,by),by));
        let yy=f64x2_add(f64x2_mul(f64x2_mul(two,ay),ay),f64x2_mul(f64x2_mul(third,bx),bx));
        let xy=f64x2_sub(f64x2_mul(f64x2_mul(two,ax),ay),f64x2_mul(f64x2_mul(third,by),bx));
        let diff=f64x2_sub(xx,yy);
        let lambda=f64x2_div(f64x2_add(f64x2_add(xx,yy),f64x2_sqrt(f64x2_add(f64x2_mul(diff,diff),f64x2_mul(f64x2_mul(f64x2_splat(4.0),xy),xy)))),two);
        let small=f64x2_lt(f64x2_abs(xy),f64x2_splat(1e-15));
        let axis=v128_and(f64x2_ge(xx,yy),f64x2_splat(1.0));
        let mut ux=v128_bitselect(axis,xy,small);let mut uy=v128_bitselect(f64x2_sub(f64x2_splat(1.0),axis),f64x2_sub(lambda,xx),small);
        let norm=f64x2_sqrt(f64x2_add(f64x2_mul(ux,ux),f64x2_mul(uy,uy)));ux=f64x2_div(ux,norm);uy=f64x2_div(uy,norm);
        let flip=f64x2_lt(f64x2_add(f64x2_mul(ax,ux),f64x2_mul(ay,uy)),f64x2_splat(0.0));ux=v128_bitselect(f64x2_neg(ux),ux,flip);uy=v128_bitselect(f64x2_neg(uy),uy,flip);
        let mut nx=f64x2_neg(uy);let mut ny=ux;let flip=f64x2_lt(f64x2_add(f64x2_mul(bx,nx),f64x2_mul(by,ny)),f64x2_splat(0.0));nx=v128_bitselect(f64x2_neg(nx),nx,flip);ny=v128_bitselect(f64x2_neg(ny),ny,flip);
        let half=f64x2_max(f64x2_abs(f64x2_add(f64x2_mul(ax,ux),f64x2_mul(ay,uy))),f64x2_splat(0.5));
        let tangent=0.2773245440598384_f64;
        let high=f64x2_div(f64x2_mul(half,f64x2_splat(1.0+(1.0+tangent*tangent).sqrt())),f64x2_splat(tangent));
        let height=f64x2_min(f64x2_max(f64x2_abs(f64x2_add(f64x2_mul(bx,nx),f64x2_mul(by,ny))),f64x2_mul(half,f64x2_splat(tangent))),high);
        out[start]=(f64x2_extract_lane::<0>(ux),f64x2_extract_lane::<0>(uy),f64x2_extract_lane::<0>(nx),f64x2_extract_lane::<0>(ny),f64x2_extract_lane::<0>(half),f64x2_extract_lane::<0>(height));
        if start==0 {out[1]=(f64x2_extract_lane::<1>(ux),f64x2_extract_lane::<1>(uy),f64x2_extract_lane::<1>(nx),f64x2_extract_lane::<1>(ny),f64x2_extract_lane::<1>(half),f64x2_extract_lane::<1>(height));}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::project;
    #[test]
    fn projected_shapes_are_isosceles_and_idempotent() {
        for n in 0..1000 {
            let mut v = std::array::from_fn(|i| ((n*7919+i*1051)%997) as f64 / 7.0);
            project(&mut v);
            let edge = |a: usize, b: usize| (v[2*a]-v[2*b]).powi(2)+(v[2*a+1]-v[2*b+1]).powi(2);
            let lengths = [edge(0,1), edge(1,2), edge(2,0)];
            assert!((lengths[0]-lengths[1]).abs().min((lengths[1]-lengths[2]).abs()).min((lengths[2]-lengths[0]).abs()) < 1e-8);
            let before = v;
            project(&mut v);
            assert!(v.iter().zip(before).all(|(a,b)| (a-b).abs() < 1e-8));
        }
    }
}
