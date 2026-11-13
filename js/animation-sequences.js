/* Bounded temporal sequences; static JSON and fitting parameters are unchanged. */
'use strict';
const AnimationSequences=(()=>{
 const FIELDS=8;
 function budget(config,hardware=globalThis.navigator?.hardwareConcurrency||1){return Number.isInteger(config.primeval_threads)&&config.primeval_threads>0?Math.max(1,Math.min(config.primeval_threads,hardware)):Math.max(1,Math.min(16,hardware));}
 function plan(config,width,height,frames,hardware=globalThis.navigator?.hardwareConcurrency||1,memory=globalThis.navigator?.deviceMemory||4,preferred=8){
  const cpu=budget(config,hardware),count=Number(config.num_primitives??2000),detail=Number(config.primeval_resolution??512);
  if(!Number.isSafeInteger(count)||count<1)throw Error('Invalid shape count');
  if(!Number.isInteger(detail)||detail<32||detail>2048)throw Error('Invalid fitting detail');
  const side=Math.min(detail,Math.max(width,height)),pixels=side*side*Math.min(width,height)/Math.max(width,height),estimated=384*1024*1024+pixels*128+count*1024,allowance=Math.min(4096,memory*256)*1024*1024;
  const limit=config.animation_parallel===false||cpu<4||count<500||side<128||frames<3?1:Math.max(1,Math.min(preferred,Math.floor(cpu/2),Math.floor(allowance/estimated),Math.max(Math.floor((frames-8)/2),Math.min(7,frames-1))));
  const workers=2**Math.floor(Math.log2(limit));
  return {workers,budget:cpu,threads:Math.max(1,Math.floor(cpu/workers)),prefix:workers>1?Math.min(8,frames):0,latencyThreads:Math.min(4,cpu)};
 }
 function split(items,workers){const n=Math.min(workers,items.length);if(!n)return [];const edges=Array.from({length:n+1},(_,i)=>Math.floor(i*items.length/n)),pinned=new Set();for(let cut=1;cut<items.length;cut++)if(items[cut]?.cut){let best=-1,distance=Infinity;for(let i=1;i<n;i++)if(!pinned.has(i)&&edges[i-1]<cut&&cut<edges[i+1]&&Math.abs(edges[i]-cut)<distance){best=i;distance=Math.abs(edges[i]-cut);}if(best>=0){edges[best]=cut;pinned.add(best);}}return Array.from({length:n},(_,i)=>items.slice(edges[i],edges[i+1]));}
 function timing(rows,endTime){return rows.map((row,i)=>{if(i===rows.length-1)return Math.max(.001,endTime-row.timestamp);const delta=rows[i+1].timestamp-row.timestamp;return delta>0?delta:row.duration;});}
 // Remap sequence-local control IDs once. Every later frame keeps that mapping.
 function stitch(frames,previous,width,height,unit=1,core=globalThis.AnimationCore){
  if(!frames.length)return [];
  if(!previous)return frames;
  const slots=frames.reduce((n,frame)=>Math.max(n,frame.length/FIELDS),previous.length/FIELDS),first=frames[0],elements=core.elements({width,height,frames:[first]},0,unit),matched=core.packFrame(elements,previous,width,height,unit),byOrder=new Map(),mapping=new Map(),used=new Set();
  for(let at=0;at<matched.length;at+=FIELDS)if(matched[at])byOrder.set(matched[at+7],at/FIELDS);
  for(let at=0;at<first.length;at+=FIELDS)if(first[at]){const id=byOrder.get(first[at+7]);mapping.set(at/FIELDS,id);used.add(id);}
  let next=0;for(let id=0;id<slots;id++)if(!mapping.has(id)){while(used.has(next))next++;mapping.set(id,next);used.add(next++);}
  return frames.map(frame=>{const out=new Float64Array(slots*FIELDS);for(let at=0;at<frame.length;at+=FIELDS)out.set(frame.subarray(at,at+FIELDS),mapping.get(at/FIELDS)*FIELDS);return out;});
 }

 async function prepare(file,config){
  const fps=Number(config.animation_fps??0);if(!Number.isSafeInteger(fps)||fps<0)throw Error('animation.fpsInvalid');
  const rows=[];let total=0,origin=null,endTime=0,width=0,height=0,preserve=false,cachedBytes=0,canvas=null,thumbCanvas=null,previousThumb=null;
  function accept(timestamp,duration,w,h,draw){if(width&&(width!==w||height!==h))throw Error('animation.codec');const source=total++;origin??=timestamp;timestamp-=origin;duration=Number.isFinite(duration)&&duration>0?duration:1/30;endTime=Math.max(endTime,timestamp+duration);width=w;height=h;const tick=fps&&!preserve?Math.max(0,Math.ceil((timestamp-1e-7)*fps))/fps:timestamp;if(fps&&!preserve&&tick>=timestamp+duration-1e-7)return;const row={index:rows.length,source,timestamp:tick,duration};if(rows.length<8&&cachedBytes+w*h*4<=64*1024*1024){if(!canvas||canvas.width!==w||canvas.height!==h)canvas=new OffscreenCanvas(w,h);const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.clearRect(0,0,w,h);draw(ctx,w,h);row.rgba=ctx.getImageData(0,0,w,h).data;cachedBytes+=row.rgba.byteLength;}const sw=Math.max(1,Math.round(w*Math.min(1,64/Math.max(w,h)))),sh=Math.max(1,Math.round(h*Math.min(1,64/Math.max(w,h))));if(!thumbCanvas||thumbCanvas.width!==sw||thumbCanvas.height!==sh)thumbCanvas=new OffscreenCanvas(sw,sh);const tiny=thumbCanvas.getContext('2d',{willReadFrequently:true});tiny.clearRect(0,0,sw,sh);draw(tiny,sw,sh);const thumb=tiny.getImageData(0,0,sw,sh).data;row.cut=!!previousThumb&&AnimationMotion.sceneChange(previousThumb,thumb,sw,sh).cut;previousThumb=thumb;rows.push(row);}
  if(file.type==='image/gif'||/\.gif$/i.test(file.name)){
   if(typeof ImageDecoder==='undefined'||!await ImageDecoder.isTypeSupported('image/gif'))throw Error('animation.codec');
   const bytes=await file.arrayBuffer(),timing=AnimationMedia.gifTiming(bytes),decoder=new ImageDecoder({data:bytes,type:'image/gif',preferAnimation:true});
   try{await decoder.tracks.ready;await decoder.completed;const count=decoder.tracks.selectedTrack.frameCount;preserve=!!timing&&timing.frames===count&&timing.frames<=fps*timing.duration+1e-6;
    for(let i=0;i<count;i++){const {image}=await decoder.decode({frameIndex:i});try{accept(image.timestamp/1e6,Math.max(.01,(image.duration||0)/1e6),image.displayWidth,image.displayHeight,(ctx,w,h)=>ctx.drawImage(image,0,0,w,h));}finally{image.close();}}
   }finally{decoder.close();}
  }else{
   if(typeof VideoDecoder==='undefined')throw Error('animation.codec');
   const M=await import('./vendor/mediabunny/mediabunny.min.js'),input=new M.Input({source:new M.BlobSource(file),formats:[M.MP4,M.QTFF,M.WEBM,M.MATROSKA,M.OGG,M.MPEG_TS]});
   try{const track=await input.getPrimaryVideoTrack();if(!track||!await track.canDecode())throw Error('animation.codec');const sink=new M.VideoSampleSink(track);for await(const sample of sink.samples())try{accept(sample.timestamp,sample.duration,sample.displayWidth,sample.displayHeight,(ctx,w,h)=>sample.draw(ctx,0,0,w,h));}finally{sample.close();}}finally{input.dispose();}
  }
  if(!rows.length)throw Error('animation.codec');return {rows,total,origin,endTime,width,height};
 }
 async function run(msg,prepared,options,started,send=(data,transfer)=>self.postMessage(data,transfer)){
  const states=[],handles=[],segments=[];let bytes=0,largest=0,firstEightMs=null;
  const elapsed=()=>performance.now()-started;
  function metrics(){const out={frameWorkers:options.workers,threadsPerFrame:options.threads,prefixThreads:options.latencyThreads,sourceFrames:prepared.total,skippedFrames:prepared.total-prepared.rows.length,selectedFrames:prepared.rows.length,firstEightMs};for(const state of states)for(const [key,value] of Object.entries(state.metrics||{})){if(typeof value==='number'&&!['sourceFrames','skippedFrames','selectedFrames'].includes(key))out[key]=(out[key]||0)+value;}return out;}
  async function sequence(rows,threads,seed=null,requestSeed=false){
   const state={progress:0,metrics:null,firstSource:rows[0].source,lastSource:rows.at(-1).source};states.push(state);const worker=new Worker('worker-animation.js?v=pixel-perfect-3');handles.push(worker);
   const result=await new Promise((resolve,reject)=>{
    worker.onerror=event=>reject(Error(event.message||'Frame sequence failed'));
    worker.onmessage=({data})=>{
     if(data.type==='error'){reject(Error(data.message?.startsWith('animation.')?data.message:data.detail||data.message));return;}
     if(data.type==='progress'){
      if(data.metrics)state.metrics=data.metrics;
      state.progress=Math.max(state.progress,Math.min(rows.length,Number(data.step)||0));
      send({type:'progress',step:states.reduce((n,s)=>n+s.progress,0),total:prepared.rows.length,phase:'animation',metrics:metrics()});return;
     }
     if(data.type.startsWith('animation-frame')){
      if(!msg.livePreview)return;const row=rows[(data.type==='animation-frame'?data.index:data.sourceFrame-1)];if(!row)return;
      send({...data,sourceFrame:row.source+1,totalSource:prepared.total,...(data.type==='animation-frame'?{index:row.index}:{})},data.type==='animation-frame'?[data.frame.buffer]:[]);return;
     }
     if(data.type==='done'){
      worker.terminate();state.progress=rows.length;state.metrics=data.result.animation.metrics;
      if(data.result.animation.frames.length!==rows.length){reject(Error('Frame sequence count changed'));return;}
      for(const frame of data.result.animation.frames)bytes+=frame.byteLength;largest=Math.max(largest,data.result.animation.controls);if(bytes>AnimationCore.MEMORY||prepared.rows.length*largest*FIELDS*8>AnimationCore.MEMORY){reject(Error('animation.limit'));return;}
      segments.push({rows,...data,keepIds:!!seed});send({type:'progress',step:states.reduce((n,s)=>n+s.progress,0),total:prepared.rows.length,phase:'animation',metrics:metrics()});resolve(data);return;
     }
     send(data);
    };
    worker.postMessage({...msg,seed,requestSeed,repairWarm:true,sequence:{indices:rows.map(row=>row.source),origin:prepared.origin},config:{...msg.config,primeval_threads:threads}});
   });return result;
  }
  try{
   // Keep the initial preview responsive before sharing cores with later fits.
   if(options.prefix){
    const prefix=prepared.rows.slice(0,options.prefix),warm=plan(msg.config,prepared.width,prepared.height,prepared.rows.length,navigator.hardwareConcurrency||1,navigator.deviceMemory||4,8);
    if(prefix.every(row=>row.rgba)){
     const first=await sequence(prefix.slice(0,1),options.latencyThreads,null,true),base=first.seed,tasks=[];let drawing=base.previousDrawing,map=base.automaticMap,previous=prefix[0].rgba,cut=false;
     for(const row of prefix.slice(1)){cut||=AnimationMotion.sceneChange(previous,row.rgba,prepared.width,prepared.height).cut;const flow=AnimationMotion.estimate(previous,row.rgba,prepared.width,prepared.height);drawing=AnimationMotion.predict(drawing,flow);map=AnimationMotion.warpImportance(map,flow);tasks.push({row,seed:{...base,previousDrawing:drawing,automaticMap:map,predicted:true}});previous=row.rgba;}
     if(cut)await sequence(prefix.slice(1),options.latencyThreads,base);
     else{let next=0;await Promise.all(Array.from({length:Math.min(warm.workers,tasks.length)},async()=>{while(next<tasks.length){const task=tasks[next++];await sequence([task.row],warm.threads,task.seed);}}));}
    }else await sequence(prefix,options.latencyThreads);
    firstEightMs=prepared.rows.length>=8?elapsed():null;send({type:'progress',step:options.prefix,total:prepared.rows.length,phase:'animation',metrics:metrics()});
   }
   const remaining=prepared.rows.slice(options.prefix);await Promise.all(split(remaining,options.workers).map(rows=>sequence(rows,options.threads)));
   segments.sort((a,b)=>a.rows[0].index-b.rows[0].index);const first=segments[0],animation={...first.result.animation,frames:[],durations:[],controls:0,hasTransparency:false};
   let previous=null;for(const segment of segments){const child=segment.result.animation;if(child.width!==animation.width||child.height!==animation.height||child.unit!==animation.unit)throw Error('Primeval sequence dimensions changed');const frames=segment.keepIds?child.frames:stitch(child.frames,previous,animation.width,animation.height,animation.unit,AnimationCore);for(const frame of frames){animation.frames.push(frame);animation.controls=Math.max(animation.controls,frame.length/FIELDS);previous=frame;}animation.hasTransparency||=child.hasTransparency;}
   animation.durations=timing(prepared.rows,prepared.endTime);animation.metrics={...metrics(),sequenceQuality:states.map(state=>({firstSource:state.firstSource,lastSource:state.lastSource,fullFitMs:state.metrics?.fullFitMs,refitMs:state.metrics?.refitMs,keyframes:state.metrics?.keyframes,refined:state.metrics?.refined,detail:state.metrics?.lastDetail,referenceDetail:state.metrics?.referenceDetail,lastAttempt:state.metrics?.lastAttempt}))};
   const result={...first.result,elapsed_seconds:Math.round(elapsed()/10)/100,config:{...first.result.config,primeval_threads:msg.config.primeval_threads,output_has_transparency:animation.hasTransparency},animation};
   send({type:'done',result,poster:first.poster},[first.poster,...new Set(animation.frames.map(frame=>frame.buffer))]);
  }finally{for(const worker of handles)worker.terminate();}
 }
 return {budget,plan,split,stitch,timing,prepare,run};
})();
if(typeof module!=='undefined')module.exports=AnimationSequences;
