//! Research constraint: one upright triangle sprite, local X/Y scale and rotation.
//! Project every proposal and gradient update, rather than post-distorting a fit.
#[inline(always)]
pub(crate) fn project(v: &mut [f64; 6]) -> bool {
    let original = *v;
    let cx = (v[0] + v[2] + v[4]) / 3.0;
    let cy = (v[1] + v[3] + v[5]) / 3.0;
    let mut best = original;
    let mut best_error = f64::INFINITY;
    for apex in 0..3 {
        let i = (apex + 1) % 3;
        let j = (apex + 2) % 3;
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
