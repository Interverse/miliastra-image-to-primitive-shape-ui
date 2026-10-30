/* Optimization of the native rectangle converter's rendered output.
 * Only integer, axis-aligned, solid-color rectangles. No fitted opacity,
 * rotation, textures, resampling or alternative shape assets.
 */
"use strict";
const RectangleOptimizer = (() => {
  const R = typeof RectangleCompression !== "undefined" ? RectangleCompression : require("./rectangle-compression.js");
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const even = v => { const n=Math.floor(v);return Math.abs(v-n-0.5)<1e-8?n+(n%2):Math.round(v); };
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));

  class Model {
    constructor(target,width,height) {
      this.target=target;this.width=width;this.height=height;
      this.integral=new R.Integral(target,width,height);
    }
    stats(x,y,w,h) {
      const s=this.integral.stats(x,y,w,h),mean=s.color.slice(),a=even(mean[3]*255)/255;
      s.color=[...mean.slice(0,3).map(v=>a>0?even(clamp(v/a,0,1)*255)/255*a:0),a];
      // Statistical variance plus the exact cost of the exported byte color.
      for(let c=0;c<4;c++)s.error+=w*h*(s.color[c]-mean[c])**2;
      return s;
    }
    uniform(n) {
      const t=this.target,w=this.width,anchor=(n.y*w+n.x)*4;
      for(let y=n.y;y<n.y+n.h;y++)for(let x=n.x;x<n.x+n.w;x++)for(let c=0;c<4;c++)if(t[(y*w+x)*4+c]!==t[anchor+c])return false;
      return true;
    }
    plan(n) {
      if(n.plan!==undefined)return n.plan;
      if(this.uniform(n)){n.plan=null;return null;}
      let best=null;
      for(let axis=0;axis<2;axis++)for(let k=1;k<(axis?n.h:n.w);k++){
        const a=this.stats(n.x,n.y,axis?n.w:k,axis?k:n.h);
        const b=this.stats(n.x+(axis?0:k),n.y+(axis?k:0),axis?n.w:n.w-k,axis?n.h-k:n.h);
        const gain=n.error-a.error-b.error;
        if(!best||gain>best.gain)best={axis,cut:(axis?n.y:n.x)+k,a,b,gain};
      }
      n.plan=best;return best;
    }
    expand(n) {
      const p=this.plan(n);if(!p)return false;
      n.axis=p.axis;n.cut=p.cut;
      n.left={...p.a,color:p.a.color.slice()};n.right={...p.b,color:p.b.color.slice()};
      n.left.parent=n;n.right.parent=n;return true;
    }
    collect(root) {
      const leaves=[],internals=[];
      function visit(n){if(n.left){internals.push(n);visit(n.left);visit(n.right);}else leaves.push(n);}
      visit(root);return {leaves,internals};
    }
    snapshot(root) {
      return this.collect(root).leaves.map(n=>({x:n.x,y:n.y,w:n.w,h:n.h,color:n.color.slice(),error:n.error}));
    }
    refresh(n,x,y,w,h,force=false) {
      const changed=n.x!==x||n.y!==y||n.w!==w||n.h!==h;
      if(!changed&&!force)return;
      if(changed){const s=this.stats(x,y,w,h);Object.assign(n,s);n.plan=undefined;}
      if(n.left){
        if(n.axis===0){this.refresh(n.left,x,y,n.cut-x,h);this.refresh(n.right,n.cut,y,x+w-n.cut,h);}
        else {this.refresh(n.left,x,y,w,n.cut-y);this.refresh(n.right,x,n.cut,w,y+h-n.cut);}
      }
    }
    slide(n) {
      if(!n.left||(!n.left.left&&!n.right.left))return false;
      const left=this.collect(n.left).leaves,right=this.collect(n.right).leaves,axis=n.axis,cut=n.cut;
      const a=left.filter(v=>axis?v.y+v.h===cut:v.x+v.w===cut);
      const b=right.filter(v=>axis?v.y===cut:v.x===cut);
      let lo=axis?n.y+1:n.x+1,hi=axis?n.y+n.h-1:n.x+n.w-1;
      for(const v of a)lo=Math.max(lo,axis?v.y+1:v.x+1);
      for(const v of b)hi=Math.min(hi,axis?v.y+v.h-1:v.x+v.w-1);
      let best=a.concat(b).reduce((s,v)=>s+v.error,0),position=cut;
      for(let p=lo;p<=hi;p++){
        if(p===cut)continue;let error=0;const d=p-cut;
        for(const v of a)error+=this.stats(v.x,v.y,v.w+(axis?0:d),v.h+(axis?d:0)).error;
        for(const v of b)error+=this.stats(v.x+(axis?0:d),v.y+(axis?d:0),v.w-(axis?0:d),v.h-(axis?d:0)).error;
        if(error<best-1e-12){best=error;position=p;}
      }
      if(position===cut)return false;
      n.cut=position;this.refresh(n,n.x,n.y,n.w,n.h,true);return true;
    }
    exchange(root) {
      const {leaves,internals}=this.collect(root),splits=[];
      for(const leaf of leaves){const p=this.plan(leaf);if(p&&p.gain>1e-12)splits.push({leaf,gain:p.gain});}
      splits.sort((a,b)=>b.gain-a.gain);
      const merges=internals.filter(n=>!n.left.left&&!n.right.left).map(n=>({node:n,cost:n.error-n.left.error-n.right.error})).sort((a,b)=>a.cost-b.cost);
      let best=null;
      for(const merge of merges.slice(0,8)){
        const split=splits.find(s=>s.leaf.parent!==merge.node);
        if(split&&split.gain>merge.cost+1e-12&&(!best||split.gain-merge.cost>best.gain))best={merge:merge.node,split:split.leaf,gain:split.gain-merge.cost};
      }
      if(!best)return false;
      best.merge.left.parent=null;best.merge.right.parent=null;
      best.merge.left=null;best.merge.right=null;
      this.expand(best.split);return true;
    }
  }

  async function partition(target,width,height,budget,hooks={}) {
    const model=new Model(target,width,height),root=model.stats(0,0,width,height),heap=new R.Heap();let count=1;
    const schedule=n=>{const p=model.plan(n);if(p){n.gain=Math.max(0,p.gain);heap.push(n);}};
    schedule(root);
    while(count<budget&&heap.items.length){
      if(hooks.cancelled?.())return null;
      const n=heap.pop();model.expand(n);count++;schedule(n.left);schedule(n.right);
      if(count%32===0){hooks.progress?.(count,budget);await pause();}
    }
    hooks.progress?.(count,budget);
    return {model,root,nodes:model.snapshot(root)};
  }

  // Start from the exact native tiling and merge the least costly adjoining
  // rectangles. This avoids growing tens of thousands of overdraw proposals
  // from a blank canvas when the requested budget is close to the native size.
  // Full-edge neighbors only: every accepted union remains one rectangle.
  async function mergeNative(input,target,width,height,budget,hooks={}) {
    const model=new Model(target,width,height),heap=new R.Heap(),active=new Set();
    const startsX=new Map(),endsX=new Map(),startsY=new Map(),endsY=new Map();
    const keyX=n=>[n.x,n.y,n.h].join(":"),endX=n=>[n.x+n.w,n.y,n.h].join(":");
    const keyY=n=>[n.y,n.x,n.w].join(":"),endY=n=>[n.y+n.h,n.x,n.w].join(":");
    function pair(a,b){
      if(!a||!b)return;
      const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.max(a.x+a.w,b.x+b.w)-x,h=Math.max(a.y+a.h,b.y+b.h)-y;
      if(w*h!==a.w*a.h+b.w*b.h)return;
      const merged=model.stats(x,y,w,h),cost=Math.max(0,merged.error-a.error-b.error);
      heap.push({a,b,merged,gain:-cost});
    }
    function add(n){
      pair(n,endsX.get(keyX(n)));pair(n,startsX.get(endX(n)));
      pair(n,endsY.get(keyY(n)));pair(n,startsY.get(endY(n)));
      startsX.set(keyX(n),n);endsX.set(endX(n),n);startsY.set(keyY(n),n);endsY.set(endY(n),n);active.add(n);
    }
    function remove(n){
      startsX.delete(keyX(n));endsX.delete(endX(n));startsY.delete(keyY(n));endsY.delete(endY(n));active.delete(n);
    }
    for(let i=0;i<input.length;i++){
      if(hooks.cancelled?.())return null;
      const n=input[i];add(model.stats(n.x,n.y,n.w,n.h));
      if(i%512===0)await pause();
    }
    let merges=0;
    while(active.size>budget&&heap.items.length){
      if(hooks.cancelled?.())return null;
      const p=heap.pop();if(!active.has(p.a)||!active.has(p.b))continue;
      remove(p.a);remove(p.b);add(p.merged);merges++;
      if(merges%128===0){hooks.progress?.(input.length-active.size,input.length-budget);await pause();}
    }
    const nodes=Array.from(active, n=>({x:n.x,y:n.y,w:n.w,h:n.h,color:n.color.slice(),error:n.error}));
    return {nodes,merges,reached:nodes.length<=budget,background:model.stats(0,0,width,height)};
  }

  async function refine(state,iterations,hooks={}) {
    const {model,root}=state;let order=[],changes=0;
    // Yield before the first step, including for very large requested runs.
    hooks.progress?.(0,iterations);await pause();
    for(let step=1;step<=iterations;step++){
      if(hooks.cancelled?.())return null;
      if(!order.length||step%32===1){
        const all=model.collect(root);const errors=new Map();
        function error(n){if(!n.left)return n.error;const v=error(n.left)+error(n.right);errors.set(n,v);return v;}
        error(root);order=all.internals.sort((a,b)=>errors.get(b)-errors.get(a));
      }
      if(order.length&&model.slide(order[(step-1)%order.length]))changes++;
      if(step%16===0&&model.exchange(root))changes++;
      if(step%32===0||step===iterations)await hooks.candidate?.(model.snapshot(root),step);
      if(step%8===0||step===iterations){hooks.progress?.(step,iterations);await pause();}
    }
    return {nodes:model.snapshot(root),steps:iterations,changes};
  }

  // Opaque overdraw candidate. An integer rectangle repaints a region with its
  // optimal byte RGB. Only a negative exact error delta is ever painted.
  async function layered(target,width,height,budget,hooks={}) {
    if(target.some((v,i)=>i%4===3&&v!==1))return null;
    const model=new Model(target,width,height),canvas=new Float64Array(target.length),errors=new Float64Array(width*height);
    const prefix=new Float64Array((width+1)*(height+1)),cdf=new Float64Array(width*height),out=[];
    let total=0,state=1;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    function paint(n){for(let y=n.y;y<n.y+n.h;y++)for(let x=n.x;x<n.x+n.w;x++){
      const p=(y*width+x)*4;let error=0;
      for(let c=0;c<4;c++){canvas[p+c]=n.color[c];error+=(target[p+c]-canvas[p+c])**2;}
      errors[p/4]=error;
    }}
    const base=model.stats(0,0,width,height);paint(base);out.push(base);
    function update(){
      total=0;
      for(let y=0;y<height;y++){let sum=0;for(let x=0;x<width;x++){
        const i=y*width+x,j=(y+1)*(width+1)+x+1;sum+=errors[i];prefix[j]=prefix[j-width-1]+sum;
        total+=errors[i];cdf[i]=total;
      }}
    }
    function pick(){let lo=0,hi=cdf.length-1,value=random()*total;while(lo<hi){const m=(lo+hi)>>>1;if(cdf[m]<value)lo=m+1;else hi=m;}return lo;}
    function proposal(x0,y0,x1,y1){
      x0=clamp(Math.round(x0),0,width-1);y0=clamp(Math.round(y0),0,height-1);
      x1=clamp(Math.round(x1),x0+1,width);y1=clamp(Math.round(y1),y0+1,height);
      const n=model.stats(x0,y0,x1-x0,y1-y0);
      n.delta=n.error-model.integral.rect(prefix,n.x,n.y,n.w,n.h);return n;
    }
    for(let i=1;i<budget;i++){
      if(hooks.cancelled?.())return null;
      if(i%4===1)update();if(total<1e-15)break;
      let best=null;
      const density=Math.max(1,Math.sqrt(width*height/budget)),maximum=Math.max(density,Math.max(width,height)*0.25*(1-i/budget));
      for(let location=0;location<4;location++){
        const p=pick(),x=p%width+0.5,y=Math.floor(p/width)+0.5;
        for(const size of [1,2,density/2,density,density*2,maximum])for(const aspect of [1/8,1/3,1,3,8]){
          const w=Math.max(1,size*Math.sqrt(aspect)),h=Math.max(1,size/Math.sqrt(aspect));
          const n=proposal(x-w/2,y-h/2,x+w/2,y+h/2);if(!best||n.delta<best.delta)best=n;
        }
      }
      for(let attempt=0;attempt<48;attempt++){
        const box=[best.x,best.y,best.x+best.w,best.y+best.h],axis=Math.floor(random()*4),sign=random()<0.5?-1:1;
        box[axis]+=sign*Math.max(1,Math.round((axis%2?best.h:best.w)*0.25));
        if(box[2]<=box[0]||box[3]<=box[1])continue;
        const n=proposal(...box);if(n.delta<best.delta)best=n;
      }
      // The prefix is refreshed in batches, so verify against current pixels.
      let old=0;
      for(let y=best.y;y<best.y+best.h;y++)for(let x=best.x;x<best.x+best.w;x++)old+=errors[y*width+x];
      if(best.error>=old-1e-12){
        let at=0;for(let p=1;p<errors.length;p++)if(errors[p]>errors[at])at=p;
        if(errors[at]<1e-15)break;
        best=model.stats(at%width,Math.floor(at/width),1,1);
      }
      paint(best);out.push(best);
      if(i%8===0){hooks.progress?.(out.length,budget);await pause();}
    }
    hooks.progress?.(out.length,budget);return out;
  }

  // Joint coordinate refinement of opaque overdraw. Later rectangles mask
  // earlier ones. Recolor only visible pixels; shrinking a rectangle restores
  // the exact earlier painter underneath it, rather than an assumed backdrop.
  async function refineLayered(input,target,width,height,iterations,hooks={}) {
    const nodes=input.map(n=>({x:n.x,y:n.y,w:n.w,h:n.h,color:n.color.slice()}));
    const owners=new Uint32Array(width*height),errors=new Float64Array(width*height),columns=Math.ceil(width/16);
    let order=[],changes=0,state=7;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    function inside(n,x,y){return x>=n.x&&y>=n.y&&x<n.x+n.w&&y<n.y+n.h;}
    function error(p,color){let e=0;for(let c=0;c<3;c++)e+=(target[p*4+c]-color[c])**2;return e;}
    for(let i=0;i<nodes.length;i++){const n=nodes[i];for(let y=n.y;y<n.y+n.h;y++)owners.fill(i,y*width+n.x,y*width+n.x+n.w);}
    for(let p=0;p<owners.length;p++)errors[p]=error(p,nodes[owners[p]].color);
    function tiles(){
      const result=Array.from({length:columns*Math.ceil(height/16)},()=>[]);
      for(let i=0;i<nodes.length;i++){const n=nodes[i];for(let y=n.y>>4;y<=((n.y+n.h-1)>>4);y++)for(let x=n.x>>4;x<=((n.x+n.w-1)>>4);x++)result[y*columns+x].push(i);}
      return result;
    }
    hooks.progress?.(0,iterations);await pause();
    for(let step=1;step<=iterations;step++){
      if(hooks.cancelled?.())return null;
      if(!order.length||step%32===1){
        const score=new Float64Array(nodes.length);for(let p=0;p<owners.length;p++)score[owners[p]]+=errors[p];
        order=Array.from(score,(_v,i)=>i).sort((a,b)=>score[b]-score[a]);
      }
      const k=order[(step-1)%order.length],old=nodes[k],index=tiles(),visible=[],under=new Map();
      for(let y=old.y;y<old.y+old.h;y++)for(let x=old.x;x<old.x+old.w;x++){
        const p=y*width+x;if(owners[p]!==k)continue;
        let previous=0;
        if(k){const list=index[(y>>4)*columns+(x>>4)];for(let j=list.length-1;j>=0;j--){const id=list[j];if(id<k&&inside(nodes[id],x,y)){previous=id;break;}}}
        visible.push({p,x,y,undo:error(p,nodes[previous].color)-errors[p]});under.set(p,previous);
      }
      function proposal(x,y,w,h){
        if(w<1||h<1||x<0||y<0||x+w>width||y+h>height)return null;
        let n=0,oldError=0,square=0;const sum=[0,0,0];
        for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){
          const p=yy*width+xx;if(owners[p]>k)continue;n++;oldError+=errors[p];
          for(let c=0;c<3;c++){const v=target[p*4+c];sum[c]+=v;square+=v*v;}
        }
        if(!n)return null;
        const color=sum.map(v=>even(clamp(v/n,0,1)*255)/255);let cost=square-oldError;
        for(let c=0;c<3;c++)cost+=n*color[c]*color[c]-2*color[c]*sum[c];
        for(const v of visible)if(v.x<x||v.y<y||v.x>=x+w||v.y>=y+h)cost+=v.undo;
        return {x,y,w,h,color:[...color,1],delta:cost};
      }
      let best=proposal(old.x,old.y,old.w,old.h);
      if(k)for(let trial=0;trial<32;trial++){
        const start=best&&best.delta<0?best:old,box=[start.x,start.y,start.x+start.w,start.y+start.h];
        const axis=Math.floor(random()*4),sign=random()<0.5?-1:1,span=[1,2,Math.max(1,Math.round((axis%2?start.h:start.w)*0.2))][trial%3];
        box[axis]+=sign*span;
        const n=proposal(box[0],box[1],box[2]-box[0],box[3]-box[1]);if(n&&(!best||n.delta<best.delta))best=n;
      }
      if(best&&best.delta<-1e-12){
        nodes[k]={x:best.x,y:best.y,w:best.w,h:best.h,color:best.color};
        const x0=Math.min(old.x,best.x),y0=Math.min(old.y,best.y),x1=Math.max(old.x+old.w,best.x+best.w),y1=Math.max(old.y+old.h,best.y+best.h);
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
          const p=y*width+x;if(owners[p]>k)continue;
          if(inside(best,x,y))owners[p]=k;else if(owners[p]===k)owners[p]=under.get(p);
          errors[p]=error(p,nodes[owners[p]].color);
        }
        changes++;
      }
      if(step%32===0||step===iterations)await hooks.candidate?.(nodes.map(n=>({...n,color:n.color.slice()})),step);
      if(step%8===0||step===iterations){hooks.progress?.(step,iterations);await pause();}
    }
    return {nodes,steps:iterations,changes,loss:errors.reduce((a,b)=>a+b,0)};
  }
  return {Model,partition,mergeNative,refine,layered,refineLayered};
})();
if(typeof module!=="undefined")module.exports=RectangleOptimizer;
