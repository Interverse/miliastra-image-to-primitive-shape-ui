'use strict';
const assert=require('node:assert/strict'),{decode}=require('./animation-payload.cjs');
// Independent quadratic oracle: four rotated corners, not the spatial DAG code.
function verify(source,result){
 const before=decode(source),after=decode(result),meta=before.meta,N=meta.dimensions[3];
 for(const name of ['IMAGE_TEMPLATE_INDEX','PLAYBACK_FPS','ENCODED_FPS','WIDTH,W,H,N','GEOMETRY,ROTATION,COMPACT','LOOP','durations'])assert.equal(after.meta.lines[name],meta.lines[name],'Changed animation setting: '+name);
 assert.equal(after.frames.length,before.frames.length);let overlapPairs=0,disjointPairs=0;
 for(let f=0;f<before.frames.length;f++){
  const a=before.frames[f],b=after.frames[f],boxes=[],ranks=new Set(),g=meta.compact?.5:.1,r=meta.compact?1:.1,W=meta.dimensions[1],H=meta.dimensions[2],pad=Math.max(2,2*W/meta.dimensions[0]);
  for(let id=0;id<N;id++){
   const k=id*8;for(let field=0;field<7;field++)assert.equal(b[k+field],a[k+field],`Primitive changed at ${f}:${id}:${field}`);
   const rank=b[k+7];assert.ok(Number.isSafeInteger(rank)&&rank>=0&&rank<N&&!ranks.has(rank),'Invalid optimized rank');ranks.add(rank);
   if(!a[k]||Math.floor(a[k+6]/16777216)===0||a[k+3]<=0||a[k+4]<=0)continue;
   const angle=a[k+5]*r*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle),w=a[k+3]*g/2,h=a[k+4]*g/2,x=a[k+1]*g,y=a[k+2]*g;
   const corners=[[-w,-h],[-w,h],[w,-h],[w,h]].map(([u,v])=>[x+u*co-v*si,y+u*si+v*co]),xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]),left=Math.min(...xs),right=Math.max(...xs),bottom=Math.min(...ys),top=Math.max(...ys);
   if(right<-W/2-2||left>W/2+2||top<-H/2-2||bottom>H/2+2)continue;
   boxes.push({id,left:Math.max(-W/2,left-pad),right:Math.min(W/2,right+pad),bottom:Math.max(-H/2,bottom-pad),top:Math.min(H/2,top+pad)});
  }
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
   const u=boxes[i],v=boxes[j];if(u.left<=v.right&&v.left<=u.right&&u.bottom<=v.top&&v.bottom<=u.top){overlapPairs++;assert.ok((a[u.id*8+7]-a[v.id*8+7])*(b[u.id*8+7]-b[v.id*8+7])>0,`Overlapping primitives reordered at frame ${f}: ${u.id},${v.id}`);}else disjointPairs++;
  }
 }
 return {frames:before.frames.length,controls:N,overlapPairs,disjointPairs};
}
module.exports={verify};
