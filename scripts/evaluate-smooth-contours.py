"""Independent exported-boundary diagnostics, not a perceptual quality score."""
import argparse,json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter,sobel,distance_transform_edt,label,binary_erosion


def rgba(path):
    a=np.asarray(Image.open(path).convert('RGBA'),dtype=np.float64)/255
    a[:,:,:3]*=a[:,:,3:4]
    return a


def edges(a):
    smooth=gaussian_filter(a,(.65,.65,0))
    gx=sobel(smooth,axis=1)/8;gy=sobel(smooth,axis=0)/8
    xx=np.sum(gx*gx,axis=2);xy=np.sum(gx*gy,axis=2);yy=np.sum(gy*gy,axis=2)
    strength=np.sqrt((xx+yy)/2+np.sqrt((xx-yy)**2/4+xy*xy))
    angle=.5*np.arctan2(2*xy,xx-yy)
    # Absolute threshold; fewer output edges alone is never a quality reward.
    return strength>.045,angle,strength


def measure(source,output):
    a,b=rgba(source),rgba(output);assert a.shape==b.shape
    ae,an,_=edges(a);be,bn,bw=edges(b)
    da,ia=distance_transform_edt(~ae,return_indices=True);db=distance_transform_edt(~be)
    valid=be&(da<=3)
    tangent=np.sin(bn-an[ia[0],ia[1]])**2
    transparent=np.any(a[:,:,3]<.99)
    # Evaluation-only openings in these sources: alpha holes, or light holes in
    # the white-background line fixtures. This is not general semantic annotation.
    foreground=a[:,:,3]>.5 if transparent else np.mean(a[:,:,:3],axis=2)<.75
    output_foreground=b[:,:,3]>.5 if transparent else np.mean(b[:,:,:3],axis=2)<.75
    components,n=label(~foreground);border=set(np.unique(np.concatenate((components[0],components[-1],components[:,0],components[:,-1]))));holes=[]
    for i in range(1,n+1):
        region=components==i
        if i in border or region.sum()<16:continue
        interior=binary_erosion(region,iterations=2)
        if not interior.any():continue
        holes.append(float(np.mean(~output_foreground[interior])))
    return dict(source_hole_count=len(holes),source_hole_background_retention=holes,
                premult_mse=float(np.mean((a-b)**2)),alpha_spill=float(np.maximum(b[:,:,3]-a[:,:,3],0).sum()),alpha_deficit=float(np.maximum(a[:,:,3]-b[:,:,3],0).sum()),
                matched_edge_tangent_error=float(np.average(tangent[valid],weights=bw[valid])) if valid.any() else None,
                unmatched_output_edge_fraction=float(np.mean(da[be]>3)) if be.any() else None,
                missing_source_edge_fraction=float(np.mean(db[ae]>3)) if ae.any() else None,
                source_to_output_edge_distance=float(db[ae].mean()) if ae.any() else None,
                output_edge_pixels=int(be.sum()),source_edge_pixels=int(ae.sum()))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('folder',type=Path);a=p.parse_args()
    data=json.loads((a.folder/'results.json').read_text());assert data['complete'];rows=[]
    for row in data['rows']:
        target=a.folder/row['name']/'source-256.png';output=a.folder/row['folder']/'vector-256.png'
        rows.append({**row,'measurements':measure(target,output)})
    (a.folder/'evaluations.json').write_text(json.dumps(dict(scope='Diagnostics at256px from exported game geometry. Tangent agreement, unmatched/missing contours, pixel error and alpha are separate; not human identity/style or universal quality. No output-alpha masking.',rows=rows),indent=2))
    table=['| Source | Family | N | Seed | Smoothing | Tangent error | Unmatched edges | Missing edges | MSE |','|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        m=r['measurements'];table.append(f"|{r['name']}|{r['family']}|{r['count']}|{r['seed']}|{r['strength']}|{m['matched_edge_tangent_error']:.5f}|{m['unmatched_output_edge_fraction']:.3%}|{m['missing_source_edge_fraction']:.3%}|{m['premult_mse']:.6f}|")
    (a.folder/'measurements.md').write_text('\n'.join(table)+'\n');print('\n'.join(table))


if __name__=='__main__':main()
