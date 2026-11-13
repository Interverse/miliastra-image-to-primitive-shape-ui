/* Primeval and Splat animation states. Static JSON/export schemas are untouched.
 * Shape kinds: 1 ellipse, 2 rectangle, 3 triangle, 4 Splat (image 106057; animation
 * Splat fits keep scale at 1, so a frame needs no extra fields). */
"use strict";
const AnimationCore=(()=>{
 // Retained fitted states, not decoded video pixels. Allow long clips on capable
 // devices; retain an explicit resource limit instead of removing source frames.
 const MEMORY=Math.min(1024,Math.max(256,(globalThis.navigator?.deviceMemory||4)*128))*1024*1024,FIELDS=8;
 const types=['','ellipse','rectangle','triangle','splat'];
 function packFrame(elements,previous,width,height,unit=1,inherit=false){
  const records=elements.map((e,order)=>[types.indexOf(e.type),Math.round((e.center.x/unit-width/2)*10),Math.round((e.center.y/unit+height/2)*10),Math.round((e.type==='ellipse'?e.size.rx*2:e.size.width)/unit*10),Math.round((e.type==='ellipse'?e.size.ry*2:e.size.height)/unit*10),Math.round((e.rotation?.z||0)*10),e.packed_color>>>0,order]);
  if(records.some(r=>r[0]<1))throw Error('Unsupported animation shape');
  const slots=Math.max(records.length,(previous?.length||0)/FIELDS),out=new Float64Array(slots*FIELDS),used=new Set(),buckets=new Map();
  if(inherit&&previous){const ids=Array.from({length:previous.length/8},(_,i)=>i).filter(i=>previous[i*8]).sort((a,b)=>previous[a*8+7]-previous[b*8+7]);const mapped=Array.isArray(inherit)?inherit:records.map((_,i)=>i);if(mapped.length===records.length&&new Set(mapped).size===records.length&&mapped.every(i=>Number.isInteger(i)&&i>=0&&i<ids.length)){records.forEach((r,i)=>out.set(r,ids[mapped[i]]*8));return out;}}

  const cell=r=>[Math.floor((r[1]/10+width/2)/width*32),Math.floor((r[2]/10+height/2)/height*32)];
  if(previous)for(let id=0;id<slots;id++){const r=previous.subarray(id*FIELDS,(id+1)*FIELDS);if(!r[0])continue;const [x,y]=cell(r),key=`${r[0]}:${x}:${y}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);}
  let next=0;
  // Match large shapes first; layer order is stored separately and preserved.
  for(const r of records.slice().sort((a,b)=>b[3]*b[4]-a[3]*a[4])){
   let best=-1,cost=Infinity;const [x,y]=cell(r);
   for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    const ids=buckets.get(`${r[0]}:${x+dx}:${y+dy}`)||[];let examined=0;
    for(let j=ids.length-1;j>=0&&examined<32;j--){const id=ids[j];if(used.has(id))continue;examined++;const at=id*FIELDS;
     const score=(r[1]-previous[at+1])**2+(r[2]-previous[at+2])**2+((r[3]-previous[at+3])**2+(r[4]-previous[at+4])**2)/4;
     if(score<cost){cost=score;best=id;}
    }
   }
   if(best<0){while(used.has(next))next++;best=next++;}
   used.add(best);out.set(r,best*FIELDS);
  }
  return out;
 }
 function elements(animation,index,unit=1){const frame=animation.frames[index],out=[];
  for(let at=0;at<frame.length;at+=FIELDS){const kind=frame[at];if(!kind)continue;const type=types[kind],x=(frame[at+1]/10+animation.width/2)*unit,y=(frame[at+2]/10-animation.height/2)*unit,w=frame[at+3]/10*unit,h=frame[at+4]/10*unit,p=frame[at+6];
   out.push({id:at/FIELDS,type,shape:type==='rectangle'?'rect':type==='ellipse'?'circle':type==='splat'?'splat':'triangle',center:{x,y},relative:{x:x-animation.width*unit/2,y:y+animation.height*unit/2},size:type==='ellipse'?{rx:w/2,ry:h/2}:{width:w,height:h},rotation:{x:0,y:0,z:frame[at+5]/10},color:'#'+(p%16777216).toString(16).padStart(6,'0'),alpha:Math.floor(p/16777216)/255,packed_color:p,image_asset_ref:[0,100002,100001,100003,106057][kind],...(type==='splat'?{primitive_type:'splat',image_type:'Stretch',scale:{x:1,y:1}}:{}),...(type==='triangle'?{triangle_pivot:'box'}:{}),order:frame[at+7]});
  }
  return out.sort((a,b)=>a.order-b.order);
 }
 return {MEMORY,FIELDS,packFrame,elements};
})();
if(typeof module!=='undefined')module.exports=AnimationCore;
