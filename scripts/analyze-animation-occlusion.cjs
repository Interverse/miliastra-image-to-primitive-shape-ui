'use strict';
const fs=require('node:fs'),{decode}=require('./animation-payload.cjs');
function clip(poly,axis,value,sign){const out=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=(a[axis]-value)*sign,db=(b[axis]-value)*sign;if(da>=0)out.push(a);if((da<0)!==(db<0)){const t=da/(da-db);out.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}}return out;}
function analyze(source){
 const {meta,frames}=decode(source),[width,W,H,N]=meta.dimensions,g=width/W*(meta.compact?.5:.1),rotation=meta.compact?1:.1,height=width*H/W;
 let visible=0,opaqueRects=0,occluded=0,disjointQuads=0;const perFrame=[];
 for(const frame of frames){const shapes=[];
  for(let id=0;id<N;id++){const a=id*8,kind=frame[a],alpha=Math.floor(frame[a+6]/16777216);if(!kind||!alpha||frame[a+3]<=0||frame[a+4]<=0)continue;
   const angle=frame[a+5]*rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),x=frame[a+1]*g,y=frame[a+2]*g,w=frame[a+3]*g/2,h=frame[a+4]*g/2,pad=2;
   let corners=[[-w-pad,-h-pad],[w+pad,-h-pad],[w+pad,h+pad],[-w-pad,h+pad]].map(([u,v])=>[x+u*c-v*s,y+u*s+v*c]);
   if(Math.max(...corners.map(p=>p[0]))<-width/2||Math.min(...corners.map(p=>p[0]))>width/2||Math.max(...corners.map(p=>p[1]))<-height/2||Math.min(...corners.map(p=>p[1]))>height/2)continue;
   for(const [axis,value,sign]of [[0,-width/2,1],[0,width/2,-1],[1,-height/2,1],[1,height/2,-1]]){corners=clip(corners,axis,value,sign);if(!corners.length)break;}
   if(!corners.length){disjointQuads++;continue;}visible++;shapes.push({id,rank:frame[a+7],kind,alpha,x,y,w,h,c,s,corners});
  }
  const opaque=[];let hidden=0;shapes.sort((a,b)=>b.rank-a.rank);
  for(const shape of shapes){const covered=opaque.some(o=>shape.corners.every(([x,y])=>{const dx=x-o.x,dy=y-o.y;return Math.abs(dx*o.c+dy*o.s)<o.w-o.inset&&Math.abs(-dx*o.s+dy*o.c)<o.h-o.inset;}));if(covered){hidden++;occluded++;}
   if(shape.kind===2&&shape.alpha===255){const inset=Math.max(2,.05*Math.min(shape.w,shape.h));if(shape.w>inset&&shape.h>inset){opaque.push({...shape,inset});opaqueRects++;}}
  }perFrame.push(hidden);
 }return {frames:frames.length,N,visible,opaqueRects,occluded,disjointQuads,hiddenFraction:occluded/Math.max(1,visible),perFrame};
}
if(require.main===module)for(const file of process.argv.slice(2))console.log(JSON.stringify({file,...analyze(fs.readFileSync(file,'utf8'))}));
module.exports={analyze};
