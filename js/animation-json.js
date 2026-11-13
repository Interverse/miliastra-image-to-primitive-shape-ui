/* Optional video data; ordinary image/frame JSON keeps its existing schema. */
'use strict';
const AnimationJson=(()=>{
 const core=()=>typeof AnimationCore!=='undefined'?AnimationCore:require('./animation-core.js');
 const invalid=()=>{throw Error('import.invalid');};
 function restore(data){
  if(!data||data.version!==1||data.kind!=='primeval')throw Error('import.unsupported');
  const {width,height,controls,unit,fps,loop,durations,frames}=data;
  if(![width,height,controls].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isFinite(unit)||unit<=0||!Number.isSafeInteger(fps)||fps<0||typeof loop!=='boolean'||!Array.isArray(frames)||!frames.length||!Array.isArray(durations)||durations.length!==frames.length||durations.some(n=>!Number.isFinite(n)||n<=0))invalid();
  if(frames.length*controls*8*8>core().MEMORY)throw Error('animation.limit');
  const decoded=frames.map(frame=>{
   if(!Array.isArray(frame)||frame.length%8||frame.length>controls*8||!frame.every(Number.isSafeInteger))invalid();
   const ranks=new Set();for(let at=0;at<frame.length;at+=8){const kind=frame[at],rank=frame[at+7];if(kind<0||kind>4||frame[at+3]<0||frame[at+4]<0||frame[at+6]<0||frame[at+6]>4294967295)invalid();if(kind){if(rank<0||rank>=controls||ranks.has(rank))invalid();ranks.add(rank);}}
   return new Float64Array(frame);
  });
  return {kind:'primeval',width,height,controls,unit,fps,loop,durations:durations.slice(),frames:decoded};
 }
 async function blob(animation,poster,unit,{signal,onProgress}={}){
  const metadata={version:1,kind:'primeval',width:animation.width,height:animation.height,controls:animation.controls,unit,fps:animation.fps||0,loop:animation.loop!==false,durations:animation.durations};
  const parts=[JSON.stringify(poster,null,2).slice(0,-1)+',"animation":'+JSON.stringify(metadata).slice(0,-1)+',"frames":['];
  for(let i=0;i<animation.frames.length;i++){
   signal?.throwIfAborted();if(i)parts.push(',');parts.push(JSON.stringify(Array.from(animation.frames[i])));onProgress?.(i+1);
   if(i%8===7)await new Promise(resolve=>setTimeout(resolve,0));
  }
  signal?.throwIfAborted();parts.push(']}}');return new Blob(parts,{type:'application/json'});
 }
 return {restore,blob};
})();
if(typeof module!=='undefined')module.exports=AnimationJson;
