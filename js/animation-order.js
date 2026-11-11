/* Lossless painter-order planning; only disjoint padded draw bounds may cross. */
'use strict';
const AnimationOrder=(()=>{
function bounds(frame,id,meta){
 const a=id*8;if(!frame[a]||Math.floor(frame[a+6]/16777216)===0)return null;
 const geometry=meta.compact?.5:.1,rotation=meta.compact?1:.1,w=frame[a+3]*geometry,h=frame[a+4]*geometry;if(w<=0||h<=0)return null;
 const angle=frame[a+5]*rotation*Math.PI/180,co=Math.abs(Math.cos(angle)),si=Math.abs(Math.sin(angle));
 const baseX=(w*co+h*si)/2,baseY=(w*si+h*co)/2,x=frame[a+1]*geometry,y=frame[a+2]*geometry,W=meta.dimensions[1],H=meta.dimensions[2];
 if(x+baseX<-W/2-2||x-baseX>W/2+2||y+baseY<-H/2-2||y-baseY>H/2+2)return null;
 const padding=Math.max(2,2*W/meta.dimensions[0]),rx=baseX+padding,ry=baseY+padding;
 return [Math.max(-W/2,x-rx),Math.max(-H/2,y-ry),Math.min(W/2,x+rx),Math.min(H/2,y+ry)];
}
const overlap=(a,b)=>a[0]<=b[2]&&b[0]<=a[2]&&a[1]<=b[3]&&b[1]<=a[3];
function originalOrder(frame,N){
 const order=new Array(N).fill(-1),unused=[];for(let id=0;id<N;id++)if(frame[id*8]){const rank=frame[id*8+7];if(!Number.isSafeInteger(rank)||rank<0||rank>=N||order[rank]!==-1)throw Error('Invalid primitive painter rank');order[rank]=id;}else unused.push(id);
 let at=0;for(let slot=0;slot<N;slot++)if(order[slot]===-1)order[slot]=unused[at++];return order;
}
function graph(frame,meta){
 const N=meta.dimensions[3],boxes=Array.from({length:N},(_,id)=>bounds(frame,id,meta)),order=originalOrder(frame,N),out=Array.from({length:N},()=>[]),indegree=new Int32Array(N),grid=new Map(),seen=new Int32Array(N);
 const cell=Math.max(1,Math.max(meta.dimensions[1],meta.dimensions[2])/Math.ceil(Math.sqrt(N/4)));let edges=0,stamp=0;
 for(const id of order){const box=boxes[id];if(!box)continue;stamp++;for(let y=Math.floor(box[1]/cell);y<=Math.floor(box[3]/cell);y++)for(let x=Math.floor(box[0]/cell);x<=Math.floor(box[2]/cell);x++){
  const key=x+','+y;let bucket=grid.get(key);if(!bucket){bucket=[];grid.set(key,bucket);}for(const prev of bucket)if(seen[prev]!==stamp){seen[prev]=stamp;if(overlap(boxes[prev],box)){out[prev].push(id);indegree[id]++;if(++edges>2000000)throw Error('Draw-order dependency graph exceeds 2,000,000 edges; shape count was not truncated');}}bucket.push(id);
 }}
 const offsets=new Int32Array(N+1);for(let id=0;id<N;id++)offsets[id+1]=offsets[id]+out[id].length;const targets=new Int32Array(edges);for(let id=0;id<N;id++)targets.set(out[id],offsets[id]);
 return {boxes,order,indegree,offsets,targets};
}
function changes(frame,id,prior,old,visible,oldVisible){
 if(!visible)return {writes:oldVisible?1:0,images:0};if(!oldVisible)return {writes:6,images:1};
 const a=id*8,b=old*8,images=Number(frame[a]!==prior[b]);return {images,writes:images+Number(frame[a+1]!==prior[b+1]||frame[a+2]!==prior[b+2])+Number(frame[a+3]!==prior[b+3]||frame[a+4]!==prior[b+4])+Number(frame[a+5]!==prior[b+5])+Number(frame[a+6]!==prior[b+6])};
}
function measure(frames,orders,meta){let writes=0,images=0,runs=0;const N=meta.dimensions[3],boxes=frames.map(frame=>Array.from({length:N},(_,id)=>bounds(frame,id,meta)));
 for(let f=0;f<frames.length;f++){let kind=0;for(const id of orders[f])if(boxes[f][id]){const next=frames[f][id*8];if(next!==kind){runs++;kind=next;}}}
 for(let f=meta.lines.LOOP.trim()==='true'?0:1;f<frames.length;f++){const prev=(f+frames.length-1)%frames.length;for(let slot=0;slot<N;slot++){const id=orders[f][slot],old=orders[prev][slot],cost=changes(frames[f],id,frames[prev],old,!!boxes[f][id],!!boxes[prev][old]);writes+=cost.writes;images+=cost.images;}}return {writes,images,runs};
}
function schedule(frame,prior,previous,g,meta,imageBias,runBias=0){
 const N=meta.dimensions[3],position=new Int32Array(N),degree=g.indegree.slice(),ready=new Uint8Array(N),bits=Array.from({length:4},()=>new Uint32Array(Math.ceil(N/32))),byPosition=previous,priorVisible=Array.from({length:N},(_,id)=>!!bounds(prior,id,meta));previous.forEach((id,i)=>position[id]=i);
 const indices=Array.from({length:4},()=>new Map());for(let id=0;id<N;id++)if(g.boxes[id])for(const c of [3,5,6]){const a=id*8,key=c+':'+(c===3?frame[a+3]+','+frame[a+4]:frame[a+c]),index=indices[frame[a]];let bucket=index.get(key);if(!bucket){bucket=[];index.set(key,bucket);}bucket.push(id);}
 const add=id=>{ready[id]=1;const p=position[id];bits[frame[id*8]][p>>>5]|=1<<(p&31);};for(let id=0;id<N;id++)if(g.boxes[id]&&degree[id]===0)add(id);
 const nearby=(kind,start,direction)=>{const set=bits[kind];let word=start>>>5;for(;word>=0&&word<set.length;word+=direction){let value=set[word];if(word===(start>>>5))value&=direction>0?(-1<<(start&31)):(-1>>>(31-(start&31)));if(value){const bit=direction>0?31-Math.clz32(value&-value):31-Math.clz32(value);return byPosition[word*32+bit];}}return -1;};
 const result=[],candidates=new Set(),active=g.boxes.reduce((n,b)=>n+!!b,0);
 for(let slot=0;slot<active;slot++){
  candidates.clear();for(let kind=1;kind<=3;kind++){const left=nearby(kind,slot,-1),right=nearby(kind,slot,1);if(left>=0)candidates.add(left);if(right>=0)candidates.add(right);}
  const old=previous[slot],b=old*8,kind=prior[b];if(priorVisible[old])for(const c of [3,5,6]){const key=c+':'+(c===3?prior[b+3]+','+prior[b+4]:prior[b+c]),bucket=indices[kind]?.get(key);if(bucket){let added=0;for(const id of bucket)if(ready[id]){candidates.add(id);if(++added===8)break;}}}
  let best=-1,bestScore=Infinity;for(const id of candidates){const cost=changes(frame,id,prior,old,true,priorVisible[old]),score=cost.writes+cost.images*imageBias+(result.length&&frame[id*8]!==frame[result.at(-1)*8]?runBias:0)+Math.abs(position[id]-slot)*1e-6+(id===old?0:1e-7);if(score<bestScore){best=id;bestScore=score;}}
  if(best<0)throw Error('Invalid draw-order dependency graph');result.push(best);ready[best]=0;const p=position[best];bits[frame[best*8]][p>>>5]&=~(1<<(p&31));
  for(let edge=g.offsets[best];edge<g.offsets[best+1];edge++){const next=g.targets[edge];if(--degree[next]===0)add(next);}
 }
 for(const id of g.order)if(!g.boxes[id])result.push(id);return result;
}
function refine(order,frame,prior,previous,g,meta,imageBias){
 const oldVisible=Array.from({length:order.length},(_,id)=>!!bounds(prior,id,meta));
 const score=(id,slot)=>{const old=previous[slot],cost=changes(frame,id,prior,old,!!g.boxes[id],oldVisible[old]);return cost.writes+cost.images*imageBias;};
 // Bounded k-opt: a swap is legal only if neither moved shape intersects any
 // shape it crosses. Every accepted swap strictly improves this transition.
 for(let pass=0;pass<2;pass++){let improved=false;
  for(let i=0;i<order.length;i++){
   const a=order[i],box=g.boxes[a],old=score(a,i);let best=-1,bestDelta=0;
   for(let j=i+1;j<Math.min(order.length,i+13);j++){
    const b=order[j],other=g.boxes[b];if(box&&other&&overlap(box,other))break;
    const delta=score(b,i)+score(a,j)-old-score(b,j);if(delta>=bestDelta)continue;
    let legal=true;if(other)for(let k=i+1;k<j;k++){const middle=g.boxes[order[k]];if(middle&&overlap(middle,other)){legal=false;break;}}
    if(legal){best=j;bestDelta=delta;}
   }
   if(best>=0){order[i]=order[best];order[best]=a;improved=true;}
  }
  if(!improved)break;
 }
 return order;
}
function plan(frames,meta,{maxCells=500000}={}){
 const N=meta.dimensions[3];
 // Limit optimization work, never fitting counts or exported frames. The exact
 // original ordering is the fallback for very large or densely overlapping jobs.
 if(N*frames.length>maxCells)return {frames,report:{changed:false,reason:'planning-budget'}};
 const original=frames.map(f=>originalOrder(f,N)),before=measure(frames,original,meta),trials=[];let best=original,bestCost=before;
 // The original plan remains an exact fallback. All optimization happens offline.
 for(const materialSeed of [false,true])for(const bias of [0,4]){
  let seed=materialSeed?schedule(frames.at(-1),frames.at(-1),original.at(-1),graph(frames.at(-1),meta),meta,0,100):original.at(-1),lastScore=Infinity;
  for(let pass=0;pass<3;pass++){
   const orders=[];let previous=seed,prior=frames.at(-1);
   for(let f=0;f<frames.length;f++){const g=graph(frames[f],meta),plan=refine(schedule(frames[f],prior,previous,g,meta,bias),frames[f],prior,previous,g,meta,bias);orders.push(plan);previous=plan;prior=frames[f];}
   const cost=measure(frames,orders,meta),score=cost.writes+cost.images*4,bestScore=bestCost.writes+bestCost.images*4;trials.push({materialSeed,bias,pass,...cost});if(cost.writes<=before.writes&&cost.images<=before.images&&cost.runs<=before.runs&&(score<bestScore||(score===bestScore&&cost.runs<bestCost.runs))){best=orders;bestCost=cost;}
   if(score>=lastScore)break;lastScore=score;seed=orders.at(-1);
  }
 }
 const optimized=frames.map((frame,f)=>{const result=frame.slice();best[f].forEach((id,rank)=>result[id*8+7]=rank);return result;});
 return {frames:optimized,report:{before,after:bestCost,changed:best!==original},orders:best,trials};
}
return {plan,bounds,overlap,graph,measure,originalOrder};
})();
if(typeof module!=='undefined')module.exports=AnimationOrder;
