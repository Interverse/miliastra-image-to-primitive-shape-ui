/* Error-driven Gaussian placement. Each candidate solves bounded RGB and
 * opacity against the actual premultiplied source-over canvas. A fixed
 * primitive budget is spent on the largest remaining weighted errors.
 */
"use strict";
const GaussianSeed = (() => {
  const K = typeof Gaussian !== "undefined" ? Gaussian : require("./gaussian.js");
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function weights(target, width, height) {
    const result = new Float32Array(width * height);
    let sum = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const l = (y * width + Math.max(0, x - 1)) * 4;
      const r = (y * width + Math.min(width - 1, x + 1)) * 4;
      const t = (Math.max(0, y - 1) * width + x) * 4;
      const b = (Math.min(height - 1, y + 1) * width + x) * 4;
      let energy = 0;
      for (let c = 0; c < 4; c++) {
        const dx = target[r + c] - target[l + c], dy = target[b + c] - target[t + c];
        energy += (dx * dx + dy * dy) * (c === 3 ? 0.25 : 1);
      }
      const edge = Math.sqrt(energy);
      const value = 1 + 3 * edge / (edge + 0.12);
      result[y * width + x] = value; sum += value;
    }
    const normalizer = width * height / Math.max(1, sum);
    for (let i = 0; i < result.length; i++) result[i] *= normalizer;
    return result;
  }

  function raster(shape, width, height, visit) {
    const [cx, cy, lx, ly, angle] = shape;
    const sx = Math.exp(lx), sy = Math.exp(ly), c = Math.cos(angle), s = Math.sin(angle);
    const bx = 3 * Math.hypot(c * sx, s * sy), by = 3 * Math.hypot(s * sx, c * sy);
    const x0 = Math.max(0, Math.floor(cx - bx)), x1 = Math.min(width - 1, Math.ceil(cx + bx));
    const y0 = Math.max(0, Math.floor(cy - by)), y1 = Math.min(height - 1, Math.ceil(cy + by));
    const a = c*c/(sx*sx) + s*s/(sy*sy), b = c*s*(1/(sx*sx)-1/(sy*sy));
    const d = s*s/(sx*sx) + c*c/(sy*sy);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, q = a*dx*dx + 2*b*dx*dy + d*dy*dy;
        if (q < 9) visit((y * width + x) * 4, (Math.exp(-0.5*q)-K.EDGE)*K.NORM);
      }
    }
  }

  function solve(shape, canvas, target, importance, width, height, transparent) {
    let s2=0, br=0, bg=0, bb=0, b2=0, dr=0, dg=0, db=0, db1=0, a1=0, a2=0;
    raster(shape, width, height, (p, z) => {
      const w=importance[p/4], wz=w*z, wz2=wz*z;
      const r=canvas[p], g=canvas[p+1], b=canvas[p+2];
      const er=target[p]-r, eg=target[p+1]-g, eb=target[p+2]-b;
      s2+=wz2; br+=wz2*r; bg+=wz2*g; bb+=wz2*b; b2+=wz2*(r*r+g*g+b*b);
      dr+=wz*er; dg+=wz*eg; db+=wz*eb; db1+=wz*(er*r+eg*g+eb*b);
      if (transparent) {
        const remain=1-canvas[p+3];
        a1+=wz*remain*(target[p+3]-canvas[p+3]); a2+=wz2*remain*remain;
      }
    });
    let best = { shape, delta: 0, color: [0,0,0], opacity: 0 };
    if (s2 < 1e-12) return best;
    const opacities = [0.25, 0.5, 0.75, 0.995];
    if (transparent && a2>1e-12) opacities.push(clamp(a1/a2,0.01,0.995));
    for (const o of opacities) {
      const r=clamp((dr/o+br)/s2,0,1), g=clamp((dg/o+bg)/s2,0,1), b=clamp((db/o+bb)/s2,0,1);
      const delta=o*o*(s2*(r*r+g*g+b*b)-2*(r*br+g*bg+b*bb)+b2+a2)
        -2*o*(r*dr+g*dg+b*db-db1+a1);
      if (delta<best.delta) best={shape,delta,color:[r,g,b],opacity:o};
    }
    return best;
  }

  function paint(canvas, candidate, width, height) {
    raster(candidate.shape,width,height,(p,z)=>{
      const alpha=z*candidate.opacity;
      for(let c=0;c<3;c++) canvas[p+c]+=alpha*(candidate.color[c]-canvas[p+c]);
      canvas[p+3]+=alpha*(1-canvas[p+3]);
    });
  }

  async function grow(target,width,height,count,transparent,options={}) {
    const base=options.params || new Float64Array(0), oldCount=base.length/9;
    const params=new Float64Array(count*9);params.set(base);
    const canvas=options.canvas ? options.canvas.slice() : new Float32Array(width*height*4);
    if (!options.canvas && !transparent) canvas.fill(1);
    const importance=options.weights || weights(target,width,height);
    let state=(options.seed || 1)>>>0;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const cdf=new Float64Array(width*height);
    let total=0;
    function updateErrors(){
      total=0;
      for(let i=0;i<cdf.length;i++){
        let error=0;const p=i*4;
        for(let c=0;c<(transparent?4:3);c++){const d=canvas[p+c]-target[p+c];error+=d*d;}
        total+=importance[i]*error;cdf[i]=total;
      }
    }
    function pick(){
      const value=random()*total;let lo=0,hi=cdf.length-1;
      while(lo<hi){const mid=(lo+hi)>>>1;if(cdf[mid]<value)lo=mid+1;else hi=mid;}
      return lo;
    }
    const density=Math.max(0.6,Math.sqrt(width*height/count)*0.55);
    for(let i=oldCount;i<count;i++){
      if(options.cancelled&&options.cancelled())return null;
      if((i-oldCount)%4===0)updateErrors();
      let best=null;
      const fraction=(i-oldCount)/Math.max(1,count-oldCount);
      const maximum=Math.max(1.2,Math.max(width,height)*(options.detail?0.06:0.22)*(1-0.75*fraction));
      const scales=[0.5,1,density*0.5,density,density*2,maximum].filter(s=>s<=maximum+1e-6);
      for(let location=0;location<4;location++){
        const pixel=total>1e-12?pick():Math.floor(random()*width*height);
        const x=pixel%width,y=Math.floor(pixel/width);
        const l=(y*width+Math.max(0,x-1))*4,r=(y*width+Math.min(width-1,x+1))*4;
        const t=(Math.max(0,y-1)*width+x)*4,b=(Math.min(height-1,y+1)*width+x)*4;
        let gx=0,gy=0,strongest=-1;
        for(let c=0;c<4;c++){
          const dx=target[r+c]-target[l+c],dy=target[b+c]-target[t+c],power=dx*dx+dy*dy;
          if(power>strongest){strongest=power;gx=dx;gy=dy;}
        }
        const tangent=Math.atan2(gy,gx)+Math.PI/2;
        for(const scale of scales)for(const aspect of [1,2.5]){
          const shape=[x+0.5,y+0.5,Math.log(scale*Math.sqrt(aspect)),Math.log(scale/Math.sqrt(aspect)),aspect===1?0:tangent];
          const candidate=solve(shape,canvas,target,importance,width,height,transparent);
          if(!best||candidate.delta<best.delta)best=candidate;
        }
      }
      for(let mutation=0;mutation<18;mutation++){
        const shape=best.shape.slice(),dimension=Math.floor(random()*5),direction=random()<0.5?-1:1;
        if(dimension<2)shape[dimension]+=direction*Math.max(0.4,Math.exp(Math.min(shape[2],shape[3]))*0.5);
        else shape[dimension]+=direction*(dimension===4?0.35:0.25);
        shape[0]=clamp(shape[0],-width*0.1,width*1.1);shape[1]=clamp(shape[1],-height*0.1,height*1.1);
        shape[2]=clamp(shape[2],Math.log(0.2),Math.log(Math.max(width,height)));
        shape[3]=clamp(shape[3],Math.log(0.2),Math.log(Math.max(width,height)));
        const candidate=solve(shape,canvas,target,importance,width,height,transparent);
        if(candidate.delta<best.delta)best=candidate;
      }
      paint(canvas,best,width,height);
      params.set([...best.shape,...best.color,best.opacity],i*9);
      if((i-oldCount)%8===0||i===count-1){
        if(options.progress)options.progress(i+1,count);
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    return {params,canvas};
  }
  return {weights,solve,paint,grow};
})();
if(typeof module!=="undefined")module.exports=GaussianSeed;
