"use strict";
importScripts('animation-sequences.js?v=3','animation-motion.js?v=5','animation-fit-pool.js?v=3','animation-media.js?v=1','animation-progress.js?v=1','animation-core.js?v=6','worker-primeval.js?v=animation-detail-2','focus.js?v=2');
self.onmessage=async({data:msg})=>{
 if(!['process','preview'].includes(msg.cmd))return;
 const started=performance.now();let fitPool=null;
 try{
  const {file}=msg;let config=msg.config;const preview=msg.cmd==='preview',fps=Number(config.animation_fps??0);
  if(!Number.isSafeInteger(fps)||fps<0)throw Error('animation.fpsInvalid');
  if(!preview&&!msg.sequence&&config.animation_temporal!==false&&config.primeval_turbo===true){
   const cpu=AnimationSequences.budget(config);
   if(config.animation_parallel!==false&&cpu>=4&&Number(config.num_primitives??2000)>=500&&Number(config.primeval_resolution??512)>=128){
    const prepared=await AnimationSequences.prepare(file,config),options=AnimationSequences.plan(config,prepared.width,prepared.height,prepared.rows.length,navigator.hardwareConcurrency||1,navigator.deviceMemory||4,[1,2,4,8].includes(msg.sequenceWorkers)?msg.sequenceWorkers:8);
    if(options.workers>1){await AnimationSequences.run(msg,prepared,options,started);return;}
   }
   config={...config,primeval_threads:Math.min(4,cpu)};
  }
  const sequence=msg.sequence?new Set(msg.sequence.indices):null,sequenceLast=msg.sequence?.indices.at(-1);

  let sourceFrames=0,skippedFrames=0,origin=null,endTime=0,previewFrames=0,previewBytes=0,preserveTiming=false;
  let canvas,ctx,animation,first,previousPixels,expected=0,frameConfig,previousDrawing,keyFrame=-96,automaticMap=null,referenceError=null,referenceFocusError=null,referenceComplexity=null,referenceFocusComplexity=null,lastFocusFrame=-8,referenceDetail=null,qualityCanvas=null,seedLoaded=false,seedConsumed=false;const pending=[];let completedSource=0;
  const live=msg.livePreview===true;
  const temporal=config.animation_temporal!==false,metrics={keyframes:0,refined:0,repeated:0,focusAnalyses:0,fullFitMs:0,refitMs:0,motionMs:0,trackedFrames:0,replacements:0,detailFallbacks:0,preflightFallbacks:0};
  function frameStart(sourceIndex){if(live)self.postMessage({type:'animation-frame-start',sourceFrame:sourceIndex,totalSource:expected,shapeCount:Number(config.num_primitives)||2000});}
  function frameReady(frame,sourceIndex,timestamp,duration){if(!live)return;const copy=frame.slice();self.postMessage({type:'animation-frame',index:animation.frames.length-1-(seedLoaded?1:0),sourceFrame:sourceIndex,totalSource:expected,width:animation.width,height:animation.height,unit:animation.unit,timestamp,duration,frame:copy},[copy.buffer]);}
  function detail(rgba,w,h,result,drawing=false,importance=null){
   const outWidth=drawing?animation.width:result.image_size.width,outHeight=drawing?animation.height:result.image_size.height,scale=Math.min(1,384/Math.max(outWidth,outHeight)),qw=Math.max(1,Math.round(outWidth*scale)),qh=Math.max(1,Math.round(outHeight*scale));if(!qualityCanvas||qualityCanvas.width!==qw||qualityCanvas.height!==qh)qualityCanvas=new OffscreenCanvas(qw,qh);const context=qualityCanvas.getContext('2d',{willReadFrequently:true});context.clearRect(0,0,qualityCanvas.width,qualityCanvas.height);
   const elements=drawing?PrimevalResult.drawingToElements(result,animation.width,animation.height,config).elements:result.elements;
   PrimevalResult.drawElements(context,elements,animation.unit/scale);
   return AnimationMotion.detailQuality(rgba,w,h,context.getImageData(0,0,qualityCanvas.width,qualityCanvas.height).data,qualityCanvas.width,qualityCanvas.height,importance);
  }
  async function drain(){
   const task=pending.shift(),out=await task.promise;if(!out.ok)throw out.error;const result=out.result;
   if(!first){first=result;animation.width=result.image_size.width;animation.height=result.image_size.height;}
   if(result.image_size.width!==animation.width||result.image_size.height!==animation.height)throw Error('Primeval frame dimensions changed');
   const frame=task.repeated?animation.frames.at(-1):AnimationCore.packFrame(result.elements,animation.frames.at(-1),animation.width,animation.height,animation.unit,false);
   if((animation.frames.length+1-(seedLoaded?1:0))*Math.max(frame.length,animation.controls*8)*8>AnimationCore.MEMORY)throw Error('animation.limit');
   animation.controls=Math.max(animation.controls,frame.length/8);animation.frames.push(frame);animation.timestamps.push(task.timestamp);animation.durations.push(task.duration);animation.hasTransparency||=result.config.output_has_transparency;frameConfig=result.config;
   if(task.repeated)metrics.repeated++;else{metrics.keyframes++;metrics.fullFitMs+=out.ms;}
   frameReady(frame,task.sourceIndex,task.timestamp,task.duration);completedSource=task.sourceIndex;self.postMessage({type:'progress',step:task.sourceIndex,total:expected,phase:'animation',metrics:{...metrics}});
  }
  let lastIndependent=null;
  async function independent(rgba,width,height,timestamp,duration,transparent,identical){
   if(!fitPool){const plan=AnimationFitPool.plan(config,width,height);fitPool=new AnimationFitPool.Pool(plan);metrics.frameWorkers=plan.workers;metrics.threadsPerFrame=plan.threads;}
   const sourceIndex=sourceFrames;frameStart(sourceIndex);
   let promise=identical?lastIndependent:null;
   if(!promise){let importance=null;const focus=config.focus;if(config.primeval_turbo&&focus?.enabled){let automatic=null;if(focus.automatic){metrics.focusAnalyses++;try{automatic=await Focus.analyze({},rgba,width,height,{cancelled:false});}catch(error){self.postMessage({type:'focus-warning',detail:String(error)});}}importance=Focus.combine(automatic,focus.areas||[],width,height);}
    const poster=pending.length===0&&animation.frames.length===0;
    promise=fitPool.run({rgba:rgba.slice().buffer,width,height,importance,poster,livePreview:live,sourceFrame:sourceIndex,totalSource:expected,config:{...config,fit_method:'primeval',enable_png_mode:config.enable_png_mode||transparent}},data=>{if(data.type==='animation-frame-progress')self.postMessage(data);else self.postMessage({type:'progress',step:completedSource,total:expected,phase:data.phase||'animation'});}).then(result=>({ok:true,result,ms:result.animation_fit_ms}),error=>({ok:false,error}));lastIndependent=promise;
   }
   pending.push({promise,repeated:identical,timestamp,duration,sourceIndex:sourceFrames});previousPixels=rgba;
   if(pending.length>=fitPool.options.workers*2)await drain();
  }
  async function accept(draw,width,height,timestamp,duration){
   duration=Number.isFinite(duration)&&duration>0?duration:1/30;
   sourceFrames++;origin??=msg.sequence?.origin??timestamp;timestamp-=origin;endTime=Math.max(endTime,timestamp+duration);
   const tick=fps&&!preserveTiming?Math.max(0,Math.ceil((timestamp-1e-7)*fps))/fps:timestamp;
   if(fps&&!preserveTiming&&tick>=timestamp+duration-1e-7){skippedFrames++;self.postMessage({type:'progress',step:!temporal&&!preview?completedSource:sourceFrames,total:expected,phase:'animation'});return;}
   timestamp=tick;
   if(preview){
    const scale=Math.min(1,320/Math.max(width,height)),w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
    previewBytes+=w*h*4;if(previewBytes>64*1024*1024)throw Error('animation.previewLimit');
    const surface=new OffscreenCanvas(w,h),context=surface.getContext('2d');draw(context,w,h);
    const bitmap=surface.transferToImageBitmap();previewFrames++;self.postMessage({type:'previewFrame',bitmap,timestamp,duration},[bitmap]);return;
   }
   width=Math.round(width);height=Math.round(height);
   if(!animation){
    if(width*height*4>AnimationCore.MEMORY)throw Error('animation.limit');
    canvas=new OffscreenCanvas(width,height);ctx=canvas.getContext('2d',{willReadFrequently:true});
    animation={kind:'primeval',width,height,frames:[],durations:[],timestamps:[],loop:config.animation_loop!==false,fps,controls:0,unit:Number(config.image_scale)||1};
   }
   if(width!==canvas.width||height!==canvas.height)throw Error('animation.codec');
   ctx.clearRect(0,0,width,height);draw(ctx,width,height);
   const rgba=ctx.getImageData(0,0,width,height).data;
   if(msg.seed&&!seedLoaded){const s=msg.seed;seedLoaded=true;previousDrawing=s.previousDrawing;previousPixels=new Uint8ClampedArray(s.previousPixels);automaticMap=s.automaticMap;referenceError=s.referenceError;referenceFocusError=s.referenceFocusError;referenceComplexity=s.referenceComplexity;referenceFocusComplexity=s.referenceFocusComplexity;referenceDetail=s.referenceDetail;lastFocusFrame=0;keyFrame=0;frameConfig=s.config;animation.width=s.width;animation.height=s.height;animation.frames.push(s.frame);animation.timestamps.push(0);animation.durations.push(1/30);animation.controls=s.frame.length/8;first={primeval_png:s.poster,image_center:s.image_center};}
   const seededPrediction=!!msg.seed?.predicted&&!seedConsumed,allowWarmRepair=seededPrediction||msg.repairWarm===true;

   let transparent=false;for(let i=3;i<rgba.length;i+=4)if(rgba[i]<255){transparent=true;break;}
   let identical=!!previousPixels&&!seededPrediction;if(identical){const a=new Uint32Array(rgba.buffer,rgba.byteOffset,rgba.byteLength/4),b=new Uint32Array(previousPixels.buffer,previousPixels.byteOffset,previousPixels.byteLength/4);for(let i=0;i<a.length;i++)if(a[i]!==b[i]){identical=false;break;}}
   if(!temporal){await independent(rgba,width,height,timestamp,duration,transparent,identical);return;}
   frameStart(sourceFrames);const stream=live?new AnimationProgress.Stream(data=>self.postMessage(data),{sourceFrame:sourceFrames,totalSource:expected,shapeCount:Number(config.num_primitives)||2000}):null;
   let frame;
   if(identical)frame=animation.frames.at(-1),metrics.repeated++;
   else{
    const cut=previousPixels&&!seededPrediction?AnimationMotion.sceneChange(previousPixels,rgba,width,height):null;
    const sceneChange=!!cut?.cut;if(sceneChange)metrics.sceneCuts=(metrics.sceneCuts||0)+1;
    let refine=temporal&&previousDrawing&&!sceneChange&&animation.frames.length-keyFrame<96;
    let importance=null,motion=null,predictedDrawing=previousDrawing;
    if(refine&&!seededPrediction){const motionStarted=performance.now();motion=AnimationMotion.estimate(previousPixels,rgba,width,height);predictedDrawing=AnimationMotion.predict(previousDrawing,motion);automaticMap=AnimationMotion.warpImportance(automaticMap,motion);metrics.motionMs+=performance.now()-motionStarted;if(motion.tracked)metrics.trackedFrames++;}
    const focus=config.focus;
    if(config.primeval_turbo&&focus?.enabled){
     let automatic=null;
     if(focus.automatic){if(!refine||animation.frames.length-lastFocusFrame>=8){lastFocusFrame=animation.frames.length;metrics.focusAnalyses++;try{automaticMap=await Focus.analyze({},rgba,width,height,{cancelled:false});}catch(error){automaticMap=null;self.postMessage({type:'focus-warning',detail:String(error)});}}automatic=automaticMap;}
     importance=Focus.combine(automatic,focus.areas||[],width,height);
    }
    if(refine&&referenceDetail){const warped=detail(rgba,width,height,predictedDrawing,true,importance),plain=detail(rgba,width,height,previousDrawing,true,importance);if(plain.edge+plain.focusEdge<warped.edge+warped.focusEdge){predictedDrawing=previousDrawing;metrics.unwarpedStarts=(metrics.unwarpedStarts||0)+1;}}
    if(refine&&!allowWarmRepair&&referenceDetail&&!AnimationMotion.detailAccepts(referenceDetail,detail(rgba,width,height,predictedDrawing,true,importance),true)){refine=false;metrics.preflightFallbacks++;if(focus?.automatic&&config.primeval_turbo&&focus.enabled){metrics.focusAnalyses++;lastFocusFrame=animation.frames.length;try{automaticMap=await Focus.analyze({},rgba,width,height,{cancelled:false});}catch(error){automaticMap=null;}importance=Focus.combine(automaticMap,focus.areas||[],width,height);}}
    if(refine&&stream){const converted=PrimevalResult.drawingToElements(predictedDrawing,animation.width,animation.height,config);stream.push({step:config.num_primitives,total:config.num_primitives,phase:'refine',directSvg:true,previewSvg:PrimevalResult.elementsToSvg(converted.elements,animation.width,animation.height,config)});stream.flush();}
    let failure;
    const fitStarted=performance.now();
    const content=refine?AnimationMotion.quality(rgba,width,height,rgba,width,height,importance):null;
    const ratio=content&&referenceComplexity?Math.max(1,Math.min(1.15,content.complexity/referenceComplexity)):1;
    const focusRatio=content&&referenceFocusComplexity?Math.max(1,Math.min(1.15,content.focusComplexity/referenceFocusComplexity)):1;
    const expectedError=referenceError===null?1:referenceError*ratio,expectedFocusError=referenceFocusError===null?1:referenceFocusError*focusRatio;
    const errorTarget=referenceError===null?1:Math.max(expectedError*1.08,expectedError+.004);
    const focusTarget=referenceFocusError===null?1:Math.max(expectedFocusError*1.08,expectedFocusError+.004);
    let result=await processPrimeval({temporalFocusTarget:focusTarget+.0005,temporalErrorTarget:errorTarget+.0005,previousDrawing:refine?predictedDrawing:null,frameSize:animation,cmd:'process',rgba:rgba.buffer,width,height,importance,config:{...config,fit_method:'primeval',enable_png_mode:config.enable_png_mode||transparent}},data=>{
     if(data.type==='error')failure=data.message;
     if(data.type==='progress'){stream?.push(data);self.postMessage({type:'progress',step:sourceFrames-1+(data.step/(data.total||1)),total:expected||animation.frames.length+1,phase:data.phase||'animation'});}
    });
    if(!result)throw Error(failure||'Primeval frame fitting failed');
    if(refine){metrics.lastAttempt={global:result.temporal_error,focus:result.temporal_focus_error,globalTarget:errorTarget,focusTarget,replacements:result.temporal_replacements||0};self.postMessage({type:'progress',step:sourceFrames,total:expected,phase:'animation',metrics:{...metrics}});}
    let currentDetail=detail(rgba,width,height,result,false,importance),detailFailed=refine&&!AnimationMotion.detailAccepts(referenceDetail,currentDetail);
    // Warm starts may need another cheap repair before a full restart.
    for(let retry=0;allowWarmRepair&&refine&&retry<2&&(result.temporal_error>errorTarget+.0005||result.temporal_focus_error>focusTarget+.0005||detailFailed);retry++){
     const next=await processPrimeval({temporalFocusTarget:focusTarget+.0005,temporalErrorTarget:errorTarget+.0005,previousDrawing:result.primeval_drawing,frameSize:animation,cmd:'process',rgba:rgba.buffer,width,height,importance,config:{...config,fit_method:'primeval',enable_png_mode:config.enable_png_mode||transparent}},data=>{if(data.type==='error')failure=data.message;else if(data.type==='progress')stream?.push(data);});
     if(!next)throw Error(failure||'Primeval frame repair failed');
     if(Array.isArray(next.temporal_order)&&Array.isArray(result.temporal_order))next.temporal_order=next.temporal_order.map(i=>result.temporal_order[i]);
     next.temporal_replacements=(next.temporal_replacements||0)+(result.temporal_replacements||0);result=next;metrics.warmRetries=(metrics.warmRetries||0)+1;
     currentDetail=detail(rgba,width,height,result,false,importance);detailFailed=!AnimationMotion.detailAccepts(referenceDetail,currentDetail);
     metrics.lastAttempt={global:result.temporal_error,focus:result.temporal_focus_error,globalTarget:errorTarget,focusTarget,replacements:result.temporal_replacements||0};self.postMessage({type:'progress',step:sourceFrames,total:expected,phase:'animation',metrics:{...metrics}});
    }
    if(detailFailed)metrics.detailFallbacks++;
    let acceptedRefine=refine;
    if(refine&&referenceError!==null&&(result.temporal_error>errorTarget+.0005||result.temporal_focus_error>focusTarget+.0005||detailFailed)){
      acceptedRefine=false;
      if(focus?.enabled&&config.primeval_turbo&&focus.automatic){metrics.focusAnalyses++;try{automaticMap=await Focus.analyze({},rgba,width,height,{cancelled:false});}catch(error){automaticMap=null;}importance=Focus.combine(automaticMap,focus.areas||[],width,height);}

      result=await processPrimeval({cmd:'process',rgba:rgba.buffer,width,height,importance,config:{...config,fit_method:'primeval',enable_png_mode:config.enable_png_mode||transparent}},data=>{if(data.type==='error')failure=data.message;else if(data.type==='progress')stream?.push(data);});
      if(!result)throw Error(failure||'Primeval keyframe fitting failed');
    }
    if(!acceptedRefine){
      const pixels=(config.output_alpha??1)===1?new Uint8ClampedArray(result.preview_rgba):(await PNGDecode.decode(new Uint8Array(result.primeval_png))).rgba;
      const quality=AnimationMotion.quality(rgba,width,height,pixels,result.image_size.width,result.image_size.height,importance);
      referenceDetail=detail(rgba,width,height,result,false,importance);
      referenceError=quality.global;referenceFocusError=quality.focus;referenceComplexity=quality.complexity;referenceFocusComplexity=quality.focusComplexity;
    }

    if(acceptedRefine){metrics.refined++;metrics.replacements+=result.temporal_replacements||0;metrics.refitMs+=performance.now()-fitStarted;}else{metrics.keyframes++;metrics.fullFitMs+=performance.now()-fitStarted;keyFrame=animation.frames.length;}
    metrics.lastDetail=detail(rgba,width,height,result,false,importance);metrics.referenceDetail=referenceDetail;
    previousDrawing=result.primeval_drawing;
    if(!first)first=result;
    if(result.image_size.width!==animation.width||result.image_size.height!==animation.height){
     if(animation.frames.length)throw Error('Primeval frame dimensions changed');
     animation.width=result.image_size.width;animation.height=result.image_size.height;
    }
    frame=AnimationCore.packFrame(result.elements,animation.frames.at(-1),animation.width,animation.height,animation.unit,acceptedRefine?(result.temporal_order||true):false);
    frameConfig=result.config;
    animation.hasTransparency ||= result.config.output_has_transparency;
   }
   if((animation.frames.length+1-(seedLoaded?1:0))*Math.max(frame.length,animation.controls*8)*8>AnimationCore.MEMORY)throw Error('animation.limit');
   animation.controls=Math.max(animation.controls,frame.length/8);
   animation.frames.push(frame);animation.timestamps.push(timestamp);animation.durations.push(duration);
   stream?.flush();frameReady(frame,sourceFrames,timestamp,duration);previousPixels=rgba;seedConsumed=true;
   self.postMessage({type:'progress',step:sourceFrames,total:expected||animation.frames.length+1,phase:'animation',metrics:{...metrics}});
  }
  async function decode(){
  if(file.type==='image/gif'||/\.gif$/i.test(file.name)){
   if(typeof ImageDecoder==='undefined'||!await ImageDecoder.isTypeSupported('image/gif'))throw Error('animation.codec');
   const gifData=await file.arrayBuffer(),timing=AnimationMedia.gifTiming(gifData);
   const decoder=new ImageDecoder({data:gifData,type:'image/gif',preferAnimation:true});
   try{await decoder.tracks.ready;await decoder.completed;const track=decoder.tracks.selectedTrack;expected=track.frameCount;preserveTiming=!!timing&&timing.frames===track.frameCount&&timing.frames<=fps*timing.duration+1e-6;
    for(let i=0;i<track.frameCount;i++){if(sequence&&i>sequenceLast)break;if(sequence&&!sequence.has(i))continue;const {image}=await decoder.decode({frameIndex:i});try{await accept((ctx,w,h)=>ctx.drawImage(image,0,0,w,h),image.displayWidth,image.displayHeight,image.timestamp/1e6,Math.max(0.01,(image.duration||0)/1e6));}finally{image.close();}}
   }finally{decoder.close();}
  }else{
   if(typeof VideoDecoder==='undefined')throw Error('animation.codec');
   const M=await import('./vendor/mediabunny/mediabunny.min.js');
   const input=new M.Input({source:new M.BlobSource(file),formats:[M.MP4,M.QTFF,M.WEBM,M.MATROSKA,M.OGG,M.MPEG_TS]});
   try{const track=await input.getPrimaryVideoTrack();if(!track)throw Error('No video track');if(!await track.canDecode())throw Error('Unsupported video decoder: '+JSON.stringify(await track.getDecoderConfig()));
    const sink=new M.VideoSampleSink(track);expected=(await track.computePacketStats()).packetCount;
    let sampleIndex=0;for await(const sample of sink.samples()){
     try{const index=sampleIndex++;if(sequence&&index>sequenceLast)break;if(!sequence||sequence.has(index))await accept((ctx,w,h)=>sample.draw(ctx,0,0,w,h),sample.displayWidth,sample.displayHeight,sample.timestamp,sample.duration);}finally{sample.close();}
    }
   }finally{input.dispose();}
  }
  }
  await decode();while(pending.length)await drain();fitPool?.close();
  if(preview){self.postMessage({type:'previewDone',frames:previewFrames,duration:endTime,fps,sourceFrames});return;}
  if(!animation?.frames.length)throw Error('animation.codec');
  if(seedLoaded){animation.frames.shift();animation.timestamps.shift();animation.durations.shift();}
  for(let i=0;i<animation.durations.length;i++){
   const delta=animation.timestamps[i+1]-animation.timestamps[i];
   if(Number.isFinite(delta)&&delta>0)animation.durations[i]=delta;
   if(!(animation.durations[i]>0)||!Number.isFinite(animation.durations[i]))animation.durations[i]=animation.durations[i-1]||1/30;
  }
  animation.durations[animation.durations.length-1]=Math.max(.001,endTime-animation.timestamps.at(-1));
  delete animation.timestamps;animation.metrics={...metrics,sourceFrames,skippedFrames,selectedFrames:animation.frames.length};
  const elements=AnimationCore.elements(animation,0,animation.unit);
  const poster=first.primeval_png;
  const result={mode:'fill',image_size:{width:animation.width,height:animation.height},image_center:first.image_center,elements,elements_count:elements.length,elapsed_seconds:Math.round((performance.now()-started)/10)/100,
   config:{...config,...frameConfig,primeval_threads:msg.config.primeval_threads,engine:'animation-browser',fit_method:'primeval',output_has_transparency:!!animation.hasTransparency},mask:null,image_rgba:null,animation};
  const seed=msg.requestSeed?{previousDrawing,previousPixels:previousPixels.buffer,automaticMap,referenceError,referenceFocusError,referenceComplexity,referenceFocusComplexity,referenceDetail,frame:animation.frames.at(-1),width:animation.width,height:animation.height,poster,image_center:first.image_center,config:frameConfig}:undefined;
  self.postMessage({type:'done',result,poster,...(seed?{seed}:{})},[...new Set([poster,...animation.frames.map(frame=>frame.buffer),...(seed?[seed.previousPixels]:[])])]);
 }catch(error){fitPool?.close(error);self.postMessage({type:'error',message:error.message?.startsWith('animation.')?error.message:'animation.fitError',detail:error.stack||String(error)});}
};
